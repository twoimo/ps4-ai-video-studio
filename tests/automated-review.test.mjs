import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTOMATED_REVIEW_ALGORITHM_VERSION,
  AUTOMATED_REVIEW_FILE_POLICY,
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
import { verifyStrictGeminiRecoverySourceReceipt } from "../src/gemini-submission-lineage.mjs";
import { writePrivateJson } from "../src/gemini-monitor-privacy.mjs";
import {
  classifyGeminiFailure,
  createMonitorJobInertFirst,
  isMonitorRuntimeDeadlineError,
  MONITOR_STUDIO_TOKEN_MAX_BYTES,
  inspectGeminiRetryResetLineage,
  MONITOR_API_RESPONSE_POLICY,
  monitorApiExchange,
  monitorApiExchangeWithStudioToken,
  monitorRuntimeSubwindow,
  monitorStartupPlanTransition,
  normalizeMonitorRuntimeBoundaryError,
  profileFailoverTransition,
  readStudioTokenStrict,
  readMonitorTerminalQuality,
  resolveMonitorClipPlan,
  resolveMonitorApiBase,
  resolveMonitorRuntimeWindow,
  retryLimitResetTransition,
  runSoftwareReview
} from "../scripts/monitor-gemini-production.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const JOB_ID = "automated-review-job-001";
const RUN_ID = "automated-review-run-001";
const temporaryRoots = [];

