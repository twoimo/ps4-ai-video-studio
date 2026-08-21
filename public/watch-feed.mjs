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

export function bindWatchFeed(root, onBack) {
  if (!root) return;
  if (root.dataset?.watchBound === "1") {
    if (globalThis.document?.body?.classList?.contains("watch-open")) {
      playWatchFeed(root.querySelector(".watch-slide.active video") || root.querySelector("video"));
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
