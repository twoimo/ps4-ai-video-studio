import { constants as fsConstants, existsSync, fstatSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ANALYSIS_PATH,
  JOBS_DIR,
  ROOT,
  WORKSPACE_DIR,
  createJob,
  ensureWorkspace,
  assertNoPriorPaidLocalVideoSubmission,
  listJobs,
  recoverSemanticRevalidationWorkspace,
  readSemanticTransactionStrict,
  readGeminiSemanticRevalidationInputs,
  readAnalysis,
  readJob,
  runJob,
  SEMANTIC_REVALIDATION_MODE,
  updateJob,
  writeJob
} from "./pipeline.mjs";
import { appendRunEvent, hashFile, writeRunManifest } from "./run-ledger.mjs";
import { buildGeminiGenerationRequest, configuredGeminiJobProfile, geminiBrowserStatus, startGeminiBrowser } from "./gemini-browser.mjs";
import { buildLocalVideoRequest, localVideoProviderRequestBodyClosureBound, withStoredBflAuthorization } from "./local-video-provider.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "./provenance.mjs";
import {
  assertRuntimeQualityRevisionEvaluation,
  bindQualityRevision,
  buildQualityRevisionEvent,
  buildQualityRevisionManifest,
  canonicalJsonHash,
  committeeEvidenceHash,
  evaluateJob,
  prepareQualityRevision,
  readQualityRevisionState as readQualityRevisionStateUnchecked,
  runQualityLoop,
  saveCommitteeReview
} from "./quality.mjs";
import { ytDlpInfo } from "./yt-dlp.mjs";
import { redactGeminiMonitor } from "./gemini-monitor-privacy.mjs";
import { buildProviderReadiness } from "./provider-readiness.mjs";
import { createShotPatternReceipt, publicShotPatternCatalog, readShotPatternCatalog, verifyShotPatternReceipt } from "./shot-patterns.mjs";
import { loadSemanticRevalidationSource, verifySemanticRevalidationProviderZeroBinding } from "./semantic-revalidation-closure.mjs";
import { LOCAL_SEMANTIC_POLICY_BINDING } from "./local-semantic-verifier.mjs";
import { buildBflPaidApprovalContext, consumeOrRecoverBflPaidApproval } from "./bfl-paid-approval.mjs";
import { geminiSourceGenerationEvidenceName, verifyGeminiSubmissionLineageClosure } from "./gemini-submission-lineage.mjs";
import { redactStoredGeminiJobFailure, storedProviderFailure } from "./gemini-error-safety.mjs";
import {
  appendFileAt,
  closeFd,
  createFileAt,
  mkdirAt,
  openFileAt,
  openDirectoryAt,
  readFileAt,
  readFdBuffer,
  replaceFileAt,
  sameFdIdentity,
  statFd,
  syncFd,
  tryLockExclusive,
  unlock,
  writeFdBuffer
} from "./dirfd.mjs";
import {
  installLocalClipUpload,
  readLocalClipUploadTransactionStrict,
  recoverLocalClipUploadTransaction,
  verifyReadyLocalClipSet
} from "./local-clip-upload.mjs";

const PORT = Number(process.env.PORT || 3000);
export const DEFAULT_HOST = "127.0.0.1";
const HOST = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
const PUBLIC_DIR = join(ROOT, "public");
const activeJobs = new Set();
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/;
export const MAX_STUDIO_TOKEN_BYTES = 4 * 1024;
export const ARTIFACT_CAPABILITY_TTL_SECONDS = 60 * 60;
const ARTIFACT_CAPABILITY_VERSION = "ps4-artifact-capability-v1";
// Bun's multipart formData() materializes the accepted request in memory. Keep
// the admitted body small enough that parser/object overhead cannot turn one
// upload into an unbounded resident-memory spike before validation runs.
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 12;
export const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 256 * 1024;
export const MAX_GEMINI_MONITOR_BYTES = 64 * 1024;
export const MAX_ACTIVE_ARTIFACT_STREAMS = 4;
export const ARTIFACT_STREAM_CHUNK_BYTES = 64 * 1024;
export const ARTIFACT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;
const STUDIO_RUNTIME_DIR = join(WORKSPACE_DIR, ".runtime");
export const STUDIO_TOKEN_PATH = join(STUDIO_RUNTIME_DIR, "studio-token");
const STUDIO_SERVER_LEASE_FILENAME = "studio-server.lock";
const STUDIO_SERVER_LEASE_STATE_BYTES = 33;
const STUDIO_SERVER_LEASE_UNMIGRATED = Buffer.alloc(STUDIO_SERVER_LEASE_STATE_BYTES, 0);
const STUDIO_SERVER_LEASE_PATH_BOUND = 2;
const STUDIO_SERVER_LEASE_MIGRATED = 1;

function studioServerTokenPathHash(tokenPath) {
  return createHash("sha256").update(resolve(tokenPath), "utf8").digest();
}

function studioServerLeaseState(status, tokenPathHash) {
  if (![STUDIO_SERVER_LEASE_PATH_BOUND, STUDIO_SERVER_LEASE_MIGRATED].includes(status)) {
    throw new Error("Studio server lease protocol status가 유효하지 않습니다.");
  }
  if (!Buffer.isBuffer(tokenPathHash) || tokenPathHash.byteLength !== 32) {
    throw new Error("Studio server token path hash가 유효하지 않습니다.");
  }
  return Buffer.concat([Buffer.from([status]), tokenPathHash]);
}
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const JOB_LEASE_FILENAME = ".run.lock";
const JOB_LEASE_MAX_BYTES = 16 * 1024;
export const MAX_CONCURRENT_STALE_JOB_RECOVERIES = 4;
const STALE_RUN_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const STALE_RUN_EVENT_MAX_BYTES = 64 * 1024 * 1024;
export const IMMUTABLE_ARTIFACT_POLICY = Object.freeze({
  maximumCount: 64,
  maximumFileBytes: 1024 * 1024 * 1024,
  maximumAggregateBytes: 4 * 1024 * 1024 * 1024,
  maximumConcurrentVerifications: 4,
  maximumVerificationWaiters: 16,
  verificationWaitTimeoutMs: 30_000,
  maximumNameBytes: 4 * 1024
});
const VERIFIED_FILE_HASH_CACHE_LIMIT = 4096;
const verifiedFileHashCache = new Map();
const activeArtifactStreamLimits = new Map();
let activeImmutableArtifactVerifications = 0;
const immutableArtifactVerificationWaiters = [];
let activeMultipartUploads = 0;
const CREATE_JOB_REQUEST_KEYS = new Set([
  "autoStart",
  "captions",
  "clipCount",
  "format",
  "geminiCdpUrl",
  "geminiProfileDir",
  "provider",
  "sources",
  "targetDurationSec",
  "topic",
  "voiceover"
]);
const semanticTransactionBlockedJobIds = new Set();
const localClipTransactionBlockedJobIds = new Set();
const legacyLeaseBlockedJobIds = new Set();
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export { redactGeminiMonitor } from "./gemini-monitor-privacy.mjs";

export function createSessionToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 32) throw new Error("세션 토큰은 최소 32바이트여야 합니다.");
  return randomBytes(bytes).toString("base64url");
}

export function resolveStudioToken(explicitToken = "") {
  const token = String(explicitToken || "");
  if (!token) return createSessionToken();
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (token !== token.trim() || /\s|\p{Cc}|\p{Cs}/u.test(token) || tokenBytes < 32 || tokenBytes > MAX_STUDIO_TOKEN_BYTES) {
    throw new Error(`PS4_STUDIO_TOKEN은 공백 없이 32~${MAX_STUDIO_TOKEN_BYTES}바이트여야 합니다.`);
  }
  return token;
}

function requireStudioToken(token) {
  if (typeof token !== "string" || !token) throw new Error("Studio signing token이 필요합니다.");
  return resolveStudioToken(token);
}

const STUDIO_TOKEN = resolveStudioToken(process.env.PS4_STUDIO_TOKEN);
const LEGACY_LOCAL_PROVIDER_SEMANTICS = "local-input-binding-v1";
const LEGACY_LOCAL_GATE_BLOCKER = "레거시 local 입력 결속은 현재 provider·콘텐츠 의미 증거 gate로 인정되지 않습니다.";

function hasLegacyLocalQualitySemantics(quality) {
  const metrics = quality?.metrics;
  return metrics?.provider === "local"
    && metrics.providerProof === true
    && !Object.hasOwn(metrics, "providerEvidenceEligible");
}

function constantTimeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function artifactCapabilityPayload(jobId, artifactName, expiresAt) {
  return JSON.stringify([ARTIFACT_CAPABILITY_VERSION, expiresAt, jobId, artifactName]);
}

function artifactCapabilityMac(token, jobId, artifactName, expiresAt) {
  return createHmac("sha256", String(token)).update(artifactCapabilityPayload(jobId, artifactName, expiresAt)).digest("base64url");
}

export function createArtifactCapabilityUrl(jobId, artifactName, token, options = {}) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new Error("산출물 capability job ID가 안전하지 않습니다.");
  safeArtifactPath(jobId, artifactName);
  const signingToken = requireStudioToken(token);
  const nowMs = options.nowMs ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? ARTIFACT_CAPABILITY_TTL_SECONDS;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > ARTIFACT_CAPABILITY_TTL_SECONDS) {
    throw new Error("산출물 capability 만료 설정이 안전하지 않습니다.");
  }
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const capability = artifactCapabilityMac(signingToken, jobId, artifactName, expiresAt);
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}?exp=${expiresAt}&cap=${capability}`;
}

export function authorizeArtifactCapabilityRequest(request, url = new URL(request.url), options = {}) {
  const trustedOrigins = options.trustedOrigins || options.allowedOrigins || defaultTrustedStudioOrigins();
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return { ok: false, status: 403, code: "capability-method" };
  if (!isTrustedStudioOrigin(url, trustedOrigins)) return { ok: false, status: 403, code: "untrusted-host" };
  const route = url.pathname.match(/^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/u);
  if (!route) return { ok: false, status: 403, code: "capability-route" };
  let jobId;
  let artifactName;
  try {
    jobId = decodeURIComponent(route[1]);
    artifactName = decodeURIComponent(route[2]);
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("unsafe job id");
    safeArtifactPath(jobId, artifactName);
  } catch {
    return { ok: false, status: 403, code: "capability-route" };
  }
  const keys = [...url.searchParams.keys()];
  const expiresValues = url.searchParams.getAll("exp");
  const capabilityValues = url.searchParams.getAll("cap");
  if (
    keys.length !== 2
    || new Set(keys).size !== 2
    || expiresValues.length !== 1
    || capabilityValues.length !== 1
    || !/^\d{10}$/u.test(expiresValues[0])
    || !/^[A-Za-z0-9_-]{43}$/u.test(capabilityValues[0])
  ) return { ok: false, status: 403, code: "invalid-capability" };
  const expiresAt = Number(expiresValues[0]);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (
    !Number.isSafeInteger(expiresAt)
    || !Number.isSafeInteger(nowSeconds)
    || expiresAt < nowSeconds
    || expiresAt > nowSeconds + ARTIFACT_CAPABILITY_TTL_SECONDS
  ) return { ok: false, status: 403, code: "expired-capability" };
  const expected = artifactCapabilityMac(options.token || "", jobId, artifactName, expiresAt);
  if (!constantTimeTokenEqual(capabilityValues[0], expected)) return { ok: false, status: 403, code: "invalid-capability" };
  return { ok: true, code: "artifact-capability", jobId, artifactName, expiresAt };
}

export function redactJobResponse(job, options = {}) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return job;
  const source = redactStoredGeminiJobFailure(job);
  const { geminiProfileDir: _geminiProfileDir, ...safe } = source;
  const artifacts = [];
  for (const artifact of Array.isArray(safe.artifacts) ? safe.artifacts : []) {
    if (!artifact || typeof artifact !== "object" || typeof artifact.name !== "string" || !artifact.name) continue;
    try {
      safeArtifactPath(source.id, artifact.name);
    } catch {
      continue;
    }
    const capabilityToken = options.artifactCapabilityToken;
    artifacts.push({
      ...artifact,
      // Stored URLs are mutable presentation data, not evidence. Always bind
      // the public destination to this exact job and declared artifact name.
      url: capabilityToken
        ? createArtifactCapabilityUrl(source.id, artifact.name, capabilityToken, options.artifactCapabilityOptions)
        : null
    });
  }
  const sessionBinding = canonicalGeminiSessionBinding(source);
  const semanticRevalidationReadiness = source.integrity?.status === "blocked"
    ? { eligible: false, reason: source.integrity.message || "봉인 run 무결성 검증이 차단되었습니다.", providerRequests: 0 }
    : source.semanticRevalidationSummary?.status === "sealed" && source.semanticRevalidationSummary.childRunId === source.runId
      ? { eligible: false, reason: "현재 run에는 purpose-aware 로컬 의미 재검수가 이미 적용되었습니다.", providerRequests: 0 }
    : source.provider === "gemini-browser" && source.status === "needs-improvement" && source.runStatus === "needs-improvement" && Boolean(source.runId)
      ? { eligible: true, sourceRunId: source.runId, providerRequests: 0, mode: SEMANTIC_REVALIDATION_MODE }
      : source.provider === "local-video" && source.status === "needs-improvement"
        ? { eligible: false, reason: "local-video 완료 영수증의 provider-0 resume 경로는 아직 지원하지 않습니다.", providerRequests: 0 }
        : { eligible: false, reason: "봉인된 개선 필요 Gemini run에서만 로컬 의미 재검수를 시작할 수 있습니다.", providerRequests: 0 };
  const legacyLocalProviderSemantics = safe.provider === "local"
    && Boolean(safe.qualitySummary)
    && (
      safe.status === "completed"
      || safe.runStatus === "verified"
      || (!safe.localClipImport && (safe.status === "needs-improvement" || safe.runStatus === "needs-improvement"))
    );
  const legacyQualitySummary = legacyLocalProviderSemantics ? {
    ...safe.qualitySummary,
    status: "needs-improvement",
    technicalEvidenceGate: false,
    semanticGate: false,
    contentSemanticsVerified: false,
    providerProof: false,
    providerEvidenceEligible: false,
    blockers: [...new Set([...(Array.isArray(safe.qualitySummary?.blockers) ? safe.qualitySummary.blockers : []), LEGACY_LOCAL_GATE_BLOCKER])]
  } : null;
  const projection = {
    ...safe,
    ...(legacyLocalProviderSemantics ? {
      status: "needs-improvement",
      runStatus: "needs-improvement",
      stage: "개선 필요",
      message: "레거시 local 입력 결속만 확인되었습니다. 현재 provider·콘텐츠 의미 증거 gate는 닫혀 있습니다.",
      technicalEvidenceGate: false,
      semanticGate: false,
      contentSemanticsVerified: false,
      providerProof: false,
      providerEvidenceEligible: false,
      legacyProviderProofSemantics: LEGACY_LOCAL_PROVIDER_SEMANTICS,
      legacyRawArtifactAccessBlocked: true,
      qualitySummary: legacyQualitySummary
    } : {}),
    artifacts,
    semanticRevalidationReadiness
  };
  return sessionBinding ? { ...projection, geminiSessionBinding: sessionBinding, geminiSessionBindingHash: geminiSessionBindingHash(source) } : projection;
}

export function projectQualityTruthfulness(quality) {
  const metrics = quality?.metrics;
  const legacyLocalProviderSemantics = hasLegacyLocalQualitySemantics(quality);
  if (!legacyLocalProviderSemantics) return quality;
  return {
    ...quality,
    status: "needs-improvement",
    technicalEvidenceGate: false,
    semanticGate: false,
    contentSemanticsVerified: false,
    providerProof: false,
    providerEvidenceEligible: false,
    blockers: [...new Set([...(Array.isArray(quality.blockers) ? quality.blockers : []), LEGACY_LOCAL_GATE_BLOCKER])],
    legacyProviderProofSemantics: LEGACY_LOCAL_PROVIDER_SEMANTICS,
    legacyRawArtifactAccessBlocked: true,
    metrics: {
      ...metrics,
      technicalEvidenceGate: false,
      contentSemanticsVerified: false,
      providerProof: false,
      providerEvidenceEligible: false,
      legacyProviderProofSemantics: LEGACY_LOCAL_PROVIDER_SEMANTICS
    }
  };
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1" || value === "[::1]") return true;
  const octets = value.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function studioOrigin(hostname, port, protocol = "http:") {
  const host = String(hostname || "");
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`${protocol}//${bracketed}:${Number(port)}`).origin;
}

function defaultTrustedStudioOrigins() {
  return [studioOrigin(DEFAULT_HOST, PORT)];
}

export function isTrustedStudioOrigin(origin, trustedOrigins = defaultTrustedStudioOrigins()) {
  try {
    const url = origin instanceof URL ? origin : new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return Array.isArray(trustedOrigins) && trustedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function bearerValue(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] || "";
}

export function authorizeMutationRequest(request, url = new URL(request.url), options = {}) {
  const token = options.token || "";
  const trustedOrigins = options.trustedOrigins || options.allowedOrigins || defaultTrustedStudioOrigins();
  if (!isTrustedStudioOrigin(url, trustedOrigins)) return { ok: false, status: 403, code: "untrusted-host" };
  const suppliedToken = bearerValue(request);
  if (SAFE_HTTP_METHODS.has(request.method.toUpperCase())) {
    if (!constantTimeTokenEqual(suppliedToken, token)) return { ok: false, status: 403, code: "invalid-session" };
    return { ok: true, code: "safe-bearer" };
  }
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || origin !== url.origin || !isTrustedStudioOrigin(origin, trustedOrigins)) {
    return { ok: false, status: 403, code: "cross-origin" };
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return { ok: false, status: 403, code: "cross-site" };
  if (!constantTimeTokenEqual(suppliedToken, token)) return { ok: false, status: 403, code: "invalid-session" };
  return { ok: true, code: "bearer" };
}

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function plainJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateCreateJobRequest(body) {
  if (!plainJsonObject(body)) throw requestError("작업 생성에는 JSON 객체가 필요합니다.", 400);
  if (Object.keys(body).some((key) => !CREATE_JOB_REQUEST_KEYS.has(key))) {
    throw requestError("작업 생성 요청에 허용되지 않은 필드가 있습니다.", 400);
  }
  if (body.autoStart !== undefined && typeof body.autoStart !== "boolean") throw requestError("autoStart는 boolean이어야 합니다.", 400);
  if (body.autoStart === true) {
    throw requestError("작업 생성은 항상 inert 상태로 완료해야 합니다. 응답의 정확한 job ID를 영속화한 뒤 별도 시작하세요.", 400);
  }
  return body;
}

export function validateUploadBatch(files, limits = {}) {
  const maxFiles = limits.maxFiles ?? MAX_UPLOAD_FILES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_UPLOAD_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES;
  if (!Array.isArray(files) || files.length === 0) throw requestError("업로드할 영상 파일을 선택하세요.", 400);
  if (files.length > maxFiles) throw requestError(`한 번에 최대 ${maxFiles}개 클립만 업로드할 수 있습니다.`, 413);
  let totalBytes = 0;
  for (const file of files) {
    const size = Number(file?.size);
    if (!Number.isSafeInteger(size) || size < 0) throw requestError("업로드 파일 크기가 올바르지 않습니다.", 400);
    if (size > maxFileBytes) throw requestError(`클립 하나의 최대 크기는 ${Math.floor(maxFileBytes / 1024 / 1024)}MB입니다.`, 413);
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw requestError(`클립 전체 크기는 ${Math.floor(maxTotalBytes / 1024 / 1024)}MB를 넘을 수 없습니다.`, 413);
    }
  }
  return { count: files.length, totalBytes };
}

export function validateRequestContentLength(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const raw = request.headers.get("content-length");
  if (raw == null) return null;
  if (!/^\d+$/.test(raw)) throw requestError("Content-Length가 올바르지 않습니다.", 400);
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes)) throw requestError("Content-Length가 올바르지 않습니다.", 400);
  if (bytes > maxBytes) throw requestError("업로드 요청 본문이 허용 크기를 초과했습니다.", 413);
  return bytes;
}

