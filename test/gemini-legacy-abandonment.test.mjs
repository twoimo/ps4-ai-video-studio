import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  attestLegacyGeminiAbandonmentConsumption,
  createLegacyGeminiAbandonment,
  GEMINI_LEGACY_ABANDONMENT_NAME,
  legacyGeminiGenerationNeedsAbandonment,
  readLegacyGeminiAbandonmentDecision,
  unsupportedLegacyGeminiFailure,
  validateLegacyGeminiAbandonment,
  observeLegacyGeminiTargets,
  preserveLegacyGeminiAbandonmentEvidence,
  validateLegacyGeminiAbandonmentConsumption
} from "../src/gemini-legacy-abandonment.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "../src/provenance.mjs";

const temporaryRoots = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TEST_JOB = {
  id: "legacy-job",
  geminiCdpUrl: "http://127.0.0.1:9444",
  geminiProfileDir: "/tmp/ps4-legacy-test-profile"
};

function legacyGeneration(jobId = "legacy-job") {
  const job = { ...TEST_JOB, id: jobId };
  return {
    schemaVersion: 3,
    jobId,
    provider: "gemini-browser",
    runId: "legacy-run",
    status: "failed",
    segments: [],
    error: "result wait timed out",
    sessionBinding: canonicalGeminiSessionBinding(job),
    sessionBindingHash: geminiSessionBindingHash(job)
  };
}

