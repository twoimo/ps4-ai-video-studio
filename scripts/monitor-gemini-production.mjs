import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { geminiQuotaStatus, isGeminiBrowserAbortError, isGeminiBrowserDeadlineError, readGeminiGenerationReceipt, startGeminiBrowser } from "../src/gemini-browser.mjs";
import { automatedReviewCheckpointPath, runAutomatedQualityReview } from "../src/automated-review.mjs";
import { geminiSessionBindingHash } from "../src/provenance.mjs";
import { verifyStrictGeminiRecoverySourceReceipt } from "../src/gemini-submission-lineage.mjs";
import { publishUltragoalResumeSignal } from "../src/ultragoal-signal.mjs";
import {
  acquireGeminiMonitorLease,
  monitorDiagnosticEvidence,
  persistGeminiMonitorEvent,
  projectGeminiMonitorProfileObservation,
  readRedactedGeminiMonitorState,
  redactGeminiMonitor,
  scrubGeminiMonitorArtifacts,
  writePrivateJson
} from "../src/gemini-monitor-privacy.mjs";
import { closeFd, openDirectoryAt, openFileAt, sameFdIdentity, statFd } from "../src/dirfd.mjs";

const root = resolve(import.meta.dirname, "..");
const workspaceDir = join(root, "workspace");
const statePath = join(workspaceDir, "gemini-monitor.json");
const logPath = join(workspaceDir, "gemini-monitor.jsonl");
const monitorLeasePath = join(workspaceDir, ".runtime", "gemini-monitor.lock");
const studioTokenPath = process.env.PS4_STUDIO_TOKEN_FILE || join(workspaceDir, ".runtime", "studio-token");
const ultragoalSignalPath = process.env.GEMINI_ULTRAGOAL_SIGNAL_PATH || join(workspaceDir, "ultragoal-resume-request.json");
const automatedReviewRoot = process.env.GEMINI_AUTOMATED_REVIEW_CHECKPOINT_ROOT || join(workspaceDir, "automated-review");
export function resolveMonitorApiBase(value = "http://127.0.0.1:3000") {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("PS4_API_BASE는 exact loopback HTTP origin이어야 합니다.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "http:" || !loopback || parsed.username || parsed.password || !parsed.port || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("PS4_API_BASE는 경로·자격증명 없는 exact loopback HTTP origin이어야 합니다.");
  }
  return parsed.origin;
}

const apiBase = resolveMonitorApiBase(process.env.PS4_API_BASE || "http://127.0.0.1:3000");
const pollMs = Math.max(30_000, Number(process.env.GEMINI_MONITOR_INTERVAL_MS || 300_000));
const jobPollMs = Math.max(3_000, Number(process.env.GEMINI_JOB_POLL_INTERVAL_MS || 10_000));
const maxRuntimeMs = Math.max(60_000, Number(process.env.GEMINI_MONITOR_MAX_RUNTIME_MS || 7 * 24 * 60 * 60 * 1000));
const retryLimit = Math.max(1, Math.min(5, Number(process.env.GEMINI_MONITOR_RETRY_LIMIT || 3)));
const jobPollWindowMs = Math.max(jobPollMs * 3, Number(process.env.GEMINI_JOB_POLL_WINDOW_MS || 10 * 60 * 1000));
const topic = process.env.GEMINI_MONITOR_TOPIC || "경복궁 마당이 평평해 보여도 울퉁불퉁한 이유";
export function resolveMonitorClipPlan(environment = process.env) {
  const configuredClipCount = Number(environment.GEMINI_MONITOR_CLIP_COUNT || 2);
  const clipCount = Math.max(2, Math.min(12, Math.trunc(Number.isFinite(configuredClipCount) ? configuredClipCount : 2)));
  const defaultDuration = Math.min(110, clipCount * 10);
  const configuredDuration = Number(environment.GEMINI_MONITOR_TARGET_DURATION_SEC || defaultDuration);
  const targetDurationSec = Math.max(20, Math.min(180, Number.isFinite(configuredDuration) ? configuredDuration : defaultDuration));
  return { clipCount, targetDurationSec };
}

function monitorTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && monitorIso(parsed) === normalized ? parsed : null;
}

