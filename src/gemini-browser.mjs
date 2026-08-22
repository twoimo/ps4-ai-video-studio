import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { JOBS_DIR, runBoundedRenderProcess } from "./pipeline.mjs";
import { closeFd, openDirectoryAt, openFileAt, readFdBuffer, sameFdIdentity, statFd } from "./dirfd.mjs";
import { hashFile } from "./run-ledger.mjs";
import { createGeminiFailureEvidence, verifyGeminiFailureEvidence } from "./gemini-error-safety.mjs";
import {
  canonicalGeminiObservedRuntimeProof,
  canonicalGeminiSessionBinding,
  geminiObservedRuntimeProofHash,
  geminiSessionBindingHash,
  validateGeminiObservedRuntimeProof
} from "./provenance.mjs";
import { buildGeminiClipPrompt, providerPromptBindingForSegment, providerRequestFieldsForSegment } from "./shot-patterns.mjs";
import {
  attestLegacyGeminiAbandonmentConsumption,
  preserveLegacyGeminiAbandonmentEvidence,
  readLegacyGeminiAbandonmentDecision,
  validateLegacyGeminiAbandonmentConsumption
} from "./gemini-legacy-abandonment.mjs";
export { buildGeminiClipPrompt } from "./shot-patterns.mjs";

const DEFAULT_CDP = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || join(process.env.HOME || "/tmp", ".ps4-ai-video-studio", "chrome-profile");
const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000;
const MIN_VIDEO_TIMEOUT_MS = 300_000;
const MAX_VIDEO_TIMEOUT_MS = 3_600_000;
const CONVERSATION_BINDING_TIMEOUT_MS = 30_000;
const CONVERSATION_BINDING_POLL_MS = 500;
const MIN_NEW_HEADLESS_CHROME_MAJOR = 109;
const CDP_VERSION_TIMEOUT_MS = 2_500;
const CDP_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHROME_LAUNCH_ATTEMPTS = 40;
const CHROME_LAUNCH_POLL_MS = 500;
const CHROME_TERMINATION_GRACE_MS = 1_000;
const CHROME_TERMINATION_KILL_MS = 2_000;
const GEMINI_FFPROBE_TIMEOUT_MS = 15_000;
const GEMINI_FFPROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const GEMINI_FFPROBE_ADMISSION_TIMEOUT_MS = 30_000;
export const GEMINI_MEDIA_MAX_BYTES = 70 * 1024 * 1024;
export const GEMINI_MEDIA_TRANSFER_CHUNK_BYTES = 256 * 1024;
const GEMINI_MEDIA_PULL_WAIT_MS = 5_000;
const GEMINI_MEDIA_MAX_URL_BYTES = 16 * 1024;

function geminiBrowserIso(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function geminiBrowserDeadlineError(deadlineMs) {
  const error = new Error(`Gemini browser runtime deadline에 도달했습니다. (${geminiBrowserIso(deadlineMs)})`);
  error.name = "GeminiBrowserDeadlineError";
  error.code = "GEMINI_BROWSER_DEADLINE";
  error.deadlineAt = geminiBrowserIso(deadlineMs);
  return error;
}

function geminiBrowserAbortError() {
  const error = new Error("Gemini browser 작업이 취소되었습니다.");
  error.name = "GeminiBrowserAbortError";
  error.code = "GEMINI_BROWSER_ABORTED";
  return error;
}

function geminiBrowserTimeoutError() {
  const error = new Error("Gemini browser 작업 시간이 초과되었습니다.");
  error.name = "GeminiBrowserTimeoutError";
  error.code = "GEMINI_BROWSER_TIMEOUT";
  return error;
}

export function isGeminiBrowserDeadlineError(error) {
  return error?.code === "GEMINI_BROWSER_DEADLINE";
}

export function isGeminiBrowserAbortError(error) {
  return error?.code === "GEMINI_BROWSER_ABORTED";
}

function isGeminiBrowserBoundaryError(error) {
  return isGeminiBrowserDeadlineError(error) || isGeminiBrowserAbortError(error);
}

function createGeminiBrowserRuntime(input = {}, overrides = {}) {
  const options = { ...input, ...overrides };
  const rawDeadline = options.deadlineMs ?? options.runtimeDeadlineMs ?? null;
  const deadlineMs = rawDeadline === null || rawDeadline === undefined ? null : Number(rawDeadline);
  if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || !geminiBrowserIso(deadlineMs))) {
    throw new TypeError("Gemini browser absolute deadline이 유효하지 않습니다.");
  }
  const signal = options.signal ?? null;
  if (signal !== null && (
    typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  )) throw new TypeError("Gemini browser AbortSignal이 유효하지 않습니다.");
  const now = options.now || Date.now;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const fetchFn = options.fetchFn || fetch;
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const spawnFn = options.spawnFn || spawn;
  const chromeBinaryFn = options.chromeBinaryFn || chromeBinary;
  const mkdirFn = options.mkdirFn || mkdir;
  const processKillFn = options.processKillFn || process.kill.bind(process);
  if (
    typeof now !== "function"
    || typeof setTimeoutFn !== "function"
    || typeof clearTimeoutFn !== "function"
    || typeof fetchFn !== "function"
    || typeof WebSocketImpl !== "function"
    || typeof spawnFn !== "function"
    || typeof chromeBinaryFn !== "function"
    || typeof mkdirFn !== "function"
    || typeof processKillFn !== "function"
  ) throw new TypeError("Gemini browser runtime dependency가 유효하지 않습니다.");
  const launchAttempts = options.chromeLaunchAttempts ?? CHROME_LAUNCH_ATTEMPTS;
  const launchPollMs = options.chromeLaunchPollMs ?? CHROME_LAUNCH_POLL_MS;
  const terminationGraceMs = options.chromeTerminationGraceMs ?? CHROME_TERMINATION_GRACE_MS;
  const terminationKillMs = options.chromeTerminationKillMs ?? CHROME_TERMINATION_KILL_MS;
  if (
    !Number.isSafeInteger(launchAttempts) || launchAttempts < 1 || launchAttempts > CHROME_LAUNCH_ATTEMPTS
    || !Number.isSafeInteger(launchPollMs) || launchPollMs < 1 || launchPollMs > CHROME_LAUNCH_POLL_MS
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > CHROME_TERMINATION_GRACE_MS
    || !Number.isSafeInteger(terminationKillMs) || terminationKillMs < 1 || terminationKillMs > CHROME_TERMINATION_KILL_MS
  ) throw new TypeError("Gemini Chrome lifecycle 경계가 유효하지 않습니다.");
  return {
    deadlineMs,
    signal,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    fetchFn,
    WebSocketImpl,
    spawnFn,
    chromeBinaryFn,
    mkdirFn,
    processKillFn,
    launchAttempts,
    launchPollMs,
    terminationGraceMs,
    terminationKillMs
  };
}

function runtimeNow(runtime) {
  const value = Number(runtime.now());
  if (!Number.isFinite(value) || !geminiBrowserIso(value)) throw new TypeError("Gemini browser clock이 유효하지 않습니다.");
  return value;
}

function normalizedCallerAbort(runtime) {
  if (
    runtime.deadlineMs !== null
    && (
      runtimeNow(runtime) >= runtime.deadlineMs
      || isGeminiBrowserDeadlineError(runtime.signal?.reason)
      || runtime.signal?.reason?.code === "MONITOR_RUNTIME_DEADLINE"
    )
  ) return geminiBrowserDeadlineError(runtime.deadlineMs);
  return geminiBrowserAbortError();
}

function currentGeminiBrowserBoundaryError(runtime) {
  if (runtime.deadlineMs !== null && runtimeNow(runtime) >= runtime.deadlineMs) {
    return geminiBrowserDeadlineError(runtime.deadlineMs);
  }
  if (runtime.signal?.aborted) return normalizedCallerAbort(runtime);
  return null;
}

function assertGeminiBrowserRuntimeActive(runtime) {
  const error = currentGeminiBrowserBoundaryError(runtime);
  if (error) throw error;
}

async function runWithinGeminiBrowserRuntime(operation, runtime, { timeoutMs = null } = {}) {
  if (typeof operation !== "function") throw new TypeError("Gemini browser bounded 작업 함수가 필요합니다.");
  const startedAt = runtimeNow(runtime);
  if (runtime.deadlineMs !== null && startedAt >= runtime.deadlineMs) {
    throw geminiBrowserDeadlineError(runtime.deadlineMs);
  }
  if (runtime.signal?.aborted) throw normalizedCallerAbort(runtime);
  const parsedTimeout = timeoutMs === null || timeoutMs === undefined ? null : Number(timeoutMs);
  if (parsedTimeout !== null && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
    throw new TypeError("Gemini browser local timeout이 유효하지 않습니다.");
  }

  const localDeadlineMs = parsedTimeout === null ? null : startedAt + parsedTimeout;
  const boundaryAt = runtime.deadlineMs === null
    ? localDeadlineMs
    : localDeadlineMs === null
      ? runtime.deadlineMs
      : Math.min(runtime.deadlineMs, localDeadlineMs);
  const deadlineWins = runtime.deadlineMs !== null && (localDeadlineMs === null || runtime.deadlineMs <= localDeadlineMs);
  const controller = new AbortController();
  let timerId = null;
  let settled = false;
  let rejectBoundary = null;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
  const rejectWith = (error) => {
    if (settled) return;
    controller.abort(error);
    rejectBoundary(error);
  };
  const scheduleBoundary = () => {
    if (boundaryAt === null || settled) return;
    const remainingMs = boundaryAt - runtimeNow(runtime);
    if (remainingMs > 0) {
      timerId = runtime.setTimeoutFn(scheduleBoundary, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      return;
    }
    rejectWith(deadlineWins ? geminiBrowserDeadlineError(runtime.deadlineMs) : geminiBrowserTimeoutError());
  };
  const forwardCallerAbort = () => rejectWith(normalizedCallerAbort(runtime));
  if (runtime.signal) runtime.signal.addEventListener("abort", forwardCallerAbort, { once: true });
  scheduleBoundary();

  try {
    const operationPromise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason || geminiBrowserAbortError();
      return operation(controller.signal);
    });
    const result = boundaryAt === null && !runtime.signal
      ? await operationPromise
      : await Promise.race([operationPromise, boundary]);
    assertGeminiBrowserRuntimeActive(runtime);
    return result;
  } catch (error) {
    const currentBoundaryError = currentGeminiBrowserBoundaryError(runtime);
    if (currentBoundaryError) throw currentBoundaryError;
    if (isGeminiBrowserDeadlineError(error)) {
      if (runtime.deadlineMs === null) throw error;
      throw geminiBrowserDeadlineError(runtime.deadlineMs);
    }
    if (isGeminiBrowserAbortError(error)) throw geminiBrowserAbortError();
    if (controller.signal.aborted) {
      if (isGeminiBrowserDeadlineError(controller.signal.reason)) throw geminiBrowserDeadlineError(runtime.deadlineMs);
      if (isGeminiBrowserAbortError(controller.signal.reason)) throw geminiBrowserAbortError();
      if (controller.signal.reason?.code === "GEMINI_BROWSER_TIMEOUT") throw geminiBrowserTimeoutError();
    }
    throw error;
  } finally {
    settled = true;
    if (timerId !== null) runtime.clearTimeoutFn(timerId);
    if (runtime.signal) runtime.signal.removeEventListener("abort", forwardCallerAbort);
  }
}

async function sleepWithinGeminiBrowserRuntime(ms, runtime) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs === 0) {
    if (runtime.deadlineMs !== null && runtimeNow(runtime) >= runtime.deadlineMs) {
      throw geminiBrowserDeadlineError(runtime.deadlineMs);
    }
    if (runtime.signal?.aborted) throw normalizedCallerAbort(runtime);
    return;
  }
  await runWithinGeminiBrowserRuntime((signal) => new Promise((resolveSleep, rejectSleep) => {
    let timer = null;
    const abortSleep = () => {
      if (timer !== null) runtime.clearTimeoutFn(timer);
      rejectSleep(signal.reason || geminiBrowserAbortError());
    };
    timer = runtime.setTimeoutFn(() => {
      signal.removeEventListener("abort", abortSleep);
      resolveSleep();
    }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    signal.addEventListener("abort", abortSleep, { once: true });
  }), runtime);
}

export function resolveGeminiVideoTimeoutMs(environment = process.env) {
  const raw = environment.GEMINI_VIDEO_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_VIDEO_TIMEOUT_MS;
  const normalized = String(raw).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("GEMINI_VIDEO_TIMEOUT_MS에는 밀리초 단위의 정수만 사용할 수 있습니다.");
  }
  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_VIDEO_TIMEOUT_MS || timeoutMs > MAX_VIDEO_TIMEOUT_MS) {
    throw new Error(`GEMINI_VIDEO_TIMEOUT_MS는 ${MIN_VIDEO_TIMEOUT_MS}~${MAX_VIDEO_TIMEOUT_MS} 사이여야 합니다.`);
  }
  return timeoutMs;
}

function browserConfig(input = {}) {
  const cdpUrl = String(input.cdpUrl || DEFAULT_CDP).replace(/\/$/, "");
  const profileDir = resolve(String(input.profileDir || PROFILE_DIR));
  const profileRoot = resolve(process.env.HOME || "/tmp", ".ps4-ai-video-studio");
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error("Gemini CDP 주소가 올바르지 않습니다.");
  }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new Error("Gemini CDP는 경로·인증 정보가 없는 로컬 HTTP origin만 사용할 수 있습니다.");
  }
  if (profileDir !== profileRoot && !profileDir.startsWith(`${profileRoot}/`)) {
    throw new Error("Gemini Chrome 프로필은 PS4 Studio 전용 프로필 디렉터리 안에 있어야 합니다.");
  }
  return {
    cdpUrl: parsed.origin,
    profileDir
  };
}

export function validatedGeminiBrowserWebSocketUrl(value, cdpUrl) {
  let parsed;
  let expected;
  try {
    parsed = new URL(String(value || ""));
    expected = new URL(String(cdpUrl || ""));
  } catch {
    throw new Error("Gemini CDP browser WebSocket 주소가 올바르지 않습니다.");
  }
  if (parsed.protocol !== "ws:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.port !== expected.port
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9._~-]{1,256}$/.test(parsed.pathname)) {
    throw new Error("Gemini CDP browser WebSocket은 같은 loopback port의 browser endpoint여야 합니다.");
  }
  return parsed.href;
}

export function configuredGeminiJobProfile() {
  const config = browserConfig();
  return { geminiCdpUrl: config.cdpUrl, geminiProfileDir: config.profileDir };
}
function optionalBoolean(value, name, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name}에는 1/0, true/false, yes/no 또는 on/off만 사용할 수 있습니다.`);
}

export function resolveGeminiChromeLaunchPolicy(environment = process.env) {
  const headless = optionalBoolean(environment.GEMINI_CHROME_HEADLESS, "GEMINI_CHROME_HEADLESS", true);
  const background = !headless && optionalBoolean(environment.GEMINI_CHROME_BACKGROUND, "GEMINI_CHROME_BACKGROUND", false);
  return {
    headless,
    background,
    mode: headless ? "headless" : background ? "background" : "visible",
    headlessImplementation: headless ? "new" : null
  };
}

export function assertGeminiGenerationLaunchPolicy(policy = resolveGeminiChromeLaunchPolicy()) {
  if (policy?.headless !== true || policy?.mode !== "headless" || policy?.headlessImplementation !== "new") {
    throw new Error("Gemini 영상 생성은 GEMINI_CHROME_HEADLESS=1의 --headless=new 전용 runtime에서만 허용됩니다. headed Chrome은 상태·로그인 확인에만 사용할 수 있습니다.");
  }
  return policy;
}

export function geminiChromeMajorVersion(version) {
  const match = `${version?.Browser || ""} ${version?.["User-Agent"] || ""}`.match(/(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function isHeadlessChromeVersion(version) {
  return /HeadlessChrome\//i.test(`${version?.Browser || ""} ${version?.["User-Agent"] || ""}`);
}

export function assertGeminiChromeRuntime(version, policy = resolveGeminiChromeLaunchPolicy()) {
  const chromeMajor = geminiChromeMajorVersion(version);
  if (!Number.isInteger(chromeMajor)) {
    throw new Error("연결된 CDP endpoint가 지원되는 Chrome/Chromium인지 확인할 수 없습니다.");
  }
  if (policy.headless && chromeMajor < MIN_NEW_HEADLESS_CHROME_MAJOR) {
    throw new Error(`새 Chrome 헤드리스 모드는 Chrome ${MIN_NEW_HEADLESS_CHROME_MAJOR} 이상이 필요합니다. 현재 감지 버전: ${chromeMajor}`);
  }
  const actualHeadless = isHeadlessChromeVersion(version);
  if (actualHeadless !== policy.headless) {
    const requested = policy.headless ? "headless" : policy.mode;
    const actual = actualHeadless ? "headless" : "headed";
    throw new Error(`Gemini Chrome 모드 불일치: ${requested}를 요청했지만 CDP 포트에는 ${actual} Chrome이 연결되어 있습니다. 전용 Chrome을 완전히 종료한 뒤 같은 프로필로 다시 시작하세요.`);
  }
  return { chromeMajor, actualHeadless, mode: policy.mode };
}

export function buildGeminiChromeLaunchArgs(input = {}, environment = process.env) {
  const config = browserConfig(input);
  const policy = resolveGeminiChromeLaunchPolicy(environment);
  const cdpPort = new URL(config.cdpUrl).port;
  const chromeArgs = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${config.profileDir}`,
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (policy.headless) chromeArgs.push("--headless=new", "--window-size=1440,1200");
  else if (policy.background) chromeArgs.push("--no-startup-window");
  chromeArgs.push("https://gemini.google.com/app");
  return chromeArgs;
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

function normalizedGeminiTargetId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

export function geminiTargetConversationLineage(targetId, conversationUrl) {
  const normalizedTarget = normalizedGeminiTargetId(targetId);
  const canonicalConversation = canonicalGeminiConversationUrl(conversationUrl);
  if (!normalizedTarget || !canonicalConversation) {
    throw new Error("완료 Gemini 클립의 target·conversation lineage를 정확히 결속할 수 없습니다.");
  }
  const lineage = {
    schemaVersion: 1,
    method: "privacy-safe-cdp-target-conversation-hashes",
    targetIdHash: hashJson({ type: "gemini-cdp-target-id", value: normalizedTarget }),
    conversationUrlHash: hashJson({ type: "gemini-canonical-conversation-url", value: canonicalConversation })
  };
  return { lineage, lineageHash: hashJson(lineage) };
}

function validGeminiTargetConversationLineage(segment) {
  const lineage = segment?.targetConversationLineage;
  return lineage?.schemaVersion === 1
    && lineage.method === "privacy-safe-cdp-target-conversation-hashes"
    && isSha256(lineage.targetIdHash)
    && isSha256(lineage.conversationUrlHash)
    && segment.targetConversationLineageHash === hashJson(lineage);
}

function validGenerationRuntimeAttestation(attestation, sessionJob) {
  return attestation?.type === "gemini-chrome-session"
    && attestation.provider === "gemini-browser"
    && hashJson(attestation.sessionBinding) === attestation.sessionBindingHash
    && attestation.persistentProfile === true
    && attestation.headless === true
    && attestation.headlessRequested === true
    && attestation.headlessImplementation === "new"
    && attestation.chromeMajor === attestation.runtimeProof?.chromeMajor
    && attestation.fallbackUsed === false
    && validateGeminiObservedRuntimeProof(attestation.runtimeProof, sessionJob)
    && attestation.runtimeProofHash === geminiObservedRuntimeProofHash(attestation.runtimeProof);
}

export function geminiSegmentSubmissionLineage(previousGeneration, providerRequestSentThisRun) {
  if (providerRequestSentThisRun === true) {
    return {
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null
    };
  }
  if (providerRequestSentThisRun !== false
    || !String(previousGeneration?.runId || "").trim()
    || previousGeneration?.provider !== "gemini-browser") {
    throw new Error("상속된 Gemini provider 제출의 직전 generation 결속을 확인할 수 없습니다.");
  }
  return {
    providerRequestSentThisRun: false,
    inheritedProviderSubmission: true,
    sourceRunId: previousGeneration.runId,
    sourceGenerationHash: hashJson(previousGeneration)
  };
}

function refreshGeminiSubmissionSummary(generation) {
  const segments = Array.isArray(generation?.segments) ? generation.segments : [];
  generation.providerRequestSentThisRun = segments.some((segment) => segment.providerRequestSentThisRun === true);
  generation.inheritedProviderSubmission = segments.some((segment) => (
    segment.submittedToProvider === true
    && segment.providerRequestSentThisRun === false
    && segment.inheritedProviderSubmission === true
  ));
  generation.submissionRunIds = [...new Set(segments.map((segment) => String(segment.submissionRunId || "").trim()).filter(Boolean))].sort();
  return generation;
}

