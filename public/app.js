import { formatClock, inspectVideoDownloads, isWatchableShort, shortDownloads, shortDurationSeconds, shortPreview, shortStatus, shortThumbnail, shortUploadPack } from "./shorts-ui.mjs";
import { applyWatchTransform, bindWatchFeed, clearWatchSize, createWatchPlayer, currentWatchSlide, goWatchIndex, playWatchFeed, settleWatchIndex, sizeWatchFeed, stepWatchFeed, stopWatchFeed, syncWatchFeed, wrapWatchFeed } from "./watch-feed.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const APP_TITLE = "PS4_JUSTDOIT";
const VIEWS = ["create", "detail", "template", "settings", "machine", "watch", "grid"];
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
  focusOpener: null
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
  if (view === "template") return "#template";
  if (view === "settings") return "#settings";
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
  const shortOverlay = $("#short-overlay");
  const templateOverlay = $("#template-overlay");
  const settingsOverlay = $("#settings-overlay");
  const watchFeed = $("#watch-feed");
  const library = $("#shorts");
  if (next !== "watch") clearWatchSize(watchFeed);
  state.view = next;
  if (state.view !== "watch") closeOpenWatchInspect();
  document.body.classList.toggle("watch-open", state.view === "watch");
  document.body.classList.toggle("overlay-open", ["create", "detail", "template", "settings", "machine"].includes(state.view));
  if (createOverlay) createOverlay.hidden = state.view !== "create";
  if (shortOverlay) shortOverlay.hidden = state.view !== "detail";
  if (templateOverlay) templateOverlay.hidden = state.view !== "template";
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
  if (state.view === "detail") trapOverlay("#short-overlay");
  if (state.view === "template") trapOverlay("#template-overlay");
  if (state.view === "settings") trapOverlay("#settings-overlay");
  if (state.view === "machine") trapOverlay("#machine-overlay");
  if (state.view === "template") void loadTemplateSurface();
  if (state.view === "settings") void hydrateStudioSettings();
  if (state.view === "machine") renderMachineSheet();
  syncDocumentTitle();
}

