import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyWatchTransform,
  bindWatchFeed,
  clearWatchSize,
  createWatchPlayer,
  getWatchIndex,
  goWatchIndex,
  pageHeight,
  pauseWatchFeed,
  playWatchFeed,
  playWatchMedia,
  selectedWatchSlide,
  sizeWatchFeed,
  stopWatchFeed,
  syncWatchFeed,
  watchPageHeight,
  wrapWatchFeed
} from "../public/watch-feed.mjs";

function fakeVideo(time = 4, options = {}) {
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
    dataset: {},
    readyState: 0,
    style: { visibility: "", opacity: "" },
    closest(selector) {
      return selector === ".watch-player" ? null : null;
    },
    getAttribute(name) {
      return name === "src" ? this.src : null;
    },
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    play() {
      this.playCalls += 1;
      if (options.rejectUnmuted && !this.muted) {
        this.paused = true;
        return Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }));
      }
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    remove() {
      this.removeCalls = (this.removeCalls || 0) + 1;
      this.parentElement = null;
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

test("pauseWatchFeed pauses the player and does not remove it", () => {
  const video = fakeVideo(4);
  const root = {
    querySelector(selector) {
      return selector === ".watch-player video" || selector === "video" ? video : null;
    },
    querySelectorAll() { return [video]; }
  };
  pauseWatchFeed(root);
  assert.equal(video.pauseCalls, 1);
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 4);
  assert.equal(video.removeCalls || 0, 0);
});

test("stopWatchFeed pauses every video and removes the node", () => {
  const videos = [fakeVideo(8), fakeVideo(2.5)];
  stopWatchFeed(fakeRoot(videos));
  assert.equal(videos[0].pauseCalls, 1);
  assert.equal(videos[1].pauseCalls, 1);
  assert.equal(videos[0].currentTime, 0);
  assert.equal(videos[1].currentTime, 0);
  assert.equal(videos[0].paused, true);
  assert.equal(videos[0].removeCalls, 1);
  assert.equal(videos[1].removeCalls, 1);
});

