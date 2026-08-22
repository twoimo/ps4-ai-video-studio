import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, fchmodSync, ftruncateSync, openSync } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
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
  unlock,
  writeFdBuffer,
  unlinkAt
} from "./dirfd.mjs";

export const GEMINI_MONITOR_PRIVATE_FILE_LIMITS = Object.freeze({
  stateBytes: 64 * 1024,
  signalBytes: 64 * 1024,
  leaseBytes: 4 * 1024,
  logBytes: 4 * 1024 * 1024,
  logLineBytes: 64 * 1024
});

const MAX_RETAINED_MONITOR_LOG_LINES = 1024;

const HASH_ONLY_MONITOR_KEYS = new Map([
  ["arialabel", "monitor-dom-label-redacted"],
  ["bodytext", "monitor-dom-text-redacted"],
  ["diagnostic", "monitor-diagnostic-redacted"],
  ["error", "monitor-error-redacted"],
  ["lasterror", "monitor-error-redacted"],
  ["label", "monitor-dom-label-redacted"],
  ["message", "monitor-message-redacted"],
  ["quotamessage", "monitor-quota-text-redacted"],
  ["quotaresettext", "monitor-quota-text-redacted"],
  ["raw", "monitor-raw-text-redacted"]
]);

const MONITOR_FIELDS = new Set([
  "schemaVersion", "status", "profileId", "jobId", "runId", "topic", "clipCount",
  "targetDurationSec", "startedAt", "deadlineAt", "updatedAt", "attempt", "attempts",
  "profiles", "lastError", "completion", "event", "at", "apiBase", "pollMs",
  "quotaWakeLeadMs", "jobPollMs", "retryLimit", "runtimeSource", "runtimeReason",
  "quotaResetAt", "nextQuotaCheckAt", "quotaWaitMs", "quotaWaitReason", "progress",
  "stageEvidence", "messageEvidence", "errorEvidence", "failureEvidence", "failureCode",
  "nextAction", "reviewKind", "human", "independentPrincipal", "automatedReview",
  "automatedReviewKind", "automatedReviewReasons", "failoverCheckpoint", "previousJobId",
  "previousRunId", "previousProfileId", "nextProfileId", "failedJobId", "supersededPlan",
  "selectedPlan", "planMismatchReasons", "retryLineage", "resetAllowed", "resetReason",
  "lineage", "checkpoint", "reason", "reasons", "action", "source", "provider", "format",
  "jobStatus", "runStatus", "qualityStatus", "totalScore", "threshold", "semanticGate",
  "semanticReviewPending", "keyCount", "sha256", "code", "byteLength", "available",
  "headless", "requestedHeadless", "videoMode", "observationFailed", "errorCode",
  "authentication", "observedAt", "expiresAt", "cdpUrl", "id", "quotaMessage",
  "quotaResetText", "diagnostic", "message", "error", "raw", "label", "ariaLabel",
  "bodyText", "requestFingerprint", "sessionBindingHash", "actualSessionBindingHash",
  "expectedSessionBindingHash", "previousPlan", "desiredPlan", "selectedProfileId",
  "profileObservationHash", "completionEvidence", "sequence", "kind", "goalId", "ttlMs",
  "requiresGoalResume", "signalId", "profileObservations", "reviewedAt", "reviewId",
  "submissionId", "revisionId", "baseManifest", "baseQuality", "supersedes", "originalSha256"
]);

const SIGNAL_FIELDS = new Set([
  "schemaVersion", "kind", "goalId", "event", "sequence", "observedAt", "expiresAt",
  "ttlMs", "requiresGoalResume", "nextAction", "jobId", "runId", "status", "profileId",
  "profileObservations", "profileObservationHash", "completionEvidence", "requestFingerprint",
  "signalId"
]);

const BROWSER_FIELDS = new Set([
  "connected", "started", "browser", "chromeMajor", "headless", "requestedHeadless", "mode"
]);

