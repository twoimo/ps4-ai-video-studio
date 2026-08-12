import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistGeminiMonitorEvent,
  redactGeminiMonitor,
  scrubGeminiMonitorArtifacts
} from "../src/gemini-monitor-privacy.mjs";
import { createUltragoalResumeSignal } from "../src/ultragoal-signal.mjs";

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
  test("wake signals contain operational profile aliases but never configured email labels", () => {
    const signal = createUltragoalResumeSignal({
      event: "provider-available",
      profiles: [{ id: "account-1", email: "private@example.com", cdpUrl: "http://127.0.0.1:9222", headless: true, available: true }]
    });

    expect(signal.availableProfiles).toEqual([{
      id: "account-1",
      cdpUrl: "http://127.0.0.1:9222",
      headless: true
    }]);
    expect(JSON.stringify(signal)).not.toContain("private@example.com");
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
      quotaResetText: "Contact [redacted-email] when [redacted-profile-path] resets",
      diagnostic: "stack at /[redacted-user]/project/src/file.mjs:1:2",
      available: false
    });
    expect(combined).not.toContain("real@example.com");
    expect(combined).not.toContain("Real Name");
    expect(combined).not.toContain("private Gemini conversation");
    expect(combined).not.toContain("/Users/private");
    expect(combined).not.toContain("/tmp/private");
    expect(state.lastError).toBe("profile [redacted-profile-path] failed for [redacted-email]");
    expect(state.lastError).not.toContain("src/file.mjs");
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.logPath)).mode & 0o777).toBe(0o600);
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
});
