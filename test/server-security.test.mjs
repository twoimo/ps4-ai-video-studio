import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST,
  ARTIFACT_CAPABILITY_TTL_SECONDS,
  MAX_GEMINI_MONITOR_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_STUDIO_TOKEN_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  acquireJobLease,
  authorizeArtifactCapabilityRequest,
  authorizeMutationRequest,
  createArtifactCapabilityUrl,
  createSessionToken,
  createStudioRequestHandler,
  immutableProviderClosureBound,
  isLoopbackHostname,
  persistStudioToken,
  readJson,
  redactGeminiMonitor,
  redactJobResponse,
  releaseJobLease,
  resolveStudioToken,
  startJob,
  startStudioServer,
  verifyImmutableShotPatternClosure,
  validateRequestContentLength,
  validateUploadBatch
} from "../src/server.mjs";
import { createJob, JOBS_DIR, listJobs, readJob, updateJob } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { buildBflPaidApprovalContext, createBflPaidApprovalReceipt, persistBflPaidApproval } from "../src/bfl-paid-approval.mjs";
import { applyShotPatternsToScript, createShotPatternReceipt, hashShotPatternValue, readShotPatternCatalog } from "../src/shot-patterns.mjs";
import { monitorDiagnosticEvidence } from "../src/gemini-monitor-privacy.mjs";
import { ytDlpInfo, YT_DLP_VERSION_POLICY } from "../src/yt-dlp.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function mutationRequest(url, token, headers = {}) {
  const origin = new URL(url).origin;
  return new Request(url, {
    method: "POST",
    headers: {
      origin,
      authorization: `Bearer ${token}`,
      "sec-fetch-site": "same-origin",
      ...headers
    }
  });
}

describe("yt-dlp health probe admission", () => {
  test("bounds concurrent probes, output, lifetime, and releases permits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-yt-dlp-probe-test-"));
    temporaryDirectories.push(directory);
    const startedPath = join(directory, "started.log");
    const hangingPath = join(directory, "yt-dlp-hanging");
    const noisyPath = join(directory, "yt-dlp-noisy");
    const invalidPath = join(directory, "yt-dlp-invalid");
    const healthyPath = join(directory, "yt-dlp-healthy");
    const shebang = `#!${process.execPath}\n`;
    const exactArgvGuard = "if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91);\n";
    await writeFile(hangingPath, `${shebang}import { appendFileSync } from 'node:fs';\n${exactArgvGuard}appendFileSync(${JSON.stringify(startedPath)}, String(process.pid) + '\\n');\nsetInterval(() => {}, 1000);\n`);
    await writeFile(noisyPath, `${shebang}${exactArgvGuard}process.stdout.write('x'.repeat(4096));\n`);
    await writeFile(invalidPath, `${shebang}${exactArgvGuard}process.stdout.write('2026.08.14\\nsecret');\n`);
    await writeFile(healthyPath, `${shebang}${exactArgvGuard}process.stdout.write('2026.08.14-safe');\n`);
    await Promise.all([hangingPath, noisyPath, invalidPath, healthyPath].map((path) => chmod(path, 0o700)));

    expect(YT_DLP_VERSION_POLICY.admissionTimeoutMs).toBeLessThanOrEqual(1_000);
    const hangingOptions = {
      executablePath: hangingPath,
      timeoutMs: 1_500,
      // Other test files intentionally share the production-wide subprocess
      // admission pool. Wait for their bounded work instead of assuming both
      // slots are idle within half a second.
      admissionTimeoutMs: 5_000,
      maximumOutputBytes: 512
    };
    const first = ytDlpInfo(hangingOptions);
    const second = ytDlpInfo(hangingOptions);
    let startedPids = [];
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        startedPids = (await readFile(startedPath, "utf8")).trim().split("\n").filter(Boolean).map(Number);
      } catch {}
      if (startedPids.length === 2) break;
      await Bun.sleep(10);
    }
    expect(startedPids).toHaveLength(2);

    const saturated = await ytDlpInfo({
      executablePath: hangingPath,
      timeoutMs: 1_500,
      admissionTimeoutMs: 40,
      maximumOutputBytes: 512
    });
    expect(saturated).toMatchObject({
      installed: false,
      error: "yt-dlp version probe unavailable",
      errorCode: "YT_DLP_VERSION_PROBE_UNAVAILABLE"
    });
    expect((await Promise.all([first, second])).every((result) => result.errorCode === "YT_DLP_VERSION_PROBE_UNAVAILABLE")).toBe(true);

    const noisy = await ytDlpInfo({ executablePath: noisyPath, maximumOutputBytes: 128 });
    expect(noisy).toMatchObject({ installed: false, error: "yt-dlp version probe unavailable" });
    expect(noisy.error).not.toContain(noisyPath);
    const invalid = await ytDlpInfo({ executablePath: invalidPath, maximumOutputBytes: 512 });
    expect(invalid).toMatchObject({ installed: false, errorCode: "YT_DLP_VERSION_PROBE_UNAVAILABLE" });
    const healthy = await ytDlpInfo({ executablePath: healthyPath, maximumOutputBytes: 512 });
    expect(healthy).toMatchObject({
      installed: true,
      version: "2026.08.14-safe",
      error: null,
      errorCode: null
    });

    for (const pid of startedPids) {
      let alive = true;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") alive = false;
        }
        if (!alive) break;
        await Bun.sleep(10);
      }
      expect(alive).toBe(false);
    }
  });
});

describe("process session tokens", () => {
  test("generates independent 256-bit base64url tokens", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(() => createSessionToken(31)).toThrow("최소 32바이트");
  });

  test("rejects weak explicit bearer secrets", () => {
    expect(() => resolveStudioToken("short-token")).toThrow("32~");
    expect(() => resolveStudioToken(` ${"x".repeat(40)}`)).toThrow("공백 없이");
    expect(() => resolveStudioToken("x".repeat(MAX_STUDIO_TOKEN_BYTES + 1))).toThrow("32~");
    expect(resolveStudioToken("x".repeat(40))).toBe("x".repeat(40));
  });

  test("persists the CLI bearer token in a mode-0600 runtime file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-security-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "runtime", "studio-token");
    const token = createSessionToken();

    await persistStudioToken(token, tokenPath);

    expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "runtime"))).mode & 0o777).toBe(0o700);
  });

  test("refuses pre-existing runtime and token symlinks without touching their external targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-security-symlink-test-"));
    temporaryDirectories.push(directory);
    const external = await mkdtemp(join(tmpdir(), "ps4-security-external-test-"));
    temporaryDirectories.push(external);
    const externalToken = join(external, "external-token");
    await writeFile(externalToken, "unchanged\n", { mode: 0o600 });
    const externalMode = (await stat(external)).mode & 0o777;
    const externalBytes = await readFile(externalToken);

    await symlink(external, join(directory, "runtime"));
    await expect(persistStudioToken(createSessionToken(), join(directory, "runtime", "studio-token"))).rejects.toThrow();
    expect((await stat(external)).mode & 0o777).toBe(externalMode);
    expect(await readFile(externalToken)).toEqual(externalBytes);
    expect(await readdir(external)).toEqual(["external-token"]);

    await rm(join(directory, "runtime"));
    await mkdir(join(directory, "runtime"), { mode: 0o700 });
    await symlink(externalToken, join(directory, "runtime", "studio-token"));
    await expect(persistStudioToken(createSessionToken(), join(directory, "runtime", "studio-token"))).rejects.toThrow();
    expect(await readFile(externalToken)).toEqual(externalBytes);
  });

  test("refuses permissive runtime directories and multiply-linked token files instead of chmoding them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-security-mode-test-"));
    temporaryDirectories.push(directory);
    const runtime = join(directory, "runtime");
    const tokenPath = join(runtime, "studio-token");
    await mkdir(runtime, { mode: 0o700 });
    await chmod(runtime, 0o755);
    await expect(persistStudioToken(createSessionToken(), tokenPath)).rejects.toThrow("mode-0700");
    expect((await stat(runtime)).mode & 0o777).toBe(0o755);

    await chmod(runtime, 0o700);
    await writeFile(tokenPath, "x".repeat(43), { mode: 0o600 });
    await link(tokenPath, join(runtime, "second-link"));
    await expect(persistStudioToken(createSessionToken(), tokenPath)).rejects.toThrow("single-link");
    expect(await readFile(tokenPath, "utf8")).toBe("x".repeat(43));
  });
});