function exactProviderZeroGeneration() {
  const sessionBinding = {
    schemaVersion: 1,
    cdpOrigin: "http://127.0.0.1:9222",
    profileBasename: "monitor-profile",
    profilePathHash: HASH_A
  };
  const sessionBindingHash = canonicalJsonHash(sessionBinding);
  const runtimeProof = {
    schemaVersion: 1,
    method: "cdp-browser-get-command-line-and-version",
    sessionBindingHash,
    cdpOriginHash: canonicalJsonHash({ type: "gemini-cdp-origin", origin: sessionBinding.cdpOrigin }),
    profilePathHash: sessionBinding.profilePathHash,
    remoteDebuggingAddress: "127.0.0.1",
    remoteDebuggingPort: "9222",
    headless: true,
    headlessImplementation: "new",
    chromeMajor: 151,
    browserVersionHash: HASH_A,
    commandLineHash: HASH_B
  };
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: "HeadlessChrome/151.0",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    headlessRequested: true,
    chromeMajor: 151,
    headlessImplementation: "new",
    runtimeProof,
    runtimeProofHash: canonicalJsonHash(runtimeProof),
    fallbackUsed: false
  };
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const request = {
    provider: "gemini-browser",
    clipCount: 2,
    segments: [{ visualPrompt: "first" }, { visualPrompt: "second" }]
  };
  const scriptHash = HASH_A;
  const resumeScriptHash = HASH_B;
  const requestHash = canonicalJsonHash({ ...request, scriptHash });
  return {
    schemaVersion: 5,
    provider: "gemini-browser",
    jobId: "failed-job",
    runId: "failed-run",
    status: "failed",
    browser: providerAttestation.browser,
    startedAt: "2026-08-12T10:00:00.000Z",
    completedAt: "2026-08-12T10:01:00.000Z",
    promptReadinessFailure: null,
    request,
    requestHash,
    requestScriptHash: requestHash,
    scriptHash,
    resumeRequestHash: canonicalJsonHash({ ...request, scriptHash: resumeScriptHash }),
    resumeScriptHash,
    sessionBinding,
    sessionBindingHash,
    providerDecision,
    providerDecisionHash: canonicalJsonHash(providerDecision),
    providerAttestation,
    providerAttestationHash: canonicalJsonHash(providerAttestation),
    providerRequestSentThisRun: false,
    inheritedProviderSubmission: false,
    submissionRunIds: [],
    segments: [],
    pendingSegment: null,
    resumedFrom: null,
    resumedFromCompletedGeneration: null,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: []
  };
}

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
    inputMotionGate: { approvedProvider: true, enforced: true, enforcementPass: true },
    inputMotionGateBinding: true,
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

  test("allows a sealed pre-motion-gate base to append a re-evaluation but never ignores a declared failed gate", () => {
    const legacy = qualityFixture({ metrics: { inputMotionGate: null, inputMotionGateBinding: false, inputDiversityBinding: undefined } });
    const legacyAnalysis = analyzeAutomatedPanel({ quality: legacy, evidenceHashes: legacy.metrics.evidenceHashes, revisionContext: context() });
    expect(legacyAnalysis.reasons).not.toContain("gate:inputMotionGateBinding");
    expect(legacyAnalysis.reasons).not.toContain("gate:inputDiversityBinding");
    expect(legacyAnalysis.methodResults.find((result) => result.method === "provenance-recovery/v1")?.checks)
      .not.toContainEqual({ id: "input-motion-gate-binding", pass: false });

    const declaredFailure = qualityFixture({
      metrics: {
        inputMotionGate: { approvedProvider: true, enforced: true, enforcementPass: false },
        inputMotionGateBinding: false
      }
    });
    const failedAnalysis = analyzeAutomatedPanel({ quality: declaredFailure, evidenceHashes: declaredFailure.metrics.evidenceHashes, revisionContext: context() });
    expect(failedAnalysis.reasons).toContain("gate:inputMotionGateBinding");
    expect(failedAnalysis.methodResults.find((result) => result.method === "provenance-recovery/v1")?.checks)
      .toContainEqual({ id: "input-motion-gate-binding", pass: false });
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
  const path = join(tmpdir(), "ps4-ai-video-studio-automated-review", randomUUID());
  temporaryRoots.push(path);
  return path;
}

async function immutableFileSnapshot(path) {
  const [bytes, file, parent] = await Promise.all([
    readFile(path),
    stat(path, { bigint: true }),
    stat(dirname(path), { bigint: true })
  ]);
  return {
    bytes,
    file: {
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mode: file.mode,
      nlink: file.nlink,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs
    },
    parent: { mtimeNs: parent.mtimeNs, ctimeNs: parent.ctimeNs }
  };
}

async function strictCredentialInvariant(path) {
  const identity = await lstat(path, { bigint: true });
  return {
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
    mode: identity.mode,
    uid: identity.uid,
    gid: identity.gid,
    nlink: identity.nlink,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs,
    kind: identity.isFile() ? "file" : identity.isSymbolicLink() ? "symlink" : identity.isFIFO() ? "fifo" : "other",
    bytes: identity.isFile() ? await readFile(path) : null,
    linkTarget: identity.isSymbolicLink() ? await readlink(path) : null
  };
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
      `GET /api/jobs/${JOB_ID}`,
      `GET /api/jobs/${JOB_ID}/quality`,
      `POST /api/jobs/${JOB_ID}/quality/revisions/prepare`,
      `POST /api/jobs/${JOB_ID}/quality/revisions/submit`
    ]);
    expect(transitions).toEqual(["prepared", "submitting", "sealed_completed"]);
    expect(fixture.submissions[0].review.human).toBe(false);
    expect(validateCommitteeReview(fixture.submissions[0].review)).toBe(true);
  });

  test("serializes two concurrent reviews with one persistent lock and permits a later reacquire", async () => {
    const fixture = apiFixture();
    const checkpointRoot = temporaryCheckpointRoot();
    let initialJobArrivals = 0;
    let releaseJobBarrier;
    const jobBarrier = new Promise((resolveBarrier) => { releaseJobBarrier = resolveBarrier; });
    const api = async (path, options = {}) => {
      const response = await fixture.api(path, options);
      const method = options.method || "GET";
      if (method === "GET" && path === `/api/jobs/${JOB_ID}`) {
        initialJobArrivals += 1;
        if (initialJobArrivals === 2) releaseJobBarrier();
        if (initialJobArrivals <= 2) await jobBarrier;
      }
      if (method === "POST" && path.endsWith("/quality/revisions/prepare")) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      if (method === "POST" && path.endsWith("/quality/revisions/submit")) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      return response;
    };
    const transitions = [[], []];
    const calls = [0, 1].map((index) => runAutomatedQualityReview({
      jobId: JOB_ID,
      api,
      checkpointRoot,
      onTransition: async (transition) => transitions[index].push(transition.phase),
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    }));

    const outcomes = await Promise.allSettled(calls);

    expect(initialJobArrivals).toBeGreaterThanOrEqual(3);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejectedIndex = outcomes.findIndex((outcome) => outcome.status === "rejected");
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect(outcomes[rejectedIndex].reason).toMatchObject({ code: "AUTOMATED_REVIEW_LOCK_BUSY" });
    expect(transitions[rejectedIndex]).toEqual([]);
    expect(fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/quality/revisions/prepare"))).toHaveLength(1);
    expect(fixture.submissions).toHaveLength(1);
    const checkpointDir = join(checkpointRoot, JOB_ID);
    const journal = await readFile(join(checkpointDir, `${RUN_ID}.jsonl`), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(3);
    const lockPath = join(checkpointDir, `${RUN_ID}.lock`);
    const beforeReacquire = await immutableFileSnapshot(lockPath);
    expect(beforeReacquire.bytes.byteLength).toBe(AUTOMATED_REVIEW_FILE_POLICY.lockBytes);
    expect(beforeReacquire.file.nlink).toBe(1n);
    expect(beforeReacquire.file.mode & 0o777n).toBe(0o600n);

    const reacquired = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api: fixture.api,
      checkpointRoot,
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    });

    expect(reacquired.kind).toBe("completed");
    expect(fixture.submissions).toHaveLength(1);
    const afterReacquire = await immutableFileSnapshot(lockPath);
    expect({ bytes: afterReacquire.bytes, file: afterReacquire.file })
      .toEqual({ bytes: beforeReacquire.bytes, file: beforeReacquire.file });
  });

  test("re-reads the job under lock and refuses a changed run before quality, prepare, or submit", async () => {
    const fixture = apiFixture();
    let jobReads = 0;
    const api = async (path, options = {}) => {
      const response = await fixture.api(path, options);
      if ((options.method || "GET") === "GET" && path === `/api/jobs/${JOB_ID}`) {
        jobReads += 1;
        if (jobReads === 2) return { ...response, runId: "run-software-changed-000002" };
      }
      return response;
    };

    const error = await runAutomatedQualityReview({
      jobId: JOB_ID,
      api,
      checkpointRoot: temporaryCheckpointRoot(),
      recoveryPollMs: 0,
      maxRecoveryPolls: 1
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "AUTOMATED_REVIEW_JOB_CHANGED" });
    expect(jobReads).toBe(2);
    expect(fixture.calls.some((call) => call.path.endsWith("/quality"))).toBe(false);
    expect(fixture.calls.some((call) => call.path.endsWith("/quality/revisions/prepare"))).toBe(false);
    expect(fixture.submissions).toHaveLength(0);
  });

  test("rejects linked, nonempty, and oversized lock leaves without checkpoint or external mutation", async () => {
    for (const variant of ["symlink", "hardlink", "nonempty", "oversized"]) {
      const fixture = apiFixture();
      const checkpointRoot = temporaryCheckpointRoot();
      const checkpointDir = join(checkpointRoot, JOB_ID);
      const lockPath = join(checkpointDir, `${RUN_ID}.lock`);
      await mkdir(checkpointDir, { recursive: true });
      let protectedPath = lockPath;
      if (["symlink", "hardlink"].includes(variant)) {
        const externalDir = temporaryCheckpointRoot();
        protectedPath = join(externalDir, `${variant}-lock-sentinel`);
        await mkdir(externalDir, { recursive: true });
        await writeFile(protectedPath, Buffer.alloc(0), { mode: 0o600 });
        if (variant === "symlink") await symlink(protectedPath, lockPath);
        else await link(protectedPath, lockPath);
      } else {
        const bytes = variant === "nonempty" ? Buffer.from("lock-sentinel") : Buffer.alloc(1024 * 1024, 0x61);
        await writeFile(lockPath, bytes, { mode: 0o600 });
      }
      const before = await immutableFileSnapshot(protectedPath);

      const error = await runAutomatedQualityReview({
        jobId: JOB_ID,
        api: fixture.api,
        checkpointRoot,
        recoveryPollMs: 0,
        maxRecoveryPolls: 1
      }).catch((caught) => caught);

      expect(error).toMatchObject({ code: "AUTOMATED_REVIEW_LOCK_INVALID" });
      expect(fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/quality/revisions/prepare"))).toHaveLength(0);
      expect(fixture.submissions).toHaveLength(0);
      expect(await immutableFileSnapshot(protectedPath)).toEqual(before);
      expect(await stat(join(checkpointDir, `${RUN_ID}.json`)).catch(() => null)).toBeNull();
      expect(await stat(join(checkpointDir, `${RUN_ID}.jsonl`)).catch(() => null)).toBeNull();
    }
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

  test("rejects symlinked and hard-linked checkpoint leaves without reading or mutating external files", async () => {
    for (const linkKind of ["symlink", "hardlink"]) {
      const checkpointRoot = temporaryCheckpointRoot();
      const checkpointDir = join(checkpointRoot, JOB_ID);
      const checkpointPath = join(checkpointDir, `${RUN_ID}.json`);
      const externalDir = temporaryCheckpointRoot();
      const externalPath = join(externalDir, `${linkKind}-checkpoint.json`);
      await mkdir(checkpointDir, { recursive: true });
      await mkdir(externalDir, { recursive: true });
      await writeFile(externalPath, "external-checkpoint-sentinel");
      if (linkKind === "symlink") await symlink(externalPath, checkpointPath);
      else await link(externalPath, checkpointPath);
      const beforeBytes = await readFile(externalPath);
      const beforeFile = await stat(externalPath, { bigint: true });
      const beforeDirectory = await stat(externalDir, { bigint: true });

      await expect(runAutomatedQualityReview({
        jobId: JOB_ID,
        api: apiFixture().api,
        checkpointRoot
      })).rejects.toThrow(/checkpoint/);

      expect(await readFile(externalPath)).toEqual(beforeBytes);
      const afterFile = await stat(externalPath, { bigint: true });
      const afterDirectory = await stat(externalDir, { bigint: true });
      expect({ size: afterFile.size, mtimeNs: afterFile.mtimeNs, ctimeNs: afterFile.ctimeNs })
        .toEqual({ size: beforeFile.size, mtimeNs: beforeFile.mtimeNs, ctimeNs: beforeFile.ctimeNs });
      expect({ mtimeNs: afterDirectory.mtimeNs, ctimeNs: afterDirectory.ctimeNs })
        .toEqual({ mtimeNs: beforeDirectory.mtimeNs, ctimeNs: beforeDirectory.ctimeNs });
    }
  });

  test("rejects symlinked and hard-linked journals without appending to external files", async () => {
    for (const linkKind of ["symlink", "hardlink"]) {
      const fixture = apiFixture();
      const checkpointRoot = temporaryCheckpointRoot();
      const checkpointDir = join(checkpointRoot, JOB_ID);
      const journalPath = join(checkpointDir, `${RUN_ID}.jsonl`);
      const externalDir = temporaryCheckpointRoot();
      const externalPath = join(externalDir, `${linkKind}-journal.txt`);
      await mkdir(checkpointDir, { recursive: true });
      await mkdir(externalDir, { recursive: true });
      await writeFile(externalPath, "external-journal-sentinel\n");
      if (linkKind === "symlink") await symlink(externalPath, journalPath);
      else await link(externalPath, journalPath);
      const beforeBytes = await readFile(externalPath);
      const beforeFile = await stat(externalPath, { bigint: true });
      const beforeDirectory = await stat(externalDir, { bigint: true });

      await expect(runAutomatedQualityReview({
        jobId: JOB_ID,
        api: fixture.api,
        checkpointRoot
      })).rejects.toThrow();

      expect(fixture.submissions).toHaveLength(0);
      expect(await readFile(externalPath)).toEqual(beforeBytes);
      const afterFile = await stat(externalPath, { bigint: true });
      const afterDirectory = await stat(externalDir, { bigint: true });
      expect({ size: afterFile.size, mtimeNs: afterFile.mtimeNs, ctimeNs: afterFile.ctimeNs })
        .toEqual({ size: beforeFile.size, mtimeNs: beforeFile.mtimeNs, ctimeNs: beforeFile.ctimeNs });
      expect({ mtimeNs: afterDirectory.mtimeNs, ctimeNs: afterDirectory.ctimeNs })
        .toEqual({ mtimeNs: beforeDirectory.mtimeNs, ctimeNs: beforeDirectory.ctimeNs });
    }
  });

  test("rejects oversized and invalid UTF-8 checkpoints before JSON parsing", async () => {
    const checkpointRoot = temporaryCheckpointRoot();
    const checkpointDir = join(checkpointRoot, JOB_ID);
    const checkpointPath = join(checkpointDir, `${RUN_ID}.json`);
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(checkpointPath, Buffer.alloc(AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes + 1, 0x20));
    await expect(readAutomatedReviewCheckpoint(checkpointPath)).rejects.toThrow(/bounded|limit/);
    await writeFile(checkpointPath, Buffer.from([0xc3, 0x28]));
    await expect(readAutomatedReviewCheckpoint(checkpointPath)).rejects.toThrow(/checkpoint/);
  });

  test("rejects a symlinked checkpoint root and a noncanonical explicit path without mutating either target", async () => {
    const externalDir = temporaryCheckpointRoot();
    const linkedRoot = temporaryCheckpointRoot();
    await mkdir(externalDir, { recursive: true });
    await symlink(externalDir, linkedRoot);
    const beforeDirectory = await stat(externalDir, { bigint: true });
    await expect(runAutomatedQualityReview({
      jobId: JOB_ID,
      api: apiFixture().api,
      checkpointRoot: linkedRoot
    })).rejects.toThrow();
    const afterDirectory = await stat(externalDir, { bigint: true });
    expect({ mtimeNs: afterDirectory.mtimeNs, ctimeNs: afterDirectory.ctimeNs })
      .toEqual({ mtimeNs: beforeDirectory.mtimeNs, ctimeNs: beforeDirectory.ctimeNs });

    const invalidRoot = temporaryCheckpointRoot();
    const invalidPath = join(invalidRoot, "different-job", `${RUN_ID}.json`);
    await expect(runAutomatedQualityReview({
      jobId: JOB_ID,
      api: apiFixture().api,
      checkpointPath: invalidPath,
      checkpointRoot: invalidRoot
    })).rejects.toThrow(/canonical root\/job\/run\.json/);
    expect(await stat(invalidRoot).catch(() => null)).toBeNull();
  });
});

test("monitor defaults can request the observed two-clip single-profile run", async () => {
  expect(AUTOMATED_REVIEW_METHODS).toHaveLength(5);
  expect(AUTOMATED_REVIEW_ALGORITHM_VERSION).toBe("deterministic-evidence-panel/v1");
  expect(resolveMonitorClipPlan({})).toEqual({ clipCount: 2, targetDurationSec: 20 });
  expect(resolveMonitorClipPlan({ GEMINI_MONITOR_CLIP_COUNT: "12" })).toEqual({ clipCount: 12, targetDurationSec: 110 });
  expect(resolveMonitorClipPlan({ GEMINI_MONITOR_CLIP_COUNT: "1", GEMINI_MONITOR_TARGET_DURATION_SEC: "5" })).toEqual({ clipCount: 2, targetDurationSec: 20 });
});

test("monitor bearer token is restricted to an exact loopback API origin", () => {
  expect(resolveMonitorApiBase("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  expect(resolveMonitorApiBase("http://[::1]:3000")).toBe("http://[::1]:3000");
  for (const value of [
    "https://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.2:3000",
    "http://127.0.0.1:3000/path",
    "http://user:pass@127.0.0.1:3000",
    "https://example.com"
  ]) {
    expect(() => resolveMonitorApiBase(value)).toThrow(/loopback HTTP origin/);
  }
});

test("monitor reads only an exact private Studio token inode within the persisted deadline", async () => {
  const root = temporaryCheckpointRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tokenPath = join(root, "studio-token");
  const token = "t".repeat(MONITOR_STUDIO_TOKEN_MAX_BYTES);
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const before = await strictCredentialInvariant(tokenPath);

  expect(readStudioTokenStrict(tokenPath, { runtimeDeadlineMs: Date.now() + 60_000 })).toBe(token);
  expect(await strictCredentialInvariant(tokenPath)).toEqual(before);

  const exactPath = join(root, "studio-token-no-newline");
  const exactToken = "x".repeat(32);
  await writeFile(exactPath, exactToken, { mode: 0o600 });
  await chmod(exactPath, 0o600);
  expect(readStudioTokenStrict(exactPath, { runtimeDeadlineMs: Date.now() + 60_000 })).toBe(exactToken);

  const deadlinePath = join(root, "studio-token-deadline");
  await writeFile(deadlinePath, `${exactToken}\n`, { mode: 0o600 });
  await chmod(deadlinePath, 0o600);
  const deadlineBefore = await strictCredentialInvariant(deadlinePath);
  const deadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
  const observations = [deadlineMs - 1, deadlineMs];
  expect(() => readStudioTokenStrict(deadlinePath, {
    runtimeDeadlineMs: deadlineMs,
    now: () => observations.shift() ?? deadlineMs
  })).toThrow(/persisted runtime deadline/);
  expect(await strictCredentialInvariant(deadlinePath)).toEqual(deadlineBefore);
});

test("monitor rejects special, aliased, oversized, non-private, linked, and malformed token files without mutation", async () => {
  const root = temporaryCheckpointRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const deadline = () => Date.now() + 60_000;
  const expectRejectedUnchanged = async (path) => {
    const before = await strictCredentialInvariant(path);
    let error;
    try {
      readStudioTokenStrict(path, { runtimeDeadlineMs: deadline() });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("MONITOR_STUDIO_TOKEN_UNSAFE");
    expect(error?.message || "").not.toContain(path);
    expect(await strictCredentialInvariant(path)).toEqual(before);
  };

  const oversizedPath = join(root, "oversized-token");
  await writeFile(oversizedPath, "o".repeat(MONITOR_STUDIO_TOKEN_MAX_BYTES + 2), { mode: 0o600 });
  await chmod(oversizedPath, 0o600);
  await expectRejectedUnchanged(oversizedPath);

  for (const [name, value] of [
    ["short-token", "q".repeat(31)],
    ["whitespace-token", `${"w".repeat(16)} ${"w".repeat(16)}`],
    ["double-newline-token", `${"n".repeat(32)}\n\n`]
  ]) {
    const path = join(root, name);
    await writeFile(path, value, { mode: 0o600 });
    await chmod(path, 0o600);
    await expectRejectedUnchanged(path);
  }

  const invalidUtf8Path = join(root, "invalid-utf8-token");
  await writeFile(invalidUtf8Path, Buffer.concat([Buffer.from("u".repeat(32)), Buffer.from([0xff])]), { mode: 0o600 });
  await chmod(invalidUtf8Path, 0o600);
  await expectRejectedUnchanged(invalidUtf8Path);

  const bomPath = join(root, "bom-token");
  await writeFile(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("b".repeat(32))]), { mode: 0o600 });
  await chmod(bomPath, 0o600);
  await expectRejectedUnchanged(bomPath);

  const publicModePath = join(root, "public-mode-token");
  await writeFile(publicModePath, "m".repeat(32), { mode: 0o644 });
  await chmod(publicModePath, 0o644);
  await expectRejectedUnchanged(publicModePath);

  const hardlinkSource = join(root, "hardlink-source");
  const hardlinkPath = join(root, "hardlink-token");
  await writeFile(hardlinkSource, "h".repeat(32), { mode: 0o600 });
  await chmod(hardlinkSource, 0o600);
  await link(hardlinkSource, hardlinkPath);
  const hardlinkSourceBefore = await strictCredentialInvariant(hardlinkSource);
  await expectRejectedUnchanged(hardlinkPath);
  expect(await strictCredentialInvariant(hardlinkSource)).toEqual(hardlinkSourceBefore);

  const symlinkTarget = join(root, "symlink-target");
  const symlinkPath = join(root, "symlink-token");
  await writeFile(symlinkTarget, "s".repeat(32), { mode: 0o600 });
  await chmod(symlinkTarget, 0o600);
  await symlink(symlinkTarget, symlinkPath);
  const symlinkTargetBefore = await strictCredentialInvariant(symlinkTarget);
  await expectRejectedUnchanged(symlinkPath);
  expect(await strictCredentialInvariant(symlinkTarget)).toEqual(symlinkTargetBefore);

  const actualAncestor = join(root, "actual-ancestor");
  const linkedAncestor = join(root, "linked-ancestor");
  await mkdir(actualAncestor, { mode: 0o700 });
  const ancestorToken = join(actualAncestor, "studio-token");
  await writeFile(ancestorToken, "a".repeat(32), { mode: 0o600 });
  await chmod(ancestorToken, 0o600);
  await symlink(actualAncestor, linkedAncestor);
  const ancestorBefore = await strictCredentialInvariant(ancestorToken);
  let ancestorError;
  try {
    readStudioTokenStrict(join(linkedAncestor, "studio-token"), { runtimeDeadlineMs: deadline() });
  } catch (caught) {
    ancestorError = caught;
  }
  expect(ancestorError?.code).toBe("MONITOR_STUDIO_TOKEN_UNSAFE");
  expect(await strictCredentialInvariant(ancestorToken)).toEqual(ancestorBefore);
  expect((await lstat(linkedAncestor)).isSymbolicLink()).toBe(true);

  const fifoPath = join(root, "fifo-token");
  const fifo = spawnSync("mkfifo", [fifoPath], { stdio: "pipe" });
  expect(fifo.status).toBe(0);
  await expectRejectedUnchanged(fifoPath);
});

test("monitor persists an inert job identity before it can start provider work", async () => {
  const events = [];
  const signals = [];
  const calls = [];
  const monitorState = { attempts: 0, jobId: null, profileId: null };
  const profile = { id: "account-1", cdpUrl: "http://127.0.0.1:9222", profileDir: "/Users/example/.ps4-ai-video-studio/profile" };
  const apiClient = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/jobs") {
      return { job: { id: JOB_ID, provider: "gemini-browser", status: "queued", runId: null } };
    }
    expect(events.at(-1)).toMatchObject({ event: "job_created", details: { jobId: JOB_ID } });
    return { job: { id: JOB_ID, provider: "gemini-browser", status: "running", runId: RUN_ID } };
  };

  const result = await createMonitorJobInertFirst({
    profile,
    monitorState,
    request: { topic: "결속된 주제", format: "vertical", clipCount: 2, targetDurationSec: 20, captions: true, voiceover: true, sources: [] },
    apiClient,
    persistEvent: async (event, details) => events.push({ event, details }),
    signalWriter: async (event, details) => signals.push({ event, details })
  });

  expect(calls.map((entry) => entry.path)).toEqual(["/api/jobs", `/api/jobs/${JOB_ID}/run`]);
  expect(JSON.parse(calls[0].options.body)).toMatchObject({ provider: "gemini-browser", autoStart: false });
  expect(monitorState).toMatchObject({ jobId: JOB_ID, profileId: "account-1" });
  expect(events.map((entry) => entry.event)).toEqual(["job_created", "job_resumed"]);
  expect(signals.map((entry) => entry.event)).toEqual(["production-staged", "production-started"]);
  expect(result).toMatchObject({ created: { id: JOB_ID, runId: null }, started: { runId: RUN_ID } });
});

