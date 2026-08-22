import { providerReadinessMarkup } from "./provider-readiness-view.js";
import { shotPatternsMarkup } from "./shot-patterns-view.js";
import {
  buildYouTubeVideoUrl,
  createProductionJobInertFirst,
  currentQualityEvidenceEntry,
  geminiQuotaMonitorSummary,
  invalidateQualityEvidenceCache,
  jobAnnouncementSignature,
  localClipReplacementConfirmation,
  localClipUploadExpectedRunId,
  partitionRunArtifacts,
  providerReadinessRefreshDelay,
  qualityEvidenceCacheEntryMatches,
  refreshQualityEvidenceCache,
  safeSameOriginArtifactUrl,
  safeYouTubeVideoUrl,
  semanticRevalidationEligibility,
  shouldPollJobs,
  stableUiSignature
} from "./job-ui-safety.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const PENDING_GEMINI_LAUNCH_KEY = "ps4.pending-gemini-launch.v1";
export const STUDIO_BEARER_SESSION_KEY = "ps4.studio-bearer.v1";
export const MAX_STUDIO_BEARER_BYTES = 4 * 1024;
const state = {
  studioToken: null,
  analysis: null,
  shotPatterns: null,
  jobs: [],
  selectedJobId: null,
  pendingGeminiLaunch: null,
  page: 1,
  query: "",
  sort: "views",
  category: "",
  poll: null,
  pollRequestedUntil: 0,
  pollFailureSignature: null,
  healthTimer: null,
  searchTimer: null,
  qualityDetails: {},
  jobListSignature: null,
  jobDetailSignature: null,
  pipelineSignature: null,
  announcedJobSignature: null
};

export function validStudioBearerToken(value) {
  if (typeof value !== "string" || value !== value.trim() || /\s|\p{Cc}|\p{Cs}/u.test(value)) return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= 32 && bytes <= MAX_STUDIO_BEARER_BYTES;
}

export function parseStudioBearerFragment(hash) {
  const source = typeof hash === "string" && hash.startsWith("#") ? hash.slice(1) : "";
  const params = new URLSearchParams(source);
  if (!params.has("token")) return { present: false, token: null };
  const exact = /^token=([^&]*)$/u.exec(source);
  let token = null;
  try {
    const decoded = exact ? decodeURIComponent(exact[1]) : null;
    token = validStudioBearerToken(decoded) ? decoded : null;
  } catch {
    token = null;
  }
  return { present: true, token };
}

export function consumeStudioBearerFragment(options = {}) {
  const location = options.location || globalThis.location;
  const history = options.history || globalThis.history;
  const storage = options.storage || globalThis.sessionStorage;
  const parsed = parseStudioBearerFragment(location?.hash || "");
  if (!parsed.present) return parsed;
  try {
    if (parsed.token) storage?.setItem?.(STUDIO_BEARER_SESSION_KEY, parsed.token);
    else storage?.removeItem?.(STUDIO_BEARER_SESSION_KEY);
  } catch {
    // Page memory remains origin-bound even when sessionStorage is disabled.
  } finally {
    history?.replaceState?.(history.state ?? null, "", `${location?.pathname || "/"}${location?.search || ""}`);
  }
  return parsed;
}

export function readStoredStudioBearer(storage = globalThis.sessionStorage) {
  let token = null;
  try {
    token = storage?.getItem?.(STUDIO_BEARER_SESSION_KEY) || null;
  } catch {
    return null;
  }
  if (validStudioBearerToken(token)) return token;
  try { storage?.removeItem?.(STUDIO_BEARER_SESSION_KEY); } catch {}
  return null;
}

export function authorizedStudioFetchOptions(options = {}, token) {
  if (!validStudioBearerToken(token)) throw new Error("Studio Bearer token이 잠겨 있습니다.");
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  return { ...options, headers, credentials: "omit", referrerPolicy: "no-referrer" };
}

function activateNavigation(targetId) {
  const links = $$(".nav-item");
  if (!links.some((link) => link.getAttribute("href") === `#${targetId}`)) return;
  links.forEach((link) => {
    const active = link.getAttribute("href") === `#${targetId}`;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ko-KR");
}

function formatViews(value) {
  const number = Number(value || 0);
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1).replace(/\.0$/, "")}만`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}천`;
  return formatNumber(number);
}