// `redactGeminiMonitor` is also the final API projection for sealed quality
// summaries. Keep that contract closed as well: unknown sealed fields never
// become public merely because they were added to an artifact.
const QUALITY_FIELDS = new Set([
  "iterations", "schemaVersion", "jobId", "runId", "iteration", "evaluatedAt", "threshold",
  "status", "totalScore", "finalization", "postPublicationRevision", "prePublication", "ahp",
  "committee", "reviewers", "reviewedAt", "technicalEvidenceGate", "semanticGate", "metrics",
  "criteria", "remediation", "blockers", "contentSemanticsVerified", "providerProof",
  "providerEvidenceEligible", "legacyProviderProofSemantics", "legacyRawArtifactAccessBlocked",
  "localSemanticReceipt", "verified", "path", "jobStatus", "observedJobStatus",
  "evaluationPhase", "semanticGateStateEligible", "revisionEvaluationEligible", "revisionContext",
  "revisionId", "sequence", "baseManifest", "baseQuality", "supersedes", "provider",
  "providerDecisionBinding", "providerDecisionEventBinding", "providerAttestationBinding",
  "geminiSubmissionLineageBinding", "geminiSubmissionLineage", "geminiGeneration",
  "localVideoGeneration", "segmentCount", "browser", "sessionBinding", "sessionBindingHash",
  "model", "modelVersion", "modelId", "receiptPath", "receiptSha256", "localVideoModelBinding",
  "localVideoRequestBinding", "localVideoClipBinding", "localVideoReceiptBinding",
  "shotPatternReceipt", "receiptHash", "catalogId", "applicationMode", "submittedToProvider",
  "providerRequestSentThisRun", "inheritedProviderSubmission", "sourceSubmissionRunId",
  "sourceGenerationHash", "shotPatternReceiptBinding", "shotPatternProviderEvidenceBinding",
  "semanticRevalidationProviderZero", "semanticRevalidationProviderZeroBinding", "required",
  "providerGenerationProvenance", "generationClipBinding", "generationProvenance",
  "terminalRunBinding", "terminalEventBinding", "eventLogParsePass", "immutableClosureBinding",
  "immutableEvidenceBinding", "geminiSessionBinding", "geminiSessionBindingHash",
  "geminiRequestSessionBinding", "inputManifest", "entryCount", "inputMotionGate", "algorithm",
  "approvedProvider", "enforced", "observedPass", "enforcementPass", "failures", "recomputed",
  "recomputationError", "inputMotionGateBinding", "inputDiversityBinding", "inputManifestBinding",
  "runManifestBinding", "benchmarkReceiptBinding", "sourceSetBinding", "sourceContentBinding",
  "researchStatusVerified", "evidenceTextBindingVerified", "evidenceTextBindingHash",
  "evidenceTextBindingAlgorithm", "committeeEvidenceBound", "committeeAttestationValid", "format",
  "topic", "expectedSegments", "expectedClips", "clipCount", "normalizedCount", "finalMedia",
  "width", "height", "fps", "duration", "sampleRate", "audioStreamCount", "videoStreamCount",
  "durationSum", "sourceDurationSum", "durationDelta", "captionsCount",
  "generatedCaptionCuesPerMinute", "benchmarkCaptionDensity", "captionDensityRatio",
  "captionTiming", "alignment", "estimated", "wordTimingCount", "voiceoverSync", "voiceStyle",
  "voiceSelection", "sayRate", "loudnessTarget", "sourceAudioMode", "sourceAudioGain",
  "targetDurationSec", "voiceoverDurationSec", "captionSpeechDurationSec",
  "captionSpeechCoverageRatio", "benchmarkRlm", "sourceCount", "sourceQuality", "claimEvidencePass",
  "sourceBundle", "fetchedCount", "totalCount", "evidenceCount", "evidenceFrames", "time",
  "evidenceHashes", "frameAudioCaption", "frameCountObserved", "sceneCutCount", "cutReconciliation",
  "silenceCount", "meanVolumeDb", "captionCount", "averageCharsPerSecond", "captionCoverageRatio",
  "uncaptionedTailSec", "captionOverrunSec", "audioQc", "integratedLufs", "loudnessRangeLu",
  "truePeakDbfs", "clippedSamples", "benchmarkDuration", "frameAudioCaptionError", "id", "label",
  "weight", "targetWeight", "score", "autoScore", "committeeScore", "evidence", "factors", "max",
  "pass", "priority", "action", "reason", "code", "byteLength", "sha256"
]);

const NESTED_FIELDS = new Set([...MONITOR_FIELDS, ...SIGNAL_FIELDS, ...BROWSER_FIELDS, ...QUALITY_FIELDS]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function monitorDiagnosticEvidence(value, code = "monitor-diagnostic-redacted") {
  if (value == null) return null;
  if (value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["byteLength", "code", "sha256"])
    && /^[a-z0-9][a-z0-9-]{0,95}$/.test(String(value.code || ""))
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && /^sha256:[a-f0-9]{64}$/.test(String(value.sha256 || ""))) {
    return { code: value.code, byteLength: value.byteLength, sha256: value.sha256 };
  }
  let bytes;
  try {
    bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    bytes = Buffer.from(String(value));
  }
  return {
    code,
    byteLength: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

export function sanitizeGeminiMonitorString(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted-credential]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|client[_-]?secret|secret|cookie|credentials?)\b\s*[:=]\s*[^\s,;"'<>]+/gi, "$1=[redacted-credential]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:file:\/\/)?\/[^\s"'<>]*(?:profile|user-data-dir)[^\s"'<>]*/gi, "[redacted-profile-path]")
    .replace(/[A-Z]:\\Users\\[^\s"'<>]*(?:profile|user-data-dir)[^\s"'<>]*/gi, "[redacted-profile-path]")
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s"'<>/]+(?=\/)/gi, "/[redacted-user]")
    .replace(/[A-Z]:\\Users\\[^\\\s"'<>]+/gi, "C:\\Users\\[redacted-user]");
}

function exactEvidenceMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, hash]) => (
    typeof name === "string"
      && name.length <= 4096
      && !name.includes("\0")
      && /^sha256:[a-f0-9]{64}$/.test(String(hash || ""))
      ? [[name, String(hash)]]
      : []
  )));
}

function projectClosedValue(value, key = "") {
  const normalized = normalizedKey(key);
  if (HASH_ONLY_MONITOR_KEYS.has(normalized)) {
    return monitorDiagnosticEvidence(value, HASH_ONLY_MONITOR_KEYS.get(normalized));
  }
  if (key === "evidenceHashes") return exactEvidenceMap(value);
  if (key === "profiles" || key === "profileObservations") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((profile) => {
      try {
        return [key === "profiles"
          ? projectMonitorStateProfile(profile)
          : projectGeminiMonitorProfileObservation(profile)];
      } catch { return []; }
    });
  }
  if (Array.isArray(value)) return value.map((entry) => (
    entry && typeof entry === "object"
      ? projectClosedObject(entry, NESTED_FIELDS)
      : typeof entry === "string" ? sanitizeGeminiMonitorString(entry) : entry
  ));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 3 && Object.hasOwn(value, "code") && Object.hasOwn(value, "byteLength") && Object.hasOwn(value, "sha256")) {
      return monitorDiagnosticEvidence(value);
    }
    return projectClosedObject(value, NESTED_FIELDS);
  }
  return typeof value === "string" ? sanitizeGeminiMonitorString(value) : value;
}

function projectClosedObject(value, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    allowedFields.has(key) ? [[key, projectClosedValue(entry, key)]] : []
  )));
}

/**
 * Returns a deep, non-mutating public/persistable closed-schema view.
 *
 * Unknown keys are omitted at every depth. This is intentionally an allowlist,
 * not a growing collection of secret-looking names: a newly introduced token,
 * cookie, credential or arbitrary DOM field is private by default. Diagnostic
 * text is represented only by fixed evidence.
 */
