import { formatClock, isWatchableShort, shortDurationSeconds, shortPreview, shortStatus, shortThumbnail, shortUploadPack } from "./shorts-ui.mjs";
import { collectInspectPayload } from "./materials-editor.mjs";
import { machineSheetHtml, renderStudioPipe } from "./studio-pipe.mjs";
import { paintStudioPipe } from "./studio-chrome.mjs";
import { renderWorldSlotFields } from "./template-spec.mjs";
import { applyWatchTransform, bindWatchFeed, clearWatchSize, createWatchPlayer, currentWatchSlide, goWatchIndex, playWatchFeed, settleWatchIndex, sizeWatchFeed, stepWatchFeed, stopWatchFeed, syncWatchFeed, wrapWatchFeed } from "./watch-feed.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const APP_TITLE = "PS4_JUSTDOIT";
const VIEWS = ["create", "settings", "machine", "watch", "grid"];
const state = {
  jobs: [],
  selectedJobId: null,
  highlightJobId: null,
  view: "grid",
  template: null,
  createPreview: null,
  live: {},
  health: null,
  sse: null,
  livePoll: null,
  poll: null,
  returnToWatch: false,
  watchObserver: null,
  feedObserver: null,
  watchLockUntil: 0,
  watchSwiping: false,
  createMode: "single",
  focusOpener: null,
  jobsLoaded: false
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function syncToggleLabels() {
  $$(".toggle-state").forEach((label) => {
    const input = document.getElementById(label.dataset.toggleState);
    label.textContent = input?.checked ? "켜짐" : "꺼짐";
  });
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

function watchableJobs() {
  return state.jobs.filter((job) => isWatchableShort(job));
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedJobId) || null;
}

function hashForView(view) {
  if (view === "create") return "#create";
  if (view === "watch") return state.selectedJobId ? `#watch/${state.selectedJobId}` : "#watch";
  if (view === "settings") return "#settings";
  if (view === "machine") return "#machine";
  return "#shorts";
}

function replaceWatchHash(jobId) {
  if (state.view !== "watch" || !jobId) return;
  const next = `#watch/${jobId}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex=\"-1\"])";

function overlayFocusables(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => !node.hidden && node.closest("[hidden]") == null);
}

function bindFocusTrap(root) {
  if (!root || root.dataset.focusTrap === "1") return;
  root.dataset.focusTrap = "1";
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const items = overlayFocusables(root);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function rememberOpener(event) {
  state.focusOpener = event?.currentTarget || document.activeElement;
}

function restoreOpener() {
  const opener = state.focusOpener;
  state.focusOpener = null;
  if (opener && typeof opener.focus === "function") opener.focus();
}

function trapOverlay(selector) {
  const root = $(selector);
  if (!root) return;
  bindFocusTrap(root);
  window.requestAnimationFrame(() => overlayFocusables(root)[0]?.focus());
}

function setView(view, options = {}) {
  const next = VIEWS.includes(view) ? view : "grid";
  const createOverlay = $("#create-overlay");
  const settingsOverlay = $("#settings-overlay");
  const watchFeed = $("#watch-feed");
  const library = $("#shorts");
  if (next !== "watch") clearWatchSize(watchFeed);
  state.view = next;
  document.body.classList.toggle("watch-open", state.view === "watch");
  document.body.classList.toggle("overlay-open", ["create", "settings", "machine"].includes(state.view));
  if (createOverlay) createOverlay.hidden = state.view !== "create";
  if (settingsOverlay) settingsOverlay.hidden = state.view !== "settings";
  const machineOverlay = $("#machine-overlay");
  if (machineOverlay) machineOverlay.hidden = state.view !== "machine";
  const menuOverlay = $("#menu-overlay");
  if (menuOverlay && next !== "grid") menuOverlay.hidden = true;
  if (watchFeed) watchFeed.hidden = state.view !== "watch";
  if (library) library.hidden = state.view === "watch";
  const openingWatch = state.view === "watch";
  if (openingWatch) {
    document.querySelectorAll(".preview-wrap video, .shorts-grid video, audio").forEach((media) => {
      try { media.pause(); } catch { /* ignore leftover preview/grid/audio */ }
    });
    sizeWatchFeed(watchFeed);
  }
  syncWatchFeed(watchFeed, state.view, () => mountWatchFeed({ focus: true, instant: Boolean(options.instant) }));
  const afterPaint = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
  if (openingWatch) {
    afterPaint(() => {
      sizeWatchFeed(watchFeed);
      applyWatchTransform(watchFeed, { animate: false });
    });
  } else {
    sizeShortsGrid();
    afterPaint(() => sizeShortsGrid());
  }
  if (!options.skipHash) {
    const nextHash = hashForView(state.view);
    if (location.hash !== nextHash) history.replaceState(null, "", nextHash);
  }
  if (state.view === "create") {
    syncCreateMode();
    trapOverlay("#create-overlay");
    void hydrateCreateSlots();
    void hydrateStudioSettings();
  }
  if (state.view === "settings") trapOverlay("#settings-overlay");
  if (state.view === "machine") trapOverlay("#machine-overlay");
  if (state.view === "settings") void hydrateStudioSettings();
  if (state.view === "machine") renderMachineSheet();
  syncDocumentTitle();
}

function syncDocumentTitle() {
  if (state.view === "watch") {
    const shortTitle = String(selectedJob()?.topic || "").trim();
    document.title = shortTitle ? `${shortTitle} · ${APP_TITLE}` : APP_TITLE;
    return;
  }
  document.title = APP_TITLE;
}

function applyHash() {
  const hash = location.hash.replace("#", "");
  if (hash === "create") {
    setView("create", { skipHash: true });
    return;
  }
  if (hash === "template") {
    location.replace("/template");
    return;
  }
  if (hash === "backlot" || hash.startsWith("backlot/")) {
    const projectId = hash.startsWith("backlot/p/") ? hash.slice("backlot/p/".length) : hash.startsWith("backlot/") && hash !== "backlot/" ? hash.slice("backlot/".length) : "";
    location.replace(projectId ? `/backlot/p/${encodeURIComponent(projectId)}` : "/backlot");
    return;
  }
  if (hash === "settings") {
    setView("settings", { skipHash: true });
    return;
  }
  if (hash === "machine") {
    setView("machine", { skipHash: true });
    return;
  }
  if (hash === "watch" || hash.startsWith("watch/")) {
    const jobId = hash.startsWith("watch/") ? decodeURIComponent(hash.slice("watch/".length)) : "";
    if (jobId) state.selectedJobId = jobId;
    if (watchableJobs().length) {
      setView("watch", { skipHash: true, instant: true });
      return;
    }
    setView("grid", { skipHash: true });
    return;
  }
  if (hash === "short" || hash.startsWith("short/")) {
    const jobId = hash.startsWith("short/") ? decodeURIComponent(hash.slice("short/".length)) : "";
    if (jobId) {
      openMaterials(jobId);
      return;
    }
    location.replace("/backlot");
    return;
  }
  if (!hash || hash === "shorts") {
    setView("grid", { skipHash: true });
    return;
  }
  setView("grid", { skipHash: true });
}

function sizeShortsGrid() {
  const grid = $("#shorts-grid");
  if (!grid) return;
  const gap = 2;
  const width = grid.clientWidth;
  if (!width) return;
  const col = (window.innerHeight - 52 - gap) * 9 / 16;
  if (!(col > 0)) return;
  const shortLandscape = window.innerWidth > window.innerHeight && window.innerHeight / window.innerWidth < 0.75;
  const n = Math.max(shortLandscape ? 3 : 1, Math.ceil((width + gap) / (col + gap)));
  grid.style.setProperty("--n", String(n));
}

function createTileMarkup() {
  return `<button type="button" class="short-card short-create-tile" id="create-tile" aria-label="새 쇼츠"><div class="short-card-thumb create-thumb"><span class="create-plus">+</span></div></button>`;
}

function jobCardsMarkup() {
  return state.jobs.map(renderShortCard).join("");
}

function bindFeedScroll() {
  const grid = $("#shorts-grid");
  state.feedObserver?.disconnect();
  state.feedObserver = null;
  const sentinel = grid?.querySelector(".feed-sentinel");
  if (!grid || !sentinel) return;
  state.feedObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) grid.scrollTo({ top: 0, behavior: "smooth" });
  }, { root: grid, rootMargin: "600px" });
  state.feedObserver.observe(sentinel);
}

function bust(url, token) {
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token || "")}`;
}

function watchIndexOf(jobId) {
  return watchableJobs().findIndex((job) => job.id === jobId);
}

function watchSignature() {
  return watchableJobs().map((job) => `${job.id}:${shortPreview(job).videoUrl}`).join("\n");
}

function watchSlideMarkup(job, loop = "") {
  const preview = shortPreview(job);
  const poster = bust(preview.poster, job.updatedAt);
  const loopAttr = loop === "head" ? ' data-loop="head"' : loop === "tail" ? ' data-loop="tail"' : "";
  return `<article class="watch-slide"${loopAttr} data-job-id="${escapeHtml(job.id)}" data-src="${escapeHtml(preview.videoUrl)}" data-video-url="${escapeHtml(preview.videoUrl)}" data-poster="${escapeHtml(poster)}">${poster ? `<img class="watch-poster" src="${escapeHtml(poster)}" alt="" />` : ""}</article>`;
}

function watchChromeMarkup() {
  return `<button type="button" class="watch-close watch-back" aria-label="닫기">×</button><button type="button" class="watch-menu watch-materials-toggle" aria-label="재료"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg></button><div class="watch-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><div class="watch-slide-chrome"><div class="watch-meta"><h2></h2></div></div>`;
}

function watchFeedMarkup(jobs) {
  if (jobs.length >= 2) {
    return `${watchSlideMarkup(jobs[jobs.length - 1], "head")}${jobs.map((job) => watchSlideMarkup(job)).join("")}${watchSlideMarkup(jobs[0], "tail")}`;
  }
  return jobs.map((job) => watchSlideMarkup(job)).join("");
}

function renderWatchSlide(job) {
  return watchSlideMarkup(job);
}

function bindWatchChrome() {
  const feed = $("#watch-feed");
  if (!feed || feed.dataset.chromeBound === "1") return;
  feed.dataset.chromeBound = "1";
  const video = createWatchPlayer(feed);
  video?.addEventListener("timeupdate", () => {
    const progress = feed.querySelector(".watch-progress");
    const bar = progress?.querySelector("i");
    if (video.duration) {
      const value = Math.round((video.currentTime / video.duration) * 100);
      if (bar) bar.style.width = `${value}%`;
      progress?.setAttribute("aria-valuenow", String(value));
    }
  });
  feed.querySelector(".watch-close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    stopWatchFeed(feed);
    openHome(event);
  });
  feed.querySelector(".watch-menu, .watch-materials-toggle")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const jobId = currentWatchSlide(feed)?.dataset?.jobId || state.selectedJobId;
    openMaterials(jobId);
  });
}