function formatTime(seconds) {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatMiB(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)}MB` : "—";
}

function readPendingGeminiLaunch() {
  try {
    const stored = JSON.parse(globalThis.sessionStorage?.getItem(PENDING_GEMINI_LAUNCH_KEY) || "null");
    const value = stored || state.pendingGeminiLaunch;
    if (
      value?.schemaVersion !== 1
      || typeof value.jobId !== "string"
      || !value.jobId
      || /[\0/\\]/u.test(value.jobId)
      || typeof value.requestSignature !== "string"
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function rememberPendingGeminiLaunch(jobId, requestSignature) {
  const value = { schemaVersion: 1, jobId, requestSignature };
  state.pendingGeminiLaunch = value;
  try {
    globalThis.sessionStorage?.setItem(PENDING_GEMINI_LAUNCH_KEY, JSON.stringify(value));
  } catch {
    // Session storage is a UX retry aid. The server's exact job id remains the
    // provider-side idempotency boundary when storage is unavailable.
  }
}

function forgetPendingGeminiLaunch() {
  state.pendingGeminiLaunch = null;
  try {
    globalThis.sessionStorage?.removeItem(PENDING_GEMINI_LAUNCH_KEY);
  } catch {
    // Ignore browser storage policy failures.
  }
}

const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 증거·미디어 규격", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "출처 텍스트 결속·벤치마크 적합성", weight: 10 },
  { id: "automationRecovery", label: "자동화 재현성·실패 복구", weight: 10 }
];

const PROVIDER_COPY = {
  "gemini-browser": {
    short: "Gemini Chrome",
    detail: "Gemini Chrome",
    generation: "Gemini video",
    generationDetail: "Chrome 브라우저 자동화",
    status: "Gemini Chrome"
  },
  "local-video": {
    short: "로컬 영상 모델",
    detail: "로컬 영상 모델 명령 어댑터",
    generation: "Local video model",
    generationDetail: "설정된 로컬 생성기 명령 · 업로드 아님",
    status: "로컬 영상 모델"
  },
  local: {
    short: "로컬 클립 업로드",
    detail: "로컬 클립 업로드 후 편집",
    generation: "Local clip source",
    generationDetail: "업로드한 클립 사용 · 영상 생성 없음",
    status: "로컬 클립 편집"
  }
};

function providerCopy(provider) {
  return PROVIDER_COPY[provider] || {
    short: "알 수 없는 제공자",
    detail: "알 수 없는 제공자",
    generation: "Video source",
    generationDetail: "제공자 확인 필요",
    status: "제공자 확인 필요"
  };
}

function scoreText(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : "—";
}

function syncToggleLabels() {
  $$(".toggle-state").forEach((label) => {
    const input = document.getElementById(label.dataset.toggleState);
    label.textContent = input?.checked ? "ON" : "OFF";
  });
}
function renderAHPPanel(quality, history) {
  const criteria = Array.isArray(quality?.criteria) && quality.criteria.length
    ? quality.criteria
    : AHP_CRITERIA.map((criterion) => ({ ...criterion, autoScore: null, committeeScore: null, score: null, blockers: [] }));
  const rows = criteria.map((criterion) => {
    const blockers = Array.isArray(criterion.blockers) && criterion.blockers.length
      ? `<small class="ahp-blockers">${criterion.blockers.map((item) => escapeHtml(item)).join(" · ")}</small>`
      : "";
    return `<div class="ahp-row"><div><b>${escapeHtml(criterion.label)}</b><small>${criterion.weight || AHP_CRITERIA.find((item) => item.id === criterion.id)?.weight || 0}% · 자동 ${scoreText(criterion.autoScore)} · reviewer payload ${scoreText(criterion.committeeScore)}</small>${blockers}</div><strong>${scoreText(criterion.score)}</strong></div>`;
  }).join("");
  const metrics = quality?.metrics || {};
  const historyItems = Array.isArray(history) ? history : [];
  const historyMarkup = historyItems.length
    ? historyItems.map((item) => `<span>ITERATION ${item.iteration}: ${scoreText(item.totalScore)} · ${escapeHtml(item.status || "unknown")}</span>`).join("")
    : `<span>${history?.error ? `이력 검증 실패: ${escapeHtml(history.error)}` : "봉인된 반복 이력이 아직 없습니다."}</span>`;
  const provenance = [
    ["RUN", quality?.runId || "—"],
    ["PROVIDER", metrics.provider || "—"],
    ["TECHNICAL EVIDENCE", quality?.technicalEvidenceGate || metrics.technicalEvidenceGate ? "PASS" : "CLOSED"],
    ["CONTENT SEMANTICS", quality?.semanticGate ? "RUN-BOUND PASS · 사람 승인 아님" : "NOT VERIFIED · 사람 검토 필요"],
    ["AUDIO TRACKS", metrics.finalMedia?.audioStreamCount ?? "—"],
    ["VOICE STYLE", metrics.voiceoverSync?.voiceStyle || "—"],
    ["INPUT BINDING", metrics.inputManifestBinding ? "PASS" : "FAIL"],
    ["CLIP MOTION", metrics.inputMotionGate?.enforced ? (metrics.inputMotionGateBinding ? "PASS · RECOMPUTED" : "FAIL") : (metrics.inputMotionGate ? `MEASURED · ${metrics.inputMotionGate.observedPass ? "PASS" : "NOT SUBMISSION-ELIGIBLE"}` : "—")],
    ["BENCHMARK RECEIPT", metrics.benchmarkReceiptBinding ? "PASS" : "FAIL"],
    ["IMMUTABLE CLOSURE", metrics.immutableClosureBinding ? "PASS" : "FAIL"],
    ["EVIDENCE HASHES", `${Object.keys(metrics.evidenceHashes || {}).length}개`],
    ["RLM", metrics.benchmarkRlm?.sha256 || "—"]
  ].map(([label, value]) => `<span><b>${label}</b><em>${escapeHtml(value)}</em></span>`).join("");
  const commands = [
    `GET /api/jobs/${encodeURIComponent(quality?.jobId || "")}/quality`,
    `GET /api/jobs/${encodeURIComponent(quality?.jobId || "")}/quality/history`,
    "bun scripts/analyze-channel.mjs",
    "bun scripts/run-rlm-analysis.mjs"
  ].map((command) => `<code>${escapeHtml(command)}</code>`).join("");
  const technicalPass = Boolean(quality?.technicalEvidenceGate || metrics.technicalEvidenceGate);
  return `<section class="job-ahp panel"><div class="job-ahp-head"><div><span class="panel-kicker">AHP EVIDENCE RECEIPT</span><h4>${technicalPass ? "기술 증거·무결성 검사 통과 · 콘텐츠 품질 판정 아님" : "기술 증거 또는 reviewer payload 미충족"}</h4></div><strong>${scoreText(quality?.totalScore)}<small>/ 100</small></strong></div><div class="ahp-rows">${rows}</div><div class="evidence-grid">${provenance}</div><div class="history-strip"><span class="panel-kicker">ITERATION HISTORY</span>${historyMarkup}</div><div class="verification-strip"><span class="panel-kicker">REPRODUCTION COMMANDS</span>${commands}</div></section>`;
}

async function api(path, options = {}) {
  if (!state.studioToken) throw new Error("Studio가 잠겨 있습니다.");
  const target = new URL(String(path), globalThis.location?.origin);
  if (
    target.origin !== globalThis.location?.origin
    || target.username
    || target.password
    || !target.pathname.startsWith("/api/")
    || target.hash
  ) throw new Error("Studio API 대상이 exact same-origin 경계가 아닙니다.");
  const response = await fetch(target.href, authorizedStudioFetchOptions(options, state.studioToken));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message, type = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = "toast"; }, 4200);
}

function renderStats() {
  const { snapshot, videos, shortsDuration, shortsRecentDuration } = state.analysis;
  const currentDuration = shortsRecentDuration || shortsDuration;
  const average = videos.length ? Math.round(videos.reduce((sum, video) => sum + video.viewCount, 0) / videos.length) : 0;
  $("#stats").innerHTML = [
    ["CHANNEL SCALE", formatNumber(snapshot.subscribers), "구독자", "accent"],
    ["FULL INDEX", formatNumber(snapshot.totalVideos), "전체 영상", ""],
    ["SHORTS ENGINE", formatNumber(snapshot.shorts), "쇼츠 영상", ""],
    ["CURRENT LENGTH", `${currentDuration?.medianSec || currentDuration?.recommendedTargetSec || 78}s`, `최근 ${currentDuration?.population || snapshot.shorts}개 평균 ${currentDuration?.meanSec || 75.1}s`, ""],
    ["AVG. SIGNAL", formatViews(average), "영상당 평균 조회수", ""]
  ].map(([label, value, caption, tone]) => `<div class="stat-card ${tone}"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>`).join("");
}

function renderBenchmark() {
  const { editorialHypothesis, categories, hooks, topVideos } = state.analysis;
  const hypothesis = editorialHypothesis || {};
  $("#promise").textContent = hypothesis.promise || "편집 가설을 사용할 수 없습니다.";
  $("#formula").textContent = hypothesis.titleFormula || "";
  $("#editorial-hypothesis-limit").textContent = hypothesis.limitation || "제목·메타데이터 휴리스틱이며 시청각 관측 결과가 아닙니다.";
  $("#narrative").innerHTML = (hypothesis.narrative || []).map((item) => `<div class="narrative-item"><span>${String(item.step).padStart(2, "0")}</span><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div></div>`).join("");
  const maxCategory = Math.max(...categories.map((item) => item.totalViews), 1);
  $("#categories").innerHTML = categories.map((item) => `<div class="category-row"><div class="category-meta"><span>${escapeHtml(item.label)}</span><b>${formatViews(item.averageViews)} 평균</b></div><div class="bar-track"><i style="width:${Math.max(4, Math.round(item.totalViews / maxCategory * 100))}%"></i></div><small>${item.count}개 · 누적 ${formatViews(item.totalViews)}</small></div>`).join("");
  $("#top-hooks").innerHTML = hooks.map((item, index) => `<div class="hook-row"><span class="rank">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(item.label)}</b><small>${item.count}개 사용 · ${formatViews(item.averageViews)} 평균 조회</small></div><span class="hook-arrow" aria-hidden="true">↗</span></div>`).join("");
  $("#top-videos").innerHTML = topVideos.slice(0, 8).map((video, index) => {
    const href = buildYouTubeVideoUrl(video.id);
    if (!href) return "";
    return `<a class="top-video" href="${href}" target="_blank" rel="noreferrer"><span class="rank">${String(index + 1).padStart(2, "0")}</span><span class="top-video-title">${escapeHtml(video.title)}</span><strong>${formatViews(video.viewCount)}</strong></a>`;
  }).join("");
  $("#video-category").innerHTML = `<option value="">전체 주제</option>${categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}`;
  const committeeRoles = [
    ["구조 규칙 검사", "대본 필드·출처 텍스트 결속"],
    ["미디어 증거 존재 검사", "프레임 분석·증거 파일 존재"],
    ["타임라인 정합 검사", "렌더·컷 경계 구조"],
    ["자막·오디오 QC", "자막 측정·오디오 계측"],
    ["provenance 복구 검사", "해시·run·provider 결속"]
  ];
  $("#committee-roles").innerHTML = committeeRoles.map(([role, scope]) => `<div class="committee-role"><span class="role-mark" aria-hidden="true">+</span><div><b>${escapeHtml(role)}</b><small>${escapeHtml(scope)}</small></div><span class="role-status">SOFTWARE METHOD</span></div>`).join("");
  const ahpWeights = state.analysis.ahp?.weights || AHP_CRITERIA;
  $("#ahp-criteria").innerHTML = `<div class="ahp-benchmark-note"><b>고정 AHP 가중치</b><span>${ahpWeights.map((criterion) => `${escapeHtml(criterion.label)} ${criterion.weight || criterion.targetWeight}%`).join(" · ")}</span><small>분석 산출물은 제목·메타데이터 휴리스틱이며, 프레임·음성·자막 의미론을 대신하지 않습니다.</small></div>`;
  const durationSnapshot = state.analysis.benchmarkProfile?.duration;
  const duration = durationSnapshot?.recentSummary || state.analysis.shortsRecentDuration || durationSnapshot?.summary || durationSnapshot || state.analysis.shortsDuration;
  const mediaEvidence = state.analysis.benchmarkProfile?.rlm?.mediaEvidence || {};
  const mediaReceipt = state.analysis.benchmarkProfile?.media || {};
  const numericOrNull = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const sampleCount = numericOrNull(mediaEvidence.sampleCount);
  const selectedCount = Array.isArray(mediaReceipt.selected) ? mediaReceipt.selected.length : numericOrNull(mediaReceipt.limit);
  const mediaScope = sampleCount === null
    ? "미디어 표본 자료 없음"
    : `컨테이너 ${sampleCount} · 오디오 ${numericOrNull(mediaEvidence.audioSampleCount) ?? "미측정"} · 자막 ${numericOrNull(mediaEvidence.captionSampleCount) ?? "미측정"}`;
  const rlmLevels = state.analysis.benchmarkProfile?.rlm?.reduction?.levels?.map((level) => level.length).join(" → ") || "8 → 1";
  const buckets = Array.isArray(durationSnapshot?.buckets) ? durationSnapshot.buckets : [];
  const totalShorts = Number(state.analysis.snapshot?.shorts || state.analysis.snapshot?.totalVideos || 1);
  const bucketHeight = (index) => Math.max(8, Math.round(Number(buckets[index]?.count || 0) / Math.max(1, totalShorts) * 100));
  const range = duration?.recommendedRangeSec || [duration?.p10Sec || 0, duration?.p90Sec || 0];
  const populationLabel = duration.population ? `최근 ${duration.population}개` : `전체 ${totalShorts}개`;
  $("#duration-profile").innerHTML = duration ? `<div class="duration-profile-head"><span>DETERMINISTIC RECURSIVE METADATA REDUCER · yt-dlp</span><b>${duration.recommendedTargetSec}s target</b></div><div class="duration-bars"><i style="height:${bucketHeight(0)}%"></i><i style="height:${bucketHeight(1)}%"></i><i style="height:${bucketHeight(2)}%"></i><i style="height:${bucketHeight(3)}%"></i></div><small>${populationLabel} · 권장 범위 ${range[0]}–${range[1]}초 · 전체 ${totalShorts} Shorts 메타데이터 집계 · ${selectedCount === null ? "선택 수 미측정" : `${selectedCount}개 선택`} / ${mediaScope} · 비대표 표본 · 재귀 집계 ${rlmLevels}</small>` : "";
}

function renderShotPatterns() {
  const container = $("#shot-pattern-list");
  if (!container) return;
  container.innerHTML = shotPatternsMarkup(state.shotPatterns);
}

async function renderVideos() {
  const params = new URLSearchParams({ page: state.page, limit: 24, sort: state.sort });
  if (state.query) params.set("q", state.query);
  if (state.category) params.set("category", state.category);
  const payload = await api(`/api/channel/videos?${params}`);
  const totalPages = Math.max(1, Math.ceil(payload.total / payload.limit));
  if (state.page > totalPages) { state.page = totalPages; return renderVideos(); }
  $("#page-label").textContent = `${state.page} / ${totalPages}`;
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= totalPages;
  const videoRows = (Array.isArray(payload.videos) ? payload.videos : []).map((video) => {
    const href = safeYouTubeVideoUrl(video.url);
    if (!href) return "";
    const category = video.analysis.categories[0]?.label || "분석 중";
    const hook = video.analysis.hookScore;
    return `<a class="library-row" href="${href}" target="_blank" rel="noreferrer"><span class="library-position">${String(video.position).padStart(3, "0")}</span><span class="library-title">${escapeHtml(video.title)}<small>${escapeHtml(category)} · ${video.type === "short" ? "Shorts" : escapeHtml(video.duration || "롱폼")}</small></span><span class="hook-score"><i style="width:${hook}%"></i><small>훅 ${hook}</small></span><strong>${formatViews(video.viewCount)}</strong><span class="library-arrow" aria-hidden="true">↗</span></a>`;
  }).filter(Boolean);
  $("#video-library").innerHTML = videoRows.length ? videoRows.join("") : `<div class="empty-state">검색 조건에 맞는 영상이 없습니다.</div>`;
}

function passedTechnicalEvidenceGate(job, quality = null) {
  const result = quality || currentQualityEvidenceEntry(job, state.qualityDetails[job?.id])?.quality || job?.qualitySummary;
  return Boolean(result?.technicalEvidenceGate === true || result?.metrics?.technicalEvidenceGate === true);
}

function passedSemanticGate(job, quality = null) {
  const result = quality || currentQualityEvidenceEntry(job, state.qualityDetails[job?.id])?.quality || job?.qualitySummary;
  return result?.semanticGate === true;
}

function statusLabel(status, job = null, quality = null) {
  if (job?.integrity?.status === "blocked") return "무결성 차단";
  if (status === "completed") {
    if (passedTechnicalEvidenceGate(job, quality) && passedSemanticGate(job, quality)) return "기술·의미 gate 통과 · 게시 전 사람 승인 별도";
    return quality || job?.qualitySummary ? "렌더 완료 · 검증 gate 미통과" : "렌더 완료 · 검증 미확인";
  }
  return status === "needs-improvement" ? "렌더 완료 · 개선 필요" : status === "failed" ? "오류" : status === "verifying" ? "검수 중" : status === "running" ? "제작 중" : status === "queued" ? "대기열" : "상태 확인 중";
}

const JOB_STATUS_CLASS_TOKENS = new Set(["queued", "running", "verifying", "completed", "needs-improvement", "failed"]);

export function jobStatusClassToken(job) {
  if (job?.integrity?.status === "blocked") return "integrity-blocked";
  return JOB_STATUS_CLASS_TOKENS.has(job?.status) ? job.status : "unknown";
}

function clampedProgress(value) {
  const progress = Number(value);
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0;
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedJobId) || null;
}

function captureJobFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || (!$("#jobs-list")?.contains(active) && !$("#job-detail")?.contains(active))) return null;
  const card = active.closest?.("[data-job-id]");
  return {
    jobId: card?.dataset.jobId || null,
    control: active.dataset.focusKey || active.id || null,
    selectionStart: typeof active.selectionStart === "number" ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === "number" ? active.selectionEnd : null
  };
}

function restoreJobFocus(snapshot) {
  if (!snapshot) return;
  let target = snapshot.control ? document.querySelector(`[data-focus-key="${CSS.escape(snapshot.control)}"]`) : null;
  if (!target && snapshot.control) target = document.getElementById(snapshot.control);
  if (!target && snapshot.jobId) target = [...document.querySelectorAll(".job-card")].find((button) => button.dataset.jobId === snapshot.jobId);
  if (!(target instanceof HTMLElement)) return;
  target.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
  }
}

function listUiProjection(jobs) {
  return jobs.map((job) => ({
    id: job.id,
    topic: job.topic,
    provider: job.provider,
    status: job.status,
    stage: job.stage,
    progress: clampedProgress(job.progress),
    createdAt: job.createdAt,
    integrityStatus: job.integrity?.status || null,
    qualitySummary: job.qualitySummary || null
  }));
}

function detailUiProjection(job) {
  if (!job) return null;
  return {
    ...job,
    artifacts: (Array.isArray(job.artifacts) ? job.artifacts : []).map((artifact) => ({
      name: artifact?.name || null,
      kind: artifact?.kind || null,
      url: artifact?.url || null,
      bytes: Number.isSafeInteger(Number(artifact?.bytes)) ? Number(artifact.bytes) : null,
      sha256: artifact?.sha256 || null
    })),
    clientQuality: currentQualityEvidenceEntry(job, state.qualityDetails[job.id])
  };
}

function announceSelectedJob(job) {
  const announcer = $("#job-status-announcer");
  if (!announcer || !job) return;
  const signature = jobAnnouncementSignature(job);
  if (signature === state.announcedJobSignature) return;
  state.announcedJobSignature = signature;
  announcer.textContent = `${job.topic || "선택한 작업"}: ${statusLabel(job.status, job)}, ${job.stage || "단계 확인 중"}. ${job.integrity?.message || job.message || ""}`;
}

async function loadQualityEvidence(job) {
  if (!job?.runId || job.integrity?.status === "blocked" || !["completed", "needs-improvement"].includes(job.status)) return;
  const cached = state.qualityDetails[job.id];
  const result = await refreshQualityEvidenceCache(job, cached, async () => {
    const [quality, history] = await Promise.all([
      api(`/api/jobs/${encodeURIComponent(job.id)}/quality`),
      api(`/api/jobs/${encodeURIComponent(job.id)}/quality/history`)
    ]);
    return { quality, history: history.iterations || [] };
  });
  if (!result.refreshed || !result.entry) return;
  const currentJob = state.jobs.find((entry) => entry.id === job.id);
  if (!qualityEvidenceCacheEntryMatches(currentJob, result.entry)) return;
  state.qualityDetails[job.id] = result.entry;
  if (state.selectedJobId === job.id) {
    state.jobDetailSignature = null;
    renderJobDetail(currentJob);
  }
}

function renderJobs({ focusSelectedCard = false } = {}) {
  const list = $("#jobs-list");
  const focusSnapshot = captureJobFocus();
  if (!state.jobs.length) {
    const emptySignature = stableUiSignature([]);
    if (state.jobListSignature !== emptySignature) {
      list.innerHTML = `<div class="empty-state">아직 제작 작업이 없습니다.<br />위에서 주제를 입력하면 파이프라인이 시작됩니다.</div>`;
      state.jobListSignature = emptySignature;
    }
    if (state.jobDetailSignature !== "empty") {
      $("#job-detail").innerHTML = `<div class="empty-detail"><span aria-hidden="true">◌</span><p>작업을 선택하면<br />실시간 산출물이 표시됩니다.</p></div>`;
      state.jobDetailSignature = "empty";
    }
    renderPipeline(null);
    return;
  }
  if (!state.selectedJobId || !state.jobs.some((job) => job.id === state.selectedJobId)) state.selectedJobId = state.jobs[0].id;
  const listSignature = stableUiSignature({ jobs: listUiProjection(state.jobs), selectedJobId: state.selectedJobId });
  if (state.jobListSignature !== listSignature) {
    list.innerHTML = state.jobs.map((job) => {
      const progress = clampedProgress(job.progress);
      return `<button class="job-card ${job.id === state.selectedJobId ? "selected" : ""}" aria-controls="job-detail" aria-pressed="${job.id === state.selectedJobId}" data-job-id="${escapeHtml(job.id)}"><div class="job-card-top"><span class="job-status ${jobStatusClassToken(job)}"><i aria-hidden="true"></i>${statusLabel(job.status, job)}</span><time>${new Date(job.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><h3>${escapeHtml(job.topic)}</h3><div class="job-card-bottom"><span>${escapeHtml(job.integrity?.status === "blocked" ? "봉인 증거 확인 필요" : job.stage)} · ${escapeHtml(providerCopy(job.provider).short)}</span><strong>${progress}%</strong></div><div class="mini-progress" role="progressbar" aria-label="${escapeHtml(job.topic)} 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div></button>`;
    }).join("");
    state.jobListSignature = listSignature;
  }
  list.onclick = (event) => {
    const button = event.target.closest(".job-card");
    if (!button) return;
    state.selectedJobId = button.dataset.jobId;
    state.jobListSignature = null;
    state.jobDetailSignature = null;
    state.pipelineSignature = null;
    renderJobs({ focusSelectedCard: true });
  };
  const selected = selectedJob();
  renderJobDetail(selected);
  renderPipeline(selected);
  announceSelectedJob(selected);
  if (focusSelectedCard) {
    [...list.querySelectorAll(".job-card")].find((button) => button.dataset.jobId === state.selectedJobId)?.focus({ preventScroll: true });
  } else restoreJobFocus(focusSnapshot);
  if (selected && ["completed", "needs-improvement"].includes(selected.status) && selected.runId) void loadQualityEvidence(selected);
}

