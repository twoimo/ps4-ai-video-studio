const pagers = new WeakMap();

function pagerOf(root) {
  if (!root) return null;
  let pager = pagers.get(root);
  if (!pager) {
    pager = {
      index: 0,
      startX: 0,
      startY: 0,
      lastY: 0,
      lastT: 0,
      dx: 0,
      dy: 0,
      velocity: 0,
      swiping: false,
      swallowClick: false,
      onActive: null
    };
    pagers.set(root, pager);
  }
  return pager;
}

function watchTrack(root) {
  if (!root) return null;
  if (typeof root.querySelector === "function") {
    return root.querySelector("#watch-track") || root.querySelector(".watch-track") || root;
  }
  return root;
}

function watchSlides(root) {
  const track = watchTrack(root);
  if (typeof track?.querySelectorAll !== "function") return [];
  return [...track.querySelectorAll(".watch-slide")];
}

function watchPlayerVideo(root) {
  if (!root) return null;
  if (typeof root.play === "function" && typeof root.querySelector !== "function") return root;
  return root.querySelector?.(".watch-player video")
    || root.querySelector?.("video")
    || null;
}

function currentIndex(root) {
  return pagerOf(root)?.index ?? 0;
}

export function getWatchIndex(root) {
  return currentIndex(root);
}

export function currentWatchSlide(root) {
  const slides = watchSlides(root);
  return slides[currentIndex(root)] || selectedWatchSlide(root);
}

export function applyWatchTransform(root, { animate = false, offset = 0 } = {}) {
  const track = watchTrack(root);
  const pager = pagerOf(root);
  const h = pageHeight(root);
  if (!track?.style || !pager || !(h > 0)) return;
  const y = -pager.index * h + offset;
  const count = watchSlides(root).length;
  if (count) track.style.height = `${count * h}px`;
  track.style.transition = animate ? "transform 160ms ease-out" : "none";
  track.style.transform = `translate3d(0, ${y}px, 0)`;
}

export function goWatchIndex(root, index, { animate = false } = {}) {
  const pager = pagerOf(root);
  const slides = watchSlides(root);
  if (!pager || !slides.length) return;
  pager.index = Math.max(0, Math.min(slides.length - 1, index));
  applyWatchTransform(root, { animate });
}

export function stepWatchFeed(root, delta, { animate = true } = {}) {
  const pager = pagerOf(root);
  if (!pager) return;
  goWatchIndex(root, pager.index + delta, { animate });
}

function attachWatchVideo(video) {
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.playsInline = true;
  video.loop = true;
  video.preload = "auto";
  video.muted = false;
  if (typeof video.removeAttribute === "function") video.removeAttribute("muted");
  return video;
}

function ensureWatchPlayer(root) {
  if (!root) return null;
  if (typeof root.play === "function" && typeof root.querySelector !== "function") return root;
  let video = watchPlayerVideo(root);
  if (video) return video;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  const stage = root.querySelector?.(".watch-player .watch-stage") || root.querySelector?.(".watch-stage");
  if (stage) {
    video = stage.querySelector("video") || document.createElement("video");
    attachWatchVideo(video);
    if (!video.parentElement) stage.appendChild(video);
    return video;
  }
  const player = document.createElement("div");
  player.className = "watch-player";
  const nextStage = document.createElement("div");
  nextStage.className = "watch-stage";
  video = document.createElement("video");
  attachWatchVideo(video);
  nextStage.appendChild(video);
  player.appendChild(nextStage);
  return video;
}

function reparentWatchVideo(root, activeSlide) {
  const video = ensureWatchPlayer(root);
  if (!video || !activeSlide) return video;
  const player = video.closest(".watch-player") || video;
  if (player.parentElement !== activeSlide) activeSlide.appendChild(player);
  return video;
}

export function createWatchPlayer(root) {
  return ensureWatchPlayer(root);
}

export function stopWatchFeed(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const video of root.querySelectorAll("video")) {
    video.pause();
    video.currentTime = 0;
  }
}

export function playWatchFeed(target) {
  if (target && typeof target.play === "function" && typeof target.querySelector !== "function") {
    target.muted = false;
    if (typeof target.removeAttribute === "function") target.removeAttribute("muted");
    return target.play();
  }
  const root = target;
  const slides = watchSlides(root);
  const activeSlide = slides[currentIndex(root)];
  const video = reparentWatchVideo(root, activeSlide);
  if (!video) return;
  video.muted = false;
  if (typeof video.removeAttribute === "function") video.removeAttribute("muted");
  video.volume = 1;
  video.preload = "auto";
  const src = activeSlide?.dataset?.src || activeSlide?.dataset?.videoUrl;
  if (src && video.getAttribute?.("src") !== src) video.src = src;
  if (activeSlide?.dataset?.poster) video.poster = activeSlide.dataset.poster;
  return video.play();
}

export function clearWatchSize(root) {
  if (root?.dataset) delete root.dataset.sized;
  if (root?.style?.removeProperty) root.style.removeProperty("--watch-h");
}

export function syncWatchFeed(root, surface, mountWatchFeed) {
  if (surface !== "watch") {
    clearWatchSize(root);
    stopWatchFeed(root);
    return;
  }
  if (root) root.hidden = false;
  sizeWatchFeed(root);
  if (typeof mountWatchFeed === "function") mountWatchFeed();
}

export function selectedWatchSlide(root, jobId) {
  if (!root || typeof root.querySelector !== "function") return null;
  if (jobId != null && jobId !== "") {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(jobId)) : String(jobId);
    return root.querySelector(`.watch-slide[data-job-id="${escaped}"]:not([data-loop])`)
      || root.querySelector(`.watch-slide[data-job-id="${escaped}"]`);
  }
  return root.querySelector(".watch-slide.active:not([data-loop])")
    || root.querySelector(".watch-slide.active");
}

