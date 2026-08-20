import { channelOneLiner, formatClock, shortDurationSeconds, shortPreview, shortStatus, shortThumbnail } from "./shorts-ui.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { analysis: null, jobs: [], selectedJobId: null, highlightJobId: null, view: "grid", template: null, createPreview: null, jobPrompts: {}, live: {}, sse: null, livePoll: null, page: 1, query: "", sort: "views", category: "", poll: null, qualityHistory: {}, qualityDetails: {} };

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
  return formatClock(seconds);
}

const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 일관성·생성 품질", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "사실성·출처·벤치마크 적합성", weight: 10 },
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
  "grok-imagine": {
    short: "Grok Imagine 공장",
    detail: "Grok Imagine 공장 · 공식 grok CLI",
    generation: "Grok Imagine factory",
    generationDetail: "훅 잠금 · image_edit · 10초 720p · 대화 자막",
    status: "Grok Imagine 공장"
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
    return `<div class="ahp-row"><div><b>${escapeHtml(criterion.label)}</b><small>${criterion.weight || AHP_CRITERIA.find((item) => item.id === criterion.id)?.weight || 0}% · 자동 ${scoreText(criterion.autoScore)} · 위원회 ${scoreText(criterion.committeeScore)}</small>${blockers}</div><strong>${scoreText(criterion.score)}</strong></div>`;
  }).join("");
  const metrics = quality?.metrics || {};
  const historyItems = Array.isArray(history) ? history : [];
  const historyMarkup = historyItems.length
    ? historyItems.map((item) => `<span>ITERATION ${item.iteration}: ${scoreText(item.totalScore)} · ${escapeHtml(item.status || "unknown")}</span>`).join("")
    : `<span>${history?.error ? `이력 검증 실패: ${escapeHtml(history.error)}` : "봉인된 반복 이력이 아직 없습니다."}</span>`;
  const provenance = [
    ["RUN", quality?.runId || "—"],
    ["PROVIDER", metrics.provider || "—"],
    ["SEMANTIC GATE", quality?.semanticGate ? "OPEN" : "CLOSED · 증거 부족"],
    ["AUDIO TRACKS", metrics.finalMedia?.audioStreamCount ?? "—"],
    ["VOICE STYLE", metrics.voiceoverSync?.voiceStyle || "—"],
    ["INPUT BINDING", metrics.inputManifestBinding ? "PASS" : "FAIL"],
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
  return `<section class="job-ahp panel"><div class="job-ahp-head"><div><span class="panel-kicker">AHP EVIDENCE RECEIPT</span><h4>${quality?.semanticGate ? "의미론 게이트 검토 가능" : "기계 점수만 계산됨 · 의미론 게이트 보류"}</h4></div><strong>${scoreText(quality?.totalScore)}<small>/ 100</small></strong></div><div class="ahp-rows">${rows}</div><div class="evidence-grid">${provenance}</div><div class="history-strip"><span class="panel-kicker">ITERATION HISTORY</span>${historyMarkup}</div><div class="verification-strip"><span class="panel-kicker">REPRODUCTION COMMANDS</span>${commands}</div></section>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `요청 실패 (${response.status})`);
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
  const { snapshot, videos, shortsDuration } = state.analysis;
  const average = videos.length ? Math.round(videos.reduce((sum, video) => sum + video.viewCount, 0) / videos.length) : 0;
  $("#stats").innerHTML = [
    ["CHANNEL SCALE", formatNumber(snapshot.subscribers), "구독자", "accent"],
    ["FULL INDEX", formatNumber(snapshot.totalVideos), "전체 영상", ""],
    ["SHORTS ENGINE", formatNumber(snapshot.shorts), "쇼츠 영상", ""],
    ["AVG. LENGTH", `${shortsDuration?.medianSec || 78}s`, `평균 ${shortsDuration?.meanSec || 75.1}s · yt-dlp`, ""],
    ["AVG. SIGNAL", formatViews(average), "영상당 평균 조회수", ""]
  ].map(([label, value, caption, tone]) => `<div class="stat-card ${tone}"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>`).join("");
}

function renderBenchmark() {
  const { editorialModel, categories, hooks, topVideos } = state.analysis;
  $("#promise").textContent = editorialModel.promise;
  $("#formula").textContent = editorialModel.titleFormula;
  $("#narrative").innerHTML = editorialModel.narrative.map((item) => `<div class="narrative-item"><span>${String(item.step).padStart(2, "0")}</span><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div></div>`).join("");
  const maxCategory = Math.max(...categories.map((item) => item.totalViews), 1);
  $("#categories").innerHTML = categories.map((item) => `<div class="category-row"><div class="category-meta"><span>${escapeHtml(item.label)}</span><b>${formatViews(item.averageViews)} 평균</b></div><div class="bar-track"><i style="width:${Math.max(4, Math.round(item.totalViews / maxCategory * 100))}%"></i></div><small>${item.count}개 · 누적 ${formatViews(item.totalViews)}</small></div>`).join("");
  $("#top-hooks").innerHTML = hooks.map((item, index) => `<div class="hook-row"><span class="rank">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(item.label)}</b><small>${item.count}개 사용 · ${formatViews(item.averageViews)} 평균 조회</small></div><span class="hook-arrow">↗</span></div>`).join("");
  $("#top-videos").innerHTML = topVideos.slice(0, 8).map((video, index) => `<a class="top-video" href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}" target="_blank" rel="noreferrer"><span class="rank">${String(index + 1).padStart(2, "0")}</span><span class="top-video-title">${escapeHtml(video.title)}</span><strong>${formatViews(video.viewCount)}</strong></a>`).join("");
  $("#video-category").innerHTML = `<option value="">전체 주제</option>${categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}`;
  const committeeRoles = [
    ["콘텐츠 디렉터", "훅·서사·벤치마크 문법"],
    ["모션 디렉터", "생성 장면·시각 일관성"],
    ["사운드 엔지니어", "자막·음성·믹스"],
    ["자동화 아키텍트", "Chrome·FFmpeg·복구"],
    ["레드팀 QA", "실패·경계·재현성"]
  ];
  $("#committee-roles").innerHTML = committeeRoles.map(([role, scope]) => `<div class="committee-role"><span class="role-mark">+</span><div><b>${escapeHtml(role)}</b><small>${escapeHtml(scope)}</small></div><span class="role-status">SUBMIT ON RUN</span></div>`).join("");
  const ahpWeights = state.analysis.ahp?.weights || AHP_CRITERIA;
  $("#ahp-criteria").innerHTML = `<div class="ahp-benchmark-note"><b>고정 AHP 가중치</b><span>${ahpWeights.map((criterion) => `${escapeHtml(criterion.label)} ${criterion.weight || criterion.targetWeight}%`).join(" · ")}</span><small>분석 산출물은 제목·메타데이터 휴리스틱이며, 프레임·음성·자막 의미론을 대신하지 않습니다.</small></div>`;
  const durationSnapshot = state.analysis.benchmarkProfile?.duration;
  const duration = durationSnapshot?.summary || durationSnapshot || state.analysis.shortsDuration;
  const benchmarkProfile = state.analysis.benchmarkProfile;
  const sampleCount = benchmarkProfile?.rlm?.mediaEvidence?.sampleCount || 0;
  const rlmLevels = benchmarkProfile?.rlm?.reduction?.levels?.map((level) => level.length).join(" → ") || "8 → 1";
  const buckets = Array.isArray(durationSnapshot?.buckets) ? durationSnapshot.buckets : [];
  const totalShorts = Number(state.analysis.snapshot?.shorts || state.analysis.snapshot?.totalVideos || 1);
  const bucketHeight = (index) => Math.max(8, Math.round(Number(buckets[index]?.count || 0) / Math.max(1, totalShorts) * 100));
  const range = duration?.recommendedRangeSec || [duration?.p10Sec || 0, duration?.p90Sec || 0];
  $("#duration-profile").innerHTML = duration ? `<div class="duration-profile-head"><span>RLM · yt-dlp DURATION PROFILE</span><b>${duration.recommendedTargetSec}s target</b></div><div class="duration-bars"><i style="height:${bucketHeight(0)}%"></i><i style="height:${bucketHeight(1)}%"></i><i style="height:${bucketHeight(2)}%"></i><i style="height:${bucketHeight(3)}%"></i></div><small>${duration.minSec}–${duration.maxSec}초 · 권장 범위 ${range[0]}–${range[1]}초 · p90 ${duration.p90Sec}초 · frame/audio/caption sample ${sampleCount}개 · RLM ${rlmLevels}</small>` : "";
  renderChannelDna();
}

