import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CdpBrowser,
  assertGeminiPartialResumePreflight,
  assertGeminiGenerationLaunchPolicy,
  assertGeminiChromeRuntime,
  buildGeminiClipPrompt,
  buildGeminiChromeLaunchArgs,
  buildGeminiGenerationRequest,
  canonicalGeminiEditorText,
  canonicalGeminiConversationUrl,
  canonicalGeminiResumeScriptHash,
  connectBrowser,
  confirmGeminiPromptSubmission,
  createGeminiSubmissionBaseline,
  cancelGeminiPageMediaSession,
  downloadGeminiMediaFromPage,
  geminiAspectRatioEvidence,
  geminiQuotaStatus,
  geminiChromeMajorVersion,
  geminiPromptRetryDecision,
  geminiPromptReadiness,
  geminiPendingRecoveryDecision,
  geminiSegmentSubmissionLineage,
  geminiTargetConversationLineage,
  geminiPromptSubmissionDomState,
  geminiPromptSubmissionEvidence,
  inspectGeminiSubmitIntent,
  openGeminiPageMediaSession,
  probeVideoDimensions,
  pullGeminiPageMediaSession,
  publishDurableGeminiClip,
  generateGeminiClips,
  GEMINI_GENERATION_RECEIPT_MAX_BYTES,
  readGeminiGenerationReceipt,
  retainLegacyGeminiAbandonmentProvenance,
  geminiVideoQuotaMessage,
  isHeadlessChromeVersion,
  isGeminiBrowserAbortError,
  isGeminiBrowserDeadlineError,
  resolveGeminiChromeLaunchPolicy,
  resolveGeminiVideoTimeoutMs,
  selectGeminiRecoveryTarget,
  startGeminiBrowser,
  trustedGeminiMediaCandidateUrl,
  trustedGeminiMediaUrl,
  validateGeminiMediaUrl,
  validatedGeminiBrowserWebSocketUrl,
  waitForGeminiConversationUrl,
  waitForGeminiPromptReady,
  writeGeminiGenerationCheckpoint
} from "../src/gemini-browser.mjs";
import { inspectGeminiRetryResetLineage } from "../scripts/monitor-gemini-production.mjs";
import {
  canonicalGeminiObservedRuntimeProof,
  canonicalGeminiSessionBinding,
  canonicalJsonHash,
  geminiObservedRuntimeProofHash,
  geminiSessionBindingHash
} from "../src/provenance.mjs";
import { JOBS_DIR, runBoundedRenderProcess } from "../src/pipeline.mjs";
import { providerPromptBindingForSegment } from "../src/shot-patterns.mjs";
import { createGeminiFailureEvidence } from "../src/gemini-error-safety.mjs";

const generatedJobDirs = [];
afterEach(async () => {
  await Promise.all(generatedJobDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const HEADLESS_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36"
};

const HEADED_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36"
};
const DEDICATED_PROFILE = join(homedir(), ".ps4-ai-video-studio", "headless-test");

function fakeDeadlineClock(startMs) {
  let nowMs = startMs;
  let nextTimerId = 1;
  const timers = new Map();
  const firedDelays = [];
  const flush = async () => {
    for (let index = 0; index < 64; index += 1) await Promise.resolve();
  };
  return {
    now: () => nowMs,
    setTimeoutFn(callback, delayMs) {
      const id = nextTimerId++;
      timers.set(id, { callback, at: nowMs + Math.max(0, Number(delayMs) || 0) });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    get firedDelays() {
      return [...firedDelays];
    },
    async settle(promise, maxTimers = 100) {
      let outcome = null;
      promise.then(
        (value) => { outcome = { status: "fulfilled", value }; },
        (error) => { outcome = { status: "rejected", error }; }
      );
      for (let attempt = 0; attempt <= maxTimers; attempt += 1) {
        await flush();
        if (outcome) {
          if (outcome.status === "rejected") throw outcome.error;
          return outcome.value;
        }
        const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) {
          if (attempt < 8) continue;
          throw new Error("fake deadline 작업이 timer 없이 미완료 상태입니다.");
        }
        const [id, timer] = next;
        timers.delete(id);
        firedDelays.push(timer.at - nowMs);
        nowMs = timer.at;
        timer.callback();
      }
      throw new Error("fake deadline timer 상한을 초과했습니다.");
    }
  };
}

function fakeWebSocketClass({ autoOpen = false, onSend = () => {} } = {}) {
  return class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = autoOpen ? FakeWebSocket.OPEN : FakeWebSocket.CONNECTING;
      this.closed = false;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
      if (autoOpen) queueMicrotask(() => this.emit("open"));
    }

    addEventListener(type, listener, options = {}) {
      const entries = this.listeners.get(type) || [];
      entries.push({ listener, once: options?.once === true });
      this.listeners.set(type, entries);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.listener !== listener));
    }

    emit(type, data = null) {
      const entries = [...(this.listeners.get(type) || [])];
      for (const entry of entries) {
        entry.listener({ type, data });
        if (entry.once) this.removeEventListener(type, entry.listener);
      }
    }

    send(payload) {
      onSend(this, payload);
    }

    close() {
      this.closed = true;
      this.readyState = FakeWebSocket.CLOSED;
    }
  };
}

function fakeChromeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.unrefCalls = 0;
  child.killCalls = [];
  child.unref = () => { child.unrefCalls += 1; };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.finish(signal, null);
    return true;
  };
  child.finish = (signal = null, exitCode = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.signalCode = signal;
    child.exitCode = exitCode;
    child.emit("exit", exitCode, signal);
    child.emit("close", exitCode, signal);
  };
  return child;
}

function currentGenerationReceipt(overrides = {}) {
  const sessionBinding = {
    schemaVersion: 1,
    cdpOrigin: "http://127.0.0.1:9222",
    profileBasename: "headless-test",
    profilePathHash: `sha256:${"1".repeat(64)}`
  };
  const sessionBindingHash = canonicalJsonHash(sessionBinding);
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true
  };
  return {
    schemaVersion: 4,
    provider: "gemini-browser",
    jobId: "job-current",
    runId: "run-current",
    status: "failed",
    startedAt: "2026-08-12T13:00:00.000Z",
    completedAt: "2026-08-12T13:01:00.000Z",
    request: { provider: "gemini-browser", clipCount: 1, segments: [{}] },
    requestHash: `sha256:${"2".repeat(64)}`,
    requestScriptHash: `sha256:${"2".repeat(64)}`,
    scriptHash: `sha256:${"3".repeat(64)}`,
    resumeRequestHash: `sha256:${"4".repeat(64)}`,
    resumeScriptHash: `sha256:${"5".repeat(64)}`,
    sessionBinding,
    sessionBindingHash,
    providerDecision,
    providerDecisionHash: canonicalJsonHash(providerDecision),
    providerAttestation,
    providerAttestationHash: canonicalJsonHash(providerAttestation),
    segments: [],
    pendingSegment: null,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: [],
    ...overrides
  };
}

function partialResumeFixture() {
  const id = `gemini-preflight-${randomUUID()}`;
  const profileDir = join(homedir(), ".ps4-ai-video-studio", `preflight-${id}`);
  const priorRunId = "prior-generation-run";
  const job = {
    id,
    runId: "current-generation-run",
    provider: "gemini-browser",
    geminiCdpUrl: "http://127.0.0.1:9222",
    geminiProfileDir: profileDir,
    topic: "exact partial resume",
    format: "vertical",
    clipCount: 1,
    targetDurationSec: 5,
    captions: true,
    voiceover: false
  };
  const script = { segments: [{ visualPrompt: "evidence-bound stone drainage detail", durationHint: 5, caption: "", narration: "" }] };
  const request = buildGeminiGenerationRequest(job, script);
  const scriptHash = canonicalJsonHash(script);
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const requestHash = canonicalJsonHash({ ...request, scriptHash });
  const resumeRequestHash = canonicalJsonHash({ ...request, scriptHash: resumeScriptHash });
  const providerDecision = { requested: "gemini-browser", selected: "gemini-browser", fallbackUsed: false, policy: "no-local-video-fallback" };
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const sessionBindingHash = geminiSessionBindingHash(job);
  const runtimeProof = canonicalGeminiObservedRuntimeProof({
    job,
    version: {
      product: "Chrome/151.0.7922.109",
      userAgent: "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36",
      protocolVersion: "1.3",
      revision: "preflight-test"
    },
    commandLine: { arguments: [
      "chrome",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      "--headless=new",
      "--enable-automation"
    ] }
  });
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: "Chrome/151.0.7922.109",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    headlessRequested: true,
    chromeMajor: 151,
    headlessImplementation: "new",
    runtimeProof,
    runtimeProofHash: geminiObservedRuntimeProofHash(runtimeProof),
    fallbackUsed: false
  };
  const providerAttestationHash = canonicalJsonHash(providerAttestation);
  const providerDecisionHash = canonicalJsonHash(providerDecision);
  const prompt = buildGeminiClipPrompt(job, script, script.segments[0]);
  const promptBinding = providerPromptBindingForSegment(script.segments[0], "gemini-browser");
  const targetConversation = geminiTargetConversationLineage("private-target-id", "https://gemini.google.com/app/private-conversation");
  const clipBytes = Buffer.from("sealed Gemini clip bytes");
  const clipSha = `sha256:${createHash("sha256").update(clipBytes).digest("hex")}`;
  const generation = {
    schemaVersion: 5,
    provider: "gemini-browser",
    jobId: id,
    runId: priorRunId,
    status: "failed",
    startedAt: "2026-08-12T13:00:00.000Z",
    completedAt: "2026-08-12T13:01:00.000Z",
    request,
    requestHash,
    requestScriptHash: requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    sessionBinding,
    sessionBindingHash,
    providerDecision,
    providerDecisionHash,
    providerAttestation,
    providerAttestationHash,
    segments: [{
      index: 1,
      runId: priorRunId,
      submissionRunId: priorRunId,
      requestHash,
      scriptHash,
      resumeRequestHash,
      resumeScriptHash,
      providerDecisionHash,
      providerAttestationHash,
      durationHint: 5,
      prompt,
      promptHash: canonicalJsonHash({ prompt }),
      providerVisualPromptHash: promptBinding.providerVisualPromptHash,
      shotPattern: promptBinding.shotPattern,
      targetConversationLineage: targetConversation.lineage,
      targetConversationLineageHash: targetConversation.lineageHash,
      submittedToProvider: true,
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null,
      submissionAcknowledgement: { verified: true },
      path: "clips/01.mp4",
      output: "clips/01.mp4",
      sha256: clipSha
    }],
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    submissionRunIds: [priorRunId],
    pendingSegment: null,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: []
  };
  return { job, script, request, generation, clipBytes, clipSha, jobDir: join(JOBS_DIR, id) };
}

function recoveryReceiptForGeneration(generation) {
  const body = Buffer.from(JSON.stringify(generation, null, 2));
  return {
    body,
    expected: {
      bytes: body.length,
      sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      sourceRunId: generation.runId,
      sourceGenerationHash: canonicalJsonHash(generation)
    }
  };
}

