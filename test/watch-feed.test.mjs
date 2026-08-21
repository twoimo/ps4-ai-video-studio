import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyWatchTransform,
  bindWatchFeed,
  clearWatchSize,
  createWatchPlayer,
  getWatchIndex,
  goWatchIndex,
  pageHeight,
  playWatchFeed,
  selectedWatchSlide,
  sizeWatchFeed,
  stopWatchFeed,
  syncWatchFeed,
  watchPageHeight,
  wrapWatchFeed
} from "../public/watch-feed.mjs";

function fakeVideo(time = 4) {
  return {
    paused: false,
    muted: true,
    volume: 1,
    preload: "none",
    src: "",
    poster: "",
    currentTime: time,
    parentElement: null,
    playCalls: 0,
    pauseCalls: 0,
    closest(selector) {
      return selector === ".watch-player" ? null : null;
    },
    getAttribute(name) {
      return name === "src" ? this.src : null;
    },
    removeAttribute() {},
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }
  };
}

function fakeRoot(videos, extra = {}) {
  const listeners = [];
  const props = {};
  return {
    dataset: {},
    clientHeight: 640,
    videos,
    listeners,
    style: {
      getPropertyValue(name) { return props[name] || ""; },
      setProperty(name, value) { props[name] = value; },
      removeProperty(name) { delete props[name]; }
    },
    querySelector(selector) {
      if (selector === ".watch-player video" || selector === "video") return extra.active || videos[0] || null;
      return extra.nodes?.[selector] || null;
    },
    querySelectorAll(selector) {
      return selector === "video" ? videos : [];
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    }
  };
}

function decorateSlide(slide) {
  if (typeof slide.appendChild === "function") return slide;
  slide.children = [];
  slide.appendChild = function appendChild(node) {
    this.children.push(node);
    if (node) node.parentElement = this;
    return node;
  };
  return slide;
}

function fakePager({ slides = [], height = 640, video = null } = {}) {
  slides.forEach(decorateSlide);
  const props = { "--watch-h": `${height}px` };
  const listeners = [];
  const trackListeners = [];
  const track = {
    style: { transition: "", transform: "", height: "" },
    querySelectorAll(selector) {
      return selector === ".watch-slide" ? slides : [];
    },
    addEventListener(type, handler) {
      trackListeners.push({ type, handler });
    }
  };
  const root = {
    clientHeight: height,
    dataset: {},
    hidden: false,
    listeners,
    trackListeners,
    track,
    video,
    style: {
      getPropertyValue(name) { return props[name] || ""; },
      setProperty(name, value) { props[name] = value; },
      removeProperty(name) { delete props[name]; }
    },
    querySelector(selector) {
      if (selector === "#watch-track" || selector === ".watch-track") return track;
      if (selector === ".watch-player video" || selector === "video") return video;
      if (selector === ".watch-slide.active:not([data-loop])") {
        return slides.find((slide) => slide.className?.includes("active") && !slide.dataset?.loop) || null;
      }
      if (selector.startsWith(".watch-slide[data-job-id=") && selector.includes(":not([data-loop])")) {
        const id = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"]:not'));
        return slides.find((slide) => slide.dataset?.jobId === id && !slide.dataset?.loop) || null;
      }
      if (selector.startsWith(".watch-slide[data-job-id=")) {
        const id = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"'));
        return slides.find((slide) => slide.dataset?.jobId === id) || null;
      }
      if (selector === ".watch-slide.active") return slides.find((slide) => slide.className?.includes("active")) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".watch-slide") return slides;
      if (selector === "video") return video ? [video] : [];
      return [];
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    }
  };
  return root;
}

test("stopWatchFeed pauses every video and seeks to the start", () => {
  const videos = [fakeVideo(8), fakeVideo(2.5)];
  stopWatchFeed(fakeRoot(videos));
  assert.equal(videos[0].pauseCalls, 1);
  assert.equal(videos[1].pauseCalls, 1);
  assert.equal(videos[0].currentTime, 0);
  assert.equal(videos[1].currentTime, 0);
  assert.equal(videos[0].paused, true);
});

