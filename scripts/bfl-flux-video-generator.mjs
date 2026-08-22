#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createServer, isIP } from "node:net";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBflValueDoesNotContainApiKey,
  claimBflProviderExecution,
  validateHistoricalBflRequestAuthorization,
  validateBflRequestAuthorization,
  verifyBflConsumedApprovalForRequest
} from "../src/bfl-paid-approval.mjs";
import {
  closeFd,
  createFileAt,
  openDirectoryAt,
  openFileAt,
  openOrCreateDirectoryAt,
  readFdBuffer,
  renameAtNoReplace,
  replaceFileAt,
  sameFdIdentity,
  statFd,
  syncFd,
  unlinkAt,
  writeFdBuffer
} from "../src/dirfd.mjs";

const API_URL = "https://api.bfl.ai/v1/flux-3-video";
const API_BASE_URL = "https://api.bfl.ai";
const MODEL = "flux-3-video";
const MODEL_VERSION = "latest";
const MIN_DURATION_SEC = 5;
const MAX_DURATION_SEC = 20;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const CREDIT_USD = 0.01;
const OFFICIAL_PRICING_URL = "https://docs.bfl.ai/quick_start/pricing";
// FLUX 3 Video full-render t2v pricing published by BFL. The adapter never
// enables draft mode, so an operator estimate below this floor is unsafe.
const OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND = Object.freeze({ hd: 17, fhd: 29 });
const CHECKPOINT_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const INVOCATION_LEASE_SCHEMA_VERSION = 2;
const INVOCATION_LEASE_PREFIX = ".bfl-flux-video-invocation-";
const CHECKPOINT_ROOT_NAME = ".bfl-flux-video";
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_INVOCATION_LEASE_BYTES = 256 * 1024;
// One kernel-owned loopback listener serializes every paid BFL executor on the
// machine. The operating system releases it on SIGKILL, unlike a file lease.
const GLOBAL_BFL_GUARD_HOST = "127.0.0.1";
const GLOBAL_BFL_GUARD_PORT = 41493;
const BFL_TASK_BODY_KEYS = Object.freeze([
  "aspect_ratio", "draft", "duration", "generate_audio", "mode", "prompt",
  "resolution", "safety_tolerance", "version"
]);
const TERMINAL_SUCCESS_STATUSES = new Set(["ready", "completed", "complete", "succeeded", "success"]);
const ACTIVE_STATUSES = new Set(["pending", "processing", "queued", "submitted", "in_progress", "in-progress", "running", "reasoning", "generating"]);
const FAILURE_STATUSES = new Set(["error", "failed"]);
const MODERATION_STATUSES = new Set(["request moderated", "content moderated"]);
const APPROVED_API_ORIGINS = new Set([
  "https://api.bfl.ai",
  "https://api.eu.bfl.ai",
  "https://api.us.bfl.ai"
]);
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|signature|token|webhook[-_]?secret|^sig$)/iu;
const SAFE_ATTESTATION_KEY = new Set([
  "paidAuthorization", "authorizationHash", "paidAuthorizationHash", "apiKeyFingerprint",
  "approvalHash", "capabilityHash", "contextHash", "requestPolicyHash", "jobBindingHash", "adapterSha256"
]);
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|auth|credential|key|password|secret|signature|token|^sig$|^x-amz-|^x-goog-)/iu;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function canonicalJsonSnapshot(value, label) {
  let text;
  try {
    text = JSON.stringify(stableValue(value));
  } catch {
    throw new Error(`${label} could not be canonicalized`);
  }
  if (typeof text !== "string") throw new Error(`${label} is not JSON serializable`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} canonical bytes are not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a plain JSON object`);
  if (Object.keys(parsed).sort().join(",") !== [...BFL_TASK_BODY_KEYS].sort().join(",")) {
    throw new Error(`${label} does not have the exact approved BFL body shape`);
  }
  const canonicalText = JSON.stringify(stableValue(parsed));
  if (canonicalText !== text) throw new Error(`${label} canonical bytes are unstable`);
  return {
    value: parsed,
    text,
    sha256: `sha256:${createHash("sha256").update(text).digest("hex")}`
  };
}

function timestamp(value) {
  return firstString(value?.created_at, value?.createdAt, value?.submitted_at, value?.submittedAt, value?.updated_at, value?.updatedAt, value?.completed_at, value?.completedAt);
}

function taskIdFrom(value) {
  return firstString(value?.id, value?.task_id, value?.taskId, value?.request_id, value?.requestId);
}

function statusFrom(value) {
  const status = firstString(value?.status, value?.state);
  return status ? status.toLowerCase() : null;
}

function strictPositiveNumber(value, label, { optional = false, allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(`${label} is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} finite number`);
  }
  return parsed;
}

function boundedIntegerSetting(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function strictBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false`);
}

function replaceAllSecretForms(value, secret) {
  let output = String(value);
  if (!secret) return output;
  const forms = new Set([secret, encodeURIComponent(secret)]);
  try {
    forms.add(decodeURIComponent(secret));
  } catch {
    // The raw and encoded forms are still covered.
  }
  for (const form of forms) {
    if (form) output = output.split(form).join("[redacted]");
  }
  return output;
}

function redactFreeText(value, secret) {
  return replaceAllSecretForms(value, secret)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [redacted]")
    .replace(/\b((?:api[-_]?key|authorization|credential|password|secret|signature|token|webhook[-_]?secret|sig)\s*[:=]\s*)[^\s,;&#]+/giu, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|auth|credential|key|password|secret|signature|token|sig|x-amz-[^=&#\s]+|x-goog-[^=&#\s]+)=)[^&#\s]+/giu, "$1[redacted]");
}

function redactUrl(value, secret) {
  const replaced = redactFreeText(value, secret);
  let parsed;
  try {
    parsed = new URL(replaced);
  } catch {
    return replaced;
  }
  if (parsed.username) parsed.username = "[redacted]";
  if (parsed.password) parsed.password = "[redacted]";
  for (const [key] of parsed.searchParams) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "[redacted]");
  }
  if (parsed.hash) parsed.hash = "#[redacted]";
  return parsed.href;
}

function redactValue(value, secret, seen = new WeakSet(), parentKey = "") {
  if (typeof value === "string") {
    const withoutConfiguredSecret = replaceAllSecretForms(value, secret);
    if (/^(?:prompt|visualPrompt|providerVisualPrompt|caption|narration)$/u.test(parentKey)) {
      return withoutConfiguredSecret;
    }
    if (/(?:url|uri|href)$/iu.test(parentKey)) return redactUrl(withoutConfiguredSecret, null);
    return redactFreeText(withoutConfiguredSecret, null);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) && !SAFE_ATTESTATION_KEY.has(key) ? "[redacted]" : redactValue(item, secret, seen, key);
  }
  seen.delete(value);
  return output;
}

function urlContainsSecret(value, secret) {
  if (!secret) return false;
  const url = String(value);
  if (url.includes(secret) || url.includes(encodeURIComponent(secret))) return true;
  try {
    return decodeURIComponent(url).includes(secret);
  } catch {
    return false;
  }
}

function durationFor(segment, request) {
  const hinted = Number(segment?.durationHint);
  const fallback = Number(request.targetDurationSec) / Math.max(1, request.segments.length);
  const value = Number.isFinite(hinted) && hinted > 0
    ? hinted
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : MIN_DURATION_SEC;
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, Math.round(value)));
}

function assertSafeJobId(jobId) {
  const value = requiredString(jobId, "jobId");
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("..") || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("jobId contains an unsafe path");
  }
}

function assertSafeWorkingDirectory(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("jobWorkingDirectory is required");
  const raw = value.trim();
  if (raw.split(/[\\/]+/u).includes("..")) throw new Error("jobWorkingDirectory contains traversal");
  return resolve(raw);
}

function workingDirectoryFor(request) {
  const explicit = request.jobWorkingDirectory ?? request.workingDirectory ?? request.jobDir ?? request.workDir;
  if (request.paidAuthorization && explicit !== undefined) {
    throw new Error("paid BFL requests cannot select a mutable working directory");
  }
  if (explicit !== undefined) return assertSafeWorkingDirectory(explicit);
  assertSafeJobId(request.jobId);
  const projectRoot = resolve(import.meta.dirname, "..");
  return resolve(projectRoot, "workspace", "jobs", request.jobId);
}

function relativeClipPath(index) {
  return `clips/${String(index).padStart(2, "0")}.mp4`;
}

function assertClipPath(relativePath, clipsDirectory) {
  if (!/^clips\/[^/]+\.mp4$/u.test(relativePath) || relativePath.includes("..") || relativePath.includes("\\") || relativePath.startsWith("/")) {
    throw new Error(`unsafe output path: ${relativePath}`);
  }
  const absolutePath = resolve(join(clipsDirectory, relativePath.slice("clips/".length)));
  if (!absolutePath.startsWith(`${resolve(clipsDirectory)}${sep}`)) throw new Error(`output path escapes job directory: ${relativePath}`);
  return absolutePath;
}

function normalizeHostname(hostname) {
  return String(hostname).trim().toLowerCase().replace(/\.$/u, "");
}

function validDnsLabel(label) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);
}