describe("Gemini Chrome headless launch policy", () => {
  test("defaults to the new headless mode without a background window", () => {
    expect(resolveGeminiChromeLaunchPolicy({})).toEqual({
      headless: true,
      background: false,
      mode: "headless",
      headlessImplementation: "new"
    });
  });

  test("requires an explicit false value for a visible first-login window", () => {
    expect(resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "0" })).toMatchObject({
      headless: false,
      background: false,
      mode: "visible"
    });
    expect(resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "false", GEMINI_CHROME_BACKGROUND: "1" })).toMatchObject({
      headless: false,
      background: true,
      mode: "background"
    });
  });

  test("keeps headed modes status-only and permits generation only in new headless", () => {
    expect(assertGeminiGenerationLaunchPolicy(resolveGeminiChromeLaunchPolicy({}))).toMatchObject({
      headless: true,
      mode: "headless",
      headlessImplementation: "new"
    });
    expect(() => assertGeminiGenerationLaunchPolicy(resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "0" })))
      .toThrow("headed Chrome은 상태·로그인 확인에만");
    expect(() => assertGeminiGenerationLaunchPolicy({ headless: true, mode: "headless", headlessImplementation: "old" }))
      .toThrow("--headless=new");
  });

  test("rejects ambiguous mode values instead of silently opening a window", () => {
    expect(() => resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "sometimes" })).toThrow("GEMINI_CHROME_HEADLESS");
    expect(() => resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "0", GEMINI_CHROME_BACKGROUND: "maybe" })).toThrow("GEMINI_CHROME_BACKGROUND");
  });

  test("pins CDP to loopback and launches the persisted profile with new headless", () => {
    const args = buildGeminiChromeLaunchArgs({
      cdpUrl: "http://127.0.0.1:9444",
      profileDir: DEDICATED_PROFILE
    }, {
      GEMINI_CHROME_HEADLESS: "1"
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9444");
    expect(args).toContain(`--user-data-dir=${DEDICATED_PROFILE}`);
    expect(args).toContain("--headless=new");
    expect(args).toContain("--window-size=1440,1200");
    expect(args).not.toContain("--disable-gpu");
    expect(args).not.toContain("--no-startup-window");
  });

  test("rejects non-loopback CDP and profiles outside the dedicated root", () => {
    expect(() => buildGeminiChromeLaunchArgs({
      cdpUrl: "http://example.com:9222",
      profileDir: DEDICATED_PROFILE
    })).toThrow("로컬 HTTP origin");
    expect(() => buildGeminiChromeLaunchArgs({
      cdpUrl: "http://127.0.0.1:9222",
      profileDir: "/tmp/shared-profile"
    })).toThrow("전용 프로필");
  });
});

