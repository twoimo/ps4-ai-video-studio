import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireGeminiMonitorLease,
  GEMINI_MONITOR_PRIVATE_FILE_LIMITS,
  monitorDiagnosticEvidence,
  persistGeminiMonitorEvent,
  readRedactedGeminiMonitorState,
  redactGeminiMonitor,
  scrubGeminiMonitorArtifacts,
  writePrivateJson
} from "../src/gemini-monitor-privacy.mjs";
import {
  consumeUltragoalResumeSignal,
  createUltragoalResumeSignal,
  publishUltragoalResumeSignal,
  verifyUltragoalResumeSignal
} from "../src/ultragoal-signal.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixturePaths() {
  const directory = await mkdtemp(join(tmpdir(), "ps4-monitor-privacy-"));
  temporaryDirectories.push(directory);
  return {
    statePath: join(directory, "runtime", "gemini-monitor.json"),
    logPath: join(directory, "runtime", "gemini-monitor.jsonl"),
    signalPath: join(directory, "runtime", "ultragoal.json")
  };
}

describe("Gemini monitor persistence privacy", () => {
  test("uses a closed public schema for credential fields at every depth", () => {
    const secret = "monitor-secret-never-public";
    const source = {
      schemaVersion: 2,
      status: "monitoring",
      profiles: [{
        id: "account-1",
        cdpUrl: "http://127.0.0.1:9222",
        available: true,
        apiKey: secret,
        nested: { token: secret }
      }],
      apiKey: secret,
      authorization: `Bearer ${secret}`,
      accessToken: secret,
      password: secret,
      token: secret,
      secret,
      cookie: secret,
      setCookie: secret,
      clientSecret: secret,
      credential: secret,
      credentials: { value: secret },
      OMLX_API_KEY: secret,
      PS4_STUDIO_TOKEN: secret,
      completion: {
        jobStatus: "running",
        authorization: `Bearer ${secret}`,
        array: [{ password: secret }]
      },
      lastError: `Bearer ${secret}`,
      arbitraryFutureField: { apiKey: secret }
    };

    const projected = redactGeminiMonitor(source);
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      schemaVersion: 2,
      status: "monitoring",
      profiles: [{ id: "account-1", cdpUrl: "http://127.0.0.1:9222", available: true }],
      completion: { jobStatus: "running" }
    });
    expect(projected.lastError).toEqual(monitorDiagnosticEvidence(source.lastError, "monitor-error-redacted"));
    expect(serialized).not.toContain(secret);
    for (const key of [
      "apiKey", "authorization", "accessToken", "password", "token", "secret", "cookie",
      "setCookie", "clientSecret", "credential", "credentials", "OMLX_API_KEY",
      "PS4_STUDIO_TOKEN", "arbitraryFutureField"
    ]) expect(serialized).not.toContain(`\"${key}\"`);
    expect(source.apiKey).toBe(secret);
  });

  test("allows one kernel-lock owner, preserves its canonical inode, and repairs stale torn owner bytes", async () => {
    const paths = await fixturePaths();
    const lockPath = join(paths.statePath, "..", "gemini-monitor.lock");
    const first = await acquireGeminiMonitorLease(lockPath, {
      pid: 41001,
      now: new Date("2026-08-12T10:00:00.000Z"),
      nonce: "11111111-1111-4111-8111-111111111111"
    });
    await expect(acquireGeminiMonitorLease(lockPath, {
      pid: 41002,
      now: new Date("2026-08-12T10:00:01.000Z"),
      nonce: "22222222-2222-4222-8222-222222222222"
    })).rejects.toMatchObject({ code: "GEMINI_MONITOR_ALREADY_RUNNING" });
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    const firstBytes = await readFile(lockPath);
    const firstIdentity = await stat(lockPath, { bigint: true });
    await first.release();
    await first.release();
    const releasedIdentity = await stat(lockPath, { bigint: true });
    expect(releasedIdentity.dev).toBe(firstIdentity.dev);
    expect(releasedIdentity.ino).toBe(firstIdentity.ino);
    expect(await readFile(lockPath)).toEqual(firstBytes);

    const second = await acquireGeminiMonitorLease(lockPath, {
      pid: 41002,
      now: new Date("2026-08-12T10:00:02.000Z"),
      nonce: "22222222-2222-4222-8222-222222222222"
    });
    await second.release();

    const tornBytes = Buffer.alloc(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes, 0x7b);
    await writeFile(lockPath, tornBytes, { mode: 0o600 });
    const tornIdentity = await stat(lockPath, { bigint: true });
    const repaired = await acquireGeminiMonitorLease(lockPath, {
      pid: 41003,
      now: new Date("2026-08-12T10:00:03.000Z"),
      nonce: "33333333-3333-4333-8333-333333333333"
    });
    const repairedIdentity = await stat(lockPath, { bigint: true });
    expect(repairedIdentity.dev).toBe(tornIdentity.dev);
    expect(repairedIdentity.ino).toBe(tornIdentity.ino);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      pid: 41003,
      nonce: "33333333-3333-4333-8333-333333333333"
    });
    await repaired.release();
  });

  test("reports malformed bytes as busy while locked and repairs them after a publication-boundary crash", async () => {
    const paths = await fixturePaths();
    const lockPath = join(paths.statePath, "..", "gemini-monitor.lock");
    const childPath = join(dirname(paths.statePath), "lease-publication-child.mjs");
    const signalPath = join(dirname(paths.statePath), "lease-publication-locked");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "gemini-monitor-privacy.mjs")).href;
    await mkdir(dirname(childPath), { recursive: true });
    await writeFile(lockPath, Buffer.alloc(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes, 0x5b), { mode: 0o600 });
    const originalIdentity = await stat(lockPath, { bigint: true });
    await writeFile(childPath, [
      "const { writeFile } = await import('node:fs/promises');",
      "const { acquireGeminiMonitorLease } = await import(process.argv[4]);",
      "await acquireGeminiMonitorLease(process.argv[2], { hooks: { afterLeaseLocked: async () => {",
      "  await writeFile(process.argv[3], 'locked-before-owner-publication');",
      "  await new Promise(() => {});",
      "} } });"
    ].join("\n"));

    const child = spawn(process.execPath, [childPath, lockPath, signalPath, moduleUrl], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !(await stat(signalPath).then(() => true, () => false))) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("publication child exited before lock signal");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFile(signalPath, "utf8")).toBe("locked-before-owner-publication");
      await expect(acquireGeminiMonitorLease(lockPath)).rejects.toMatchObject({
        code: "GEMINI_MONITOR_ALREADY_RUNNING",
        owner: null
      });

      child.kill("SIGKILL");
      await once(child, "exit");
      const repaired = await acquireGeminiMonitorLease(lockPath, {
        pid: process.pid,
        now: new Date("2026-08-12T10:00:30.000Z"),
        nonce: "88888888-8888-4888-8888-888888888888"
      });
      const repairedIdentity = await stat(lockPath, { bigint: true });
      expect(repairedIdentity.dev).toBe(originalIdentity.dev);
      expect(repairedIdentity.ino).toBe(originalIdentity.ino);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
        pid: process.pid,
        nonce: "88888888-8888-4888-8888-888888888888"
      });
      await repaired.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
      }
    }
  });

  test("reacquires the permanent canonical lease after a real SIGKILL crash", async () => {
    const paths = await fixturePaths();
    const lockPath = join(paths.statePath, "..", "gemini-monitor.lock");
    const childPath = join(dirname(paths.statePath), "lease-owner-child.mjs");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "gemini-monitor-privacy.mjs")).href;
    await mkdir(dirname(childPath), { recursive: true });
    await writeFile(childPath, [
      "const { acquireGeminiMonitorLease } = await import(process.argv[3]);",
      "await acquireGeminiMonitorLease(process.argv[2]);",
      "process.stdout.write('acquired\\n');",
      "setInterval(() => {}, 1000);"
    ].join("\n"));

    const child = spawn(process.execPath, [childPath, lockPath, moduleUrl], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const firstOutput = await Promise.race([
        once(child.stdout, "data").then(([chunk]) => String(chunk)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("lease child startup timeout")), 5_000))
      ]);
      expect(firstOutput).toContain("acquired");
      await expect(acquireGeminiMonitorLease(lockPath)).rejects.toMatchObject({
        code: "GEMINI_MONITOR_ALREADY_RUNNING",
        owner: { pid: child.pid }
      });

      child.kill("SIGKILL");
      await once(child, "exit");
      const crashedIdentity = await stat(lockPath, { bigint: true });
      const replacement = await acquireGeminiMonitorLease(lockPath, {
        pid: process.pid,
        now: new Date("2026-08-12T10:01:00.000Z"),
        nonce: "44444444-4444-4444-8444-444444444444"
      });
      const reacquiredIdentity = await stat(lockPath, { bigint: true });
      expect(reacquiredIdentity.dev).toBe(crashedIdentity.dev);
      expect(reacquiredIdentity.ino).toBe(crashedIdentity.ino);
      await replacement.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
      }
    }
  });

  test("fails closed when the canonical lease inode is swapped after kernel lock acquisition", async () => {
    const paths = await fixturePaths();
    const lockPath = join(paths.statePath, "..", "gemini-monitor.lock");
    const preservedPath = join(paths.statePath, "..", "preserved-monitor.lock");
    const seed = await acquireGeminiMonitorLease(lockPath, {
      pid: 41020,
      now: new Date("2026-08-12T10:00:00.000Z"),
      nonce: "55555555-5555-4555-8555-555555555555"
    });
    await seed.release();
    const originalBytes = await readFile(lockPath);
    const replacementBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      pid: 41021,
      acquiredAt: "2026-08-12T10:00:01.000Z",
      nonce: "66666666-6666-4666-8666-666666666666"
    })}\n`);

    await expect(acquireGeminiMonitorLease(lockPath, {
      pid: 41022,
      now: new Date("2026-08-12T10:00:02.000Z"),
      nonce: "77777777-7777-4777-8777-777777777777",
      hooks: {
        afterLeaseLocked: async () => {
          await rename(lockPath, preservedPath);
          await writeFile(lockPath, replacementBytes, { mode: 0o600 });
        }
      }
    })).rejects.toMatchObject({ code: "GEMINI_MONITOR_LEASE_OWNER_MISMATCH" });

    expect(await readFile(preservedPath)).toEqual(originalBytes);
    expect(await readFile(lockPath)).toEqual(replacementBytes);
  });

  test("never follows or overwrites unsafe state ancestry and rejects oversized bytes before parsing", async () => {
    const paths = await fixturePaths();
    const runtimeDir = dirname(paths.statePath);
    const externalPath = join(runtimeDir, "..", "external-state.json");
    const externalBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, status: "monitoring", profiles: [], apiKey: "external-secret" }));
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(externalPath, externalBytes);

    await symlink(externalPath, paths.statePath);
    expect(await readRedactedGeminiMonitorState(paths.statePath)).toBeNull();
    await expect(scrubGeminiMonitorArtifacts({ statePath: paths.statePath })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.statePath);

    await link(externalPath, paths.statePath);
    expect(await readRedactedGeminiMonitorState(paths.statePath)).toBeNull();
    await expect(scrubGeminiMonitorArtifacts({ statePath: paths.statePath })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.statePath);

    await writeFile(paths.statePath, "");
    await truncate(paths.statePath, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes + 1);
    expect(await readRedactedGeminiMonitorState(paths.statePath)).toBeNull();
    await expect(scrubGeminiMonitorArtifacts({ statePath: paths.statePath })).rejects.toThrow();
    expect((await stat(paths.statePath)).size).toBe(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes + 1);
    await unlink(paths.statePath);

    await writeFile(paths.statePath, Buffer.from([0xc3, 0x28]));
    await scrubGeminiMonitorArtifacts({ statePath: paths.statePath });
    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      event: "privacy_redaction_parse_failure"
    });

    const outsideDir = join(runtimeDir, "..", "external-runtime");
    const aliasDir = join(runtimeDir, "..", "runtime-alias");
    const outsideState = join(outsideDir, "state.json");
    await mkdir(outsideDir);
    await writeFile(outsideState, externalBytes);
    await symlink(outsideDir, aliasDir, "dir");
    await expect(scrubGeminiMonitorArtifacts({ statePath: join(aliasDir, "state.json") })).rejects.toThrow();
    expect(await readFile(outsideState)).toEqual(externalBytes);
  });

  test("treats symlinked, hardlinked, and oversized monitor leases as corrupt without mutating targets", async () => {
    const paths = await fixturePaths();
    const lockPath = join(paths.statePath, "..", ".runtime", "gemini-monitor.lock");
    const externalPath = join(paths.statePath, "..", "lease-external.json");
    const externalBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      pid: 41009,
      acquiredAt: "2026-08-12T10:00:00.000Z",
      nonce: "99999999-9999-4999-8999-999999999999"
    })}\n`);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(externalPath, externalBytes);

    await symlink(externalPath, lockPath);
    await expect(acquireGeminiMonitorLease(lockPath)).rejects.toMatchObject({ code: "GEMINI_MONITOR_LEASE_CORRUPT" });
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(lockPath);

    await link(externalPath, lockPath);
    await expect(acquireGeminiMonitorLease(lockPath)).rejects.toMatchObject({ code: "GEMINI_MONITOR_LEASE_CORRUPT" });
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(lockPath);

    await writeFile(lockPath, "");
    await truncate(lockPath, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes + 1);
    await expect(acquireGeminiMonitorLease(lockPath)).rejects.toMatchObject({ code: "GEMINI_MONITOR_LEASE_CORRUPT" });
    expect((await stat(lockPath)).size).toBe(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes + 1);
  });

  test("wake signals contain operational profile aliases but never configured email labels", () => {
    const signal = createUltragoalResumeSignal({
      event: "provider-available",
      observedAt: "2026-08-12T10:00:00.000Z",
      sequence: 7,
      profileId: "account-1",
      status: "quota-available",
      profiles: [{ id: "account-1", email: "private@example.com", cdpUrl: "http://127.0.0.1:9222", headless: true, available: true }]
    });

    expect(signal.profileObservations).toEqual([{
      id: "account-1",
      cdpUrl: "http://127.0.0.1:9222",
      available: true,
      headless: true,
      videoMode: null,
      quotaResetAt: null,
      observationFailed: false,
      errorCode: null
    }]);
    expect(signal).toMatchObject({ schemaVersion: 2, sequence: 7, profileId: "account-1", ttlMs: 900_000 });
    expect(signal.profileObservationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(signal.signalId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyUltragoalResumeSignal(signal)).toEqual(signal);
    expect(JSON.stringify(signal)).not.toContain("private@example.com");
  });

  test("private JSON publication syncs temp bytes before rename and the parent after rename", async () => {
    const trace = [];
    const tempHandle = {
      writeFile: async () => trace.push("temp-write"),
      chmod: async () => trace.push("temp-chmod"),
      sync: async () => trace.push("temp-sync"),
      close: async () => trace.push("temp-close")
    };
    const parentHandle = {
      sync: async () => trace.push("parent-sync"),
      close: async () => trace.push("parent-close")
    };
    await writePrivateJson("/virtual/runtime/state.json", { status: "queued" }, {
      mkdirFn: async () => trace.push("mkdir"),
      chmodFn: async () => trace.push("parent-chmod"),
      openFn: async (_path, flags) => {
        trace.push(flags === "wx" ? "temp-open" : "parent-open");
        return flags === "wx" ? tempHandle : parentHandle;
      },
      renameFn: async () => trace.push("rename"),
      unlinkFn: async () => trace.push("unlink"),
      randomUUIDFn: () => "durability-test"
    });
    expect(trace).toEqual([
      "mkdir", "parent-chmod", "temp-open", "temp-write", "temp-chmod", "temp-sync", "temp-close",
      "rename", "parent-open", "parent-sync", "parent-close"
    ]);
  });

  test("private JSON publication throws at every crash boundary and never renames unsynced bytes", async () => {
    for (const boundary of ["temp-sync", "rename", "parent-sync"]) {
      const trace = [];
      const injected = new Error(`injected-${boundary}`);
      const tempHandle = {
        writeFile: async () => trace.push("temp-write"),
        chmod: async () => trace.push("temp-chmod"),
        sync: async () => {
          trace.push("temp-sync");
          if (boundary === "temp-sync") throw injected;
        },
        close: async () => trace.push("temp-close")
      };
      const parentHandle = {
        sync: async () => {
          trace.push("parent-sync");
          if (boundary === "parent-sync") throw injected;
        },
        close: async () => trace.push("parent-close")
      };
      await expect(writePrivateJson("/virtual/runtime/state.json", { status: "queued" }, {
        mkdirFn: async () => {},
        chmodFn: async () => {},
        openFn: async (_path, flags) => flags === "wx" ? tempHandle : parentHandle,
        renameFn: async () => {
          trace.push("rename");
          if (boundary === "rename") throw injected;
        },
        unlinkFn: async () => trace.push("unlink"),
        randomUUIDFn: () => `failure-${boundary}`
      })).rejects.toThrow(`injected-${boundary}`);
      expect(trace.includes("rename")).toBe(boundary !== "temp-sync");
      expect(trace.includes("parent-sync")).toBe(boundary === "parent-sync");
      expect(trace.includes("unlink")).toBe(boundary !== "parent-sync");
    }
  });

  test("persists and logs only the redacted monitor projection", async () => {
    const paths = await fixturePaths();
    const logged = [];
    const raw = {
      status: "quota-blocked",
      profiles: [{
        id: "account-1",
        email: "real@example.com",
        account: "Google Account Real Name (real@example.com)",
        profileDir: "/Users/private/.ps4-ai-video-studio/chrome-profile",
        bodyExcerpt: "private Gemini conversation",
        quotaResetText: "Contact real@example.com when /tmp/private/chrome-profile resets",
        diagnostic: "stack at /Users/private/project/src/file.mjs:1:2",
        available: false
      }],
      lastError: "profile /tmp/private/chrome-profile failed for real@example.com\n    at /Users/private/project/src/file.mjs:1:2"
    };

    const state = await persistGeminiMonitorEvent({
      ...paths,
      state: { schemaVersion: 2 },
      event: "profiles_observed",
      details: raw,
      now: new Date("2026-08-12T10:00:00.000Z"),
      logger: (line) => logged.push(line)
    });
    const stateText = await readFile(paths.statePath, "utf8");
    const logText = await readFile(paths.logPath, "utf8");
    const combined = `${stateText}\n${logText}\n${logged.join("\n")}`;

    expect(state).toEqual(redactGeminiMonitor(state));
    expect(state.profiles[0]).toEqual({
      id: "account-1",
      quotaResetText: monitorDiagnosticEvidence(raw.profiles[0].quotaResetText, "monitor-quota-text-redacted"),
      diagnostic: monitorDiagnosticEvidence(raw.profiles[0].diagnostic, "monitor-diagnostic-redacted"),
      available: false
    });
    expect(combined).not.toContain("real@example.com");
    expect(combined).not.toContain("Real Name");
    expect(combined).not.toContain("private Gemini conversation");
    expect(combined).not.toContain("/Users/private");
    expect(combined).not.toContain("/tmp/private");
    expect(state.lastError).toEqual(monitorDiagnosticEvidence(raw.lastError, "monitor-error-redacted"));
    expect(JSON.stringify(state.lastError)).not.toContain("src/file.mjs");
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.logPath)).mode & 0o777).toBe(0o600);
  });

  test("rotates a near-cap JSONL into hash-only provenance plus a bounded redacted complete-line tail", async () => {
    const paths = await fixturePaths();
    const secret = "rotation-secret-never-public";
    const historicalLine = Buffer.from(`${JSON.stringify({
      schemaVersion: 2,
      event: "old_event",
      at: "2026-08-12T09:00:00.000Z",
      attempts: 1,
      reason: `apiKey=${secret}`,
      arbitraryFutureField: { authorization: `Bearer ${secret}` }
    })}\n`);
    const repetitions = Math.floor((GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes - 1) / historicalLine.byteLength);
    const previous = Buffer.concat(
      Array.from({ length: repetitions }, () => historicalLine),
      repetitions * historicalLine.byteLength
    );
    await mkdir(dirname(paths.logPath), { recursive: true, mode: 0o700 });
    await writeFile(paths.logPath, previous, { mode: 0o600 });

    await persistGeminiMonitorEvent({
      ...paths,
      state: { schemaVersion: 2, status: "monitoring" },
      event: "near_cap_event",
      details: { reason: `safe-${"x".repeat(4096)}` },
      now: new Date("2026-08-12T10:00:00.000Z"),
      logger: null
    });

    const rotatedBytes = await readFile(paths.logPath);
    const rotatedText = rotatedBytes.toString("utf8");
    const records = rotatedText.trim().split("\n").map((line) => JSON.parse(line));
    expect(rotatedBytes.byteLength).toBeLessThanOrEqual(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes);
    expect(records[0]).toEqual({
      schemaVersion: 2,
      event: "privacy_log_rotated",
      byteLength: previous.byteLength,
      originalSha256: `sha256:${createHash("sha256").update(previous).digest("hex")}`
    });
    expect(records.filter((record) => record.event === "old_event").length).toBeGreaterThan(0);
    expect(records.filter((record) => record.event === "old_event").length).toBeLessThanOrEqual(1024);
    expect(records.at(-1).event).toBe("near_cap_event");
    expect(rotatedText).not.toContain(secret);
    expect((await stat(paths.logPath)).mode & 0o777).toBe(0o600);

    // A restarted monitor appends to the rotated canonical log instead of
    // hitting the old permanent hard cap again.
    await persistGeminiMonitorEvent({
      ...paths,
      state: { schemaVersion: 2, status: "resuming" },
      event: "restart_event",
      details: { status: "monitoring" },
      now: new Date("2026-08-12T10:01:00.000Z"),
      logger: null
    });
    const restarted = (await readFile(paths.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(restarted.at(-1)).toMatchObject({ event: "restart_event", status: "monitoring" });
    expect((await stat(paths.logPath)).size).toBeLessThanOrEqual(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes);
  });

  test("log rotation rejects aliased inodes without changing external bytes or metadata", async () => {
    const paths = await fixturePaths();
    const runtimeDir = dirname(paths.logPath);
    const externalPath = join(runtimeDir, "..", "external-monitor-log.jsonl");
    const externalBytes = Buffer.from(`${JSON.stringify({ event: "external", apiKey: "external-secret" })}\n`);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(externalPath, externalBytes, { mode: 0o640 });
    const snapshot = async () => {
      const value = await stat(externalPath, { bigint: true });
      return {
        dev: value.dev,
        ino: value.ino,
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs
      };
    };
    const append = () => persistGeminiMonitorEvent({
      ...paths,
      state: { schemaVersion: 2 },
      event: "must_not_publish",
      details: {},
      logger: null
    });

    await symlink(externalPath, paths.logPath);
    const symlinkTargetBefore = await snapshot();
    await expect(append()).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    expect(await snapshot()).toEqual(symlinkTargetBefore);
    await unlink(paths.logPath);

    await link(externalPath, paths.logPath);
    const hardlinkTargetBefore = await snapshot();
    await expect(append()).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    expect(await snapshot()).toEqual(hardlinkTargetBefore);
    await unlink(paths.logPath);
  });

  test("one-way scrubs legacy state, JSONL and wake signals", async () => {
    const paths = await fixturePaths();
    await persistGeminiMonitorEvent({
      ...paths,
      state: {},
      event: "seed",
      details: {},
      logger: null
    });
    await Bun.write(paths.statePath, JSON.stringify({ account: "Google Account Jane (jane@example.com)", status: "blocked" }));
    await Bun.write(paths.logPath, `${JSON.stringify({ event: "old", bodyExcerpt: "secret", profileDir: "/Users/jane/chrome-profile", quotaMessage: "jane@example.com" })}\nnot-json jane@example.com\n`);
    await Bun.write(paths.signalPath, JSON.stringify({ availableProfiles: [{ email: "jane@example.com", id: "account-1" }] }));

    await scrubGeminiMonitorArtifacts(paths);

    const combined = `${await readFile(paths.statePath, "utf8")}\n${await readFile(paths.logPath, "utf8")}\n${await readFile(paths.signalPath, "utf8")}`;
    expect(combined).not.toContain("jane@example.com");
    expect(combined).not.toContain("/Users/jane");
    expect(combined).not.toContain("secret");
    expect(combined).not.toContain("not-json");
    expect(combined).toContain("privacy_redaction_parse_failure");
    expect((await stat(paths.signalPath)).mode & 0o777).toBe(0o600);
  });

  test("scrubs bounded JSONL line by line and never mutates unsafe or oversized logs", async () => {
    const paths = await fixturePaths();
    const runtimeDir = dirname(paths.logPath);
    const secret = "jsonl-secret-never-public";
    await mkdir(runtimeDir, { recursive: true });
    const records = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
      schemaVersion: 2,
      event: "old_event",
      at: "2026-08-12T10:00:00.000Z",
      attempts: index,
      apiKey: secret,
      authorization: `Bearer ${secret}`,
      error: `${secret}-${index}`,
      arbitrary: { password: secret }
    }));
    await writeFile(paths.logPath, Buffer.concat([
      Buffer.from(records.join("\n")),
      Buffer.from("\n"),
      Buffer.from([0xc3, 0x28])
    ]));

    await scrubGeminiMonitorArtifacts({ logPath: paths.logPath });
    const scrubbed = await readFile(paths.logPath, "utf8");
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain("apiKey");
    expect(scrubbed).not.toContain("authorization");
    expect(scrubbed).toContain("privacy_redaction_parse_failure");
    expect(scrubbed.match(/old_event/g)?.length).toBe(2_000);

    const externalPath = join(runtimeDir, "..", "external-log.jsonl");
    const externalBytes = Buffer.from(`${JSON.stringify({ event: "old_event", apiKey: secret })}\n`);
    await writeFile(externalPath, externalBytes);
    await unlink(paths.logPath);
    await symlink(externalPath, paths.logPath);
    await expect(scrubGeminiMonitorArtifacts({ logPath: paths.logPath })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.logPath);

    await link(externalPath, paths.logPath);
    await expect(scrubGeminiMonitorArtifacts({ logPath: paths.logPath })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.logPath);

    await writeFile(paths.logPath, "");
    await truncate(paths.logPath, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes + 1);
    await expect(scrubGeminiMonitorArtifacts({ logPath: paths.logPath })).rejects.toThrow();
    expect((await stat(paths.logPath)).size).toBe(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes + 1);
    await unlink(paths.logPath);

    // A small legacy input can expand when raw errors become hash receipts.
    // The scrubber rotates to one fixed marker before its output budget grows.
    await writeFile(paths.logPath, Buffer.from(`${'{"error":"x"}\n'.repeat(35_000)}`));
    await scrubGeminiMonitorArtifacts({ logPath: paths.logPath });
    expect(JSON.parse((await readFile(paths.logPath, "utf8")).trim())).toMatchObject({
      schemaVersion: 2,
      event: "privacy_redaction_file_failure"
    });
    expect((await stat(paths.logPath)).size).toBeLessThan(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logLineBytes);
  });

  test("UltraGoal signals advance monotonically, deduplicate live equivalents, expire, and are consumed once", async () => {
    const paths = await fixturePaths();
    const base = {
      event: "provider-available",
      goalId: "G005",
      observedAt: "2026-08-12T10:00:00.000Z",
      profileId: "account-1",
      status: "quota-available",
      profiles: [{
        id: "account-1",
        cdpUrl: "http://127.0.0.1:9222",
        available: true,
        headless: true,
        videoMode: true,
        quotaResetAt: null,
        observationFailed: false,
        errorCode: null
      }]
    };
    const first = await publishUltragoalResumeSignal(paths.signalPath, base, { writeSignal: writePrivateJson });
    expect(first).toMatchObject({ published: true, idempotent: false, signal: { sequence: 1 } });

    const duplicate = await publishUltragoalResumeSignal(paths.signalPath, {
      ...base,
      observedAt: "2026-08-12T10:00:10.000Z"
    }, { writeSignal: writePrivateJson });
    expect(duplicate).toMatchObject({ published: false, idempotent: true, signal: { sequence: 1, signalId: first.signal.signalId } });

    const staged = await publishUltragoalResumeSignal(paths.signalPath, {
      ...base,
      event: "production-staged",
      observedAt: "2026-08-12T10:00:20.000Z",
      jobId: "monitor-job-001",
      runId: null,
      status: "production-staged"
    }, { writeSignal: writePrivateJson });
    expect(staged).toMatchObject({ published: true, signal: { sequence: 2, jobId: "monitor-job-001", runId: null } });

    const consumed = await consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: staged.signal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: "2026-08-12T10:01:00.000Z"
    });
    expect(consumed).toMatchObject({ consumed: true, idempotent: false, claim: { sequence: 2, signalId: staged.signal.signalId } });
    expect(await consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: staged.signal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: "2026-08-12T10:01:30.000Z"
    })).toMatchObject({ consumed: true, idempotent: true });
    await expect(consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: staged.signal.signalId,
      consumerId: "ultragoal-runtime-2",
      now: "2026-08-12T10:02:00.000Z"
    })).rejects.toMatchObject({ code: "ULTRAGOAL_SIGNAL_ALREADY_CONSUMED" });
    await expect(consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: staged.signal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: staged.signal.expiresAt
    })).rejects.toMatchObject({ code: "ULTRAGOAL_SIGNAL_EXPIRED" });
  });

  test("UltraGoal publication and consumption fail closed on unsafe or oversized signal files", async () => {
    const paths = await fixturePaths();
    const base = {
      event: "provider-available",
      goalId: "G005",
      observedAt: "2026-08-12T10:00:00.000Z",
      profileId: "account-1",
      status: "quota-available",
      profiles: [{
        id: "account-1",
        cdpUrl: "http://127.0.0.1:9222",
        available: true,
        headless: true,
        videoMode: true,
        quotaResetAt: null,
        observationFailed: false,
        errorCode: null
      }]
    };
    const externalSignal = createUltragoalResumeSignal(base);
    const externalPath = join(dirname(paths.signalPath), "..", "external-signal.json");
    const externalBytes = Buffer.from(`${JSON.stringify(externalSignal)}\n`);
    await mkdir(dirname(paths.signalPath), { recursive: true });
    await writeFile(externalPath, externalBytes);

    await symlink(externalPath, paths.signalPath);
    await expect(publishUltragoalResumeSignal(paths.signalPath, {
      ...base,
      observedAt: "2026-08-12T10:00:10.000Z"
    }, { writeSignal: writePrivateJson })).rejects.toThrow();
    await expect(consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: externalSignal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: "2026-08-12T10:01:00.000Z"
    })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.signalPath);

    await link(externalPath, paths.signalPath);
    await expect(publishUltragoalResumeSignal(paths.signalPath, base, {
      writeSignal: writePrivateJson
    })).rejects.toThrow();
    expect(await readFile(externalPath)).toEqual(externalBytes);
    await unlink(paths.signalPath);

    await writeFile(paths.signalPath, "");
    await truncate(paths.signalPath, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes + 1);
    await expect(publishUltragoalResumeSignal(paths.signalPath, base, {
      writeSignal: writePrivateJson
    })).rejects.toThrow();
    expect((await stat(paths.signalPath)).size).toBe(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes + 1);
  });

  test("UltraGoal idempotent retries re-fsync the exact file and parent before reporting durable success", async () => {
    const paths = await fixturePaths();
    const base = {
      event: "provider-available",
      goalId: "G005",
      observedAt: "2026-08-12T10:00:00.000Z",
      profileId: "account-1",
      status: "quota-available",
      profiles: [{
        id: "account-1",
        cdpUrl: "http://127.0.0.1:9222",
        available: true,
        headless: true,
        videoMode: true,
        quotaResetAt: null,
        observationFailed: false,
        errorCode: null
      }]
    };
    const realOpen = (await import("node:fs/promises")).open;
    const publishOperations = [];
    let publishParentSyncFailures = 1;
    let publishCreates = 0;
    const publishOpen = async (path, flags, mode) => {
      if (flags === "wx") publishCreates += 1;
      const handle = await realOpen(path, flags, mode);
      return {
        readFile: (...args) => handle.readFile(...args),
        writeFile: (...args) => handle.writeFile(...args),
        chmod: (...args) => handle.chmod(...args),
        close: () => handle.close(),
        sync: async () => {
          publishOperations.push(path === join(paths.signalPath, "..")
            ? "parent-sync"
            : path === paths.signalPath ? "file-sync" : "temp-sync");
          if (path === join(paths.signalPath, "..") && publishParentSyncFailures-- > 0) {
            throw new Error("ambiguous publish parent fsync");
          }
          return handle.sync();
        }
      };
    };
    const durableWrite = (path, signal) => writePrivateJson(path, signal, { openFn: publishOpen });
    await expect(publishUltragoalResumeSignal(paths.signalPath, base, {
      openFn: publishOpen,
      writeSignal: durableWrite
    })).rejects.toThrow("ambiguous publish parent fsync");
    const first = await publishUltragoalResumeSignal(paths.signalPath, {
      ...base,
      observedAt: "2026-08-12T10:00:10.000Z"
    }, {
      openFn: publishOpen,
      writeSignal: durableWrite
    });
    expect(first).toMatchObject({ published: false, idempotent: true, signal: { sequence: 1 } });
    expect(publishCreates).toBe(1);
    expect(publishOperations).toEqual(["temp-sync", "parent-sync", "file-sync", "parent-sync"]);

    const claimPath = `${paths.signalPath}.consumed-${first.signal.sequence}.json`;
    const consumeOperations = [];
    let consumeParentSyncFailures = 1;
    let exclusiveCreates = 0;
    let claimWrites = 0;
    const consumeOpen = async (path, flags, mode) => {
      if (flags === "wx") exclusiveCreates += 1;
      const handle = await realOpen(path, flags, mode);
      return {
        readFile: (...args) => handle.readFile(...args),
        writeFile: (...args) => {
          claimWrites += 1;
          return handle.writeFile(...args);
        },
        chmod: (...args) => handle.chmod(...args),
        close: () => handle.close(),
        sync: async () => {
          if (path === claimPath) consumeOperations.push("claim-sync");
          if (path === join(claimPath, "..")) {
            consumeOperations.push("parent-sync");
            if (consumeParentSyncFailures-- > 0) throw new Error("ambiguous consume parent fsync");
          }
          return handle.sync();
        }
      };
    };
    await expect(consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: first.signal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: "2026-08-12T10:01:00.000Z"
    }, { openFn: consumeOpen })).rejects.toThrow("ambiguous consume parent fsync");
    expect(await consumeUltragoalResumeSignal(paths.signalPath, {
      expectedSignalId: first.signal.signalId,
      consumerId: "ultragoal-runtime-1",
      now: "2026-08-12T10:01:30.000Z"
    }, { openFn: consumeOpen })).toMatchObject({ consumed: true, idempotent: true });
    expect(exclusiveCreates).toBe(2);
    expect(claimWrites).toBe(1);
    expect(consumeOperations).toEqual(["claim-sync", "parent-sync", "claim-sync", "parent-sync"]);
  });

  test("merges the already-scrubbed disk state so an older process cannot restore removed fields", async () => {
    const paths = await fixturePaths();
    await Bun.write(paths.statePath, JSON.stringify({ status: "blocked", profiles: [{ id: "account-1" }] }));
    const staleInMemory = {
      status: "blocked",
      profiles: [{ id: "account-1", email: "old@example.com", bodyExcerpt: "old private page" }],
      account: "Old Person"
    };

    const next = await persistGeminiMonitorEvent({
      ...paths,
      state: staleInMemory,
      event: "quota_wait_scheduled",
      details: { nextQuotaCheckAt: "2026-08-12T11:00:00.000Z" },
      logger: null
    });
    const serialized = JSON.stringify(next);

    expect(next.profiles).toEqual([{ id: "account-1" }]);
    expect(serialized).not.toContain("old@example.com");
    expect(serialized).not.toContain("old private page");
    expect(serialized).not.toContain("Old Person");
  });

  test("lets an explicit retry-limit reset override stale disk pointers with null and zero", async () => {
    const paths = await fixturePaths();
    const staleState = {
      schemaVersion: 2,
      status: "failed",
      jobId: "failed-job",
      runId: "failed-run",
      profileId: "account-1",
      attempts: 3,
      completion: { stale: true }
    };
    await Bun.write(paths.statePath, JSON.stringify(staleState));
    const reset = {
      status: "monitoring",
      jobId: null,
      runId: null,
      profileId: null,
      attempts: 0,
      completion: null,
      failedJobId: "failed-job",
      nextAction: "create_new_job"
    };

    const next = await persistGeminiMonitorEvent({
      ...paths,
      state: staleState,
      event: "job_retry_limit_reached",
      details: reset,
      now: new Date("2026-08-12T12:00:00.000Z"),
      logger: null
    });
    const event = JSON.parse((await readFile(paths.logPath, "utf8")).trim());

    expect(next).toMatchObject(reset);
    expect(event).toMatchObject({
      event: "job_retry_limit_reached",
      jobId: null,
      runId: null,
      profileId: null,
      attempts: 0,
      completion: null
    });
  });
});
