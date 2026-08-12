import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { geminiQuotaStatus, startGeminiBrowser } from "../src/gemini-browser.mjs";
import { automatedReviewCheckpointPath, runAutomatedQualityReview } from "../src/automated-review.mjs";
import { geminiSessionBindingHash } from "../src/provenance.mjs";
import { createUltragoalResumeSignal } from "../src/ultragoal-signal.mjs";
import {
  persistGeminiMonitorEvent,
  readRedactedGeminiMonitorState,
  redactGeminiMonitor,
  scrubGeminiMonitorArtifacts,
  writePrivateJson
} from "../src/gemini-monitor-privacy.mjs";

const root = resolve(import.meta.dirname, "..");
const workspaceDir = join(root, "workspace");
const statePath = join(workspaceDir, "gemini-monitor.json");
const logPath = join(workspaceDir, "gemini-monitor.jsonl");
const studioTokenPath = process.env.PS4_STUDIO_TOKEN_FILE || join(workspaceDir, ".runtime", "studio-token");
const ultragoalSignalPath = process.env.GEMINI_ULTRAGOAL_SIGNAL_PATH || join(workspaceDir, "ultragoal-resume-request.json");
const automatedReviewRoot = process.env.GEMINI_AUTOMATED_REVIEW_CHECKPOINT_ROOT || join(workspaceDir, "automated-review");
const apiBase = process.env.PS4_API_BASE || "http://localhost:3000";
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
  updatedAt: new Date().toISOString(),
  attempts: 0,
  profiles: [],
  lastError: null,
  completion: null
};

async function persist(event, details = {}) {
  state = await persistGeminiMonitorEvent({ statePath, logPath, state, event, details });
}

async function writeUltragoalSignal(event, details = {}) {
  const payload = createUltragoalResumeSignal({
    event,
    goalId: "G005",
    jobId: details.jobId ?? state.jobId,
    runId: details.runId ?? state.runId,
    status: details.status ?? state.status,
    profiles: details.profiles || state.profiles || [],
    completion: details.completion ?? state.completion ?? null
  });
  try {
    await writePrivateJson(ultragoalSignalPath, payload);
  } catch (error) {
    await writePrivateJson(ultragoalSignalPath, { ...payload, signalError: error.message }).catch(() => {});
  }
}

let studioToken = String(process.env.PS4_STUDIO_TOKEN || "").trim();
async function api(path, options = {}) {
  if (!studioToken) {
    try {
      studioToken = (await readFile(studioTokenPath, "utf8")).trim();
    } catch {
      throw new Error(`로컬 Studio 인증 토큰을 읽을 수 없습니다: ${studioTokenPath}. 서버를 먼저 시작하세요.`);
    }
  }
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      origin: new URL(apiBase).origin,
      authorization: `Bearer ${studioToken}`
    }
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(-1000) }; }
  if (!response.ok) {
    const error = new Error(`${response.status}: ${body.error || body.message || text.slice(-500)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
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
    .map((profile) => quotaResetAt(profile.quotaResetText, now))
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  return resets[0] || null;
}

async function waitForQuotaWindow(observations, reason, status = "quota-blocked") {
  const resetAt = nextQuotaResetAt(observations);
  const needsFrequentProbe = observations.some((profile) => (
    !profile.available
    && !profile.quotaResetText
    && (profile.videoMode === false || profile.error || profile.quotaMessage == null)
  ));
  const now = Date.now();
  const waitMs = needsFrequentProbe
    ? pollMs
    : resetAt
      ? Math.max(30_000, resetAt.getTime() - now - quotaWakeLeadMs)
      : pollMs;
  await persist("quota_wait_scheduled", {
    status,
    quotaResetAt: resetAt?.toISOString() || null,
    nextQuotaCheckAt: new Date(now + waitMs).toISOString(),
    quotaWaitMs: waitMs,
    quotaWaitReason: needsFrequentProbe ? "frequent_probe_required" : reason
  });
  await sleep(waitMs);
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

async function observeProfiles() {
  const observations = [];
  for (const profile of profiles) {
    try {
      await startGeminiBrowser({ cdpUrl: profile.cdpUrl, profileDir: profile.profileDir });
      observations.push({
        id: profile.id,
        ...(await geminiQuotaStatus({ cdpUrl: profile.cdpUrl, profileDir: profile.profileDir }))
      });
    } catch (error) {
      observations.push({ id: profile.id, available: false, error: error.message });
    }
  }
  await persist("profiles_observed", {
    status: observations.some((profile) => profile.available) ? "quota-available" : "quota-blocked",
    profiles: observations,
    lastError: observations.find((profile) => profile.error)?.error || null
  });
  await writeUltragoalSignal(
    observations.some((profile) => profile.available) ? "provider-available" : "provider-blocked",
    { profiles: observations, status: observations.some((profile) => profile.available) ? "quota-available" : "quota-blocked" }
  );
  return observations;
}

async function createJob(profile) {
  const job = await api("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic,
      provider: "gemini-browser",
      format: "vertical",
      clipCount,
      targetDurationSec,
      captions: true,
      voiceover: true,
      sources,
      geminiCdpUrl: profile.cdpUrl,
      geminiProfileDir: profile.profileDir
    })
  });
  state.jobId = job.job.id;
  state.profileId = profile.id;
  await persist("job_created", { jobId: state.jobId, profileId: profile.id, status: job.job.status });
  await writeUltragoalSignal("production-started", { jobId: state.jobId, status: job.job.status });
}

async function resumeJob() {
  const response = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/run`, { method: "POST" });
  await persist("job_resumed", { jobId: state.jobId, profileId: state.profileId, runId: response.job?.runId || null, attempts: state.attempts + 1, status: response.job?.status || "queued" });
}

