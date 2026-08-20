import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  discoverEpisodeDrop,
  ensureLibraryEpisodes,
  findJobForSlug,
  loadSeedCatalog,
  matchesEpisodeSlug,
  seedJobRecord
} from "../src/episode-import.mjs";
import { createGrokFactoryQueue } from "../src/grok-factory-queue.mjs";
import { shortStatus, shortThumbnail } from "../public/shorts-ui.mjs";

test("seed catalog names playground-cistern and refuge-floor", async () => {
  const catalog = await loadSeedCatalog();
  assert.deepEqual(catalog.episodes.map((item) => item.slug), ["playground-cistern", "refuge-floor"]);
  assert.match(catalog.episodes[0].topic, /놀이터/);
  assert.match(catalog.episodes[1].topic, /중간층|피난|아파트/);
  assert.equal(seedJobRecord(catalog.episodes[0]).id, "seed-playground-cistern");
  assert.equal(catalog.episodes[0].duration, 53.3);
  assert.equal(catalog.episodes[1].duration, 48.2);
  assert.equal(seedJobRecord(catalog.episodes[0]).duration, 53.3);
  assert.equal(seedJobRecord(catalog.episodes[1]).duration, 48.2);
  assert.equal(seedJobRecord(catalog.episodes[1]).provider, "grok-imagine");
  assert.ok(matchesEpisodeSlug("playground-cistern.mp4", "playground-cistern"));
  assert.ok(matchesEpisodeSlug("refuge-floor", "refuge-floor"));
});

test("empty library gets seed cards; dropped masters attach once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-lib-"));
  const jobsDir = join(root, "jobs");
  const drops = join(root, "imports");
  await mkdir(join(drops, "playground-cistern"), { recursive: true });
  await writeFile(join(drops, "playground-cistern", "master.mp4"), "cistern-master");
  await writeFile(join(drops, "refuge-floor.mp4"), "refuge-master");
  const first = await ensureLibraryEpisodes({
    root,
    jobsDir,
    workspaceDir: root,
    extraRoots: [drops]
  });
  assert.deepEqual(first.jobs.map((job) => job.slug).sort(), ["playground-cistern", "refuge-floor"]);
  assert.ok(first.seeded.includes("seed-playground-cistern"));
  assert.ok(first.imported.includes("seed-playground-cistern"));
  assert.ok(first.imported.includes("seed-refuge-floor"));
  assert.equal(findJobForSlug(first.jobs, "playground-cistern").imported, true);
  assert.ok(existsSync(join(jobsDir, "seed-playground-cistern", "master.mp4")));
  assert.equal(await readFile(join(jobsDir, "seed-refuge-floor", "final.mp4"), "utf8"), "refuge-master");

  const second = await ensureLibraryEpisodes({
    root,
    jobsDir,
    workspaceDir: root,
    extraRoots: [drops]
  });
  assert.equal(second.seeded.length, 0);
  assert.equal(second.jobs.length, 2);
  const drop = await discoverEpisodeDrop("playground-cistern", [drops]);
  assert.match(drop.master, /master\.mp4$/);
  await rm(root, { recursive: true, force: true });
});

test("imported jpg wins over 1x1 placeholder png on the card", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-thumb-"));
  const jobsDir = join(root, "jobs");
  const drops = join(root, "imports");
  await mkdir(join(drops, "playground-cistern"), { recursive: true });
  await writeFile(join(drops, "playground-cistern", "thumbnail.jpg"), "real-thumb");
  const result = await ensureLibraryEpisodes({
    root,
    jobsDir,
    workspaceDir: root,
    extraRoots: [drops]
  });
  const job = findJobForSlug(result.jobs, "playground-cistern");
  assert.ok(existsSync(join(jobsDir, job.id, "thumbnail.png")));
  assert.ok(existsSync(join(jobsDir, job.id, "thumbnail.jpg")));
  assert.equal(job.artifacts.find((item) => item.name === "thumbnail.png")?.placeholder, true);
  assert.equal(job.artifacts.find((item) => item.name === "thumbnail.png")?.width, 1);
  assert.match(shortThumbnail(job), /thumbnail\.jpg$/);
  await rm(root, { recursive: true, force: true });
});

test("serial grok queue starts one job and holds the next", async () => {
  const jobs = {
    a: { id: "a", provider: "grok-imagine", status: "queued" },
    b: { id: "b", provider: "grok-imagine", status: "queued" },
    c: { id: "c", provider: "gemini-browser", status: "queued" }
  };
  const launched = [];
  const finish = {};
  const queue = createGrokFactoryQueue({
    readJob: async (id) => jobs[id],
    updateJob: async (id, patch) => {
      jobs[id] = { ...jobs[id], ...patch };
      return jobs[id];
    },
    launch: (id) => {
      launched.push(id);
      return new Promise((resolve) => {
        finish[id] = resolve;
      });
    }
  });
  await queue.accept("a");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await queue.accept("b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(launched, ["a"]);
  assert.equal(queue.snapshot().runningId, "a");
  assert.deepEqual(queue.snapshot().waiting, ["b"]);
  assert.equal(jobs.b.status, "queued");
  assert.equal(jobs.b.queuePosition, 1);
  assert.match(jobs.b.message, /대기열 1번/);
  assert.equal(shortStatus(jobs.b).label, "대기 1");

  finish.a(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(launched, ["a", "b"]);
  assert.equal(queue.snapshot().runningId, "b");
  assert.deepEqual(queue.snapshot().waiting, []);

  const gemini = queue.accept("c");
  await Promise.resolve();
  assert.deepEqual(launched, ["a", "b", "c"]);
  finish.b(true);
  finish.c(true);
  await gemini;
});

test("studio keeps import control and seed episode copy", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const app = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(html, /id="shorts-grid"/);
  assert.match(html, /id="live-factory"/);
  assert.match(html, /id="template-overlay"/);
  assert.match(html, /id="import-library"/);
  assert.match(html, /playground-cistern/);
  assert.match(html, /refuge-floor/);
  assert.match(app, /\/api\/library\/import/);
  assert.match(app, /factoryQueue|queuePosition|이미 만든 편/);
});