function monitorIso(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

/**
 * Resolves one process-independent runtime window. A restart reuses the
 * persisted deadline, or migrates a legacy record by anchoring the deadline to
 * its original startedAt. Invalid persisted boundaries expire immediately so a
 * corrupt state can never grant a fresh generation window.
 */
export function resolveMonitorRuntimeWindow({ persistedState = null, now = new Date(), maxRuntimeMs: configuredMaxRuntimeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const parsedNow = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const safeNow = Number.isFinite(parsedNow) && monitorIso(parsedNow) ? parsedNow : 0;
  const runtimeMs = Number(configuredMaxRuntimeMs);
  const resumed = Boolean(persistedState && typeof persistedState === "object" && !Array.isArray(persistedState));
  const invalid = (reason) => ({
    valid: false,
    resumed,
    expired: true,
    reason,
    source: "invalid",
    startedAt: null,
    deadlineAt: monitorIso(safeNow),
    deadlineMs: safeNow
  });

  if (!Number.isFinite(parsedNow) || !monitorIso(parsedNow)) return invalid("invalid-now");
  if (!Number.isFinite(runtimeMs) || runtimeMs < 60_000) return invalid("invalid-max-runtime");

  if (!resumed) {
    const deadlineMs = parsedNow + runtimeMs;
    const deadlineAt = monitorIso(deadlineMs);
    if (!deadlineAt) return invalid("runtime-overflow");
    return {
      valid: true,
      resumed: false,
      expired: false,
      reason: null,
      source: "new",
      startedAt: monitorIso(parsedNow),
      deadlineAt,
      deadlineMs
    };
  }

  const startedMs = monitorTimestamp(persistedState.startedAt);
  if (startedMs === null) return invalid("invalid-started-at");
  if (startedMs > parsedNow) return invalid("future-started-at");
  const maximumDeadlineMs = startedMs + runtimeMs;
  if (!monitorIso(maximumDeadlineMs)) return invalid("runtime-overflow");

  const hasPersistedDeadline = Object.hasOwn(persistedState, "deadlineAt");
  let deadlineMs = maximumDeadlineMs;
  let source = "derived-from-started-at";
  if (hasPersistedDeadline) {
    const persistedDeadlineMs = monitorTimestamp(persistedState.deadlineAt);
    if (persistedDeadlineMs === null) return invalid("invalid-deadline-at");
    if (persistedDeadlineMs < startedMs) return invalid("deadline-before-start");
    deadlineMs = Math.min(persistedDeadlineMs, maximumDeadlineMs);
    source = persistedDeadlineMs > maximumDeadlineMs ? "persisted-clamped" : "persisted";
  }

  const persistedTerminal = persistedState.status === "deadline-reached";
  const expired = persistedTerminal || parsedNow >= deadlineMs;
  return {
    valid: true,
    resumed: true,
    expired,
    reason: persistedTerminal ? "persisted-deadline-reached" : expired ? "runtime-expired" : null,
    source,
    startedAt: monitorIso(startedMs),
    deadlineAt: monitorIso(deadlineMs),
    deadlineMs
  };
}

/**
 * Clamps any monitor-owned wait or polling window to the persisted runtime
 * deadline. Explicit timestamps keep this helper pure and fake-time testable.
 */
export function monitorRuntimeSubwindow({
  nowMs,
  runtimeDeadlineMs,
  localDeadlineMs = null,
  requestedWaitMs = 0
} = {}) {
  const parsedNow = Number(nowMs);
  const parsedRuntimeDeadline = Number(runtimeDeadlineMs);
  const parsedLocalDeadline = localDeadlineMs === null || localDeadlineMs === undefined
    ? parsedRuntimeDeadline
    : Number(localDeadlineMs);
  const safeNow = Number.isFinite(parsedNow) ? parsedNow : 0;
  const invalid = !Number.isFinite(parsedNow)
    || !Number.isFinite(parsedRuntimeDeadline)
    || !Number.isFinite(parsedLocalDeadline)
    || !monitorIso(parsedNow)
    || !monitorIso(parsedRuntimeDeadline)
    || !monitorIso(parsedLocalDeadline);
  if (invalid) {
    return {
      valid: false,
      expired: true,
      deadlineMs: safeNow,
      deadlineAt: monitorIso(safeNow),
      remainingRuntimeMs: 0,
      remainingSubwindowMs: 0,
      waitMs: 0,
      nextCheckAt: monitorIso(safeNow)
    };
  }

  const deadlineMs = Math.min(parsedRuntimeDeadline, parsedLocalDeadline);
  const remainingRuntimeMs = Math.max(0, parsedRuntimeDeadline - parsedNow);
  const remainingSubwindowMs = Math.max(0, deadlineMs - parsedNow);
  const requested = Number(requestedWaitMs);
  const safeRequestedWaitMs = Number.isFinite(requested) && requested > 0 ? requested : 0;
  const waitMs = Math.min(safeRequestedWaitMs, remainingSubwindowMs);
  const nextCheckMs = Math.min(parsedNow + waitMs, deadlineMs);
  return {
    valid: true,
    expired: parsedNow >= parsedRuntimeDeadline,
    deadlineMs,
    deadlineAt: monitorIso(deadlineMs),
    remainingRuntimeMs,
    remainingSubwindowMs,
    waitMs,
    nextCheckAt: monitorIso(nextCheckMs)
  };
}
const { clipCount, targetDurationSec } = resolveMonitorClipPlan();
const quotaWakeLeadMs = Math.max(0, Number(process.env.GEMINI_QUOTA_WAKE_LEAD_MS || 30_000));
const sources = JSON.parse(process.env.GEMINI_MONITOR_SOURCES_JSON || JSON.stringify([
  {
    title: "국가유산채널 조선시대 최첨단 건축재료 박석",
    url: "https://uci.k-heritage.tv/resolver/I801%3A1501001-001-V00356?utm_source=openai"
  },
  {
    title: "국가유산포털 경복궁 근정전",
    url: "https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaAsno=0002230000000&ccbaCpno=1111102230000&pageNo=1_1_1_1&sngl=N"
  }
]));
const profileRoot = process.env.GEMINI_PROFILE_ROOT || join(process.env.HOME || "/tmp", ".ps4-ai-video-studio");
const profiles = JSON.parse(process.env.GEMINI_MONITOR_PROFILES_JSON || JSON.stringify([
  {
    id: "account-1",
    email: process.env.GEMINI_ACCOUNT_1_EMAIL || "account-1",
    cdpUrl: process.env.GEMINI_ACCOUNT_1_CDP_URL || "http://127.0.0.1:9222",
    profileDir: process.env.GEMINI_ACCOUNT_1_PROFILE_DIR || join(profileRoot, "chrome-profile")
  },
  {
    id: "account-2",
    email: process.env.GEMINI_ACCOUNT_2_EMAIL || "account-2",
    cdpUrl: process.env.GEMINI_ACCOUNT_2_CDP_URL || "http://127.0.0.1:9233",
    profileDir: process.env.GEMINI_ACCOUNT_2_PROFILE_DIR || join(profileRoot, "chrome-login-profile")
  }
]));

function normalizedPlanTopic(value) {
  return String(value || "").trim();
}

function expectedProfileBindingHash(profile) {
  if (!profile) return null;
  return geminiSessionBindingHash({
    geminiCdpUrl: profile.cdpUrl,
    geminiProfileDir: profile.profileDir
  });
}

export function monitorStartupPlanTransition({ monitorState, job, desiredPlan, configuredProfiles }) {
  if (!monitorState || !job || !desiredPlan || !Array.isArray(configuredProfiles)) {
    throw new Error("모니터 시작 계획 호환성 검사 입력이 유효하지 않습니다.");
  }
  const reasons = [];
  const selectedProfile = configuredProfiles.find((profile) => profile?.id === monitorState.profileId) || null;
  const expectedBindingHash = expectedProfileBindingHash(selectedProfile);
  const actualBindingHash = String(job.geminiSessionBindingHash || "").trim() || null;
  const desiredTopic = normalizedPlanTopic(desiredPlan.topic);
  const stateTopic = normalizedPlanTopic(monitorState.topic);
  const jobTopic = normalizedPlanTopic(job.topic);
  const desiredClipCount = Number(desiredPlan.clipCount);
  const desiredTargetDurationSec = Number(desiredPlan.targetDurationSec);

  if (stateTopic !== desiredTopic) reasons.push("state-topic");
  if (jobTopic !== desiredTopic) reasons.push("job-topic");
  if (Number(monitorState.clipCount) !== desiredClipCount) reasons.push("state-clip-count");
  if (Number(job.clipCount) !== desiredClipCount) reasons.push("job-clip-count");
  if (Number(monitorState.targetDurationSec) !== desiredTargetDurationSec) reasons.push("state-target-duration");
  if (Number(job.targetDurationSec) !== desiredTargetDurationSec) reasons.push("job-target-duration");
  if (job.provider !== "gemini-browser") reasons.push("job-provider");
  if (!selectedProfile) reasons.push("profile-id");
  if (!expectedBindingHash || actualBindingHash !== expectedBindingHash) reasons.push("profile-binding");

  const terminalRetryable = ["failed", "quota-blocked"].includes(job.status)
    && !["running", "verified", "needs-improvement", "completed"].includes(job.runStatus);
  const uniqueReasons = [...new Set(reasons)].sort();
  const supersede = terminalRetryable && uniqueReasons.length > 0;
  return {
    action: supersede ? "supersede" : "preserve",
    compatible: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    reset: supersede
      ? {
          status: "monitoring",
          jobId: null,
          runId: null,
          profileId: null,
          attempts: 0,
          topic: desiredTopic,
          clipCount: desiredClipCount,
          targetDurationSec: desiredTargetDurationSec,
          completion: null,
          lastError: null
        }
      : null,
    previousPlan: {
      jobId: job.id || monitorState.jobId || null,
      runId: job.runId || monitorState.runId || null,
      jobStatus: job.status || null,
      runStatus: job.runStatus || null,
      profileId: monitorState.profileId || null,
      topic: jobTopic || stateTopic,
      clipCount: Number(job.clipCount ?? monitorState.clipCount),
      targetDurationSec: Number(job.targetDurationSec ?? monitorState.targetDurationSec),
      sessionBindingHash: actualBindingHash
    },
    desiredPlan: {
      provider: "gemini-browser",
      topic: desiredTopic,
      clipCount: desiredClipCount,
      targetDurationSec: desiredTargetDurationSec
    }
  };
}

let state = {
  schemaVersion: 2,
  status: "starting",
  profileId: null,
  jobId: null,
  runId: null,
  topic,
  clipCount,
  targetDurationSec,
  startedAt: new Date().toISOString(),
  deadlineAt: null,
  updatedAt: new Date().toISOString(),
  attempts: 0,
  profiles: [],
  lastError: null,
  completion: null
};

let runtimeBoundary = null;
let activeRuntimeDeadlineMs = null;

async function persist(event, details = {}) {
  state = await persistGeminiMonitorEvent({
    statePath,
    logPath,
    state,
    event,
    details: runtimeBoundary ? { ...details, ...runtimeBoundary } : details
  });
}

async function writeUltragoalSignal(event, details = {}) {
  const boundValue = (key, fallback = null) => Object.hasOwn(details, key) ? details[key] : (state[key] ?? fallback);
  return publishUltragoalResumeSignal(ultragoalSignalPath, {
    event,
    goalId: "G005",
    observedAt: new Date().toISOString(),
    jobId: boundValue("jobId"),
    runId: boundValue("runId"),
    profileId: boundValue("profileId"),
    status: boundValue("status", "unknown"),
    profiles: details.profiles || state.profiles || [],
    completion: details.completion ?? state.completion ?? null
  }, {
    writeSignal: writePrivateJson
  });
}

function monitorRuntimeDeadlineError(runtimeDeadlineMs) {
  const error = new Error(`모니터 persisted runtime deadline에 도달했습니다. (${monitorIso(runtimeDeadlineMs)})`);
  error.name = "MonitorRuntimeDeadlineError";
  error.code = "MONITOR_RUNTIME_DEADLINE";
  error.deadlineAt = monitorIso(runtimeDeadlineMs);
  return error;
}

export const MONITOR_STUDIO_TOKEN_MAX_BYTES = 4 * 1024;
const MONITOR_STUDIO_TOKEN_MAX_FILE_BYTES = MONITOR_STUDIO_TOKEN_MAX_BYTES + 1;

function monitorStudioTokenError() {
  const error = new Error("로컬 Studio 인증 토큰 파일이 strict credential 정책을 충족하지 않습니다.");
  error.code = "MONITOR_STUDIO_TOKEN_UNSAFE";
  return error;
}

function assertStudioTokenReadDeadline(runtimeDeadlineMs, nowFn) {
  const deadlineMs = Number(runtimeDeadlineMs);
  const nowMs = Number(nowFn());
  if (!Number.isFinite(deadlineMs) || !monitorIso(deadlineMs) || !Number.isFinite(nowMs) || !monitorIso(nowMs)) {
    throw new TypeError("Studio token runtime deadline이 유효하지 않습니다.");
  }
  if (nowMs >= deadlineMs) throw monitorRuntimeDeadlineError(deadlineMs);
}

function sameStudioTokenFileSnapshot(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function assertStudioTokenFileSnapshot(snapshot) {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    currentUid === null
    || !snapshot?.isFile?.()
    || snapshot.nlink !== 1n
    || snapshot.uid !== currentUid
    || (snapshot.mode & 0o777n) !== 0o600n
    || snapshot.size < 1n
    || snapshot.size > BigInt(MONITOR_STUDIO_TOKEN_MAX_FILE_BYTES)
  ) throw monitorStudioTokenError();
}

function canonicalStudioTokenPath(filePath) {
  let target = resolve(filePath);
  if (process.platform === "darwin") {
    if (target === "/var" || target.startsWith("/var/")) target = `/private${target}`;
    else if (target === "/tmp" || target.startsWith("/tmp/")) target = `/private${target}`;
  }
  return target;
}

function closeStudioTokenBoundary(boundary) {
  for (const directory of [...(boundary?.directories || [])].reverse()) {
    try { closeFd(directory.fd); } catch {}
  }
}

function pinStudioTokenParent(filePath) {
  const target = canonicalStudioTokenPath(filePath);
  const name = basename(target);
  const segments = target.split("/").filter(Boolean);
  if (!name || !segments.length || name === "." || name === "..") throw monitorStudioTokenError();
  const parentSegments = segments.slice(0, -1);
  const directories = [];
  let currentFd = openSync(
    "/",
    fsConstants.O_RDONLY
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK
      | (fsConstants.O_DIRECTORY || 0)
      | (fsConstants.O_CLOEXEC || 0)
  );
  try {
    directories.push({ fd: currentFd, identity: null });
    const rootIdentity = statFd(currentFd);
    if (!rootIdentity.isDirectory()) throw monitorStudioTokenError();
    directories[0].identity = rootIdentity;
    for (const segment of parentSegments) {
      const nextFd = openDirectoryAt(currentFd, segment);
      let identity;
      try {
        identity = statFd(nextFd);
        if (!identity.isDirectory()) throw monitorStudioTokenError();
      } catch (error) {
        closeFd(nextFd);
        throw error;
      }
      directories.push({ fd: nextFd, identity });
      currentFd = nextFd;
    }
    return { target, name, parentSegments, directories, parentFd: currentFd };
  } catch (error) {
    closeStudioTokenBoundary({ directories });
    throw error;
  }
}

function assertStudioTokenBoundaryCurrent(boundary) {
  let currentFd = openSync(
    "/",
    fsConstants.O_RDONLY
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK
      | (fsConstants.O_DIRECTORY || 0)
      | (fsConstants.O_CLOEXEC || 0)
  );
  try {
    if (!sameFdIdentity(boundary.directories[0].identity, statFd(currentFd))) throw monitorStudioTokenError();
    for (let index = 0; index < boundary.parentSegments.length; index += 1) {
      const nextFd = openDirectoryAt(currentFd, boundary.parentSegments[index]);
      closeFd(currentFd);
      currentFd = nextFd;
      if (!sameFdIdentity(boundary.directories[index + 1].identity, statFd(currentFd))) {
        throw monitorStudioTokenError();
      }
    }
  } finally {
    try { closeFd(currentFd); } catch {}
  }
}

export function validateMonitorStudioToken(value) {
  if (typeof value !== "string" || value !== value.trim() || /\s|\p{Cc}|\p{Cs}/u.test(value)) {
    throw monitorStudioTokenError();
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < 32 || byteLength > MONITOR_STUDIO_TOKEN_MAX_BYTES) throw monitorStudioTokenError();
  return value;
}

/**
 * Reads the server-published bearer credential without following the leaf,
 * blocking on a special file, or trusting a pathname after the read. The
 * server writes one final LF; an exact no-LF token is accepted as well.
 */
export function readStudioTokenStrict(filePath, {
  runtimeDeadlineMs,
  now = Date.now
} = {}) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0") || typeof now !== "function") {
    throw monitorStudioTokenError();
  }
  let boundary = null;
  let tokenFd = null;
  let reopenedFd = null;
  try {
    assertStudioTokenReadDeadline(runtimeDeadlineMs, now);
    boundary = pinStudioTokenParent(filePath);

    assertStudioTokenReadDeadline(runtimeDeadlineMs, now);
    tokenFd = openFileAt(
      boundary.parentFd,
      boundary.name,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
    const openedSnapshot = fstatSync(tokenFd, { bigint: true });
    assertStudioTokenFileSnapshot(openedSnapshot);

    const buffer = Buffer.allocUnsafe(MONITOR_STUDIO_TOKEN_MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      assertStudioTokenReadDeadline(runtimeDeadlineMs, now);
      const bytesRead = readSync(tokenFd, buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MONITOR_STUDIO_TOKEN_MAX_FILE_BYTES || BigInt(offset) !== openedSnapshot.size) {
      throw monitorStudioTokenError();
    }
    const afterReadSnapshot = fstatSync(tokenFd, { bigint: true });
    assertStudioTokenFileSnapshot(afterReadSnapshot);
    if (!sameStudioTokenFileSnapshot(openedSnapshot, afterReadSnapshot)) throw monitorStudioTokenError();

    assertStudioTokenReadDeadline(runtimeDeadlineMs, now);
    assertStudioTokenBoundaryCurrent(boundary);
    reopenedFd = openFileAt(
      boundary.parentFd,
      boundary.name,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
    const reopenedSnapshot = fstatSync(reopenedFd, { bigint: true });
    assertStudioTokenFileSnapshot(reopenedSnapshot);
    if (!sameStudioTokenFileSnapshot(afterReadSnapshot, reopenedSnapshot)) throw monitorStudioTokenError();
    assertStudioTokenBoundaryCurrent(boundary);

    let serialized;
    try {
      serialized = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw monitorStudioTokenError();
    }
    const token = serialized.endsWith("\n") ? serialized.slice(0, -1) : serialized;
    assertStudioTokenReadDeadline(runtimeDeadlineMs, now);
    return validateMonitorStudioToken(token);
  } catch (error) {
    if (isMonitorRuntimeDeadlineError(error) || error instanceof TypeError && error.message === "Studio token runtime deadline이 유효하지 않습니다.") {
      throw error;
    }
    throw monitorStudioTokenError();
  } finally {
    if (reopenedFd !== null) try { closeSync(reopenedFd); } catch {}
    if (tokenFd !== null) try { closeSync(tokenFd); } catch {}
    closeStudioTokenBoundary(boundary);
  }
}

const configuredStudioToken = typeof process.env.PS4_STUDIO_TOKEN === "string" ? process.env.PS4_STUDIO_TOKEN : "";

export function isMonitorRuntimeDeadlineError(error) {
  return error?.code === "MONITOR_RUNTIME_DEADLINE";
}

export function normalizeMonitorRuntimeBoundaryError(error, { runtimeDeadlineMs, nowMs = Date.now() } = {}) {
  const deadlineMs = Number(runtimeDeadlineMs);
  const currentMs = Number(nowMs);
  if (!Number.isFinite(deadlineMs) || !monitorIso(deadlineMs) || !Number.isFinite(currentMs) || !monitorIso(currentMs)) {
    throw new TypeError("monitor runtime boundary 입력이 유효하지 않습니다.");
  }
  if (isMonitorRuntimeDeadlineError(error)) return error;
  if (isGeminiBrowserDeadlineError(error) || currentMs >= deadlineMs) return monitorRuntimeDeadlineError(deadlineMs);
  return null;
}

/**
 * Runs one complete local API exchange (headers and body included) under the
 * persisted monitor deadline. Dependencies are injectable so a hanging fetch
 * can be tested without opening a socket or waiting on wall-clock time.
 */
export async function runWithMonitorRuntimeDeadline(operation, {
  runtimeDeadlineMs,
  signal: callerSignal = null,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof operation !== "function") throw new TypeError("monitor runtime 작업 함수가 필요합니다.");
  if (typeof now !== "function" || typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("monitor runtime clock/timer가 유효하지 않습니다.");
  }
  const deadlineMs = Number(runtimeDeadlineMs);
  const initialNow = Number(now());
  if (!Number.isFinite(deadlineMs) || !monitorIso(deadlineMs) || !Number.isFinite(initialNow) || !monitorIso(initialNow)) {
    throw new TypeError("monitor runtime deadline이 유효하지 않습니다.");
  }
  if (initialNow >= deadlineMs) throw monitorRuntimeDeadlineError(deadlineMs);
  if (callerSignal?.aborted) throw callerSignal.reason || new DOMException("요청이 취소되었습니다.", "AbortError");

  const controller = new AbortController();
  let deadlineReached = false;
  let timeoutId = null;
  const abortAtDeadline = () => {
    const currentNow = Number(now());
    const remainingMs = Number.isFinite(currentNow) ? deadlineMs - currentNow : 0;
    if (remainingMs > 0) {
      timeoutId = setTimeoutFn(abortAtDeadline, Math.min(remainingMs, 2_147_483_647));
      return;
    }
    deadlineReached = true;
    controller.abort(monitorRuntimeDeadlineError(deadlineMs));
  };
  const forwardCallerAbort = () => {
    controller.abort(callerSignal.reason || new DOMException("요청이 취소되었습니다.", "AbortError"));
  };
  if (callerSignal) callerSignal.addEventListener("abort", forwardCallerAbort, { once: true });
  timeoutId = setTimeoutFn(abortAtDeadline, Math.min(deadlineMs - initialNow, 2_147_483_647));

  try {
    const result = await operation(controller.signal);
    if (deadlineReached || Number(now()) >= deadlineMs) throw monitorRuntimeDeadlineError(deadlineMs);
    return result;
  } catch (error) {
    if (deadlineReached || isMonitorRuntimeDeadlineError(error) || Number(now()) >= deadlineMs) {
      throw monitorRuntimeDeadlineError(deadlineMs);
    }
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeoutFn(timeoutId);
    if (callerSignal) callerSignal.removeEventListener("abort", forwardCallerAbort);
  }
}

export const MONITOR_API_RESPONSE_POLICY = Object.freeze({
  maximumBytes: 256 * 1024,
  mediaType: "application/json",
  charset: "utf-8"
});

const EMPTY_MONITOR_API_BYTES = Buffer.alloc(0);

function monitorApiBodyEvidence(bytes = EMPTY_MONITOR_API_BYTES, code = "monitor-api-response-rejected") {
  const snapshot = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    code,
    byteLength: snapshot.byteLength,
    sha256: `sha256:${createHash("sha256").update(snapshot).digest("hex")}`
  };
}

function monitorApiResponseError(code, {
  status = null,
  bytes = EMPTY_MONITOR_API_BYTES,
  evidenceCode = "monitor-api-response-rejected"
} = {}) {
  const error = new Error("monitor API response was rejected");
  error.name = "MonitorApiResponseError";
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  error.bodyEvidence = monitorApiBodyEvidence(bytes, evidenceCode);
  return error;
}

function exactMonitorJsonContentType(value) {
  if (typeof value !== "string") return false;
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(value.trim());
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : null;
}

function abortMonitorApiReader(reader, reason = "MONITOR_API_RESPONSE_REJECTED") {
  try {
    void Promise.resolve(reader?.cancel?.(reason)).catch(() => {});
  } catch {
    // Cancellation is best effort; the fixed rejection below remains authoritative.
  }
}

function cancelMonitorApiBody(response) {
  try {
    void Promise.resolve(response?.body?.cancel?.("MONITOR_API_RESPONSE_REJECTED")).catch(() => {});
  } catch {
    // Do not let a provider-controlled cancellation error replace the fixed error.
  }
}

async function readMonitorApiJsonResponse(response, signal) {
  const status = responseStatus(response);
  let contentType = null;
  try {
    contentType = response?.headers?.get?.("content-type") ?? null;
  } catch {
    contentType = null;
  }
  if (!exactMonitorJsonContentType(contentType)) {
    cancelMonitorApiBody(response);
    throw monitorApiResponseError("MONITOR_API_INVALID_CONTENT_TYPE", {
      status,
      evidenceCode: "monitor-api-invalid-content-type"
    });
  }

  let reader;
  try {
    reader = response?.body?.getReader?.();
  } catch {
    reader = null;
  }
  if (!reader || typeof reader.read !== "function") {
    throw monitorApiResponseError("MONITOR_API_RESPONSE_BODY_UNAVAILABLE", {
      status,
      evidenceCode: "monitor-api-response-body-unavailable"
    });
  }

  const chunks = [];
  let observedBytes = 0;
  const abortedMarker = Object.freeze({ aborted: true });
  let markAborted;
  const aborted = new Promise((resolve) => { markAborted = () => resolve(abortedMarker); });
  const onAbort = () => {
    abortMonitorApiReader(reader, "MONITOR_API_RESPONSE_ABORTED");
    markAborted();
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    while (true) {
      let next;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } catch {
        if (signal?.aborted && isMonitorRuntimeDeadlineError(signal.reason)) throw signal.reason;
        throw monitorApiResponseError(
          signal?.aborted ? "MONITOR_API_RESPONSE_ABORTED" : "MONITOR_API_RESPONSE_READ_FAILED",
          {
            status,
            bytes: Buffer.concat(chunks, observedBytes),
            evidenceCode: signal?.aborted ? "monitor-api-response-aborted" : "monitor-api-response-read-failed"
          }
        );
      }
      if (next === abortedMarker || signal?.aborted) {
        if (isMonitorRuntimeDeadlineError(signal?.reason)) throw signal.reason;
        throw monitorApiResponseError("MONITOR_API_RESPONSE_ABORTED", {
          status,
          bytes: Buffer.concat(chunks, observedBytes),
          evidenceCode: "monitor-api-response-aborted"
        });
      }
      if (!next || next.done) break;

      let chunk;
      try {
        chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      } catch {
        throw monitorApiResponseError("MONITOR_API_RESPONSE_READ_FAILED", {
          status,
          bytes: Buffer.concat(chunks, observedBytes),
          evidenceCode: "monitor-api-response-read-failed"
        });
      }
      const remainingObservedBytes = MONITOR_API_RESPONSE_POLICY.maximumBytes + 1 - observedBytes;
      const copiedBytes = Math.min(chunk.byteLength, Math.max(0, remainingObservedBytes));
      if (copiedBytes > 0) {
        chunks.push(Buffer.from(chunk.subarray(0, copiedBytes)));
        observedBytes += copiedBytes;
      }
      if (observedBytes > MONITOR_API_RESPONSE_POLICY.maximumBytes || chunk.byteLength > copiedBytes) {
        abortMonitorApiReader(reader, "MONITOR_API_RESPONSE_TOO_LARGE");
        throw monitorApiResponseError("MONITOR_API_RESPONSE_TOO_LARGE", {
          status,
          bytes: Buffer.concat(chunks, observedBytes),
          evidenceCode: "monitor-api-response-too-large"
        });
      }
    }
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    try { reader.releaseLock?.(); } catch {}
  }

  const bytes = Buffer.concat(chunks, observedBytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw monitorApiResponseError("MONITOR_API_RESPONSE_INVALID_UTF8", {
      status,
      bytes,
      evidenceCode: "monitor-api-response-invalid-utf8"
    });
  }
  try {
    return { bytes, value: JSON.parse(text) };
  } catch {
    throw monitorApiResponseError("MONITOR_API_RESPONSE_INVALID_JSON", {
      status,
      bytes,
      evidenceCode: "monitor-api-response-invalid-json"
    });
  }
}

export async function monitorApiExchange(url, options = {}, {
  runtimeDeadlineMs,
  fetchFn = fetch,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("monitor API fetch 함수가 필요합니다.");
  const { signal: callerSignal, ...requestOptions } = options;
  if (callerSignal?.aborted) {
    throw monitorApiResponseError("MONITOR_API_REQUEST_ABORTED", {
      evidenceCode: "monitor-api-request-aborted"
    });
  }
  return runWithMonitorRuntimeDeadline(async (signal) => {
    let response;
    try {
      response = await fetchFn(url, { ...requestOptions, signal });
    } catch {
      if (signal.aborted && isMonitorRuntimeDeadlineError(signal.reason)) throw signal.reason;
      throw monitorApiResponseError(
        signal.aborted ? "MONITOR_API_REQUEST_ABORTED" : "MONITOR_API_REQUEST_FAILED",
        { evidenceCode: signal.aborted ? "monitor-api-request-aborted" : "monitor-api-request-failed" }
      );
    }
    const body = await readMonitorApiJsonResponse(response, signal);
    if (!response.ok) {
      throw monitorApiResponseError("MONITOR_API_HTTP_ERROR", {
        status: response.status,
        bytes: body.bytes,
        evidenceCode: "monitor-api-http-error"
      });
    }
    return body.value;
  }, { runtimeDeadlineMs, signal: callerSignal, now, setTimeoutFn, clearTimeoutFn });
}

export async function monitorApiExchangeWithStudioToken(url, options = {}, {
  configuredToken = "",
  tokenPath = studioTokenPath,
  readTokenFn = readStudioTokenStrict,
  exchangeFn = monitorApiExchange,
  ...exchangeOptions
} = {}) {
  if (typeof readTokenFn !== "function" || typeof exchangeFn !== "function") {
    throw new TypeError("monitor Studio token exchange 함수가 필요합니다.");
  }
  const fileBacked = !configuredToken;
  const readCurrentToken = () => validateMonitorStudioToken(fileBacked
    ? readTokenFn(tokenPath, {
        runtimeDeadlineMs: exchangeOptions.runtimeDeadlineMs,
        now: exchangeOptions.now || Date.now
      })
    : configuredToken);
  const exchange = (token) => exchangeFn(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: `Bearer ${token}`
    }
  }, exchangeOptions);

  const firstToken = readCurrentToken();
  try {
    return await exchange(firstToken);
  } catch (error) {
    const authenticationRejected = error?.code === "MONITOR_API_HTTP_ERROR"
      && (error.status === 401 || error.status === 403);
    if (!fileBacked || !authenticationRejected) throw error;
    const refreshedToken = readCurrentToken();
    if (refreshedToken === firstToken) throw error;
    return exchange(refreshedToken);
  }
}

