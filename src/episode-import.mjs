import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { ROOT, WORKSPACE_DIR, JOBS_DIR, listJobs, writeJob } from "./pipeline.mjs";
import { PROVIDER_ID as GROK_IMAGINE_PROVIDER } from "./grok-imagine-factory.mjs";

const SEED_PATH = join(ROOT, "data", "seed-episodes.json");
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function mediaUrl(jobId, name) {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
}

export async function loadSeedCatalog(catalogPath = SEED_PATH) {
  return JSON.parse(await readFile(catalogPath, "utf8"));
}

export function episodeJobId(episode) {
  return episode.id || `seed-${episode.slug}`;
}

export function matchesEpisodeSlug(name = "", slug = "") {
  const normalized = String(name).toLowerCase();
  const key = String(slug).toLowerCase();
  return normalized === key || normalized.startsWith(`${key}.`) || normalized.startsWith(`${key}-`) || normalized.startsWith(`${key}_`);
}

function artifact(jobId, name, kind, extra = {}) {
  return { name, kind, url: mediaUrl(jobId, name), ...extra };
}

const PLACEHOLDER_THUMB = { placeholder: true, width: 1, height: 1, bytes: PLACEHOLDER_PNG.length };

export function findJobForSlug(jobs, slug) {
  return (jobs || []).find((job) => job.slug === slug || job.id === slug || job.id === `seed-${slug}` || job.id?.endsWith(`-${slug}`));
}

export function dropRootsFromCatalog(catalog, root = ROOT, workspaceDir = WORKSPACE_DIR) {
  const listed = Array.isArray(catalog.dropRoots) ? catalog.dropRoots : [];
  return [
    ...listed.map((item) => resolve(root, item)),
    join(workspaceDir, "imports"),
    join(workspaceDir, "masters"),
    join(workspaceDir, "episodes"),
    join(root, "fixtures", "episodes")
  ].filter((path, index, all) => all.indexOf(path) === index);
}

export async function discoverEpisodeDrop(slug, roots = []) {
  const found = { slug, master: "", thumbnail: "", captions: "", files: [] };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!matchesEpisodeSlug(entry.name, slug)) continue;
      const path = join(root, entry.name);
      if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(extension) && !found.master) found.master = path;
        if (IMAGE_EXTENSIONS.has(extension) && !found.thumbnail) found.thumbnail = path;
        found.files.push(path);
      } else if (entry.isDirectory()) {
        const nested = await readdir(path);
        for (const name of nested) {
          const nestedPath = join(path, name);
          const extension = extname(name).toLowerCase();
          const base = basename(name, extension).toLowerCase();
          if (VIDEO_EXTENSIONS.has(extension) && (base === "master" || base === "final" || base === "chat" || !found.master)) {
            if (base === "master" || base === "final" || !found.master) found.master = nestedPath;
          }
          if (IMAGE_EXTENSIONS.has(extension) && (base === "thumbnail" || base.startsWith("thumb") || !found.thumbnail)) {
            found.thumbnail = nestedPath;
          }
          if (name === "captions.ass" || name === "captions.srt") found.captions = nestedPath;
          found.files.push(nestedPath);
        }
      }
    }
  }
  return found;
}

export function seedJobRecord(episode, { hasMaster = false } = {}) {
  const id = episodeJobId(episode);
  const now = new Date().toISOString();
  const artifacts = [artifact(id, "thumbnail.png", "thumbnail", PLACEHOLDER_THUMB)];
  if (hasMaster) {
    artifacts.unshift(
      artifact(id, "master.mp4", "master-video"),
      artifact(id, "final.mp4", "video"),
      artifact(id, "chat.mp4", "chat-video")
    );
  }
  return {
    id,
    slug: episode.slug,
    topic: episode.topic,
    facts: episode.facts || [],
    format: "vertical",
    provider: GROK_IMAGINE_PROVIDER,
    clipCount: 7,
    captions: true,
    voiceover: false,
    worldSlots: {},
    sources: [],
    targetDurationSec: episode.duration || 70,
    duration: episode.duration || 70,
    status: "completed",
    stage: "완료",
    progress: 100,
    message: hasMaster ? "가져온 마스터를 라이브러리에 올렸습니다." : "시드 카드 · 마스터를 workspace/imports에 두면 이 칸에 붙습니다.",
    warnings: [],
    artifacts,
    seed: true,
    imported: hasMaster,
    origin: hasMaster ? "import" : "seed",
    createdAt: now,
    updatedAt: now
  };
}

async function writePlaceholderThumbnail(jobDir) {
  const path = join(jobDir, "thumbnail.png");
  if (!existsSync(path)) await writeFile(path, PLACEHOLDER_PNG);
  return path;
}