export function redactGeminiMonitor(value) {
  if (Array.isArray(value)) return value.map((entry) => redactGeminiMonitor(entry));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? monitorDiagnosticEvidence(value) : value;
  }
  if (value.kind === "ultragoal-resume-request") return projectClosedObject(value, SIGNAL_FIELDS);
  if (Object.hasOwn(value, "iterations")) {
    return { iterations: Array.isArray(value.iterations)
      ? value.iterations.map((entry) => projectClosedObject(entry, QUALITY_FIELDS))
      : [] };
  }
  if (Object.hasOwn(value, "metrics") || (Object.hasOwn(value, "criteria") && Object.hasOwn(value, "totalScore"))) {
    return projectClosedObject(value, QUALITY_FIELDS);
  }
  if (Object.hasOwn(value, "connected") && !Object.hasOwn(value, "profiles")) {
    return projectClosedObject(value, BROWSER_FIELDS);
  }
  return projectClosedObject(value, MONITOR_FIELDS);
}

function exactMonitorTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed).toISOString();
  return normalized === value ? normalized : null;
}

function exactLoopbackOrigin(value) {
  try {
    const url = new URL(String(value));
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "http:"
      && loopback
      && Boolean(url.port)
      && !url.username
      && !url.password
      && (url.pathname === "/" || url.pathname === "")
      && !url.search
      && !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Projects browser observations onto a closed operational schema. All DOM
 * text, labels, account identity and error messages are ignored by design.
 */
export function projectGeminiMonitorProfileObservation(value = {}) {
  const id = typeof value?.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.id)
    ? value.id
    : null;
  const cdpUrl = exactLoopbackOrigin(value?.cdpUrl);
  if (!id || !cdpUrl) throw new TypeError("Gemini monitor profile observation identity가 유효하지 않습니다.");
  const quotaResetAt = value?.quotaResetAt == null ? null : exactMonitorTimestamp(value.quotaResetAt);
  const errorCode = value?.errorCode == null
    ? null
    : /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(value.errorCode))
      ? String(value.errorCode)
      : "gemini-observation-failed";
  return {
    id,
    cdpUrl,
    available: value?.available === true,
    headless: value?.headless === true ? true : value?.headless === false ? false : null,
    videoMode: value?.videoMode === true ? true : value?.videoMode === false ? false : null,
    quotaResetAt,
    observationFailed: value?.observationFailed === true,
    errorCode
  };
}

function projectMonitorStateProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Gemini monitor state profile이 유효하지 않습니다.");
  const id = value.id == null
    ? null
    : typeof value.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.id)
      ? value.id
      : null;
  if (value.id != null && !id) throw new TypeError("Gemini monitor state profile id가 유효하지 않습니다.");
  const cdpUrl = value.cdpUrl == null ? null : exactLoopbackOrigin(value.cdpUrl);
  if (value.cdpUrl != null && !cdpUrl) throw new TypeError("Gemini monitor state profile CDP origin이 유효하지 않습니다.");
  const quotaResetAt = value.quotaResetAt == null ? null : exactMonitorTimestamp(value.quotaResetAt);
  return {
    ...(id ? { id } : {}),
    ...(cdpUrl ? { cdpUrl } : {}),
    ...(Object.hasOwn(value, "available") ? { available: value.available === true } : {}),
    ...(Object.hasOwn(value, "headless") ? {
      headless: value.headless === true ? true : value.headless === false ? false : null
    } : {}),
    ...(Object.hasOwn(value, "videoMode") ? {
      videoMode: value.videoMode === true ? true : value.videoMode === false ? false : null
    } : {}),
    ...(Object.hasOwn(value, "quotaResetAt") ? { quotaResetAt } : {}),
    ...(Object.hasOwn(value, "observationFailed") ? { observationFailed: value.observationFailed === true } : {}),
    ...(Object.hasOwn(value, "errorCode") ? {
      errorCode: value.errorCode == null
        ? null
        : /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(value.errorCode))
          ? String(value.errorCode)
          : "gemini-observation-failed"
    } : {}),
    ...(value?.requestedHeadless === true || value?.requestedHeadless === false
      ? { requestedHeadless: value.requestedHeadless }
      : {}),
    ...(exactMonitorTimestamp(value?.observedAt) ? { observedAt: value.observedAt } : {}),
    ...(["authenticated", "unauthenticated", "unknown", "sign-in-required", "signed-out"].includes(value?.authentication)
      ? { authentication: value.authentication }
      : {}),
    ...(value?.quotaMessage == null ? {} : {
      quotaMessage: monitorDiagnosticEvidence(value.quotaMessage, "monitor-quota-text-redacted")
    }),
    ...(value?.quotaResetText == null ? {} : {
      quotaResetText: monitorDiagnosticEvidence(value.quotaResetText, "monitor-quota-text-redacted")
    }),
    ...(value?.diagnostic == null ? {} : {
      diagnostic: monitorDiagnosticEvidence(value.diagnostic, "monitor-diagnostic-redacted")
    })
  };
}

function privateBoundaryError(message, code = "GEMINI_MONITOR_PRIVATE_FILE_UNSAFE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function samePrivateFileSnapshot(left, right) {
  return Boolean(left && right
    && sameFdIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function closePrivateBoundary(boundary) {
  for (const entry of [...(boundary?.directories || [])].reverse()) {
    try { closeFd(entry.fd); } catch {}
  }
}

async function pinPrivateParent(filePath, { create = false } = {}) {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    throw new TypeError("Gemini monitor private file 경로가 유효하지 않습니다.");
  }
  let target = resolve(filePath);
  // macOS exposes these immutable system aliases as symlinks. Canonicalize
  // only the fixed OS aliases; arbitrary user-controlled ancestry remains
  // subject to the O_NOFOLLOW traversal below.
  if (process.platform === "darwin") {
    if (target === "/var" || target.startsWith("/var/")) target = `/private${target}`;
    else if (target === "/tmp" || target.startsWith("/tmp/")) target = `/private${target}`;
  }
  const name = basename(target);
  if (!name || name === "." || name === "..") throw new TypeError("Gemini monitor private file 이름이 유효하지 않습니다.");
  const segments = dirname(target).split("/").filter(Boolean);
  const directories = [];
  let currentFd = openSync(
    "/",
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    let currentPath = "/";
    directories.push({ path: currentPath, fd: currentFd, identity: statFd(currentFd) });
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
        throw privateBoundaryError("Gemini monitor private file ancestry가 directory가 아닙니다.");
      }
      currentPath = currentPath === "/" ? `/${segment}` : `${currentPath}/${segment}`;
      directories.push({ path: currentPath, fd: nextFd, identity });
      currentFd = nextFd;
    }
    if (segments.length > 0) fchmodSync(currentFd, 0o700);
    return { target, name, parentFd: currentFd, directories };
  } catch (error) {
    closePrivateBoundary({ directories });
    throw error;
  }
}