function isPrivateOrLocalHostname(hostname) {
  const normalized = normalizeHostname(hostname).replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (ipVersion === 6) {
    const compact = normalized.replace(/^::ffff:/iu, "");
    if (isIP(compact) === 4) return isPrivateOrLocalHostname(compact);
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function isOfficialDeliveryHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  const hyphenMatch = /^delivery-([a-z0-9-]+)\.bfl\.ai$/u.exec(normalized);
  if (hyphenMatch) return validDnsLabel(hyphenMatch[1]);
  const dottedMatch = /^delivery\.([a-z0-9-]+)\.bfl\.ai$/u.exec(normalized);
  return Boolean(dottedMatch && validDnsLabel(dottedMatch[1]));
}

function configuredMediaHosts(env = process.env) {
  const hosts = new Set();
  for (const raw of String(env.BFL_MEDIA_HOSTS || "").split(",")) {
    if (!raw.trim()) continue;
    if (raw.includes("://") || raw.includes("/") || raw.includes(":") || raw.includes("@")) {
      throw new Error("BFL_MEDIA_HOSTS must contain comma-separated hostnames without schemes, ports, paths, or credentials");
    }
    const hostname = normalizeHostname(raw);
    if (!hostname.split(".").every(validDnsLabel) || isIP(hostname) || isPrivateOrLocalHostname(hostname)) {
      throw new Error(`BFL_MEDIA_HOSTS contains an unsafe hostname: ${raw.trim()}`);
    }
    hosts.add(hostname);
  }
  return hosts;
}

function resultUrlFrom(value, apiKey, env = process.env) {
  const result = value?.result;
  const candidates = [
    result?.video?.url,
    result?.video?.href,
    result?.video,
    result?.videoUrl,
    result?.video_url,
    result?.sample,
    result?.url,
    value?.video?.url,
    value?.videoUrl,
    value?.video_url,
    value?.output?.url,
    value?.url
  ];
  const url = firstString(...candidates);
  if (!url) throw new Error("BFL result does not contain a video URL");
  if (urlContainsSecret(url, apiKey)) throw new Error("BFL result video URL contains the API key");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BFL result contains an invalid video URL");
  }
  if (parsed.protocol !== "https:") throw new Error("BFL result video URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("BFL result video URL must not contain credentials");
  if (parsed.port) throw new Error("BFL result video URL must use the default HTTPS port");
  if (parsed.hash) throw new Error("BFL result video URL must not contain a fragment");
  const hostname = normalizeHostname(parsed.hostname);
  if (isIP(hostname) || isPrivateOrLocalHostname(hostname)) throw new Error("BFL result video URL host is private, local, or an IP literal");
  if (!isOfficialDeliveryHostname(hostname) && !configuredMediaHosts(env).has(hostname)) {
    throw new Error("BFL result video URL host is not an approved delivery host");
  }
  return parsed.href;
}

function pollingUrlFrom(value, taskId, apiKey) {
  const id = requiredString(taskId, "BFL task ID");
  const supplied = firstString(value?.polling_url, value?.pollingUrl, value?.poll_url, value?.pollUrl);
  const candidate = supplied || `${API_BASE_URL}/v1/get_result?id=${encodeURIComponent(id)}`;
  if (urlContainsSecret(candidate, apiKey)) throw new Error("BFL polling URL contains the API key");
  let parsed;
  try {
    parsed = new URL(candidate, API_BASE_URL);
  } catch {
    throw new Error("BFL response contains an invalid polling URL");
  }
  if (parsed.protocol !== "https:") throw new Error("BFL polling URL must use HTTPS");
  if (parsed.username || parsed.password || parsed.port || parsed.hash || !APPROVED_API_ORIGINS.has(parsed.origin)) {
    throw new Error("BFL polling URL origin or URL components are not approved");
  }
  if (parsed.pathname !== "/v1/get_result") throw new Error("BFL polling URL path is not approved");
  const ids = parsed.searchParams.getAll("id");
  if (ids.length !== 1 || ids[0] !== id) throw new Error("BFL polling URL task ID does not match the submission");
  for (const [key] of parsed.searchParams) {
    if (SENSITIVE_QUERY_KEY.test(key)) throw new Error("BFL polling URL contains a sensitive query parameter");
  }
  return parsed.href;
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("stdin must contain one JSON object");
  assertSafeJobId(request.jobId);
  requiredString(request.runId, "runId");
  const requestHash = requiredString(request.requestHash, "requestHash");
  const scriptHash = requiredString(request.scriptHash, "scriptHash");
  if (!/^sha256:[a-f0-9]{64}$/u.test(requestHash)) throw new Error("requestHash must be a sha256 digest");
  if (!/^sha256:[a-f0-9]{64}$/u.test(scriptHash)) throw new Error("scriptHash must be a sha256 digest");
  if (!Array.isArray(request.segments) || request.segments.length === 0) throw new Error("segments must be a non-empty array");
  for (const [index, segment] of request.segments.entries()) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error(`segment ${index + 1} is malformed`);
    const segmentIndex = Number(segment.index ?? index + 1);
    if (!Number.isInteger(segmentIndex) || segmentIndex !== index + 1) throw new Error("segments must have contiguous 1-based indices");
    const prompt = requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`);
    if (segment.providerVisualPromptHash !== undefined) {
      const providerVisualPrompt = requiredString(segment.providerVisualPrompt, `segments[${index + 1}].providerVisualPrompt`);
      if (prompt !== providerVisualPrompt) throw new Error(`segment ${index + 1} providerVisualPrompt must equal the submitted prompt`);
      if (segment.providerVisualPromptHash !== hashJson(providerVisualPrompt)) {
        throw new Error(`segment ${index + 1} providerVisualPromptHash does not match providerVisualPrompt`);
      }
      if (!segment.shotPattern || typeof segment.shotPattern !== "object" || Array.isArray(segment.shotPattern)) {
        throw new Error(`segment ${index + 1} shotPattern is required when providerVisualPromptHash is present`);
      }
    }
  }
  return request;
}

function requestBodiesFor(request, env = process.env) {
  const authorization = request?.paidAuthorization;
  const authorizedPolicy = authorization?.context?.requestPolicy || null;
  if (authorization) {
    validateBflRequestAuthorization(authorization, request, { now: new Date(authorization.approvedAt) });
    if (!authorizedPolicy || authorizedPolicy.durationsSec?.length !== request.segments.length) {
      throw new Error("BFL paid authorization task policy does not match the requested segments");
    }
  }
  const configuredResolution = authorizedPolicy?.resolution ?? request?.bfl?.resolution ?? env.BFL_VIDEO_RESOLUTION ?? "hd";
  if (!new Set(["hd", "fhd"]).has(configuredResolution)) throw new Error("BFL video resolution must be hd or fhd");
  const generateAudio = authorizedPolicy?.generateAudio ?? strictBoolean(request?.bfl?.generateAudio ?? env.BFL_GENERATE_AUDIO, false, "BFL_GENERATE_AUDIO");
  const safetyTolerance = authorizedPolicy?.safetyTolerance ?? boundedIntegerSetting(request?.bfl?.safetyTolerance ?? env.BFL_SAFETY_TOLERANCE, 2, 0, 4, "BFL_SAFETY_TOLERANCE");
  const aspectRatio = authorizedPolicy?.aspectRatio ?? (request.format === "vertical" ? "9:16" : "16:9");
  return request.segments.map((segment, index) => ({
    index: index + 1,
    body: {
      mode: "t2v",
      prompt: requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`),
      aspect_ratio: aspectRatio,
      duration: authorizedPolicy?.durationsSec?.[index] ?? durationFor(segment, request),
      resolution: configuredResolution,
      version: MODEL_VERSION,
      generate_audio: generateAudio,
      safety_tolerance: safetyTolerance,
      draft: false
    }
  }));
}

function maximumConfiguredNumber(values, label, options = {}) {
  const parsed = values
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => strictPositiveNumber(value, label, { ...options, optional: false }));
  return parsed.length ? Math.max(...parsed) : null;
}

function minimumConfiguredNumber(values, label, options = {}) {
  const parsed = values
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => strictPositiveNumber(value, label, { ...options, optional: false }));
  return parsed.length ? Math.min(...parsed) : null;
}

function officialTaskCreditFloor(task) {
  const body = task?.body;
  if (body?.mode !== "t2v" || body?.draft !== false) {
    throw new Error(`official BFL pricing floor is unavailable for ${String(body?.mode || "unknown")} ${body?.draft ? "draft" : "full"} generation`);
  }
  const creditsPerSecond = OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND[body.resolution];
  if (!Number.isFinite(creditsPerSecond)) {
    throw new Error(`official BFL pricing floor is unavailable for resolution ${String(body?.resolution || "unknown")}`);
  }
  const duration = strictPositiveNumber(body.duration, "BFL task duration");
  return { credits: duration * creditsPerSecond, creditsPerSecond };
}

function budgetFor(request, tasks, env = process.env) {
  const requestBudget = request.budget && typeof request.budget === "object" && !Array.isArray(request.budget) ? request.budget : {};
  const authorizedMaxCredits = request?.paidAuthorization?.context?.maxCredits;
  const maxCredits = authorizedMaxCredits ?? minimumConfiguredNumber([
    requestBudget.maxCredits,
    request.maxCredits,
    env.BFL_MAX_CREDITS
  ], "BFL maximum credits");
  const perSecond = maximumConfiguredNumber([
    requestBudget.estimatedCreditsPerSecond,
    env.BFL_ESTIMATED_CREDITS_PER_SECOND
  ], "BFL estimated credits per second", { allowZero: true }) ?? 0;
  const perRequest = maximumConfiguredNumber([
    requestBudget.estimatedCreditsPerRequest,
    env.BFL_ESTIMATED_CREDITS_PER_REQUEST
  ], "BFL estimated credits per request", { allowZero: true }) ?? 0;
  const authorizedEstimate = request?.paidAuthorization?.context?.operatorEstimateCredits;
  const directTotal = authorizedEstimate ?? maximumConfiguredNumber([
    requestBudget.estimatedTotalCredits,
    request.estimatedCostCredits,
    env.BFL_ESTIMATED_TOTAL_CREDITS
  ], "BFL estimated total credits", { allowZero: true });
  const rateEstimates = tasks.map((task) => task.body.duration * perSecond + perRequest);
  const rateTotal = rateEstimates.reduce((sum, value) => sum + value, 0);
  const operatorEstimatedTotalCredits = Math.max(rateTotal, directTotal ?? 0);
  const officialFloors = tasks.map(officialTaskCreditFloor);
  const officialMinimumCredits = officialFloors.reduce((sum, floor) => sum + floor.credits, 0);
  const guardedTaskBases = tasks.map((_, index) => Math.max(rateEstimates[index], officialFloors[index].credits));
  const guardedBaseTotal = guardedTaskBases.reduce((sum, value) => sum + value, 0);
  const estimatedTotalCredits = Math.max(guardedBaseTotal, directTotal ?? 0);
  const unallocatedCredits = estimatedTotalCredits - guardedBaseTotal;
  const taskEstimates = guardedTaskBases.map((base, index) => {
    if (!(unallocatedCredits > 0)) return base;
    const weight = officialMinimumCredits > 0
      ? officialFloors[index].credits / officialMinimumCredits
      : 1 / tasks.length;
    return base + unallocatedCredits * weight;
  });
  return {
    maxCredits,
    operatorEstimatedTotalCredits,
    officialMinimumCredits,
    estimatedTotalCredits,
    estimatedTotalUsd: estimatedTotalCredits * CREDIT_USD,
    creditUsd: CREDIT_USD,
    estimateBasis: {
      estimatedCreditsPerSecond: perSecond || null,
      estimatedCreditsPerRequest: perRequest || null,
      estimatedTotalCredits: directTotal,
      officialPriceFloor: {
        provider: "bfl",
        model: MODEL,
        mode: "t2v",
        render: "full",
        creditUsd: CREDIT_USD,
        creditsPerSecond: { ...OFFICIAL_FULL_RENDER_CREDITS_PER_SECOND },
        source: OFFICIAL_PRICING_URL
      }
    },
    taskEstimates
  };
}