function renderChannelDna() {
  const editorial = state.analysis?.editorialModel || {};
  const promise = editorial.promise || "평범한 공간·시설에서 의외의 설계 원리를 발견하게 한다.";
  const formula = editorial.titleFormula || "[익숙한 대상] + [상식과 반대되는 사실] + [이유/방법/숨은 구조]";
  const hook = editorial.narrative?.[0]?.detail || "제목은 설명문보다 질문·반전. 사실마다 출처를 적습니다.";
  if ($("#channel-promise")) $("#channel-promise").textContent = promise;
  if ($("#channel-formula")) $("#channel-formula").textContent = formula;
  if ($("#create-formula")) $("#create-formula").textContent = formula;
  if ($("#create-promise")) $("#create-promise").textContent = `${promise} ${hook}`;
  const weights = state.analysis?.ahp?.weights || AHP_CRITERIA;
  if ($("#create-ahp")) {
    $("#create-ahp").textContent = `AHP ${weights.map((item) => `${item.label} ${item.weight || item.targetWeight}%`).join(" · ")}`;
  }
  const hooks = Array.isArray(state.analysis?.hooks) ? state.analysis.hooks.slice(0, 3) : [];
  const suggestions = document.querySelector(".suggestions");
  if (suggestions && hooks.length) {
    suggestions.innerHTML = hooks.map((item) => `<button type="button" data-topic="${escapeHtml(item.label)}">${escapeHtml(item.label)}</button>`).join("");
    suggestions.querySelectorAll("[data-topic]").forEach((button) => button.addEventListener("click", () => {
      $("#topic").value = button.dataset.topic;
      $("#topic").focus();
      void refreshCreatePreview();
    }));
  }
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
  $("#video-library").innerHTML = payload.videos.length ? payload.videos.map((video) => {
    const category = video.analysis.categories[0]?.label || "분석 중";
    const hook = video.analysis.hookScore;
    return `<a class="library-row" href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer"><span class="library-position">${String(video.position).padStart(3, "0")}</span><span class="library-title">${escapeHtml(video.title)}<small>${escapeHtml(category)} · ${video.type === "short" ? "Shorts" : escapeHtml(video.duration || "롱폼")}</small></span><span class="hook-score"><i style="width:${hook}%"></i><small>훅 ${hook}</small></span><strong>${formatViews(video.viewCount)}</strong><span class="library-arrow">↗</span></a>`;
  }).join("") : `<div class="empty-state">검색 조건에 맞는 영상이 없습니다.</div>`;
}

function statusLabel(status, job) {
  if (job) return shortStatus(job).label;
  return status === "completed" ? "완료" : status === "failed" ? "실패·프리즈" : status === "verifying" || status === "running" || status === "queued" ? "생성중" : "초안";
}