test("monitor never starts a provider when inert job persistence fails", async () => {
  const calls = [];
  const monitorState = { attempts: 0, jobId: null, profileId: null };
  await expect(createMonitorJobInertFirst({
    profile: { id: "account-1", cdpUrl: "http://127.0.0.1:9222", profileDir: "/Users/example/.ps4-ai-video-studio/profile" },
    monitorState,
    request: { topic: "결속된 주제", format: "vertical", clipCount: 2, targetDurationSec: 20, captions: true, voiceover: true, sources: [] },
    apiClient: async (path) => {
      calls.push(path);
      return { job: { id: JOB_ID, provider: "gemini-browser", status: "queued", runId: null } };
    },
    persistEvent: async () => { throw new Error("durable monitor state unavailable"); },
    signalWriter: async () => {}
  })).rejects.toThrow(/durable monitor state unavailable/);
  expect(calls).toEqual(["/api/jobs"]);
});

test("monitor makes zero /run calls when durable staging fails at any power-loss boundary", async () => {
  for (const boundary of ["temp-sync", "rename", "parent-sync"]) {
    const calls = [];
    const monitorState = { attempts: 0, jobId: null, profileId: null };
    const persistEvent = async () => writePrivateJson(`/virtual/${boundary}/monitor.json`, monitorState, {
      mkdirFn: async () => {},
      chmodFn: async () => {},
      openFn: async (_path, flags) => flags === "wx"
        ? {
            writeFile: async () => {},
            chmod: async () => {},
            sync: async () => { if (boundary === "temp-sync") throw new Error(boundary); },
            close: async () => {}
          }
        : {
            sync: async () => { if (boundary === "parent-sync") throw new Error(boundary); },
            close: async () => {}
          },
      renameFn: async () => { if (boundary === "rename") throw new Error(boundary); },
      unlinkFn: async () => {},
      randomUUIDFn: () => boundary
    });
    await expect(createMonitorJobInertFirst({
      profile: { id: "account-1", cdpUrl: "http://127.0.0.1:9222", profileDir: "/Users/example/.ps4-ai-video-studio/profile" },
      monitorState,
      request: { topic: "결속된 주제", format: "vertical", clipCount: 2, targetDurationSec: 20, captions: true, voiceover: true, sources: [] },
      apiClient: async (path) => {
        calls.push(path);
        return { job: { id: JOB_ID, provider: "gemini-browser", status: "queued", runId: null } };
      },
      persistEvent,
      signalWriter: async () => {}
    })).rejects.toThrow(boundary);
    expect(calls).toEqual(["/api/jobs"]);
  }
});