function assertLiveBudget(budget) {
  if (!Number.isFinite(budget.maxCredits) || budget.maxCredits <= 0) {
    throw new Error("live BFL generation requires BFL_MAX_CREDITS or request.budget.maxCredits");
  }
  if (!Number.isFinite(budget.operatorEstimatedTotalCredits) || budget.operatorEstimatedTotalCredits <= 0) {
    throw new Error("live BFL generation requires BFL_ESTIMATED_TOTAL_CREDITS, BFL_ESTIMATED_CREDITS_PER_SECOND, BFL_ESTIMATED_CREDITS_PER_REQUEST, or the request budget equivalent");
  }
  if (!Number.isFinite(budget.officialMinimumCredits) || budget.officialMinimumCredits <= 0) {
    throw new Error(`official ${MODEL} pricing floor is unavailable; live BFL generation is disabled`);
  }
  if (budget.operatorEstimatedTotalCredits < budget.officialMinimumCredits) {
    throw new Error(`operator-supplied BFL estimate ${budget.operatorEstimatedTotalCredits} credits is below the official ${MODEL} full-render floor of ${budget.officialMinimumCredits} credits`);
  }
  if (!Number.isFinite(budget.estimatedTotalCredits) || budget.estimatedTotalCredits > budget.maxCredits) {
    throw new Error(`estimated BFL cost ${budget.estimatedTotalCredits} credits exceeds the ${budget.maxCredits}-credit ceiling`);
  }
}

function checkpointRunKey(request) {
  return createHash("sha256")
    .update(`${request.jobId}\0${request.runId}\0${request.requestHash}\0${request.scriptHash}`)
    .digest("hex");
}

function generationPlan(request, env = process.env) {
  validateRequest(request);
  configuredMediaHosts(env);
  const tasks = requestBodiesFor(request, env).map((task) => {
    const relativePath = relativeClipPath(task.index);
    const bodySnapshot = canonicalJsonSnapshot(task.body, `BFL task ${task.index} request body`);
    return {
      ...task,
      body: bodySnapshot.value,
      requestBodyText: bodySnapshot.text,
      relativePath,
      requestBodyHash: bodySnapshot.sha256,
      estimatedCredits: 0
    };
  });
  const budget = budgetFor(request, tasks, env);
  tasks.forEach((task, index) => {
    task.estimatedCredits = budget.taskEstimates[index];
  });
  const jobDirectory = workingDirectoryFor(request);
  const checkpointRunName = checkpointRunKey(request);
  const checkpointDirectory = join(jobDirectory, CHECKPOINT_ROOT_NAME, checkpointRunName);
  return {
    endpoint: API_URL,
    method: "POST",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    concurrency: 1,
    jobDirectory,
    clipsDirectory: join(jobDirectory, "clips"),
    checkpointDirectory,
    checkpointRunName,
    budget: { ...budget, taskEstimates: undefined },
    tasks: tasks.map((task) => ({
      ...task,
      outputName: basename(task.relativePath),
      checkpointName: `task-${String(task.index).padStart(3, "0")}.json`,
      checkpointPath: join(checkpointDirectory, `task-${String(task.index).padStart(3, "0")}.json`)
    }))
  };
}

function dryRunReceipt(request, env = process.env) {
  const plan = generationPlan(request, env);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "dry-run",
    networkRequests: 0,
    jobId: request.jobId,
    runId: request.runId,
    provider: "local-video",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    contract: {
      endpoint: plan.endpoint,
      method: plan.method,
      concurrency: plan.concurrency,
      checkpointDirectory: plan.checkpointDirectory,
      outputDirectory: plan.clipsDirectory
    },
    budget: {
      ...plan.budget,
      liveReady: plan.budget.maxCredits !== null
        && plan.budget.operatorEstimatedTotalCredits >= plan.budget.officialMinimumCredits
        && plan.budget.estimatedTotalCredits <= plan.budget.maxCredits
    },
    tasks: plan.tasks.map((task) => ({
      index: task.index,
      request: task.body,
      requestBodyHash: task.requestBodyHash,
      estimatedCredits: task.estimatedCredits,
      output: task.relativePath,
      checkpointPath: task.checkpointPath
    }))
  };
}

function dryRunRequested(request, env = process.env) {
  const environmentForcesDryRun = strictBoolean(env.BFL_DRY_RUN, false, "BFL_DRY_RUN");
  const requestForcesDryRun = strictBoolean(request.dryRun, false, "request.dryRun");
  return environmentForcesDryRun || requestForcesDryRun;
}

async function openAbsoluteDirectoryStrict(path, label) {
  const pathnameIdentity = await lstat(path, { bigint: true });
  if (!pathnameIdentity.isDirectory() || pathnameIdentity.isSymbolicLink?.()) throw new Error(`${label} is not an exact non-symlink directory`);
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameFdIdentity(pathnameIdentity, identity)) throw new Error(`${label} changed while it was opened`);
    return { path, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function optionalDirectoryAt(parentFd, name, label) {
  try {
    const fd = openDirectoryAt(parentFd, name);
    const identity = statFd(fd);
    if (!identity.isDirectory()) {
      closeFd(fd);
      throw new Error(`${label} is not a directory`);
    }
    return { fd, identity };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} is not an exact non-symlink directory`);
  }
}

function optionalOwnedFileAt(parentFd, name, maximumBytes, label) {
  let fd;
  try {
    fd = openFileAt(parentFd, name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} is not an exact non-symlink regular file`);
  }
  try {
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size > BigInt(maximumBytes)) {
      throw new Error(`${label} is not a bounded single-link regular file`);
    }
    return { fd, identity };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function closeOptionalOwnedFile(snapshot) {
  if (snapshot?.fd !== null && snapshot?.fd !== undefined) closeFd(snapshot.fd);
}

function exactFileIdentityAt(parentFd, name, expected, maximumBytes, label) {
  const current = optionalOwnedFileAt(parentFd, name, maximumBytes, label);
  try {
    return Boolean(current && sameFdIdentity(expected, current.identity));
  } finally {
    closeOptionalOwnedFile(current);
  }
}

function closeBflStorage(storage) {
  if (!storage || storage.closed) return;
  storage.closed = true;
  if (storage.checkpointRun) closeFd(storage.checkpointRun.fd);
  if (storage.checkpointRoot) closeFd(storage.checkpointRoot.fd);
  if (storage.clips) closeFd(storage.clips.fd);
  if (storage.job) closeFd(storage.job.fd);
  if (storage.jobs) closeFd(storage.jobs.fd);
  if (storage.workspace) closeFd(storage.workspace.fd);
  storage.project?.handle?.close?.().catch(() => {});
}