async function api(path, options = {}) {
  const deadlineMs = Number(activeRuntimeDeadlineMs);
  if (!Number.isFinite(deadlineMs) || !monitorIso(deadlineMs)) {
    throw new Error("monitor API runtime deadline이 설정되지 않았습니다.");
  }
  if (Date.now() >= deadlineMs) throw monitorRuntimeDeadlineError(deadlineMs);
  return monitorApiExchangeWithStudioToken(`${apiBase}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      origin: new URL(apiBase).origin
    }
  }, {
    configuredToken: configuredStudioToken,
    tokenPath: studioTokenPath,
    runtimeDeadlineMs: deadlineMs
  });
}

export async function runSoftwareReview(job, quality, options = {}) {
  if (!job?.id || !job?.runId || quality?.jobId !== job.id || quality?.runId !== job.runId) {
    throw new Error("결정론적 소프트웨어 리뷰 입력이 현재 jobId·runId와 일치하지 않습니다.");
  }
  const apiClient = options.apiClient || api;
  const persistEvent = options.persistEvent || persist;
  const runner = options.runner || runAutomatedQualityReview;
  const checkpointRoot = options.checkpointRoot || automatedReviewRoot;
  await persistEvent("automated_review_started", {
    status: "automated-reviewing",
    jobId: job.id,
    runId: job.runId,
    reviewKind: "deterministic-software-methods",
    human: false,
    independentPrincipal: false
  });
  return runner({
    jobId: job.id,
    api: apiClient,
    checkpointPath: automatedReviewCheckpointPath(job.id, job.runId, checkpointRoot),
    onTransition: async (transition) => persistEvent("automated_review_transition", {
      automatedReview: { ...transition, human: false, independentPrincipal: false }
    })
  });
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function sleepWithinRuntime(requestedWaitMs, runtimeDeadlineMs, localDeadlineMs = null) {
  const subwindow = monitorRuntimeSubwindow({
    nowMs: Date.now(),
    runtimeDeadlineMs,
    localDeadlineMs,
    requestedWaitMs
  });
  if (subwindow.waitMs > 0) await sleep(subwindow.waitMs);
  return subwindow;
}
function quotaResetAt(text, now = new Date()) {
  const korean = String(text || "").match(/(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
  const english = String(text || "").match(/available again on\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!korean && !english) return null;
  let month;
  let day;
  let hour;
  let minute;
  if (korean) {
    month = Number(korean[1]);
    day = Number(korean[2]);
    hour = Number(korean[4]) % 12;
    if (korean[3] === "오후") hour += 12;
    minute = Number(korean[5]);
  } else {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    month = monthNames.indexOf(english[1].slice(0, 3).toLowerCase()) + 1;
    day = Number(english[2]);
    hour = Number(english[3]) % 12;
    if (english[5].toUpperCase() === "PM") hour += 12;
    minute = Number(english[4]);
  }
  if (!month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const candidate = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);
  return candidate.getTime() > now.getTime() ? candidate : now;
}

function nextQuotaResetAt(observations, now = new Date()) {
  const resets = observations
    .map((profile) => {
      const exact = monitorTimestamp(profile?.quotaResetAt);
      return exact === null ? null : new Date(exact);
    })
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  return resets[0] || null;
}

async function waitForQuotaWindow(observations, reason, status = "quota-blocked", runtimeDeadlineMs) {
  const resetAt = nextQuotaResetAt(observations);
  const needsFrequentProbe = observations.some((profile) => (
    !profile.available
    && !profile.quotaResetAt
    && (profile.videoMode === false || profile.observationFailed === true)
  ));
  const now = Date.now();
  const requestedWaitMs = needsFrequentProbe
    ? pollMs
    : resetAt
      ? Math.max(30_000, resetAt.getTime() - now - quotaWakeLeadMs)
      : pollMs;
  const subwindow = monitorRuntimeSubwindow({ nowMs: now, runtimeDeadlineMs, requestedWaitMs });
  await persist("quota_wait_scheduled", {
    status,
    quotaResetAt: resetAt?.toISOString() || null,
    nextQuotaCheckAt: subwindow.nextCheckAt,
    quotaWaitMs: subwindow.waitMs,
    quotaWaitReason: needsFrequentProbe ? "frequent_probe_required" : reason
  });
  await sleepWithinRuntime(subwindow.waitMs, runtimeDeadlineMs);
}

function isQuotaError(value) {
  const text = String(value || "");
  return /you(?:'|’)re out of videos|videos will be available again|동영상 생성 할당량이 소진되었습니다|지금은 동영상을 생성할 수 없습니다|(?:할당량|쿼터).*(?:소진|사용할 수 없)|quota.*(?:exhaust|deplet|available again)/i.test(text);
}

function isAspectRatioError(value) {
  const text = String(value || "");
  return /세로\s*9\s*:\s*16\s*비율의\s*동영상을\s*반환하지\s*않|(?:did\s+not|didn't|failed\s+to)\s+return[^\n]*(?:vertical\s*)?9\s*:\s*16|(?:aspect\s*ratio|orientation)[^\n]*(?:mismatch|invalid|incorrect|not\s+(?:vertical\s*)?9\s*:\s*16)/i.test(text);
}

export function classifyGeminiFailure(value) {
  if (isQuotaError(value)) {
    return {
      kind: "quota-blocked",
      code: "quota-exhausted",
      retryableOnSameProfile: true,
      preferAlternateProfile: true
    };
  }
  if (isAspectRatioError(value)) {
    return {
      kind: "non-retryable",
      code: "aspect-ratio-mismatch",
      retryableOnSameProfile: false,
      preferAlternateProfile: true
    };
  }
  return {
    kind: "failed",
    code: "generation-failed",
    retryableOnSameProfile: true,
    preferAlternateProfile: false
  };
}

const STRUCTURAL_RECOVERY_FIELDS = new Set([
  "recoveryAttempts",
  "recoveredPendingSegments",
  "rejectedResumes",
  "resumedFrom",
  "resumedFromCompletedGeneration",
  "resumeRequestHash",
  "resumeScriptHash"
]);

function hasUnexpectedRecoveryAncestryField(value, path = "") {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasUnexpectedRecoveryAncestryField(entry, `${path}[]`));
  return Object.entries(value).some(([key, entry]) => {
    const topLevelStructural = path === "" && STRUCTURAL_RECOVERY_FIELDS.has(key);
    return (/(?:recover|resum|source)/i.test(key) && !topLevelStructural)
      || hasUnexpectedRecoveryAncestryField(entry, path ? `${path}.${key}` : key);
  });
}

function geminiReceiptSubmissionEvidence(generation) {
  const evidenceKinds = [];
  if (generation?.status === "completed") evidenceKinds.push("completed-generation");
  if (Array.isArray(generation?.segments) && generation.segments.length > 0) evidenceKinds.push("completed-segments");
  if (generation?.pendingSegment) evidenceKinds.push("pending-segment");
  if (generation?.providerRequestSentThisRun === true) evidenceKinds.push("provider-request-sent");
  if (generation?.inheritedProviderSubmission === true) evidenceKinds.push("inherited-provider-submission");
  if (Array.isArray(generation?.submissionRunIds) && generation.submissionRunIds.length > 0) evidenceKinds.push("submission-run-lineage");
  if (Array.isArray(generation?.recoveryAttempts) && generation.recoveryAttempts.length > 0) evidenceKinds.push("recovery-attempt-lineage");
  if (Array.isArray(generation?.recoveredPendingSegments) && generation.recoveredPendingSegments.length > 0) evidenceKinds.push("recovered-pending-lineage");
  if (Array.isArray(generation?.rejectedResumes) && generation.rejectedResumes.length > 0) evidenceKinds.push("rejected-resume-lineage");
  if (generation?.resumedFrom != null) evidenceKinds.push("resumed-generation-lineage");
  if (generation?.resumedFromCompletedGeneration != null) evidenceKinds.push("completed-generation-resume-lineage");
  if (hasUnexpectedRecoveryAncestryField(generation)) evidenceKinds.push("unexpected-recovery-source-lineage");
  return [...new Set(evidenceKinds)].sort();
}

/**
 * Examines the exact prior generation receipt before a failed job pointer may
 * be cleared. Any unreadable, foreign or submission-bearing receipt blocks the
 * reset: creating a different job would discard the only duplicate-prevention
 * lineage. A valid receipt proving zero submission evidence may be reset.
 */
export async function inspectGeminiRetryResetLineage({
  monitorState,
  currentJob = null,
  jobsRoot = join(workspaceDir, "jobs"),
  readReceipt = readGeminiGenerationReceipt
} = {}) {
  const jobId = String(currentJob?.id || monitorState?.jobId || "");
  const runId = String(currentJob?.runId || monitorState?.runId || "");
  if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/.test(jobId)) {
    return { resetAllowed: false, reason: "prior-job-identity-invalid", evidenceKinds: [], receipt: null };
  }
  const generationPath = join(jobsRoot, jobId, "gemini-generation.json");
  let exact;
  try {
    exact = await readReceipt(generationPath, { includeSnapshot: true });
  } catch {
    return { resetAllowed: false, reason: "prior-generation-receipt-invalid", evidenceKinds: [], receipt: null };
  }
  if (!exact) return { resetAllowed: false, reason: "prior-generation-receipt-missing", evidenceKinds: [], receipt: null };
  const generation = exact.generation;
  const receipt = {
    jobId: generation.jobId,
    runId: generation.runId,
    status: generation.status,
    bytes: exact.snapshot.bytes,
    sha256: exact.snapshot.sha256,
    generationHash: exact.snapshot.generationHash
  };
  if (generation.jobId !== jobId || !runId || generation.runId !== runId) {
    return { resetAllowed: false, reason: "prior-generation-binding-mismatch", evidenceKinds: [], receipt };
  }
  const evidenceKinds = geminiReceiptSubmissionEvidence(generation);
  if (evidenceKinds.length > 0) {
    return { resetAllowed: false, reason: "prior-provider-lineage-present", evidenceKinds, receipt };
  }
  const exactProviderZero = verifyStrictGeminiRecoverySourceReceipt(generation)
    && generation.schemaVersion === 5
    && generation.status === "failed"
    && generation.providerRequestSentThisRun === false
    && generation.inheritedProviderSubmission === false
    && Array.isArray(generation.submissionRunIds)
    && generation.submissionRunIds.length === 0
    && Array.isArray(generation.segments)
    && generation.segments.length === 0
    && generation.pendingSegment == null
    && Array.isArray(generation.recoveryAttempts)
    && generation.recoveryAttempts.length === 0
    && Array.isArray(generation.recoveredPendingSegments)
    && generation.recoveredPendingSegments.length === 0
    && Array.isArray(generation.rejectedResumes)
    && generation.rejectedResumes.length === 0
    && generation.resumedFrom == null
    && generation.resumedFromCompletedGeneration == null
    && generation.legacySubmissionAbandonment == null
    && generation.legacySubmissionAbandonmentEvidence == null
    && Array.isArray(generation.legacySubmissionAbandonmentConsumptions)
    && generation.legacySubmissionAbandonmentConsumptions.length === 0;
  return exactProviderZero
    ? { resetAllowed: true, reason: "verified-provider-zero-receipt", evidenceKinds, receipt }
    : { resetAllowed: false, reason: "prior-provider-zero-contract-missing", evidenceKinds, receipt };
}

function retryLineageBlockedTransition({ monitorState, lineage }) {
  return {
    status: "retry-lineage-blocked",
    jobId: monitorState?.jobId || lineage?.receipt?.jobId || null,
    runId: monitorState?.runId || lineage?.receipt?.runId || null,
    profileId: monitorState?.profileId || null,
    attempts: Number(monitorState?.attempts || 0),
    retryLineage: lineage,
    lastError: "gemini-retry-lineage-blocked",
    nextAction: "reconcile_or_explicitly_abandon_prior_provider_lineage"
  };
}

export function retryLimitResetTransition({ monitorState, error = null } = {}) {
  return {
    status: "monitoring",
    jobId: null,
    runId: null,
    profileId: null,
    attempts: 0,
    completion: null,
    failedJobId: monitorState?.jobId || null,
    lastError: error ? "gemini-retry-limit-reached" : null,
    nextAction: "create_new_job"
  };
}

export function profileFailoverTransition({ monitorState, currentJob, observations, reason = "selected-profile-unavailable", checkpointedAt = new Date().toISOString() }) {
  if (!monitorState || !Array.isArray(observations)) {
    throw new Error("프로필 전환 계획 입력이 유효하지 않습니다.");
  }
  const alternate = observations.find((profile) => profile?.available && profile.id !== monitorState.profileId) || null;
  if (!alternate) return { action: "wait", reason: "no-alternate-profile" };

  const previousJobId = currentJob?.id || monitorState.jobId || null;
  const previousRunId = currentJob?.runId || monitorState.runId || null;
  const terminalStatus = currentJob?.status || monitorState.status;
  const terminal = ["failed", "quota-blocked"].includes(terminalStatus);
  if (previousRunId && !terminal) {
    return { action: "preserve", reason: "immutable-active-run" };
  }

  return {
    action: "create-new-job",
    nextProfileId: alternate.id,
    checkpoint: {
      checkpointedAt,
      reason,
      jobId: previousJobId,
      runId: previousRunId,
      profileId: monitorState.profileId || null,
      jobStatus: currentJob?.status || null,
      immutableRunBound: Boolean(previousRunId),
      sessionBindingHash: String(currentJob?.geminiSessionBindingHash || "").trim() || null
    },
    reset: {
      status: "switching-profile",
      jobId: null,
      runId: null,
      profileId: alternate.id,
      attempts: 0,
      completion: null,
      lastError: null
    }
  };
}

function profileFor(id) {
  return profiles.find((profile) => profile.id === id) || null;
}

async function observeProfiles(runtimeDeadlineMs, signal = null) {
  const observations = [];
  for (const profile of profiles) {
    try {
      const browserRuntime = { deadlineMs: runtimeDeadlineMs, signal };
      await startGeminiBrowser({ cdpUrl: profile.cdpUrl, profileDir: profile.profileDir }, browserRuntime);
      const observed = await geminiQuotaStatus({ cdpUrl: profile.cdpUrl, profileDir: profile.profileDir }, browserRuntime);
      const resetAt = quotaResetAt(observed?.quotaResetText);
      observations.push(projectGeminiMonitorProfileObservation({
        id: profile.id,
        cdpUrl: profile.cdpUrl,
        available: observed?.available === true,
        headless: observed?.headless === true,
        videoMode: observed?.videoMode === true ? true : observed?.videoMode === false ? false : null,
        quotaResetAt: resetAt?.toISOString() || null,
        observationFailed: false,
        errorCode: null
      }));
    } catch (error) {
      const boundaryError = normalizeMonitorRuntimeBoundaryError(error, { runtimeDeadlineMs });
      if (boundaryError) throw boundaryError;
      if (isGeminiBrowserAbortError(error)) throw error;
      observations.push(projectGeminiMonitorProfileObservation({
        id: profile.id,
        cdpUrl: profile.cdpUrl,
        available: false,
        headless: null,
        videoMode: null,
        quotaResetAt: null,
        observationFailed: true,
        errorCode: "gemini-observation-failed"
      }));
    }
  }
  await persist("profiles_observed", {
    status: observations.some((profile) => profile.available) ? "quota-available" : "quota-blocked",
    profiles: observations,
    lastError: observations.find((profile) => profile.errorCode)?.errorCode || null
  });
  await writeUltragoalSignal(
    observations.some((profile) => profile.available) ? "provider-available" : "provider-blocked",
    {
      profiles: observations,
      profileId: observations.find((profile) => profile.available)?.id || null,
      status: observations.some((profile) => profile.available) ? "quota-available" : "quota-blocked"
    }
  );
  return observations;
}

export async function createMonitorJobInertFirst({
  profile,
  monitorState,
  request,
  apiClient,
  persistEvent,
  signalWriter
} = {}) {
  if (!profile?.id || !profile?.cdpUrl || !profile?.profileDir || !monitorState || typeof request !== "object" || !request || typeof apiClient !== "function" || typeof persistEvent !== "function" || typeof signalWriter !== "function") {
    throw new TypeError("Gemini monitor job 생성 입력이 유효하지 않습니다.");
  }
  const response = await apiClient("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...request,
      provider: "gemini-browser",
      geminiCdpUrl: profile.cdpUrl,
      geminiProfileDir: profile.profileDir,
      autoStart: false
    })
  });
  const job = response?.job;
  if (!job?.id || job.provider !== "gemini-browser") {
    throw new Error("Studio가 유효한 inert Gemini job 영수증을 반환하지 않았습니다.");
  }
  if (job.status !== "queued" || job.runId) {
    const error = new Error("autoStart:false 생성 요청이 inert queued job을 반환하지 않았습니다.");
    error.code = "GEMINI_MONITOR_CREATE_NOT_INERT";
    throw error;
  }
  monitorState.jobId = job.id;
  monitorState.profileId = profile.id;
  await persistEvent("job_created", { jobId: job.id, profileId: profile.id, status: job.status });
  await signalWriter("production-staged", { jobId: job.id, runId: null, profileId: profile.id, status: "production-staged" });

  const started = await apiClient(`/api/jobs/${encodeURIComponent(job.id)}/run`, { method: "POST" });
  if (started?.job?.id !== job.id || started.job.provider !== "gemini-browser" || !String(started.job.runId || "").trim()) {
    throw new Error("Studio가 시작된 Gemini job/run의 exact 영수증을 반환하지 않았습니다.");
  }
  await persistEvent("job_resumed", {
    jobId: job.id,
    profileId: profile.id,
    runId: started.job?.runId || null,
    attempts: Number(monitorState.attempts || 0) + 1,
    status: started.job?.status || "queued"
  });
  await signalWriter("production-started", {
    jobId: job.id,
    runId: started.job.runId,
    profileId: profile.id,
    status: started.job.status || "running"
  });
  return { created: job, started: started.job || null };
}

async function createJob(profile) {
  return createMonitorJobInertFirst({
    profile,
    monitorState: state,
    request: {
      topic,
      format: "vertical",
      clipCount,
      targetDurationSec,
      captions: true,
      voiceover: true,
      sources
    },
    apiClient: api,
    persistEvent: persist,
    signalWriter: writeUltragoalSignal
  });
}

export async function readMonitorTerminalQuality(apiClient, jobId) {
  if (typeof apiClient !== "function" || typeof jobId !== "string" || !jobId.trim()) {
    throw new TypeError("monitor terminal quality 입력이 유효하지 않습니다.");
  }
  const quality = await apiClient(`/api/jobs/${encodeURIComponent(jobId)}/quality`);
  if (!quality || typeof quality !== "object" || Array.isArray(quality) || Object.hasOwn(quality, "error")) {
    throw new Error("Studio가 유효한 terminal quality 영수증을 반환하지 않았습니다.");
  }
  return quality;
}

async function resumeJob() {
  const response = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/run`, { method: "POST" });
  if (response?.job?.id !== state.jobId || response.job.provider !== "gemini-browser" || !String(response.job.runId || "").trim()) {
    throw new Error("Studio가 재개된 Gemini job/run의 exact 영수증을 반환하지 않았습니다.");
  }
  await persist("job_resumed", { jobId: state.jobId, profileId: state.profileId, runId: response.job.runId, attempts: state.attempts + 1, status: response.job.status || "running" });
  await writeUltragoalSignal("production-started", {
    jobId: state.jobId,
    runId: response.job.runId,
    profileId: state.profileId,
    status: response.job.status || "running"
  });
}