describe("same-origin mutation authorization", () => {
  test("rejects legacy cookies even when they contain the exact master token", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://127.0.0.1:3000/api/jobs", token, {
      authorization: "",
      cookie: `ps4_studio_session=${encodeURIComponent(token)}`
    });

    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
  });

  test("accepts an exact bearer token but still requires same-origin", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://127.0.0.1:3000/api/jobs", token, {
      cookie: "",
      authorization: `Bearer ${token}`
    });
    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toEqual({ ok: true, code: "bearer" });

    for (const authorization of [`Bearer  ${token}`, `Bearer\t${token}`, `Bearer ${token},duplicate`]) {
      const malformed = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { authorization });
      expect(authorizeMutationRequest(malformed, new URL(malformed.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    }

    const crossOrigin = mutationRequest("http://127.0.0.1:3000/api/jobs", token, {
      origin: "https://attacker.example",
      authorization: `Bearer ${token}`
    });
    expect(authorizeMutationRequest(crossOrigin, new URL(crossOrigin.url), { token })).toMatchObject({ ok: false, code: "cross-origin" });
  });

  test("rejects missing Origin, wrong tokens, cross-site metadata, and DNS rebinding hosts", () => {
    const token = createSessionToken();
    const noOrigin = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { origin: "" });
    const wrongToken = mutationRequest("http://127.0.0.1:3000/api/jobs", "z".repeat(43));
    const crossSite = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { "sec-fetch-site": "cross-site" });
    const rebound = mutationRequest("http://attacker.example:3000/api/jobs", token);

    expect(authorizeMutationRequest(noOrigin, new URL(noOrigin.url), { token })).toMatchObject({ ok: false, code: "cross-origin" });
    expect(authorizeMutationRequest(wrongToken, new URL(wrongToken.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    expect(authorizeMutationRequest(crossSite, new URL(crossSite.url), { token })).toMatchObject({ ok: false, code: "cross-site" });
    expect(authorizeMutationRequest(rebound, new URL(rebound.url), { token })).toMatchObject({ ok: false, code: "untrusted-host" });
  });

  test("requires a session for safe API methods and rejects DNS-rebinding hosts", () => {
    const token = createSessionToken();
    const unauthenticated = new Request("http://127.0.0.1:3000/api/health");
    const authenticated = new Request("http://127.0.0.1:3000/api/health", {
      headers: { authorization: `Bearer ${token}` }
    });
    const rebound = new Request("http://attacker.example:3000/api/jobs", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authorizeMutationRequest(unauthenticated, new URL(unauthenticated.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    expect(authorizeMutationRequest(authenticated, new URL(authenticated.url), { token })).toEqual({ ok: true, code: "safe-bearer" });
    expect(authorizeMutationRequest(rebound, new URL(rebound.url), { token })).toMatchObject({ ok: false, code: "untrusted-host" });
  });

  test("never places the master token in a static response cookie", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    for (const request of [
      new Request("http://127.0.0.1:3000/"),
      new Request("http://127.0.0.1:3000/", { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } }),
      new Request("http://127.0.0.1:3000/index.html")
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await response.text()).not.toContain(token);
    }
  });

  test("enforces the gate in the actual Bun request handler while UI bootstrap remains usable", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const navigation = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });
    const uiResponse = await handler(navigation);
    expect(uiResponse.status).toBe(200);
    expect(uiResponse.headers.get("set-cookie")).toBeNull();

    const rejected = await handler(new Request("http://127.0.0.1:3000/api/not-found", { method: "POST" }));
    expect(rejected.status).toBe(403);

    const accepted = await handler(mutationRequest("http://127.0.0.1:3000/api/not-found", token));
    expect(accepted.status).toBe(404);
  });

  test("serves the read-only shot-pattern projection only inside the authenticated API boundary", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const rejected = await handler(new Request("http://127.0.0.1:3000/api/shot-patterns"));
    const accepted = await handler(new Request("http://127.0.0.1:3000/api/shot-patterns", {
      headers: { authorization: `Bearer ${token}` }
    }));

    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(200);
    const payload = await accepted.json();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      catalogId: "ps4-higgsfield-learning-patterns-v1",
      usage: {
        mode: "provider-camera-continuity-suffix/v1",
        catalogResearch: {
          providerCallsMade: false,
          generationSpend: false,
          remoteAssetsCopiedIntoProject: false
        }
      }
    });
    expect(payload.patterns).toHaveLength(8);
    expect(payload.patterns.every((pattern) => !Object.hasOwn(pattern, "template") && !Object.hasOwn(pattern, "variables"))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("data:image/");
  });

  test("binds stateless read-only capabilities to one exact artifact path and a short expiry", async () => {
    const token = createSessionToken();
    const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
    const jobId = "job-capability-123456";
    const artifactName = "runs/run-123456/artifacts/final.mp4";
    const relative = createArtifactCapabilityUrl(jobId, artifactName, token, { nowMs, ttlSeconds: 300 });
    const url = new URL(relative, "http://127.0.0.1:3000");
    const request = new Request(url);

    expect(authorizeArtifactCapabilityRequest(request, url, { token, nowMs })).toMatchObject({
      ok: true,
      code: "artifact-capability",
      jobId,
      artifactName
    });
    const wrongPath = new URL(url);
    wrongPath.pathname = wrongPath.pathname.replace("final.mp4", "other.mp4");
    expect(authorizeArtifactCapabilityRequest(new Request(wrongPath), wrongPath, { token, nowMs })).toMatchObject({ ok: false, code: "invalid-capability" });
    const extra = new URL(url);
    extra.searchParams.set("extra", "1");
    expect(authorizeArtifactCapabilityRequest(new Request(extra), extra, { token, nowMs })).toMatchObject({ ok: false, code: "invalid-capability" });
    expect(authorizeArtifactCapabilityRequest(new Request(url, { method: "POST" }), url, { token, nowMs })).toMatchObject({ ok: false, code: "capability-method" });
    expect(authorizeArtifactCapabilityRequest(request, url, { token, nowMs: nowMs + 301_000 })).toMatchObject({ ok: false, code: "expired-capability" });

    const tooLong = createArtifactCapabilityUrl(jobId, artifactName, token, { nowMs, ttlSeconds: ARTIFACT_CAPABILITY_TTL_SECONDS });
    const tooLongUrl = new URL(tooLong, "http://127.0.0.1:3000");
    expect(authorizeArtifactCapabilityRequest(new Request(tooLongUrl), tooLongUrl, { token, nowMs: nowMs - 1_000 })).toMatchObject({ ok: false, code: "expired-capability" });
  });

  test("emits capability URLs only when a projection has an explicit signing key", () => {
    const token = createSessionToken();
    const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
    const job = {
      id: "job-projection-123456",
      provider: "local-video",
      status: "queued",
      artifacts: [{ name: "runs/run-123456/artifacts/final.mp4", bytes: 12 }]
    };
    expect(redactJobResponse(job).artifacts[0].url).toBeNull();
    const projected = redactJobResponse(job, {
      artifactCapabilityToken: token,
      artifactCapabilityOptions: { nowMs, ttlSeconds: 300 }
    });
    const url = new URL(projected.artifacts[0].url, "http://127.0.0.1:3000");
    expect(authorizeArtifactCapabilityRequest(new Request(url), url, { token, nowMs })).toMatchObject({
      ok: true,
      jobId: job.id,
      artifactName: job.artifacts[0].name
    });
    expect(() => createArtifactCapabilityUrl(job.id, job.artifacts[0].name, "", { nowMs })).toThrow("signing token");
  });

  test("allows a valid capability through only the artifact GET route without granting API authority", async () => {
    const token = createSessionToken();
    const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
    const job = await createJob({ topic: "artifact capability boundary", provider: "local", clipCount: 1, targetDurationSec: 20 });
    temporaryDirectories.push(join(JOBS_DIR, job.id));
    const capabilityPath = createArtifactCapabilityUrl(job.id, "final.mp4", token, { nowMs, ttlSeconds: 300 });
    const handler = createStudioRequestHandler({ token, artifactCapabilityNowMs: nowMs });

    const artifact = await handler(new Request(new URL(capabilityPath, "http://127.0.0.1:3000")));
    expect(artifact.status).toBe(404);
    const jobs = await handler(new Request(`http://127.0.0.1:3000/api/jobs?${new URL(capabilityPath, "http://127.0.0.1:3000").searchParams}`));
    expect(jobs.status).toBe(403);
  });

  test("binds a real Bun server to the loopback interface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-test-"));
    temporaryDirectories.push(directory);
    const token = createSessionToken();
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    const server = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      token,
      tokenPath: join(directory, "runtime", "studio-token"),
      serverLeasePath
    });
    try {
      expect(server.hostname).toBe(DEFAULT_HOST);
      expect(String(server.url)).toStartWith(`http://${DEFAULT_HOST}:`);

      const uiResponse = await fetch(server.url);
      expect(uiResponse.status).toBe(200);
      expect(uiResponse.headers.get("set-cookie")).toBeNull();

      const rejected = await fetch(new URL("/api/not-found", server.url), { method: "POST" });
      expect(rejected.status).toBe(403);

      const rejectedRead = await fetch(new URL("/api/jobs", server.url));
      expect(rejectedRead.status).toBe(403);

      const acceptedRead = await fetch(new URL("/api/jobs", server.url), {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(acceptedRead.status).toBe(200);

      const accepted = await fetch(new URL("/api/not-found", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          authorization: `Bearer ${token}`
        }
      });
      expect(accepted.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("reserves the port before token publication and serializes one runtime owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-startup-order-test-"));
    temporaryDirectories.push(directory);
    const firstTokenPath = join(directory, "first", "studio-token");
    const secondTokenPath = join(directory, "second", "studio-token");
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    const firstToken = createSessionToken();
    const secondPriorToken = createSessionToken();
    const secondAttemptToken = createSessionToken();
    await persistStudioToken(secondPriorToken, secondTokenPath);
    const secondBefore = await readFile(secondTokenPath);
    let reservedStatus = null;
    let tokenExistedWhileReserved = null;
    const first = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      token: firstToken,
      tokenPath: firstTokenPath,
      serverLeasePath,
      afterPortReserved: async ({ serverUrl }) => {
        reservedStatus = (await fetch(new URL("/api/jobs", serverUrl), {
          headers: { authorization: `Bearer ${firstToken}` }
        })).status;
        tokenExistedWhileReserved = await readFile(firstTokenPath).then(() => true, () => false);
      }
    });
    try {
      expect(reservedStatus).toBe(503);
      expect(tokenExistedWhileReserved).toBe(false);
      await expect(startStudioServer({
        hostname: DEFAULT_HOST,
        port: first.port,
        token: secondAttemptToken,
        tokenPath: secondTokenPath,
        serverLeasePath
      })).rejects.toThrow();
      expect(await readFile(secondTokenPath)).toEqual(secondBefore);
      expect((await fetch(new URL("/api/jobs", first.url), {
        headers: { authorization: `Bearer ${firstToken}` }
      })).status).toBe(200);

      await expect(startStudioServer({
        hostname: DEFAULT_HOST,
        port: 0,
        token: createSessionToken(),
        tokenPath: firstTokenPath,
        serverLeasePath
      })).rejects.toMatchObject({ code: "STUDIO_SERVER_ALREADY_RUNNING" });
      expect((await readFile(firstTokenPath, "utf8")).trim()).toBe(firstToken);
    } finally {
      await first.stop(true);
    }

    await expect(startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath: secondTokenPath,
      serverLeasePath
    })).rejects.toMatchObject({ code: "STUDIO_SERVER_TOKEN_PATH_MISMATCH" });
    expect(await readFile(secondTokenPath)).toEqual(secondBefore);

    const mismatchedToken = createSessionToken();
    await expect(startStudioServer({ hostname: DEFAULT_HOST, port: 0, token: mismatchedToken, tokenPath: firstTokenPath, serverLeasePath }))
      .rejects.toMatchObject({ code: "STUDIO_TOKEN_MISMATCH" });
    expect((await readFile(firstTokenPath, "utf8")).trim()).toBe(firstToken);

    const restarted = await startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath: firstTokenPath, serverLeasePath });
    try {
      expect(restarted.studioToken).toBe(firstToken);
      expect(restarted.reload({ fetch: () => new Response("reloaded") })).toBe(restarted);
      expect((await readFile(firstTokenPath, "utf8")).trim()).toBe(firstToken);
      expect((await fetch(new URL("/api/jobs", restarted.url), {
        headers: { authorization: `Bearer ${firstToken}` }
      })).status).toBe(200);
    } finally {
      await restarted.stop(true);
    }
  });

  test("requires an explicit one-time singleton migration for a legacy token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-lease-migration-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "credential-runtime", "studio-token");
    const alternateTokenPath = join(directory, "alternate-credential-runtime", "studio-token");
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    const legacyToken = createSessionToken();
    await persistStudioToken(legacyToken, tokenPath);
    const tokenBefore = await readFile(tokenPath);

    await expect(startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath }))
      .rejects.toMatchObject({ code: "STUDIO_SERVER_LEASE_MIGRATION_REQUIRED" });
    expect(await readFile(tokenPath)).toEqual(tokenBefore);
    await expect(startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath: alternateTokenPath,
      serverLeasePath,
      allowLeaseMigration: true
    })).rejects.toMatchObject({ code: "STUDIO_SERVER_TOKEN_PATH_MISMATCH" });
    await expect(readFile(alternateTokenPath)).rejects.toMatchObject({ code: "ENOENT" });

    const migrated = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath,
      serverLeasePath,
      allowLeaseMigration: true
    });
    try {
      expect(migrated.studioToken).toBe(legacyToken);
      expect((await fetch(new URL("/api/jobs", migrated.url), {
        headers: { authorization: `Bearer ${legacyToken}` }
      })).status).toBe(200);
    } finally {
      await migrated.stop(true);
    }

    const restarted = await startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath });
    await restarted.stop(true);

    const disposable = await startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath });
    disposable[Symbol.dispose]();
    await disposable.stop(true);
    const afterDispose = await startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath });
    await afterDispose.stop(true);
  });

  test("durably binds a fresh token path before publication can crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-lease-pending-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "credential-runtime", "studio-token");
    const alternateTokenPath = join(directory, "alternate-credential-runtime", "studio-token");
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    const token = createSessionToken();

    await expect(startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      token,
      tokenPath,
      serverLeasePath,
      afterTokenPersistedBeforeLeaseMigration: async () => {
        throw new Error("simulated crash after token publication");
      }
    })).rejects.toThrow("simulated crash after token publication");
    expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
    expect((await readFile(serverLeasePath))[0]).toBe(2);

    await expect(startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath: alternateTokenPath,
      serverLeasePath,
      allowLeaseMigration: true
    })).rejects.toMatchObject({ code: "STUDIO_SERVER_TOKEN_PATH_MISMATCH" });
    await expect(readFile(alternateTokenPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath }))
      .rejects.toMatchObject({ code: "STUDIO_SERVER_LEASE_MIGRATION_REQUIRED" });

    const recovered = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath,
      serverLeasePath,
      allowLeaseMigration: true
    });
    await recovered.stop(true);
    expect((await readFile(serverLeasePath))[0]).toBe(1);
  });

  test("keeps the singleton lease until synchronous disposal finishes stop(true)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-dispose-barrier-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "credential-runtime", "studio-token");
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    let releaseStop;
    let stopEntered = false;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const server = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath,
      serverLeasePath,
      stopServerFn: async (target) => {
        stopEntered = true;
        await stopGate;
        return target.stop(true);
      }
    });

    server[Symbol.dispose]();
    expect(stopEntered).toBe(true);
    await expect(startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath }))
      .rejects.toMatchObject({ code: "STUDIO_SERVER_ALREADY_RUNNING" });
    releaseStop();
    await server.stop(true);

    const restarted = await startStudioServer({ hostname: DEFAULT_HOST, port: 0, tokenPath, serverLeasePath });
    await restarted.stop(true);
  });

  test("reloads a rotated canonical default token without accepting the stale bearer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-token-refresh-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "credential-runtime", "studio-token");
    const serverLeasePath = join(directory, "workspace-runtime", "studio-server.lock");
    const firstToken = createSessionToken();
    await persistStudioToken(firstToken, tokenPath);
    const server = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      tokenPath,
      serverLeasePath,
      allowLeaseMigration: true
    });
    try {
      const replacementToken = createSessionToken();
      await persistStudioToken(replacementToken, tokenPath);
      expect((await fetch(new URL("/api/jobs", server.url), {
        headers: { authorization: `Bearer ${firstToken}` }
      })).status).toBe(403);
      expect((await fetch(new URL("/api/jobs", server.url), {
        headers: { authorization: `Bearer ${replacementToken}` }
      })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses an externally reachable bind before issuing any session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-external-bind-test-"));
    temporaryDirectories.push(directory);
    await expect(startStudioServer({
      hostname: "0.0.0.0",
      port: 0,
      token: createSessionToken(),
      tokenPath: join(directory, "runtime", "studio-token")
    })).rejects.toThrow("loopback host");
  });
});

