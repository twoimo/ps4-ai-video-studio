#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const API_URL = "https://api.bfl.ai/v1/flux-3-video";
const API_BASE_URL = "https://api.bfl.ai";
const MODEL = "flux-3-video";
const MODEL_VERSION = "flux-3-video";
const MIN_DURATION_SEC = 5;
const MAX_DURATION_SEC = 20;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
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

function numberSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function redactedUrl(url, secret) {
  return secret && url.includes(secret) ? url.split(secret).join("[redacted]") : url;
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
  requiredString(jobId, "jobId");
  if (jobId === "." || jobId === ".." || jobId.includes("/") || jobId.includes("\\") || jobId.includes("..")) {
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

function resultUrlFrom(value) {
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
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BFL result contains an invalid video URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("BFL result video URL must use HTTP(S)");
  return parsed.href;
}

function pollingUrlFrom(value, taskId) {
  const supplied = firstString(value?.polling_url, value?.pollingUrl, value?.poll_url, value?.pollUrl);
  if (supplied) {
    let parsed;
    try {
      parsed = new URL(supplied, API_BASE_URL);
    } catch {
      throw new Error("BFL response contains an invalid polling URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("BFL polling URL must use HTTP(S)");
    return parsed.href;
  }
  if (!taskId) throw new Error("BFL response does not contain a task ID or polling URL");
  return `${API_BASE_URL}/v1/get_result?id=${encodeURIComponent(taskId)}`;
}

async function fetchBounded(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`BFL request timed out after ${timeoutMs}ms`);
    throw new Error(`BFL request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  if (!response || !response.ok) {
    const status = response?.status ?? "unknown";
    throw new Error(`BFL ${label} returned HTTP ${status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`BFL ${label} response could not be read: ${error.message}`);
  }
  if (!text.trim()) throw new Error(`BFL ${label} response was empty`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`BFL ${label} response was not valid JSON`);
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("stdin must contain one JSON object");
  assertSafeJobId(request.jobId);
  requiredString(request.runId, "runId");
  requiredString(request.requestHash, "requestHash");
  requiredString(request.scriptHash, "scriptHash");
  if (!Array.isArray(request.segments) || request.segments.length === 0) throw new Error("segments must be a non-empty array");
  for (const [index, segment] of request.segments.entries()) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error(`segment ${index + 1} is malformed`);
    const segmentIndex = Number(segment.index ?? index + 1);
    if (!Number.isInteger(segmentIndex) || segmentIndex !== index + 1) throw new Error("segments must have contiguous 1-based indices");
    requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`);
  }
}

async function pollTask(task, deadline, pollIntervalMs) {
  let latest = task.submission;
  let pollCount = 0;
  let firstPoll = true;
  while (true) {
    const status = statusFrom(latest);
    if (status === "error" || status === "failed") {
      throw new Error(`BFL task ${task.id} failed with status ${status}`);
    }
    if (status === "request moderated" || status === "content moderated") {
      throw new Error(`BFL task ${task.id} was moderated (${status})`);
    }
    if (["ready", "completed", "complete", "succeeded", "success"].includes(status || "")) {
      return { response: latest, pollCount };
    }
    if (status && !["pending", "processing", "queued", "submitted", "in_progress", "in-progress", "running", "reasoning", "generating"].includes(status)) {
      throw new Error(`BFL task ${task.id} returned unsupported status ${status}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`BFL task ${task.id} polling timed out`);
    if (!firstPoll) await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(pollIntervalMs, remaining)));
    firstPoll = false;
    const response = await fetchBounded(task.pollingUrl, {
      method: "GET",
      headers: { accept: "application/json", "x-key": task.apiKey }
    }, Math.max(1, deadline - Date.now()));
    latest = await readJsonResponse(response, "poll");
    if (!statusFrom(latest)) throw new Error(`BFL task ${task.id} poll result is missing status`);
    pollCount += 1;
  }
}

function contentTypeIsVideo(response) {
  const contentType = response?.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase();
  return Boolean(contentType && (contentType.startsWith("video/") || contentType === "application/octet-stream"));
}