function placeWatchFeed(index = Math.max(0, watchIndexOf(state.selectedJobId))) {
  const root = $("#watch-feed");
  const jobs = watchableJobs();
  const last = Math.max(0, jobs.length - 1);
  const real = Math.max(0, Math.min(last, index));
  const offset = jobs.length >= 2 ? 1 : 0;
  goWatchIndex(root, real + offset, { animate: false });
}

function notifyActive(jobId) {
  const root = $("#watch-feed");
  wrapWatchFeed(root);
  const slide = currentWatchSlide(root);
  const id = jobId || slide?.dataset?.jobId;
  if (!id) return;
  state.selectedJobId = id;
  replaceWatchHash(id);
  activateWatchSlide(id);
}

function activateWatchSlide(jobId) {
  $$(".watch-slide").forEach((slide) => {
    slide.classList.toggle("active", slide.dataset.jobId === jobId && !slide.dataset.loop);
  });
  const title = $("#watch-feed .watch-meta h2");
  const job = state.jobs.find((item) => item.id === jobId);
  if (title) title.textContent = job?.topic || "쇼츠";
  const feed = $("#watch-feed");
  if (!document.body.classList.contains("watch-open")) {
    stopWatchFeed(feed);
    return;
  }
  const play = playWatchFeed(feed);
  if (play && typeof play.catch === "function") play.catch(() => {});
}