test("syncWatchFeed stops videos when the surface is not watch", () => {
  const videos = [fakeVideo(6)];
  const root = fakeRoot(videos);
  syncWatchFeed(root, "watch");
  assert.equal(videos[0].pauseCalls, 0);
  assert.equal(videos[0].currentTime, 6);
  syncWatchFeed(root, "grid");
  assert.equal(videos[0].pauseCalls, 1);
  assert.equal(videos[0].currentTime, 0);
});

test("bindWatchFeed closes only on watch-close and ignores letterbox", () => {
  const videos = [fakeVideo(3)];
  const root = fakeRoot(videos);
  const backs = [];
  bindWatchFeed(root, (event) => backs.push(event.via));
  const handler = root.listeners.find((item) => item.type === "click").handler;
  handler({ target: { closest: () => null }, via: "letterbox" });
  assert.equal(backs.length, 0);
  assert.equal(videos[0].pauseCalls, 0);
  handler({ target: { closest: (sel) => sel === ".watch-stage" ? {} : null }, via: "stage" });
  assert.equal(backs.length, 0);
  assert.equal(videos[0].pauseCalls, 1);
  handler({ target: { closest: (sel) => sel === ".watch-close, .watch-back" || sel === ".watch-close" || sel === ".watch-back" ? {} : null }, via: "close" });
  assert.deepEqual(backs, ["close"]);
  assert.equal(videos[0].pauseCalls, 2);
  assert.equal(videos[0].currentTime, 0);
});

test("bindWatchFeed already bound plays only while body.watch-open", () => {
  const active = fakeVideo(1);
  const videos = [active];
  const root = fakeRoot(videos, { active });
  root.dataset.watchBound = "1";
  const body = { classList: { contains: (name) => name === "watch-open" && globalThis.__watchOpen === true } };
  const previous = globalThis.document;
  globalThis.document = { body };
  globalThis.__watchOpen = false;
  bindWatchFeed(root, () => {});
  assert.equal(active.playCalls, 0);
  assert.equal(active.pauseCalls, 1);
  assert.equal(active.currentTime, 0);
  active.currentTime = 2;
  globalThis.__watchOpen = true;
  bindWatchFeed(root, () => {});
  assert.equal(active.playCalls, 1);
  assert.equal(active.muted, false);
  globalThis.document = previous;
  delete globalThis.__watchOpen;
});

test("playWatchFeed unmutes before play", () => {
  const video = fakeVideo(0);
  playWatchFeed(video);
  assert.equal(video.muted, false);
  assert.equal(video.playCalls, 1);
});

test("playWatchFeed plays only the shared player", () => {
  const video = fakeVideo(1);
  const slides = [
    { dataset: { src: "/a.mp4", jobId: "a" } },
    { dataset: { src: "/b.mp4", jobId: "b" } }
  ];
  const root = fakePager({ slides, video, height: 640 });
  goWatchIndex(root, 0);
  playWatchFeed(root);
  assert.equal(video.src, "/a.mp4");
  assert.equal(video.playCalls, 1);
  assert.equal(video.muted, false);
  assert.equal(video.volume, 1);
  goWatchIndex(root, 1);
  playWatchFeed(root);
  assert.equal(video.src, "/b.mp4");
  assert.equal(video.playCalls, 2);
});

test("playWatchFeed never assigns muted true", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  assert.equal(feed.includes("muted = true"), false);
  assert.equal(app.includes("muted = true"), false);
  assert.equal(feed.includes("muted=true"), false);
  assert.match(feed, /video\.muted = false/);
});