async function pinBflStorage(plan, request) {
  assertSafeJobId(request.jobId);
  const projectPath = resolve(import.meta.dirname, "..");
  const expectedJobDirectory = join(projectPath, "workspace", "jobs", request.jobId);
  if (resolve(plan.jobDirectory) !== expectedJobDirectory) throw new Error("BFL job directory is not the canonical project workspace job child");
  const project = await openAbsoluteDirectoryStrict(projectPath, "BFL project root");
  const storage = { project, workspace: null, jobs: null, job: null, clips: null, checkpointRoot: null, checkpointRun: null, plan, request, closed: false };
  try {
    const workspaceFd = openDirectoryAt(project.handle.fd, "workspace");
    storage.workspace = { fd: workspaceFd, identity: statFd(workspaceFd) };
    const jobsFd = openDirectoryAt(workspaceFd, "jobs");
    storage.jobs = { fd: jobsFd, identity: statFd(jobsFd) };
    const jobFd = openDirectoryAt(jobsFd, request.jobId);
    storage.job = { fd: jobFd, identity: statFd(jobFd) };
    const clipsFd = openDirectoryAt(jobFd, "clips");
    storage.clips = { fd: clipsFd, identity: statFd(clipsFd) };
    storage.checkpointRoot = optionalDirectoryAt(jobFd, CHECKPOINT_ROOT_NAME, "BFL checkpoint root");
    if (storage.checkpointRoot) {
      storage.checkpointRun = optionalDirectoryAt(storage.checkpointRoot.fd, plan.checkpointRunName, "BFL checkpoint run directory");
    }
    const lease = optionalOwnedFileAt(storage.job.fd, basename(invocationLeasePath(plan, request)), MAX_INVOCATION_LEASE_BYTES, "BFL invocation lease");
    closeOptionalOwnedFile(lease);
    for (const task of plan.tasks) {
      const output = optionalOwnedFileAt(storage.clips.fd, task.outputName, DEFAULT_MAX_MEDIA_BYTES, `BFL output ${task.index}`);
      closeOptionalOwnedFile(output);
      if (storage.checkpointRun) {
        const checkpoint = optionalOwnedFileAt(storage.checkpointRun.fd, task.checkpointName, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
        closeOptionalOwnedFile(checkpoint);
      }
    }
    await assertBflStorageCurrent(storage, "preflight");
    return storage;
  } catch (error) {
    closeBflStorage(storage);
    const wrapped = new Error(`BFL canonical workspace storage를 검증할 수 없습니다: ${error.message}`);
    wrapped.code = "BFL_STORAGE_UNSAFE";
    throw wrapped;
  }
}

async function assertBflStorageCurrent(storage, phase) {
  const currentProject = await openAbsoluteDirectoryStrict(storage.project.path, `BFL project root (${phase})`);
  const opened = [];
  try {
    if (!sameFdIdentity(storage.project.identity, currentProject.identity)) throw new Error(`BFL project root changed during ${phase}`);
    const workspaceFd = openDirectoryAt(currentProject.handle.fd, "workspace"); opened.push(workspaceFd);
    if (!sameFdIdentity(storage.workspace.identity, statFd(workspaceFd))) throw new Error(`BFL workspace changed during ${phase}`);
    const jobsFd = openDirectoryAt(workspaceFd, "jobs"); opened.push(jobsFd);
    if (!sameFdIdentity(storage.jobs.identity, statFd(jobsFd))) throw new Error(`BFL jobs root changed during ${phase}`);
    const jobFd = openDirectoryAt(jobsFd, storage.request.jobId); opened.push(jobFd);
    if (!sameFdIdentity(storage.job.identity, statFd(jobFd))) throw new Error(`BFL job directory changed during ${phase}`);
    const clipsFd = openDirectoryAt(jobFd, "clips"); opened.push(clipsFd);
    if (!sameFdIdentity(storage.clips.identity, statFd(clipsFd))) throw new Error(`BFL clips directory changed during ${phase}`);
    if (storage.checkpointRoot) {
      const checkpointRootFd = openDirectoryAt(jobFd, CHECKPOINT_ROOT_NAME); opened.push(checkpointRootFd);
      if (!sameFdIdentity(storage.checkpointRoot.identity, statFd(checkpointRootFd))) throw new Error(`BFL checkpoint root changed during ${phase}`);
      if (storage.checkpointRun) {
        const checkpointRunFd = openDirectoryAt(checkpointRootFd, storage.plan.checkpointRunName); opened.push(checkpointRunFd);
        if (!sameFdIdentity(storage.checkpointRun.identity, statFd(checkpointRunFd))) throw new Error(`BFL checkpoint run directory changed during ${phase}`);
      }
    }
  } finally {
    for (const fd of opened.reverse()) closeFd(fd);
    await currentProject.handle.close();
  }
}

async function ensureBflCheckpointStorage(storage) {
  if (!storage.checkpointRoot) {
    const fd = openOrCreateDirectoryAt(storage.job.fd, CHECKPOINT_ROOT_NAME, 0o700);
    storage.checkpointRoot = { fd, identity: statFd(fd) };
  }
  if (!storage.checkpointRun) {
    const fd = openOrCreateDirectoryAt(storage.checkpointRoot.fd, storage.plan.checkpointRunName, 0o700);
    storage.checkpointRun = { fd, identity: statFd(fd) };
  }
  await assertBflStorageCurrent(storage, "checkpoint publication");
}

function readOwnedBytesAt(parentFd, name, maximumBytes, label) {
  const snapshot = optionalOwnedFileAt(parentFd, name, maximumBytes, label);
  if (!snapshot) return null;
  try {
    const bytes = readFdBuffer(snapshot.fd, { maxBytes: maximumBytes });
    const after = statFd(snapshot.fd);
    if (after.nlink !== 1n || !sameFdIdentity(snapshot.identity, after)) throw new Error(`${label} changed while it was read`);
    return { bytes, identity: snapshot.identity };
  } finally {
    closeOptionalOwnedFile(snapshot);
  }
}

function writeJsonAtomicAt(parentFd, name, value, maximumBytes, label) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds its maximum byte size`);
  const current = optionalOwnedFileAt(parentFd, name, maximumBytes, label);
  try {
    if (current) {
      replaceFileAt(parentFd, name, bytes, { expectedIdentity: current.identity, mode: 0o600 });
    } else {
      const fd = createFileAt(parentFd, name, fsConstants.O_RDWR, 0o600, { initialBytes: bytes });
      closeFd(fd);
    }
    syncFd(parentFd);
  } finally {
    closeOptionalOwnedFile(current);
  }
}

async function preflightBflStorage(request, env = process.env) {
  const plan = generationPlan(request, env);
  const storage = await pinBflStorage(plan, request);
  try {
    return {
      jobDirectory: plan.jobDirectory,
      clipsDirectory: plan.clipsDirectory,
      checkpointDirectory: plan.checkpointDirectory,
      checkpointExists: Boolean(storage.checkpointRun)
    };
  } finally {
    closeBflStorage(storage);
  }
}

function invocationLeasePath(plan, request) {
  return join(plan.jobDirectory, `${INVOCATION_LEASE_PREFIX}${checkpointRunKey(request)}.json`);
}

function invocationLeaseUnsigned(request, { ownerNonce, acquiredAt, mode, takeoverOfLeaseHash = null }) {
  return {
    schemaVersion: INVOCATION_LEASE_SCHEMA_VERSION,
    type: "bfl-flux-video-invocation-lease",
    status: "exclusive-owner",
    mode,
    jobId: request.jobId,
    runId: request.runId,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    pid: process.pid,
    ownerNonce,
    acquiredAt,
    takeoverOfLeaseHash
  };
}

function validateInvocationLease(lease, request) {
  const expectedKeys = [
    "acquiredAt", "jobId", "leaseHash", "mode", "ownerNonce", "pid", "requestHash", "runId",
    "schemaVersion", "scriptHash", "status", "takeoverOfLeaseHash", "type"
  ];
  const { leaseHash, ...unsigned } = lease || {};
  if (
    !lease
    || typeof lease !== "object"
    || Array.isArray(lease)
    || Object.keys(lease).sort().join(",") !== expectedKeys.sort().join(",")
    || lease.schemaVersion !== INVOCATION_LEASE_SCHEMA_VERSION
    || lease.type !== "bfl-flux-video-invocation-lease"
    || lease.status !== "exclusive-owner"
    || !["pending", "paid-owner", "provider-zero-recovery"].includes(lease.mode)
    || lease.jobId !== request.jobId
    || lease.runId !== request.runId
    || lease.requestHash !== request.requestHash
    || lease.scriptHash !== request.scriptHash
    || !Number.isInteger(lease.pid)
    || lease.pid <= 0
    || typeof lease.ownerNonce !== "string"
    || !/^[0-9a-f-]{36}$/u.test(lease.ownerNonce)
    || (lease.takeoverOfLeaseHash !== null && !/^sha256:[a-f0-9]{64}$/u.test(lease.takeoverOfLeaseHash || ""))
    || !Number.isFinite(Date.parse(lease.acquiredAt || ""))
    || leaseHash !== hashJson(unsigned)
  ) throw new Error("BFL invocation lease is malformed or bound to another request");
  return lease;
}

async function readInvocationLease(storage, request) {
  const name = basename(invocationLeasePath(storage.plan, request));
  const snapshot = readOwnedBytesAt(storage.job.fd, name, MAX_INVOCATION_LEASE_BYTES, "BFL invocation lease");
  if (!snapshot) return null;
  let lease;
  try {
    lease = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("BFL invocation lease is not valid JSON");
  }
  return { lease: validateInvocationLease(lease, request), identity: snapshot.identity };
}

async function closeGlobalBflGuard(server) {
  if (!server) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function acquireGlobalBflGuard() {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: GLOBAL_BFL_GUARD_HOST,
        port: GLOBAL_BFL_GUARD_PORT,
        exclusive: true
      });
    });
  } catch (error) {
    await closeGlobalBflGuard(server).catch(() => {});
    if (error?.code === "EADDRINUSE") {
      throw new Error("another BFL invocation already owns this exact request or an unknown process holds the global paid-executor guard");
    }
    throw new Error("the global BFL paid-executor guard could not be acquired");
  }
  const address = server.address();
  if (
    !address
    || typeof address === "string"
    || address.address !== GLOBAL_BFL_GUARD_HOST
    || address.port !== GLOBAL_BFL_GUARD_PORT
  ) {
    await closeGlobalBflGuard(server).catch(() => {});
    throw new Error("the global BFL paid-executor guard bound an unexpected address");
  }
  return server;
}

async function acquireInvocationLease(plan, request, storage) {
  const guard = await acquireGlobalBflGuard();
  const path = invocationLeasePath(plan, request);
  const name = basename(path);
  const ownerNonce = randomUUID();
  const acquiredAt = new Date().toISOString();
  let priorLease = null;
  try {
    priorLease = await readInvocationLease(storage, request);
  } catch (error) {
    await closeGlobalBflGuard(guard).catch(() => {});
    throw error;
  }
  const unsigned = invocationLeaseUnsigned(request, {
    ownerNonce,
    acquiredAt,
    mode: "pending",
    takeoverOfLeaseHash: priorLease?.lease?.leaseHash || null
  });
  const lease = { ...unsigned, leaseHash: hashJson(unsigned) };
  try {
    await assertBflStorageCurrent(storage, "invocation lease publication");
    writeJsonAtomicAt(storage.job.fd, name, lease, MAX_INVOCATION_LEASE_BYTES, "BFL invocation lease");
    return { path, name, lease, guard, storage };
  } catch (error) {
    await closeGlobalBflGuard(guard).catch(() => {});
    if (error?.code === "EEXIST") throw new Error("BFL invocation lease appeared while the global guard was held");
    throw error;
  }
}

async function setInvocationLeaseMode(owner, request, mode) {
  const currentSnapshot = await readInvocationLease(owner.storage, request);
  const current = currentSnapshot?.lease;
  if (!current || current.ownerNonce !== owner.lease.ownerNonce || current.pid !== process.pid) {
    throw new Error("BFL invocation lease ownership changed unexpectedly");
  }
  const unsigned = invocationLeaseUnsigned(request, {
    ownerNonce: current.ownerNonce,
    acquiredAt: current.acquiredAt,
    mode,
    takeoverOfLeaseHash: current.takeoverOfLeaseHash
  });
  const lease = { ...unsigned, leaseHash: hashJson(unsigned) };
  writeJsonAtomicAt(owner.storage.job.fd, owner.name, lease, MAX_INVOCATION_LEASE_BYTES, "BFL invocation lease");
  owner.lease = lease;
  return owner;
}

async function releaseInvocationLease(owner, request) {
  let releaseError = null;
  try {
    const current = (await readInvocationLease(owner.storage, request))?.lease;
    if (!current || current.ownerNonce !== owner.lease.ownerNonce || current.pid !== process.pid) {
      throw new Error("BFL invocation lease cannot be released by a non-owner");
    }
    unlinkAt(owner.storage.job.fd, owner.name);
    syncFd(owner.storage.job.fd);
  } catch (error) {
    releaseError = error;
  } finally {
    await closeGlobalBflGuard(owner.guard).catch((error) => {
      releaseError ||= error;
    });
  }
  if (releaseError) throw releaseError;
}

async function loadCheckpoint(task, request, storage) {
  const snapshot = readOwnedBytesAt(storage.checkpointRun.fd, task.checkpointName, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
  if (!snapshot) return null;
  let checkpoint;
  try {
    checkpoint = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error(`BFL checkpoint ${task.index} is not valid JSON`);
  }
  const identityMatches = checkpoint?.schemaVersion === CHECKPOINT_SCHEMA_VERSION
    && checkpoint?.provider === "bfl"
    && checkpoint?.model === MODEL
    && checkpoint?.jobId === request.jobId
    && checkpoint?.runId === request.runId
    && checkpoint?.requestHash === request.requestHash
    && checkpoint?.scriptHash === request.scriptHash
    && checkpoint?.index === task.index
    && checkpoint?.requestBodyHash === task.requestBodyHash
    && checkpoint?.output === task.relativePath;
  if (!identityMatches) throw new Error(`BFL checkpoint ${task.index} does not match this immutable request`);
  if (
    !checkpoint.request
    || typeof checkpoint.request !== "object"
    || Array.isArray(checkpoint.request)
    || hashJson(checkpoint.request) !== task.requestBodyHash
  ) {
    throw new Error(`BFL task ${task.index} checkpoint request body hash is invalid`);
  }
  return checkpoint;
}

function baseCheckpoint(task, request) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    provider: "bfl",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    jobId: request.jobId,
    runId: request.runId,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    index: task.index,
    requestBodyHash: task.requestBodyHash,
    request: JSON.parse(task.requestBodyText),
    estimatedCredits: task.estimatedCredits,
    output: task.relativePath,
    phase: "prepared",
    preparedAt: new Date().toISOString()
  };
}

function cancelResponseBody(response, reason) {
  try {
    const cancellation = response?.body?.cancel?.(reason);
    if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {});
  } catch {
    // Cancellation is best-effort after the request has already failed closed.
  }
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return value === null || value === undefined ? null : String(value).trim();
}

function declaredResponseLength(response, maximumBytes, label) {
  const value = responseHeader(response, "content-length");
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} returned an invalid Content-Length`);
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error(`${label} returned an invalid Content-Length`);
  if (length > maximumBytes) throw new Error(`${label} exceeds maximum size of ${maximumBytes} bytes`);
  return length;
}

