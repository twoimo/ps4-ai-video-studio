import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT } from "./pipeline.mjs";
import {
  PROJECTS_DIR,
  listProjects,
  loadBoardState,
  safeMediaPath,
  safeProjectDir
} from "./backlot-state.mjs";

const UI_DIR = join(ROOT, "public", "backlot");
const THUMB_CACHE_DIR = join(ROOT, "workspace", ".backlot", "thumbs");
const THUMB_WIDTHS = [320, 640, 960];
const SSE_HEARTBEAT_SECONDS = 15;
const IGNORE_PARTS = new Set(["node_modules", ".git", "__pycache__", ".cache"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

export function backlotHealth() {
  return { ok: true, app: "backlot" };
}

class ChangeHub {
  constructor() {
    this.subscribers = new Map();
  }

  subscribe(projectId = null) {
    const handle = { q: [], waiters: [], projectId };
    this.subscribers.set(handle, projectId);
    return handle;
  }

  unsubscribe(handle) {
    this.subscribers.delete(handle);
  }

  publish(projectId) {
    for (const [handle, only] of this.subscribers) {
      if (only != null && only !== projectId) continue;
      if (handle.waiters.length) handle.waiters.shift()(projectId);
      else if (handle.q.length < 64) handle.q.push(projectId);
    }
  }

  async take(handle, timeoutMs) {
    if (handle.q.length) return handle.q.shift();
    return await new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        const index = handle.waiters.indexOf(onValue);
        if (index >= 0) handle.waiters.splice(index, 1);
        resolveWait(undefined);
      }, timeoutMs);
      const onValue = (value) => {
        clearTimeout(timer);
        resolveWait(value);
      };
      handle.waiters.push(onValue);
    });
  }
}

export const hub = new ChangeHub();
const summaryCache = new Map();

function invalidateSummary(projectId) {
  summaryCache.delete(projectId);
}

function projectOfChange(pathStr) {
  const norm = String(pathStr || "").replace(/\\/g, "/");
  const root = resolve(PROJECTS_DIR).replace(/\\/g, "/");
  if (!norm.includes(root) && !norm.startsWith("workspace/jobs") && !/^[A-Za-z0-9._-]+(\/|$)/.test(norm)) {
    const first = norm.split("/").filter(Boolean)[0];
    return first || null;
  }
  const rel = norm.startsWith(root) ? norm.slice(root.length).replace(/^[/\\]/, "") : norm;
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || IGNORE_PARTS.has(parts[0])) return null;
  if (parts.some((part) => IGNORE_PARTS.has(part))) return null;
  return parts[0];
}

async function cachedSummaries() {
  const fresh = await listProjects(PROJECTS_DIR);
  for (const summary of fresh) summaryCache.set(summary.project_id, summary);
  return fresh;
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function errorJson(message, status) {
  return json({ error: message, detail: message }, status);
}

async function runFfmpeg(args) {
  return await new Promise((resolvePromise) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => resolvePromise(false));
    child.on("exit", (code) => resolvePromise(code === 0));
  });
}

async function thumbnailFor(source, width) {
  const suffix = extname(source).toLowerCase();
  const isImage = IMAGE_EXT.has(suffix);
  const isVideo = VIDEO_EXT.has(suffix);
  if (!isImage && !isVideo) return null;
  try {
    const info = await Bun.file(source).stat();
    const key = createHash("sha1")
      .update(`${source}|${info.mtimeMs}|${info.size}|${width}`)
      .digest("hex")
      .slice(0, 20);
    mkdirSync(THUMB_CACHE_DIR, { recursive: true });
    const cached = join(THUMB_CACHE_DIR, `${key}.jpg`);
    if (existsSync(cached)) return cached;
    const tmp = join(THUMB_CACHE_DIR, `${key}.${randomUUID().slice(0, 8)}.tmp.jpg`);
    const ok = isVideo
      ? await runFfmpeg(["-y", "-loglevel", "error", "-ss", "1.5", "-i", source, "-frames:v", "1", "-vf", `scale=${width}:-2`, tmp])
      : await runFfmpeg(["-y", "-loglevel", "error", "-i", source, "-frames:v", "1", "-vf", `scale=${width}:-2`, tmp]);
    if (!ok || !existsSync(tmp)) return null;
    await Bun.write(cached, Bun.file(tmp));
    try { await Bun.file(tmp).unlink?.(); } catch { /* tmp leftover is fine */ }
    return cached;
  } catch {
    return null;
  }
}

function contentType(path) {
  const ext = extname(path).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
  }[ext] || "application/octet-stream";
}

async function uiHtml(name, assets) {
  let html = await readFile(join(UI_DIR, name), "utf8");
  for (const asset of assets) {
    const path = join(UI_DIR, "ui", asset.replace(/^ui\//, ""));
    const file = existsSync(path) ? path : join(UI_DIR, asset);
    if (existsSync(file)) {
      const version = String(Math.floor(statSync(file).mtimeMs / 1000));
      const cacheBust = `/backlot/ui/${asset}?v=${version}`;
      if (html.includes(`/backlot/ui/${asset}`)) {
        html = html.replaceAll(`/backlot/ui/${asset}`, cacheBust);
      } else {
        html = html.replaceAll(`/ui/${asset}`, cacheBust);
      }
    }
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
  });
}

function sseResponse(stream) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}