function exactGeminiPromptText(value) {
  return String(value ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
}

export function canonicalGeminiEditorText(value) {
  return exactGeminiPromptText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

function editorNewlineCount(value) {
  return (exactGeminiPromptText(value).replace(/\r\n?/g, "\n").match(/\n/g) || []).length;
}

export function geminiPromptReadiness(prompt, observation = {}) {
  const expected = exactGeminiPromptText(prompt);
  const observed = observation.promptValue == null ? null : exactGeminiPromptText(observation.promptValue);
  const canonicalExpected = canonicalGeminiEditorText(expected);
  const canonicalObserved = observed == null ? null : canonicalGeminiEditorText(observed);
  const diagnostics = {
    promptFieldVisible: observation.promptFieldVisible === true,
    expectedLength: expected.length,
    observedLength: observed == null ? null : observed.length,
    expectedCanonicalLength: canonicalExpected.length,
    observedCanonicalLength: canonicalObserved == null ? null : canonicalObserved.length,
    expectedCanonicalHash: hashJson({ editorText: canonicalExpected }),
    observedCanonicalHash: canonicalObserved == null ? null : hashJson({ editorText: canonicalObserved }),
    expectedNewlineCount: editorNewlineCount(expected),
    observedNewlineCount: observed == null ? null : editorNewlineCount(observed)
  };
  return {
    ready: diagnostics.promptFieldVisible && canonicalObserved === canonicalExpected,
    diagnostics
  };
}

export async function waitForGeminiPromptReady({
  prompt,
  observe,
  sleepFn = sleep,
  maxPolls = 12,
  pollIntervalMs = 125
} = {}) {
  if (typeof observe !== "function" || typeof sleepFn !== "function") {
    throw new TypeError("Gemini prompt 준비 확인에는 observe와 sleepFn 함수가 필요합니다.");
  }
  const polls = Math.max(1, Number(maxPolls) || 1);
  let readiness = geminiPromptReadiness(prompt, {});
  for (let attempt = 0; attempt < polls; attempt += 1) {
    readiness = geminiPromptReadiness(prompt, await observe());
    if (readiness.ready) return { ...readiness, attempts: attempt + 1 };
    if (attempt + 1 < polls) await sleepFn(pollIntervalMs);
  }
  return { ...readiness, attempts: polls };
}

export function canonicalGeminiConversationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "gemini.google.com"
    || parsed.username
    || parsed.password
    || parsed.port
  ) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!/^\/app\/[^/?#]+$/i.test(path)) return null;
  return `https://gemini.google.com${path}`;
}

function strictGoogleusercontentMediaHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized.endsWith(".googleusercontent.com") || normalized.length > 253) return false;
  const labels = normalized.split(".");
  if (labels.length < 3 || labels.at(-2) !== "googleusercontent" || labels.at(-1) !== "com") return false;
  return labels.slice(0, -2).every((label) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
  ));
}

/**
 * Validate a media candidate before any page-context fetch. Gemini's own
 * same-origin URLs and Google-owned googleusercontent delivery hosts are the
 * only network destinations; broad *.google.com and arbitrary CDN hosts are
 * intentionally excluded. Blob URLs must be UUID objects created by the exact
 * Gemini origin, so an attacker-controlled blob/data/custom scheme is inert.
 */
export function validateGeminiMediaUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > GEMINI_MEDIA_MAX_URL_BYTES || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("Gemini media URL이 허용 경계를 벗어났습니다.");
  }
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw new Error("Gemini media URL이 올바르지 않습니다.");
  }
  if (parsed.protocol === "blob:") {
    if (
      parsed.origin !== "https://gemini.google.com"
      || !/^blob:https:\/\/gemini\.google\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(parsed.href)
    ) throw new Error("Gemini blob media URL이 exact Gemini origin UUID가 아닙니다.");
    return {
      url: parsed.href,
      kind: "blob",
      origin: "https://gemini.google.com",
      hostname: "gemini.google.com",
      credentials: "same-origin"
    };
  }
  if (
    parsed.protocol !== "https:"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash
    || (parsed.hostname !== "gemini.google.com" && !strictGoogleusercontentMediaHost(parsed.hostname))
  ) throw new Error("Gemini network media URL destination이 허용되지 않습니다.");
  return {
    url: parsed.href,
    kind: "https",
    origin: parsed.origin,
    hostname: parsed.hostname,
    credentials: parsed.origin === "https://gemini.google.com" ? "same-origin" : "omit"
  };
}

export function trustedGeminiMediaUrl(value) {
  try { return validateGeminiMediaUrl(value); } catch { return null; }
}

export function trustedGeminiMediaCandidateUrl(value, candidateKind) {
  if (!["video-src", "download-link"].includes(candidateKind)) return null;
  const policy = trustedGeminiMediaUrl(value);
  if (!policy) return null;
  // A provider-rendered anchor must not create a new credentialed same-origin
  // GET. Blob objects are inert local handles; network download links must use
  // the cookie-less Google media delivery origin. A <video> has already loaded
  // its currentSrc, so re-reading that exact source does not add a new origin.
  if (candidateKind === "download-link" && policy.kind === "https" && policy.origin === "https://gemini.google.com") return null;
  return policy;
}

export function selectGeminiRecoveryTarget(checkpoint = {}, targets = []) {
  const conversationUrl = canonicalGeminiConversationUrl(checkpoint.conversationUrl);
  const checkpointTargetId = String(checkpoint.targetId || "").trim();
  if (!checkpointTargetId) {
    return { status: "invalid-checkpoint", target: null, conversationUrl };
  }
  if (!conversationUrl) {
    const matches = (Array.isArray(targets) ? targets : []).filter((target) => (
      String(target?.type || "").toLowerCase() === "page"
      && String(target?.targetId || "") === checkpointTargetId
      && /^https:\/\/gemini\.google\.com\/(?:app(?:\/[^/?#]+)?|videos)(?:[?#]|$)/i.test(String(target?.url || ""))
    ));
    if (matches.length === 0) return { status: "missing", target: null, conversationUrl: null };
    if (matches.length !== 1) return { status: "ambiguous", target: null, conversationUrl: null, matchCount: matches.length };
    return { status: "exact-unbound", target: matches[0], conversationUrl: canonicalGeminiConversationUrl(matches[0].url) };
  }
  const matches = (Array.isArray(targets) ? targets : []).filter((target) => (
    String(target?.type || "").toLowerCase() === "page"
    && canonicalGeminiConversationUrl(target?.url) === conversationUrl
  ));
  if (matches.length === 0) return { status: "missing", target: null, conversationUrl };
  if (matches.length !== 1) return { status: "ambiguous", target: null, conversationUrl, matchCount: matches.length };
  const target = matches[0];
  if (String(target.targetId || "") !== checkpointTargetId) {
    return { status: "target-id-mismatch", target: null, conversationUrl };
  }
  return { status: "exact", target, conversationUrl };
}

export function geminiPendingRecoveryDecision(previousGeneration, current = {}) {
  const pending = previousGeneration?.pendingSegment;
  if (!pending) return { applicable: false, eligible: false, reason: "no-pending-checkpoint" };
  const semanticMatch = previousGeneration?.jobId === current.jobId
    && previousGeneration?.requestHash === current.requestHash
    && previousGeneration?.scriptHash === current.scriptHash
    && previousGeneration?.resumeRequestHash === current.resumeRequestHash
    && previousGeneration?.resumeScriptHash === current.resumeScriptHash;
  if (!semanticMatch) return { applicable: false, eligible: false, reason: "semantic-resume-mismatch" };
  const reject = (reason) => ({ applicable: true, eligible: false, reason });
  if (previousGeneration.schemaVersion !== 5 || previousGeneration.provider !== "gemini-browser") return reject("generation-receipt-version-invalid");
  if (!["running", "failed"].includes(previousGeneration.status)) return reject("generation-status-not-recoverable");
  if (hashJson(previousGeneration.sessionBinding) !== current.sessionBindingHash) return reject("session-receipt-integrity-mismatch");
  if (hashJson(previousGeneration.providerDecision) !== current.providerDecisionHash) return reject("provider-decision-receipt-integrity-mismatch");
  if (hashJson(previousGeneration.providerAttestation) !== current.providerAttestationHash) return reject("provider-attestation-receipt-integrity-mismatch");
  if (![1, 2].includes(pending.schemaVersion)) return reject("pending-checkpoint-version-invalid");
  if (!["submit-intent", "ambiguous-submitted", "submitted-awaiting-result"].includes(pending.status)) return reject("pending-status-not-recoverable");
  const intentOnly = pending.status === "submit-intent";
  if (intentOnly) {
    if (pending.schemaVersion !== 2 || pending.submissionMayHaveOccurred !== true || pending.submittedToProvider !== null) {
      return reject("submit-intent-marker-invalid");
    }
  } else if (pending.submittedToProvider !== true) return reject("provider-submission-marker-missing");
  if (!Number.isInteger(pending.index) || pending.index < 1 || pending.index !== current.index) return reject("segment-index-mismatch");
  if (!previousGeneration.runId || pending.runId !== previousGeneration.runId) return reject("run-binding-mismatch");
  if (!String(pending.submissionRunId || "").trim()) return reject("submission-run-binding-missing");
  if (!Array.isArray(previousGeneration.recoveryAttempts)) return reject("recovery-attempt-history-invalid");
  if (previousGeneration.recoveryAttempts.some((attempt, index) => (
    attempt?.attempt !== index + 1
    || attempt.submissionRunId !== pending.submissionRunId
    || !String(attempt.runId || "").trim()
    || !Number.isFinite(Date.parse(attempt.startedAt))
  ))) return reject("recovery-attempt-history-invalid");
  if (!previousGeneration.requestHash || pending.requestHash !== previousGeneration.requestHash) return reject("request-binding-mismatch");
  if (!previousGeneration.scriptHash || pending.scriptHash !== previousGeneration.scriptHash) return reject("script-binding-mismatch");
  if (pending.resumeRequestHash !== previousGeneration.resumeRequestHash || pending.resumeRequestHash !== current.resumeRequestHash) {
    return reject("resume-request-binding-mismatch");
  }
  if (pending.resumeScriptHash !== previousGeneration.resumeScriptHash || pending.resumeScriptHash !== current.resumeScriptHash) {
    return reject("resume-script-binding-mismatch");
  }
  if (!current.sessionBindingHash || previousGeneration.sessionBindingHash !== current.sessionBindingHash || pending.sessionBindingHash !== current.sessionBindingHash) {
    return reject("session-binding-mismatch");
  }
  if (!current.providerDecisionHash || previousGeneration.providerDecisionHash !== current.providerDecisionHash || pending.providerDecisionHash !== current.providerDecisionHash) {
    return reject("provider-decision-binding-mismatch");
  }
  if (!current.providerAttestationHash || previousGeneration.providerAttestationHash !== current.providerAttestationHash || pending.providerAttestationHash !== current.providerAttestationHash) {
    return reject("provider-attestation-binding-mismatch");
  }
  const prompt = String(current.prompt || "");
  if (!prompt || pending.prompt !== prompt || pending.promptHash !== hashJson({ prompt })) return reject("prompt-binding-mismatch");
  if (!isSha256(current.providerVisualPromptHash)
    || pending.providerVisualPromptHash !== current.providerVisualPromptHash
    || hashJson(pending.shotPattern ?? null) !== hashJson(current.shotPattern ?? null)) {
    return reject("provider-visual-prompt-binding-mismatch");
  }
  if (!intentOnly && (
    pending.submissionAcknowledgement?.verified !== true
    || (pending.schemaVersion === 2
      ? pending.submissionAcknowledgement?.clickCount !== 1
      : ![1, 2].includes(pending.submissionAcknowledgement?.clickCount))
    || !Array.isArray(pending.submissionAcknowledgement?.evidenceTypes)
    || pending.submissionAcknowledgement.evidenceTypes.length === 0
    || pending.submissionAcknowledgement.evidenceTypes.some((type) => !["user-message", "stop-response", "generation"].includes(type))
  )) return reject("submission-acknowledgement-missing");
  if (intentOnly && !validGeminiSubmissionBaseline(pending.submissionBaseline, prompt)) {
    return reject("submit-intent-baseline-invalid");
  }
  if (
    !(intentOnly ? Number.isFinite(Date.parse(pending.intentCreatedAt)) : Number.isFinite(Date.parse(pending.submittedAt)))
    || !Number.isInteger(pending.timeoutMs)
    || pending.timeoutMs < MIN_VIDEO_TIMEOUT_MS
    || pending.timeoutMs > MAX_VIDEO_TIMEOUT_MS
  ) return reject("pending-timing-checkpoint-invalid");
  if (!String(pending.targetId || "").trim() || String(pending.targetId).length > 256) {
    return reject("conversation-target-binding-missing");
  }
  if (pending.status === "submitted-awaiting-result" && !canonicalGeminiConversationUrl(pending.conversationUrl)) {
    return reject("conversation-target-binding-missing");
  }
  if (["submit-intent", "ambiguous-submitted"].includes(pending.status) && pending.conversationUrl !== null) return reject("ambiguous-conversation-binding-invalid");
  for (const key of ["videos", "links", "chats"]) {
    if (
      !Array.isArray(pending.knownMedia?.[key])
      || pending.knownMedia[key].length > 2_000
      || pending.knownMedia[key].some((value) => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value))
    ) {
      return reject("known-media-checkpoint-invalid");
    }
  }
  return {
    applicable: true,
    eligible: true,
    reason: intentOnly ? "exact-submit-intent-recovery" : "exact-pending-recovery",
    checkpoint: pending,
    conversationUrl: canonicalGeminiConversationUrl(pending.conversationUrl)
  };
}

export function geminiVideoQuotaMessage(value) {
  const body = String(value || "");
  const patterns = [
    /(?:지금은\s*)?동영상을 생성할 수 없습니다[^.。\n]{0,240}/i,
    /동영상을 다시 생성할 수 있습니다[^.。\n]{0,240}/i,
    /동영상[^.。\n]{0,48}(?:생성\s*)?(?:할당량|쿼터|한도)[^.。\n]{0,160}(?:소진|모두 사용|초과|도달|재설정|갱신|다시 생성)/i,
    /(?:할당량|쿼터|한도)[^.。\n]{0,48}동영상[^.。\n]{0,160}(?:소진|모두 사용|초과|도달|재설정|갱신|다시 생성)/i,
    /you(?:'|’)re out of videos[^.\n]{0,240}/i,
    /video generation (?:quota|limit)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i,
    /videos will be available again[^.\n]{0,240}/i,
    /(?:video generation|videos?)[^.\n]{0,80}(?:quota|usage limit|generation limit)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i,
    /(?:quota|usage limit|generation limit)[^.\n]{0,80}(?:video generation|videos?)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

export function geminiAspectRatioEvidence(format, evidence = {}) {
  const desiredRatio = format === "vertical" ? "portrait" : "landscape";
  const oppositeRatio = desiredRatio === "portrait" ? "landscape" : "portrait";
  const labelMatches = (value, ratio) => {
    const label = String(value || "").trim().toLowerCase();
    if (!label) return false;
    const selectionLabel = label.replace(/가로\s*[/·-]?\s*세로(?:\s*비율)?/g, " ");
    const portrait = /(?:\bportrait\b|세로(?:\s*모드)?|9\s*[:/x×]\s*16)/i.test(selectionLabel);
    const landscape = /(?:\blandscape\b|가로(?:\s*모드)?|16\s*[:/x×]\s*9)/i.test(selectionLabel);
    return ratio === "portrait" ? portrait && !landscape : landscape && !portrait;
  };
  const controlLabel = String(evidence.controlLabel || "").trim();
  const options = Array.isArray(evidence.options) ? evidence.options : [];
  const controlDesired = labelMatches(controlLabel, desiredRatio);
  const controlOpposite = labelMatches(controlLabel, oppositeRatio);
  const selectedDesired = options.some((option) => option?.selected === true && labelMatches(option.label, desiredRatio));
  const selectedOpposite = options.some((option) => option?.selected === true && labelMatches(option.label, oppositeRatio));
  const configured = !controlOpposite && !selectedOpposite && (controlDesired || selectedDesired);
  return {
    configured,
    desiredRatio,
    controlLabel: controlLabel || null,
    method: controlDesired ? "control-label" : selectedDesired ? "selected-state" : null,
    contradiction: controlOpposite || selectedOpposite
  };
}

function volatileGeminiScriptTimestamp(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "fetchedat"
    || normalized === "capturedat"
    || normalized === "captureat"
    || normalized === "capturetimestamp"
    || normalized === "capturedtimestamp"
    || normalized === "sourcesnapshotat";
}

export function canonicalGeminiResumeScript(value) {
  if (Array.isArray(value)) return value.map(canonicalGeminiResumeScript);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !volatileGeminiScriptTimestamp(key))
      .map(([key, nested]) => [key, canonicalGeminiResumeScript(nested)]));
  }
  return value;
}

export function canonicalGeminiResumeScriptHash(script) {
  return hashJson(canonicalGeminiResumeScript(script));
}

export function buildGeminiGenerationRequest(job, script) {
  return {
    provider: "gemini-browser",
    topic: job.topic || "",
    format: job.format || "vertical",
    clipCount: Number(job.clipCount || script?.segments?.length || 0),
    targetDurationSec: Number(job.targetDurationSec || 0),
    targetDurationRangeSec: job.targetDurationRangeSec || null,
    captions: job.captions !== false,
    voiceover: job.voiceover !== false,
    segments: (script?.segments || []).map((segment) => ({
      durationHint: segment.durationHint || null,
      visualPrompt: segment.visualPrompt || "",
      caption: segment.caption || "",
      narration: segment.narration || "",
      ...providerRequestFieldsForSegment(segment, "gemini-browser")
    }))
  };
}

let browserProcess = null;
let browserLaunch = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeVideoDimensions(filePath, dependencies = {}) {
  if (
    typeof filePath !== "string"
    || !filePath
    || filePath.length > 32_768
    || filePath.includes("\0")
  ) throw new TypeError("Gemini ffprobe 입력 경로가 올바르지 않습니다.");
  const runProcessFn = dependencies.runProcessFn || runBoundedRenderProcess;
  if (typeof runProcessFn !== "function") throw new TypeError("Gemini ffprobe bounded runner가 올바르지 않습니다.");
  const timeoutMs = dependencies.timeoutMs ?? GEMINI_FFPROBE_TIMEOUT_MS;
  const maximumOutputBytes = dependencies.maximumOutputBytes ?? GEMINI_FFPROBE_MAX_OUTPUT_BYTES;
  const admissionTimeoutMs = dependencies.admissionTimeoutMs ?? GEMINI_FFPROBE_ADMISSION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GEMINI_FFPROBE_TIMEOUT_MS
    || !Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1 || maximumOutputBytes > GEMINI_FFPROBE_MAX_OUTPUT_BYTES
    || !Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs < 1 || admissionTimeoutMs > GEMINI_FFPROBE_ADMISSION_TIMEOUT_MS
  ) throw new TypeError("Gemini ffprobe 실행 경계가 올바르지 않습니다.");
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    filePath
  ];
  let result;
  try {
    result = await runProcessFn("ffprobe", args, {
      timeoutMs,
      maximumOutputBytes,
      admissionTimeoutMs,
      stdoutMode: "text"
    });
  } catch {
    return null;
  }
  try {
    const stream = JSON.parse(result.stdout).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? { width, height }
      : null;
  } catch {
    return null;
  }
}

async function clipMatchesFormat(filePath, format) {
  const dimensions = await probeVideoDimensions(filePath);
  if (!dimensions) return false;
  const isVertical = dimensions.height > dimensions.width && dimensions.height / dimensions.width >= 1.4;
  return format === "vertical" ? isVertical : !isVertical;
}

async function getVersion(baseUrl = DEFAULT_CDP, runtime = createGeminiBrowserRuntime()) {
  return runWithinGeminiBrowserRuntime(async (signal) => {
    const response = await runtime.fetchFn(`${baseUrl.replace(/\/$/, "")}/json/version`, { signal });
    if (!response.ok) throw new Error(`Chrome DevTools 연결 실패 (${response.status})`);
    return response.json();
  }, runtime, { timeoutMs: CDP_VERSION_TIMEOUT_MS });
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BINARY,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  return candidates.find((path) => Bun.file(path).size > 0) || null;
}