function assertIdentityResponseEncoding(response, label) {
  const encoding = responseHeader(response, "content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new Error(`${label} returned an unsupported Content-Encoding`);
  }
}

function assertJsonResponseType(response, label) {
  const contentType = responseHeader(response, "content-type");
  if (!contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    throw new Error(`${label} returned an invalid Content-Type`);
  }
}

function fixedTimeoutError(label) {
  const error = new Error(`${label} timed out`);
  error.code = "BFL_RESPONSE_TIMEOUT";
  return error;
}

async function readResponseChunk(reader, signal, label) {
  if (!signal) return reader.read();
  if (signal.aborted) throw fixedTimeoutError(label);
  return new Promise((resolveRead, rejectRead) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectRead, fixedTimeoutError(label));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolveRead, value),
      () => finish(rejectRead, new Error(`${label} response could not be read`))
    );
  });
}

async function readBoundedResponseBody(response, {
  signal,
  maximumBytes,
  declaredLength,
  label,
  onChunk
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("BFL response byte limit is invalid");
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error(`${label} response body was unavailable`);
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal, label);
      if (done) {
        finished = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      if (!Number.isSafeInteger(chunk.byteLength) || !Number.isSafeInteger(total + chunk.byteLength) || total + chunk.byteLength > maximumBytes) {
        throw new Error(`${label} exceeds maximum size of ${maximumBytes} bytes`);
      }
      if (onChunk) await onChunk(chunk, total);
      total += chunk.byteLength;
    }
    if (declaredLength !== null && declaredLength !== total) {
      throw new Error(`${label} did not match its declared Content-Length`);
    }
    return total;
  } catch (error) {
    try {
      const cancellation = reader.cancel(signal?.aborted ? "deadline exceeded" : "response rejected");
      if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {});
    } catch {}
    if (signal?.aborted && error?.code !== "BFL_RESPONSE_TIMEOUT") throw fixedTimeoutError(label);
    throw error;
  } finally {
    if (finished) {
      try { reader.releaseLock(); } catch {}
    }
  }
}

function raceRequestDeadline(promise, signal, label) {
  if (signal.aborted) return Promise.reject(fixedTimeoutError(label));
  return new Promise((resolveRace, rejectRace) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectRace, fixedTimeoutError(label));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolveRace, value),
      (error) => finish(rejectRace, error)
    );
  });
}