test("monitor runtime deadline is anchored to the original start and never extended by restart", () => {
  const maxRuntimeMs = 60_000;
  const first = resolveMonitorRuntimeWindow({
    now: new Date("2026-08-12T12:00:00.000Z"),
    maxRuntimeMs
  });
  expect(first).toEqual({
    valid: true,
    resumed: false,
    expired: false,
    reason: null,
    source: "new",
    startedAt: "2026-08-12T12:00:00.000Z",
    deadlineAt: "2026-08-12T12:01:00.000Z",
    deadlineMs: Date.parse("2026-08-12T12:01:00.000Z")
  });

  const resumed = resolveMonitorRuntimeWindow({
    persistedState: {
      status: "monitoring",
      startedAt: first.startedAt,
      deadlineAt: first.deadlineAt
    },
    now: new Date("2026-08-12T12:00:45.000Z"),
    maxRuntimeMs
  });
  expect(resumed).toMatchObject({
    valid: true,
    resumed: true,
    expired: false,
    source: "persisted",
    startedAt: first.startedAt,
    deadlineAt: first.deadlineAt,
    deadlineMs: first.deadlineMs
  });

  const expired = resolveMonitorRuntimeWindow({
    persistedState: { status: "monitoring", startedAt: first.startedAt, deadlineAt: first.deadlineAt },
    now: new Date("2026-08-12T12:01:00.000Z"),
    maxRuntimeMs
  });
  expect(expired).toMatchObject({ valid: true, resumed: true, expired: true, reason: "runtime-expired", deadlineAt: first.deadlineAt });

  const terminal = resolveMonitorRuntimeWindow({
    persistedState: { status: "deadline-reached", startedAt: first.startedAt, deadlineAt: first.deadlineAt },
    now: new Date("2026-08-12T12:00:30.000Z"),
    maxRuntimeMs
  });
  expect(terminal).toMatchObject({ valid: true, expired: true, reason: "persisted-deadline-reached", deadlineAt: first.deadlineAt });
});

