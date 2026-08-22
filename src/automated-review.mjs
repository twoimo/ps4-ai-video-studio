import { constants as fsConstants, openSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AHP_CRITERIA,
  canonicalJsonHash,
  committeeAttestationHash,
  committeeDecisionHash,
  committeeEvidenceHash,
  validateCommitteeReview
} from "./quality.mjs";
import { WORKSPACE_DIR } from "./pipeline.mjs";
import {
  appendFileAt,
  closeFd,
  createFileAt,
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  readFdBuffer,
  replaceFileAt,
  sameFdIdentity,
  statFd,
  syncFd,
  tryLockExclusive,
  unlock
} from "./dirfd.mjs";

export const AUTOMATED_REVIEW_ALGORITHM_VERSION = "deterministic-evidence-panel/v1";
export const AUTOMATED_REVIEW_PANEL_FAMILY_ID = "ps4-software-review-methods/v1";
export const AUTOMATED_REVIEW_CHECKPOINT_SCHEMA_VERSION = 1;
export const AUTOMATED_REVIEW_FILE_POLICY = Object.freeze({
  checkpointBytes: 4 * 1024 * 1024,
  journalBytes: 4 * 1024 * 1024,
  journalLineBytes: 16 * 1024,
  lockBytes: 0
});

export const AUTOMATED_REVIEW_METHODS = Object.freeze([
  Object.freeze({
    id: "structural-rubric/v1",
    role: "software-structure-check/v1",
    familyId: "structure-rules/v1",
    criterionIds: Object.freeze(["hookStory", "factSourceFit"])
  }),
  Object.freeze({
    id: "visual-evidence-presence/v1",
    role: "software-media-evidence-check/v1",
    familyId: "media-evidence-rules/v1",
    criterionIds: Object.freeze(["visualConsistency"])
  }),
  Object.freeze({
    id: "temporal-edit-reconciliation/v1",
    role: "software-timeline-check/v1",
    familyId: "timeline-rules/v1",
    criterionIds: Object.freeze(["editRhythm"])
  }),
  Object.freeze({
    id: "caption-audio-qc/v1",
    role: "software-caption-audio-check/v1",
    familyId: "caption-audio-rules/v1",
    criterionIds: Object.freeze(["captionsAudio"])
  }),
  Object.freeze({
    id: "provenance-recovery/v1",
    role: "software-provenance-check/v1",
    familyId: "provenance-rules/v1",
    criterionIds: Object.freeze(["factSourceFit", "automationRecovery"])
  })
]);

const REQUIRED_BOOLEAN_GATES = Object.freeze([
  "semanticGateStateEligible",
  "providerProof",
  "providerGenerationProvenance",
  "terminalRunBinding",
  "terminalEventBinding",
  "eventLogParsePass",
  "immutableClosureBinding",
  "immutableEvidenceBinding",
  "inputManifestBinding",
  "runManifestBinding",
  "geminiRequestSessionBinding",
  "benchmarkReceiptBinding",
  "sourceQuality",
  "sourceSetBinding",
  "sourceContentBinding",
  "researchStatusVerified",
  "evidenceTextBindingVerified",
  "claimEvidencePass"
]);

const RESOLVABLE_REVIEW_BLOCKERS = new Set([
  "5-method software reviewer payload 파일이 없습니다.",
  "시각 증거·미디어 규격: 대표 프레임에 대한 reviewer payload가 없습니다.",
  "콘텐츠 의미 품질은 자동 판정하지 않습니다. VLM 장면 관련성·번인 자막 OCR·ASR 정렬·사실 함의에 대한 사람 또는 별도 검증이 필요합니다."
]);

const DEFAULT_CHECKPOINT_ROOT = join(WORKSPACE_DIR, "automated-review");
const CHECKPOINT_PHASES = new Set([
  "prepared",
  "submitting",
  "submission_unknown",
  "submission_rejected",
  "sealed_completed",
  "sealed_needs_improvement",
  "preflight_blocked",
  "reconciliation_required"
]);

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCanonicalText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function normalizedEvidenceHashes(value) {
  if (!isPlainObject(value) || !Object.keys(value).length) throw new Error("자동 리뷰에는 비어 있지 않은 evidenceHashes가 필요합니다.");
  const entries = Object.entries(value).sort(([left], [right]) => compareCanonicalText(left, right));
  if (entries.some(([path, hash]) => !String(path).trim() || !/^sha256:[a-f0-9]{64}$/i.test(String(hash || "")))) {
    throw new Error("자동 리뷰 evidenceHashes의 경로 또는 SHA-256 형식이 유효하지 않습니다.");
  }
  return Object.fromEntries(entries.map(([path, hash]) => [path, String(hash).toLowerCase()]));
}

function normalizedFactors(criterion) {
  if (!Array.isArray(criterion?.factors) || !criterion.factors.length) throw new Error(`${criterion?.id || "unknown"} 기준의 기계 측정 factor가 없습니다.`);
  return criterion.factors.map((factor) => {
    const max = Number(factor?.max);
    if (!String(factor?.id || "").trim() || !Number.isFinite(max) || max <= 0 || typeof factor.pass !== "boolean") {
      throw new Error(`${criterion.id} 기준의 factor 선언이 유효하지 않습니다.`);
    }
    return { id: String(factor.id), max, pass: factor.pass };
  }).sort((left, right) => compareCanonicalText(left.id, right.id));
}

function recomputeFactorScore(criterion) {
  const factors = normalizedFactors(criterion);
  const possible = factors.reduce((sum, factor) => sum + factor.max, 0);
  const earned = factors.reduce((sum, factor) => sum + (factor.pass ? factor.max : 0), 0);
  return { factors, score: round(earned * 100 / possible) };
}

function criteriaState(quality) {
  if (!Array.isArray(quality?.criteria) || quality.criteria.length !== AHP_CRITERIA.length) throw new Error("자동 리뷰에는 여섯 개 AHP 기계 기준이 필요합니다.");
  const byId = new Map();
  for (const criterion of quality.criteria) {
    const expected = AHP_CRITERIA.find((entry) => entry.id === criterion?.id);
    const autoScore = Number(criterion?.autoScore);
    if (!expected || byId.has(criterion.id) || !Number.isFinite(autoScore) || autoScore < 0 || autoScore > 100) {
      throw new Error("자동 리뷰 AHP 기준 식별자 또는 autoScore가 유효하지 않습니다.");
    }
    const recomputed = recomputeFactorScore(criterion);
    if (Math.abs(autoScore - recomputed.score) > 0.11) throw new Error(`${criterion.id} autoScore가 기계 factor 재계산값과 일치하지 않습니다.`);
    byId.set(criterion.id, {
      id: criterion.id,
      weight: expected.weight,
      autoScore: round(autoScore),
      recomputedScore: recomputed.score,
      factors: recomputed.factors
    });
  }
  if (AHP_CRITERIA.some((criterion) => !byId.has(criterion.id))) throw new Error("자동 리뷰 AHP 기준 집합이 고정 스키마와 일치하지 않습니다.");
  return byId;
}