function chromeProcessExited(child) {
  return !child || child.exitCode !== null && child.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function waitForChromeProcessExit(child, timeoutMs) {
  if (chromeProcessExited(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.("exit", onExit);
      child.off?.("close", onExit);
      child.off?.("error", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
    child.once?.("error", onExit);
    timer = setTimeout(() => finish(chromeProcessExited(child)), timeoutMs);
    timer.unref?.();
  });
}

function signalChromeProcessGroup(child, signal, runtime) {
  if (chromeProcessExited(child)) return;
  const pid = Number(child?.pid);
  let groupSignaled = false;
  if (
    (process.platform === "darwin" || process.platform === "linux")
    && Number.isSafeInteger(pid)
    && pid > 1
  ) {
    try {
      runtime.processKillFn(-pid, signal);
      groupSignaled = true;
    } catch {}
  }
  if (!groupSignaled) {
    try { child?.kill?.(signal); } catch {}
  }
}

async function terminateUnattestedChrome(child, runtime) {
  if (!child || chromeProcessExited(child)) return;
  signalChromeProcessGroup(child, "SIGTERM", runtime);
  if (await waitForChromeProcessExit(child, runtime.terminationGraceMs)) return;
  signalChromeProcessGroup(child, "SIGKILL", runtime);
  if (await waitForChromeProcessExit(child, runtime.terminationKillMs)) return;
  const error = new Error("실패한 Gemini Chrome process group 종료를 확인하지 못했습니다.");
  error.code = "GEMINI_CHROME_CLEANUP_TIMEOUT";
  throw error;
}

async function launchChromeSingleFlight(config, runtime, policy, binary, chromeArgs, launchKey) {
  let child = null;
  let spawnFailure = null;
  const recordSpawnFailure = () => { spawnFailure = true; };
  try {
    await runtime.mkdirFn(config.profileDir, { recursive: true });
    assertGeminiBrowserRuntimeActive(runtime);
    child = runtime.spawnFn(binary, chromeArgs, { detached: true, stdio: "ignore" });
    if (!child || !Number.isSafeInteger(Number(child.pid)) || Number(child.pid) <= 1) {
      throw new Error("Gemini Chrome process를 안전한 detached owner로 시작하지 못했습니다.");
    }
    if (browserLaunch?.key === launchKey) browserLaunch.child = child;
    child.once?.("error", recordSpawnFailure);
    const cdpPort = new URL(config.cdpUrl).port || "9222";
    for (let attempt = 0; attempt < runtime.launchAttempts; attempt += 1) {
      if (spawnFailure || chromeProcessExited(child)) {
        throw new Error("Gemini Chrome process가 CDP attestation 전에 종료됐습니다.");
      }
      let version;
      try {
        version = await getVersion(config.cdpUrl, runtime);
      } catch (error) {
        if (isGeminiBrowserBoundaryError(error)) throw error;
        if (attempt + 1 < runtime.launchAttempts) {
          await sleepWithinGeminiBrowserRuntime(runtime.launchPollMs, runtime);
        }
        continue;
      }
      assertGeminiChromeRuntime(version, policy);
      browserProcess = child;
      const publishedOwner = child;
      child.once?.("exit", () => {
        if (browserProcess === publishedOwner) browserProcess = null;
      });
      child.unref?.();
      return version;
    }
    throw new Error(`Chrome 원격 디버깅 포트(${cdpPort})를 열지 못했습니다.`);
  } catch (error) {
    try {
      await terminateUnattestedChrome(child, runtime);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Gemini Chrome 시작 실패 후 process group 정리를 완료하지 못했습니다.");
    }
    throw error;
  } finally {
    child?.off?.("error", recordSpawnFailure);
    if (browserLaunch?.key === launchKey && browserLaunch.child === child) browserLaunch.child = null;
  }
}

async function startChrome(input = {}, runtime = createGeminiBrowserRuntime(), policy = resolveGeminiChromeLaunchPolicy()) {
  const config = browserConfig(input);
  assertGeminiBrowserRuntimeActive(runtime);
  const binary = runtime.chromeBinaryFn();
  if (!binary) throw new Error("Google Chrome 또는 Chromium을 찾지 못했습니다.");
  const chromeArgs = buildGeminiChromeLaunchArgs(config);
  const launchKey = JSON.stringify({ cdpUrl: config.cdpUrl, profileDir: config.profileDir, binary, chromeArgs });
  if (browserLaunch) {
    if (browserLaunch.key !== launchKey) {
      throw new Error("다른 Gemini Chrome cold launch가 진행 중이어서 새 process를 시작하지 않습니다.");
    }
    return browserLaunch.promise;
  }
  if (browserProcess && !chromeProcessExited(browserProcess)) {
    throw new Error("게시된 Gemini Chrome owner가 실행 중이지만 CDP endpoint에 응답하지 않습니다. 새 process로 덮어쓰지 않습니다.");
  }
  if (browserProcess && chromeProcessExited(browserProcess)) browserProcess = null;
  const launch = {
    key: launchKey,
    child: null,
    promise: null
  };
  launch.promise = launchChromeSingleFlight(config, runtime, policy, binary, chromeArgs, launchKey);
  browserLaunch = launch;
  try {
    return await launch.promise;
  } finally {
    if (browserLaunch === launch) browserLaunch = null;
  }
}

export class CdpBrowser {
  constructor(version, baseUrl = DEFAULT_CDP, options = {}) {
    this.version = version;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.runtime = createGeminiBrowserRuntime(options);
    this.WebSocketImpl = this.runtime.WebSocketImpl;
    this.ws = null;
    this.messageListener = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
  }

  async connect(options = {}) {
    assertGeminiBrowserRuntimeActive(this.runtime);
    const webSocketUrl = validatedGeminiBrowserWebSocketUrl(this.version.webSocketDebuggerUrl, this.baseUrl);
    try {
      this.ws = new this.WebSocketImpl(webSocketUrl);
    } catch {
      throw new Error("Gemini Chrome DevTools 연결을 초기화하지 못했습니다.");
    }
    this.messageListener = (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      const request = this.pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(message.error.message || "Chrome DevTools 오류"));
      else request.resolve(message.result);
    };
    this.ws.addEventListener("message", this.messageListener);
    let resolveOpen;
    let rejectOpen;
    const opened = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const onOpen = () => resolveOpen();
    const onError = () => rejectOpen(new Error("Gemini Chrome DevTools 연결에 실패했습니다."));
    this.ws.addEventListener("open", onOpen, { once: true });
    this.ws.addEventListener("error", onError, { once: true });
    try {
      await runWithinGeminiBrowserRuntime(() => opened, this.runtime);
    } finally {
      this.ws.removeEventListener("open", onOpen);
      this.ws.removeEventListener("error", onError);
    }
    if (options.runtimeAttestation) {
      const commandLine = await this.command("Browser.getBrowserCommandLine");
      const browserVersion = await this.command("Browser.getVersion");
      this.runtimeProof = canonicalGeminiObservedRuntimeProof({
        job: {
          geminiCdpUrl: options.runtimeAttestation.cdpUrl,
          geminiProfileDir: options.runtimeAttestation.profileDir
        },
        version: browserVersion,
        commandLine
      });
      this.runtimeProofHash = geminiObservedRuntimeProofHash(this.runtimeProof);
      if (options.expectedRuntimeProofHash && this.runtimeProofHash !== options.expectedRuntimeProofHash) {
        throw new Error("Gemini Chrome runtime이 사전 관측 이후 변경되었습니다. target을 만들거나 요청을 전송하지 않습니다.");
      }
      if (options.attestationOnly === true) return this;
    }
    if (options.resumeTarget) {
      const listed = await this.command("Target.getTargets");
      const selection = selectGeminiRecoveryTarget(options.resumeTarget, listed.targetInfos || []);
      if (!["exact", "exact-unbound"].includes(selection.status)) {
        throw new Error(`Gemini 대기 결과의 기존 대화 탭을 안전하게 복구하지 못했습니다 (${selection.status}). 중복 생성을 막기 위해 새 요청을 전송하지 않습니다.`);
      }
      this.targetId = selection.target.targetId;
      this.recoveryTargetSelection = selection;
    } else {
      const created = await this.command("Target.createTarget", { url: "https://gemini.google.com/app", newWindow: true });
      this.targetId = created.targetId;
    }
    const attached = await this.command("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    const downloadPath = join(dirname(JOBS_DIR), "downloads");
    await this.runtime.mkdirFn(downloadPath, { recursive: true });
    await this.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
    await this.command("Page.enable", {}, true);
    await this.command("Runtime.enable", {}, true);
    await sleepWithinGeminiBrowserRuntime(1200, this.runtime);
    return this;
  }

  command(method, params = {}, session = false) {
    try {
      assertGeminiBrowserRuntimeActive(this.runtime);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.ws || this.ws.readyState !== (this.WebSocketImpl.OPEN ?? 1)) return Promise.reject(new Error("Chrome DevTools WebSocket가 닫혀 있습니다."));
    const id = this.nextId++;
    const message = { id, method, params };
    if (session && this.sessionId) message.sessionId = this.sessionId;
    return runWithinGeminiBrowserRuntime((signal) => new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abortCommand);
      };
      const settle = (callback) => (value) => {
        cleanup();
        callback(value);
      };
      const request = { resolve: settle(resolve), reject: settle(reject) };
      const abortCommand = () => request.reject(signal.reason || geminiBrowserAbortError());
      signal.addEventListener("abort", abortCommand, { once: true });
      this.pending.set(id, request);
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        request.reject(error);
      }
    }), this.runtime, { timeoutMs: CDP_COMMAND_TIMEOUT_MS });
  }

  commandForCleanup(method, params = {}) {
    if (!this.ws || this.ws.readyState !== (this.WebSocketImpl.OPEN ?? 1)) {
      return Promise.reject(new Error("Chrome DevTools WebSocket가 닫혀 있습니다."));
    }
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (callback) => (value) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        callback(value);
      };
      const request = { resolve: settle(resolve), reject: settle(reject) };
      this.pending.set(id, request);
      timer = setTimeout(() => request.reject(new Error("Gemini fresh target 정리 시간이 초과되었습니다.")), CDP_VERSION_TIMEOUT_MS);
      timer.unref?.();
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        request.reject(error);
      }
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true }, true);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Gemini 페이지 스크립트 오류");
    return result.result?.value;
  }

  async navigate(url) {
    await this.command("Page.navigate", { url }, true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ready = await this.evaluate("document.readyState === 'complete' || document.readyState === 'interactive'").catch((error) => {
        if (isGeminiBrowserBoundaryError(error)) throw error;
        return false;
      });
      if (ready) break;
      await sleepWithinGeminiBrowserRuntime(250, this.runtime);
    }
    await sleepWithinGeminiBrowserRuntime(2500, this.runtime);
  }

  async close(options = {}) {
    const preserveTarget = options.preserveTarget === true;
    const forceFreshTargetCleanup = options.forceFreshTargetCleanup === true && !preserveTarget;
    let targetClosed = false;
    let sessionDetached = false;
    let boundaryError = null;
    try {
      if (preserveTarget) {
        if (this.sessionId) {
          try {
            await this.command("Target.detachFromTarget", { sessionId: this.sessionId });
            sessionDetached = true;
          } catch (error) {
            if (isGeminiBrowserBoundaryError(error)) boundaryError = error;
          }
        }
      } else {
        if (this.targetId) {
          try {
            const result = forceFreshTargetCleanup
              ? await this.commandForCleanup("Target.closeTarget", { targetId: this.targetId })
              : await this.command("Target.closeTarget", { targetId: this.targetId });
            targetClosed = result?.success === true;
          } catch (error) {
            if (isGeminiBrowserBoundaryError(error)) boundaryError = error;
          }
        }
      }
    } finally {
      for (const request of [...this.pending.values()]) {
        request.reject(new Error("Chrome DevTools 세션이 닫혔습니다."));
      }
      this.pending.clear();
      if (this.ws && this.messageListener) this.ws.removeEventListener("message", this.messageListener);
      try { this.ws?.close(); } catch {}
    }
    boundaryError ||= currentGeminiBrowserBoundaryError(this.runtime);
    if (boundaryError) throw boundaryError;
    return { preserveTarget, targetClosed, sessionDetached, targetId: this.targetId || null };
  }
}

async function resolveBrowserVersion(input = {}, runtime = createGeminiBrowserRuntime(), policy = resolveGeminiChromeLaunchPolicy()) {
  const config = browserConfig(input);
  let version;
  try {
    version = await getVersion(config.cdpUrl, runtime);
  } catch (error) {
    if (isGeminiBrowserBoundaryError(error)) throw error;
    version = await startChrome(config, runtime, policy);
  }
  assertGeminiChromeRuntime(version, policy);
  return version;
}

export async function connectBrowser(input = {}, options = {}) {
  const config = browserConfig(input);
  const runtime = createGeminiBrowserRuntime(input, options);
  const policy = options.policy || resolveGeminiChromeLaunchPolicy();
  const version = options.version || await resolveBrowserVersion(config, runtime, policy);
  assertGeminiChromeRuntime(version, policy);
  const browser = new CdpBrowser(version, config.cdpUrl, runtime);
  try {
    await browser.connect({
      resumeTarget: options.resumeTarget || null,
      runtimeAttestation: options.runtimeAttestation === true ? config : null,
      expectedRuntimeProofHash: options.expectedRuntimeProofHash || null,
      attestationOnly: options.attestationOnly === true
    });
  } catch (error) {
    const preserveTarget = Boolean(options.resumeTarget);
    const closeError = await browser.close({
      preserveTarget,
      forceFreshTargetCleanup: !preserveTarget
    }).then(() => null, (caught) => caught);
    if (isGeminiBrowserBoundaryError(closeError)) throw closeError;
    throw error;
  }
  return browser;
}

async function observeGeminiGenerationRuntime(config, version, policy, options = {}) {
  const browser = await connectBrowser(config, {
    ...options,
    version,
    policy,
    runtimeAttestation: true,
    attestationOnly: true
  });
  try {
    return { proof: browser.runtimeProof, proofHash: browser.runtimeProofHash };
  } finally {
    await browser.close({ preserveTarget: true });
  }
}

async function clickVideoTool(browser, format = "vertical") {
  const desiredRatio = format === "vertical" ? "portrait" : "landscape";
  return browser.evaluate(`(async () => {
    const desiredRatio = ${JSON.stringify(desiredRatio)};
    const requestedFormat = desiredRatio === "portrait" ? "vertical" : "horizontal";
    const quotaMessageFor = ${geminiVideoQuotaMessage.toString()};
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const ratioLabel = (el) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(el));
    const ratioOptionElement = (el) => el.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(el.closest('[role="menu"],[role="listbox"]'));
    const findRatioControl = () => {
      const controls = [...document.querySelectorAll('button,[role="button"]')].filter((el) => visible(el) && !ratioOptionElement(el));
      return controls.find((el) => /aspect ratio|가로세로|화면비/i.test(text(el))) || controls.find(ratioLabel) || null;
    };
    const selected = (el) => {
      if (typeof el.checked === 'boolean' && el.checked === true) return true;
      return [el.getAttribute('aria-checked'), el.getAttribute('aria-selected'), el.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const readRatioEvidence = () => {
      const ratioControl = findRatioControl();
      const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
        .filter((el) => visible(el) && ratioLabel(el))
        .map((el) => ({ label: text(el), selected: selected(el) }));
      return ratioEvidenceFor(requestedFormat, { controlLabel: ratioControl ? text(ratioControl) : '', options });
    };
    const chooseRatio = async () => {
      let ratioControl = null;
      let verification = readRatioEvidence();
      if (verification.configured) return verification;
      for (let attempt = 0; attempt < 10 && !ratioControl; attempt += 1) {
        ratioControl = findRatioControl();
        if (!ratioControl) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ratioControl) return { ...verification, reason: 'ratio-control-missing' };
      ratioControl.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')].filter(visible);
      const option = options.find((el) => el !== ratioControl
        && ratioOptionElement(el)
        && ratioEvidenceFor(requestedFormat, { options: [{ label: text(el), selected: true }] }).configured);
      if (!option) return { ...verification, reason: 'ratio-option-missing' };
      option.click();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        verification = readRatioEvidence();
        if (verification.configured) return verification;
      }
      return { ...verification, reason: 'ratio-selection-unverified' };
    };
    let buttons = [];
    let body = "";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      body = (document.body?.innerText || "").slice(-6000);
      const quotaMessage = quotaMessageFor(body);
      if (quotaMessage) return { clicked: false, quota: true, quotaMessage, body };
      buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible);
      const signIn = buttons.find((el) => /로그인|sign in/i.test(text(el)) && /accounts\.google\.com/i.test(el.href || el.closest('a')?.href || ''));
      if (signIn) return { clicked: false, authRequired: true };
      const fields = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
      if (/동영상 만들기|create videos?/i.test(body) && fields.length) {
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: "prompt-ready", ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const tryIt = buttons.find((el) => /사용해 보기|try it|create videos?/i.test(text(el)));
      if (tryIt) {
        tryIt.click();
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const after = (document.body?.innerText || "").slice(-6000);
        const afterQuotaMessage = quotaMessageFor(after);
        if (afterQuotaMessage) return { clicked: false, quota: true, quotaMessage: afterQuotaMessage, body: after };
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: text(tryIt), ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const video = buttons.find((el) => /동영상 만들기|create videos?/i.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
      if (video) {
        video.click();
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: text(video), ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const tools = buttons.find((el) => /도구|tools|더보기|more|모드/.test(text(el)));
      if (tools) {
        tools.click();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const menu = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible).find((el) => /동영상 만들기|create videos?|video/.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
        if (menu) {
          menu.click();
          const ratioVerification = await chooseRatio();
          return { clicked: true, label: text(menu), ratioConfigured: ratioVerification.configured === true, ratioVerification };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { clicked: false, buttons: buttons.map(text).filter(Boolean).slice(-40), body };
  })()`);
}

async function verifyVideoAspectRatio(browser, format = "vertical") {
  return browser.evaluate(`(() => {
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const ratioLabel = (el) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(el));
    const ratioOptionElement = (el) => el.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(el.closest('[role="menu"],[role="listbox"]'));
    const selected = (el) => {
      if (typeof el.checked === 'boolean' && el.checked === true) return true;
      return [el.getAttribute('aria-checked'), el.getAttribute('aria-selected'), el.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const controls = [...document.querySelectorAll('button,[role="button"]')].filter((el) => visible(el) && !ratioOptionElement(el));
    const ratioControl = controls.find((el) => /aspect ratio|가로세로|화면비/i.test(text(el))) || controls.find(ratioLabel) || null;
    const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
      .filter((el) => visible(el) && ratioLabel(el))
      .map((el) => ({ label: text(el), selected: selected(el) }));
    return ratioEvidenceFor(${JSON.stringify(format)}, { controlLabel: ratioControl ? text(ratioControl) : '', options });
  })()`);
}