test("monitor runtime migration and corrupt boundaries fail closed without a fresh window", () => {
  const now = new Date("2026-08-12T12:00:45.000Z");
  const maxRuntimeMs = 60_000;
  const legacy = resolveMonitorRuntimeWindow({
    persistedState: { status: "monitoring", startedAt: "2026-08-12T12:00:00.000Z" },
    now,
    maxRuntimeMs
  });
  expect(legacy).toMatchObject({
    valid: true,
    expired: false,
    source: "derived-from-started-at",
    deadlineAt: "2026-08-12T12:01:00.000Z"
  });

  const clamped = resolveMonitorRuntimeWindow({
    persistedState: {
      status: "monitoring",
      startedAt: "2026-08-12T12:00:00.000Z",
      deadlineAt: "2026-08-12T12:10:00.000Z"
    },
    now,
    maxRuntimeMs
  });
  expect(clamped).toMatchObject({ source: "persisted-clamped", deadlineAt: "2026-08-12T12:01:00.000Z" });

  for (const persistedState of [
    { status: "monitoring", startedAt: "invalid" },
    { status: "monitoring", startedAt: "2026-08-12T12:01:00.000Z" },
    { status: "monitoring", startedAt: "2026-08-12T12:00:00.000Z", deadlineAt: "invalid" },
    { status: "monitoring", startedAt: "2026-08-12T12:00:00.000Z", deadlineAt: "2026-08-12T11:59:59.000Z" }
  ]) {
    const result = resolveMonitorRuntimeWindow({ persistedState, now, maxRuntimeMs });
    expect(result).toMatchObject({ valid: false, expired: true, source: "invalid", deadlineMs: now.getTime() });
  }
});

test("monitor runtime subwindows clamp quota, polling, retry, and catch waits to the persisted deadline", () => {
  const nowMs = Date.parse("2026-08-12T12:00:45.000Z");
  const runtimeDeadlineMs = Date.parse("2026-08-12T12:01:00.000Z");

  const quotaResetAfterDeadline = monitorRuntimeSubwindow({
    nowMs,
    runtimeDeadlineMs,
    requestedWaitMs: 10 * 60_000
  });
  expect(quotaResetAfterDeadline).toMatchObject({
    valid: true,
    expired: false,
    deadlineMs: runtimeDeadlineMs,
    remainingRuntimeMs: 15_000,
    remainingSubwindowMs: 15_000,
    waitMs: 15_000,
    nextCheckAt: "2026-08-12T12:01:00.000Z"
  });
  expect(Date.parse(quotaResetAfterDeadline.nextCheckAt)).toBeLessThanOrEqual(runtimeDeadlineMs);

  const pollWindow = monitorRuntimeSubwindow({
    nowMs,
    runtimeDeadlineMs,
    localDeadlineMs: nowMs + 10 * 60_000,
    requestedWaitMs: 10_000
  });
  expect(pollWindow).toMatchObject({ deadlineMs: runtimeDeadlineMs, waitMs: 10_000 });

  const localPollFirst = monitorRuntimeSubwindow({
    nowMs,
    runtimeDeadlineMs,
    localDeadlineMs: nowMs + 5_000,
    requestedWaitMs: 10_000
  });
  expect(localPollFirst).toMatchObject({ deadlineMs: nowMs + 5_000, waitMs: 5_000, nextCheckAt: "2026-08-12T12:00:50.000Z" });

  for (const requestedWaitMs of [300_000, 30_000]) {
    const retryOrCatch = monitorRuntimeSubwindow({ nowMs, runtimeDeadlineMs, requestedWaitMs });
    expect(retryOrCatch.waitMs).toBe(15_000);
    expect(retryOrCatch.nextCheckAt).toBe("2026-08-12T12:01:00.000Z");
  }

  expect(monitorRuntimeSubwindow({
    nowMs: runtimeDeadlineMs,
    runtimeDeadlineMs,
    requestedWaitMs: 30_000
  })).toMatchObject({ expired: true, waitMs: 0, nextCheckAt: "2026-08-12T12:01:00.000Z" });
});

