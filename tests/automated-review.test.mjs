import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUTOMATED_REVIEW_ALGORITHM_VERSION,
  AUTOMATED_REVIEW_METHODS,
  analyzeAutomatedPanel,
  buildAutomatedCommitteeReview,
  qualityReviewFingerprint,
  readAutomatedReviewCheckpoint,
  runAutomatedQualityReview,
  validateAutomatedCommitteeReview
} from "../src/automated-review.mjs";
import {
  AHP_CRITERIA,
  canonicalJsonHash,
  committeeAttestationHash,
  committeeDecisionHash,
  committeeEvidenceHash,
  validateCommitteeReview
} from "../src/quality.mjs";
import { geminiSessionBindingHash } from "../src/provenance.mjs";
import { monitorStartupPlanTransition, resolveMonitorClipPlan, runSoftwareReview } from "../scripts/monitor-gemini-production.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const JOB_ID = "automated-review-job-001";
const RUN_ID = "automated-review-run-001";
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(revisionId = "revision-software-000001", sequence = 1) {
  return {
    schemaVersion: 2,
    jobId: JOB_ID,
    runId: RUN_ID,
    revisionId,
    sequence,
    baseManifest: { path: `runs/${RUN_ID}/manifest.json`, sha256: HASH_A, status: "needs-improvement" },
    baseQuality: { path: `runs/${RUN_ID}/artifacts/quality.json`, sha256: HASH_B },
    supersedes: sequence === 1
      ? {
          type: "base-run",
          path: `runs/${RUN_ID}/manifest.json`,
          sha256: HASH_A,
          sequence: 0,
          revisionId: null,
          effectiveStatus: "needs-improvement"
        }
      : {
          type: "quality-revision",
          path: `runs/${RUN_ID}/revisions/revision-software-${String(sequence - 1).padStart(6, "0")}/manifest.json`,
          sha256: `sha256:${"c".repeat(64)}`,
          sequence: sequence - 1,
          revisionId: `revision-software-${String(sequence - 1).padStart(6, "0")}`,
          effectiveStatus: "needs-improvement"
        }
  };
}

function criterionFixture(criterion, score = 100) {
  const factors = score === 100
    ? [{ id: `${criterion.id}-pass`, label: "measured", max: 100, pass: true }]
    : [
        { id: `${criterion.id}-pass`, label: "measured", max: score, pass: true },
        { id: `${criterion.id}-fail`, label: "missing", max: 100 - score, pass: false }
      ];
  return {
    id: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    autoScore: score,
    committeeScore: null,
    score,
    factors,
    blockers: []
  };
}

function qualityFixture(overrides = {}) {
  const evidenceHashes = overrides.evidenceHashes || { "final.mp4": HASH_A, "quality/frame-01.jpg": HASH_B };
  const metrics = {
    provider: "gemini-browser",
    semanticGateStateEligible: true,
    providerProof: true,
    providerGenerationProvenance: true,
    terminalRunBinding: true,
    terminalEventBinding: true,
    eventLogParsePass: true,
    immutableClosureBinding: true,
    immutableEvidenceBinding: true,
    inputDiversityBinding: true,
    inputManifestBinding: true,
    runManifestBinding: true,
    geminiRequestSessionBinding: true,
    benchmarkReceiptBinding: true,
    sourceQuality: true,
    sourceSetBinding: true,
    sourceContentBinding: true,
    researchStatusVerified: true,
    evidenceTextBindingVerified: true,
    claimEvidencePass: true,
    providerDecisionBinding: true,
    providerDecisionEventBinding: true,
    providerAttestationBinding: true,
    generationProvenance: true,
    generationClipBinding: true,
    evidenceFrames: [{ path: "quality/frame-01.jpg", sha256: HASH_B }],
    frameAudioCaption: { audioQc: { status: "measured" } },
    evidenceHashes,
    finalMedia: { width: 1080, height: 1920, duration: 20 }
  };
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    runId: RUN_ID,
    status: "needs-improvement",
    totalScore: 100,
    threshold: 98,
    semanticGate: false,
    blockers: [
      "5-method software reviewer payload 파일이 없습니다.",
      "시각 증거·미디어 규격: 대표 프레임에 대한 reviewer payload가 없습니다.",
      "콘텐츠 의미 품질은 자동 판정하지 않습니다. VLM 장면 관련성·번인 자막 OCR·ASR 정렬·사실 함의에 대한 사람 또는 별도 검증이 필요합니다."
    ],
    criteria: AHP_CRITERIA.map((criterion) => criterionFixture(criterion)),
    metrics,
    ...overrides,
    metrics: { ...metrics, ...(overrides.metrics || {}), evidenceHashes }
  };
}