export function geminiPromptSubmissionDomState(prompt, root, currentHref = "") {
  const exactEditorText = (value) => String(value ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
  const canonicalEditorText = (value) => exactEditorText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
  const expectedPrompt = exactEditorText(prompt);
  const canonicalExpectedPrompt = canonicalEditorText(expectedPrompt);
  const query = (selector) => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const visible = (element) => {
    const rect = element?.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const labels = (element) => [
    element?.innerText,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title")
  ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
  const disabled = (element) => Boolean(
    element?.disabled
    || /^(?:true|disabled)$/i.test(element?.getAttribute?.("aria-disabled") || "")
    || /^(?:disabled)$/i.test(element?.getAttribute?.("data-state") || "")
  );
  const fields = query('textarea,[contenteditable="true"],[role="textbox"]')
    .filter(visible)
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
  const field = fields[0] || null;
  const promptValue = field
    ? exactEditorText(field.tagName === "TEXTAREA" || field.tagName === "INPUT" ? field.value || "" : field.innerText ?? field.textContent ?? "")
    : null;
  const buttons = query('button,[role="button"]').filter(visible);
  const send = buttons.find(exactSendLabel) || null;
  const stopResponseCount = buttons.filter((element) => labels(element).some((value) => /^(?:stop response|stop generating|응답 중지|생성 중지)(?: button| 버튼)?$/i.test(value))).length;
  const userMessageNodes = query([
    "user-query",
    '[data-message-author-role="user"]',
    '[data-test-id*="user-query"]',
    '[data-testid*="user-query"]',
    '[class*="user-query"]',
    '[class*="user-message"]',
    '[class*="query-content"]'
  ].join(","));
  const userMessageMatchCount = userMessageNodes.filter((element) => {
    if (!visible(element) || element === field || element.contains?.(field)) return false;
    const value = exactEditorText(element.innerText ?? element.textContent ?? "");
    return canonicalEditorText(value) === canonicalExpectedPrompt;
  }).length;
  const generationNodes = query([
    "model-response",
    '[data-test-id*="model-response"]',
    '[data-testid*="model-response"]',
    '[class*="model-response"]',
    '[role="progressbar"]',
    '[aria-busy="true"]',
    "video",
    'a[href*="download"]',
    'a[href$=".mp4"]'
  ].join(",")).filter(visible);
  const generationEvidenceKeys = generationNodes.map((element, index) => {
    const href = element.href || element.getAttribute?.("href") || "";
    const source = element.currentSrc || element.src || element.getAttribute?.("src") || "";
    const label = labels(element).join(" ").slice(0, 160);
    return `${String(element.tagName || "node").toLowerCase()}:${href || source || label || index}`;
  });
  const conversationUrl = /gemini\.google\.com\/app\/[^/?#]+/i.test(String(currentHref)) ? String(currentHref) : null;
  return {
    promptFieldVisible: Boolean(field),
    promptValue,
    promptMatchesExpected: Boolean(field) && canonicalEditorText(promptValue) === canonicalExpectedPrompt,
    sendPresent: Boolean(send),
    sendEnabled: Boolean(send && !disabled(send)),
    sendLabel: send ? labels(send).join(" ") : null,
    userMessageMatchCount,
    stopResponseCount,
    generationEvidenceCount: generationNodes.length,
    generationEvidenceKeys,
    conversationUrl
  };
}

export function geminiPromptSubmissionEvidence(prompt, baseline = {}, observation = {}) {
  const canonicalEditorText = (value) => String(value ?? "")
    .replace(/[\u200B\uFEFF]/g, "")
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
  const expectedPrompt = canonicalEditorText(prompt);
  const baselineKeys = new Set(Array.isArray(baseline.generationEvidenceKeys) ? baseline.generationEvidenceKeys : []);
  const currentKeys = Array.isArray(observation.generationEvidenceKeys) ? observation.generationEvidenceKeys : [];
  const userMessageAppeared = Number(observation.userMessageMatchCount || 0) > Number(baseline.userMessageMatchCount || 0);
  const stopResponseAppeared = Number(observation.stopResponseCount || 0) > Number(baseline.stopResponseCount || 0);
  const generationEvidenceAppeared = Number(observation.generationEvidenceCount || 0) > Number(baseline.generationEvidenceCount || 0)
    || currentKeys.some((key) => !baselineKeys.has(key))
    || Boolean(observation.conversationUrl && observation.conversationUrl !== baseline.conversationUrl);
  const evidenceTypes = [
    userMessageAppeared ? "user-message" : null,
    stopResponseAppeared ? "stop-response" : null,
    generationEvidenceAppeared ? "generation" : null
  ].filter(Boolean);
  const observedPrompt = canonicalEditorText(observation.promptValue);
  const promptCleared = observation.promptFieldVisible === true && observedPrompt === "";
  const exactPromptRetained = observation.promptFieldVisible === true && observedPrompt === expectedPrompt;
  return {
    verified: promptCleared && evidenceTypes.length > 0,
    promptCleared,
    exactPromptRetained,
    hasNewEvidence: evidenceTypes.length > 0,
    evidenceTypes,
    sendEnabled: observation.sendEnabled === true
  };
}

function submissionEvidenceKeyHash(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ""))
    ? String(value).toLowerCase()
    : hashJson({ type: "gemini-submission-evidence-key", value: String(value || "") });
}

export function createGeminiSubmissionBaseline(prompt, observation = {}, capturedAt = new Date().toISOString()) {
  const rawPrompt = String(prompt ?? "");
  if (!exactGeminiPromptText(rawPrompt) || !geminiPromptReadiness(rawPrompt, observation).ready) {
    throw new Error("Gemini submit intent에는 전송 직전의 정확한 prompt 상태가 필요합니다.");
  }
  const payload = {
    schemaVersion: 1,
    capturedAt,
    promptHash: hashJson({ prompt: rawPrompt }),
    promptFieldVisible: true,
    sendEnabled: observation.sendEnabled === true,
    userMessageMatchCount: Math.max(0, Number(observation.userMessageMatchCount) || 0),
    stopResponseCount: Math.max(0, Number(observation.stopResponseCount) || 0),
    generationEvidenceCount: Math.max(0, Number(observation.generationEvidenceCount) || 0),
    generationEvidenceKeys: [...new Set((observation.generationEvidenceKeys || []).map(submissionEvidenceKeyHash))].sort(),
    conversationUrl: canonicalGeminiConversationUrl(observation.conversationUrl)
  };
  return { ...payload, baselineHash: hashJson(payload) };
}

function validGeminiSubmissionBaseline(baseline, prompt) {
  if (!baseline || baseline.schemaVersion !== 1 || !Number.isFinite(Date.parse(baseline.capturedAt))) return false;
  const { baselineHash, ...payload } = baseline;
  if (baselineHash !== hashJson(payload) || baseline.promptHash !== hashJson({ prompt: String(prompt ?? "") })) return false;
  if (baseline.promptFieldVisible !== true || baseline.sendEnabled !== true) return false;
  if (!["userMessageMatchCount", "stopResponseCount", "generationEvidenceCount"].every((key) => Number.isInteger(baseline[key]) && baseline[key] >= 0)) return false;
  if (!Array.isArray(baseline.generationEvidenceKeys)
    || baseline.generationEvidenceKeys.some((key) => !/^sha256:[a-f0-9]{64}$/.test(key))) return false;
  return baseline.conversationUrl === null || Boolean(canonicalGeminiConversationUrl(baseline.conversationUrl));
}

export function inspectGeminiSubmitIntent(checkpoint, prompt, observation = {}) {
  if (checkpoint?.status !== "submit-intent" || !validGeminiSubmissionBaseline(checkpoint.submissionBaseline, prompt)) {
    return { promotable: false, reason: "submit-intent-invalid", evidence: null };
  }
  const baseline = checkpoint.submissionBaseline;
  const normalizedObservation = {
    ...observation,
    generationEvidenceKeys: (observation.generationEvidenceKeys || []).map(submissionEvidenceKeyHash),
    conversationUrl: canonicalGeminiConversationUrl(observation.conversationUrl)
  };
  const evidence = geminiPromptSubmissionEvidence(prompt, {
    promptFieldVisible: true,
    promptValue: prompt,
    sendEnabled: baseline.sendEnabled,
    userMessageMatchCount: baseline.userMessageMatchCount,
    stopResponseCount: baseline.stopResponseCount,
    generationEvidenceCount: baseline.generationEvidenceCount,
    generationEvidenceKeys: baseline.generationEvidenceKeys,
    conversationUrl: baseline.conversationUrl
  }, normalizedObservation);
  return evidence.verified
    ? { promotable: true, reason: "strong-post-click-evidence", evidence }
    : { promotable: false, reason: "post-click-outcome-ambiguous", evidence };
}

export function geminiPromptRetryDecision(prompt, format, baseline = {}, observation = {}, ratioEvidence = {}) {
  const submission = geminiPromptSubmissionEvidence(prompt, baseline, observation);
  if (submission.hasNewEvidence) return { eligible: false, reason: "submission-evidence-observed", submission };
  if (!submission.exactPromptRetained) return { eligible: false, reason: "exact-prompt-not-retained", submission };
  if (!submission.sendEnabled) return { eligible: false, reason: "send-control-not-enabled", submission };
  if (ratioEvidence.configured !== true || ratioEvidence.contradiction === true) {
    return {
      eligible: false,
      reason: `${format === "vertical" ? "portrait" : "landscape"}-ratio-unverified`,
      submission
    };
  }
  return { eligible: true, reason: "safe-bounded-retry", submission };
}

export async function confirmGeminiPromptSubmission({
  prompt,
  format = "vertical",
  observe,
  initialClick,
  retryClick,
  sleepFn = sleep,
  pollsPerWindow = 32,
  pollIntervalMs = 250,
  maxClickAttempts = 2,
  onVerified = null,
  onBeforeInitialClick = null
}) {
  if (typeof observe !== "function" || typeof initialClick !== "function" || typeof retryClick !== "function") {
    throw new TypeError("Gemini 제출 확인에는 observe, initialClick, retryClick 함수가 필요합니다.");
  }
  const baseline = await observe();
  const readiness = geminiPromptReadiness(prompt, baseline);
  if (!readiness.ready) {
    return { submitted: false, reason: "exact-prompt-not-ready", clickCount: 0, diagnostics: readiness.diagnostics };
  }
  if (typeof onBeforeInitialClick === "function") await onBeforeInitialClick(baseline);
  const firstClick = await initialClick();
  if (firstClick?.clicked !== true) {
    return { submitted: false, reason: firstClick?.reason || "initial-submit-control-unavailable", clickCount: 0, baseline, click: firstClick || null };
  }

  let clickCount = 1;
  let evidenceObserved = false;
  const evidenceTypes = new Set();
  let lastObservation = baseline;
  let lastSubmission = geminiPromptSubmissionEvidence(prompt, baseline, baseline);
  const windows = Math.max(1, Number(maxClickAttempts) || 1);
  const polls = Math.max(1, Number(pollsPerWindow) || 1);

  for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
    for (let pollIndex = 0; pollIndex < polls; pollIndex += 1) {
      lastObservation = await observe();
      lastSubmission = geminiPromptSubmissionEvidence(prompt, baseline, lastObservation);
      for (const type of lastSubmission.evidenceTypes) evidenceTypes.add(type);
      evidenceObserved ||= lastSubmission.hasNewEvidence;
      if (lastSubmission.promptCleared && evidenceObserved) {
        const result = {
          submitted: true,
          verified: true,
          method: firstClick.method || "button",
          clickCount,
          evidenceTypes: [...evidenceTypes],
          observation: lastObservation
        };
        if (typeof onVerified === "function") await onVerified(result);
        return result;
      }
      if (pollIndex + 1 < polls) await sleepFn(pollIntervalMs);
    }

    if (evidenceObserved) {
      if (windowIndex + 1 < windows) continue;
      break;
    }
    if (clickCount >= windows) break;
    const retry = await retryClick({ baseline, observation: lastObservation, clickCount });
    if (retry?.evidence?.hasNewEvidence) {
      for (const type of retry.evidence.evidenceTypes || []) evidenceTypes.add(type);
      evidenceObserved = true;
      lastObservation = retry.observation || lastObservation;
      continue;
    }
    if (retry?.clicked !== true) {
      return {
        submitted: false,
        reason: retry?.reason || "bounded-retry-rejected",
        clickCount,
        evidenceTypes: [...evidenceTypes],
        observation: retry?.observation || lastObservation
      };
    }
    clickCount += 1;
  }

  return {
    submitted: false,
    reason: evidenceObserved
      ? "submission-evidence-without-cleared-input"
      : lastSubmission.promptCleared
        ? "prompt-cleared-without-submission-evidence"
        : "submission-unverified",
    clickCount,
    evidenceTypes: [...evidenceTypes],
    observation: lastObservation
  };
}

async function fillPrompt(browser, prompt) {
  const prepared = await browser.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const fields = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
    const field = fields.sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0];
    if (!field) return { filled: false, fields: 0 };
    field.focus();
    if (field.tagName === 'TEXTAREA') {
      field.select();
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return { filled: true, tag: field.tagName };
  })()`);
  if (!prepared?.filled) return prepared || { filled: false, fields: 0 };
  try {
    await browser.command("Input.insertText", { text: String(prompt) }, true);
  } catch {
    const value = JSON.stringify(String(prompt));
    await browser.evaluate(`(() => {
      const field = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!field) return false;
      if (field.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter ? setter.call(field, ${value}) : field.value = ${value};
      } else {
        field.textContent = ${value};
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
      return true;
    })()`);
  }
  const readiness = await waitForGeminiPromptReady({
    prompt,
    observe: () => inspectPromptSubmission(browser, prompt)
  });
  return {
    ...prepared,
    promptReady: readiness.ready,
    reason: readiness.ready ? "exact-prompt-ready" : "exact-prompt-not-ready",
    attempts: readiness.attempts,
    diagnostics: readiness.diagnostics
  };
}

async function inspectPromptSubmission(browser, prompt) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    return stateFor(${JSON.stringify(String(prompt))}, document, location.href);
  })()`);
}

async function clickPromptSubmit(browser, prompt) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    const expectedPrompt = ${JSON.stringify(String(prompt))};
    const observation = stateFor(expectedPrompt, document, location.href);
    if (!observation.promptFieldVisible || observation.promptMatchesExpected !== true) {
      return { clicked: false, reason: 'exact-prompt-not-ready', observation };
    }
    if (!observation.sendEnabled) {
      return { clicked: false, reason: observation.sendPresent ? 'send-control-disabled' : 'send-control-missing', observation };
    }
    const visible = (element) => { const rect = element?.getBoundingClientRect?.(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
    const labels = (element) => [element?.innerText, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
    const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
    const send = [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(exactSendLabel);
    if (!send) return { clicked: false, reason: 'send-control-missing', observation };
    send.click();
    return { clicked: true, method: 'button', label: labels(send).join(' '), observation };
  })()`);
}

async function retryPromptSubmit(browser, prompt, format, baseline) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    const geminiPromptSubmissionEvidence = ${geminiPromptSubmissionEvidence.toString()};
    const retryFor = ${geminiPromptRetryDecision.toString()};
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const expectedPrompt = ${JSON.stringify(String(prompt))};
    const requestedFormat = ${JSON.stringify(format)};
    const baseline = ${JSON.stringify(baseline)};
    const visible = (element) => { const rect = element?.getBoundingClientRect?.(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
    const labels = (element) => [element?.innerText, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
    const text = (element) => labels(element).join(' ').trim().toLowerCase();
    const ratioLabel = (element) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(element));
    const ratioOptionElement = (element) => element.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(element.closest('[role="menu"],[role="listbox"]'));
    const selected = (element) => {
      if (typeof element.checked === 'boolean' && element.checked === true) return true;
      return [element.getAttribute('aria-checked'), element.getAttribute('aria-selected'), element.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const controls = [...document.querySelectorAll('button,[role="button"]')].filter((element) => visible(element) && !ratioOptionElement(element));
    const ratioControl = controls.find((element) => /aspect ratio|가로세로|화면비/i.test(text(element))) || controls.find(ratioLabel) || null;
    const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
      .filter((element) => visible(element) && ratioLabel(element))
      .map((element) => ({ label: text(element), selected: selected(element) }));
    const ratioVerification = ratioEvidenceFor(requestedFormat, { controlLabel: ratioControl ? text(ratioControl) : '', options });
    const observation = stateFor(expectedPrompt, document, location.href);
    const decision = retryFor(expectedPrompt, requestedFormat, baseline, observation, ratioVerification);
    if (!decision.eligible) {
      return { clicked: false, reason: decision.reason, observation, evidence: decision.submission, ratioVerification };
    }
    const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
    const send = [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(exactSendLabel);
    if (!send) return { clicked: false, reason: 'send-control-missing', observation, evidence: decision.submission, ratioVerification };
    send.click();
    return { clicked: true, method: 'button', label: labels(send).join(' '), observation, evidence: decision.submission, ratioVerification };
  })()`);
}

async function submitPrompt(browser, prompt, format, { onBeforeInitialClick = null, onVerified = null } = {}) {
  return confirmGeminiPromptSubmission({
    prompt,
    format,
    observe: () => inspectPromptSubmission(browser, prompt),
    initialClick: () => clickPromptSubmit(browser, prompt),
    retryClick: ({ baseline }) => retryPromptSubmit(browser, prompt, format, baseline),
    onBeforeInitialClick,
    onVerified,
    maxClickAttempts: 1
  });
}

async function inspectMedia(browser) {
  return browser.evaluate(`(() => ({
    pageUrl: location.href,
    videos: [...document.querySelectorAll('video')].map(v => ({ src: v.currentSrc || v.src || '', ready: v.readyState, duration: v.duration || 0 })),
    links: [...document.querySelectorAll('a')].map(a => ({ href: a.href || '', text: (a.innerText || a.getAttribute('aria-label') || '').trim() })).filter(x => x.href && (/\\.mp4|download|다운로드|내려받기/i.test(x.href + ' ' + x.text))),
    chats: [...document.querySelectorAll('a')].map(a => ({ href: a.href || '', text: (a.innerText || a.getAttribute('aria-label') || '').trim() })).filter(x => /gemini\\.google\\.com\\/app\\/[^/?#]+/i.test(x.href)),
    buttons: [...document.querySelectorAll('button,[role="button"]')].map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(-60),
    body: (document.body?.innerText || '').slice(-4000)
  }))()`);
}

function serializeKnownMedia(knownMedia = {}) {
  return Object.fromEntries(["videos", "links", "chats"].map((key) => [
    key,
    [...new Set(Array.from(knownMedia[key] || [])
      .filter((value) => typeof value === "string" && value)
      .map((value) => /^sha256:[a-f0-9]{64}$/i.test(value) ? value : hashJson({ type: "gemini-page-media", value })))]
      .sort()
  ]));
}

function deserializeKnownMedia(knownMedia = {}) {
  return Object.fromEntries(["videos", "links", "chats"].map((key) => [key, new Set(knownMedia[key] || [])]));
}