async function downloadVideo(url, outputPath, timeoutMs) {
  const response = await fetchBounded(url, {}, timeoutMs);
  if (!response.ok) throw new Error(`video download returned HTTP ${response.status}`);
  if (!contentTypeIsVideo(response)) throw new Error("video download returned an invalid content type");
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`video download could not be read: ${error.message}`);
  }
  if (bytes.length === 0) throw new Error("video download was empty");
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(`video output could not be written: ${error.message}`);
  }
  return {
    bytes: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

async function generate(request, apiKey) {
  const timeoutMs = numberSetting(process.env.BFL_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS, 10, 60 * 60 * 1000);
  const pollIntervalMs = numberSetting(process.env.BFL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 10, 60_000);
  const jobDirectory = workingDirectoryFor(request);
  const clipsDirectory = join(jobDirectory, "clips");
  await mkdir(clipsDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const aspectRatio = request.format === "vertical" ? "9:16" : "16:9";
  const tasks = [];

  for (const [index, segment] of request.segments.entries()) {
    if (Date.now() >= deadline) throw new Error("BFL generation timed out");
    const prompt = requiredString(segment.prompt ?? segment.visualPrompt, `segments[${index + 1}].prompt`);
    const body = {
      mode: "t2v",
      prompt,
      aspect_ratio: aspectRatio,
      duration: durationFor(segment, request),
      resolution: "hd",
      generate_audio: false
    };
    const response = await fetchBounded(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-key": apiKey },
      body: JSON.stringify(body)
    }, Math.max(1, deadline - Date.now()));
    const submission = await readJsonResponse(response, "submit");
    const submissionStatus = statusFrom(submission);
    if (["error", "failed", "request moderated", "content moderated"].includes(submissionStatus || "")) {
      throw new Error(`BFL task submission failed with status ${submissionStatus}`);
    }
    const id = taskIdFrom(submission);
    if (!id) throw new Error("BFL submission did not contain a task ID");
    const pollingUrl = pollingUrlFrom(submission, id);
    tasks.push({
      id,
      pollingUrl,
      apiKey,
      index: index + 1,
      request: body,
      submission,
      submittedAt: new Date().toISOString()
    });
  }

  const segments = [];
  for (const task of tasks) {
    const result = await pollTask(task, deadline, pollIntervalMs);
    const videoUrl = resultUrlFrom(result.response);
    const relativePath = relativeClipPath(task.index);
    const outputPath = assertClipPath(relativePath, clipsDirectory);
    const file = await downloadVideo(videoUrl, outputPath, Math.max(1, deadline - Date.now()));
    const responseId = taskIdFrom(result.response) || task.id;
    const modelVersion = firstString(result.response?.model_version, result.response?.modelVersion, result.response?.version, task.submission?.model_version, task.submission?.modelVersion, task.submission?.version, MODEL_VERSION);
    segments.push({
      index: task.index,
      path: relativePath,
      output: relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
      taskId: task.id,
      responseId,
      pollingUrl: redactedUrl(task.pollingUrl, apiKey),
      submittedAt: task.submittedAt,
      submissionResponseId: taskIdFrom(task.submission),
      submissionTimestamp: timestamp(task.submission),
      submissionStatus: statusFrom(task.submission),
      responseTimestamp: timestamp(result.response),
      responseStatus: statusFrom(result.response),
      completedAt: new Date().toISOString(),
      modelVersion
    });
  }

  if (segments.length !== request.segments.length) throw new Error("BFL output count does not match request");
  const modelIds = tasks.map((task) => task.id).filter(Boolean);
  if (!modelIds.length) throw new Error("BFL response did not contain task IDs");
  const completedAt = new Date().toISOString();
  const modelVersion = firstString(...segments.map((segment) => segment.modelVersion), MODEL_VERSION);
  return {
    schemaVersion: 1,
    status: "completed",
    jobId: request.jobId,
    runId: request.runId,
    provider: "local-video",
    model: MODEL,
    modelVersion,
    modelId: modelIds.length === 1 ? modelIds[0] : modelIds.join(","),
    taskIds: modelIds,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    request,
    createdAt: startedAt,
    completedAt,
    tasks: segments.map((segment) => ({
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
      completedAt: segment.completedAt
    })),
    segments: segments.sort((left, right) => left.index - right.index),
    outputs: segments.sort((left, right) => left.index - right.index).map((segment) => segment.path)
  };
}

async function main() {
  const apiKey = process.env.BFL_API_KEY?.trim();
  if (!apiKey) throw new Error("BFL_API_KEY is required");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const input = Buffer.concat(chunks).toString("utf8");
  if (!input.trim()) throw new Error("stdin JSON request is required");
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    throw new Error("stdin did not contain valid JSON");
  }
  validateRequest(request);
  const receipt = await generate(request, apiKey);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`bfl-flux-video-generator: ${error.message}\n`);
  process.exitCode = 1;
});
