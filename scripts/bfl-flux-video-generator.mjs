#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.bfl.ai/v1/flux-3-video";
const API_BASE_URL = "https://api.bfl.ai";
const MODEL = "flux-3-video";
const MODEL_VERSION = "latest";
const MIN_DURATION_SEC = 5;
const MAX_DURATION_SEC = 20;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const CREDIT_USD = 0.01;
const CHECKPOINT_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
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

function redactValue(value, secret, seen = new WeakSet()) {
  if (typeof value === "string") return redactUrl(value, secret);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(item, secret, seen);
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
  if (explicit !== undefined) return assertSafeWorkingDirectory(explicit);
  assertSafeJobId(request.jobId);
  return resolve(import.meta.dirname, "..", "workspace", "jobs", request.jobId);
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
    requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`);
  }
  return request;
}

function requestBodiesFor(request, env = process.env) {
  const configuredResolution = request?.bfl?.resolution ?? env.BFL_VIDEO_RESOLUTION ?? "hd";
  if (!new Set(["hd", "fhd"]).has(configuredResolution)) throw new Error("BFL video resolution must be hd or fhd");
  const generateAudio = strictBoolean(request?.bfl?.generateAudio ?? env.BFL_GENERATE_AUDIO, false, "BFL_GENERATE_AUDIO");
  const safetyTolerance = boundedIntegerSetting(request?.bfl?.safetyTolerance ?? env.BFL_SAFETY_TOLERANCE, 2, 0, 4, "BFL_SAFETY_TOLERANCE");
  const aspectRatio = request.format === "vertical" ? "9:16" : "16:9";
  return request.segments.map((segment, index) => ({
    index: index + 1,
    body: {
      mode: "t2v",
      prompt: requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`),
      aspect_ratio: aspectRatio,
      duration: durationFor(segment, request),
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