test("stopWatchFeed epoch ignores a late play after leave", async () => {
  let resolvePlay;
  const video = fakeVideo(3);
  video.play = function play() {
    this.playCalls += 1;
    return new Promise((resolve) => {
      resolvePlay = () => {
        this.paused = false;
        resolve();
      };
    });
  };
  const root = fakePager({
    slides: [{ dataset: { src: "/a.mp4", jobId: "a" } }],
    video,
    height: 640
  });
  const pending = playWatchFeed(root);
  stopWatchFeed(root);
  resolvePlay();
  await pending;
  assert.equal(video.paused, true);
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

test("bindWatchFeed closes only on watch-close and letterbox tap stops watch", () => {
  const videos = [fakeVideo(3)];
  const root = fakeRoot(videos);
  const backs = [];
  bindWatchFeed(root, (event) => backs.push(event.via));
  const handler = root.listeners.find((item) => item.type === "click").handler;
  handler({ target: { closest: () => null }, via: "letterbox" });
  assert.deepEqual(backs, ["letterbox"]);
  assert.equal(videos[0].pauseCalls, 1);
  assert.equal(videos[0].currentTime, 0);
  videos[0].currentTime = 3;
  videos[0].paused = false;
  handler({ target: { closest: (sel) => sel === ".watch-stage" ? {} : null }, via: "stage" });
  assert.deepEqual(backs, ["letterbox"]);
  assert.equal(videos[0].pauseCalls, 2);
  handler({ target: { closest: (sel) => sel === ".watch-close, .watch-back" || sel === ".watch-close" || sel === ".watch-back" ? {} : null }, via: "close" });
  assert.deepEqual(backs, ["letterbox", "close"]);
  assert.equal(videos[0].pauseCalls, 3);
  assert.equal(videos[0].currentTime, 0);
  videos[0].currentTime = 3;
  videos[0].paused = false;
  handler({ target: { closest: (sel) => sel === ".watch-poster" ? {} : null }, via: "poster" });
  assert.deepEqual(backs, ["letterbox", "close"]);
  assert.equal(videos[0].pauseCalls, 4);
  handler({ target: { closest: (sel) => sel === ".watch-meta" ? {} : null }, via: "title" });
  assert.deepEqual(backs, ["letterbox", "close"]);
  handler({ target: { parentElement: { closest: (sel) => sel === ".watch-meta" || sel === ".watch-slide-chrome" ? {} : null } }, via: "title-text" });
  assert.deepEqual(backs, ["letterbox", "close"]);
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

test("playWatchFeed hides the video before reparent when the job changes", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const playFn = feed.slice(feed.indexOf("function revealWatchVideo"), feed.indexOf("export function clearWatchSize"));
  assert.ok(playFn.indexOf('visibility = "hidden"') < playFn.indexOf("reparentWatchVideo"));
  assert.ok(playFn.indexOf("loadeddata") < playFn.indexOf("video.src"));
  assert.ok(playFn.indexOf("canplay") < playFn.indexOf("video.src"));
  assert.ok(playFn.indexOf("playing") < playFn.indexOf("video.src"));
  assert.match(playFn, /visibility = "hidden"/);
  assert.match(playFn, /function revealWatchVideo/);
  assert.match(playFn, /visibility = "visible"/);
  assert.match(playFn, /opacity = "1"/);
  assert.match(playFn, /readyState/);
  assert.match(playFn, /reparentWatchVideo/);
  assert.match(playFn, /loadeddata/);
  assert.match(playFn, /canplay/);
  assert.match(playFn, /playing/);
  assert.match(feed, /setAttribute\("playsinline"/);
  assert.match(feed, /setAttribute\("webkit-playsinline"/);
  assert.match(feed, /setAttribute\("x5-playsinline"/);
  assert.match(feed, /setAttribute\("controlslist", "nodownload"\)/);
  assert.match(feed, /controlsList = "nodownload"/);
  assert.match(feed, /addEventListener\("contextmenu"/);
  const video = fakeVideo(1);
  const slides = [
    { dataset: { src: "/a.mp4", jobId: "a", poster: "/a.jpg" } },
    { dataset: { src: "/b.mp4", jobId: "b", poster: "/b.jpg" } }
  ];
  const root = fakePager({ slides, video, height: 640 });
  goWatchIndex(root, 0);
  playWatchFeed(root);
  assert.equal(video.dataset.jobId, "a");
  goWatchIndex(root, 1);
  playWatchFeed(root);
  assert.equal(video.style.visibility, "hidden");
  assert.equal(video.src, "/b.mp4");
  assert.equal(video.poster, "/b.jpg");
  assert.equal(video.dataset.jobId, "b");
  video.dataset.jobId = "b";
  video.style.visibility = "hidden";
  playWatchFeed(root);
  assert.equal(video.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  assert.equal(video.playCalls, 3);
});

test("playWatchMedia muted fallback is same-turn unmute then remute", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const mediaFn = feed.slice(feed.indexOf("export function playWatchMedia"), feed.indexOf("function revealAndPlay"));
  const mutedFn = feed.slice(feed.indexOf("function playMutedThenUnmutePlay"), feed.indexOf("export function playWatchMedia"));
  assert.equal(app.includes("muted = true"), false);
  assert.equal(feed.includes("muted=true"), false);
  assert.equal(feed.includes("탭해서 재생"), false);
  assert.equal(feed.includes(".catch(() => {})"), false);
  assert.match(feed, /export function playWatchMedia/);
  assert.match(feed, /function playMutedThenUnmutePlay/);
  assert.match(feed, /function unmuteAndPlay/);
  assert.match(feed, /function remuteAndPlay/);
  assert.match(mediaFn, /video\.muted = false/);
  assert.ok(mediaFn.indexOf("video.play()") < mediaFn.indexOf("playMutedThenUnmutePlay"));
  assert.match(mutedFn, /video\.muted = true/);
  assert.match(mutedFn, /finishWatchPlay/);
  assert.equal(mutedFn.includes("unmuteAndPlay"), false);
  assert.match(feed, /pointerup/);
});

test("playWatchMedia remutes and plays when unmute play fails", async () => {
  let muted = true;
  let playCalls = 0;
  const video = {
    paused: true,
    volume: 1,
    preload: "none",
    src: "",
    poster: "",
    currentTime: 0,
    parentElement: null,
    dataset: {},
    readyState: 0,
    style: { visibility: "", opacity: "" },
    get muted() { return muted; },
    set muted(value) { muted = value; },
    closest() { return null; },
    getAttribute() { return null; },
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    play() {
      playCalls += 1;
      this.playCalls = playCalls;
      if (!muted) {
        this.paused = true;
        return Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }));
      }
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; }
  };
  await playWatchMedia(video);
  assert.equal(playCalls, 2);
  assert.equal(video.muted, true);
  assert.equal(video.paused, false);
});

test("playWatchMedia same-turn muted play stays muted after unmuted reject", async () => {
  let unmutedFails = 1;
  const video = fakeVideo(0);
  video.play = function play() {
    this.playCalls += 1;
    if (!this.muted && unmutedFails > 0) {
      unmutedFails -= 1;
      this.paused = true;
      return Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }));
    }
    this.paused = false;
    return Promise.resolve();
  };
  await playWatchMedia(video);
  assert.equal(video.playCalls, 2);
  assert.equal(video.paused, false);
  assert.equal(video.muted, true);
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

test("sizeWatchFeed remasures clientHeight every call", () => {
  const root = fakePager({ height: 589 });
  root.style.removeProperty("--watch-h");
  assert.equal(sizeWatchFeed(root), 589);
  assert.equal(root.style.getPropertyValue("--watch-h"), "589px");
  assert.equal(root.dataset.sized, undefined);
  root.clientHeight = 844;
  assert.equal(sizeWatchFeed(root), 844);
  assert.equal(root.style.getPropertyValue("--watch-h"), "844px");
  assert.equal(pageHeight(root), 844);
  clearWatchSize(root);
  assert.equal(root.dataset.sized, undefined);
  assert.equal(root.style.getPropertyValue("--watch-h"), "");
});

test("pageHeight and applyWatchTransform use live clientHeight not --watch-h", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const root = fakePager({ slides, height: 844 });
  root.style.setProperty("--watch-h", "589px");
  assert.equal(pageHeight(root), 844);
  assert.equal(watchPageHeight(root), 844);
  goWatchIndex(root, 1);
  assert.match(root.track.style.transform, /translate3d\(0,\s*-844px,\s*0\)/);
  root.clientHeight = 711;
  applyWatchTransform(root, { animate: false });
  assert.match(root.track.style.transform, /translate3d\(0,\s*-711px,\s*0\)/);
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

test("pointerup swipe calls playWatchFeed after moveWatchIndex", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const endFn = feed.slice(feed.indexOf("const endPointer"), feed.indexOf('root.addEventListener("pointerup"'));
  assert.ok(endFn.indexOf("moveWatchIndex") < endFn.indexOf("playWatchFeed(root)"));
  assert.match(endFn, /moveWatchIndex\(root,[\s\S]*\{\s*animate:\s*true\s*\}\)/);
  assert.match(endFn, /playWatchFeed\(root\)/);
  const video = fakeVideo(1);
  const slides = [{ dataset: { jobId: "a", src: "/a.mp4" } }, { dataset: { jobId: "b", src: "/b.mp4" } }];
  const root = fakePager({ slides, video, height: 640 });
  bindWatchFeed(root, () => {});
  const start = root.listeners.find((item) => item.type === "pointerdown").handler;
  const move = root.listeners.find((item) => item.type === "pointermove").handler;
  const end = root.listeners.find((item) => item.type === "pointerup").handler;
  goWatchIndex(root, 0);
  video.dataset.jobId = "a";
  const plays = video.playCalls;
  start({ clientX: 10, clientY: 200, target: { closest: () => null } });
  move({ clientX: 10, clientY: 140, target: { closest: () => null } });
  end({ clientX: 10, clientY: 140, target: { closest: () => null } });
  assert.equal(getWatchIndex(root), 1);
  assert.equal(video.playCalls, plays + 1);
  assert.equal(video.src, "/b.mp4");
});

test("wheel listener steps one slide and plays", () => {
  const video = fakeVideo(1);
  const slides = [{ dataset: { jobId: "a", src: "/a.mp4" } }, { dataset: { jobId: "b", src: "/b.mp4" } }];
  const root = fakePager({ slides, video, height: 640 });
  bindWatchFeed(root, () => {});
  const wheel = root.listeners.find((item) => item.type === "wheel");
  assert.ok(wheel);
  goWatchIndex(root, 0);
  wheel.handler({ deltaY: 80, target: { closest: () => null }, preventDefault() {} });
  assert.equal(getWatchIndex(root), 1);
  assert.equal(video.src, "/b.mp4");
  wheel.handler({ deltaY: 80, target: { closest: () => null }, preventDefault() {} });
  assert.equal(getWatchIndex(root), 1);
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

test("hamburger chromeHit does not open inspect and never swallows", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const tokens = new Set();
  const opened = [];
  const root = fakePager({ slides, height: 640 });
  root.classList = {
    toggle(name) {
      if (tokens.has(name)) tokens.delete(name);
      else tokens.add(name);
    },
    contains(name) { return tokens.has(name); }
  };
  bindWatchFeed(root, () => {}, null, (jobId) => opened.push(jobId));
  goWatchIndex(root, 1);
  const down = root.listeners.find((item) => item.type === "pointerdown").handler;
  const up = root.listeners.find((item) => item.type === "pointerup").handler;
  const click = root.listeners.find((item) => item.type === "click").handler;
  const menu = { closest: (sel) => sel.includes(".watch-menu") || sel.includes(".watch-materials-toggle") ? {} : null };
  down({ clientX: 10, clientY: 20, target: menu });
  up({ clientX: 10, clientY: 20, target: menu });
  click({ target: menu, preventDefault() {}, stopPropagation() {} });
  assert.equal(tokens.has("inspect-open"), false);
  assert.equal(getWatchIndex(root), 1);
  assert.deepEqual(opened, ["b"]);
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
  const pauses = video.pauseCalls;
  click({
    target: { closest: (sel) => sel === "video" || sel === ".watch-stage" ? {} : null },
    preventDefault() { prevented.push("prevent"); },
    stopPropagation() { prevented.push("stop"); }
  });
  assert.deepEqual(prevented, ["prevent", "stop"]);
  assert.equal(video.pauseCalls, pauses);
});

test("swipe swallowClick before chrome so landing on close does not leave", () => {
  const slides = [{ dataset: { jobId: "a" } }, { dataset: { jobId: "b" } }];
  const backs = [];
  const root = fakePager({ slides, height: 640 });
  bindWatchFeed(root, (event) => backs.push(event.via || "back"));
  const start = root.listeners.find((item) => item.type === "pointerdown").handler;
  const move = root.listeners.find((item) => item.type === "pointermove").handler;
  const end = root.listeners.find((item) => item.type === "pointerup").handler;
  const click = root.listeners.find((item) => item.type === "click").handler;
  goWatchIndex(root, 0);
  start({ clientX: 10, clientY: 200, target: { closest: () => null } });
  move({ clientX: 10, clientY: 140, target: { closest: () => null } });
  const close = { closest: (sel) => sel.includes("watch-close") || sel.includes("watch-back") ? {} : null };
  end({ clientX: 10, clientY: 140, target: close });
  const prevented = [];
  click({
    target: close,
    via: "close",
    preventDefault() { prevented.push("prevent"); },
    stopPropagation() { prevented.push("stop"); }
  });
  assert.deepEqual(backs, []);
  assert.deepEqual(prevented, ["prevent", "stop"]);
  assert.equal(getWatchIndex(root), 1);
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
  assert.match(css, /\.watch-slide\s*\{[^}]*height:\s*100cqh/);
  assert.match(css, /\.watch-feed\s*\{[^}]*container-type:\s*size/);
  assert.match(css, /\.watch-track\s*\{[^}]*will-change:\s*transform/);
  assert.equal(/\.watch-slide\s*\{[^}]*will-change/.test(css), false);
  assert.equal(/\.watch-feed\s*\{[^}]*will-change/.test(css), false);
  assert.equal(css.includes("scroll-snap"), false);
  assert.equal(css.includes("-webkit-overflow-scrolling"), false);
  assert.equal(css.includes("backface-visibility"), false);
  assert.equal(css.includes("100svh"), false);
  assert.match(css, /#watch-feed[\s\S]*min-height:\s*100%/);
  assert.match(css, /#watch-feed \.watch-column\s*\{[^}]*width:\s*100%/);
  assert.match(css, /#watch-feed \.watch-column\s*\{[^}]*height:\s*100%/);
  assert.match(css, /#watch-feed \.watch-column\s*\{[^}]*min-height:\s*100%/);
  assert.match(css, /#watch-feed \.watch-column\s*\{[^}]*max-width:\s*calc\(100cqh \* 9 \/ 16\)/);
  assert.match(css, /#watch-feed \.watch-column\s*\{[^}]*margin-inline:\s*auto/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*#watch-feed \.watch-column[\s\S]*max-width:\s*var\(--watch-col\)/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*#watch-feed \.watch-slide[\s\S]*max-width:\s*var\(--watch-col\)/);
  assert.doesNotMatch(css, /@media \(max-width:\s*860px\)[\s\S]*#watch-feed \.watch-column[\s\S]{0,80}max-width:\s*100%/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-menu[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
  assert.match(css, /#watch-feed \.watch-menu/);
  assert.equal(css.includes("watch-inspect"), false);
  assert.equal(css.includes("inspect-open"), false);
  assert.equal(html.includes("watch-inspect"), false);
  assert.equal(html.includes("inspect-dismiss"), false);
  assert.equal(css.includes("translateX(100%)"), false);
  assert.match(css, /\.watch-close[\s\S]*top:\s*12px/);
  assert.match(css, /\.watch-close[\s\S]*left:\s*12px/);
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

test("watch chrome has no tap-to-play overlay", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  const html = await readFile(join(process.cwd(), "public/index.html"), "utf8");
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const chrome = app.slice(app.indexOf("function watchChromeMarkup"), app.indexOf("function watchFeedMarkup"));
  assert.equal(chrome.includes("탭해서 재생"), false);
  assert.equal(chrome.includes("watch-play"), false);
  assert.equal(chrome.includes("watch-tap-play"), false);
  assert.equal(app.includes("showTapPlay"), false);
  assert.equal(app.includes("hideTapPlay"), false);
  assert.equal(app.includes("setWatchPlayGate"), false);
  assert.equal(feed.includes("showTapPlay"), false);
  assert.equal(feed.includes("hideTapPlay"), false);
  assert.equal(html.includes("탭해서 재생"), false);
  assert.equal(html.includes('class="watch-play"'), false);
  assert.equal(/\.watch-play\s*\{/.test(css), false);
  assert.equal(css.includes(".watch-tap-play"), false);
});

test("watch-feed module and app wire the transform pager", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  const html = await readFile(join(process.cwd(), "public/index.html"), "utf8");
  assert.match(feed, /export function pauseWatchFeed\(root\)/);
  assert.match(feed, /export function stopWatchFeed\(root\)/);
  assert.match(feed, /export function stopWatchFeed\(root\) \{[\s\S]*?pager\.swiping = false/);
  assert.match(feed, /if \(!pager\.swiping\)/);
  assert.match(app, /function resumeWatchIfVisible/);
  assert.match(app, /visibilitychange[\s\S]*pauseWatchFeed[\s\S]*resumeWatchIfVisible/);
  assert.match(app, /addEventListener\("pageshow", resumeWatchIfVisible\)/);
  assert.match(css, /#watch-feed \.watch-close[\s\S]*z-index:\s*9/);
  assert.match(feed, /bumpWatchEpoch\(root\)/);
  assert.match(feed, /isStaleWatch/);
  assert.match(feed, /video\.pause\(\)/);
  assert.match(feed, /video\.currentTime = 0/);
  assert.match(feed, /export function syncWatchFeed/);
  assert.match(feed, /clearWatchSize\(root\);\s*stopWatchFeed\(root\)/);
  assert.match(feed, /if \(root\) root\.hidden = false;\s*sizeWatchFeed\(root\)/);
  assert.match(feed, /mountWatchFeed\(\)/);
  assert.match(feed, /export function bindWatchFeed/);
  assert.match(feed, /onMaterials/);
  assert.match(feed, /pager\.onMaterials\?\.\(jobId\)/);
  assert.match(feed, /stopWatchFeed\(root\);\s*onBack\?\.\(event\)/);
  assert.match(feed, /function eventElement/);
  assert.match(feed, /function inWatchPlayer/);
  assert.match(feed, /closest\("\.watch-poster"\)/);
  assert.match(feed, /closest\("\.watch-meta"\)/);
  assert.match(feed, /closest\("\.watch-slide-chrome"\)/);
  assert.match(feed, /closest\("\.watch-column"\)/);
  assert.match(feed, /hit\?\.closest\?\.\("\.watch-stage"\)/);
  assert.match(feed, /playMutedThenUnmutePlay[\s\S]*finishWatchPlay/);
  assert.match(feed, /watch-open[\s\S]*playWatchFeed[\s\S]*stopWatchFeed\(root\)/);
  assert.match(feed, /\.watch-close, \.watch-back, \.watch-menu, \.watch-materials-toggle, \.watch-sound/);
  assert.match(feed, /function syncWatchSound/);
  assert.match(feed, /button\.hidden = !\(video\?\.muted \|\| video\?\.volume === 0\)/);
  assert.match(feed, /prev === 0 && video\.volume > 0/);
  assert.match(feed, /function bindWatchFlip/);
  assert.match(feed, /orientationchange/);
  assert.match(feed, /closest\?\.\("\.watch-sound"\)/);
  assert.match(html, /class="watch-sound"/);
  assert.match(app, /class="watch-sound"/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound[\s\S]*?right:\s*0/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound[\s\S]*?left:\s*auto/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound svg[\s\S]*?filter:\s*drop-shadow\(0 1px 6px rgba\(0,0,0,\.75\)\)/);
  assert.match(css, /\.watch-meta h2\s*\{[^}]*padding-right:\s*52px/);
  assert.match(css, /\.watch-sound\[hidden\]/);
  assert.equal(feed.includes("letterbox"), false);
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view,\s*\(\) => mountWatchFeed/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
  assert.match(app, /pagehide/);
  assert.match(app, /pageHiding = true;\s*replaceClearStudioLayer\(\)/);
  assert.doesNotMatch(app, /pagehide[\s\S]{0,200}history\.back/);
  assert.match(app, /function studioLayerDismiss/);
  assert.match(app, /dataset\.fromPop/);
  assert.equal(feed.includes("scrollFocusedFieldIntoView"), false);
  assert.equal(feed.includes("visualViewport"), false);
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
  assert.equal(app.includes("closeOpenWatchInspect"), false);
  assert.equal(app.includes("closeWatchInspect"), false);
  assert.equal(feed.includes("setTimeout"), false);
  assert.equal(feed.includes('window.addEventListener("resize"'), false);
  assert.equal(feed.includes("}, 80);"), false);
  assert.equal(feed.includes("}, 40);"), false);
  assert.equal(app.includes("}, 80);"), false);
  assert.equal(app.includes("}, 40);"), false);
  assert.equal(feed.includes("visualViewport"), false);
  assert.equal(feed.includes('dataset.sized = "1"'), false);
  assert.equal(app.includes("쇼츠 공장"), false);
  assert.match(feed, /export function sizeWatchFeed/);
  assert.match(feed, /export function wrapWatchFeed/);
  assert.match(feed, /export function clearWatchSize/);
  assert.match(feed, /export function pageHeight/);
  assert.match(feed, /root\.clientHeight/);
  assert.match(feed, /video\.play\(\)/);
  assert.equal(feed.includes("function toggleInspect"), false);
  assert.equal(feed.includes("inspect-open"), false);
  assert.equal(feed.includes("watch-inspect"), false);
  assert.match(feed, /chromeHit/);
  assert.match(app, /clearWatchSize\(watchFeed\)/);
  assert.match(app, /sizeWatchFeed\(watchFeed\)/);
  assert.match(app, /sizeShortsGrid\(\)/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /orientationchange/);
  assert.match(app, /applyWatchTransform/);
  assert.match(app, /stepWatchFeed/);
  assert.match(app, /function notifyActive/);
  assert.match(app, /function mountWatchFeed/);
  assert.match(app, /addEventListener\("resize", sizeShortsGrid\)/);
  assert.match(app, /function pinWatchToVisualViewport/);
  assert.match(app, /pinOverlaysToVisualViewport/);
  assert.equal(feed.includes("pinWatchToVisualViewport"), false);
  assert.equal(feed.includes("pinOverlaysToVisualViewport"), false);
  assert.equal(feed.includes("scrollFocusIntoPanel"), false);
  assert.equal(feed.includes("overlayLockY"), false);
  assert.equal(feed.includes("visualViewport"), false);
  assert.equal(feed.includes("visualViewport"), false);
  assert.equal(/addEventListener\("resize", \(\) => \{[\s\S]*sizeWatchFeed/.test(app), false);
  assert.match(feed, /setProperty\("--watch-h"/);
  assert.match(feed, /removeProperty\("--watch-h"\)/);
  assert.match(feed, /dataset\?\.loop === "head"/);
  assert.match(feed, /dataset\?\.loop === "tail"/);
  assert.match(feed, /:not\(\[data-loop\]\)/);
  assert.match(app, /data-loop="head"/);
  assert.match(app, /data-loop="tail"/);
  assert.match(app, /function watchFeedMarkup/);
  assert.match(app, /function openMaterials/);
  assert.match(app, /\/backlot\/p\//);
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
  assert.match(feed, /export function moveWatchIndex/);
  assert.match(feed, /export function moveWatchIndex\(root, index, options\) \{\s*bumpWatchEpoch\(root\);\s*pauseLeftoverMedia\(root\)/);
  assert.match(feed, /export function settleWatchIndex/);
  assert.match(feed, /addEventListener\("wheel"/);
  assert.match(feed, /passive:\s*false/);
  assert.match(css, /\.watch-player video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.watch-player video\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.watch-player video\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.watch-player video\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.watch-player video\s*\{[^}]*background:\s*transparent/);
  assert.equal(/\.watch-player video\s*\{[^}]*display:\s*none/.test(css), false);
  assert.match(css, /\.watch-slide \.watch-poster\s*\{[^}]*z-index:\s*0/);
  assert.match(css, /\.watch-slide \.watch-poster\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.watch-stage\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.watch-stage\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.watch-slide\s*\{[^}]*max-width:\s*calc\(100cqh \* 9 \/ 16\)/);
  assert.match(css, /\.watch-slide\s*\{[^}]*margin-inline:\s*auto/);
  assert.equal(/@media \(min-width:\s*861px\)[\s\S]*\.watch-menu[\s\S]*display:\s*none/.test(css), false);
  assert.equal(css.includes("watch-inspect-dismiss"), false);
  assert.match(feed, /activeSlide\.appendChild/);
  assert.match(feed, /swallowClick/);
  const clickFn = feed.slice(feed.indexOf('root.addEventListener("click"'), feed.indexOf('root.addEventListener("pointerdown"'));
  assert.ok(clickFn.indexOf("pager.swallowClick") < clickFn.indexOf("chromeHit(event)"));
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-slide-chrome[\s\S]*bottom:\s*max\(112px,\s*calc\(env\(safe-area-inset-bottom\) \+ 44px\)\)/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-sound[\s\S]*bottom:\s*max\(68px/);
  assert.doesNotMatch(css, /\.watch-slide-chrome[\s\S]{0,180}--vv-bottom/);
  assert.doesNotMatch(css, /\.watch-sound[\s\S]{0,180}--vv-bottom/);
  assert.doesNotMatch(css, /#watch-feed[\s\S]{0,180}bottom:\s*var\(--vv-bottom/);
  assert.match(feed, /movement < 10/);
  assert.match(feed, /Math\.hypot/);
  const sizeFn = feed.slice(feed.indexOf("export function sizeWatchFeed"), feed.indexOf("export function wrapWatchFeed"));
  assert.match(sizeFn, /root\.clientHeight/);
  assert.equal(sizeFn.includes("visualViewport"), false);
  assert.equal(sizeFn.includes("dataset.sized"), false);
  assert.match(css, /100cqh/);
  assert.match(css, /container-type:\s*size/);
  assert.match(css, /\.watch-player\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-chrome\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-chrome\s*\{[^}]*pointer-events:\s*none/);
  assert.equal(/#watch-feed \.watch-chrome[\s\S]{0,80}position:\s*fixed/.test(css), false);
  assert.equal(/#watch-feed \.watch-close[\s\S]{0,80}position:\s*fixed/.test(css), false);
  assert.equal(/#watch-feed \.watch-menu[\s\S]{0,80}position:\s*fixed/.test(css), false);
  assert.match(css, /\.watch-feed\s*\{[^}]*overflow:\s*hidden/);
  assert.equal(/\.watch-feed\s*\{[^}]*overflow-y:\s*scroll/.test(css), false);
  assert.equal(app.includes("scrollIntoView"), false);
  assert.match(feed, /const watchPlayers = new WeakMap/);
  assert.match(feed, /watchPlayers\.set\(root, video\)/);
  assert.match(feed, /function ensureWatchColumn/);
  assert.match(feed, /className = "watch-column"/);
  assert.match(feed, /pauseLeftoverMedia/);
  assert.match(feed, /\.preview-wrap video, \.shorts-grid video, audio/);
  assert.match(feed, /root\.addEventListener\("wheel"/);
  assert.equal(feed.includes('document.addEventListener("wheel"'), false);
  assert.equal(feed.includes('window.addEventListener("wheel"'), false);
  assert.match(app, /preview-wrap video, \.shorts-grid video, audio/);
  assert.match(app, /stopWatchFeed\(root\);\s*track\.dataset\.signature = signature;\s*track\.innerHTML/);
  assert.match(html, /class="watch-column"/);
});

test("ensureWatchPlayer reuses one video before attach", () => {
  let created = 0;
  const video = fakeVideo(0);
  const kids = [];
  const stage = {
    querySelector: () => null,
    appendChild(node) { kids.push(node); }
  };
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "video");
      created += 1;
      return video;
    }
  };
  const root = {
    querySelector(selector) {
      return selector.includes("watch-stage") ? stage : null;
    }
  };
  assert.equal(createWatchPlayer(root), video);
  assert.equal(createWatchPlayer(root), video);
  assert.equal(created, 1);
  globalThis.document = previous;
});

test("same-job playWatchFeed only plays and does not reparent", () => {
  const video = fakeVideo(1);
  video.dataset.jobId = "a";
  video.src = "/a.mp4";
  const slides = [{ dataset: { src: "/a.mp4", jobId: "a", poster: "/a.jpg" } }];
  const root = fakePager({ slides, video, height: 640 });
  goWatchIndex(root, 0);
  playWatchFeed(root);
  const pauses = video.pauseCalls;
  const plays = video.playCalls;
  playWatchFeed(root);
  assert.equal(video.pauseCalls, pauses);
  assert.equal(video.playCalls, plays + 1);
  assert.equal(video.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  assert.equal(video.src, "/a.mp4");
});

test("leave watch pauses leftover preview grid and audio", () => {
  const leftover = {
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; }
  };
  const audio = {
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; }
  };
  const previous = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      assert.match(selector, /preview-wrap video/);
      assert.match(selector, /shorts-grid video/);
      assert.match(selector, /audio/);
      return [leftover, audio];
    }
  };
  const videos = [fakeVideo(3)];
  const root = fakeRoot(videos);
  syncWatchFeed(root, "watch");
  assert.equal(leftover.pauseCalls, 1);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(videos[0].pauseCalls, 0);
  syncWatchFeed(root, "grid");
  assert.ok(leftover.pauseCalls >= 2);
  assert.ok(audio.pauseCalls >= 2);
  assert.equal(videos[0].pauseCalls, 1);
  assert.equal(videos[0].src === "" || videos[0].removeCalls === 1, true);
  globalThis.document = previous;
});

test("watch-open beats the #watch-feed.watch-feed hide rule", async () => {
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  assert.match(css, /body\.watch-open #watch-feed/);
  assert.match(css, /body\.watch-open #watch-feed\.watch-feed/);
  assert.match(css, /body\.watch-open \.watch-feed\s*\{[^}]*display:\s*block/);
  assert.match(css, /#watch-feed\.watch-feed[\s\S]*display:\s*none/);
});

test("first paint #watch hides the grid before JS", async () => {
  const html = await readFile(join(process.cwd(), "public/index.html"), "utf8");
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const boot = html.slice(html.indexOf("hash === \"create\" || hash === \"batch\""), html.indexOf('src="/app.js"'));
  assert.equal(html.includes('class="watch-open"'), false);
  assert.match(boot, /hash === "watch" \|\| hash.indexOf\("watch\/"\) === 0/);
  assert.match(boot, /classList\.add\("watch-open"\)/);
  assert.match(boot, /getElementById\("shorts"\)/);
  assert.match(boot, /library\.hidden = true/);
  assert.match(boot, /getElementById\("watch-feed"\)/);
  assert.match(boot, /feed\.hidden = false/);
  assert.match(app, /if \(!playable\.length\) \{\s*setView\("grid", \{ skipHash: true \}\);\s*if \(location\.hash && location\.hash !== "#shorts"\) history\.replaceState\(null, "", "#shorts"\)/);
});

test("wheel stays on the watch feed root", () => {
  const slides = [{ dataset: { jobId: "a", src: "/a.mp4" } }, { dataset: { jobId: "b", src: "/b.mp4" } }];
  const root = fakePager({ slides, video: fakeVideo(1), height: 640 });
  bindWatchFeed(root, () => {});
  const wheels = root.listeners.filter((item) => item.type === "wheel");
  assert.equal(wheels.length, 1);
});

test("readyState 2 after src reveals the hidden video immediately", () => {
  const video = fakeVideo(1);
  video.readyState = 2;
  const slides = [
    { dataset: { src: "/a.mp4", jobId: "a" } },
    { dataset: { src: "/b.mp4", jobId: "b" } }
  ];
  const root = fakePager({ slides, video, height: 640 });
  goWatchIndex(root, 0);
  playWatchFeed(root);
  goWatchIndex(root, 1);
  playWatchFeed(root);
  assert.equal(video.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  assert.equal(video.src, "/b.mp4");
});

test("listeners before src catch synchronous Android loadeddata", () => {
  const video = fakeVideo(1);
  let srcValue = "";
  const handlers = [];
  video.addEventListener = (_type, handler) => { handlers.push(handler); };
  Object.defineProperty(video, "src", {
    configurable: true,
    get() { return srcValue; },
    set(value) {
      srcValue = value;
      for (const handler of handlers) handler();
    }
  });
  const slides = [
    { dataset: { src: "/a.mp4", jobId: "a" } },
    { dataset: { src: "/b.mp4", jobId: "b" } }
  ];
  const root = fakePager({ slides, video, height: 640 });
  goWatchIndex(root, 0);
  playWatchFeed(root);
  goWatchIndex(root, 1);
  playWatchFeed(root);
  assert.ok(handlers.length >= 3);
  assert.equal(video.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
});

test("public files have no tap-to-play copy and no credit 402 copy", async () => {
  const root = join(process.cwd(), "public");
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(js|mjs|html|css)$/.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  assert.ok(files.length > 0);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("탭해서 재생"), false, path);
    assert.equal(source.includes("크레딧 402"), false, path);
  }
});

test("watch PiP leftover exits on pause and stop and kicks back on enter", async () => {
  const feed = await readFile(join(process.cwd(), "public/watch-feed.mjs"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  assert.match(feed, /function exitWatchPictureInPicture/);
  assert.match(feed, /document\.exitPictureInPicture/);
  assert.match(feed, /enterpictureinpicture/);
  assert.match(feed, /leavepictureinpicture/);
  assert.match(feed, /exitWatchPictureInPicture\(video\);\s*try \{ video\.pause\(\)/);
  assert.match(feed, /exitWatchPictureInPicture\(video\);\s*video\.pause\(\)/);
  assert.match(feed, /stopWatchFeed\(root\);\s*onBack\?\.\(\)/);
  assert.match(feed, /classList\?\.contains\("watch-open"\)\) return;\s*try \{ video\.pause\(\)/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound\s*\{[^}]*bottom:\s*max\(68px,\s*env\(safe-area-inset-bottom\)\)/);
});