function goToWatchIndex(index, { instant = false } = {}) {
  const jobs = watchableJobs();
  if (!jobs.length) return;
  const next = Math.max(0, Math.min(jobs.length - 1, index));
  const job = jobs[next];
  state.selectedJobId = job.id;
  placeWatchFeed(next);
  activateWatchSlide(job.id);
  replaceWatchHash(job.id);
  syncDocumentTitle();
}

function patchWatchSlide(job) {
  document.querySelectorAll(`.watch-slide[data-job-id="${CSS.escape(job.id)}"]`).forEach((slide) => {
    const preview = shortPreview(job);
    if (preview.videoUrl) {
      slide.dataset.src = preview.videoUrl;
      slide.dataset.videoUrl = preview.videoUrl;
    }
    if (preview.poster) slide.dataset.poster = bust(preview.poster, job.updatedAt);
    const img = slide.querySelector(".watch-poster");
    if (img && slide.dataset.poster) img.src = slide.dataset.poster;
  });
  if (state.selectedJobId === job.id) {
    const title = $("#watch-feed .watch-meta h2");
    if (title) title.textContent = job.topic || "쇼츠";
  }
}

function mountWatchFeed({ focus = false, instant = false } = {}) {
  const root = $("#watch-feed");
  const track = $("#watch-track");
  const empty = $("#watch-empty");
  bindWatchFeed(root, openHome, (jobId) => notifyActive(jobId));
  bindWatchChrome();
  createWatchPlayer(root);
  if (!track) return;
  const jobs = watchableJobs();
  if (empty) empty.hidden = jobs.length > 0;
  if (!jobs.length) {
    stopWatchFeed(root);
    track.innerHTML = "";
    track.dataset.signature = "";
    return;
  }
  const signature = watchSignature();
  const rebuilt = track.dataset.signature !== signature;
  if (rebuilt) {
    stopWatchFeed(root);
    track.dataset.signature = signature;
    track.innerHTML = watchFeedMarkup(jobs);
  } else {
    jobs.forEach(patchWatchSlide);
  }
  if (focus || !document.querySelector(".watch-slide.active:not([data-loop])")) {
    const index = Math.max(0, watchIndexOf(state.selectedJobId));
    placeWatchFeed(index);
    goToWatchIndex(index, { instant });
  } else {
    placeWatchFeed(Math.max(0, watchIndexOf(state.selectedJobId)));
  }
  settleWatchIndex(root, { animate: false });
}

function renderWatchFeed(options) {
  return mountWatchFeed(options);
}

function materialsUrl(jobId) {
  return `/backlot/p/${encodeURIComponent(jobId)}`;
}