async function assertPrivateBoundaryPinned(boundary) {
  const current = await pinPrivateParent(boundary.target);
  try {
    if (current.directories.length !== boundary.directories.length) {
      throw privateBoundaryError("Gemini monitor private file ancestry 길이가 변경되었습니다.");
    }
    for (let index = 0; index < boundary.directories.length; index += 1) {
      const expected = boundary.directories[index];
      const observed = current.directories[index];
      if (expected.path !== observed.path || !sameFdIdentity(expected.identity, observed.identity)) {
        throw privateBoundaryError("Gemini monitor private file ancestry가 처리 중 교체되었습니다.");
      }
    }
  } finally {
    closePrivateBoundary(current);
  }
}

function openPrivateLeaf(boundary, maximumBytes, { allowMissing = false } = {}) {
  let fd;
  try {
    fd = openFileAt(
      boundary.parentFd,
      boundary.name,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size > BigInt(maximumBytes)) {
      throw privateBoundaryError("Gemini monitor private file이 bounded single-link regular file이 아닙니다.");
    }
    return { fd, identity };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

async function readPrivateFileSnapshot(filePath, maximumBytes, { allowMissing = true } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("Gemini monitor private file byte limit이 유효하지 않습니다.");
  let boundary;
  let leaf;
  try {
    boundary = await pinPrivateParent(filePath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    leaf = openPrivateLeaf(boundary, maximumBytes, { allowMissing });
    if (!leaf) return null;
    const bytes = readFdBuffer(leaf.fd, { maxBytes: maximumBytes });
    const after = statFd(leaf.fd);
    if (after.nlink !== 1n || !samePrivateFileSnapshot(leaf.identity, after)) {
      throw privateBoundaryError("Gemini monitor private file이 읽는 중 변경되었습니다.");
    }
    await assertPrivateBoundaryPinned(boundary);
    const current = openPrivateLeaf(boundary, maximumBytes);
    try {
      if (!samePrivateFileSnapshot(leaf.identity, current.identity)) {
        throw privateBoundaryError("Gemini monitor private file pathname이 읽는 중 교체되었습니다.");
      }
    } finally {
      closeFd(current.fd);
    }
    return { bytes, identity: leaf.identity };
  } finally {
    if (leaf) closeFd(leaf.fd);
    closePrivateBoundary(boundary);
  }
}

function strictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw privateBoundaryError("Gemini monitor private file이 올바른 UTF-8이 아닙니다.", "GEMINI_MONITOR_PRIVATE_FILE_INVALID_UTF8");
  }
}

function parseStrictJsonBytes(bytes) {
  try {
    return JSON.parse(strictUtf8(bytes));
  } catch (error) {
    if (error?.code === "GEMINI_MONITOR_PRIVATE_FILE_INVALID_UTF8") throw error;
    throw privateBoundaryError("Gemini monitor private JSON을 해석할 수 없습니다.", "GEMINI_MONITOR_PRIVATE_JSON_INVALID");
  }
}

export async function readPrivateJsonFileStrict(filePath, {
  maxBytes = GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes,
  allowMissing = true
} = {}) {
  const snapshot = await readPrivateFileSnapshot(filePath, maxBytes, { allowMissing });
  return snapshot ? parseStrictJsonBytes(snapshot.bytes) : null;
}

export async function readAndSyncPrivateJsonFileStrict(filePath, {
  maxBytes = GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes
} = {}) {
  const snapshot = await readPrivateFileSnapshot(filePath, maxBytes, { allowMissing: false });
  const value = parseStrictJsonBytes(snapshot.bytes);
  const boundary = await pinPrivateParent(filePath);
  try {
    const canonical = openPrivateLeaf(boundary, maxBytes);
    try {
      if (!samePrivateFileSnapshot(snapshot.identity, canonical.identity)) {
        throw privateBoundaryError("Gemini monitor private file이 durable sync 전에 교체되었습니다.");
      }
      syncFd(canonical.fd);
      syncFd(boundary.parentFd);
      const after = statFd(canonical.fd);
      if (!samePrivateFileSnapshot(canonical.identity, after) || after.nlink !== 1n) {
        throw privateBoundaryError("Gemini monitor private file이 durable sync 중 변경되었습니다.");
      }
    } finally {
      closeFd(canonical.fd);
    }
    await assertPrivateBoundaryPinned(boundary);
    return value;
  } finally {
    closePrivateBoundary(boundary);
  }
}

export async function createPrivateJsonFileExclusiveStrict(filePath, value, {
  maxBytes = GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes
} = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.byteLength > maxBytes) throw privateBoundaryError("Gemini monitor exclusive JSON publication이 byte limit을 초과했습니다.");
  const boundary = await pinPrivateParent(filePath, { create: true });
  let fd = null;
  try {
    fd = createFileAt(boundary.parentFd, boundary.name, fsConstants.O_RDWR, 0o600, { initialBytes: bytes });
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size !== BigInt(bytes.byteLength)) {
      throw privateBoundaryError("Gemini monitor exclusive JSON publication이 안전하지 않습니다.");
    }
    fchmodSync(fd, 0o600);
    syncFd(fd);
    syncFd(boundary.parentFd);
    await assertPrivateBoundaryPinned(boundary);
    return identity;
  } finally {
    if (fd !== null) closeFd(fd);
    closePrivateBoundary(boundary);
  }
}