function mockCdp(targets = [{ id: "root", type: "page", url: "https://gemini.google.com/app" }], version = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36"
}) {
  return async (url, options) => {
    expect(options.redirect).toBe("error");
    if (url.endsWith("/json/version")) return new Response(JSON.stringify(version), { status: 200 });
    if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets), { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ps4-gemini-abandonment-"));
  temporaryRoots.push(root);
  const jobsDir = join(root, "jobs");
  const jobId = "legacy-job";
  const jobDir = join(jobsDir, jobId);
  await mkdir(jobDir, { recursive: true });
  const generation = legacyGeneration(jobId);
  const generationBytes = Buffer.from(JSON.stringify(generation, null, 2));
  const generationPath = join(jobDir, "gemini-generation.json");
  await writeFile(generationPath, generationBytes);
  await writeFile(join(jobDir, "job.json"), JSON.stringify({ ...TEST_JOB, id: jobId }, null, 2));
  return { root, jobsDir, jobId, jobDir, generation, generationPath, generationSha256: sha256(generationBytes) };
}

describe("explicit legacy Gemini submission abandonment", () => {
  test("fails closed until an exact job- and generation-bound operator receipt exists", async () => {
    const value = await fixture();
    expect(legacyGeminiGenerationNeedsAbandonment(value.generation)).toBe(true);
    expect(await readLegacyGeminiAbandonmentDecision(value)).toMatchObject({
      required: true,
      allowed: false,
      reason: "operator-abandonment-receipt-missing"
    });

    const created = await createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "기존 제출 대화 target이 존재하지 않음을 운영자가 확인했습니다.",
      assertNoLiveTarget: true,
      fetchFn: mockCdp(),
      now: () => new Date("2026-08-12T13:00:00.000Z")
    });
    expect(created.receipt).toMatchObject({
      schemaVersion: 2,
      type: "gemini-legacy-submission-abandonment",
      jobId: value.jobId,
      authorization: "explicit-operator-cli",
      operatorAssertion: "no-live-recoverable-conversation-target",
      sourceGeneration: { sha256: value.generationSha256 },
      liveCdpObservation: {
        method: "loopback-cdp-json-read-only",
        headless: true,
        prohibitedTargetCount: 0,
        targetCount: 1
      }
    });
    expect(created.receipt.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await stat(created.receiptPath)).mode & 0o077).toBe(0);
    expect(await readLegacyGeminiAbandonmentDecision(value)).toMatchObject({
      required: true,
      allowed: true,
      reason: "explicit-operator-abandonment",
      receipt: { sourceGenerationSha256: value.generationSha256 }
    });
    await expect(createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "같은 폐기를 두 번 만들 수 없어야 합니다.",
      assertNoLiveTarget: true
      , fetchFn: mockCdp()
    })).rejects.toThrow("이미");
  });

  test("rejects a missing assertion, wrong source hash, and receipt mutation", async () => {
    const value = await fixture();
    await expect(createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "충분히 긴 운영자 확인 사유입니다.",
      assertNoLiveTarget: false
    })).rejects.toThrow("assert-no-live-target");
    await expect(createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: `sha256:${"0".repeat(64)}`,
      reason: "충분히 긴 운영자 확인 사유입니다.",
      assertNoLiveTarget: true
      , fetchFn: mockCdp()
    })).rejects.toThrow("일치하지 않습니다");

    const { receiptPath } = await createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "기존 target이 없음을 명시적으로 확인했습니다.",
      assertNoLiveTarget: true
      , fetchFn: mockCdp()
    });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.reason += " 변조";
    expect(validateLegacyGeminiAbandonment({
      jobId: value.jobId,
      generation: value.generation,
      generationSha256: value.generationSha256,
      receipt
    })).toMatchObject({ required: true, allowed: false, reason: "operator-abandonment-integrity-failed" });
  });

  test("rejects unavailable, malformed, headed, or live generation CDP observations", async () => {
    const value = await fixture();
    const common = {
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "live CDP target 부재를 독립적으로 확인합니다.",
      assertNoLiveTarget: true
    };
    await expect(createLegacyGeminiAbandonment({
      ...common,
      fetchFn: async () => { throw new Error("offline"); }
    })).rejects.toThrow("읽을 수 없습니다");
    await expect(createLegacyGeminiAbandonment({
      ...common,
      fetchFn: mockCdp([], { Browser: "Chrome/151", "User-Agent": "Chrome/151" })
    })).rejects.toThrow("headless Chrome");
    await expect(createLegacyGeminiAbandonment({
      ...common,
      fetchFn: mockCdp([{ id: "live-conversation", type: "page", url: "https://gemini.google.com/app/live-conversation" }])
    })).rejects.toThrow("target이 남아");
    await expect(createLegacyGeminiAbandonment({
      ...common,
      fetchFn: mockCdp([{ id: "malformed-url", type: "page", url: "not a URL" }])
    })).rejects.toThrow("malformed");
    await expect(createLegacyGeminiAbandonment({
      ...common,
      fetchFn: mockCdp([{ type: "page", url: "https://gemini.google.com/app" }])
    })).rejects.toThrow("malformed");
    await expect(observeLegacyGeminiTargets({
      job: { ...TEST_JOB, geminiCdpUrl: "https://example.test:9444" },
      generation: value.generation,
      fetchFn: mockCdp()
    })).rejects.toThrow("세션 결속");
  });

  test("binds a protocol targetId to exactly one real /json/list id and only tolerates its stale root URL", async () => {
    const value = await fixture();
    const observe = (targets, allowedTargetIds = ["created-target"]) => observeLegacyGeminiTargets({
      job: { ...TEST_JOB, id: value.jobId },
      generation: value.generation,
      fetchFn: mockCdp(targets),
      allowedTargetIds,
      now: () => new Date("2026-08-12T13:00:00.000Z")
    });
    const realJsonListTarget = {
      description: "",
      devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1/devtools/page/created-target",
      id: "created-target",
      title: "Google Gemini",
      type: "page",
      url: "https://gemini.google.com/app",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/created-target"
    };

    await expect(observe([realJsonListTarget])).resolves.toMatchObject({
      authorizedTargetCount: 1,
      prohibitedTargetCount: 0,
      geminiRootTargetCount: 1
    });
    await expect(observe([{ ...realJsonListTarget, url: "https://gemini.google.com/videos?hl=ko" }])).resolves.toMatchObject({
      authorizedTargetCount: 1,
      prohibitedTargetCount: 0
    });
    await expect(observe([])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, id: "different-target" }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, id: undefined, targetId: "created-target" }])).rejects.toThrow("malformed");
    await expect(observe([{ ...realJsonListTarget, targetId: "different-target" }])).rejects.toThrow("malformed");
    await expect(observe([realJsonListTarget, { ...realJsonListTarget }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, type: "service_worker" }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, url: "https://example.test/videos" }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, url: "https://gemini.google.com/settings" }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, url: "https://gemini.google.com/app/current-conversation" }])).rejects.toThrow("정확히 결속");
    await expect(observe([{ ...realJsonListTarget, url: "https://gemini.google.com/videos/nested" }])).rejects.toThrow("정확히 결속");
    await expect(observe([
      realJsonListTarget,
      { id: "other-conversation", type: "page", url: "https://gemini.google.com/app/other-conversation" }
    ])).rejects.toThrow("target이 남아");
    await expect(observe([
      realJsonListTarget,
      { id: "other-generation", type: "page", url: "https://gemini.google.com/videos" }
    ])).rejects.toThrow("target이 남아");
  });

  test("re-attests immediately before a legacy-authorized fresh submit and blocks a late target", async () => {
    const value = await fixture();
    await createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "최초 관측 시 기존 Gemini target이 없었습니다.",
      assertNoLiveTarget: true,
      fetchFn: mockCdp(),
      now: () => new Date("2026-08-12T13:00:00.000Z")
    });
    const decision = await readLegacyGeminiAbandonmentDecision(value);
    const requestHash = `sha256:${"1".repeat(64)}`;
    const resumeRequestHash = `sha256:${"2".repeat(64)}`;
    const promptHash = `sha256:${"3".repeat(64)}`;
    const currentGeneration = {
      ...value.generation,
      schemaVersion: 4,
      runId: "current-run",
      request: { clipCount: 1 },
      requestHash,
      resumeRequestHash,
      pendingSegment: { index: 1, submissionRunId: "current-run", promptHash }
    };
    let submitCount = 0;
    const submitAfterGuard = async (fetchFn) => {
      const attestation = await attestLegacyGeminiAbandonmentConsumption({
        job: { ...TEST_JOB, id: value.jobId },
        generation: currentGeneration,
        abandonmentReceipt: decision.receipt,
        currentTargetId: "current-submit-target",
        runId: currentGeneration.runId,
        requestHash,
        resumeRequestHash,
        segmentIndex: 1,
        promptHash,
        fetchFn,
        now: () => new Date("2026-08-12T13:00:01.000Z")
      });
      submitCount += 1;
      return attestation;
    };

    await expect(submitAfterGuard(mockCdp([
      { id: "root", type: "page", url: "https://gemini.google.com/app" },
      { id: "late-legacy", type: "page", url: "https://gemini.google.com/app/late-legacy" },
      { id: "current-submit-target", type: "page", url: "https://gemini.google.com/videos" }
    ]))).rejects.toThrow("target이 남아");
    expect(submitCount).toBe(0);

    await expect(submitAfterGuard(mockCdp([
      { id: "root", type: "page", url: "https://gemini.google.com/app" }
    ]))).rejects.toThrow("정확히 결속");
    expect(submitCount).toBe(0);

    const staleRootAttestation = await submitAfterGuard(mockCdp([
      { id: "root", type: "page", url: "https://gemini.google.com/app" },
      { id: "current-submit-target", type: "page", url: "https://gemini.google.com/app" }
    ]));
    expect(staleRootAttestation.liveCdpObservation).toMatchObject({
      authorizedTargetCount: 1,
      prohibitedTargetCount: 0
    });
    expect(submitCount).toBe(1);

    const attestation = await submitAfterGuard(mockCdp([
      { id: "root", type: "page", url: "https://gemini.google.com/app" },
      { id: "current-submit-target", type: "page", url: "https://gemini.google.com/videos" }
    ]));
    expect(submitCount).toBe(2);
    expect(attestation.liveCdpObservation).toMatchObject({
      headless: true,
      prohibitedTargetCount: 0,
      authorizedTargetCount: 1
    });
    expect(validateLegacyGeminiAbandonmentConsumption({
      attestation,
      abandonmentReceipt: decision.receipt,
      generation: currentGeneration
    })).toBe(true);
    const mutated = structuredClone(attestation);
    mutated.liveCdpObservation.targetCount += 1;
    expect(validateLegacyGeminiAbandonmentConsumption({
      attestation: mutated,
      abandonmentReceipt: decision.receipt,
      generation: currentGeneration
    })).toBe(false);
    const requestMutated = structuredClone(attestation);
    requestMutated.requestHash = `sha256:${"9".repeat(64)}`;
    expect(validateLegacyGeminiAbandonmentConsumption({
      attestation: requestMutated,
      abandonmentReceipt: decision.receipt,
      generation: currentGeneration
    })).toBe(false);
  });

  test("rejects request and session mismatches before reading CDP or advancing toward a click", async () => {
    const value = await fixture();
    await createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "최초 관측 시 기존 Gemini target이 없었습니다.",
      assertNoLiveTarget: true,
      fetchFn: mockCdp()
    });
    const decision = await readLegacyGeminiAbandonmentDecision(value);
    const requestHash = `sha256:${"1".repeat(64)}`;
    const resumeRequestHash = `sha256:${"2".repeat(64)}`;
    const promptHash = `sha256:${"3".repeat(64)}`;
    const currentGeneration = {
      ...value.generation,
      schemaVersion: 4,
      runId: "current-run",
      request: { clipCount: 1 },
      requestHash,
      resumeRequestHash,
      pendingSegment: { index: 1, submissionRunId: "current-run", promptHash }
    };
    let cdpReads = 0;
    const fetchFn = async (...args) => {
      cdpReads += 1;
      return mockCdp()(...args);
    };
    const attest = (overrides = {}) => attestLegacyGeminiAbandonmentConsumption({
      job: { ...TEST_JOB, id: value.jobId },
      generation: currentGeneration,
      abandonmentReceipt: decision.receipt,
      currentTargetId: "current-submit-target",
      runId: currentGeneration.runId,
      requestHash,
      resumeRequestHash,
      segmentIndex: 1,
      promptHash,
      fetchFn,
      ...overrides
    });

    await expect(attest({ requestHash: `sha256:${"9".repeat(64)}` })).rejects.toThrow("job·요청·세션 결속");
    await expect(attest({ generation: { ...currentGeneration, sessionBindingHash: `sha256:${"8".repeat(64)}` } })).rejects.toThrow("job·요청·세션 결속");
    await expect(attest({ job: { ...TEST_JOB, id: "different-job" } })).rejects.toThrow("job·요청·세션 결속");
    await expect(attest({ currentTargetId: "" })).rejects.toThrow("target ID");
    expect(cdpReads).toBe(0);
  });

  test("preserves exact abandoned generation and receipt bytes before overwrite", async () => {
    const value = await fixture();
    const created = await createLegacyGeminiAbandonment({
      jobsDir: value.jobsDir,
      jobId: value.jobId,
      expectedGenerationSha256: value.generationSha256,
      reason: "legacy 원본과 관측 영수증을 보존합니다.",
      assertNoLiveTarget: true,
      fetchFn: mockCdp()
    });
    const evidence = await preserveLegacyGeminiAbandonmentEvidence(value);
    expect(evidence).toMatchObject({
      generationSha256: value.generationSha256,
      receiptHash: created.receipt.receiptHash
    });
    expect(sha256(await readFile(join(value.jobDir, evidence.generationPath)))).toBe(value.generationSha256);
    expect(sha256(await readFile(join(value.jobDir, evidence.receiptPath)))).toBe(evidence.receiptSha256);
  });

  test("does not require abandonment for a current recoverable checkpoint", () => {
    const current = { ...legacyGeneration(), schemaVersion: 4, status: "running", pendingSegment: { status: "ambiguous-submitted" } };
    expect(legacyGeminiGenerationNeedsAbandonment(current)).toBe(false);
    expect(validateLegacyGeminiAbandonment({ jobId: current.jobId, generation: current, generationSha256: null, receipt: null })).toEqual({
      required: false,
      allowed: true,
      receipt: null
    });
    expect(unsupportedLegacyGeminiFailure({ ...legacyGeneration(), segments: [{ index: 1 }] })).toBe(true);
  });
});
