import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST,
  MAX_UPLOAD_FILES,
  SESSION_COOKIE_NAME,
  authorizeMutationRequest,
  createSessionCookie,
  createSessionToken,
  createStudioRequestHandler,
  immutableProviderClosureBound,
  isLoopbackHostname,
  persistStudioToken,
  redactGeminiMonitor,
  resolveStudioToken,
  shouldIssueSessionCookie,
  startStudioServer,
  verifyImmutableShotPatternClosure,
  validateRequestContentLength,
  validateUploadBatch
} from "../src/server.mjs";
import { JOBS_DIR } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { applyShotPatternsToScript, createShotPatternReceipt, hashShotPatternValue, readShotPatternCatalog } from "../src/shot-patterns.mjs";

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
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "sec-fetch-site": "same-origin",
      ...headers
    }
  });
}

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
    expect(() => resolveStudioToken("short-token")).toThrow("최소 32바이트");
    expect(() => resolveStudioToken(` ${"x".repeat(40)}`)).toThrow("공백 없이");
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
});

describe("same-origin mutation authorization", () => {
  test("accepts the HttpOnly session cookie from the exact loopback origin", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://127.0.0.1:3000/api/jobs", token);

    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toEqual({ ok: true, code: "session" });
  });

  test("accepts an exact bearer token but still requires same-origin", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://localhost:3000/api/jobs", token, {
      cookie: "",
      authorization: `Bearer ${token}`
    });
    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toEqual({ ok: true, code: "bearer" });

    const crossOrigin = mutationRequest("http://localhost:3000/api/jobs", token, {
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
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` }
    });
    const rebound = new Request("http://attacker.example:3000/api/jobs", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authorizeMutationRequest(unauthenticated, new URL(unauthenticated.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    expect(authorizeMutationRequest(authenticated, new URL(authenticated.url), { token })).toEqual({ ok: true, code: "safe-session" });
    expect(authorizeMutationRequest(rebound, new URL(rebound.url), { token })).toMatchObject({ ok: false, code: "untrusted-host" });
  });

  test("issues the session only for a top-level loopback UI navigation", () => {
    const token = createSessionToken();
    const navigation = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });
    const subresource = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-origin" }
    });
    const rebound = new Request("http://attacker.example:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });

    expect(shouldIssueSessionCookie(navigation)).toBe(true);
    expect(shouldIssueSessionCookie(subresource)).toBe(false);
    expect(shouldIssueSessionCookie(rebound)).toBe(false);
    expect(createSessionCookie(token)).toContain("HttpOnly; SameSite=Strict");
    expect(createSessionCookie(token)).not.toContain("Domain=");
  });

  test("enforces the gate in the actual Bun request handler while UI bootstrap remains usable", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const navigation = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });
    const uiResponse = await handler(navigation);
    expect(uiResponse.status).toBe(200);
    expect(uiResponse.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(uiResponse.headers.get("set-cookie")).toContain("HttpOnly");

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
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` }
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

  test("binds a real Bun server to the loopback interface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-test-"));
    temporaryDirectories.push(directory);
    const token = createSessionToken();
    const server = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      token,
      tokenPath: join(directory, "runtime", "studio-token")
    });
    try {
      expect(server.hostname).toBe(DEFAULT_HOST);
      expect(String(server.url)).toStartWith(`http://${DEFAULT_HOST}:`);

      const uiResponse = await fetch(server.url);
      const cookie = uiResponse.headers.get("set-cookie");
      expect(uiResponse.status).toBe(200);
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

      const rejected = await fetch(new URL("/api/not-found", server.url), { method: "POST" });
      expect(rejected.status).toBe(403);

      const rejectedRead = await fetch(new URL("/api/jobs", server.url));
      expect(rejectedRead.status).toBe(403);

      const acceptedRead = await fetch(new URL("/api/jobs", server.url), {
        headers: { cookie: cookie.split(";", 1)[0] }
      });
      expect(acceptedRead.status).toBe(200);

      const accepted = await fetch(new URL("/api/not-found", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: cookie.split(";", 1)[0]
        }
      });
      expect(accepted.status).toBe(404);
    } finally {
      server.stop(true);
    }
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
      providerProof: true,
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
      { metrics: { provider: "local", providerProof: true } },
      { runId: "legacy-run", immutableArtifacts: [] },
      {}
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
        providerProof: true,
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
    expect(redacted.profiles[0].quotaMessage).toBe("Contact [redacted-email] after reset");
    expect(redacted.profiles[0].diagnostic).toBe("using [redacted-profile-path] for this run");
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
});

describe("upload resource limits", () => {
  test("enforces file count, per-file bytes, and aggregate bytes", () => {
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
