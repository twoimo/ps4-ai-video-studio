const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { analysis: null, jobs: [], selectedJobId: null, page: 1, query: "", sort: "views", category: "", poll: null, qualityHistory: {}, qualityDetails: {} };

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

function statusLabel(status) {
  return status === "completed" ? "완료" : status === "failed" ? "오류" : status === "verifying" ? "검수 중" : status === "running" ? "제작 중" : status === "queued" ? "대기열" : "상태 확인 중";
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

function renderJobs() {
  const list = $("#jobs-list");
  if (!state.jobs.length) {
    list.innerHTML = `<div class="empty-state">아직 제작 작업이 없습니다.<br />위에서 주제를 입력하면 파이프라인이 시작됩니다.</div>`;
    $("#job-detail").innerHTML = `<div class="empty-detail"><span>◌</span><p>작업을 선택하면<br />실시간 산출물이 표시됩니다.</p></div>`;
    renderPipeline(null);
    return;
  }
  if (!state.selectedJobId || !state.jobs.some((job) => job.id === state.selectedJobId)) state.selectedJobId = state.jobs[0].id;
  list.innerHTML = state.jobs.map((job) => `<button class="job-card ${job.id === state.selectedJobId ? "selected" : ""}" aria-pressed="${job.id === state.selectedJobId}" data-job-id="${escapeHtml(job.id)}"><div class="job-card-top"><span class="job-status ${job.status}"><i></i>${statusLabel(job.status)}</span><time>${new Date(job.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><h3>${escapeHtml(job.topic)}</h3><div class="job-card-bottom"><span>${escapeHtml(job.stage)} · ${escapeHtml(providerCopy(job.provider).short)}</span><strong>${job.progress || 0}%</strong></div><div class="mini-progress"><i style="width:${job.progress || 0}%"></i></div></button>`).join("");
  $$(".job-card").forEach((button) => button.addEventListener("click", () => { state.selectedJobId = button.dataset.jobId; renderJobs(); }));
  const selected = state.jobs.find((job) => job.id === state.selectedJobId);
  renderJobDetail(selected);
  renderPipeline(selected);
  if (selected?.status === "completed" && selected.runId) void loadQualityEvidence(selected);
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
  $("#pipeline-status").textContent = job ? `${copy.status} · ${statusLabel(job.status)} · ${job.progress || 0}% · ${job.message || ""}` : "대기 중";
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
    : `<div class="pending-evidence">품질 검수 대기 · 현재 상태 ${escapeHtml(statusLabel(job.status))}${detailState?.error ? ` · ${escapeHtml(detailState.error)}` : ""}</div>`;
  detail.innerHTML = `<div class="detail-head"><div><span class="panel-kicker">SELECTED JOB</span><h3>${escapeHtml(job.topic)}</h3></div><span class="job-status ${job.status}"><i></i>${statusLabel(job.status)}</span></div><div class="detail-progress"><div><span>${escapeHtml(job.message || "")}</span><b>${job.progress || 0}%</b></div><div class="progress-track"><i style="width:${job.progress || 0}%"></i></div></div>${qualityPanel}${job.status === "completed" ? `<div class="preview-wrap">${previewMarkup}<div class="preview-caption"><span>FINAL PREVIEW · RUN-BOUND</span><span>${formatTime(job.duration)} · ${job.format === "vertical" ? "9:16" : "16:9"}</span></div></div>` : ""}${providerNotice}${factoryGallery}${localControls}<div class="detail-meta"><span>생성 모드 <b>${escapeHtml(copy.detail)}</b></span><span>자막 <b>${job.captions ? "ON" : "OFF"}</b></span><span>내레이션 <b>${job.voiceover ? "ON" : "OFF"}</b></span><span>RUN <b>${escapeHtml(job.runId || "—")}</b></span><span>RUN STATUS <b>${escapeHtml(job.runStatus || "—")}</b></span></div>${warnings ? `<div class="warning-box"><b>확인 필요</b><ul>${warnings}</ul></div>` : ""}${artifacts ? `<div class="artifact-list"><span class="panel-kicker">RUN-BOUND DELIVERABLES</span>${artifacts}</div>` : ""}${job.status === "failed" ? `<div class="error-box"><b>실행 오류</b><pre>${escapeHtml(job.error || job.message || "알 수 없는 오류")}</pre><button class="secondary-button" id="retry-job">다시 실행</button></div>` : ""}`;
  $("#detail-upload")?.addEventListener("change", uploadLocalClips);
  $("#run-local")?.addEventListener("click", runSelectedJob);
  $("#retry-job")?.addEventListener("click", runSelectedJob);
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

async function refreshJobs() {
  const payload = await api("/api/jobs");
  state.jobs = payload.jobs;
  renderJobs();
  const active = state.jobs.some((job) => ["queued", "running", "verifying"].includes(job.status));
  if (active && !state.poll) state.poll = window.setInterval(pollJobs, 1800);
  if (!active && state.poll) { window.clearInterval(state.poll); state.poll = null; }
}

async function createProduction(event) {
  event.preventDefault();
  const provider = $("#provider").value;
  const sources = $("#sources").value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ title: url, url }));
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const body = { topic: $("#topic").value, format: $("#format").value, clipCount: Number($("#clip-count").value), provider, sources, facts, captions: $("#captions").checked, voiceover: provider === "grok-imagine" ? false : $("#voiceover").checked };
  if (provider === "gemini-browser" || provider === "grok-imagine") body.autoStart = true;
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "파이프라인 시작 중…";
  try {
    const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.selectedJobId = payload.job.id;
    await refreshJobs();
    document.querySelector("#rendering").scrollIntoView({ behavior: "smooth", block: "start" });
    const message = provider === "gemini-browser"
      ? "Gemini Chrome 자동 생성 작업을 시작했습니다."
      : provider === "grok-imagine"
        ? "Grok Imagine 공장 작업을 시작했습니다. 공식 grok CLI OAuth가 있는 기기에서만 진행됩니다."
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

function bindEvents() {
  $("#create-form").addEventListener("submit", createProduction);
  $("#provider")?.addEventListener("change", syncProviderForm);
  syncProviderForm();
  $("#browser-start").addEventListener("click", connectBrowser);
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