export async function persistStudioToken(token, tokenPath = STUDIO_TOKEN_PATH) {
  const bytes = Buffer.from(`${requireStudioToken(token)}\n`, "utf8");
  const target = resolve(tokenPath);
  const runtimeDir = dirname(target);
  const parentPath = dirname(runtimeDir);
  const runtimeName = basename(runtimeDir);
  const tokenName = basename(target);
  if (!runtimeName || !tokenName || join(runtimeDir, tokenName) !== target || join(parentPath, runtimeName) !== runtimeDir) {
    throw new Error("Studio token 경로가 안전한 parent/leaf 구조가 아닙니다.");
  }

  let parent = null;
  let runtimeFd = null;
  let existingFd = null;
  let expectedIdentity = null;
  let currentParent = null;
  let currentRuntimeFd = null;
  let publishedFd = null;
  try {
    parent = await openJobStorageDirectoryStrict(parentPath);
    try {
      mkdirAt(parent.handle.fd, runtimeName, 0o700);
      syncFd(parent.handle.fd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    runtimeFd = openDirectoryAt(parent.handle.fd, runtimeName);
    const runtimeIdentity = statFd(runtimeFd);
    const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : runtimeIdentity.uid;
    if (
      !runtimeIdentity.isDirectory()
      || (runtimeIdentity.mode & 0o777n) !== 0o700n
      || runtimeIdentity.uid !== expectedUid
    ) throw new Error("Studio runtime은 현재 사용자 소유 mode-0700 non-symlink directory여야 합니다.");

    try {
      existingFd = openFileAt(runtimeFd, tokenName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      expectedIdentity = statFd(existingFd);
      if (
        !expectedIdentity.isFile()
        || expectedIdentity.nlink !== 1n
        || (expectedIdentity.mode & 0o777n) !== 0o600n
        || expectedIdentity.uid !== expectedUid
      ) throw new Error("기존 Studio token은 현재 사용자 소유 mode-0600 single-link regular file이어야 합니다.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      expectedIdentity = null;
    } finally {
      if (existingFd !== null) closeFd(existingFd);
      existingFd = null;
    }

    replaceFileAt(runtimeFd, tokenName, bytes, { mode: 0o600, expectedIdentity });

    currentParent = await openJobStorageDirectoryStrict(parentPath);
    if (!sameFdIdentity(parent.identity, currentParent.identity)) {
      throw new Error("Studio token parent가 publication 중 교체되었습니다.");
    }
    currentRuntimeFd = openDirectoryAt(currentParent.handle.fd, runtimeName);
    if (!sameFdIdentity(runtimeIdentity, statFd(currentRuntimeFd))) {
      throw new Error("Studio runtime이 publication 중 교체되었습니다.");
    }
    publishedFd = openFileAt(currentRuntimeFd, tokenName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const published = statFd(publishedFd);
    const publishedBytes = readFdBuffer(publishedFd, { maxBytes: MAX_STUDIO_TOKEN_BYTES + 1 });
    if (
      !published.isFile()
      || published.nlink !== 1n
      || (published.mode & 0o777n) !== 0o600n
      || published.uid !== expectedUid
      || publishedBytes.byteLength !== bytes.byteLength
      || !timingSafeEqual(publishedBytes, bytes)
    ) throw new Error("published Studio token의 inode·mode·내용 검증에 실패했습니다.");
    syncFd(currentRuntimeFd);
    syncFd(currentParent.handle.fd);
  } finally {
    if (publishedFd !== null) closeFd(publishedFd);
    if (currentRuntimeFd !== null) closeFd(currentRuntimeFd);
    await currentParent?.handle.close().catch(() => {});
    if (existingFd !== null) closeFd(existingFd);
    if (runtimeFd !== null) closeFd(runtimeFd);
    await parent?.handle.close().catch(() => {});
  }
  return target;
}

async function readPersistedStudioTokenStrict(tokenPath) {
  const target = resolve(tokenPath);
  const runtimeDir = dirname(target);
  const parentPath = dirname(runtimeDir);
  const runtimeName = basename(runtimeDir);
  const tokenName = basename(target);
  if (!runtimeName || !tokenName || join(runtimeDir, tokenName) !== target || join(parentPath, runtimeName) !== runtimeDir) {
    throw new Error("Studio token 경로가 안전한 parent/leaf 구조가 아닙니다.");
  }
  const parent = await openJobStorageDirectoryStrict(parentPath);
  let runtimeFd = null;
  let tokenFd = null;
  let currentParent = null;
  let currentRuntimeFd = null;
  let currentTokenFd = null;
  try {
    try {
      runtimeFd = openDirectoryAt(parent.handle.fd, runtimeName);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const runtimeIdentity = statFd(runtimeFd);
    const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : runtimeIdentity.uid;
    if (
      !runtimeIdentity.isDirectory()
      || (runtimeIdentity.mode & 0o777n) !== 0o700n
      || runtimeIdentity.uid !== expectedUid
    ) throw new Error("Studio runtime은 현재 사용자 소유 mode-0700 non-symlink directory여야 합니다.");
    try {
      tokenFd = openFileAt(runtimeFd, tokenName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const before = statFd(tokenFd);
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.uid !== expectedUid
      || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n
      || before.size > BigInt(MAX_STUDIO_TOKEN_BYTES + 1)
    ) throw new Error("기존 Studio token은 현재 사용자 소유의 bounded mode-0600 single-link regular file이어야 합니다.");
    const bytes = readFdBuffer(tokenFd, { maxBytes: MAX_STUDIO_TOKEN_BYTES + 1 });
    const after = statFd(tokenFd);
    if (
      !sameFdIdentity(before, after)
      || before.mode !== after.mode
      || before.uid !== after.uid
      || before.gid !== after.gid
      || before.nlink !== after.nlink
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("기존 Studio token inode가 읽는 동안 변경되었습니다.");

    currentParent = await openJobStorageDirectoryStrict(parentPath);
    if (!sameFdIdentity(parent.identity, currentParent.identity)) throw new Error("Studio token parent가 읽는 동안 교체되었습니다.");
    currentRuntimeFd = openDirectoryAt(currentParent.handle.fd, runtimeName);
    if (!sameFdIdentity(runtimeIdentity, statFd(currentRuntimeFd))) throw new Error("Studio runtime이 token read 중 교체되었습니다.");
    currentTokenFd = openFileAt(currentRuntimeFd, tokenName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!sameFdIdentity(after, statFd(currentTokenFd))) throw new Error("Studio token canonical inode가 읽는 동안 교체되었습니다.");

    let serialized;
    try {
      serialized = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("기존 Studio token이 strict UTF-8이 아닙니다.");
    }
    const value = serialized.endsWith("\n") ? serialized.slice(0, -1) : serialized;
    return requireStudioToken(value);
  } finally {
    if (currentTokenFd !== null) closeFd(currentTokenFd);
    if (currentRuntimeFd !== null) closeFd(currentRuntimeFd);
    await currentParent?.handle.close().catch(() => {});
    if (tokenFd !== null) closeFd(tokenFd);
    if (runtimeFd !== null) closeFd(runtimeFd);
    await parent.handle.close().catch(() => {});
  }
}

async function acquireStudioServerLease(leasePath) {
  const target = resolve(leasePath);
  const runtimeDir = dirname(target);
  const parentPath = dirname(runtimeDir);
  const runtimeName = basename(runtimeDir);
  const leaseName = basename(target);
  if (!runtimeName || join(parentPath, runtimeName) !== runtimeDir) {
    throw new Error("Studio server lease 경로가 안전한 parent/runtime 구조가 아닙니다.");
  }
  const parent = await openJobStorageDirectoryStrict(parentPath);
  let runtimeFd = null;
  let leaseFd = null;
  let locked = false;
  let returned = false;
  try {
    try {
      mkdirAt(parent.handle.fd, runtimeName, 0o700);
      syncFd(parent.handle.fd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    runtimeFd = openDirectoryAt(parent.handle.fd, runtimeName);
    const runtimeIdentity = statFd(runtimeFd);
    const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : runtimeIdentity.uid;
    if (
      !runtimeIdentity.isDirectory()
      || (runtimeIdentity.mode & 0o777n) !== 0o700n
      || runtimeIdentity.uid !== expectedUid
    ) throw new Error("Studio runtime은 현재 사용자 소유 mode-0700 non-symlink directory여야 합니다.");

    try {
      leaseFd = createFileAt(runtimeFd, leaseName, fsConstants.O_RDWR, 0o600, {
        initialBytes: STUDIO_SERVER_LEASE_UNMIGRATED
      });
      syncFd(runtimeFd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      leaseFd = openFileAt(runtimeFd, leaseName, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    }
    const leaseIdentity = statFd(leaseFd);
    if (
      !leaseIdentity.isFile()
      || leaseIdentity.nlink !== 1n
      || leaseIdentity.uid !== expectedUid
      || (leaseIdentity.mode & 0o777n) !== 0o600n
      || leaseIdentity.size !== BigInt(STUDIO_SERVER_LEASE_STATE_BYTES)
    ) throw new Error("Studio server lease는 exact mode-0600 single-link protocol file이어야 합니다.");
    if (!tryLockExclusive(leaseFd)) {
      const error = new Error("Studio server가 이 runtime에서 이미 실행 중입니다.");
      error.code = "STUDIO_SERVER_ALREADY_RUNNING";
      throw error;
    }
    locked = true;

    const currentParent = await openJobStorageDirectoryStrict(parentPath);
    let currentRuntimeFd = null;
    let currentLeaseFd = null;
    try {
      if (!sameFdIdentity(parent.identity, currentParent.identity)) throw new Error("Studio server lease parent가 교체되었습니다.");
      currentRuntimeFd = openDirectoryAt(currentParent.handle.fd, runtimeName);
      if (!sameFdIdentity(runtimeIdentity, statFd(currentRuntimeFd))) throw new Error("Studio runtime이 lease 획득 중 교체되었습니다.");
      currentLeaseFd = openFileAt(currentRuntimeFd, leaseName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      if (!sameFdIdentity(leaseIdentity, statFd(currentLeaseFd))) throw new Error("Studio server lease canonical inode가 교체되었습니다.");
    } finally {
      if (currentLeaseFd !== null) closeFd(currentLeaseFd);
      if (currentRuntimeFd !== null) closeFd(currentRuntimeFd);
      await currentParent.handle.close().catch(() => {});
    }

    const leaseState = readFdBuffer(leaseFd, { maxBytes: STUDIO_SERVER_LEASE_STATE_BYTES });
    const unmigrated = leaseState.byteLength === STUDIO_SERVER_LEASE_STATE_BYTES
      && leaseState.equals(STUDIO_SERVER_LEASE_UNMIGRATED);
    const pathBoundState = leaseState.byteLength === STUDIO_SERVER_LEASE_STATE_BYTES
      && leaseState[0] === STUDIO_SERVER_LEASE_PATH_BOUND;
    const migratedState = leaseState.byteLength === STUDIO_SERVER_LEASE_STATE_BYTES
      && leaseState[0] === STUDIO_SERVER_LEASE_MIGRATED;
    if (!unmigrated && !pathBoundState && !migratedState) {
      throw new Error("Studio server lease protocol state가 유효하지 않습니다.");
    }
    let migrated = migratedState;
    let boundTokenPathHash = pathBoundState || migratedState ? Buffer.from(leaseState.subarray(1)) : null;
    returned = true;
    return {
      fd: leaseFd,
      identity: leaseIdentity,
      get migrated() { return migrated; },
      async assertCurrent() {
        const currentParent = await openJobStorageDirectoryStrict(parentPath);
        let currentRuntimeFd = null;
        let currentLeaseFd = null;
        try {
          if (!sameFdIdentity(parent.identity, currentParent.identity)) throw new Error("Studio server lease parent가 교체되었습니다.");
          currentRuntimeFd = openDirectoryAt(currentParent.handle.fd, runtimeName);
          if (!sameFdIdentity(runtimeIdentity, statFd(currentRuntimeFd))) throw new Error("Studio runtime이 server 시작 중 교체되었습니다.");
          currentLeaseFd = openFileAt(currentRuntimeFd, leaseName, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
          const currentLease = statFd(currentLeaseFd);
          if (
            !sameFdIdentity(leaseIdentity, currentLease)
            || currentLease.nlink !== 1n
            || currentLease.size !== BigInt(STUDIO_SERVER_LEASE_STATE_BYTES)
          ) {
            throw new Error("Studio server lease canonical inode를 재검증할 수 없습니다.");
          }
        } finally {
          if (currentLeaseFd !== null) closeFd(currentLeaseFd);
          if (currentRuntimeFd !== null) closeFd(currentRuntimeFd);
          await currentParent.handle.close().catch(() => {});
        }
      },
      assertTokenPath(tokenPathHash) {
        if (boundTokenPathHash && !timingSafeEqual(boundTokenPathHash, tokenPathHash)) {
          const error = new Error("Studio server singleton이 다른 canonical token 경로에 결속되어 있습니다.");
          error.code = "STUDIO_SERVER_TOKEN_PATH_MISMATCH";
          throw error;
        }
      },
      async bindTokenPath(tokenPathHash) {
        if (boundTokenPathHash) {
          this.assertTokenPath(tokenPathHash);
          return;
        }
        await this.assertCurrent();
        const pathBoundBytes = studioServerLeaseState(STUDIO_SERVER_LEASE_PATH_BOUND, tokenPathHash);
        writeFdBuffer(leaseFd, pathBoundBytes, 0);
        syncFd(leaseFd);
        const exact = readFdBuffer(leaseFd, { maxBytes: STUDIO_SERVER_LEASE_STATE_BYTES });
        if (!exact.equals(pathBoundBytes)) {
          throw new Error("Studio server token 경로 결속을 영속화하지 못했습니다.");
        }
        await this.assertCurrent();
        boundTokenPathHash = Buffer.from(tokenPathHash);
      },
      async markMigrated(tokenPathHash) {
        if (migrated) {
          this.assertTokenPath(tokenPathHash);
          return;
        }
        this.assertTokenPath(tokenPathHash);
        if (!boundTokenPathHash) throw new Error("Studio server token 경로가 migration 전에 결속되지 않았습니다.");
        await this.assertCurrent();
        const migratedBytes = studioServerLeaseState(STUDIO_SERVER_LEASE_MIGRATED, tokenPathHash);
        writeFdBuffer(leaseFd, migratedBytes, 0);
        syncFd(leaseFd);
        const exact = readFdBuffer(leaseFd, { maxBytes: STUDIO_SERVER_LEASE_STATE_BYTES });
        if (!exact.equals(migratedBytes)) {
          throw new Error("Studio server lease migration state를 영속화하지 못했습니다.");
        }
        await this.assertCurrent();
        migrated = true;
        boundTokenPathHash = Buffer.from(tokenPathHash);
      },
      release() {
        if (leaseFd === null) return;
        try { unlock(leaseFd); } finally {
          closeFd(leaseFd);
          leaseFd = null;
          locked = false;
        }
      }
    };
  } finally {
    if (!returned && leaseFd !== null) {
      if (locked) try { unlock(leaseFd); } catch {}
      try { closeFd(leaseFd); } catch {}
    }
    if (runtimeFd !== null) closeFd(runtimeFd);
    await parent.handle.close().catch(() => {});
  }
}

function bindStudioServerLease(server, lease, studioToken, stopServer = (target) => target.stop(true)) {
  let stopPromise = null;
  let proxy = null;
  const stopWithLease = () => {
    if (!stopPromise) {
      stopPromise = Promise.resolve(stopServer(server)).then((result) => {
        lease.release();
        return result;
      });
    }
    return stopPromise;
  };
  proxy = new Proxy(server, {
    get(target, property) {
      if (property === "stop") return stopWithLease;
      if (property === Symbol.dispose) {
        return () => {
          // Symbol.dispose cannot return the shutdown Promise. Attach a
          // secret-free rejection observer so a failed native stop is not an
          // unhandled rejection; keep the original rejected stopPromise so a
          // later explicit stop()/asyncDispose call can still observe it.
          void stopWithLease().catch(() => {
            console.error("Studio server synchronous disposal did not confirm shutdown and singleton lease release.");
          });
        };
      }
      if (property === Symbol.asyncDispose) return stopWithLease;
      if (property === "studioToken") return studioToken;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        const result = value.apply(target, args);
        return result === target ? proxy : result;
      };
    }
  });
  return proxy;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function providerPolicy(provider) {
  if (provider === "gemini-browser") return "no-local-video-fallback";
  if (provider === "local-video") return "local-video-command-adapter-no-fallback";
  if (provider === "local") return "local-upload-edit";
  return null;
}

function immutableRunProvider(manifest) {
  const request = manifest?.request;
  const decision = manifest?.providerDecision;
  const provider = request?.provider;
  const policy = providerPolicy(provider);
  if (
    !policy
    || decision?.requested !== provider
    || decision?.selected !== provider
    || decision?.fallbackUsed !== false
    || decision?.policy !== policy
    || request?.fallbackPolicy !== policy
    || manifest?.providerDecisionHash !== hashJson(decision)
  ) return null;
  return provider;
}

function immutableProviderProvenance(manifest, provider = immutableRunProvider(manifest)) {
  const name = provider === "gemini-browser"
    ? "gemini-generation.json"
    : provider === "local-video" ? `runs/${manifest?.runId}/local-video-generation.json` : null;
  if (!name) return null;
  const artifact = manifest?.immutableArtifacts?.find((entry) => entry?.name === name);
  const expectedPath = `runs/${manifest.runId}/artifacts/${name.replaceAll("/", "__")}`;
  if (!artifact || artifact.path !== expectedPath || !/^sha256:[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))) return null;
  return { path: artifact.path, sha256: artifact.sha256 };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

function errorResponse(error, status = 400) {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}
function qualityErrorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /실행 중|현재 작업|봉인|runId|작업 식별자|실행 산출물/.test(message);
  const explicitStatus = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  return errorResponse(error, explicitStatus || (conflict ? 409 : 400));
}

export async function readJson(request, maximumBytes = MAX_JSON_BODY_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("JSON 본문 상한이 올바르지 않습니다.");
  if ((request.headers.get("content-type") || "").trim().toLowerCase() !== "application/json") {
    throw requestError("JSON 요청은 Content-Type: application/json이 필요합니다.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw requestError("Content-Length가 올바르지 않습니다.", 400);
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes)) throw requestError("Content-Length가 올바르지 않습니다.", 400);
    if (declaredBytes > maximumBytes) throw requestError("JSON 요청 본문이 허용 크기를 초과했습니다.", 413);
  }
  if (!request.body) throw requestError("JSON 요청 본문을 읽지 못했습니다.", 400);
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        await reader.cancel("JSON body limit exceeded").catch(() => {});
        throw requestError("JSON 요청 본문이 허용 크기를 초과했습니다.", 413);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    throw requestError("JSON 요청 본문을 읽지 못했습니다.", 400);
  } finally {
    reader.releaseLock();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
  } catch {
    throw requestError("JSON 요청 본문은 올바른 UTF-8이어야 합니다.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw requestError("JSON 요청 본문을 읽지 못했습니다.", 400);
  }
}
async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const GEMINI_MONITOR_NOT_RUNNING = Object.freeze({
  schemaVersion: 2,
  status: "not-running",
  profiles: Object.freeze([])
});

async function readGeminiMonitorJsonStrict(path, maximumBytes = MAX_GEMINI_MONITOR_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return null;
  const target = resolve(path);
  const parentPath = dirname(target);
  const name = basename(target);
  let parent;
  let fileFd = null;
  let currentParent;
  let currentFileFd = null;
  try {
    // Pin the direct parent as well as the leaf. Reopening both after the
    // bounded same-fd read detects a rename or ancestry swap during the read.
    parent = await openJobStorageDirectoryStrict(parentPath);
    fileFd = openFileAt(
      parent.handle.fd,
      name,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
    const before = statFd(fileFd);
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) return null;
    const fingerprint = fileStatFingerprint(before);
    const bytes = readFdBuffer(fileFd, { maxBytes: maximumBytes });
    const after = statFd(fileFd);
    if (after.nlink !== 1n || fileStatFingerprint(after) !== fingerprint) return null;

    currentParent = await openJobStorageDirectoryStrict(parentPath);
    if (!sameJobStorageDirectoryIdentity(parent.identity, currentParent.identity)) return null;
    currentFileFd = openFileAt(
      currentParent.handle.fd,
      name,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
    const current = statFd(currentFileFd);
    if (!current.isFile() || current.nlink !== 1n || fileStatFingerprint(current) !== fingerprint) return null;

    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plainJsonObject(parsed) || parsed.schemaVersion !== 2 || !Array.isArray(parsed.profiles)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    if (currentFileFd !== null) closeFd(currentFileFd);
    await currentParent?.handle.close().catch(() => {});
    if (fileFd !== null) closeFd(fileFd);
    await parent?.handle.close().catch(() => {});
  }
}

function projectGeminiMonitorOrFailClosed(monitor) {
  if (!monitor) return GEMINI_MONITOR_NOT_RUNNING;
  try {
    const projected = redactGeminiMonitor(monitor);
    return plainJsonObject(projected) && projected.schemaVersion === 2 && Array.isArray(projected.profiles)
      ? projected
      : GEMINI_MONITOR_NOT_RUNNING;
  } catch {
    return GEMINI_MONITOR_NOT_RUNNING;
  }
}
async function readOptionalJsonLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function safeArtifactPath(jobId, filename) {
  const jobRoot = resolve(JOBS_DIR, jobId);
  const target = resolve(jobRoot, filename);
  if (!(target === jobRoot || target.startsWith(`${jobRoot}${sep}`))) throw new Error("허용되지 않은 파일 경로입니다.");
  return target;
}
function sameJobStorageDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
async function openJobStorageDirectoryStrict(path) {
  const pathIdentity = await lstat(path, { bigint: true });
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error("작업 산출물 ancestry가 exact non-symlink directory가 아닙니다.");
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameJobStorageDirectoryIdentity(pathIdentity, identity)) {
      throw new Error("작업 산출물 ancestry가 lstat과 fd open 사이에 교체되었습니다.");
    }
    return { path, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
async function pinJobStorageFileAncestry(path, options = {}) {
  const jobsRoot = resolve(JOBS_DIR);
  const target = resolve(path);
  if (!target.startsWith(`${jobsRoot}${sep}`)) throw new Error("작업 산출물 경로가 jobs root를 벗어납니다.");
  const paths = [];
  let current = dirname(target);
  while (true) {
    paths.push(current);
    if (current === jobsRoot) break;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(`${jobsRoot}${sep}`)) {
      throw new Error("작업 산출물 ancestry가 jobs root에 결속되지 않았습니다.");
    }
    current = parent;
  }
  const snapshots = [];
  let complete = true;
  try {
    for (const directoryPath of paths.reverse()) {
      try {
        snapshots.push(await openJobStorageDirectoryStrict(directoryPath));
      } catch (error) {
        if (options.allowMissing === true && error?.code === "ENOENT") {
          complete = false;
          break;
        }
        throw error;
      }
    }
    return { path: target, snapshots, complete };
  } catch (error) {
    await Promise.all(snapshots.reverse().map((snapshot) => snapshot.handle.close().catch(() => {})));
    throw error;
  }
}
async function closeJobStorageAncestry(ancestry) {
  await Promise.all((ancestry?.snapshots || []).reverse().map((snapshot) => snapshot.handle.close().catch(() => {})));
}
async function assertJobStorageAncestryPinned(ancestry) {
  const current = await pinJobStorageFileAncestry(ancestry.path, { allowMissing: true });
  try {
    if (current.complete !== ancestry.complete || current.snapshots.length !== ancestry.snapshots.length) {
      throw new Error("작업 산출물 ancestry가 처리 중 생성되거나 제거되었습니다.");
    }
    for (let index = 0; index < ancestry.snapshots.length; index += 1) {
      if (
        ancestry.snapshots[index].path !== current.snapshots[index].path
        || !sameJobStorageDirectoryIdentity(ancestry.snapshots[index].identity, current.snapshots[index].identity)
      ) throw new Error("작업 산출물 ancestry가 처리 중 다른 inode로 교체되었습니다.");
    }
  } finally {
    await closeJobStorageAncestry(current);
  }
}
async function readQualityRevisionState(jobId, runId) {
  const boundary = join(JOBS_DIR, jobId, "runs", runId, "revisions", ".read-boundary");
  const ancestry = await pinJobStorageFileAncestry(boundary, { allowMissing: true });
  try {
    if (ancestry.complete) {
      const revisionsDir = dirname(boundary);
      const revisions = await readdir(revisionsDir, { withFileTypes: true });
      for (const revision of revisions) {
        if (!revision.isDirectory() || revision.name.startsWith(".quality-revision-staging-")) continue;
        const revisionDir = join(revisionsDir, revision.name);
        const entries = await readdir(revisionDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const maximumBytes = entry.name === "events.jsonl"
            ? STALE_RUN_EVENT_MAX_BYTES
            : STALE_RUN_MANIFEST_MAX_BYTES;
          if (await boundedExclusiveFileSize(join(revisionDir, entry.name), maximumBytes) === null) {
            throw new Error("품질 revision 산출물이 exclusive regular file 또는 허용 크기 범위가 아닙니다.");
          }
        }
      }
    }
    const state = await readQualityRevisionStateUnchecked(jobId, runId);
    await assertJobStorageAncestryPinned(ancestry);
    return state;
  } finally {
    await closeJobStorageAncestry(ancestry);
  }
}

async function boundedExclusiveFileSize(path, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  let ancestry;
  let handle;
  try {
    ancestry = await pinJobStorageFileAncestry(path, { allowMissing: true });
    if (!ancestry.complete) return null;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) return null;
    await assertJobStorageAncestryPinned(ancestry);
    return Number(before.size);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
    await closeJobStorageAncestry(ancestry);
  }
}

async function boundedVerifiedFileReceipt(path, expectedHash, maximumBytes) {
  const bytes = await boundedExclusiveFileSize(path, maximumBytes);
  if (bytes === null || !(await verifyFileReceipt(path, bytes, expectedHash))) return null;
  return { bytes, sha256: expectedHash };
}
export async function verifyFileReceipt(path, expectedBytes, expectedHash, options = {}) {
  if (!Number.isSafeInteger(Number(expectedBytes)) || Number(expectedBytes) < 0 || !/^sha256:[a-f0-9]{64}$/u.test(String(expectedHash || ""))) return false;
  const openFile = options.openFn || open;
  let handle;
  let ancestry;
  try {
    ancestry = await pinJobStorageFileAncestry(path, { allowMissing: true });
    handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(Number(expectedBytes))) return false;
    const fingerprint = fileStatFingerprint(before);
    await options.afterInitialStat?.({ path, fingerprint });
    const cached = verifiedFileHashCache.get(path);
    if (cached?.fingerprint !== fingerprint || cached.expectedHash !== expectedHash) {
      const actualHash = await hashOpenFileHandle(handle, Number(before.size));
      const afterHash = await handle.stat({ bigint: true });
      if (actualHash !== expectedHash || afterHash.nlink !== 1n || fileStatFingerprint(afterHash) !== fingerprint) {
        verifiedFileHashCache.delete(path);
        return false;
      }
    }
    await options.beforePathIdentityRecheck?.({ path, fingerprint });
    let currentHandle;
    try {
      currentHandle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const current = await currentHandle.stat({ bigint: true });
      if (!current.isFile() || current.nlink !== 1n || fileStatFingerprint(current) !== fingerprint) {
        verifiedFileHashCache.delete(path);
        return false;
      }
    } finally {
      await currentHandle?.close().catch(() => {});
    }
    await assertJobStorageAncestryPinned(ancestry);
    verifiedFileHashCache.set(path, { fingerprint, expectedHash });
    if (verifiedFileHashCache.size > VERIFIED_FILE_HASH_CACHE_LIMIT) {
      verifiedFileHashCache.delete(verifiedFileHashCache.keys().next().value);
    }
    return true;
  } catch {
    verifiedFileHashCache.delete(path);
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await closeJobStorageAncestry(ancestry);
  }
}
function hashResponseBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function snapshotServerEvidenceBuffer(input, options = {}) {
  const buffer = Buffer.from(input);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  const snapshot = {
    buffer,
    bytes: buffer.byteLength,
    sha256: hashResponseBytes(buffer),
    text
  };
  if (options.json === true) snapshot.value = JSON.parse(snapshot.text);
  return snapshot;
}
function parseArtifactByteRange(value, totalBytes) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(value).trim());
  if (!match || totalBytes <= 0 || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixBytes = Number(match[2]);
    if (!Number.isSafeInteger(suffixBytes) || suffixBytes <= 0) return false;
    start = Math.max(0, totalBytes - suffixBytes);
    end = totalBytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : totalBytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalBytes || end < start) return false;
    end = Math.min(end, totalBytes - 1);
  }
  return { start, end };
}
function fileStatFingerprint(fileStat) {
  return [fileStat.dev, fileStat.ino, fileStat.size, fileStat.mtimeNs, fileStat.ctimeNs].join(":");
}
async function hashOpenFileHandle(fileHandle, totalBytes) {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, totalBytes)));
  let position = 0;
  while (position < totalBytes) {
    const length = Math.min(chunk.byteLength, totalBytes - position);
    const { bytesRead } = await fileHandle.read(chunk, 0, length, position);
    if (bytesRead !== length) throw new Error("검증 중 산출물 바이트를 모두 읽지 못했습니다.");
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${digest.digest("hex")}`;
}
async function readOpenFileSlice(fileHandle, start, length) {
  const body = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(body, offset, length - offset, start + offset);
    if (bytesRead <= 0) throw new Error("응답 산출물 바이트를 모두 읽지 못했습니다.");
    offset += bytesRead;
  }
  return body;
}

function acquireArtifactStreamSlot(options = {}) {
  const limit = options.maximumActiveStreams ?? MAX_ACTIVE_ARTIFACT_STREAMS;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("산출물 stream 동시성 상한이 올바르지 않습니다.");
  const current = activeArtifactStreamLimits.get(limit) || 0;
  if (current >= limit) return null;
  activeArtifactStreamLimits.set(limit, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (activeArtifactStreamLimits.get(limit) || 1) - 1);
    if (next === 0) activeArtifactStreamLimits.delete(limit);
    else activeArtifactStreamLimits.set(limit, next);
  };
}

async function prepareVerifiedArtifactStream(path, receipt, rangeHeader = null, options = {}) {
  const releaseSlot = acquireArtifactStreamSlot(options);
  if (!releaseSlot) throw requestError("동시에 읽을 수 있는 산출물 stream 수를 초과했습니다.", 429);
  let ancestry;
  let fileHandle;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await fileHandle?.close().catch(() => {});
    await closeJobStorageAncestry(ancestry);
    releaseSlot();
  };
  try {
    ancestry = await pinJobStorageFileAncestry(path, { allowMissing: true });
    fileHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await fileHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("응답 산출물이 exclusive regular file이 아닙니다.");
    }
    const totalBytes = Number(before.size);
    const fingerprint = fileStatFingerprint(before);
    if (
      !receipt
      || !Number.isSafeInteger(Number(receipt.bytes))
      || Number(receipt.bytes) !== totalBytes
      || !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.sha256 || ""))
    ) throw new Error("stream 응답 산출물 크기·해시 선언이 유효하지 않습니다.");
    const cached = verifiedFileHashCache.get(path);
    if (cached?.fingerprint !== fingerprint || cached.expectedHash !== receipt.sha256) {
      const actualHash = await hashOpenFileHandle(fileHandle, totalBytes);
      const afterHash = await fileHandle.stat({ bigint: true });
      if (actualHash !== receipt.sha256 || afterHash.nlink !== 1n || fileStatFingerprint(afterHash) !== fingerprint) {
        throw new Error("stream 응답 산출물 해시가 선언과 일치하지 않습니다.");
      }
      verifiedFileHashCache.set(path, { fingerprint, expectedHash: receipt.sha256 });
      if (verifiedFileHashCache.size > VERIFIED_FILE_HASH_CACHE_LIMIT) {
        verifiedFileHashCache.delete(verifiedFileHashCache.keys().next().value);
      }
    }
    const range = parseArtifactByteRange(rangeHeader, totalBytes);
    if (range === false) {
      await assertJobStorageAncestryPinned(ancestry);
      await close();
      return { stream: null, range: false, totalBytes };
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(-1, totalBytes - 1);
    const chunkBytes = options.chunkBytes ?? ARTIFACT_STREAM_CHUNK_BYTES;
    const idleTimeoutMs = options.idleTimeoutMs ?? ARTIFACT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw new TypeError("산출물 stream chunk 상한이 올바르지 않습니다.");
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new TypeError("산출물 stream idle timeout이 올바르지 않습니다.");
    await assertJobStorageAncestryPinned(ancestry);
    let position = start;
    let timer = null;
    let controllerRef = null;
    let pulling = false;
    const disarm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      disarm();
      timer = setTimeout(() => {
        const controller = controllerRef;
        void close().finally(() => controller?.error(requestError("산출물 stream 유휴 시간이 초과되었습니다.", 408)));
      }, idleTimeoutMs);
    };
    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        arm();
      },
      async pull(controller) {
        if (pulling || closed) return;
        pulling = true;
        disarm();
        try {
          if (position > end) {
            await close();
            controller.close();
            return;
          }
          const requested = Math.min(chunkBytes, end - position + 1);
          const body = Buffer.allocUnsafe(requested);
          let offset = 0;
          while (offset < requested) {
            const { bytesRead } = await fileHandle.read(body, offset, requested - offset, position + offset);
            if (bytesRead <= 0) throw new Error("stream 응답 산출물 바이트를 모두 읽지 못했습니다.");
            offset += bytesRead;
          }
          position += requested;
          const afterRead = await fileHandle.stat({ bigint: true });
          if (afterRead.nlink !== 1n || fileStatFingerprint(afterRead) !== fingerprint) {
            throw new Error("stream 응답 중 산출물이 변경되었습니다.");
          }
          await assertJobStorageAncestryPinned(ancestry);
          controller.enqueue(body);
          if (position > end) {
            await close();
            controller.close();
          } else {
            arm();
          }
        } catch (error) {
          await close();
          controller.error(error);
        } finally {
          pulling = false;
        }
      },
      async cancel() {
        disarm();
        await close();
      }
    }, { highWaterMark: 0 });
    return { stream, range, totalBytes, contentLength: Math.max(0, end - start + 1) };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createVerifiedArtifactStream(path, receipt, rangeHeader = null, options = {}) {
  return prepareVerifiedArtifactStream(path, receipt, rangeHeader, options);
}

export function immutableArtifactReadLimit(options = { json: true }) {
  return options.json === false ? STALE_RUN_EVENT_MAX_BYTES : STALE_RUN_MANIFEST_MAX_BYTES;
}
export async function readVerifiedArtifactRange(path, receipt, rangeHeader = null) {
  const ancestry = await pinJobStorageFileAncestry(path, { allowMissing: true });
  let fileHandle;
  try {
    fileHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await fileHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("응답 산출물이 exclusive regular file이 아닙니다.");
    const totalBytes = Number(before.size);
    const fingerprint = fileStatFingerprint(before);
    if (receipt) {
      if (
        !Number.isSafeInteger(Number(receipt.bytes))
        || Number(receipt.bytes) !== totalBytes
        || !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.sha256 || ""))
      ) throw new Error("응답 산출물 크기·해시 선언이 유효하지 않습니다.");
      const cached = verifiedFileHashCache.get(path);
      if (cached?.fingerprint !== fingerprint || cached.expectedHash !== receipt.sha256) {
        const actualHash = await hashOpenFileHandle(fileHandle, totalBytes);
        if (actualHash !== receipt.sha256) throw new Error("응답 산출물 해시가 선언과 일치하지 않습니다.");
        const afterHash = await fileHandle.stat({ bigint: true });
        if (afterHash.nlink !== 1n || fileStatFingerprint(afterHash) !== fingerprint) throw new Error("검증 중 응답 산출물이 변경되었습니다.");
        verifiedFileHashCache.set(path, { fingerprint, expectedHash: receipt.sha256 });
        if (verifiedFileHashCache.size > VERIFIED_FILE_HASH_CACHE_LIMIT) {
          verifiedFileHashCache.delete(verifiedFileHashCache.keys().next().value);
        }
      }
    }
    const range = parseArtifactByteRange(rangeHeader, totalBytes);
    if (range === false) {
      await assertJobStorageAncestryPinned(ancestry);
      return { body: null, range: false, totalBytes };
    }
    const start = range ? range.start : 0;
    const length = range ? range.end - range.start + 1 : totalBytes;
    const body = await readOpenFileSlice(fileHandle, start, length);
    const afterRead = await fileHandle.stat({ bigint: true });
    if (afterRead.nlink !== 1n || fileStatFingerprint(afterRead) !== fingerprint) throw new Error("응답 중 산출물이 변경되었습니다.");
    if (!range && receipt && hashResponseBytes(body) !== receipt.sha256) {
      throw new Error("응답 산출물 바이트가 검증된 선언과 일치하지 않습니다.");
    }
    await assertJobStorageAncestryPinned(ancestry);
    return { body, range, totalBytes };
  } finally {
    await fileHandle?.close().catch(() => {});
    await closeJobStorageAncestry(ancestry);
  }
}
async function readRunManifestStrict(runDir) {
  const path = join(runDir, "manifest.json");
  let ancestry;
  let handle;
  try {
    ancestry = await pinJobStorageFileAncestry(path, { allowMissing: true });
    if (!ancestry.complete) {
      await closeJobStorageAncestry(ancestry);
      ancestry = null;
      return { status: "absent", manifest: null, snapshot: null };
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    await closeJobStorageAncestry(ancestry);
    ancestry = null;
    if (error?.code === "ENOENT") return { status: "absent", manifest: null, snapshot: null };
    return { status: "invalid", manifest: null, snapshot: null };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(STALE_RUN_MANIFEST_MAX_BYTES)) {
      return { status: "invalid", manifest: null, snapshot: null };
    }
    const bytes = await readOpenFileSlice(handle, 0, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || fileStatFingerprint(before) !== fileStatFingerprint(after) || BigInt(bytes.byteLength) !== after.size) {
      return { status: "invalid", manifest: null, snapshot: null };
    }
    await assertJobStorageAncestryPinned(ancestry);
    const snapshot = snapshotServerEvidenceBuffer(bytes, { json: true });
    return { status: "present", manifest: snapshot.value, snapshot };
  } catch {
    return { status: "invalid", manifest: null, snapshot: null };
  } finally {
    await handle.close();
    await closeJobStorageAncestry(ancestry);
  }
}
async function readVerifiedImmutableArtifact(job, artifact, expectedName = artifact?.name, options = { json: true }) {
  if (!job?.runId || !artifact?.path || artifact.name !== expectedName) return null;
  const declaredBytes = Number(artifact.bytes);
  const maximumBytes = immutableArtifactReadLimit(options);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maximumBytes) return null;
  const jobRoot = resolve(JOBS_DIR, job.id);
  const expectedPath = `runs/${job.runId}/artifacts/${String(artifact.name).replaceAll("/", "__")}`;
  if (artifact.path !== expectedPath) return null;
  const path = resolve(jobRoot, artifact.path);
  if (!path.startsWith(`${jobRoot}${sep}`)) return null;
  let snapshot;
  try {
    const verified = await readVerifiedArtifactRange(path, { bytes: declaredBytes, sha256: artifact.sha256 });
    snapshot = snapshotServerEvidenceBuffer(verified.body, options);
  } catch {
    return null;
  }
  if (snapshot.bytes !== declaredBytes || snapshot.sha256 !== artifact.sha256) return null;
  return { path, ...snapshot };
}
async function verifyImmutableSemanticRevalidationClosure(job, manifest) {
  if (!manifest?.semanticRevalidation) return true;
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const generationDeclaration = immutableArtifacts.find((artifact) => artifact?.name === "gemini-generation.json");
  const shotName = `runs/${job.runId}/shot-pattern-receipt.json`;
  const shotDeclaration = immutableArtifacts.find((artifact) => artifact?.name === shotName);
  const generation = await readVerifiedImmutableArtifact(job, generationDeclaration, "gemini-generation.json");
  const shot = await readVerifiedImmutableArtifact(job, shotDeclaration, shotName);
  if (!generation?.value || !shot?.value) return false;
  try {
    const source = await loadSemanticRevalidationSource(join(JOBS_DIR, job.id), manifest);
    return verifySemanticRevalidationProviderZeroBinding({
      jobId: job.id,
      runId: job.runId,
      manifest,
      generation: generation.value,
      childGenerationFileHash: generationDeclaration.sha256,
      shotPatternReceipt: shot.value,
      source
    }).verified === true;
  } catch {
    return false;
  }
}

function preflightImmutableArtifactDeclarations(job, immutableArtifacts) {
  if (
    !job
    || !JOB_ID_PATTERN.test(String(job.id || ""))
    || !JOB_ID_PATTERN.test(String(job.runId || ""))
    || !Array.isArray(immutableArtifacts)
    || immutableArtifacts.length < 1
    || immutableArtifacts.length > IMMUTABLE_ARTIFACT_POLICY.maximumCount
  ) return null;
  const jobRoot = resolve(JOBS_DIR, job.id);
  const names = new Set();
  const relativePaths = new Set();
  const prepared = [];
  let aggregateBytes = 0;
  for (const artifact of immutableArtifacts) {
    const name = artifact?.name;
    const bytes = artifact?.bytes;
    const expectedPath = typeof name === "string"
      ? `runs/${job.runId}/artifacts/${name.replaceAll("/", "__")}`
      : null;
    if (
      typeof name !== "string"
      || !name
      || name.includes("\0")
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name)
      || name.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || Buffer.byteLength(name, "utf8") > IMMUTABLE_ARTIFACT_POLICY.maximumNameBytes
      || names.has(name)
      || typeof artifact?.path !== "string"
      || artifact.path !== expectedPath
      || relativePaths.has(artifact.path)
      || !/^sha256:[a-f0-9]{64}$/u.test(String(artifact?.sha256 || ""))
      || !Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > IMMUTABLE_ARTIFACT_POLICY.maximumFileBytes
      || bytes > IMMUTABLE_ARTIFACT_POLICY.maximumAggregateBytes - aggregateBytes
    ) return null;
    const path = resolve(jobRoot, artifact.path);
    if (!path.startsWith(`${jobRoot}${sep}`)) return null;
    names.add(name);
    relativePaths.add(artifact.path);
    aggregateBytes += bytes;
    prepared.push({ artifact, path });
  }
  return { prepared, aggregateBytes };
}

function immutableArtifactVerificationRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImmutableArtifactVerifications = Math.max(0, activeImmutableArtifactVerifications - 1);
    while (immutableArtifactVerificationWaiters.length) {
      const waiter = immutableArtifactVerificationWaiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      activeImmutableArtifactVerifications += 1;
      waiter.resolve(immutableArtifactVerificationRelease());
      break;
    }
  };
}

async function acquireImmutableArtifactVerification({ timeoutMs = IMMUTABLE_ARTIFACT_POLICY.verificationWaitTimeoutMs } = {}) {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > IMMUTABLE_ARTIFACT_POLICY.verificationWaitTimeoutMs
  ) throw new TypeError("불변 산출물 검증 admission timeout이 올바르지 않습니다.");
  if (activeImmutableArtifactVerifications < IMMUTABLE_ARTIFACT_POLICY.maximumConcurrentVerifications) {
    activeImmutableArtifactVerifications += 1;
    return immutableArtifactVerificationRelease();
  }
  if (immutableArtifactVerificationWaiters.length >= IMMUTABLE_ARTIFACT_POLICY.maximumVerificationWaiters) {
    const error = new Error("불변 산출물 검증 대기열이 가득 찼습니다.");
    error.code = "IMMUTABLE_ARTIFACT_VERIFICATION_QUEUE_FULL";
    throw error;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const waiter = { settled: false, resolve: resolvePromise, timer: null };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = immutableArtifactVerificationWaiters.indexOf(waiter);
      if (index >= 0) immutableArtifactVerificationWaiters.splice(index, 1);
      const error = new Error("불변 산출물 검증 실행 슬롯 대기 시간이 초과되었습니다.");
      error.code = "IMMUTABLE_ARTIFACT_VERIFICATION_ADMISSION_TIMEOUT";
      rejectPromise(error);
    }, timeoutMs);
    waiter.timer.unref?.();
    immutableArtifactVerificationWaiters.push(waiter);
  });
}

export async function verifyImmutableArtifactDeclarations(job, immutableArtifacts, options = {}) {
  const preflight = preflightImmutableArtifactDeclarations(job, immutableArtifacts);
  if (!preflight) return false;
  const verifyReceipt = options.verifyFileReceiptFn || verifyFileReceipt;
  if (typeof verifyReceipt !== "function") throw new TypeError("불변 산출물 verifier가 함수가 아닙니다.");
  const admissionTimeoutMs = options.verificationAdmissionTimeoutMs
    ?? IMMUTABLE_ARTIFACT_POLICY.verificationWaitTimeoutMs;
  if (
    !Number.isSafeInteger(admissionTimeoutMs)
    || admissionTimeoutMs < 1
    || admissionTimeoutMs > IMMUTABLE_ARTIFACT_POLICY.verificationWaitTimeoutMs
  ) throw new TypeError("불변 산출물 검증 admission timeout이 올바르지 않습니다.");
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= preflight.prepared.length) return;
      const { artifact, path } = preflight.prepared[index];
      let verified = false;
      let releaseVerification = null;
      try {
        releaseVerification = await acquireImmutableArtifactVerification({ timeoutMs: admissionTimeoutMs });
        if (failed) return;
        verified = await verifyReceipt(path, artifact.bytes, artifact.sha256);
      } catch {
        verified = false;
      } finally {
        releaseVerification?.();
      }
      if (!verified) failed = true;
    }
  };
  const workerCount = Math.min(
    IMMUTABLE_ARTIFACT_POLICY.maximumConcurrentVerifications,
    preflight.prepared.length
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return !failed && cursor >= preflight.prepared.length;
}

async function verifyImmutableRun(job, manifest) {
  const sealedStatus = manifest?.status;
  if (!job?.runId || !manifest || !["completed", "needs-improvement"].includes(sealedStatus) || manifest.jobId !== job.id || manifest.runId !== job.runId || !Array.isArray(manifest.ledgerErrors) || manifest.ledgerErrors.length !== 0) return false;
  if (sealedStatus === "completed" && manifest.runStatus !== "verified") return false;
  if (sealedStatus === "needs-improvement" && manifest.runStatus !== "needs-improvement") return false;
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const names = immutableArtifacts.map((artifact) => artifact?.name).filter(Boolean);
  const expectedPath = (name) => `runs/${job.runId}/artifacts/${String(name).replaceAll("/", "__")}`;
  const requiredNames = [
    "final.mp4",
    "captions.srt",
    "script.json",
    "thumbnail.jpg",
    "quality.json",
    "frame-audio-caption.json",
    "sources.json",
    `runs/${job.runId}/events.jsonl`,
    `runs/${job.runId}/input-manifest.json`,
    `runs/${job.runId}/benchmarks/channel-analysis.json`,
    `runs/${job.runId}/benchmarks/shorts-metadata.json`,
    `runs/${job.runId}/benchmarks/rlm-benchmark-analysis.json`
  ];
  const shotPatternManifestSignal = Boolean(manifest.shotPatterns || manifest.script?.shotPatterns);
  if (shotPatternManifestSignal) {
    if (!manifest.shotPatterns || !manifest.script?.shotPatterns) return false;
    requiredNames.push(`runs/${job.runId}/shot-pattern-receipt.json`);
  }
  if (new Set(names).size !== names.length || !requiredNames.every((name) => names.includes(name))) return false;
  return await verifyImmutableArtifactDeclarations(job, immutableArtifacts)
    && await verifyImmutableSemanticRevalidationClosure(job, manifest);
}
async function verifyRevisionJobDeclarations(job, state) {
  const prefix = `runs/${job.runId}/revisions/`;
  const declared = (job.artifacts || []).filter((artifact) => String(artifact?.name || "").startsWith(prefix));
  if (new Set(declared.map((artifact) => artifact.name)).size !== declared.length) return false;
  const expected = new Map();
  for (const record of state.revisions) {
    const { manifest, manifestHash } = record;
    const manifestPath = `${prefix}${manifest.revisionId}/manifest.json`;
    const manifestDeclarations = declared.filter((artifact) => artifact?.name === manifestPath);
    if (manifestDeclarations.length !== 1) return false;
    const manifestDeclaration = manifestDeclarations[0];
    if (
      manifestDeclaration.sha256 !== manifestHash
      || !Number.isSafeInteger(Number(manifestDeclaration.bytes))
      || Number(manifestDeclaration.bytes) < 0
      || Number(manifestDeclaration.bytes) > STALE_RUN_MANIFEST_MAX_BYTES
      || !(await verifyFileReceipt(resolve(JOBS_DIR, job.id, manifestPath), manifestDeclaration.bytes, manifestHash))
    ) return false;
    expected.set(manifestPath, { sha256: manifestHash, bytes: Number(manifestDeclaration.bytes) });
    for (const declaration of [manifest.committeeReview, manifest.quality, manifest.events]) {
      const maximumBytes = declaration === manifest.events ? STALE_RUN_EVENT_MAX_BYTES : STALE_RUN_MANIFEST_MAX_BYTES;
      if (
        !Number.isSafeInteger(Number(declaration?.bytes))
        || Number(declaration.bytes) < 0
        || Number(declaration.bytes) > maximumBytes
        || !(await verifyFileReceipt(resolve(JOBS_DIR, job.id, declaration.path), declaration.bytes, declaration.sha256))
      ) return false;
      expected.set(declaration.path, { sha256: declaration.sha256, bytes: declaration.bytes });
    }
  }
  if (declared.length !== expected.size) return false;
  return declared.every((artifact) => {
    const receipt = expected.get(artifact.name);
    return receipt
      && artifact.sha256 === receipt.sha256
      && Number(artifact.bytes) === Number(receipt.bytes);
  });
}

export function providerMotionClosureBound(provider, metrics, inputManifest) {
  if (!["gemini-browser", "local-video"].includes(provider)) return true;
  const schemaVersion = Number(inputManifest?.schemaVersion);
  if ([1, 2].includes(schemaVersion)) {
    return !Object.hasOwn(metrics || {}, "inputMotionGate")
      && !Object.hasOwn(metrics || {}, "inputMotionGateBinding");
  }
  return Number.isInteger(schemaVersion)
    && schemaVersion >= 3
    && metrics?.inputMotionGateBinding === true
    && metrics.inputMotionGate?.approvedProvider === true
    && metrics.inputMotionGate.enforced === true
    && metrics.inputMotionGate.enforcementPass === true
    && inputManifest.motionGate?.provider === provider
    && inputManifest.motionGate.approvedProvider === true
    && inputManifest.motionGate.enforced === true
    && inputManifest.motionGate.enforcementPass === true;
}

export function providerDiversityClosureBound(provider, metrics, inputManifest) {
  if (!["gemini-browser", "local-video"].includes(provider)) return true;
  const schemaVersion = Number(inputManifest?.schemaVersion);
  if (schemaVersion === 1) {
    return !Object.hasOwn(metrics || {}, "inputDiversityBinding");
  }
  return Number.isInteger(schemaVersion)
    && schemaVersion >= 2
    && metrics?.inputDiversityBinding === true;
}

export function immutableProviderClosureBound(provider, quality, manifest, inputManifest) {
  const metrics = quality?.metrics || {};
  const immutableNames = new Set((manifest?.immutableArtifacts || []).map((artifact) => artifact?.name));
  const shotPatternName = `runs/${manifest?.runId}/shot-pattern-receipt.json`;
  const shotPatternMetricDeclared = Object.hasOwn(metrics, "shotPatternReceiptBinding");
  const shotPatternExpected = Boolean(manifest?.shotPatterns || manifest?.script?.shotPatterns || shotPatternMetricDeclared);
  const shotPatternArtifact = manifest?.immutableArtifacts?.find((artifact) => artifact?.name === shotPatternName);
  const geminiGenerationArtifact = manifest?.immutableArtifacts?.find((artifact) => artifact?.name === "gemini-generation.json");
  const shotPatternMetric = metrics.shotPatternReceipt;
  const shotPatternReferenceFields = [
    "path",
    "sha256",
    "receiptHash",
    "catalogId",
    "catalogHash",
    "continuityContractHash",
    "segmentCount",
    "applicationMode",
    "providerEligible",
    "providerSubmissionPlanned",
    "submittedToProvider",
    "providerRequestSentThisRun",
    "inheritedProviderSubmission",
    "sourceSubmissionRunId",
    "sourceGenerationHash",
    "providerRequestHash",
    "providerGenerationHash"
  ];
  const shotPatternClosureBound = !shotPatternExpected || Boolean(
    manifest?.shotPatterns
    && manifest?.script?.shotPatterns
    && metrics.shotPatternReceiptBinding === true
    && immutableNames.has(shotPatternName)
    && manifest.shotPatterns.path === shotPatternName
    && manifest.shotPatterns.sha256 === shotPatternArtifact?.sha256
    && shotPatternMetric?.path === shotPatternName
    && shotPatternMetric.sha256 === shotPatternArtifact?.sha256
    && shotPatternMetric.receiptHash === manifest.shotPatterns.receiptHash
    && shotPatternMetric.catalogId === manifest.shotPatterns.catalogId
    && shotPatternMetric.applicationMode === manifest.shotPatterns.applicationMode
    && shotPatternMetric.submittedToProvider === manifest.shotPatterns.submittedToProvider
    && shotPatternMetric.segmentCount === manifest.shotPatterns.segmentCount
    && metrics.evidenceHashes?.[shotPatternName] === shotPatternArtifact?.sha256
    && shotPatternReferenceFields.every((field) => (
      JSON.stringify(manifest.shotPatterns[field]) === JSON.stringify(manifest.script.shotPatterns[field])
    ))
  );
  const semanticRevalidationClosureBound = !manifest?.semanticRevalidation || Boolean(
    metrics.semanticRevalidationProviderZeroBinding === true
    && metrics.semanticRevalidationProviderZero?.verified === true
    && metrics.semanticRevalidationProviderZero.sourceRunId === manifest.semanticRevalidation.sourceRunId
    && metrics.semanticRevalidationProviderZero.parentManifestHash === manifest.semanticRevalidation.parentManifestHash
    && metrics.semanticRevalidationProviderZero.sourceGenerationFileHash === manifest.semanticRevalidation.sourceProviderProvenance?.sha256
    && metrics.semanticRevalidationProviderZero.childGenerationHash === manifest.semanticRevalidation.childGenerationHash
    && metrics.semanticRevalidationProviderZero.childGenerationFileHash === geminiGenerationArtifact?.sha256
  );
  const geminiSubmissionLineageClosureBound = provider !== "gemini-browser" || Boolean(
    metrics.geminiSubmissionLineageBinding === true
    && canonicalJsonHash(metrics.geminiSubmissionLineage || null) === canonicalJsonHash(manifest?.geminiSubmissionLineage || null)
  );
  if (provider === "gemini-browser") {
    return metrics.provider === "gemini-browser"
      && metrics.providerProof === true
      && metrics.generationProvenance === true
      && metrics.generationClipBinding === true
      && metrics.providerDecisionBinding === true
      && metrics.providerDecisionEventBinding === true
      && providerMotionClosureBound(provider, metrics, inputManifest)
      && providerDiversityClosureBound(provider, metrics, inputManifest)
      && metrics.inputManifestBinding === true
      && immutableNames.has("gemini-generation.json")
      && geminiSubmissionLineageClosureBound
      && shotPatternClosureBound
      && semanticRevalidationClosureBound;
  }
  if (provider === "local-video") {
    const receiptName = `runs/${manifest.runId}/local-video-generation.json`;
    return metrics.provider === "local-video"
      && metrics.providerProof === true
      && metrics.providerGenerationProvenance === true
      && metrics.localVideoModelBinding === true
      && metrics.localVideoClipBinding === true
      && metrics.localVideoReceiptBinding === true
      && providerMotionClosureBound(provider, metrics, inputManifest)
      && providerDiversityClosureBound(provider, metrics, inputManifest)
      && metrics.inputManifestBinding === true
      && immutableNames.has(receiptName)
      && manifest.providerReceipt?.path === receiptName
      && manifest.providerReceipt.sha256 === manifest.immutableArtifacts.find((artifact) => artifact?.name === receiptName)?.sha256
      && shotPatternClosureBound;
  }
  const localClipReceiptName = `runs/${manifest?.runId}/local-clip-import.json`;
  const localClipReceiptArtifact = manifest?.immutableArtifacts?.find((artifact) => artifact?.name === localClipReceiptName);
  const localClipImportExpected = Boolean(manifest?.localClipImportReceipt || manifest?.request?.localClipImport || inputManifest?.localClipImport);
  const localClipImportClosureBound = !localClipImportExpected || Boolean(
    metrics.inputManifestBinding === true
    && immutableNames.has(localClipReceiptName)
    && manifest.localClipImportReceipt?.path === localClipReceiptName
    && manifest.localClipImportReceipt.sha256 === localClipReceiptArtifact?.sha256
    && manifest.localClipImportReceipt.receiptHash === manifest.request?.localClipImport?.receiptHash
    && manifest.localClipImportReceipt.receiptHash === inputManifest?.localClipImport?.receiptHash
    && manifest.localClipImportReceipt.setHash === manifest.request?.localClipImport?.setHash
    && manifest.localClipImportReceipt.setHash === inputManifest?.localClipImport?.setHash
    && manifest.localClipImportReceipt.source === "manual-user-upload"
    && manifest.localClipImportReceipt.providerEvidenceEligible === false
    && manifest.request?.localClipImport?.providerEvidenceEligible === false
    && inputManifest?.localClipImport?.providerEvidenceEligible === false
  );
  const truthfulLocalProviderShape = metrics.providerProof === false
    && metrics.providerEvidenceEligible === false;
  const historicalLocalProviderShape = !localClipImportExpected
    && metrics.providerProof === true
    && !Object.hasOwn(metrics, "providerEvidenceEligible");
  return provider === "local"
    && metrics.provider === "local"
    && (truthfulLocalProviderShape || historicalLocalProviderShape)
    && shotPatternClosureBound
    && localClipImportClosureBound;
}

async function verifyImmutableGeminiSubmissionLineage(job, provider, quality, manifest) {
  if (provider !== "gemini-browser") return true;
  const metrics = quality?.metrics || {};
  if (
    metrics.geminiSubmissionLineageBinding !== true
    || canonicalJsonHash(metrics.geminiSubmissionLineage || null) !== canonicalJsonHash(manifest?.geminiSubmissionLineage || null)
  ) return false;
  const artifacts = Array.isArray(manifest?.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const generationDeclaration = artifacts.find((artifact) => artifact?.name === "gemini-generation.json");
  const generationSnapshot = await readVerifiedImmutableArtifact(job, generationDeclaration, "gemini-generation.json");
  if (!generationSnapshot?.value) return false;
  const sourceName = geminiSourceGenerationEvidenceName(job.runId);
  const sourceReceipt = manifest?.geminiSubmissionLineage?.sourceGenerationReceipt;
  const sourceDeclaration = sourceReceipt?.path === sourceName
    ? artifacts.find((artifact) => artifact?.name === sourceName) || null
    : null;
  const sourceSnapshot = sourceDeclaration
    ? await readVerifiedImmutableArtifact(job, sourceDeclaration, sourceName)
    : null;
  if (sourceDeclaration && metrics.evidenceHashes?.[sourceName] !== sourceDeclaration.sha256) return false;
  return verifyGeminiSubmissionLineageClosure({
    generation: generationSnapshot.value,
    runId: job.runId,
    manifestLineage: manifest.geminiSubmissionLineage,
    sourceSnapshot,
    sourceDeclaration
  });
}

function shotPatternSegmentLineage(receipt) {
  if (receipt?.schemaVersion < 2 || !Array.isArray(receipt?.segments)) return undefined;
  return receipt.segments.map((segment) => ({
    index: segment.index,
    providerRequestSentThisRun: segment.providerRequestSentThisRun,
    inheritedProviderSubmission: segment.inheritedProviderSubmission,
    submissionRunId: segment.submissionRunId,
    sourceRunId: segment.sourceRunId,
    sourceGenerationHash: segment.sourceGenerationHash
  }));
}

export async function verifyImmutableShotPatternClosure(job, provider, quality, manifest) {
  const metrics = quality?.metrics || {};
  const immutableArtifacts = Array.isArray(manifest?.immutableArtifacts) ? manifest.immutableArtifacts : [];
  if (!(await verifyImmutableGeminiSubmissionLineage(job, provider, quality, manifest))) return false;
  const scriptDeclaration = immutableArtifacts.find((artifact) => artifact?.name === "script.json");
  const verifiedScript = await readVerifiedImmutableArtifact(job, scriptDeclaration, "script.json");
  if (!verifiedScript?.value) return false;
  const script = verifiedScript.value;
  const required = Boolean(
    script.shotPatternPlan
    || manifest?.shotPatterns
    || manifest?.script?.shotPatterns
    || Object.hasOwn(metrics, "shotPatternReceiptBinding")
  );
  if (!required) return true;
  if (!script.shotPatternPlan || !manifest?.shotPatterns || !manifest?.script?.shotPatterns || metrics.shotPatternReceiptBinding !== true) return false;

  const receiptName = `runs/${job.runId}/shot-pattern-receipt.json`;
  const receiptDeclaration = immutableArtifacts.find((artifact) => artifact?.name === receiptName);
  const verifiedReceipt = await readVerifiedImmutableArtifact(job, receiptDeclaration, receiptName);
  const receipt = verifiedReceipt?.value;
  if (!receipt || !verifyShotPatternReceipt(receipt) || receipt.jobId !== job.id || receipt.runId !== job.runId || receipt.provider !== provider) return false;

  let expectedReceipt;
  try {
    expectedReceipt = createShotPatternReceipt(
      script,
      { id: job.id, provider },
      job.runId,
      provider === "local"
        ? { schemaVersion: receipt.schemaVersion }
        : {
            schemaVersion: receipt.schemaVersion,
            submittedToProvider: true,
            ...(receipt.schemaVersion >= 2 ? {
              providerRequestSentThisRun: receipt.providerRequestSentThisRun,
              inheritedProviderSubmission: receipt.inheritedProviderSubmission,
              sourceSubmissionRunId: receipt.sourceSubmissionRunId,
              sourceGenerationHash: receipt.sourceGenerationHash,
              segmentLineage: shotPatternSegmentLineage(receipt)
            } : {}),
            providerRequestHash: receipt.providerRequestHash,
            providerGenerationHash: receipt.providerGenerationHash
          }
    );
  } catch {
    return false;
  }
  if (hashJson(receipt) !== hashJson(expectedReceipt)) return false;

  const reference = manifest.shotPatterns;
  const nestedReference = manifest.script.shotPatterns;
  const expectedReference = {
    path: receiptName,
    sha256: receiptDeclaration?.sha256,
    receiptHash: receipt.receiptHash,
    catalogId: receipt.catalogId,
    catalogHash: receipt.catalogHash,
    continuityContractHash: receipt.continuityContractHash,
    segmentCount: receipt.segmentCount,
    applicationMode: receipt.applicationMode,
    providerEligible: receipt.providerEligible,
    providerSubmissionPlanned: receipt.providerSubmissionPlanned,
    submittedToProvider: receipt.submittedToProvider,
    ...(receipt.schemaVersion >= 2 ? {
      providerRequestSentThisRun: receipt.providerRequestSentThisRun,
      inheritedProviderSubmission: receipt.inheritedProviderSubmission,
      sourceSubmissionRunId: receipt.sourceSubmissionRunId,
      sourceGenerationHash: receipt.sourceGenerationHash
    } : {}),
    providerRequestHash: receipt.providerRequestHash,
    providerGenerationHash: receipt.providerGenerationHash
  };
  if (hashJson(reference) !== hashJson(expectedReference) || hashJson(nestedReference) !== hashJson(expectedReference)) return false;
  const expectedMetric = {
    path: receiptName,
    sha256: receiptDeclaration?.sha256,
    receiptHash: receipt.receiptHash,
    catalogId: receipt.catalogId,
    applicationMode: receipt.applicationMode,
    submittedToProvider: receipt.submittedToProvider,
    ...(receipt.schemaVersion >= 2 ? {
      providerRequestSentThisRun: receipt.providerRequestSentThisRun,
      inheritedProviderSubmission: receipt.inheritedProviderSubmission,
      sourceSubmissionRunId: receipt.sourceSubmissionRunId,
      sourceGenerationHash: receipt.sourceGenerationHash
    } : {}),
    segmentCount: receipt.segmentCount
  };
  if (hashJson(metrics.shotPatternReceipt) !== hashJson(expectedMetric) || metrics.evidenceHashes?.[receiptName] !== receiptDeclaration?.sha256) return false;

  if (provider === "local") return receipt.submittedToProvider === false;
  const generationName = provider === "gemini-browser"
    ? "gemini-generation.json"
    : provider === "local-video"
      ? `runs/${job.runId}/local-video-generation.json`
      : null;
  if (!generationName) return false;
  const generationDeclaration = immutableArtifacts.find((artifact) => artifact?.name === generationName);
  const verifiedGeneration = await readVerifiedImmutableArtifact(job, generationDeclaration, generationName);
  return Boolean(
    verifiedGeneration?.value
    && receipt.submittedToProvider === true
    && receipt.providerRequestHash === verifiedGeneration.value.requestHash
    && receipt.providerGenerationHash === generationDeclaration?.sha256
  );
}

async function revisionArtifactDeclarations(job, state) {
  const declarations = [];
  const artifactUrl = (path) => `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(path)}`;
  for (const record of state.revisions) {
    const manifest = record.manifest;
    const root = `runs/${job.runId}/revisions/${manifest.revisionId}`;
    const manifestPath = `${root}/manifest.json`;
    const manifestReceipt = await boundedVerifiedFileReceipt(
      resolve(JOBS_DIR, job.id, manifestPath),
      record.manifestHash,
      STALE_RUN_MANIFEST_MAX_BYTES
    );
    if (!manifestReceipt) throw new Error("품질 revision manifest가 exclusive·bounded 영수증과 일치하지 않습니다.");
    const values = [
      [{ path: manifest.committeeReview.path, sha256: manifest.committeeReview.sha256, bytes: manifest.committeeReview.bytes }, "committee-review-revision"],
      [{ path: manifest.quality.path, sha256: manifest.quality.sha256, bytes: manifest.quality.bytes }, "quality-revision"],
      [{ path: manifest.events.path, sha256: manifest.events.sha256, bytes: manifest.events.bytes }, "quality-revision-events"],
      [{ path: manifestPath, sha256: record.manifestHash, bytes: manifestReceipt.bytes }, "quality-revision-manifest"]
    ];
    declarations.push(...values.map(([receipt, kind]) => ({
      name: receipt.path,
      kind,
      bytes: Number(receipt.bytes),
      sha256: receipt.sha256,
      url: artifactUrl(receipt.path)
    })));
  }
  return declarations;
}

function canonicalArtifactUrl(jobId, name) {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
}

function canonicalBaseArtifactDeclarations(job, manifest, manifestSnapshot) {
  if (!manifestSnapshot || manifestSnapshot.value !== manifest) {
    throw new Error("봉인 manifest 선언은 검증된 동일 바이트 snapshot에 결속되어야 합니다.");
  }
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const immutableByName = new Map();
  const immutableDeclarations = immutableArtifacts.map((artifact) => {
    if (
      !artifact
      || typeof artifact.name !== "string"
      || !artifact.name
      || typeof artifact.path !== "string"
      || !artifact.path
      || !Number.isSafeInteger(Number(artifact.bytes))
      || Number(artifact.bytes) < 0
      || !/^sha256:[a-f0-9]{64}$/u.test(String(artifact.sha256 || ""))
      || immutableByName.has(artifact.name)
    ) throw new Error("봉인 manifest의 immutable artifact 선언이 유효하지 않습니다.");
    immutableByName.set(artifact.name, artifact);
    return {
      name: artifact.path,
      kind: `immutable-${artifact.kind || "artifact"}`,
      bytes: Number(artifact.bytes),
      sha256: artifact.sha256,
      url: canonicalArtifactUrl(job.id, artifact.path)
    };
  });

  // Older sealed manifests did not persist the root alias receipt array. Its
  // only trustworthy reconstruction is the immutable declaration itself.
  const rootArtifacts = manifest.artifacts === undefined
    ? immutableArtifacts.map((artifact) => ({
        name: artifact.name,
        path: artifact.name,
        kind: artifact.kind,
        bytes: artifact.bytes,
        sha256: artifact.sha256
      }))
    : manifest.artifacts;
  if (!Array.isArray(rootArtifacts)) throw new Error("봉인 manifest의 root artifact 선언이 배열이 아닙니다.");
  const rootNames = new Set();
  const rootDeclarations = rootArtifacts.map((artifact) => {
    const immutable = immutableByName.get(artifact?.name);
    if (
      !immutable
      || rootNames.has(artifact.name)
      || artifact.path !== artifact.name
      || Number(artifact.bytes) !== Number(immutable.bytes)
      || artifact.sha256 !== immutable.sha256
    ) throw new Error("봉인 manifest의 root artifact가 immutable snapshot과 일치하지 않습니다.");
    safeArtifactPath(job.id, artifact.name);
    rootNames.add(artifact.name);
    return {
      name: artifact.name,
      kind: artifact.kind || immutable.kind || "artifact",
      bytes: Number(immutable.bytes),
      sha256: immutable.sha256,
      url: canonicalArtifactUrl(job.id, artifact.name)
    };
  });
  const manifestName = `runs/${job.runId}/manifest.json`;
  const declarations = [
    ...rootDeclarations,
    ...immutableDeclarations,
    {
      name: manifestName,
      kind: "run-manifest",
      bytes: manifestSnapshot.bytes,
      sha256: manifestSnapshot.sha256,
      url: canonicalArtifactUrl(job.id, manifestName)
    }
  ];
  if (new Set(declarations.map((artifact) => artifact.name)).size !== declarations.length) {
    throw new Error("봉인 base artifact 공개 선언에 중복 경로가 있습니다.");
  }
  return declarations;
}

function canonicalInputManifestReceipt(manifest, inputValue = null) {
  const runId = manifest?.runId;
  const name = `runs/${runId}/input-manifest.json`;
  const declaration = manifest?.immutableArtifacts?.find((artifact) => artifact?.name === name);
  if (!declaration?.sha256 || declaration.path !== `runs/${runId}/artifacts/${name.replaceAll("/", "__")}`) {
    throw new Error("봉인 input manifest immutable 선언이 유효하지 않습니다.");
  }
  const entryCount = Array.isArray(inputValue?.entries) ? inputValue.entries.length : Number(manifest.qualitySummary?.inputManifest?.entryCount);
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) throw new Error("봉인 input manifest entryCount가 유효하지 않습니다.");
  return { path: name, sha256: declaration.sha256, entryCount };
}

function canonicalQualitySummary(quality, inputManifest = null) {
  const summary = {};
  for (const field of ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"]) {
    if (Object.hasOwn(quality || {}, field)) summary[field] = quality[field];
  }
  if (inputManifest) summary.inputManifest = inputManifest;
  return summary;
}

function verifiedTerminalInputManifestReceipt(manifest, quality, inputValue) {
  const canonical = canonicalInputManifestReceipt(manifest, inputValue);
  const provider = quality?.metrics?.provider;
  const storedMetric = quality?.metrics?.inputManifest;
  const storedSummary = manifest?.qualitySummary?.inputManifest;
  const required = ["gemini-browser", "local-video"].includes(provider)
    || storedMetric != null
    || storedSummary != null;
  if (!required) return null;
  if (
    canonicalJsonHash(storedMetric || null) !== canonicalJsonHash(canonical)
    || canonicalJsonHash(storedSummary || null) !== canonicalJsonHash(canonical)
  ) {
    throw new Error("봉인 input manifest 영수증이 quality·run manifest와 정확히 결속되지 않았습니다.");
  }
  return canonical;
}

function expectedTerminalQualitySummary(manifest, state, inputValue = null) {
  const quality = state.latestQuality || state.baseQuality.value;
  const inputManifest = verifiedTerminalInputManifestReceipt(manifest, state.baseQuality.value, inputValue);
  const summary = canonicalQualitySummary(quality, inputManifest);
  if (!state.latestManifest) return summary;
  return {
    ...summary,
    revisionId: state.latestManifest.revisionId,
    revisionSequence: Number(state.latestManifest.sequence),
    revisionManifest: `runs/${state.runId}/revisions/${state.latestManifest.revisionId}/manifest.json`
  };
}

function assertBaseQualitySummaryBound(manifest, state, inputValue) {
  const inputManifest = verifiedTerminalInputManifestReceipt(manifest, state.baseQuality.value, inputValue);
  const expected = canonicalQualitySummary(state.baseQuality.value, inputManifest);
  if (canonicalJsonHash(manifest?.qualitySummary || null) !== canonicalJsonHash(expected)) {
    throw new Error("봉인 run manifest의 base quality 요약이 불변 quality와 정확히 결속되지 않았습니다.");
  }
  return { expected, inputManifest };
}

async function reconcileQualityRevisionJobUnlocked(job) {
  if (!job?.runId) return job;
  const runDir = join(JOBS_DIR, job.id, "runs", job.runId);
  const manifestRead = await readRunManifestStrict(runDir);
  const manifest = manifestRead.manifest;
  if (!manifest || !["completed", "needs-improvement"].includes(manifest.status)) {
    if (["completed", "needs-improvement"].includes(job.status) || ["verified", "needs-improvement"].includes(job.runStatus)) {
      throw new Error("terminal 작업 포인터에 대응하는 봉인 run manifest를 찾지 못했습니다.");
    }
    return job;
  }
  if (!(await verifyImmutableRun(job, manifest))) throw new Error("봉인된 base run의 불변 산출물 무결성 검증에 실패했습니다.");
  const provider = immutableRunProvider(manifest);
  if (!provider) throw new Error("봉인된 base run의 provider 요청·결정 결속이 유효하지 않습니다.");
  const state = await readQualityRevisionState(job.id, job.runId);
  if (state.baseManifestHash !== manifestRead.snapshot?.sha256) {
    throw new Error("봉인 run manifest와 품질 revision base manifest가 동일 바이트에 결속되지 않았습니다.");
  }
  const inputDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/input-manifest.json`);
  const verifiedInput = await readVerifiedImmutableArtifact(job, inputDeclaration, `runs/${job.runId}/input-manifest.json`);
  if (!verifiedInput?.value || !immutableProviderClosureBound(provider, state.baseQuality.value, manifest, verifiedInput.value)) {
    throw new Error("봉인된 base run의 provider 증거 폐쇄가 유효하지 않습니다.");
  }
  assertBaseQualitySummaryBound(manifest, state, verifiedInput.value);
  if (!(await verifyImmutableShotPatternClosure(job, provider, state.baseQuality.value, manifest))) {
    throw new Error("봉인된 base run의 shot pattern 증거 폐쇄가 유효하지 않습니다.");
  }
  const revisionArtifacts = await revisionArtifactDeclarations(job, state);
  const baseArtifacts = canonicalBaseArtifactDeclarations(job, manifest, manifestRead.snapshot);
  const quality = state.latestQuality || state.baseQuality.value;
  const effectiveStatus = state.effectiveStatus;
  const effectiveRunStatus = effectiveStatus === "completed" ? "verified" : "needs-improvement";
  const qualitySummary = expectedTerminalQualitySummary(manifest, state, verifiedInput.value);
  const artifacts = [...baseArtifacts, ...revisionArtifacts];
  const providerProvenance = immutableProviderProvenance(manifest, provider);
  if (["gemini-browser", "local-video"].includes(provider) && !providerProvenance) {
    throw new Error("봉인된 base run의 immutable provider provenance를 찾을 수 없습니다.");
  }
  const desired = { provider, status: effectiveStatus, runStatus: effectiveRunStatus, qualitySummary, artifacts, providerProvenance };
  const current = { provider: job.provider, status: job.status, runStatus: job.runStatus, qualitySummary: job.qualitySummary, artifacts: job.artifacts || [], providerProvenance: job.providerProvenance || null };
  if (canonicalJsonHash(current) === canonicalJsonHash(desired)) return job;
  const latest = await readJob(job.id);
  if (latest.runId !== job.runId || ["running", "verifying"].includes(latest.status)) return latest;
  return updateJob(job.id, {
    ...desired,
    ...(state.latestManifest ? {
      stage: effectiveStatus === "completed" ? "완료" : "개선 필요",
      progress: 100,
      message: effectiveStatus === "completed"
        ? `봉인된 reviewer payload revision 상태를 복구했습니다. (${quality.totalScore}점)`
        : `봉인된 reviewer payload revision 상태를 복구했습니다 · 추가 개선이 필요합니다. (${quality.totalScore}점)`,
      error: null
    } : {})
  });
}

function terminalJobPointer(job) {
  return ["completed", "needs-improvement"].includes(job?.status)
    || ["verified", "needs-improvement"].includes(job?.runStatus);
}

async function assertTerminalRunIntegrity(job) {
  if (!terminalJobPointer(job)) return null;
  if (!job?.runId) throw new Error("terminal 작업 포인터에 현재 runId가 없습니다.");
  if (!JOB_ID_PATTERN.test(job.runId)) throw new Error("현재 runId 형식이 안전하지 않습니다.");
  const runDir = join(JOBS_DIR, job.id, "runs", job.runId);
  const manifestRead = await readRunManifestStrict(runDir);
  const manifest = manifestRead.manifest;
  if (!manifest || !["completed", "needs-improvement"].includes(manifest.status)) {
    throw new Error("terminal 작업 포인터에 대응하는 봉인 run manifest를 찾지 못했습니다.");
  }
  if (!(await verifyImmutableRun(job, manifest))) throw new Error("봉인된 base run의 불변 산출물 무결성 검증에 실패했습니다.");
  const provider = immutableRunProvider(manifest);
  if (!provider) throw new Error("봉인된 base run의 provider 요청·결정 결속이 유효하지 않습니다.");
  const state = await readQualityRevisionState(job.id, job.runId);
  if (state.baseManifestHash !== manifestRead.snapshot?.sha256) {
    throw new Error("봉인 run manifest와 품질 revision base manifest가 동일 바이트에 결속되지 않았습니다.");
  }
  const inputName = `runs/${job.runId}/input-manifest.json`;
  const inputDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === inputName);
  const verifiedInput = await readVerifiedImmutableArtifact(job, inputDeclaration, inputName);
  if (!verifiedInput?.value || !immutableProviderClosureBound(provider, state.baseQuality.value, manifest, verifiedInput.value)) {
    throw new Error("봉인된 base run의 provider 증거 폐쇄가 유효하지 않습니다.");
  }
  assertBaseQualitySummaryBound(manifest, state, verifiedInput.value);
  if (!(await verifyImmutableShotPatternClosure(job, provider, state.baseQuality.value, manifest))) {
    throw new Error("봉인된 base run의 shot pattern 증거 폐쇄가 유효하지 않습니다.");
  }
  const revisionPrefix = `runs/${job.runId}/revisions/`;
  const declaredRevisionArtifacts = (job.artifacts || []).filter((artifact) => String(artifact?.name || "").startsWith(revisionPrefix));
  // A crash may leave a fully sealed append-only revision on disk before the
  // mutable job pointer receives its declarations. Zero declarations are
  // repairable by reconciliation; any partial/contradictory set is not.
  const revisionDeclarationsMatch = declaredRevisionArtifacts.length === 0
    ? state.revisions.length === 0
    : await verifyRevisionJobDeclarations(job, state);
  const expectedProviderProvenance = immutableProviderProvenance(manifest, provider);
  if (["gemini-browser", "local-video"].includes(provider) && !expectedProviderProvenance) {
    throw new Error("봉인된 base run의 immutable provider provenance를 찾을 수 없습니다.");
  }
  const expectedBaseArtifacts = canonicalBaseArtifactDeclarations(job, manifest, manifestRead.snapshot);
  const declaredBaseArtifacts = (job.artifacts || []).filter((artifact) => !String(artifact?.name || "").startsWith(revisionPrefix));
  const baseDeclarationsMatch = canonicalJsonHash(declaredBaseArtifacts) === canonicalJsonHash(expectedBaseArtifacts);
  const expectedStatus = state.effectiveStatus;
  const expectedRunStatus = expectedStatus === "completed" ? "verified" : "needs-improvement";
  const expectedQualitySummary = expectedTerminalQualitySummary(manifest, state, verifiedInput.value);
  const pointerMatches = job.provider === provider
    && job.status === expectedStatus
    && job.runStatus === expectedRunStatus
    && canonicalJsonHash(job.qualitySummary || null) === canonicalJsonHash(expectedQualitySummary || null)
    && canonicalJsonHash(job.providerProvenance || null) === canonicalJsonHash(expectedProviderProvenance || null);
  return {
    manifest,
    manifestSnapshot: manifestRead.snapshot,
    state,
    pointerMatches,
    baseDeclarationsMatch,
    revisionDeclarationsMatch
  };
}

function legacyLocalRawArtifactNames(terminalIntegrity) {
  const state = terminalIntegrity?.state;
  const manifest = terminalIntegrity?.manifest;
  if (!hasLegacyLocalQualitySemantics(state?.baseQuality?.value) || !manifest?.runId) return new Set();
  const names = new Set([`runs/${manifest.runId}/manifest.json`]);
  for (const declaration of manifest.immutableArtifacts || []) {
    if (
      declaration?.name === "quality.json"
      || /^quality\/iteration-\d+\.json$/u.test(String(declaration?.name || ""))
    ) {
      if (typeof declaration.name === "string") names.add(declaration.name);
      if (typeof declaration.path === "string") names.add(declaration.path);
    }
  }
  for (const record of state.revisions || []) {
    const revisionId = record?.manifest?.revisionId;
    const qualityPath = record?.manifest?.quality?.path;
    if (typeof qualityPath === "string") names.add(qualityPath);
    if (typeof revisionId === "string") {
      names.add(`runs/${manifest.runId}/revisions/${revisionId}/quality.json`);
    }
  }
  return names;
}

export async function reconcileQualityRevisionJob(job, options = {}) {
  const terminalPointer = terminalJobPointer(job);
  if (!job?.runId) {
    if (terminalPointer) throw new Error("terminal 작업 포인터에 현재 runId가 없습니다.");
    return job;
  }
  if (!JOB_ID_PATTERN.test(job.runId)) throw new Error("현재 runId 형식이 안전하지 않습니다.");
  const terminalIntegrity = terminalPointer ? await assertTerminalRunIntegrity(job) : null;
  // A caller that already owns the cross-process lease may repair the mutable
  // pointer from the exact sealed state, even when withJob marks it active in
  // this process. Read-only active callers must never bypass mismatches.
  if (options.leaseHeld === true) return reconcileQualityRevisionJobUnlocked(job);
  if (activeJobs.has(job.id)) {
    if (terminalIntegrity && (!terminalIntegrity.pointerMatches || !terminalIntegrity.baseDeclarationsMatch || !terminalIntegrity.revisionDeclarationsMatch)) {
      throw new Error("terminal 작업 포인터가 봉인 품질·revision 상태와 일치하지 않습니다.");
    }
    return job;
  }
  const lease = await acquireJobLease(job.id);
  if (!lease) {
    const latest = await readJob(job.id);
    if (legacyLeaseBlockedJobIds.has(job.id)) return legacyLeaseBlockedJobResponse(latest);
    if (terminalJobPointer(latest)) {
      const latestIntegrity = await assertTerminalRunIntegrity(latest);
      if (!latestIntegrity.pointerMatches || !latestIntegrity.baseDeclarationsMatch || !latestIntegrity.revisionDeclarationsMatch) {
        throw new Error("terminal 작업 포인터가 봉인 품질·revision 상태와 일치하지 않습니다.");
      }
    }
    return latest;
  }
  try {
    const locked = await readJob(job.id);
    if (locked.runId !== job.runId || ["running", "verifying"].includes(locked.status)) return locked;
    return await reconcileQualityRevisionJobUnlocked(locked);
  } finally {
    await releaseJobLease(lease);
  }
}

function integrityBlockedJobResponse(job, options = {}) {
  return {
    ...job,
    integrity: {
      status: "blocked",
      code: options.code || "sealed-run-integrity-failure",
      message: options.message || "봉인된 실행의 무결성 검증에 실패해 자동 복구와 품질 판정을 차단했습니다.",
      mutableJobPreserved: true
    }
  };
}

function semanticTransactionBlockedJobResponse(job) {
  return integrityBlockedJobResponse(job, {
    code: "semantic-transaction-integrity-failure",
    message: "의미 재검수 transaction marker를 안전한 regular file로 확인할 수 없어 이 작업의 자동 복구와 품질 판정을 차단했습니다."
  });
}

function localClipTransactionBlockedJobResponse(job) {
  return integrityBlockedJobResponse(job, {
    code: "local-clip-upload-transaction-integrity-failure",
    message: "로컬 클립 업로드 transaction을 안전하게 복구하지 못해 이 작업의 읽기·실행·변경을 차단했습니다. 다른 작업은 계속 사용할 수 있습니다."
  });
}

function legacyLeaseBlockedJobResponse(job) {
  return integrityBlockedJobResponse(job, {
    code: "legacy-job-lease-migration-required",
    message: "구버전의 내용 있는 job lease를 자동 변경하지 않았습니다. 모든 Studio 프로세스 종료를 확인한 운영자가 원본을 보존하도록 이름을 바꾼 뒤 다시 시도해야 합니다."
  });
}

async function inspectSemanticTransactionRouteBoundary(jobId) {
  try {
    const journal = await readSemanticTransactionStrict(join(JOBS_DIR, jobId));
    if (!journal) {
      semanticTransactionBlockedJobIds.delete(jobId);
      return { blocked: false, journal: null, error: null };
    }
    semanticTransactionBlockedJobIds.add(jobId);
    return {
      blocked: true,
      journal,
      error: new Error("의미 재검수 transaction이 해결될 때까지 이 작업의 접근을 제한합니다.")
    };
  } catch (error) {
    semanticTransactionBlockedJobIds.add(jobId);
    return { blocked: true, journal: null, error };
  }
}

async function inspectLocalClipTransactionRouteBoundary(jobId) {
  try {
    const journal = await readLocalClipUploadTransactionStrict(join(JOBS_DIR, jobId));
    if (!journal) {
      localClipTransactionBlockedJobIds.delete(jobId);
      return { blocked: false, journal: null, error: null };
    }
    localClipTransactionBlockedJobIds.add(jobId);
    return {
      blocked: true,
      journal,
      error: new Error("로컬 클립 업로드 transaction이 해결될 때까지 이 작업의 접근을 제한합니다.")
    };
  } catch (error) {
    localClipTransactionBlockedJobIds.add(jobId);
    return { blocked: true, journal: null, error };
  }
}

export async function reconcileJobsIndependently(jobs, options = {}) {
  const results = [];
  for (const job of jobs) {
    if (localClipTransactionBlockedJobIds.has(job?.id) || options.localClipBlockedJobIds?.has(job?.id)) {
      results.push(localClipTransactionBlockedJobResponse(job));
      continue;
    }
    if (semanticTransactionBlockedJobIds.has(job?.id) || options.blockedJobIds?.has(job?.id)) {
      results.push(semanticTransactionBlockedJobResponse(job));
      continue;
    }
    if (job?.integrity?.status === "blocked") {
      results.push(job);
      continue;
    }
    if (legacyLeaseBlockedJobIds.has(job?.id)) {
      results.push(legacyLeaseBlockedJobResponse(job));
      continue;
    }
    const terminalPointer = ["completed", "needs-improvement"].includes(job?.status)
      || ["verified", "needs-improvement"].includes(job?.runStatus);
    if (options.revisionOnly === true && !terminalPointer && (!job.runId || !existsSync(join(JOBS_DIR, job.id, "runs", job.runId, "revisions")))) {
      results.push(job);
      continue;
    }
    try {
      results.push(await reconcileQualityRevisionJob(job));
    } catch (error) {
      options.onIntegrityError?.(job, error);
      results.push(integrityBlockedJobResponse(job));
    }
  }
  return results;
}

async function readVerifiedQuality(job) {
  if (!["completed", "needs-improvement"].includes(job?.status)) return null;
  const manifestRead = job?.runId
    ? await readRunManifestStrict(join(JOBS_DIR, job.id, "runs", job.runId))
    : { status: "absent", manifest: null, snapshot: null };
  const manifest = manifestRead.manifest;
  if (!(await verifyImmutableRun(job, manifest))) return null;
  const declaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === "quality.json");
  const verified = await readVerifiedImmutableArtifact(job, declaration, "quality.json");
  if (!verified?.value || verified.value.jobId !== job.id || verified.value.runId !== job.runId) return null;
  if (manifest.status === "completed" && (verified.value.status !== "passed" || verified.value.semanticGate !== true)) return null;
  if (manifest.status === "needs-improvement" && (verified.value.status === "passed" || verified.value.semanticGate === true)) return null;
  const provider = immutableRunProvider(manifest);
  if (!provider) return null;
  const inputDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/input-manifest.json`);
  const verifiedInput = await readVerifiedImmutableArtifact(job, inputDeclaration, `runs/${job.runId}/input-manifest.json`);
  if (!verifiedInput?.value || !immutableProviderClosureBound(provider, verified.value, manifest, verifiedInput.value)) return null;
  if (!(await verifyImmutableShotPatternClosure(job, provider, verified.value, manifest))) return null;
  const canonicalInputReceipt = verifiedTerminalInputManifestReceipt(manifest, verified.value, verifiedInput.value);
  const baseSummary = canonicalQualitySummary(verified.value, canonicalInputReceipt);
  const summaryMatches = canonicalJsonHash(manifest.qualitySummary || null) === canonicalJsonHash(baseSummary);
  const eventArtifact = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/events.jsonl`);
  const eventSnapshot = eventArtifact
    ? await readVerifiedImmutableArtifact(job, eventArtifact, eventArtifact.name, { json: false })
    : null;
  let events = null;
  try {
    events = eventSnapshot?.text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) || null;
  } catch {
    events = null;
  }
  const terminal = Array.isArray(events) ? events.at(-1) : null;
  const terminalMatches = Boolean(
    terminal?.type === "quality_finalized"
    && terminal.jobId === job.id
    && terminal.runId === job.runId
    && terminal.status === manifest.runStatus
    && terminal.qualityHash === declaration.sha256
    && canonicalJsonHash(terminal.qualitySummary || null) === canonicalJsonHash(baseSummary)
  );
  if (!summaryMatches || !terminalMatches) return null;
  const state = await readQualityRevisionState(job.id, job.runId).catch(() => null);
  if (
    !state
    || state.baseManifestHash !== manifestRead.snapshot?.sha256
    || !(await verifyRevisionJobDeclarations(job, state))
  ) return null;
  if (!state.latestManifest) {
    const expectedRunStatus = manifest.status === "completed" ? "verified" : "needs-improvement";
    if (
      job.status !== manifest.status
      || job.runStatus !== expectedRunStatus
      || job.provider !== provider
      || job.qualitySummary?.revisionId
      || job.qualitySummary?.revisionSequence
      || job.qualitySummary?.revisionManifest
      || canonicalJsonHash(job.qualitySummary || null) !== canonicalJsonHash(baseSummary)
    ) return null;
    return verified.value;
  }
  const revisionQuality = state.latestQuality;
  const revisionSummary = {
    ...canonicalQualitySummary(revisionQuality, canonicalInputReceipt),
    revisionId: state.latestManifest.revisionId,
    revisionSequence: Number(state.latestManifest.sequence),
    revisionManifest: `runs/${job.runId}/revisions/${state.latestManifest.revisionId}/manifest.json`
  };
  const revisionManifest = state.latestManifest;
  const expectedRunStatus = state.effectiveStatus === "completed" ? "verified" : "needs-improvement";
  if (
    !revisionQuality
    || job.status !== state.effectiveStatus
    || job.provider !== provider
    || job.runStatus !== expectedRunStatus
    || canonicalJsonHash(job.qualitySummary || null) !== canonicalJsonHash(revisionSummary)
  ) return null;
  return revisionQuality;
}