function renderPipeline(job) {
  const signature = stableUiSignature(job ? {
    id: job.id,
    provider: job.provider,
    status: job.status,
    stage: job.stage,
    progress: clampedProgress(job.progress),
    message: job.message || null,
    integrity: job.integrity || null,
    qualitySummary: job.qualitySummary || null
  } : null);
  if (state.pipelineSignature === signature) return;
  state.pipelineSignature = signature;
  const generationStep = $('[data-role="generation"]');
  const copy = providerCopy(job?.provider);
  if (generationStep) {
    generationStep.dataset.stage = job?.provider === "local-video" ? "로컬 영상 생성" : job?.provider === "gemini-browser" ? "Gemini 영상" : "영상 생성";
    const title = generationStep.querySelector("b");
    const description = generationStep.querySelector("small");
    if (title) title.textContent = job ? copy.generation : "Video generation";
    if (description) description.textContent = job ? copy.generationDetail : "Gemini Chrome 또는 설정된 로컬 모델";
  }
  const stageIndexFor = (stage = "") => {
    if (stage.includes("준비") || stage === "대기") return 1;
    if (stage.includes("Gemini") || stage.includes("영상 생성") || stage.includes("로컬 영상")) return 2;
    if (stage.includes("편집") || stage.includes("정규화")) return 3;
    if (stage.includes("자막") || stage.includes("음성")) return 4;
    if (stage.includes("검수") || stage.includes("검증")) return 5;
    if (stage.includes("완료")) return 6;
    return 0;
  };
  const currentIndex = job
    ? ["completed", "needs-improvement"].includes(job.status) ? 6 : stageIndexFor(job.stage)
    : -1;
  $$(".pipeline-step").forEach((step) => {
    const stageIndex = stageIndexFor(step.dataset.stage);
    const active = Boolean(job && ["queued", "running", "verifying"].includes(job.status) && stageIndex === currentIndex);
    const done = Boolean(job && (["completed", "needs-improvement"].includes(job.status) || stageIndex < currentIndex));
    const gatePassed = passedTechnicalEvidenceGate(job);
    step.classList.toggle("done", done && (stageIndex < 6 || gatePassed));
    step.classList.toggle("current", active);
    step.classList.toggle("error", Boolean(job && job.status === "failed" && stageIndex === currentIndex));
    step.setAttribute("aria-current", active ? "step" : "false");
    const stateLabel = step.querySelector(".step-state");
    stateLabel.textContent = job?.status === "failed" && stageIndex === currentIndex
      ? "FAIL"
      : done ? (stageIndex === 6 && !gatePassed ? "GATE CLOSED" : job.status === "needs-improvement" ? "REVIEW" : "DONE") : active ? (job.status === "verifying" ? "VERIFY" : "RUN") : "WAIT";
  });
  $("#pipeline-status").textContent = job ? `${copy.status} · ${statusLabel(job.status, job)} · ${clampedProgress(job.progress)}% · ${job.integrity?.message || job.message || ""}` : "대기 중";
}