function existingPrivateLeafIdentity(boundary, maximumBytes) {
  const leaf = openPrivateLeaf(boundary, maximumBytes, { allowMissing: true });
  if (!leaf) return null;
  try {
    return leaf.identity;
  } finally {
    closeFd(leaf.fd);
  }
}

async function replacePrivateBytes(filePath, input, options = {}) {
  const {
    maxBytes = GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes,
    expectedIdentity
  } = options;
  const bytes = Buffer.from(input);
  if (bytes.byteLength > maxBytes) throw privateBoundaryError("Gemini monitor private file publication이 byte limit을 초과했습니다.");
  const boundary = await pinPrivateParent(filePath, { create: true });
  try {
    const currentIdentity = existingPrivateLeafIdentity(boundary, maxBytes);
    if (Object.hasOwn(options, "expectedIdentity") && (
      expectedIdentity === null
        ? currentIdentity !== null
        : !samePrivateFileSnapshot(expectedIdentity, currentIdentity)
    )) throw privateBoundaryError("Gemini monitor private file이 읽은 뒤 교체되어 publication을 중단합니다.");
    await assertPrivateBoundaryPinned(boundary);
    replaceFileAt(boundary.parentFd, boundary.name, bytes, {
      mode: 0o600,
      expectedIdentity: currentIdentity
    });
    await assertPrivateBoundaryPinned(boundary);
    const published = openPrivateLeaf(boundary, maxBytes);
    try {
      if (published.identity.size !== BigInt(bytes.byteLength)) {
        throw privateBoundaryError("Gemini monitor private file publication 크기가 일치하지 않습니다.");
      }
    } finally {
      closeFd(published.fd);
    }
  } finally {
    closePrivateBoundary(boundary);
  }
}