test("monitor API deadline aborts a locally injected hanging fetch without leaking request secrets", async () => {
  let nowMs = Date.parse("2026-08-12T12:00:57.500Z");
  const runtimeDeadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
  const secretBody = "private-request-body-never-log";
  const secretToken = "private-studio-token-never-log";
  let scheduledDelayMs = null;
  let observedSignal = null;
  let cleared = false;

  const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    const rejectOnAbort = () => reject(options.signal.reason || new DOMException("aborted", "AbortError"));
    if (options.signal.aborted) rejectOnAbort();
    else options.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  const setTimeoutFn = (callback, delayMs) => {
    scheduledDelayMs = delayMs;
    queueMicrotask(() => {
      nowMs += delayMs;
      callback();
    });
    return 1;
  };
  const error = await monitorApiExchange(
    "http://127.0.0.1:3000/api/jobs",
    {
      method: "POST",
      headers: { authorization: `Bearer ${secretToken}` },
      body: secretBody
    },
    {
      runtimeDeadlineMs,
      fetchFn: hangingFetch,
      now: () => nowMs,
      setTimeoutFn,
      clearTimeoutFn: () => { cleared = true; }
    }
  ).catch((caught) => caught);

  expect(scheduledDelayMs).toBe(2_500);
  expect(nowMs).toBe(runtimeDeadlineMs);
  expect(observedSignal?.aborted).toBe(true);
  expect(cleared).toBe(true);
  expect(isMonitorRuntimeDeadlineError(error)).toBe(true);
  expect(error).toMatchObject({ name: "MonitorRuntimeDeadlineError", code: "MONITOR_RUNTIME_DEADLINE", deadlineAt: "2026-08-12T12:01:00.000Z" });
  expect(error.message).not.toContain(secretBody);
  expect(error.message).not.toContain(secretToken);
  expect(error.message).not.toContain("/api/jobs");
});

test("monitor API accepts only bounded fatal-UTF-8 JSON and returns a normal parsed response", async () => {
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const body = await monitorApiExchange("http://127.0.0.1:3000/api/health", {}, {
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    fetchFn: async () => new Response(JSON.stringify({ ok: true, status: "ready" }), {
      status: 200,
      headers: { "content-type": "Application/JSON; charset=\"UTF-8\"" }
    })
  });

  expect(body).toEqual({ ok: true, status: "ready" });
  expect(MONITOR_API_RESPONSE_POLICY).toEqual({
    maximumBytes: 256 * 1024,
    mediaType: "application/json",
    charset: "utf-8"
  });
});

test("monitor API rejects non-JSON content without reading or retaining its secret body", async () => {
  const secret = "private-html-dom-and-studio-token";
  let cancelled = false;
  let read = false;
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const error = await monitorApiExchange("http://127.0.0.1:3000/api/jobs", {}, {
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/html" : null },
      body: {
        cancel: () => { cancelled = true; },
        getReader: () => {
          read = true;
          return { read: async () => ({ done: false, value: Buffer.from(secret) }) };
        }
      }
    })
  }).catch((caught) => caught);

  expect(error).toMatchObject({
    name: "MonitorApiResponseError",
    code: "MONITOR_API_INVALID_CONTENT_TYPE",
    status: 200,
    bodyEvidence: {
      code: "monitor-api-invalid-content-type",
      byteLength: 0,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }
  });
  expect(cancelled).toBe(true);
  expect(read).toBe(false);
  expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(secret);
  expect(Object.hasOwn(error, "body")).toBe(false);
});

test("monitor API cancels a chunked no-length oversized error body and keeps only capped hash evidence", async () => {
  const secret = "oversized-provider-secret-never-echo";
  const chunks = [
    Buffer.alloc(MONITOR_API_RESPONSE_POLICY.maximumBytes, 0x61),
    Buffer.from(`x${secret}`)
  ];
  let index = 0;
  let cancelled = false;
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const error = await monitorApiExchange("http://127.0.0.1:3000/api/jobs", {}, {
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    fetchFn: async () => ({
      ok: false,
      status: 503,
      headers: {
        get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null
      },
      body: {
        getReader: () => ({
          read: async () => index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
          cancel: () => { cancelled = true; },
          releaseLock: () => {}
        })
      }
    })
  }).catch((caught) => caught);

  expect(error).toMatchObject({
    name: "MonitorApiResponseError",
    code: "MONITOR_API_RESPONSE_TOO_LARGE",
    status: 503,
    bodyEvidence: {
      code: "monitor-api-response-too-large",
      byteLength: MONITOR_API_RESPONSE_POLICY.maximumBytes + 1,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }
  });
  expect(cancelled).toBe(true);
  expect(Object.hasOwn(error, "body")).toBe(false);
  expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(secret);
});

test("monitor API rejects malformed and non-UTF-8 JSON with hash-only evidence", async () => {
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const cases = [
    { bytes: Buffer.from('{"secret":"private-malformed"'), code: "MONITOR_API_RESPONSE_INVALID_JSON", evidenceCode: "monitor-api-response-invalid-json", secret: "private-malformed" },
    { bytes: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), code: "MONITOR_API_RESPONSE_INVALID_UTF8", evidenceCode: "monitor-api-response-invalid-utf8", secret: "�" }
  ];

  for (const fixture of cases) {
    const error = await monitorApiExchange("http://127.0.0.1:3000/api/jobs", {}, {
      runtimeDeadlineMs: nowMs + 60_000,
      now: () => nowMs,
      fetchFn: async () => new Response(fixture.bytes, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      })
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: fixture.code,
      bodyEvidence: {
        code: fixture.evidenceCode,
        byteLength: fixture.bytes.byteLength,
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    });
    expect(Object.hasOwn(error, "body")).toBe(false);
    expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(fixture.secret);
  }
});

test("monitor API error JSON and a body-read deadline never echo response secrets", async () => {
  const secret = "private-error-json-never-persist";
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const httpError = await monitorApiExchange("http://127.0.0.1:3000/api/jobs", {}, {
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    fetchFn: async () => new Response(JSON.stringify({ error: secret }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  }).catch((caught) => caught);
  expect(httpError).toMatchObject({
    code: "MONITOR_API_HTTP_ERROR",
    status: 400,
    bodyEvidence: {
      code: "monitor-api-http-error",
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }
  });
  expect(Object.hasOwn(httpError, "body")).toBe(false);
  expect(JSON.stringify({ ...httpError, message: httpError.message, stack: httpError.stack })).not.toContain(secret);

  let deadlineNowMs = Date.parse("2026-08-12T12:00:57.500Z");
  const deadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
  let cancelled = false;
  const deadlineError = await monitorApiExchange("http://127.0.0.1:3000/api/jobs", {}, {
    runtimeDeadlineMs: deadlineMs,
    now: () => deadlineNowMs,
    setTimeoutFn: (callback, delayMs) => {
      queueMicrotask(() => {
        deadlineNowMs += delayMs;
        callback();
      });
      return 1;
    },
    clearTimeoutFn: () => {},
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => { cancelled = true; },
          releaseLock: () => {}
        })
      }
    })
  }).catch((caught) => caught);
  expect(isMonitorRuntimeDeadlineError(deadlineError)).toBe(true);
  expect(cancelled).toBe(true);
  expect(JSON.stringify({ ...deadlineError, message: deadlineError.message, stack: deadlineError.stack })).not.toContain(secret);
});