function renderJobDetail(job) {
  const detail = $("#job-detail");
  if (!job) return;
  const signature = stableUiSignature(detailUiProjection(job));
  if (state.jobDetailSignature === signature) return;
  const focusSnapshot = captureJobFocus();
  const copy = providerCopy(job.provider);
  const warnings = (job.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const artifactRecords = Array.isArray(job.artifacts) ? job.artifacts : [];
  const verifiedArtifactUrl = (artifact) => safeSameOriginArtifactUrl(
    artifact?.url,
    globalThis.location?.origin,
    { jobId: job.id, artifactName: artifact?.name }
  );
  const artifactLinkMarkup = (artifact) => {
    const href = verifiedArtifactUrl(artifact);
    if (!href) return "";
    const glyph = artifact.kind?.includes("video") ? "▶" : artifact.kind?.includes("thumbnail") ? "▧" : "≡";
    const receipt = artifact.sha256 && Number.isSafeInteger(Number(artifact.bytes))
      ? `<em>${escapeHtml(String(artifact.sha256).slice(0, 15))}… · ${formatNumber(artifact.bytes)} B</em>`
      : "";
    return `<a class="artifact-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer"><span aria-hidden="true">${glyph}</span>${escapeHtml(artifact.name)}${receipt}<b aria-hidden="true">↗</b></a>`;
  };
  const artifactGroups = partitionRunArtifacts(artifactRecords, job.runId);
  const immutableArtifacts = artifactGroups.immutable.map(artifactLinkMarkup).filter(Boolean).join("");
  const revisionArtifacts = artifactGroups.revision.map(artifactLinkMarkup).filter(Boolean).join("");
  const mutableArtifacts = artifactGroups.mutable.map(artifactLinkMarkup).filter(Boolean).join("");
  const localReady = job.provider === "local"
    && job.localClipImport?.status === "ready"
    && job.localClipImport?.clipCount === job.clipCount
    && job.localClipImport?.providerEvidenceEligible === false;
  const localControls = job.provider === "local" && job.integrity?.status !== "blocked" && !["running", "verifying"].includes(job.status)
    ? `<div class="upload-box"><label for="detail-upload"><span>정확히 ${escapeHtml(job.clipCount)}개 클립을 선택하세요</span><small>선택한 순서가 장면 순서가 됩니다 · 파일당 최대 64 MiB · 합계 64 MiB · 각 0.25–180초 · 4K 이하 · MP4/MOV/WebM/M4V/MKV</small></label><input id="detail-upload" data-focus-key="detail-upload" type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v,video/x-matroska,.mp4,.mov,.webm,.m4v,.mkv" multiple aria-describedby="detail-upload-status" /><p id="detail-upload-status" class="upload-status" role="status" aria-live="polite">${localReady ? `${escapeHtml(job.localClipImport.clipCount)}개 검증 완료 · ${formatMiB(job.localClipImport.totalBytes)} · 선택 순서대로 실행 준비됨` : `아직 검증된 클립 세트가 없습니다 · ${escapeHtml(job.clipCount)}개를 한 번에 선택하세요.`}</p><button class="secondary-button" data-focus-key="run-local" id="run-local"${localReady ? "" : " disabled"}>검증된 ${escapeHtml(job.clipCount)}개 클립으로 편집 실행</button></div>`
    : "";
  const localVideoControls = job.provider === "local-video" && job.integrity?.status !== "blocked" && job.status === "queued" ? `<div class="upload-box"><span>영수증 어댑터 실행 대기</span><small>설정된 생성기·비용 상한을 확인한 뒤 시작합니다.</small><button class="secondary-button" data-focus-key="run-provider" id="run-provider">local-video 생성 시작</button></div>` : "";
  const geminiControls = job.provider === "gemini-browser" && job.integrity?.status !== "blocked" && job.status === "queued" ? `<div class="upload-box"><span>Gemini 대기 작업</span><small>이 작업 ID만 다시 시작합니다. 새 provider 작업을 만들지 않습니다.</small><button class="secondary-button" data-focus-key="run-gemini" id="run-gemini">이 Gemini 작업 시작·재확인</button></div>` : "";
  const semanticEligibility = semanticRevalidationEligibility(job);
  const semanticRevalidationControls = semanticEligibility.eligible
    ? `<div class="upload-box"><span>Purpose-aware 로컬 의미 재검수</span><small>가능 여부를 현재 봉인 run에서 다시 확인한 뒤 새 child run을 만듭니다. 통과·완료를 미리 보장하지 않습니다.</small><button class="secondary-button" data-focus-key="semantic-revalidate" id="semantic-revalidate">기존 봉인 영상만 로컬 재검수 · Gemini 요청 0회</button></div>`
    : job.provider === "local-video" && job.status === "needs-improvement"
      ? `<div class="pending-evidence">로컬 의미 재검수 대기 · ${escapeHtml(job.semanticRevalidationReadiness?.reason || "provider-0 resume 경로를 지원하지 않습니다.")}</div>`
      : "";
  const providerNotice = job.provider === "local-video"
    ? `<div class="pending-evidence">로컬 영상 모델 명령 어댑터 · 설정된 로컬 생성기 실행 결과만 사용합니다. 로컬 클립 업로드 경로가 아닙니다.</div>`
    : "";
  const detailState = currentQualityEvidenceEntry(job, state.qualityDetails[job.id]);
  const quality = detailState?.quality || job.qualitySummary;
  const history = detailState?.history || [];
  const runArtifact = (suffix) => artifactRecords.find((artifact) => job.runId && artifact.name === `runs/${job.runId}/artifacts/${suffix}`) || {};
  const previewVideo = runArtifact("final.mp4");
  const previewThumbnail = runArtifact("thumbnail.jpg");
  const previewVideoUrl = verifiedArtifactUrl(previewVideo);
  const previewThumbnailUrl = verifiedArtifactUrl(previewThumbnail);
  const previewMarkup = previewVideoUrl
    ? `<video controls playsinline preload="metadata"${previewThumbnailUrl ? ` poster="${escapeHtml(previewThumbnailUrl)}"` : ""} src="${escapeHtml(previewVideoUrl)}"></video>`
    : `<div class="preview-unavailable">현재 실행의 불변 미리보기 산출물이 없습니다.</div>`;
  const qualityPanel = quality
    ? `<div class="ahp-summary ${passedTechnicalEvidenceGate(job, quality) ? "passed" : "needs-improvement"}"><div><span class="panel-kicker">${passedTechnicalEvidenceGate(job, quality) ? "TECHNICAL EVIDENCE GATE PASSED" : "TECHNICAL EVIDENCE GATE CLOSED"}</span><strong>${scoreText(quality.totalScore)}<small>/ 100</small></strong></div><span>${passedTechnicalEvidenceGate(job, quality) ? "구조·무결성 검사 통과 · 콘텐츠 품질 판정 아님" : `${job.status === "needs-improvement" ? "개선 필요 · " : ""}점수만으로는 기술 검사 통과가 아닙니다`}</span></div>${renderAHPPanel(quality, history)}${quality.blockers?.length ? `<div class="warning-box"><b>차단·개선 항목</b><ul>${quality.blockers.slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}`
    : `<div class="pending-evidence">품질 검수 대기 · 현재 상태 ${escapeHtml(statusLabel(job.status, job))}${detailState?.error ? ` · ${escapeHtml(detailState.error)}` : ""}</div>`;
  const progress = clampedProgress(job.progress);
  detail.innerHTML = `<div class="detail-head"><div><span class="panel-kicker">SELECTED JOB</span><h3>${escapeHtml(job.topic)}</h3></div><span class="job-status ${jobStatusClassToken(job)}"><i aria-hidden="true"></i>${statusLabel(job.status, job, quality)}</span></div><div class="detail-progress"><div><span>${escapeHtml(job.integrity?.message || job.message || "")}</span><b>${progress}%</b></div><div class="progress-track" role="progressbar" aria-label="선택한 작업 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div></div>${qualityPanel}${["completed", "needs-improvement"].includes(job.status) && job.integrity?.status !== "blocked" ? `<div class="preview-wrap">${previewMarkup}<div class="preview-caption"><span>FINAL PREVIEW · RUN-BOUND</span><span>${formatTime(job.duration)} · ${job.format === "vertical" ? "9:16" : "16:9"}</span></div></div>` : ""}${providerNotice}${localControls}${localVideoControls}${geminiControls}${semanticRevalidationControls}<div class="detail-meta"><span>생성 모드 <b>${escapeHtml(copy.detail)}</b></span><span>자막 <b>${job.captions ? "ON" : "OFF"}</b></span><span>내레이션 <b>${job.voiceover ? "ON" : "OFF"}</b></span><span>RUN <b>${escapeHtml(job.runId || "—")}</b></span><span>RUN STATUS <b>${escapeHtml(job.runStatus || "—")}</b></span></div>${warnings ? `<div class="warning-box"><b>확인 필요</b><ul>${warnings}</ul></div>` : ""}${immutableArtifacts ? `<div class="artifact-list"><span class="panel-kicker">IMMUTABLE RUN ARTIFACTS</span>${immutableArtifacts}</div>` : ""}${revisionArtifacts ? `<div class="artifact-list"><span class="panel-kicker">APPEND-ONLY VERIFIED REVISION EVIDENCE</span>${revisionArtifacts}</div>` : ""}${mutableArtifacts ? `<div class="artifact-list"><span class="panel-kicker">MUTABLE WORKSPACE REFERENCES</span>${mutableArtifacts}</div>` : ""}${job.status === "failed" ? `<div class="error-box"><b>실행 오류</b><pre>${escapeHtml(job.error || job.message || "알 수 없는 오류")}</pre><button class="secondary-button" data-focus-key="retry-job" id="retry-job">다시 실행</button></div>` : ""}`;
  state.jobDetailSignature = signature;
  $("#detail-upload")?.addEventListener("change", uploadLocalClips);
  $("#run-local")?.addEventListener("click", runSelectedJob);
  $("#run-provider")?.addEventListener("click", runSelectedJob);
  $("#run-gemini")?.addEventListener("click", runSelectedJob);
  $("#semantic-revalidate")?.addEventListener("click", revalidateSelectedJob);
  $("#retry-job")?.addEventListener("click", runSelectedJob);
  restoreJobFocus(focusSnapshot);
}

async function uploadLocalClips(event) {
  const files = [...event.target.files];
  if (!files.length || !state.selectedJobId) return;
  const job = selectedJob();
  const status = $("#detail-upload-status");
  const runButton = $("#run-local");
  if (!job || job.provider !== "local") {
    showToast("선택한 작업은 로컬 클립 업로드 작업이 아닙니다.", "error");
    event.target.value = "";
    return;
  }
  if (files.length !== job.clipCount) {
    const message = `정확히 ${job.clipCount}개가 필요합니다. 현재 ${files.length}개를 선택했습니다.`;
    if (status) status.textContent = message;
    showToast(message, "error");
    event.target.value = "";
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (files.some((file) => file.size <= 0 || file.size > 64 * 1024 * 1024) || totalBytes > 64 * 1024 * 1024) {
    const message = "비어 있는 파일, 64 MiB 초과 파일 또는 합계 64 MiB 초과 세트는 업로드할 수 없습니다.";
    if (status) status.textContent = message;
    showToast(message, "error");
    event.target.value = "";
    return;
  }
  const replacement = localClipReplacementConfirmation(job);
  if (replacement && !globalThis.confirm(replacement.message)) {
    const message = `RUN ${replacement.runId}의 기존 결과와 source clips를 유지했습니다.`;
    if (status) status.textContent = message;
    showToast(message);
    event.target.value = "";
    return;
  }
  const form = new FormData();
  form.append("expectedRunId", localClipUploadExpectedRunId(job));
  files.forEach((file) => form.append("files", file));
  event.target.disabled = true;
  if (runButton) runButton.disabled = true;
  if (status) status.textContent = `${files.length}개 클립을 선택 순서대로 검사·업로드하는 중입니다…`;
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/clips`, { method: "POST", body: form });
    const order = (result.uploaded || []).map((item) => `${item.index}. ${item.name}`).join(" → ");
    invalidateQualityEvidenceCache(state.qualityDetails, job.id);
    if (result.job?.id === job.id) {
      state.jobs = state.jobs.map((entry) => entry.id === job.id ? result.job : entry);
      state.jobListSignature = null;
      state.jobDetailSignature = null;
      state.pipelineSignature = null;
      try {
        renderJobs();
      } catch (renderError) {
        console.error(`업로드 후 작업 화면 갱신 실패: ${renderError.message}`);
      }
    }
    showToast(`${files.length}개 클립 검증·교체 완료${result.recovered ? " · 중단 지점 자동 복구" : ""}`);
    if (status) status.textContent = `${files.length}개 검증 완료 · ${formatMiB(totalBytes)} · ${order || "선택 순서 유지"}`;
    try {
      await refreshJobs();
    } catch (refreshError) {
      const message = `클립 교체는 완료됐지만 작업 목록 재확인에 실패했습니다: ${refreshError.message}`;
      if (status) status.textContent = message;
      showToast(message, "error");
    }
  } catch (error) {
    if (status) status.textContent = `업로드 실패 · ${error.message} · 기존 클립 세트는 유지됩니다.`;
    showToast(error.message, "error");
  } finally {
    event.target.disabled = false;
    event.target.value = "";
  }
}

async function runSelectedJob() {
  if (!state.selectedJobId) return;
  const job = selectedJob();
  if (job?.provider === "local" && !(job.localClipImport?.status === "ready" && job.localClipImport?.clipCount === job.clipCount && job.localClipImport?.providerEvidenceEligible === false)) {
    showToast(`검증된 ${job.clipCount}개 클립을 먼저 업로드하세요.`, "error");
    return;
  }
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/run`, { method: "POST" });
    showToast("편집 파이프라인을 시작했습니다.");
    requestJobPolling();
    await refreshJobs();
  } catch (error) {
    // A run response can be lost after the server accepted it. Refresh the
    // same durable job id before offering any retry; never create a new job as
    // an ambiguity fallback.
    requestJobPolling();
    await refreshJobs().catch(() => {});
    showToast(error.message, "error");
  }
}