function monitorLogRotationMarker(previous) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    event: "privacy_log_rotated",
    byteLength: previous.byteLength,
    originalSha256: `sha256:${createHash("sha256").update(previous).digest("hex")}`
  })}\n`);
}

function safeCompleteMonitorLogLine(line) {
  let end = line.byteLength;
  if (end > 0 && line[end - 1] === 0x0a) end -= 1;
  if (end > 0 && line[end - 1] === 0x0d) end -= 1;
  const payload = line.subarray(0, end);
  if (payload.byteLength === 0) return null;
  let projected;
  try {
    projected = payload.byteLength <= GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logLineBytes
      ? redactGeminiMonitor(parseStrictJsonBytes(payload))
      : privacyParseFailure(payload);
  } catch {
    projected = privacyParseFailure(payload);
  }
  let serialized = Buffer.from(`${JSON.stringify(projected)}\n`);
  if (serialized.byteLength > GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logLineBytes) {
    serialized = Buffer.from(`${JSON.stringify(privacyParseFailure(payload))}\n`);
  }
  return serialized;
}

function boundedRotatedMonitorLog(previous, nextLine) {
  const maximumBytes = GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes;
  const completeExistingLog = previous.byteLength === 0 || previous[previous.byteLength - 1] === 0x0a;
  if (completeExistingLog && previous.byteLength + nextLine.byteLength <= maximumBytes) {
    return Buffer.concat([previous, nextLine], previous.byteLength + nextLine.byteLength);
  }

  // The marker binds the complete pre-rotation byte sequence. Retained tail
  // records are parsed and projected again, so legacy credentials or unknown
  // fields can never be copied into the new canonical log.
  const marker = monitorLogRotationMarker(previous);
  const tailBudget = maximumBytes - marker.byteLength - nextLine.byteLength;
  if (tailBudget < 0) {
    throw privateBoundaryError("Gemini monitor JSONL rotation record가 file limit을 초과했습니다.");
  }

  const retained = [];
  let retainedBytes = 0;
  let cursor = previous.byteLength;
  if (cursor > 0 && previous[cursor - 1] !== 0x0a) {
    const lastComplete = previous.lastIndexOf(0x0a);
    cursor = lastComplete < 0 ? 0 : lastComplete + 1;
  }
  while (cursor > 0 && retained.length < MAX_RETAINED_MONITOR_LOG_LINES) {
    const previousNewline = previous.lastIndexOf(0x0a, cursor - 2);
    const start = previousNewline < 0 ? 0 : previousNewline + 1;
    const safeLine = safeCompleteMonitorLogLine(previous.subarray(start, cursor));
    cursor = start;
    if (!safeLine) continue;
    if (safeLine.byteLength > tailBudget - retainedBytes) break;
    retained.push(safeLine);
    retainedBytes += safeLine.byteLength;
  }
  retained.reverse();
  return Buffer.concat(
    [marker, ...retained, nextLine],
    marker.byteLength + retainedBytes + nextLine.byteLength
  );
}

async function appendPrivateLogLine(filePath, line) {
  const bytes = Buffer.from(line);
  if (
    bytes.byteLength === 0
    || bytes.byteLength > GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logLineBytes
    || bytes[bytes.byteLength - 1] !== 0x0a
  ) {
    throw privateBoundaryError("Gemini monitor JSONL record가 line limit을 초과했습니다.");
  }
  const boundary = await pinPrivateParent(filePath, { create: true });
  let leaf = null;
  try {
    leaf = openPrivateLeaf(boundary, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes, { allowMissing: true });
    const expectedIdentity = leaf?.identity || null;
    const previous = leaf
      ? readFdBuffer(leaf.fd, { maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes })
      : Buffer.alloc(0);
    if (leaf) {
      const afterRead = statFd(leaf.fd);
      if (afterRead.nlink !== 1n || !samePrivateFileSnapshot(expectedIdentity, afterRead)) {
        throw privateBoundaryError("Gemini monitor JSONL이 append 중 변경되었습니다.");
      }
    }
    const publishedBytes = boundedRotatedMonitorLog(previous, bytes);
    await assertPrivateBoundaryPinned(boundary);
    replaceFileAt(boundary.parentFd, boundary.name, publishedBytes, {
      mode: 0o600,
      expectedIdentity
    });
    await assertPrivateBoundaryPinned(boundary);
    const published = openPrivateLeaf(boundary, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes);
    try {
      const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : published.identity.uid;
      if (
        published.identity.size !== BigInt(publishedBytes.byteLength)
        || (published.identity.mode & 0o777n) !== 0o600n
        || published.identity.uid !== expectedUid
      ) throw privateBoundaryError("Gemini monitor JSONL publication metadata가 안전하지 않습니다.");
      // replaceFileAt fsyncs the staged inode and parent before returning.
      // Re-sync the canonical handles so an idempotent caller also receives a
      // durability acknowledgement tied to the final pathname.
      syncFd(published.fd);
      syncFd(boundary.parentFd);
    } finally {
      closeFd(published.fd);
    }
  } finally {
    if (leaf) closeFd(leaf.fd);
    closePrivateBoundary(boundary);
  }
}

async function ensurePrivateParent(filePath, dependencies = {}) {
  const mkdirFn = dependencies.mkdirFn || mkdir;
  const chmodFn = dependencies.chmodFn || chmod;
  const parent = dirname(filePath);
  await mkdirFn(parent, { recursive: true, mode: 0o700 });
  await chmodFn(parent, 0o700);
}

async function syncParentDirectory(filePath, dependencies = {}) {
  const openFn = dependencies.openFn || open;
  const handle = await openFn(dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function monitorLeaseOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pid = Number(value.pid);
  const acquiredAt = typeof value.acquiredAt === "string" ? value.acquiredAt : "";
  const nonce = typeof value.nonce === "string" ? value.nonce : "";
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(pid) || pid <= 0 || !acquiredAt || !Number.isFinite(Date.parse(acquiredAt)) || !/^[a-f0-9-]{36}$/i.test(nonce)) {
    return null;
  }
  return { schemaVersion: 1, pid, acquiredAt, nonce };
}

function monitorLeaseError(message, code, owner = undefined, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (owner !== undefined) error.owner = owner;
  if (cause) error.cause = cause;
  return error;
}

function monitorLeaseOwnerBytes(owner) {
  const serialized = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  if (serialized.byteLength > GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes) {
    throw monitorLeaseError(
      "Gemini monitor lease owner가 byte limit을 초과했습니다.",
      "GEMINI_MONITOR_LEASE_CORRUPT"
    );
  }
  // Every owner update is one fixed-size overwrite. Keeping the inode length
  // constant avoids an observable empty/partial truncation window for a
  // contending process, while JSON.parse accepts the trailing JSON whitespace.
  return Buffer.concat([
    serialized,
    Buffer.alloc(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes - serialized.byteLength, 0x20)
  ]);
}

function assertMonitorLeaseIdentity(identity) {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : identity.uid;
  if (
    !identity.isFile()
    || identity.nlink !== 1n
    || identity.uid !== expectedUid
    || (identity.mode & 0o777n) !== 0o600n
    || identity.size < 0n
    || identity.size > BigInt(GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes)
  ) {
    throw monitorLeaseError(
      "Gemini monitor lease는 현재 사용자 소유 mode-0600 bounded single-link regular file이어야 합니다.",
      "GEMINI_MONITOR_LEASE_CORRUPT"
    );
  }
  return identity;
}

function readMonitorLeaseOwnerFromFd(fd) {
  const before = assertMonitorLeaseIdentity(statFd(fd));
  let parsed;
  try {
    parsed = parseStrictJsonBytes(readFdBuffer(fd, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes
    }));
  } catch (error) {
    throw monitorLeaseError(
      "Gemini monitor lease가 손상되어 있습니다. 자동으로 덮어쓰지 않습니다.",
      "GEMINI_MONITOR_LEASE_CORRUPT",
      null,
      error
    );
  }
  const owner = monitorLeaseOwner(parsed);
  const after = assertMonitorLeaseIdentity(statFd(fd));
  if (!owner || !samePrivateFileSnapshot(before, after)) {
    throw monitorLeaseError(
      "Gemini monitor lease가 손상되어 있습니다. 자동으로 덮어쓰지 않습니다.",
      "GEMINI_MONITOR_LEASE_CORRUPT"
    );
  }
  return { owner, identity: after };
}

function tryReadMonitorLeaseOwnerFromFd(fd) {
  try {
    return readMonitorLeaseOwnerFromFd(fd).owner;
  } catch {
    return null;
  }
}

async function assertCanonicalMonitorLeaseInode(boundary, expectedIdentity) {
  await assertPrivateBoundaryPinned(boundary);
  const current = openPrivateLeaf(boundary, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes);
  try {
    assertMonitorLeaseIdentity(current.identity);
    if (!sameFdIdentity(expectedIdentity, current.identity)) {
      throw monitorLeaseError(
        "Gemini monitor lease canonical inode가 처리 중 교체되었습니다.",
        "GEMINI_MONITOR_LEASE_OWNER_MISMATCH"
      );
    }
  } finally {
    closeFd(current.fd);
  }
}

async function assertCanonicalMonitorLease(boundary, expectedIdentity) {
  await assertPrivateBoundaryPinned(boundary);
  const current = openPrivateLeaf(boundary, GEMINI_MONITOR_PRIVATE_FILE_LIMITS.leaseBytes);
  try {
    assertMonitorLeaseIdentity(current.identity);
    if (!samePrivateFileSnapshot(expectedIdentity, current.identity)) {
      throw monitorLeaseError(
        "Gemini monitor lease canonical inode가 처리 중 교체되었습니다.",
        "GEMINI_MONITOR_LEASE_OWNER_MISMATCH"
      );
    }
  } finally {
    closeFd(current.fd);
  }
}

/**
 * Claims the one monitor process allowed to create or resume provider jobs.
 * The canonical inode is permanent. `flock` is the ownership primitive, so a
 * process crash releases ownership in the kernel without an unsafe pathname
 * unlink/recreate race.
 */
export async function acquireGeminiMonitorLease(lockPath, {
  pid = process.pid,
  now = new Date(),
  nonce = randomUUID(),
  hooks = null
} = {}) {
  if (typeof lockPath !== "string" || !lockPath.trim()) throw new TypeError("Gemini monitor lease 경로가 필요합니다.");
  const acquiredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const owner = monitorLeaseOwner({ schemaVersion: 1, pid, acquiredAt, nonce });
  if (!owner) throw new TypeError("Gemini monitor lease owner가 유효하지 않습니다.");
  const boundary = await pinPrivateParent(lockPath, { create: true });
  const ownerBytes = monitorLeaseOwnerBytes(owner);
  let leaseFd = null;
  let locked = false;
  let returned = false;
  try {
    try {
      leaseFd = createFileAt(
        boundary.parentFd,
        boundary.name,
        fsConstants.O_RDWR,
        0o600,
        { initialBytes: ownerBytes }
      );
      fchmodSync(leaseFd, 0o600);
      syncFd(leaseFd);
      syncFd(boundary.parentFd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        leaseFd = openFileAt(
          boundary.parentFd,
          boundary.name,
          fsConstants.O_RDWR | fsConstants.O_NONBLOCK
        );
      } catch (openError) {
        throw monitorLeaseError(
          "Gemini monitor lease가 손상되어 있습니다. 자동으로 덮어쓰지 않습니다.",
          "GEMINI_MONITOR_LEASE_CORRUPT",
          null,
          openError
        );
      }
    }

    assertMonitorLeaseIdentity(statFd(leaseFd));
    if (!tryLockExclusive(leaseFd)) {
      const existing = tryReadMonitorLeaseOwnerFromFd(leaseFd);
      const busyIdentity = assertMonitorLeaseIdentity(statFd(leaseFd));
      await assertCanonicalMonitorLeaseInode(boundary, busyIdentity);
      throw monitorLeaseError(
        existing
          ? `Gemini monitor lease가 이미 존재합니다. PID ${existing.pid}의 실행 여부를 확인하세요.`
          : "Gemini monitor lease가 이미 실행 중인 owner에 의해 잠겨 있습니다.",
        "GEMINI_MONITOR_ALREADY_RUNNING",
        existing
      );
    }
    locked = true;

    // The kernel lock and safe canonical inode are authoritative. Prior owner
    // bytes may be torn by a crash during the preceding fixed-size overwrite;
    // once the flock is ours, repair them instead of permanently bricking the
    // monitor. Exact pathname identity is still re-attested around the write.
    const previousIdentity = assertMonitorLeaseIdentity(statFd(leaseFd));
    await assertCanonicalMonitorLease(boundary, previousIdentity);
    await hooks?.afterLeaseLocked?.({
      lockPath,
      identity: previousIdentity,
      owner: tryReadMonitorLeaseOwnerFromFd(leaseFd)
    });
    await assertCanonicalMonitorLease(boundary, previousIdentity);

    writeFdBuffer(leaseFd, ownerBytes, 0);
    ftruncateSync(leaseFd, ownerBytes.byteLength);
    syncFd(leaseFd);
    const identity = assertMonitorLeaseIdentity(statFd(leaseFd));
    await assertCanonicalMonitorLease(boundary, identity);
    const exact = readMonitorLeaseOwnerFromFd(leaseFd);
    if (
      exact.owner.pid !== owner.pid
      || exact.owner.nonce !== owner.nonce
      || exact.owner.acquiredAt !== owner.acquiredAt
      || !samePrivateFileSnapshot(identity, exact.identity)
    ) {
      throw monitorLeaseError(
        "Gemini monitor lease owner publication을 재검증할 수 없습니다.",
        "GEMINI_MONITOR_LEASE_OWNER_MISMATCH"
      );
    }

    let released = false;
    const lease = {
      owner,
      async release() {
        if (released) return;
        let releaseError = null;
        try {
          if (!tryLockExclusive(leaseFd)) {
            throw monitorLeaseError(
              "Gemini monitor lease kernel lock 소유권을 재검증할 수 없습니다.",
              "GEMINI_MONITOR_LEASE_OWNER_MISMATCH"
            );
          }
          const held = readMonitorLeaseOwnerFromFd(leaseFd);
          if (
            held.owner.nonce !== owner.nonce
            || held.owner.pid !== owner.pid
            || held.owner.acquiredAt !== owner.acquiredAt
          ) {
            throw monitorLeaseError(
              "Gemini monitor lease 소유권이 바뀌어 해제하지 않습니다.",
              "GEMINI_MONITOR_LEASE_OWNER_MISMATCH"
            );
          }
          await assertCanonicalMonitorLease(boundary, held.identity);
          unlock(leaseFd);
          locked = false;
        } catch (error) {
          releaseError = error?.code
            ? error
            : monitorLeaseError(
                "Gemini monitor lease 소유권을 재검증할 수 없습니다.",
                "GEMINI_MONITOR_LEASE_RELEASE_FAILED",
                null,
                error
              );
        } finally {
          if (locked) {
            try { unlock(leaseFd); } catch {}
            locked = false;
          }
          try { closeFd(leaseFd); } catch (error) { releaseError ||= error; }
          closePrivateBoundary(boundary);
          released = true;
        }
        if (releaseError) throw releaseError;
      }
    };
    returned = true;
    return lease;
  } catch (error) {
    if (locked) {
      try { unlock(leaseFd); } catch {}
    }
    throw error?.code
      ? error
      : monitorLeaseError(
          "Gemini monitor lease가 손상되어 있습니다. 자동으로 덮어쓰지 않습니다.",
          "GEMINI_MONITOR_LEASE_CORRUPT",
          null,
          error
        );
  } finally {
    if (!returned) {
      if (leaseFd !== null) try { closeFd(leaseFd); } catch {}
      closePrivateBoundary(boundary);
    }
  }
}

export async function readRedactedGeminiMonitorState(filePath) {
  try {
    const value = await readPrivateJsonFileStrict(filePath, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes
    });
    return value == null ? null : redactGeminiMonitor(value);
  } catch {
    return null;
  }
}

export async function writePrivateJson(filePath, value, dependencies = {}) {
  const projected = redactGeminiMonitor(value);
  const serialized = Buffer.from(`${JSON.stringify(projected, null, 2)}\n`);
  const hasInjectedFilesystem = ["openFn", "renameFn", "unlinkFn", "mkdirFn", "chmodFn"].some((key) => Object.hasOwn(dependencies, key));
  if (!hasInjectedFilesystem) {
    await replacePrivateBytes(filePath, serialized, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes,
      ...(Object.hasOwn(dependencies, "expectedIdentity") ? { expectedIdentity: dependencies.expectedIdentity } : {})
    });
    return;
  }
  const openFn = dependencies.openFn || open;
  const renameFn = dependencies.renameFn || rename;
  const unlinkFn = dependencies.unlinkFn || unlink;
  const randomIdFn = dependencies.randomUUIDFn || randomUUID;
  await ensurePrivateParent(filePath, dependencies);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomIdFn()}`;
  let handle = null;
  let renamed = false;
  try {
    handle = await openFn(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      if (typeof handle.chmod === "function") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
      handle = null;
    }
    await renameFn(temporaryPath, filePath);
    renamed = true;
    await syncParentDirectory(filePath, dependencies);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await unlinkFn(temporaryPath).catch(() => {});
  }
}