async function readVerifiedQualityHistory(job) {
  const quality = await readVerifiedQuality(job);
  if (!quality) return null;
  const manifestRead = job?.runId
    ? await readRunManifestStrict(join(JOBS_DIR, job.id, "runs", job.runId))
    : { status: "absent", manifest: null };
  const manifest = manifestRead.manifest;
  const declarations = (manifest?.immutableArtifacts || [])
    .filter((artifact) => /^quality\/iteration-\d+\.json$/.test(artifact?.name || ""))
    .sort((left, right) => left.name.localeCompare(right.name));
  const values = [];
  for (const declaration of declarations) {
    const verified = await readVerifiedImmutableArtifact(job, declaration);
    if (verified?.value?.jobId === job.id && verified.value.runId === job.runId) values.push(verified.value);
  }
  const state = await readQualityRevisionState(job.id, job.runId).catch(() => null);
  if (
    !state
    || state.baseManifestHash !== manifestRead.snapshot?.sha256
    || !(await verifyRevisionJobDeclarations(job, state))
  ) return null;
  for (const record of state.revisions) values.push(record.quality);
  return values;
}

function contentType(path) {
  const ext = extname(path).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function withJob(jobId, callback) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  try {
    await callback();
    return true;
  } finally {
    activeJobs.delete(jobId);
  }
}

