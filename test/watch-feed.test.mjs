import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bindWatchFeed, playWatchFeed, stopWatchFeed, syncWatchFeed } from "../public/watch-feed.mjs";

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

test("watch hash uses #watch/ and close is × top-right", async () => {
  const app = await readFile(join(process.cwd(), "public/app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public/styles.css"), "utf8");
  assert.match(app, /#watch\/\$\{/);
  assert.match(app, /hash\.startsWith\("watch\/"\)/);
  assert.match(app, /replaceWatchHash/);
  assert.match(app, /history\.replaceState\(null, "", next\)/);
  assert.match(app, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(css, /\.watch-close[\s\S]*top:\s*12px/);
  assert.match(css, /\.watch-close[\s\S]*right:\s*12px/);
  assert.match(css, /\.watch-dl\s*\{[^}]*top:\s*64px/);
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
  assert.match(feed, /surface !== "watch"\) stopWatchFeed\(root\)/);
  assert.match(feed, /export function bindWatchFeed/);
  assert.match(feed, /stopWatchFeed\(root\);\s*onBack\?\.\(event\)/);
  assert.match(feed, /watch-open[\s\S]*playWatchFeed[\s\S]*stopWatchFeed\(root\)/);
  assert.match(feed, /\.watch-close, \.watch-back/);
  assert.equal(feed.includes("letterbox"), false);
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view\)/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
  assert.match(app, /pagehide/);
  assert.match(app, /aria-valuenow/);
  assert.match(app, /Math\.abs\(dy\) > 50/);
  assert.match(app, /preload = "auto"/);
  assert.match(app, /class="watch-dl"/);
});