test("createWatchPlayer builds one video with createElement", () => {
  const kids = [];
  const stage = {
    querySelector: () => null,
    appendChild(node) { kids.push(node); }
  };
  const created = {
    setAttribute() {},
    removeAttribute() {},
    muted: true,
    playsInline: false,
    loop: false,
    preload: "none"
  };
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "video");
      return created;
    }
  };
  const root = {
    querySelector(selector) {
      return selector.includes("watch-stage") ? stage : null;
    }
  };
  assert.equal(createWatchPlayer(root), created);
  assert.equal(created.preload, "auto");
  assert.equal(created.muted, false);
  assert.equal(created.loop, true);
  assert.equal(created.playsInline, true);
  assert.equal(kids[0], created);
  globalThis.document = previous;
});

test("sizeWatchFeed writes --watch-h from clientHeight once", () => {
  const previous = globalThis.window;
  globalThis.window = { visualViewport: { height: 844.4 }, innerHeight: 900 };
  const root = fakePager({ height: 711 });
  delete root.dataset.sized;
  root.style.removeProperty("--watch-h");
  assert.equal(sizeWatchFeed(root), 711);
  assert.equal(root.style.getPropertyValue("--watch-h"), "711px");
  assert.equal(root.dataset.sized, "1");
  assert.equal(watchPageHeight(root), 711);
  assert.equal(pageHeight(root), 711);
  globalThis.window.visualViewport.height = 700;
  root.clientHeight = 12;
  assert.equal(sizeWatchFeed(root), 711);
  assert.equal(root.style.getPropertyValue("--watch-h"), "711px");
  clearWatchSize(root);
  assert.equal(root.dataset.sized, undefined);
  assert.equal(root.style.getPropertyValue("--watch-h"), "");
  globalThis.window = previous;
});

test("sizeWatchFeed falls back to visualViewport then innerHeight when clientHeight is 0", () => {
  const previous = globalThis.window;
  globalThis.window = { visualViewport: { height: 844.4 }, innerHeight: 812 };
  const root = fakePager({ height: 0 });
  delete root.dataset.sized;
  root.style.removeProperty("--watch-h");
  assert.equal(sizeWatchFeed(root), 844);
  assert.equal(root.style.getPropertyValue("--watch-h"), "844px");
  clearWatchSize(root);
  root.clientHeight = 0;
  globalThis.window = { innerHeight: 812 };
  assert.equal(sizeWatchFeed(root, { force: true }), 812);
  assert.equal(root.style.getPropertyValue("--watch-h"), "812px");
  clearWatchSize(root);
  assert.equal(root.dataset.sized, undefined);
  globalThis.window = previous;
});

test("watchPageHeight uses measured px and ignores CSS 100svh", () => {
  const root = fakePager({ height: 640 });
  root.style.setProperty("--watch-h", "100svh");
  assert.equal(watchPageHeight(root), 0);
  root.style.setProperty("--watch-h", "640px");
  assert.equal(watchPageHeight(root), 640);
});

test("wrapWatchFeed jumps clone head to real last and tail to real first", () => {
  const slides = [
    { dataset: { loop: "head", jobId: "b" } },
    { dataset: { jobId: "a" } },
    { dataset: { jobId: "b" } },
    { dataset: { loop: "tail", jobId: "a" } }
  ];
  const root = fakePager({ slides, height: 640 });
  goWatchIndex(root, 0);
  wrapWatchFeed(root);
  assert.equal(getWatchIndex(root), 2);
  assert.equal(root.track.style.transition, "none");
  assert.match(root.track.style.transform, /translate3d\(0,\s*-1280px,\s*0\)/);
  goWatchIndex(root, 3);
  wrapWatchFeed(root);
  assert.equal(getWatchIndex(root), 1);
  assert.match(root.track.style.transform, /translate3d\(0,\s*-640px,\s*0\)/);
});

test("applyWatchTransform follows the finger then snaps one page", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const root = fakePager({ slides, height: 640 });
  goWatchIndex(root, 0);
  applyWatchTransform(root, { animate: false, offset: -80 });
  assert.equal(root.track.style.transition, "none");
  assert.match(root.track.style.transform, /translate3d\(0,\s*-80px,\s*0\)/);
  goWatchIndex(root, 1, { animate: true });
  assert.match(root.track.style.transition, /160ms/);
  assert.match(root.track.style.transform, /translate3d\(0,\s*-640px,\s*0\)/);
});