function openMaterials(jobId) {
  if (!jobId) return;
  state.selectedJobId = jobId;
  stopWatchFeed($("#watch-feed"));
  location.assign(materialsUrl(jobId));
}

function openJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  state.selectedJobId = jobId;
  if (job && isWatchableShort(job)) {
    setView("watch", { instant: true });
    renderJobs();
    return;
  }
  openMaterials(jobId);
}

function openDetail(jobId) {
  openMaterials(jobId);
}

function collectDraftFields(root) {
  return collectInspectPayload(root);
}

function youtubePrepMarkup(job) {
  const pack = shortUploadPack(job);
  const links = pack.links.map((item) => `<a href="${escapeHtml(item.href)}" download>${escapeHtml(item.label)}</a>`).join("");
  return `<section class="upload-pack"><h3>업로드 준비</h3><p class="inspect-hint">유튜브에 아직 올리지 않아요</p><p class="pack-title">${escapeHtml(pack.title || job.topic || "")}</p><textarea readonly rows="4">${escapeHtml(pack.description)}</textarea>${links}</section>`;
}

async function saveInspectDraft(jobId, root) {
  const body = collectInspectPayload(root);
  const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (payload.job) upsertJob(payload.job);
  return payload;
}

function openHome(event) {
  event?.preventDefault();
  closeMenu();
  setView("grid");
  renderJobs();
  sizeShortsGrid();
  const afterPaint = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
  afterPaint(() => sizeShortsGrid());
}

function renderShortCard(job) {
  const status = shortStatus(job);
  const thumb = bust(shortThumbnail(job), job.updatedAt);
  const duration = status.key === "draft" ? "—" : formatClock(shortDurationSeconds(job));
  const highlight = job.id === state.highlightJobId ? " just-created" : "";
  const progress = Number(job.progress || 0);
  const fallback = escapeHtml(status.label);
  const media = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="" />`
    : `<div class="thumb-fallback" aria-hidden="true"><span>${fallback}</span></div>`;
  const generating = status.key === "running"
    ? `<div class="thumb-progress" aria-hidden="true"><i style="width:${progress}%"></i></div>`
    : "";
  return `<article class="short-card status-${status.key}${highlight}" data-job-id="${escapeHtml(job.id)}"><button type="button" class="short-card-open" data-job-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.topic || "쇼츠")}" aria-pressed="${job.id === state.selectedJobId && state.view === "watch"}"><div class="short-card-thumb"><div class="thumb-stage">${media}${generating}</div><span class="short-status ${status.key}"><i></i>${escapeHtml(status.label)}</span><span class="short-duration">${escapeHtml(duration)}</span></div></button><button type="button" class="short-card-detail" data-job-id="${escapeHtml(job.id)}">재료</button></article>`;
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

function canDeleteJob(job) {
  return job && ["draft", "failed", "queued"].includes(job.status);
}

async function deleteJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!canDeleteJob(job)) return;
  if (!window.confirm(`삭제할까요? ${job.topic || "쇼츠"}`)) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    state.jobs = state.jobs.filter((item) => item.id !== jobId);
    if (state.selectedJobId === jobId) {
      state.selectedJobId = null;
      setView("grid");
    }
    renderJobs();
    showToast("삭제했습니다.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function bindShortCard(card) {
  const jobId = card.dataset.jobId;
  card.querySelector(".short-card-open")?.addEventListener("click", () => openJob(jobId));
  card.querySelector(".short-card-detail")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetail(jobId);
  });
  let hold = 0;
  const startHold = () => {
    hold = window.setTimeout(() => deleteJob(jobId), 520);
  };
  const cancelHold = () => window.clearTimeout(hold);
  card.addEventListener("pointerdown", startHold);
  card.addEventListener("pointerup", cancelHold);
  card.addEventListener("pointerleave", cancelHold);
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void deleteJob(jobId);
  });
}

function patchGridCard(job) {
  if (!job?.id) return;
  const grid = $("#shorts-grid");
  if (!grid) return;
  const cards = [...grid.querySelectorAll(`.short-card[data-job-id="${CSS.escape(job.id)}"]`)];
  if (!cards.length) {
    renderJobs();
    return;
  }
  cards.forEach((card) => {
    const next = document.createElement("template");
    next.innerHTML = renderShortCard(job);
    const fresh = next.content.firstElementChild;
    card.replaceWith(fresh);
    bindShortCard(fresh);
  });
}

function renderJobs() {
  const grid = $("#shorts-grid");
  if (grid && state.jobsLoaded) {
    grid.innerHTML = `${createTileMarkup()}${jobCardsMarkup()}<div class="feed-sentinel"></div>`;
    $("#create-tile")?.addEventListener("click", openCreate);
    $$(".short-card[data-job-id]").forEach(bindShortCard);
    bindFeedScroll();
    sizeShortsGrid();
  }
  renderStudioChrome();
  if (state.view === "watch") {
    renderWatchFeed();
    return;
  }
  syncDocumentTitle();
}