function setView(view, options = {}) {
  state.view = ["create", "detail", "template"].includes(view) ? view : "grid";
  const createOverlay = $("#create-overlay");
  const shortOverlay = $("#short-overlay");
  const templateOverlay = $("#template-overlay");
  if (createOverlay) createOverlay.hidden = state.view !== "create";
  if (shortOverlay) shortOverlay.hidden = state.view !== "detail";
  if (templateOverlay) templateOverlay.hidden = state.view !== "template";
  document.body.classList.toggle("overlay-open", state.view !== "grid");
  $$(".nav-item").forEach((item) => {
    const target = item.getAttribute("href");
    const active = (state.view === "create" && target === "#create")
      || (state.view === "template" && target === "#template")
      || (state.view === "grid" && target === "#shorts")
      || (state.view === "detail" && target === "#shorts");
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  if (!options.skipHash) {
    const nextHash = state.view === "create" ? "#create" : state.view === "detail" ? "#short" : state.view === "template" ? "#template" : "#shorts";
    if (location.hash !== nextHash) history.replaceState(null, "", nextHash);
  }
  if (state.view === "create") {
    window.requestAnimationFrame(() => $("#topic")?.focus());
    void hydrateCreateSlots();
  }
  if (state.view === "template") void loadTemplateSurface();
}

function applyHash() {
  const hash = location.hash.replace("#", "");
  if (hash === "create") {
    setView("create", { skipHash: true });
    return;
  }
  if (hash === "template") {
    setView("template", { skipHash: true });
    return;
  }
  if (hash === "benchmark") {
    setView("grid", { skipHash: true });
    $("#benchmark")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (hash === "short" || hash === "generation" || hash === "rendering") {
    if (state.selectedJobId && state.jobs.some((job) => job.id === state.selectedJobId)) {
      setView("detail", { skipHash: true });
      return;
    }
  }
  setView("grid", { skipHash: true });
}

function createTileMarkup() {
  return `<button type="button" class="short-card short-create-tile" id="create-tile"><div class="short-card-thumb create-thumb"><span class="create-plus">+</span></div><div class="short-card-body"><h3>새 쇼츠</h3><div class="short-card-meta"><span>Grok Imagine 공장</span><strong>—</strong></div></div></button>`;
}

function bust(url, token) {
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token || "")}`;
}

function renderShortCard(job) {
  const status = shortStatus(job);
  const thumb = bust(shortThumbnail(job), job.updatedAt);
  const duration = formatClock(shortDurationSeconds(job));
  const highlight = job.id === state.highlightJobId ? " just-created" : "";
  const selected = job.id === state.selectedJobId && state.view === "detail" ? " selected" : "";
  const progress = Number(job.progress || 0);
  const fallback = escapeHtml((job.topic || "P4").slice(0, 2));
  const oneLiner = channelOneLiner(job, state.analysis?.editorialModel);
  const media = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="" />`
    : `<div class="thumb-fallback" aria-hidden="true"><span>${fallback}</span></div>`;
  const generating = status.key === "running"
    ? `<div class="thumb-progress" aria-hidden="true"><i style="width:${progress}%"></i></div>`
    : "";
  const liveLine = liveLineFor(job);
  const origin = job.imported ? "가져온 편" : job.seed ? "시드" : "";
  return `<button type="button" class="short-card status-${status.key}${highlight}${selected}" data-job-id="${escapeHtml(job.id)}" aria-pressed="${job.id === state.selectedJobId && state.view === "detail"}"><div class="short-card-thumb">${media}<span class="short-status ${status.key}"><i></i>${escapeHtml(status.label)}</span><span class="short-duration">${escapeHtml(duration)}</span>${origin ? `<span class="short-origin">${escapeHtml(origin)}</span>` : ""}${generating}</div><div class="short-card-body"><h3>${escapeHtml(job.topic)}</h3><p class="short-oneliner">${escapeHtml(oneLiner)}</p>${liveLine ? `<p class="short-card-live">${escapeHtml(liveLine)}</p>` : ""}</div></button>`;
}

function liveLineFor(job = {}) {
  if (Number(job.queuePosition) > 0) return job.message || `공장 대기열 ${job.queuePosition}번`;
  if (!["queued", "running", "verifying"].includes(job.status)) return "";
  return job.live?.message || job.message || "생성중";
}

function upsertJob(partial) {
  if (!partial?.id) return null;
  const index = state.jobs.findIndex((item) => item.id === partial.id);
  if (index >= 0) {
    state.jobs[index] = { ...state.jobs[index], ...partial };
    return state.jobs[index];
  }
  state.jobs.unshift(partial);
  return state.jobs[0];
}
async function loadQualityEvidence(job) {
  if (!job?.runId || job.status !== "completed") return;
  const cached = state.qualityDetails[job.id];
  if (cached?.runId === job.runId) return;
  try {
    const [quality, history] = await Promise.all([
      api(`/api/jobs/${encodeURIComponent(job.id)}/quality`),
      api(`/api/jobs/${encodeURIComponent(job.id)}/quality/history`)
    ]);
    state.qualityDetails[job.id] = { runId: job.runId, quality, history: history.iterations || [] };
  } catch (error) {
    state.qualityDetails[job.id] = { runId: job.runId, error: error.message, quality: null, history: [] };
  }
  if (state.selectedJobId === job.id) renderJobDetail(job);
}

function bindShortCard(button) {
  button.addEventListener("click", () => {
    state.selectedJobId = button.dataset.jobId;
    setView("detail");
    renderJobs();
  });
}

function patchGridCard(job) {
  if (!job?.id) return;
  const grid = $("#shorts-grid");
  if (!grid) return;
  const card = grid.querySelector(`.short-card[data-job-id="${CSS.escape(job.id)}"]`);
  if (!card) {
    renderJobs();
    return;
  }
  const next = document.createElement("template");
  next.innerHTML = renderShortCard(job);
  const fresh = next.content.firstElementChild;
  card.replaceWith(fresh);
  bindShortCard(fresh);
}

function patchDetailProgress(job) {
  if (!job || state.selectedJobId !== job.id || state.view !== "detail") return;
  const message = document.querySelector("#job-detail .detail-progress span");
  const percent = document.querySelector("#job-detail .detail-progress b");
  const bar = document.querySelector("#job-detail .progress-track i");
  if (message) message.textContent = job.live?.message || job.message || "";
  if (percent) percent.textContent = `${job.progress || 0}%`;
  if (bar) bar.style.width = `${job.progress || 0}%`;
  const still = document.querySelector("#job-detail .preview-still");
  const next = bust(shortThumbnail(job), job.updatedAt);
  if (still && next) still.src = next;
  else if (!still && next && !document.querySelector("#job-detail video")) {
    const wrap = document.querySelector("#job-detail .preview-wrap");
    if (wrap) {
      const img = document.createElement("img");
      img.className = "preview-still";
      img.alt = "훅 잠금";
      img.src = next;
      wrap.prepend(img);
    }
  }
}

function renderJobs() {
  const grid = $("#shorts-grid");
  const count = $("#shorts-count");
  if (count) count.textContent = `${state.jobs.length}편`;
  if (grid) {
    grid.innerHTML = `${createTileMarkup()}${state.jobs.map(renderShortCard).join("")}`;
    $("#create-tile")?.addEventListener("click", openCreate);
    $$(".short-card[data-job-id]").forEach(bindShortCard);
  }
  if (state.view === "detail") {
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (!selected) {
      state.selectedJobId = null;
      setView("grid");
      renderPipeline(null);
      renderLiveFactory(null);
      return;
    }
    renderJobDetail(selected);
    renderPipeline(selected);
    renderLiveFactory(selected);
    watchJobLive(selected);
    if (selected.status === "completed" && selected.runId) void loadQualityEvidence(selected);
    return;
  }
  if (state.view !== "create") renderPipeline(null);
}

function renderPipeline(job) {
  const generationStep = $('[data-role="generation"]');
  const copy = providerCopy(job?.provider);
  if (generationStep) {
    generationStep.dataset.stage = job?.provider === "local-video" ? "로컬 영상 생성" : job?.provider === "gemini-browser" ? "Gemini 영상" : job?.provider === "grok-imagine" ? "Grok Imagine 공장" : "영상 생성";
    const title = generationStep.querySelector("b");
    const description = generationStep.querySelector("small");
    if (title) title.textContent = job ? copy.generation : "Video generation";
    if (description) description.textContent = job ? copy.generationDetail : "Gemini Chrome 또는 설정된 로컬 모델";
  }
  const stageIndexFor = (stage = "") => {
    if (stage.includes("준비") || stage === "대기") return 1;
    if (stage.includes("Gemini") || stage.includes("영상 생성") || stage.includes("로컬 영상") || stage.includes("Grok Imagine")) return 2;
    if (stage.includes("편집") || stage.includes("정규화")) return 3;
    if (stage.includes("자막") || stage.includes("음성")) return 4;
    if (stage.includes("검수") || stage.includes("검증")) return 5;
    if (stage.includes("완료")) return 6;
    return 0;
  };
  const currentIndex = job
    ? job.status === "completed" ? 6 : stageIndexFor(job.stage)
    : -1;
  $$(".pipeline-step").forEach((step) => {
    const stageIndex = stageIndexFor(step.dataset.stage);
    const active = Boolean(job && ["queued", "running", "verifying"].includes(job.status) && stageIndex === currentIndex);
    const done = Boolean(job && (job.status === "completed" || stageIndex < currentIndex));
    step.classList.toggle("done", done);
    step.classList.toggle("current", active);
    step.classList.toggle("error", Boolean(job && job.status === "failed" && stageIndex === currentIndex));
    step.setAttribute("aria-current", active ? "step" : "false");
    const stateLabel = step.querySelector(".step-state");
    stateLabel.textContent = job?.status === "failed" && stageIndex === currentIndex
      ? "FAIL"
      : done ? "DONE" : active ? (job.status === "verifying" ? "VERIFY" : "RUN") : "WAIT";
  });
  const statusNode = $("#pipeline-status");
  if (statusNode) statusNode.textContent = job ? `${copy.status} · ${statusLabel(job.status, job)} · ${job.progress || 0}% · ${job.message || ""}` : "대기 중";
  const pipeline = $("#generation");
  if (pipeline) pipeline.hidden = job?.provider === "grok-imagine";
}

function defaultFactoryStages() {
  return [
    ["plan", "기획/슬롯"],
    ["hook-lock", "훅 스틸 잠금"],
    ["image-edit", "샷별 image_edit"],
    ["still-qa", "스틸 QA"],
    ["animate", "10초 영상"],
    ["clip-qa", "클립 QA 0.3/5/9.5"],
    ["tts-mix", "TTS/믹스"],
    ["captions", "대화 자막"],
    ["compose", "fill 720×1280 합성"],
    ["parts", "채팅 파트"]
  ].map(([id, label]) => ({ id, label, status: "WAIT", message: "" }));
}

function renderLiveFactory(job) {
  const root = $("#live-factory");
  if (!root) return;
  if (!job || job.provider !== "grok-imagine") {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  const live = state.live[job.id] || {};
  const timeline = live.timeline?.length ? live.timeline : defaultFactoryStages();
  const shots = live.shots?.length ? live.shots : Array.from({ length: 7 }, (_, index) => ({ index: index + 1, status: "WAIT" }));
  const proofs = live.proofs || [];
  const current = job.live || {};
  const currentPrompt = current.prompt || live.events?.slice().reverse().find((event) => event.prompt)?.prompt || "";
  const stamp = job.updatedAt || Date.now();
  const proofStrip = proofs.length
    ? `<div class="live-proofs"><span class="panel-kicker">AUTO-EDIT PROOF</span><div>${proofs.map((frame) => `<img src="${escapeHtml(bust(frame.url, stamp))}" alt="${escapeHtml(frame.name)}" />`).join("")}</div></div>`
    : "";
  root.innerHTML = `<div class="panel-head"><div><span class="panel-kicker">LIVE FACTORY</span><h3>실시간 제작</h3></div><span class="live-badge">${escapeHtml(current.status || statusLabel(job.status, job))}</span></div><p class="live-now">${escapeHtml(current.message || job.message || "대기 중")}</p><div class="live-stages">${timeline.map((stage) => `<div class="live-stage ${escapeHtml((stage.status || "WAIT").toLowerCase())}"><span>${escapeHtml(stage.label)}</span><b>${escapeHtml(stage.status || "WAIT")}</b><small>${escapeHtml(stage.message || "")}</small></div>`).join("")}</div><div class="live-shot-grid">${shots.map((shot) => {
    const src = bust(shot.stillUrl || shot.clipUrl, stamp);
    return `<div class="live-shot ${escapeHtml((shot.status || "WAIT").toLowerCase())}"><div class="live-shot-thumb">${src ? `<img src="${escapeHtml(src)}" alt="" />` : `<span>${String(shot.index).padStart(2, "0")}</span>`}</div><small>${escapeHtml(shot.roleKo || shot.message || `${shot.index}번`)}</small></div>`;
  }).join("")}</div>${proofStrip}${currentPrompt ? `<div class="live-prompt"><span class="panel-kicker">NOW FILLING</span><pre>${escapeHtml(currentPrompt)}</pre></div>` : `<p class="form-footnote">채워진 슬롯·샷 프롬프트가 단계가 시작되면 여기에 뜹니다.</p>`}`;
}

function applyLiveSnapshot(jobId, payload) {
  if (!payload || !jobId) return;
  const previous = state.live[jobId] || {};
  state.live[jobId] = {
    events: payload.events || previous.events || [],
    timeline: payload.timeline || previous.timeline || [],
    shots: payload.shots || previous.shots || [],
    proofs: payload.proofs || previous.proofs || []
  };
  const job = upsertJob(payload.job || state.jobs.find((item) => item.id === jobId));
  if (job && payload.job) {
    job.artifacts = payload.job.artifacts || job.artifacts;
    job.live = payload.job.live || job.live;
    job.stage = payload.job.stage || job.stage;
    job.message = payload.job.message || job.message;
    job.progress = payload.job.progress ?? job.progress;
    job.status = payload.job.status || job.status;
    job.updatedAt = payload.job.updatedAt || job.updatedAt;
  }
  const selected = state.jobs.find((item) => item.id === jobId);
  renderLiveFactory(selected);
  patchDetailProgress(selected);
  patchGridCard(selected);
}

function applyFactoryStage(jobId, event) {
  if (!event) return;
  const live = state.live[jobId] || { events: [], timeline: defaultFactoryStages(), shots: Array.from({ length: 7 }, (_, index) => ({ index: index + 1, status: "WAIT" })), proofs: [] };
  live.events = [...(live.events || []), event];
  live.timeline = (live.timeline?.length ? live.timeline : defaultFactoryStages()).map((stage) => (
    stage.id === event.stageId
      ? { ...stage, status: event.status || stage.status, message: event.message || stage.message, prompt: event.prompt || stage.prompt, frozen: Boolean(event.frozen) }
      : stage
  ));
  if (event.shotIndex) {
    live.shots = (live.shots?.length ? live.shots : Array.from({ length: 7 }, (_, index) => ({ index: index + 1, status: "WAIT" }))).map((shot) => {
      if (shot.index !== event.shotIndex) return shot;
      const still = event.artifacts?.find((item) => /\.png$/i.test(item.name || ""))?.url;
      const clip = event.artifacts?.find((item) => /\.mp4$/i.test(item.name || ""))?.url;
      return {
        ...shot,
        status: event.status || shot.status,
        message: event.message || shot.message,
        roleKo: event.roleKo || shot.roleKo,
        prompt: event.prompt || shot.prompt,
        stillUrl: still || shot.stillUrl,
        clipUrl: clip || shot.clipUrl,
        frozen: shot.frozen || Boolean(event.frozen)
      };
    });
  }
  const proofs = (event.artifacts || []).filter((item) => item.kind === "proof-frame" || /factory\/proof\//.test(item.name || ""));
  if (proofs.length) live.proofs = [...(live.proofs || []).filter((item) => !proofs.some((next) => next.name === item.name)), ...proofs];
  state.live[jobId] = live;
  const job = upsertJob({
    id: jobId,
    live: { stageId: event.stageId, status: event.status, message: event.message, prompt: event.prompt || event.animatePrompt || null, frozen: Boolean(event.frozen), shotIndex: event.shotIndex },
    message: event.message,
    artifacts: [...(state.jobs.find((item) => item.id === jobId)?.artifacts || []), ...(event.artifacts || [])]
  });
  renderLiveFactory(job);
  patchDetailProgress(job);
  patchGridCard(job);
}

function watchJobLive(job) {
  if (!job || job.provider !== "grok-imagine") return;
  const active = ["queued", "running", "verifying"].includes(job.status);
  if (!active) {
    if (state.livePoll) { window.clearInterval(state.livePoll); state.livePoll = null; }
    if (!state.live[job.id]?.timeline?.length) void loadLiveSnapshot(job.id);
    return;
  }
  if (state.sse && state.sse.jobId === job.id) return;
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  if (state.livePoll) { window.clearInterval(state.livePoll); state.livePoll = null; }
  try {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(job.id)}/events?sse=1`);
    source.jobId = job.id;
    source.addEventListener("factory_stage", (event) => {
      try { applyFactoryStage(job.id, JSON.parse(event.data)); } catch { void loadLiveSnapshot(job.id); }
    });
    source.addEventListener("job", (event) => {
      try { applyLiveSnapshot(job.id, JSON.parse(event.data)); } catch { void loadLiveSnapshot(job.id); }
    });
    source.addEventListener("done", () => {
      source.close();
      if (state.sse === source) state.sse = null;
      void loadLiveSnapshot(job.id);
      void refreshJobs();
    });
    source.onerror = () => {
      source.close();
      if (state.sse === source) state.sse = null;
      if (!state.livePoll) state.livePoll = window.setInterval(() => loadLiveSnapshot(job.id), 1000);
    };
    state.sse = source;
    void loadLiveSnapshot(job.id);
  } catch {
    if (!state.livePoll) state.livePoll = window.setInterval(() => loadLiveSnapshot(job.id), 1000);
    void loadLiveSnapshot(job.id);
  }
}

async function loadLiveSnapshot(jobId) {
  try {
    const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}/live`);
    applyLiveSnapshot(jobId, payload);
  } catch {
    // Keep the last live frame if the snapshot is briefly unavailable.
  }
}

function renderLockTable(locks = []) {
  if (!locks.length) return "";
  return `<div class="lock-table" aria-label="공장 잠금"><span class="panel-kicker">LOCKED FACTORY RULES</span>${locks.map((lock) => `<div class="lock-row"><div><b>${escapeHtml(lock.label)}</b><code>${escapeHtml(lock.id)}</code><small>${escapeHtml(lock.rule)}</small></div><span class="lock-flag">읽기 전용</span></div>`).join("")}</div>`;
}

function renderSkeleton(skeleton) {
  if (!skeleton) return "";
  const lines = (skeleton.lines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const graphics = (skeleton.redGraphics || []).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
  return `<div class="skeleton-block"><span class="panel-kicker">SHOT SKELETON · ${escapeHtml(skeleton.aspect || "9:16")}</span><p class="skeleton-meta">type ${escapeHtml(skeleton.type || "{{type}}")} · camera ${escapeHtml(skeleton.camera || "{{camera}}")}</p><div class="chip-row">${graphics}</div><ul>${lines}</ul></div>`;
}

function renderWorldSlotFields(slots = [], { namePrefix = "world-slot", editable = false } = {}) {
  return slots.map((slot) => {
    const canEdit = editable && slot.editable !== false && !slot.locked;
    const value = slot.value || "";
    const field = canEdit
      ? `<textarea id="${escapeHtml(namePrefix)}-${escapeHtml(slot.id)}" name="${escapeHtml(slot.id)}" data-world-slot="${escapeHtml(slot.id)}" rows="2">${escapeHtml(value)}</textarea>`
      : `<p class="slot-value">${escapeHtml(value || slot.placeholder || `{{${slot.id}}}`)}</p>`;
    return `<label class="slot-card ${canEdit ? "editable" : "locked"}"><span><b>${escapeHtml(slot.label)}</b><code>${escapeHtml(slot.id)}</code></span><small>${escapeHtml(slot.hint || "")}${canEdit ? "" : " · 읽기 전용"}</small>${field}</label>`;
  }).join("");
}

function renderShotPromptList(shots = []) {
  if (!shots.length) return `<div class="pending-evidence">채워진 샷 프롬프트가 아직 없습니다. 주제와 사실을 넣으면 스켈레톤이 채워집니다.</div>`;
  return `<div class="shot-prompt-list">${shots.map((shot) => `<article class="shot-prompt"><div class="shot-prompt-head"><b>${String(shot.index).padStart(2, "0")} · ${escapeHtml(shot.slotId || shot.role || "shot")}</b><span>${escapeHtml(shot.aspect || "9:16")} · ${escapeHtml(shot.tool || "")} · ${escapeHtml(shot.camera || "")}</span></div>${shot.fact ? `<small>사실 ${escapeHtml(shot.fact)}${shot.label ? ` · 라벨 ${escapeHtml(shot.label)}` : ""}</small>` : ""}<pre>${escapeHtml(shot.prompt || "")}</pre>${shot.animatePrompt ? `<details><summary>10초 애니메이션 프롬프트</summary><pre>${escapeHtml(shot.animatePrompt)}</pre></details>` : ""}</article>`).join("")}</div>`;
}

function renderPromptInspect(payload, { title = "프롬프트 템플릿", filled = false } = {}) {
  if (!payload) return "";
  return `<section class="prompt-inspect"><div class="panel-head"><div><span class="panel-kicker">${filled ? "FILLED SLOTS + SHOT PROMPTS" : "LOCKED IMAGINE TEMPLATE"}</span><h3>${escapeHtml(title)}</h3></div><span class="live-badge">${escapeHtml(payload.date || "2026-08-21")}</span></div>${renderWorldSlotFields(payload.worldSlots || payload.slots || [], { editable: false })}${renderSkeleton(payload.skeleton)}${filled ? renderShotPromptList(payload.shots || []) : ""}${renderLockTable(payload.locks || [])}</section>`;
}

async function loadTemplateSurface() {
  const root = $("#template-root");
  if (!root) return;
  try {
    if (!state.template) state.template = await api("/api/grok-imagine/template");
    const template = state.template;
    root.innerHTML = `<div class="panel-head"><div><span class="panel-kicker">GROK IMAGINE · ${escapeHtml(template.id)}</span><h3 id="template-title">${escapeHtml(template.title)}</h3></div><span class="live-badge">읽기 전용 잠금</span></div><p class="library-lead">빈 스켈레톤과 공장 잠금입니다. 슬롯 값은 새 쇼츠 초안에서만 채울 수 있고, FORBIDDEN·자막 Y·사람 없음은 바꾸지 않습니다.</p><div class="slot-grid">${renderWorldSlotFields(template.slots)}</div>${renderSkeleton(template.skeleton)}${renderLockTable(template.locks)}`;
  } catch (error) {
    root.innerHTML = `<div class="error-box"><b>템플릿을 불러오지 못했습니다</b><pre>${escapeHtml(error.message)}</pre></div>`;
  }
}

function collectWorldSlots() {
  const slots = {};
  $$("[data-world-slot]").forEach((input) => {
    const value = String(input.value || "").trim();
    if (value) slots[input.dataset.worldSlot] = value;
  });
  return slots;
}

async function refreshCreatePreview() {
  if ($("#provider")?.value !== "grok-imagine") {
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = "";
    return;
  }
  const topic = $("#topic")?.value || "";
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const worldSlots = collectWorldSlots();
  if (topic.trim().length < 4 && !facts.length) {
    const preview = $("#create-prompt-preview");
    if (preview && state.template) preview.innerHTML = renderSkeleton(state.template.skeleton) + renderLockTable(state.template.locks);
    return;
  }
  try {
    state.createPreview = await api("/api/grok-imagine/template/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: topic.trim() || "빈 현장의 숨은 원리", facts, worldSlots })
    });
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = `${renderWorldSlotFields(state.createPreview.worldSlots)}<h4 class="prompt-subhead">채워진 샷 프롬프트</h4>${renderShotPromptList(state.createPreview.shots)}${renderLockTable(state.createPreview.locks)}`;
  } catch (error) {
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = `<div class="warning-box"><b>미리보기 실패</b><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function hydrateCreateSlots() {
  try {
    if (!state.template) state.template = await api("/api/grok-imagine/template");
    const mount = $("#create-world-slots");
    if (mount && !mount.dataset.ready) {
      mount.innerHTML = renderWorldSlotFields(state.template.slots, { editable: true, namePrefix: "create-slot" });
      mount.dataset.ready = "1";
      mount.querySelectorAll("[data-world-slot]").forEach((input) => input.addEventListener("input", () => {
        window.clearTimeout(state.previewTimer);
        state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
      }));
    }
    await refreshCreatePreview();
  } catch (error) {
    showToast(`템플릿을 불러오지 못했습니다: ${error.message}`, "error");
  }
}

async function loadJobPrompts(job) {
  if (!job || job.provider !== "grok-imagine") return null;
  const cached = state.jobPrompts[job.id];
  if (cached && cached.updatedAt === job.updatedAt) return cached.payload;
  try {
    const payload = await api(`/api/jobs/${encodeURIComponent(job.id)}/prompts`);
    state.jobPrompts[job.id] = { updatedAt: job.updatedAt, payload };
    return payload;
  } catch (error) {
    state.jobPrompts[job.id] = { updatedAt: job.updatedAt, error: error.message, payload: null };
    return null;
  }
}

function renderFactoryGallery(artifactRecords = []) {
  const groups = [
    ["훅 잠금", artifactRecords.filter((artifact) => artifact.kind === "hook-lock")],
    ["스틸", artifactRecords.filter((artifact) => artifact.kind === "still")],
    ["클립", artifactRecords.filter((artifact) => artifact.kind === "clip")],
    ["마스터", artifactRecords.filter((artifact) => artifact.kind === "master-video")],
    ["채팅 파일", artifactRecords.filter((artifact) => artifact.kind === "chat-video")],
    ["파트", artifactRecords.filter((artifact) => artifact.kind === "part")]
  ].filter(([, items]) => items.length);
  if (!groups.length) return "";
  return `<div class="factory-gallery"><span class="panel-kicker">GROK IMAGINE FACTORY</span>${groups.map(([label, items]) => `<div class="factory-row"><b>${escapeHtml(label)}</b><div>${items.map((item) => {
    const isImage = /\.(png|jpe?g|webp)$/i.test(item.name);
    return isImage && item.url
      ? `<a class="factory-thumb" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" /><small>${escapeHtml(item.name)}</small></a>`
      : `<a class="artifact-link" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noreferrer"><span>${item.kind?.includes("video") || item.kind === "clip" || item.kind === "part" ? "▶" : "≡"}</span>${escapeHtml(item.name)}<b>↗</b></a>`;
  }).join("")}</div></div>`).join("")}</div>`;
}

function renderJobDetail(job) {
  const detail = $("#job-detail");
  if (!job) return;
  const copy = providerCopy(job.provider);
  const warnings = (job.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const artifactRecords = job.artifacts || [];
  const artifacts = artifactRecords.filter((artifact) => artifact.url).map((artifact) => `<a class="artifact-link" href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer"><span>${artifact.kind?.includes("video") ? "▶" : artifact.kind?.includes("thumbnail") ? "▧" : "≡"}</span>${escapeHtml(artifact.name)}<b>↗</b></a>`).join("");
  const localControls = job.provider === "local" && !["completed", "running", "verifying"].includes(job.status) ? `<div class="upload-box"><label for="detail-upload"><span>클립을 여기에 올리세요</span><small>MP4, MOV, WebM · 여러 파일 가능</small></label><input id="detail-upload" type="file" accept="video/*" multiple /><button class="secondary-button" id="run-local">업로드된 클립으로 편집 실행</button></div>` : "";
  const providerNotice = job.provider === "local-video"
    ? `<div class="pending-evidence">로컬 영상 모델 명령 어댑터 · 설정된 로컬 생성기 실행 결과만 사용합니다. 로컬 클립 업로드 경로가 아닙니다.</div>`
    : job.provider === "grok-imagine"
      ? `<div class="pending-evidence">Grok Imagine 공장 · 공식 grok CLI OAuth만 사용합니다. Gemini로 대체하지 않으며, 훅 잠금 이후에는 image_edit만 합니다.</div>`
      : "";
  const factoryGallery = renderFactoryGallery(artifactRecords);
  const promptState = state.jobPrompts[job.id];
  const promptPanel = job.provider === "grok-imagine"
    ? promptState?.payload
      ? renderPromptInspect(promptState.payload, { title: "이 쇼츠의 채워진 프롬프트", filled: true })
      : `<div class="pending-evidence">${promptState?.error ? `프롬프트를 읽지 못했습니다 · ${escapeHtml(promptState.error)}` : "채워진 슬롯과 샷 프롬프트를 불러오는 중"}</div>`
    : "";
  const detailState = state.qualityDetails[job.id];
  const quality = detailState?.quality || job.qualitySummary;
  const history = detailState?.history || [];
  const runArtifact = (suffix) => artifactRecords.find((artifact) => job.runId && artifact.name === `runs/${job.runId}/artifacts/${suffix}`) || {};
  const previewVideo = runArtifact("final.mp4");
  const previewThumbnail = runArtifact("thumbnail.jpg");
  const previewMarkup = previewVideo.url
    ? `<video controls playsinline preload="metadata" poster="${escapeHtml(previewThumbnail.url || "")}" src="${escapeHtml(previewVideo.url)}"></video>`
    : `<div class="preview-unavailable">현재 실행의 불변 미리보기 산출물이 없습니다.</div>`;
  const qualityPanel = quality
    ? `<div class="ahp-summary ${quality.semanticGate ? "passed" : "needs-improvement"}"><div><span class="panel-kicker">${quality.semanticGate ? "AHP QUALITY SCORE" : "MECHANICAL CHECK · SEMANTIC GATE CLOSED"}</span><strong>${scoreText(quality.totalScore)}<small>/ 100</small></strong></div><span>${quality.semanticGate ? (job.provider === "gemini-browser" ? "위원회·Gemini 근거 검토 가능" : job.provider === "grok-imagine" ? "위원회·Imagine 근거 검토 가능" : "위원회 근거 검토 가능") : "기계 점수만 표시 · 의미론 판정 보류"}</span></div>${renderAHPPanel(quality, history)}${quality.blockers?.length ? `<div class="warning-box"><b>차단·개선 항목</b><ul>${quality.blockers.slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}`
    : `<div class="pending-evidence">품질 검수 대기 · 현재 상태 ${escapeHtml(statusLabel(job.status, job))}${detailState?.error ? ` · ${escapeHtml(detailState.error)}` : ""}</div>`;
  const preview = shortPreview(job);
  const previewMedia = preview.videoUrl
    ? `<video controls playsinline preload="metadata" poster="${escapeHtml(preview.poster || previewThumbnail.url || "")}" src="${escapeHtml(preview.videoUrl)}"></video>`
    : preview.poster
      ? `<img class="preview-still" src="${escapeHtml(preview.poster)}" alt="훅 잠금" />`
      : previewMarkup;
  const status = shortStatus(job);
  detail.innerHTML = `<div class="detail-head"><div><span class="panel-kicker">SELECTED SHORT</span><h3 id="short-detail-title">${escapeHtml(job.topic)}</h3></div><span class="job-status ${status.key} ${job.status}"><i></i>${escapeHtml(status.label)}</span></div><div class="detail-progress"><div><span>${escapeHtml(job.message || "")}</span><b>${job.progress || 0}%</b></div><div class="progress-track"><i style="width:${job.progress || 0}%"></i></div></div>${qualityPanel}<div class="preview-wrap">${previewMedia}<div class="preview-caption"><span>${preview.videoUrl ? "FINAL PREVIEW · RUN-BOUND" : preview.poster ? "HOOK LOCK" : "PREVIEW"}</span><span>${formatTime(shortDurationSeconds(job))} · ${job.format === "vertical" ? "9:16" : "16:9"}</span></div></div>${providerNotice}${factoryGallery}${promptPanel}${localControls}<div class="detail-meta"><span>생성 모드 <b>${escapeHtml(copy.detail)}</b></span><span>자막 <b>${job.captions ? "ON" : "OFF"}</b></span><span>내레이션 <b>${job.voiceover ? "ON" : "OFF"}</b></span><span>RUN <b>${escapeHtml(job.runId || "—")}</b></span><span>RUN STATUS <b>${escapeHtml(job.runStatus || "—")}</b></span></div>${warnings ? `<div class="warning-box"><b>확인 필요</b><ul>${warnings}</ul></div>` : ""}${artifacts ? `<div class="artifact-list"><span class="panel-kicker">RUN-BOUND DELIVERABLES</span>${artifacts}</div>` : ""}${job.status === "failed" ? `<div class="error-box"><b>실행 오류</b><pre>${escapeHtml(job.error || job.message || "알 수 없는 오류")}</pre><button class="secondary-button" id="retry-job">다시 실행</button></div>` : ""}`;
  $("#detail-upload")?.addEventListener("change", uploadLocalClips);
  $("#run-local")?.addEventListener("click", runSelectedJob);
  $("#retry-job")?.addEventListener("click", runSelectedJob);
  if (job.provider === "grok-imagine") {
    const cached = state.jobPrompts[job.id];
    if (!cached || cached.updatedAt !== job.updatedAt) {
      void loadJobPrompts(job).then(() => {
        if (state.selectedJobId === job.id && state.view === "detail") renderJobDetail(job);
      });
    }
  }
}

async function uploadLocalClips(event) {
  const files = [...event.target.files];
  if (!files.length || !state.selectedJobId) return;
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/clips`, { method: "POST", body: form });
    showToast(`${files.length}개 클립을 업로드했습니다.`);
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function runSelectedJob() {
  if (!state.selectedJobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/run`, { method: "POST" });
    showToast("편집 파이프라인을 시작했습니다.");
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function pollJobs() {
  try {
    await refreshJobs();
  } catch (error) {
    showToast(`작업 상태 갱신 실패: ${error.message}`, "error");
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (selected) $("#pipeline-status").textContent = `상태 갱신 실패 · ${error.message}`;
  }
}

function syncPollTimer() {
  const active = state.jobs.some((job) => ["queued", "running", "verifying"].includes(job.status));
  if (state.poll) { window.clearInterval(state.poll); state.poll = null; }
  if (active) state.poll = window.setInterval(pollJobs, 900);
}

async function refreshJobs() {
  const payload = await api("/api/jobs");
  const previousIds = state.jobs.map((job) => job.id).join("\n");
  const nextIds = payload.jobs.map((job) => job.id).join("\n");
  const selectedId = state.selectedJobId;
  const selectedLive = selectedId ? state.jobs.find((job) => job.id === selectedId) : null;
  state.jobs = payload.jobs.map((job) => {
    if (job.id === selectedId && selectedLive?.live && ["queued", "running", "verifying"].includes(job.status)) {
      return { ...job, live: job.live || selectedLive.live, artifacts: job.artifacts?.length ? job.artifacts : selectedLive.artifacts };
    }
    return job;
  });
  const structural = previousIds !== nextIds || !document.querySelector("#create-tile");
  if (structural) renderJobs();
  else {
    state.jobs.forEach(patchGridCard);
    const selected = state.jobs.find((job) => job.id === selectedId);
    if (state.view === "detail" && selected) {
      patchDetailProgress(selected);
      renderLiveFactory(selected);
      watchJobLive(selected);
    }
  }
  syncPollTimer();
}

async function createProduction(event) {
  event.preventDefault();
  const provider = $("#provider").value;
  const sources = $("#sources").value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ title: url, url }));
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const worldSlots = collectWorldSlots();
  const body = { topic: $("#topic").value, format: $("#format").value, clipCount: Number($("#clip-count").value), provider, sources, facts, worldSlots, captions: $("#captions").checked, voiceover: provider === "grok-imagine" ? false : $("#voiceover").checked };
  if (provider === "gemini-browser" || provider === "grok-imagine") body.autoStart = true;
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "파이프라인 시작 중…";
  try {
    const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.selectedJobId = payload.job.id;
    state.highlightJobId = payload.job.id;
    upsertJob(payload.job);
    window.setTimeout(() => {
      if (state.highlightJobId === payload.job.id) state.highlightJobId = null;
      const card = document.querySelector(`[data-job-id="${CSS.escape(payload.job.id)}"]`);
      card?.classList.remove("just-created");
    }, 4200);
    if (provider === "grok-imagine") {
      setView("detail");
      renderJobs();
      watchJobLive(payload.job);
    } else {
      setView("grid");
    }
    await refreshJobs();
    if (provider !== "grok-imagine") $("#shorts")?.scrollIntoView({ behavior: "smooth", block: "start" });
    const message = provider === "gemini-browser"
      ? "Gemini Chrome 자동 생성 작업을 시작했습니다."
      : provider === "grok-imagine"
        ? "Grok Imagine 공장 작업을 시작했습니다. 실시간 단계가 이 쇼츠에 표시됩니다."
      : provider === "local-video"
        ? "로컬 영상 모델 명령 어댑터 작업을 만들었습니다. 설정된 생성기 명령이 필요합니다."
        : "로컬 클립 편집 작업을 만들었습니다. 클립을 업로드하세요.";
    showToast(message);
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.querySelector("span").textContent = "자동 제작 시작"; }
}

async function refreshHealth() {
  try {
    const health = await api("/api/health");
    const monitor = await api("/api/gemini/monitor").catch(() => null);
    const monitorProfiles = Array.isArray(monitor?.profiles) ? monitor.profiles : [];
    const monitorDetails = monitorProfiles.map((profile) => {
      const mode = profile.headless === true ? "headless" : profile.headless === false ? "background" : "mode unknown";
      const detail = profile.available ? "READY" : (profile.quotaResetText || profile.quotaMessage || "BLOCKED");
      return `${profile.email || profile.id} [${mode}]: ${detail}`;
    }).join(" · ");
    const monitorLabel = monitorProfiles.length
      ? `${monitor.status || "monitoring"} · ${monitorProfiles.filter((profile) => profile.available).length}/${monitorProfiles.length} 계정 사용 가능 · ${monitorDetails}`
      : "monitor not running";
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
    $("#system-label").textContent = ready ? "시스템 준비 완료" : "설정 확인 필요";
    $("#browser-start").classList.toggle("connected", browserConnected);
    $("#browser-start").innerHTML = `<span class="button-dot"></span>${browserConnected ? "Gemini Chrome 연결됨" : "Gemini Chrome 연결"}`;
    $("#health-capabilities").innerHTML = `<div class="health-title">LOCAL CAPABILITIES <small>${ready ? "READY" : "CHECK REQUIRED"}</small></div><div class="health-items">${checks.map(([name, value]) => `<span class="${value ? "ok" : "missing"}"><i></i>${name} ${value ? "PASS" : "MISSING"}</span>`).join("")}<span class="${browserConnected ? "ok" : "missing"}"><i></i>Gemini Chrome ${browserConnected ? "CONNECTED" : "DISCONNECTED"}</span><span class="${health.capabilities.geminiApiKey ? "ok" : "muted"}"><i></i>Gemini text API ${health.capabilities.geminiApiKey ? "CONFIGURED" : "NOT CONFIGURED"}</span><span class="${health.capabilities.grokCli ? "ok" : "muted"}"><i></i>Grok Imagine CLI ${health.capabilities.grokCli ? "READY" : "NOT ON THIS MACHINE"}</span><span class="muted"><i></i>yt-dlp ${escapeHtml(ytDlp.version || "unknown")} · ${escapeHtml(ytDlp.maintenance || "maintenance unavailable")}</span><span class="${monitorProfiles.some((profile) => profile.available) ? "ok" : "muted"}"><i></i>Gemini quota monitor ${escapeHtml(monitorLabel)}</span></div>`;
    if (!health.capabilities.ffmpeg) showToast("ffmpeg가 없습니다. 터미널에서 brew install ffmpeg를 실행하세요.", "error");
  } catch (error) {
    $("#system-label").textContent = "서버 연결 실패";
    $("#health-capabilities").innerHTML = `<span class="health-error">서버 상태를 확인하지 못했습니다: ${escapeHtml(error.message)}</span>`;
  }
}

async function connectBrowser() {
  const button = $("#browser-start");
  button.disabled = true;
  button.innerHTML = `<span class="button-dot"></span> Chrome 시작 중…`;
  try {
    const result = await api("/api/browser/start", { method: "POST" });
    showToast(result.started ? "전용 Chrome을 시작했습니다. Gemini 로그인 세션을 확인하세요." : "Chrome DevTools 연결이 확인되었습니다.");
    await refreshHealth();
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; await refreshHealth(); }
}

function syncProviderForm() {
  const provider = $("#provider")?.value;
  const factsField = $("#facts-field");
  const help = $("#provider-help");
  const voiceover = $("#voiceover");
  const clipCount = $("#clip-count");
  const format = $("#format");
  if (factsField) factsField.hidden = provider !== "grok-imagine";
  if (help) {
    help.textContent = provider === "grok-imagine"
      ? "Grok Imagine 공장은 PATH의 grok 또는 ~/.grok/bin/grok와 이미 되어 있는 SuperGrok OAuth만 사용합니다. XAI_API_KEY와 grok login/logout은 쓰지 않으며 Gemini로 대체하지 않습니다. 훅 잠금 후 image_edit, 10초 720p, 대화 자막 MarginV=450."
      : provider === "local-video"
        ? "로컬 영상 모델은 설정된 생성기 명령이 필요합니다. 로컬 클립 업로드와는 별도이며, 생성기를 대신 제공하지 않습니다."
        : provider === "local"
          ? "업로드한 로컬 클립만 편집합니다. 영상을 생성하지 않습니다."
          : "Gemini 모드는 전용 Chrome 프로필의 쿠키·세션을 재사용합니다. CAPTCHA·로그인 입력은 우회하지 않습니다.";
  }
  if (voiceover) {
    if (provider === "grok-imagine") {
      voiceover.checked = false;
      voiceover.disabled = true;
    } else {
      voiceover.disabled = false;
    }
  }
  if (clipCount) {
    clipCount.value = provider === "grok-imagine" ? "7" : clipCount.value;
    clipCount.disabled = provider === "grok-imagine";
  }
  if (format) {
    if (provider === "grok-imagine") format.value = "vertical";
    format.disabled = provider === "grok-imagine";
  }
  syncToggleLabels();
}

function openCreate(event) {
  event?.preventDefault();
  setView("create");
  void hydrateCreateSlots();
}

function openTemplate(event) {
  event?.preventDefault();
  setView("template");
}

async function importLibrary(event) {
  event?.preventDefault();
  try {
    const payload = await api("/api/library/import", { method: "POST" });
    await refreshJobs();
    const imported = payload.imported?.length || 0;
    const seeded = payload.seeded?.length || 0;
    showToast(imported ? `${imported}편 마스터를 카드로 올렸습니다.` : seeded ? "시드 카드가 라이브러리에 있습니다. 마스터를 workspace/imports에 두면 붙습니다." : "라이브러리를 다시 읽었습니다.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function closeOverlays(event) {
  event?.preventDefault();
  state.selectedJobId = state.view === "detail" ? null : state.selectedJobId;
  setView("grid");
  renderJobs();
}

function bindEvents() {
  $("#create-form").addEventListener("submit", createProduction);
  $("#provider")?.addEventListener("change", syncProviderForm);
  syncProviderForm();
  $("#browser-start").addEventListener("click", connectBrowser);
  $("#new-short")?.addEventListener("click", openCreate);
  $("#create-tile")?.addEventListener("click", openCreate);
  $("#open-template")?.addEventListener("click", openTemplate);
  $("#import-library")?.addEventListener("click", importLibrary);
  $("#close-create")?.addEventListener("click", closeOverlays);
  $("#close-short")?.addEventListener("click", closeOverlays);
  $("#close-template")?.addEventListener("click", closeOverlays);
  $("#topic")?.addEventListener("input", () => {
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
  });
  $("#facts")?.addEventListener("input", () => {
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
  });
  $$("[data-close-view]").forEach((node) => node.addEventListener("click", closeOverlays));
  window.addEventListener("hashchange", () => { applyHash(); renderJobs(); });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.view !== "grid") closeOverlays();
  });
  $("#refresh-all").addEventListener("click", async () => { await Promise.all([refreshJobs(), renderVideos(), refreshHealth()]); showToast("데이터를 갱신했습니다."); });
  $$('[data-topic]').forEach((button) => button.addEventListener("click", () => { $("#topic").value = button.dataset.topic; $("#topic").focus(); }));
  $$(".toggle-label input").forEach((input) => input.addEventListener("change", syncToggleLabels));
  syncToggleLabels();
  $("#video-search").addEventListener("input", (event) => { state.query = event.target.value; state.page = 1; window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(() => renderVideos().catch((error) => showToast(`영상 검색 실패: ${error.message}`, "error")), 250); });
  $("#video-sort").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 1; renderVideos().catch((error) => showToast(`정렬 실패: ${error.message}`, "error")); });
  $("#video-category").addEventListener("change", (event) => { state.category = event.target.value; state.page = 1; renderVideos().catch((error) => showToast(`필터 실패: ${error.message}`, "error")); });
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderVideos().catch((error) => showToast(`페이지 이동 실패: ${error.message}`, "error")); } });
  $("#next-page").addEventListener("click", () => { state.page += 1; renderVideos().catch((error) => showToast(`페이지 이동 실패: ${error.message}`, "error")); });
}

async function init() {
  bindEvents();
  applyHash();
  try {
    const [analysis, benchmarkProfile] = await Promise.all([api("/api/channel"), api("/api/benchmark/profile")]);
    state.analysis = { ...analysis, benchmarkProfile };
    renderStats();
    renderBenchmark();
    await Promise.all([renderVideos(), refreshJobs(), refreshHealth()]);
  } catch (error) {
    showToast(error.message, "error");
  }
}

init();