test("pointer swipe translates the track then steps one slide", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const root = fakePager({ slides, height: 640 });
  bindWatchFeed(root, () => {});
  const start = root.listeners.find((item) => item.type === "pointerdown").handler;
  const move = root.listeners.find((item) => item.type === "pointermove").handler;
  const end = root.listeners.find((item) => item.type === "pointerup").handler;
  goWatchIndex(root, 0);
  start({ clientX: 10, clientY: 200, target: { closest: () => null } });
  move({ clientX: 10, clientY: 140, target: { closest: () => null } });
  assert.match(root.track.style.transform, /translate3d\(0,\s*-60px,\s*0\)/);
  end({ clientX: 10, clientY: 140, target: { closest: () => null } });
  assert.equal(getWatchIndex(root), 1);
  assert.match(root.track.style.transform, /translate3d\(0,\s*-640px,\s*0\)/);
});

test("pointer tap under 10px snaps back and does not change index", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const root = fakePager({ slides, height: 640 });
  bindWatchFeed(root, () => {});
  const start = root.listeners.find((item) => item.type === "pointerdown").handler;
  const move = root.listeners.find((item) => item.type === "pointermove").handler;
  const end = root.listeners.find((item) => item.type === "pointerup").handler;
  const click = root.listeners.find((item) => item.type === "click").handler;
  goWatchIndex(root, 0);
  start({ clientX: 10, clientY: 200, target: { closest: () => null } });
  move({ clientX: 12, clientY: 196, target: { closest: () => null } });
  end({ clientX: 12, clientY: 196, target: { closest: () => null } });
  assert.equal(getWatchIndex(root), 0);
  assert.equal(root.track.style.transition, "none");
  const paused = fakeVideo(1);
  paused.paused = false;
  root.video = paused;
  const original = root.querySelector.bind(root);
  root.querySelector = (selector) => {
    if (selector === "video" || selector === ".watch-player video") return paused;
    return original(selector);
  };
  click({ target: { closest: (sel) => sel === "video" || sel === ".watch-stage" ? {} : null }, preventDefault() {}, stopPropagation() {} });
  assert.equal(paused.pauseCalls, 1);
});

test("pointer drag swallows the following click", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const video = fakeVideo(1);
  const root = fakePager({ slides, video, height: 640 });
  bindWatchFeed(root, () => {});
  const start = root.listeners.find((item) => item.type === "pointerdown").handler;
  const move = root.listeners.find((item) => item.type === "pointermove").handler;
  const end = root.listeners.find((item) => item.type === "pointerup").handler;
  const click = root.listeners.find((item) => item.type === "click").handler;
  goWatchIndex(root, 0);
  start({ clientX: 10, clientY: 200, target: { closest: () => null } });
  move({ clientX: 10, clientY: 140, target: { closest: () => null } });
  end({ clientX: 10, clientY: 140, target: { closest: () => null } });
  const prevented = [];
  click({
    target: { closest: (sel) => sel === "video" || sel === ".watch-stage" ? {} : null },
    preventDefault() { prevented.push("prevent"); },
    stopPropagation() { prevented.push("stop"); }
  });
  assert.deepEqual(prevented, ["prevent", "stop"]);
  assert.equal(video.pauseCalls, 0);
});

test("selectedWatchSlide prefers the real slide over a loop clone", () => {
  const real = { dataset: { jobId: "a" }, className: "watch-slide active" };
  const clone = { dataset: { jobId: "a", loop: "tail" }, className: "watch-slide" };
  const root = fakePager({ slides: [clone, real], height: 640 });
  assert.equal(selectedWatchSlide(root, "a"), real);
});