async function pollJob(deadline) {
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
    state.runId = job.runId || state.runId;
    await persist("job_polled", { profileId: state.profileId, runId: state.runId, status: job.status, stage: job.stage, progress: job.progress, message: job.message || null, error: job.error || null });
    if (job.status === "completed") {
      const quality = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/quality`).catch((error) => ({ error: error.message }));
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
      const quality = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/quality`).catch((error) => ({ error: error.message }));
      if (quality.error) {
        const completion = {
          jobStatus: job.status,
          runId: job.runId || null,
          qualityStatus: null,
          semanticGate: false,
          nextAction: "repair or reconcile the sealed quality chain before deterministic software review"
        };
        await persist("automated_review_reconciliation_required", { status: "review-reconciliation-required", completion, lastError: quality.error });
        await writeUltragoalSignal("automated-review-reconciliation-required", { jobId: state.jobId, runId: state.runId, status: "review-reconciliation-required", completion });
        return { kind: "review-reconciliation-required", job, quality };
      }
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
      if (failure.kind === "quota-blocked") {
        await persist("quota_blocked_during_job", { status: "quota-blocked", lastError: detail, runId: job.runId || state.runId });
        return { kind: "quota-blocked", job, error: detail, failure };
      }
      if (!failure.retryableOnSameProfile) {
        await persist("job_failed_non_retryable", {
          status: "failed",
          lastError: detail,
          runId: job.runId || state.runId,
          failureCode: failure.code,
          nextAction: "create a new job on an alternate profile without mutating this immutable run"
        });
        return { kind: "non-retryable", job, error: detail, failure };
      }
      await persist("job_failed", { status: "failed", lastError: detail, runId: job.runId || state.runId });
      return { kind: "failed", job, error: detail, failure };
    }
    await sleep(jobPollMs);
  }
  await persist("job_poll_timeout", { status: "monitoring", lastError: "작업 상태 확인 시간이 초과되어 다음 주기에 재확인합니다." });
  return { kind: "timeout" };
}