function defaultFactoryStages() {
  return [
    ["plan", "기획/슬롯"],
    ["hook-lock", "훅 스틸 잠금"],
    ["image-edit", "샷별 image_edit"],
    ["still-qa", "스틸 QA"],
    ["animate", "10초 영상"],
    ["clip-qa", "클립 QA"],
    ["tts-mix", "TTS/믹스"],
    ["captions", "대화 자막"],
    ["compose", "합성"],
    ["parts", "채팅 파트"]
  ].map(([id, label]) => ({ id, label, status: "WAIT", message: "" }));
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
  state.live[jobId] = live;
  const job = upsertJob({
    id: jobId,
    live: { stageId: event.stageId, status: event.status, message: event.message, prompt: event.prompt || event.animatePrompt || null, frozen: Boolean(event.frozen), shotIndex: event.shotIndex },
    message: event.message,
    artifacts: [...(state.jobs.find((item) => item.id === jobId)?.artifacts || []), ...(event.artifacts || [])]
  });
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

function renderShotPromptList(shots = []) {
  if (!shots.length) return "";
  return `<div class="shot-prompt-list">${shots.map((shot) => `<article class="shot-prompt"><b>${String(shot.index).padStart(2, "0")} · ${escapeHtml(shot.slotId || shot.role || "샷")}</b><pre>${escapeHtml(shot.prompt || "")}</pre></article>`).join("")}</div>`;
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
    if (preview) preview.innerHTML = "";
    return;
  }
  try {
    state.createPreview = await api("/api/grok-imagine/template/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: topic.trim() || "빈 현장의 숨은 원리",
        facts,
        worldSlots,
        scriptDraft: $("#script-draft")?.value.trim() || ""
      })
    });
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = `${renderWorldSlotFields(state.createPreview.worldSlots)}<h4 class="prompt-subhead">채워진 샷</h4>${renderShotPromptList(state.createPreview.shots)}`;
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