export async function waitForGeminiConversationUrl({
  initialUrl = null,
  readHref,
  nowFn = Date.now,
  sleepFn = sleep,
  timeoutMs = CONVERSATION_BINDING_TIMEOUT_MS,
  pollIntervalMs = CONVERSATION_BINDING_POLL_MS
} = {}) {
  if (typeof readHref !== "function" || typeof nowFn !== "function" || typeof sleepFn !== "function") {
    throw new TypeError("Gemini 대화 URL 대기 함수가 올바르지 않습니다.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("Gemini 대화 URL 대기 시간은 양의 정수여야 합니다.");
  }
  let conversationUrl = canonicalGeminiConversationUrl(initialUrl);
  if (conversationUrl) return conversationUrl;
  const startedAt = nowFn();
  const deadline = startedAt + timeoutMs;
  while (nowFn() < deadline) {
    conversationUrl = canonicalGeminiConversationUrl(await readHref().catch(() => null));
    if (conversationUrl) return conversationUrl;
    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }
  return null;
}

async function waitForConversationBinding(browser, initialObservation = {}) {
  return waitForGeminiConversationUrl({
    initialUrl: initialObservation.conversationUrl,
    readHref: () => browser.evaluate("location.href")
  });
}

export async function writeGeminiGenerationCheckpoint(path, generation, dependencies = {}) {
  const writeFileFn = dependencies.writeFileFn || writeFile;
  const renameFn = dependencies.renameFn || rename;
  const unlinkFn = dependencies.unlinkFn || unlink;
  const openFn = dependencies.openFn || open;
  const tempId = typeof dependencies.tempId === "string" && dependencies.tempId
    ? dependencies.tempId
    : `${process.pid}-${randomUUID()}`;
  const temporary = `${path}.${tempId}.tmp`;
  try {
    await writeFileFn(temporary, JSON.stringify(generation, null, 2));
    const temporaryHandle = await openFn(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await renameFn(temporary, path);
    const directoryHandle = await openFn(dirname(path), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await unlinkFn(temporary).catch(() => {});
  }
}

export async function publishDurableGeminiClip({ targetPath, bytes, format }, dependencies = {}) {
  const exactBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes || []);
  if (!exactBytes.length || exactBytes.length > 70 * 1024 * 1024) {
    throw new Error("Gemini clip publication bytes가 올바르지 않습니다.");
  }
  const normalizedFormat = format === "vertical" ? "vertical" : format === "landscape" ? "landscape" : null;
  if (!normalizedFormat || typeof targetPath !== "string" || !targetPath.endsWith(".mp4")) {
    throw new Error("Gemini clip publication 경로 또는 format이 올바르지 않습니다.");
  }
  const openFn = dependencies.openFn || open;
  const renameFn = dependencies.renameFn || rename;
  const unlinkFn = dependencies.unlinkFn || unlink;
  const clipMatchesFormatFn = dependencies.clipMatchesFormatFn || clipMatchesFormat;
  const temporaryPath = `${targetPath}.${dependencies.tempId || `${process.pid}-${randomUUID()}`}.tmp`;
  let renamed = false;
  try {
    const handle = await openFn(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(exactBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!await clipMatchesFormatFn(temporaryPath, normalizedFormat)) {
      throw new Error(`Gemini가 ${normalizedFormat === "vertical" ? "세로 9:16" : "가로 16:9"} 비율의 영상을 반환하지 않았습니다.`);
    }
    await renameFn(temporaryPath, targetPath);
    renamed = true;
    const directoryHandle = await openFn(dirname(targetPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return {
      path: targetPath,
      bytes: exactBytes.length,
      sha256: `sha256:${createHash("sha256").update(exactBytes).digest("hex")}`
    };
  } finally {
    if (!renamed) await unlinkFn(temporaryPath).catch(() => {});
  }
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ""));
}

function validLegacyAbandonmentEvidenceReference(value) {
  if (value == null) return true;
  return value?.schemaVersion === 1
    && value.generationPath === "legacy-gemini-evidence/abandoned-gemini-generation.json"
    && value.receiptPath === "legacy-gemini-evidence/abandonment-receipt.json"
    && isSha256(value.generationSha256)
    && isSha256(value.receiptSha256)
    && isSha256(value.receiptHash);
}

function validLegacyAbandonmentReceiptReference(value, strict = false) {
  if (value == null) return true;
  const structurallyValid = value?.path === "gemini-legacy-abandonment.json"
    && value.authorization === "explicit-operator-cli"
    && value.operatorAssertion === "no-live-recoverable-conversation-target"
    && Number.isFinite(Date.parse(value.authorizedAt))
    && isSha256(value.receiptHash)
    && isSha256(value.sourceGenerationSha256)
    && value.liveCdpObservation?.headless === true
    && value.liveCdpObservation?.prohibitedTargetCount === 0
    && Number.isInteger(value.liveCdpObservation?.targetCount)
    && value.liveCdpObservation.targetCount >= 0
    && Number.isFinite(Date.parse(value.liveCdpObservation?.observedAt))
    && isSha256(value.liveCdpObservation?.cdpOriginHash)
    && isSha256(value.liveCdpObservation?.targetSetHash);
  return structurallyValid && (!strict || (
    value.liveCdpObservation?.headlessImplementation === "new"
    && isSha256(value.liveCdpObservation?.runtimeProofHash)
  ));
}

function validPromptReadinessFailure(value) {
  if (value == null) return true;
  const expectedKeys = [
    "code",
    "expectedCanonicalHash",
    "expectedCanonicalLength",
    "expectedLength",
    "expectedNewlineCount",
    "observedCanonicalHash",
    "observedCanonicalLength",
    "observedLength",
    "observedNewlineCount",
    "promptFieldVisible",
    "recordedAt",
    "schemaVersion"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort())
    || value.schemaVersion !== 1
    || !/^GEMINI_PROMPT_[A-Z_]+$/.test(String(value.code || ""))
    || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.promptFieldVisible !== "boolean"
    || !isSha256(value.expectedCanonicalHash)
    || (value.observedCanonicalHash !== null && !isSha256(value.observedCanonicalHash))) return false;
  for (const key of ["expectedLength", "expectedCanonicalLength", "expectedNewlineCount"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  for (const key of ["observedLength", "observedCanonicalLength", "observedNewlineCount"]) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 0)) return false;
  }
  return true;
}

function validCurrentGeminiGenerationReceipt(generation) {
  if (generation.schemaVersion < 4) {
    // Historical failed receipts with no completed segments remain eligible
    // for the explicit legacy-abandonment flow. A legacy receipt that claims
    // completion must contain at least one segment; otherwise treating it as
    // an ordinary previous run can fall through to a blind fresh submission.
    return Array.isArray(generation.segments)
      && (generation.status !== "completed" || (
        generation.segments.length > 0
        && Number.isFinite(Date.parse(generation.completedAt))
      ));
  }
  if (![4, 5].includes(generation.schemaVersion)) return false;
  const strict = generation.schemaVersion === 5;
  const hasFailureText = Object.hasOwn(generation, "error") || Object.hasOwn(generation, "errorEvidence");
  if (strict && hasFailureText && (
    !verifyGeminiFailureEvidence(generation.errorEvidence)
    || generation.error !== generation.errorEvidence.reasonCode
    || !/^GEMINI_[A-Z0-9_]{1,95}$/.test(String(generation.errorCode || ""))
  )) return false;
  if (!generation.request || typeof generation.request !== "object" || Array.isArray(generation.request)
    || generation.request.provider !== "gemini-browser"
    || !Number.isInteger(generation.request.clipCount) || generation.request.clipCount < 1
    || !Array.isArray(generation.request.segments)
    || generation.request.segments.length !== generation.request.clipCount) return false;
  if (!Number.isFinite(Date.parse(generation.startedAt))
    || (["failed", "completed"].includes(generation.status) && !Number.isFinite(Date.parse(generation.completedAt)))) return false;
  if (!validPromptReadinessFailure(generation.promptReadinessFailure)
    || (generation.promptReadinessFailure != null
      && (generation.status !== "failed" || generation.errorCode !== generation.promptReadinessFailure.code))) return false;
  if (!["requestHash", "scriptHash", "resumeRequestHash", "resumeScriptHash", "sessionBindingHash", "providerDecisionHash", "providerAttestationHash"]
    .every((key) => isSha256(generation[key]))) return false;
  if (!generation.sessionBinding || hashJson(generation.sessionBinding) !== generation.sessionBindingHash
    || !generation.providerDecision || hashJson(generation.providerDecision) !== generation.providerDecisionHash
    || !generation.providerAttestation || hashJson(generation.providerAttestation) !== generation.providerAttestationHash
    || generation.providerAttestation.sessionBindingHash !== generation.sessionBindingHash) return false;
  if (strict && !validGenerationRuntimeAttestation(generation.providerAttestation, generation.sessionBinding)) return false;
  if (!Array.isArray(generation.segments)
    || !Array.isArray(generation.recoveryAttempts)
    || !Array.isArray(generation.recoveredPendingSegments)
    || !Array.isArray(generation.rejectedResumes)
    || (generation.pendingSegment != null && (typeof generation.pendingSegment !== "object" || Array.isArray(generation.pendingSegment)))) return false;
  if (generation.segments.length > generation.request.clipCount) return false;
  const segmentIndexes = new Set();
  for (const [position, segment] of generation.segments.entries()) {
    if (!Number.isInteger(segment?.index) || segment.index < 1 || segment.index > generation.request.clipCount
      || segment.index !== position + 1
      || segmentIndexes.has(segment.index)
      || segment.runId !== generation.runId
      || segment.requestHash !== generation.requestHash
      || segment.scriptHash !== generation.scriptHash
      || segment.resumeRequestHash !== generation.resumeRequestHash
      || segment.resumeScriptHash !== generation.resumeScriptHash
      || segment.providerDecisionHash !== generation.providerDecisionHash
      || segment.providerAttestationHash !== generation.providerAttestationHash
      || segment.submittedToProvider !== true
      || segment.submissionAcknowledgement?.verified !== true
      || !String(segment.submissionRunId || "").trim()
      || !String(segment.prompt || "").trim()
      || segment.promptHash !== hashJson({ prompt: segment.prompt })
      || !isSha256(segment.providerVisualPromptHash)
      || !isSha256(segment.sha256)
      || segment.path !== segment.output
      || segment.path !== `clips/${String(segment.index).padStart(2, "0")}.mp4`) return false;
    if (strict && (
      typeof segment.providerRequestSentThisRun !== "boolean"
      || typeof segment.inheritedProviderSubmission !== "boolean"
      || segment.inheritedProviderSubmission === segment.providerRequestSentThisRun
      || !Object.hasOwn(segment, "sourceRunId")
      || !Object.hasOwn(segment, "sourceGenerationHash")
      || !validGeminiTargetConversationLineage(segment)
    )) return false;
    if (strict && segment.providerRequestSentThisRun === true && (
      segment.inheritedProviderSubmission !== false
      || segment.sourceRunId !== null
      || segment.sourceGenerationHash !== null
      || segment.submissionRunId !== generation.runId
    )) return false;
    if (strict && segment.providerRequestSentThisRun === false && (
      segment.inheritedProviderSubmission !== true
      || !String(segment.sourceRunId || "").trim()
      || segment.sourceRunId === generation.runId
      || !isSha256(segment.sourceGenerationHash)
    )) return false;
    segmentIndexes.add(segment.index);
  }
  if (generation.pendingSegment != null && generation.pendingSegment.index !== generation.segments.length + 1) return false;
  if (generation.recoveryAttempts.some((attempt, index) => (
    attempt?.attempt !== index + 1
    || !String(attempt.runId || "").trim()
    || !String(attempt.submissionRunId || "").trim()
    || !Number.isFinite(Date.parse(attempt.startedAt))
    || (attempt.completedAt != null && !Number.isFinite(Date.parse(attempt.completedAt)))
  ))) return false;
  if (generation.status === "completed"
    && (generation.pendingSegment != null || generation.segments.length !== generation.request.clipCount)) return false;
  if (strict && (
    typeof generation.providerRequestSentThisRun !== "boolean"
    || typeof generation.inheritedProviderSubmission !== "boolean"
    || generation.providerRequestSentThisRun !== generation.segments.some((segment) => segment.providerRequestSentThisRun)
    || generation.inheritedProviderSubmission !== generation.segments.some((segment) => segment.inheritedProviderSubmission)
    || !Array.isArray(generation.submissionRunIds)
    || JSON.stringify(generation.submissionRunIds) !== JSON.stringify([
      ...new Set(generation.segments.map((segment) => String(segment.submissionRunId || "").trim()).filter(Boolean))
    ].sort())
  )) return false;
  if (strict && generation.resumedFromCompletedGeneration != null) {
    const resume = generation.resumedFromCompletedGeneration;
    if (!String(resume.sourceRunId || "").trim()
      || !isSha256(resume.sourceGenerationHash)
      || !Number.isFinite(Date.parse(resume.resumedAt))
      || resume.providerRequestSent !== false
      || generation.segments.some((segment) => (
        segment.sourceRunId !== resume.sourceRunId
        || segment.sourceGenerationHash !== resume.sourceGenerationHash
        || segment.providerRequestSentThisRun !== false
        || segment.inheritedProviderSubmission !== true
      ))) return false;
  }
  const hasLegacyReceipt = generation.legacySubmissionAbandonment != null;
  const hasLegacyEvidence = generation.legacySubmissionAbandonmentEvidence != null;
  if (hasLegacyReceipt !== hasLegacyEvidence
    || !validLegacyAbandonmentReceiptReference(generation.legacySubmissionAbandonment, strict)
    || !validLegacyAbandonmentEvidenceReference(generation.legacySubmissionAbandonmentEvidence)
    || (hasLegacyReceipt
      && generation.legacySubmissionAbandonment.receiptHash !== generation.legacySubmissionAbandonmentEvidence.receiptHash
      || hasLegacyReceipt
      && generation.legacySubmissionAbandonment.sourceGenerationSha256 !== generation.legacySubmissionAbandonmentEvidence.generationSha256)) return false;
  if (!Array.isArray(generation.legacySubmissionAbandonmentConsumptions)) return false;
  if (!hasLegacyReceipt && generation.legacySubmissionAbandonmentConsumptions.length !== 0) return false;
  if (!strict) return true;
  const submittedSegmentIndexes = new Set(generation.segments.map((segment) => segment.index));
  if (generation.pendingSegment) submittedSegmentIndexes.add(generation.pendingSegment.index);
  const consumedSegments = new Set();
  for (const attestation of generation.legacySubmissionAbandonmentConsumptions) {
    if (!submittedSegmentIndexes.has(attestation?.segmentIndex)
      || consumedSegments.has(attestation?.segmentIndex)
      || !validateLegacyGeminiAbandonmentConsumption({
        attestation,
        abandonmentReceipt: generation.legacySubmissionAbandonment,
        generation
      })) return false;
    consumedSegments.add(attestation.segmentIndex);
  }
  if (hasLegacyReceipt && [...submittedSegmentIndexes].some((index) => !consumedSegments.has(index))) return false;
  return true;
}

export const GEMINI_GENERATION_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;

function sameGenerationReceiptState(left, right) {
  return sameFdIdentity(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function canonicalGeminiGenerationReceiptLocation(path) {
  const jobsRoot = resolve(JOBS_DIR);
  const target = resolve(String(path || ""));
  const jobDirectory = dirname(target);
  const jobId = basename(jobDirectory);
  if (
    basename(target) !== "gemini-generation.json"
    || dirname(jobDirectory) !== jobsRoot
    || target !== join(jobsRoot, jobId, "gemini-generation.json")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/.test(jobId)
  ) throw new Error("Gemini generation 영수증 경로가 canonical jobs direct-child 경계가 아닙니다.");
  return { jobsRoot, jobId, target };
}

function openPinnedGeminiJobsRoot(path) {
  const fd = openSync(
    path,
    fsConstants.O_RDONLY
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK
      | (fsConstants.O_DIRECTORY || 0)
  );
  const identity = statFd(fd);
  if (!identity.isDirectory()) {
    closeSync(fd);
    throw new Error("Gemini generation jobs root가 디렉터리가 아닙니다.");
  }
  return { fd, identity };
}

async function readCanonicalGeminiGenerationReceiptBytes(path, dependencies = {}) {
  const location = canonicalGeminiGenerationReceiptLocation(path);
  let jobsRoot = null;
  let jobFd = null;
  let fileFd = null;
  let currentJobsRoot = null;
  let currentJobFd = null;
  let currentFileFd = null;
  try {
    jobsRoot = openPinnedGeminiJobsRoot(location.jobsRoot);
    jobFd = openDirectoryAt(jobsRoot.fd, location.jobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("Gemini generation job entry가 디렉터리가 아닙니다.");
    try {
      fileFd = openFileAt(jobFd, "gemini-generation.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const before = statFd(fileFd);
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size > BigInt(GEMINI_GENERATION_RECEIPT_MAX_BYTES)
    ) throw new Error("Gemini generation 영수증은 bounded single-link regular file이어야 합니다.");
    const bytes = readFdBuffer(fileFd, { maxBytes: GEMINI_GENERATION_RECEIPT_MAX_BYTES });
    const after = statFd(fileFd);
    if (after.nlink !== 1n || !sameGenerationReceiptState(before, after)) {
      throw new Error("Gemini generation 영수증이 same-fd read 중 변경되었습니다.");
    }

    await dependencies.afterPinnedReadForTest?.({ path: location.target });

    currentJobsRoot = openPinnedGeminiJobsRoot(location.jobsRoot);
    if (!sameFdIdentity(jobsRoot.identity, currentJobsRoot.identity)) {
      throw new Error("Gemini generation 영수증 jobs root가 읽는 중 교체되었습니다.");
    }
    currentJobFd = openDirectoryAt(currentJobsRoot.fd, location.jobId);
    const currentJobIdentity = statFd(currentJobFd);
    if (!currentJobIdentity.isDirectory() || !sameFdIdentity(jobIdentity, currentJobIdentity)) {
      throw new Error("Gemini generation 영수증 job directory가 읽는 중 교체되었습니다.");
    }
    currentFileFd = openFileAt(currentJobFd, "gemini-generation.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const current = statFd(currentFileFd);
    if (!current.isFile() || current.nlink !== 1n || !sameGenerationReceiptState(before, current)) {
      throw new Error("Gemini generation 영수증 canonical path가 읽는 중 교체되었습니다.");
    }
    return bytes;
  } finally {
    if (currentFileFd !== null) closeFd(currentFileFd);
    if (currentJobFd !== null) closeFd(currentJobFd);
    if (currentJobsRoot) closeSync(currentJobsRoot.fd);
    if (fileFd !== null) closeFd(fileFd);
    if (jobFd !== null) closeFd(jobFd);
    if (jobsRoot) closeSync(jobsRoot.fd);
  }
}

async function readGeminiGenerationReceiptBytes(path, dependencies = {}) {
  if (Object.hasOwn(dependencies, "receiptBytes")) {
    if (dependencies.receiptBytes == null) return null;
    if (
      typeof dependencies.receiptBytes !== "string"
      && !Buffer.isBuffer(dependencies.receiptBytes)
      && !(dependencies.receiptBytes instanceof Uint8Array)
    ) throw new TypeError("주입된 Gemini generation 영수증 바이트가 유효하지 않습니다.");
    return dependencies.receiptBytes;
  }

  const hasInjectedExists = Object.hasOwn(dependencies, "existsFn");
  const hasInjectedRead = Object.hasOwn(dependencies, "readFileFn");
  if (hasInjectedExists || hasInjectedRead) {
    if (!hasInjectedExists || !hasInjectedRead || typeof dependencies.existsFn !== "function" || typeof dependencies.readFileFn !== "function") {
      throw new TypeError("Gemini generation 테스트 byte reader는 existsFn·readFileFn을 함께 명시해야 합니다.");
    }
    if (!dependencies.existsFn(path)) return null;
    return dependencies.readFileFn(path);
  }
  return readCanonicalGeminiGenerationReceiptBytes(path, dependencies);
}

export async function readGeminiGenerationReceipt(path, dependencies = {}) {
  let bytes;
  try {
    const input = await readGeminiGenerationReceiptBytes(path, dependencies);
    if (input == null) return null;
    const observedBytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input?.byteLength;
    if (!Number.isSafeInteger(observedBytes) || observedBytes > GEMINI_GENERATION_RECEIPT_MAX_BYTES) {
      throw new Error(`영수증 크기가 ${GEMINI_GENERATION_RECEIPT_MAX_BYTES} byte 제한을 초과했습니다.`);
    }
    bytes = Buffer.from(input);
  } catch (error) {
    throw new Error(`기존 Gemini generation 영수증을 읽을 수 없습니다. 새 요청을 전송하지 않습니다 (${error.message}).`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const generation = JSON.parse(text);
    if (!generation || typeof generation !== "object" || Array.isArray(generation)) throw new Error("object expected");
    if (!Number.isInteger(generation.schemaVersion) || generation.schemaVersion < 1
      || generation.provider !== "gemini-browser"
      || !String(generation.jobId || "").trim()
      || !String(generation.runId || "").trim()
      || !["running", "failed", "completed"].includes(generation.status)
      || !validCurrentGeminiGenerationReceipt(generation)) {
      throw new Error("required generation fields are invalid");
    }
    if (dependencies.includeSnapshot === true) {
      const exactBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes));
      return {
        generation,
        snapshot: {
          bytes: exactBytes.length,
          sha256: `sha256:${createHash("sha256").update(exactBytes).digest("hex")}`,
          generationHash: hashJson(generation),
          raw: exactBytes
        }
      };
    }
    return generation;
  } catch (error) {
    throw new Error(`기존 Gemini generation 영수증이 손상되었습니다. 새 요청을 전송하지 않습니다 (${error.message}).`);
  }
}

function validateExpectedRecoverySourceReceipt(expected, actual) {
  if (expected == null) return;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
    || JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify([
      "bytes", "sha256", "sourceGenerationHash", "sourceRunId"
    ])
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    || !isSha256(expected.sha256)
    || !String(expected.sourceRunId || "").trim()
    || !isSha256(expected.sourceGenerationHash)) {
    throw new Error("기대된 Gemini recovery source 영수증이 올바르지 않습니다. 브라우저에 연결하지 않습니다.");
  }
  if (!actual
    || actual.snapshot.bytes !== expected.bytes
    || actual.snapshot.sha256 !== expected.sha256
    || actual.generation.runId !== expected.sourceRunId
    || actual.snapshot.generationHash !== expected.sourceGenerationHash) {
    throw new Error("Gemini recovery source 영수증이 보존 이후 변경되었습니다. 브라우저에 연결하거나 새 요청을 전송하지 않습니다.");
  }
}

export async function assertGeminiPartialResumePreflight({
  job,
  script,
  jobDir,
  previousGeneration,
  requestPayload,
  requestHash,
  scriptHash,
  resumeRequestHash,
  resumeScriptHash,
  sessionBinding,
  sessionBindingHash,
  providerDecision,
  providerDecisionHash
}, dependencies = {}) {
  const segments = previousGeneration?.segments;
  if (!["failed", "running"].includes(previousGeneration?.status) || !Array.isArray(segments) || segments.length === 0) {
    return { required: false, segmentCount: 0 };
  }
  const fail = (reason) => {
    const error = new Error(`기존 Gemini 완료 클립을 현재 실행에 exact 결속할 수 없습니다 (${reason}). 브라우저에 연결하거나 새 요청을 전송하지 않습니다.`);
    error.code = "GEMINI_PARTIAL_RESUME_BINDING_MISMATCH";
    throw error;
  };
  if (previousGeneration.schemaVersion !== 5
    || previousGeneration.provider !== "gemini-browser"
    || !validCurrentGeminiGenerationReceipt(previousGeneration)) fail("generation-schema");
  if (previousGeneration.jobId !== job.id || !String(previousGeneration.runId || "").trim()) fail("job-run");
  if (hashJson(previousGeneration.request) !== hashJson(requestPayload)
    || previousGeneration.requestHash !== requestHash
    || previousGeneration.requestHash !== hashJson({ ...previousGeneration.request, scriptHash: previousGeneration.scriptHash })
    || previousGeneration.scriptHash !== scriptHash
    || previousGeneration.resumeRequestHash !== resumeRequestHash
    || previousGeneration.resumeRequestHash !== hashJson({ ...previousGeneration.request, scriptHash: previousGeneration.resumeScriptHash })
    || previousGeneration.resumeScriptHash !== resumeScriptHash) fail("request-script");
  if (hashJson(previousGeneration.sessionBinding) !== sessionBindingHash
    || previousGeneration.sessionBindingHash !== sessionBindingHash
    || hashJson(sessionBinding) !== sessionBindingHash) fail("session");
  if (hashJson(previousGeneration.providerDecision) !== providerDecisionHash
    || previousGeneration.providerDecisionHash !== providerDecisionHash
    || hashJson(providerDecision) !== providerDecisionHash) fail("provider-decision");
  if (!validGenerationRuntimeAttestation(previousGeneration.providerAttestation, job)
    || previousGeneration.providerAttestationHash !== hashJson(previousGeneration.providerAttestation)
    || previousGeneration.providerAttestation.sessionBindingHash !== sessionBindingHash) fail("observed-runtime-attestation");
  if (segments.length > script.segments.length) fail("segment-count");
  const readFileFn = dependencies.readFileFn || readFile;
  const writeFileFn = dependencies.writeFileFn || writeFile;
  const unlinkFn = dependencies.unlinkFn || unlink;
  const clipMatchesFormatFn = dependencies.clipMatchesFormatFn || clipMatchesFormat;
  const existsFn = dependencies.existsFn || existsSync;
  for (let position = 0; position < segments.length; position += 1) {
    const index = position + 1;
    const segment = segments[position];
    const currentScriptSegment = script.segments[position];
    const prompt = buildGeminiClipPrompt(job, script, currentScriptSegment);
    const promptBinding = providerPromptBindingForSegment(currentScriptSegment, "gemini-browser");
    const relativePath = `clips/${String(index).padStart(2, "0")}.mp4`;
    if (segment?.index !== index
      || segment.runId !== previousGeneration.runId
      || segment.requestHash !== previousGeneration.requestHash
      || segment.scriptHash !== previousGeneration.scriptHash
      || segment.resumeRequestHash !== previousGeneration.resumeRequestHash
      || segment.resumeScriptHash !== previousGeneration.resumeScriptHash
      || segment.providerDecisionHash !== previousGeneration.providerDecisionHash
      || segment.providerAttestationHash !== previousGeneration.providerAttestationHash
      || segment.prompt !== prompt
      || segment.promptHash !== hashJson({ prompt })
      || segment.providerVisualPromptHash !== promptBinding.providerVisualPromptHash
      || hashJson(segment.shotPattern ?? null) !== hashJson(promptBinding.shotPattern ?? null)
      || segment.path !== relativePath
      || segment.output !== relativePath
      || segment.submittedToProvider !== true
      || segment.submissionAcknowledgement?.verified !== true
      || !validGeminiTargetConversationLineage(segment)) fail(`segment-${index}-provenance`);
    const absolutePath = join(jobDir, relativePath);
    if (!existsFn(absolutePath)) fail(`segment-${index}-bytes`);
    let clipBytes;
    try { clipBytes = await readFileFn(absolutePath); } catch { fail(`segment-${index}-bytes`); }
    const exactBytes = Buffer.isBuffer(clipBytes) ? clipBytes : Buffer.from(clipBytes);
    if (`sha256:${createHash("sha256").update(exactBytes).digest("hex")}` !== segment.sha256) fail(`segment-${index}-bytes`);
    const snapshotPath = join(dirname(absolutePath), `.gemini-resume-${index}-${randomUUID()}.mp4`);
    try {
      await writeFileFn(snapshotPath, exactBytes, { flag: "wx", mode: 0o400 });
      if (!await clipMatchesFormatFn(snapshotPath, job.format).catch(() => false)) fail(`segment-${index}-format`);
    } finally {
      await unlinkFn(snapshotPath).catch(() => {});
    }
  }
  return {
    required: true,
    segmentCount: segments.length,
    providerAttestationHash: previousGeneration.providerAttestationHash
  };
}

export function retainLegacyGeminiAbandonmentProvenance(previousGeneration, legacyDecision, newlyPreservedEvidence) {
  const receipt = legacyDecision?.required === true
    ? legacyDecision.receipt
    : previousGeneration?.legacySubmissionAbandonment || null;
  const evidence = legacyDecision?.required === true
    ? newlyPreservedEvidence
    : previousGeneration?.legacySubmissionAbandonmentEvidence || null;
  const consumptions = legacyDecision?.required === true
    ? []
    : previousGeneration?.legacySubmissionAbandonmentConsumptions || [];
  if ((receipt == null) !== (evidence == null)
    || !validLegacyAbandonmentReceiptReference(receipt)
    || !validLegacyAbandonmentEvidenceReference(evidence)
    || (receipt && receipt.receiptHash !== evidence.receiptHash)
    || (receipt && receipt.sourceGenerationSha256 !== evidence.generationSha256)) {
    throw new Error("legacy Gemini 폐기 provenance를 안전하게 이어받을 수 없습니다.");
  }
  if (!Array.isArray(consumptions)) throw new Error("legacy Gemini 폐기 소비 provenance가 올바르지 않습니다.");
  return { receipt, evidence, consumptions };
}

export async function openGeminiPageMediaSession(input, dependencies = {}) {
  const globalObject = dependencies.globalObject || globalThis;
  const fetchFn = dependencies.fetchFn || globalObject.fetch;
  const nowFn = dependencies.nowFn || Date.now;
  const setTimeoutFn = dependencies.setTimeoutFn || setTimeout;
  const clearTimeoutFn = dependencies.clearTimeoutFn || clearTimeout;
  const pageOrigin = dependencies.pageOrigin ?? globalObject.location?.origin;
  const sessionKey = String(input?.sessionKey || "");
  const url = String(input?.url || "");
  const credentials = input?.credentials;
  const deadlineMs = Number(input?.deadlineMs);
  const maximumBytes = Number(input?.maximumBytes);
  const failure = (code, status = null) => ({ ok: false, code, status: Number.isInteger(status) ? status : null });
  if (
    pageOrigin !== "https://gemini.google.com"
    || !/^__ps4GeminiMedia_[a-f0-9]{32}$/u.test(sessionKey)
    || !url
    || !["same-origin", "omit"].includes(credentials)
    || !Number.isSafeInteger(deadlineMs)
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > 70 * 1024 * 1024
  ) return failure("invalid-session-input");
  if (Object.prototype.hasOwnProperty.call(globalObject, sessionKey)) return failure("duplicate-session");
  const controller = new AbortController();
  const state = {
    controller,
    timer: null,
    deadlinePromise: null,
    reader: null,
    response: null,
    readPromise: null,
    pending: null,
    pendingOffset: 0,
    observedBytes: 0,
    declaredLength: null,
    maximumBytes
  };
  const cleanup = async (reason) => {
    try { controller.abort(); } catch {}
    if (state.timer !== null) clearTimeoutFn(state.timer);
    try { await state.reader?.cancel?.(reason); } catch {}
    try { await state.response?.body?.cancel?.(reason); } catch {}
    try { delete globalObject[sessionKey]; } catch {}
  };
  const remainingMs = deadlineMs - Number(nowFn());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 3_600_000) return failure("deadline-expired");
  let markDeadline;
  state.deadlinePromise = new Promise((resolveDeadline) => { markDeadline = () => resolveDeadline({ kind: "deadline" }); });
  state.timer = setTimeoutFn(() => {
    try { controller.abort(); } catch {}
    markDeadline();
  }, remainingMs);
  try {
    Object.defineProperty(globalObject, sessionKey, { value: state, configurable: true, enumerable: false });
  } catch {
    if (state.timer !== null) clearTimeoutFn(state.timer);
    return failure("session-publication-failed");
  }
  const fetchPromise = Promise.resolve().then(() => fetchFn(url, {
    method: "GET",
    credentials,
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    headers: { accept: "video/*, application/octet-stream;q=0.8" },
    signal: controller.signal
  })).then(
    (response) => ({ kind: "response", response }),
    () => ({ kind: "fetch-error" })
  );
  const opened = await Promise.race([fetchPromise, state.deadlinePromise]);
  if (opened?.kind === "deadline") {
    void fetchPromise.then(async (late) => {
      try { await late?.response?.body?.cancel?.("deadline-expired"); } catch {}
    });
    await cleanup("deadline-expired");
    return failure("deadline-expired");
  }
  if (opened?.kind !== "response") {
    await cleanup("fetch-failed");
    return failure("fetch-failed");
  }
  const response = opened.response;
  state.response = response;
  const status = Number(response?.status);
  if (!response?.ok || status !== 200 || response.redirected === true) {
    await cleanup(response?.redirected ? "redirect-rejected" : "http-rejected");
    return failure(response?.redirected ? "redirect-rejected" : "http-rejected", status);
  }
  if (!["basic", "cors"].includes(String(response.type || ""))) {
    await cleanup("response-type-rejected");
    return failure("response-type-rejected", status);
  }
  let contentType;
  let contentEncoding;
  let contentLength;
  let contentRange;
  try {
    contentType = response.headers.get("content-type");
    contentEncoding = response.headers.get("content-encoding");
    contentLength = response.headers.get("content-length");
    contentRange = response.headers.get("content-range");
  } catch {
    await cleanup("headers-unreadable");
    return failure("headers-unreadable", status);
  }
  const normalizedType = typeof contentType === "string" ? contentType.trim().toLowerCase() : "";
  if (!(/^video\/[a-z0-9!#$&^_.+-]+$/u.test(normalizedType) || normalizedType === "application/octet-stream")) {
    await cleanup("media-type-rejected");
    return failure("media-type-rejected", status);
  }
  if (contentEncoding !== null && String(contentEncoding).trim().toLowerCase() !== "identity") {
    await cleanup("content-encoding-rejected");
    return failure("content-encoding-rejected", status);
  }
  if (contentRange !== null) {
    await cleanup("content-range-rejected");
    return failure("content-range-rejected", status);
  }
  if (contentLength !== null) {
    const normalizedLength = String(contentLength).trim();
    if (!/^\d+$/u.test(normalizedLength)) {
      await cleanup("content-length-invalid");
      return failure("content-length-invalid", status);
    }
    state.declaredLength = Number(normalizedLength);
    if (!Number.isSafeInteger(state.declaredLength) || state.declaredLength > maximumBytes) {
      await cleanup("content-length-rejected");
      return failure("content-length-rejected", status);
    }
  }
  try { state.reader = response.body?.getReader?.(); } catch { state.reader = null; }
  if (!state.reader || typeof state.reader.read !== "function") {
    await cleanup("body-unavailable");
    return failure("body-unavailable", status);
  }
  return {
    ok: true,
    responseUrl: String(response.url || ""),
    responseType: String(response.type || ""),
    mediaType: normalizedType,
    declaredLength: state.declaredLength
  };
}

export async function pullGeminiPageMediaSession(input, dependencies = {}) {
  const globalObject = dependencies.globalObject || globalThis;
  const setTimeoutFn = dependencies.setTimeoutFn || setTimeout;
  const clearTimeoutFn = dependencies.clearTimeoutFn || clearTimeout;
  const btoaFn = dependencies.btoaFn || globalObject.btoa;
  const sessionKey = String(input?.sessionKey || "");
  const maximumChunkBytes = Number(input?.maximumChunkBytes);
  const waitMs = Number(input?.waitMs);
  const state = globalObject[sessionKey];
  const failure = (code) => ({ ok: false, code });
  if (
    !state
    || !/^__ps4GeminiMedia_[a-f0-9]{32}$/u.test(sessionKey)
    || !Number.isSafeInteger(maximumChunkBytes)
    || maximumChunkBytes < 1
    || maximumChunkBytes > 256 * 1024
    || !Number.isSafeInteger(waitMs)
    || waitMs < 1
    || waitMs > 5_000
    || typeof btoaFn !== "function"
  ) return failure("invalid-session");
  const cleanup = async (reason) => {
    try { state.controller?.abort?.(); } catch {}
    if (state.timer !== null) clearTimeoutFn(state.timer);
    try { await state.reader?.cancel?.(reason); } catch {}
    try { delete globalObject[sessionKey]; } catch {}
  };
  if (!state.pending) {
    if (!state.readPromise) {
      state.readPromise = Promise.resolve().then(() => state.reader.read()).then(
        (value) => ({ kind: "read", value }),
        () => ({ kind: "read-error" })
      );
    }
    let pollTimer = null;
    const poll = new Promise((resolvePoll) => {
      pollTimer = setTimeoutFn(() => resolvePoll({ kind: "pending" }), waitMs);
    });
    const next = await Promise.race([state.readPromise, state.deadlinePromise, poll]);
    if (pollTimer !== null) clearTimeoutFn(pollTimer);
    if (next?.kind === "pending") return { ok: true, pending: true };
    if (next?.kind === "deadline") {
      await cleanup("deadline-expired");
      return failure("deadline-expired");
    }
    state.readPromise = null;
    if (next?.kind !== "read") {
      await cleanup("body-read-failed");
      return failure("body-read-failed");
    }
    if (next.value?.done) {
      if (state.declaredLength !== null && state.declaredLength !== state.observedBytes) {
        await cleanup("content-length-mismatch");
        return failure("content-length-mismatch");
      }
      const totalBytes = state.observedBytes;
      await cleanup("complete");
      return { ok: true, done: true, totalBytes };
    }
    let chunk;
    try {
      chunk = next.value?.value instanceof Uint8Array
        ? next.value.value
        : new Uint8Array(next.value?.value);
    } catch {
      await cleanup("body-chunk-invalid");
      return failure("body-chunk-invalid");
    }
    const nextTotal = state.observedBytes + chunk.byteLength;
    if (
      !Number.isSafeInteger(nextTotal)
      || nextTotal > state.maximumBytes
      || (state.declaredLength !== null && nextTotal > state.declaredLength)
    ) {
      await cleanup("body-too-large");
      return failure("body-too-large");
    }
    state.observedBytes = nextTotal;
    state.pending = chunk;
    state.pendingOffset = 0;
  }
  const end = Math.min(state.pending.byteLength, state.pendingOffset + maximumChunkBytes);
  const output = state.pending.subarray(state.pendingOffset, end);
  state.pendingOffset = end;
  if (state.pendingOffset >= state.pending.byteLength) {
    state.pending = null;
    state.pendingOffset = 0;
  }
  let binary = "";
  for (let offset = 0; offset < output.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...output.subarray(offset, Math.min(output.byteLength, offset + 0x8000)));
  }
  return {
    ok: true,
    done: false,
    base64: btoaFn(binary),
    chunkBytes: output.byteLength,
    observedBytes: state.observedBytes
  };
}

export async function cancelGeminiPageMediaSession(input, dependencies = {}) {
  const globalObject = dependencies.globalObject || globalThis;
  const clearTimeoutFn = dependencies.clearTimeoutFn || clearTimeout;
  const sessionKey = String(input?.sessionKey || "");
  const state = globalObject[sessionKey];
  if (!state) return { ok: true, canceled: false };
  try { state.controller?.abort?.(); } catch {}
  if (state.timer !== null) clearTimeoutFn(state.timer);
  try { await state.reader?.cancel?.("node-cleanup"); } catch {}
  try { await state.response?.body?.cancel?.("node-cleanup"); } catch {}
  try { delete globalObject[sessionKey]; } catch {}
  return { ok: true, canceled: true };
}

function pageMediaExpression(fn, input) {
  return `(${fn.toString()})(${JSON.stringify(input)})`;
}

function strictBase64Chunk(value, expectedBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(expectedBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === expectedBytes && bytes.toString("base64") === value ? bytes : null;
}

export async function downloadGeminiMediaFromPage(browser, url, options = {}) {
  if (!browser || typeof browser.evaluate !== "function") throw new TypeError("Gemini media browser가 올바르지 않습니다.");
  const candidateKind = options.candidateKind || "video-src";
  const policy = trustedGeminiMediaCandidateUrl(url, candidateKind);
  if (!policy) throw new Error("Gemini media candidate provenance가 허용되지 않습니다.");
  const deadlineMs = Number(options.deadlineMs);
  const maximumBytes = options.maximumBytes ?? GEMINI_MEDIA_MAX_BYTES;
  const maximumChunkBytes = options.maximumChunkBytes ?? GEMINI_MEDIA_TRANSFER_CHUNK_BYTES;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || deadlineMs - Date.now() > MAX_VIDEO_TIMEOUT_MS
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1 || maximumBytes > GEMINI_MEDIA_MAX_BYTES
    || !Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1 || maximumChunkBytes > GEMINI_MEDIA_TRANSFER_CHUNK_BYTES) {
    throw new TypeError("Gemini media download 경계가 올바르지 않습니다.");
  }
  const sessionKey = `__ps4GeminiMedia_${randomUUID().replaceAll("-", "")}`;
  const cleanup = () => browser.evaluate(pageMediaExpression(cancelGeminiPageMediaSession, { sessionKey })).catch(() => null);
  let opened;
  try {
    opened = await browser.evaluate(pageMediaExpression(openGeminiPageMediaSession, {
      sessionKey,
      url: policy.url,
      credentials: policy.credentials,
      deadlineMs,
      maximumBytes
    }));
  } catch (error) {
    await cleanup();
    if (isGeminiBrowserBoundaryError(error)) throw error;
    return null;
  }
  if (!opened?.ok) {
    await cleanup();
    return null;
  }
  let finalPolicy;
  try { finalPolicy = validateGeminiMediaUrl(opened.responseUrl); } catch { finalPolicy = null; }
  if (!finalPolicy || finalPolicy.url !== policy.url || finalPolicy.kind !== policy.kind
    || !["basic", "cors"].includes(opened.responseType)) {
    await cleanup();
    return null;
  }
  const chunks = [];
  let transferredBytes = 0;
  try {
    while (Date.now() < deadlineMs) {
      let result;
      try {
        result = await browser.evaluate(pageMediaExpression(pullGeminiPageMediaSession, {
          sessionKey,
          maximumChunkBytes,
          waitMs: Math.min(GEMINI_MEDIA_PULL_WAIT_MS, Math.max(1, deadlineMs - Date.now()))
        }));
      } catch (error) {
        if (isGeminiBrowserBoundaryError(error)) throw error;
        return null;
      }
      if (!result?.ok) return null;
      if (result.pending === true) continue;
      if (result.done === true) {
        if (result.totalBytes !== transferredBytes || transferredBytes <= 0) return null;
        return Buffer.concat(chunks, transferredBytes);
      }
      const chunkBytes = Number(result.chunkBytes);
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > maximumChunkBytes) return null;
      const chunk = strictBase64Chunk(result.base64, chunkBytes);
      if (!chunk || !Number.isSafeInteger(transferredBytes + chunkBytes) || transferredBytes + chunkBytes > maximumBytes) return null;
      chunks.push(chunk);
      transferredBytes += chunkBytes;
    }
    return null;
  } finally {
    await cleanup();
  }
}

export class GeminiClipTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Gemini 영상 생성 결과를 ${Math.round(timeoutMs / 60_000)}분 안에 찾지 못했습니다. 제출된 대화 탭은 늦게 도착하는 결과를 회수할 수 있도록 보존합니다.`);
    this.name = "GeminiClipTimeoutError";
    this.code = "GEMINI_VIDEO_RESULT_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

async function waitForClip(browser, knownMedia, deadline, timeoutMs, expectedConversationUrl) {
  const expectedUrl = canonicalGeminiConversationUrl(expectedConversationUrl);
  if (!expectedUrl) throw new Error("Gemini 결과 대기에는 결속된 대화 URL이 필요합니다.");
  while (Date.now() < deadline) {
    const media = await inspectMedia(browser);
    if (canonicalGeminiConversationUrl(media.pageUrl) !== expectedUrl) {
      throw new Error("Gemini 결과 대기 중 결속된 대화 URL이 변경되었습니다. 다른 대화의 결과를 가져오지 않습니다.");
    }
    const quotaMessage = geminiVideoQuotaMessage(media.body);
    if (quotaMessage) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${quotaMessage}`);
    const knownVideos = knownMedia?.videos || new Set();
    const knownLinks = knownMedia?.links || new Set();
    const freshVideos = media.videos.filter((video) => video.src
      && !knownVideos.has(hashJson({ type: "gemini-page-media", value: video.src }))
      && video.ready > 0);
    const direct = freshVideos.find((video) => trustedGeminiMediaCandidateUrl(video.src, "video-src"));
    const freshLinks = media.links.filter((item) => item.href
      && !knownLinks.has(hashJson({ type: "gemini-page-media", value: item.href })));
    const link = freshLinks.find((item) => trustedGeminiMediaCandidateUrl(item.href, "download-link"));
    if (direct?.src) {
      const data = await downloadGeminiMediaFromPage(browser, direct.src, { deadlineMs: deadline, candidateKind: "video-src" });
      if (data) return data;
    }
    if (link?.href) {
      const data = await downloadGeminiMediaFromPage(browser, link.href, { deadlineMs: deadline, candidateKind: "download-link" });
      if (data) return data;
    }
    await sleep(2500);
  }
  throw new GeminiClipTimeoutError(timeoutMs);
}