async function projectStamp(projectId) {
  if (!projectId) return "";
  try {
    const state = await loadBoardState(safeProjectDir(projectId));
    return `${state.last_activity || 0}:${state.stages.map((stage) => stage.status).join(",")}:${state.media.renders.length}`;
  } catch {
    return "";
  }
}

function eventStream(filterId) {
  const encoder = new TextEncoder();
  const handle = hub.subscribe(filterId);
  let closed = false;
  return sseResponse(new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        try { controller.enqueue(encoder.encode(sse(payload))); }
        catch { closed = true; }
      };
      send(filterId ? { type: "hello", project_id: filterId } : { type: "hello" });
      let stamp = filterId ? await projectStamp(filterId) : "";
      while (!closed) {
        const changed = await hub.take(handle, SSE_HEARTBEAT_SECONDS * 1000);
        if (closed) break;
        if (changed === undefined) {
          send({ type: "heartbeat", ts: Date.now() / 1000 });
          if (filterId) {
            const next = await projectStamp(filterId);
            if (next && next !== stamp) {
              stamp = next;
              send({ type: "change", project_id: filterId });
            }
          }
          continue;
        }
        while (handle.q.length) handle.q.shift();
        send({ type: "change", project_id: changed });
      }
      hub.unsubscribe(handle);
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() {
      closed = true;
      hub.unsubscribe(handle);
    }
  }));
}

export async function handleBacklotApi(request, url) {
  const path = url.pathname;
  if (path === "/api/projects" && request.method === "GET") {
    return json(await cachedSummaries());
  }
  const stateMatch = path.match(/^\/api\/project\/([^/]+)\/state$/);
  if (stateMatch && request.method === "GET") {
    try {
      const projectDir = safeProjectDir(decodeURIComponent(stateMatch[1]));
      return json(await loadBoardState(projectDir));
    } catch (error) {
      return errorJson(error.message, error.status || 400);
    }
  }
  const eventsMatch = path.match(/^\/api\/project\/([^/]+)\/events$/);
  if (eventsMatch && request.method === "GET") {
    try {
      const projectId = decodeURIComponent(eventsMatch[1]);
      safeProjectDir(projectId);
      return eventStream(projectId);
    } catch (error) {
      return errorJson(error.message, error.status || 400);
    }
  }
  if (path === "/api/library/events" && request.method === "GET") {
    return eventStream(null);
  }
  return null;
}

export async function handleBacklotMedia(request, url) {
  const thumbMatch = url.pathname.match(/^\/thumb\/([^/]+)\/(.+)$/);
  if (thumbMatch && request.method === "GET") {
    try {
      const projectDir = safeProjectDir(decodeURIComponent(thumbMatch[1]));
      const target = safeMediaPath(projectDir, decodeURIComponent(thumbMatch[2]));
      if (!existsSync(target)) return errorJson("media not found", 404);
      const requested = Number(url.searchParams.get("w") || 640);
      const width = THUMB_WIDTHS.reduce((best, item) => Math.abs(item - requested) < Math.abs(best - requested) ? item : best, THUMB_WIDTHS[0]);
      const cached = await thumbnailFor(target, width);
      if (!cached) {
        if (VIDEO_EXT.has(extname(target).toLowerCase())) return errorJson("no poster frame available", 404);
        return new Response(Bun.file(target), { headers: { "content-type": contentType(target), "cache-control": "no-cache" } });
      }
      return new Response(Bun.file(cached), { headers: { "content-type": "image/jpeg", "cache-control": "no-cache" } });
    } catch (error) {
      return errorJson(error.message, error.status || 400);
    }
  }
  const mediaMatch = url.pathname.match(/^\/media\/([^/]+)\/(.+)$/);
  if (mediaMatch && request.method === "GET") {
    try {
      const projectDir = safeProjectDir(decodeURIComponent(mediaMatch[1]));
      const target = safeMediaPath(projectDir, decodeURIComponent(mediaMatch[2]));
      if (!existsSync(target)) return errorJson("media not found", 404);
      return new Response(Bun.file(target), { headers: { "content-type": contentType(target), "cache-control": "no-cache" } });
    } catch (error) {
      return errorJson(error.message, error.status || 400);
    }
  }
  return null;
}

export async function handleBacklotPage(request, url) {
  if (request.method !== "GET") return null;
  if (url.pathname === "/backlot" || url.pathname === "/backlot/") {
    return uiHtml("index.html", ["board.css", "library.js"]);
  }
  if (/^\/(?:backlot\/)?p\/[^/]+\/?$/.test(url.pathname)) {
    return uiHtml("board.html", ["board.css", "board.js", "materials.js"]);
  }
  return null;
}

export async function handleBacklot(request, url) {
  return await handleBacklotApi(request, url)
    || await handleBacklotMedia(request, url)
    || await handleBacklotPage(request, url);
}

export function notifyProjectChange(projectId) {
  if (!projectId) return;
  invalidateSummary(projectId);
  hub.publish(projectId);
}

export function startBacklotWatcher(root = PROJECTS_DIR) {
  if (!existsSync(root)) return null;
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      const projectId = projectOfChange(filename || "");
      if (projectId) notifyProjectChange(projectId);
    });
    watcher.on?.("error", () => {});
    return watcher;
  } catch {
    return null;
  }
}

export function startBacklotPoll(ms = 4000) {
  return setInterval(() => {
    notifyProjectChange("*");
    for (const handle of hub.subscribers.keys()) {
      if (handle.projectId) notifyProjectChange(handle.projectId);
    }
  }, ms);
}

startBacklotWatcher();