export async function persistGeminiMonitorEvent({
  statePath,
  logPath,
  state,
  event,
  details = {},
  now = new Date(),
  logger = console.log
}) {
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  const safeDetails = redactGeminiMonitor(details);
  const diskState = await readRedactedGeminiMonitorState(statePath);
  const memoryState = redactGeminiMonitor(state);
  // The scrubbed disk snapshot wins over stale memory for privacy, while the
  // event details are the authoritative transition patch. Callers must put
  // intentional null/zero resets in details so disk state cannot revive them.
  const nextState = diskState && typeof diskState === "object"
    ? { ...memoryState, ...diskState, ...safeDetails, updatedAt }
    : { ...memoryState, ...safeDetails, updatedAt };
  const record = {
    schemaVersion: 2,
    ...safeDetails,
    event: sanitizeGeminiMonitorString(event),
    at: updatedAt
  };

  await writePrivateJson(statePath, nextState);
  await appendPrivateLogLine(logPath, `${JSON.stringify(record)}\n`);
  logger?.(JSON.stringify({ event: record.event, ...safeDetails }));
  return nextState;
}

function privacyParseFailure(line) {
  return {
    schemaVersion: 2,
    event: "privacy_redaction_parse_failure",
    originalSha256: `sha256:${createHash("sha256").update(line).digest("hex")}`
  };
}

