import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { geminiQuotaStatus } from "../src/gemini-browser.mjs";

const root = resolve(import.meta.dirname, "..");
const workspaceDir = join(root, "workspace");
const statePath = join(workspaceDir, "gemini-monitor.json");
const logPath = join(workspaceDir, "gemini-monitor.jsonl");
const apiBase = process.env.PS4_API_BASE || "http://localhost:3000";
const pollMs = Math.max(30_000, Number(process.env.GEMINI_MONITOR_INTERVAL_MS || 300_000));
const jobPollMs = Math.max(3_000, Number(process.env.GEMINI_JOB_POLL_INTERVAL_MS || 10_000));
const maxRuntimeMs = Math.max(60_000, Number(process.env.GEMINI_MONITOR_MAX_RUNTIME_MS || 24 * 60 * 60 * 1000));
const retryLimit = Math.max(1, Math.min(5, Number(process.env.GEMINI_MONITOR_RETRY_LIMIT || 3)));
const jobPollWindowMs = Math.max(jobPollMs * 3, 4 * 60 * 1000);
const topic = process.env.GEMINI_MONITOR_TOPIC || "경복궁 마당이 평평해 보여도 울퉁불퉁한 이유";
const clipCount = Math.max(6, Math.min(12, Number(process.env.GEMINI_MONITOR_CLIP_COUNT || 8)));
const targetDurationSec = Math.max(54, Math.min(91, Number(process.env.GEMINI_MONITOR_TARGET_DURATION_SEC || 78)));
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
  state = { ...state, ...details, updatedAt: new Date().toISOString() };
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await appendFile(logPath, `${JSON.stringify({ schemaVersion: 2, event, at: state.updatedAt, ...details })}\n`);
  console.log(JSON.stringify({ event, ...details }));
}

async function api(path, options) {
  const response = await fetch(`${apiBase}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(-1000) }; }
  if (!response.ok) throw new Error(`${response.status}: ${body.error || body.message || text.slice(-500)}`);
  return body;
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

async function waitForQuotaWindow(observations, reason) {
  const resetAt = nextQuotaResetAt(observations);
  const now = Date.now();
  const waitMs = resetAt
    ? Math.max(30_000, resetAt.getTime() - now - quotaWakeLeadMs)
    : pollMs;
  await persist("quota_wait_scheduled", {
    status: "quota-blocked",
    quotaResetAt: resetAt?.toISOString() || null,
    nextQuotaCheckAt: new Date(now + waitMs).toISOString(),
    quotaWaitMs: waitMs,
    quotaWaitReason: reason
  });
  await sleep(waitMs);
}

function isQuotaError(value) {
  const text = String(value || "");
  return /you(?:'|’)re out of videos|videos will be available again|동영상 생성 할당량이 소진되었습니다|지금은 동영상을 생성할 수 없습니다|(?:할당량|쿼터).*(?:소진|사용할 수 없)|quota.*(?:exhaust|deplet|available again)/i.test(text);
}

function profileFor(id) {
  return profiles.find((profile) => profile.id === id) || null;
}

async function observeProfiles() {
  const observations = [];
  for (const profile of profiles) {
    try {
      observations.push({
        id: profile.id,
        email: profile.email,
        ...(await geminiQuotaStatus({ cdpUrl: profile.cdpUrl, profileDir: profile.profileDir }))
      });
    } catch (error) {
      observations.push({ id: profile.id, email: profile.email, available: false, error: error.message });
    }
  }
  await persist("profiles_observed", {
    status: observations.some((profile) => profile.available) ? "quota-available" : "quota-blocked",
    profiles: observations,
    lastError: observations.find((profile) => profile.error)?.error || null
  });
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
  await persist("job_created", { jobId: state.jobId, profileId: profile.id, email: profile.email, status: job.job.status });
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
      return { kind: "completed", job, quality };
    }
    if (job.status === "failed") {
      const detail = job.error || job.message || "Gemini 작업이 실패했습니다.";
      if (isQuotaError(detail)) {
        await persist("quota_blocked_during_job", { status: "quota-blocked", lastError: detail, runId: job.runId || state.runId });
        return { kind: "quota-blocked", job, error: detail };
      }
      await persist("job_failed", { status: "failed", lastError: detail, runId: job.runId || state.runId });
      return { kind: "failed", job, error: detail };
    }
    await sleep(jobPollMs);
  }
  await persist("job_poll_timeout", { status: "monitoring", lastError: "작업 상태 확인 시간이 초과되어 다음 주기에 재확인합니다." });
  return { kind: "timeout" };
}

async function switchToAvailableProfile(observations) {
  const alternate = observations.find((profile) => profile.available && profile.id !== state.profileId);
  if (!alternate) return false;
  await persist("profile_failover", { status: "switching-profile", previousProfileId: state.profileId, nextProfileId: alternate.id, nextEmail: alternate.email, previousJobId: state.jobId });
  state.jobId = null;
  state.runId = null;
  state.profileId = alternate.id;
  await createJob(profileFor(alternate.id));
  return true;
}

async function main() {
  await mkdir(workspaceDir, { recursive: true });
  try {
    const previous = JSON.parse(await readFile(statePath, "utf8"));
    if (previous?.status !== "production-complete") state = { ...state, ...previous, schemaVersion: 2, status: "resuming" };
  } catch {}
  await persist("monitor_started", { status: "monitoring", apiBase, pollMs, quotaWakeLeadMs, jobPollMs, retryLimit, profiles: profiles.map(({ id, email, cdpUrl, profileDir }) => ({ id, email, cdpUrl, profileDir })), clipCount, targetDurationSec });
  const deadline = Date.now() + maxRuntimeMs;
  while (Date.now() < deadline) {
    try {
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
        if (current.status === "completed") {
          await pollJob(Date.now() + 1_000);
          return;
        }
        if (current.status === "failed") {
          const currentObservation = observations.find((profile) => profile.id === state.profileId);
          if (!currentObservation?.available) {
            if (await switchToAvailableProfile(observations)) continue;
            await persist("selected_profile_quota_blocked", { status: "quota-blocked", profileId: state.profileId, jobId: state.jobId });
            await waitForQuotaWindow(observations, "selected_profile_quota_blocked");
            continue;
          }
          await resumeJob();
        }
      }
      const result = await pollJob(Date.now() + jobPollWindowMs);
      if (result.kind === "completed") return;
      if (result.kind === "failed") {
        if (state.attempts >= retryLimit) return;
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
      if (result.kind === "quota-blocked") {
        waitObservations = await observeProfiles();
        if (await switchToAvailableProfile(waitObservations)) continue;
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

await main();