async function attachDropFiles(job, drop, jobsDir) {
  const jobDir = join(jobsDir, job.id);
  await mkdir(jobDir, { recursive: true });
  const artifacts = [...(job.artifacts || [])];
  const add = (name, kind, extra = {}) => {
    const existing = artifacts.find((item) => item.name === name);
    if (existing) Object.assign(existing, extra);
    else artifacts.push(artifact(job.id, name, kind, extra));
  };
  if (drop.master && existsSync(drop.master)) {
    await copyFile(drop.master, join(jobDir, "master.mp4"));
    await copyFile(drop.master, join(jobDir, "final.mp4"));
    await copyFile(drop.master, join(jobDir, "chat.mp4"));
    add("master.mp4", "master-video");
    add("final.mp4", "video");
    add("chat.mp4", "chat-video");
    job.imported = true;
    job.origin = "import";
    job.message = "가져온 마스터를 라이브러리에 올렸습니다.";
  }
  if (drop.thumbnail && existsSync(drop.thumbnail)) {
    const extension = extname(drop.thumbnail).toLowerCase() === ".png" ? "thumbnail.png" : "thumbnail.jpg";
    await copyFile(drop.thumbnail, join(jobDir, extension));
    if (extension === "thumbnail.png") {
      const index = artifacts.findIndex((item) => item.name === "thumbnail.png");
      const real = artifact(job.id, "thumbnail.png", "thumbnail");
      if (index >= 0) artifacts[index] = real;
      else artifacts.push(real);
    } else {
      add(extension, "thumbnail");
      add("thumbnail.png", "thumbnail", PLACEHOLDER_THUMB);
    }
  } else {
    await writePlaceholderThumbnail(jobDir);
    add("thumbnail.png", "thumbnail", PLACEHOLDER_THUMB);
  }
  if (drop.captions && existsSync(drop.captions)) {
    const name = basename(drop.captions);
    await copyFile(drop.captions, join(jobDir, name));
    add(name, name.endsWith(".ass") ? "captions-ass" : "captions");
  }
  job.artifacts = artifacts;
  job.status = "completed";
  job.stage = "완료";
  job.progress = 100;
  return job;
}

export async function ensureLibraryEpisodes({
  root = ROOT,
  jobsDir = JOBS_DIR,
  workspaceDir = WORKSPACE_DIR,
  catalogPath = SEED_PATH,
  extraRoots = [],
  write = writeJob,
  list = listJobs
} = {}) {
  await mkdir(jobsDir, { recursive: true });
  await mkdir(join(workspaceDir, "imports"), { recursive: true });
  await mkdir(join(workspaceDir, "masters"), { recursive: true });
  await mkdir(join(workspaceDir, "episodes"), { recursive: true });
  const catalog = await loadSeedCatalog(catalogPath);
  const roots = [...dropRootsFromCatalog(catalog, root, workspaceDir), ...extraRoots];
  const existing = jobsDir === JOBS_DIR
    ? await list()
    : await listJobsFrom(jobsDir);
  const seeded = [];
  const imported = [];
  const jobs = [];
  for (const episode of catalog.episodes || []) {
    const drop = await discoverEpisodeDrop(episode.slug, roots);
    let job = findJobForSlug(existing, episode.slug);
    let dirty = false;
    if (!job) {
      job = seedJobRecord(episode, { hasMaster: Boolean(drop.master) });
      const jobDir = join(jobsDir, job.id);
      await mkdir(jobDir, { recursive: true });
      await writePlaceholderThumbnail(jobDir);
      seeded.push(job.id);
      dirty = true;
    }
    if (drop.master || drop.thumbnail) {
      const hadMasterFile = existsSync(join(jobsDir, job.id, "master.mp4"));
      job = await attachDropFiles(job, drop, jobsDir);
      if (drop.master && !hadMasterFile) imported.push(job.id);
      dirty = true;
    } else if (!existsSync(join(jobsDir, job.id, "thumbnail.png")) && !existsSync(join(jobsDir, job.id, "thumbnail.jpg"))) {
      await writePlaceholderThumbnail(join(jobsDir, job.id));
      dirty = true;
    }
    job.slug = episode.slug;
    if (dirty) {
      if (jobsDir === JOBS_DIR) await write(job);
      else await writeJobTo(jobsDir, job);
    }
    jobs.push(job);
  }
  return { jobs, seeded, imported, catalog };
}

async function listJobsFrom(jobsDir) {
  const entries = await readdir(jobsDir, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      jobs.push(JSON.parse(await readFile(join(jobsDir, entry.name, "job.json"), "utf8")));
    } catch {
      // Skip incomplete job folders.
    }
  }
  return jobs;
}

async function writeJobTo(jobsDir, job) {
  const dir = join(jobsDir, job.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.json"), JSON.stringify(job, null, 2));
  return job;
}
