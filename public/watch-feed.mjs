export function stopWatchFeed(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const video of root.querySelectorAll("video")) {
    video.pause();
    video.currentTime = 0;
  }
}

export function playWatchFeed(video) {
  if (!video) return;
  video.muted = false;
  if (typeof video.removeAttribute === "function") video.removeAttribute("muted");
  return video.play();
}

export function syncWatchFeed(root, surface) {
  if (surface !== "watch") stopWatchFeed(root);
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

export function watchPageHeight(root) {
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

export function sizeWatchFeed(root) {
  if (!root) return 0;
  const height = Math.round(root.clientHeight || 0);
  if (height > 0 && typeof root.style?.setProperty === "function") {
    root.style.setProperty("--watch-h", `${height}px`);
  }
  return height;
}

function watchScroller(root) {
  if (!root) return null;
  if (typeof root.querySelector === "function") {
    return root.querySelector("#watch-scroller") || root.querySelector(".watch-scroller") || root;
  }
  return root;
}

export function snapWatchFeed(root) {
  const scroller = watchScroller(root);
  if (!scroller || typeof scroller.scrollTop !== "number") return;
  const h = watchPageHeight(root);
  if (!(h > 0)) return;
  scroller.scrollTop = Math.round(scroller.scrollTop / h) * h;
  const slides = typeof scroller.querySelectorAll === "function"
    ? [...scroller.querySelectorAll(".watch-slide")]
    : [];
  const index = Math.round(scroller.scrollTop / h);
  const landed = slides[index];
  if (landed?.dataset?.loop === "head") {
    const realLast = [...slides].reverse().find((slide) => !slide.dataset?.loop);
    if (realLast) scroller.scrollTop = Math.max(0, slides.indexOf(realLast)) * h;
  } else if (landed?.dataset?.loop === "tail") {
    const realFirst = slides.find((slide) => !slide.dataset?.loop);
    if (realFirst) scroller.scrollTop = Math.max(0, slides.indexOf(realFirst)) * h;
  }
}

export function bindWatchFeed(root, onBack) {
  if (!root) return;
  if (root.dataset?.watchBound === "1") {
    if (globalThis.document?.body?.classList?.contains("watch-open")) {
      playWatchFeed(
        selectedWatchSlide(root)?.querySelector?.("video")
          || root.querySelector(".watch-slide.active:not([data-loop]) video")
          || root.querySelector(".watch-slide.active video")
          || root.querySelector("video")
      );
    } else {
      stopWatchFeed(root);
    }
    return;
  }
  if (root.dataset) root.dataset.watchBound = "1";
  root.addEventListener("click", (event) => {
    const close = event.target?.closest?.(".watch-close, .watch-back");
    if (!close) return;
    stopWatchFeed(root);
    onBack?.(event);
  });
}