async function revalidateSelectedJob() {
  if (!state.selectedJobId) return;
  const job = state.jobs.find((entry) => entry.id === state.selectedJobId);
  const eligibility = semanticRevalidationEligibility(job);
  if (!eligibility.eligible) {
    showToast(eligibility.reason, "error");
    return;
  }
  const confirmation = "기존 봉인 영상만 로컬 재검수 · Gemini 요청 0회";
  if (!window.confirm(`${confirmation}\n\n원본 run은 변경되지 않으며 새 child run이 생성됩니다.`)) return;
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(job.id)}/semantic/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRunId: eligibility.sourceRunId })
    });
    showToast(`${result.message || confirmation} · child ${result.childRunId || "시작 중"}`);
    requestJobPolling();
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function pollJobs() {
  let failed = false;
  try {
    await refreshJobs();
    state.pollFailureSignature = null;
  } catch (error) {
    failed = true;
    const signature = String(error?.message || error);
    if (state.pollFailureSignature !== signature) {
      showToast(`작업 상태 갱신 실패: ${signature}`, "error");
      state.pollFailureSignature = signature;
    }
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (selected) $("#pipeline-status").textContent = `상태 갱신 실패 · ${signature}`;
  } finally {
    if (shouldPollJobs(state.jobs) || pollingRequested()) scheduleJobPoll(failed ? (document.hidden ? 10_000 : 3_600) : undefined);
  }
}