async function switchToAvailableProfile(observations, reason = "selected-profile-unavailable", knownCurrentJob) {
  const current = knownCurrentJob === undefined && state.jobId
    ? await api(`/api/jobs/${encodeURIComponent(state.jobId)}`).catch(() => null)
    : knownCurrentJob || null;
  const transition = profileFailoverTransition({
    monitorState: state,
    currentJob: current,
    observations,
    reason
  });
  if (transition.action !== "create-new-job") return false;

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
  await mkdir(workspaceDir, { recursive: true });
  await scrubGeminiMonitorArtifacts({ statePath, logPath, signalPath: ultragoalSignalPath });
  try {
    const previous = await readRedactedGeminiMonitorState(statePath);
    if (previous && typeof previous === "object") state = { ...state, ...previous, schemaVersion: 2, status: "resuming" };
  } catch {}
  state.profiles = [];
  const startupStateSnapshot = { ...state };
  await persist("monitor_started", { status: "monitoring", apiBase, pollMs, quotaWakeLeadMs, jobPollMs, retryLimit, profiles: profiles.map(({ id, cdpUrl }) => ({ id, cdpUrl })), clipCount, targetDurationSec });
  const deadline = Date.now() + maxRuntimeMs;
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
          await pollJob(Date.now() + 1_000);
          return;
        }
      }
      const observations = await observeProfiles();
      if (!state.jobId) {
        const available = observations.find((profile) => profile.available);
        if (!available) {
          await waitForQuotaWindow(observations, "no_available_profile");
          continue;
        }
        await createJob(profileFor(available.id));
      } else {
        const current = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
        if (["completed", "needs-improvement"].includes(current.status)) {
          await pollJob(Date.now() + 1_000);
          return;
        }
        if (current.status === "failed") {
          const failure = classifyGeminiFailure(current.error || current.message || "");
          if (!failure.retryableOnSameProfile) {
            if (await switchToAvailableProfile(observations, failure.code, current)) continue;
            await persist("non_retryable_profile_wait", {
              status: "waiting-alternate-profile",
              jobId: state.jobId,
              runId: current.runId || state.runId,
              profileId: state.profileId,
              failureCode: failure.code,
              nextAction: "wait for an alternate profile and create a new job; never resume this immutable run"
            });
            await waitForQuotaWindow(observations, "non_retryable_failure_needs_alternate_profile", "waiting-alternate-profile");
            continue;
          }
          const currentObservation = observations.find((profile) => profile.id === state.profileId);
          if (!currentObservation?.available) {
            if (await switchToAvailableProfile(observations, failure.code, current)) continue;
            await persist("selected_profile_quota_blocked", { status: "quota-blocked", profileId: state.profileId, jobId: state.jobId });
            await waitForQuotaWindow(observations, "selected_profile_quota_blocked");
            continue;
          }
          await resumeJob();
        }
      }
      const result = await pollJob(Date.now() + jobPollWindowMs);
      if (["completed", "review-needs-remediation", "review-reconciliation-required"].includes(result.kind)) return;
      if (result.kind === "failed") {
        if (state.attempts >= retryLimit) {
          const failedJobId = state.jobId;
          state = { ...state, jobId: null, runId: null, profileId: null, attempts: 0 };
          await persist("job_retry_limit_reached", {
            status: "monitoring",
            failedJobId,
            lastError: result.error,
            nextAction: "create_new_job"
          });
          await sleep(pollMs);
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
        await sleep(pollMs);
        continue;
      }
      let waitObservations = observations;
      let waitReason = "monitor_cycle";
      if (["quota-blocked", "non-retryable"].includes(result.kind)) {
        waitObservations = await observeProfiles();
        if (await switchToAvailableProfile(waitObservations, result.failure?.code || result.kind, result.job)) continue;
        if (result.kind === "non-retryable") {
          await persist("non_retryable_profile_wait", {
            status: "waiting-alternate-profile",
            jobId: state.jobId,
            runId: result.job?.runId || state.runId,
            profileId: state.profileId,
            failureCode: result.failure?.code || "non-retryable",
            nextAction: "wait for an alternate profile and create a new job; never resume this immutable run"
          });
          await waitForQuotaWindow(waitObservations, "non_retryable_failure_needs_alternate_profile", "waiting-alternate-profile");
          continue;
        }
        waitReason = "all_profiles_quota_blocked";
      }
      await waitForQuotaWindow(waitObservations, waitReason);
      continue;
    } catch (error) {
      await persist("monitor_error", { status: "monitoring", lastError: error.message });
      await sleep(pollMs);
    }
  }
  await persist("monitor_deadline", { status: "deadline-reached", lastError: "모니터링 최대 실행 시간이 만료되었습니다.", retryLimit });
}

if (import.meta.main) await main();