function metricSnapshot(metrics = {}) {
  return {
    provider: metrics.provider || null,
    technicalEvidenceGate: metrics.technicalEvidenceGate === true,
    contentSemanticsVerified: metrics.contentSemanticsVerified === true,
    ...Object.fromEntries(REQUIRED_BOOLEAN_GATES.map((key) => [key, metrics[key] === true])),
    providerDecisionBinding: metrics.providerDecisionBinding === true,
    providerDecisionEventBinding: metrics.providerDecisionEventBinding === true,
    providerAttestationBinding: metrics.providerAttestationBinding === true,
    generationProvenance: metrics.generationProvenance === true,
    generationClipBinding: metrics.generationClipBinding === true,
    localVideoModelBinding: metrics.localVideoModelBinding === true,
    localVideoRequestBinding: metrics.localVideoRequestBinding === true,
    localVideoClipBinding: metrics.localVideoClipBinding === true,
    localVideoReceiptBinding: metrics.localVideoReceiptBinding === true,
    inputMotionGateDeclared: Boolean(metrics.inputMotionGate),
    inputMotionGateBinding: metrics.inputMotionGateBinding === true,
    inputDiversityDeclared: Boolean(metrics.inputDiversityBinding !== undefined || metrics.inputMotionGate),
    inputDiversityBinding: metrics.inputDiversityBinding === true,
    evidenceFrameCount: Array.isArray(metrics.evidenceFrames) ? metrics.evidenceFrames.length : 0,
    evidenceFramesHash: canonicalJsonHash(Array.isArray(metrics.evidenceFrames) ? metrics.evidenceFrames : []),
    finalMediaPresent: Boolean(metrics.finalMedia),
    finalMediaHash: canonicalJsonHash(metrics.finalMedia || null),
    frameAudioCaptionPresent: Boolean(metrics.frameAudioCaption),
    frameAudioCaptionHash: canonicalJsonHash(metrics.frameAudioCaption || null),
    audioQcStatus: metrics.frameAudioCaption?.audioQc?.status || null,
    geminiSessionBindingHash: metrics.geminiSessionBindingHash || null,
    inputManifestHash: metrics.inputManifest?.sha256 || null
  };
}

