const pagers = new WeakMap();
const watchPlayers = new WeakMap();

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
      wheelAt: 0,
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
  const held = watchPlayers.get(root);
  if (held) return held;
  const found = root.querySelector?.(".watch-player video") || null;
  if (found) watchPlayers.set(root, found);
  return found;
}

function pauseLeftoverMedia(root) {
  const held = root ? watchPlayers.get(root) : null;
  const doc = globalThis.document;
  if (typeof doc?.querySelectorAll !== "function") return;
  for (const media of [...doc.querySelectorAll(".preview-wrap video, .shorts-grid video, audio")]) {
    if (media === held) continue;
    try { media.pause?.(); } catch { /* ignore leftover media */ }
  }
}

function ensureWatchColumn(root) {
  if (!root || typeof root.querySelector !== "function") return null;
  let column = root.querySelector(".watch-column");
  if (column) return column;
  const chrome = root.querySelector("#watch-chrome") || root.querySelector(".watch-chrome");
  if (!chrome) return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  column = document.createElement("div");
  column.className = "watch-column";
  chrome.parentElement?.insertBefore?.(column, chrome);
  column.appendChild(chrome);
  return column;
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

export function applyTrack(root, options) {
  return applyWatchTransform(root, options);
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

export function moveWatchIndex(root, index, options) {
  return goWatchIndex(root, index, options);
}

export function stepWatchFeed(root, delta, { animate = true } = {}) {
  const pager = pagerOf(root);
  if (!pager) return;
  moveWatchIndex(root, pager.index + delta, { animate });
}

function attachWatchVideo(video) {
  if (typeof video.setAttribute === "function") {
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
  }
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
  ensureWatchColumn(root);
  let video = watchPlayers.get(root);
  if (video) return video;
  video = root.querySelector?.(".watch-player video") || null;
  if (video) {
    attachWatchVideo(video);
    watchPlayers.set(root, video);
    return video;
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  video = document.createElement("video");
  attachWatchVideo(video);
  watchPlayers.set(root, video);
  const stage = root.querySelector?.(".watch-player .watch-stage") || root.querySelector?.(".watch-stage");
  if (stage) {
    if (!video.parentElement) stage.appendChild(video);
    return video;
  }
  const player = document.createElement("div");
  player.className = "watch-player";
  const nextStage = document.createElement("div");
  nextStage.className = "watch-stage";
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
  pauseLeftoverMedia(root);
  const videos = [];
  const held = root ? watchPlayers.get(root) : null;
  if (held) videos.push(held);
  if (root && typeof root.querySelectorAll === "function") {
    for (const video of root.querySelectorAll("video")) {
      if (!videos.includes(video)) videos.push(video);
    }
  }
  for (const video of videos) {
    video.pause();
    video.currentTime = 0;
    if (typeof video.removeAttribute === "function") video.removeAttribute("src");
    try { video.load?.(); } catch { /* ignore empty src */ }
    if (typeof video.remove === "function") video.remove();
    else video.parentElement?.removeChild?.(video);
  }
  if (root) watchPlayers.delete(root);
}

function revealWatchVideo(video) {
  if (!video?.style) return video;
  video.style.visibility = "visible";
  video.style.opacity = "1";
  return video;
}

function revealAndPlay(video, jobId) {
  if (jobId && video.dataset?.jobId && video.dataset.jobId !== jobId) return;
  revealWatchVideo(video);
  const play = video.play();
  if (play && typeof play.then === "function") {
    play.then(() => revealWatchVideo(video)).catch(() => {});
  }
  return play;
}

export function playWatchFeed(target) {
  if (target && typeof target.play === "function" && typeof target.querySelector !== "function") {
    target.muted = false;
    if (typeof target.removeAttribute === "function") target.removeAttribute("muted");
    attachWatchVideo(target);
    revealWatchVideo(target);
    const play = target.play();
    if (play && typeof play.then === "function") {
      play.then(() => revealWatchVideo(target)).catch(() => {});
    }
    return play;
  }
  const root = target;
  const slides = watchSlides(root);
  const activeSlide = slides[currentIndex(root)];
  const jobId = activeSlide?.dataset?.jobId;
  let video = ensureWatchPlayer(root);
  if (!video) return;
  attachWatchVideo(video);
  video.muted = false;
  if (typeof video.removeAttribute === "function") video.removeAttribute("muted");
  video.volume = 1;
  video.preload = "auto";
  if (jobId && video.dataset?.jobId === jobId) {
    return revealAndPlay(video, jobId);
  }
  if (video.style) {
    video.style.visibility = "hidden";
    video.style.opacity = "0";
  }
  video.pause();
  video = reparentWatchVideo(root, activeSlide);
  if (!video) return;
  attachWatchVideo(video);
  if (activeSlide?.dataset?.poster) video.poster = activeSlide.dataset.poster;
  const src = activeSlide?.dataset?.src || activeSlide?.dataset?.videoUrl;
  const reveal = () => revealAndPlay(video, jobId);
  if (typeof video.addEventListener === "function") {
    video.addEventListener("loadeddata", reveal, { once: true });
    video.addEventListener("canplay", reveal, { once: true });
    video.addEventListener("playing", reveal, { once: true });
  }
  if (src && video.getAttribute?.("src") !== src) video.src = src;
  if (video.dataset) video.dataset.jobId = jobId || "";
  if ((video.readyState || 0) >= 2) revealWatchVideo(video);
  const play = video.play();
  if (play && typeof play.then === "function") {
    play.then(() => revealWatchVideo(video)).catch(() => {});
  }
  return play;
}

export function clearWatchSize(root) {
  if (root?.dataset) delete root.dataset.sized;
  if (root?.style?.removeProperty) root.style.removeProperty("--watch-h");
}

export function syncWatchFeed(root, surface, mountWatchFeed) {
  pauseLeftoverMedia(root);
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

export function pageHeight(root) {
  if (!root) return 0;
  return Math.round(root.clientHeight || 0);
}

export const watchPageHeight = pageHeight;

export function sizeWatchFeed(root) {
  if (!root) return 0;
  const h = Math.round(root.clientHeight || 0);
  if (h > 0) root.style.setProperty("--watch-h", `${h}px`);
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

export function settleWatchIndex(root, { animate = false } = {}) {
  wrapWatchFeed(root);
  const slide = currentWatchSlide(root);
  const pager = pagerOf(root);
  pager?.onActive?.(slide?.dataset?.jobId, slide);
  if (animate) return;
  playWatchFeed(root);
}

function settleWatchPager(root) {
  settleWatchIndex(root, { animate: false });
}

function chromeHit(event) {
  const closest = event.target?.closest?.bind(event.target);
  if (!closest) return false;
  return Boolean(
    closest(".watch-inspect")
    || closest(".watch-close")
    || closest(".watch-back")
    || closest(".watch-menu")
    || closest(".watch-materials-toggle")
    || closest(".watch-inspect-dismiss")
    || closest(".watch-dl")
    || closest(".watch-inspect, .watch-close, .watch-back, .watch-menu, .watch-materials-toggle, .watch-inspect-dismiss, .watch-dl")
  );
}

function toggleInspect(root) {
  root?.classList?.toggle("inspect-open");
}

function setSwiping(root, pager, value) {
  pager.swiping = value;
  if (root?.dataset) {
    if (value) root.dataset.swiping = "1";
    else delete root.dataset.swiping;
  }
}

function bindWatchResize(root) {
  if (!root || typeof ResizeObserver !== "function") return;
  if (root.dataset?.resizeBound === "1") return;
  if (root.dataset) root.dataset.resizeBound = "1";
  const observer = new ResizeObserver(() => {
    if (root.dataset?.swiping === "1" || pagerOf(root)?.swiping) return;
    sizeWatchFeed(root);
    applyWatchTransform(root, { animate: false });
  });
  observer.observe(root);
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
  ensureWatchColumn(root);
  createWatchPlayer(root);
  bindWatchResize(root);
  const track = watchTrack(root);
  root.addEventListener("click", (event) => {
    if (chromeHit(event)) {
      pager.swallowClick = false;
      if (event.target?.closest?.(".watch-menu, .watch-materials-toggle")) {
        event.preventDefault?.();
        event.stopPropagation?.();
        toggleInspect(root);
        return;
      }
      const close = event.target?.closest?.(".watch-close, .watch-back");
      if (close) {
        stopWatchFeed(root);
        onBack?.(event);
        return;
      }
      return;
    }
    if (pager.swallowClick) {
      pager.swallowClick = false;
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    if (!event.target.closest(".watch-stage") && !event.target.closest("video")) return;
    const video = watchPlayerVideo(root);
    if (!video) return;
    if (video.paused) {
      revealWatchVideo(video);
      const play = globalThis.document?.body?.classList?.contains("watch-open") ? playWatchFeed(root) : null;
      if (play && typeof play.then === "function") {
        play.then(() => revealWatchVideo(video)).catch(() => {});
      }
      if (!play) stopWatchFeed(root);
    } else {
      video.pause();
    }
  });
  root.addEventListener("pointerdown", (event) => {
    if (chromeHit(event)) {
      pager.swallowClick = false;
      return;
    }
    setSwiping(root, pager, true);
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
    if (chromeHit(event)) {
      pager.swallowClick = false;
      return;
    }
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
    if (chromeHit(event)) {
      pager.swallowClick = false;
      setSwiping(root, pager, false);
      return;
    }
    if (!pager.swiping) return;
    setSwiping(root, pager, false);
    const movement = Math.hypot(pager.dx, pager.dy);
    if (cancel || movement < 10) {
      applyWatchTransform(root, { animate: false });
      return;
    }
    pager.swallowClick = true;
    const dy = pager.dy;
    const fast = Math.abs(pager.velocity) > 0.4;
    if (Math.abs(dy) > 40 || fast) {
      moveWatchIndex(root, pager.index + (dy < 0 ? 1 : -1), { animate: true });
      playWatchFeed(root);
    } else applyWatchTransform(root, { animate: true });
  };
  root.addEventListener("pointerup", (event) => endPointer(event, false));
  root.addEventListener("pointercancel", (event) => endPointer(event, true));
  root.addEventListener("wheel", (event) => {
    if (event.target?.closest?.(".watch-inspect")) return;
    if (pager.swiping || root.dataset?.swiping === "1") return;
    const dy = event.deltaY || 0;
    if (Math.abs(dy) <= 40) return;
    event.preventDefault?.();
    const now = Date.now();
    if (now - (pager.wheelAt || 0) < 320) return;
    pager.wheelAt = now;
    moveWatchIndex(root, pager.index + (dy > 0 ? 1 : -1), { animate: true });
    playWatchFeed(root);
  }, { passive: false });
  track?.addEventListener?.("transitionend", (event) => {
    if (event.propertyName && event.propertyName !== "transform") return;
    settleWatchPager(root);
  });
}
