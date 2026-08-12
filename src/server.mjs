import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ANALYSIS_PATH,
  JOBS_DIR,
  ROOT,
  copyUpload,
  createJob,
  ensureWorkspace,
  listJobs,
  recoverSemanticRevalidationWorkspace,
  readGeminiSemanticRevalidationInputs,
  readAnalysis,
  readJob,
  runJob,
  SEMANTIC_REVALIDATION_MODE,
  updateJob
} from "./pipeline.mjs";
import { appendRunEvent, hashFile, readRunManifest, writeRunManifest } from "./run-ledger.mjs";
import { buildGeminiGenerationRequest, configuredGeminiJobProfile, geminiBrowserStatus, startGeminiBrowser } from "./gemini-browser.mjs";
import { buildLocalVideoRequest } from "./local-video-provider.mjs";
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
  readQualityRevisionState,
  runQualityLoop,
  saveCommitteeReview
} from "./quality.mjs";
import { ytDlpInfo } from "./yt-dlp.mjs";
import { redactGeminiMonitor } from "./gemini-monitor-privacy.mjs";
import { buildProviderReadiness } from "./provider-readiness.mjs";
import { createShotPatternReceipt, publicShotPatternCatalog, readShotPatternCatalog, verifyShotPatternReceipt } from "./shot-patterns.mjs";
import { loadSemanticRevalidationSource, verifySemanticRevalidationProviderZeroBinding } from "./semantic-revalidation-closure.mjs";
import { LOCAL_SEMANTIC_POLICY_BINDING } from "./local-semantic-verifier.mjs";

const PORT = Number(process.env.PORT || 3000);
export const DEFAULT_HOST = "127.0.0.1";
const HOST = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
const PUBLIC_DIR = join(ROOT, "public");
const activeJobs = new Set();
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/;
export const SESSION_COOKIE_NAME = "ps4_studio_session";
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 12;
export const MAX_UPLOAD_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;
const STUDIO_RUNTIME_DIR = join(ROOT, "workspace", ".runtime");
export const STUDIO_TOKEN_PATH = join(STUDIO_RUNTIME_DIR, "studio-token");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const JOB_LEASE_FILENAME = ".run.lock";
const JOB_LEASE_WINDOW_MS = 30 * 60 * 1000;
const JOB_LEASE_HEARTBEAT_MS = JOB_LEASE_WINDOW_MS / 3;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export { redactGeminiMonitor } from "./gemini-monitor-privacy.mjs";

export function createSessionToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 32) throw new Error("세션 토큰은 최소 32바이트여야 합니다.");
  return randomBytes(bytes).toString("base64url");
}

export function resolveStudioToken(explicitToken = "") {
  const token = String(explicitToken || "");
  if (!token) return createSessionToken();
  if (token !== token.trim() || /\s/.test(token) || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("PS4_STUDIO_TOKEN은 공백 없이 최소 32바이트여야 합니다.");
  }
  return token;
}

const STUDIO_TOKEN = resolveStudioToken(process.env.PS4_STUDIO_TOKEN);

function constantTimeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function redactJobResponse(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return job;
  const { geminiProfileDir: _geminiProfileDir, ...safe } = job;
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const semanticRevalidationReadiness = job.integrity?.status === "blocked"
    ? { eligible: false, reason: job.integrity.message || "봉인 run 무결성 검증이 차단되었습니다.", providerRequests: 0 }
    : job.semanticRevalidationSummary?.status === "sealed" && job.semanticRevalidationSummary.childRunId === job.runId
      ? { eligible: false, reason: "현재 run에는 purpose-aware 로컬 의미 재검수가 이미 적용되었습니다.", providerRequests: 0 }
    : job.provider === "gemini-browser" && job.status === "needs-improvement" && job.runStatus === "needs-improvement" && Boolean(job.runId)
      ? { eligible: true, sourceRunId: job.runId, providerRequests: 0, mode: SEMANTIC_REVALIDATION_MODE }
      : job.provider === "local-video" && job.status === "needs-improvement"
        ? { eligible: false, reason: "local-video 완료 영수증의 provider-0 resume 경로는 아직 지원하지 않습니다.", providerRequests: 0 }
        : { eligible: false, reason: "봉인된 개선 필요 Gemini run에서만 로컬 의미 재검수를 시작할 수 있습니다.", providerRequests: 0 };
  const projection = { ...safe, semanticRevalidationReadiness };
  return sessionBinding ? { ...projection, geminiSessionBinding: sessionBinding, geminiSessionBindingHash: geminiSessionBindingHash(job) } : projection;
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1" || value === "[::1]") return true;
  const octets = value.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function configuredOrigins(value = process.env.PS4_ALLOWED_ORIGINS || "") {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean).flatMap((item) => {
    try {
      const url = new URL(item);
      return url.origin === item ? [item] : [];
    } catch {
      return [];
    }
  });
}