describe("Gemini Chrome runtime mode attestation", () => {
  test("recognizes supported Chrome 151 headless", () => {
    expect(geminiChromeMajorVersion(HEADLESS_151)).toBe(151);
    expect(isHeadlessChromeVersion(HEADLESS_151)).toBe(true);
    expect(assertGeminiChromeRuntime(HEADLESS_151, { headless: true, mode: "headless" })).toEqual({
      chromeMajor: 151,
      actualHeadless: true,
      mode: "headless"
    });
  });

  test("fails closed when an existing CDP port serves a headed browser", () => {
    expect(() => assertGeminiChromeRuntime(HEADED_151, { headless: true, mode: "headless" })).toThrow("모드 불일치");
  });

  test("fails closed for legacy or unidentified runtimes", () => {
    expect(() => assertGeminiChromeRuntime({
      Browser: "Chrome/108.0.0.0",
      "User-Agent": "HeadlessChrome/108.0.0.0"
    }, { headless: true, mode: "headless" })).toThrow("Chrome 109 이상");
    expect(() => assertGeminiChromeRuntime({ Browser: "Unknown/1" }, { headless: true, mode: "headless" })).toThrow("확인할 수 없습니다");
  });

  test("derives generation authority from exact observed CDP command-line facts", () => {
    const job = {
      geminiCdpUrl: "http://127.0.0.1:9222",
      geminiProfileDir: DEDICATED_PROFILE
    };
    const version = {
      product: "Chrome/151.0.7922.109",
      userAgent: "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36",
      protocolVersion: "1.3",
      revision: "runtime-proof-test"
    };
    const exactArguments = [
      "chrome",
      `--user-data-dir=${DEDICATED_PROFILE}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      "--headless=new",
      "--enable-automation"
    ];
    const proof = canonicalGeminiObservedRuntimeProof({ job, version, commandLine: { arguments: exactArguments } });
    expect(proof).toMatchObject({
      method: "cdp-browser-get-command-line-and-version",
      remoteDebuggingAddress: "127.0.0.1",
      remoteDebuggingPort: "9222",
      headless: true,
      headlessImplementation: "new",
      chromeMajor: 151
    });
    expect(JSON.stringify(proof)).not.toContain(DEDICATED_PROFILE);
    for (const mutate of [
      (args) => args.map((arg) => arg.startsWith("--user-data-dir=") ? "--user-data-dir=/tmp/other-profile" : arg),
      (args) => args.map((arg) => arg === "--remote-debugging-port=9222" ? "--remote-debugging-port=9333" : arg),
      (args) => args.map((arg) => arg === "--remote-debugging-address=127.0.0.1" ? "--remote-debugging-address=0.0.0.0" : arg),
      (args) => args.map((arg) => arg === "--headless=new" ? "--headless" : arg),
      (args) => [...args, "--headless=new"]
    ]) {
      expect(() => canonicalGeminiObservedRuntimeProof({ job, version, commandLine: { arguments: mutate(exactArguments) } })).toThrow();
    }
    expect(() => canonicalGeminiObservedRuntimeProof({
      job,
      version: { ...version, userAgent: "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36" },
      commandLine: { arguments: exactArguments }
    })).toThrow("headless runtime");
  });

  test("pins the browser WebSocket to the same loopback CDP port", () => {
    expect(validatedGeminiBrowserWebSocketUrl(
      "ws://localhost:9222/devtools/browser/123e4567-e89b-12d3-a456-426614174000",
      "http://127.0.0.1:9222"
    )).toBe("ws://localhost:9222/devtools/browser/123e4567-e89b-12d3-a456-426614174000");
    for (const value of [
      "wss://localhost:9222/devtools/browser/token",
      "ws://127.0.0.1:9333/devtools/browser/token",
      "ws://example.test:9222/devtools/browser/token",
      "ws://127.0.0.1:9222/devtools/page/token",
      "ws://user:pass@127.0.0.1:9222/devtools/browser/token",
      "ws://127.0.0.1:9222/devtools/browser/token?secret=1"
    ]) expect(() => validatedGeminiBrowserWebSocketUrl(value, "http://127.0.0.1:9222")).toThrow("loopback");
  });
});

describe("Gemini Chrome owned-process lifecycle", () => {
  const input = {
    cdpUrl: "http://127.0.0.1:9222",
    profileDir: DEDICATED_PROFILE
  };
  const headlessVersion = {
    ...HEADLESS_151,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/owned-process-test"
  };

  test("single-flights concurrent cold starts and shares the exact attested result", async () => {
    const initialRejectors = [];
    let initialCalls = 0;
    let spawnCalls = 0;
    const child = fakeChromeChild(41_001);
    const fetchFn = () => {
      if (initialCalls < 2) {
        initialCalls += 1;
        return new Promise((_resolve, reject) => {
          initialRejectors.push(reject);
          if (initialRejectors.length === 2) {
            queueMicrotask(() => initialRejectors.splice(0).forEach((rejectInitial) => rejectInitial(new Error("cold"))));
          }
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => headlessVersion });
    };
    const options = {
      fetchFn,
      chromeBinaryFn: () => "/virtual/chrome",
      mkdirFn: async () => {},
      spawnFn: (_binary, _args, spawnOptions) => {
        spawnCalls += 1;
        expect(spawnOptions).toEqual({ detached: true, stdio: "ignore" });
        return child;
      }
    };

    const [first, second] = await Promise.all([
      startGeminiBrowser(input, options),
      startGeminiBrowser(input, options)
    ]);

    expect(spawnCalls).toBe(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ connected: true, started: true, headless: true, chromeMajor: 151 });
    expect(child.unrefCalls).toBe(1);
    expect(child.killCalls).toEqual([]);
    child.finish(null, 0);
  });

  test("shares launch failure, TERM-to-KILL cleans the exact group, and a later retry succeeds", async () => {
    const initialRejectors = [];
    let initialCalls = 0;
    let phase = "mismatch";
    let retryCalls = 0;
    const children = [fakeChromeChild(41_011), fakeChromeChild(41_012)];
    const processSignals = [];
    let spawnCalls = 0;
    const fetchFn = () => {
      if (phase === "mismatch" && initialCalls < 2) {
        initialCalls += 1;
        return new Promise((_resolve, reject) => {
          initialRejectors.push(reject);
          if (initialRejectors.length === 2) {
            queueMicrotask(() => initialRejectors.splice(0).forEach((rejectInitial) => rejectInitial(new Error("cold"))));
          }
        });
      }
      if (phase === "retry" && retryCalls++ === 0) return Promise.reject(new Error("cold"));
      const version = phase === "mismatch" ? HEADED_151 : headlessVersion;
      return Promise.resolve({ ok: true, status: 200, json: async () => version });
    };
    const options = {
      fetchFn,
      chromeBinaryFn: () => "/virtual/chrome",
      mkdirFn: async () => {},
      chromeTerminationGraceMs: 5,
      chromeTerminationKillMs: 20,
      spawnFn: () => children[spawnCalls++],
      processKillFn: (pid, signal) => {
        processSignals.push([pid, signal]);
        const child = children.find((candidate) => candidate.pid === Math.abs(pid));
        if (signal === "SIGKILL") child.finish(signal, null);
      }
    };

    const [firstError, secondError] = await Promise.all([
      startGeminiBrowser(input, options).catch((error) => error),
      startGeminiBrowser(input, options).catch((error) => error)
    ]);
    expect(firstError).toBe(secondError);
    expect(firstError.message).toContain("모드 불일치");
    expect(spawnCalls).toBe(1);
    expect(processSignals).toEqual([
      [-41_011, "SIGTERM"],
      [-41_011, "SIGKILL"]
    ]);
    expect(children[0].signalCode).toBe("SIGKILL");
    expect(children[0].unrefCalls).toBe(0);

    phase = "retry";
    const recovered = await startGeminiBrowser(input, options);
    expect(recovered).toMatchObject({ connected: true, started: true, headless: true, chromeMajor: 151 });
    expect(spawnCalls).toBe(2);
    expect(children[1].unrefCalls).toBe(1);
    children[1].finish(null, 0);
  });

  test("terminates and reaps a cold-start timeout before allowing a clean retry", async () => {
    let phase = "timeout";
    let retryCalls = 0;
    let spawnCalls = 0;
    const children = [fakeChromeChild(41_021), fakeChromeChild(41_022)];
    const processSignals = [];
    const options = {
      fetchFn: () => {
        if (phase === "timeout") return Promise.reject(new Error("unreachable"));
        if (retryCalls++ === 0) return Promise.reject(new Error("cold"));
        return Promise.resolve({ ok: true, status: 200, json: async () => headlessVersion });
      },
      chromeBinaryFn: () => "/virtual/chrome",
      mkdirFn: async () => {},
      chromeLaunchAttempts: 1,
      chromeLaunchPollMs: 1,
      chromeTerminationGraceMs: 10,
      chromeTerminationKillMs: 10,
      spawnFn: () => children[spawnCalls++],
      processKillFn: (pid, signal) => {
        processSignals.push([pid, signal]);
        children.find((candidate) => candidate.pid === Math.abs(pid)).finish(signal, null);
      }
    };

    await expect(startGeminiBrowser(input, options)).rejects.toThrow("원격 디버깅 포트");
    expect(processSignals).toEqual([[-41_021, "SIGTERM"]]);
    expect(children[0].signalCode).toBe("SIGTERM");

    phase = "retry";
    await expect(startGeminiBrowser(input, options)).resolves.toMatchObject({ started: true, headless: true });
    expect(spawnCalls).toBe(2);
    children[1].finish(null, 0);
  });

  test("never overwrites a published live owner when its CDP endpoint becomes unavailable", async () => {
    let phase = "cold";
    let calls = 0;
    let spawnCalls = 0;
    const owner = fakeChromeChild(41_031);
    const challenger = fakeChromeChild(41_032);
    const options = {
      fetchFn: () => {
        calls += 1;
        if (phase === "cold" && calls === 1) return Promise.reject(new Error("cold"));
        if (phase === "cold") return Promise.resolve({ ok: true, status: 200, json: async () => headlessVersion });
        return Promise.reject(new Error("endpoint unavailable"));
      },
      chromeBinaryFn: () => "/virtual/chrome",
      mkdirFn: async () => {},
      chromeLaunchAttempts: 1,
      spawnFn: () => spawnCalls++ === 0 ? owner : challenger
    };
    await expect(startGeminiBrowser(input, options)).resolves.toMatchObject({ started: true, headless: true });
    phase = "unavailable";
    await expect(startGeminiBrowser(input, options)).rejects.toThrow("새 process로 덮어쓰지 않습니다");
    expect(spawnCalls).toBe(1);
    expect(challenger.unrefCalls).toBe(0);
    owner.finish(null, 0);
  });

  test("closes a fresh setup target on failure but preserves an explicit recovery target", async () => {
    const runFailure = async (resumeTarget = null) => {
      const methods = [];
      const FakeWebSocket = fakeWebSocketClass({
        autoOpen: true,
        onSend: (socket, payload) => {
          const command = JSON.parse(payload);
          methods.push(command.method);
          let response;
          if (command.method === "Target.getTargets") {
            response = { result: { targetInfos: [{ targetId: "recovery-target", type: "page", url: "https://gemini.google.com/app/recovery" }] } };
          } else if (command.method === "Target.createTarget") {
            response = { result: { targetId: "fresh-target" } };
          } else if (command.method === "Target.attachToTarget") {
            response = { result: { sessionId: "session-1" } };
          } else if (command.method === "Browser.setDownloadBehavior") {
            response = { error: { message: "download setup failed" } };
          } else if (command.method === "Target.closeTarget") {
            response = { result: { success: true } };
          } else if (command.method === "Target.detachFromTarget") {
            response = { result: {} };
          } else {
            response = { result: {} };
          }
          socket.emit("message", JSON.stringify({ id: command.id, ...response }));
        }
      });
      const error = await connectBrowser(input, {
        version: headlessVersion,
        policy: { headless: true, mode: "headless", headlessImplementation: "new" },
        WebSocketImpl: FakeWebSocket,
        mkdirFn: async () => {},
        ...(resumeTarget ? { resumeTarget } : {})
      }).catch((caught) => caught);
      expect(error.message).toBe("download setup failed");
      return methods;
    };

    const freshMethods = await runFailure();
    expect(freshMethods).toContain("Target.closeTarget");
    expect(freshMethods).not.toContain("Target.detachFromTarget");

    const recoveryMethods = await runFailure({
      targetId: "recovery-target",
      conversationUrl: "https://gemini.google.com/app/recovery"
    });
    expect(recoveryMethods).toContain("Target.detachFromTarget");
    expect(recoveryMethods).not.toContain("Target.closeTarget");
  });

  test("uses the cleanup-only command boundary to close a fresh target after the caller deadline", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    const methods = [];
    const FakeWebSocket = fakeWebSocketClass({
      autoOpen: true,
      onSend: (socket, payload) => {
        const command = JSON.parse(payload);
        methods.push(command.method);
        const result = command.method === "Target.createTarget"
          ? { targetId: "deadline-fresh-target" }
          : command.method === "Target.attachToTarget"
            ? { sessionId: "deadline-session" }
            : command.method === "Target.closeTarget"
              ? { success: true }
              : {};
        socket.emit("message", JSON.stringify({ id: command.id, result }));
      }
    });

    const error = await clock.settle(connectBrowser(input, {
      version: headlessVersion,
      policy: { headless: true, mode: "headless", headlessImplementation: "new" },
      deadlineMs: startedAt + 100,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      WebSocketImpl: FakeWebSocket,
      mkdirFn: async () => {}
    })).catch((caught) => caught);

    expect(isGeminiBrowserDeadlineError(error)).toBe(true);
    expect(methods).toContain("Target.closeTarget");
    expect(methods.at(-1)).toBe("Target.closeTarget");
  });
});

describe("Gemini bounded ffprobe", () => {
  test("passes only fixed validated args and strict resource bounds to the shared runner", async () => {
    const calls = [];
    const dimensions = await probeVideoDimensions("/virtual/clip.mp4", {
      runProcessFn: async (...args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }] }), stderr: "" };
      }
    });
    expect(dimensions).toEqual({ width: 1080, height: 1920 });
    expect(calls).toEqual([[
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", "/virtual/clip.mp4"],
      { timeoutMs: 15_000, maximumOutputBytes: 64 * 1024, admissionTimeoutMs: 30_000, stdoutMode: "text" }
    ]]);
    await expect(probeVideoDimensions("bad\0path", {
      runProcessFn: async () => { throw new Error("must not spawn"); }
    })).rejects.toThrow("입력 경로");
  });

  test("kills hung or noisy probes through the shared runner, releases admission, and still parses success", async () => {
    const bounded = (source) => (_command, _args, options) => runBoundedRenderProcess(process.execPath, ["-e", source], options);
    const limits = { timeoutMs: 80, maximumOutputBytes: 1024, admissionTimeoutMs: 500 };

    expect(await probeVideoDimensions("/virtual/hung.mp4", {
      ...limits,
      runProcessFn: bounded("setInterval(() => {}, 1000)")
    })).toBeNull();
    expect(await probeVideoDimensions("/virtual/noisy.mp4", {
      ...limits,
      runProcessFn: bounded("process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)")
    })).toBeNull();
    expect(await probeVideoDimensions("/virtual/success.mp4", {
      ...limits,
      timeoutMs: 1_000,
      runProcessFn: bounded("process.stdout.write(JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }))")
    })).toEqual({ width: 1920, height: 1080 });
  });
});

describe("Gemini page media egress boundary", () => {
  const sessionKey = () => `__ps4GeminiMedia_${randomUUID().replaceAll("-", "")}`;
  const pageGlobal = () => ({ location: { origin: "https://gemini.google.com" } });
  const browserResponse = (bytes, {
    url = "https://lh3.googleusercontent.com/video.mp4",
    type = "cors",
    redirected = false,
    headers = { "content-type": "video/mp4" },
    status = 200
  } = {}) => {
    const response = new Response(bytes, { status, headers });
    Object.defineProperties(response, {
      url: { value: url },
      type: { value: type },
      redirected: { value: redirected }
    });
    return response;
  };
  const pageDependencies = (globalObject, fetchFn) => ({
    globalObject,
    pageOrigin: "https://gemini.google.com",
    fetchFn,
    btoaFn: (binary) => Buffer.from(binary, "binary").toString("base64")
  });

  test("allows only exact Gemini blobs and explicit Google media delivery hosts", () => {
    const blob = "blob:https://gemini.google.com/550e8400-e29b-41d4-a716-446655440000";
    expect(validateGeminiMediaUrl(blob)).toMatchObject({ kind: "blob", credentials: "same-origin" });
    expect(validateGeminiMediaUrl("https://gemini.google.com/media/video.mp4?download=1")).toMatchObject({
      hostname: "gemini.google.com",
      credentials: "same-origin"
    });
    expect(validateGeminiMediaUrl("https://lh3.googleusercontent.com/media/video.mp4?sig=signed")).toMatchObject({
      hostname: "lh3.googleusercontent.com",
      credentials: "omit"
    });
    expect(trustedGeminiMediaCandidateUrl("https://gemini.google.com/media/video.mp4", "video-src")).not.toBeNull();
    expect(trustedGeminiMediaCandidateUrl("https://gemini.google.com/logout?download=.mp4", "download-link")).toBeNull();
    expect(trustedGeminiMediaCandidateUrl("https://lh3.googleusercontent.com/video.mp4", "download-link")).not.toBeNull();
    for (const rejected of [
      "blob:https://evil.example/550e8400-e29b-41d4-a716-446655440000",
      "blob:https://gemini.google.com/not-a-uuid",
      "data:video/mp4;base64,AAAA",
      "http://gemini.google.com/video.mp4",
      "https://127.0.0.1/video.mp4",
      "https://localhost/video.mp4",
      "https://gemini.google.com.attacker.example/video.mp4",
      "https://google.com/video.mp4",
      "https://googleusercontent.com/video.mp4",
      "https://user:pass@lh3.googleusercontent.com/video.mp4",
      "https://lh3.googleusercontent.com:444/video.mp4",
      "https://lh3.googleusercontent.com/video.mp4#secret"
    ]) {
      expect(trustedGeminiMediaUrl(rejected)).toBeNull();
    }
  });

  test("rejects an untrusted URL before browser.evaluate and streams trusted chunks without arrayBuffer", async () => {
    let calls = 0;
    const browser = {
      async evaluate(expression) {
        calls += 1;
        if (expression.includes("openGeminiPageMediaSession")) return {
          ok: true,
          responseUrl: "https://lh3.googleusercontent.com/video.mp4?sig=signed",
          responseType: "cors",
          mediaType: "video/mp4",
          declaredLength: 8
        };
        if (expression.includes("pullGeminiPageMediaSession") && calls === 2) return {
          ok: true,
          done: false,
          base64: Buffer.from("12345678").toString("base64"),
          chunkBytes: 8,
          observedBytes: 8
        };
        if (expression.includes("pullGeminiPageMediaSession")) return { ok: true, done: true, totalBytes: 8 };
        return { ok: true, canceled: true };
      }
    };
    await expect(downloadGeminiMediaFromPage(
      browser,
      "http://127.0.0.1/private.mp4",
      { deadlineMs: Date.now() + 1_000 }
    )).rejects.toThrow("candidate provenance");
    expect(calls).toBe(0);

    const bytes = await downloadGeminiMediaFromPage(
      browser,
      "https://lh3.googleusercontent.com/video.mp4?sig=signed",
      { deadlineMs: Date.now() + 1_000, maximumBytes: 16, maximumChunkBytes: 8 }
    );
    expect(bytes).toEqual(Buffer.from("12345678"));
    expect(calls).toBe(4);
  });

  test("requires final response URL provenance before pulling any body bytes", async () => {
    const expressions = [];
    const browser = {
      async evaluate(expression) {
        expressions.push(expression);
        if (expression.includes("openGeminiPageMediaSession")) return {
          ok: true,
          responseUrl: "https://attacker.example/redirected.mp4",
          responseType: "cors",
          mediaType: "video/mp4",
          declaredLength: null
        };
        return { ok: true, canceled: true };
      }
    };
    expect(await downloadGeminiMediaFromPage(
      browser,
      "https://lh3.googleusercontent.com/video.mp4",
      { deadlineMs: Date.now() + 1_000 }
    )).toBeNull();
    expect(expressions).toHaveLength(2);
    expect(expressions.some((value) => value.includes("pullGeminiPageMediaSession"))).toBe(false);
  });

  test("does not expose signed media URLs through page-protocol failures", async () => {
    const signed = "https://lh3.googleusercontent.com/video.mp4?X-Goog-Signature=private-signature";
    const browser = {
      async evaluate(expression) {
        if (expression.includes("openGeminiPageMediaSession")) throw new Error(`protocol failed while evaluating ${signed}`);
        return { ok: true, canceled: true };
      }
    };
    const result = await downloadGeminiMediaFromPage(browser, signed, { deadlineMs: Date.now() + 1_000 });
    expect(result).toBeNull();
  });

  test("opens with redirect:error, no third-party credentials, exact MIME, and declared byte limits", async () => {
    const bytes = Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112);
    const globalObject = pageGlobal();
    let observedOptions = null;
    const key = sessionKey();
    const opened = await openGeminiPageMediaSession({
      sessionKey: key,
      url: "https://lh3.googleusercontent.com/video.mp4",
      credentials: "omit",
      deadlineMs: Date.now() + 1_000,
      maximumBytes: 16
    }, pageDependencies(globalObject, async (_url, options) => {
      observedOptions = options;
      return browserResponse(bytes, { headers: { "content-type": "video/mp4", "content-encoding": "identity", "content-length": "8" } });
    }));
    expect(opened).toMatchObject({ ok: true, mediaType: "video/mp4", declaredLength: 8 });
    expect(observedOptions).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(observedOptions.signal).toBeInstanceOf(AbortSignal);

    const chunks = [];
    while (true) {
      const pulled = await pullGeminiPageMediaSession({ sessionKey: key, maximumChunkBytes: 3, waitMs: 50 }, pageDependencies(globalObject));
      expect(pulled.ok).toBe(true);
      if (pulled.done) {
        expect(pulled.totalBytes).toBe(8);
        break;
      }
      if (!pulled.pending) chunks.push(Buffer.from(pulled.base64, "base64"));
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    expect(globalObject[key]).toBeUndefined();
  });

  test("cancels redirects, MIME/encoding violations, oversize bodies, and length mismatch", async () => {
    const cases = [
      {
        response: browserResponse("x", { redirected: true, headers: { "content-type": "video/mp4" } }),
        code: "redirect-rejected"
      },
      {
        response: browserResponse("x", { headers: { "content-type": "text/html" } }),
        code: "media-type-rejected"
      },
      {
        response: browserResponse("x", { headers: { "content-type": "video/mp4", "content-encoding": "gzip" } }),
        code: "content-encoding-rejected"
      },
      {
        response: browserResponse("x", { headers: { "content-type": "video/mp4", "content-length": "99" } }),
        code: "content-length-rejected"
      },
      {
        response: browserResponse("x", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/2" } }),
        code: "http-rejected"
      },
      {
        response: browserResponse("x", { headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/2" } }),
        code: "content-range-rejected"
      }
    ];
    for (const item of cases) {
      const globalObject = pageGlobal();
      const result = await openGeminiPageMediaSession({
        sessionKey: sessionKey(),
        url: "https://lh3.googleusercontent.com/video.mp4",
        credentials: "omit",
        deadlineMs: Date.now() + 1_000,
        maximumBytes: 8
      }, pageDependencies(globalObject, async () => item.response));
      expect(result).toMatchObject({ ok: false, code: item.code });
    }

    let canceled = false;
    const oversizedBody = new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4, 5)); },
      cancel() { canceled = true; }
    });
    const oversizedResponse = browserResponse(oversizedBody, { headers: { "content-type": "video/mp4" } });
    const oversizedGlobal = pageGlobal();
    const oversizedKey = sessionKey();
    expect((await openGeminiPageMediaSession({
      sessionKey: oversizedKey,
      url: "https://lh3.googleusercontent.com/video.mp4",
      credentials: "omit",
      deadlineMs: Date.now() + 1_000,
      maximumBytes: 4
    }, pageDependencies(oversizedGlobal, async () => oversizedResponse))).ok).toBe(true);
    expect(await pullGeminiPageMediaSession(
      { sessionKey: oversizedKey, maximumChunkBytes: 4, waitMs: 50 },
      pageDependencies(oversizedGlobal)
    )).toMatchObject({ ok: false, code: "body-too-large" });
    expect(canceled).toBe(true);

    const mismatchGlobal = pageGlobal();
    const mismatchKey = sessionKey();
    expect((await openGeminiPageMediaSession({
      sessionKey: mismatchKey,
      url: "https://lh3.googleusercontent.com/video.mp4",
      credentials: "omit",
      deadlineMs: Date.now() + 1_000,
      maximumBytes: 8
    }, pageDependencies(mismatchGlobal, async () => browserResponse(Uint8Array.of(1, 2), {
      headers: { "content-type": "video/mp4", "content-length": "3" }
    })))).ok).toBe(true);
    expect((await pullGeminiPageMediaSession(
      { sessionKey: mismatchKey, maximumChunkBytes: 8, waitMs: 50 }, pageDependencies(mismatchGlobal)
    )).ok).toBe(true);
    expect(await pullGeminiPageMediaSession(
      { sessionKey: mismatchKey, maximumChunkBytes: 8, waitMs: 50 }, pageDependencies(mismatchGlobal)
    )).toMatchObject({ ok: false, code: "content-length-mismatch" });
  });

  test("uses one absolute page deadline for a slow body and cancels the reader", async () => {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1)); },
      cancel() { canceled = true; }
    });
    const globalObject = pageGlobal();
    const key = sessionKey();
    const deadlineMs = Date.now() + 35;
    expect((await openGeminiPageMediaSession({
      sessionKey: key,
      url: "https://lh3.googleusercontent.com/video.mp4",
      credentials: "omit",
      deadlineMs,
      maximumBytes: 8
    }, pageDependencies(globalObject, async () => browserResponse(body)))).ok).toBe(true);
    expect((await pullGeminiPageMediaSession(
      { sessionKey: key, maximumChunkBytes: 8, waitMs: 5 }, pageDependencies(globalObject)
    )).ok).toBe(true);
    let terminal = null;
    for (let attempt = 0; attempt < 20 && !terminal; attempt += 1) {
      const result = await pullGeminiPageMediaSession(
        { sessionKey: key, maximumChunkBytes: 8, waitMs: 5 }, pageDependencies(globalObject)
      );
      if (!result.ok) terminal = result;
    }
    expect(terminal).toMatchObject({ code: "deadline-expired" });
    expect(canceled).toBe(true);
    expect(globalObject[key]).toBeUndefined();
    expect(Date.now()).toBeLessThan(deadlineMs + 1_000);
  });

  test("refuses a navigated-away page before starting any fetch", async () => {
    let fetches = 0;
    const result = await openGeminiPageMediaSession({
      sessionKey: sessionKey(),
      url: "https://lh3.googleusercontent.com/video.mp4",
      credentials: "omit",
      deadlineMs: Date.now() + 1_000,
      maximumBytes: 8
    }, {
      globalObject: { location: { origin: "https://attacker.example" } },
      fetchFn: async () => { fetches += 1; return browserResponse("x"); }
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-session-input" });
    expect(fetches).toBe(0);
  });
});

describe("Gemini monitor browser runtime deadline", () => {
  test("aborts startGeminiBrowser at the one absolute deadline instead of falling through to a Chrome launch", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:58.750Z");
    const deadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    const FakeWebSocket = fakeWebSocketClass();
    let observedSignal = null;
    const fetchFn = (_url, { signal }) => new Promise((_resolve, reject) => {
      observedSignal = signal;
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    const error = await clock.settle(startGeminiBrowser({
      cdpUrl: "http://127.0.0.1:9222",
      profileDir: DEDICATED_PROFILE
    }, {
      deadlineMs,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      fetchFn,
      WebSocketImpl: FakeWebSocket
    })).catch((caught) => caught);

    expect(clock.firedDelays).toEqual([1_250]);
    expect(observedSignal?.aborted).toBe(true);
    expect(isGeminiBrowserDeadlineError(error)).toBe(true);
    expect(error).toMatchObject({ code: "GEMINI_BROWSER_DEADLINE", deadlineAt: "2026-08-12T12:01:00.000Z" });
    expect(error.message).not.toContain("127.0.0.1");
  });

  test("aborts a hanging quota-observation WebSocket open at the remaining runtime", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:57.500Z");
    const deadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    const privateWebSocketUrl = "ws://127.0.0.1:9222/devtools/browser/private-session-token";
    const FakeWebSocket = fakeWebSocketClass();
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...HEADLESS_151, webSocketDebuggerUrl: privateWebSocketUrl })
    });

    const error = await clock.settle(geminiQuotaStatus({
      cdpUrl: "http://127.0.0.1:9222",
      profileDir: DEDICATED_PROFILE
    }, {
      deadlineMs,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      fetchFn,
      WebSocketImpl: FakeWebSocket
    })).catch((caught) => caught);

    expect(error).toMatchObject({ code: "GEMINI_BROWSER_DEADLINE" });
    expect(clock.firedDelays).toEqual([2_500]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(isGeminiBrowserDeadlineError(error)).toBe(true);
    expect(error.message).not.toContain(privateWebSocketUrl);
    expect(error.message).not.toContain("private-session-token");
  });

  test("composes a caller abort with the absolute deadline and sanitizes its reason", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    const caller = new AbortController();
    const FakeWebSocket = fakeWebSocketClass();
    const browser = new CdpBrowser({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/private" }, "http://127.0.0.1:9222", {
      deadlineMs: startedAt + 10_000,
      signal: caller.signal,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      WebSocketImpl: FakeWebSocket
    });
    const pending = browser.connect();
    caller.abort(new Error("private caller abort body and URL https://secret.example.test"));
    const error = await pending.catch((caught) => caught);
    const closeError = await browser.close().catch((caught) => caught);

    expect(isGeminiBrowserAbortError(error)).toBe(true);
    expect(isGeminiBrowserAbortError(closeError)).toBe(true);
    expect(error.message).not.toContain("private caller abort body");
    expect(error.message).not.toContain("secret.example.test");
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  test("clamps repeated navigation commands and sleeps to the same cumulative deadline", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    let browser = null;
    let evaluateCalls = 0;
    const FakeWebSocket = fakeWebSocketClass({
      onSend: (_socket, payload) => {
        const command = JSON.parse(payload);
        if (command.method === "Runtime.evaluate") evaluateCalls += 1;
        const result = command.method === "Runtime.evaluate" ? { result: { value: false } } : {};
        browser.pending.get(command.id)?.resolve(result);
      }
    });
    browser = new CdpBrowser({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/private" }, "http://127.0.0.1:9222", {
      deadlineMs: startedAt + 600,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      WebSocketImpl: FakeWebSocket
    });
    browser.ws = new FakeWebSocket("ws://127.0.0.1:9222/devtools/browser/private");
    browser.ws.readyState = FakeWebSocket.OPEN;
    const privateNavigationUrl = "https://gemini.google.com/videos?private-body=never-log";

    const error = await clock.settle(browser.navigate(privateNavigationUrl)).catch((caught) => caught);
    const closeError = await browser.close().catch((caught) => caught);

    expect(error).toMatchObject({ code: "GEMINI_BROWSER_DEADLINE" });
    expect(isGeminiBrowserDeadlineError(closeError)).toBe(true);
    expect(clock.firedDelays).toEqual([250, 250, 100]);
    expect(evaluateCalls).toBe(3);
    expect(isGeminiBrowserDeadlineError(error)).toBe(true);
    expect(error.message).not.toContain(privateNavigationUrl);
    expect(error.message).not.toContain("private-body");
  });

  test("aborts a hanging protocol close at the exact remaining runtime and still closes locally", async () => {
    const startedAt = Date.parse("2026-08-12T12:00:00.000Z");
    const clock = fakeDeadlineClock(startedAt);
    const FakeWebSocket = fakeWebSocketClass();
    const browser = new CdpBrowser({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/private" }, "http://127.0.0.1:9222", {
      deadlineMs: startedAt + 800,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      WebSocketImpl: FakeWebSocket
    });
    browser.ws = new FakeWebSocket("ws://127.0.0.1:9222/devtools/browser/private");
    browser.ws.readyState = FakeWebSocket.OPEN;
    browser.targetId = "private-target-id-never-log";

    const error = await clock.settle(browser.close()).catch((caught) => caught);

    expect(clock.firedDelays).toEqual([800]);
    expect(browser.ws.closed).toBe(true);
    expect(browser.pending.size).toBe(0);
    expect(isGeminiBrowserDeadlineError(error)).toBe(true);
    expect(error.message).not.toContain("private-target-id-never-log");
  });
});

describe("Gemini long-running result recovery", () => {
  test("defaults to twenty minutes and strictly bounds timeout configuration", () => {
    expect(resolveGeminiVideoTimeoutMs({})).toBe(1_200_000);
    expect(resolveGeminiVideoTimeoutMs({ GEMINI_VIDEO_TIMEOUT_MS: "300000" })).toBe(300_000);
    expect(resolveGeminiVideoTimeoutMs({ GEMINI_VIDEO_TIMEOUT_MS: " 3600000 " })).toBe(3_600_000);
    for (const value of ["60000", "3600001", "600000.5", "ten-minutes", "-600000", "Infinity"]) {
      expect(() => resolveGeminiVideoTimeoutMs({ GEMINI_VIDEO_TIMEOUT_MS: value })).toThrow("GEMINI_VIDEO_TIMEOUT_MS");
    }
  });

  test("waits the full bounded thirty seconds for a delayed conversation URL", async () => {
    let now = 0;
    let reads = 0;
    const delayed = await waitForGeminiConversationUrl({
      readHref: async () => {
        reads += 1;
        return now >= 6_000 ? "https://gemini.google.com/app/late-conversation?hl=ko" : "https://gemini.google.com/videos";
      },
      nowFn: () => now,
      sleepFn: async (milliseconds) => { now += milliseconds; }
    });
    expect(delayed).toBe("https://gemini.google.com/app/late-conversation");
    expect(now).toBe(6_000);
    expect(reads).toBe(13);

    now = 0;
    reads = 0;
    const missing = await waitForGeminiConversationUrl({
      readHref: async () => { reads += 1; return "https://gemini.google.com/videos"; },
      nowFn: () => now,
      sleepFn: async (milliseconds) => { now += milliseconds; }
    });
    expect(missing).toBeNull();
    expect(now).toBe(30_000);
    expect(reads).toBe(60);
  });

  test("removes an atomic checkpoint temp file when rename fails", async () => {
    const operations = [];
    await expect(writeGeminiGenerationCheckpoint("/virtual/generation.json", { status: "running" }, {
      tempId: "deterministic",
      writeFileFn: async (path, body) => { operations.push(["write", path, JSON.parse(body).status]); },
      openFn: async (path) => ({
        sync: async () => { operations.push(["sync", path]); },
        close: async () => { operations.push(["close", path]); }
      }),
      renameFn: async (source, target) => { operations.push(["rename", source, target]); throw new Error("disk-full"); },
      unlinkFn: async (path) => { operations.push(["unlink", path]); }
    })).rejects.toThrow("disk-full");
    expect(operations).toEqual([
      ["write", "/virtual/generation.json.deterministic.tmp", "running"],
      ["sync", "/virtual/generation.json.deterministic.tmp"],
      ["close", "/virtual/generation.json.deterministic.tmp"],
      ["rename", "/virtual/generation.json.deterministic.tmp", "/virtual/generation.json"],
      ["unlink", "/virtual/generation.json.deterministic.tmp"]
    ]);
  });

  test("fsyncs the checkpoint file and parent directory around atomic rename", async () => {
    const operations = [];
    await writeGeminiGenerationCheckpoint("/virtual/generation.json", { status: "running" }, {
      tempId: "durable",
      writeFileFn: async () => { operations.push("write"); },
      openFn: async (path) => ({
        sync: async () => { operations.push(`sync:${path}`); },
        close: async () => { operations.push(`close:${path}`); }
      }),
      renameFn: async () => { operations.push("rename"); },
      unlinkFn: async () => { operations.push("unlink"); }
    });
    expect(operations).toEqual([
      "write",
      "sync:/virtual/generation.json.durable.tmp",
      "close:/virtual/generation.json.durable.tmp",
      "rename",
      "sync:/virtual",
      "close:/virtual",
      "unlink"
    ]);
  });

  test("publishes a clip only after temp-file and clips-directory fsync around atomic rename", async () => {
    const operations = [];
    const targetPath = "/virtual/clips/01.mp4";
    const result = await publishDurableGeminiClip({
      targetPath,
      bytes: Buffer.from("exact provider clip"),
      format: "vertical"
    }, {
      tempId: "durable",
      openFn: async (path, flags) => ({
        writeFile: async () => { operations.push(`write:${path}:${flags}`); },
        sync: async () => { operations.push(`sync:${path}`); },
        close: async () => { operations.push(`close:${path}`); }
      }),
      clipMatchesFormatFn: async (path, format) => {
        operations.push(`probe:${path}:${format}`);
        return true;
      },
      renameFn: async (source, target) => { operations.push(`rename:${source}:${target}`); },
      unlinkFn: async (path) => { operations.push(`unlink:${path}`); }
    });
    expect(result).toMatchObject({ path: targetPath, bytes: 19 });
    expect(result.sha256).toBe(`sha256:${createHash("sha256").update("exact provider clip").digest("hex")}`);
    expect(operations).toEqual([
      "write:/virtual/clips/01.mp4.durable.tmp:wx",
      "sync:/virtual/clips/01.mp4.durable.tmp",
      "close:/virtual/clips/01.mp4.durable.tmp",
      "probe:/virtual/clips/01.mp4.durable.tmp:vertical",
      "rename:/virtual/clips/01.mp4.durable.tmp:/virtual/clips/01.mp4",
      "sync:/virtual/clips",
      "close:/virtual/clips"
    ]);
  });

  test("does not report clip publication success when the clips directory fsync fails", async () => {
    const operations = [];
    await expect(publishDurableGeminiClip({
      targetPath: "/virtual/clips/01.mp4",
      bytes: Buffer.from("exact provider clip"),
      format: "vertical"
    }, {
      tempId: "directory-failure",
      openFn: async (path) => ({
        writeFile: async () => {},
        sync: async () => {
          operations.push(`sync:${path}`);
          if (path === "/virtual/clips") throw new Error("directory fsync failed");
        },
        close: async () => {}
      }),
      clipMatchesFormatFn: async () => true,
      renameFn: async () => { operations.push("rename"); },
      unlinkFn: async () => { operations.push("unlink"); }
    })).rejects.toThrow("directory fsync failed");
    expect(operations).toEqual([
      "sync:/virtual/clips/01.mp4.directory-failure.tmp",
      "rename",
      "sync:/virtual/clips"
    ]);
  });

  test("fails closed on unreadable or malformed generation receipts", async () => {
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => { throw new Error("permission denied"); }
    })).rejects.toThrow("새 요청을 전송하지 않습니다");
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from("{broken")
    })).rejects.toThrow("손상되었습니다");
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from("{}")
    })).rejects.toThrow("손상되었습니다");
    const malformedLegacyCompleted = {
      schemaVersion: 3,
      provider: "gemini-browser",
      jobId: "legacy-completed",
      runId: "legacy-run",
      status: "completed",
      completedAt: "2026-08-12T13:01:00.000Z",
      segments: []
    };
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(malformedLegacyCompleted))
    })).rejects.toThrow("새 요청을 전송하지 않습니다");
    const legacyFailedForExplicitAbandonment = {
      ...malformedLegacyCompleted,
      status: "failed",
      segments: []
    };
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(legacyFailedForExplicitAbandonment))
    })).toEqual(legacyFailedForExplicitAbandonment);
    const valid = currentGenerationReceipt();
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(valid))
    })).toEqual(valid);
    for (const corrupt of [
      (value) => { delete value.request; },
      (value) => { delete value.recoveryAttempts; },
      (value) => { value.sessionBindingHash = `sha256:${"0".repeat(64)}`; },
      (value) => { value.providerAttestation.sessionBindingHash = `sha256:${"0".repeat(64)}`; },
      (value) => { value.status = "completed"; }
    ]) {
      const malformed = structuredClone(valid);
      corrupt(malformed);
      await expect(readGeminiGenerationReceipt("/receipt", {
        existsFn: () => true,
        readFileFn: async () => Buffer.from(JSON.stringify(malformed))
      })).rejects.toThrow("손상되었습니다");
    }
    const orphanedConsumption = currentGenerationReceipt({
      legacySubmissionAbandonmentConsumptions: [{ segmentIndex: 1 }]
    });
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(orphanedConsumption))
    })).rejects.toThrow("손상되었습니다");
    const safePromptReadinessFailure = currentGenerationReceipt({
      errorCode: "GEMINI_PROMPT_FILL_MISMATCH",
      promptReadinessFailure: {
        schemaVersion: 1,
        code: "GEMINI_PROMPT_FILL_MISMATCH",
        recordedAt: "2026-08-12T14:00:00.000Z",
        promptFieldVisible: true,
        expectedLength: 1457,
        observedLength: 1000,
        expectedCanonicalLength: 1455,
        observedCanonicalLength: 998,
        expectedCanonicalHash: `sha256:${"6".repeat(64)}`,
        observedCanonicalHash: `sha256:${"7".repeat(64)}`,
        expectedNewlineCount: 2,
        observedNewlineCount: 1
      }
    });
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(safePromptReadinessFailure))
    })).toEqual(safePromptReadinessFailure);
    const leakedPromptReadinessFailure = structuredClone(safePromptReadinessFailure);
    leakedPromptReadinessFailure.promptReadinessFailure.promptValue = "provider prompt body must not be stored here";
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(leakedPromptReadinessFailure))
    })).rejects.toThrow("손상되었습니다");
    expect(await readGeminiGenerationReceipt("/receipt", { receiptBytes: null })).toBeNull();
  });

  test("pins the canonical generation receipt and rejects external aliases, oversized bytes, invalid UTF-8, and replacement", async () => {
    const fixture = partialResumeFixture();
    const jobDir = fixture.jobDir;
    const receiptPath = join(jobDir, "gemini-generation.json");
    const externalRoot = await mkdtemp(join(tmpdir(), "ps4-gemini-receipt-boundary-"));
    generatedJobDirs.push(jobDir, externalRoot);
    await mkdir(jobDir, { recursive: true });
    const providerZero = {
      ...fixture.generation,
      status: "failed",
      segments: [],
      pendingSegment: null,
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: false,
      submissionRunIds: [],
      recoveryAttempts: [],
      recoveredPendingSegments: [],
      rejectedResumes: [],
      resumedFrom: null,
      resumedFromCompletedGeneration: null
    };
    const receiptBytes = Buffer.from(JSON.stringify(providerZero));
    const externalReceipt = join(externalRoot, "external-generation.json");
    await writeFile(externalReceipt, receiptBytes, { mode: 0o600 });

    const externalBeforeSymlink = await stat(externalReceipt, { bigint: true });
    await symlink(externalReceipt, receiptPath);
    await expect(readGeminiGenerationReceipt(receiptPath)).rejects.toThrow("새 요청을 전송하지 않습니다");
    const lineage = await inspectGeminiRetryResetLineage({
      monitorState: { jobId: fixture.job.id, runId: fixture.generation.runId, profileId: "account-1" },
      currentJob: { id: fixture.job.id, runId: fixture.generation.runId },
      jobsRoot: JOBS_DIR
    });
    expect(lineage).toMatchObject({ resetAllowed: false, reason: "prior-generation-receipt-invalid" });
    expect(await readFile(externalReceipt)).toEqual(receiptBytes);
    const externalAfterSymlink = await stat(externalReceipt, { bigint: true });
    expect(externalAfterSymlink.mtimeNs).toBe(externalBeforeSymlink.mtimeNs);
    expect(externalAfterSymlink.ctimeNs).toBe(externalBeforeSymlink.ctimeNs);
    await unlink(receiptPath);

    await link(externalReceipt, receiptPath);
    const externalBeforeHardlink = await stat(externalReceipt, { bigint: true });
    await expect(readGeminiGenerationReceipt(receiptPath)).rejects.toThrow("single-link regular file");
    expect(await readFile(externalReceipt)).toEqual(receiptBytes);
    const externalAfterHardlink = await stat(externalReceipt, { bigint: true });
    expect(externalAfterHardlink.nlink).toBe(externalBeforeHardlink.nlink);
    expect(externalAfterHardlink.mtimeNs).toBe(externalBeforeHardlink.mtimeNs);
    expect(externalAfterHardlink.ctimeNs).toBe(externalBeforeHardlink.ctimeNs);
    await unlink(receiptPath);

    const oversized = await open(receiptPath, "wx", 0o600);
    await oversized.truncate(GEMINI_GENERATION_RECEIPT_MAX_BYTES + 1);
    await oversized.close();
    const oversizedBefore = await stat(receiptPath, { bigint: true });
    await expect(readGeminiGenerationReceipt(receiptPath)).rejects.toThrow("single-link regular file");
    const oversizedAfter = await stat(receiptPath, { bigint: true });
    expect(oversizedAfter.size).toBe(oversizedBefore.size);
    expect(oversizedAfter.mtimeNs).toBe(oversizedBefore.mtimeNs);
    await unlink(receiptPath);

    await writeFile(receiptPath, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(readGeminiGenerationReceipt(receiptPath)).rejects.toThrow("손상되었습니다");
    await unlink(receiptPath);

    await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
    await expect(readGeminiGenerationReceipt(receiptPath)).resolves.toEqual(providerZero);
    const displacedReceipt = join(externalRoot, "displaced-generation.json");
    const replacementReceipt = join(externalRoot, "replacement-generation.json");
    await writeFile(replacementReceipt, receiptBytes, { mode: 0o600 });
    await expect(readGeminiGenerationReceipt(receiptPath, {
      afterPinnedReadForTest: async () => {
        await rename(receiptPath, displacedReceipt);
        await rename(replacementReceipt, receiptPath);
      }
    })).rejects.toThrow("canonical path가 읽는 중 교체");
  });

  test("keeps schema 4 historical and requires observed runtime, lineage, and source fields only in schema 5", async () => {
    const strict = partialResumeFixture().generation;
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(strict))
    })).toEqual(strict);
    const rawFailure = structuredClone(strict);
    rawFailure.error = "private DOM retry label and conversation body";
    rawFailure.errorCode = "GEMINI_PROVIDER_FAILURE";
    await expect(readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(rawFailure))
    })).rejects.toThrow("손상되었습니다");
    const safeFailure = structuredClone(strict);
    safeFailure.errorEvidence = createGeminiFailureEvidence(rawFailure.error, { phase: "pipeline" });
    safeFailure.error = safeFailure.errorEvidence.reasonCode;
    safeFailure.errorCode = "GEMINI_PROVIDER_FAILURE";
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(safeFailure))
    })).toEqual(safeFailure);
    for (const mutate of [
      (value) => { delete value.providerAttestation.runtimeProof; delete value.providerAttestation.runtimeProofHash; value.providerAttestationHash = canonicalJsonHash(value.providerAttestation); value.segments[0].providerAttestationHash = value.providerAttestationHash; },
      (value) => { delete value.segments[0].targetConversationLineage; delete value.segments[0].targetConversationLineageHash; },
      (value) => { delete value.segments[0].sourceGenerationHash; },
      (value) => { value.segments[0].sourceRunId = "ancestor-not-immediate"; value.segments[0].sourceGenerationHash = `sha256:${"a".repeat(64)}`; value.segments[0].providerRequestSentThisRun = true; },
      (value) => { delete value.providerRequestSentThisRun; },
      (value) => { value.submissionRunIds = ["wrong-run"]; }
    ]) {
      const corrupted = structuredClone(strict);
      mutate(corrupted);
      await expect(readGeminiGenerationReceipt("/receipt", {
        existsFn: () => true,
        readFileFn: async () => Buffer.from(JSON.stringify(corrupted))
      })).rejects.toThrow("손상되었습니다");
    }
    const historical = structuredClone(strict);
    historical.schemaVersion = 4;
    delete historical.providerAttestation.runtimeProof;
    delete historical.providerAttestation.runtimeProofHash;
    historical.providerAttestationHash = canonicalJsonHash(historical.providerAttestation);
    historical.segments[0].providerAttestationHash = historical.providerAttestationHash;
    delete historical.segments[0].targetConversationLineage;
    delete historical.segments[0].targetConversationLineageHash;
    delete historical.segments[0].sourceRunId;
    delete historical.segments[0].sourceGenerationHash;
    delete historical.segments[0].providerRequestSentThisRun;
    delete historical.segments[0].inheritedProviderSubmission;
    delete historical.providerRequestSentThisRun;
    delete historical.inheritedProviderSubmission;
    delete historical.submissionRunIds;
    expect(await readGeminiGenerationReceipt("/receipt", {
      existsFn: () => true,
      readFileFn: async () => Buffer.from(JSON.stringify(historical))
    })).toEqual(historical);
  });

  test("accepts only an exact completed-prefix preflight and checks every clip before browser access", async () => {
    const fixture = partialResumeFixture();
    let fileHashCalls = 0;
    let formatCalls = 0;
    await expect(assertGeminiPartialResumePreflight({
      job: fixture.job,
      script: fixture.script,
      jobDir: fixture.jobDir,
      previousGeneration: fixture.generation,
      requestPayload: fixture.request,
      requestHash: fixture.generation.requestHash,
      scriptHash: fixture.generation.scriptHash,
      resumeRequestHash: fixture.generation.resumeRequestHash,
      resumeScriptHash: fixture.generation.resumeScriptHash,
      sessionBinding: fixture.generation.sessionBinding,
      sessionBindingHash: fixture.generation.sessionBindingHash,
      providerDecision: fixture.generation.providerDecision,
      providerDecisionHash: fixture.generation.providerDecisionHash
    }, {
      existsFn: () => true,
      readFileFn: async () => { fileHashCalls += 1; return fixture.clipBytes; },
      writeFileFn: async () => {},
      unlinkFn: async () => {},
      clipMatchesFormatFn: async () => { formatCalls += 1; return true; }
    })).resolves.toMatchObject({ required: true, segmentCount: 1 });
    expect(fileHashCalls).toBe(1);
    expect(formatCalls).toBe(1);
  });

  test("records direct, completed, partial, pending, and two-hop lineage against the immediate source", () => {
    expect(geminiSegmentSubmissionLineage(null, true)).toEqual({
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null
    });
    const first = { schemaVersion: 5, provider: "gemini-browser", runId: "first", ancestor: null };
    const completedReuse = geminiSegmentSubmissionLineage(first, false);
    const partialReuse = geminiSegmentSubmissionLineage(first, false);
    const pendingRecovery = geminiSegmentSubmissionLineage(first, false);
    expect(completedReuse).toEqual(partialReuse);
    expect(partialReuse).toEqual(pendingRecovery);
    expect(completedReuse).toMatchObject({
      sourceRunId: "first",
      sourceGenerationHash: canonicalJsonHash(first),
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true
    });
    const second = {
      schemaVersion: 5,
      provider: "gemini-browser",
      runId: "second",
      inheritedSegment: completedReuse
    };
    const thirdHop = geminiSegmentSubmissionLineage(second, false);
    expect(thirdHop.sourceRunId).toBe("second");
    expect(thirdHop.sourceGenerationHash).toBe(canonicalJsonHash(second));
    expect(thirdHop.sourceGenerationHash).not.toBe(completedReuse.sourceGenerationHash);
  });

  test("blocks every completed-prefix tamper with zero browser/provider calls", async () => {
    const fixture = partialResumeFixture();
    generatedJobDirs.push(fixture.jobDir);
    await mkdir(join(fixture.jobDir, "clips"), { recursive: true });
    let browserCalls = 0;
    let providerCalls = 0;
    const dependencies = {
      existsFn: () => true,
      readFileFn: async () => fixture.clipBytes,
      writeFileFn: async () => {},
      unlinkFn: async () => {},
      clipMatchesFormatFn: async () => true,
      resolveBrowserVersionFn: async () => { browserCalls += 1; throw new Error("browser must not be reached"); },
      observeGeminiGenerationRuntimeFn: async () => { browserCalls += 1; throw new Error("browser must not be reached"); },
      connectBrowserFn: async () => { browserCalls += 1; providerCalls += 1; throw new Error("provider must not be reached"); }
    };
    const exactWithoutExpectation = recoveryReceiptForGeneration(fixture.generation);
    await writeFile(join(fixture.jobDir, "gemini-generation.json"), exactWithoutExpectation.body);
    await expect(generateGeminiClips(fixture.job, fixture.script, async () => {}, dependencies))
      .rejects.toThrow("immutable byte 영수증이 없습니다");
    expect(browserCalls).toBe(0);
    expect(providerCalls).toBe(0);
    const mutations = [
      (value) => { value.requestHash = `sha256:${"0".repeat(64)}`; value.segments[0].requestHash = value.requestHash; },
      (value) => { value.resumeScriptHash = `sha256:${"0".repeat(64)}`; value.segments[0].resumeScriptHash = value.resumeScriptHash; },
      (value) => { value.sessionBindingHash = `sha256:${"0".repeat(64)}`; },
      (value) => { value.providerAttestationHash = `sha256:${"0".repeat(64)}`; value.segments[0].providerAttestationHash = value.providerAttestationHash; },
      (value) => { value.segments[0].prompt += " tampered"; },
      (value) => { value.segments[0].providerVisualPromptHash = `sha256:${"0".repeat(64)}`; },
      (value) => { value.segments[0].targetConversationLineage.targetIdHash = `sha256:${"0".repeat(64)}`; },
      (value) => { value.segments[0].index = 2; value.segments[0].path = "clips/02.mp4"; value.segments[0].output = "clips/02.mp4"; },
      (value) => { value.segments.push(structuredClone(value.segments[0])); },
      (value) => { value.segments[0].providerRequestSentThisRun = false; },
      (value) => { value.submissionRunIds = ["different-run"]; }
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(fixture.generation);
      mutate(corrupted);
      const source = recoveryReceiptForGeneration(corrupted);
      await writeFile(join(fixture.jobDir, "gemini-generation.json"), source.body);
      await expect(generateGeminiClips({
        ...fixture.job,
        expectedRecoverySourceGenerationReceipt: source.expected
      }, fixture.script, async () => {}, dependencies))
        .rejects.toThrow(/새 요청|브라우저|손상|exact 결속/);
      expect(browserCalls).toBe(0);
      expect(providerCalls).toBe(0);
    }
    const exactReceiptButWrongBytes = structuredClone(fixture.generation);
    const exactSource = recoveryReceiptForGeneration(exactReceiptButWrongBytes);
    await writeFile(join(fixture.jobDir, "gemini-generation.json"), exactSource.body);
    const exactJob = { ...fixture.job, expectedRecoverySourceGenerationReceipt: exactSource.expected };
    await expect(generateGeminiClips(exactJob, fixture.script, async () => {}, {
      ...dependencies,
      readFileFn: async () => Buffer.from("different clip bytes")
    })).rejects.toThrow("새 요청을 전송하지 않습니다");
    expect(browserCalls).toBe(0);
    expect(providerCalls).toBe(0);
    await expect(generateGeminiClips(exactJob, fixture.script, async () => {}, {
      ...dependencies,
      clipMatchesFormatFn: async () => false
    })).rejects.toThrow("새 요청을 전송하지 않습니다");
    expect(browserCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("retains exact legacy abandonment provenance across repeated recovery runs", () => {
    const receipt = {
      path: "gemini-legacy-abandonment.json",
      receiptHash: `sha256:${"a".repeat(64)}`,
      sourceGenerationSha256: `sha256:${"b".repeat(64)}`,
      authorizedAt: "2026-08-12T13:00:00.000Z",
      authorization: "explicit-operator-cli",
      operatorAssertion: "no-live-recoverable-conversation-target",
      liveCdpObservation: {
        observedAt: "2026-08-12T13:00:00.000Z",
        cdpOriginHash: `sha256:${"c".repeat(64)}`,
        targetCount: 1,
        prohibitedTargetCount: 0,
        targetSetHash: `sha256:${"d".repeat(64)}`,
        headless: true,
        headlessImplementation: "new",
        runtimeProofHash: `sha256:${"f".repeat(64)}`
      }
    };
    const evidence = {
      schemaVersion: 1,
      generationPath: "legacy-gemini-evidence/abandoned-gemini-generation.json",
      generationSha256: receipt.sourceGenerationSha256,
      receiptPath: "legacy-gemini-evidence/abandonment-receipt.json",
      receiptSha256: `sha256:${"e".repeat(64)}`,
      receiptHash: receipt.receiptHash
    };
    const first = retainLegacyGeminiAbandonmentProvenance({}, { required: true, receipt }, evidence);
    const second = retainLegacyGeminiAbandonmentProvenance({
      legacySubmissionAbandonment: first.receipt,
      legacySubmissionAbandonmentEvidence: first.evidence,
      legacySubmissionAbandonmentConsumptions: []
    }, { required: false, receipt: null }, null);
    expect(second).toEqual(first);

    const corrupted = structuredClone(evidence);
    corrupted.generationPath = "../unbound-generation.json";
    expect(() => retainLegacyGeminiAbandonmentProvenance({
      legacySubmissionAbandonment: receipt,
      legacySubmissionAbandonmentEvidence: corrupted
    }, { required: false, receipt: null }, null)).toThrow("안전하게 이어받을 수 없습니다");
  });

  test("selects only the single exact live conversation target", () => {
    const checkpoint = {
      targetId: "target-1",
      conversationUrl: "https://gemini.google.com/app/conversation-1?hl=ko"
    };
    expect(canonicalGeminiConversationUrl(checkpoint.conversationUrl)).toBe("https://gemini.google.com/app/conversation-1");
    expect(selectGeminiRecoveryTarget(checkpoint, [{
      targetId: "target-1",
      type: "page",
      url: "https://gemini.google.com/app/conversation-1?hl=en"
    }])).toMatchObject({ status: "exact", conversationUrl: "https://gemini.google.com/app/conversation-1" });
    expect(selectGeminiRecoveryTarget(checkpoint, [
      { targetId: "target-1", type: "page", url: "https://gemini.google.com/app/conversation-1" },
      { targetId: "target-2", type: "page", url: "https://gemini.google.com/app/conversation-1?hl=ko" }
    ])).toMatchObject({ status: "ambiguous", matchCount: 2 });
    expect(selectGeminiRecoveryTarget(checkpoint, [{
      targetId: "different-target",
      type: "page",
      url: "https://gemini.google.com/app/conversation-1"
    }])).toMatchObject({ status: "target-id-mismatch" });
    expect(selectGeminiRecoveryTarget({ ...checkpoint, conversationUrl: "https://example.test/app/conversation-1" }, [])).toMatchObject({
      status: "missing"
    });
    expect(selectGeminiRecoveryTarget({ targetId: "target-1", conversationUrl: null }, [{
      targetId: "target-1",
      type: "page",
      url: "https://gemini.google.com/app/late-bound"
    }])).toMatchObject({
      status: "exact-unbound",
      conversationUrl: "https://gemini.google.com/app/late-bound"
    });
  });

  test("requires a fully bound acknowledgement before a retry may recover without resubmission", () => {
    const prompt = "Create a vertical 9:16 documentary clip.";
    const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    const promptHash = digest({ prompt });
    const sessionBinding = { binding: "session" };
    const providerDecision = { decision: "gemini-browser" };
    const providerAttestation = { attestation: "headless-session" };
    const current = {
      jobId: "job-1",
      index: 1,
      prompt,
      requestHash: "request-1",
      scriptHash: "script-1",
      resumeRequestHash: "resume-request",
      resumeScriptHash: "resume-script",
      sessionBindingHash: digest(sessionBinding),
      providerDecisionHash: digest(providerDecision),
      providerAttestationHash: digest(providerAttestation),
      providerVisualPromptHash: digest({ providerVisualPrompt: prompt }),
      shotPattern: null
    };
    const previous = {
      schemaVersion: 5,
      status: "failed",
      provider: "gemini-browser",
      jobId: "job-1",
      runId: "run-1",
      requestHash: "request-1",
      scriptHash: "script-1",
      resumeRequestHash: current.resumeRequestHash,
      resumeScriptHash: current.resumeScriptHash,
      sessionBindingHash: current.sessionBindingHash,
      providerDecisionHash: current.providerDecisionHash,
      providerAttestationHash: current.providerAttestationHash,
      sessionBinding,
      providerDecision,
      providerAttestation,
      recoveryAttempts: [],
      pendingSegment: {
        schemaVersion: 1,
        status: "submitted-awaiting-result",
        index: 1,
        runId: "run-1",
        submissionRunId: "run-1",
        requestHash: "request-1",
        scriptHash: "script-1",
        resumeRequestHash: current.resumeRequestHash,
        resumeScriptHash: current.resumeScriptHash,
        sessionBindingHash: current.sessionBindingHash,
        providerDecisionHash: current.providerDecisionHash,
        providerAttestationHash: current.providerAttestationHash,
        prompt,
        promptHash,
        providerVisualPromptHash: current.providerVisualPromptHash,
        shotPattern: null,
        submittedToProvider: true,
        submittedAt: "2026-08-12T12:00:00.000Z",
        timeoutMs: 1_200_000,
        conversationUrl: "https://gemini.google.com/app/conversation-1",
        targetId: "target-1",
        knownMedia: { videos: [], links: [], chats: [] },
        submissionAcknowledgement: { verified: true, clickCount: 1, evidenceTypes: ["user-message"] }
      }
    };

    expect(geminiPendingRecoveryDecision(previous, current)).toMatchObject({
      applicable: true,
      eligible: true,
      reason: "exact-pending-recovery"
    });
    const ambiguous = structuredClone(previous);
    ambiguous.pendingSegment.status = "ambiguous-submitted";
    ambiguous.pendingSegment.conversationUrl = null;
    expect(geminiPendingRecoveryDecision(ambiguous, current)).toMatchObject({ eligible: true, reason: "exact-pending-recovery" });

    const intent = structuredClone(previous);
    intent.pendingSegment = {
      ...intent.pendingSegment,
      schemaVersion: 2,
      status: "submit-intent",
      submittedToProvider: null,
      submissionMayHaveOccurred: true,
      intentCreatedAt: "2026-08-12T12:00:00.000Z",
      conversationUrl: null,
      submissionAcknowledgement: null,
      submissionBaseline: createGeminiSubmissionBaseline(prompt, {
        promptFieldVisible: true,
        promptValue: prompt,
        sendEnabled: true,
        userMessageMatchCount: 0,
        stopResponseCount: 0,
        generationEvidenceCount: 0,
        generationEvidenceKeys: [],
        conversationUrl: null
      }, "2026-08-12T12:00:00.000Z")
    };
    expect(geminiPendingRecoveryDecision(intent, current)).toMatchObject({
      eligible: true,
      reason: "exact-submit-intent-recovery"
    });
    intent.pendingSegment.submissionBaseline.baselineHash = `sha256:${"0".repeat(64)}`;
    expect(geminiPendingRecoveryDecision(intent, current)).toMatchObject({ eligible: false, reason: "submit-intent-baseline-invalid" });

    const secondRecovery = structuredClone(previous);
    secondRecovery.runId = "recovery-run-1";
    secondRecovery.pendingSegment.runId = "recovery-run-1";
    secondRecovery.recoveryAttempts = [{
      attempt: 1,
      runId: "recovery-run-1",
      submissionRunId: "run-1",
      startedAt: "2026-08-12T12:30:00.000Z",
      status: "timed-out"
    }];
    expect(geminiPendingRecoveryDecision(secondRecovery, current)).toMatchObject({ eligible: true });
    expect(secondRecovery.pendingSegment.submissionRunId).toBe("run-1");
    for (const mutate of [
      (value) => { value.pendingSegment.runId = "different-run"; },
      (value) => { value.pendingSegment.prompt += " altered"; },
      (value) => { value.pendingSegment.providerAttestationHash = "different-attestation"; },
      (value) => { value.pendingSegment.submissionAcknowledgement.verified = false; },
      (value) => { value.pendingSegment.timeoutMs = 1; },
      (value) => { value.pendingSegment.knownMedia.links = ["https://signed.example.test/video.mp4?token=secret"]; },
      (value) => { value.pendingSegment.knownMedia.videos = [42]; }
    ]) {
      const corrupted = structuredClone(previous);
      mutate(corrupted);
      expect(geminiPendingRecoveryDecision(corrupted, current)).toMatchObject({ applicable: true, eligible: false });
    }
    expect(geminiPendingRecoveryDecision(previous, { ...current, resumeScriptHash: "new-script" })).toMatchObject({
      applicable: false,
      eligible: false,
      reason: "semantic-resume-mismatch"
    });
  });
});

describe("Gemini browser generation safety", () => {
  test("requires an authoritative aspect-ratio label or selected state", () => {
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Aspect ratio: Portrait" })).toMatchObject({
      configured: true,
      method: "control-label"
    });
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "가로세로 비율: 세로 모드" }).configured).toBe(true);
    expect(geminiAspectRatioEvidence("vertical", {
      controlLabel: "Aspect ratio",
      options: [{ label: "Portrait 9:16", selected: true }]
    })).toMatchObject({ configured: true, method: "selected-state" });
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Aspect ratio" }).configured).toBe(false);
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Landscape 16:9" })).toMatchObject({
      configured: false,
      contradiction: true
    });
  });

  test("detects precise video quota messages without treating upgrade copy as exhaustion", () => {
    expect(geminiVideoQuotaMessage("동영상을 다시 생성할 수 있습니다: 오늘 오후 8:20")).toContain("동영상을 다시 생성할 수 있습니다");
    expect(geminiVideoQuotaMessage("Video generation limit reached. Videos will be available again tomorrow.")).toContain("Video generation limit reached");
    expect(geminiVideoQuotaMessage("업그레이드하여 더 많은 기능을 이용하세요")).toBeNull();
    expect(geminiVideoQuotaMessage("Manage quota and billing in settings")).toBeNull();
  });

  test("canonical resume hash ignores capture timestamps but binds prompts, evidence, and source hashes", () => {
    const script = {
      title: "박석 배수 구조",
      capturedAt: "2026-08-12T10:00:00.000Z",
      sources: [{
        url: "https://example.test/source",
        sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetchedAt: "2026-08-12T10:00:01.000Z",
        evidence: [{ id: "excerpt-1", quote: "박석 사이로 물이 빠집니다." }]
      }],
      segments: [{
        visualPrompt: "vertical documentary close-up of stone drainage",
        narration: "박석 사이로 물이 빠집니다.",
        sourceEvidence: [{ sourceId: "https://example.test/source", quote: "박석 사이로 물이 빠집니다." }]
      }]
    };
    const timestampOnlyChange = structuredClone(script);
    timestampOnlyChange.capturedAt = "2026-08-12T11:00:00.000Z";
    timestampOnlyChange.sources[0].fetchedAt = "2026-08-12T11:00:01.000Z";
    expect(canonicalGeminiResumeScriptHash(timestampOnlyChange)).toBe(canonicalGeminiResumeScriptHash(script));

    for (const mutate of [
      (value) => { value.segments[0].visualPrompt += " in rain"; },
      (value) => { value.sources[0].evidence[0].quote = "다른 근거"; },
      (value) => { value.sources[0].sha256 = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }
    ]) {
      const changed = structuredClone(script);
      mutate(changed);
      expect(canonicalGeminiResumeScriptHash(changed)).not.toBe(canonicalGeminiResumeScriptHash(script));
    }
  });

  test("reads exact prompt, send control, and fresh acknowledgement evidence from the DOM", () => {
    const prompt = "Create a vertical 9:16 documentary clip.";
    const element = (input = {}) => ({
      tagName: input.tagName || "DIV",
      innerText: input.innerText || "",
      textContent: input.textContent ?? input.innerText ?? "",
      value: input.value,
      disabled: input.disabled || false,
      href: input.href || "",
      src: input.src || "",
      currentSrc: input.currentSrc || "",
      getBoundingClientRect: () => ({ width: input.width ?? 100, height: input.height ?? 40 }),
      getAttribute: (name) => input.attributes?.[name] ?? null,
      contains: (candidate) => Array.isArray(input.children) && input.children.includes(candidate)
    });
    const field = element({ tagName: "TEXTAREA", value: prompt, width: 600, height: 120 });
    const createVideo = element({ tagName: "BUTTON", attributes: { "aria-label": "Create videos" } });
    const send = element({ tagName: "BUTTON", attributes: { "aria-label": "Send message" } });
    const stop = element({ tagName: "BUTTON", attributes: { "aria-label": "Stop response" } });
    const userMessage = element({ tagName: "USER-QUERY", innerText: prompt });
    const response = element({ tagName: "MODEL-RESPONSE", innerText: "Generating video" });
    let acknowledged = false;
    const root = {
      querySelectorAll(selector) {
        if (selector === 'textarea,[contenteditable="true"],[role="textbox"]') return [field];
        if (selector === 'button,[role="button"]') return acknowledged ? [createVideo, send, stop] : [createVideo, send];
        if (selector.includes("user-query")) return acknowledged ? [userMessage] : [];
        if (selector.includes("model-response")) return acknowledged ? [response] : [];
        return [];
      }
    };

    const baseline = geminiPromptSubmissionDomState(prompt, root, "https://gemini.google.com/videos");
    expect(baseline).toMatchObject({
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      sendLabel: "Send message",
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      conversationUrl: null
    });

    acknowledged = true;
    field.value = "";
    const after = geminiPromptSubmissionDomState(prompt, root, "https://gemini.google.com/app/conversation-1");
    expect(after).toMatchObject({
      promptValue: "",
      userMessageMatchCount: 1,
      stopResponseCount: 1,
      generationEvidenceCount: 1,
      conversationUrl: "https://gemini.google.com/app/conversation-1"
    });
    expect(geminiPromptSubmissionEvidence(prompt, baseline, after)).toMatchObject({
      verified: true,
      promptCleared: true,
      hasNewEvidence: true
    });
  });

  test("treats Quill blank-line and zero-width residue as a cleared editor", () => {
    const field = {
      tagName: "DIV",
      innerText: "\n\u200b\ufeff",
      textContent: "\n\u200b\ufeff",
      getBoundingClientRect: () => ({ width: 600, height: 80 }),
      getAttribute: (name) => name === "role" ? "textbox" : null,
      contains: () => false
    };
    const userMessage = {
      tagName: "USER-QUERY",
      innerText: "궁궐 배수의 비밀",
      textContent: "궁궐 배수의 비밀",
      getBoundingClientRect: () => ({ width: 500, height: 60 }),
      getAttribute: () => null,
      contains: () => false
    };
    const root = {
      querySelectorAll(selector) {
        if (selector === 'textarea,[contenteditable="true"],[role="textbox"]') return [field];
        if (selector === 'button,[role="button"]') return [];
        if (selector.includes("user-query")) return [userMessage];
        return [];
      }
    };
    const state = geminiPromptSubmissionDomState("궁궐 배수의 비밀", root, "https://gemini.google.com/app/thread-1");
    expect(state.promptValue).toBe("");
    expect(geminiPromptSubmissionEvidence("궁궐 배수의 비밀", {
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    }, state)).toMatchObject({ verified: true, promptCleared: true, evidenceTypes: ["user-message", "generation"] });
  });

  test("accepts Quill paragraph whitespace while retaining the exact original prompt hash", async () => {
    const prompt = "First evidence line\nSecond evidence line";
    const quillRenderedPrompt = "First\u00a0evidence line\r\n\r\nSecond evidence line";
    expect(canonicalGeminiEditorText(quillRenderedPrompt)).toBe(canonicalGeminiEditorText(prompt));

    const baseline = {
      promptFieldVisible: true,
      promptValue: quillRenderedPrompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    const after = { ...baseline, promptValue: "", userMessageMatchCount: 1 };
    const observations = [baseline, after];
    let clicks = 0;
    let checkpoint = null;
    const result = await confirmGeminiPromptSubmission({
      prompt,
      observe: async () => observations.shift(),
      initialClick: async () => { clicks += 1; return { clicked: true, method: "button" }; },
      retryClick: async () => ({ clicked: false }),
      onBeforeInitialClick: async (observation) => {
        checkpoint = createGeminiSubmissionBaseline(prompt, observation, "2026-08-12T14:00:00.000Z");
      },
      sleepFn: async () => {},
      pollsPerWindow: 1,
      maxClickAttempts: 1
    });

    expect(result).toMatchObject({ submitted: true, verified: true, clickCount: 1 });
    expect(clicks).toBe(1);
    expect(checkpoint.promptHash).toBe(canonicalJsonHash({ prompt }));
    expect(checkpoint.promptHash).not.toBe(canonicalJsonHash({ prompt: quillRenderedPrompt }));
  });

  test("binds the durable submit baseline to raw prompt bytes, not display normalization", () => {
    const rawPrompt = "\u200B  First evidence line\nSecond evidence line \uFEFF ";
    const displayNormalizedPrompt = rawPrompt.replace(/[\u200B\uFEFF]/g, "").trim();
    const observation = {
      promptFieldVisible: true,
      promptValue: "First evidence line\n\nSecond evidence line",
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    const baseline = createGeminiSubmissionBaseline(rawPrompt, observation, "2026-08-12T14:00:00.000Z");
    expect(baseline.promptHash).toBe(canonicalJsonHash({ prompt: rawPrompt }));
    expect(baseline.promptHash).not.toBe(canonicalJsonHash({ prompt: displayNormalizedPrompt }));
    expect(inspectGeminiSubmitIntent({ status: "submit-intent", submissionBaseline: baseline }, rawPrompt, observation))
      .toMatchObject({ promotable: false, reason: "post-click-outcome-ambiguous" });
    expect(inspectGeminiSubmitIntent({ status: "submit-intent", submissionBaseline: baseline }, displayNormalizedPrompt, observation))
      .toMatchObject({ promotable: false, reason: "submit-intent-invalid" });
  });

  test("polls after filling until the canonical Quill prompt is complete", async () => {
    const prompt = "Evidence-bound scene\nSlow camera reveal";
    const observations = [
      { promptFieldVisible: true, promptValue: "Evidence-bound scene\nSlow camera" },
      { promptFieldVisible: true, promptValue: "Evidence-bound scene\n\nSlow camera reveal" }
    ];
    const readiness = await waitForGeminiPromptReady({
      prompt,
      observe: async () => observations.shift(),
      sleepFn: async () => {},
      maxPolls: 2
    });
    expect(readiness).toMatchObject({ ready: true, attempts: 2 });
    expect(readiness.diagnostics).toMatchObject({
      expectedLength: prompt.length,
      observedLength: prompt.length + 1,
      expectedNewlineCount: 1,
      observedNewlineCount: 2
    });
  });

  test("rejects word, punctuation, and truncation mutations before any click with sanitized diagnostics", async () => {
    const prompt = "Stone courtyard drains rain.\nKeep one slow reveal.";
    const mismatches = [
      "Brick courtyard drains rain.\nKeep one slow reveal.",
      "Stone courtyard drains rain!\nKeep one slow reveal.",
      "Stone courtyard drains rain.\nKeep one slow"
    ];
    for (const promptValue of mismatches) {
      const readiness = geminiPromptReadiness(prompt, { promptFieldVisible: true, promptValue });
      expect(readiness.ready).toBe(false);
      let beforeClick = 0;
      let clicks = 0;
      const result = await confirmGeminiPromptSubmission({
        prompt,
        observe: async () => ({
          promptFieldVisible: true,
          promptValue,
          sendEnabled: true,
          userMessageMatchCount: 0,
          stopResponseCount: 0,
          generationEvidenceCount: 0,
          generationEvidenceKeys: [],
          conversationUrl: null
        }),
        initialClick: async () => { clicks += 1; return { clicked: true }; },
        retryClick: async () => { clicks += 1; return { clicked: true }; },
        onBeforeInitialClick: async () => { beforeClick += 1; }
      });
      expect(result).toMatchObject({ submitted: false, reason: "exact-prompt-not-ready", clickCount: 0 });
      expect(result.diagnostics.expectedCanonicalHash).not.toBe(result.diagnostics.observedCanonicalHash);
      expect(JSON.stringify(result.diagnostics)).not.toContain(prompt);
      expect(JSON.stringify(result)).not.toContain(promptValue);
      expect(beforeClick).toBe(0);
      expect(clicks).toBe(0);
    }
  });

  test("requires both a cleared editor and post-click acknowledgement evidence", () => {
    const prompt = "exact prompt";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    expect(geminiPromptSubmissionEvidence(prompt, baseline, {
      ...baseline,
      promptValue: ""
    })).toMatchObject({ verified: false, promptCleared: true, hasNewEvidence: false });
    expect(geminiPromptSubmissionEvidence(prompt, baseline, {
      ...baseline,
      userMessageMatchCount: 1
    })).toMatchObject({ verified: false, promptCleared: false, hasNewEvidence: true });
    expect(geminiPromptSubmissionEvidence(prompt, baseline, {
      ...baseline,
      promptValue: "",
      stopResponseCount: 1
    })).toMatchObject({ verified: true, promptCleared: true, hasNewEvidence: true });
    expect(geminiPromptRetryDecision(prompt, "vertical", baseline, {
      ...baseline,
      userMessageMatchCount: 1
    }, {
      configured: true,
      contradiction: false
    })).toMatchObject({ eligible: false, reason: "submission-evidence-observed" });
  });

  test("performs one bounded retry only for the same prompt with portrait still selected", async () => {
    const prompt = "exact vertical prompt";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    const observations = [
      baseline,
      baseline,
      { ...baseline, promptValue: "", userMessageMatchCount: 1 }
    ];
    let initialClicks = 0;
    let retryClicks = 0;
    const result = await confirmGeminiPromptSubmission({
      prompt,
      format: "vertical",
      observe: async () => observations.shift(),
      initialClick: async () => { initialClicks += 1; return { clicked: true, method: "button" }; },
      retryClick: async ({ baseline: boundBaseline, observation }) => {
        retryClicks += 1;
        const decision = geminiPromptRetryDecision(prompt, "vertical", boundBaseline, observation, {
          configured: true,
          contradiction: false,
          desiredRatio: "portrait"
        });
        expect(decision).toMatchObject({ eligible: true, reason: "safe-bounded-retry" });
        return { clicked: true, method: "button", evidence: decision.submission };
      },
      sleepFn: async () => {},
      pollsPerWindow: 1,
      maxClickAttempts: 2
    });

    expect(result).toMatchObject({ submitted: true, verified: true, clickCount: 2 });
    expect(result.evidenceTypes).toContain("user-message");
    expect(initialClicks).toBe(1);
    expect(retryClicks).toBe(1);
  });

  test("never retries after any acknowledgement evidence appears", async () => {
    const prompt = "do not duplicate this prompt";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    const observations = [
      baseline,
      { ...baseline, stopResponseCount: 1 },
      { ...baseline, promptValue: "", stopResponseCount: 1 }
    ];
    let retryCalls = 0;
    const result = await confirmGeminiPromptSubmission({
      prompt,
      observe: async () => observations.shift(),
      initialClick: async () => ({ clicked: true, method: "button" }),
      retryClick: async () => { retryCalls += 1; return { clicked: true }; },
      sleepFn: async () => {},
      pollsPerWindow: 2,
      maxClickAttempts: 2
    });

    expect(result).toMatchObject({ submitted: true, verified: true, clickCount: 1 });
    expect(result.evidenceTypes).toContain("stop-response");
    expect(retryCalls).toBe(0);
  });

  test("durably checkpoints verified acknowledgement before returning submission", async () => {
    const prompt = "checkpoint before return";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    const observations = [baseline, { ...baseline, promptValue: "", userMessageMatchCount: 1 }];
    const order = [];
    const result = await confirmGeminiPromptSubmission({
      prompt,
      observe: async () => observations.shift(),
      initialClick: async () => ({ clicked: true, method: "button" }),
      retryClick: async () => ({ clicked: false }),
      onVerified: async (acknowledgement) => {
        order.push("checkpoint");
        expect(acknowledgement).toMatchObject({ submitted: true, verified: true, clickCount: 1 });
      },
      sleepFn: async () => {},
      pollsPerWindow: 1,
      maxClickAttempts: 1
    });
    order.push("returned");
    expect(result.verified).toBe(true);
    expect(order).toEqual(["checkpoint", "returned"]);

    const failedObservations = [baseline, { ...baseline, promptValue: "", stopResponseCount: 1 }];
    await expect(confirmGeminiPromptSubmission({
      prompt,
      observe: async () => failedObservations.shift(),
      initialClick: async () => ({ clicked: true, method: "button" }),
      retryClick: async () => ({ clicked: false }),
      onVerified: async () => { throw new Error("checkpoint-write-failed"); },
      sleepFn: async () => {},
      pollsPerWindow: 1,
      maxClickAttempts: 1
    })).rejects.toThrow("checkpoint-write-failed");
  });

  test("a crash immediately after the first click leaves a recoverable intent and permits no second click", async () => {
    const prompt = "single click crash fence";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    let checkpoint = null;
    let clicks = 0;
    await expect(confirmGeminiPromptSubmission({
      prompt,
      observe: async () => baseline,
      onBeforeInitialClick: async (observation) => {
        checkpoint = {
          status: "submit-intent",
          submissionBaseline: createGeminiSubmissionBaseline(prompt, observation, "2026-08-12T13:00:00.000Z")
        };
      },
      initialClick: async () => {
        clicks += 1;
        throw new Error("fault-after-click");
      },
      retryClick: async () => { clicks += 1; return { clicked: true }; }
    })).rejects.toThrow("fault-after-click");
    expect(clicks).toBe(1);
    expect(checkpoint.status).toBe("submit-intent");
    expect(inspectGeminiSubmitIntent(checkpoint, prompt, baseline)).toMatchObject({
      promotable: false,
      reason: "post-click-outcome-ambiguous"
    });
    expect(clicks).toBe(1);
  });

  test("fails closed before result waiting when acknowledgement cannot be verified", async () => {
    const prompt = "unacknowledged prompt";
    const baseline = {
      promptFieldVisible: true,
      promptValue: prompt,
      sendEnabled: true,
      userMessageMatchCount: 0,
      stopResponseCount: 0,
      generationEvidenceCount: 0,
      generationEvidenceKeys: [],
      conversationUrl: null
    };
    let resultWaitStarted = false;
    const result = await confirmGeminiPromptSubmission({
      prompt,
      format: "vertical",
      observe: async () => baseline,
      initialClick: async () => ({ clicked: true, method: "button" }),
      retryClick: async ({ baseline: boundBaseline, observation }) => {
        const decision = geminiPromptRetryDecision(prompt, "vertical", boundBaseline, observation, {
          configured: false,
          contradiction: true
        });
        return { clicked: false, reason: decision.reason, evidence: decision.submission };
      },
      sleepFn: async () => {},
      pollsPerWindow: 1,
      maxClickAttempts: 2
    });
    if (result.submitted && result.verified) resultWaitStarted = true;

    expect(result).toMatchObject({ submitted: false, reason: "portrait-ratio-unverified", clickCount: 1 });
    expect(resultWaitStarted).toBe(false);
  });
});