async function runSelectedJob() {
  if (!state.selectedJobId) return;
  if (state.health?.imagine?.frozen !== false) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/run`, { method: "POST" });
    showToast("만들기를 시작했습니다.");
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function pollJobs() {
  try {
    await refreshJobs();
  } catch (error) {
    showToast(`작업 상태 갱신 실패: ${error.message}`, "error");
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
  state.jobs = [...payload.jobs].sort((left, right) => {
    const leftIndex = Number(left.libraryIndex);
    const rightIndex = Number(right.libraryIndex);
    if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) return leftIndex - rightIndex;
    if (Number.isFinite(leftIndex)) return 1;
    if (Number.isFinite(rightIndex)) return -1;
    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  }).map((job) => {
    if (job.id === selectedId && selectedLive?.live && ["queued", "running", "verifying"].includes(job.status)) {
      return { ...job, live: job.live || selectedLive.live, artifacts: job.artifacts?.length ? job.artifacts : selectedLive.artifacts };
    }
    return job;
  });
  const structural = previousIds !== nextIds || !state.jobsLoaded || !document.querySelector("#create-tile");
  state.jobsLoaded = true;
  if (structural) renderJobs();
  else {
    state.jobs.forEach(patchGridCard);
    if (state.view === "watch") renderWatchFeed();
    syncDocumentTitle();
  }
  syncPollTimer();
}

async function createProduction(event) {
  event.preventDefault();
  const provider = $("#provider").value;
  const sources = $("#sources").value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ title: url, url }));
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const worldSlots = collectWorldSlots();
  const scriptDraft = $("#script-draft")?.value.trim() || "";
  const ttsProvider = $("#create-tts-provider")?.value || "edge";
  const ttsVoice = $("#create-tts-voice")?.value || "";
  const body = { topic: $("#topic").value, format: $("#format").value, clipCount: Number($("#clip-count").value), provider, sources, facts, worldSlots, scriptDraft, ttsProvider, ttsVoice, captions: $("#captions").checked, voiceover: provider === "grok-imagine" ? false : $("#voiceover").checked, draftOnly: true };
  if (ttsVoice) {
    void api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttsProvider, ttsVoice })
    }).then((payload) => {
      if (payload?.settings) {
        state.settings = payload.settings;
        applySettingsToForm(payload.settings);
      }
    }).catch(() => {});
  }
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "저장 중…";
  try {
    const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.selectedJobId = payload.job.id;
    state.highlightJobId = payload.job.id;
    upsertJob(payload.job);
    window.setTimeout(() => {
      if (state.highlightJobId === payload.job.id) state.highlightJobId = null;
      document.querySelector(`[data-job-id="${CSS.escape(payload.job.id)}"]`)?.classList.remove("just-created");
    }, 4200);
    location.assign(materialsUrl(payload.job.id));
    return;
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.querySelector("span").textContent = "초안 저장"; }
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
      ? "Grok Imagine으로 그림과 움직임을 만듭니다."
      : provider === "local-video"
        ? "로컬 영상 모델은 설정된 생성기 명령이 필요합니다."
        : "업로드한 로컬 클립만 편집합니다.";
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

function syncCreateMode() {
  const batch = state.createMode === "batch";
  const title = $("#create-title");
  if (title) title.textContent = batch ? "양산" : "새 쇼츠";
  const topicField = $("#single-topic-field");
  const topic = $("#topic");
  const batchField = $("#batch-field");
  const submit = $("#create-submit");
  const actions = $("#batch-actions");
  const queue = $("#batch-queue");
  if (topicField) topicField.hidden = batch;
  if (batchField) batchField.hidden = !batch;
  if (submit) submit.hidden = batch;
  if (actions) actions.hidden = !batch;
  if (topic) topic.required = !batch;
  const frozen = state.health?.imagine?.frozen !== false;
  if (queue) queue.disabled = frozen;
}

function openCreate(event) {
  event?.preventDefault();
  rememberOpener(event);
  state.createMode = "single";
  setView("create");
  void hydrateCreateSlots();
}

function openBatch(event) {
  event?.preventDefault();
  rememberOpener(event);
  closeMenu();
  state.createMode = "batch";
  setView("create");
  void hydrateCreateSlots();
}

function parseBatchTopics() {
  return ($("#batch-topics")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 4);
}

function batchJobBody(topic) {
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  return { topic, facts, provider: "grok-imagine", draftOnly: true, captions: true, voiceover: false };
}

async function saveBatchDrafts() {
  const topics = parseBatchTopics();
  if (!topics.length) {
    showToast("주제를 한 줄에 하나씩 4자 이상 입력하세요.", "error");
    return;
  }
  try {
    for (const topic of topics) {
      const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batchJobBody(topic)) });
      if (payload.job) upsertJob(payload.job);
    }
    await refreshJobs();
    showToast(`초안 ${topics.length}개를 저장했습니다.`);
    closeOverlays();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function queueBatchJobs() {
  if (state.health?.imagine?.frozen !== false) return;
  const topics = parseBatchTopics();
  if (!topics.length) {
    showToast("주제를 한 줄에 하나씩 4자 이상 입력하세요.", "error");
    return;
  }
  try {
    for (const topic of topics) {
      const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batchJobBody(topic)) });
      const jobId = payload.job?.id;
      if (jobId) {
        upsertJob(payload.job);
        await api(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: "POST" });
      }
    }
    await refreshJobs();
    showToast(`대기열에 ${topics.length}개를 넣었습니다.`);
    closeOverlays();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openTemplate(event) {
  event?.preventDefault();
  closeMenu();
  stopWatchFeed($("#watch-feed"));
  location.assign("/template");
}

function openSettings(event) {
  event?.preventDefault();
  rememberOpener(event);
  closeMenu();
  if (state.view === "watch") state.returnToWatch = true;
  setView("settings");
}

function openMachine(event) {
  event?.preventDefault();
  rememberOpener(event);
  closeMenu();
  setView("machine");
}

function renderChips(health = {}) {
  return renderStudioPipe(health);
}

function renderMachineSheet() {
  const root = $("#machine-root");
  if (!root) return;
  root.innerHTML = machineSheetHtml(state.health || {});
}

function renderStudioChrome() {
  const health = state.health || {};
  const grok = Boolean(health.capabilities?.grokCli);
  const ffmpeg = Boolean(health.capabilities?.ffmpeg);
  const frozen = health.imagine?.frozen !== false;
  const chips = $("#studio-chips");
  if (chips) {
    paintStudioPipe(document, health, openMachine);
  }
  const banner = $("#feed-banner");
  if (banner) {
    const reasons = [];
    if (!state.jobs.length) reasons.push("쇼츠가 없습니다");
    if (!ffmpeg) reasons.push("편집을 할 수 없습니다");
    if (!grok) reasons.push("대본을 쓸 수 없습니다");
    if (frozen) reasons.push("지금은 그림을 안 만들어요");
    banner.hidden = reasons.length === 0;
    banner.textContent = reasons.join(" · ");
  }
}

function applySettingsToForm(settings) {
  const chirp = Boolean(settings?.chirpAvailable);
  ["settings-chirp-option", "create-chirp-option"].forEach((id) => {
    const option = document.getElementById(id);
    if (option) option.hidden = !chirp;
  });
  const provider = settings?.ttsProvider === "chirp" && chirp ? "chirp" : "edge";
  if ($("#settings-tts-provider")) $("#settings-tts-provider").value = provider;
  if ($("#create-tts-provider")) $("#create-tts-provider").value = provider;
  if (settings?.ttsVoice) {
    if ($("#settings-tts-voice")) $("#settings-tts-voice").value = settings.ttsVoice;
    if ($("#create-tts-voice")) $("#create-tts-voice").value = settings.ttsVoice;
  }
  if ($("#settings-bgm-enabled")) $("#settings-bgm-enabled").checked = settings?.bgmEnabled === true;
  if ($("#settings-bgm-volume")) $("#settings-bgm-volume").value = String(settings?.bgmVolume ?? 0.08);
  if ($("#settings-ffmpeg")) $("#settings-ffmpeg").value = settings?.ffmpegPath || "";
  syncToggleLabels();
}

async function hydrateStudioSettings() {
  try {
    const payload = await api("/api/settings");
    state.settings = payload.settings;
    applySettingsToForm(payload.settings);
    const songs = $("#settings-bgm-songs");
    if (songs) {
      const count = Array.isArray(payload.songs) ? payload.songs.length : 0;
      songs.textContent = count ? `곡 ${count}개` : "곡 없음";
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveSettings(event) {
  event?.preventDefault();
  try {
    const payload = await api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ttsProvider: $("#settings-tts-provider")?.value,
        ttsVoice: $("#settings-tts-voice")?.value,
        bgmEnabled: $("#settings-bgm-enabled")?.checked === true,
        bgmVolume: Number($("#settings-bgm-volume")?.value || 0),
        ffmpegPath: $("#settings-ffmpeg")?.value || ""
      })
    });
    state.settings = payload.settings;
    applySettingsToForm(payload.settings);
    showToast("설정을 저장했습니다.");
    closeOverlays();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function previewVoice(buttonId, audioId, providerId, voiceId) {
  const button = $(buttonId);
  if (button) button.disabled = true;
  try {
    const text = $("#script-draft")?.value.trim() || $("#topic")?.value.trim() || "이렇게 설계된 겁니다.";
    const response = await fetch("/api/tts/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        provider: $(providerId)?.value || "edge",
        voice: $(voiceId)?.value
      })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "미리 듣기에 실패했습니다.");
    }
    const blob = await response.blob();
    const audio = $(audioId);
    if (audio) {
      audio.src = URL.createObjectURL(blob);
      audio.hidden = false;
      await audio.play().catch(() => {});
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function applyDraftWorldSlots(worldSlots = {}) {
  if (!worldSlots || typeof worldSlots !== "object") return;
  for (const [id, value] of Object.entries(worldSlots)) {
    if (id === "sourced_si" || id === "avoid") continue;
    const input = document.querySelector(`#create-world-slots [data-world-slot="${CSS.escape(id)}"]`);
    if (input && "value" in input) input.value = String(value || "");
  }
}