function syncDocumentTitle() {
  if (state.view === "template") {
    document.title = `템플릿 · ${APP_TITLE}`;
    return;
  }
  if (state.view === "watch" || state.view === "detail") {
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
    setView("template", { skipHash: true });
    return;
  }
  if (hash === "settings") {
    setView("settings", { skipHash: true });
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
  if (hash === "short") {
    if (state.selectedJobId && state.jobs.some((job) => job.id === state.selectedJobId)) {
      setView("detail", { skipHash: true });
      return;
    }
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

function closeWatchInspect() {
  const feed = $("#watch-feed");
  if (!feed?.classList.contains("inspect-open")) return false;
  feed.classList.remove("inspect-open");
  return true;
}

function closeOpenWatchInspect() {
  return closeWatchInspect();
}

function toggleWatchInspect() {
  $("#watch-feed")?.classList.toggle("inspect-open");
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
    if (closeOpenWatchInspect()) return;
    stopWatchFeed(feed);
    openHome(event);
  });
  feed.querySelector(".watch-menu")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWatchInspect();
  });
  feed.querySelector(".watch-inspect-dismiss")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeWatchInspect();
  });
  feed.addEventListener("click", (event) => {
    if (!event.target?.closest?.(".watch-inspect-close")) return;
    event.preventDefault();
    event.stopPropagation();
    closeWatchInspect();
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
  void hydrateWatchInspect(id);
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
  void hydrateWatchInspect(job.id);
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

function openJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  state.selectedJobId = jobId;
  if (job && isWatchableShort(job)) setView("watch", { instant: true });
  else setView("detail");
  renderJobs();
}

function openDetail(jobId) {
  state.selectedJobId = jobId;
  if (state.view === "watch") state.returnToWatch = true;
  rememberOpener();
  setView("detail");
  renderJobs();
}

const INSPECT_WORLD_SLOT_IDS = ["site", "weather", "everyday_thing", "hidden_thing", "materials", "wear", "trace", "palette"];

function collectInspectPayload(root) {
  const shots = {};
  root?.querySelectorAll(".inspect-shot[data-shot-index]").forEach((node) => {
    const index = Number(node.dataset.shotIndex);
    if (!Number.isInteger(index)) return;
    shots[index] = {
      index,
      prompt: node.querySelector("[data-shot-prompt], .inspect-shot-prompt")?.value || "",
      animatePrompt: node.querySelector("[data-shot-animate], .inspect-shot-animate")?.value || "",
      caption: node.querySelector("[data-shot-caption], .inspect-shot-caption")?.value || ""
    };
  });
  root?.querySelectorAll(".inspect-caption [data-shot-caption], .inspect-caption .inspect-shot-caption").forEach((input) => {
    const index = Number(input.dataset.shotIndex || input.closest("[data-shot-index]")?.dataset.shotIndex);
    if (!Number.isInteger(index)) return;
    shots[index] = {
      index,
      prompt: shots[index]?.prompt || "",
      animatePrompt: shots[index]?.animatePrompt || "",
      caption: input.value || ""
    };
  });
  return {
    topic: root.querySelector("[data-draft-topic], .inspect-topic")?.value || "",
    facts: (root.querySelector("[data-draft-facts], .inspect-facts")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    scriptDraft: root.querySelector("[data-draft-script], .inspect-script")?.value || "",
    worldSlots: Object.fromEntries([...root.querySelectorAll("[data-world-slot]")].map((input) => [input.dataset.worldSlot, input.value]).filter(([, value]) => String(value || "").trim())),
    shotOverrides: shots
  };
}

function collectDraftFields(root) {
  return collectInspectPayload(root);
}

function inspectSlotValue(slots, id, job) {
  const fromPrompt = (slots || []).find((slot) => slot.id === id)?.value;
  if (fromPrompt != null && String(fromPrompt).trim()) return fromPrompt;
  return job?.worldSlots?.[id] || "";
}

function hiddenInspectFields(job, prompts) {
  const facts = Array.isArray(job.facts) ? job.facts.join("\n") : "";
  const slots = INSPECT_WORLD_SLOT_IDS.map((id) => `<textarea hidden class="inspect-slot" data-world-slot="${escapeHtml(id)}">${escapeHtml(inspectSlotValue(prompts?.worldSlots, id, job))}</textarea>`).join("");
  const shots = (prompts?.shots || []).map((shot, offset) => {
    const index = Number(shot.index || offset + 1);
    return `<article hidden class="inspect-shot" data-shot-index="${index}"><textarea class="inspect-shot-prompt" data-shot-prompt>${escapeHtml(shot.prompt || "")}</textarea><textarea class="inspect-shot-animate" data-shot-animate>${escapeHtml(shot.animatePrompt || "")}</textarea></article>`;
  }).join("");
  return `<textarea hidden class="inspect-facts" data-draft-facts>${escapeHtml(facts)}</textarea>${slots}${shots}`;
}

function renderInspectCaptions(shots = []) {
  return shots.map((shot, offset) => {
    const index = Number(shot.index || offset + 1);
    return `<div class="inspect-caption" data-shot-index="${index}"><b>${index}</b><textarea class="inspect-shot-caption" data-shot-caption data-shot-index="${index}" rows="2">${escapeHtml(shot.caption || "")}</textarea></div>`;
  }).join("");
}

function youtubePrepMarkup(job) {
  const pack = shortUploadPack(job);
  const links = pack.links.map((item) => `<a href="${escapeHtml(item.href)}" download>${escapeHtml(item.label)}</a>`).join("");
  return `<section class="upload-pack"><h3>업로드 준비</h3><p class="inspect-hint">유튜브에 아직 올리지 않아요</p><p class="pack-title">${escapeHtml(pack.title || job.topic || "")}</p><textarea readonly rows="4">${escapeHtml(pack.description)}</textarea>${links}</section>`;
}

function renderWatchInspectPanel(job, prompts) {
  const frozen = state.health?.imagine?.frozen !== false;
  const shots = prompts?.shots || [];
  const files = inspectVideoDownloads(job).map((item) => `<a href="${escapeHtml(item.href)}" download>${escapeHtml(item.label)}</a>`).join("");
  return `<div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2><button type="button" class="watch-inspect-close" aria-label="닫기">×</button></div><label class="field-label" for="inspect-topic-${escapeHtml(job.id)}">제목</label><input id="inspect-topic-${escapeHtml(job.id)}" class="inspect-topic" data-draft-topic value="${escapeHtml(job.topic || "")}" minlength="4" /><label class="field-label">대본</label><textarea class="inspect-script" data-draft-script rows="4">${escapeHtml(job.scriptDraft || "")}</textarea><label class="field-label">자막</label>${renderInspectCaptions(shots)}${hiddenInspectFields(job, prompts)}${files ? `<div class="inspect-files">${files}</div>` : ""}<div class="inspect-actions"><button type="button" class="primary-button inspect-save" data-inspect-save>저장</button><button type="button" class="secondary-button inspect-regen" data-inspect-regen${frozen ? " disabled" : ""}>다시 만들기</button>${frozen ? `<p class="inspect-frozen">지금은 다시 못 만들어요</p>` : ""}</div></div>`;
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

function bindInspectActions(root, jobId) {
  root.querySelector(".inspect-save, [data-inspect-save]")?.addEventListener("click", async () => {
    try {
      await saveInspectDraft(jobId, root);
      showToast("초안을 저장했습니다.");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  root.querySelector(".inspect-regen, [data-inspect-regen]")?.addEventListener("click", async () => {
    if (state.health?.imagine?.frozen !== false) {
      showToast("크레딧 402", "error");
      return;
    }
    try {
      await saveInspectDraft(jobId, root);
      await api(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: "POST" });
      showToast("대기열에 넣었습니다.");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

async function hydrateWatchInspect(jobId) {
  const panel = $("#watch-inspect");
  if (!panel || panel.dataset.ready === jobId) return;
  panel.dataset.jobId = jobId;
  let job = state.jobs.find((item) => item.id === jobId) || null;
  let prompts = null;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    upsertJob(job);
  } catch {
    // Keep the library copy if the detail request fails.
  }
  try {
    prompts = await api(`/api/jobs/${encodeURIComponent(jobId)}/prompts`);
  } catch {
    prompts = null;
  }
  if (!job) return;
  panel.innerHTML = renderWatchInspectPanel(job, prompts);
  panel.dataset.ready = jobId;
  bindInspectActions(panel, jobId);
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
  const selected = job.id === state.selectedJobId && state.view === "detail" ? " selected" : "";
  const progress = Number(job.progress || 0);
  const fallback = escapeHtml(status.label);
  const media = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="" />`
    : `<div class="thumb-fallback" aria-hidden="true"><span>${fallback}</span></div>`;
  const generating = status.key === "running"
    ? `<div class="thumb-progress" aria-hidden="true"><i style="width:${progress}%"></i></div>`
    : "";
  return `<article class="short-card status-${status.key}${highlight}${selected}" data-job-id="${escapeHtml(job.id)}"><button type="button" class="short-card-open" data-job-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.topic || "쇼츠")}" aria-pressed="${job.id === state.selectedJobId && (state.view === "detail" || state.view === "watch")}"><div class="short-card-thumb"><div class="thumb-stage">${media}${generating}</div><span class="short-status ${status.key}"><i></i>${escapeHtml(status.label)}</span><span class="short-duration">${escapeHtml(duration)}</span></div></button><button type="button" class="short-card-detail" data-job-id="${escapeHtml(job.id)}">상세</button></article>`;
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

function currentStageText(job = {}) {
  if (Number(job.queuePosition) > 0) return job.message || `대기 ${job.queuePosition}`;
  return job.live?.message || job.stage || job.message || shortStatus(job).label;
}

function currentStillUrl(job = {}) {
  const live = state.live[job.id] || {};
  const shot = [...(live.shots || [])].reverse().find((item) => item.stillUrl || item.clipUrl);
  return bust(shot?.stillUrl || shortThumbnail(job), job.updatedAt);
}

function patchDetailProgress(job) {
  if (!job || state.selectedJobId !== job.id || state.view !== "detail") return;
  const message = document.querySelector("#job-detail .detail-progress span, #live-factory .live-now");
  const percent = document.querySelector("#job-detail .detail-progress b");
  const bar = document.querySelector("#job-detail .progress-track i");
  const stage = currentStageText(job);
  if (message) message.textContent = stage;
  if (percent) percent.textContent = `${job.progress || 0}%`;
  if (bar) bar.style.width = `${job.progress || 0}%`;
  const still = document.querySelector("#job-detail .preview-still, #live-factory .live-still");
  const next = currentStillUrl(job);
  if (still && next) still.src = next;
  else if (!still && next && !document.querySelector("#job-detail video")) {
    const wrap = document.querySelector("#job-detail .preview-wrap, #live-factory .live-still-wrap");
    if (wrap) {
      const img = document.createElement("img");
      img.className = wrap.classList.contains("live-still-wrap") ? "live-still" : "preview-still";
      img.alt = "";
      img.src = next;
      wrap.prepend(img);
    }
  }
}

function renderJobs() {
  const grid = $("#shorts-grid");
  if (grid) {
    grid.innerHTML = `${createTileMarkup()}${jobCardsMarkup()}<div class="feed-sentinel"></div>`;
    $("#create-tile")?.addEventListener("click", openCreate);
    $$(".short-card[data-job-id]").forEach(bindShortCard);
    bindFeedScroll();
    sizeShortsGrid();
    renderStudioChrome();
  }
  if (state.view === "watch") {
    renderWatchFeed();
    return;
  }
  if (state.view === "detail") {
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (!selected) {
      state.selectedJobId = null;
      setView("grid");
      renderLiveFactory(null);
      return;
    }
    renderJobDetail(selected);
    renderLiveFactory(selected);
    watchJobLive(selected);
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

function renderLiveFactory(job) {
  const root = $("#live-factory");
  if (!root) return;
  const running = job && ["queued", "running", "verifying"].includes(job.status);
  if (!job || job.provider !== "grok-imagine" || !running) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  const still = currentStillUrl(job);
  const timeline = state.live[job.id]?.timeline?.length ? state.live[job.id].timeline : defaultFactoryStages();
  const stages = `<ol class="live-stages">${timeline.map((stage) => `<li class="live-stage status-${escapeHtml(String(stage.status || "WAIT").toLowerCase())}"><b>${escapeHtml(stage.label || stage.id)}</b><span>${escapeHtml(stage.message || stage.status || "")}</span></li>`).join("")}</ol>`;
  root.innerHTML = `<p class="live-now">${escapeHtml(currentStageText(job))}</p>${still ? `<div class="live-still-wrap"><img class="live-still" src="${escapeHtml(still)}" alt="" /></div>` : ""}${stages}`;
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
  if (state.view === "detail" && selected && ["completed", "failed"].includes(selected.status)) {
    renderJobDetail(selected);
    renderLiveFactory(selected);
  } else {
    renderLiveFactory(selected);
    patchDetailProgress(selected);
  }
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

function renderWorldSlotFields(slots = [], { namePrefix = "world-slot", editable = false } = {}) {
  return slots.map((slot) => {
    const canEdit = editable && slot.editable !== false && !slot.locked;
    const value = slot.value || "";
    const field = canEdit
      ? `<textarea id="${escapeHtml(namePrefix)}-${escapeHtml(slot.id)}" name="${escapeHtml(slot.id)}" data-world-slot="${escapeHtml(slot.id)}" rows="2">${escapeHtml(value)}</textarea>`
      : `<p class="slot-value">${escapeHtml(value || slot.placeholder || `{{${slot.id}}}`)}</p>`;
    return `<label class="slot-card ${canEdit ? "editable" : "locked"}"><span><b>${escapeHtml(slot.label)}</b></span><small>${escapeHtml(slot.hint || "")}</small>${field}</label>`;
  }).join("");
}

function renderShotPromptList(shots = []) {
  if (!shots.length) return "";
  return `<div class="shot-prompt-list">${shots.map((shot) => `<article class="shot-prompt"><b>${String(shot.index).padStart(2, "0")} · ${escapeHtml(shot.slotId || shot.role || "샷")}</b><pre>${escapeHtml(shot.prompt || "")}</pre></article>`).join("")}</div>`;
}

function renderLockTable(locks = []) {
  if (!locks.length) return "";
  return `<details class="template-locks"><summary>잠금 규칙</summary><div class="lock-table">${locks.map((lock) => `<div class="lock-row"><b>${escapeHtml(lock.label)}</b><small>${escapeHtml(lock.rule)}</small></div>`).join("")}</div></details>`;
}

async function loadTemplateSurface() {
  const root = $("#template-root");
  if (!root) return;
  try {
    if (!state.template) state.template = await api("/api/grok-imagine/template");
    const template = state.template;
    root.innerHTML = `<h2 id="template-title">${escapeHtml(template.title)}</h2><p>슬롯 값은 새 쇼츠 초안에서만 채울 수 있습니다. 사람·자막 위치·금지 항목은 바꾸지 않습니다.</p><div class="slot-grid">${renderWorldSlotFields(template.slots)}</div>${renderLockTable(template.locks)}`;
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
    if (preview) preview.innerHTML = "";
    return;
  }
  try {
    state.createPreview = await api("/api/grok-imagine/template/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: topic.trim() || "빈 현장의 숨은 원리", facts, worldSlots })
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

function renderJobDetail(job) {
  const detail = $("#job-detail");
  if (!job) return;
  const status = shortStatus(job);
  const running = ["queued", "running", "verifying"].includes(job.status);
  const preview = shortPreview(job);
  const still = currentStillUrl(job);
  const previewMedia = preview.videoUrl
    ? `<video controls playsinline preload="metadata" poster="${escapeHtml(preview.poster || still || "")}" src="${escapeHtml(preview.videoUrl)}"></video>`
    : still
      ? `<img class="preview-still" src="${escapeHtml(still)}" alt="" />`
      : "";
  const previewMarkup = previewMedia ? `<div class="preview-wrap">${previewMedia}</div>` : "";
  const facts = (Array.isArray(job.facts) ? job.facts : []).map((fact) => String(fact).trim()).filter(Boolean);
  const factsMarkup = `<label class="field-label" for="detail-facts">사실</label><textarea id="detail-facts" data-draft-facts rows="4">${escapeHtml(facts.join("\n"))}</textarea>${facts.length ? `<ul class="draft-facts">${facts.slice(0, 4).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : ""}`;
  const scriptText = String(job.scriptDraft || job.script?.oneLiner || "").trim();
  const scriptMarkup = `<label class="field-label" for="detail-script">대본</label>${scriptText ? `<textarea id="detail-script" class="draft-script" data-draft-script rows="4">${escapeHtml(scriptText)}</textarea>` : `<p class="empty-note">대본 없음</p><textarea id="detail-script" class="draft-script" data-draft-script rows="4"></textarea>`}`;
  const slotEntries = Object.entries(job.worldSlots || {}).filter(([, value]) => String(value || "").trim());
  const slotsMarkup = slotEntries.length
    ? `<label class="field-label">슬롯</label><dl class="draft-slots">${slotEntries.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl><div class="slot-grid">${renderWorldSlotFields(slotEntries.map(([id, value]) => ({ id, label: id, value, editable: true })), { editable: true, namePrefix: "detail-slot" })}</div>`
    : `<label class="field-label">슬롯</label><p class="empty-note">슬롯 없음</p><dl class="draft-slots"></dl>`;
  const frozen = state.health?.imagine?.frozen !== false;
  const saveDraft = `<button class="secondary-button" id="save-draft" type="button">저장</button>`;
  const runDraft = status.key === "draft"
    ? `<button class="primary-button" id="run-draft" type="button"${frozen ? " disabled" : ""}>공장 시작</button>${frozen ? `<p class="inspect-frozen">크레딧 402</p>` : ""}`
    : "";
  const localControls = job.provider === "local" && !["completed", "running", "verifying"].includes(job.status)
    ? `<div class="upload-box"><label for="detail-upload"><span>클립을 올리세요</span><small>MP4, MOV, WebM</small></label><input id="detail-upload" type="file" accept="video/*" multiple /><button class="secondary-button" id="run-local" type="button">업로드한 클립으로 편집</button></div>`
    : "";
  const downloads = shortDownloads(job).map((item) => `<a class="artifact-link" href="${escapeHtml(item.href)}" download>${escapeHtml(item.label)}<b>↓</b></a>`).join("");
  const warnings = (job.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  detail.innerHTML = `<div class="detail-head"><h2 id="short-detail-title">${escapeHtml(status.label)}</h2><span class="job-status ${status.key}"><i></i>${escapeHtml(status.label)}</span></div><label class="field-label" for="detail-topic">주제</label><input id="detail-topic" data-draft-topic value="${escapeHtml(job.topic || "")}" minlength="4" />${running ? `<div class="detail-progress"><div><span>${escapeHtml(currentStageText(job))}</span><b>${job.progress || 0}%</b></div><div class="progress-track"><i style="width:${job.progress || 0}%"></i></div></div>` : ""}${previewMarkup}${scriptMarkup}${slotsMarkup}${factsMarkup}${saveDraft}${runDraft}${localControls}${warnings ? `<div class="warning-box"><ul>${warnings}</ul></div>` : ""}${downloads ? `<div class="download-list artifact-list"><h3>내려받기</h3>${downloads}</div>` : ""}${job.status === "failed" ? `<div class="error-box"><b>실행 오류</b><pre>${escapeHtml(job.error || job.message || "알 수 없는 오류")}</pre><button class="secondary-button" id="retry-job" type="button">다시 실행</button></div>` : ""}`;
  $("#detail-upload")?.addEventListener("change", uploadLocalClips);
  $("#run-local")?.addEventListener("click", runSelectedJob);
  $("#retry-job")?.addEventListener("click", runSelectedJob);
  $("#run-draft")?.addEventListener("click", runSelectedJob);
  $("#save-draft")?.addEventListener("click", () => { void saveDetailDraft(); });
}

async function uploadLocalClips(event) {
  const files = [...event.target.files];
  if (!files.length || !state.selectedJobId) return;
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/clips`, { method: "POST", body: form });
    showToast(`${files.length}개 클립을 올렸습니다.`);
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function saveDetailDraft() {
  if (!state.selectedJobId) return;
  try {
    const payload = await saveInspectDraft(state.selectedJobId, $("#job-detail"));
    showToast("초안을 저장했습니다.");
    if (payload.job) {
      upsertJob(payload.job);
      renderJobDetail(payload.job);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function runSelectedJob() {
  if (!state.selectedJobId) return;
  if (state.health?.imagine?.frozen !== false) {
    showToast("크레딧 402", "error");
    return;
  }
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/run`, { method: "POST" });
    showToast("편집을 시작했습니다.");
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
  const structural = previousIds !== nextIds || !document.querySelector("#create-tile");
  if (structural) renderJobs();
  else {
    state.jobs.forEach(patchGridCard);
    const selected = state.jobs.find((job) => job.id === selectedId);
    if (state.view === "watch") renderWatchFeed();
    if (state.view === "detail" && selected) {
      patchDetailProgress(selected);
      renderLiveFactory(selected);
      watchJobLive(selected);
    }
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
    setView("detail");
    renderJobs();
    await refreshJobs();
    showToast("초안을 저장했습니다.");
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
      ? "Grok Imagine 공장은 PATH의 grok 또는 ~/.grok/bin/grok와 이미 되어 있는 SuperGrok OAuth만 사용합니다. XAI_API_KEY와 grok login/logout은 쓰지 않으며 Gemini로 대체하지 않습니다."
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
  const frozenNote = $("#batch-frozen");
  const queue = $("#batch-queue");
  if (topicField) topicField.hidden = batch;
  if (batchField) batchField.hidden = !batch;
  if (submit) submit.hidden = batch;
  if (actions) actions.hidden = !batch;
  if (topic) topic.required = !batch;
  const frozen = state.health?.imagine?.frozen !== false;
  if (queue) queue.disabled = frozen;
  if (frozenNote) frozenNote.hidden = !batch || !frozen;
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
  if (state.health?.imagine?.frozen !== false) {
    showToast("크레딧 402", "error");
    return;
  }
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
  rememberOpener(event);
  closeMenu();
  if (state.view === "watch") state.returnToWatch = true;
  setView("template");
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

function renderMachineSheet() {
  const root = $("#machine-root");
  if (!root) return;
  const health = state.health || {};
  const grok = Boolean(health.capabilities?.grokCli);
  const ffmpeg = Boolean(health.capabilities?.ffmpeg);
  const frozen = health.imagine?.frozen !== false;
  root.innerHTML = `<h2 id="machine-title">사양</h2><p>grok ${grok ? "준비" : "없음"} · ffmpeg ${ffmpeg ? "준비" : "없음"} · Imagine ${frozen ? "402 동결" : "열림"}</p>`;
}

function renderStudioChrome() {
  const health = state.health || {};
  const grok = Boolean(health.capabilities?.grokCli);
  const ffmpeg = Boolean(health.capabilities?.ffmpeg);
  const frozen = health.imagine?.frozen !== false;
  const chips = $("#studio-chips");
  if (chips) {
    chips.hidden = false;
    chips.innerHTML = `<button type="button" class="studio-chip${grok ? "" : " warn"}" data-open-machine>grok</button><button type="button" class="studio-chip${ffmpeg ? "" : " warn"}" data-open-machine>ffmpeg</button><button type="button" class="studio-chip${frozen ? " danger" : ""}" data-open-machine>402</button>`;
    chips.querySelectorAll("[data-open-machine]").forEach((button) => button.addEventListener("click", openMachine));
  }
  const banner = $("#feed-banner");
  if (banner) {
    const reasons = [];
    if (!state.jobs.length) reasons.push("쇼츠가 없습니다");
    if (frozen) reasons.push("Imagine 402");
    if (!ffmpeg) reasons.push("ffmpeg 없음");
    if (!grok) reasons.push("grok 없음");
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
  if (!["create", "detail", "template", "settings", "machine"].includes(state.view)) {
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
  state.selectedJobId = state.view === "detail" ? null : state.selectedJobId;
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
  $("#open-template")?.addEventListener("click", openTemplate);
  $("#open-settings")?.addEventListener("click", openSettings);
  $("#import-library")?.addEventListener("click", importLibrary);
  $("#close-create")?.addEventListener("click", closeOverlays);
  $("#close-short")?.addEventListener("click", closeOverlays);
  $("#close-template")?.addEventListener("click", closeOverlays);
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
        if (closeOpenWatchInspect()) return;
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
      closeOpenWatchInspect();
      stopWatchFeed($("#watch-feed"));
    }
  });
  window.addEventListener("pagehide", () => {
    closeOpenWatchInspect();
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
    showToast(error.message, "error");
  }
}

init();