async function fetchBounded(url, options, timeoutMs, fetchImpl = globalThis.fetch, consumeResponse) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
  if (typeof consumeResponse !== "function") throw new TypeError("BFL response consumer is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) {
    throw new TypeError("BFL request timeout is invalid");
  }
  const controller = new AbortController();
  const label = "BFL request";
  const timer = setTimeout(() => controller.abort(fixedTimeoutError(label)), timeoutMs);
  let response = null;
  let consumed = false;
  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(url, { ...options, redirect: "error", signal: controller.signal }));
    void fetchPromise.then((lateResponse) => {
      if (controller.signal.aborted && lateResponse !== response) cancelResponseBody(lateResponse, "request deadline exceeded");
    }, () => {});
    try {
      response = await raceRequestDeadline(fetchPromise, controller.signal, label);
    } catch (error) {
      if (controller.signal.aborted || error?.code === "BFL_RESPONSE_TIMEOUT") {
        throw new Error(`BFL request timed out after ${timeoutMs}ms`);
      }
      const detail = [error?.message, error?.cause?.message].filter(Boolean).join(" ");
      if (/redirect/iu.test(detail)) throw new Error("BFL request rejected redirect");
      throw new Error("BFL request failed");
    }
    const result = await raceRequestDeadline(
      Promise.resolve().then(() => consumeResponse(response, { signal: controller.signal })),
      controller.signal,
      label
    );
    consumed = true;
    return result;
  } catch (error) {
    if (controller.signal.aborted || error?.code === "BFL_RESPONSE_TIMEOUT") {
      throw new Error(`BFL request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (!consumed) cancelResponseBody(response, "response rejected");
  }
}

async function readJsonResponse(response, label, { signal, maximumBytes = DEFAULT_MAX_JSON_RESPONSE_BYTES } = {}) {
  if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
    cancelResponseBody(response, "redirect rejected");
    throw new Error(`BFL ${label} rejected redirect`);
  }
  if (!response || !response.ok) {
    const status = response?.status ?? "unknown";
    cancelResponseBody(response, "HTTP status rejected");
    throw new Error(`BFL ${label} returned HTTP ${status}`);
  }
  const responseLabel = `BFL ${label}`;
  let declaredLength;
  try {
    assertJsonResponseType(response, responseLabel);
    assertIdentityResponseEncoding(response, responseLabel);
    declaredLength = declaredResponseLength(response, maximumBytes, responseLabel);
  } catch (error) {
    cancelResponseBody(response, "response headers rejected");
    throw error;
  }
  const chunks = [];
  const total = await readBoundedResponseBody(response, {
    signal,
    maximumBytes,
    declaredLength,
    label: responseLabel,
    onChunk(chunk) { chunks.push(Buffer.from(chunk)); }
  });
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new Error(`${responseLabel} response was not valid UTF-8`);
  }
  if (!text.trim()) throw new Error(`BFL ${label} response was empty`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`BFL ${label} response was not valid JSON`);
  }
}

function providerCostFrom(value) {
  if (value?.cost === undefined || value?.cost === null) return null;
  return strictPositiveNumber(value.cost, "BFL provider cost", { allowZero: true });
}

async function submitTask(task, checkpoint, request, apiKey, deadline, options) {
  const approvedBodyText = task.requestBodyText;
  if (typeof approvedBodyText !== "string" || !approvedBodyText) {
    throw new Error(`BFL task ${task.index} exact approved POST bytes are missing`);
  }
  let approvedBodyValue;
  try {
    approvedBodyValue = JSON.parse(approvedBodyText);
  } catch {
    throw new Error(`BFL task ${task.index} exact approved POST bytes are invalid`);
  }
  const approvedBody = canonicalJsonSnapshot(approvedBodyValue, `BFL task ${task.index} approved POST bytes`);
  if (
    approvedBody.text !== approvedBodyText
    || approvedBody.sha256 !== task.requestBodyHash
    || canonicalJsonSnapshot(task.body, `BFL task ${task.index} request body`).text !== approvedBodyText
    || hashJson(checkpoint.request) !== task.requestBodyHash
  ) throw new Error(`BFL task ${task.index} body does not match the exact approved POST bytes`);
  const attemptId = randomUUID();
  const submissionStartedAt = options.now().toISOString();
  validateBflRequestAuthorization(request.paidAuthorization, request, { now: new Date(submissionStartedAt) });
  const submitting = {
    ...checkpoint,
    phase: "submitting",
    submissionAttemptId: attemptId,
    submissionStartedAt,
    lastError: undefined
  };
  writeJsonAtomicAt(options.storage.checkpointRun.fd, task.checkpointName, submitting, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
  // Re-attest after the durable pre-POST checkpoint. A scheduler pause or slow
  // fsync must never turn an expired approval into a paid provider call.
  const prePostAt = options.now();
  validateBflRequestAuthorization(request.paidAuthorization, request, { now: prePostAt });
  if (typeof options.beforePaidPost === "function") {
    await options.beforePaidPost({ task, submitting: structuredClone(submitting), prePostAt });
  }
  await assertBflStorageCurrent(options.storage, `paid POST ${task.index}`);
  const afterHookBody = canonicalJsonSnapshot(task.body, `BFL task ${task.index} request body`);
  if (
    task.requestBodyText !== approvedBodyText
    || task.requestBodyHash !== approvedBody.sha256
    || afterHookBody.text !== approvedBodyText
    || afterHookBody.sha256 !== approvedBody.sha256
  ) {
    throw new Error(`BFL task ${task.index} body changed after the durable pre-POST authorization check`);
  }
  await verifyBflConsumedApprovalForRequest(
    options.jobDirectory,
    request.paidAuthorization,
    request,
    {
      now: options.now(),
      apiKey,
      executorSnapshotPath: options.executorSnapshotPath,
      requireClaim: true
    }
  );
  const finalBody = canonicalJsonSnapshot(task.body, `BFL task ${task.index} request body`);
  if (
    task.requestBodyText !== approvedBodyText
    || task.requestBodyHash !== approvedBody.sha256
    || finalBody.text !== approvedBodyText
    || finalBody.sha256 !== approvedBody.sha256
  ) throw new Error(`BFL task ${task.index} body changed before the paid POST`);
  let submission;
  try {
    submission = await fetchBounded(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "x-key": apiKey },
      body: approvedBodyText
    }, Math.max(1, deadline - Date.now()), options.fetchImpl, (response, context) => (
      readJsonResponse(response, "submit", context)
    ));
    const submissionStatus = statusFrom(submission);
    if (FAILURE_STATUSES.has(submissionStatus) || MODERATION_STATUSES.has(submissionStatus)) {
      throw new Error(`BFL task submission failed with status ${submissionStatus}`);
    }
    const id = taskIdFrom(submission);
    if (!id) throw new Error("BFL submission did not contain a task ID");
    const pollingUrl = pollingUrlFrom(submission, id, apiKey);
    const submitted = {
      ...submitting,
      phase: "submitted",
      taskId: id,
      pollingUrl,
      providerCostCredits: providerCostFrom(submission),
      submissionStatus,
      submissionTimestamp: timestamp(submission),
      submittedAt: new Date().toISOString()
    };
    writeJsonAtomicAt(options.storage.checkpointRun.fd, task.checkpointName, submitted, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
    return submitted;
  } catch (error) {
    const unknown = {
      ...submitting,
      phase: "submission_unknown",
      submissionOutcomeUnknownAt: new Date().toISOString(),
      lastError: redactValue(error?.message || "BFL submission outcome is unknown", apiKey)
    };
    try {
      writeJsonAtomicAt(options.storage.checkpointRun.fd, task.checkpointName, unknown, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
    } catch {}
    throw new Error(`BFL task ${task.index} submission outcome is unknown; refusing automatic resubmission (checkpoint: ${task.checkpointPath})`);
  }
}

function assertResumableCheckpoint(checkpoint, task) {
  if (["submitting", "submission_unknown"].includes(checkpoint.phase)) {
    throw new Error(`BFL task ${task.index} has an ambiguous prior submission; automatic paid resubmission is disabled (checkpoint: ${task.checkpointPath})`);
  }
  if (!["prepared", "submitted", "downloaded"].includes(checkpoint.phase)) {
    throw new Error(`BFL task ${task.index} checkpoint has unsupported phase ${checkpoint.phase}`);
  }
  if (["submitted", "downloaded"].includes(checkpoint.phase)) {
    requiredString(checkpoint.taskId, `BFL task ${task.index} checkpoint taskId`);
    pollingUrlFrom({ polling_url: checkpoint.pollingUrl }, checkpoint.taskId, null);
    if (checkpoint.providerCostCredits !== null && checkpoint.providerCostCredits !== undefined) {
      strictPositiveNumber(checkpoint.providerCostCredits, `BFL task ${task.index} checkpoint provider cost`, { allowZero: true });
    }
  }
  if (checkpoint.phase === "downloaded") {
    if (!Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes <= 0) throw new Error(`BFL task ${task.index} checkpoint has invalid output bytes`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(checkpoint.sha256 || "")) throw new Error(`BFL task ${task.index} checkpoint has an invalid output hash`);
    if (!TERMINAL_SUCCESS_STATUSES.has(checkpoint.responseStatus)) throw new Error(`BFL task ${task.index} checkpoint is not bound to a successful provider result`);
  }
}

async function pollTask(checkpoint, apiKey, deadline, pollIntervalMs, options) {
  let latest = null;
  let pollCount = 0;
  let firstPoll = true;
  while (true) {
    if (latest) {
      const responseId = taskIdFrom(latest);
      if (responseId && responseId !== checkpoint.taskId) throw new Error(`BFL task ${checkpoint.taskId} poll result returned a different task ID`);
      const status = statusFrom(latest);
      if (FAILURE_STATUSES.has(status)) throw new Error(`BFL task ${checkpoint.taskId} failed with status ${status}`);
      if (MODERATION_STATUSES.has(status)) throw new Error(`BFL task ${checkpoint.taskId} was moderated (${status})`);
      if (TERMINAL_SUCCESS_STATUSES.has(status)) return { response: latest, pollCount };
      if (!status) throw new Error(`BFL task ${checkpoint.taskId} poll result is missing status`);
      if (!ACTIVE_STATUSES.has(status)) throw new Error(`BFL task ${checkpoint.taskId} returned unsupported status ${status}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`BFL task ${checkpoint.taskId} polling timed out`);
    if (!firstPoll) await options.sleep(Math.min(pollIntervalMs, remaining));
    firstPoll = false;
    await assertBflStorageCurrent(options.storage, `provider poll ${checkpoint.taskId}`);
    latest = await fetchBounded(checkpoint.pollingUrl, {
      method: "GET",
      headers: { accept: "application/json", "accept-encoding": "identity", "x-key": apiKey }
    }, Math.max(1, deadline - Date.now()), options.fetchImpl, (response, context) => (
      readJsonResponse(response, "poll", context)
    ));
    pollCount += 1;
  }
}