function monitorJobStatus(value) {
  return ["completed", "failed", "needs-improvement", "queued", "running", "verifying"].includes(value)
    ? value
    : "unknown";
}

async function pollJob(localDeadlineMs, runtimeDeadlineMs) {
  const pollWindow = monitorRuntimeSubwindow({ nowMs: Date.now(), runtimeDeadlineMs, localDeadlineMs });
  const deadline = pollWindow.deadlineMs;
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
    state.runId = job.runId || state.runId;
    await persist("job_polled", {
      profileId: state.profileId,
      runId: state.runId,
      status: monitorJobStatus(job.status),
      stageEvidence: monitorDiagnosticEvidence(job.stage, "gemini-job-stage-observed"),
      progress: Number.isFinite(Number(job.progress)) ? Math.max(0, Math.min(100, Number(job.progress))) : null,
      messageEvidence: monitorDiagnosticEvidence(job.message, "gemini-job-message-observed"),
      errorEvidence: monitorDiagnosticEvidence(job.error, "gemini-job-error-observed")
    });
    if (job.status === "completed") {
      const quality = await readMonitorTerminalQuality(api, state.jobId);
      const completion = {
        jobStatus: job.status,
        runId: job.runId || null,
        qualityStatus: quality.status || null,
        totalScore: quality.totalScore ?? null,
        threshold: quality.threshold ?? null,
        semanticGate: quality.semanticGate ?? false,
        finalMedia: quality.metrics?.finalMedia || null,
        semanticReviewPending: quality.semanticGate !== true
      };
      await persist("production_completed", { status: "production-complete", completion });
      await writeUltragoalSignal("production-complete", { jobId: state.jobId, runId: state.runId, status: "production-complete", completion });
      return { kind: "completed", job, quality };
    }
    if (job.status === "needs-improvement") {
      const quality = await readMonitorTerminalQuality(api, state.jobId);
      const automatedReview = await runSoftwareReview(job, quality);
      if (automatedReview.kind === "completed") {
        const effectiveQuality = automatedReview.quality || await api(`/api/jobs/${encodeURIComponent(state.jobId)}/quality`);
        const completion = {
          jobStatus: "completed",
          runId: job.runId || null,
          qualityStatus: effectiveQuality.status || null,
          totalScore: effectiveQuality.totalScore ?? null,
          threshold: effectiveQuality.threshold ?? null,
          semanticGate: effectiveQuality.semanticGate === true,
          reviewKind: "deterministic-software-methods",
          human: false,
          independentPrincipal: false
        };
        await persist("production_completed", { status: "production-complete", completion });
        await writeUltragoalSignal("production-complete", { jobId: state.jobId, runId: state.runId, status: "production-complete", completion });
        return { kind: "completed", job: automatedReview.job || job, quality: effectiveQuality, automatedReview };
      }
      const completion = {
        jobStatus: job.status,
        runId: job.runId || null,
        qualityStatus: quality.status || null,
        totalScore: quality.totalScore ?? null,
        threshold: quality.threshold ?? null,
        semanticGate: quality.semanticGate ?? false,
        reviewKind: "deterministic-software-methods",
        human: false,
        independentPrincipal: false,
        automatedReviewKind: automatedReview.kind,
        automatedReviewReasons: automatedReview.analysis?.reasons || automatedReview.checkpoint?.reasons || [],
        nextAction: automatedReview.kind === "reconciliation-required" || automatedReview.kind === "submission-unknown"
          ? "reconcile the append-only revision before any further review submission"
          : "improve media or immutable evidence; do not spend quota or repeat software review on unchanged evidence"
      };
      const reconciliation = ["reconciliation-required", "submission-unknown"].includes(automatedReview.kind);
      const event = reconciliation ? "automated_review_reconciliation_required" : "automated_review_needs_remediation";
      const status = reconciliation ? "review-reconciliation-required" : "review-needs-remediation";
      await persist(event, { status, completion });
      await writeUltragoalSignal(event.replaceAll("_", "-"), { jobId: state.jobId, runId: state.runId, status, completion });
      return { kind: reconciliation ? "review-reconciliation-required" : "review-needs-remediation", job, quality, automatedReview };
    }
    if (job.status === "failed") {
      const detail = job.error || job.message || "Gemini 작업이 실패했습니다.";
      const failure = classifyGeminiFailure(detail);
      const failureEvidence = monitorDiagnosticEvidence(detail, `gemini-${failure.code}`);
      if (failure.kind === "quota-blocked") {
        await persist("quota_blocked_during_job", { status: "quota-blocked", lastError: failure.code, failureEvidence, runId: job.runId || state.runId });
        return { kind: "quota-blocked", job, error: failure.code, failure, failureEvidence };
      }
      if (!failure.retryableOnSameProfile) {
        await persist("job_failed_non_retryable", {
          status: "failed",
          lastError: failure.code,
          failureEvidence,
          runId: job.runId || state.runId,
          failureCode: failure.code,
          nextAction: "create a new job on an alternate profile without mutating this immutable run"
        });
        return { kind: "non-retryable", job, error: failure.code, failure, failureEvidence };
      }
      await persist("job_failed", { status: "failed", lastError: failure.code, failureEvidence, runId: job.runId || state.runId });
      return { kind: "failed", job, error: failure.code, failure, failureEvidence };
    }
    await sleepWithinRuntime(jobPollMs, runtimeDeadlineMs, deadline);
  }
  await persist("job_poll_timeout", { status: "monitoring", lastError: "gemini-job-poll-timeout" });
  return { kind: "timeout" };
}