function qualityFingerprintPayload({ quality, evidenceHashes, revisionContext = null }) {
  const criteria = [...criteriaState(quality).values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  const hashes = normalizedEvidenceHashes(evidenceHashes || quality?.metrics?.evidenceHashes);
  return {
    schemaVersion: 1,
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    jobId: quality?.jobId || null,
    runId: quality?.runId || null,
    threshold: Number(quality?.threshold),
    criteria,
    metrics: metricSnapshot(quality?.metrics),
    evidenceHashes: hashes
  };
}

export function qualityReviewFingerprint(input) {
  return canonicalJsonHash(qualityFingerprintPayload(input));
}

function methodImplementationHash(method) {
  return canonicalJsonHash({
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    panelFamilyId: AUTOMATED_REVIEW_PANEL_FAMILY_ID,
    familyId: method.familyId,
    method: method.id,
    role: method.role,
    criterionIds: method.criterionIds,
    scoring: "minimum-of-base-auto-factor-and-applicable-method/v1",
    human: false,
    independentPrincipal: false
  });
}

function methodChecks(method, metrics) {
  const checks = [];
  const add = (id, pass) => checks.push({ id, pass: pass === true });
  if (method.id === "structural-rubric/v1") {
    add("source-quality", metrics.sourceQuality);
    add("source-set-binding", metrics.sourceSetBinding);
    add("claim-evidence-binding", metrics.claimEvidencePass);
  } else if (method.id === "visual-evidence-presence/v1") {
    add("frame-analysis-present", Boolean(metrics.frameAudioCaption));
    add("evidence-frames-present", Array.isArray(metrics.evidenceFrames) && metrics.evidenceFrames.length > 0);
  } else if (method.id === "temporal-edit-reconciliation/v1") {
    add("final-media-present", Boolean(metrics.finalMedia));
    add("frame-analysis-present", Boolean(metrics.frameAudioCaption));
  } else if (method.id === "caption-audio-qc/v1") {
    add("frame-audio-caption-present", Boolean(metrics.frameAudioCaption));
    add("audio-qc-measured", metrics.frameAudioCaption?.audioQc?.status === "measured");
  } else if (method.id === "provenance-recovery/v1") {
    REQUIRED_BOOLEAN_GATES.filter((key) => !["semanticGateStateEligible"].includes(key)).forEach((key) => add(key, metrics[key]));
    if (metrics.inputMotionGate) add("input-motion-gate-binding", metrics.inputMotionGateBinding);
    if (metrics.inputDiversityBinding !== undefined || metrics.inputMotionGate) add("input-diversity-binding", metrics.inputDiversityBinding);
    add("provider-decision-binding", metrics.providerDecisionBinding);
    add("provider-decision-event-binding", metrics.providerDecisionEventBinding);
  }
  return checks.sort((left, right) => compareCanonicalText(left.id, right.id));
}

function methodCriterionScore(method, criterion, checks) {
  const base = Math.min(criterion.autoScore, criterion.recomputedScore);
  const hardGateIds = method.id === "structural-rubric/v1" && criterion.id === "factSourceFit"
    ? ["source-quality", "source-set-binding", "claim-evidence-binding"]
    : method.id === "visual-evidence-presence/v1"
      ? ["frame-analysis-present", "evidence-frames-present"]
      : method.id === "temporal-edit-reconciliation/v1"
        ? ["final-media-present", "frame-analysis-present"]
        : method.id === "caption-audio-qc/v1"
          ? ["frame-audio-caption-present", "audio-qc-measured"]
          : method.id === "provenance-recovery/v1"
            ? checks.map((check) => check.id)
            : [];
  const gatePass = hardGateIds.every((id) => checks.find((check) => check.id === id)?.pass === true);
  return gatePass ? round(base) : 0;
}

function buildMethodResult(method, quality, criteria, evidenceHash, revisionContext) {
  const metrics = quality.metrics || {};
  const selectedCriteria = method.criterionIds.map((id) => criteria.get(id));
  const checks = methodChecks(method, metrics);
  const input = {
    schemaVersion: 1,
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    familyId: method.familyId,
    method: method.id,
    jobId: quality.jobId,
    runId: quality.runId,
    revisionId: revisionContext.revisionId,
    revisionSequence: Number(revisionContext.sequence),
    evidenceHash,
    criteria: selectedCriteria,
    metrics: metricSnapshot(metrics)
  };
  const criterionScores = Object.fromEntries(selectedCriteria.map((criterion) => [criterion.id, methodCriterionScore(method, criterion, checks)]));
  const output = {
    schemaVersion: 1,
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    panelFamilyId: AUTOMATED_REVIEW_PANEL_FAMILY_ID,
    familyId: method.familyId,
    method: method.id,
    role: method.role,
    human: false,
    independentPrincipal: false,
    checks,
    criterionScores
  };
  const result = {
    ...output,
    implementationHash: methodImplementationHash(method),
    inputHash: canonicalJsonHash(input),
    outputHash: canonicalJsonHash(output)
  };
  return { ...result, methodResultHash: canonicalJsonHash(result) };
}

function blockerSet(quality) {
  return [...new Set([
    ...(Array.isArray(quality?.blockers) ? quality.blockers : []),
    ...(quality?.criteria || []).flatMap((criterion) => (criterion?.blockers || []).map((blocker) => `${criterion.label}: ${blocker}`))
  ].map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

export function analyzeAutomatedPanel({ quality, evidenceHashes, revisionContext }) {
  const reasons = [];
  if (!quality || !revisionContext) throw new Error("자동 리뷰 분석에는 quality와 revisionContext가 필요합니다.");
  if (quality.jobId !== revisionContext.jobId || quality.runId !== revisionContext.runId) reasons.push("quality-context-binding");
  if (quality.status !== "needs-improvement") reasons.push("quality-status");
  const normalizedHashes = normalizedEvidenceHashes(evidenceHashes);
  const qualityHashes = normalizedEvidenceHashes(quality.metrics?.evidenceHashes);
  const evidenceHash = committeeEvidenceHash(normalizedHashes);
  if (canonicalJsonHash(normalizedHashes) !== canonicalJsonHash(qualityHashes)) reasons.push("evidence-set-mismatch");
  const criteria = criteriaState(quality);
  const metrics = quality.metrics || {};
  if (!["gemini-browser", "local-video"].includes(metrics.provider)) reasons.push("provider-not-eligible");
  REQUIRED_BOOLEAN_GATES.forEach((key) => {
    if (metrics[key] !== true) reasons.push(`gate:${key}`);
  });
  if (metrics.inputMotionGate && metrics.inputMotionGateBinding !== true) reasons.push("gate:inputMotionGateBinding");
  if ((metrics.inputDiversityBinding !== undefined || metrics.inputMotionGate) && metrics.inputDiversityBinding !== true) reasons.push("gate:inputDiversityBinding");
  if (metrics.providerDecisionBinding !== true) reasons.push("gate:providerDecisionBinding");
  if (metrics.providerDecisionEventBinding !== true) reasons.push("gate:providerDecisionEventBinding");
  if (!metrics.frameAudioCaption) reasons.push("gate:frameAudioCaption");
  if (!Array.isArray(metrics.evidenceFrames) || metrics.evidenceFrames.length === 0) reasons.push("gate:evidenceFrames");
  if (metrics.provider === "gemini-browser" && (metrics.providerAttestationBinding !== true || metrics.generationProvenance !== true || metrics.generationClipBinding !== true)) reasons.push("gate:geminiGeneration");
  if (metrics.provider === "local-video" && (metrics.localVideoModelBinding !== true || metrics.localVideoRequestBinding !== true || metrics.localVideoClipBinding !== true || metrics.localVideoReceiptBinding !== true)) reasons.push("gate:localVideoGeneration");
  const unknownBlockers = blockerSet(quality).filter((blocker) => !RESOLVABLE_REVIEW_BLOCKERS.has(blocker));
  unknownBlockers.forEach((blocker) => reasons.push(`unresolved-blocker:${canonicalJsonHash(blocker)}`));

  const methodResults = AUTOMATED_REVIEW_METHODS.map((method) => buildMethodResult(method, quality, criteria, evidenceHash, revisionContext));
  const scores = {};
  for (const criterion of AHP_CRITERIA) {
    const base = criteria.get(criterion.id);
    const owners = methodResults.filter((result) => Object.hasOwn(result.criterionScores, criterion.id));
    if (!owners.length) throw new Error(`${criterion.id} 기준에 적용할 소프트웨어 방법이 없습니다.`);
    const score = round(Math.min(base.autoScore, ...owners.map((result) => result.criterionScores[criterion.id])));
    scores[criterion.id] = {
      score,
      evidence: `software-method-min/v1:${owners.map((result) => `${result.method}=${result.methodResultHash}`).sort().join(";")}`
    };
  }
  const projectedTotalScore = round(AHP_CRITERIA.reduce((sum, criterion) => sum + scores[criterion.id].score * criterion.weight / 100, 0));
  const threshold = Number(quality.threshold);
  if (!Number.isFinite(threshold) || projectedTotalScore < threshold) reasons.push("projected-score-below-threshold");
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    evidenceHash,
    evidenceHashes: normalizedHashes,
    qualityFingerprint: qualityReviewFingerprint({ quality, evidenceHashes: normalizedHashes, revisionContext }),
    projectedTotalScore,
    threshold,
    methodResults,
    scores
  };
}

function reviewerId(method, result, revisionContext) {
  const slug = method.id.split("/")[0].replace(/[^a-z0-9]+/g, "-");
  const digest = canonicalJsonHash({
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    method: method.id,
    methodResultHash: result.methodResultHash,
    jobId: revisionContext.jobId,
    runId: revisionContext.runId,
    revisionId: revisionContext.revisionId,
    revisionSequence: Number(revisionContext.sequence)
  }).slice("sha256:".length, "sha256:".length + 20);
  return `software-${slug}-${digest}`;
}

function constructAutomatedCommitteeReview({ jobId, runId, quality, evidenceHashes, revisionContext }) {
  if (jobId !== revisionContext?.jobId || runId !== revisionContext?.runId || quality?.jobId !== jobId || quality?.runId !== runId) {
    throw new Error("자동 리뷰 jobId·runId가 revision context와 일치하지 않습니다.");
  }
  const analysis = analyzeAutomatedPanel({ quality, evidenceHashes, revisionContext });
  if (!analysis.eligible) throw new Error(`자동 리뷰 사전 검사가 닫혔습니다: ${analysis.reasons.join(", ")}`);
  const panelMethodSetHash = canonicalJsonHash(analysis.methodResults.map((result) => ({
    method: result.method,
    role: result.role,
    familyId: result.familyId,
    implementationHash: result.implementationHash,
    inputHash: result.inputHash,
    outputHash: result.outputHash,
    methodResultHash: result.methodResultHash
  })));
  const review = {
    schemaVersion: 2,
    type: "deterministic-software-review",
    human: false,
    independentPrincipal: false,
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    panelFamilyId: AUTOMATED_REVIEW_PANEL_FAMILY_ID,
    panelMethodSetHash,
    qualityFingerprint: analysis.qualityFingerprint,
    projectedTotalScore: analysis.projectedTotalScore,
    jobId,
    runId,
    revisionId: revisionContext.revisionId,
    revisionSequence: Number(revisionContext.sequence),
    evidenceHashes: analysis.evidenceHashes,
    evidenceHash: analysis.evidenceHash,
    scores: analysis.scores,
    methodResults: analysis.methodResults,
    reviewers: []
  };
  review.decisionHash = committeeDecisionHash(review);
  review.reviewers = AUTOMATED_REVIEW_METHODS.map((method) => {
    const result = analysis.methodResults.find((entry) => entry.method === method.id);
    const id = reviewerId(method, result, revisionContext);
    const attestation = {
      schemaVersion: 1,
      type: "deterministic-software-method-attestation",
      human: false,
      independentPrincipal: false,
      authority: "software-method-not-human",
      algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
      panelFamilyId: AUTOMATED_REVIEW_PANEL_FAMILY_ID,
      methodFamilyId: method.familyId,
      panelMethodSetHash,
      implementationHash: result.implementationHash,
      inputHash: result.inputHash,
      outputHash: result.outputHash,
      methodResultHash: result.methodResultHash,
      reviewerId: id,
      role: method.role,
      method: method.id,
      jobId,
      runId,
      revisionId: revisionContext.revisionId,
      revisionSequence: Number(revisionContext.sequence),
      evidenceHash: analysis.evidenceHash,
      decisionHash: review.decisionHash
    };
    return {
      id,
      role: method.role,
      method: method.id,
      human: false,
      independentPrincipal: false,
      panelFamilyId: AUTOMATED_REVIEW_PANEL_FAMILY_ID,
      methodFamilyId: method.familyId,
      revisionId: revisionContext.revisionId,
      revisionSequence: Number(revisionContext.sequence),
      implementationHash: result.implementationHash,
      inputHash: result.inputHash,
      outputHash: result.outputHash,
      methodResultHash: result.methodResultHash,
      attestation,
      attestationHash: committeeAttestationHash(attestation)
    };
  });
  return review;
}

export function validateAutomatedCommitteeReview(review, { quality, revisionContext } = {}) {
  validateCommitteeReview(review, {
    expectedJobId: revisionContext?.jobId,
    expectedRunId: revisionContext?.runId,
    expectedEvidenceHashes: quality?.metrics?.evidenceHashes
  });
  const expected = constructAutomatedCommitteeReview({
    jobId: revisionContext.jobId,
    runId: revisionContext.runId,
    quality,
    evidenceHashes: review.evidenceHashes,
    revisionContext
  });
  if (canonicalJsonHash(review) !== canonicalJsonHash(expected)) throw new Error("자동 리뷰 payload가 결정론적 소프트웨어 방법 출력과 일치하지 않습니다.");
  return true;
}

export function buildAutomatedCommitteeReview(input) {
  const review = constructAutomatedCommitteeReview(input);
  validateAutomatedCommitteeReview(review, { quality: input.quality, revisionContext: input.revisionContext });
  return review;
}

function safePathSegment(value, label) {
  const segment = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,160}$/.test(segment)) throw new Error(`${label}가 checkpoint 경로에 사용할 수 없는 형식입니다.`);
  return segment;
}

function canonicalCheckpointPath(value) {
  let path = resolve(String(value || ""));
  // macOS exposes these fixed system aliases as symlinks. Normalize only the
  // OS aliases; every user-controlled ancestry component is still traversed
  // with O_NOFOLLOW below.
  if (process.platform === "darwin") {
    if (path === "/var" || path.startsWith("/var/")) path = `/private${path}`;
    else if (path === "/tmp" || path.startsWith("/tmp/")) path = `/private${path}`;
  }
  return path;
}

export function automatedReviewCheckpointPath(jobId, runId, root = DEFAULT_CHECKPOINT_ROOT) {
  return join(canonicalCheckpointPath(root), safePathSegment(jobId, "jobId"), `${safePathSegment(runId, "runId")}.json`);
}

function closePinnedDirectories(pinned) {
  for (const directory of [...(pinned?.directories || [])].reverse()) {
    try { closeFd(directory.fd); } catch {}
  }
}

function pinCheckpointDirectory(path, { create = false } = {}) {
  const target = canonicalCheckpointPath(path);
  if (target === "/") throw new Error("자동 리뷰 checkpoint root로 filesystem root를 사용할 수 없습니다.");
  const segments = target.split("/").filter(Boolean);
  const directories = [];
  let currentFd = openSync(
    "/",
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    directories.push({ segment: null, fd: currentFd, identity: statFd(currentFd) });
    for (const segment of segments) {
      let nextFd;
      try {
        nextFd = openDirectoryAt(currentFd, segment);
      } catch (error) {
        if (!create || error?.code !== "ENOENT") throw error;
        mkdirAt(currentFd, segment, 0o700);
        syncFd(currentFd);
        nextFd = openDirectoryAt(currentFd, segment);
      }
      const identity = statFd(nextFd);
      if (!identity.isDirectory()) {
        closeFd(nextFd);
        throw new Error("자동 리뷰 checkpoint ancestry가 directory가 아닙니다.");
      }
      directories.push({ segment, fd: nextFd, identity });
      currentFd = nextFd;
    }
    return { target, segments, directories, fd: currentFd, identity: directories.at(-1).identity };
  } catch (error) {
    closePinnedDirectories({ directories });
    throw error;
  }
}

function assertCheckpointDirectoryPinned(pinned) {
  let currentFd = openSync(
    "/",
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    if (!sameFdIdentity(pinned.directories[0].identity, statFd(currentFd))) {
      throw new Error("자동 리뷰 checkpoint filesystem root가 교체되었습니다.");
    }
    for (let index = 0; index < pinned.segments.length; index += 1) {
      const nextFd = openDirectoryAt(currentFd, pinned.segments[index]);
      closeFd(currentFd);
      currentFd = nextFd;
      if (!sameFdIdentity(pinned.directories[index + 1].identity, statFd(currentFd))) {
        throw new Error("자동 리뷰 checkpoint ancestry가 작업 중 교체되었습니다.");
      }
    }
  } finally {
    closeFd(currentFd);
  }
}

function pinAutomatedReviewBoundary(jobId, runId, checkpointRoot, { create = false } = {}) {
  const safeJobId = safePathSegment(jobId, "jobId");
  const safeRunId = safePathSegment(runId, "runId");
  const root = pinCheckpointDirectory(checkpointRoot, { create });
  let jobFd = null;
  try {
    try {
      jobFd = openDirectoryAt(root.fd, safeJobId);
    } catch (error) {
      if (!create || error?.code !== "ENOENT") throw error;
      mkdirAt(root.fd, safeJobId, 0o700);
      syncFd(root.fd);
      jobFd = openDirectoryAt(root.fd, safeJobId);
    }
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("자동 리뷰 checkpoint job entry가 directory가 아닙니다.");
    const name = `${safeRunId}.json`;
    return {
      root,
      jobId: safeJobId,
      runId: safeRunId,
      jobFd,
      jobIdentity,
      name,
      journalName: `${safeRunId}.jsonl`,
      lockName: `${safeRunId}.lock`,
      path: join(root.target, safeJobId, name)
    };
  } catch (error) {
    if (jobFd !== null) closeFd(jobFd);
    closePinnedDirectories(root);
    throw error;
  }
}

function closeAutomatedReviewBoundary(boundary) {
  if (boundary?.jobFd !== null && boundary?.jobFd !== undefined) {
    try { closeFd(boundary.jobFd); } catch {}
  }
  closePinnedDirectories(boundary?.root);
}

function assertAutomatedReviewBoundaryPinned(boundary) {
  assertCheckpointDirectoryPinned(boundary.root);
  const currentJobFd = openDirectoryAt(boundary.root.fd, boundary.jobId);
  try {
    if (!sameFdIdentity(boundary.jobIdentity, statFd(currentJobFd))) {
      throw new Error("자동 리뷰 checkpoint job directory가 작업 중 교체되었습니다.");
    }
  } finally {
    closeFd(currentJobFd);
  }
}

function automatedReviewLockError(message, code = "AUTOMATED_REVIEW_LOCK_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function acquireAutomatedReviewLock(boundary) {
  let lockFd = null;
  let acquired = false;
  try {
    assertAutomatedReviewBoundaryPinned(boundary);
    try {
      lockFd = createFileAt(boundary.jobFd, boundary.lockName, fsConstants.O_RDWR, 0o600, {
        initialBytes: Buffer.alloc(0)
      });
      syncFd(boundary.jobFd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      lockFd = openFileAt(boundary.jobFd, boundary.lockName, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    }
    const before = statFd(lockFd);
    if (!before.isFile() || before.nlink !== 1n || before.size !== 0n || (before.mode & 0o777n) !== 0o600n) {
      throw automatedReviewLockError("자동 리뷰 lock은 비어 있는 single-link regular file이어야 합니다.");
    }
    if (!tryLockExclusive(lockFd)) {
      throw automatedReviewLockError("동일 job/run의 자동 리뷰가 이미 실행 중입니다.", "AUTOMATED_REVIEW_LOCK_BUSY");
    }
    acquired = true;
    const locked = statFd(lockFd);
    if (!locked.isFile() || locked.nlink !== 1n || locked.size !== 0n || (locked.mode & 0o777n) !== 0o600n || !sameCheckpointFileSnapshot(before, locked)) {
      throw automatedReviewLockError("자동 리뷰 lock inode가 획득 중 변경되었습니다.");
    }
    assertAutomatedReviewBoundaryPinned(boundary);
    const currentFd = openFileAt(boundary.jobFd, boundary.lockName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const current = statFd(currentFd);
      if (!current.isFile() || current.nlink !== 1n || current.size !== 0n || (current.mode & 0o777n) !== 0o600n || !sameCheckpointFileSnapshot(locked, current)) {
        throw automatedReviewLockError("자동 리뷰 lock canonical inode가 획득 중 교체되었습니다.");
      }
    } finally {
      closeFd(currentFd);
    }
    return { fd: lockFd, identity: locked };
  } catch (error) {
    if (lockFd !== null) {
      if (acquired) try { unlock(lockFd); } catch {}
      try { closeFd(lockFd); } catch {}
    }
    if (error?.code === "AUTOMATED_REVIEW_LOCK_BUSY" || error?.code === "AUTOMATED_REVIEW_LOCK_INVALID") throw error;
    throw automatedReviewLockError(`자동 리뷰 lock을 안전하게 획득하지 못했습니다 (${error.message}).`);
  }
}

function assertAutomatedReviewLockPinned(boundary, lock = boundary?.automatedReviewLock) {
  if (!lock) throw automatedReviewLockError("자동 리뷰 lock이 획득되지 않았습니다.");
  assertAutomatedReviewBoundaryPinned(boundary);
  const held = statFd(lock.fd);
  const currentFd = openFileAt(boundary.jobFd, boundary.lockName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const current = statFd(currentFd);
    if (
      !held.isFile()
      || held.nlink !== 1n
      || held.size !== 0n
      || (held.mode & 0o777n) !== 0o600n
      || (current.mode & 0o777n) !== 0o600n
      || !sameCheckpointFileSnapshot(lock.identity, held)
      || !sameCheckpointFileSnapshot(held, current)
    ) throw automatedReviewLockError("자동 리뷰 lock canonical inode가 보유 중 교체되었습니다.");
    return held;
  } finally {
    closeFd(currentFd);
  }
}

function releaseAutomatedReviewLock(boundary, lock) {
  if (!lock) return;
  try {
    assertAutomatedReviewLockPinned(boundary, lock);
    unlock(lock.fd);
  } finally {
    closeFd(lock.fd);
  }
}

function sameCheckpointFileSnapshot(left, right) {
  return Boolean(left && right
    && sameFdIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function checkpointLeafIdentity(boundary, name, maximumBytes, { allowMissing = false } = {}) {
  let fd = null;
  try {
    fd = openFileAt(boundary.jobFd, name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size > BigInt(maximumBytes)) {
      throw new Error("자동 리뷰 checkpoint leaf가 bounded single-link regular file이 아닙니다.");
    }
    return identity;
  } finally {
    closeFd(fd);
  }
}

function decodeCheckpointJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function checkpointValue(bytes) {
  const value = decodeCheckpointJson(bytes);
  const { checkpointHash, ...payload } = value || {};
  if (
    value?.schemaVersion !== AUTOMATED_REVIEW_CHECKPOINT_SCHEMA_VERSION
    || !CHECKPOINT_PHASES.has(value.phase)
    || !value.jobId
    || !value.runId
    || checkpointHash !== canonicalJsonHash(payload)
  ) throw new Error("checkpoint schema가 유효하지 않습니다.");
  return value;
}

async function readCheckpointFromBoundary(boundary) {
  await assertAutomatedReviewBoundaryPinned(boundary);
  let fd = null;
  try {
    fd = openFileAt(boundary.jobFd, boundary.name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = statFd(fd);
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes)) {
      throw new Error("checkpoint가 bounded single-link regular file이 아닙니다.");
    }
    const bytes = readFdBuffer(fd, { maxBytes: AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes });
    const after = statFd(fd);
    const current = checkpointLeafIdentity(boundary, boundary.name, AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes);
    if (!sameCheckpointFileSnapshot(before, after) || !sameCheckpointFileSnapshot(after, current)) {
      throw new Error("checkpoint가 읽는 동안 교체되었습니다.");
    }
    await assertAutomatedReviewBoundaryPinned(boundary);
    return checkpointValue(bytes);
  } finally {
    closeFd(fd);
  }
}

export async function readAutomatedReviewCheckpoint(path, options = {}) {
  let ownedBoundary = null;
  try {
    let boundary = options.boundary || null;
    if (!boundary) {
      const canonicalPath = canonicalCheckpointPath(path);
      const name = basename(canonicalPath);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,160}\.json$/u.test(name)) {
        throw new Error("checkpoint 파일 이름이 유효하지 않습니다.");
      }
      const runId = name.slice(0, -".json".length);
      const jobId = basename(dirname(canonicalPath));
      const root = dirname(dirname(canonicalPath));
      ownedBoundary = pinAutomatedReviewBoundary(jobId, runId, root);
      if (ownedBoundary.path !== canonicalPath) throw new Error("checkpoint 경로가 canonical root/job/run 경계와 일치하지 않습니다.");
      boundary = ownedBoundary;
    }
    return await readCheckpointFromBoundary(boundary);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`자동 리뷰 checkpoint를 안전하게 읽지 못했습니다: ${error.message}`);
  } finally {
    closeAutomatedReviewBoundary(ownedBoundary);
  }
}

async function persistCheckpoint(boundary, checkpoint, onTransition = async () => {}) {
  assertAutomatedReviewLockPinned(boundary);
  const { checkpointHash: _previousCheckpointHash, ...checkpointPayload } = checkpoint;
  const payload = {
    ...checkpointPayload,
    schemaVersion: AUTOMATED_REVIEW_CHECKPOINT_SCHEMA_VERSION,
    algorithmVersion: AUTOMATED_REVIEW_ALGORITHM_VERSION,
    updatedAt: checkpoint.updatedAt || new Date().toISOString()
  };
  const value = { ...payload, checkpointHash: canonicalJsonHash(payload) };
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  if (bytes.byteLength > AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes) {
    throw new Error("자동 리뷰 checkpoint가 byte limit을 초과했습니다.");
  }
  const journalLine = Buffer.from(`${JSON.stringify({ phase: value.phase, at: value.updatedAt, jobId: value.jobId, runId: value.runId, revisionId: value.revisionId || null, evidenceHash: value.evidenceHash || null })}\n`);
  if (journalLine.byteLength > AUTOMATED_REVIEW_FILE_POLICY.journalLineBytes) {
    throw new Error("자동 리뷰 checkpoint journal record가 byte limit을 초과했습니다.");
  }
  await assertAutomatedReviewBoundaryPinned(boundary);
  const expectedIdentity = checkpointLeafIdentity(
    boundary,
    boundary.name,
    AUTOMATED_REVIEW_FILE_POLICY.checkpointBytes,
    { allowMissing: true }
  );
  checkpointLeafIdentity(
    boundary,
    boundary.journalName,
    AUTOMATED_REVIEW_FILE_POLICY.journalBytes,
    { allowMissing: true }
  );
  replaceFileAt(boundary.jobFd, boundary.name, bytes, { mode: 0o600, expectedIdentity });
  appendFileAt(boundary.jobFd, boundary.journalName, journalLine, {
    mode: 0o600,
    maxBytes: AUTOMATED_REVIEW_FILE_POLICY.journalBytes
  });
  syncFd(boundary.jobFd);
  await assertAutomatedReviewBoundaryPinned(boundary);
  assertAutomatedReviewLockPinned(boundary);
  await onTransition({ phase: value.phase, jobId: value.jobId, runId: value.runId, revisionId: value.revisionId || null, evidenceHash: value.evidenceHash || null });
  return value;
}

function errorStatus(error) {
  const value = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(value) ? value : null;
}

function errorText(error) {
  return [error?.message, error?.body?.error, error?.body?.message].filter(Boolean).join(" ");
}

function staleContextError(error) {
  const status = errorStatus(error);
  return [400, 409].includes(status) && /(?:revision\s*)?context.*(?:head|일치)|append-only head|head.*변경/i.test(errorText(error));
}

async function postJson(api, path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function checkpointResultKind(checkpoint) {
  return checkpoint.phase === "sealed_completed"
    ? "completed"
    : checkpoint.phase === "sealed_needs_improvement"
      ? "needs-remediation"
      : checkpoint.phase === "preflight_blocked" || checkpoint.phase === "submission_rejected"
        ? "preflight-blocked"
        : checkpoint.phase === "reconciliation_required"
          ? "reconciliation-required"
          : "submission-unknown";
}

async function reconcileSubmission({ api, jobId, checkpoint, checkpointBoundary, onTransition, now, sleepFn, recoveryPollMs, maxRecoveryPolls }) {
  let lastIntegrityError = null;
  for (let attempt = 0; attempt < Math.max(1, maxRecoveryPolls); attempt += 1) {
    try {
      assertAutomatedReviewLockPinned(checkpointBoundary);
      const [job, quality, history] = await Promise.all([
        api(`/api/jobs/${encodeURIComponent(jobId)}`),
        api(`/api/jobs/${encodeURIComponent(jobId)}/quality`),
        api(`/api/jobs/${encodeURIComponent(jobId)}/quality/history`)
      ]);
      const sealed = Array.isArray(history?.iterations)
        ? history.iterations.find((iteration) => iteration?.revisionId === checkpoint.revisionId)
        : null;
      if (sealed) {
        const phase = sealed.status === "passed" && sealed.semanticGate === true ? "sealed_completed" : "sealed_needs_improvement";
        const next = await persistCheckpoint(checkpointBoundary, {
          ...checkpoint,
          phase,
          updatedAt: now(),
          reconciledFromHistory: true,
          sealedStatus: sealed.status,
          effectiveJobStatus: job.status,
          effectiveRevisionId: quality.revisionId || job.qualitySummary?.revisionId || null
        }, onTransition);
        return { kind: checkpointResultKind(next), checkpoint: next, job, quality, history, sealed };
      }
      lastIntegrityError = null;
    } catch (error) {
      if (errorStatus(error) === 409) lastIntegrityError = error;
      else throw error;
    }
    if (attempt + 1 < maxRecoveryPolls) await sleepFn(recoveryPollMs);
  }
  if (lastIntegrityError) {
    const next = await persistCheckpoint(checkpointBoundary, {
      ...checkpoint,
      phase: "reconciliation_required",
      updatedAt: now(),
      lastError: errorText(lastIntegrityError)
    }, onTransition);
    return { kind: "reconciliation-required", checkpoint: next };
  }
  return null;
}

function validateCheckpointIdentity(checkpoint, jobId, runId) {
  if (checkpoint.jobId !== jobId || checkpoint.runId !== runId || checkpoint.algorithmVersion !== AUTOMATED_REVIEW_ALGORITHM_VERSION) {
    throw new Error("자동 리뷰 checkpoint가 현재 jobId·runId·algorithm과 일치하지 않습니다.");
  }
}

function verifySubmitResponse(response, context) {
  if (
    !response?.revision
    || response.revision.revisionId !== context.revisionId
    || Number(response.revision.sequence) !== Number(context.sequence)
    || response.quality?.revisionId !== context.revisionId
    || response.job?.runId !== context.runId
  ) throw new Error("품질 revision 제출 응답이 요청한 revision context와 일치하지 않습니다.");
  return response.quality.status === "passed" && response.quality.semanticGate === true ? "sealed_completed" : "sealed_needs_improvement";
}

export async function runAutomatedQualityReview({
  jobId,
  api,
  checkpointPath = null,
  checkpointRoot = null,
  onTransition = async () => {},
  now = () => new Date().toISOString(),
  sleepFn = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  recoveryPollMs = 1_000,
  maxRecoveryPolls = 2
} = {}) {
  if (!jobId || typeof api !== "function") throw new Error("자동 리뷰 실행에는 jobId와 API 함수가 필요합니다.");
  let job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (job.status === "completed") return { kind: "completed", job, skipped: "already-completed" };
  if (job.status !== "needs-improvement" || !job.runId) return { kind: "not-eligible", job, skipped: "job-status" };
  const explicitPath = checkpointPath ? canonicalCheckpointPath(checkpointPath) : null;
  const effectiveRoot = checkpointRoot
    ? canonicalCheckpointPath(checkpointRoot)
    : explicitPath
      ? dirname(dirname(explicitPath))
      : canonicalCheckpointPath(DEFAULT_CHECKPOINT_ROOT);
  const path = automatedReviewCheckpointPath(jobId, job.runId, effectiveRoot);
  if (explicitPath && explicitPath !== path) {
    throw new Error("명시적 자동 리뷰 checkpoint 경로가 canonical root/job/run.json 경계와 일치하지 않습니다.");
  }
  const checkpointBoundary = pinAutomatedReviewBoundary(jobId, job.runId, effectiveRoot, { create: true });
  let automatedReviewLock = null;
  try {
  automatedReviewLock = acquireAutomatedReviewLock(checkpointBoundary);
  checkpointBoundary.automatedReviewLock = automatedReviewLock;
  assertAutomatedReviewLockPinned(checkpointBoundary);
  const lockedJob = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  assertAutomatedReviewLockPinned(checkpointBoundary);
  if (lockedJob?.status === "completed") return { kind: "completed", job: lockedJob, skipped: "completed-before-lock" };
  if (lockedJob?.id !== jobId || lockedJob?.runId !== job.runId || lockedJob?.status !== "needs-improvement") {
    const error = new Error("자동 리뷰 lock 획득 전후 jobId·runId·상태가 변경되었습니다.");
    error.code = "AUTOMATED_REVIEW_JOB_CHANGED";
    throw error;
  }
  job = lockedJob;
  let quality = await api(`/api/jobs/${encodeURIComponent(jobId)}/quality`);
  assertAutomatedReviewLockPinned(checkpointBoundary);
  if (quality.jobId !== jobId || quality.runId !== job.runId) throw new Error("품질 응답이 현재 jobId·runId에 결속되어 있지 않습니다.");
  let checkpoint = await readAutomatedReviewCheckpoint(path, { boundary: checkpointBoundary });
  const currentFingerprint = qualityReviewFingerprint({ quality, evidenceHashes: quality.metrics?.evidenceHashes });
  const currentEvidenceHash = committeeEvidenceHash(normalizedEvidenceHashes(quality.metrics?.evidenceHashes));
  if (checkpoint) {
    validateCheckpointIdentity(checkpoint, jobId, job.runId);
    if (["submitting", "submission_unknown", "reconciliation_required", "sealed_completed", "sealed_needs_improvement"].includes(checkpoint.phase)) {
      const reconciled = await reconcileSubmission({ api, jobId, checkpoint, checkpointBoundary, onTransition, now, sleepFn, recoveryPollMs, maxRecoveryPolls });
      if (reconciled) return reconciled;
      if (checkpoint.phase === "sealed_needs_improvement" && checkpoint.evidenceHash === currentEvidenceHash && checkpoint.qualityFingerprint === currentFingerprint) {
        return { kind: "needs-remediation", checkpoint, job, quality, skipped: "unchanged-evidence" };
      }
      if (checkpoint.phase === "sealed_completed") throw new Error("completed checkpoint에 대응하는 봉인 revision을 찾지 못했습니다.");
      if (["submitting", "submission_unknown", "reconciliation_required"].includes(checkpoint.phase)) {
        const next = checkpoint.phase === "reconciliation_required" ? checkpoint : await persistCheckpoint(checkpointBoundary, {
          ...checkpoint,
          phase: "submission_unknown",
          updatedAt: now(),
          lastError: checkpoint.lastError || "제출 결과를 history에서 확인하지 못했습니다. 자동 재제출을 중단합니다."
        }, onTransition);
        return { kind: checkpointResultKind(next), checkpoint: next, job, quality };
      }
    }
    if (["preflight_blocked", "submission_rejected"].includes(checkpoint.phase) && checkpoint.evidenceHash === currentEvidenceHash && checkpoint.qualityFingerprint === currentFingerprint) {
      return { kind: "preflight-blocked", checkpoint, job, quality, skipped: "unchanged-evidence" };
    }
  }

  let refreshes = 0;
  const prepareAndBuild = async () => {
    assertAutomatedReviewLockPinned(checkpointBoundary);
    const prepared = await postJson(api, `/api/jobs/${encodeURIComponent(jobId)}/quality/revisions/prepare`, { runId: job.runId });
    const context = prepared?.revisionContext;
    if (!context || context.jobId !== jobId || context.runId !== job.runId) throw new Error("prepare 응답의 revision context가 현재 작업과 일치하지 않습니다.");
    const preparedHashes = normalizedEvidenceHashes(prepared.evidenceHashes);
    if (prepared.evidenceHash !== committeeEvidenceHash(preparedHashes) || prepared.evidenceHash !== currentEvidenceHash) {
      throw new Error("prepare 응답의 evidence hash가 로컬 품질 증거 재계산과 일치하지 않습니다.");
    }
    const analysis = analyzeAutomatedPanel({ quality, evidenceHashes: preparedHashes, revisionContext: context });
    if (!analysis.eligible) {
      const blocked = await persistCheckpoint(checkpointBoundary, {
        phase: "preflight_blocked",
        jobId,
        runId: job.runId,
        revisionId: context.revisionId,
        revisionSequence: Number(context.sequence),
        contextHash: canonicalJsonHash(context),
        evidenceHash: analysis.evidenceHash,
        qualityFingerprint: analysis.qualityFingerprint,
        projectedTotalScore: analysis.projectedTotalScore,
        reasons: analysis.reasons,
        updatedAt: now()
      }, onTransition);
      return { blocked, analysis };
    }
    const review = buildAutomatedCommitteeReview({ jobId, runId: job.runId, quality, evidenceHashes: preparedHashes, revisionContext: context });
    validateAutomatedCommitteeReview(review, { quality, revisionContext: context });
    const request = { revisionContext: context, review };
    const preparedCheckpoint = await persistCheckpoint(checkpointBoundary, {
      phase: "prepared",
      jobId,
      runId: job.runId,
      revisionId: context.revisionId,
      revisionSequence: Number(context.sequence),
      contextHash: canonicalJsonHash(context),
      evidenceHash: analysis.evidenceHash,
      qualityFingerprint: analysis.qualityFingerprint,
      projectedTotalScore: analysis.projectedTotalScore,
      requestHash: canonicalJsonHash(request),
      request,
      updatedAt: now()
    }, onTransition);
    return { context, request, preparedCheckpoint, analysis };
  };

  let prepared;
  if (checkpoint?.phase === "prepared") {
    if (checkpoint.evidenceHash !== currentEvidenceHash || checkpoint.qualityFingerprint !== currentFingerprint) {
      throw new Error("prepared checkpoint가 현재 불변 품질 증거와 일치하지 않습니다.");
    }
    validateAutomatedCommitteeReview(checkpoint.request?.review, { quality, revisionContext: checkpoint.request?.revisionContext });
    if (checkpoint.requestHash !== canonicalJsonHash(checkpoint.request)) throw new Error("prepared checkpoint의 요청 해시가 payload와 일치하지 않습니다.");
    prepared = { context: checkpoint.request.revisionContext, request: checkpoint.request, preparedCheckpoint: checkpoint };
  } else {
    prepared = await prepareAndBuild();
    if (prepared.blocked) return { kind: "preflight-blocked", checkpoint: prepared.blocked, analysis: prepared.analysis, job, quality };
  }

  while (prepared) {
    const submitting = await persistCheckpoint(checkpointBoundary, {
      ...prepared.preparedCheckpoint,
      phase: "submitting",
      updatedAt: now()
    }, onTransition);
    try {
      assertAutomatedReviewLockPinned(checkpointBoundary);
      const response = await postJson(api, `/api/jobs/${encodeURIComponent(jobId)}/quality/revisions/submit`, prepared.request);
      const phase = verifySubmitResponse(response, prepared.context);
      const sealed = await persistCheckpoint(checkpointBoundary, {
        ...submitting,
        phase,
        updatedAt: now(),
        sealedStatus: response.quality.status,
        effectiveJobStatus: response.job.status,
        responseRevisionManifest: response.revision.manifestPath
      }, onTransition);
      return { kind: checkpointResultKind(sealed), checkpoint: sealed, ...response };
    } catch (error) {
      const ambiguous = errorStatus(error) == null || errorStatus(error) >= 500;
      const failed = await persistCheckpoint(checkpointBoundary, {
        ...submitting,
        phase: ambiguous ? "submission_unknown" : "submission_rejected",
        updatedAt: now(),
        lastError: errorText(error),
        responseStatus: errorStatus(error)
      }, onTransition);
      const reconciled = await reconcileSubmission({ api, jobId, checkpoint: failed, checkpointBoundary, onTransition, now, sleepFn, recoveryPollMs, maxRecoveryPolls });
      if (reconciled) return reconciled;
      if (!ambiguous && staleContextError(error) && refreshes < 1) {
        refreshes += 1;
        job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (job.status === "completed") return { kind: "completed", job, skipped: "head-completed" };
        quality = await api(`/api/jobs/${encodeURIComponent(jobId)}/quality`);
        prepared = await prepareAndBuild();
        if (prepared.blocked) return { kind: "preflight-blocked", checkpoint: prepared.blocked, analysis: prepared.analysis, job, quality };
        if (prepared.context.revisionId === submitting.revisionId || prepared.preparedCheckpoint.contextHash === submitting.contextHash) {
          return { kind: "submission-rejected", checkpoint: failed, error };
        }
        continue;
      }
      if (ambiguous) return { kind: "submission-unknown", checkpoint: failed, error };
      return { kind: "submission-rejected", checkpoint: failed, error };
    }
  }
  throw new Error("자동 리뷰 제출 상태를 결정하지 못했습니다.");
  } finally {
    try {
      releaseAutomatedReviewLock(checkpointBoundary, automatedReviewLock);
    } finally {
      closeAutomatedReviewBoundary(checkpointBoundary);
    }
  }
}