function isRunningJobPointer(job) {
  return ["running", "verifying"].includes(job?.status);
}
export async function acquireJobLease(jobId, options = {}) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new Error("job lease id가 안전하지 않습니다.");
  const jobDir = join(JOBS_DIR, jobId);
  const lockPath = join(JOBS_DIR, jobId, JOB_LEASE_FILENAME);
  const jobsRootSnapshot = await openJobStorageDirectoryStrict(JOBS_DIR);
  let jobFd = null;
  let lockFd = null;
  let handle = null;
  let acquired = false;
  try {
    jobFd = openDirectoryAt(jobsRootSnapshot.handle.fd, jobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) return null;
    let newlyCreated = false;
    try {
      lockFd = createFileAt(
        jobFd,
        JOB_LEASE_FILENAME,
        fsConstants.O_RDWR,
        0o600
      );
      newlyCreated = true;
      syncFd(jobFd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      lockFd = openFileAt(jobFd, JOB_LEASE_FILENAME, fsConstants.O_RDWR);
    }
    const identity = statFd(lockFd);
    if (!identity.isFile() || identity.nlink !== 1n) return null;
    if (!tryLockExclusive(lockFd)) return null;
    await options.afterLeaseLocked?.({ lockPath, identity });
    await options.beforeStaleLeaseReclaim?.({ lockPath, identity });
    const lockedIdentity = statFd(lockFd);
    if (!lockedIdentity.isFile() || lockedIdentity.nlink !== 1n) return null;
    const currentJobFd = openDirectoryAt(jobsRootSnapshot.handle.fd, jobId);
    let currentIdentity;
    try {
      if (!sameFdIdentity(jobIdentity, statFd(currentJobFd))) return null;
      const currentLockFd = openFileAt(currentJobFd, JOB_LEASE_FILENAME, fsConstants.O_RDONLY);
      try {
        currentIdentity = statFd(currentLockFd);
      } finally {
        closeFd(currentLockFd);
      }
    } finally {
      closeFd(currentJobFd);
    }
    if (
      !currentIdentity
      || !currentIdentity.isFile()
      || !sameFdIdentity(lockedIdentity, currentIdentity)
    ) return null;
    if (!newlyCreated) {
      const existingBytes = readFdBuffer(lockFd, { maxBytes: JOB_LEASE_MAX_BYTES });
      if (existingBytes.byteLength > 0) {
        // Nonempty canonical bytes belong to the legacy existence-based lease
        // protocol. They are never modified automatically: a still-running old
        // binary cannot participate in flock, so takeover would split brain.
        legacyLeaseBlockedJobIds.add(jobId);
        return null;
      }
    }
    legacyLeaseBlockedJobIds.delete(jobId);
    const token = randomUUID();
    handle = {
      fd: lockFd,
      stat: async (options) => options?.bigint ? statFd(lockFd) : fstatSync(lockFd),
      close: async () => closeFd(lockFd)
    };
    const heartbeat = null;
    acquired = true;
    return { handle, heartbeat, lockPath, token, identity: lockedIdentity };
  } catch (error) {
    if (["ENOENT", "EINTR"].includes(error?.code)) return null;
    throw error;
  } finally {
    if (!acquired && lockFd !== null) {
      try { unlock(lockFd); } catch {}
      try { closeFd(lockFd); } catch {}
    }
    if (jobFd !== null) closeFd(jobFd);
    await jobsRootSnapshot.handle.close().catch(() => {});
  }
}