function pollingRequested() {
  return Date.now() < state.pollRequestedUntil;
}

function scheduleJobPoll(delay = document.hidden ? 10_000 : 1_800) {
  if (state.poll !== null || (!shouldPollJobs(state.jobs) && !pollingRequested())) return;
  state.poll = window.setTimeout(async () => {
    state.poll = null;
    await pollJobs();
  }, delay);
}

function requestJobPolling(windowMs = 30_000) {
  state.pollRequestedUntil = Math.max(state.pollRequestedUntil, Date.now() + windowMs);
  // Establish the recovery timer before the caller's immediate refresh, but
  // leave the normal delay so the two GETs cannot race one another.
  scheduleJobPoll();
}

async function refreshJobs() {
  const payload = await api("/api/jobs");
  state.jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const pending = readPendingGeminiLaunch();
  if (pending) {
    const pendingJob = state.jobs.find((job) => job.id === pending.jobId);
    if (pendingJob && !pendingJob.integrity && ["queued", "running", "verifying"].includes(pendingJob.status)) {
      state.selectedJobId = pending.jobId;
    } else {
      forgetPendingGeminiLaunch();
    }
  }
  renderJobs();
  const active = shouldPollJobs(state.jobs);
  if (active || pollingRequested()) scheduleJobPoll();
  else if (state.poll !== null) { window.clearTimeout(state.poll); state.poll = null; }
}

