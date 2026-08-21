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

test("bindWatchFeed stops then calls onBack for letterbox and back clicks", () => {
  const videos = [fakeVideo(3)];
  const root = fakeRoot(videos);
  const backs = [];
  bindWatchFeed(root, (event) => backs.push(event.via));
  const handler = root.listeners.find((item) => item.type === "click").handler;
  handler({ target: { closest: (sel) => sel === ".watch-stage" ? {} : null }, via: "stage" });
  assert.equal(backs.length, 0);
  assert.equal(videos[0].pauseCalls, 0);
  handler({ target: { closest: (sel) => sel === ".watch-back" ? {} : null }, via: "back" });
  handler({ target: { closest: () => null }, via: "letterbox" });
  assert.deepEqual(backs, ["back", "letterbox"]);
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
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view\)/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
});