function reverseObject(object) {
  return Object.fromEntries(Object.entries(object).reverse());
}

describe("deterministic non-human software review panel", () => {
  test("builds five unique revision-scoped software methods with canonical bindings", () => {
    const quality = qualityFixture();
    const revisionContext = context();
    const review = buildAutomatedCommitteeReview({
      jobId: JOB_ID,
      runId: RUN_ID,
      quality,
      evidenceHashes: reverseObject(quality.metrics.evidenceHashes),
      revisionContext
    });

    expect(review.type).toBe("deterministic-software-review");
    expect(review.human).toBe(false);
    expect(review.independentPrincipal).toBe(false);
    expect(review.reviewers).toHaveLength(5);
    expect(new Set(review.reviewers.map((entry) => entry.id)).size).toBe(5);
    expect(new Set(review.reviewers.map((entry) => entry.role)).size).toBe(5);
    expect(new Set(review.reviewers.map((entry) => entry.method)).size).toBe(5);
    expect(validateCommitteeReview(review)).toBe(true);
    expect(validateAutomatedCommitteeReview(review, { quality, revisionContext })).toBe(true);
    expect(review.decisionHash).toBe(committeeDecisionHash(review));
    expect(review.evidenceHash).toBe(committeeEvidenceHash(review.evidenceHashes));

    for (const reviewer of review.reviewers) {
      const attestation = reviewer.attestation;
      expect(reviewer.human).toBe(false);
      expect(reviewer.independentPrincipal).toBe(false);
      expect(reviewer.revisionId).toBe(revisionContext.revisionId);
      expect(reviewer.revisionSequence).toBe(revisionContext.sequence);
      expect(reviewer.implementationHash).toBe(attestation.implementationHash);
      expect(reviewer.inputHash).toBe(attestation.inputHash);
      expect(reviewer.outputHash).toBe(attestation.outputHash);
      expect(reviewer.methodResultHash).toBe(attestation.methodResultHash);
      expect(attestation.human).toBe(false);
      expect(attestation.independentPrincipal).toBe(false);
      expect(attestation.authority).toBe("software-method-not-human");
      expect(attestation.revisionId).toBe(revisionContext.revisionId);
      expect(attestation.revisionSequence).toBe(revisionContext.sequence);
      expect(attestation.evidenceHash).toBe(review.evidenceHash);
      expect(attestation.decisionHash).toBe(review.decisionHash);
      expect(attestation.implementationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(attestation.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(attestation.outputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(attestation.methodResultHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(reviewer.attestationHash).toBe(committeeAttestationHash(attestation));
    }
  });

  test("is deterministic across input ordering and creates fresh identities for a stale context", () => {
    const quality = qualityFixture();
    const firstContext = context();
    const first = buildAutomatedCommitteeReview({ jobId: JOB_ID, runId: RUN_ID, quality, evidenceHashes: quality.metrics.evidenceHashes, revisionContext: firstContext });
    const reorderedQuality = { ...quality, criteria: [...quality.criteria].reverse() };
    const reordered = buildAutomatedCommitteeReview({ jobId: JOB_ID, runId: RUN_ID, quality: reorderedQuality, evidenceHashes: reverseObject(quality.metrics.evidenceHashes), revisionContext: firstContext });
    expect(canonicalJsonHash(reordered)).toBe(canonicalJsonHash(first));

    const secondContext = context("revision-software-000002", 2);
    const second = buildAutomatedCommitteeReview({ jobId: JOB_ID, runId: RUN_ID, quality, evidenceHashes: quality.metrics.evidenceHashes, revisionContext: secondContext });
    expect(second.reviewers.map((entry) => entry.id)).not.toEqual(first.reviewers.map((entry) => entry.id));
    expect(second.reviewers.map((entry) => entry.attestationHash)).not.toEqual(first.reviewers.map((entry) => entry.attestationHash));
    expect(second.qualityFingerprint).toBe(first.qualityFingerprint);
  });

  test("never raises a machine score and fails closed on unknown blockers or gates", () => {
    const quality = qualityFixture({
      criteria: AHP_CRITERIA.map((criterion) => criterionFixture(criterion, criterion.id === "visualConsistency" ? 90 : 100))
    });
    const low = analyzeAutomatedPanel({ quality, evidenceHashes: quality.metrics.evidenceHashes, revisionContext: context() });
    expect(low.eligible).toBe(false);
    expect(low.reasons).toContain("projected-score-below-threshold");
    for (const criterion of quality.criteria) expect(low.scores[criterion.id].score).toBeLessThanOrEqual(criterion.autoScore);

    const unknownBlocker = qualityFixture({ blockers: ["manual factual correction required"] });
    expect(analyzeAutomatedPanel({ quality: unknownBlocker, evidenceHashes: unknownBlocker.metrics.evidenceHashes, revisionContext: context() }).reasons.some((reason) => reason.startsWith("unresolved-blocker:"))).toBe(true);
    const brokenGate = qualityFixture({ metrics: { immutableClosureBinding: false } });
    const brokenGateAnalysis = analyzeAutomatedPanel({ quality: brokenGate, evidenceHashes: brokenGate.metrics.evidenceHashes, revisionContext: context() });
    expect(brokenGateAnalysis.reasons).toContain("gate:immutableClosureBinding");
    expect(brokenGateAnalysis.scores.factSourceFit.score).toBe(0);

    const evidenceMismatch = analyzeAutomatedPanel({ quality, evidenceHashes: { ...quality.metrics.evidenceHashes, "final.mp4": HASH_B }, revisionContext: context() });
    expect(evidenceMismatch.reasons).toContain("evidence-set-mismatch");
  });

  test("detects method-result mutation and fingerprints only immutable automatic evidence", () => {
    const quality = qualityFixture();
    const revisionContext = context();
    const review = buildAutomatedCommitteeReview({ jobId: JOB_ID, runId: RUN_ID, quality, evidenceHashes: quality.metrics.evidenceHashes, revisionContext });
    review.methodResults[0].outputHash = HASH_A;
    expect(() => validateAutomatedCommitteeReview(review, { quality, revisionContext })).toThrow(/결정론적/);

    const withCommitteePresentation = {
      ...quality,
      criteria: quality.criteria.map((criterion) => ({ ...criterion, committeeScore: 99, score: 99 }))
    };
    expect(qualityReviewFingerprint({ quality: withCommitteePresentation, evidenceHashes: quality.metrics.evidenceHashes })).toBe(
      qualityReviewFingerprint({ quality, evidenceHashes: quality.metrics.evidenceHashes })
    );
    expect(qualityReviewFingerprint({ quality, evidenceHashes: { ...quality.metrics.evidenceHashes, "final.mp4": HASH_B } })).not.toBe(
      qualityReviewFingerprint({ quality, evidenceHashes: quality.metrics.evidenceHashes })
    );
  });
});

function temporaryCheckpointRoot() {
  const path = join(process.cwd(), "workspace", ".test-automated-review", randomUUID());
  temporaryRoots.push(path);
  return path;
}

function apiFixture({ submitMode = "success", submittedStatus = "passed", staleOnce = false } = {}) {
  const quality = qualityFixture();
  const contexts = [context("revision-software-000001", 1), context("revision-software-000002", 2)];
  const calls = [];
  const submissions = [];
  let prepareIndex = 0;
  let currentHistory = [];
  const api = async (path, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body });
    if (method === "GET" && path === `/api/jobs/${JOB_ID}`) return { id: JOB_ID, runId: RUN_ID, status: "needs-improvement", qualitySummary: {} };
    if (method === "GET" && path === `/api/jobs/${JOB_ID}/quality`) return quality;
    if (method === "GET" && path === `/api/jobs/${JOB_ID}/quality/history`) return { iterations: currentHistory };
    if (method === "POST" && path.endsWith("/quality/revisions/prepare")) {
      const revisionContext = contexts[Math.min(prepareIndex, contexts.length - 1)];
      prepareIndex += 1;
      return { revisionContext, evidenceHashes: quality.metrics.evidenceHashes, evidenceHash: committeeEvidenceHash(quality.metrics.evidenceHashes) };
    }
    if (method === "POST" && path.endsWith("/quality/revisions/submit")) {
      submissions.push(body);
      if (staleOnce && submissions.length === 1) {
        const error = new Error("400: 제출한 revisionContext가 현재 append-only head와 일치하지 않습니다.");
        error.status = 400;
        error.body = { error: error.message };
        throw error;
      }
      const submittedQuality = {
        ...quality,
        status: submittedStatus,
        semanticGate: submittedStatus === "passed",
        revisionId: body.revisionContext.revisionId,
        revisionSequence: body.revisionContext.sequence
      };
      if (submitMode !== "unknown-unsealed") currentHistory = [submittedQuality];
      if (submitMode === "lost-response") throw new Error("connection reset after response loss");
      if (submitMode === "unknown-unsealed") throw new Error("connection reset before known response");
      return {
        revision: { revisionId: body.revisionContext.revisionId, sequence: body.revisionContext.sequence, manifestPath: `manifest-${body.revisionContext.revisionId}` },
        quality: submittedQuality,
        job: { id: JOB_ID, runId: RUN_ID, status: submittedStatus === "passed" ? "completed" : "needs-improvement" }
      };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  if (submitMode === "unknown-unsealed") currentHistory = [];
  return { api, calls, submissions, quality, setHistory: (value) => { currentHistory = value; } };
}

describe("automated review checkpoint and submission recovery", () => {
  test("runs prepare, local validation and submit in order, sealing its checkpoint", async () => {
    const fixture = apiFixture();
    const checkpointRoot = temporaryCheckpointRoot();
    const transitions = [];
    const result = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      onTransition: async (transition) => transitions.push(transition.phase),
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(result.kind).toBe("completed");
    expect(fixture.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /api/jobs/${JOB_ID}`,
      `GET /api/jobs/${JOB_ID}/quality`,
      `POST /api/jobs/${JOB_ID}/quality/revisions/prepare`,
      `POST /api/jobs/${JOB_ID}/quality/revisions/submit`
    ]);
    expect(transitions).toEqual(["prepared", "submitting", "sealed_completed"]);
    expect(fixture.submissions[0].review.human).toBe(false);
    expect(validateCommitteeReview(fixture.submissions[0].review)).toBe(true);
  });

  test("regenerates every revision-scoped attestation once after a stale context", async () => {
    const fixture = apiFixture({ staleOnce: true });
    const result = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot: temporaryCheckpointRoot(),
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(result.kind).toBe("completed");
    expect(fixture.submissions).toHaveLength(2);
    expect(fixture.submissions[0].revisionContext.revisionId).not.toBe(fixture.submissions[1].revisionContext.revisionId);
    expect(fixture.submissions[0].review.reviewers.map((entry) => entry.id)).not.toEqual(fixture.submissions[1].review.reviewers.map((entry) => entry.id));
    expect(fixture.submissions[0].review.reviewers.map((entry) => entry.attestationHash)).not.toEqual(fixture.submissions[1].review.reviewers.map((entry) => entry.attestationHash));
  });

  test("rejects a prepare evidence set that differs from the locally recomputed quality set", async () => {
    const fixture = apiFixture();
    const api = async (path, options) => {
      const response = await fixture.api(path, options);
      if ((options?.method || "GET") === "POST" && path.endsWith("/quality/revisions/prepare")) {
        const evidenceHashes = { ...response.evidenceHashes, "final.mp4": HASH_B };
        return { ...response, evidenceHashes, evidenceHash: committeeEvidenceHash(evidenceHashes) };
      }
      return response;
    };
    await expect(runAutomatedQualityReview({
      jobId: JOB_ID,
      api,
      checkpointRoot: temporaryCheckpointRoot(),
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    })).rejects.toThrow(/로컬 품질 증거/);
    expect(fixture.submissions).toHaveLength(0);
  });

  test("reconciles a lost response from history and never blindly resubmits", async () => {
    const fixture = apiFixture({ submitMode: "lost-response" });
    const checkpointRoot = temporaryCheckpointRoot();
    const first = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(first.kind).toBe("completed");
    expect(fixture.submissions).toHaveLength(1);
    const second = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(second.kind).toBe("completed");
    expect(fixture.submissions).toHaveLength(1);
  });

  test("records an unknown submission and makes zero blind retries without history proof", async () => {
    const fixture = apiFixture({ submitMode: "unknown-unsealed" });
    fixture.setHistory([]);
    const checkpointRoot = temporaryCheckpointRoot();
    const first = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(first.kind).toBe("submission-unknown");
    expect(fixture.submissions).toHaveLength(1);
    const second = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });
    expect(second.kind).toBe("submission-unknown");
    expect(fixture.submissions).toHaveLength(1);
  });

  test("blocks reviewer churn for sealed needs-improvement on unchanged evidence", async () => {
    const fixture = apiFixture({ submittedStatus: "needs-improvement" });
    const checkpointRoot = temporaryCheckpointRoot();
    const first = await runAutomatedQualityReview({ jobId: JOB_ID, api: fixture.api, checkpointRoot, recoveryPollMs: 0, maxRecoveryPolls: 1 });
    expect(first.kind).toBe("needs-remediation");
    const second = await runAutomatedQualityReview({ jobId: JOB_ID, api: fixture.api, checkpointRoot, recoveryPollMs: 0, maxRecoveryPolls: 1 });
    expect(second.kind).toBe("needs-remediation");
    expect(fixture.submissions).toHaveLength(1);
  });

  test("fails closed on a corrupted checkpoint", async () => {
    const root = temporaryCheckpointRoot();
    const checkpointPath = join(root, "checkpoint.json");
    await mkdir(root, { recursive: true });
    await writeFile(checkpointPath, "{not-json");
    await expect(runAutomatedQualityReview({ jobId: JOB_ID, api: apiFixture().api, checkpointPath })).rejects.toThrow(/checkpoint/);
    await expect(readAutomatedReviewCheckpoint(checkpointPath)).rejects.toThrow(/checkpoint/);
  });

  test("fails closed when a valid checkpoint JSON is semantically mutated", async () => {
    const fixture = apiFixture({ submitMode: "unknown-unsealed" });
    const checkpointRoot = temporaryCheckpointRoot();
    await runAutomatedQualityReview({ jobId: JOB_ID, api: fixture.api, checkpointRoot, recoveryPollMs: 0, maxRecoveryPolls: 1 });
    const checkpointPath = join(checkpointRoot, JOB_ID, `${RUN_ID}.json`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.evidenceHash = HASH_B;
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
    await expect(readAutomatedReviewCheckpoint(checkpointPath)).rejects.toThrow(/checkpoint/);
  });
});

test("monitor defaults can request the observed two-clip single-profile run", async () => {
  expect(AUTOMATED_REVIEW_METHODS).toHaveLength(5);
  expect(AUTOMATED_REVIEW_ALGORITHM_VERSION).toBe("deterministic-evidence-panel/v1");
  expect(resolveMonitorClipPlan({})).toEqual({ clipCount: 2, targetDurationSec: 20 });
  expect(resolveMonitorClipPlan({ GEMINI_MONITOR_CLIP_COUNT: "12" })).toEqual({ clipCount: 12, targetDurationSec: 110 });
  expect(resolveMonitorClipPlan({ GEMINI_MONITOR_CLIP_COUNT: "1", GEMINI_MONITOR_TARGET_DURATION_SEC: "5" })).toEqual({ clipCount: 2, targetDurationSec: 20 });
});

test("monitor supersedes only a terminal incompatible legacy plan", () => {
  const configuredProfiles = [{
    id: "account-2",
    cdpUrl: "http://127.0.0.1:9233",
    profileDir: "/Users/example/.ps4-ai-video-studio/chrome-login-profile"
  }];
  const monitorState = {
    status: "quota-blocked",
    jobId: "legacy-eight-clip-job",
    runId: "legacy-run",
    profileId: "account-2",
    topic: "경복궁 박석",
    clipCount: 8,
    targetDurationSec: 78,
    attempts: 3
  };
  const job = {
    id: monitorState.jobId,
    runId: monitorState.runId,
    status: "failed",
    runStatus: "failed",
    provider: "gemini-browser",
    topic: monitorState.topic,
    clipCount: 8,
    targetDurationSec: 78,
    geminiSessionBindingHash: geminiSessionBindingHash({
      geminiCdpUrl: configuredProfiles[0].cdpUrl,
      geminiProfileDir: configuredProfiles[0].profileDir
    })
  };
  const desiredPlan = { topic: monitorState.topic, clipCount: 2, targetDurationSec: 20 };
  const transition = monitorStartupPlanTransition({ monitorState, job, desiredPlan, configuredProfiles });

  expect(transition.action).toBe("supersede");
  expect(transition.reasons).toEqual(["job-clip-count", "job-target-duration", "state-clip-count", "state-target-duration"]);
  expect(transition.reset).toMatchObject({
    jobId: null,
    runId: null,
    profileId: null,
    attempts: 0,
    clipCount: 2,
    targetDurationSec: 20
  });

  for (const status of ["running", "completed", "needs-improvement"]) {
    const preserved = monitorStartupPlanTransition({
      monitorState,
      job: { ...job, status, runStatus: status },
      desiredPlan,
      configuredProfiles
    });
    expect(preserved.action).toBe("preserve");
    expect(preserved.reset).toBeNull();
  }

  const profileChanged = monitorStartupPlanTransition({
    monitorState: { ...monitorState, clipCount: 2, targetDurationSec: 20 },
    job: { ...job, clipCount: 2, targetDurationSec: 20 },
    desiredPlan,
    configuredProfiles: [{ ...configuredProfiles[0], profileDir: `${configuredProfiles[0].profileDir}-new` }]
  });
  expect(profileChanged.action).toBe("supersede");
  expect(profileChanged.reasons).toEqual(["profile-binding"]);
});

test("monitor delegates needs-improvement review only to the local software runner", async () => {
  const events = [];
  let runnerInput = null;
  const quality = qualityFixture();
  const checkpointRoot = temporaryCheckpointRoot();
  const result = await runSoftwareReview({ id: JOB_ID, runId: RUN_ID }, quality, {
    checkpointRoot,
    apiClient: async () => { throw new Error("API should be owned by the injected runner in this test"); },
    persistEvent: async (event, details) => events.push({ event, details }),
    runner: async (input) => {
      runnerInput = input;
      await input.onTransition({ phase: "prepared", jobId: JOB_ID, runId: RUN_ID });
      return { kind: "preflight-blocked" };
    }
  });
  expect(result.kind).toBe("preflight-blocked");
  expect(runnerInput.jobId).toBe(JOB_ID);
  expect(runnerInput.checkpointPath).toContain(RUN_ID);
  expect(events[0]).toMatchObject({
    event: "automated_review_started",
    details: { reviewKind: "deterministic-software-methods", human: false, independentPrincipal: false }
  });
  expect(events[1]).toMatchObject({
    event: "automated_review_transition",
    details: { automatedReview: { phase: "prepared", human: false, independentPrincipal: false } }
  });
});