test("watch hash uses #watch/ and close is ×", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  const html = await readFile(join(process.cwd(), "public/index.html"), "utf8");
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  assert.match(app, /#watch\/\$\{/);
  assert.match(app, /hash\.startsWith\("watch\/"\)/);
  assert.match(app, /replaceWatchHash/);
  assert.match(app, /history\.replaceState\(null, "", next\)/);
  assert.match(app, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(html, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(feed, /setAttribute\("webkit-playsinline"/);
  assert.match(feed, /document\.createElement\("video"\)/);
  assert.match(app, /class="watch-menu watch-materials-toggle"/);
  assert.match(css, /\.watch-slide\s*\{[^}]*height:\s*var\(--watch-h\)/);
  assert.match(css, /\.watch-track\s*\{[^}]*will-change:\s*transform/);
  assert.equal(/\.watch-slide\s*\{[^}]*will-change/.test(css), false);
  assert.equal(/\.watch-feed\s*\{[^}]*will-change/.test(css), false);
  assert.equal(css.includes("scroll-snap"), false);
  assert.equal(css.includes("-webkit-overflow-scrolling"), false);
  assert.equal(css.includes("backface-visibility"), false);
  assert.equal(css.includes("100svh"), false);
  assert.match(css, /\.watch-close[\s\S]*top:\s*12px/);
  assert.match(css, /\.watch-close[\s\S]*right:\s*12px/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-close[\s\S]*right:\s*auto/);
  assert.match(css, /\.watch-close\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.watch-close\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.watch-close\s*\{[^}]*border-radius:\s*0/);
  assert.match(css, /\.watch-back\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.watch-back\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.watch-back\s*\{[^}]*border-radius:\s*0/);
  assert.equal(/\.watch-close\s*\{[^}]*border-radius:\s*50%/.test(css), false);
  assert.equal(/\.watch-close\s*\{[^}]*background:\s*rgba/.test(css), false);
});

test("rejected play shows tap-to-play", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  assert.match(app, /탭해서 재생/);
  assert.match(app, /setWatchPlayGate\(true\)/);
  assert.match(app, /class="watch-play"/);
});

test("watch-feed module and app wire the transform pager", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  const html = await readFile(join(process.cwd(), "public/index.html"), "utf8");
  assert.match(feed, /export function stopWatchFeed\(root\)/);
  assert.match(feed, /video\.pause\(\)/);
  assert.match(feed, /video\.currentTime = 0/);
  assert.match(feed, /export function syncWatchFeed/);
  assert.match(feed, /clearWatchSize\(root\);\s*stopWatchFeed\(root\)/);
  assert.match(feed, /if \(root\) root\.hidden = false;\s*sizeWatchFeed\(root\)/);
  assert.match(feed, /mountWatchFeed\(\)/);
  assert.match(feed, /export function bindWatchFeed/);
  assert.match(feed, /stopWatchFeed\(root\);\s*onBack\?\.\(event\)/);
  assert.match(feed, /watch-open[\s\S]*playWatchFeed[\s\S]*stopWatchFeed\(root\)/);
  assert.match(feed, /\.watch-close, \.watch-back/);
  assert.equal(feed.includes("letterbox"), false);
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view,\s*\(\) => mountWatchFeed/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
  assert.match(app, /pagehide/);
  assert.match(app, /aria-valuenow/);
  assert.equal(app.includes("Math.abs(dy) > 50"), false);
  assert.match(feed, /preload = "auto"/);
  assert.equal(feed.includes("0.05"), false);
  assert.equal(app.includes("0.05"), false);
  assert.equal(app.includes("function primeWatchVideo"), false);
  assert.equal(app.includes("function snapWatchFeed"), false);
  assert.equal(feed.includes("export function snapWatchFeed"), false);
  assert.equal(app.includes("watch-scroller"), false);
  assert.equal(html.includes("watch-scroller"), false);
  assert.equal(feed.includes("scrollTop"), false);
  assert.equal(feed.includes("scrollend"), false);
  assert.equal(feed.includes("distance <= 1.05"), false);
  assert.equal(app.includes("muted = true"), false);
  const watchSlide = app.slice(app.indexOf("function watchSlideMarkup"), app.indexOf("function watchChromeMarkup"));
  assert.equal(watchSlide.includes("<video"), false);
  assert.equal(watchSlide.includes("watch-dl"), false);
  assert.equal(app.includes('class="watch-dl"'), false);
  assert.match(app, /if \(closeOpenWatchInspect\(\)\) return;/);
  assert.equal(feed.includes("setTimeout"), false);
  assert.equal(feed.includes('window.addEventListener("resize"'), false);
  assert.equal(feed.includes("}, 80);"), false);
  assert.equal(feed.includes("}, 40);"), false);
  assert.equal(app.includes("}, 80);"), false);
  assert.equal(app.includes("}, 40);"), false);
  assert.match(feed, /visualViewport/);
  assert.equal(app.includes("쇼츠 공장"), false);
  assert.match(feed, /export function sizeWatchFeed/);
  assert.match(feed, /export function wrapWatchFeed/);
  assert.match(feed, /export function clearWatchSize/);
  assert.match(feed, /export function pageHeight/);
  assert.match(feed, /dataset\.sized/);
  assert.match(feed, /force = false/);
  assert.match(feed, /root\.clientHeight/);
  assert.match(feed, /window\.innerHeight/);
  assert.match(feed, /video\.play\(\)/);
  assert.match(app, /clearWatchSize\(watchFeed\)/);
  assert.match(app, /sizeWatchFeed\(watchFeed\)/);
  assert.match(app, /force:\s*true/);
  assert.match(app, /orientationchange/);
  assert.match(app, /applyWatchTransform/);
  assert.match(app, /stepWatchFeed/);
  assert.match(app, /function notifyActive/);
  assert.match(app, /function mountWatchFeed/);
  assert.match(app, /addEventListener\("resize", sizeShortsGrid\)/);
  assert.equal(/addEventListener\("resize", \(\) => \{[\s\S]*sizeWatchFeed/.test(app), false);
  assert.match(feed, /setProperty\("--watch-h"/);
  assert.match(feed, /removeProperty\("--watch-h"\)/);
  assert.match(feed, /dataset\?\.loop === "head"/);
  assert.match(feed, /dataset\?\.loop === "tail"/);
  assert.match(feed, /:not\(\[data-loop\]\)/);
  assert.match(app, /data-loop="head"/);
  assert.match(app, /data-loop="tail"/);
  assert.match(app, /function watchFeedMarkup/);
  assert.match(app, /\$\("#watch-inspect"\)/);
  assert.match(html, /id="watch-track"/);
  assert.equal(html.includes('id="watch-player"'), false);
  assert.match(feed, /pointerdown/);
  assert.match(feed, /pointermove/);
  assert.match(feed, /pointerup/);
  assert.match(feed, /pointercancel/);
  assert.equal(feed.includes("touchstart"), false);
  assert.equal(feed.includes("touchend"), false);
  assert.match(feed, /function reparentWatchVideo/);
  assert.match(feed, /activeSlide\.appendChild/);
  assert.match(feed, /swallowClick/);
  assert.match(feed, /movement < 10/);
  assert.match(feed, /Math\.hypot/);
  const sizeFn = feed.slice(feed.indexOf("export function sizeWatchFeed"), feed.indexOf("export function wrapWatchFeed"));
  assert.ok(sizeFn.indexOf("root.clientHeight") < sizeFn.indexOf("visualViewport"));
  assert.match(css, /\.watch-player\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-chrome\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.watch-chrome\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.watch-feed\s*\{[^}]*overflow:\s*hidden/);
  assert.equal(/\.watch-feed\s*\{[^}]*overflow-y:\s*scroll/.test(css), false);
  assert.equal(app.includes("scrollIntoView"), false);
});