async function createProduction(event) {
  event.preventDefault();
  const provider = $("#provider").value;
  const sources = $("#sources").value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ title: url, url }));
  const body = { topic: $("#topic").value, format: $("#format").value, clipCount: Number($("#clip-count").value), targetDurationSec: Number($("#target-duration").value), provider, sources, captions: $("#captions").checked, voiceover: $("#voiceover").checked };
  const requestSignature = stableUiSignature(body);
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "파이프라인 시작 중…";
  try {
    const pending = provider === "gemini-browser" ? readPendingGeminiLaunch() : null;
    const pendingJob = pending?.requestSignature === requestSignature
      ? state.jobs.find((job) => job.id === pending.jobId && !job.integrity && ["queued", "running", "verifying"].includes(job.status))
      : null;
    if (pendingJob) {
      state.selectedJobId = pendingJob.id;
      if (pendingJob.status === "queued") {
        await api(`/api/jobs/${encodeURIComponent(pendingJob.id)}/run`, { method: "POST" }).catch(() => {});
      }
      requestJobPolling();
      await refreshJobs();
      showToast("기존 Gemini 작업 ID를 재사용해 상태를 확인했습니다. 새 provider 작업은 만들지 않았습니다.");
      return;
    }
    const launch = await createProductionJobInertFirst(api, body, {
      onCreated: ({ jobId }) => {
        state.selectedJobId = jobId;
        if (provider === "gemini-browser") rememberPendingGeminiLaunch(jobId, requestSignature);
      }
    });
    if (launch.runAttempted) requestJobPolling();
    await refreshJobs();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.querySelector("#rendering").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    const message = provider === "gemini-browser"
      ? launch.runError
        ? "Gemini 대기 작업은 보존했습니다. 시작 응답을 확인하지 못했으므로 같은 작업 상세에서 재시도하세요."
        : "Gemini 생성 요청을 등록했습니다. 로그인·쿼터·UI 상태에 따라 중단될 수 있습니다."
      : provider === "local-video"
        ? "local-video 작업을 대기열에 만들었습니다. 정확한 비용 견적과 1회 유료 승인 영수증을 만든 뒤 작업 상세에서 시작하세요."
        : "로컬 클립 편집 작업을 만들었습니다. 클립을 업로드하세요.";
    showToast(message, launch.runError ? "error" : undefined);
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.querySelector("span").textContent = "제작 작업 생성"; }
}

async function refreshHealth() {
  try {
    const [health, readiness] = await Promise.all([
      api("/api/health"),
      api("/api/providers/readiness").catch((error) => ({ error: error.message }))
    ]);
    const quotaMonitor = readiness.error
      ? { ready: false, label: `NOT_CONNECTED · readiness unavailable: ${readiness.error}` }
      : geminiQuotaMonitorSummary(readiness);
    const ytDlp = health.capabilities.ytDlp || {};
    const checks = [
      ["ffmpeg", health.capabilities.ffmpeg],
      ["ffprobe", health.capabilities.ffprobe],
      ["macOS say", health.capabilities.macSay],
      ["RLM", health.rlmAnalysis],
      ["yt-dlp", ytDlp.installed],
      ["channel analysis", health.analysis]
    ];
    const ready = checks.every(([, value]) => Boolean(value));
    const browserConnected = Boolean(health.browser?.connected);
    $("#system-dot").className = `dot ${ready ? "ready" : "warn"}`;
    $("#system-label").textContent = ready ? "로컬 편집 도구 준비 완료" : "로컬 도구 설정 확인 필요";
    $("#browser-start").classList.toggle("connected", browserConnected);
    $("#browser-start").innerHTML = `<span class="button-dot" aria-hidden="true"></span>${browserConnected ? "Gemini Chrome 연결됨" : "Gemini Chrome 연결"}`;
    $("#health-capabilities").innerHTML = `<div class="health-title">LOCAL CAPABILITIES <small>${ready ? "LOCAL TOOLING READY · PROVIDER STATUS SEPARATE" : "CHECK REQUIRED"}</small></div><div class="health-items">${checks.map(([name, value]) => `<span class="${value ? "ok" : "missing"}"><i aria-hidden="true"></i>${name} ${value ? "PASS" : "MISSING"}</span>`).join("")}<span class="${browserConnected ? "ok" : "missing"}"><i aria-hidden="true"></i>Gemini Chrome ${browserConnected ? "CONNECTED" : "DISCONNECTED"}</span><span class="muted"><i aria-hidden="true"></i>yt-dlp ${escapeHtml(ytDlp.version || "unknown")} · ${escapeHtml(ytDlp.maintenance || "maintenance unavailable")}</span><span class="${quotaMonitor.ready ? "ok" : "muted"}"><i aria-hidden="true"></i>Gemini quota monitor ${escapeHtml(quotaMonitor.label)}</span></div>`;
    $("#provider-readiness").innerHTML = readiness.error
      ? `<span class="health-error">제공자 준비상태를 확인하지 못했습니다: ${escapeHtml(readiness.error)}</span>`
      : providerReadinessMarkup(readiness);
    if (state.healthTimer !== null) window.clearTimeout(state.healthTimer);
    state.healthTimer = window.setTimeout(() => {
      state.healthTimer = null;
      if (!document.hidden) void refreshHealth();
    }, providerReadinessRefreshDelay(readiness));
    if (!health.capabilities.ffmpeg) showToast("ffmpeg가 없습니다. 터미널에서 brew install ffmpeg를 실행하세요.", "error");
  } catch (error) {
    $("#system-label").textContent = "서버 연결 실패";
    $("#health-capabilities").innerHTML = `<span class="health-error">서버 상태를 확인하지 못했습니다: ${escapeHtml(error.message)}</span>`;
    $("#provider-readiness").innerHTML = `<span class="health-error">제공자 준비상태를 확인하지 못했습니다.</span>`;
    if (state.healthTimer !== null) window.clearTimeout(state.healthTimer);
    state.healthTimer = window.setTimeout(() => {
      state.healthTimer = null;
      if (!document.hidden) void refreshHealth();
    }, 60_000);
  }
}