function budgetFor(request, tasks, env = process.env) {
  const requestBudget = request.budget && typeof request.budget === "object" && !Array.isArray(request.budget) ? request.budget : {};
  const maxCredits = minimumConfiguredNumber([
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
  const directTotal = maximumConfiguredNumber([
    requestBudget.estimatedTotalCredits,
    request.estimatedCostCredits,
    env.BFL_ESTIMATED_TOTAL_CREDITS
  ], "BFL estimated total credits", { allowZero: true });
  const rateEstimates = tasks.map((task) => task.body.duration * perSecond + perRequest);
  const rateTotal = rateEstimates.reduce((sum, value) => sum + value, 0);
  const estimatedTotalCredits = Math.max(rateTotal, directTotal ?? 0);
  const totalDuration = tasks.reduce((sum, task) => sum + task.body.duration, 0);
  const taskEstimates = tasks.map((task, index) => {
    if (estimatedTotalCredits === rateTotal) return rateEstimates[index];
    const weight = totalDuration > 0 ? task.body.duration / totalDuration : 1 / tasks.length;
    return estimatedTotalCredits * weight;
  });
  return {
    maxCredits,
    estimatedTotalCredits,
    estimatedTotalUsd: estimatedTotalCredits * CREDIT_USD,
    creditUsd: CREDIT_USD,
    estimateBasis: {
      estimatedCreditsPerSecond: perSecond || null,
      estimatedCreditsPerRequest: perRequest || null,
      estimatedTotalCredits: directTotal
    },
    taskEstimates
  };
}

function assertLiveBudget(budget) {
  if (budget.maxCredits === null) {
    throw new Error("live BFL generation requires BFL_MAX_CREDITS or request.budget.maxCredits");
  }
  if (!(budget.estimatedTotalCredits > 0)) {
    throw new Error("live BFL generation requires BFL_ESTIMATED_TOTAL_CREDITS, BFL_ESTIMATED_CREDITS_PER_SECOND, BFL_ESTIMATED_CREDITS_PER_REQUEST, or the request budget equivalent");
  }
  if (budget.estimatedTotalCredits > budget.maxCredits) {
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
    return {
      ...task,
      relativePath,
      requestBodyHash: hashJson(task.body),
      estimatedCredits: 0
    };
  });
  const budget = budgetFor(request, tasks, env);
  tasks.forEach((task, index) => {
    task.estimatedCredits = budget.taskEstimates[index];
  });
  const jobDirectory = workingDirectoryFor(request);
  const checkpointDirectory = join(jobDirectory, ".bfl-flux-video", checkpointRunKey(request));
  return {
    endpoint: API_URL,
    method: "POST",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    concurrency: 1,
    jobDirectory,
    clipsDirectory: join(jobDirectory, "clips"),
    checkpointDirectory,
    budget: { ...budget, taskEstimates: undefined },
    tasks: tasks.map((task) => ({
      ...task,
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
        && plan.budget.estimatedTotalCredits > 0
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

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadCheckpoint(task, request) {
  let raw;
  try {
    raw = await readFile(task.checkpointPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`BFL checkpoint ${task.index} could not be read`);
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(raw);
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
    request: task.body,
    estimatedCredits: task.estimatedCredits,
    output: task.relativePath,
    phase: "prepared",
    preparedAt: new Date().toISOString()
  };
}

async function fetchBounded(url, options, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`BFL request timed out after ${timeoutMs}ms`);
    const detail = [error?.message, error?.cause?.message].filter(Boolean).join(" ");
    if (/redirect/iu.test(detail)) throw new Error("BFL request rejected redirect");
    throw new Error("BFL request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  if (response?.redirected || (response?.status >= 300 && response?.status < 400)) throw new Error(`BFL ${label} rejected redirect`);
  if (!response || !response.ok) {
    const status = response?.status ?? "unknown";
    throw new Error(`BFL ${label} returned HTTP ${status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new Error(`BFL ${label} response could not be read`);
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
  const attemptId = randomUUID();
  const submitting = {
    ...checkpoint,
    phase: "submitting",
    submissionAttemptId: attemptId,
    submissionStartedAt: new Date().toISOString(),
    lastError: undefined
  };
  await writeJsonAtomic(task.checkpointPath, submitting);
  let submission;
  try {
    const response = await fetchBounded(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-key": apiKey },
      body: JSON.stringify(task.body)
    }, Math.max(1, deadline - Date.now()), options.fetchImpl);
    submission = await readJsonResponse(response, "submit");
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
    await writeJsonAtomic(task.checkpointPath, submitted);
    return submitted;
  } catch (error) {
    const unknown = {
      ...submitting,
      phase: "submission_unknown",
      submissionOutcomeUnknownAt: new Date().toISOString(),
      lastError: redactValue(error?.message || "BFL submission outcome is unknown", apiKey)
    };
    await writeJsonAtomic(task.checkpointPath, unknown).catch(() => {});
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
    const response = await fetchBounded(checkpoint.pollingUrl, {
      method: "GET",
      headers: { accept: "application/json", "x-key": apiKey }
    }, Math.max(1, deadline - Date.now()), options.fetchImpl);
    latest = await readJsonResponse(response, "poll");
    pollCount += 1;
  }
}

function contentTypeIsVideo(response) {
  const contentType = response?.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase();
  return Boolean(contentType && (contentType.startsWith("video/") || contentType === "application/octet-stream"));
}

function maxMediaBytes(env = process.env) {
  return boundedIntegerSetting(env.BFL_MAX_MEDIA_BYTES, DEFAULT_MAX_MEDIA_BYTES, 1, MAX_MAX_MEDIA_BYTES, "BFL_MAX_MEDIA_BYTES");
}

async function writeChunk(fileHandle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await fileHandle.write(chunk, offset, chunk.length - offset);
    if (!result.bytesWritten) throw new Error("video output write made no progress");
    offset += result.bytesWritten;
  }
}

async function downloadVideo(url, outputPath, timeoutMs, maxBytes, fetchImpl) {
  const response = await fetchBounded(url, { headers: { accept: "video/*" } }, timeoutMs, fetchImpl);
  if (response?.redirected || (response?.status >= 300 && response?.status < 400)) throw new Error("video download rejected redirect");
  if (!response.ok) throw new Error(`video download returned HTTP ${response.status}`);
  if (!contentTypeIsVideo(response)) throw new Error("video download returned an invalid content type");
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) throw new Error("video download returned an invalid Content-Length");
    if (declaredLength > maxBytes) throw new Error(`video download exceeds maximum size of ${maxBytes} bytes`);
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let fileHandle;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("video download response body was unavailable");
    while (true) {
      const chunkResult = await reader.read();
      if (chunkResult.done) break;
      const chunkSize = Number(chunkResult.value?.byteLength);
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 0 || bytes + chunkSize > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`video download exceeds maximum size of ${maxBytes} bytes`);
      }
      const chunk = Buffer.from(chunkResult.value);
      bytes += chunk.length;
      hash.update(chunk);
      await writeChunk(fileHandle, chunk);
    }
    if (bytes === 0) throw new Error("video download was empty");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await rename(temporaryPath, outputPath);
    await syncDirectory(dirname(outputPath));
  } catch (error) {
    await fileHandle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (error?.message?.startsWith("video download")) throw error;
    throw new Error("video output could not be written");
  }
  return { bytes, sha256: `sha256:${hash.digest("hex")}` };
}

async function hashExistingFile(path) {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) return null;
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return { bytes: fileStat.size, sha256: `sha256:${hash.digest("hex")}` };
}

async function completedCheckpointFile(checkpoint, task, clipsDirectory) {
  if (checkpoint.phase !== "downloaded") return null;
  const outputPath = assertClipPath(task.relativePath, clipsDirectory);
  const actual = await hashExistingFile(outputPath);
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

function assertBudgetBeforeSubmission(plan, checkpoints, taskOffset) {
  const observed = knownProviderCost(checkpoints.slice(0, taskOffset));
  const remaining = remainingEstimatedCost(plan, checkpoints, taskOffset);
  if (observed + remaining > plan.budget.maxCredits) {
    throw new Error(`BFL budget guard stopped before task ${taskOffset + 1}: ${observed + remaining} projected credits exceeds the ${plan.budget.maxCredits}-credit ceiling`);
  }
}

function segmentFromCheckpoint(checkpoint, task) {
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
    submissionResponseId: checkpoint.taskId,
    submissionTimestamp: checkpoint.submissionTimestamp,
    submissionStatus: checkpoint.submissionStatus,
    responseTimestamp: checkpoint.responseTimestamp,
    responseStatus: checkpoint.responseStatus,
    completedAt: checkpoint.completedAt,
    modelVersion: MODEL_VERSION,
    providerCostCredits: checkpoint.providerCostCredits,
    estimatedCredits: task.estimatedCredits,
    resumed: Boolean(checkpoint.resumed)
  };
}

async function generate(request, apiKey, runtime = {}) {
  validateRequest(request);
  const key = requiredString(apiKey, "BFL_API_KEY");
  const env = runtime.env || process.env;
  const plan = generationPlan(request, env);
  assertLiveBudget(plan.budget);
  const timeoutMs = boundedIntegerSetting(env.BFL_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS, 10, 60 * 60 * 1000, "BFL_POLL_TIMEOUT_MS");
  const pollIntervalMs = boundedIntegerSetting(env.BFL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 10, 60_000, "BFL_POLL_INTERVAL_MS");
  const mediaBytes = maxMediaBytes(env);
  const options = {
    fetchImpl: runtime.fetchImpl || globalThis.fetch,
    sleep: runtime.sleep || ((duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration)))
  };
  await mkdir(plan.clipsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(plan.checkpointDirectory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const checkpoints = [];

  for (const task of plan.tasks) {
    let checkpoint = await loadCheckpoint(task, request);
    if (!checkpoint) {
      checkpoint = baseCheckpoint(task, request);
      await writeJsonAtomic(task.checkpointPath, checkpoint);
    } else {
      checkpoint = { ...checkpoint, resumed: true };
    }
    assertResumableCheckpoint(checkpoint, task);
    checkpoints[task.index - 1] = checkpoint;
  }

  const segments = [];
  for (const [taskOffset, task] of plan.tasks.entries()) {
    if (Date.now() >= deadline) throw new Error("BFL generation timed out");
    let checkpoint = checkpoints[taskOffset];
    const existing = await completedCheckpointFile(checkpoint, task, plan.clipsDirectory);
    if (existing) {
      segments.push(segmentFromCheckpoint(checkpoint, task));
      continue;
    }
    if (checkpoint.phase === "prepared") {
      assertBudgetBeforeSubmission(plan, checkpoints, taskOffset);
      checkpoint = await submitTask(task, checkpoint, request, key, deadline, options);
      checkpoints[taskOffset] = checkpoint;
    }
    if (checkpoint.phase !== "submitted") throw new Error(`BFL task ${task.index} cannot resume from phase ${checkpoint.phase}`);
    const result = await pollTask(checkpoint, key, deadline, pollIntervalMs, options);
    const videoUrl = resultUrlFrom(result.response, key, env);
    const outputPath = assertClipPath(task.relativePath, plan.clipsDirectory);
    const file = await downloadVideo(videoUrl, outputPath, Math.max(1, deadline - Date.now()), mediaBytes, options.fetchImpl);
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
    await writeJsonAtomic(task.checkpointPath, completed);
    checkpoints[taskOffset] = completed;
    segments.push(segmentFromCheckpoint(completed, task));
  }

  if (segments.length !== request.segments.length) throw new Error("BFL output count does not match request");
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
    request: redactValue(request, key),
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
      submissionResponseId: segment.submissionResponseId,
      submissionTimestamp: segment.submissionTimestamp,
      submissionStatus: segment.submissionStatus,
      responseTimestamp: segment.responseTimestamp,
      responseStatus: segment.responseStatus,
      completedAt: segment.completedAt,
      providerCostCredits: segment.providerCostCredits,
      estimatedCredits: segment.estimatedCredits,
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

async function main() {
  const request = validateRequest(await readStdinRequest());
  if (dryRunRequested(request)) {
    process.stdout.write(`${JSON.stringify(redactValue(dryRunReceipt(request), null))}\n`);
    return;
  }
  const apiKey = requiredString(process.env.BFL_API_KEY, "BFL_API_KEY");
  const receipt = await generate(request, apiKey);
  process.stdout.write(`${JSON.stringify(redactValue(receipt, apiKey))}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    const apiKey = process.env.BFL_API_KEY?.trim();
    process.stderr.write(`bfl-flux-video-generator: ${redactValue(error?.message || "unknown error", apiKey)}\n`);
    process.exitCode = 1;
  });
}

export {
  API_URL,
  MODEL,
  assertLiveBudget,
  budgetFor,
  dryRunReceipt,
  dryRunRequested,
  generate,
  generationPlan,
  isOfficialDeliveryHostname,
  pollingUrlFrom,
  redactUrl,
  redactValue,
  resultUrlFrom,
  validateRequest
};