function renderScriptSegmentPreview(segments = []) {
  const list = $("#script-segment-preview");
  if (!list) return;
  if (!Array.isArray(segments) || !segments.length) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  list.hidden = false;
  list.innerHTML = segments.map((segment, offset) => {
    const index = Number.isInteger(segment.index) ? segment.index : offset + 1;
    const kind = segment.type || segment.role || "";
    const meta = [kind, segment.tool || "", segment.label || ""].filter(Boolean).join(" · ");
    const line = segment.narration || segment.caption || "";
    return `<li><b>${index}</b><div>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}<p>${escapeHtml(line)}</p></div></li>`;
  }).join("");
}

async function draftScriptFromTopic() {
  const button = $("#draft-script");
  const errorBox = $("#script-draft-error");
  const area = $("#script-draft");
  const label = $("#script-draft-label");
  if (button) button.disabled = true;
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  try {
    const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
    const payload = await api("/api/script/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: $("#topic")?.value, facts })
    });
    if (area) {
      area.hidden = false;
      area.value = payload.draft;
    }
    if (label) label.hidden = false;
    applyDraftWorldSlots(payload.worldSlots);
    renderScriptSegmentPreview(payload.segments || payload.script?.segments);
    await refreshCreatePreview().catch(() => {});
    showToast("대본 초안을 넣었습니다.");
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message;
    }
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function resetMenuCard() {
  const title = $("#menu-title");
  if (title) title.textContent = "메뉴";
  const actions = $("#menu-actions");
  const result = $("#menu-import-result");
  if (actions) actions.hidden = false;
  if (result) result.hidden = true;
}

function closeMenu(event) {
  event?.preventDefault?.();
  const overlay = $("#menu-overlay");
  if (!overlay || overlay.hidden) return false;
  overlay.hidden = true;
  resetMenuCard();
  if (!["create", "settings", "machine"].includes(state.view)) {
    document.body.classList.remove("overlay-open");
    restoreOpener();
  }
  return true;
}

function openMenu(event) {
  event?.preventDefault?.();
  const overlay = $("#menu-overlay");
  if (!overlay) return;
  if (!overlay.hidden) {
    closeMenu(event);
    return;
  }
  rememberOpener(event);
  resetMenuCard();
  overlay.hidden = false;
  document.body.classList.add("overlay-open");
  trapOverlay("#menu-overlay");
}

function showImportResult(payload) {
  const overlay = $("#menu-overlay");
  if (overlay) overlay.hidden = false;
  document.body.classList.add("overlay-open");
  const title = $("#menu-title");
  if (title) title.textContent = "가져오기";
  const actions = $("#menu-actions");
  const result = $("#menu-import-result");
  const summary = $("#menu-import-summary");
  const imported = payload.imported?.length || 0;
  const seeded = payload.seeded?.length || 0;
  const roots = payload.roots?.length || 0;
  if (summary) summary.textContent = `가져옴 ${imported} · 시드 ${seeded} · 경로 ${roots}`;
  if (actions) actions.hidden = true;
  if (result) result.hidden = false;
  trapOverlay("#menu-overlay");
}