function contentTypeIsVideo(response) {
  const contentType = responseHeader(response, "content-type")?.toLowerCase();
  return Boolean(contentType && (/^video\/[a-z0-9!#$&^_.+-]+$/u.test(contentType) || contentType === "application/octet-stream"));
}

async function readVideoResponse(response, {
  signal,
  maximumBytes,
  onChunk
} = {}) {
  if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
    cancelResponseBody(response, "redirect rejected");
    throw new Error("video download rejected redirect");
  }
  if (!response?.ok) {
    cancelResponseBody(response, "HTTP status rejected");
    throw new Error(`video download returned HTTP ${response?.status ?? "unknown"}`);
  }
  if (!contentTypeIsVideo(response)) {
    cancelResponseBody(response, "content type rejected");
    throw new Error("video download returned an invalid content type");
  }
  try {
    assertIdentityResponseEncoding(response, "video download");
  } catch (error) {
    cancelResponseBody(response, "content encoding rejected");
    throw error;
  }
  let declaredLength;
  try {
    declaredLength = declaredResponseLength(response, maximumBytes, "video download");
  } catch (error) {
    cancelResponseBody(response, "content length rejected");
    throw error;
  }
  return readBoundedResponseBody(response, {
    signal,
    maximumBytes,
    declaredLength,
    label: "video download",
    onChunk
  });
}

function maxMediaBytes(env = process.env) {
  return boundedIntegerSetting(env.BFL_MAX_MEDIA_BYTES, DEFAULT_MAX_MEDIA_BYTES, 1, MAX_MAX_MEDIA_BYTES, "BFL_MAX_MEDIA_BYTES");
}

async function downloadVideo(url, outputName, timeoutMs, maxBytes, fetchImpl, storage) {
  await assertBflStorageCurrent(storage, `video download ${outputName}`);
  const temporaryName = `.${outputName}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryFd = null;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    temporaryFd = createFileAt(storage.clips.fd, temporaryName, fsConstants.O_RDWR, 0o600);
    bytes = await fetchBounded(url, {
      headers: { accept: "video/*", "accept-encoding": "identity" }
    }, timeoutMs, fetchImpl, (response, { signal }) => (
      readVideoResponse(response, {
        signal,
        maximumBytes: maxBytes,
        onChunk(chunk, offset) {
          const bytesChunk = Buffer.from(chunk);
          writeFdBuffer(temporaryFd, bytesChunk, offset);
          hash.update(bytesChunk);
        }
      })
    ));
    if (bytes === 0) throw new Error("video download was empty");
    syncFd(temporaryFd);
    closeFd(temporaryFd);
    temporaryFd = null;
    const existing = optionalOwnedFileAt(storage.clips.fd, outputName, maxBytes, `BFL output ${outputName}`);
    try {
      if (existing) {
        if (!exactFileIdentityAt(storage.clips.fd, outputName, existing.identity, maxBytes, `BFL output ${outputName}`)) {
          throw new Error("video output changed before publication");
        }
        unlinkAt(storage.clips.fd, outputName);
      }
    } finally {
      closeOptionalOwnedFile(existing);
    }
    renameAtNoReplace(storage.clips.fd, temporaryName, storage.clips.fd, outputName);
    syncFd(storage.clips.fd);
    await assertBflStorageCurrent(storage, `video publication ${outputName}`);
  } catch (error) {
    if (temporaryFd !== null) try { closeFd(temporaryFd); } catch {}
    try { unlinkAt(storage.clips.fd, temporaryName); } catch {}
    if (error?.message?.startsWith("video download")) throw error;
    throw new Error("video output could not be written");
  }
  return { bytes, sha256: `sha256:${hash.digest("hex")}` };
}

function hashExistingFileAt(parentFd, name, maximumBytes) {
  const snapshot = optionalOwnedFileAt(parentFd, name, maximumBytes, `BFL output ${name}`);
  if (!snapshot || snapshot.identity.size <= 0n) {
    closeOptionalOwnedFile(snapshot);
    return null;
  }
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    const size = Number(snapshot.identity.size);
    while (offset < size) {
      const bytesRead = readSync(snapshot.fd, buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
      if (bytesRead <= 0) throw new Error("BFL output ended before its declared size");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = statFd(snapshot.fd);
    if (after.nlink !== 1n || after.size !== snapshot.identity.size || !sameFdIdentity(after, snapshot.identity)) {
      throw new Error("BFL output changed while it was hashed");
    }
    return { bytes: size, sha256: `sha256:${hash.digest("hex")}` };
  } finally {
    closeOptionalOwnedFile(snapshot);
  }
}

async function completedCheckpointFile(checkpoint, task, storage, maximumBytes) {
  if (checkpoint.phase !== "downloaded") return null;
  assertClipPath(task.relativePath, storage.plan.clipsDirectory);
  const actual = hashExistingFileAt(storage.clips.fd, task.outputName, maximumBytes);
  if (!actual || actual.bytes !== checkpoint.bytes || actual.sha256 !== checkpoint.sha256) return null;
  return actual;
}

function checkpointProviderCost(checkpoint) {
  if (!["submitted", "downloaded"].includes(checkpoint?.phase)) return null;
  const value = checkpoint.providerCostCredits;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function knownProviderCost(checkpoints) {
  return checkpoints.reduce((sum, checkpoint) => {
    const value = checkpointProviderCost(checkpoint);
    return sum + (value ?? 0);
  }, 0);
}

function remainingEstimatedCost(plan, checkpoints, fromIndex) {
  return plan.tasks.slice(fromIndex).reduce((sum, task) => {
    const checkpoint = checkpoints[task.index - 1];
    return sum + (checkpointProviderCost(checkpoint) ?? task.estimatedCredits);
  }, 0);
}

function priorReportedOrEstimatedCost(plan, checkpoints, toIndex) {
  return plan.tasks.slice(0, toIndex).reduce((sum, task) => {
    const checkpoint = checkpoints[task.index - 1];
    return sum + (checkpointProviderCost(checkpoint) ?? task.estimatedCredits);
  }, 0);
}

function assertBudgetBeforeSubmission(plan, checkpoints, taskOffset) {
  const observed = priorReportedOrEstimatedCost(plan, checkpoints, taskOffset);
  const remaining = remainingEstimatedCost(plan, checkpoints, taskOffset);
  if (observed + remaining > plan.budget.maxCredits) {
    throw new Error(`BFL budget guard stopped before task ${taskOffset + 1}: ${observed + remaining} projected credits exceeds the ${plan.budget.maxCredits}-credit ceiling`);
  }
}

function segmentFromCheckpoint(checkpoint, task, request) {
  const requestSegment = request.segments[task.index - 1];
  if (checkpoint.requestBodyHash !== hashJson(checkpoint.request)) {
    throw new Error(`BFL task ${task.index} checkpoint request body hash is invalid`);
  }
  if (checkpoint.request?.prompt !== task.body.prompt || checkpoint.request?.prompt !== requestSegment.prompt) {
    throw new Error(`BFL task ${task.index} submitted prompt does not match the immutable local-video request`);
  }
  if (requestSegment.providerVisualPromptHash && (
    requestSegment.providerVisualPrompt !== checkpoint.request.prompt
    || requestSegment.providerVisualPrompt !== requestSegment.prompt
  )) {
    throw new Error(`BFL task ${task.index} provider shot-pattern prompt was not the submitted POST body`);
  }
  return {
    index: task.index,
    path: task.relativePath,
    output: task.relativePath,
    bytes: checkpoint.bytes,
    sha256: checkpoint.sha256,
    taskId: checkpoint.taskId,
    responseId: checkpoint.responseId || checkpoint.taskId,
    pollingUrl: redactUrl(checkpoint.pollingUrl, null),
    submittedAt: checkpoint.submittedAt,
    submissionStartedAt: checkpoint.submissionStartedAt,
    submissionResponseId: checkpoint.taskId,
    submissionTimestamp: checkpoint.submissionTimestamp,
    submissionStatus: checkpoint.submissionStatus,
    responseTimestamp: checkpoint.responseTimestamp,
    responseStatus: checkpoint.responseStatus,
    completedAt: checkpoint.completedAt,
    modelVersion: MODEL_VERSION,
    providerCostCredits: checkpoint.providerCostCredits,
    estimatedCredits: task.estimatedCredits,
    submittedRequestBody: structuredClone(checkpoint.request),
    submittedRequestBodyHash: checkpoint.requestBodyHash,
    submittedPromptHash: hashJson({ prompt: checkpoint.request.prompt }),
    resumed: Boolean(checkpoint.resumed),
    ...(requestSegment.providerVisualPromptHash ? {
      providerVisualPrompt: checkpoint.request.prompt,
      providerVisualPromptHash: requestSegment.providerVisualPromptHash,
      shotPattern: requestSegment.shotPattern,
      submittedToProvider: true
    } : {})
  };
}

async function generate(request, apiKey, runtime = {}) {
  validateRequest(request);
  if (!validateHistoricalBflRequestAuthorization(request?.paidAuthorization, request)) {
    throw new Error("live BFL generation requires an exact consumed paid request authorization");
  }
  const key = requiredString(apiKey, "BFL_API_KEY");
  assertBflValueDoesNotContainApiKey(request, key);
  const env = runtime.env || process.env;
  const plan = generationPlan(request, env);
  const storage = await pinBflStorage(plan, request);
  try {
    await verifyBflConsumedApprovalForRequest(
      plan.jobDirectory,
      request.paidAuthorization,
      request,
      {
        historical: true,
        apiKey: key,
        executorSnapshotPath: join(plan.jobDirectory, request.paidAuthorization.context.executorSnapshotName),
        requireClaim: true
      }
    );
    const invocationOwner = await acquireInvocationLease(plan, request, storage);
    try {
      if (typeof runtime.afterInvocationLeaseAcquired === "function") {
        await runtime.afterInvocationLeaseAcquired({ path: invocationOwner.path });
      }
      return await generateWithInvocationOwner(request, key, runtime, env, plan, invocationOwner, storage);
    } finally {
      await releaseInvocationLease(invocationOwner, request);
    }
  } finally {
    closeBflStorage(storage);
  }
}

async function generateWithInvocationOwner(request, key, runtime, env, plan, invocationOwner, storage) {
  const timeoutMs = boundedIntegerSetting(env.BFL_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS, 10, 60 * 60 * 1000, "BFL_POLL_TIMEOUT_MS");
  const pollIntervalMs = boundedIntegerSetting(env.BFL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 10, 60_000, "BFL_POLL_INTERVAL_MS");
  const mediaBytes = maxMediaBytes(env);
  const executorSnapshotPath = join(plan.jobDirectory, request.paidAuthorization.context.executorSnapshotName);
  const options = {
    fetchImpl: runtime.fetchImpl || globalThis.fetch,
    sleep: runtime.sleep || ((duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration))),
    now: () => new Date(),
    beforePaidPost: runtime.beforePaidPost,
    beforeProviderExecutionClaim: runtime.beforeProviderExecutionClaim,
    afterProviderExecutionClaim: runtime.afterProviderExecutionClaim,
    jobDirectory: plan.jobDirectory,
    executorSnapshotPath,
    storage
  };
  await ensureBflCheckpointStorage(storage);
  await assertBflStorageCurrent(storage, "before provider execution claim");
  let providerExecution = await claimBflProviderExecution(
    plan.jobDirectory,
    request.paidAuthorization,
    request,
    { allowMissing: true }
  );
  const hadProviderExecution = Boolean(providerExecution);
  let recoveryOnly = false;
  if (hadProviderExecution) {
    await verifyBflConsumedApprovalForRequest(
      plan.jobDirectory,
      request.paidAuthorization,
      request,
      { historical: true, apiKey: key, executorSnapshotPath, requireClaim: true }
    );
  }
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const checkpoints = [];

  for (const task of plan.tasks) {
    let checkpoint = await loadCheckpoint(task, request, storage);
    if (!checkpoint) {
      if (hadProviderExecution) {
        throw new Error(`BFL execution claim exists without checkpoint ${task.index}; paid recovery is ambiguous`);
      }
      checkpoint = baseCheckpoint(task, request);
      writeJsonAtomicAt(storage.checkpointRun.fd, task.checkpointName, checkpoint, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
    } else {
      checkpoint = { ...checkpoint, resumed: true };
    }
    assertResumableCheckpoint(checkpoint, task);
    checkpoints[task.index - 1] = checkpoint;
  }
  const hasProviderEvidence = checkpoints.some((checkpoint) => ["submitted", "downloaded"].includes(checkpoint.phase));
  if (!hadProviderExecution && hasProviderEvidence) {
    throw new Error("BFL submitted checkpoint evidence is missing its exact provider execution claim");
  }
  if (hadProviderExecution) {
    if (hasProviderEvidence) {
      recoveryOnly = true;
      await setInvocationLeaseMode(invocationOwner, request, "provider-zero-recovery");
    } else {
      // A provider execution claim cannot precede the durable prepared set and
      // the adapter cannot POST before it durably writes `submitting`. Thus an
      // exact all-prepared set proves the prior owner died after claim but
      // before any provider request, and the same unexpired approval may resume.
      await verifyBflConsumedApprovalForRequest(
        plan.jobDirectory,
        request.paidAuthorization,
        request,
        { now: new Date(), apiKey: key, executorSnapshotPath, requireClaim: true }
      );
      await setInvocationLeaseMode(invocationOwner, request, "paid-owner");
    }
  } else if (typeof runtime.afterPreparedCheckpoints === "function") {
    await runtime.afterPreparedCheckpoints({
      checkpoints: structuredClone(checkpoints),
      checkpointDirectory: plan.checkpointDirectory
    });
  }

  const segments = [];
  for (const [taskOffset, task] of plan.tasks.entries()) {
    if (Date.now() >= deadline) throw new Error("BFL generation timed out");
    let checkpoint = checkpoints[taskOffset];
    const existing = await completedCheckpointFile(checkpoint, task, storage, mediaBytes);
    if (existing) {
      segments.push(segmentFromCheckpoint(checkpoint, task, request));
      continue;
    }
    if (checkpoint.phase === "prepared") {
      // Budget policy gates only a new paid POST. A known submitted task has
      // already incurred its provider charge and must remain recoverable when
      // estimates or ceilings are tightened after submission.
      if (recoveryOnly) {
        throw new Error(`BFL provider-zero recovery stopped at prepared task ${task.index}; a new paid POST requires a new explicit approval`);
      }
      assertLiveBudget(plan.budget);
      assertBudgetBeforeSubmission(plan, checkpoints, taskOffset);
      if (!providerExecution) {
        await verifyBflConsumedApprovalForRequest(
          plan.jobDirectory,
          request.paidAuthorization,
          request,
          {
            now: new Date(),
            apiKey: key,
            executorSnapshotPath,
            requireClaim: true
          }
        );
        if (typeof options.beforeProviderExecutionClaim === "function") {
          await options.beforeProviderExecutionClaim({
            task: structuredClone(task),
            checkpoint: structuredClone(checkpoint)
          });
        }
        const claimAt = options.now();
        await verifyBflConsumedApprovalForRequest(
          plan.jobDirectory,
          request.paidAuthorization,
          request,
          { now: claimAt, apiKey: key, executorSnapshotPath, requireClaim: true }
        );
        providerExecution = await claimBflProviderExecution(
          plan.jobDirectory,
          request.paidAuthorization,
          request,
          { now: claimAt, allowCreate: true, allowExisting: true }
        );
        if (!providerExecution.created) {
          recoveryOnly = true;
          await setInvocationLeaseMode(invocationOwner, request, "provider-zero-recovery");
          await verifyBflConsumedApprovalForRequest(
            plan.jobDirectory,
            request.paidAuthorization,
            request,
            { historical: true, apiKey: key, executorSnapshotPath, requireClaim: true }
          );
          throw new Error(`BFL provider-zero recovery stopped at prepared task ${task.index}; a new paid POST requires a new explicit approval`);
        }
        if (typeof options.afterProviderExecutionClaim === "function") {
          await options.afterProviderExecutionClaim({
            task: structuredClone(task),
            checkpoint: structuredClone(checkpoint),
            executionClaim: structuredClone(providerExecution.claimReceipt)
          });
        }
        await setInvocationLeaseMode(invocationOwner, request, "paid-owner");
      }
      checkpoint = await submitTask(task, checkpoint, request, key, deadline, options);
      checkpoints[taskOffset] = checkpoint;
    }
    if (checkpoint.phase !== "submitted") throw new Error(`BFL task ${task.index} cannot resume from phase ${checkpoint.phase}`);
    const result = await pollTask(checkpoint, key, deadline, pollIntervalMs, options);
    const videoUrl = resultUrlFrom(result.response, key, env);
    assertClipPath(task.relativePath, plan.clipsDirectory);
    const file = await downloadVideo(videoUrl, task.outputName, Math.max(1, deadline - Date.now()), mediaBytes, options.fetchImpl, storage);
    const completed = {
      ...checkpoint,
      phase: "downloaded",
      bytes: file.bytes,
      sha256: file.sha256,
      responseId: taskIdFrom(result.response) || checkpoint.taskId,
      responseTimestamp: timestamp(result.response),
      responseStatus: statusFrom(result.response),
      pollCount: result.pollCount,
      completedAt: new Date().toISOString()
    };
    writeJsonAtomicAt(storage.checkpointRun.fd, task.checkpointName, completed, MAX_CHECKPOINT_BYTES, `BFL checkpoint ${task.index}`);
    checkpoints[taskOffset] = completed;
    segments.push(segmentFromCheckpoint(completed, task, request));
  }

  if (segments.length !== request.segments.length) throw new Error("BFL output count does not match request");
  if (!providerExecution?.claimReceipt) throw new Error("BFL completed output is missing its exact provider execution claim");
  const orderedSegments = segments.sort((left, right) => left.index - right.index);
  const taskIds = orderedSegments.map((segment) => segment.taskId);
  const providerReportedCredits = knownProviderCost(checkpoints);
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "completed",
    jobId: request.jobId,
    runId: request.runId,
    provider: "local-video",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    modelId: taskIds.length === 1 ? taskIds[0] : taskIds.join(","),
    taskIds,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    request: structuredClone(request),
    paidAuthorization: structuredClone(request.paidAuthorization),
    providerExecutionClaim: structuredClone(providerExecution.claimReceipt),
    createdAt: startedAt,
    completedAt,
    cost: {
      estimatedCredits: plan.budget.estimatedTotalCredits,
      estimatedUsd: plan.budget.estimatedTotalUsd,
      maxCredits: plan.budget.maxCredits,
      providerReportedCredits,
      providerReportedUsd: providerReportedCredits * CREDIT_USD,
      providerCostComplete: checkpoints.every((checkpoint) => Number.isFinite(checkpoint.providerCostCredits)),
      creditUsd: CREDIT_USD,
      ceilingBasis: "operator-supplied estimate; the BFL submit response reports cost only after submission"
    },
    tasks: orderedSegments.map((segment) => ({
      index: segment.index,
      taskId: segment.taskId,
      responseId: segment.responseId,
      pollingUrl: segment.pollingUrl,
      submittedAt: segment.submittedAt,
      submissionStartedAt: segment.submissionStartedAt,
      submissionResponseId: segment.submissionResponseId,
      submissionTimestamp: segment.submissionTimestamp,
      submissionStatus: segment.submissionStatus,
      responseTimestamp: segment.responseTimestamp,
      responseStatus: segment.responseStatus,
      completedAt: segment.completedAt,
      providerCostCredits: segment.providerCostCredits,
      estimatedCredits: segment.estimatedCredits,
      request: structuredClone(segment.submittedRequestBody),
      requestBodyHash: segment.submittedRequestBodyHash,
      submittedPromptHash: segment.submittedPromptHash,
      resumed: segment.resumed
    })),
    segments: orderedSegments,
    outputs: orderedSegments.map((segment) => segment.path)
  };
}

async function readStdinRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const input = Buffer.concat(chunks).toString("utf8");
  if (!input.trim()) throw new Error("stdin JSON request is required");
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("stdin did not contain valid JSON");
  }
}

function redactCompletedReceiptForOutput(receipt, apiKey) {
  const { request: exactRequest, paidAuthorization, providerExecutionClaim, ...providerDerived } = receipt;
  return {
    ...redactValue(providerDerived, apiKey),
    request: exactRequest,
    paidAuthorization,
    providerExecutionClaim
  };
}

async function main() {
  const request = validateRequest(await readStdinRequest());
  if (dryRunRequested(request)) {
    process.stdout.write(`${JSON.stringify(redactValue(dryRunReceipt(request), null))}\n`);
    return;
  }
  const apiKey = requiredString(process.env.BFL_API_KEY, "BFL_API_KEY");
  const receipt = await generate(request, apiKey);
  // request and paid attestations were validated against their canonical hashes
  // before the first POST. Preserve them byte-for-byte; only provider-derived
  // material is redacted recursively. This prevents harmless prompt/topic text
  // such as `token: stone` from breaking the parent's exact signed echo check.
  process.stdout.write(`${JSON.stringify(redactCompletedReceiptForOutput(receipt, apiKey))}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    const apiKey = process.env.BFL_API_KEY?.trim();
    process.stderr.write(`bfl-flux-video-generator: ${redactFreeText(error?.message || "unknown error", apiKey)}\n`);
    process.exitCode = 1;
  });
}

export {
  API_URL,
  GLOBAL_BFL_GUARD_HOST,
  GLOBAL_BFL_GUARD_PORT,
  MODEL,
  assertLiveBudget,
  budgetFor,
  dryRunReceipt,
  dryRunRequested,
  fetchBounded,
  generate,
  generationPlan,
  isOfficialDeliveryHostname,
  pollingUrlFrom,
  preflightBflStorage,
  readJsonResponse,
  readVideoResponse,
  redactCompletedReceiptForOutput,
  redactUrl,
  redactValue,
  resultUrlFrom,
  validateRequest
};