export async function geminiBrowserStatus(input = {}) {
  let config = null;
  let version = null;
  let policy = null;
  try {
    config = browserConfig(input);
    policy = resolveGeminiChromeLaunchPolicy();
    version = await getVersion(config.cdpUrl);
    const runtime = assertGeminiChromeRuntime(version, policy);
    return {
      connected: true,
      browser: version.Browser || "Chrome",
      chromeMajor: runtime.chromeMajor,
      headless: runtime.actualHeadless,
      requestedHeadless: policy.headless,
      mode: runtime.mode,
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir
    };
  } catch (error) {
    return {
      connected: false,
      browser: version?.Browser || null,
      headless: version ? isHeadlessChromeVersion(version) : null,
      requestedHeadless: policy?.headless ?? null,
      cdpUrl: config?.cdpUrl || null,
      profileDir: config?.profileDir || null,
      message: error.message
    };
  }
}

export async function geminiQuotaStatus(input = {}, options = {}) {
  const config = browserConfig(input);
  const runtime = createGeminiBrowserRuntime(input, options);
  let browser = null;
  try {
    browser = await connectBrowser(config, runtime);
    await browser.navigate("https://gemini.google.com/videos");
    const observation = await browser.evaluate(`(() => {
      const quotaMessageFor = ${geminiVideoQuotaMessage.toString()};
      const body = document.body?.innerText || "";
      const quotaMessage = quotaMessageFor(body);
      const quotaResetText = body.match(/[^\\n]*(?:다시 생성할 수 있습니다|videos will be available again)[^\\n]*/i)?.[0]?.trim() || null;
      const account = [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") || "").find((value) => /Google (?:Account|계정)(?::|\\s)/i.test(value)) || null;
      const signInRequired = [...document.querySelectorAll("a,button,[role='button']")].some((el) => /로그인|sign in/i.test([el.innerText, el.getAttribute('aria-label')].filter(Boolean).join(' ')) && /accounts\\.google\\.com/i.test(el.href || el.closest('a')?.href || ''));
      const videoMode = /동영상 만들기|create videos?/i.test(body);
      return {
        available: videoMode && !quotaMessage && !signInRequired,
        quotaMessage,
        quotaResetText,
        account,
        authentication: account ? "authenticated" : signInRequired ? "sign-in-required" : "unknown",
        plan: body.match(/\\b(?:Pro|Plus|Ultra)\\b/)?.[0] || null,
        videoMode,
        bodyExcerpt: body.slice(-1200)
      };
    })()`);
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir,
      headless: isHeadlessChromeVersion(browser.version),
      requestedHeadless: resolveGeminiChromeLaunchPolicy().headless,
      ...observation
    };
  } catch (error) {
    if (isGeminiBrowserBoundaryError(error)) throw error;
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir,
      headless: null,
      available: false,
      error: error.message
    };
  } finally {
    await browser?.close();
  }
}