test("monitor reloads a rotated file token and retries one rejected exchange exactly once", async () => {
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const oldToken = "o".repeat(32);
  const newToken = "n".repeat(32);
  const reads = [oldToken, newToken];
  const authorizations = [];
  const result = await monitorApiExchangeWithStudioToken("http://127.0.0.1:3000/api/jobs", {
    headers: { origin: "http://127.0.0.1:3000" }
  }, {
    tokenPath: "/private/tmp/strict-token-fixture",
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    readTokenFn: () => reads.shift(),
    fetchFn: async (_url, options) => {
      authorizations.push(options.headers.authorization);
      const accepted = options.headers.authorization === `Bearer ${newToken}`;
      return new Response(JSON.stringify(accepted ? { ok: true } : { error: "forbidden" }), {
        status: accepted ? 200 : 403,
        headers: { "content-type": "application/json" }
      });
    }
  });
  expect(result).toEqual({ ok: true });
  expect(reads).toHaveLength(0);
  expect(authorizations).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
});

test("monitor does not retry an unchanged file token or reload an explicit environment token", async () => {
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const unchangedToken = "u".repeat(32);
  let fileReads = 0;
  let exchanges = 0;
  const rejected = await monitorApiExchangeWithStudioToken("http://127.0.0.1:3000/api/jobs", {}, {
    tokenPath: "/private/tmp/strict-token-fixture",
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    readTokenFn: () => {
      fileReads += 1;
      return unchangedToken;
    },
    exchangeFn: async () => {
      exchanges += 1;
      const error = new Error("fixed rejection");
      error.code = "MONITOR_API_HTTP_ERROR";
      error.status = 403;
      throw error;
    }
  }).catch((error) => error);
  expect(rejected).toMatchObject({ code: "MONITOR_API_HTTP_ERROR", status: 403 });
  expect(fileReads).toBe(2);
  expect(exchanges).toBe(1);

  const explicitToken = "e".repeat(32);
  let explicitReads = 0;
  exchanges = 0;
  await expect(monitorApiExchangeWithStudioToken("http://127.0.0.1:3000/api/jobs", {}, {
    configuredToken: explicitToken,
    tokenPath: "/private/tmp/must-not-be-read",
    runtimeDeadlineMs: nowMs + 60_000,
    now: () => nowMs,
    readTokenFn: () => {
      explicitReads += 1;
      return "x".repeat(32);
    },
    exchangeFn: async (_url, options) => {
      exchanges += 1;
      expect(options.headers.authorization).toBe(`Bearer ${explicitToken}`);
      const error = new Error("fixed rejection");
      error.code = "MONITOR_API_HTTP_ERROR";
      error.status = 403;
      throw error;
    }
  })).rejects.toMatchObject({ code: "MONITOR_API_HTTP_ERROR", status: 403 });
  expect(explicitReads).toBe(0);
  expect(exchanges).toBe(1);
});

test("monitor never converts a transient startup response into terminal quality evidence", async () => {
  const unavailable = new Error("startup is not complete");
  unavailable.code = "MONITOR_API_HTTP_ERROR";
  unavailable.status = 503;
  let calls = 0;
  const rejected = await readMonitorTerminalQuality(async () => {
    calls += 1;
    throw unavailable;
  }, JOB_ID).catch((error) => error);
  expect(rejected).toBe(unavailable);
  expect(calls).toBe(1);

  await expect(readMonitorTerminalQuality(async () => ({ error: "not sealed" }), JOB_ID))
    .rejects.toThrow("terminal quality");
  const quality = { jobId: JOB_ID, runId: RUN_ID, status: "completed", semanticGate: true };
  expect(await readMonitorTerminalQuality(async (path) => {
    expect(path).toBe(`/api/jobs/${JOB_ID}/quality`);
    return quality;
  }, JOB_ID)).toBe(quality);
});

test("monitor maps a sanitized browser deadline to its terminal deadline-reached flow", () => {
  const runtimeDeadlineMs = Date.parse("2026-08-12T12:01:00.000Z");
  const browserError = Object.assign(new Error("private URL https://secret.example.test and request body"), {
    code: "GEMINI_BROWSER_DEADLINE"
  });
  const error = normalizeMonitorRuntimeBoundaryError(browserError, {
    runtimeDeadlineMs,
    nowMs: runtimeDeadlineMs - 1
  });

  expect(isMonitorRuntimeDeadlineError(error)).toBe(true);
  expect(error).toMatchObject({ code: "MONITOR_RUNTIME_DEADLINE", deadlineAt: "2026-08-12T12:01:00.000Z" });
  expect(error.message).not.toContain("secret.example.test");
  expect(error.message).not.toContain("request body");
});

test("monitor retry-limit transition authoritatively clears job-bound pointers", () => {
  expect(retryLimitResetTransition({
    monitorState: { jobId: "failed-job", runId: "failed-run", profileId: "account-1", attempts: 3 },
    error: "generation failed"
  })).toEqual({
    status: "monitoring",
    jobId: null,
    runId: null,
    profileId: null,
    attempts: 0,
    completion: null,
    failedJobId: "failed-job",
    lastError: "gemini-retry-limit-reached",
    nextAction: "create_new_job"
  });
});

test("monitor blocks cross-job retry when exact prior receipt has completed, pending, or submitted lineage", async () => {
  const monitorState = { jobId: "failed-job", runId: "failed-run", profileId: "account-1", attempts: 3 };
  let providerRequests = 0;
  for (const evidence of [
    { status: "completed", segments: [], pendingSegment: null, providerRequestSentThisRun: false, inheritedProviderSubmission: false, submissionRunIds: [] },
    { status: "failed", segments: [], pendingSegment: { index: 1 }, providerRequestSentThisRun: false, inheritedProviderSubmission: false, submissionRunIds: ["failed-run"] },
    { status: "failed", segments: [], pendingSegment: null, providerRequestSentThisRun: true, inheritedProviderSubmission: false, submissionRunIds: ["failed-run"] }
  ]) {
    const lineage = await inspectGeminiRetryResetLineage({
      monitorState,
      currentJob: { id: "failed-job", runId: "failed-run" },
      readReceipt: async () => ({
        generation: {
          schemaVersion: 5,
          provider: "gemini-browser",
          jobId: "failed-job",
          runId: "failed-run",
          legacySubmissionAbandonment: null,
          legacySubmissionAbandonmentEvidence: null,
          legacySubmissionAbandonmentConsumptions: [],
          ...evidence
        },
        snapshot: { bytes: 100, sha256: HASH_A, generationHash: HASH_B }
      })
    });
    expect(lineage.resetAllowed).toBe(false);
    if (lineage.resetAllowed) providerRequests += 1;
  }
  expect(providerRequests).toBe(0);
});