export async function releaseJobLease(lease) {
  if (lease.heartbeat) clearInterval(lease.heartbeat);
  try {
    const heldIdentity = await lease.handle.stat({ bigint: true });
    const currentIdentity = await lstat(lease.lockPath, { bigint: true }).catch(() => null);
    if (!currentIdentity || !sameFdIdentity(heldIdentity, currentIdentity)) {
      throw new Error("job lease canonical inode가 보유 중 교체되어 안전하게 해제할 수 없습니다.");
    }
    // The canonical inode is deliberately permanent. flock unlock/close is the
    // atomic release; never unlink/rename a pathname another process may own.
    unlock(lease.handle.fd);
  } finally {
    await lease.handle.close().catch(() => {});
  }
}

async function assertHeldJobLease(lease) {
  const heldIdentity = await lease.handle.stat({ bigint: true });
  if (!heldIdentity.isFile() || heldIdentity.nlink !== 1n) return false;
  const ancestry = await pinJobStorageFileAncestry(lease.lockPath);
  try {
    const currentHandle = await open(lease.lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const currentIdentity = await currentHandle.stat({ bigint: true });
      if (!sameFdIdentity(heldIdentity, currentIdentity)) return false;
    } finally {
      await currentHandle.close();
    }
    await assertJobStorageAncestryPinned(ancestry);
    return readFdBuffer(lease.handle.fd, { maxBytes: JOB_LEASE_MAX_BYTES }).byteLength === 0;
  } catch {
    return false;
  } finally {
    await closeJobStorageAncestry(ancestry);
  }
}