function parseWatchHeight(value) {
  const text = String(value || "").trim();
  if (!text.endsWith("px")) return 0;
  const height = Number.parseFloat(text);
  return height > 0 ? Math.round(height) : 0;
}

export function pageHeight(root) {
  if (!root) return 0;
  const fromInline = parseWatchHeight(root.style?.getPropertyValue?.("--watch-h"));
  if (fromInline > 0) return fromInline;
  if (typeof getComputedStyle === "function") {
    try {
      const computed = parseWatchHeight(getComputedStyle(root).getPropertyValue("--watch-h"));
      if (computed > 0) return computed;
    } catch {
      // jsdom-less tests have no computed style
    }
  }
  return 0;
}

export const watchPageHeight = pageHeight;

export function sizeWatchFeed(root, { force = false } = {}) {
  if (!root) return 0;
  if (root.dataset.sized === "1" && !force) return pageHeight(root);
  const h = Math.round(root.clientHeight || window.visualViewport?.height || window.innerHeight || 0);
  if (h > 0) {
    root.style.setProperty("--watch-h", `${h}px`);
    root.dataset.sized = "1";
  }
  return h;
}

export function wrapWatchFeed(root) {
  const slides = watchSlides(root);
  const pager = pagerOf(root);
  if (!pager || !slides.length) return;
  const landed = slides[pager.index];
  if (landed?.dataset?.loop === "head") {
    const realLast = [...slides].reverse().find((slide) => !slide.dataset?.loop);
    if (realLast) pager.index = Math.max(0, slides.indexOf(realLast));
    applyWatchTransform(root, { animate: false });
  } else if (landed?.dataset?.loop === "tail") {
    const realFirst = slides.find((slide) => !slide.dataset?.loop);
    if (realFirst) pager.index = Math.max(0, slides.indexOf(realFirst));
    applyWatchTransform(root, { animate: false });
  }
  reparentWatchVideo(root, slides[pager.index]);
}

function settleWatchPager(root) {
  wrapWatchFeed(root);
  const slide = currentWatchSlide(root);
  const pager = pagerOf(root);
  pager?.onActive?.(slide?.dataset?.jobId, slide);
  playWatchFeed(root);
}

function chromeTarget(event) {
  return event.target?.closest?.(".watch-chrome, .watch-inspect, .watch-inspect-dismiss, .watch-close, .watch-back, .watch-menu, .watch-play");
}

export function bindWatchFeed(root, onBack, onActive) {
  if (!root) return;
  const pager = pagerOf(root);
  if (onActive) pager.onActive = onActive;
  if (root.dataset?.watchBound === "1") {
    if (globalThis.document?.body?.classList?.contains("watch-open")) {
      playWatchFeed(root);
    } else {
      stopWatchFeed(root);
    }
    return;
  }
  if (root.dataset) root.dataset.watchBound = "1";
  createWatchPlayer(root);
  const track = watchTrack(root);
  root.addEventListener("click", (event) => {
    if (pager.swallowClick) {
      pager.swallowClick = false;
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    const close = event.target?.closest?.(".watch-close, .watch-back");
    if (close) {
      stopWatchFeed(root);
      onBack?.(event);
      return;
    }
    if (event.target?.closest?.(".watch-play")) {
      const play = playWatchFeed(root);
      if (play && typeof play.catch === "function") play.catch(() => {});
      return;
    }
    if (!event.target.closest(".watch-stage") && !event.target.closest("video")) return;
    const video = watchPlayerVideo(root);
    if (!video) return;
    if (video.paused) {
      const play = globalThis.document?.body?.classList?.contains("watch-open") ? playWatchFeed(root) : null;
      if (!play) stopWatchFeed(root);
    } else {
      video.pause();
    }
  });
  root.addEventListener("pointerdown", (event) => {
    if (chromeTarget(event)) return;
    pager.swiping = true;
    pager.swallowClick = false;
    pager.startX = event.clientX || 0;
    pager.startY = event.clientY || 0;
    pager.lastY = pager.startY;
    pager.lastT = Date.now();
    pager.dx = 0;
    pager.dy = 0;
    pager.velocity = 0;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    applyWatchTransform(root, { animate: false, offset: 0 });
  });
  root.addEventListener("pointermove", (event) => {
    if (!pager.swiping) return;
    if (chromeTarget(event)) return;
    const x = event.clientX || 0;
    const y = event.clientY || 0;
    const now = Date.now();
    const dt = Math.max(1, now - pager.lastT);
    pager.velocity = (y - pager.lastY) / dt;
    pager.lastY = y;
    pager.lastT = now;
    pager.dx = x - pager.startX;
    pager.dy = y - pager.startY;
    applyWatchTransform(root, { animate: false, offset: pager.dy });
  });
  const endPointer = (event, cancel = false) => {
    if (!pager.swiping) return;
    pager.swiping = false;
    if (chromeTarget(event)) return;
    const movement = Math.hypot(pager.dx, pager.dy);
    if (cancel || movement < 10) {
      applyWatchTransform(root, { animate: false });
      return;
    }
    pager.swallowClick = true;
    const dy = pager.dy;
    const fast = Math.abs(pager.velocity) > 0.4;
    if (Math.abs(dy) > 40 || fast) stepWatchFeed(root, dy < 0 ? 1 : -1, { animate: true });
    else applyWatchTransform(root, { animate: true });
  };
  root.addEventListener("pointerup", (event) => endPointer(event, false));
  root.addEventListener("pointercancel", (event) => endPointer(event, true));
  track?.addEventListener?.("transitionend", (event) => {
    if (event.propertyName && event.propertyName !== "transform") return;
    settleWatchPager(root);
  });
}