test("monitor resets only an exact schema-5 provider-zero receipt and treats missing, corrupt, foreign, or legacy receipts as blocked", async () => {
  const monitorState = { jobId: "failed-job", runId: "failed-run", profileId: "account-1", attempts: 3 };
  const currentJob = { id: "failed-job", runId: "failed-run" };
  const exactZero = exactProviderZeroGeneration();
  expect(verifyStrictGeminiRecoverySourceReceipt(exactZero)).toBe(true);
  const read = (generation) => async () => generation == null ? null : ({
    generation,
    snapshot: { bytes: 100, sha256: HASH_A, generationHash: HASH_B }
  });
  expect(await inspectGeminiRetryResetLineage({ monitorState, currentJob, readReceipt: read(exactZero) }))
    .toMatchObject({ resetAllowed: true, reason: "verified-provider-zero-receipt" });
  expect(await inspectGeminiRetryResetLineage({ monitorState, currentJob, readReceipt: read(null) }))
    .toMatchObject({ resetAllowed: false, reason: "prior-generation-receipt-missing" });
  expect(await inspectGeminiRetryResetLineage({ monitorState, currentJob, readReceipt: async () => { throw new Error("corrupt"); } }))
    .toMatchObject({ resetAllowed: false, reason: "prior-generation-receipt-invalid" });
  expect(await inspectGeminiRetryResetLineage({ monitorState, currentJob, readReceipt: read({ ...exactZero, jobId: "foreign-job" }) }))
    .toMatchObject({ resetAllowed: false, reason: "prior-generation-binding-mismatch" });
  expect(await inspectGeminiRetryResetLineage({ monitorState, currentJob, readReceipt: read({ ...exactZero, schemaVersion: 4 }) }))
    .toMatchObject({ resetAllowed: false, reason: "prior-provider-zero-contract-missing" });
});

test("monitor blocks parser-valid provider-zero-looking receipts with any recovery ancestry and sends provider requests zero times", async () => {
  const monitorState = { jobId: "failed-job", runId: "failed-run", profileId: "account-1", attempts: 3 };
  const currentJob = { id: "failed-job", runId: "failed-run" };
  const variants = [
    {
      evidenceKind: "recovery-attempt-lineage",
      mutate(generation) {
        generation.recoveryAttempts = [{
          attempt: 1,
          runId: "failed-run",
          submissionRunId: "source-run",
          startedAt: "2026-08-12T10:00:10.000Z",
          completedAt: "2026-08-12T10:00:20.000Z"
        }];
      }
    },
    {
      evidenceKind: "recovered-pending-lineage",
      mutate(generation) {
        generation.recoveredPendingSegments = [{ index: 1, sourceRunId: "source-run", recoveredAt: "2026-08-12T10:00:20.000Z" }];
      }
    },
    {
      evidenceKind: "rejected-resume-lineage",
      mutate(generation) {
        generation.rejectedResumes = [{ index: 1, reason: "prior recovery ancestry" }];
      }
    },
    {
      evidenceKind: "completed-generation-resume-lineage",
      mutate(generation) {
        generation.resumedFromCompletedGeneration = {
          sourceRunId: "source-run",
          sourceGenerationHash: HASH_A,
          resumedAt: "2026-08-12T10:00:20.000Z",
          providerRequestSent: false
        };
      }
    },
    {
      evidenceKind: "resumed-generation-lineage",
      mutate(generation) {
        generation.resumedFrom = "2026-08-12T09:59:00.000Z";
      }
    },
    {
      evidenceKind: "unexpected-recovery-source-lineage",
      mutate(generation) {
        generation.resultWaitPolicy = { recoverySourceRunId: "source-run", sourceGenerationHash: HASH_A };
      }
    }
  ];
  let providerRequests = 0;
  for (const variant of variants) {
    const generation = exactProviderZeroGeneration();
    variant.mutate(generation);
    expect(verifyStrictGeminiRecoverySourceReceipt(generation)).toBe(true);
    const lineage = await inspectGeminiRetryResetLineage({
      monitorState,
      currentJob,
      readReceipt: async () => ({
        generation,
        snapshot: { bytes: 100, sha256: HASH_A, generationHash: HASH_B }
      })
    });
    expect(lineage).toMatchObject({
      resetAllowed: false,
      reason: "prior-provider-lineage-present",
      evidenceKinds: expect.arrayContaining([variant.evidenceKind])
    });
    if (lineage.resetAllowed) providerRequests += 1;
  }
  expect(providerRequests).toBe(0);
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

test("monitor checkpoints an immutable failed run and creates only a new alternate-profile plan", () => {
  const monitorState = {
    status: "quota-blocked",
    jobId: "failed-job-account-1",
    runId: "immutable-run-account-1",
    profileId: "account-1",
    attempts: 2,
    completion: { stale: true },
    lastError: "quota exhausted"
  };
  const currentJob = {
    id: monitorState.jobId,
    runId: monitorState.runId,
    status: "failed",
    geminiSessionBindingHash: HASH_A
  };
  const observations = [
    { id: "account-1", available: false },
    { id: "account-2", available: true }
  ];
  const originalInputs = structuredClone({ monitorState, currentJob, observations });
  const transition = profileFailoverTransition({
    monitorState,
    currentJob,
    observations,
    reason: "quota-exhausted",
    checkpointedAt: "2026-08-12T11:20:00.000Z"
  });

  expect(transition).toEqual({
    action: "create-new-job",
    nextProfileId: "account-2",
    checkpoint: {
      checkpointedAt: "2026-08-12T11:20:00.000Z",
      reason: "quota-exhausted",
      jobId: "failed-job-account-1",
      runId: "immutable-run-account-1",
      profileId: "account-1",
      jobStatus: "failed",
      immutableRunBound: true,
      sessionBindingHash: HASH_A
    },
    reset: {
      status: "switching-profile",
      jobId: null,
      runId: null,
      profileId: "account-2",
      attempts: 0,
      completion: null,
      lastError: null
    }
  });
  expect({ monitorState, currentJob, observations }).toEqual(originalInputs);

  expect(profileFailoverTransition({
    monitorState,
    currentJob: { ...currentJob, status: "running" },
    observations
  })).toEqual({ action: "preserve", reason: "immutable-active-run" });
  expect(profileFailoverTransition({
    monitorState,
    currentJob,
    observations: observations.map((profile) => ({ ...profile, available: false }))
  })).toEqual({ action: "wait", reason: "no-alternate-profile" });
});

test("monitor classifies 9:16 output mismatches as non-retryable on the same profile", () => {
  expect(classifyGeminiFailure("Gemini가 세로 9:16 비율의 동영상을 반환하지 않았습니다.")).toEqual({
    kind: "non-retryable",
    code: "aspect-ratio-mismatch",
    retryableOnSameProfile: false,
    preferAlternateProfile: true
  });
  expect(classifyGeminiFailure("Gemini did not return a vertical 9:16 video.")).toMatchObject({
    kind: "non-retryable",
    retryableOnSameProfile: false
  });
  expect(classifyGeminiFailure("You're out of videos. Videos will be available again tomorrow.")).toMatchObject({
    kind: "quota-blocked",
    retryableOnSameProfile: true,
    preferAlternateProfile: true
  });
  expect(classifyGeminiFailure("download timed out")).toMatchObject({
    kind: "failed",
    retryableOnSameProfile: true,
    preferAlternateProfile: false
  });
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