async function switchToAvailableProfile(observations, reason = "selected-profile-unavailable", knownCurrentJob) {
  const current = knownCurrentJob === undefined && state.jobId
    ? await api(`/api/jobs/${encodeURIComponent(state.jobId)}`).catch((error) => {
        if (isMonitorRuntimeDeadlineError(error)) throw error;
        return null;
      })
    : knownCurrentJob || null;
  const transition = profileFailoverTransition({
    monitorState: state,
    currentJob: current,
    observations,
    reason
  });
  if (transition.action !== "create-new-job") return false;

  const lineage = await inspectGeminiRetryResetLineage({ monitorState: state, currentJob: current });
  if (!lineage.resetAllowed) {
    await persist("profile_failover_lineage_blocked", retryLineageBlockedTransition({ monitorState: state, lineage }));
    return "blocked";
  }

  await persist("profile_failover_checkpointed", {
    ...transition.reset,
    failoverCheckpoint: transition.checkpoint,
    previousJobId: transition.checkpoint.jobId,
    previousRunId: transition.checkpoint.runId,
    previousProfileId: transition.checkpoint.profileId,
    nextProfileId: transition.nextProfileId,
    nextAction: "create_new_job_on_alternate_profile"
  });
  await createJob(profileFor(transition.nextProfileId));
  return true;
}