export function isTrustedStudioOrigin(origin, allowedOrigins = configuredOrigins()) {
  try {
    const url = origin instanceof URL ? origin : new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return isLoopbackHostname(url.hostname) || allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function bearerValue(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] || "";
}

export function authorizeMutationRequest(request, url = new URL(request.url), options = {}) {
  const token = options.token || "";
  const allowedOrigins = options.allowedOrigins || configuredOrigins();
  if (!isTrustedStudioOrigin(url, allowedOrigins)) return { ok: false, status: 403, code: "untrusted-host" };
  const suppliedToken = bearerValue(request) || cookieValue(request, SESSION_COOKIE_NAME);
  if (SAFE_HTTP_METHODS.has(request.method.toUpperCase())) {
    if (!constantTimeTokenEqual(suppliedToken, token)) return { ok: false, status: 403, code: "invalid-session" };
    return { ok: true, code: bearerValue(request) ? "safe-bearer" : "safe-session" };
  }
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || origin !== url.origin || !isTrustedStudioOrigin(origin, allowedOrigins)) {
    return { ok: false, status: 403, code: "cross-origin" };
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return { ok: false, status: 403, code: "cross-site" };
  if (!constantTimeTokenEqual(suppliedToken, token)) return { ok: false, status: 403, code: "invalid-session" };
  return { ok: true, code: bearerValue(request) ? "bearer" : "session" };
}

export function createSessionCookie(token, { secure = false } = {}) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function shouldIssueSessionCookie(request, url = new URL(request.url), allowedOrigins = configuredOrigins()) {
  if (request.method !== "GET" || !["/", "/index.html"].includes(url.pathname) || !isTrustedStudioOrigin(url, allowedOrigins)) return false;
  const destination = request.headers.get("sec-fetch-dest");
  const mode = request.headers.get("sec-fetch-mode");
  const site = request.headers.get("sec-fetch-site");
  if (destination && destination !== "document") return false;
  if (mode && mode !== "navigate") return false;
  if (site && !["none", "same-origin"].includes(site)) return false;
  return true;
}

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
  const runtimeDir = resolve(tokenPath, "..");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  const temporaryPath = `${tokenPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, tokenPath);
    await chmod(tokenPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return tokenPath;
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
  return errorResponse(error, conflict ? 409 : 400);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("JSON 요청 본문을 읽지 못했습니다.");
  }
}
async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
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
async function readVerifiedImmutableArtifact(job, artifact, expectedName = artifact?.name) {
  if (!job?.runId || !artifact?.path || artifact.name !== expectedName) return null;
  const jobRoot = resolve(JOBS_DIR, job.id);
  const expectedPath = `runs/${job.runId}/artifacts/${String(artifact.name).replaceAll("/", "__")}`;
  if (artifact.path !== expectedPath) return null;
  const path = resolve(jobRoot, artifact.path);
  if (!path.startsWith(`${jobRoot}${sep}`)) return null;
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || Number(artifact.bytes) !== fileStat.size || !String(artifact.sha256 || "").startsWith("sha256:")) return null;
  if (await hashFile(path).catch(() => null) !== artifact.sha256) return null;
  return { path, value: await readOptionalJson(path) };
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
  const results = await Promise.all(immutableArtifacts.map(async (artifact) => {
    if (!artifact?.path || artifact.path !== expectedPath(artifact.name) || !String(artifact.sha256 || "").startsWith("sha256:")) return false;
    const path = resolve(JOBS_DIR, job.id, artifact.path);
    const fileStat = await stat(path).catch(() => null);
    return path.startsWith(`${resolve(JOBS_DIR, job.id)}${sep}`)
      && fileStat?.isFile()
      && Number(artifact.bytes) === fileStat.size
      && await hashFile(path).catch(() => null) === artifact.sha256;
  }));
  return results.every(Boolean) && await verifyImmutableSemanticRevalidationClosure(job, manifest);
}
async function verifyRevisionJobDeclarations(job, state) {
  const prefix = `runs/${job.runId}/revisions/`;
  const declared = (job.artifacts || []).filter((artifact) => String(artifact?.name || "").startsWith(prefix));
  if (new Set(declared.map((artifact) => artifact.name)).size !== declared.length) return false;
  const expected = new Map();
  for (const record of state.revisions) {
    const { manifest, manifestHash } = record;
    const manifestPath = `${prefix}${manifest.revisionId}/manifest.json`;
    const manifestStat = await stat(resolve(JOBS_DIR, job.id, manifestPath)).catch(() => null);
    if (!manifestStat?.isFile()) return false;
    expected.set(manifestPath, { sha256: manifestHash, bytes: manifestStat.size });
    for (const declaration of [manifest.committeeReview, manifest.quality, manifest.events]) {
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
  return provider === "local" && metrics.provider === "local" && metrics.providerProof === true && shotPatternClosureBound;
}

export async function verifyImmutableShotPatternClosure(job, provider, quality, manifest) {
  const metrics = quality?.metrics || {};
  const immutableArtifacts = Array.isArray(manifest?.immutableArtifacts) ? manifest.immutableArtifacts : [];
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
              sourceGenerationHash: receipt.sourceGenerationHash
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
    const manifestStat = await stat(resolve(JOBS_DIR, job.id, manifestPath));
    const values = [
      [{ path: manifest.committeeReview.path, sha256: manifest.committeeReview.sha256, bytes: manifest.committeeReview.bytes }, "committee-review-revision"],
      [{ path: manifest.quality.path, sha256: manifest.quality.sha256, bytes: manifest.quality.bytes }, "quality-revision"],
      [{ path: manifest.events.path, sha256: manifest.events.sha256, bytes: manifest.events.bytes }, "quality-revision-events"],
      [{ path: manifestPath, sha256: record.manifestHash, bytes: manifestStat.size }, "quality-revision-manifest"]
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

async function reconcileQualityRevisionJobUnlocked(job) {
  if (!job?.runId) return job;
  const runDir = join(JOBS_DIR, job.id, "runs", job.runId);
  const manifest = await readRunManifest(runDir);
  if (!manifest || !["completed", "needs-improvement"].includes(manifest.status)) return job;
  if (!(await verifyImmutableRun(job, manifest))) throw new Error("봉인된 base run의 불변 산출물 무결성 검증에 실패했습니다.");
  const provider = immutableRunProvider(manifest);
  if (!provider) throw new Error("봉인된 base run의 provider 요청·결정 결속이 유효하지 않습니다.");
  const state = await readQualityRevisionState(job.id, job.runId);
  const inputDeclaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/input-manifest.json`);
  const verifiedInput = await readVerifiedImmutableArtifact(job, inputDeclaration, `runs/${job.runId}/input-manifest.json`);
  if (!verifiedInput?.value || !immutableProviderClosureBound(provider, state.baseQuality.value, manifest, verifiedInput.value)) {
    throw new Error("봉인된 base run의 provider 증거 폐쇄가 유효하지 않습니다.");
  }
  if (!(await verifyImmutableShotPatternClosure(job, provider, state.baseQuality.value, manifest))) {
    throw new Error("봉인된 base run의 shot pattern 증거 폐쇄가 유효하지 않습니다.");
  }
  const revisionArtifacts = await revisionArtifactDeclarations(job, state);
  const revisionPrefix = `runs/${job.runId}/revisions/`;
  const baseArtifacts = (job.artifacts || []).filter((artifact) => !String(artifact?.name || "").startsWith(revisionPrefix));
  const quality = state.latestQuality || state.baseQuality.value;
  const effectiveStatus = state.effectiveStatus;
  const effectiveRunStatus = effectiveStatus === "completed" ? "verified" : "needs-improvement";
  const qualitySummary = state.latestManifest
    ? {
      status: quality.status,
      totalScore: quality.totalScore,
      threshold: quality.threshold,
      technicalEvidenceGate: quality.technicalEvidenceGate,
      semanticGate: quality.semanticGate,
      runId: quality.runId,
      blockers: quality.blockers,
      inputManifest: manifest.qualitySummary?.inputManifest || quality.inputManifest || quality.metrics?.inputManifest || null,
      revisionId: state.latestManifest.revisionId,
      revisionSequence: Number(state.latestManifest.sequence),
      revisionManifest: `runs/${job.runId}/revisions/${state.latestManifest.revisionId}/manifest.json`
    }
    : { ...manifest.qualitySummary };
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

