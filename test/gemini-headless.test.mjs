import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertGeminiChromeRuntime,
  buildGeminiChromeLaunchArgs,
  canonicalGeminiEditorText,
  canonicalGeminiConversationUrl,
  canonicalGeminiResumeScriptHash,
  confirmGeminiPromptSubmission,
  createGeminiSubmissionBaseline,
  geminiAspectRatioEvidence,
  geminiChromeMajorVersion,
  geminiPromptRetryDecision,
  geminiPromptReadiness,
  geminiPendingRecoveryDecision,
  geminiPromptSubmissionDomState,
  geminiPromptSubmissionEvidence,
  inspectGeminiSubmitIntent,
  readGeminiGenerationReceipt,
  retainLegacyGeminiAbandonmentProvenance,
  geminiVideoQuotaMessage,
  isHeadlessChromeVersion,
  resolveGeminiChromeLaunchPolicy,
  resolveGeminiVideoTimeoutMs,
  selectGeminiRecoveryTarget,
  waitForGeminiConversationUrl,
  waitForGeminiPromptReady,
  writeGeminiGenerationCheckpoint
} from "../src/gemini-browser.mjs";
import { canonicalJsonHash } from "../src/provenance.mjs";

const HEADLESS_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36"
};

const HEADED_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36"
};
const DEDICATED_PROFILE = join(homedir(), ".ps4-ai-video-studio", "headless-test");

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
    expect(await readGeminiGenerationReceipt("/receipt", { existsFn: () => false })).toBeNull();
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
        headless: true
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
      resumeRequestHash: "resume-request",
      resumeScriptHash: "resume-script",
      sessionBindingHash: digest(sessionBinding),
      providerDecisionHash: digest(providerDecision),
      providerAttestationHash: digest(providerAttestation)
    };
    const previous = {
      schemaVersion: 4,
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