/**
 * One-way migration for monitor artifacts produced by earlier builds.
 * Malformed JSONL records are replaced by a hash-only marker rather than
 * retaining potentially sensitive source text.
 */
export async function scrubGeminiMonitorArtifacts({ statePath, logPath, signalPath } = {}) {
  const scrubbed = [];
  for (const filePath of [statePath, signalPath].filter(Boolean)) {
    const snapshot = await readPrivateFileSnapshot(
      filePath,
      GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes
    );
    if (snapshot == null) continue;
    let value;
    try {
      value = parseStrictJsonBytes(snapshot.bytes);
    } catch {
      value = privacyParseFailure(snapshot.bytes);
    }
    const serialized = Buffer.from(`${JSON.stringify(redactGeminiMonitor(value), null, 2)}\n`);
    await replacePrivateBytes(filePath, serialized, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.stateBytes,
      expectedIdentity: snapshot.identity
    });
    scrubbed.push(filePath);
  }

  if (logPath) {
    const snapshot = await readPrivateFileSnapshot(
      logPath,
      GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes
    );
    if (snapshot != null) {
      const output = [];
      let outputBytes = 0;
      let outputOverflow = false;
      const appendRecord = (record) => {
        const serialized = Buffer.from(`${JSON.stringify(record)}\n`);
        if (outputBytes + serialized.byteLength > GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes) {
          outputOverflow = true;
          output.length = 0;
          outputBytes = 0;
          return false;
        }
        output.push(serialized);
        outputBytes += serialized.byteLength;
        return true;
      };
      let lineStart = 0;
      for (let index = 0; index <= snapshot.bytes.byteLength; index += 1) {
        if (index !== snapshot.bytes.byteLength && snapshot.bytes[index] !== 0x0a) continue;
        let lineEnd = index;
        if (lineEnd > lineStart && snapshot.bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
        const line = snapshot.bytes.subarray(lineStart, lineEnd);
        lineStart = index + 1;
        if (line.byteLength === 0) continue;
        if (line.byteLength > GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logLineBytes) {
          if (!appendRecord(privacyParseFailure(line))) break;
          continue;
        }
        try {
          if (!appendRecord(redactGeminiMonitor(parseStrictJsonBytes(line)))) break;
        } catch {
          if (!appendRecord(privacyParseFailure(line))) break;
        }
      }
      const sanitized = outputOverflow
        ? Buffer.from(`${JSON.stringify({
          schemaVersion: 2,
          event: "privacy_redaction_file_failure",
          originalSha256: `sha256:${createHash("sha256").update(snapshot.bytes).digest("hex")}`
        })}\n`)
        : Buffer.concat(output, outputBytes);
      await replacePrivateBytes(logPath, sanitized, {
        maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.logBytes,
        expectedIdentity: snapshot.identity
      });
      scrubbed.push(logPath);
    }
  }
  return scrubbed;
}
