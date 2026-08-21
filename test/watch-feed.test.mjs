import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bindWatchFeed, clearWatchSize, playWatchFeed, selectedWatchSlide, sizeWatchFeed, snapWatchFeed, stopWatchFeed, syncWatchFeed, watchPageHeight, wrapWatchFeed } from "../public/watch-feed.mjs";

function fakeVideo(time = 4) {
  return {
    paused: false,
    muted: true,
    currentTime: time,
    playCalls: 0,
    pauseCalls: 0,
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
  return {
    dataset: {},
    videos,
    listeners,
    querySelector(selector) {
      if (selector === ".watch-slide.active video") return extra.active || videos[0] || null;
      if (selector === "video") return videos[0] || null;
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
  handler({ target: { closest: (sel) => sel === ".watch-stage" ? {} : null }, via: "stage" });
  handler({ target: { closest: () => null }, via: "letterbox" });
  assert.equal(backs.length, 0);
  assert.equal(videos[0].pauseCalls, 0);
  handler({ target: { closest: (sel) => sel === ".watch-close, .watch-back" || sel === ".watch-close" || sel === ".watch-back" ? {} : null }, via: "close" });
  assert.deepEqual(backs, ["close"]);
  assert.equal(videos[0].pauseCalls, 1);
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

test("playWatchFeed never assigns muted true", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  assert.equal(feed.includes("muted = true"), false);
  assert.equal(app.includes("muted = true"), false);
  assert.equal(feed.includes("muted=true"), false);
  assert.match(feed, /video\.muted = false/);
});

function fakeFeed(slides, scrollTop = 0, height = 640) {
  const props = { "--watch-h": `${height}px` };
  const scroller = {
    scrollTop,
    querySelectorAll(selector) {
      return selector === ".watch-slide" ? slides : [];
    }
  };
  return {
    clientHeight: height,
    dataset: {},
    style: {
      getPropertyValue(name) { return props[name] || ""; },
      setProperty(name, value) { props[name] = value; }
    },
    querySelector(selector) {
      if (selector === "#watch-scroller" || selector === ".watch-scroller") return scroller;
      if (selector === ".watch-slide.active:not([data-loop])") return slides.find((slide) => slide.className?.includes("active") && !slide.dataset?.loop) || null;
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
    scroller
  };
}

test("sizeWatchFeed writes --watch-h from clientHeight once", () => {
  const root = fakeFeed([], 0, 711);
  assert.equal(sizeWatchFeed(root), 711);
  assert.equal(root.style.getPropertyValue("--watch-h"), "711px");
  assert.equal(root.dataset.sized, "1");
  assert.equal(watchPageHeight(root), 711);
  root.clientHeight = 12;
  assert.equal(sizeWatchFeed(root), 711);
  assert.equal(root.style.getPropertyValue("--watch-h"), "711px");
});

test("sizeWatchFeed prefers window.innerHeight and lock unless force", () => {
  const previous = globalThis.window;
  globalThis.window = { innerHeight: 812 };
  const root = fakeFeed([], 0, 711);
  assert.equal(sizeWatchFeed(root), 812);
  assert.equal(root.style.getPropertyValue("--watch-h"), "812px");
  assert.equal(root.dataset.sized, "1");
  globalThis.window.innerHeight = 400;
  root.clientHeight = 12;
  assert.equal(sizeWatchFeed(root), 812);
  assert.equal(root.style.getPropertyValue("--watch-h"), "812px");
  assert.equal(sizeWatchFeed(root, { force: true }), 400);
  assert.equal(root.style.getPropertyValue("--watch-h"), "400px");
  clearWatchSize(root);
  assert.equal(root.dataset.sized, undefined);
  globalThis.window = previous;
});

test("watchPageHeight uses measured px and ignores CSS 100svh", () => {
  const root = fakeFeed([], 0, 640);
  root.style.setProperty("--watch-h", "100svh");
  assert.equal(watchPageHeight(root), 0);
  root.style.setProperty("--watch-h", "640px");
  assert.equal(watchPageHeight(root), 640);
});

test("snapWatchFeed uses existing --watch-h and does not remeasure", () => {
  const slides = [
    { dataset: { jobId: "a" } },
    { dataset: { jobId: "b" } }
  ];
  const root = fakeFeed(slides, 80, 640);
  const before = root.style.getPropertyValue("--watch-h");
  root.clientHeight = 12;
  const original = root.style.setProperty;
  root.style.setProperty = () => { throw new Error("snapWatchFeed remesured --watch-h"); };
  snapWatchFeed(root);
  root.style.setProperty = original;
  assert.equal(root.style.getPropertyValue("--watch-h"), before);
  assert.equal(root.scroller.scrollTop, 0);
});

test("snapWatchFeed jumps head clone to real last and tail clone to real first", () => {
  const slides = [
    { dataset: { loop: "head", jobId: "b" } },
    { dataset: { jobId: "a" } },
    { dataset: { jobId: "b" } },
    { dataset: { loop: "tail", jobId: "a" } }
  ];
  const head = fakeFeed(slides, 0, 640);
  snapWatchFeed(head);
  assert.equal(head.scroller.scrollTop, 2 * 640);
  const tail = fakeFeed(slides, 3 * 640, 640);
  wrapWatchFeed(tail);
  assert.equal(tail.scroller.scrollTop, 1 * 640);
});

test("selectedWatchSlide prefers the real slide over a loop clone", () => {
  const real = { dataset: { jobId: "a" }, className: "watch-slide active" };
  const clone = { dataset: { jobId: "a", loop: "tail" }, className: "watch-slide" };
  const root = fakeFeed([clone, real], 0, 640);
  assert.equal(selectedWatchSlide(root, "a"), real);
});

test("watch hash uses #watch/ and close is × top-right", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  assert.match(app, /#watch\/\$\{/);
  assert.match(app, /hash\.startsWith\("watch\/"\)/);
  assert.match(app, /replaceWatchHash/);
  assert.match(app, /history\.replaceState\(null, "", next\)/);
  assert.match(app, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(app, /playsinline webkit-playsinline/);
  assert.match(app, /setAttribute\("webkit-playsinline"/);
  assert.match(app, /class="watch-menu watch-materials-toggle"/);
  assert.match(css, /\.watch-feed\s*\{[^}]*--watch-h:\s*100svh/);
  assert.match(css, /\.watch-slide\s*\{[^}]*height:\s*var\(--watch-h,\s*100svh\)/);
  assert.match(css, /\.watch-stage\s*\{[^}]*height:\s*var\(--watch-h,\s*100svh\)/);
  assert.match(css, /--watch-h/);
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

test("rejected play shows tap-to-play on the slide", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  assert.match(app, /탭해서 재생/);
  assert.match(app, /setWatchPlayGate\(slide, true\)/);
  assert.match(app, /class="watch-play"/);
});

test("watch-feed module and app wire stop before leave", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  assert.match(feed, /export function stopWatchFeed\(root\)/);
  assert.match(feed, /video\.pause\(\)/);
  assert.match(feed, /video\.currentTime = 0/);
  assert.match(feed, /export function syncWatchFeed/);
  assert.match(feed, /clearWatchSize\(root\);\s*stopWatchFeed\(root\)/);
  assert.match(feed, /sizeWatchFeed\(root\);\s*if \(root\) root\.hidden = false;/);
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
  assert.match(app, /preload = "auto"/);
  assert.match(app, /function primeWatchVideo/);
  assert.match(app, /video\.currentTime = 0\.05/);
  assert.match(app, /\.slice\(0,\s*2\)[\s\S]*primeWatchVideo\(video\)/);
  assert.equal(app.includes("muted = true"), false);
  const watchSlide = app.slice(app.indexOf("function watchSlideMarkup"), app.indexOf("function setWatchPlayGate"));
  assert.equal(watchSlide.includes("watch-dl"), false);
  assert.equal(app.includes('class="watch-dl"'), false);
  assert.match(app, /if \(closeOpenWatchInspect\(\)\) return;/);
  const bindScroller = app.slice(app.indexOf("function bindWatchScroller"), app.indexOf("function activateWatchSlide"));
  assert.equal(/touchend[\s\S]*scrollBy/.test(bindScroller), false);
  assert.equal(/touchend[\s\S]*stepWatch/.test(bindScroller), false);
  assert.match(bindScroller, /if \(dy\) closeOpenWatchInspect\(\)/);
  assert.equal(/touchend[\s\S]*snapWatchFeed/.test(bindScroller), false);
  assert.equal(/touchend[\s\S]*afterWatchSnap/.test(bindScroller), false);
  assert.match(bindScroller, /scrollend/);
  assert.match(bindScroller, /settleWatchFeed|wrapWatchFeed/);
  assert.match(bindScroller, /playWatchFeed\(root\)/);
  assert.equal(bindScroller.includes("setTimeout"), false);
  assert.equal(bindScroller.includes('window.addEventListener("resize"'), false);
  assert.equal(feed.includes('window.addEventListener("resize"'), false);
  assert.equal(feed.includes("}, 80);"), false);
  assert.equal(feed.includes("}, 40);"), false);
  assert.equal(app.includes("}, 80);"), false);
  assert.equal(app.includes("}, 40);"), false);
  assert.equal(app.includes("visualViewport"), false);
  assert.equal(app.includes("쇼츠 공장"), false);
  assert.match(feed, /export function sizeWatchFeed/);
  assert.match(feed, /export function snapWatchFeed/);
  assert.match(feed, /export function wrapWatchFeed/);
  assert.match(feed, /export function clearWatchSize/);
  assert.match(feed, /dataset\.sized/);
  assert.match(feed, /force = false/);
  assert.match(feed, /window\.innerHeight/);
  assert.match(app, /clearWatchSize\(watchFeed\)/);
  assert.match(app, /sizeWatchFeed\(watchFeed\)/);
  assert.match(app, /force:\s*true/);
  assert.match(app, /orientationchange/);
  assert.match(app, /function notifyActive/);
  assert.match(app, /function mountWatchFeed/);
  assert.match(app, /addEventListener\("resize", sizeShortsGrid\)/);
  assert.equal(/addEventListener\("resize", \(\) => \{[\s\S]*sizeWatchFeed/.test(app), false);
  assert.match(feed, /setProperty\("--watch-h"/);
  assert.equal(/function snapWatchFeed[\s\S]*setProperty\("--watch-h"/.test(feed), false);
  assert.equal(/function snapWatchFeed[\s\S]*sizeWatchFeed/.test(feed), false);
  assert.match(feed, /scrollTop = Math\.round\(scroller\.scrollTop \/ h\) \* h/);
  assert.match(feed, /dataset\?\.loop === "head"/);
  assert.match(feed, /dataset\?\.loop === "tail"/);
  assert.match(feed, /:not\(\[data-loop\]\)/);
  assert.match(app, /data-loop="head"/);
  assert.match(app, /data-loop="tail"/);
  assert.match(app, /function watchFeedMarkup/);
  assert.match(app, /scrollBy\(\{\s*top:\s*delta \* h,\s*behavior:\s*"auto"\s*\}\)/);
  const bindSlide = app.slice(app.indexOf("function bindWatchSlide"), app.indexOf("function observeWatchSlides"));
  assert.equal(bindSlide.includes("scrollIntoView"), false);
});
