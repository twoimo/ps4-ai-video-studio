import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hashFile } from "./run-ledger.mjs";
import { buildBflExecutorSnapshotDigest } from "./bfl-executor-snapshot.mjs";

export const BFL_PAID_APPROVAL_SCHEMA_VERSION = 1;
export const BFL_PAID_APPROVAL_NAME = "bfl-paid-approval.json";
export const BFL_PAID_CLAIM_PREFIX = "bfl-paid-claim-";
export const BFL_PROVIDER_EXECUTION_PREFIX = "bfl-paid-provider-execution-";
export const BFL_MODEL = "flux-3-video";
export const BFL_MODEL_VERSION = "latest";
export const BFL_CREDIT_USD = 0.01;
export const BFL_OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND = Object.freeze({ hd: 17, fhd: 29 });
export const BFL_MIN_CLIP_DURATION_SEC = 5;
export const BFL_MAX_CLIP_DURATION_SEC = 20;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_APPROVAL_RECEIPT_BYTES = 1024 * 1024;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function hashBflApprovalValue(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function contextHashFor(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const { contextHash: _contextHash, ...unsigned } = context;
  return hashBflApprovalValue(unsigned);
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalBflRequestHash(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const {
    paidAuthorization: _paidAuthorization,
    requestHash: _requestHash,
    ...canonicalRequest
  } = request;
  return hashBflApprovalValue(canonicalRequest);
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}은 양수여야 합니다.`);
  return number;
}

function jobBinding(job) {
  if (!job || !JOB_ID.test(String(job.id || "")) || job.provider !== "local-video") {
    throw new Error("BFL 유료 승인은 안전한 local-video 작업에만 만들 수 있습니다.");
  }
  const binding = {
    jobId: job.id,
    provider: job.provider,
    topic: String(job.topic || ""),
    format: String(job.format || ""),
    clipCount: Number(job.clipCount),
    targetDurationSec: Number(job.targetDurationSec),
    targetDurationRangeSec: Array.isArray(job.targetDurationRangeSec) ? job.targetDurationRangeSec.map(Number) : null,
    captions: job.captions !== false,
    voiceover: job.voiceover !== false,
    createdAt: String(job.createdAt || "")
  };
  if (
    !binding.topic
    || !["vertical", "landscape"].includes(binding.format)
    || !Number.isInteger(binding.clipCount)
    || binding.clipCount < 1
    || !Number.isInteger(binding.targetDurationSec)
    || binding.targetDurationSec < 1
    || !Number.isFinite(Date.parse(binding.createdAt))
  ) throw new Error("BFL 승인용 작업 결속 정보가 완전하지 않습니다.");
  return binding;
}

function validJobBinding(binding) {
  return Boolean(
    binding
    && typeof binding === "object"
    && !Array.isArray(binding)
    && JOB_ID.test(String(binding.jobId || ""))
    && binding.provider === "local-video"
    && typeof binding.topic === "string"
    && binding.topic.length > 0
    && ["vertical", "landscape"].includes(binding.format)
    && Number.isInteger(binding.clipCount)
    && binding.clipCount > 0
    && Number.isInteger(binding.targetDurationSec)
    && binding.targetDurationSec > 0
    && (binding.targetDurationRangeSec === null || (
      Array.isArray(binding.targetDurationRangeSec)
      && binding.targetDurationRangeSec.length === 2
      && binding.targetDurationRangeSec.every(Number.isFinite)
    ))
    && typeof binding.captions === "boolean"
    && typeof binding.voiceover === "boolean"
    && Number.isFinite(Date.parse(binding.createdAt || ""))
  );
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(","));
}

function validBflRequestSegment(segment, index) {
  const baseKeys = ["caption", "durationHint", "index", "narration", "prompt", "visualPrompt"];
  const hasShotPattern = Object.hasOwn(segment || {}, "shotPattern")
    || Object.hasOwn(segment || {}, "providerVisualPrompt")
    || Object.hasOwn(segment || {}, "providerVisualPromptHash");
  const expectedKeys = hasShotPattern
    ? [...baseKeys, "providerVisualPrompt", "providerVisualPromptHash", "shotPattern"]
    : baseKeys;
  if (
    !exactKeys(segment, expectedKeys)
    || segment.index !== index
    || !(segment.durationHint === null || (Number.isFinite(segment.durationHint) && segment.durationHint > 0))
    || typeof segment.prompt !== "string"
    || !segment.prompt.trim()
    || typeof segment.visualPrompt !== "string"
    || typeof segment.caption !== "string"
    || typeof segment.narration !== "string"
  ) return false;
  if (!hasShotPattern) return true;
  return typeof segment.providerVisualPrompt === "string"
    && segment.providerVisualPrompt === segment.prompt
    && /^sha256:[a-f0-9]{64}$/u.test(segment.providerVisualPromptHash || "")
    && exactKeys(segment.shotPattern, [
      "applicationMode", "continuityContractHash", "factualTextAdded", "patternId", "providerEligible",
      "providerSubmissionPlanned", "renderedCameraPromptHash", "sourceUrls"
    ]);
}

function exactBflSignedRequestShape(request) {
  const baseKeys = [
    "captions", "clipCount", "format", "jobCreatedAt", "jobId", "provider", "requestHash", "runId",
    "schemaVersion", "scriptHash", "segments", "targetDurationRangeSec", "targetDurationSec", "topic", "voiceover"
  ];
  const expectedKeys = [
    ...baseKeys,
    ...(request?.shotPatternPlan ? ["shotPatternPlan"] : []),
    ...(request?.paidAuthorization ? ["paidAuthorization"] : [])
  ];
  if (!exactKeys(request, expectedKeys) || request.schemaVersion !== 1) return false;
  if (!Array.isArray(request.segments) || !request.segments.every((segment, index) => validBflRequestSegment(segment, index + 1))) return false;
  return !request.shotPatternPlan || exactKeys(request.shotPatternPlan, [
    "applicationMode", "catalogHash", "catalogId", "continuityContractHash", "planHash", "providerEligible",
    "providerSubmissionPlanned"
  ]);
}

function requestMatchesJobBinding(request, binding) {
  return Boolean(
    validJobBinding(binding)
    && exactBflSignedRequestShape(request)
    && request?.jobId === binding.jobId
    && request.provider === "local-video"
    && request.topic === binding.topic
    && request.format === binding.format
    && request.clipCount === binding.clipCount
    && Array.isArray(request.segments)
    && request.segments.length === binding.clipCount
    && request.targetDurationSec === binding.targetDurationSec
    && hashBflApprovalValue(request.targetDurationRangeSec ?? null) === hashBflApprovalValue(binding.targetDurationRangeSec)
    && request.captions === binding.captions
    && request.voiceover === binding.voiceover
    && request.jobCreatedAt === binding.createdAt
    && ["jobWorkingDirectory", "workingDirectory", "jobDir", "workDir"].every((field) => request[field] === undefined)
  );
}

function taskDurationForJob(job, index) {
  const explicitHints = Array.isArray(job?.bflDurationHints) ? job.bflDurationHints : null;
  const hinted = Number(explicitHints?.[index]);
  const fallback = Number(job?.targetDurationSec) / Math.max(1, Number(job?.clipCount));
  const value = Number.isFinite(hinted) && hinted > 0
    ? hinted
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : BFL_MIN_CLIP_DURATION_SEC;
  return Math.min(BFL_MAX_CLIP_DURATION_SEC, Math.max(BFL_MIN_CLIP_DURATION_SEC, Math.round(value)));
}

function paidRequestPolicy(job, env) {
  const resolution = String(env.BFL_VIDEO_RESOLUTION || "hd").trim().toLowerCase();
  const audioRaw = String(env.BFL_GENERATE_AUDIO || "").trim().toLowerCase();
  if (audioRaw && !["1", "true", "yes", "on", "0", "false", "no", "off"].includes(audioRaw)) {
    throw new Error("BFL_GENERATE_AUDIO는 true 또는 false여야 합니다.");
  }
  const generateAudio = ["1", "true", "yes", "on"].includes(audioRaw);
  const safetyRaw = env.BFL_SAFETY_TOLERANCE === undefined || env.BFL_SAFETY_TOLERANCE === ""
    ? 2
    : Number(env.BFL_SAFETY_TOLERANCE);
  if (!Number.isInteger(safetyRaw) || safetyRaw < 0 || safetyRaw > 4) {
    throw new Error("BFL_SAFETY_TOLERANCE는 0부터 4 사이 정수여야 합니다.");
  }
  const durationsSec = Array.from({ length: Number(job.clipCount) }, (_, index) => taskDurationForJob(job, index));
  return {
    mode: "t2v",
    render: "full",
    resolution,
    aspectRatio: job.format === "landscape" ? "16:9" : "9:16",
    generateAudio,
    safetyTolerance: safetyRaw,
    durationsSec,
    totalBilledDurationSec: durationsSec.reduce((sum, duration) => sum + duration, 0)
  };
}

export function bflApiKeyFingerprint(value) {
  const key = String(value || "");
  if (!key.trim()) throw new Error("BFL_API_KEY가 없어 유료 승인을 만들 수 없습니다.");
  return hashBflApprovalValue({ scope: "bfl-api-key-identity/v1", key });
}

function stringContainsBflApiKey(value, apiKey) {
  const text = String(value);
  if (text.includes(apiKey) || text.includes(encodeURIComponent(apiKey))) return true;
  try {
    return decodeURIComponent(text).includes(apiKey);
  } catch {
    return false;
  }
}

function valueContainsBflApiKey(value, apiKey, seen = new WeakSet()) {
  if (typeof value === "string") return stringContainsBflApiKey(value, apiKey);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const found = Object.entries(value).some(([key, item]) => (
    stringContainsBflApiKey(key, apiKey) || valueContainsBflApiKey(item, apiKey, seen)
  ));
  seen.delete(value);
  return found;
}

export function assertBflValueDoesNotContainApiKey(value, apiKey) {
  const key = String(apiKey || "");
  if (!key.trim()) throw new Error("BFL_API_KEY가 없어 비밀 결속 검사를 수행할 수 없습니다.");
  if (valueContainsBflApiKey(value, key)) {
    throw new Error("BFL 작업 또는 signed request가 구성된 API key를 포함해 직렬화·claim·제출할 수 없습니다.");
  }
}

function approvalApiKey(context, explicitApiKey, { required = false } = {}) {
  const configured = explicitApiKey === undefined ? process.env.BFL_API_KEY : explicitApiKey;
  const key = String(configured || "");
  if (!key.trim()) {
    if (required) throw new Error("BFL 유료 승인 비밀 결속에 BFL_API_KEY가 필요합니다.");
    return null;
  }
  if (required && bflApiKeyFingerprint(key) !== context?.apiKeyFingerprint) {
    throw new Error("현재 BFL API key identity가 승인 context의 key identity와 일치하지 않습니다.");
  }
  return key;
}

function assertApprovalDoesNotContainApiKey(value, context, explicitApiKey, options = {}) {
  const key = approvalApiKey(context, explicitApiKey, options);
  if (key) assertBflValueDoesNotContainApiKey(value, key);
  return key;
}

function validBflApprovalContext(context) {
  const policy = context?.requestPolicy;
  const rate = BFL_OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND[context?.resolution];
  const totalDuration = Array.isArray(policy?.durationsSec)
    ? policy.durationsSec.reduce((sum, duration) => sum + Number(duration), 0)
    : NaN;
  return Boolean(
    context?.schemaVersion === BFL_PAID_APPROVAL_SCHEMA_VERSION
    && context.provider === "bfl"
    && context.model === BFL_MODEL
    && context.modelVersion === BFL_MODEL_VERSION
    && context.mode === "t2v"
    && context.render === "full"
    && Number.isFinite(rate)
    && context.creditsPerSecond === rate
    && context.creditUsd === BFL_CREDIT_USD
    && policy?.mode === "t2v"
    && policy.render === "full"
    && policy.resolution === context.resolution
    && ["9:16", "16:9"].includes(policy.aspectRatio)
    && typeof policy.generateAudio === "boolean"
    && Number.isInteger(policy.safetyTolerance)
    && policy.safetyTolerance >= 0
    && policy.safetyTolerance <= 4
    && Array.isArray(policy.durationsSec)
    && policy.durationsSec.length === context.jobBinding?.clipCount
    && policy.durationsSec.every((duration) => Number.isInteger(duration) && duration >= BFL_MIN_CLIP_DURATION_SEC && duration <= BFL_MAX_CLIP_DURATION_SEC)
    && policy.totalBilledDurationSec === totalDuration
    && context.requestPolicyHash === hashBflApprovalValue(policy)
    && context.officialQuoteCredits === totalDuration * rate
    && context.officialQuoteUsd === Number((context.officialQuoteCredits * BFL_CREDIT_USD).toFixed(2))
    && context.operatorEstimateCredits >= context.officialQuoteCredits
    && context.maxCredits >= context.operatorEstimateCredits
    && /^sha256:[a-f0-9]{64}$/u.test(context.apiKeyFingerprint || "")
    && context.adapterName === "bfl-flux-video-generator.mjs"
    && /^sha256:[a-f0-9]{64}$/u.test(context.adapterSha256 || "")
    && context.executorSnapshotName === ".bfl-paid-executor.mjs"
    && /^sha256:[a-f0-9]{64}$/u.test(context.executorSnapshotSha256 || "")
    && validJobBinding(context.jobBinding)
    && context.jobBindingHash === hashBflApprovalValue(context.jobBinding)
    && context.contextHash === contextHashFor(context)
  );
}

function launchCapabilityFor(receipt, context, consumedName) {
  const capability = {
    schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
    type: "bfl-paid-launch-capability",
    provider: "bfl",
    status: "consumed-launch-authorized",
    approvalHash: receipt.approvalHash,
    contextHash: context.contextHash,
    nonce: receipt.nonce,
    approvedAt: receipt.approvedAt,
    expiresAt: receipt.expiresAt,
    consumedReceiptName: consumedName,
    context
  };
  return { ...capability, capabilityHash: hashBflApprovalValue(capability) };
}

function exactConsumedLaunchCapability(receipt, context, consumedName) {
  return launchCapabilityFor(receipt, context, consumedName);
}

export function validateBflConsumedApprovalAuthorizationReceipt(receipt, authorization, { apiKey } = {}) {
  validateHistoricalBflPaidApprovalReceipt(receipt, authorization?.context, { apiKey });
  if (
    receipt.approvalHash !== authorization?.approvalHash
    || receipt.nonce !== authorization?.nonce
    || receipt.contextHash !== authorization?.contextHash
    || receipt.approvedAt !== authorization?.approvedAt
    || receipt.expiresAt !== authorization?.expiresAt
  ) throw new Error("BFL consumed approval 영수증이 request authorization과 일치하지 않습니다.");
  const exactCapability = exactConsumedLaunchCapability(receipt, receipt.context, authorization.consumedReceiptName);
  if (
    exactCapability.capabilityHash !== authorization.capabilityHash
    || hashBflApprovalValue(exactCapability.context) !== hashBflApprovalValue(authorization.context)
  ) throw new Error("BFL consumed approval의 정확한 launch capability가 request authorization과 일치하지 않습니다.");
  return receipt;
}

export function validateBflLaunchCapability(capability, context, { now = new Date() } = {}) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) throw new Error("BFL launch capability가 없습니다.");
  const { capabilityHash, ...unsigned } = capability;
  if (
    !validBflApprovalContext(context)
    || capability.schemaVersion !== BFL_PAID_APPROVAL_SCHEMA_VERSION
    || capability.type !== "bfl-paid-launch-capability"
    || capability.provider !== "bfl"
    || capability.status !== "consumed-launch-authorized"
    || capability.contextHash !== context?.contextHash
    || hashBflApprovalValue(capability.context) !== hashBflApprovalValue(context)
    || !NONCE.test(capability.nonce || "")
    || !/^bfl-paid-approval-consumed-[a-f0-9]{32}\.json$/u.test(capability.consumedReceiptName || "")
    || capability.consumedReceiptName !== `bfl-paid-approval-consumed-${capability.nonce}.json`
    || capability.capabilityHash !== hashBflApprovalValue(unsigned)
    || !Number.isFinite(Date.parse(capability.expiresAt || ""))
    || now.getTime() >= Date.parse(capability.expiresAt)
  ) throw new Error("BFL launch capability가 현재 작업·환경·만료 경계와 일치하지 않습니다.");
  return capability;
}

export function bindBflLaunchCapabilityToRequest(capability, request, { now = new Date() } = {}) {
  validateBflLaunchCapability(capability, capability?.context, { now });
  if (
    !request
    || !requestMatchesJobBinding(request, capability.context.jobBinding)
    || typeof request.runId !== "string"
    || !request.runId
    || !/^sha256:[a-f0-9]{64}$/u.test(request.requestHash || "")
    || !/^sha256:[a-f0-9]{64}$/u.test(request.scriptHash || "")
    || request.requestHash !== canonicalBflRequestHash(request)
  ) throw new Error("BFL launch capability를 현재 provider 요청에 결속할 수 없습니다.");
  const binding = {
    schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
    type: "bfl-paid-request-authorization",
    provider: "bfl",
    status: "provider-request-authorized",
    approvalHash: capability.approvalHash,
    capabilityHash: capability.capabilityHash,
    contextHash: capability.contextHash,
    nonce: capability.nonce,
    approvedAt: capability.approvedAt,
    expiresAt: capability.expiresAt,
    consumedReceiptName: capability.consumedReceiptName,
    jobId: request.jobId,
    runId: request.runId,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    context: capability.context
  };
  return { ...binding, authorizationHash: hashBflApprovalValue(binding) };
}

export function validateBflRequestAuthorization(authorization, request, { now = new Date() } = {}) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) throw new Error("BFL request authorization이 없습니다.");
  const { authorizationHash, ...unsigned } = authorization;
  const capability = {
    schemaVersion: authorization.schemaVersion,
    type: "bfl-paid-launch-capability",
    provider: authorization.provider,
    status: "consumed-launch-authorized",
    approvalHash: authorization.approvalHash,
    contextHash: authorization.contextHash,
    nonce: authorization.nonce,
    approvedAt: authorization.approvedAt,
    expiresAt: authorization.expiresAt,
    consumedReceiptName: authorization.consumedReceiptName,
    context: authorization.context,
    capabilityHash: authorization.capabilityHash
  };
  validateBflLaunchCapability(capability, authorization.context, { now });
  if (
    authorization.type !== "bfl-paid-request-authorization"
    || authorization.status !== "provider-request-authorized"
    || authorization.jobId !== request?.jobId
    || authorization.runId !== request?.runId
    || authorization.requestHash !== request?.requestHash
    || authorization.scriptHash !== request?.scriptHash
    || request?.requestHash !== canonicalBflRequestHash(request)
    || !requestMatchesJobBinding(request, authorization.context?.jobBinding)
    || authorizationHash !== hashBflApprovalValue(unsigned)
  ) throw new Error("BFL request authorization이 현재 요청과 결속되지 않았습니다.");
  return authorization;
}

function requestAuthorizationHash(authorization) {
  const { authorizationHash: _authorizationHash, ...unsigned } = authorization || {};
  return hashBflApprovalValue(unsigned);
}

export function validateHistoricalBflRequestAuthorization(authorization, request) {
  const approvedAt = new Date(authorization?.approvedAt || "invalid");
  if (!Number.isFinite(approvedAt.getTime())) return false;
  try {
    validateBflRequestAuthorization(authorization, request, { now: approvedAt });
    return true;
  } catch {
    return false;
  }
}

export function validateHistoricalBflPaidApprovalReceipt(receipt, context, options = {}) {
  const approvedAt = new Date(receipt?.approvedAt || "invalid");
  if (!Number.isFinite(approvedAt.getTime())) throw new Error("BFL 유료 승인 영수증 승인 시각이 유효하지 않습니다.");
  return validateBflPaidApprovalReceipt(receipt, context, { ...options, now: approvedAt });
}

export function validateBflRequestClaimReceipt(claim, authorization, request) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error("BFL request claim 영수증이 없습니다.");
  const { claimHash, ...unsigned } = claim;
  const claimedMs = Date.parse(claim.claimedAt || "");
  const approvedMs = Date.parse(authorization?.approvedAt || "");
  const expiresMs = Date.parse(authorization?.expiresAt || "");
  if (
    claim.schemaVersion !== BFL_PAID_APPROVAL_SCHEMA_VERSION
    || claim.type !== "bfl-paid-request-claim"
    || claim.status !== "claimed"
    || claim.approvalHash !== authorization?.approvalHash
    || claim.authorizationHash !== authorization?.authorizationHash
    || claim.contextHash !== authorization?.contextHash
    || claim.nonce !== authorization?.nonce
    || claim.jobId !== request?.jobId
    || claim.runId !== request?.runId
    || claim.requestHash !== request?.requestHash
    || claim.scriptHash !== request?.scriptHash
    || !Number.isFinite(claimedMs)
    || claimedMs < approvedMs
    || claimedMs >= expiresMs
    || claimHash !== hashBflApprovalValue(unsigned)
  ) throw new Error("BFL request claim이 승인·요청·유효 시간 창과 결속되지 않았습니다.");
  return claim;
}

export function validateBflProviderExecutionClaimReceipt(claim, authorization, request) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error("BFL provider execution claim이 없습니다.");
  const { executionClaimHash, ...unsigned } = claim;
  const claimedMs = Date.parse(claim.claimedAt || "");
  const approvedMs = Date.parse(authorization?.approvedAt || "");
  const expiresMs = Date.parse(authorization?.expiresAt || "");
  if (
    claim.schemaVersion !== BFL_PAID_APPROVAL_SCHEMA_VERSION
    || claim.type !== "bfl-paid-provider-execution-claim"
    || claim.status !== "provider-executor-claimed"
    || claim.approvalHash !== authorization?.approvalHash
    || claim.authorizationHash !== authorization?.authorizationHash
    || claim.contextHash !== authorization?.contextHash
    || claim.nonce !== authorization?.nonce
    || claim.jobId !== request?.jobId
    || claim.runId !== request?.runId
    || claim.requestHash !== request?.requestHash
    || claim.scriptHash !== request?.scriptHash
    || !Number.isFinite(claimedMs)
    || claimedMs < approvedMs
    || claimedMs >= expiresMs
    || executionClaimHash !== hashBflApprovalValue(unsigned)
  ) throw new Error("BFL provider execution claim이 승인·요청·유효 시간 창과 결속되지 않았습니다.");
  return claim;
}

async function exactBundledAdapter(root, env) {
  const configured = String(env.PS4_LOCAL_VIDEO_GENERATOR || "").trim();
  if (!configured) throw new Error("BFL 어댑터가 선택되지 않았습니다.");
  const bundled = resolve(root, "scripts", "bfl-flux-video-generator.mjs");
  const [configuredReal, bundledReal] = await Promise.all([
    realpath(resolve(configured)).catch(() => null),
    realpath(bundled).catch(() => null)
  ]);
  if (!configuredReal || configuredReal !== bundledReal) {
    throw new Error("유료 승인은 저장소에 포함된 정확한 BFL 어댑터에만 허용됩니다.");
  }
  const metadata = await stat(bundledReal);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error("BFL 어댑터가 실행 가능하지 않습니다.");
  return {
    adapterName: basename(bundledReal),
    adapterSha256: await hashFile(bundledReal),
    executorSnapshotName: ".bfl-paid-executor.mjs",
    executorSnapshotSha256: await buildBflExecutorSnapshotDigest(bundledReal, root)
  };
}

export async function buildBflPaidApprovalContext({ root, job, env = process.env } = {}) {
  if (!root) throw new Error("BFL 승인 context에 root가 필요합니다.");
  if (!String(env.BFL_API_KEY || "").trim()) throw new Error("BFL_API_KEY가 없어 유료 승인을 만들 수 없습니다.");
  assertBflValueDoesNotContainApiKey(job, env.BFL_API_KEY);
  if (String(env.BFL_DRY_RUN || "").trim() === "1") throw new Error("dry-run 설정으로 유료 승인을 만들 수 없습니다.");
  const requestPolicy = paidRequestPolicy(job, env);
  const resolution = requestPolicy.resolution;
  const creditsPerSecond = BFL_OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND[resolution];
  if (!creditsPerSecond) throw new Error("BFL 유료 승인은 hd 또는 fhd 해상도만 지원합니다.");
  const maxCredits = positiveNumber(env.BFL_MAX_CREDITS, "BFL_MAX_CREDITS");
  const binding = jobBinding(job);
  const officialQuoteCredits = requestPolicy.totalBilledDurationSec * creditsPerSecond;
  const directEstimate = Number(env.BFL_ESTIMATED_TOTAL_CREDITS);
  const perSecondEstimate = Number(env.BFL_ESTIMATED_CREDITS_PER_SECOND) * binding.targetDurationSec;
  const perRequestEstimate = Number(env.BFL_ESTIMATED_CREDITS_PER_REQUEST) * binding.clipCount;
  const operatorEstimateCredits = [directEstimate, perSecondEstimate, perRequestEstimate]
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((largest, value) => Math.max(largest, value), 0);
  if (operatorEstimateCredits < officialQuoteCredits) throw new Error("BFL 운영자 비용 추정값이 공식 최소 견적보다 작습니다.");
  if (maxCredits < officialQuoteCredits) throw new Error("BFL 최대 크레딧 상한이 공식 최소 견적보다 작습니다.");
  if (operatorEstimateCredits > maxCredits) throw new Error("BFL 운영자 비용 추정값이 최대 크레딧 상한을 초과합니다.");
  const adapter = await exactBundledAdapter(root, env);
  const context = {
    schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
    provider: "bfl",
    model: BFL_MODEL,
    modelVersion: BFL_MODEL_VERSION,
    mode: "t2v",
    render: "full",
    resolution,
    requestPolicy,
    requestPolicyHash: hashBflApprovalValue(requestPolicy),
    apiKeyFingerprint: bflApiKeyFingerprint(env.BFL_API_KEY),
    creditsPerSecond,
    creditUsd: BFL_CREDIT_USD,
    officialQuoteCredits,
    officialQuoteUsd: Number((officialQuoteCredits * BFL_CREDIT_USD).toFixed(2)),
    operatorEstimateCredits,
    maxCredits,
    jobBinding: binding,
    jobBindingHash: hashBflApprovalValue(binding),
    ...adapter
  };
  return { ...context, contextHash: hashBflApprovalValue(context) };
}

function exactReceiptShape(receipt) {
  const expected = [
    "approvalHash", "approvedAt", "approverAssertion", "context", "contextHash", "expiresAt",
    "nonce", "reason", "schemaVersion", "status", "type"
  ];
  return receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && Object.keys(receipt).sort().join(",") === expected.sort().join(",");
}

export function validateBflPaidApprovalReceipt(receipt, context, { now = new Date(), apiKey } = {}) {
  if (!exactReceiptShape(receipt)) throw new Error("BFL 유료 승인 영수증 스키마가 유효하지 않습니다.");
  assertApprovalDoesNotContainApiKey(receipt, context, apiKey);
  const { approvalHash, ...unsigned } = receipt;
  const approvedMs = Date.parse(receipt.approvedAt);
  const expiresMs = Date.parse(receipt.expiresAt);
  const nowMs = now.getTime();
  if (
    receipt.schemaVersion !== BFL_PAID_APPROVAL_SCHEMA_VERSION
    || receipt.type !== "bfl-paid-generation-approval"
    || receipt.status !== "approved-unused"
    || !NONCE.test(receipt.nonce)
    || typeof receipt.reason !== "string"
    || receipt.reason.trim().length < 8
    || receipt.approverAssertion !== "I explicitly approve one paid BFL generation attempt within this exact credit ceiling."
    || !Number.isFinite(approvedMs)
    || !Number.isFinite(expiresMs)
    || expiresMs <= approvedMs
    || expiresMs - approvedMs > MAX_APPROVAL_LIFETIME_MS
    || nowMs < approvedMs - 60_000
    || nowMs >= expiresMs
    || receipt.contextHash !== contextHashFor(receipt.context)
    || receipt.contextHash !== context?.contextHash
    || hashBflApprovalValue(receipt.context) !== hashBflApprovalValue(context)
    || approvalHash !== hashBflApprovalValue(unsigned)
  ) throw new Error("BFL 유료 승인 영수증이 현재 작업·견적과 결속되지 않았거나 만료됐습니다.");
  return receipt;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createBflPaidApprovalReceipt(context, { expiresAt, reason, now = new Date(), nonce = randomBytes(16).toString("hex"), apiKey } = {}) {
  const key = assertApprovalDoesNotContainApiKey(reason, context, apiKey, { required: true });
  const unsigned = {
    schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
    type: "bfl-paid-generation-approval",
    status: "approved-unused",
    context,
    contextHash: context?.contextHash,
    approvedAt: now.toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    nonce,
    approverAssertion: "I explicitly approve one paid BFL generation attempt within this exact credit ceiling.",
    reason: String(reason || "").trim()
  };
  const receipt = { ...unsigned, approvalHash: hashBflApprovalValue(unsigned) };
  assertBflValueDoesNotContainApiKey(receipt, key);
  validateBflPaidApprovalReceipt(receipt, context, { now, apiKey: key });
  return receipt;
}

export async function persistBflPaidApproval(jobDir, receipt, { apiKey } = {}) {
  const key = assertApprovalDoesNotContainApiKey(receipt, receipt?.context, apiKey, { required: true });
  const serializedReceipt = JSON.stringify(receipt, null, 2);
  assertBflValueDoesNotContainApiKey(serializedReceipt, key);
  const root = resolve(jobDir);
  await mkdir(root, { recursive: true });
  const path = join(root, BFL_PAID_APPROVAL_NAME);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(serializedReceipt);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(root);
  return path;
}

export async function consumeBflPaidApproval(jobDir, context, options = {}) {
  const root = resolve(jobDir);
  const path = join(root, BFL_PAID_APPROVAL_NAME);
  let activeHandle = null;
  let activeIdentity;
  let bytes;
  try {
    try {
      const pathIdentity = await lstat(path, { bigint: true });
      if (
        !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink?.()
        || ![1n, 2n].includes(pathIdentity.nlink)
        || pathIdentity.size <= 0n
        || pathIdentity.size > BigInt(MAX_APPROVAL_RECEIPT_BYTES)
      ) throw new Error("BFL active approval은 bounded single-link regular file이어야 합니다.");
      activeHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      activeIdentity = await activeHandle.stat({ bigint: true });
      if (
        !activeIdentity.isFile()
        || activeIdentity.nlink !== pathIdentity.nlink
        || activeIdentity.dev !== pathIdentity.dev
        || activeIdentity.ino !== pathIdentity.ino
        || activeIdentity.size !== pathIdentity.size
      ) throw new Error("BFL active approval이 읽기 전에 교체되었거나 외부 inode와 연결되어 있습니다.");
      bytes = await activeHandle.readFile();
    } catch (error) {
      if (error?.code === "ENOENT") {
        const missing = new Error("명시적인 1회 BFL 유료 승인 영수증이 없습니다.");
        missing.code = "BFL_PAID_APPROVAL_MISSING";
        throw missing;
      }
      throw error;
    }
    let receipt;
    try {
      receipt = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("BFL 유료 승인 영수증 JSON이 손상됐습니다.");
    }
    const key = assertApprovalDoesNotContainApiKey(receipt, context, options.apiKey, { required: true });
    assertBflValueDoesNotContainApiKey(bytes.toString("utf8"), key);
    validateBflPaidApprovalReceipt(receipt, context, { ...options, apiKey: key });
    const consumedName = `bfl-paid-approval-consumed-${receipt.nonce}.json`;
    const consumedPath = join(root, consumedName);
    if (activeIdentity.nlink === 2n) {
      const consumedIdentity = await lstat(consumedPath, { bigint: true }).catch(() => null);
      if (
        consumedIdentity?.isFile()
        && !consumedIdentity.isSymbolicLink?.()
        && consumedIdentity.nlink === 2n
        && consumedIdentity.dev === activeIdentity.dev
        && consumedIdentity.ino === activeIdentity.ino
      ) {
        const collision = new Error("BFL 유료 승인이 이미 소비됐거나 동시에 사용 중입니다.");
        collision.code = "BFL_PAID_APPROVAL_CONSUME_COLLISION";
        collision.consumedName = consumedName;
        throw collision;
      }
      throw new Error("BFL active approval은 외부 hardlink가 아닌 bounded single-link regular file이어야 합니다.");
    }
    try {
      await link(path, consumedPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        const collision = new Error("BFL 유료 승인이 이미 소비됐거나 동시에 사용 중입니다.");
        collision.code = "BFL_PAID_APPROVAL_CONSUME_COLLISION";
        collision.consumedName = consumedName;
        throw collision;
      }
      if (error?.code === "ENOENT") throw new Error("BFL 유료 승인이 이미 소비됐거나 동시에 사용 중입니다.");
      throw error;
    }
    let linkValidated = false;
    try {
      const consumedIdentity = await lstat(consumedPath, { bigint: true });
      const linkedActiveIdentity = await activeHandle.stat({ bigint: true });
      if (
        !consumedIdentity.isFile()
        || consumedIdentity.isSymbolicLink?.()
        || consumedIdentity.nlink !== 2n
        || linkedActiveIdentity.nlink !== 2n
        || consumedIdentity.dev !== activeIdentity.dev
        || consumedIdentity.ino !== activeIdentity.ino
        || linkedActiveIdentity.dev !== activeIdentity.dev
        || linkedActiveIdentity.ino !== activeIdentity.ino
      ) throw new Error("BFL consumed approval 링크가 고정한 active receipt inode와 정확히 일치하지 않습니다.");
      linkValidated = true;
    } catch (error) {
      const activePathIdentity = await lstat(path, { bigint: true }).catch(() => null);
      const consumedIdentity = await lstat(consumedPath, { bigint: true }).catch(() => null);
      const pinnedIdentity = await activeHandle.stat({ bigint: true }).catch(() => null);
      if (
        activePathIdentity?.isFile()
        && consumedIdentity?.isFile()
        && pinnedIdentity?.isFile()
        && activePathIdentity.nlink === 2n
        && consumedIdentity.nlink === 2n
        && pinnedIdentity.nlink === 2n
        && activePathIdentity.dev === activeIdentity.dev
        && activePathIdentity.ino === activeIdentity.ino
        && consumedIdentity.dev === activeIdentity.dev
        && consumedIdentity.ino === activeIdentity.ino
        && pinnedIdentity.dev === activeIdentity.dev
        && pinnedIdentity.ino === activeIdentity.ino
      ) {
        await unlink(consumedPath);
        await syncDirectory(root);
      }
      throw error;
    }
    if (!linkValidated) throw new Error("BFL consumed approval 링크 검증이 완료되지 않았습니다.");
    // Persist the new consumed name before removing the active name. Power
    // loss can then leave either A+C or C, never neither name.
    await (options.syncDirectoryFn || syncDirectory)(root);
    await options.hooks?.afterConsumedLinkDurable?.({ path, consumedPath, consumedName, receipt });
    await options.hooks?.beforeActiveApprovalUnlink?.({ path, consumedPath, consumedName, receipt });
    await unlink(path);
    await activeHandle.sync();
    await syncDirectory(root);
    const finalizedIdentity = await activeHandle.stat({ bigint: true });
    const canonicalConsumedIdentity = await lstat(consumedPath, { bigint: true });
    if (
      finalizedIdentity.nlink !== 1n
      || canonicalConsumedIdentity.nlink !== 1n
      || finalizedIdentity.dev !== activeIdentity.dev
      || finalizedIdentity.ino !== activeIdentity.ino
      || canonicalConsumedIdentity.dev !== activeIdentity.dev
      || canonicalConsumedIdentity.ino !== activeIdentity.ino
    ) throw new Error("BFL consumed approval을 고정한 단일 canonical inode로 확정하지 못했습니다.");
    const capability = launchCapabilityFor(receipt, context, consumedName);
    validateBflLaunchCapability(capability, context, options);
    return { receipt, consumedPath, consumedName, capability };
  } finally {
    await activeHandle?.close().catch(() => {});
  }
}

/**
 * Must be called while the job lease is held. A process can crash after the
 * active receipt is atomically consumed but before run publication. In that
 * one state only, reconstruct the exact unexpired capability from the single
 * context-bound consumed receipt. Any durable request/provider claim or submit
 * intent proves the approval advanced further and permanently blocks reuse.
 */
export async function consumeOrRecoverBflPaidApproval(jobDir, context, options = {}) {
  if (typeof options.assertNoPriorPaidIntent !== "function") {
    throw new Error("BFL approval consume/recover에는 lease-held prior paid intent 검사가 필요합니다.");
  }
  const root = resolve(jobDir);
  await options.assertNoPriorPaidIntent();
  const preexistingPaidState = (await readdir(root, { withFileTypes: true })).filter((entry) => (
    new RegExp(`^${BFL_PAID_CLAIM_PREFIX}[a-f0-9]{32}\\.json$`, "u").test(entry.name)
    || new RegExp(`^${BFL_PROVIDER_EXECUTION_PREFIX}[a-f0-9]{32}\\.json$`, "u").test(entry.name)
    || entry.name === ".local-video-provider-submit-intent.json"
  ));
  if (preexistingPaidState.length) {
    throw new Error("BFL approval에 이미 provider 요청 claim 또는 제출 intent가 있어 capability 소비·복구를 차단했습니다.");
  }
  let interruptedConsumedName = null;
  try {
    return { ...(await consumeBflPaidApproval(jobDir, context, options)), recovered: false };
  } catch (error) {
    if (error?.code === "BFL_PAID_APPROVAL_CONSUME_COLLISION") interruptedConsumedName = error.consumedName;
    else if (error?.code !== "BFL_PAID_APPROVAL_MISSING") throw error;
  }
  if (interruptedConsumedName) {
    const activePath = join(root, BFL_PAID_APPROVAL_NAME);
    const consumedPath = join(root, interruptedConsumedName);
    let activeHandle = null;
    let consumedHandle = null;
    try {
      activeHandle = await open(activePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      consumedHandle = await open(consumedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const [activeIdentity, consumedIdentity] = await Promise.all([
        activeHandle.stat({ bigint: true }),
        consumedHandle.stat({ bigint: true })
      ]);
      if (
        !activeIdentity.isFile()
        || !consumedIdentity.isFile()
        || activeIdentity.nlink !== 2n
        || consumedIdentity.nlink !== 2n
        || activeIdentity.size <= 0n
        || activeIdentity.size > BigInt(MAX_APPROVAL_RECEIPT_BYTES)
        || activeIdentity.size !== consumedIdentity.size
        || activeIdentity.dev !== consumedIdentity.dev
        || activeIdentity.ino !== consumedIdentity.ino
      ) throw new Error("BFL approval consume 충돌이 동일 inode의 중단된 hard-link 전이와 일치하지 않습니다.");
      const activeBytes = await activeHandle.readFile();
      let activeReceipt;
      try {
        activeReceipt = JSON.parse(activeBytes.toString("utf8"));
      } catch {
        throw new Error("중단된 BFL active approval JSON이 손상됐습니다.");
      }
      const key = assertApprovalDoesNotContainApiKey(activeReceipt, context, options.apiKey, { required: true });
      assertBflValueDoesNotContainApiKey(activeBytes.toString("utf8"), key);
      validateBflPaidApprovalReceipt(activeReceipt, context, { ...options, apiKey: key });
      if (interruptedConsumedName !== `bfl-paid-approval-consumed-${activeReceipt.nonce}.json`) {
        throw new Error("중단된 BFL approval hard-link의 nonce와 파일명이 일치하지 않습니다.");
      }
      for (const name of [
        `${BFL_PAID_CLAIM_PREFIX}${activeReceipt.nonce}.json`,
        `${BFL_PROVIDER_EXECUTION_PREFIX}${activeReceipt.nonce}.json`,
        ".local-video-provider-submit-intent.json"
      ]) {
        if (await lstat(join(root, name)).then(() => true, (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        })) throw new Error("중단된 BFL approval에 이미 provider 요청 claim 또는 제출 intent가 있어 복구를 차단했습니다.");
      }
      // The original process may have died before persisting the C link. Make
      // that link durable while both names still exist, then retire A.
      await syncDirectory(root);
      await unlink(activePath);
      await consumedHandle.sync();
      await syncDirectory(root);
      const finalizedIdentity = await consumedHandle.stat({ bigint: true });
      const canonicalIdentity = await lstat(consumedPath, { bigint: true });
      if (
        finalizedIdentity.nlink !== 1n
        || canonicalIdentity.nlink !== 1n
        || finalizedIdentity.dev !== canonicalIdentity.dev
        || finalizedIdentity.ino !== canonicalIdentity.ino
      ) throw new Error("중단된 BFL approval hard-link 전이를 단일 durable consumed receipt로 닫지 못했습니다.");
    } finally {
      await activeHandle?.close().catch(() => {});
      await consumedHandle?.close().catch(() => {});
    }
  }
  const entries = await readdir(root, { withFileTypes: true });
  const candidateNames = entries
    .filter((entry) => entry.isFile() && /^bfl-paid-approval-consumed-[a-f0-9]{32}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const matches = [];
  for (const consumedName of candidateNames) {
    const consumedPath = join(root, consumedName);
    const before = await lstat(consumedPath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_APPROVAL_RECEIPT_BYTES)) {
      throw new Error("BFL consumed approval 복구 후보가 안전한 단일 regular file이 아닙니다.");
    }
    const handle = await open(consumedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes;
    try {
      const pinned = await handle.stat({ bigint: true });
      if (pinned.dev !== before.dev || pinned.ino !== before.ino || !pinned.isFile() || pinned.nlink !== 1n) {
        throw new Error("BFL consumed approval 복구 후보가 읽는 동안 교체됐습니다.");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
    let receipt;
    try {
      receipt = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("BFL consumed approval 복구 후보 JSON이 손상됐습니다.");
    }
    if (receipt?.contextHash !== context?.contextHash) continue;
    const key = assertApprovalDoesNotContainApiKey(receipt, context, options.apiKey, { required: true });
    assertBflValueDoesNotContainApiKey(bytes.toString("utf8"), key);
    validateBflPaidApprovalReceipt(receipt, context, { ...options, apiKey: key });
    if (consumedName !== `bfl-paid-approval-consumed-${receipt.nonce}.json`) {
      throw new Error("BFL consumed approval 복구 후보의 nonce와 파일명이 일치하지 않습니다.");
    }
    matches.push({ receipt, consumedPath, consumedName });
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "현재 작업·견적에 정확히 결속된 미사용 BFL consumed approval을 복구할 수 없습니다."
      : "현재 작업·견적에 결속된 BFL consumed approval 복구 후보가 중복되어 재사용을 차단했습니다.");
  }
  const recovered = matches[0];
  for (const name of [
    `${BFL_PAID_CLAIM_PREFIX}${recovered.receipt.nonce}.json`,
    `${BFL_PROVIDER_EXECUTION_PREFIX}${recovered.receipt.nonce}.json`,
    ".local-video-provider-submit-intent.json"
  ]) {
    const present = await lstat(join(root, name)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (present) throw new Error("BFL approval에 이미 provider 요청 claim 또는 제출 intent가 있어 capability 복구를 차단했습니다.");
  }
  const capability = launchCapabilityFor(recovered.receipt, context, recovered.consumedName);
  validateBflLaunchCapability(capability, context, options);
  return { ...recovered, capability, recovered: true };
}

export async function verifyBflConsumedApprovalForRequest(jobDir, authorization, request, {
  now = new Date(),
  apiKey,
  adapterPath,
  executorSnapshotPath,
  claim = false,
  requireClaim = false,
  historical = false
} = {}) {
  if (claim && requireClaim) throw new Error("BFL request claim은 생성과 검증을 동시에 요청할 수 없습니다.");
  if (historical) {
    if (!validateHistoricalBflRequestAuthorization(authorization, request)) throw new Error("BFL historical request authorization이 유효하지 않습니다.");
  } else {
    validateBflRequestAuthorization(authorization, request, { now });
  }
  if (apiKey !== undefined) assertBflValueDoesNotContainApiKey(request, apiKey);
  const root = resolve(jobDir);
  if (basename(authorization.consumedReceiptName) !== authorization.consumedReceiptName) {
    throw new Error("BFL consumed approval 경로가 안전하지 않습니다.");
  }
  const consumedPath = join(root, authorization.consumedReceiptName);
  let receipt;
  let consumedBytes;
  try {
    consumedBytes = await readFile(consumedPath);
    receipt = JSON.parse(consumedBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`BFL consumed approval 영수증을 검증할 수 없습니다 (${error?.code || "invalid"}).`);
  }
  if (historical) validateHistoricalBflPaidApprovalReceipt(receipt, authorization.context, { apiKey });
  else validateBflPaidApprovalReceipt(receipt, authorization.context, { now, apiKey });
  validateBflConsumedApprovalAuthorizationReceipt(receipt, authorization, { apiKey });
  if (apiKey !== undefined && bflApiKeyFingerprint(apiKey) !== authorization.context.apiKeyFingerprint) {
    throw new Error("현재 BFL API key identity가 승인된 key identity와 일치하지 않습니다.");
  }
  if (adapterPath) {
    const actualPath = await realpath(adapterPath).catch(() => null);
    if (
      !actualPath
      || basename(actualPath) !== authorization.context.adapterName
      || await hashFile(actualPath) !== authorization.context.adapterSha256
    ) throw new Error("현재 BFL adapter가 승인된 adapter bytes와 일치하지 않습니다.");
  }
  if (executorSnapshotPath) {
    const actualPath = await realpath(executorSnapshotPath).catch(() => null);
    if (
      !actualPath
      || basename(actualPath) !== authorization.context.executorSnapshotName
      || await hashFile(actualPath) !== authorization.context.executorSnapshotSha256
    ) throw new Error("현재 BFL executor snapshot bytes가 승인된 전이 소스 closure와 일치하지 않습니다.");
  }
  let claimPath = null;
  let claimReceipt = null;
  let claimBytes = null;
  if (claim || requireClaim) {
    const claimName = `${BFL_PAID_CLAIM_PREFIX}${authorization.nonce}.json`;
    claimPath = join(root, claimName);
    const unsignedClaim = {
      schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
      type: "bfl-paid-request-claim",
      status: "claimed",
      approvalHash: authorization.approvalHash,
      authorizationHash: authorization.authorizationHash,
      contextHash: authorization.contextHash,
      nonce: authorization.nonce,
      jobId: authorization.jobId,
      runId: authorization.runId,
      requestHash: authorization.requestHash,
      scriptHash: authorization.scriptHash,
      claimedAt: now.toISOString()
    };
    if (claim) {
      claimReceipt = { ...unsignedClaim, claimHash: hashBflApprovalValue(unsignedClaim) };
      let handle;
      try {
        handle = await open(claimPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(claimReceipt, null, 2));
        await handle.sync();
      } catch (error) {
        if (error?.code === "EEXIST") throw new Error("BFL paid approval은 이미 provider 요청이 claim했습니다.");
        throw error;
      } finally {
        await handle?.close().catch(() => {});
      }
      await syncDirectory(root);
    } else {
      try {
        claimReceipt = JSON.parse((await readFile(claimPath)).toString("utf8"));
      } catch (error) {
        throw new Error(`BFL request claim을 검증할 수 없습니다 (${error?.code || "invalid"}).`);
      }
    }
    validateBflRequestClaimReceipt(claimReceipt, authorization, request);
    claimBytes = await readFile(claimPath);
    let exactClaim;
    try {
      exactClaim = JSON.parse(claimBytes.toString("utf8"));
    } catch {
      throw new Error("BFL request claim JSON이 손상됐습니다.");
    }
    validateBflRequestClaimReceipt(exactClaim, authorization, request);
    if (hashBflApprovalValue(exactClaim) !== hashBflApprovalValue(claimReceipt)) {
      throw new Error("BFL request claim bytes가 검증한 claim과 다릅니다.");
    }
    claimReceipt = exactClaim;
  }
  return {
    receipt,
    consumedPath,
    consumedReceiptText: consumedBytes.toString("utf8"),
    consumedReceiptBytes: consumedBytes.byteLength,
    consumedReceiptSha256: sha256Bytes(consumedBytes),
    claimPath,
    claimReceipt,
    claimReceiptText: claimBytes?.toString("utf8") || null,
    claimReceiptBytes: claimBytes?.byteLength || null,
    claimReceiptSha256: claimBytes ? sha256Bytes(claimBytes) : null
  };
}

export async function claimBflProviderExecution(jobDir, authorization, request, {
  now = new Date(),
  allowCreate = false,
  allowExisting = false,
  allowMissing = false
} = {}) {
  if (!validateHistoricalBflRequestAuthorization(authorization, request)) {
    throw new Error("BFL provider execution claim authorization이 유효하지 않습니다.");
  }
  if (allowCreate) validateBflRequestAuthorization(authorization, request, { now });
  const root = resolve(jobDir);
  const claimName = `${BFL_PROVIDER_EXECUTION_PREFIX}${authorization.nonce}.json`;
  const claimPath = join(root, claimName);
  const unsigned = {
    schemaVersion: BFL_PAID_APPROVAL_SCHEMA_VERSION,
    type: "bfl-paid-provider-execution-claim",
    status: "provider-executor-claimed",
    approvalHash: authorization.approvalHash,
    authorizationHash: authorization.authorizationHash,
    contextHash: authorization.contextHash,
    nonce: authorization.nonce,
    jobId: authorization.jobId,
    runId: authorization.runId,
    requestHash: authorization.requestHash,
    scriptHash: authorization.scriptHash,
    claimedAt: now.toISOString()
  };
  const proposed = { ...unsigned, executionClaimHash: hashBflApprovalValue(unsigned) };
  if (allowCreate) {
    let handle;
    let created = false;
    try {
      handle = await open(claimPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(proposed, null, 2));
      await handle.sync();
      created = true;
    } catch (error) {
      if (error?.code === "EEXIST" && allowExisting) {
        // The caller still has to validate the exact durable receipt below.
      } else if (error?.code === "EEXIST") {
        throw new Error("BFL provider executor는 이미 claim되어 새 유료 POST를 차단했습니다.");
      } else {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
    }
    if (created) {
      await syncDirectory(root);
      validateBflProviderExecutionClaimReceipt(proposed, authorization, request);
      return { created: true, claimPath, claimReceipt: proposed };
    }
  }
  let existing;
  let existingBytes;
  try {
    existingBytes = await readFile(claimPath);
    existing = JSON.parse(existingBytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw new Error(`BFL provider execution claim을 검증할 수 없습니다 (${error?.code || "invalid"}).`);
  }
  validateBflProviderExecutionClaimReceipt(existing, authorization, request);
  return {
    created: false,
    claimPath,
    claimReceipt: existing,
    claimReceiptText: existingBytes.toString("utf8"),
    claimReceiptBytes: existingBytes.byteLength,
    claimReceiptSha256: sha256Bytes(existingBytes)
  };
}