export async function generateGeminiClips(job, script, onProgress = async () => {}, dependencies = {}) {
  const config = browserConfig({ cdpUrl: job.geminiCdpUrl, profileDir: job.geminiProfileDir });
  const jobDir = join(JOBS_DIR, job.id);
  const clipsDir = join(jobDir, "clips");
  const generationPath = join(jobDir, "gemini-generation.json");
  const timeoutMs = resolveGeminiVideoTimeoutMs();
  const requestPayload = buildGeminiGenerationRequest(job, script);
  const scriptHash = hashJson(script);
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const requestHash = hashJson({ ...requestPayload, scriptHash });
  const resumeRequestHash = hashJson({ ...requestPayload, scriptHash: resumeScriptHash });
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const providerDecisionHash = hashJson(providerDecision);
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const sessionBindingHash = geminiSessionBindingHash(job);
  if (!sessionBinding || !sessionBindingHash) throw new Error("Gemini 실행 세션을 안전하게 결속할 수 없습니다.");

  const previousGenerationRead = await readGeminiGenerationReceipt(generationPath, { includeSnapshot: true });
  const previousGeneration = previousGenerationRead?.generation || null;
  const recoverySourceRequired = Boolean(previousGeneration && (
    job.resumeCompletedGenerationRunId
    || (["failed", "running"].includes(previousGeneration.status)
      && ((Array.isArray(previousGeneration.segments) && previousGeneration.segments.length > 0) || previousGeneration.pendingSegment))
  ));
  if (recoverySourceRequired && !job.expectedRecoverySourceGenerationReceipt) {
    throw new Error("Gemini recovery source의 immutable byte 영수증이 없습니다. 브라우저에 연결하거나 새 요청을 전송하지 않습니다.");
  }
  validateExpectedRecoverySourceReceipt(job.expectedRecoverySourceGenerationReceipt || null, previousGenerationRead);
  const legacyAbandonment = previousGeneration
    ? await readLegacyGeminiAbandonmentDecision({ jobId: job.id, jobDir, generation: previousGeneration, generationPath })
    : { required: false, allowed: true, receipt: null };
  if (legacyAbandonment.required && !legacyAbandonment.allowed) {
    throw new Error(`Legacy Gemini 실패 영수증의 제출 여부를 판별할 수 없습니다 (${legacyAbandonment.reason}). 정확한 영수증 SHA-256와 기존 대화 탭 부재를 확인한 뒤 명시적 폐기 CLI를 실행해야 합니다.`);
  }
  const legacyAbandonmentEvidence = legacyAbandonment.required
    ? await preserveLegacyGeminiAbandonmentEvidence({ jobId: job.id, jobDir, generationPath })
    : null;
  const retainedLegacyAbandonment = retainLegacyGeminiAbandonmentProvenance(
    previousGeneration,
    legacyAbandonment,
    legacyAbandonmentEvidence
  );
  if (previousGeneration
    && previousGeneration.schemaVersion !== 5
    && legacyAbandonment.required !== true) {
    throw new Error(`Historical Gemini schema ${previousGeneration.schemaVersion} 영수증은 관측 기반 재개 증명으로 해석하지 않습니다. 브라우저에 연결하거나 새 요청을 전송하지 않습니다.`);
  }
  const partialResumePreflight = await assertGeminiPartialResumePreflight({
    job,
    script,
    jobDir,
    previousGeneration,
    requestPayload,
    requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    sessionBinding,
    sessionBindingHash,
    providerDecision,
    providerDecisionHash
  }, dependencies);

  if (job.resumeCompletedGenerationRunId) {
    const expectedRunId = String(job.resumeCompletedGenerationRunId);
    const receiptIntegrity = previousGeneration?.status === "completed"
      && previousGeneration.schemaVersion === 5
      && previousGeneration.runId === expectedRunId
      && previousGeneration.jobId === job.id
      && previousGeneration.provider === "gemini-browser"
      && previousGeneration.pendingSegment == null
      && previousGeneration.requestHash === requestHash
      && previousGeneration.scriptHash === scriptHash
      && previousGeneration.resumeRequestHash === resumeRequestHash
      && previousGeneration.resumeScriptHash === resumeScriptHash
      && previousGeneration.sessionBindingHash === sessionBindingHash
      && hashJson(previousGeneration.sessionBinding) === sessionBindingHash
      && previousGeneration.providerDecisionHash === providerDecisionHash
      && hashJson(previousGeneration.providerDecision) === providerDecisionHash
      && previousGeneration.providerAttestationHash === hashJson(previousGeneration.providerAttestation)
      && previousGeneration.providerAttestation?.sessionBindingHash === sessionBindingHash
      && validGenerationRuntimeAttestation(previousGeneration.providerAttestation, job)
      && Array.isArray(previousGeneration.segments)
      && previousGeneration.segments.length === script.segments.length
      && previousGeneration.segments.every(validGeminiTargetConversationLineage);
    if (!receiptIntegrity) {
      throw new Error("중단된 pipeline의 완료 Gemini generation 영수증을 현재 요청·대본·세션에 결속할 수 없습니다. 새 요청을 전송하지 않습니다.");
    }
    const resumedAt = new Date().toISOString();
    const resumedSegments = [];
    for (let index = 0; index < script.segments.length; index += 1) {
      const segmentNumber = index + 1;
      const prior = previousGeneration.segments[index];
      const prompt = buildGeminiClipPrompt(job, script, script.segments[index]);
      const relativePath = `clips/${String(segmentNumber).padStart(2, "0")}.mp4`;
      const absolutePath = join(jobDir, relativePath);
      const providerPromptBinding = providerPromptBindingForSegment(script.segments[index], "gemini-browser");
      const bound = prior?.index === segmentNumber
        && prior.path === relativePath && prior.output === relativePath
        && prior.runId === expectedRunId
        && prior.requestHash === previousGeneration.requestHash
        && prior.scriptHash === previousGeneration.scriptHash
        && prior.resumeRequestHash === previousGeneration.resumeRequestHash
        && prior.resumeScriptHash === previousGeneration.resumeScriptHash
        && prior.providerDecisionHash === previousGeneration.providerDecisionHash
        && prior.providerAttestationHash === previousGeneration.providerAttestationHash
        && prior.prompt === prompt && prior.promptHash === hashJson({ prompt })
        && prior.providerVisualPromptHash === providerPromptBinding.providerVisualPromptHash
        && /^sha256:[a-f0-9]{64}$/.test(String(prior.sha256 || ""))
        && existsSync(absolutePath)
        && await hashFile(absolutePath).catch(() => null) === prior.sha256
        && await clipMatchesFormat(absolutePath, job.format);
      if (!bound) {
        throw new Error(`${segmentNumber}번 완료 Gemini 클립의 provenance·파일 결속을 확인할 수 없습니다. 새 요청을 전송하지 않습니다.`);
      }
      resumedSegments.push({
        ...prior,
        runId: job.runId || null,
        submissionRunId: prior.submissionRunId,
        ...geminiSegmentSubmissionLineage(previousGeneration, false),
        resumeHops: [
          ...(Array.isArray(prior.resumeHops) ? prior.resumeHops : []),
          { fromRunId: expectedRunId, toRunId: job.runId || null, resumedAt }
        ],
        resumedCompletedGeneration: true
      });
    }
    const completedResume = refreshGeminiSubmissionSummary({
      ...previousGeneration,
      schemaVersion: 5,
      startedAt: resumedAt,
      completedAt: resumedAt,
      runId: job.runId || null,
      status: "completed",
      request: requestPayload,
      requestHash,
      scriptHash,
      resumeRequestHash,
      resumeScriptHash,
      segments: resumedSegments,
      resumedFromCompletedGeneration: {
        sourceRunId: expectedRunId,
        sourceGenerationHash: hashJson(previousGeneration),
        resumedAt,
        providerRequestSent: false
      },
      legacySubmissionAbandonment: retainedLegacyAbandonment.receipt,
      legacySubmissionAbandonmentEvidence: retainedLegacyAbandonment.evidence,
      legacySubmissionAbandonmentConsumptions: retainedLegacyAbandonment.consumptions
    });
    await writeGeminiGenerationCheckpoint(generationPath, completedResume);
    await onProgress(100, `${script.segments.length}/${script.segments.length} 완료 Gemini 클립을 provider 요청 없이 복구했습니다.`);
    return completedResume;
  }

  if (job.providerRequestsForbidden === true) {
    throw new Error("이 실행은 Gemini provider 요청 0회로 봉인되어 새 요청을 전송할 수 없습니다.");
  }

  const launchPolicy = resolveGeminiChromeLaunchPolicy();
  assertGeminiGenerationLaunchPolicy(launchPolicy);
  if (previousGeneration?.schemaVersion === 5
    && ["failed", "running"].includes(previousGeneration.status)
    && !validGenerationRuntimeAttestation(previousGeneration.providerAttestation, job)) {
    throw new Error("기존 Gemini 영수증에 실제 CDP runtime 증명이 없습니다. historical 영수증을 무시하고 새 요청을 전송하지 않습니다.");
  }
  const resolveBrowserVersionFn = dependencies.resolveBrowserVersionFn || resolveBrowserVersion;
  const observeGeminiGenerationRuntimeFn = dependencies.observeGeminiGenerationRuntimeFn || observeGeminiGenerationRuntime;
  const connectBrowserFn = dependencies.connectBrowserFn || connectBrowser;
  const version = await resolveBrowserVersionFn(config, createGeminiBrowserRuntime(), launchPolicy);
  const runtime = assertGeminiChromeRuntime(version, launchPolicy);
  const observedRuntime = await observeGeminiGenerationRuntimeFn(config, version, launchPolicy);
  if (!validateGeminiObservedRuntimeProof(observedRuntime?.proof, job)
    || observedRuntime?.proofHash !== geminiObservedRuntimeProofHash(observedRuntime.proof)) {
    throw new Error("실제 Gemini Chrome runtime 관측 증명을 신뢰할 수 없습니다. target을 만들거나 요청을 전송하지 않습니다.");
  }
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: version.Browser || null,
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: runtime.actualHeadless,
    headlessRequested: launchPolicy.headless,
    chromeMajor: runtime.chromeMajor,
    headlessImplementation: launchPolicy.headlessImplementation,
    runtimeProof: observedRuntime.proof,
    runtimeProofHash: observedRuntime.proofHash,
    fallbackUsed: false
  };
  const providerAttestationHash = hashJson(providerAttestation);
  if (!validGenerationRuntimeAttestation(providerAttestation, job)) {
    throw new Error("Gemini Chrome version endpoint와 실제 browser-scope CDP 증명이 일치하지 않습니다. target을 만들거나 요청을 전송하지 않습니다.");
  }
  if (partialResumePreflight.required
    && partialResumePreflight.providerAttestationHash !== providerAttestationHash) {
    throw new Error("기존 Gemini 완료 클립의 실제 Chrome runtime attestation이 현재 관측과 일치하지 않습니다. target을 만들거나 새 요청을 전송하지 않습니다.");
  }
  const pendingIndex = Number(previousGeneration?.pendingSegment?.index);
  const pendingScriptSegment = Number.isInteger(pendingIndex) ? script.segments[pendingIndex - 1] : null;
  const pendingPrompt = pendingScriptSegment ? buildGeminiClipPrompt(job, script, pendingScriptSegment) : "";
  const pendingPromptBinding = pendingScriptSegment
    ? providerPromptBindingForSegment(pendingScriptSegment, "gemini-browser")
    : null;
  const recoveryDecision = geminiPendingRecoveryDecision(previousGeneration, {
    jobId: job.id,
    index: pendingIndex,
    prompt: pendingPrompt,
    requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    sessionBindingHash,
    providerDecisionHash,
    providerAttestationHash,
    providerVisualPromptHash: pendingPromptBinding?.providerVisualPromptHash || null,
    shotPattern: pendingPromptBinding?.shotPattern || null
  });
  if (previousGeneration?.pendingSegment && !recoveryDecision.eligible) {
    throw new Error(`Gemini 제출 체크포인트가 현재 실행과 안전하게 결속되지 않습니다 (${recoveryDecision.reason}). 중복 생성을 막기 위해 새 요청을 전송하지 않습니다.`);
  }

  const browser = await connectBrowserFn(config, {
    version,
    policy: launchPolicy,
    runtimeAttestation: true,
    expectedRuntimeProofHash: observedRuntime.proofHash,
    resumeTarget: recoveryDecision.eligible ? recoveryDecision.checkpoint : null
  });
  if (browser.runtimeProofHash !== observedRuntime.proofHash) {
    await browser.close({
      preserveTarget: recoveryDecision.eligible,
      forceFreshTargetCleanup: !recoveryDecision.eligible
    }).catch(() => {});
    throw new Error("Gemini Chrome runtime이 target 연결 중 변경되었습니다. 새 요청을 전송하지 않습니다.");
  }
  const previousRecoveryAttempts = Array.isArray(previousGeneration?.recoveryAttempts)
    ? previousGeneration.recoveryAttempts.map((attempt) => attempt?.completedAt ? attempt : {
      ...attempt,
      completedAt: new Date().toISOString(),
      status: "interrupted-before-checkpoint-completion",
      errorCode: "GEMINI_RECOVERY_PROCESS_INTERRUPTED"
    })
    : [];
  const previousSegments = new Map((previousGeneration?.segments || []).map((segment) => [segment.index, segment]));
  const generation = {
    schemaVersion: 5,
    jobId: job.id,
    provider: "gemini-browser",
    sessionBinding,
    sessionBindingHash,
    browser: version.Browser || null,
    startedAt: new Date().toISOString(),
    status: "running",
    runId: job.runId || null,
    requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    requestScriptHash: requestHash,
    providerAttestation,
    providerAttestationHash,
    providerDecision,
    providerDecisionHash,
    request: requestPayload,
    legacySubmissionAbandonment: retainedLegacyAbandonment.receipt,
    legacySubmissionAbandonmentEvidence: retainedLegacyAbandonment.evidence,
    legacySubmissionAbandonmentConsumptions: [...retainedLegacyAbandonment.consumptions],
    resultWaitPolicy: {
      timeoutMs,
      minimumMs: MIN_VIDEO_TIMEOUT_MS,
      maximumMs: MAX_VIDEO_TIMEOUT_MS,
      timerStartsAfter: "verified-submission-and-durable-checkpoint",
      preserveConversationTargetWhilePending: true
    },
    resumedFrom: ["failed", "running"].includes(previousGeneration?.status)
      ? previousGeneration.completedAt || previousGeneration.startedAt || null
      : null,
    pendingSegment: null,
    recoveryAttempts: previousRecoveryAttempts,
    recoveredPendingSegments: Array.isArray(previousGeneration?.recoveredPendingSegments)
      ? previousGeneration.recoveredPendingSegments
      : [],
    segments: [],
    rejectedResumes: [],
    providerRequestSentThisRun: false,
    inheritedProviderSubmission: false,
    submissionRunIds: []
  };
  await mkdir(clipsDir, { recursive: true });
  const bindingMatches = previousGeneration?.requestHash === requestHash
    && previousGeneration?.scriptHash === scriptHash
    && previousGeneration?.resumeRequestHash === resumeRequestHash
    && previousGeneration?.resumeScriptHash === resumeScriptHash;
  const resumeSessionMatches = previousGeneration?.provider === "gemini-browser"
    && previousGeneration.providerDecisionHash === providerDecisionHash
    && previousGeneration.providerAttestationHash === providerAttestationHash
    && previousGeneration.sessionBindingHash === sessionBindingHash
    && hashJson(previousGeneration.sessionBinding) === sessionBindingHash;
  const previousSegmentsBound = Boolean(
    previousGeneration?.runId
    && previousGeneration?.requestHash
    && previousGeneration?.scriptHash
    && previousGeneration?.resumeRequestHash
    && previousGeneration?.resumeScriptHash
    && Array.isArray(previousGeneration?.segments)
    && previousGeneration.segments.every((segment) => (
      segment.runId === previousGeneration.runId
      && segment.requestHash === previousGeneration.requestHash
      && segment.scriptHash === previousGeneration.scriptHash
      && segment.resumeRequestHash === previousGeneration.resumeRequestHash
      && segment.resumeScriptHash === previousGeneration.resumeScriptHash
      && segment.providerDecisionHash === previousGeneration.providerDecisionHash
      && segment.providerAttestationHash === previousGeneration.providerAttestationHash
      && segment.path === segment.output
    ))
  );
  const canResumePartial = partialResumePreflight.required
    && bindingMatches
    && resumeSessionMatches
    && previousSegmentsBound;
  let preserveTarget = false;

  const completeSegment = async ({ index, segment, target, prompt, acknowledgement, bytes, recovered = false, recoverySource = null }) => {
    const publishDurableGeminiClipFn = dependencies.publishDurableGeminiClipFn || publishDurableGeminiClip;
    const publishedClip = await publishDurableGeminiClipFn({ targetPath: target, bytes, format: job.format });
    const path = `clips/${String(index).padStart(2, "0")}.mp4`;
    const providerPromptBinding = providerPromptBindingForSegment(segment, "gemini-browser");
    const pendingBeforeCompletion = generation.pendingSegment;
    const targetConversation = geminiTargetConversationLineage(
      pendingBeforeCompletion?.targetId,
      pendingBeforeCompletion?.conversationUrl
    );
    const completedSegment = {
      index,
      runId: job.runId || null,
      submissionRunId: recoverySource?.submissionRunId || recoverySource?.runId || job.runId || null,
      requestHash,
      scriptHash,
      resumeRequestHash,
      resumeScriptHash,
      durationHint: segment.durationHint || null,
      prompt,
      promptHash: hashJson({ prompt }),
      providerVisualPromptHash: providerPromptBinding.providerVisualPromptHash,
      shotPattern: providerPromptBinding.shotPattern,
      targetConversationLineage: targetConversation.lineage,
      targetConversationLineageHash: targetConversation.lineageHash,
      submittedToProvider: true,
      ...geminiSegmentSubmissionLineage(recovered ? previousGeneration : null, recovered !== true),
      submissionAcknowledgement: acknowledgement,
      path,
      output: path,
      sha256: publishedClip.sha256,
      providerDecisionHash,
      providerAttestationHash,
      ...(recovered ? {
        recovered: true,
        sourceSubmittedAt: recoverySource?.submittedAt || null
      } : {})
    };
    generation.segments.push(completedSegment);
    refreshGeminiSubmissionSummary(generation);
    generation.pendingSegment = null;
    try {
      await writeGeminiGenerationCheckpoint(generationPath, generation);
    } catch (error) {
      generation.segments.pop();
      refreshGeminiSubmissionSummary(generation);
      generation.pendingSegment = pendingBeforeCompletion;
      throw error;
    }
  };

  try {
    for (let index = 0; index < script.segments.length; index += 1) {
      const segmentNumber = index + 1;
      const segment = script.segments[index];
      const prompt = buildGeminiClipPrompt(job, script, segment);
      const target = join(clipsDir, `${String(segmentNumber).padStart(2, "0")}.mp4`);
      const previousSegment = previousSegments.get(segmentNumber);
      const existingHashMatches = canResumePartial
        && previousSegment?.sha256
        && existsSync(target)
        && await hashFile(target).catch(() => null) === previousSegment.sha256;
      const existingFormatMatches = existingHashMatches ? await clipMatchesFormat(target, job.format) : false;
      const mustReusePriorSegment = canResumePartial && segmentNumber <= previousGeneration.segments.length;
      if (mustReusePriorSegment && (!existingHashMatches || !existingFormatMatches)) {
        throw new Error(`${segmentNumber}번 기존 Gemini 완료 클립이 사전 검증 이후 변경되었습니다. 새 요청을 전송하지 않습니다.`);
      }
      if (existingHashMatches && existingFormatMatches) {
        const path = `clips/${String(segmentNumber).padStart(2, "0")}.mp4`;
        generation.segments.push({
          ...previousSegment,
          index: segmentNumber,
          runId: job.runId || null,
          requestHash,
          scriptHash,
          resumeRequestHash,
          resumeScriptHash,
          path,
          output: path,
          submissionRunId: previousSegment.submissionRunId,
          ...geminiSegmentSubmissionLineage(previousGeneration, false),
          sourceRequestHash: previousGeneration.requestHash,
          sourceScriptHash: previousGeneration.scriptHash,
          resumeHops: [
            ...(Array.isArray(previousSegment.resumeHops) ? previousSegment.resumeHops : []),
            { fromRunId: previousGeneration.runId, toRunId: job.runId || null, resumedAt: new Date().toISOString() }
          ],
          providerDecisionHash,
          providerAttestationHash,
          resumed: true
        });
        refreshGeminiSubmissionSummary(generation);
        await onProgress(Math.round((segmentNumber / script.segments.length) * 100), `${segmentNumber}/${script.segments.length} 기존 Gemini 클립을 재사용했습니다.`);
        continue;
      }
      if (recoveryDecision.eligible && segmentNumber < pendingIndex) {
        throw new Error(`Gemini 대기 결과를 복구하기 전 ${segmentNumber}번 선행 클립의 결속을 확인하지 못했습니다. 중복 요청을 전송하지 않습니다.`);
      }
      if (existingHashMatches && !existingFormatMatches) {
        generation.rejectedResumes.push({
          index: segmentNumber,
          path: `clips/${String(segmentNumber).padStart(2, "0")}.mp4`,
          expectedFormat: job.format,
          reason: "format-mismatch"
        });
      }

      if (recoveryDecision.eligible && segmentNumber === pendingIndex) {
        const checkpoint = recoveryDecision.checkpoint;
        const submissionRunId = checkpoint.submissionRunId || checkpoint.runId;
        const recoveryAttempt = {
          attempt: generation.recoveryAttempts.length + 1,
          runId: job.runId || null,
          submissionRunId,
          startedAt: new Date().toISOString(),
          checkpointStatus: checkpoint.status,
          targetId: checkpoint.targetId
        };
        generation.recoveryAttempts.push(recoveryAttempt);
        generation.pendingSegment = {
          ...checkpoint,
          submissionRunId,
          runId: job.runId || null,
          requestHash,
          scriptHash,
          resumeRequestHash,
          resumeScriptHash,
          sessionBindingHash,
          providerDecisionHash,
          providerAttestationHash,
          recoverySourceRunId: submissionRunId,
          recoveryStartedAt: new Date().toISOString(),
          timeoutMs
        };
        preserveTarget = true;
        await writeGeminiGenerationCheckpoint(generationPath, generation);
        let recoveredConversationUrl = canonicalGeminiConversationUrl(checkpoint.conversationUrl);
        if (checkpoint.status === "submit-intent") {
          const observation = await inspectPromptSubmission(browser, prompt);
          const intentInspection = inspectGeminiSubmitIntent(checkpoint, prompt, observation);
          generation.pendingSegment.lastIntentInspection = {
            inspectedAt: new Date().toISOString(),
            result: intentInspection.reason,
            promptCleared: intentInspection.evidence?.promptCleared === true,
            evidenceTypes: intentInspection.evidence?.evidenceTypes || [],
            observationHash: hashJson({
              promptFieldVisible: observation.promptFieldVisible === true,
              promptValueHash: hashJson({ promptValue: String(observation.promptValue || "") }),
              userMessageMatchCount: Number(observation.userMessageMatchCount || 0),
              stopResponseCount: Number(observation.stopResponseCount || 0),
              generationEvidenceCount: Number(observation.generationEvidenceCount || 0),
              generationEvidenceKeys: (observation.generationEvidenceKeys || []).map(submissionEvidenceKeyHash).sort(),
              conversationUrl: canonicalGeminiConversationUrl(observation.conversationUrl)
            })
          };
          if (!intentInspection.promotable) {
            await writeGeminiGenerationCheckpoint(generationPath, generation);
            throw new Error("Gemini submit intent의 기존 탭에서 강한 post-click 증거를 확인하지 못했습니다. 클릭하거나 새 요청을 보내지 않고 탭을 보존합니다.");
          }
          generation.pendingSegment.status = "ambiguous-submitted";
          generation.pendingSegment.submittedToProvider = true;
          generation.pendingSegment.submittedAt = new Date().toISOString();
          generation.pendingSegment.submissionAcknowledgement = {
            verified: true,
            clickCount: 1,
            evidenceTypes: intentInspection.evidence.evidenceTypes,
            recoveredFromPreClickIntent: true
          };
          recoveredConversationUrl = canonicalGeminiConversationUrl(observation.conversationUrl);
          await writeGeminiGenerationCheckpoint(generationPath, generation);
        }
        if (!recoveredConversationUrl) {
          recoveredConversationUrl = await waitForConversationBinding(browser, {
            conversationUrl: browser.recoveryTargetSelection?.conversationUrl || null
          });
          if (!recoveredConversationUrl) {
            recoveryAttempt.completedAt = new Date().toISOString();
            recoveryAttempt.status = "conversation-url-unresolved";
            await writeGeminiGenerationCheckpoint(generationPath, generation);
            throw new Error("Gemini 전송 가능성 체크포인트의 기존 탭은 찾았지만 30초 안에 대화 URL을 결속하지 못했습니다. 새 요청을 전송하지 않습니다.");
          }
        }
        generation.pendingSegment.status = "submitted-awaiting-result";
        generation.pendingSegment.conversationUrl = recoveredConversationUrl;
        generation.pendingSegment.conversationBoundAt ||= new Date().toISOString();
        await writeGeminiGenerationCheckpoint(generationPath, generation);
        await onProgress(Math.round((index / script.segments.length) * 100), `${segmentNumber}/${script.segments.length} 제출된 Gemini 대화에서 늦게 도착한 결과를 회수하는 중입니다.`);
        const waitStartedAt = Date.now();
        generation.pendingSegment.waitStartedAt = new Date(waitStartedAt).toISOString();
        generation.pendingSegment.waitDeadlineAt = new Date(waitStartedAt + timeoutMs).toISOString();
        await writeGeminiGenerationCheckpoint(generationPath, generation);
        const bytes = await waitForClip(browser, deserializeKnownMedia(checkpoint.knownMedia), waitStartedAt + timeoutMs, timeoutMs, recoveredConversationUrl);
        const acknowledgement = {
          ...generation.pendingSegment.submissionAcknowledgement,
          recoveredFromCheckpoint: true,
          sourceRunId: submissionRunId
        };
        await completeSegment({ index: segmentNumber, segment, target, prompt, acknowledgement, bytes, recovered: true, recoverySource: checkpoint });
        recoveryAttempt.completedAt = new Date().toISOString();
        recoveryAttempt.status = "recovered";
        generation.recoveredPendingSegments.push({ index: segmentNumber, sourceRunId: submissionRunId, recoveredAt: new Date().toISOString() });
        await writeGeminiGenerationCheckpoint(generationPath, generation);
        await onProgress(Math.round((segmentNumber / script.segments.length) * 100), `${segmentNumber}/${script.segments.length} 기존 Gemini 대화의 결과를 회수했습니다.`);
        continue;
      }

      await onProgress(Math.round((index / script.segments.length) * 100), `${segmentNumber}/${script.segments.length} 장면을 Gemini에 요청하는 중입니다.`);
      await browser.navigate("https://gemini.google.com/videos");
      const tool = await clickVideoTool(browser, job.format);
      if (tool.authRequired) throw new Error("Gemini 전용 프로필의 로그인 세션이 만료되었습니다. GEMINI_CHROME_HEADLESS=0으로 같은 프로필을 열어 직접 로그인한 뒤 headless로 다시 시작하세요.");
      if (tool.quota) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${tool.quotaMessage || "할당량 갱신이 필요합니다."}`);
      if (!tool.clicked) throw new Error(`Gemini 동영상 도구를 찾지 못했습니다. 화면에 "동영상 만들기"가 활성화되어 있는지 확인하세요. 감지된 버튼: ${(tool.buttons || []).join(", ")}`);
      if (tool.ratioConfigured !== true) throw new Error(`Gemini에서 ${job.format === "vertical" ? "세로 9:16" : "가로 16:9"} 화면비를 선택하지 못했습니다. 생성 요청을 보내지 않고 재시도합니다.`);
      const filled = await fillPrompt(browser, prompt);
      if (!filled.filled) throw new Error("Gemini 입력창을 찾지 못했습니다.");
      if (filled.promptReady !== true) {
        const promptError = new Error("Gemini 입력창에 원문 prompt가 완전히 반영되지 않았습니다. 요청을 전송하지 않습니다.");
        promptError.code = "GEMINI_PROMPT_FILL_MISMATCH";
        promptError.promptReadinessDiagnostics = filled.diagnostics;
        throw promptError;
      }
      const submissionRatio = await verifyVideoAspectRatio(browser, job.format);
      if (submissionRatio?.configured !== true) {
        throw new Error(`Gemini에서 ${job.format === "vertical" ? "세로 9:16" : "가로 16:9"} 화면비의 선택 상태를 전송 직전에 확인하지 못했습니다. 생성 요청을 보내지 않고 재시도합니다.`);
      }
      const known = await inspectMedia(browser);
      const knownMedia = deserializeKnownMedia(serializeKnownMedia({
        videos: new Set((known.videos || []).map((video) => video.src).filter(Boolean)),
        links: new Set((known.links || []).map((item) => item.href).filter(Boolean)),
        chats: new Set((known.chats || []).map((item) => item.href).filter(Boolean))
      }));
      let submittedAt = null;
      const providerPromptBinding = providerPromptBindingForSegment(segment, "gemini-browser");
      const submitted = await submitPrompt(browser, prompt, job.format, {
        onBeforeInitialClick: async (baselineObservation) => {
          if (retainedLegacyAbandonment.receipt) {
            const legacyConsumption = await attestLegacyGeminiAbandonmentConsumption({
              job,
              generation: { ...generation, pendingSegment: {
                index: segmentNumber,
                submissionRunId: job.runId || null,
                promptHash: hashJson({ prompt })
              } },
              abandonmentReceipt: retainedLegacyAbandonment.receipt,
              currentTargetId: browser.targetId,
              runId: job.runId || null,
              requestHash,
              resumeRequestHash,
              segmentIndex: segmentNumber,
              promptHash: hashJson({ prompt })
            });
            generation.legacySubmissionAbandonmentConsumptions.push(legacyConsumption);
          }
          generation.pendingSegment = {
            schemaVersion: 2,
            status: "submit-intent",
            index: segmentNumber,
            runId: job.runId || null,
            submissionRunId: job.runId || null,
            requestHash,
            scriptHash,
            resumeRequestHash,
            resumeScriptHash,
            sessionBindingHash,
            providerDecisionHash,
            providerAttestationHash,
            durationHint: segment.durationHint || null,
            prompt,
            promptHash: hashJson({ prompt }),
            providerVisualPromptHash: providerPromptBinding.providerVisualPromptHash,
            shotPattern: providerPromptBinding.shotPattern,
            submittedToProvider: null,
            submissionMayHaveOccurred: true,
            intentCreatedAt: new Date().toISOString(),
            clickPolicy: "single-attempt-no-automatic-retry",
            conversationUrl: null,
            targetId: browser.targetId,
            knownMedia: serializeKnownMedia(knownMedia),
            submissionBaseline: createGeminiSubmissionBaseline(prompt, baselineObservation),
            submissionAcknowledgement: null,
            timeoutMs
          };
          preserveTarget = true;
          try {
            await writeGeminiGenerationCheckpoint(generationPath, generation);
          } catch (checkpointError) {
            checkpointError.code = "GEMINI_SUBMIT_INTENT_CHECKPOINT_FAILED";
            throw checkpointError;
          }
        },
        onVerified: async (verifiedSubmission) => {
          if (generation.pendingSegment?.status !== "submit-intent") {
            throw new Error("Gemini submit intent 체크포인트가 없습니다.");
          }
          submittedAt = new Date().toISOString();
          generation.pendingSegment.status = "ambiguous-submitted";
          generation.pendingSegment.submittedToProvider = true;
          generation.pendingSegment.submittedAt = submittedAt;
          generation.pendingSegment.submissionAcknowledgement = {
            verified: true,
            clickCount: verifiedSubmission.clickCount,
            evidenceTypes: verifiedSubmission.evidenceTypes
          };
          try {
            await writeGeminiGenerationCheckpoint(generationPath, generation);
          } catch (checkpointError) {
            checkpointError.code = "GEMINI_SUBMISSION_CHECKPOINT_FAILED";
            throw checkpointError;
          }
        }
      });
      if (!submitted.submitted || submitted.verified !== true) {
        const submissionError = new Error(`Gemini 영상 요청 전송을 확인하지 못했습니다 (${submitted.reason || "authoritative-submit-evidence-missing"}). 입력창 초기화와 사용자 메시지·응답 중지·생성 상태 중 하나를 함께 확인해야 합니다.`);
        if (submitted.diagnostics) {
          submissionError.code = "GEMINI_PROMPT_SUBMISSION_NOT_READY";
          submissionError.promptReadinessDiagnostics = submitted.diagnostics;
        }
        throw submissionError;
      }
      if (!submittedAt || generation.pendingSegment?.status !== "ambiguous-submitted") {
        throw new Error("Gemini 제출 확인 체크포인트가 저장되지 않았습니다. 대화 탭을 보존하고 중복 요청을 차단합니다.");
      }
      const conversationUrl = await waitForConversationBinding(browser, submitted.observation || {});
      if (!conversationUrl) {
        throw new Error("Gemini 요청은 전송됐지만 대화 URL을 안전하게 결속하지 못했습니다. 대화 탭을 보존하고 중복 요청을 차단합니다.");
      }
      generation.pendingSegment.status = "submitted-awaiting-result";
      generation.pendingSegment.conversationUrl = conversationUrl;
      generation.pendingSegment.conversationBoundAt = new Date().toISOString();
      await writeGeminiGenerationCheckpoint(generationPath, generation);
      const waitStartedAt = Date.now();
      generation.pendingSegment.waitStartedAt = new Date(waitStartedAt).toISOString();
      generation.pendingSegment.waitDeadlineAt = new Date(waitStartedAt + timeoutMs).toISOString();
      await writeGeminiGenerationCheckpoint(generationPath, generation);
      const bytes = await waitForClip(browser, knownMedia, waitStartedAt + timeoutMs, timeoutMs, conversationUrl);
      await completeSegment({
        index: segmentNumber,
        segment,
        target,
        prompt,
        acknowledgement: generation.pendingSegment.submissionAcknowledgement,
        bytes
      });
      await onProgress(Math.round((segmentNumber / script.segments.length) * 100), `${segmentNumber}/${script.segments.length} 장면 다운로드 완료`);
    }
  } catch (error) {
    preserveTarget = Boolean(generation.pendingSegment);
    generation.status = "failed";
    const failureEvidence = createGeminiFailureEvidence(error, { phase: "pipeline" });
    const safeErrorCode = /^GEMINI_[A-Z0-9_]{1,95}$/.test(String(error.code || ""))
      ? String(error.code)
      : "GEMINI_PROVIDER_FAILURE";
    generation.error = failureEvidence.reasonCode;
    generation.errorEvidence = failureEvidence;
    generation.errorCode = safeErrorCode;
    if (error.promptReadinessDiagnostics) {
      generation.promptReadinessFailure = {
        schemaVersion: 1,
        code: safeErrorCode,
        recordedAt: new Date().toISOString(),
        ...error.promptReadinessDiagnostics
      };
    }
    const recoveryAttempt = generation.recoveryAttempts.at(-1);
    if (recoveryAttempt?.runId === (job.runId || null) && !recoveryAttempt.completedAt) {
      recoveryAttempt.completedAt = new Date().toISOString();
      recoveryAttempt.status = "failed";
      recoveryAttempt.errorCode = safeErrorCode;
    }
    if (generation.pendingSegment) {
      generation.pendingSegment.lastFailureAt = new Date().toISOString();
      generation.pendingSegment.lastFailureCode = safeErrorCode;
      generation.pendingSegment.targetPreservationRequested = true;
    }
    throw error;
  } finally {
    const closeResult = await browser.close({ preserveTarget });
    if (generation.pendingSegment) {
      generation.pendingSegment.targetPreservation = {
        requested: preserveTarget,
        closeTargetCommandSent: !preserveTarget,
        cdpSessionDetached: closeResult.sessionDetached,
        targetId: closeResult.targetId,
        recordedAt: new Date().toISOString()
      };
    }
    if (generation.status === "running") generation.status = "completed";
    generation.completedAt = new Date().toISOString();
    await writeGeminiGenerationCheckpoint(generationPath, generation);
  }
  return generation;
}
export async function startGeminiBrowser(input = {}, options = {}) {
  const config = browserConfig(input);
  const browserRuntime = createGeminiBrowserRuntime(input, options);
  const policy = resolveGeminiChromeLaunchPolicy();
  let version;
  try {
    version = await getVersion(config.cdpUrl, browserRuntime);
  } catch (error) {
    if (isGeminiBrowserBoundaryError(error)) throw error;
    version = await startChrome(config, browserRuntime, policy);
    const startedRuntime = assertGeminiChromeRuntime(version, policy);
    assertGeminiBrowserRuntimeActive(browserRuntime);
    return { connected: true, started: true, browser: version.Browser || "Chrome", headless: startedRuntime.actualHeadless, requestedHeadless: policy.headless, chromeMajor: startedRuntime.chromeMajor };
  }
  const attestedRuntime = assertGeminiChromeRuntime(version, policy);
  assertGeminiBrowserRuntimeActive(browserRuntime);
  return { connected: true, started: false, browser: version.Browser || "Chrome", headless: attestedRuntime.actualHeadless, requestedHeadless: policy.headless, chromeMajor: attestedRuntime.chromeMajor };
}