async function connectBrowser() {
  const button = $("#browser-start");
  button.disabled = true;
  button.innerHTML = `<span class="button-dot" aria-hidden="true"></span> Chrome 시작 중…`;
  try {
    const result = await api("/api/browser/start", { method: "POST" });
    showToast(result.started ? "전용 Chrome을 시작했습니다. Gemini 로그인 세션을 확인하세요." : "Chrome DevTools 연결이 확인되었습니다.");
    await refreshHealth();
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; await refreshHealth(); }
}

function bindEvents() {
  $(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    const main = $("#workspace-main");
    if (!main) return;
    history.replaceState(null, "", "#workspace-main");
    main.focus({ preventScroll: true });
    if (getComputedStyle(main).overflowY === "auto" || getComputedStyle(main).overflowY === "scroll") {
      main.scrollTo({ top: 0, behavior: "auto" });
    } else {
      window.scrollTo({ top: main.getBoundingClientRect().top + window.scrollY, behavior: "auto" });
    }
  });
  $("#create-form").addEventListener("submit", createProduction);
  $("#provider").addEventListener("change", syncProviderDefaults);
  $("#browser-start").addEventListener("click", connectBrowser);
  $("#refresh-all").addEventListener("click", async () => {
    const button = $("#refresh-all");
    button.disabled = true;
    try {
      await Promise.all([refreshJobs(), renderVideos(), refreshHealth()]);
      showToast("데이터를 갱신했습니다.");
    } catch (error) {
      showToast(`데이터 갱신 실패: ${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (shouldPollJobs(state.jobs) || pollingRequested())) scheduleJobPoll(0);
    if (!document.hidden) void refreshHealth();
  });
  $$('[data-topic]').forEach((button) => button.addEventListener("click", () => { $("#topic").value = button.dataset.topic; $("#topic").focus(); }));
  $$(".toggle-label input").forEach((input) => input.addEventListener("change", syncToggleLabels));
  $$(".nav-item").forEach((link) => link.addEventListener("click", () => activateNavigation(link.hash.slice(1))));
  window.addEventListener("hashchange", () => activateNavigation(window.location.hash.slice(1) || "create"));
  activateNavigation(window.location.hash.slice(1) || "create");
  syncToggleLabels();
  syncProviderDefaults();
  $("#video-search").addEventListener("input", (event) => { state.query = event.target.value; state.page = 1; window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(() => renderVideos().catch((error) => showToast(`영상 검색 실패: ${error.message}`, "error")), 250); });
  $("#video-sort").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 1; renderVideos().catch((error) => showToast(`정렬 실패: ${error.message}`, "error")); });
  $("#video-category").addEventListener("change", (event) => { state.category = event.target.value; state.page = 1; renderVideos().catch((error) => showToast(`필터 실패: ${error.message}`, "error")); });
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderVideos().catch((error) => showToast(`페이지 이동 실패: ${error.message}`, "error")); } });
  $("#next-page").addEventListener("click", () => { state.page += 1; renderVideos().catch((error) => showToast(`페이지 이동 실패: ${error.message}`, "error")); });
}

function syncProviderDefaults() {
  const provider = $("#provider").value;
  const clipCount = $("#clip-count");
  const targetDuration = $("#target-duration");
  const help = $("#provider-help");
  if (provider === "gemini-browser") {
    clipCount.value = "2";
    targetDuration.value = "20";
    help.textContent = "관측된 계정 쿼터 안에서 완주하도록 기본 2개 클립·약 20초를 요청합니다. 쿼터가 허용되면 클립 수를 늘릴 수 있습니다.";
  } else if (provider === "local-video") {
    clipCount.value = "6";
    targetDuration.value = "110";
    help.textContent = "최근 채널 길이 기준 약 110초를 6개 장면으로 구성합니다. 이 API 경로에는 키·크레딧·비용 상한·현재 작업에 결속된 명시적 1회 유료 승인이 필요하며, BFL Playground 무료 프로모션은 자동 적용되지 않습니다. Playground에서 수동 생성한 클립은 로컬 업로드 모드를 사용하세요.";
  } else {
    clipCount.value = "4";
    targetDuration.value = "110";
    help.textContent = "BFL Playground 등 외부에서 생성·다운로드한 서로 다른 클립도 업로드해 편집할 수 있습니다(기본 4개). API task 영수증이 없으므로 이 모드는 AI provider 기술 증거 gate 대상이 아닙니다.";
  }
}

let applicationStarting = false;
let eventsBound = false;

function setStudioLocked(locked, message = "") {
  const gate = $("#studio-unlock");
  const shell = $(".app-shell");
  if (gate) {
    gate.hidden = !locked;
    gate.setAttribute("aria-hidden", locked ? "false" : "true");
  }
  if (shell) {
    shell.toggleAttribute("inert", locked);
    shell.setAttribute("aria-hidden", locked ? "true" : "false");
  }
  const error = $("#studio-unlock-error");
  if (error) error.textContent = message;
  if (locked) $("#studio-token")?.focus({ preventScroll: true });
}

function forgetStudioBearer() {
  state.studioToken = null;
  try { globalThis.sessionStorage?.removeItem(STUDIO_BEARER_SESSION_KEY); } catch {}
}

async function startStudioApplication(token) {
  if (applicationStarting) return;
  applicationStarting = true;
  state.studioToken = token;
  setStudioLocked(false);
  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
  try {
    const [analysis, benchmarkProfile, shotPatterns] = await Promise.all([
      api("/api/channel"),
      api("/api/benchmark/profile"),
      api("/api/shot-patterns").catch((error) => ({ error: error.message }))
    ]);
    state.analysis = { ...analysis, benchmarkProfile };
    state.shotPatterns = shotPatterns;
    renderStats();
    renderBenchmark();
    renderShotPatterns();
    await Promise.all([renderVideos(), refreshJobs(), refreshHealth()]);
  } catch (error) {
    if (error?.status === 403) {
      forgetStudioBearer();
      setStudioLocked(true, "Bearer token이 현재 Studio 세션과 일치하지 않습니다.");
    } else {
      showToast(error.message, "error");
    }
  } finally {
    applicationStarting = false;
  }
}

function bindStudioUnlock() {
  const form = $("#studio-unlock-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#studio-token");
    const token = input?.value || "";
    if (input) input.value = "";
    if (!validStudioBearerToken(token)) {
      setStudioLocked(true, `공백 없는 32~${MAX_STUDIO_BEARER_BYTES}바이트 token이 필요합니다.`);
      return;
    }
    try { globalThis.sessionStorage?.setItem(STUDIO_BEARER_SESSION_KEY, token); } catch {}
    await startStudioApplication(token);
  });
}

export async function init(options = {}) {
  bindStudioUnlock();
  const fragment = consumeStudioBearerFragment(options);
  const token = fragment.present ? fragment.token : readStoredStudioBearer(options.storage);
  if (!token) {
    setStudioLocked(true, fragment.present ? "URL fragment의 token 형식이 올바르지 않습니다." : "");
    return false;
  }
  await startStudioApplication(token);
  return Boolean(state.studioToken);
}

if (typeof document !== "undefined") void init();