describe("paid local-video launch authorization", () => {
  test("rejects auto-start creation and requires a one-use exact BFL approval before /run", async () => {
    const token = createSessionToken();
    let starts = 0;
    const handler = createStudioRequestHandler({
      token,
      startJobFn: async (_jobId, options = {}) => {
        try {
          const prepared = typeof options.prepareRunOptions === "function" ? await options.prepareRunOptions() : {};
          if (!prepared.paidLaunchCapability) return false;
          starts += 1;
          return true;
        } catch {
          return false;
        }
      }
    });
    const autoStart = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { "content-type": "application/json" });
    const autoStartResponse = await handler(new Request(autoStart.url, {
      method: "POST",
      headers: autoStart.headers,
      body: JSON.stringify({ topic: "유료 자동 실행 차단", provider: "local-video", autoStart: true })
    }));
    expect(autoStartResponse.status).toBe(400);
    expect(starts).toBe(0);

    const job = await createJob({ topic: "승인된 BFL 실행 회귀", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    temporaryDirectories.push(jobDir);
    const runRequest = () => mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token, { "content-type": "application/json" });
    const missing = await handler(new Request(runRequest().url, { method: "POST", headers: runRequest().headers, body: "{}" }));
    expect(missing.status).toBe(409);
    expect(starts).toBe(0);

    const keys = ["BFL_API_KEY", "BFL_DRY_RUN", "BFL_MAX_CREDITS", "BFL_ESTIMATED_TOTAL_CREDITS", "BFL_VIDEO_RESOLUTION", "PS4_LOCAL_VIDEO_GENERATOR"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.BFL_API_KEY = "test-only-key";
      process.env.BFL_DRY_RUN = "0";
      process.env.BFL_MAX_CREDITS = "340";
      process.env.BFL_ESTIMATED_TOTAL_CREDITS = "340";
      process.env.BFL_VIDEO_RESOLUTION = "hd";
      process.env.PS4_LOCAL_VIDEO_GENERATOR = join(process.cwd(), "scripts", "bfl-flux-video-generator.mjs");
      const context = await buildBflPaidApprovalContext({ root: process.cwd(), job, env: process.env });
      const now = new Date();
      const approval = createBflPaidApprovalReceipt(context, {
        now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        reason: "테스트에서 정확한 340 credit 1회 실행을 명시적으로 승인함",
        apiKey: process.env.BFL_API_KEY
      });
      await persistBflPaidApproval(jobDir, approval, { apiKey: process.env.BFL_API_KEY });
      const activeApprovalPath = join(jobDir, "bfl-paid-approval.json");
      const approvalBytesBeforeBusyRun = await readFile(activeApprovalPath);
      const approvalMtimeBeforeBusyRun = (await stat(activeApprovalPath)).mtimeMs;
      const jobBytesBeforeBusyRun = await readFile(join(jobDir, "job.json"));
      const heldLease = await acquireJobLease(job.id);
      expect(heldLease).toBeTruthy();
      try {
        const heldHandler = createStudioRequestHandler({ token });
        const busyRequest = runRequest();
        const busy = await heldHandler(new Request(busyRequest.url, { method: "POST", headers: busyRequest.headers, body: "{}" }));
        expect(busy.status).toBe(409);
        expect(await readFile(activeApprovalPath)).toEqual(approvalBytesBeforeBusyRun);
        expect((await stat(activeApprovalPath)).mtimeMs).toBe(approvalMtimeBeforeBusyRun);
        expect(await readFile(join(jobDir, "job.json"))).toEqual(jobBytesBeforeBusyRun);
        expect((await readdir(jobDir)).some((name) => name.startsWith("bfl-paid-approval-consumed-"))).toBe(false);
      } finally {
        await releaseJobLease(heldLease);
      }
      const acceptedRequest = runRequest();
      const accepted = await handler(new Request(acceptedRequest.url, { method: "POST", headers: acceptedRequest.headers, body: "{}" }));
      expect(accepted.status).toBe(200);
      expect(starts).toBe(1);
      await writeFile(join(jobDir, `bfl-paid-claim-${approval.nonce}.json`), "durable-provider-request-claim", { mode: 0o600 });
      const replayRequest = runRequest();
      const replay = await handler(new Request(replayRequest.url, { method: "POST", headers: replayRequest.headers, body: "{}" }));
      expect(replay.status).toBe(409);
      expect(starts).toBe(1);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("recovers the exact consumed approval after a lease-held pre-run crash", async () => {
    const token = createSessionToken();
    const job = await createJob({ topic: "BFL consumed launch crash 복구", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    temporaryDirectories.push(jobDir);
    const keys = ["BFL_API_KEY", "BFL_DRY_RUN", "BFL_MAX_CREDITS", "BFL_ESTIMATED_TOTAL_CREDITS", "BFL_VIDEO_RESOLUTION", "PS4_LOCAL_VIDEO_GENERATOR"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.BFL_API_KEY = "test-only-key";
      process.env.BFL_DRY_RUN = "0";
      process.env.BFL_MAX_CREDITS = "340";
      process.env.BFL_ESTIMATED_TOTAL_CREDITS = "340";
      process.env.BFL_VIDEO_RESOLUTION = "hd";
      process.env.PS4_LOCAL_VIDEO_GENERATOR = join(process.cwd(), "scripts", "bfl-flux-video-generator.mjs");
      const context = await buildBflPaidApprovalContext({ root: process.cwd(), job, env: process.env });
      const now = new Date();
      const approval = createBflPaidApprovalReceipt(context, {
        now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        reason: "테스트에서 consume 직후 process crash 복구를 승인함",
        apiKey: process.env.BFL_API_KEY
      });
      await persistBflPaidApproval(jobDir, approval, { apiKey: process.env.BFL_API_KEY });
      const capabilities = [];
      let runnerCalls = 0;
      const runId = `run-${randomUUID()}`;
      const runner = async (jobId, options) => {
        runnerCalls += 1;
        capabilities.push(options.paidLaunchCapability?.capabilityHash);
        if (runnerCalls === 1) throw new Error("simulated crash before durable run identity");
        const running = await updateJob(jobId, {
          status: "running",
          runStatus: "running",
          runId,
          runStartedAt: new Date().toISOString()
        });
        await options.onRunCreated({ job: running, runId, parentRunId: null });
        return running;
      };
      const handler = createStudioRequestHandler({
        token,
        startJobFn: (jobId, options) => startJob(jobId, { ...options, runner })
      });

      const first = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token));
      expect(first.status).toBe(409);
      expect(await stat(join(jobDir, "bfl-paid-approval.json")).catch(() => null)).toBeNull();
      expect((await readdir(jobDir)).filter((name) => name.startsWith("bfl-paid-approval-consumed-"))).toHaveLength(1);

      const retried = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token));
      expect(retried.status).toBe(200);
      expect((await retried.json()).job).toMatchObject({ id: job.id, runId, status: "running" });
      expect(runnerCalls).toBe(2);
      expect(capabilities).toEqual([capabilities[0], capabilities[0]]);
      expect(capabilities[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

describe("inert-first job creation boundary", () => {
  test("never starts provider work from POST /api/jobs, including the historical implicit Gemini default", async () => {
    const token = createSessionToken();
    let starts = 0;
    const handler = createStudioRequestHandler({ token, startJobFn: async () => { starts += 1; return true; } });
    const postJob = (body) => {
      const request = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { "content-type": "application/json" });
      return handler(new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body)
      }));
    };

    const implicit = await postJob({ topic: "암묵 자동 시작을 제거하는 Gemini 작업", provider: "gemini-browser" });
    expect(implicit.status).toBe(201);
    const created = (await implicit.json()).job;
    expect(created).toMatchObject({ provider: "gemini-browser", status: "queued" });
    expect(Object.hasOwn(created, "runId")).toBe(false);
    expect(starts).toBe(0);
    temporaryDirectories.push(join(JOBS_DIR, created.id));

    const rejectedGemini = await postJob({ topic: "명시 자동 시작도 거부하는 Gemini 작업", provider: "gemini-browser", autoStart: true });
    const rejectedLocal = await postJob({ topic: "명시 자동 시작도 거부하는 로컬 작업", provider: "local", autoStart: true });
    const rejectedPaid = await postJob({ topic: "명시 자동 시작도 거부하는 유료 작업", provider: "local-video", autoStart: true });
    expect([rejectedGemini.status, rejectedLocal.status, rejectedPaid.status]).toEqual([400, 400, 400]);
    expect(starts).toBe(0);

    const rejectedTopics = new Set([
      "명시 자동 시작도 거부하는 Gemini 작업",
      "명시 자동 시작도 거부하는 로컬 작업",
      "명시 자동 시작도 거부하는 유료 작업"
    ]);
    expect((await listJobs()).some((job) => rejectedTopics.has(job.topic))).toBe(false);
  });

  test("acknowledges /run only after the exact runId is durably visible", async () => {
    const token = createSessionToken();
    const job = await createJob({ topic: "내구성 있는 실행 ID 응답", provider: "gemini-browser", clipCount: 1, targetDurationSec: 20 });
    temporaryDirectories.push(join(JOBS_DIR, job.id));
    const runId = "2026-08-13T10-00-00-000Z-ack001";
    let callbackObservedPersistedRun = false;
    const runner = async (jobId, options) => {
      const running = await updateJob(jobId, {
        status: "running",
        runStatus: "running",
        runId,
        runStartedAt: "2026-08-13T10:00:00.000Z"
      });
      callbackObservedPersistedRun = (await readJob(jobId)).runId === runId;
      await options.onRunCreated({ job: running, runId, parentRunId: null });
      return running;
    };
    const handler = createStudioRequestHandler({ token, startJobFn: (jobId) => startJob(jobId, { runner }) });
    const response = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ started: true, job: { id: job.id, status: "running", runId } });
    expect(callbackObservedPersistedRun).toBe(true);
  });

  test("never persists Gemini or local-video launch failure through a preexisting symlinked job directory", async () => {
    const token = createSessionToken();
    let runnerCalls = 0;
    const handler = createStudioRequestHandler({
      token,
      startJobFn: (jobId) => startJob(jobId, { runner: async () => { runnerCalls += 1; } })
    });
    for (const provider of ["gemini-browser", "local-video"]) {
      const job = await createJob({ topic: `${provider} symlink 실행 실패 외부 불변`, provider, clipCount: 1, targetDurationSec: 20 });
      const canonicalDir = join(JOBS_DIR, job.id);
      const externalDir = await mkdtemp(join(tmpdir(), "ps4-start-job-symlink-"));
      await rm(externalDir, { recursive: true, force: true });
      await rename(canonicalDir, externalDir);
      await symlink(externalDir, canonicalDir, "dir");
      temporaryDirectories.push(canonicalDir, externalDir);
      const externalJobPath = join(externalDir, "job.json");
      const bytesBefore = await readFile(externalJobPath);
      const mtimeBefore = (await stat(externalJobPath)).mtimeMs;

      const response = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token));
      expect(response.status).toBe(409);
      expect(await readFile(externalJobPath)).toEqual(bytesBefore);
      expect((await stat(externalJobPath)).mtimeMs).toBe(mtimeBefore);
    }
    expect(runnerCalls).toBe(0);
  });
});