async function withQualityLease(jobId, callback) {
  if (activeJobs.has(jobId)) return null;
  const lease = await acquireJobLease(jobId);
  if (!lease) return null;
  try {
    const recovered = await recoverRunningJobUnderLease(await readJob(jobId), lease);
    if (!recovered?.runId || isRunningJobPointer(recovered) || recovered.integrity?.status === "blocked") return null;
    const locked = await reconcileQualityRevisionJob(recovered, { leaseHeld: true });
    if (locked.runId !== recovered.runId || isRunningJobPointer(locked) || locked.integrity?.status === "blocked") return null;
    const result = await callback(locked);
    const after = await readJob(jobId);
    if (after.runId !== locked.runId) throw new Error("품질 검사 중 작업 runId가 변경되었습니다.");
    return result;
  } finally {
    await releaseJobLease(lease);
  }
}
async function hasUploadedVideo(jobId) {
  const entries = await readdir(join(JOBS_DIR, jobId, "clips"), { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()));
}
async function rehydrateCompletedRun(job, manifest, manifestSnapshot = null) {
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const expectedPath = (name) => `runs/${job.runId}/artifacts/${String(name).replaceAll("/", "__")}`;
  const sealedStatus = manifest?.status;
  const requiredNames = new Set([
    "final.mp4",
    "captions.srt",
    "script.json",
    "thumbnail.jpg",
    "quality.json",
    "frame-audio-caption.json",
    "sources.json",
    `runs/${job.runId}/events.jsonl`,
    `runs/${job.runId}/input-manifest.json`,
    `runs/${job.runId}/benchmarks/channel-analysis.json`,
    `runs/${job.runId}/benchmarks/shorts-metadata.json`,
    `runs/${job.runId}/benchmarks/rlm-benchmark-analysis.json`
  ]);
  if (!["completed", "needs-improvement"].includes(sealedStatus) || !["running", "verifying", sealedStatus].includes(job.status) || manifest.jobId !== job.id || manifest.runId !== job.runId || immutableArtifacts.length < requiredNames.size || new Set(immutableArtifacts.map((artifact) => artifact?.name)).size !== immutableArtifacts.length || manifest.runStatus === "failed" || !Array.isArray(manifest.ledgerErrors) || manifest.ledgerErrors.length !== 0 || ![...requiredNames].every((name) => immutableArtifacts.some((artifact) => artifact.name === name && artifact.path === expectedPath(name)))) return null;
  if (sealedStatus === "completed" && manifest.runStatus !== "verified") return null;
  if (sealedStatus === "needs-improvement" && manifest.runStatus !== "needs-improvement") return null;
  if (!(await verifyImmutableArtifactDeclarations(job, immutableArtifacts))) return null;
  if (!(await verifyImmutableSemanticRevalidationClosure(job, manifest))) return null;
  const eventArtifact = immutableArtifacts.filter((artifact) => artifact.name === `runs/${job.runId}/events.jsonl` && artifact.path === expectedPath(artifact.name)).at(-1);
  if (!eventArtifact) return null;
  const eventSnapshot = await readVerifiedImmutableArtifact(job, eventArtifact, eventArtifact.name, { json: false });
  if (!eventSnapshot) return null;
  let events;
  try {
    events = eventSnapshot.text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
  const qualityArtifact = immutableArtifacts.find((artifact) => artifact.name === "quality.json" && artifact.path === expectedPath(artifact.name));
  const provider = immutableRunProvider(manifest);
  if (!provider) return null;
  const expectedProviderDecision = {
    requested: provider,
    selected: provider,
    fallbackUsed: false,
    policy: providerPolicy(provider)
  };
  const expectedProviderDecisionHash = hashJson(expectedProviderDecision);
  const providerDecisionEvent = events.find((event) => event.type === "provider_decision");
  const providerDecisionBound = Boolean(
    manifest.providerDecision
    && hashJson(manifest.providerDecision) === expectedProviderDecisionHash
    && manifest.providerDecisionHash === expectedProviderDecisionHash
    && providerDecisionEvent?.jobId === job.id
    && providerDecisionEvent.runId === job.runId
    && providerDecisionEvent.requested === expectedProviderDecision.requested
    && providerDecisionEvent.selected === expectedProviderDecision.selected
    && providerDecisionEvent.fallbackUsed === expectedProviderDecision.fallbackUsed
    && providerDecisionEvent.policy === expectedProviderDecision.policy
    && providerDecisionEvent.decisionHash === expectedProviderDecisionHash
  );
  const qualitySnapshot = qualityArtifact ? await readVerifiedImmutableArtifact(job, qualityArtifact, "quality.json") : null;
  const quality = qualitySnapshot?.value || null;
  if (!quality || quality.jobId !== job.id || quality.runId !== job.runId) return null;
  if (sealedStatus === "completed" && (quality.status !== "passed" || quality.semanticGate !== true)) return null;
  if (sealedStatus === "needs-improvement" && (quality.status === "passed" || quality.semanticGate === true)) return null;
  const immutableByName = new Map(immutableArtifacts.map((artifact) => [artifact?.name, artifact]));
  const readImmutableJson = async (name) => {
    const declaration = immutableByName.get(name);
    if (!declaration) return null;
    return (await readVerifiedImmutableArtifact(job, declaration, name))?.value || null;
  };
  const inputArtifact = await readImmutableJson(`runs/${job.runId}/input-manifest.json`);
  if (!inputArtifact) return null;
  const qualityMetrics = quality.metrics || {};
  if (!immutableProviderClosureBound(provider, quality, manifest, inputArtifact)) return null;
  if (!(await verifyImmutableShotPatternClosure(job, provider, quality, manifest))) return null;
  const scriptArtifact = await readImmutableJson("script.json");
  const shotPatternRequired = Boolean(scriptArtifact?.shotPatternPlan);
  let shotPatternReceipt = null;
  if (shotPatternRequired) {
    const shotPatternName = `runs/${job.runId}/shot-pattern-receipt.json`;
    const shotPatternDeclaration = immutableByName.get(shotPatternName);
    shotPatternReceipt = await readImmutableJson(shotPatternName);
    const shotPatternReference = manifest.shotPatterns;
    const expectedShotPatternReceipt = shotPatternReceipt && createShotPatternReceipt(
      scriptArtifact,
      { id: job.id, provider },
      job.runId,
      provider === "local"
        ? { schemaVersion: shotPatternReceipt.schemaVersion }
        : {
            schemaVersion: shotPatternReceipt.schemaVersion,
            submittedToProvider: true,
            ...(shotPatternReceipt.schemaVersion >= 2 ? {
              providerRequestSentThisRun: shotPatternReceipt.providerRequestSentThisRun,
              inheritedProviderSubmission: shotPatternReceipt.inheritedProviderSubmission,
              sourceSubmissionRunId: shotPatternReceipt.sourceSubmissionRunId,
              sourceGenerationHash: shotPatternReceipt.sourceGenerationHash,
              segmentLineage: shotPatternSegmentLineage(shotPatternReceipt)
            } : {}),
            providerRequestHash: shotPatternReceipt.providerRequestHash,
            providerGenerationHash: shotPatternReceipt.providerGenerationHash
          }
    );
    if (!shotPatternDeclaration || !shotPatternReceipt || !verifyShotPatternReceipt(shotPatternReceipt)
      || hashJson(shotPatternReceipt) !== hashJson(expectedShotPatternReceipt)
      || shotPatternReceipt.jobId !== job.id || shotPatternReceipt.runId !== job.runId
      || shotPatternReceipt.provider !== provider
      || shotPatternReceipt.planHash !== scriptArtifact.shotPatternPlan.planHash
      || shotPatternReceipt.catalogId !== scriptArtifact.shotPatternPlan.catalogId
      || shotPatternReceipt.catalogHash !== scriptArtifact.shotPatternPlan.catalogHash
      || shotPatternReceipt.continuityContractHash !== scriptArtifact.shotPatternPlan.continuityContractHash
      || shotPatternReceipt.segmentCount !== scriptArtifact.shotPatternPlan.segmentCount
      || shotPatternReceipt.segments?.length !== scriptArtifact.segments?.length
      || shotPatternReceipt.evidenceTextBindingHash !== scriptArtifact.evidenceTextBindingHash
      || shotPatternReference?.path !== shotPatternName
      || shotPatternReference.sha256 !== shotPatternDeclaration.sha256
      || shotPatternReference.receiptHash !== shotPatternReceipt.receiptHash
      || shotPatternReference.catalogId !== shotPatternReceipt.catalogId
      || shotPatternReference.catalogHash !== shotPatternReceipt.catalogHash
      || shotPatternReference.continuityContractHash !== shotPatternReceipt.continuityContractHash
      || shotPatternReference.segmentCount !== shotPatternReceipt.segmentCount) return null;
    for (const field of ["applicationMode", "providerEligible", "providerSubmissionPlanned", "submittedToProvider", ...(shotPatternReceipt.schemaVersion >= 2 ? ["providerRequestSentThisRun", "inheritedProviderSubmission", "sourceSubmissionRunId", "sourceGenerationHash"] : []), "providerRequestHash", "providerGenerationHash"]) {
      if (shotPatternReference[field] !== shotPatternReceipt[field]) return null;
    }
    if (qualityMetrics.shotPatternReceiptBinding !== true) return null;
    if (!shotPatternReceipt.segments.every((segment, index) => (
      segment.patternId === scriptArtifact.segments[index]?.shotPattern?.patternId
      && segment.providerVisualPromptHash === scriptArtifact.segments[index]?.shotPattern?.providerVisualPromptHash
      && segment.visualPromptHash === hashJson(scriptArtifact.segments[index]?.visualPrompt)
    ))) return null;
  }
  const inputEntries = Array.isArray(inputArtifact?.entries) ? inputArtifact.entries : [];
  const inputByName = new Map(inputEntries.map((entry) => [entry.name, entry]));
  const clipArtifactBound = (relativePath, sha256) => {
    const clipName = relativePath?.replace(/^clips\//, "");
    const inputEntry = inputByName.get(clipName);
    const declaration = immutableByName.get(relativePath);
    return Boolean(
      clipName
      && inputEntry?.relativePath === relativePath
      && inputEntry.sha256 === sha256
      && declaration?.sha256 === sha256
    );
  };
  if (provider === "local-video") {
    const receipt = await readImmutableJson(`runs/${job.runId}/local-video-generation.json`);
    const scriptHash = hashJson(scriptArtifact);
    const baseRequest = buildLocalVideoRequest({
      id: job.id,
      topic: manifest.request.topic || "",
      format: manifest.request.format || "vertical",
      clipCount: Number(manifest.request.clipCount || scriptArtifact?.segments?.length || 0),
      targetDurationSec: Number(manifest.request.targetDurationSec || 0),
      targetDurationRangeSec: manifest.request.targetDurationRangeSec || null,
      captions: manifest.request.captions !== false,
      voiceover: manifest.request.voiceover !== false,
      createdAt: job.createdAt
    }, scriptArtifact, job.runId, scriptHash);
    const request = withStoredBflAuthorization(baseRequest, receipt);
    const requestHash = baseRequest.requestHash;
    if (
      !receipt
      || !request
      || receipt.status !== "completed"
      || receipt.provider !== "local-video"
      || receipt.jobId !== job.id
      || receipt.runId !== job.runId
      || !String(receipt.model || "").trim()
      || !String(receipt.modelVersion || "").trim()
      || !String(receipt.modelId || "").trim()
      || receipt.requestHash !== requestHash
      || receipt.scriptHash !== scriptHash
      || !receipt.request
      || hashJson(receipt.request) !== hashJson(request)
      || !localVideoProviderRequestBodyClosureBound(receipt, request)
      || shotPatternReceipt?.providerRequestHash !== receipt.requestHash
      || shotPatternReceipt?.providerGenerationHash !== immutableByName.get(`runs/${job.runId}/local-video-generation.json`)?.sha256
      || !Array.isArray(receipt.segments)
      || receipt.segments.length !== inputEntries.length
      || !receipt.segments.every((segment) => clipArtifactBound(segment?.path || segment?.output, segment?.sha256))
    ) return null;
  } else if (provider === "gemini-browser") {
    const generation = await readImmutableJson("gemini-generation.json");
    const expectedGeminiRequest = buildGeminiGenerationRequest({
      topic: manifest.request.topic || "",
      format: manifest.request.format || "vertical",
      clipCount: Number(manifest.request.clipCount || scriptArtifact?.segments?.length || 0),
      targetDurationSec: Number(manifest.request.targetDurationSec || 0),
      targetDurationRangeSec: manifest.request.targetDurationRangeSec || null,
      captions: manifest.request.captions !== false,
      voiceover: manifest.request.voiceover !== false
    }, scriptArtifact);
    const expectedGeminiScriptHash = hashJson(scriptArtifact);
    const expectedGeminiRequestHash = hashJson({ ...expectedGeminiRequest, scriptHash: expectedGeminiScriptHash });
    const expectedGeminiDecision = { requested: "gemini-browser", selected: "gemini-browser", fallbackUsed: false, policy: "no-local-video-fallback" };
    const expectedGeminiDecisionHash = hashJson(expectedGeminiDecision);
    const expectedSessionBinding = manifest.request.geminiSessionBinding;
    const expectedSessionBindingHash = manifest.request.geminiSessionBindingHash;
    const attestation = generation?.providerAttestation;
    if (
      !generation
      || generation.provider !== "gemini-browser"
      || generation.jobId !== job.id
      || generation.runId !== job.runId
      || generation.status !== "completed"
      || !expectedSessionBinding
      || !expectedSessionBindingHash
      || hashJson(expectedSessionBinding) !== expectedSessionBindingHash
      || generation.sessionBindingHash !== expectedSessionBindingHash
      || hashJson(generation.sessionBinding) !== expectedSessionBindingHash
      || Object.hasOwn(generation, "profileDir")
      || Object.hasOwn(generation, "cdpUrl")
      || generation.requestHash !== expectedGeminiRequestHash
      || generation.scriptHash !== expectedGeminiScriptHash
      || shotPatternReceipt?.providerRequestHash !== generation.requestHash
      || shotPatternReceipt?.providerGenerationHash !== immutableByName.get("gemini-generation.json")?.sha256
      || !generation.providerDecision
      || hashJson(generation.providerDecision) !== expectedGeminiDecisionHash
      || generation.providerDecisionHash !== expectedGeminiDecisionHash
      || !generation.request
      || hashJson(generation.request) !== hashJson(expectedGeminiRequest)
      || !attestation
      || attestation.type !== "gemini-chrome-session"
      || attestation.provider !== "gemini-browser"
      || attestation.browser !== generation.browser
      || attestation.sessionBindingHash !== expectedSessionBindingHash
      || hashJson(attestation.sessionBinding) !== expectedSessionBindingHash
      || Object.hasOwn(attestation, "profileDir")
      || Object.hasOwn(attestation, "cdpUrl")
      || attestation.persistentProfile !== true
      || attestation.fallbackUsed !== false
      || generation.providerAttestationHash !== hashJson(attestation)
      || !Array.isArray(generation.segments)
      || !generation.segments.every((segment) => clipArtifactBound(segment?.path || segment?.output, segment?.sha256))
    ) return null;
  }
  const manifestQualitySummary = manifest.qualitySummary;
  const canonicalInputReceipt = verifiedTerminalInputManifestReceipt(manifest, quality, inputArtifact);
  const qualitySummary = canonicalQualitySummary(quality, canonicalInputReceipt);
  const summaryMatches = canonicalJsonHash(manifestQualitySummary || null) === canonicalJsonHash(qualitySummary);
  const terminalEvent = events.at(-1);
  const terminalSummary = terminalEvent?.qualitySummary;
  const terminalEventBound = Boolean(
    terminalEvent?.type === "quality_finalized"
      && terminalEvent.jobId === job.id
      && terminalEvent.runId === job.runId
      && terminalEvent.status === manifest.runStatus
      && terminalEvent.qualityHash === qualityArtifact.sha256
      && canonicalJsonHash(terminalSummary || null) === canonicalJsonHash(qualitySummary)
  );
  if (!providerDecisionBound || !summaryMatches || !terminalEventBound) return null;
  if (!manifestSnapshot || manifestSnapshot.value !== manifest) return null;
  const canonicalArtifacts = canonicalBaseArtifactDeclarations(job, manifest, manifestSnapshot);
  const providerProvenance = immutableProviderProvenance(manifest, provider);
  if (["gemini-browser", "local-video"].includes(provider) && !providerProvenance) return null;
  return updateJob(job.id, {
    provider,
    status: sealedStatus,
    stage: sealedStatus === "completed" ? "완료" : "개선 필요",
    progress: 100,
    message: sealedStatus === "completed"
      ? `영상 제작과 AHP 검사가 완료되었습니다. (${qualitySummary.totalScore}점)`
      : `영상 파일과 기계 검사만 봉인되었습니다 · 의미론 게이트가 닫혀 개선이 필요합니다. (${qualitySummary?.totalScore ?? quality?.totalScore ?? 0}점)`,
    artifacts: canonicalArtifacts,
    duration: quality?.metrics?.finalMedia?.duration ?? job.duration ?? null,
    scriptGeneratedBy: manifest.script?.generatedBy || job.scriptGeneratedBy,
    qualitySummary,
    runId: job.runId,
    runStatus: manifest.runStatus || "needs-improvement",
    providerProvenance,
    ...(manifest.semanticRevalidation ? {
      semanticRevalidationSummary: {
        status: "sealed",
        mode: manifest.semanticRevalidation.mode,
        sourceRunId: manifest.semanticRevalidation.sourceRunId,
        childRunId: manifest.runId,
        semanticPolicy: manifest.semanticRevalidation.semanticPolicy,
        providerRequests: 0
      }
    } : {}),
    error: null
  });
}

function sameStaleRunDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openStaleRunDirectoryStrict(path, label, options = {}) {
  let pathIdentity;
  try {
    pathIdentity = await lstat(path, { bigint: true });
  } catch (error) {
    if (options.allowMissing === true && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error(`stale-run ${label} 경로가 exact non-symlink directory가 아닙니다.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameStaleRunDirectoryIdentity(pathIdentity, identity)) {
      throw new Error(`stale-run ${label} directory가 lstat과 fd open 사이에 교체되었습니다.`);
    }
    return { path, label, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function pinStaleRunAncestry(job) {
  if (!JOB_ID_PATTERN.test(String(job?.id || "")) || !JOB_ID_PATTERN.test(String(job?.runId || ""))) {
    throw new Error("stale-run jobId·runId 경로가 안전하지 않습니다.");
  }
  const jobDir = join(JOBS_DIR, job.id);
  const runsDir = join(jobDir, "runs");
  const runDir = join(runsDir, job.runId);
  const snapshots = [];
  try {
    const jobsRootSnapshot = await openStaleRunDirectoryStrict(JOBS_DIR, "jobs root");
    snapshots.push(jobsRootSnapshot);
    const attachChild = (parent, name, path, label, options = {}) => {
      let fd;
      try {
        fd = openDirectoryAt(parent.handle.fd, name);
      } catch (error) {
        if (options.allowMissing === true && error?.code === "ENOENT") return null;
        throw error;
      }
      const identity = statFd(fd);
      if (!identity.isDirectory()) {
        closeFd(fd);
        throw new Error(`stale-run ${label} entry가 directory가 아닙니다.`);
      }
      return { path, label, identity, handle: { fd, close: async () => closeFd(fd) }, parent, name };
    };
    const jobSnapshot = attachChild(jobsRootSnapshot, job.id, jobDir, "job");
    snapshots.push(jobSnapshot);
    const runsSnapshot = attachChild(jobSnapshot, "runs", runsDir, "runs");
    snapshots.push(runsSnapshot);
    const runSnapshot = attachChild(runsSnapshot, job.runId, runDir, "run", { allowMissing: true });
    if (runSnapshot) snapshots.push(runSnapshot);
    return { jobDir, runsDir, runDir, snapshots, runSnapshot };
  } catch (error) {
    await Promise.all(snapshots.reverse().map((snapshot) => snapshot.handle.close().catch(() => {})));
    throw error;
  }
}

async function assertStaleRunAncestryPinned(ancestry) {
  for (const snapshot of ancestry.snapshots) {
    let current;
    if (snapshot.parent) {
      const fd = openDirectoryAt(snapshot.parent.handle.fd, snapshot.name);
      current = { handle: { close: async () => closeFd(fd) }, identity: statFd(fd) };
    } else {
      current = await openStaleRunDirectoryStrict(snapshot.path, snapshot.label);
    }
    try {
      if (!sameStaleRunDirectoryIdentity(snapshot.identity, current.identity)) {
        throw new Error(`stale-run ${snapshot.label} directory가 복구 중 다른 inode로 교체되었습니다.`);
      }
    } finally {
      await current.handle.close();
    }
  }
}

async function ensurePinnedStaleRunDirectory(ancestry) {
  if (ancestry.runSnapshot) return ancestry.runSnapshot;
  await assertStaleRunAncestryPinned(ancestry);
  const runsSnapshot = ancestry.snapshots.find((snapshot) => snapshot.path === ancestry.runsDir);
  try {
    mkdirAt(runsSnapshot.handle.fd, basename(ancestry.runDir), 0o700);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  syncFd(runsSnapshot.handle.fd);
  const runFd = openDirectoryAt(runsSnapshot.handle.fd, basename(ancestry.runDir));
  const runIdentity = statFd(runFd);
  if (!runIdentity.isDirectory()) {
    closeFd(runFd);
    throw new Error("stale-run published run entry가 directory가 아닙니다.");
  }
  const runSnapshot = {
    path: ancestry.runDir,
    label: "run",
    identity: runIdentity,
    handle: { fd: runFd, close: async () => closeFd(runFd) }
  };
  ancestry.runSnapshot = runSnapshot;
  ancestry.snapshots.push(runSnapshot);
  await assertStaleRunAncestryPinned(ancestry);
  return runSnapshot;
}

async function readPinnedStaleRunManifest(ancestry) {
  if (!ancestry.runSnapshot) return { status: "absent", manifest: null, snapshot: null };
  let bytes;
  try {
    bytes = readFileAt(ancestry.runSnapshot.handle.fd, "manifest.json", { maxBytes: STALE_RUN_MANIFEST_MAX_BYTES });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", manifest: null, snapshot: null };
    throw error;
  }
  try {
    const snapshot = snapshotServerEvidenceBuffer(bytes, { json: true });
    return { status: "present", manifest: snapshot.value, snapshot };
  } catch {
    return { status: "invalid", manifest: null, snapshot: null };
  }
}

function appendPinnedStaleRunEvent(ancestry, event) {
  if (!ancestry.runSnapshot) throw new Error("stale-run directory fd가 고정되지 않았습니다.");
  const record = { timestamp: new Date().toISOString(), ...event };
  appendFileAt(ancestry.runSnapshot.handle.fd, "events.jsonl", `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function readPinnedStaleRunEventBytes(ancestry) {
  if (!ancestry.runSnapshot) throw new Error("stale-run directory fd가 고정되지 않았습니다.");
  return readFileAt(ancestry.runSnapshot.handle.fd, "events.jsonl", { maxBytes: STALE_RUN_EVENT_MAX_BYTES });
}

function writePinnedStaleRunManifest(ancestry, manifest) {
  if (!ancestry.runSnapshot) throw new Error("stale-run directory fd가 고정되지 않았습니다.");
  replaceFileAt(ancestry.runSnapshot.handle.fd, "manifest.json", JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

async function closeStaleRun(job) {
  if (!job.runId) return;
  const ancestry = await pinStaleRunAncestry(job);
  const runDir = ancestry.runDir;
  try {
    await assertStaleRunAncestryPinned(ancestry);
    const manifestRead = await readPinnedStaleRunManifest(ancestry);
    await assertStaleRunAncestryPinned(ancestry);
    const manifest = manifestRead.manifest;
    const recoveredAt = new Date().toISOString();
    if (!manifest) {
      if (manifestRead.status !== "absent") {
        throw new Error("읽을 수 없는 기존 run manifest는 stale-run 복구로 덮어쓸 수 없습니다.");
      }
      await ensurePinnedStaleRunDirectory(ancestry);
      await assertStaleRunAncestryPinned(ancestry);
      writePinnedStaleRunManifest(ancestry, {
        schemaVersion: 1,
        jobId: job.id,
        runId: job.runId,
        status: "failed",
        runStatus: "failed",
        ledgerErrors: [],
        failedAt: recoveredAt,
        artifacts: [],
        immutableArtifacts: [],
        recovery: { type: "stale-lease", recoveredAt, reason: "stale job lease recovered without a readable manifest" }
      });
      await assertStaleRunAncestryPinned(ancestry);
      return;
    }
    if (["completed", "needs-improvement"].includes(manifest.status)) {
      throw new Error("봉인된 terminal run은 stale-run 복구로 변경할 수 없습니다.");
    }
    const alreadyFailed = manifest.status === "failed"
      && manifest.runStatus === "failed"
      && manifest.schemaVersion === 1
      && manifest.jobId === job.id
      && manifest.runId === job.runId
      && Array.isArray(manifest.ledgerErrors);
    // A crash can occur after the run manifest is durably failed but before the
    // mutable job pointer is updated. This is an idempotent completion step: do
    // not rewrite or erase the existing failure evidence.
    if (alreadyFailed) return;
    const recoverableState = manifest.status === "running"
      ? manifest.runStatus === undefined || manifest.runStatus === "running"
      : manifest.status === "finalizing"
        && ["verified", "needs-improvement"].includes(manifest.runStatus);
    if (
      manifest.schemaVersion !== 1
      || manifest.jobId !== job.id
      || manifest.runId !== job.runId
      || !recoverableState
      || !Array.isArray(manifest.ledgerErrors)
    ) throw new Error("현재 작업에 정확히 결속된 running/finalizing manifest만 stale-run 실패로 닫을 수 있습니다.");
    await assertStaleRunAncestryPinned(ancestry);
    appendPinnedStaleRunEvent(ancestry, {
      type: "recovered_stale",
      status: "failed",
      reason: "stale job lease recovered",
      runId: job.runId
    });
    await assertStaleRunAncestryPinned(ancestry);
    const eventBytes = readPinnedStaleRunEventBytes(ancestry);
    writePinnedStaleRunManifest(ancestry, {
      ...manifest,
      status: "failed",
      runStatus: "failed",
      failedAt: recoveredAt,
      artifacts: [],
      immutableArtifacts: [],
      eventLog: { path: `runs/${job.runId}/events.jsonl`, sha256: hashResponseBytes(eventBytes) },
      recovery: {
        type: "stale-lease",
        recoveredAt,
        reason: "stale job lease recovered"
      }
    });
    await assertStaleRunAncestryPinned(ancestry);
  } finally {
    await Promise.all(ancestry.snapshots.reverse().map((snapshot) => snapshot.handle.close().catch(() => {})));
  }
}

async function recoverRunningJobUnderLease(job, lease) {
  let current = null;
  let terminalManifest = null;
  try {
    current = await readJob(job.id).catch(() => null);
    if (!current || !isRunningJobPointer(current)) return current || job;
    if (current.runId && !JOB_ID_PATTERN.test(current.runId)) return integrityBlockedJobResponse(current);
    if (!(await assertHeldJobLease(lease))) return current;
    const runDir = current.runId ? join(JOBS_DIR, current.id, "runs", current.runId) : null;
    const manifestRead = runDir ? await readRunManifestStrict(runDir) : { status: "absent", manifest: null };
    const runManifest = manifestRead.manifest;
    if (!runManifest && manifestRead.status !== "absent") return integrityBlockedJobResponse(current);
    if (runManifest && (runManifest.jobId !== current.id || runManifest.runId !== current.runId)) return integrityBlockedJobResponse(current);
    if (["completed", "needs-improvement"].includes(runManifest?.status)) {
      terminalManifest = runManifest;
      const restored = await rehydrateCompletedRun(current, runManifest, manifestRead.snapshot);
      if (restored) return restored;
      return integrityBlockedJobResponse(current);
    }
    await closeStaleRun(current);
    return await updateJob(current.id, {
      status: "failed",
      stage: "오류",
      message: "이전 실행 프로세스가 종료되어 작업을 중단했습니다. 다시 실행하세요.",
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  } catch (error) {
    const persistedManifest = terminalManifest || (current?.runId
      ? (await readRunManifestStrict(join(JOBS_DIR, current.id, "runs", current.runId))).manifest
      : null);
    if (["completed", "needs-improvement"].includes(persistedManifest?.status)) {
      console.error(`job ${job.id} sealed stale-run rehydration blocked: ${error.message}`);
      return integrityBlockedJobResponse(current || job);
    }
    let closureError = null;
    try {
      await closeStaleRun(current);
    } catch (closeError) {
      closureError = closeError;
    }
    if (closureError) {
      console.error(`job ${job.id} stale-run closure blocked: ${closureError.message}`);
      return integrityBlockedJobResponse(current || job);
    }
    const failure = storedProviderFailure((current || job).provider, error, { phase: "recovery" });
    return await updateJob((current || job).id, {
      status: "failed",
      stage: "오류",
      message: `이전 실행 복구에 실패했습니다: ${failure.message}`,
      error: failure.evidence
        ? failure.error
        : [failure.error, closureError ? `stale-run closure failed: ${closureError.message}` : null].filter(Boolean).join("\n"),
      ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  }
}

async function recoverStaleJob(job) {
  if (!isRunningJobPointer(job)) return job;
  const lease = await acquireJobLease(job.id);
  if (!lease) return legacyLeaseBlockedJobIds.has(job.id) ? legacyLeaseBlockedJobResponse(job) : job;
  try {
    return await recoverRunningJobUnderLease(job, lease);
  } finally {
    await releaseJobLease(lease).catch(() => {});
  }
}

export async function recoverStaleJobs(
  jobs,
  blockedJobIds = semanticTransactionBlockedJobIds,
  localClipBlockedJobIds = new Set(),
  options = {}
) {
  const maximumConcurrency = options.maximumConcurrency ?? MAX_CONCURRENT_STALE_JOB_RECOVERIES;
  if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
    throw new Error("stale job 복구 동시성 설정이 올바르지 않습니다.");
  }
  const recoverJobFn = options.recoverJobFn || recoverStaleJob;
  const results = new Array(jobs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        results[index] = localClipBlockedJobIds.has(job.id) || localClipTransactionBlockedJobIds.has(job.id)
          ? localClipTransactionBlockedJobResponse(job)
          : blockedJobIds.has(job.id) || semanticTransactionBlockedJobIds.has(job.id)
            ? semanticTransactionBlockedJobResponse(job)
            : await recoverJobFn(job);
      } catch (error) {
        options.onRecoveryError?.(job, error);
        results[index] = integrityBlockedJobResponse(job, {
          code: "stale-job-recovery-failure",
          message: "이전 실행의 kernel lease 복구에 실패해 이 작업만 격리했습니다. 다른 작업은 계속 사용할 수 있습니다."
        });
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrency, jobs.length) },
    () => worker()
  ));
  return results;
}

export async function recoverSemanticRevalidationTransactions(options = {}) {
  const readdirFn = options.readdirFn || readdir;
  const readTransactionFn = options.readTransactionFn || readSemanticTransactionStrict;
  const recoverFn = options.recoverFn || recoverSemanticRevalidationWorkspace;
  const acquireLeaseFn = options.acquireLeaseFn || acquireJobLease;
  const releaseLeaseFn = options.releaseLeaseFn || releaseJobLease;
  let entries;
  try {
    entries = await readdirFn(JOBS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const blockedJobIds = new Set();
  const blockJob = (jobId, error) => {
    blockedJobIds.add(jobId);
    semanticTransactionBlockedJobIds.add(jobId);
    console.error(`job ${jobId} semantic revalidation transaction recovery를 격리했습니다: ${error.message}`);
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name) || activeJobs.has(entry.name)) continue;
    const jobDir = join(JOBS_DIR, entry.name);
    let journal;
    try {
      journal = await readTransactionFn(jobDir);
    } catch (error) {
      blockJob(entry.name, error);
      continue;
    }
    if (!journal) {
      semanticTransactionBlockedJobIds.delete(entry.name);
      continue;
    }
    let leaseError = null;
    const lease = await acquireLeaseFn(entry.name).catch((error) => {
      leaseError = error;
      return null;
    });
    if (leaseError) {
      blockJob(entry.name, leaseError);
      continue;
    }
    // A null lease without an acquisition error is owned by a live process.
    // Leave its transaction untouched and let that owner finish publication.
    if (!lease) {
      blockJob(entry.name, new Error("transaction marker가 live lease 아래에서 처리 중입니다."));
      continue;
    }
    let recoveryError = null;
    let releaseError = null;
    try {
      await recoverFn(jobDir, journal);
    } catch (error) {
      recoveryError = error;
    } finally {
      await releaseLeaseFn(lease).catch((error) => { releaseError = error; });
    }
    // An unresolved marker or lease is a per-job integrity boundary. Isolate it
    // from stale mutation while allowing unrelated jobs to remain available.
    if (recoveryError || releaseError) {
      blockJob(entry.name, recoveryError && releaseError
        ? new AggregateError([recoveryError, releaseError], "transaction 복구와 lease 해제가 모두 실패했습니다.")
        : recoveryError || releaseError);
      continue;
    }
    semanticTransactionBlockedJobIds.delete(entry.name);
  }
  return blockedJobIds;
}

export async function recoverLocalClipUploadTransactions(options = {}) {
  const readdirFn = options.readdirFn || readdir;
  const readTransactionFn = options.readTransactionFn || readLocalClipUploadTransactionStrict;
  const recoverFn = options.recoverFn || recoverLocalClipUploadTransaction;
  const acquireLeaseFn = options.acquireLeaseFn || acquireJobLease;
  const releaseLeaseFn = options.releaseLeaseFn || releaseJobLease;
  let entries;
  try {
    entries = await readdirFn(JOBS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const blockedJobIds = new Set();
  const blockJob = (jobId, error) => {
    blockedJobIds.add(jobId);
    localClipTransactionBlockedJobIds.add(jobId);
    console.error(`job ${jobId} local clip upload transaction recovery를 격리했습니다: ${error.message}`);
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name) || activeJobs.has(entry.name)) continue;
    const jobDir = join(JOBS_DIR, entry.name);
    let journal;
    try {
      journal = await readTransactionFn(jobDir);
      if (!journal) {
        localClipTransactionBlockedJobIds.delete(entry.name);
        continue;
      }
    } catch (error) {
      blockJob(entry.name, error);
      continue;
    }
    let lease = null;
    try {
      lease = await acquireLeaseFn(entry.name);
      if (!lease) throw new Error("job lease를 얻지 못했습니다.");
      // The discovery read above is only a hint that recovery work exists.
      // Lease acquisition can wait behind the live uploader, which may advance
      // the same transaction meanwhile. Re-read the canonical, strict marker
      // only after owning the lease so stale phase data can never roll back or
      // remove a newer durable forward decision.
      const lockedJournal = await readTransactionFn(jobDir);
      if (!lockedJournal) {
        localClipTransactionBlockedJobIds.delete(entry.name);
        continue;
      }
      await recoverFn(jobDir, {
        transaction: lockedJournal,
        readJobFn: readJob,
        writeJobFn: writeJob
      });
      localClipTransactionBlockedJobIds.delete(entry.name);
    } catch (error) {
      blockJob(entry.name, error);
    } finally {
      if (lease) {
        try {
          await releaseLeaseFn(lease);
        } catch (error) {
          blockJob(entry.name, error);
        }
      }
    }
  }
  return blockedJobIds;
}

async function syncQualityRevisionFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameQualityRevisionDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openQualityRevisionDirectoryStrict(path, label, options = {}) {
  const lstatDirectory = options.lstatDirectoryFn || lstat;
  const openDirectory = options.openDirectoryFn || open;
  const pathIdentity = await lstatDirectory(path, { bigint: true });
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error(`품질 revision ${label} 경로가 exact non-symlink directory가 아닙니다.`);
  }
  let handle;
  try {
    handle = await openDirectory(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
    );
  } catch (error) {
    throw new Error(`품질 revision ${label} directory를 안전하게 열 수 없습니다 (${error.message}).`);
  }
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameQualityRevisionDirectoryIdentity(pathIdentity, identity)) {
      throw new Error(`품질 revision ${label} directory가 lstat과 fd open 사이에 교체되었습니다.`);
    }
    return { path, label, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function closeQualityRevisionDirectorySnapshots(snapshots) {
  await Promise.all([...snapshots].reverse().map((snapshot) => snapshot?.handle.close().catch(() => {})));
}

async function assertQualityRevisionDirectorySnapshots(snapshots, options = {}, operation = "mutation") {
  if (typeof options.beforeQualityRevisionPathCheck === "function") {
    await options.beforeQualityRevisionPathCheck({ operation, paths: snapshots.map((snapshot) => snapshot.path) });
  }
  for (const snapshot of snapshots) {
    const current = await openQualityRevisionDirectoryStrict(snapshot.path, snapshot.label, options);
    try {
      if (!sameQualityRevisionDirectoryIdentity(snapshot.identity, current.identity)) {
        throw new Error(`품질 revision ${snapshot.label} directory가 처리 중 다른 inode로 교체되었습니다.`);
      }
    } finally {
      await current.handle.close();
    }
  }
}

async function qualityRevisionPathStatOrNull(path, options = {}) {
  try {
    return await (options.lstatDirectoryFn || lstat)(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function sealQualityRevision(jobId, runId, context, review, evaluatedQuality, options = {}) {
  if (!JOB_ID_PATTERN.test(String(jobId || "")) || !JOB_ID_PATTERN.test(String(runId || ""))) {
    throw new Error("품질 revision jobId·runId 경로가 안전하지 않습니다.");
  }
  const jobsRoot = resolve(JOBS_DIR);
  const jobDir = join(JOBS_DIR, jobId);
  const runsDir = join(jobDir, "runs");
  const runDir = join(runsDir, runId);
  if (!review?.runId || review.runId !== runId || review.jobId !== jobId || evaluatedQuality?.jobId !== jobId || evaluatedQuality?.runId !== runId) {
    throw new Error("reviewer payload와 품질 산출물이 현재 jobId·runId에 결속되어 있지 않습니다.");
  }
  const currentContext = await prepareQualityRevision(jobId, runId, context?.revisionId);
  if (canonicalJsonHash(currentContext) !== canonicalJsonHash(context)) throw new Error("품질 revision context가 현재 append-only head와 일치하지 않습니다.");
  assertRuntimeQualityRevisionEvaluation(evaluatedQuality, { context: currentContext, review });
  const revisionId = context.revisionId;
  const revisionsDir = join(runDir, "revisions");
  const revisionDir = join(revisionsDir, revisionId);
  const stagingDir = join(revisionsDir, `.quality-revision-staging-${revisionId}-${randomUUID()}`);
  const syncPinnedRevisionDirectory = async (snapshot) => {
    if (typeof options.syncDirectoryFn === "function") {
      await options.syncDirectoryFn(snapshot.path);
      return;
    }
    await snapshot.handle.sync();
  };
  const durabilityStep = async (operation, path) => {
    if (typeof options.onDurabilityStep === "function") await options.onDurabilityStep({ operation, path });
  };
  const relative = (name) => `runs/${runId}/revisions/${revisionId}/${name}`;
  const artifactUrl = (name) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
  const declaration = async (stagedPath, name) => ({ path: relative(name), sha256: await hashFile(stagedPath), bytes: (await stat(stagedPath)).size });
  const directorySnapshots = [];
  let stagingSnapshot = null;
  let published = false;
  try {
    for (const [path, label] of [
      [jobsRoot, "jobs root"],
      [jobDir, "job"],
      [runsDir, "runs"],
      [runDir, "run"]
    ]) {
      directorySnapshots.push(await openQualityRevisionDirectoryStrict(path, label, options));
    }
    const runSnapshot = directorySnapshots.at(-1);
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "revisions-ensure");
    if (await qualityRevisionPathStatOrNull(revisionDir, options)) {
      throw new Error("같은 revisionId의 품질 revision이 이미 봉인되었습니다.");
    }
    try {
      await mkdir(revisionsDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "revisions-pin");
    const revisionsSnapshot = await openQualityRevisionDirectoryStrict(revisionsDir, "revisions", options);
    directorySnapshots.push(revisionsSnapshot);
    // The revisions directory may be a survivor of an earlier attempt whose
    // run-directory fsync failed immediately after mkdir. Always repeat the
    // publication barrier before writing a new staging directory.
    await syncPinnedRevisionDirectory(runSnapshot);
    await durabilityStep("directory-fsync", runDir);
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-create");
    await mkdir(stagingDir, { mode: 0o700 });
    stagingSnapshot = await openQualityRevisionDirectoryStrict(stagingDir, "staging", options);
    directorySnapshots.push(stagingSnapshot);

    const reviewPath = join(stagingDir, "committee-review.json");
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-write:committee-review.json");
    await writeFile(reviewPath, JSON.stringify(review, null, 2));
    await syncQualityRevisionFile(reviewPath);
    await durabilityStep("file-fsync", reviewPath);
    const reviewDeclaration = await declaration(reviewPath, "committee-review.json");

    const quality = bindQualityRevision(evaluatedQuality, context, reviewDeclaration.sha256);
    const qualityPath = join(stagingDir, "quality.json");
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-write:quality.json");
    await writeFile(qualityPath, JSON.stringify(quality, null, 2));
    await syncQualityRevisionFile(qualityPath);
    await durabilityStep("file-fsync", qualityPath);
    const qualityDeclaration = await declaration(qualityPath, "quality.json");

    const eventRecord = buildQualityRevisionEvent({
      context,
      committeeReview: reviewDeclaration,
      qualityArtifact: qualityDeclaration,
      transition: quality.revision.transition
    });
    const eventsPath = join(stagingDir, "events.jsonl");
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-write:events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(eventRecord)}\n`);
    await syncQualityRevisionFile(eventsPath);
    await durabilityStep("file-fsync", eventsPath);
    const eventsDeclaration = await declaration(eventsPath, "events.jsonl");

    const revisionManifest = buildQualityRevisionManifest({
      context,
      review,
      quality,
      committeeReview: reviewDeclaration,
      qualityArtifact: qualityDeclaration,
      events: eventsDeclaration,
      eventRecord
    });
    const revisionManifestPath = join(stagingDir, "manifest.json");
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-write:manifest.json");
    await writeFile(revisionManifestPath, JSON.stringify(revisionManifest, null, 2));
    await syncQualityRevisionFile(revisionManifestPath);
    await durabilityStep("file-fsync", revisionManifestPath);
    const manifestDeclaration = await declaration(revisionManifestPath, "manifest.json");

    // Persist every staging entry before publishing the directory name. The
    // parent fsync after rename makes the append-only revision directory itself
    // durable across a crash immediately after publication.
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "staging-fsync");
    await syncPinnedRevisionDirectory(stagingSnapshot);
    await durabilityStep("directory-fsync", stagingDir);

    const publishContext = await prepareQualityRevision(jobId, runId, revisionId);
    if (canonicalJsonHash(publishContext) !== canonicalJsonHash(context)) throw new Error("품질 revision 봉인 중 append-only head가 변경되었습니다.");
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "publish-rename");
    if (await qualityRevisionPathStatOrNull(revisionDir, options)) throw new Error("같은 revisionId의 품질 revision이 이미 봉인되었습니다.");
    await rename(stagingDir, revisionDir);
    await durabilityStep("rename", revisionDir);
    const revisionSnapshot = await openQualityRevisionDirectoryStrict(revisionDir, "published revision", options);
    if (!sameQualityRevisionDirectoryIdentity(stagingSnapshot.identity, revisionSnapshot.identity)) {
      await revisionSnapshot.handle.close();
      throw new Error("품질 revision staging inode와 published revision inode가 일치하지 않습니다.");
    }
    directorySnapshots.pop();
    await stagingSnapshot.handle.close();
    stagingSnapshot = null;
    directorySnapshots.push(revisionSnapshot);
    await assertQualityRevisionDirectorySnapshots(directorySnapshots, options, "published-revision-fsync");
    await syncPinnedRevisionDirectory(revisionsSnapshot);
    await durabilityStep("directory-fsync", revisionsDir);
    published = true;

    const receipts = [
      [reviewDeclaration, "committee-review-revision"],
      [qualityDeclaration, "quality-revision"],
      [eventsDeclaration, "quality-revision-events"],
      [manifestDeclaration, "quality-revision-manifest"]
    ];
    return {
      revisionId,
      sequence: Number(context.sequence),
      manifestPath: manifestDeclaration.path,
      manifest: revisionManifest,
      quality,
      event: eventRecord,
      artifacts: receipts.map(([receipt, kind]) => ({
        name: receipt.path,
        kind,
        bytes: receipt.bytes,
        sha256: receipt.sha256,
        url: artifactUrl(receipt.path)
      }))
    };
  } finally {
    if (!published && stagingSnapshot) {
      await assertQualityRevisionDirectorySnapshots(directorySnapshots, {
        ...options,
        beforeQualityRevisionPathCheck: undefined
      }, "staging-cleanup").then(
        () => rm(stagingDir, { recursive: true, force: true }),
        () => null
      ).catch(() => {});
    }
    await closeQualityRevisionDirectorySnapshots(directorySnapshots);
  }
}
async function markLaunchFailure(jobId, error) {
  const current = await readJob(jobId).catch(() => null);
  if (!current || terminalJobPointer(current)) return current;
  const failure = storedProviderFailure(current.provider, error, { phase: "launch" });
  return updateJob(jobId, {
    status: "failed",
    stage: "오류",
    message: `실행 시작 실패: ${failure.message}`,
    error: failure.error,
    ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
    runStatus: "failed",
    warnings: [...(current.warnings || []), `실행 시작 실패: ${failure.message}`]
  });
}

export async function prepareSemanticRevalidationContext(job, sourceRunId) {
  if (typeof sourceRunId !== "string" || sourceRunId !== job?.runId || !JOB_ID_PATTERN.test(sourceRunId)) {
    throw new Error("의미 재검수 sourceRunId는 현재 작업의 정확한 봉인 runId여야 합니다.");
  }
  if (job.provider !== "gemini-browser") throw new Error("의미 재검수 provider-0 resume는 Gemini 작업만 지원합니다.");
  if (job.status !== "needs-improvement" || job.runStatus !== "needs-improvement") {
    throw new Error("의미 재검수는 봉인된 needs-improvement 작업에서만 시작할 수 있습니다.");
  }
  const runDir = join(JOBS_DIR, job.id, "runs", sourceRunId);
  const manifestRead = await readRunManifestStrict(runDir);
  const manifest = manifestRead.manifest;
  if (!manifest || manifest.status !== "needs-improvement" || manifest.runStatus !== "needs-improvement") {
    throw new Error("의미 재검수 원본 run이 needs-improvement 상태로 봉인되어 있지 않습니다.");
  }
  if (manifest.semanticRevalidation != null) {
    throw new Error("이미 purpose-aware semantic child인 run은 다시 policy-upgrade 재검수할 수 없습니다.");
  }
  if (!(await verifyImmutableRun(job, manifest))) throw new Error("의미 재검수 원본 run의 전체 immutable 무결성 검증에 실패했습니다.");
  const provider = immutableRunProvider(manifest);
  if (provider !== "gemini-browser") throw new Error("의미 재검수 원본의 immutable provider 결정이 Gemini에 결속되지 않았습니다.");
  const state = await readQualityRevisionState(job.id, sourceRunId);
  if (state.baseManifestHash !== manifestRead.snapshot?.sha256) {
    throw new Error("의미 재검수 원본 manifest와 품질 상태가 동일 바이트에 결속되지 않았습니다.");
  }
  if (state.effectiveStatus !== "needs-improvement") throw new Error("review revision이 반영된 현재 상태는 의미 재검수 대상이 아닙니다.");
  const sourceSemanticName = `runs/${sourceRunId}/semantic/receipt.json`;
  const sourceSemanticDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === sourceSemanticName);
  const sourceSemanticReceipt = await readVerifiedImmutableArtifact(job, sourceSemanticDeclaration, sourceSemanticName);
  if (
    sourceSemanticReceipt?.value?.schemaVersion !== 1
    || sourceSemanticReceipt.value.jobId !== job.id
    || sourceSemanticReceipt.value.runId !== sourceRunId
    || sourceSemanticReceipt.value.status !== "failed"
  ) throw new Error("의미 재검수는 봉인된 schema-1 실패 영수증의 policy upgrade에만 사용할 수 있습니다.");
  const inputName = `runs/${sourceRunId}/input-manifest.json`;
  const inputDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === inputName);
  const verifiedInput = await readVerifiedImmutableArtifact(job, inputDeclaration, inputName);
  if (!verifiedInput?.value || !immutableProviderClosureBound(provider, state.baseQuality.value, manifest, verifiedInput.value)) {
    throw new Error("의미 재검수 원본의 immutable provider closure가 유효하지 않습니다.");
  }
  if (!(await verifyImmutableShotPatternClosure(job, provider, state.baseQuality.value, manifest))) {
    throw new Error("의미 재검수 원본의 immutable shot pattern closure가 유효하지 않습니다.");
  }
  const providerProvenance = immutableProviderProvenance(manifest, provider);
  if (!providerProvenance) throw new Error("의미 재검수 원본의 immutable Gemini 영수증을 찾을 수 없습니다.");
  const manifestPath = `runs/${sourceRunId}/manifest.json`;
  const manifestHash = manifestRead.snapshot.sha256;
  const context = {
    schemaVersion: 1,
    mode: SEMANTIC_REVALIDATION_MODE,
    sourceRunId,
    sourceManifest: {
      path: manifestPath,
      sha256: manifestHash,
      status: manifest.status,
      runStatus: manifest.runStatus
    },
    sourceImmutableArtifactsHash: hashJson(manifest.immutableArtifacts),
    sourceProviderProvenance: providerProvenance,
    semanticPolicy: { ...LOCAL_SEMANTIC_POLICY_BINDING },
    providerRequestPolicy: { allowed: false, maximumCalls: 0 }
  };
  // Reuse the pipeline's independent, read-only loader as a second trust boundary.
  await readGeminiSemanticRevalidationInputs(job, join(JOBS_DIR, job.id), context);
  return context;
}

export async function startSemanticRevalidation(jobId, sourceRunId, options = {}) {
  if (activeJobs.has(jobId)) return { started: false, reason: "이미 실행 중인 작업입니다." };
  let settled = false;
  let resolveStarted;
  const started = new Promise((resolveStartedPromise) => {
    resolveStarted = (value) => {
      if (settled) return;
      settled = true;
      resolveStartedPromise(value);
    };
  });
  void withJob(jobId, async () => {
    let lease = null;
    let context = null;
    try {
      lease = await acquireJobLease(jobId);
      if (!lease) {
        resolveStarted({ started: false, reason: "다른 프로세스가 작업 lease를 사용 중입니다." });
        return;
      }
      // Recovery is a mutation. It is permitted only while this process owns
      // the cross-process lease, so another server cannot roll back a live child.
      await recoverSemanticRevalidationWorkspace(join(JOBS_DIR, jobId));
      const recovered = await recoverRunningJobUnderLease(await readJob(jobId), lease);
      if (isRunningJobPointer(recovered) || recovered.integrity?.status === "blocked") {
        resolveStarted({
          started: false,
          reason: recovered.integrity?.message || "다른 실행이 아직 작업 포인터를 소유하고 있습니다."
        });
        return;
      }
      const locked = await reconcileQualityRevisionJob(recovered, { leaseHeld: true });
      context = await prepareSemanticRevalidationContext(locked, sourceRunId);
      const runner = options.runner || runJob;
      const result = await runner(jobId, {
        ...(options.runOptions || {}),
        trigger: "semantic-revalidation",
        reason: "purpose-aware-local-semantic-policy-upgrade",
        semanticRevalidation: context,
        onRunCreated: async (created) => {
          resolveStarted({ started: true, sourceRunId, childRunId: created.runId, providerRequests: 0, semanticPolicy: context.semanticPolicy });
          if (typeof options.runOptions?.onRunCreated === "function") await options.runOptions.onRunCreated(created);
        }
      });
      const after = await readJob(jobId).catch(() => null);
      if (!settled && after?.runId && after.runId !== sourceRunId) {
        resolveStarted({ started: true, sourceRunId, childRunId: after.runId, providerRequests: 0, semanticPolicy: context.semanticPolicy });
      } else if (!settled) {
        resolveStarted({ started: false, reason: result?.message || "의미 재검수 child run을 만들지 못했습니다." });
      }
    } catch (error) {
      console.error(`job ${jobId} semantic revalidation failed to start: ${error.message}`);
      resolveStarted({ started: false, reason: error.message });
    } finally {
      if (lease) await releaseJobLease(lease);
    }
  }).then((claimed) => {
    if (!claimed) resolveStarted({ started: false, reason: "이미 실행 중인 작업입니다." });
  }).catch((error) => {
    console.error(`job ${jobId} semantic revalidation runner failed: ${error.message}`);
    resolveStarted({ started: false, reason: error.message });
  });
  return started;
}

export async function startJob(jobId, options = {}) {
  if (activeJobs.has(jobId)) return false;
  let settled = false;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  void withJob(jobId, async () => {
    let lease = null;
    let runnerStarted = false;
    try {
      lease = await acquireJobLease(jobId);
      if (!lease) {
        resolveStarted(false);
        return;
      }
      const jobDir = join(JOBS_DIR, jobId);
      if (await readSemanticTransactionStrict(jobDir) || await readLocalClipUploadTransactionStrict(jobDir)) {
        resolveStarted(false);
        return;
      }
      const recovered = await recoverRunningJobUnderLease(await readJob(jobId), lease);
      if (isRunningJobPointer(recovered) || recovered.integrity?.status === "blocked") {
        resolveStarted(false);
        return;
      }
      const {
        runner = runJob,
        onRunCreated: callerOnRunCreated,
        prepareRunOptions,
        ...runOptions
      } = options;
      const preparedRunOptions = typeof prepareRunOptions === "function"
        ? await prepareRunOptions({ jobId })
        : {};
      if (!preparedRunOptions || typeof preparedRunOptions !== "object" || Array.isArray(preparedRunOptions)) {
        throw new Error("lease-held run 준비 결과는 options 객체여야 합니다.");
      }
      runnerStarted = true;
      await runner(jobId, {
        ...runOptions,
        ...preparedRunOptions,
        onRunCreated: async (created) => {
          if (typeof callerOnRunCreated === "function") await callerOnRunCreated(created);
          // A successful /run acknowledgement is a durable identity receipt,
          // not merely evidence that a lease was acquired. runJob invokes this
          // only after publishing the run directory and persisting job.runId.
          resolveStarted(true);
        }
      });
      if (!settled) resolveStarted(false);
    } catch (error) {
      console.error(`job ${jobId} failed to start: ${error.message}`);
      // A lease acquisition failure gives us no authenticated/pinned job
      // ancestry to mutate. In particular, never follow a preexisting job-dir
      // symlink through the path-based failure persistence fallback.
      if (lease && runnerStarted) {
        await markLaunchFailure(jobId, error).catch((persistError) => console.error(`job ${jobId} start failure persistence failed: ${persistError.message}`));
      }
      resolveStarted(false);
    } finally {
      if (lease) {
        await releaseJobLease(lease).catch((error) => console.error(`job ${jobId} lease release failed: ${error.message}`));
      }
    }
  }).catch(async (error) => {
    console.error(`job ${jobId} runner failed: ${error.message}`);
    // This path can include withJob/finalizer failures after no lease was ever
    // acquired. It must be observational only.
    resolveStarted(false);
  });
  return started;
}

async function health() {
  const browser = redactGeminiMonitor(await geminiBrowserStatus());
  const ytDlp = await ytDlpInfo();
  const command = (name) => typeof Bun.which === "function" && Boolean(Bun.which(name));
  return {
    ok: true,
    service: "ps4-ai-video-studio",
    browser,
    capabilities: {
      ffmpeg: command("ffmpeg"),
      ffprobe: command("ffprobe"),
      macSay: command("say"),
      localVideoGenerator: Boolean(String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()),
      ytDlp
    },
    analysis: existsSync(ANALYSIS_PATH),
    rlmAnalysis: existsSync(join(ROOT, "data/rlm-benchmark-analysis.json"))
  };
}

async function handleApi(request, url, runtimeOptions = {}) {
  const path = url.pathname;
  const startJobFn = runtimeOptions.startJobFn || startJob;
  const redactApiJob = (job) => redactJobResponse(job, {
    artifactCapabilityToken: runtimeOptions.studioToken,
    artifactCapabilityOptions: runtimeOptions.artifactCapabilityOptions
  });
  if (path === "/api/health" && request.method === "GET") return json(await health());
  if (path === "/api/gemini/monitor" && request.method === "GET") {
    const monitorPath = runtimeOptions.geminiMonitorPath || join(WORKSPACE_DIR, "gemini-monitor.json");
    return json(projectGeminiMonitorOrFailClosed(await readGeminiMonitorJsonStrict(monitorPath)));
  }
  if (path === "/api/providers/readiness" && request.method === "GET") {
    return json(await buildProviderReadiness({ root: ROOT, workspaceDir: WORKSPACE_DIR }));
  }
  if (path === "/api/shot-patterns" && request.method === "GET") {
    return json(publicShotPatternCatalog(await readShotPatternCatalog()));
  }
  if (path === "/api/channel" && request.method === "GET") return json(await readAnalysis());
  if (path === "/api/benchmark/profile" && request.method === "GET") {
    return json({
      duration: await readOptionalJson(join(ROOT, "data/shorts-metadata.json")),
      rlm: await readOptionalJson(join(ROOT, "data/rlm-benchmark-analysis.json")),
      media: await readOptionalJson(join(ROOT, "data/benchmark-media-analysis.json"))
    });
  }
  if (path === "/api/channel/videos" && request.method === "GET") {
    const analysis = await readAnalysis();
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const category = url.searchParams.get("category") || "";
    const sort = url.searchParams.get("sort") || "views";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 24)));
    let videos = analysis.videos.filter((video) => {
      const matchesQuery = !query || video.title.toLowerCase().includes(query);
      const matchesCategory = !category || video.analysis.categories.some((item) => item.id === category);
      return matchesQuery && matchesCategory;
    });
    videos.sort((a, b) => sort === "recent" ? a.position - b.position : b.viewCount - a.viewCount);
    const start = (page - 1) * limit;
    return json({ total: videos.length, page, limit, videos: videos.slice(start, start + limit) });
  }
  if (path === "/api/jobs" && request.method === "GET") {
    const localClipBlockedJobIds = await recoverLocalClipUploadTransactions();
    const blockedJobIds = await recoverSemanticRevalidationTransactions();
    const recovered = await recoverStaleJobs(await listJobs(), blockedJobIds, localClipBlockedJobIds, {
      onRecoveryError: (job, error) => console.error(`job ${job.id} stale-run recovery를 격리했습니다: ${error.message}`)
    });
    const jobs = await reconcileJobsIndependently(recovered, { blockedJobIds, localClipBlockedJobIds });
    return json({ jobs: jobs.map(redactApiJob) });
  }
  if (path === "/api/jobs" && request.method === "POST") {
    try {
      const body = validateCreateJobRequest(await readJson(request));
      const requestedProvider = body.provider === undefined ? "gemini-browser" : body.provider;
      const createInput = requestedProvider === "gemini-browser"
        && body.geminiCdpUrl === undefined
        && body.geminiProfileDir === undefined
        ? { ...body, ...configuredGeminiJobProfile() }
        : body;
      const job = await createJob(createInput);
      return json({ job: redactApiJob(job) }, 201);
    } catch (error) {
      return errorResponse(error, Number.isInteger(error?.statusCode) ? error.statusCode : 400);
    }
  }
  if (path === "/api/browser/start" && request.method === "POST") return json(redactGeminiMonitor(await startGeminiBrowser()));

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2] || "";
    if (!JOB_ID_PATTERN.test(jobId)) return errorResponse(new Error("잘못된 작업 ID입니다."), 400);
    const localClipTransactionBoundary = await inspectLocalClipTransactionRouteBoundary(jobId);
    if (localClipTransactionBoundary.blocked) {
      if (request.method === "GET" && !suffix) {
        return json(redactApiJob(localClipTransactionBlockedJobResponse(await readJob(jobId))));
      }
      return errorResponse(new Error("로컬 클립 업로드 transaction 무결성 차단으로 이 작업을 변경하거나 파생 산출물을 읽을 수 없습니다."), 409);
    }
    const semanticTransactionBoundary = await inspectSemanticTransactionRouteBoundary(jobId);
    if (semanticTransactionBoundary.blocked) {
      if (request.method === "GET" && !suffix) {
        const stored = await readJob(jobId);
        return json(redactApiJob(semanticTransactionBlockedJobResponse(stored)));
      }
      return errorResponse(new Error("의미 재검수 transaction 무결성 차단으로 이 작업을 변경하거나 파생 산출물을 읽을 수 없습니다."), 409);
    }
    if (legacyLeaseBlockedJobIds.has(jobId)) {
      if (request.method === "GET" && !suffix) {
        return json(redactApiJob(legacyLeaseBlockedJobResponse(await readJob(jobId))));
      }
      return errorResponse(new Error("구버전 job lease migration이 필요해 이 작업의 mutation을 차단했습니다."), 409);
    }
    if (request.method === "GET" && suffix === "quality") {
      const current = await reconcileQualityRevisionJob(await readJob(jobId));
      if (!current.runId) return errorResponse(new Error("현재 실행 산출물이 없어 품질 검사를 시작할 수 없습니다."), 409);
      const quality = await readVerifiedQuality(current);
      if (!quality) return errorResponse(new Error("봉인된 현재 품질 산출물을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json(redactGeminiMonitor(projectQualityTruthfulness(quality)));
    }
    if (request.method === "GET" && suffix === "quality/history") {
      const current = await reconcileQualityRevisionJob(await readJob(jobId));
      if (!current.runId) return json({ iterations: [] });
      const iterations = await readVerifiedQualityHistory(current);
      if (iterations === null) return errorResponse(new Error("봉인된 품질 이력을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json(redactGeminiMonitor({ iterations: iterations.map(projectQualityTruthfulness) }));
    }
    if (request.method === "POST" && suffix === "quality/evaluate") {
      try {
        const body = await readJson(request);
        const quality = await withQualityLease(jobId, (lockedJob) => {
          if (body.runId && body.runId !== lockedJob.runId) throw new Error("품질 검사는 현재 작업의 runId만 허용합니다.");
          return evaluateJob(jobId, { iteration: Number(body.iteration || 1), runId: lockedJob.runId, persist: false });
        });
        if (!quality) return errorResponse(new Error("작업 실행 중에는 품질 검사를 시작할 수 없습니다."), 409);
        return json(quality);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "POST" && suffix === "quality-loop") {
      try {
        const body = await readJson(request);
        const result = await withQualityLease(jobId, (lockedJob) => {
          if (body.runId && body.runId !== lockedJob.runId) throw new Error("품질 반복 검사는 현재 작업의 runId만 허용합니다.");
          return runQualityLoop(jobId, { maxIterations: body.maxIterations || 3, runId: lockedJob.runId, persist: false });
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 품질 검사를 시작할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "POST" && suffix === "quality/revisions/prepare") {
      try {
        const body = await readJson(request);
        const result = await withQualityLease(jobId, async (lockedJob) => {
          if (body.runId && body.runId !== lockedJob.runId) throw new Error("품질 revision은 현재 작업의 runId만 허용합니다.");
          const revisionId = `revision-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
          const revisionContext = await prepareQualityRevision(jobId, lockedJob.runId, revisionId);
          const state = await readQualityRevisionState(jobId, lockedJob.runId);
          const evidenceHashes = state.baseQuality.value.metrics?.evidenceHashes || {};
          return { revisionContext, evidenceHashes, evidenceHash: committeeEvidenceHash(evidenceHashes) };
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 품질 revision을 준비할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "POST" && ["committee-review", "quality/revisions/submit"].includes(suffix)) {
      try {
        const submission = await readJson(request);
        if (!submission?.revisionContext || !submission?.review) throw new Error("revisionContext와 review를 함께 제출해야 합니다.");
        const result = await withQualityLease(jobId, async (lockedJob) => {
          const prepared = await prepareQualityRevision(jobId, lockedJob.runId, submission.revisionContext.revisionId);
          if (canonicalJsonHash(prepared) !== canonicalJsonHash(submission.revisionContext)) throw new Error("제출한 revisionContext가 현재 append-only head와 일치하지 않습니다.");
          const review = await saveCommitteeReview(jobId, submission.review, { revisionContext: prepared });
          const evaluated = await evaluateJob(jobId, {
            iteration: Number(review.iteration || prepared.sequence),
            runId: lockedJob.runId,
            persist: false,
            committee: review,
            allowPostPublicationRevision: true,
            revisionContext: prepared,
            reuseExistingAnalysis: true,
            reuseEvidenceFrames: true
          });
          const revision = await sealQualityRevision(jobId, lockedJob.runId, prepared, review, evaluated);
          const quality = revision.quality;
          const existingNames = new Set((lockedJob.artifacts || []).map((artifact) => artifact?.name));
          if (revision.artifacts.some((artifact) => existingNames.has(artifact.name))) throw new Error("품질 revision 산출물 경로가 기존 선언과 충돌합니다.");
          const job = await reconcileQualityRevisionJob(await readJob(jobId), { leaseHeld: true });
          return { review, quality: projectQualityTruthfulness(quality), revision, job: redactApiJob(job) };
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 reviewer payload 검증을 시작할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "GET" && !suffix) {
      const stored = await readJob(jobId);
      if (semanticTransactionBlockedJobIds.has(jobId)) {
        return json(redactApiJob(semanticTransactionBlockedJobResponse(stored)));
      }
      try {
        return json(redactApiJob(await reconcileQualityRevisionJob(stored)));
      } catch (error) {
        console.error(`job ${jobId} reconciliation blocked: ${error.message}`);
        return json(redactApiJob(integrityBlockedJobResponse(stored)));
      }
    }
    if (request.method === "POST" && suffix === "semantic/revalidate") {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return errorResponse(error, Number.isInteger(error?.statusCode) ? error.statusCode : 400);
      }
      if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).sort().join(",") !== "sourceRunId"
        || typeof body.sourceRunId !== "string"
      ) return errorResponse(new Error("sourceRunId만 포함한 JSON 요청이 필요합니다."), 400);
      if (activeJobs.has(jobId)) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      const current = await recoverStaleJob(await readJob(jobId));
      if (isRunningJobPointer(current) || current.integrity?.status === "blocked") {
        return errorResponse(new Error(current.integrity?.message || "이미 실행 중인 작업입니다."), 409);
      }
      const launch = await startSemanticRevalidation(jobId, body.sourceRunId, {
        runner: runtimeOptions.semanticRevalidationRunner,
        runOptions: runtimeOptions.semanticRevalidationRunOptions
      });
      if (!launch.started) return errorResponse(new Error(launch.reason || "의미 재검수를 시작할 수 없습니다."), 409);
      return json({
        started: true,
        sourceRunId: launch.sourceRunId,
        childRunId: launch.childRunId,
        providerRequests: 0,
        semanticPolicy: launch.semanticPolicy,
        message: "기존 봉인 영상만 로컬 재검수 · Gemini 요청 0회"
      }, 202);
    }
    if (request.method === "POST" && suffix === "run") {
      if (activeJobs.has(jobId)) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      const recovered = await recoverStaleJob(await readJob(jobId));
      if (isRunningJobPointer(recovered) || recovered.integrity?.status === "blocked") {
        return errorResponse(new Error(recovered.integrity?.message || "이미 실행 중인 작업입니다."), 409);
      }
      const current = await reconcileQualityRevisionJob(recovered);
      if (current.provider === "local") {
        try {
          await verifyReadyLocalClipSet(join(JOBS_DIR, jobId), current);
        } catch (error) {
          return errorResponse(error, Number.isInteger(error?.statusCode) ? error.statusCode : 409);
        }
      }
      let launchPreparationError = null;
      let runOptions = {};
      if (current.provider === "local-video") {
        runOptions = {
          prepareRunOptions: async () => {
            try {
              // startJob invokes this callback only after acquiring the exact
              // job lease. Re-read every mutable launch field there; consuming
              // paid approval before lease ownership makes a busy 409 lossy.
              const locked = await reconcileQualityRevisionJob(await readJob(jobId), { leaseHeld: true });
              if (locked.provider !== "local-video") throw new Error("현재 작업은 더 이상 local-video 유료 실행 작업이 아닙니다.");
              if (isRunningJobPointer(locked)) {
                throw new Error("이미 실행 중인 작업입니다.");
              }
              const jobDir = join(JOBS_DIR, jobId);
              const approvalContext = await buildBflPaidApprovalContext({ root: ROOT, job: locked, env: process.env });
              const prepared = await consumeOrRecoverBflPaidApproval(jobDir, approvalContext, {
                apiKey: process.env.BFL_API_KEY,
                assertNoPriorPaidIntent: () => assertNoPriorPaidLocalVideoSubmission(jobDir)
              });
              return { paidLaunchCapability: prepared.capability };
            } catch (error) {
              launchPreparationError = error;
              throw error;
            }
          }
        };
      }
      if (!(await startJobFn(jobId, runOptions))) {
        return errorResponse(launchPreparationError || new Error("이미 실행 중인 작업입니다."), 409);
      }
      return json({ started: true, job: redactApiJob(await readJob(jobId)) });
    }
    if (request.method === "POST" && suffix === "clips") {
      validateRequestContentLength(request);
      const uploadContentType = (request.headers.get("content-type") || "").trim();
      if (!/^multipart\/form-data;\s*boundary=(?:"[^"\r\n]+"|[^\s;\r\n]+)$/iu.test(uploadContentType)) {
        return errorResponse(requestError("클립 업로드는 하나의 유효한 multipart/form-data boundary가 필요합니다.", 415), 415);
      }
      if (activeJobs.has(jobId)) return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
      const lease = await acquireJobLease(jobId);
      if (!lease) return errorResponse(new Error("다른 프로세스가 작업을 사용 중입니다."), 409);
      let uploadSlotAcquired = false;
      try {
        let lockedCurrent;
        try {
          const recovered = await recoverRunningJobUnderLease(await readJob(jobId), lease);
          if (isRunningJobPointer(recovered) || recovered.integrity?.status === "blocked") {
            return errorResponse(new Error(recovered.integrity?.message || "실행 중에는 클립을 업로드할 수 없습니다."), 409);
          }
          // Reconcile and verify any terminal pointer while the same job lease
          // is held, before multipart parsing can consume bytes. Replacing
          // source clips must never erase the only mutable pointer to corrupt
          // or unverifiable sealed evidence.
          lockedCurrent = await reconcileQualityRevisionJob(recovered, { leaseHeld: true });
        } catch (error) {
          return errorResponse(new Error(`기존 봉인 실행의 무결성을 확인할 수 없어 클립 교체를 차단했습니다: ${error.message}`), 409);
        }
        if (isRunningJobPointer(lockedCurrent)) {
          return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
        }
        if (lockedCurrent.provider !== "local") return errorResponse(new Error("클립 업로드는 외부/Playground 클립 편집 작업에만 허용됩니다."), 409);
        const maximumActiveUploads = runtimeOptions.maximumActiveMultipartUploads ?? 1;
        if (!Number.isSafeInteger(maximumActiveUploads) || maximumActiveUploads < 1) {
          return errorResponse(new Error("multipart upload 동시성 설정이 올바르지 않습니다."), 500);
        }
        if (activeMultipartUploads >= maximumActiveUploads) {
          return errorResponse(requestError("다른 대용량 클립 업로드가 진행 중입니다. 완료 후 다시 시도하세요.", 429), 429);
        }
        activeMultipartUploads += 1;
        uploadSlotAcquired = true;
        const form = await request.formData();
        const expectedRunIdValues = form.getAll("expectedRunId");
        const expectedRunId = expectedRunIdValues[0];
        if (
          expectedRunIdValues.length !== 1
          || typeof expectedRunId !== "string"
          || (expectedRunId !== "" && !JOB_ID_PATTERN.test(expectedRunId))
          || [...form.keys()].some((name) => !["expectedRunId", "files"].includes(name))
        ) {
          return errorResponse(new Error("클립 교체 요청에는 정확히 하나의 안전한 expectedRunId 문자열과 files만 필요합니다."), 409);
        }
        const currentRunId = typeof lockedCurrent.runId === "string" ? lockedCurrent.runId : "";
        if (expectedRunId !== currentRunId) {
          return errorResponse(new Error("확인한 실행 결과가 현재 작업 포인터와 달라 클립 교체를 차단했습니다. 작업을 새로고침한 뒤 다시 확인하세요."), 409);
        }
        const fileValues = form.getAll("files");
        if (fileValues.some((value) => !(value instanceof File))) {
          return errorResponse(new Error("files 필드는 영상 파일만 포함해야 합니다."), 409);
        }
        const files = fileValues;
        const jobDir = join(JOBS_DIR, jobId);
        const result = await installLocalClipUpload(jobDir, lockedCurrent, files, {
          ...(runtimeOptions.localClipUploadOptions || {}),
          readJobFn: readJob,
          writeJobFn: writeJob,
          limits: { maxFileBytes: MAX_UPLOAD_BYTES, maxTotalBytes: MAX_UPLOAD_TOTAL_BYTES }
        });
        return json({
          uploaded: result.uploaded,
          ordering: "선택한 파일 순서",
          recovered: result.recovered,
          job: redactApiJob(result.job)
        }, 201);
      } finally {
        if (uploadSlotAcquired) activeMultipartUploads = Math.max(0, activeMultipartUploads - 1);
        await releaseJobLease(lease);
      }
    }
    if (["GET", "HEAD"].includes(request.method) && suffix.startsWith("artifacts/")) {
      let filename;
      try {
        filename = decodeURIComponent(suffix.slice("artifacts/".length));
      } catch {
        return errorResponse(new Error("잘못된 산출물 경로입니다."), 400);
      }
      let artifact;
      let responseReceipt = null;
      let fixedResponseBody = null;
      try {
        artifact = safeArtifactPath(jobId, filename);
      } catch (error) {
        return errorResponse(error, 403);
      }
      const revisionMatch = /^runs\/([^/]+)\/revisions\/([^/]+)\/(manifest\.json|committee-review\.json|quality\.json|events\.jsonl)$/.exec(filename);
      if (filename.includes("/revisions/") && !revisionMatch) return errorResponse(new Error("허용되지 않은 품질 revision 산출물 경로입니다."), 404);
      const initialJob = await readJob(jobId);
      if (revisionMatch) {
        const preliminaryDeclarations = (initialJob.artifacts || []).filter((entry) => entry?.name === filename);
        const maximumBytes = revisionMatch[3] === "events.jsonl"
          ? STALE_RUN_EVENT_MAX_BYTES
          : STALE_RUN_MANIFEST_MAX_BYTES;
        const receipt = preliminaryDeclarations.length === 1 ? preliminaryDeclarations[0] : null;
        if (
          revisionMatch[1] !== initialJob.runId
          || !receipt
          || !Number.isSafeInteger(Number(receipt.bytes))
          || Number(receipt.bytes) < 0
          || Number(receipt.bytes) > maximumBytes
          || !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.sha256 || ""))
          || !(await verifyFileReceipt(artifact, receipt.bytes, receipt.sha256))
        ) return errorResponse(new Error("품질 revision 무결성 사전 검증에 실패했습니다."), 409);
      }
      const job = await reconcileQualityRevisionJob(initialJob);
      let terminalIntegrity = null;
      if (terminalJobPointer(job)) {
        try {
          terminalIntegrity = await assertTerminalRunIntegrity(job);
        } catch (error) {
          return errorResponse(new Error(`봉인된 실행 무결성 검증에 실패했습니다: ${error.message}`), 409);
        }
      }
      if (legacyLocalRawArtifactNames(terminalIntegrity).has(filename)) {
        return errorResponse(new Error(
          `레거시 local 봉인 산출물의 과거 pass 의미는 현재 provider·콘텐츠 증거로 사용할 수 없습니다. `
          + `현재 판정은 /api/jobs/${jobId}, /api/jobs/${jobId}/quality 또는 /api/jobs/${jobId}/quality/history의 projected view를 사용하세요.`
        ), 409);
      }
      const jobDeclarations = (Array.isArray(job.artifacts) ? job.artifacts : []).filter((entry) => entry?.name === filename);
      if (jobDeclarations.length !== 1) return errorResponse(new Error("선언되지 않았거나 중복 선언된 작업 산출물입니다."), 404);
      if (Number.isSafeInteger(Number(jobDeclarations[0].bytes)) && /^sha256:[a-f0-9]{64}$/u.test(String(jobDeclarations[0].sha256 || ""))) {
        responseReceipt = { bytes: Number(jobDeclarations[0].bytes), sha256: jobDeclarations[0].sha256 };
      }
      const immutableMatch = /^runs\/([^/]+)\/artifacts\/(.+)$/.exec(filename);
      // A terminal request uses the one manifest snapshot that passed the full
      // closure check. Never re-open it and silently downgrade to mutable mode.
      const currentManifest = terminalIntegrity?.manifest || null;
      const sealedCurrentRun = currentManifest?.jobId === jobId
        && currentManifest?.runId === job.runId
        && ["completed", "needs-improvement"].includes(currentManifest?.status);
      const isCurrentRunManifest = filename === `runs/${job.runId}/manifest.json`;
      if (sealedCurrentRun && isCurrentRunManifest) {
        fixedResponseBody = terminalIntegrity.manifestSnapshot.buffer;
        responseReceipt = {
          bytes: terminalIntegrity.manifestSnapshot.bytes,
          sha256: terminalIntegrity.manifestSnapshot.sha256
        };
      }
      if (sealedCurrentRun && !immutableMatch && !revisionMatch && !isCurrentRunManifest) {
        const declarations = (currentManifest.immutableArtifacts || []).filter((entry) => entry?.name === filename);
        const declaration = declarations.length === 1 ? declarations[0] : null;
        const immutablePath = declaration?.path ? resolve(JOBS_DIR, jobId, declaration.path) : null;
        if (
          !declaration?.sha256
          || !Number.isSafeInteger(Number(declaration.bytes))
          || Number(declaration.bytes) < 0
          || !immutablePath?.startsWith(`${resolve(JOBS_DIR, jobId)}${sep}`)
          || !(await verifyFileReceipt(immutablePath, declaration.bytes, declaration.sha256))
        ) {
          return errorResponse(new Error("봉인된 mutable 산출물의 불변 선언을 찾지 못했습니다."), 409);
        }
        // Root artifact names are compatibility aliases only. Serve the exact
        // immutable snapshot so a mutable mirror can never race the response.
        artifact = immutablePath;
        responseReceipt = { bytes: Number(declaration.bytes), sha256: declaration.sha256 };
      }
      if (immutableMatch) {
        const [, immutableRunId] = immutableMatch;
        const declaration = currentManifest?.immutableArtifacts?.find((entry) => entry?.path === filename);
        if (immutableRunId !== job.runId || !sealedCurrentRun || !declaration?.sha256) {
          return errorResponse(new Error("불변 산출물 무결성 선언을 찾지 못했습니다."), 409);
        }
        responseReceipt = { bytes: Number(declaration.bytes), sha256: declaration.sha256 };
      }
      if (revisionMatch) {
        const [, revisionRunId, revisionId, revisionFile] = revisionMatch;
        const state = revisionRunId === job.runId ? await readQualityRevisionState(jobId, revisionRunId).catch(() => null) : null;
        const record = state?.revisions.find((entry) => entry.manifest.revisionId === revisionId);
        const revisionJobDeclarations = (job.artifacts || []).filter((entry) => entry?.name === filename);
        const internalDeclaration = revisionFile === "manifest.json"
          ? null
          : revisionFile === "committee-review.json"
            ? record?.manifest.committeeReview
            : revisionFile === "quality.json"
              ? record?.manifest.quality
              : record?.manifest.events;
        const expectedHash = revisionFile === "manifest.json" ? record?.manifestHash : internalDeclaration?.sha256;
        const expectedBytes = revisionFile === "manifest.json" ? revisionJobDeclarations[0]?.bytes : internalDeclaration?.bytes;
        const maximumBytes = revisionFile === "events.jsonl" ? STALE_RUN_EVENT_MAX_BYTES : STALE_RUN_MANIFEST_MAX_BYTES;
        if (
          !state
          || !record
          || !(await verifyRevisionJobDeclarations(job, state))
          || revisionJobDeclarations.length !== 1
          || revisionJobDeclarations[0].sha256 !== expectedHash
          || Number(revisionJobDeclarations[0].bytes) !== Number(expectedBytes)
          || !Number.isSafeInteger(Number(expectedBytes))
          || Number(expectedBytes) < 0
          || Number(expectedBytes) > maximumBytes
          || !(await verifyFileReceipt(artifact, expectedBytes, expectedHash))
        ) {
          return errorResponse(new Error("품질 revision 무결성 선언을 찾지 못했습니다."), 409);
        }
        responseReceipt = { bytes: Number(expectedBytes), sha256: expectedHash };
      }
      let body;
      let range;
      let totalBytes;
      let contentLength;
      try {
        if (fixedResponseBody) {
          totalBytes = fixedResponseBody.byteLength;
          range = parseArtifactByteRange(request.headers.get("range"), totalBytes);
          body = range && range !== false ? fixedResponseBody.subarray(range.start, range.end + 1) : fixedResponseBody;
          contentLength = body.byteLength;
        } else {
          const result = await prepareVerifiedArtifactStream(
            artifact,
            responseReceipt,
            request.headers.get("range"),
            runtimeOptions.artifactStreamOptions || {}
          );
          ({ stream: body, range, totalBytes, contentLength } = result);
        }
      } catch (error) {
        if (error?.code === "ENOENT") return errorResponse(new Error("파일을 찾지 못했습니다."), 404);
        if (Number.isInteger(error?.statusCode)) return errorResponse(error, error.statusCode);
        return errorResponse(new Error(`응답 산출물 무결성 검증에 실패했습니다: ${error.message}`), 409);
      }
      if (range === false) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${totalBytes}`, "accept-ranges": "bytes", "cache-control": "no-store" }
        });
      }
      const headers = {
        "content-type": contentType(artifact),
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "content-length": String(contentLength)
      };
      if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${totalBytes}`;
      if (filename === "final.mp4") headers["content-disposition"] = `inline; filename="${filename}"`;
      if (request.method === "HEAD") {
        await body?.cancel?.("HEAD response does not consume the verified artifact stream").catch(() => {});
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      return new Response(body, { status: range ? 206 : 200, headers });
    }
  }
  return null;
}

async function serveStatic(request, url) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const path = resolve(PUBLIC_DIR, requested);
  if (!(path === PUBLIC_DIR || path.startsWith(`${PUBLIC_DIR}${sep}`))) return new Response("Not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": contentType(path),
    "cache-control": requested === "index.html" ? "no-store" : "no-cache",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
  return new Response(file, { headers });
}

export function createStudioRequestHandler(options = {}) {
  const fixedToken = options.token || STUDIO_TOKEN;
  const tokenProvider = options.tokenProvider;
  if (tokenProvider !== undefined && typeof tokenProvider !== "function") {
    throw new TypeError("Studio token provider가 함수가 아닙니다.");
  }
  const trustedOrigins = options.trustedOrigins || options.allowedOrigins || defaultTrustedStudioOrigins();
  return async function studioFetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        const token = tokenProvider ? requireStudioToken(await tokenProvider()) : fixedToken;
        const authorization = authorizeMutationRequest(request, url, { token, trustedOrigins });
        const artifactCapability = authorization.ok
          ? null
          : authorizeArtifactCapabilityRequest(request, url, {
              token,
              trustedOrigins,
              nowMs: options.artifactCapabilityNowMs
            });
        if (!authorization.ok && !artifactCapability.ok) {
          return errorResponse(new Error("API 요청의 host, 출처 또는 Bearer 권한을 확인할 수 없습니다."), authorization.status);
        }
        const response = await handleApi(request, url, { ...options, studioToken: token });
        return response || errorResponse(new Error("API 경로를 찾지 못했습니다."), 404);
      }
      return await serveStatic(request, url);
    } catch (error) {
      console.error(error);
      const status = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.message?.includes("찾지") ? 404 : 500;
      return errorResponse(error, status);
    }
  };
}

export async function startStudioServer(options = {}) {
  const port = options.port ?? PORT;
  const hostname = options.hostname || HOST;
  if (!isLoopbackHostname(hostname)) throw new Error("Studio 서버는 loopback host에만 바인딩할 수 있습니다.");
  const explicitToken = Object.hasOwn(options, "token") ? requireStudioToken(options.token) : null;
  const trustedOrigins = [];
  const tokenPath = options.tokenPath || STUDIO_TOKEN_PATH;
  if (
    process.env.NODE_ENV !== "test"
    && [
      "serverLeasePath",
      "afterPortReserved",
      "afterTokenPersistedBeforeLeaseMigration",
      "stopServerFn"
    ].some((name) => options[name] !== undefined)
  ) {
    throw new Error("Studio server 내부 test hook은 production에서 사용할 수 없습니다.");
  }
  const serverLeasePath = options.serverLeasePath || join(STUDIO_RUNTIME_DIR, STUDIO_SERVER_LEASE_FILENAME);
  const allowLeaseMigration = options.allowLeaseMigration === true;
  const tokenPathHash = studioServerTokenPathHash(tokenPath);
  await ensureWorkspace();
  const lease = await acquireStudioServerLease(serverLeasePath);
  let server = null;
  let requestHandler = () => new Response(JSON.stringify({ error: "Studio server startup is not complete." }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
  try {
    // Reserve the loopback port before publishing a new credential. Until all
    // storage recovery and token checks finish, this socket is inert and can
    // dispatch neither static content nor authenticated API mutations.
    server = Bun.serve({
      hostname,
      port,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (request) => requestHandler(request)
    });
    await options.afterPortReserved?.({ serverUrl: server.url, port: server.port, tokenPath });
    await lease.assertCurrent();
    await lease.bindTokenPath(tokenPathHash);
    const persistedToken = await readPersistedStudioTokenStrict(tokenPath);
    if (persistedToken && !lease.migrated && !allowLeaseMigration) {
      const error = new Error("기존 Studio token을 새 singleton lease로 이전하려면 명시적 1회 승인이 필요합니다.");
      error.code = "STUDIO_SERVER_LEASE_MIGRATION_REQUIRED";
      throw error;
    }
    if (explicitToken && persistedToken && !constantTimeTokenEqual(explicitToken, persistedToken)) {
      const error = new Error("명시적 Studio token이 기존 canonical token과 일치하지 않습니다.");
      error.code = "STUDIO_TOKEN_MISMATCH";
      throw error;
    }
    const token = persistedToken || explicitToken || STUDIO_TOKEN;
    if (!persistedToken) await persistStudioToken(token, tokenPath);
    await options.afterTokenPersistedBeforeLeaseMigration?.({ tokenPath, tokenExistedBefore: Boolean(persistedToken) });
    await lease.markMigrated(tokenPathHash);
    const localClipBlockedJobIds = await recoverLocalClipUploadTransactions();
    const blockedJobIds = await recoverSemanticRevalidationTransactions();
    const recoveredJobs = await recoverStaleJobs(await listJobs(), blockedJobIds, localClipBlockedJobIds, {
      onRecoveryError: (job, error) => console.error(`job ${job.id} stale-run recovery를 격리했습니다: ${error.message}`)
    });
    await reconcileJobsIndependently(recoveredJobs, {
      blockedJobIds,
      localClipBlockedJobIds,
      revisionOnly: true,
      onIntegrityError: (job, error) => console.error(`job ${job.id} quality revision reconciliation failed: ${error.message}`)
    });
    await lease.assertCurrent();
    trustedOrigins.push(studioOrigin(hostname, server.port));
    requestHandler = createStudioRequestHandler({
      token,
      trustedOrigins,
      tokenProvider: explicitToken ? undefined : async () => {
        const current = await readPersistedStudioTokenStrict(tokenPath);
        if (!current) throw new Error("canonical Studio token을 찾을 수 없습니다.");
        return current;
      }
    });
    return bindStudioServerLease(server, lease, token, options.stopServerFn);
  } catch (error) {
    if (server) {
      try {
        await server.stop(true);
      } catch {
        // If the inert socket cannot be confirmed stopped, retain the kernel
        // lease until process exit instead of allowing a split-brain restart.
        throw error;
      }
    }
    lease.release();
    throw error;
  }
}

export function announceStudioServer(server, options = {}) {
  const hostname = options.hostname || HOST;
  const token = requireStudioToken(options.token);
  const displayHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  const message = `PS4 AI Video Studio: http://${displayHost}:${server.port}/#token=${encodeURIComponent(token)}`;
  (options.logFn || console.log)(message);
  return message;
}

if (import.meta.main) {
  const startOptions = {
    allowLeaseMigration: process.env.PS4_ALLOW_SERVER_LEASE_MIGRATION === "1"
  };
  if (typeof process.env.PS4_STUDIO_TOKEN === "string" && process.env.PS4_STUDIO_TOKEN) {
    startOptions.token = process.env.PS4_STUDIO_TOKEN;
  }
  const server = await startStudioServer(startOptions);
  announceStudioServer(server, { hostname: HOST, token: server.studioToken });
}