export async function main() {
  let monitorLease = null;
  runtimeBoundary = null;
  activeRuntimeDeadlineMs = null;
  await mkdir(workspaceDir, { recursive: true });
  monitorLease = await acquireGeminiMonitorLease(monitorLeasePath);
  try {
  await scrubGeminiMonitorArtifacts({ statePath, logPath, signalPath: ultragoalSignalPath });
  let previous = null;
  try {
    previous = await readRedactedGeminiMonitorState(statePath);
    if (previous && typeof previous === "object") state = { ...state, ...previous, schemaVersion: 2, status: "resuming" };
  } catch {}
  state.profiles = (Array.isArray(state.profiles) ? state.profiles : []).flatMap((profile) => {
    try { return [projectGeminiMonitorProfileObservation(profile)]; } catch { return []; }
  });
  const runtimeWindow = resolveMonitorRuntimeWindow({ persistedState: previous, now: new Date(), maxRuntimeMs });
  state = { ...state, startedAt: runtimeWindow.startedAt, deadlineAt: runtimeWindow.deadlineAt };
  runtimeBoundary = { startedAt: runtimeWindow.startedAt, deadlineAt: runtimeWindow.deadlineAt };
  if (!runtimeWindow.valid) {
    await persist("monitor_runtime_invalid", {
      status: "deadline-reached",
      runtimeSource: runtimeWindow.source,
      runtimeReason: runtimeWindow.reason,
      retryLimit,
      lastError: `모니터 runtime 경계가 유효하지 않아 fail-closed로 종료했습니다. (${runtimeWindow.reason})`
    });
    return;
  }
  if (runtimeWindow.expired) {
    await persist("monitor_deadline", {
      status: "deadline-reached",
      runtimeSource: runtimeWindow.source,
      runtimeReason: runtimeWindow.reason,
      retryLimit,
      lastError: "모니터링 최대 실행 시간이 만료되었습니다."
    });
    return;
  }
  const deadline = runtimeWindow.deadlineMs;
  activeRuntimeDeadlineMs = deadline;
  const startupStateSnapshot = { ...state };
  await persist("monitor_started", {
    status: "monitoring",
    apiBase,
    pollMs,
    quotaWakeLeadMs,
    jobPollMs,
    retryLimit,
    runtimeSource: runtimeWindow.source,
    profiles: profiles.map(({ id, cdpUrl }) => ({ id, cdpUrl })),
    clipCount,
    targetDurationSec
  });
  let startupPlanPending = Boolean(startupStateSnapshot.jobId);
  while (Date.now() < deadline) {
    try {
      let startupJob = null;
      if (startupPlanPending && state.jobId) {
        startupJob = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
        const transition = monitorStartupPlanTransition({
          monitorState: startupStateSnapshot,
          job: startupJob,
          desiredPlan: { topic, clipCount, targetDurationSec },
          configuredProfiles: profiles
        });
        startupPlanPending = false;
        if (transition.action === "supersede") {
          const lineage = await inspectGeminiRetryResetLineage({ monitorState: startupStateSnapshot, currentJob: startupJob });
          if (!lineage.resetAllowed) {
            await persist("plan_supersede_lineage_blocked", retryLineageBlockedTransition({ monitorState: state, lineage }));
            return;
          }
          await persist("plan_superseded", {
            ...transition.reset,
            supersededPlan: transition.previousPlan,
            selectedPlan: transition.desiredPlan,
            planMismatchReasons: transition.reasons,
            nextAction: "create_new_job_when_quota_available"
          });
          startupJob = null;
        }
      }
      if (state.jobId) {
        const existing = startupJob || await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
        if (["completed", "needs-improvement"].includes(existing.status)) {
          await pollJob(Date.now() + 1_000, deadline);
          return;
        }
        if (state.status === "retry-lineage-blocked") return;
      }
      const observations = await observeProfiles(deadline);
      if (!state.jobId) {
        const available = observations.find((profile) => profile.available);
        if (!available) {
          await waitForQuotaWindow(observations, "no_available_profile", "quota-blocked", deadline);
          continue;
        }
        await createJob(profileFor(available.id));
      } else {
        const current = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
        if (["completed", "needs-improvement"].includes(current.status)) {
          await pollJob(Date.now() + 1_000, deadline);
          return;
        }
        if (current.status === "queued" && !current.runId) {
          const currentObservation = observations.find((profile) => profile.id === state.profileId);
          if (!currentObservation?.available) {
            await persist("staged_job_waiting_for_quota", {
              status: "quota-blocked",
              jobId: state.jobId,
              profileId: state.profileId,
              nextAction: "resume_existing_inert_job_when_selected_profile_is_available"
            });
            await waitForQuotaWindow(observations, "staged_job_profile_unavailable", "quota-blocked", deadline);
            continue;
          }
          await resumeJob();
        }
        if (current.status === "failed") {
          if (state.attempts >= retryLimit) {
            const lineage = await inspectGeminiRetryResetLineage({ monitorState: state, currentJob: current });
            if (!lineage.resetAllowed) {
              await persist("job_retry_lineage_blocked", retryLineageBlockedTransition({ monitorState: state, lineage }));
              return;
            }
            await persist("job_retry_limit_reached", {
              ...retryLimitResetTransition({ monitorState: state, error: current.error || current.message || "retry-limit" }),
              retryLineage: lineage
            });
            await sleepWithinRuntime(pollMs, deadline);
            continue;
          }
          const failure = classifyGeminiFailure(current.error || current.message || "");
          if (!failure.retryableOnSameProfile) {
            const switched = await switchToAvailableProfile(observations, failure.code, current);
            if (switched === "blocked") return;
            if (switched) continue;
            await persist("non_retryable_profile_wait", {
              status: "waiting-alternate-profile",
              jobId: state.jobId,
              runId: current.runId || state.runId,
              profileId: state.profileId,
              failureCode: failure.code,
              nextAction: "wait for an alternate profile and create a new job; never resume this immutable run"
            });
            await waitForQuotaWindow(observations, "non_retryable_failure_needs_alternate_profile", "waiting-alternate-profile", deadline);
            continue;
          }
          const currentObservation = observations.find((profile) => profile.id === state.profileId);
          if (!currentObservation?.available) {
            const switched = await switchToAvailableProfile(observations, failure.code, current);
            if (switched === "blocked") return;
            if (switched) continue;
            await persist("selected_profile_quota_blocked", { status: "quota-blocked", profileId: state.profileId, jobId: state.jobId });
            await waitForQuotaWindow(observations, "selected_profile_quota_blocked", "quota-blocked", deadline);
            continue;
          }
          await resumeJob();
        }
      }
      const result = await pollJob(Date.now() + jobPollWindowMs, deadline);
      if (["completed", "review-needs-remediation", "review-reconciliation-required"].includes(result.kind)) return;
      if (result.kind === "failed") {
        if (state.attempts >= retryLimit) {
          const lineage = await inspectGeminiRetryResetLineage({ monitorState: state, currentJob: result.job });
          if (!lineage.resetAllowed) {
            await persist("job_retry_lineage_blocked", retryLineageBlockedTransition({ monitorState: state, lineage }));
            return;
          }
          await persist("job_retry_limit_reached", {
            ...retryLimitResetTransition({ monitorState: state, error: result.error }),
            retryLineage: lineage
          });
          await sleepWithinRuntime(pollMs, deadline);
          continue;
        }
        await persist("job_retry_scheduled", {
          status: "retrying",
          jobId: state.jobId,
          runId: result.job?.runId || state.runId,
          attempt: state.attempts + 1,
          retryLimit,
          lastError: result.error
        });
        await sleepWithinRuntime(pollMs, deadline);
        continue;
      }
      let waitObservations = observations;
      let waitReason = "monitor_cycle";
      if (["quota-blocked", "non-retryable"].includes(result.kind)) {
        waitObservations = await observeProfiles(deadline);
        const switched = await switchToAvailableProfile(waitObservations, result.failure?.code || result.kind, result.job);
        if (switched === "blocked") return;
        if (switched) continue;
        if (result.kind === "non-retryable") {
          await persist("non_retryable_profile_wait", {
            status: "waiting-alternate-profile",
            jobId: state.jobId,
            runId: result.job?.runId || state.runId,
            profileId: state.profileId,
            failureCode: result.failure?.code || "non-retryable",
            nextAction: "wait for an alternate profile and create a new job; never resume this immutable run"
          });
          await waitForQuotaWindow(waitObservations, "non_retryable_failure_needs_alternate_profile", "waiting-alternate-profile", deadline);
          continue;
        }
        waitReason = "all_profiles_quota_blocked";
      }
      await waitForQuotaWindow(waitObservations, waitReason, "quota-blocked", deadline);
      continue;
    } catch (error) {
      if (normalizeMonitorRuntimeBoundaryError(error, { runtimeDeadlineMs: deadline })) break;
      await persist("monitor_error", {
        status: "monitoring",
        lastError: "gemini-monitor-cycle-failed",
        errorEvidence: monitorDiagnosticEvidence(error?.stack || error, "gemini-monitor-cycle-failed")
      });
      await sleepWithinRuntime(pollMs, deadline);
    }
  }
  await persist("monitor_deadline", {
    status: "deadline-reached",
    runtimeSource: runtimeWindow.source,
    runtimeReason: "runtime-expired",
    lastError: "모니터링 최대 실행 시간이 만료되었습니다.",
    retryLimit
  });
  } finally {
    await monitorLease.release();
  }
}

if (import.meta.main) await main();