describe("sealed shot-pattern provider closure", () => {
  const receiptName = "runs/run-1/shot-pattern-receipt.json";
  const receiptSha = `sha256:${"a".repeat(64)}`;
  const reference = {
    path: receiptName,
    sha256: receiptSha,
    receiptHash: `sha256:${"b".repeat(64)}`,
    catalogId: "catalog-1",
    catalogHash: `sha256:${"c".repeat(64)}`,
    continuityContractHash: `sha256:${"d".repeat(64)}`,
    segmentCount: 2,
    applicationMode: "provider-camera-continuity-suffix/v1",
    providerEligible: false,
    providerSubmissionPlanned: false,
    submittedToProvider: false,
    providerRequestHash: null,
    providerGenerationHash: null
  };
  const manifest = {
    runId: "run-1",
    shotPatterns: reference,
    script: { shotPatterns: { ...reference } },
    immutableArtifacts: [{ name: receiptName, sha256: receiptSha }]
  };
  const quality = {
    metrics: {
      provider: "local",
      providerEvidenceEligible: false,
      providerProof: false,
      shotPatternReceiptBinding: true,
      shotPatternReceipt: {
        path: receiptName,
        sha256: receiptSha,
        receiptHash: reference.receiptHash,
        catalogId: reference.catalogId,
        applicationMode: reference.applicationMode,
        submittedToProvider: reference.submittedToProvider,
        segmentCount: reference.segmentCount
      },
      evidenceHashes: { [receiptName]: receiptSha }
    }
  };

  test("requires both manifest references, the immutable receipt, and the quality binding", () => {
    expect(immutableProviderClosureBound("local", quality, manifest, {})).toBe(true);
    expect(immutableProviderClosureBound("local", quality, { ...manifest, shotPatterns: undefined }, {})).toBe(false);
    expect(immutableProviderClosureBound("local", quality, { ...manifest, script: {} }, {})).toBe(false);
    expect(immutableProviderClosureBound("local", quality, { ...manifest, immutableArtifacts: [] }, {})).toBe(false);
    expect(immutableProviderClosureBound("local", { metrics: { ...quality.metrics, shotPatternReceiptBinding: false } }, manifest, {})).toBe(false);
  });

  test("keeps pre-shot-pattern sealed runs backward compatible", () => {
    expect(immutableProviderClosureBound(
      "local",
      { metrics: { provider: "local", providerEvidenceEligible: false, providerProof: false } },
      { runId: "legacy-run", immutableArtifacts: [] },
      {}
    )).toBe(true);
    expect(immutableProviderClosureBound(
      "local",
      { metrics: { provider: "local", providerProof: true } },
      { runId: "historical-run", immutableArtifacts: [] },
      {}
    )).toBe(true);
    expect(immutableProviderClosureBound(
      "local",
      { metrics: { provider: "local", providerEvidenceEligible: false, providerProof: true } },
      { runId: "forged-modern-run", immutableArtifacts: [] },
      {}
    )).toBe(false);
  });

  test("never lets a manual import take the historical provider-proof compatibility branch", () => {
    const localClipImport = {
      source: "manual-user-upload",
      providerEvidenceEligible: false,
      receiptHash: `sha256:${"c".repeat(64)}`,
      setHash: `sha256:${"d".repeat(64)}`
    };
    const importName = "runs/run-1/local-clip-import.json";
    const importArtifactHash = `sha256:${"e".repeat(64)}`;
    const importedManifest = {
      ...manifest,
      request: { localClipImport },
      localClipImportReceipt: { ...localClipImport, path: importName, sha256: importArtifactHash },
      immutableArtifacts: [...manifest.immutableArtifacts, { name: importName, sha256: importArtifactHash }]
    };
    const inputManifest = { localClipImport };
    expect(immutableProviderClosureBound(
      "local",
      { metrics: { ...quality.metrics, providerProof: true, providerEvidenceEligible: undefined, inputManifestBinding: true } },
      importedManifest,
      inputManifest
    )).toBe(false);
    expect(immutableProviderClosureBound(
      "local",
      { metrics: { ...quality.metrics, inputManifestBinding: true } },
      importedManifest,
      inputManifest
    )).toBe(true);
  });

  test("recomputes the full immutable receipt from the sealed script", async () => {
    const jobId = `test-shot-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const artifactDir = join(jobDir, "runs", runId, "artifacts");
    temporaryDirectories.push(jobDir);
    await mkdir(artifactDir, { recursive: true });

    const script = applyShotPatternsToScript({
      videoFormat: "vertical",
      evidenceTextBindingHash: `sha256:${"e".repeat(64)}`,
      segments: [{
        claimId: "claim-1",
        durationHint: 10,
        visualPrompt: "Vertical evidence-bound documentary view of the exact cited courtyard stone detail."
      }]
    }, {
      id: jobId,
      provider: "local",
      format: "vertical",
      clipCount: 1,
      targetDurationSec: 10
    }, await readShotPatternCatalog());
    const receipt = createShotPatternReceipt(script, { id: jobId, provider: "local" }, runId);
    const scriptPath = join(artifactDir, "script.json");
    const receiptName = `runs/${runId}/shot-pattern-receipt.json`;
    const receiptPath = join(artifactDir, receiptName.replaceAll("/", "__"));
    await writeFile(scriptPath, `${JSON.stringify(script, null, 2)}\n`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const scriptStat = await stat(scriptPath);
    const receiptStat = await stat(receiptPath);
    const reference = {
      path: receiptName,
      sha256: await hashFile(receiptPath),
      receiptHash: receipt.receiptHash,
      catalogId: receipt.catalogId,
      catalogHash: receipt.catalogHash,
      continuityContractHash: receipt.continuityContractHash,
      segmentCount: receipt.segmentCount,
      applicationMode: receipt.applicationMode,
      providerEligible: receipt.providerEligible,
      providerSubmissionPlanned: receipt.providerSubmissionPlanned,
      submittedToProvider: receipt.submittedToProvider,
      providerRequestSentThisRun: receipt.providerRequestSentThisRun,
      inheritedProviderSubmission: receipt.inheritedProviderSubmission,
      sourceSubmissionRunId: receipt.sourceSubmissionRunId,
      sourceGenerationHash: receipt.sourceGenerationHash,
      providerRequestHash: receipt.providerRequestHash,
      providerGenerationHash: receipt.providerGenerationHash
    };
    const immutableArtifacts = [
      { name: "script.json", path: `runs/${runId}/artifacts/script.json`, bytes: scriptStat.size, sha256: await hashFile(scriptPath) },
      { name: receiptName, path: `runs/${runId}/artifacts/${receiptName.replaceAll("/", "__")}`, bytes: receiptStat.size, sha256: reference.sha256 }
    ];
    const manifest = { runId, shotPatterns: reference, script: { shotPatterns: { ...reference } }, immutableArtifacts };
    const sealedQuality = {
      metrics: {
        provider: "local",
        providerEvidenceEligible: false,
        providerProof: false,
        shotPatternReceiptBinding: true,
        shotPatternReceipt: {
          path: receiptName,
          sha256: reference.sha256,
          receiptHash: reference.receiptHash,
          catalogId: reference.catalogId,
          applicationMode: reference.applicationMode,
          submittedToProvider: reference.submittedToProvider,
          providerRequestSentThisRun: reference.providerRequestSentThisRun,
          inheritedProviderSubmission: reference.inheritedProviderSubmission,
          sourceSubmissionRunId: reference.sourceSubmissionRunId,
          sourceGenerationHash: reference.sourceGenerationHash,
          segmentCount: reference.segmentCount
        },
        evidenceHashes: { [receiptName]: reference.sha256 }
      }
    };

    expect(await verifyImmutableShotPatternClosure({ id: jobId, runId }, "local", sealedQuality, manifest)).toBe(true);

    const tampered = structuredClone(receipt);
    tampered.segments[0].patternId = "tampered-pattern";
    const { receiptHash: _oldReceiptHash, ...tamperedPayload } = tampered;
    tampered.receiptHash = hashShotPatternValue(tamperedPayload);
    await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const tamperedStat = await stat(receiptPath);
    const tamperedSha = await hashFile(receiptPath);
    const tamperedReference = { ...reference, sha256: tamperedSha, receiptHash: tampered.receiptHash };
    const tamperedManifest = {
      ...manifest,
      shotPatterns: tamperedReference,
      script: { shotPatterns: { ...tamperedReference } },
      immutableArtifacts: immutableArtifacts.map((artifact) => artifact.name === receiptName
        ? { ...artifact, bytes: tamperedStat.size, sha256: tamperedSha }
        : artifact)
    };
    const tamperedQuality = {
      metrics: {
        ...sealedQuality.metrics,
        shotPatternReceipt: {
          ...sealedQuality.metrics.shotPatternReceipt,
          sha256: tamperedSha,
          receiptHash: tampered.receiptHash
        },
        evidenceHashes: { [receiptName]: tamperedSha }
      }
    };
    expect(await verifyImmutableShotPatternClosure({ id: jobId, runId }, "local", tamperedQuality, tamperedManifest)).toBe(false);
  });
});

describe("monitor response redaction", () => {
  test("removes identity, profile paths, body excerpts, and nested email strings without mutating input", () => {
    const source = {
      status: "quota-blocked",
      email: "person@example.com",
      nextEmail: "next@example.com",
      profileDir: "/Users/private/.ps4/chrome-profile",
      bodyExcerpt: "secret page text",
      profiles: [{
        id: "account-1",
        email: "nested@example.com",
        profilePath: "C:\\Users\\private\\chrome-profile",
        bodyExcerpt: "another secret",
        quotaMessage: "Contact nested@example.com after reset",
        diagnostic: "using /tmp/private/chrome-profile for this run"
      }],
      quota: { account: "Google Account person@example.com", available: false }
    };

    const redacted = redactGeminiMonitor(source);
    const serialized = JSON.stringify(redacted);

    expect(redacted.status).toBe("quota-blocked");
    expect(redacted.profiles[0].id).toBe("account-1");
    expect(redacted.profiles[0].quotaMessage).toEqual(
      monitorDiagnosticEvidence(source.profiles[0].quotaMessage, "monitor-quota-text-redacted")
    );
    expect(redacted.profiles[0].diagnostic).toEqual(
      monitorDiagnosticEvidence(source.profiles[0].diagnostic, "monitor-diagnostic-redacted")
    );
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("nested@example.com");
    expect(serialized).not.toContain("chrome-profile");
    expect(serialized).not.toContain("secret page text");
    expect(source.email).toBe("person@example.com");
  });

  test("applies redaction on the real monitor API response", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(new Request("http://127.0.0.1:3000/api/gemini/monitor", {
      headers: { authorization: `Bearer ${token}` }
    }));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toContain('"profileDir"');
    expect(serialized).not.toContain('"bodyExcerpt"');
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  test("reads a bounded exclusive monitor inode and preserves the projected response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-monitor-route-"));
    temporaryDirectories.push(directory);
    const monitorPath = join(directory, "gemini-monitor.json");
    await writeFile(monitorPath, JSON.stringify({
      schemaVersion: 2,
      status: "quota-available",
      updatedAt: "2026-08-13T00:00:00.000Z",
      email: "private@example.test",
      profiles: [{
        id: "account-1",
        available: true,
        email: "nested@example.test",
        profileDir: "/Users/private/profile",
        quotaMessage: "private quota text"
      }]
    }));
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token, geminiMonitorPath: monitorPath });
    const response = await handler(new Request("http://127.0.0.1:3000/api/gemini/monitor", {
      headers: { authorization: `Bearer ${token}` }
    }));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ schemaVersion: 2, status: "quota-available", profiles: [{ id: "account-1", available: true }] });
    expect(payload.profiles[0].quotaMessage).toEqual(
      monitorDiagnosticEvidence("private quota text", "monitor-quota-text-redacted")
    );
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("nested@example.test");
    expect(serialized).not.toContain("/Users/private/profile");
    expect(serialized).not.toContain("private quota text");
  });

  test("fails closed before reading an oversized sparse or malformed monitor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-monitor-bounds-"));
    temporaryDirectories.push(directory);
    const monitorPath = join(directory, "gemini-monitor.json");
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token, geminiMonitorPath: monitorPath });
    const request = () => new Request("http://127.0.0.1:3000/api/gemini/monitor", {
      headers: { authorization: `Bearer ${token}` }
    });

    await writeFile(monitorPath, "{}");
    await truncate(monitorPath, 64 * 1024 * 1024);
    expect((await stat(monitorPath)).size).toBeGreaterThan(MAX_GEMINI_MONITOR_BYTES);
    const oversized = await handler(request());
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toEqual({ schemaVersion: 2, status: "not-running", profiles: [] });

    await writeFile(monitorPath, "{");
    const malformed = await handler(request());
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ schemaVersion: 2, status: "not-running", profiles: [] });
  });

  test("rejects monitor symlinks and hardlinks without observing or mutating the external file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-monitor-links-"));
    temporaryDirectories.push(directory);
    const monitorPath = join(directory, "gemini-monitor.json");
    const externalPath = join(directory, "external-monitor.json");
    const externalBytes = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      status: "quota-available",
      profiles: [{ id: "external-secret", email: "external-secret@example.test" }]
    }));
    await writeFile(externalPath, externalBytes);
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token, geminiMonitorPath: monitorPath });
    const request = () => new Request("http://127.0.0.1:3000/api/gemini/monitor", {
      headers: { authorization: `Bearer ${token}` }
    });
    const assertExternalUnchanged = async (before) => {
      const after = await stat(externalPath, { bigint: true });
      expect(await readFile(externalPath)).toEqual(externalBytes);
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
    };

    await symlink(externalPath, monitorPath);
    const beforeSymlink = await stat(externalPath, { bigint: true });
    const symlinkResponse = await handler(request());
    expect(await symlinkResponse.json()).toEqual({ schemaVersion: 2, status: "not-running", profiles: [] });
    await assertExternalUnchanged(beforeSymlink);

    await rm(monitorPath);
    await link(externalPath, monitorPath);
    const beforeHardlink = await stat(externalPath, { bigint: true });
    const hardlinkResponse = await handler(request());
    expect(await hardlinkResponse.json()).toEqual({ schemaVersion: 2, status: "not-running", profiles: [] });
    await assertExternalUnchanged(beforeHardlink);
  });
});

describe("upload resource limits", () => {
  test("bounds every JSON body by observed bytes even without Content-Length", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls > 8) controller.close();
      },
      cancel() { cancelled = true; }
    });
    const request = new Request("http://127.0.0.1:3000/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJson(request)).rejects.toMatchObject({ statusCode: 413 });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(Math.ceil(MAX_JSON_BODY_BYTES / chunk.byteLength) + 2);

    const wrongType = new Request("http://127.0.0.1:3000/api/jobs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}"
    });
    await expect(readJson(wrongType)).rejects.toMatchObject({ statusCode: 415 });
  });

  test("rejects credentialed create sources before creating or echoing a job", async () => {
    await listJobs();
    const before = new Set(await readdir(JOBS_DIR));
    const token = createSessionToken();
    const secret = "do-not-echo-this-password";
    const handler = createStudioRequestHandler({ token });
    const response = await handler(new Request("http://127.0.0.1:3000/api/jobs", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        topic: "credential 출처 조기 차단",
        provider: "local",
        autoStart: false,
        sources: [{ title: "private", url: `https://user:${secret}@example.test/source` }]
      })
    }));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(400);
    expect(serialized).not.toContain(secret);
    expect(new Set(await readdir(JOBS_DIR))).toEqual(before);
  });

  test("enforces file count, per-file bytes, and aggregate bytes", () => {
    expect(MAX_UPLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_UPLOAD_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    expect(validateUploadBatch([{ size: 40 }, { size: 60 }], {
      maxFiles: 2,
      maxFileBytes: 80,
      maxTotalBytes: 100
    })).toEqual({ count: 2, totalBytes: 100 });

    expect(() => validateUploadBatch(Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => ({ size: 1 })))).toThrow("최대");
    expect(() => validateUploadBatch([{ size: 81 }], { maxFiles: 2, maxFileBytes: 80, maxTotalBytes: 100 })).toThrow("하나의 최대");
    expect(() => validateUploadBatch([{ size: 60 }, { size: 41 }], { maxFiles: 2, maxFileBytes: 80, maxTotalBytes: 100 })).toThrow("전체 크기");
  });

  test("rejects oversized or malformed Content-Length before multipart parsing", () => {
    const oversized = new Request("http://127.0.0.1:3000/upload", { headers: { "content-length": "101" } });
    const malformed = new Request("http://127.0.0.1:3000/upload", { headers: { "content-length": "1e3" } });

    expect(() => validateRequestContentLength(oversized, 100)).toThrow("허용 크기");
    expect(() => validateRequestContentLength(malformed, 100)).toThrow("올바르지");

    const maximumMultipartEnvelope = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;
    const admitted = new Request("http://127.0.0.1:3000/upload", {
      headers: { "content-length": String(maximumMultipartEnvelope) }
    });
    const rejected = new Request("http://127.0.0.1:3000/upload", {
      headers: { "content-length": String(maximumMultipartEnvelope + 1) }
    });
    expect(validateRequestContentLength(admitted)).toBe(maximumMultipartEnvelope);
    expect(() => validateRequestContentLength(rejected)).toThrow("허용 크기");
  });

  test("publishes same-named local clips in multipart order and requires the exact job count before replacement", async () => {
    const token = createSessionToken();
    let starts = 0;
    let probeCalls = 0;
    const handler = createStudioRequestHandler({
      token,
      startJobFn: async () => { starts += 1; return true; },
      localClipUploadOptions: {
        probeClipFn: async () => {
          probeCalls += 1;
          return { durationSec: 5, width: 1080, height: 1920, codec: "h264", formatNames: ["mov", "mp4"] };
        },
        nowFn: () => "2026-08-13T01:02:03.000Z"
      }
    });
    const job = await createJob({ topic: "Playground 클립 순서", provider: "local", clipCount: 2, targetDurationSec: 20 });
    const jobPath = join(JOBS_DIR, job.id, "job.json");
    const jobBytesBefore = await readFile(jobPath);
    const upload = async (selected, expectedRunIds = [""]) => {
      const form = new FormData();
      expectedRunIds.forEach((runId) => form.append("expectedRunId", runId));
      selected.forEach((file) => form.append("files", file));
      return handler(new Request(`http://127.0.0.1:3000/api/jobs/${job.id}/clips`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "same-origin"
        },
        body: form
      }));
    };

    const twoFiles = () => [
      new File(["first"], "same.mp4", { type: "video/mp4" }),
      new File(["second"], "same.mp4", { type: "video/mp4" })
    ];
    for (const expectedRunIds of [[], ["unsafe/run"], ["", ""]]) {
      const rejected = await upload(twoFiles(), expectedRunIds);
      expect(rejected.status).toBe(409);
      expect(await readFile(jobPath)).toEqual(jobBytesBefore);
      expect(await readdir(join(JOBS_DIR, job.id, "clips"))).toEqual([]);
      expect((await readdir(join(JOBS_DIR, job.id))).some((name) => name.startsWith(".clips-upload-"))).toBe(false);
    }
    expect(probeCalls).toBe(0);

    const wrongCount = await upload([new File(["only"], "same.mp4", { type: "video/mp4" })]);
    expect(wrongCount.status).toBe(400);
    expect((await wrongCount.json()).error).toContain("정확히 2개");
    expect(await readdir(join(JOBS_DIR, job.id, "clips"))).toEqual([]);

    const response = await upload(twoFiles());
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload.uploaded).toMatchObject([{ index: 1, name: "01.mp4" }, { index: 2, name: "02.mp4" }]);
    expect(await readFile(join(JOBS_DIR, job.id, "clips", "01.mp4"), "utf8")).toBe("first");
    expect(await readFile(join(JOBS_DIR, job.id, "clips", "02.mp4"), "utf8")).toBe("second");
    expect(probeCalls).toBe(2);
    expect(payload.job.localClipImport).toMatchObject({ source: "manual-user-upload", providerEvidenceEligible: false, clipCount: 2 });

    const runResponse = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${job.id}/run`, token));
    expect(runResponse.status).toBe(200);
    expect(starts).toBe(1);
  });

  test("recovers a route-level crash after the durable clip-set decision before exposing the job", async () => {
    const token = createSessionToken();
    const job = await createJob({ topic: "Playground 업로드 복구", provider: "local", clipCount: 2, targetDurationSec: 20 });
    const crashing = createStudioRequestHandler({
      token,
      localClipUploadOptions: {
        probeClipFn: async () => ({ durationSec: 5, width: 1080, height: 1920, codec: "h264", formatNames: ["mov", "mp4"] }),
        recoverOnError: false,
        hooks: { afterClipsInstalled: async () => { throw new Error("simulated route power loss"); } }
      }
    });
    const form = new FormData();
    form.append("expectedRunId", "");
    form.append("files", new File(["new-one"], "one.mp4", { type: "video/mp4" }));
    form.append("files", new File(["new-two"], "two.mp4", { type: "video/mp4" }));
    const failed = await crashing(new Request(`http://127.0.0.1:3000/api/jobs/${job.id}/clips`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "sec-fetch-site": "same-origin"
      },
      body: form
    }));
    expect(failed.status).toBe(500);
    expect(await stat(join(JOBS_DIR, job.id, ".local-clip-upload-transaction.json"))).toBeTruthy();

    const blockedRead = await crashing(new Request(`http://127.0.0.1:3000/api/jobs/${job.id}`, {
      headers: { authorization: `Bearer ${token}` }
    }));
    expect(blockedRead.status).toBe(200);
    expect((await blockedRead.json()).integrity).toMatchObject({ status: "blocked", code: "local-clip-upload-transaction-integrity-failure" });

    const recovering = createStudioRequestHandler({ token });
    const listResponse = await recovering(new Request("http://127.0.0.1:3000/api/jobs", {
      headers: { authorization: `Bearer ${token}` }
    }));
    expect(listResponse.status).toBe(200);
    const recovered = (await listResponse.json()).jobs.find((entry) => entry.id === job.id);
    expect(recovered).toMatchObject({ status: "queued", runId: null, localClipImport: { status: "ready", clipCount: 2 } });
    expect(await stat(join(JOBS_DIR, job.id, ".local-clip-upload-transaction.json")).catch(() => null)).toBeNull();
  });

  test("isolates a corrupt local-upload marker to one job and blocks every mutation on it", async () => {
    const token = createSessionToken();
    const corrupt = await createJob({ topic: "손상 업로드 격리", provider: "local", clipCount: 2, targetDurationSec: 20 });
    const healthy = await createJob({ topic: "정상 작업 유지", provider: "local", clipCount: 2, targetDurationSec: 20 });
    await writeFile(join(JOBS_DIR, corrupt.id, ".local-clip-upload-transaction.json"), "{not-json", { mode: 0o600 });
    const handler = createStudioRequestHandler({ token });

    const response = await handler(new Request("http://127.0.0.1:3000/api/jobs", {
      headers: { authorization: `Bearer ${token}` }
    }));
    expect(response.status).toBe(200);
    const jobs = (await response.json()).jobs;
    expect(jobs.find((job) => job.id === corrupt.id)?.integrity).toMatchObject({ status: "blocked", code: "local-clip-upload-transaction-integrity-failure" });
    expect(jobs.find((job) => job.id === healthy.id)?.integrity).toBeUndefined();

    const mutation = await handler(mutationRequest(`http://127.0.0.1:3000/api/jobs/${corrupt.id}/run`, token));
    expect(mutation.status).toBe(409);
    expect((await mutation.json()).error).toContain("transaction 무결성 차단");
  });
});

describe("loopback host boundary", () => {
  test("recognizes loopback names and rejects lookalikes", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.99.4.2")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });
});