export async function reconcileQualityRevisionJob(job, options = {}) {
  if (!job?.runId || activeJobs.has(job.id)) return job;
  if (options.leaseHeld === true) return reconcileQualityRevisionJobUnlocked(job);
  const lease = await acquireJobLease(job.id);
  if (!lease) return readJob(job.id);
  try {
    const locked = await readJob(job.id);
    if (locked.runId !== job.runId || ["running", "verifying"].includes(locked.status)) return locked;
    return await reconcileQualityRevisionJobUnlocked(locked);
  } finally {
    await releaseJobLease(lease);
  }
}

function integrityBlockedJobResponse(job) {
  return {
    ...job,
    integrity: {
      status: "blocked",
      code: "sealed-run-integrity-failure",
      message: "봉인된 실행의 무결성 검증에 실패해 자동 복구와 품질 판정을 차단했습니다.",
      mutableJobPreserved: true
    }
  };
}

export async function reconcileJobsIndependently(jobs, options = {}) {
  const results = [];
  for (const job of jobs) {
    if (options.revisionOnly === true && (!job.runId || !existsSync(join(JOBS_DIR, job.id, "runs", job.runId, "revisions")))) {
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
  const manifest = job?.runId ? await readRunManifest(join(JOBS_DIR, job.id, "runs", job.runId)) : null;
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
  const qualitySummaryFields = ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"];
  const summaryMatches = Boolean(
    manifest.qualitySummary
    && qualitySummaryFields.every((field) => JSON.stringify(manifest.qualitySummary[field]) === JSON.stringify(verified.value[field]))
  );
  const eventArtifact = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/events.jsonl`);
  const events = eventArtifact ? await readOptionalJsonLines(resolve(JOBS_DIR, job.id, eventArtifact.path)) : null;
  const terminal = Array.isArray(events) ? events.at(-1) : null;
  const terminalMatches = Boolean(
    terminal?.type === "quality_finalized"
    && terminal.jobId === job.id
    && terminal.runId === job.runId
    && terminal.status === manifest.runStatus
    && terminal.qualityHash === declaration.sha256
    && terminal.qualitySummary
    && qualitySummaryFields.every((field) => JSON.stringify(terminal.qualitySummary[field]) === JSON.stringify(verified.value[field]))
  );
  if (!summaryMatches || !terminalMatches) return null;
  const state = await readQualityRevisionState(job.id, job.runId).catch(() => null);
  if (!state || !(await verifyRevisionJobDeclarations(job, state))) return null;
  if (!state.latestManifest) {
    const expectedRunStatus = manifest.status === "completed" ? "verified" : "needs-improvement";
    if (
      job.status !== manifest.status
      || job.runStatus !== expectedRunStatus
      || job.provider !== provider
      || job.qualitySummary?.revisionId
      || job.qualitySummary?.revisionSequence
      || job.qualitySummary?.revisionManifest
      || qualitySummaryFields.some((field) => JSON.stringify(job.qualitySummary?.[field]) !== JSON.stringify(verified.value[field]))
    ) return null;
    return verified.value;
  }
  const revisionQuality = state.latestQuality;
  const revisionManifest = state.latestManifest;
  const expectedRunStatus = state.effectiveStatus === "completed" ? "verified" : "needs-improvement";
  if (
    !revisionQuality
    || job.status !== state.effectiveStatus
    || job.provider !== provider
    || job.runStatus !== expectedRunStatus
    || job.qualitySummary?.revisionId !== revisionManifest.revisionId
    || Number(job.qualitySummary?.revisionSequence) !== Number(revisionManifest.sequence)
    || job.qualitySummary?.revisionManifest !== `runs/${job.runId}/revisions/${revisionManifest.revisionId}/manifest.json`
    || qualitySummaryFields.some((field) => JSON.stringify(job.qualitySummary?.[field]) !== JSON.stringify(revisionQuality[field]))
  ) return null;
  return revisionQuality;
}

async function readVerifiedQualityHistory(job) {
  const quality = await readVerifiedQuality(job);
  if (!quality) return null;
  const manifest = job?.runId ? await readRunManifest(join(JOBS_DIR, job.id, "runs", job.runId)) : null;
  const declarations = (manifest?.immutableArtifacts || [])
    .filter((artifact) => /^quality\/iteration-\d+\.json$/.test(artifact?.name || ""))
    .sort((left, right) => left.name.localeCompare(right.name));
  const values = [];
  for (const declaration of declarations) {
    const verified = await readVerifiedImmutableArtifact(job, declaration);
    if (verified?.value?.jobId === job.id && verified.value.runId === job.runId) values.push(verified.value);
  }
  const state = await readQualityRevisionState(job.id, job.runId).catch(() => null);
  if (!state || !(await verifyRevisionJobDeclarations(job, state))) return null;
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

function isFreshRunningJob(job) {
  const startedAt = Date.parse(job.runStartedAt || job.updatedAt || "");
  return ["running", "verifying"].includes(job.status) && Number.isFinite(startedAt) && Date.now() - startedAt < JOB_LEASE_WINDOW_MS;
}
async function readLeaseRecord(lockPath) {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function leaseOwnerAlive(record) {
  return Boolean(record && Number.isInteger(record.pid) && isProcessAlive(record.pid));
}

async function acquireJobLease(jobId) {
  const lockPath = join(JOBS_DIR, jobId, JOB_LEASE_FILENAME);
  await mkdir(join(JOBS_DIR, jobId), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        const record = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
        const token = record.token;
        await handle.writeFile(JSON.stringify(record), "utf8");
        const heartbeat = setInterval(() => {
          try {
            if (typeof handle.utimes === "function") void handle.utimes(new Date(), new Date()).catch(() => {});
          } catch {
            // The lease is still guarded by the open descriptor if a heartbeat tick fails.
          }
        }, JOB_LEASE_HEARTBEAT_MS);
        heartbeat.unref?.();
        return { handle, heartbeat, lockPath, token };
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (!lockStat) continue;
      const job = await readJob(jobId).catch(() => null);
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (!job || isFreshRunningJob(job) || lockAge <= JOB_LEASE_WINDOW_MS) return null;
      const currentStat = await stat(lockPath).catch(() => null);
      if (!currentStat || currentStat.ino !== lockStat.ino || currentStat.mtimeMs !== lockStat.mtimeMs) continue;
      const leaseRecord = await readLeaseRecord(lockPath);
      if (leaseOwnerAlive(leaseRecord)) return null;
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw reclaimError;
      }
    }
  }
}

async function releaseJobLease(lease) {
  clearInterval(lease.heartbeat);
  try {
    const record = await readLeaseRecord(lease.lockPath);
    if (record?.token === lease.token) await unlink(lease.lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } finally {
    await lease.handle.close().catch(() => {});
  }
}

async function withQualityLease(jobId, callback) {
  if (activeJobs.has(jobId)) return null;
  const current = await readJob(jobId);
  if (["running", "verifying"].includes(current.status)) return null;
  if (!current.runId) return null;
  const lease = await acquireJobLease(jobId);
  if (!lease) return null;
  try {
    const locked = await reconcileQualityRevisionJob(await readJob(jobId), { leaseHeld: true });
    if (locked.runId !== current.runId || ["running", "verifying"].includes(locked.status)) return null;
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
async function rehydrateCompletedRun(job, manifest) {
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const jobRoot = resolve(JOBS_DIR, job.id);
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
  const verified = await Promise.all(immutableArtifacts.map(async (artifact) => {
    if (!artifact?.name || artifact.path !== expectedPath(artifact.name) || !String(artifact.sha256 || "").startsWith("sha256:")) return false;
    const path = resolve(jobRoot, artifact.path);
    if (!(path.startsWith(`${jobRoot}${sep}`) && (await stat(path).catch(() => null))?.isFile())) return false;
    const fileStat = await stat(path);
    return Number(artifact.bytes) === fileStat.size && await hashFile(path) === artifact.sha256;
  }));
  if (!verified.every(Boolean)) return null;
  if (!(await verifyImmutableSemanticRevalidationClosure(job, manifest))) return null;
  const eventArtifact = immutableArtifacts.filter((artifact) => artifact.name === `runs/${job.runId}/events.jsonl` && artifact.path === expectedPath(artifact.name)).at(-1);
  if (!eventArtifact) return null;
  const eventPath = resolve(jobRoot, eventArtifact.path);
  const events = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
  const quality = qualityArtifact ? JSON.parse(await readFile(resolve(jobRoot, qualityArtifact.path), "utf8")) : null;
  if (!quality || quality.jobId !== job.id || quality.runId !== job.runId) return null;
  if (sealedStatus === "completed" && (quality.status !== "passed" || quality.semanticGate !== true)) return null;
  if (sealedStatus === "needs-improvement" && (quality.status === "passed" || quality.semanticGate === true)) return null;
  const immutableByName = new Map(immutableArtifacts.map((artifact) => [artifact?.name, artifact]));
  const readImmutableJson = async (name) => {
    const declaration = immutableByName.get(name);
    if (!declaration) return null;
    return readOptionalJson(resolve(jobRoot, declaration.path));
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
              sourceGenerationHash: shotPatternReceipt.sourceGenerationHash
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
    const request = buildLocalVideoRequest({
      id: job.id,
      topic: manifest.request.topic || "",
      format: manifest.request.format || "vertical",
      targetDurationSec: Number(manifest.request.targetDurationSec || 0),
      targetDurationRangeSec: manifest.request.targetDurationRangeSec || null
    }, scriptArtifact, job.runId, scriptHash);
    const requestHash = request.requestHash;
    if (
      !receipt
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
  const qualitySummaryFields = ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"];
  const summaryMatches = Boolean(manifestQualitySummary && qualitySummaryFields.every((field) => JSON.stringify(manifestQualitySummary[field]) === JSON.stringify(quality[field])));
  const terminalEvent = events.at(-1);
  const terminalSummary = terminalEvent?.qualitySummary;
  const terminalEventBound = Boolean(
    terminalEvent?.type === "quality_finalized"
      && terminalEvent.jobId === job.id
      && terminalEvent.runId === job.runId
      && terminalEvent.status === manifest.runStatus
      && terminalEvent.qualityHash === qualityArtifact.sha256
      && terminalSummary?.runId === quality.runId
      && qualitySummaryFields.every((field) => JSON.stringify(terminalSummary[field]) === JSON.stringify(quality[field]))
  );
  if (!providerDecisionBound || !summaryMatches || !terminalEventBound) return null;
  const qualitySummary = {
    status: quality.status,
    totalScore: quality.totalScore,
    threshold: quality.threshold,
    technicalEvidenceGate: quality.technicalEvidenceGate,
    semanticGate: quality.semanticGate,
    runId: quality.runId,
    blockers: quality.blockers,
    inputManifest: manifestQualitySummary.inputManifest || quality.inputManifest || quality.metrics?.inputManifest || null
  };
  const artifactUrl = (path) => `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(path)}`;
  const immutableDeclarations = immutableArtifacts.map(({ path, kind }) => ({ name: path, kind: `immutable-${kind || "artifact"}`, url: artifactUrl(path) }));
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
    artifacts: [...immutableDeclarations, { name: `runs/${job.runId}/manifest.json`, kind: "run-manifest", url: `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(`runs/${job.runId}/manifest.json`)}` }],
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

async function closeStaleRun(job) {
  if (!job.runId) return;
  const runDir = join(JOBS_DIR, job.id, "runs", job.runId);
  const manifest = await readRunManifest(runDir);
  const recoveredAt = new Date().toISOString();
  if (!manifest) {
    await mkdir(runDir, { recursive: true });
    await writeRunManifest(runDir, {
      schemaVersion: 1,
      jobId: job.id,
      runId: job.runId,
      status: "failed",
      runStatus: "failed",
      failedAt: recoveredAt,
      artifacts: [],
      immutableArtifacts: [],
      recovery: { type: "stale-lease", recoveredAt, reason: "stale job lease recovered without a readable manifest" }
    });
    return;
  }
  await appendRunEvent(runDir, {
    type: "recovered_stale",
    status: "failed",
    reason: "stale job lease recovered",
    runId: job.runId
  });
  const eventsPath = join(runDir, "events.jsonl");
  await writeRunManifest(runDir, {
    ...manifest,
    status: "failed",
    runStatus: "failed",
    failedAt: recoveredAt,
    artifacts: [],
    immutableArtifacts: [],
    eventLog: { path: `runs/${job.runId}/events.jsonl`, sha256: await hashFile(eventsPath) },
    recovery: {
      type: "stale-lease",
      recoveredAt,
      reason: "stale job lease recovered"
    }
  });
}

async function recoverStaleJob(job) {
  if (!["running", "verifying"].includes(job.status) || isFreshRunningJob(job)) return job;
  let lease = null;
  let current = null;
  try {
    lease = await acquireJobLease(job.id);
    if (!lease) return job;
    current = await readJob(job.id).catch(() => null);
    if (!current || !["running", "verifying"].includes(current.status) || isFreshRunningJob(current)) return current || job;
    const leaseRecord = await readLeaseRecord(lease.lockPath);
    if (!leaseRecord || leaseRecord.token !== lease.token) return current;
    const runManifest = current.runId ? await readRunManifest(join(JOBS_DIR, current.id, "runs", current.runId)) : null;
    if (["completed", "needs-improvement"].includes(runManifest?.status)) {
      const restored = await rehydrateCompletedRun(current, runManifest);
      if (restored) return restored;
    }
    await closeStaleRun(current);
    return await updateJob(job.id, {
      status: "failed",
      stage: "오류",
      message: "이전 실행 프로세스가 종료되어 작업을 중단했습니다. 다시 실행하세요.",
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  } catch (error) {
    let closureError = null;
    try {
      await closeStaleRun(current);
    } catch (closeError) {
      closureError = closeError;
      if (current?.runId) {
        const runDir = join(JOBS_DIR, current.id, "runs", current.runId);
        const manifest = await readRunManifest(runDir).catch(() => null);
        if (manifest) {
          await writeRunManifest(runDir, {
            ...manifest,
            status: "failed",
            runStatus: "failed",
            failedAt: new Date().toISOString(),
            artifacts: [],
            immutableArtifacts: [],
            recovery: { type: "stale-rehydrate-failed", reason: closeError.message }
          }).catch(() => {});
        }
      }
    }
    return await updateJob(job.id, {
      status: "failed",
      stage: "오류",
      message: `이전 실행 복구에 실패했습니다: ${error.message}`,
      error: [error.stack || error.toString(), closureError ? `stale-run closure failed: ${closureError.message}` : null].filter(Boolean).join("\n"),
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  } finally {
    if (lease) await releaseJobLease(lease).catch(() => {});
  }
}

async function recoverStaleJobs(jobs) {
  return Promise.all(jobs.map((job) => recoverStaleJob(job)));
}

async function recoverSemanticRevalidationTransactions() {
  const entries = await readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || activeJobs.has(entry.name)) continue;
    const jobDir = join(JOBS_DIR, entry.name);
    const transactionPath = join(jobDir, ".semantic-revalidation-transaction.json");
    if (!(await stat(transactionPath).catch(() => null))?.isFile()) continue;
    const lease = await acquireJobLease(entry.name).catch((error) => {
      console.error(`job ${entry.name} semantic revalidation recovery lease failed: ${error.message}`);
      return null;
    });
    if (!lease) continue;
    try {
      await recoverSemanticRevalidationWorkspace(jobDir);
    } catch (error) {
      console.error(`job ${entry.name} semantic revalidation transaction recovery failed: ${error.message}`);
    } finally {
      await releaseJobLease(lease).catch((error) => {
        console.error(`job ${entry.name} semantic revalidation recovery lease release failed: ${error.message}`);
      });
    }
  }
}
export async function sealQualityRevision(jobId, runId, context, review, evaluatedQuality) {
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
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
  if (existsSync(revisionDir)) throw new Error("같은 revisionId의 품질 revision이 이미 봉인되었습니다.");
  await mkdir(revisionsDir, { recursive: true });
  await mkdir(stagingDir);
  const relative = (name) => `runs/${runId}/revisions/${revisionId}/${name}`;
  const artifactUrl = (name) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
  const declaration = async (stagedPath, name) => ({ path: relative(name), sha256: await hashFile(stagedPath), bytes: (await stat(stagedPath)).size });
  let published = false;
  try {
    const reviewPath = join(stagingDir, "committee-review.json");
    await writeFile(reviewPath, JSON.stringify(review, null, 2));
    const reviewDeclaration = await declaration(reviewPath, "committee-review.json");

    const quality = bindQualityRevision(evaluatedQuality, context, reviewDeclaration.sha256);
    const qualityPath = join(stagingDir, "quality.json");
    await writeFile(qualityPath, JSON.stringify(quality, null, 2));
    const qualityDeclaration = await declaration(qualityPath, "quality.json");

    const eventRecord = buildQualityRevisionEvent({
      context,
      committeeReview: reviewDeclaration,
      qualityArtifact: qualityDeclaration,
      transition: quality.revision.transition
    });
    const eventsPath = join(stagingDir, "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(eventRecord)}\n`);
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
    await writeFile(revisionManifestPath, JSON.stringify(revisionManifest, null, 2));
    const manifestDeclaration = await declaration(revisionManifestPath, "manifest.json");

    const publishContext = await prepareQualityRevision(jobId, runId, revisionId);
    if (canonicalJsonHash(publishContext) !== canonicalJsonHash(context)) throw new Error("품질 revision 봉인 중 append-only head가 변경되었습니다.");
    if (existsSync(revisionDir)) throw new Error("같은 revisionId의 품질 revision이 이미 봉인되었습니다.");
    await rename(stagingDir, revisionDir);
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
    if (!published) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function markLaunchFailure(jobId, error) {
  const current = await readJob(jobId).catch(() => null);
  if (!current || current.status === "completed") return current;
  return updateJob(jobId, {
    status: "failed",
    stage: "오류",
    message: `실행 시작 실패: ${error.message}`,
    error: error.stack || error.toString(),
    runStatus: "failed",
    warnings: [...(current.warnings || []), `실행 시작 실패: ${error.message}`]
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
  const manifest = await readRunManifest(runDir);
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
  const manifestHash = await hashFile(join(JOBS_DIR, job.id, manifestPath));
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
      const locked = await reconcileQualityRevisionJob(await readJob(jobId), { leaseHeld: true });
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

async function startJob(jobId, options = {}) {
  if (activeJobs.has(jobId)) return false;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  void withJob(jobId, async () => {
    let lease = null;
    try {
      lease = await acquireJobLease(jobId);
      if (!lease) {
        resolveStarted(false);
        return;
      }
      resolveStarted(true);
      await runJob(jobId, options);
    } catch (error) {
      console.error(`job ${jobId} failed to start: ${error.message}`);
      await markLaunchFailure(jobId, error).catch((persistError) => console.error(`job ${jobId} start failure persistence failed: ${persistError.message}`));
      resolveStarted(false);
    } finally {
      if (lease) await releaseJobLease(lease);
    }
  }).catch(async (error) => {
    console.error(`job ${jobId} runner failed: ${error.message}`);
    await markLaunchFailure(jobId, error).catch((persistError) => console.error(`job ${jobId} runner failure persistence failed: ${persistError.message}`));
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
      geminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      localVideoGenerator: Boolean(String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()),
      ytDlp
    },
    analysis: existsSync(ANALYSIS_PATH),
    rlmAnalysis: existsSync(join(ROOT, "data/rlm-benchmark-analysis.json"))
  };
}

async function handleApi(request, url, runtimeOptions = {}) {
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") return json(await health());
  if (path === "/api/gemini/monitor" && request.method === "GET") {
    const monitor = await readOptionalJson(join(ROOT, "workspace", "gemini-monitor.json")) || { schemaVersion: 2, status: "not-running", profiles: [] };
    return json(redactGeminiMonitor(monitor));
  }
  if (path === "/api/providers/readiness" && request.method === "GET") {
    return json(await buildProviderReadiness({ root: ROOT }));
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
    await recoverSemanticRevalidationTransactions();
    const recovered = await recoverStaleJobs(await listJobs());
    const jobs = await reconcileJobsIndependently(recovered);
    return json({ jobs: jobs.map(redactJobResponse) });
  }
  if (path === "/api/jobs" && request.method === "POST") {
    try {
      const body = await readJson(request);
      if (!body.topic || String(body.topic).trim().length < 4) throw new Error("영상 주제를 4자 이상 입력하세요.");
      const requestedProvider = body.provider === undefined ? "gemini-browser" : body.provider;
      if (requestedProvider === "local-video" && body.autoStart === true && !String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()) {
        throw new Error("PS4_LOCAL_VIDEO_GENERATOR가 설정되지 않아 local-video 작업을 시작할 수 없습니다.");
      }
      const createInput = requestedProvider === "gemini-browser"
        && body.geminiCdpUrl === undefined
        && body.geminiProfileDir === undefined
        ? { ...body, ...configuredGeminiJobProfile() }
        : body;
      const job = await createJob(createInput);
      if (job.provider === "gemini-browser" && body.autoStart !== false) {
        await startJob(job.id);
      } else if (body.autoStart === true) {
        if (job.provider === "local-video") {
          if (!String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()) throw new Error("PS4_LOCAL_VIDEO_GENERATOR가 설정되지 않아 local-video 자동 시작을 수행할 수 없습니다.");
          await startJob(job.id);
        } else {
          if (!(await hasUploadedVideo(job.id))) throw new Error("로컬 자동 시작에는 업로드된 영상 클립이 하나 이상 필요합니다.");
          await startJob(job.id);
        }
      }
      return json({ job: redactJobResponse(job) }, 201);
    } catch (error) {
      return errorResponse(error, 400);
    }
  }
  if (path === "/api/browser/start" && request.method === "POST") return json(redactGeminiMonitor(await startGeminiBrowser()));

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2] || "";
    if (!JOB_ID_PATTERN.test(jobId)) return errorResponse(new Error("잘못된 작업 ID입니다."), 400);
    if (request.method === "GET" && suffix === "quality") {
      const current = await reconcileQualityRevisionJob(await readJob(jobId));
      if (!current.runId) return errorResponse(new Error("현재 실행 산출물이 없어 품질 검사를 시작할 수 없습니다."), 409);
      const quality = await readVerifiedQuality(current);
      if (!quality) return errorResponse(new Error("봉인된 현재 품질 산출물을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json(redactGeminiMonitor(quality));
    }
    if (request.method === "GET" && suffix === "quality/history") {
      const current = await reconcileQualityRevisionJob(await readJob(jobId));
      if (!current.runId) return json({ iterations: [] });
      const iterations = await readVerifiedQualityHistory(current);
      if (iterations === null) return errorResponse(new Error("봉인된 품질 이력을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json(redactGeminiMonitor({ iterations }));
    }
    if (request.method === "POST" && suffix === "quality/evaluate") {
      try {
        const body = await readJson(request);
        if (body.runId && body.runId !== (await readJob(jobId)).runId) return errorResponse(new Error("품질 검사는 현재 작업의 runId만 허용합니다."), 409);
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
        if (body.runId && body.runId !== (await readJob(jobId)).runId) return errorResponse(new Error("품질 반복 검사는 현재 작업의 runId만 허용합니다."), 409);
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
          return { review, quality, revision, job: redactJobResponse(job) };
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 reviewer payload 검증을 시작할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "GET" && !suffix) return json(redactJobResponse(await reconcileQualityRevisionJob(await readJob(jobId))));
    if (request.method === "POST" && suffix === "semantic/revalidate") {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return errorResponse(error, 400);
      }
      if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).sort().join(",") !== "sourceRunId"
        || typeof body.sourceRunId !== "string"
      ) return errorResponse(new Error("sourceRunId만 포함한 JSON 요청이 필요합니다."), 400);
      const current = await readJob(jobId);
      if (activeJobs.has(jobId) || isFreshRunningJob(current)) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
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
      const current = await reconcileQualityRevisionJob(await readJob(jobId));
      if (activeJobs.has(jobId) || isFreshRunningJob(current)) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      if (!(await startJob(jobId))) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      return json({ started: true, job: redactJobResponse(await readJob(jobId)) });
    }
    if (request.method === "POST" && suffix === "clips") {
      validateRequestContentLength(request);
      if (activeJobs.has(jobId)) return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
      const current = await readJob(jobId);
      if (isFreshRunningJob(current)) return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
      const lease = await acquireJobLease(jobId);
      if (!lease) return errorResponse(new Error("다른 프로세스가 작업을 사용 중입니다."), 409);
      try {
        const form = await request.formData();
        const files = form.getAll("files").filter((value) => value instanceof File);
        validateUploadBatch(files);
        for (const file of files) {
          const extension = extname(file.name).toLowerCase();
          if (!VIDEO_EXTENSIONS.has(extension) || (file.type && !file.type.startsWith("video/"))) throw requestError("MP4, MOV, WebM 영상만 업로드할 수 있습니다.", 400);
        }
        const jobDir = join(JOBS_DIR, jobId);
        const stagingDir = join(jobDir, `.clips-upload-${randomUUID()}`);
        const previousClipsDir = join(jobDir, `.clips-previous-${randomUUID()}`);
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });
        try {
          const uploaded = [];
          for (const file of files) uploaded.push(await copyUpload(jobId, file, stagingDir));
          await updateJob(jobId, {
            message: `${uploaded.length}개 클립 업로드를 반영하는 중입니다. 기존 실행 증거를 무효화합니다.`,
            stage: "소스 준비",
            status: "queued",
            runId: null,
            runStatus: "queued",
            qualitySummary: null,
            artifacts: [],
            duration: null,
            error: null
          });
          const clipsDir = join(jobDir, "clips");
          const hadPreviousClips = existsSync(clipsDir);
          if (hadPreviousClips) await rename(clipsDir, previousClipsDir);
          try {
            await rename(stagingDir, clipsDir);
          } catch (error) {
            if (hadPreviousClips) await rename(previousClipsDir, clipsDir).catch(() => {});
            throw error;
          }
          await rm(previousClipsDir, { recursive: true, force: true });
          const mutableFiles = [
            "final.mp4",
            "assembled.mp4",
            "voiced.mp4",
            "voiceover.aiff",
            "concat.txt",
            "captions.srt",
            "captions.vtt",
            "caption-timing.json",
            "script.json",
            "sources.json",
            "frame-audio-caption.json",
            "thumbnail.jpg",
            "quality.json",
            "committee-review.json",
            "gemini-generation.json"
          ];
          await Promise.all(mutableFiles.map((name) => unlink(join(jobDir, name)).catch(() => {})));
          await rm(join(jobDir, "quality"), { recursive: true, force: true });
          await rm(join(jobDir, "normalized"), { recursive: true, force: true });
          await mkdir(join(jobDir, "normalized"), { recursive: true });
          const finalizedUploads = uploaded.map((item) => ({ ...item, path: join(clipsDir, basename(item.path)) }));
          const job = await updateJob(jobId, { message: `${uploaded.length}개 클립이 업로드되었습니다. 기존 실행 증거를 무효화하고 새 실행을 대기합니다.` });
          return json({ uploaded: finalizedUploads, job: redactJobResponse(job) }, 201);
        } finally {
          await rm(stagingDir, { recursive: true, force: true });
        }
      } finally {
        await releaseJobLease(lease);
      }
    }
    if (request.method === "GET" && suffix.startsWith("artifacts/")) {
      let filename;
      try {
        filename = decodeURIComponent(suffix.slice("artifacts/".length));
      } catch {
        return errorResponse(new Error("잘못된 산출물 경로입니다."), 400);
      }
      let artifact;
      try {
        artifact = safeArtifactPath(jobId, filename);
      } catch (error) {
        return errorResponse(error, 403);
      }
      const job = await reconcileQualityRevisionJob(await readJob(jobId));
      const declaredArtifacts = new Set(Array.isArray(job.artifacts) ? job.artifacts.map((entry) => entry?.name).filter((name) => typeof name === "string") : []);
      if (!declaredArtifacts.has(filename)) return errorResponse(new Error("선언되지 않은 작업 산출물입니다."), 404);
      const immutableMatch = /^runs\/([^/]+)\/artifacts\/(.+)$/.exec(filename);
      if (immutableMatch) {
        const [, immutableRunId] = immutableMatch;
        const manifest = await readRunManifest(join(JOBS_DIR, jobId, "runs", immutableRunId));
        const declaration = manifest?.immutableArtifacts?.find((entry) => entry?.path === filename);
        if (immutableRunId !== job.runId || manifest?.jobId !== jobId || manifest?.runId !== immutableRunId || !declaration?.sha256) {
          return errorResponse(new Error("불변 산출물 무결성 선언을 찾지 못했습니다."), 409);
        }
        const actualHash = await hashFile(artifact).catch(() => null);
        if (actualHash !== declaration.sha256) return errorResponse(new Error("불변 산출물 무결성 검증에 실패했습니다."), 409);
      }
      const revisionMatch = /^runs\/([^/]+)\/revisions\/([^/]+)\/(manifest\.json|committee-review\.json|quality\.json|events\.jsonl)$/.exec(filename);
      if (filename.includes("/revisions/") && !revisionMatch) return errorResponse(new Error("허용되지 않은 품질 revision 산출물 경로입니다."), 404);
      if (revisionMatch) {
        const [, revisionRunId, revisionId, revisionFile] = revisionMatch;
        const state = revisionRunId === job.runId ? await readQualityRevisionState(jobId, revisionRunId).catch(() => null) : null;
        const record = state?.revisions.find((entry) => entry.manifest.revisionId === revisionId);
        const jobDeclarations = (job.artifacts || []).filter((entry) => entry?.name === filename);
        const internalDeclaration = revisionFile === "manifest.json"
          ? null
          : revisionFile === "committee-review.json"
            ? record?.manifest.committeeReview
            : revisionFile === "quality.json"
              ? record?.manifest.quality
              : record?.manifest.events;
        const fileStat = await stat(artifact).catch(() => null);
        const expectedHash = revisionFile === "manifest.json" ? record?.manifestHash : internalDeclaration?.sha256;
        const expectedBytes = revisionFile === "manifest.json" ? fileStat?.size : internalDeclaration?.bytes;
        if (
          !state
          || !record
          || !(await verifyRevisionJobDeclarations(job, state))
          || jobDeclarations.length !== 1
          || jobDeclarations[0].sha256 !== expectedHash
          || Number(jobDeclarations[0].bytes) !== Number(expectedBytes)
          || !fileStat?.isFile()
          || fileStat.size !== Number(expectedBytes)
        ) {
          return errorResponse(new Error("품질 revision 무결성 선언을 찾지 못했습니다."), 409);
        }
        const actualHash = await hashFile(artifact).catch(() => null);
        if (actualHash !== expectedHash) return errorResponse(new Error("품질 revision 무결성 검증에 실패했습니다."), 409);
      }
      const file = Bun.file(artifact);
      if (!(await file.exists())) return errorResponse(new Error("파일을 찾지 못했습니다."), 404);
      const headers = { "content-type": contentType(artifact), "cache-control": "no-store" };
      if (filename === "final.mp4") headers["content-disposition"] = `inline; filename="${filename}"`;
      return new Response(file, { headers });
    }
  }
  return null;
}

async function serveStatic(request, url, token, allowedOrigins) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const path = resolve(PUBLIC_DIR, requested);
  if (!(path === PUBLIC_DIR || path.startsWith(`${PUBLIC_DIR}${sep}`))) return new Response("Not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": contentType(path),
    "cache-control": requested === "index.html" ? "no-store" : "no-cache",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
  if (shouldIssueSessionCookie(request, url, allowedOrigins)) {
    headers["set-cookie"] = createSessionCookie(token, { secure: url.protocol === "https:" });
  }
  return new Response(file, { headers });
}

export function createStudioRequestHandler(options = {}) {
  const token = options.token || STUDIO_TOKEN;
  const allowedOrigins = options.allowedOrigins || configuredOrigins();
  return async function studioFetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        const authorization = authorizeMutationRequest(request, url, { token, allowedOrigins });
        if (!authorization.ok) return errorResponse(new Error("API 요청의 host, 출처 또는 세션을 확인할 수 없습니다."), authorization.status);
        const response = await handleApi(request, url, options);
        return response || errorResponse(new Error("API 경로를 찾지 못했습니다."), 404);
      }
      return await serveStatic(request, url, token, allowedOrigins);
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
  const token = options.token || STUDIO_TOKEN;
  const allowedOrigins = options.allowedOrigins || configuredOrigins();
  const tokenPath = options.tokenPath || STUDIO_TOKEN_PATH;
  await ensureWorkspace();
  await recoverSemanticRevalidationTransactions();
  const recoveredJobs = await recoverStaleJobs(await listJobs());
  await reconcileJobsIndependently(recoveredJobs, {
    revisionOnly: true,
    onIntegrityError: (job, error) => console.error(`job ${job.id} quality revision reconciliation failed: ${error.message}`)
  });
  const server = Bun.serve({
    hostname,
    port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: createStudioRequestHandler({ token, allowedOrigins })
  });
  try {
    await persistStudioToken(token, tokenPath);
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return server;
}

if (import.meta.main) {
  const server = await startStudioServer();
  const displayHost = HOST.includes(":") && !HOST.startsWith("[") ? `[${HOST}]` : HOST;
  console.log(`PS4 AI Video Studio: http://${displayHost}:${server.port}`);
}