async function importLibrary(event) {
  event?.preventDefault();
  try {
    const payload = await api("/api/library/import", { method: "POST" });
    await refreshJobs();
    showImportResult(payload);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function closeOverlays(event) {
  event?.preventDefault();
  if (closeMenu()) return;
  if (state.returnToWatch) {
    state.returnToWatch = false;
    setView("watch", { instant: true });
    restoreOpener();
    return;
  }
  setView("grid");
  renderJobs();
  restoreOpener();
}

async function refreshQuietly() {
  closeMenu();
  try {
    await refreshJobs();
    showToast("목록을 갱신했습니다.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function bindEvents() {
  window.addEventListener("resize", sizeShortsGrid);
  window.addEventListener("orientationchange", () => {
    if (state.view !== "watch") return;
    const root = $("#watch-feed");
    sizeWatchFeed(root);
    applyWatchTransform(root, { animate: false });
    wrapWatchFeed(root);
    notifyActive();
    playWatchFeed(root);
  });
  $("#create-form").addEventListener("submit", createProduction);
  $("#provider")?.addEventListener("change", syncProviderForm);
  syncProviderForm();
  $("#create-tile")?.addEventListener("click", openCreate);
  $("#menu-create")?.addEventListener("click", (event) => {
    closeMenu();
    if (state.view === "watch") state.returnToWatch = true;
    openCreate(event);
  });
  $("#menu-batch")?.addEventListener("click", openBatch);
  $("#batch-draft")?.addEventListener("click", () => { void saveBatchDrafts(); });
  $("#batch-queue")?.addEventListener("click", () => { void queueBatchJobs(); });
  $("#library-more")?.addEventListener("click", openMenu);
  $("#close-menu")?.addEventListener("click", closeMenu);
  $("#menu-import-ok")?.addEventListener("click", closeMenu);
  $$("[data-close-menu]").forEach((node) => node.addEventListener("click", closeMenu));
  $("#home-brand")?.addEventListener("click", openHome);
  bindWatchFeed($("#watch-feed"), openHome);
  $("#open-settings")?.addEventListener("click", openSettings);
  $("#import-library")?.addEventListener("click", importLibrary);
  $("#close-create")?.addEventListener("click", closeOverlays);
  $("#close-settings")?.addEventListener("click", closeOverlays);
  $("#close-machine")?.addEventListener("click", closeOverlays);
  $("#settings-form")?.addEventListener("submit", saveSettings);
  $("#draft-script")?.addEventListener("click", () => { void draftScriptFromTopic(); });
  $("#preview-voice")?.addEventListener("click", () => { void previewVoice("#preview-voice", "#voice-preview-audio", "#create-tts-provider", "#create-tts-voice"); });
  $("#settings-preview-voice")?.addEventListener("click", () => { void previewVoice("#settings-preview-voice", "#settings-preview-audio", "#settings-tts-provider", "#settings-tts-voice"); });
  $("#settings-bgm-enabled")?.addEventListener("change", syncToggleLabels);
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
    if (event.key === "Escape") {
      if (closeMenu()) return;
      if (state.view === "watch") {
        stopWatchFeed($("#watch-feed"));
        openHome();
        return;
      }
      if (state.view !== "grid") closeOverlays();
      return;
    }
    if (state.view !== "watch") return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    const feed = $("#watch-feed");
    if (event.key === "ArrowDown" || event.key === "j" || event.key === "PageDown") {
      event.preventDefault();
      stepWatchFeed(feed, 1, { animate: true });
    }
    if (event.key === "ArrowUp" || event.key === "k" || event.key === "PageUp") {
      event.preventDefault();
      stepWatchFeed(feed, -1, { animate: true });
    }
    if (event.key === " ") {
      event.preventDefault();
      const video = feed?.querySelector(".watch-player video") || feed?.querySelector("video");
      if (!video) return;
      if (video.paused) {
        const play = document.body.classList.contains("watch-open") ? playWatchFeed(feed) : null;
        if (play && typeof play.catch === "function") play.catch(() => {});
        else if (!play) stopWatchFeed(feed);
      } else {
        video.pause();
      }
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopWatchFeed($("#watch-feed"));
    }
  });
  window.addEventListener("pagehide", () => {
    stopWatchFeed($("#watch-feed"));
  });
  $("#refresh-all")?.addEventListener("click", () => { void refreshQuietly(); });
  $$(".toggle-label input").forEach((input) => input.addEventListener("change", syncToggleLabels));
  syncToggleLabels();
}

async function warnIfFactoryToolsMissing() {
  try {
    state.health = await api("/api/health");
    renderStudioChrome();
  } catch {
    renderStudioChrome();
  }
}

async function init() {
  bindEvents();
  applyHash();
  try {
    await refreshJobs();
    applyHash();
    void warnIfFactoryToolsMissing();
  } catch (error) {
    state.jobsLoaded = true;
    renderJobs();
    showToast(error.message, "error");
  }
}

init();
