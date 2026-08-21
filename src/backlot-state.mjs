import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { JOBS_DIR, ROOT, readJob } from "./pipeline.mjs";
import { reduceFactoryStages, reduceLiveShots } from "./grok-imagine-live.mjs";
import { readRunEvents } from "./run-ledger.mjs";

export const PROJECTS_DIR = JOBS_DIR;
export const REPO_ROOT = ROOT;

export const MEDIA_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
export const MEDIA_VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
export const MEDIA_AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
export const SCAN_EXCLUDE = new Set(["node_modules", ".git", "__pycache__", "history", ".cache"]);

export const FALLBACK_STAGES = [
  "research", "proposal", "idea", "script", "scene_plan",
  "assets", "edit", "compose", "publish"
];

export const STUDIO_RAIL = [
  { name: "script", gated: false, produces: ["script"], liveIds: ["plan"] },
  { name: "hook-lock", gated: false, produces: [], liveIds: ["hook-lock"] },
  { name: "image-edit", gated: false, produces: [], liveIds: ["image-edit", "still-qa"] },
  { name: "animate", gated: false, produces: [], liveIds: ["animate", "clip-qa"] },
  { name: "compose", gated: false, produces: ["render_report"], liveIds: ["tts-mix", "captions", "compose", "parts"] }
];

export const LIVE_WINDOW_SECONDS = 5 * 60;
export const STALL_WINDOW_SECONDS = 10 * 60;

export const ARTIFACT_FILES = {
  research_brief: "research_brief.json",
  brief: "brief.json",
  proposal_packet: "proposal_packet.json",
  script: "script.json",
  scene_plan: "scene_plan.json",
  asset_manifest: "asset_manifest.json",
  edit_decisions: "edit_decisions.json",
  render_report: "render_report.json",
  final_review: "final_review.json",
  publish_log: "publish_log.json",
  decision_log: "decision_log.json"
};

function readJson(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function readJsonAny(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function rel(projectDir, path) {
  try {
    return relative(resolve(projectDir), resolve(path)).split(sep).join("/");
  } catch {
    return basename(path);
  }
}

function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function isSafeProjectId(projectId) {
  const id = String(projectId || "");
  if (!id || id === "." || id === "..") return false;
  if (/[/\\:]/.test(id)) return false;
  return true;
}

export function safeProjectDir(projectId, projectsDir = PROJECTS_DIR) {
  if (!isSafeProjectId(projectId)) {
    const error = new Error("invalid project id");
    error.status = 400;
    throw error;
  }
  const projectDir = resolve(projectsDir, projectId);
  const root = resolve(projectsDir);
  if (!(projectDir === root || projectDir.startsWith(`${root}${sep}`))) {
    const error = new Error("invalid project id");
    error.status = 400;
    throw error;
  }
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    const error = new Error(`unknown project: ${projectId}`);
    error.status = 404;
    throw error;
  }
  return projectDir;
}

export function safeMediaPath(projectDir, filePath) {
  const target = resolve(projectDir, filePath);
  const root = resolve(projectDir);
  if (!(target === root || target.startsWith(`${root}${sep}`))) {
    const error = new Error("path escapes project");
    error.status = 403;
    throw error;
  }
  return target;
}

function collectCheckpoints(projectDir) {
  const out = {};
  for (const entry of listFiles(projectDir)) {
    if (!entry.isFile() || !entry.name.startsWith("checkpoint_") || !entry.name.endsWith(".json")) continue;
    const stage = entry.name.slice("checkpoint_".length, -".json".length);
    const data = readJson(join(projectDir, entry.name));
    if (data) {
      data._mtime = fileStat(join(projectDir, entry.name))?.mtimeMs / 1000 || 0;
      out[stage] = data;
    }
  }
  return out;
}

function collectHistory(projectDir) {
  const historyDir = join(projectDir, "history");
  const out = {};
  for (const entry of listFiles(historyDir)) {
    if (!entry.isFile() || !entry.name.startsWith("checkpoint_") || !entry.name.endsWith(".json")) continue;
    const stem = entry.name.slice(0, -".json".length);
    const match = /^checkpoint_(.+?)_\d/.exec(stem);
    const stage = match ? match[1] : stem.slice("checkpoint_".length);
    const data = readJson(join(historyDir, entry.name));
    if (data) {
      if (!out[stage]) out[stage] = [];
      out[stage].push(data);
    }
  }
  return out;
}

function loadPipelineMeta(pipelineType) {
  return {
    pipeline_type: pipelineType || "unknown",
    stages: FALLBACK_STAGES.map((name) => ({ name, gated: false, produces: [] })),
    known: false
  };
}

function resolveArtifact(projectDir, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value) {
    const path = value.startsWith("/") ? value : join(projectDir, value);
    try {
      const resolved = resolve(path);
      if (!resolved.startsWith(`${resolve(projectDir)}${sep}`)) return null;
      return readJson(resolved);
    } catch {
      return null;
    }
  }
  return null;
}

function buildStageRail(pipelineMeta, checkpoints, history) {
  const rail = [];
  const manifestNames = new Set(pipelineMeta.stages.map((stage) => stage.name));
  for (const stageDef of pipelineMeta.stages) {
    const name = stageDef.name;
    const cp = checkpoints[name];
    const versions = history[name] || [];
    const status = cp?.status || "pending";
    const entry = {
      name,
      gated: Boolean(stageDef.gated),
      produces: [...(stageDef.produces || [])],
      status: status || "pending",
      timestamp: cp?.timestamp ?? null,
      review: cp?.review ?? null,
      cost_snapshot: cp?.cost_snapshot ?? null,
      error: cp?.error ?? null,
      human_approved: cp?.human_approved ?? null,
      partial_progress: cp?.metadata?.partial_progress ?? null,
      versions: versions.length + (cp ? 1 : 0),
      history_entries: [
        ...versions.map((item) => ({ status: item.status, timestamp: item.timestamp })),
        ...(cp ? [{ status: cp.status, timestamp: cp.timestamp }] : [])
      ]
    };
    if (stageDef.gated && cp && cp.status === "completed") {
      const sawWait = versions.some((item) => item.status === "awaiting_human");
      entry.gate_skipped = !(sawWait || Boolean(cp.human_approved));
    }
    rail.push(entry);
  }
  const canon = Object.fromEntries(FALLBACK_STAGES.map((name, index) => [name, index]));
  for (const [name, cp] of Object.entries(checkpoints)) {
    if (manifestNames.has(name)) continue;
    const entry = {
      name,
      gated: false,
      produces: Object.keys(cp.artifacts || {}).filter((item) => typeof item === "string"),
      status: cp.status || "unknown",
      timestamp: cp.timestamp ?? null,
      review: cp.review ?? null,
      cost_snapshot: cp.cost_snapshot ?? null,
      error: cp.error ?? null,
      human_approved: cp.human_approved ?? null,
      partial_progress: null,
      versions: 1 + (history[name] || []).length,
      undeclared: true,
      history_entries: [
        ...(history[name] || []).map((item) => ({ status: item.status, timestamp: item.timestamp })),
        { status: cp.status, timestamp: cp.timestamp }
      ]
    };
    const pos = canon[name];
    if (pos == null) {
      rail.push(entry);
      continue;
    }
    let insertAt = rail.length;
    for (let i = 0; i < rail.length; i += 1) {
      const existingPos = canon[rail[i].name];
      if (existingPos != null && existingPos > pos) {
        insertAt = i;
        break;
      }
    }
    rail.splice(insertAt, 0, entry);
  }
  return rail;
}

function collectArtifacts(projectDir, checkpoints) {
  const artifacts = {};
  const artDir = join(projectDir, "artifacts");
  for (const [name, filename] of Object.entries(ARTIFACT_FILES)) {
    const data = readJson(join(artDir, filename));
    if (data) artifacts[name] = data;
  }
  if (!artifacts.decision_log) {
    const data = readJson(join(projectDir, "decision_log.json"));
    if (data) artifacts.decision_log = data;
  }
  for (const cp of Object.values(checkpoints)) {
    for (const [name, value] of Object.entries(cp.artifacts || {})) {
      if (artifacts[name]) continue;
      const resolved = resolveArtifact(projectDir, value);
      if (resolved) artifacts[name] = resolved;
    }
  }
  return artifacts;
}

function resolveAssetPath(projectDir, rawPath) {
  if (!rawPath) return null;
  const candidates = [];
  if (rawPath.startsWith("/")) candidates.push(rawPath);
  else {
    candidates.push(join(projectDir, rawPath));
    candidates.push(join(REPO_ROOT, rawPath));
    const parts = rawPath.split("/");
    if (parts[0] === "projects" && parts.length > 2) {
      candidates.push(join(projectDir, "..", ...parts.slice(1)));
    }
  }
  for (const candidate of candidates) {
    const info = fileStat(candidate);
    if (info?.isFile()) return candidate;
  }
  return null;
}

function assetEntry(projectDir, asset) {
  const rawPath = asset.path || "";
  let resolved = resolveAssetPath(projectDir, rawPath);
  if (resolved) {
    try {
      const inside = resolve(resolved).startsWith(`${resolve(projectDir)}${sep}`);
      if (!inside) resolved = null;
    } catch {
      resolved = null;
    }
  }
  const filePath = resolved || join(projectDir, rawPath);
  const exists = Boolean(resolved);
  let kind = asset.type || "";
  const ext = extname(filePath).toLowerCase();
  if (!kind && ext) {
    if (MEDIA_IMAGE_EXT.has(ext)) kind = "image";
    else if (MEDIA_VIDEO_EXT.has(ext)) kind = "video";
    else if (MEDIA_AUDIO_EXT.has(ext)) kind = "audio";
  }
  const renderable = exists && (MEDIA_IMAGE_EXT.has(ext) || MEDIA_VIDEO_EXT.has(ext));
  return {
    id: asset.id,
    type: kind,
    scene_id: asset.scene_id,
    path: exists ? rel(projectDir, filePath) : rawPath,
    exists,
    renderable,
    prompt: asset.prompt,
    model: asset.model,
    source_tool: asset.source_tool,
    provider: asset.provider,
    cost_usd: asset.cost_usd,
    quality_score: asset.quality_score,
    duration_seconds: asset.duration_seconds,
    resolution: asset.resolution
  };
}

function findSceneSnapshot(projectDir, sceneId) {
  const snapDir = join(projectDir, "snapshots");
  if (!sceneId) return null;
  for (const entry of listFiles(snapDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !MEDIA_IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue;
    const stem = entry.name.replace(/\.[^.]+$/, "");
    if (stem === sceneId || stem.startsWith(`${sceneId}_`)) {
      return {
        id: `snap_${sceneId}`,
        type: "image",
        scene_id: sceneId,
        path: rel(projectDir, join(snapDir, entry.name)),
        exists: true,
        renderable: true,
        snapshot: true
      };
    }
  }
  return null;
}

function findScriptSection(scene, sections) {
  const sid = scene.script_section_id;
  if (sid) {
    const match = sections.find((item) => item.id === sid);
    if (match) return match;
  }
  const start = scene.start_seconds;
  const end = scene.end_seconds;
  if (start == null || end == null) return null;
  let best = null;
  let bestOverlap = 0;
  for (const section of sections) {
    if (section.start_seconds == null || section.end_seconds == null) continue;
    const overlap = Math.min(end, section.end_seconds) - Math.max(start, section.start_seconds);
    if (overlap > bestOverlap) {
      best = section;
      bestOverlap = overlap;
    }
  }
  return best;
}

function sceneKey(value) {
  return value != null ? String(value) : "";
}

function buildStoryboard(projectDir, artifacts, events) {
  const scenePlan = artifacts.scene_plan;
  if (!scenePlan || !Array.isArray(scenePlan.scenes)) return null;
  const sections = artifacts.script?.sections || [];
  const manifestAssets = artifacts.asset_manifest?.assets || [];
  const assetsByScene = {};
  for (const asset of manifestAssets) {
    if (!asset || typeof asset !== "object") continue;
    const entry = assetEntry(projectDir, asset);
    const key = sceneKey(entry.scene_id);
    if (!assetsByScene[key]) assetsByScene[key] = [];
    assetsByScene[key].push(entry);
  }
  const generating = {};
  for (const ev of events) {
    if (ev.scene_id == null || ev.depth) continue;
    const sid = sceneKey(ev.scene_id);
    if (ev.event === "start") generating[sid] = ev;
    else if (ev.event === "finish" || ev.event === "error") delete generating[sid];
  }
  const cards = [];
  for (const scene of scenePlan.scenes) {
    if (!scene || typeof scene !== "object") continue;
    const sid = sceneKey(scene.id);
    const section = findScriptSection(scene, sections);
    const sceneAssets = assetsByScene[sid] || [];
    const visuals = sceneAssets.filter((item) => ["image", "video", "diagram", "animation"].includes(item.type));
    const audio = sceneAssets.filter((item) => ["audio", "narration", "music", "sfx"].includes(item.type));
    const renderable = visuals.filter((item) => item.renderable);
    const missing = visuals.filter((item) => !item.exists && ["image", "video", "diagram"].includes(item.type));
    const activeVisual = renderable.at(-1) || missing.at(-1) || findSceneSnapshot(projectDir, sid);
    cards.push({
      id: sid,
      type: scene.type,
      description: scene.description,
      start_seconds: scene.start_seconds,
      end_seconds: scene.end_seconds,
      duration_seconds: scene.end_seconds != null && scene.start_seconds != null
        ? Math.max(0, scene.end_seconds - scene.start_seconds)
        : null,
      hero_moment: Boolean(scene.hero_moment),
      shot_language: scene.shot_language,
      shot_intent: scene.shot_intent,
      framing: scene.framing,
      movement: scene.movement,
      narration: section?.text,
      section_label: section?.label,
      required_assets: scene.required_assets || [],
      visual: activeVisual,
      takes: renderable,
      audio,
      generating: Boolean(generating[sid]),
      generating_tool: generating[sid]?.tool
    });
  }
  let total = scenePlan.metadata?.total_duration_seconds;
  if (total == null && cards.length) {
    const ends = cards.map((card) => card.end_seconds).filter((value) => value != null);
    total = ends.length ? Math.max(...ends) : null;
  }
  return {
    scenes: cards,
    total_duration_seconds: total,
    style_playbook: scenePlan.style_playbook
  };
}

function scanMedia(projectDir) {
  const renders = [];
  const snapshots = [];
  const music = [];
  const rendersDir = join(projectDir, "renders");
  for (const entry of listFiles(rendersDir)) {
    const path = join(rendersDir, entry.name);
    if (entry.isFile() && MEDIA_VIDEO_EXT.has(extname(entry.name).toLowerCase())) {
      const info = fileStat(path);
      renders.push({ path: rel(projectDir, path), size: info?.size || 0, mtime: (info?.mtimeMs || 0) / 1000 });
    }
  }
  for (const entry of listFiles(projectDir)) {
    const path = join(projectDir, entry.name);
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() === ".mp4") {
      const info = fileStat(path);
      renders.push({ path: rel(projectDir, path), size: info?.size || 0, mtime: (info?.mtimeMs || 0) / 1000, at_root: true });
    }
    if (extname(entry.name).toLowerCase() === ".mp3") {
      music.push({ path: rel(projectDir, path), at_root: true });
    }
  }
  const musicDir = join(projectDir, "assets", "music");
  for (const entry of listFiles(musicDir)) {
    if (MEDIA_AUDIO_EXT.has(extname(entry.name).toLowerCase())) {
      music.push({ path: rel(projectDir, join(musicDir, entry.name)) });
    }
  }
  for (const dirname of ["snapshots", "verify", "factory/proof", "factory/stills"]) {
    const dir = join(projectDir, dirname);
    for (const entry of listFiles(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile() && MEDIA_IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
        snapshots.push({ path: rel(projectDir, path) });
      }
    }
  }
  renders.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { renders, snapshots, music };
}

function findPoster(projectDir, state) {
  for (const card of state.storyboard?.scenes || []) {
    const visual = card.visual;
    if (visual?.exists && visual.type === "image") return visual.path;
  }
  if (state.media?.snapshots?.[0]) return state.media.snapshots[0].path;
  for (const relDir of ["factory/stills", "assets/images", "assets/frames", "exports", "assets", "."]) {
    const dir = relDir === "." ? projectDir : join(projectDir, relDir);
    for (const entry of listFiles(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isFile() && MEDIA_IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
        return rel(projectDir, path);
      }
    }
  }
  if (state.media?.renders?.[0]) return state.media.renders[0].path;
  return null;
}

function lastActivity(projectDir) {
  let latest = 0;
  const candidates = listFiles(projectDir)
    .filter((entry) => entry.isFile() && entry.name.startsWith("checkpoint_") && entry.name.endsWith(".json"))
    .map((entry) => join(projectDir, entry.name));
  candidates.push(join(projectDir, "events.jsonl"));
  candidates.push(join(projectDir, "job.json"));
  for (const entry of listFiles(join(projectDir, "artifacts"))) {
    if (entry.name.endsWith(".json")) candidates.push(join(projectDir, "artifacts", entry.name));
  }
  for (const path of candidates) {
    const info = fileStat(path);
    if (info) latest = Math.max(latest, info.mtimeMs / 1000);
  }
  return latest;
}

function readEventsFile(projectDir, limit = 250) {
  const path = join(projectDir, "events.jsonl");
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function mapStudioStatus(liveStatus, jobStatus, frozen) {
  if (frozen) return "failed";
  if (liveStatus === "PASS") return "completed";
  if (liveStatus === "RUN") return "in_progress";
  if (liveStatus === "FAIL") return "failed";
  if (jobStatus === "completed" && liveStatus === "WAIT") return "completed";
  if (jobStatus === "failed" && liveStatus === "WAIT") return "pending";
  return "pending";
}

function studioScriptArtifact(job, script) {
  const segments = script?.segments || [];
  const duration = Number(script?.targetDurationSec || job?.duration || segments.length * 10) || 0;
  return {
    title: script?.title || job?.topic || "",
    total_duration_seconds: duration,
    sections: segments.map((segment) => ({
      id: `sc${segment.index}`,
      label: segment.slotId || segment.role || `shot ${segment.index}`,
      text: segment.caption || segment.fact || "",
      speaker_directions: segment.camera || "",
      start_seconds: (Number(segment.index) - 1) * 10,
      end_seconds: Number(segment.index) * 10
    }))
  };
}

function studioScenePlan(script, job) {
  const segments = script?.segments || [];
  if (!segments.length) return null;
  return {
    scenes: segments.map((segment) => ({
      id: `sc${segment.index}`,
      type: segment.role || segment.slotId || "shot",
      description: segment.visualPrompt || segment.caption || job?.topic || "",
      start_seconds: (Number(segment.index) - 1) * 10,
      end_seconds: Number(segment.index) * 10,
      shot_intent: segment.camera || "",
      framing: segment.camera || "",
      movement: segment.role === "hold" ? "hold" : "documentary",
      script_section_id: `sc${segment.index}`,
      required_assets: []
    })),
    metadata: { total_duration_seconds: segments.length * 10 }
  };
}

function studioAssetManifest(projectDir, script, job) {
  const assets = [];
  const segments = script?.segments || [];
  for (const segment of segments) {
    const index = String(segment.index).padStart(2, "0");
    const still = join(projectDir, "factory", "stills", `${index}.png`);
    const clip = join(projectDir, "factory", "clips", `${index}.mp4`);
    if (fileStat(still)?.isFile()) {
      assets.push({
        id: `still-${index}`,
        type: "image",
        scene_id: `sc${segment.index}`,
        path: rel(projectDir, still),
        prompt: segment.visualPrompt || "",
        source_tool: segment.tool || "image_edit"
      });
    }
    if (fileStat(clip)?.isFile()) {
      assets.push({
        id: `clip-${index}`,
        type: "video",
        scene_id: `sc${segment.index}`,
        path: rel(projectDir, clip),
        source_tool: "image_to_video",
        duration_seconds: 10
      });
    }
  }
  for (const artifact of job?.artifacts || []) {
    const name = artifact?.name || "";
    if (!/\.(png|jpe?g|webp|mp4)$/i.test(name)) continue;
    if (assets.some((item) => item.path === name)) continue;
    const path = join(projectDir, name);
    if (!fileStat(path)?.isFile()) continue;
    const stillMatch = /factory\/stills\/(\d+)\.png$/i.exec(name);
    const clipMatch = /factory\/clips\/(\d+)\.mp4$/i.exec(name);
    const sceneId = stillMatch ? `sc${Number(stillMatch[1])}` : clipMatch ? `sc${Number(clipMatch[1])}` : null;
    assets.push({
      id: name,
      type: MEDIA_VIDEO_EXT.has(extname(name).toLowerCase()) ? "video" : "image",
      scene_id: sceneId,
      path: name,
      source_tool: artifact.kind || ""
    });
  }
  return { assets };
}

function mapStudioEvents(rawEvents = []) {
  return rawEvents.map((event) => {
    const status = event.status || "";
    const kind = status === "RUN" || event.event === "start"
      ? "start"
      : status === "FAIL" || event.type === "error" || event.event === "error"
        ? "error"
        : "finish";
    return {
      ts: event.timestamp || event.ts || event.at || null,
      event: event.event || kind,
      tool: event.stageId || event.stage || event.tool || event.type || "",
      scene_id: event.shotIndex != null ? `sc${event.shotIndex}` : event.scene_id || "",
      duration_s: event.duration_s ?? event.duration ?? null,
      cost_usd: event.cost_usd ?? null,
      success: !(status === "FAIL" || event.type === "error"),
      message: event.message || ""
    };
  }).filter((event) => event.ts || event.tool);
}

function deriveFactoryRail(job, liveEvents) {
  const live = reduceFactoryStages(liveEvents);
  const byId = Object.fromEntries(live.map((stage) => [stage.id, stage]));
  const nowIso = job?.updatedAt || new Date().toISOString();
  return STUDIO_RAIL.map((stage) => {
    const mapped = stage.liveIds.map((id) => byId[id]).filter(Boolean);
    const current = [...mapped].reverse().find((item) => item.status && item.status !== "WAIT") || mapped[0];
    let status = mapStudioStatus(current?.status, job?.status, current?.frozen || /프리즈|고정/.test(job?.message || ""));
    if (!liveEvents.length) {
      if (job?.status === "completed") status = "completed";
      else if (job?.status === "draft" && stage.name === "script") status = "completed";
      else if (job?.status === "queued" && stage.name === "script") status = "in_progress";
      else if (["running", "verifying"].includes(job?.status) && stage.name === "script") status = "completed";
      else if (job?.status === "failed" && stage.name === "script") status = "failed";
      else status = "pending";
    }
    const history = [];
    for (const item of mapped) {
      if (item.status === "RUN") history.push({ status: "in_progress", timestamp: job?.updatedAt || nowIso });
      if (item.status === "PASS") history.push({ status: "completed", timestamp: job?.updatedAt || nowIso });
      if (item.status === "FAIL") history.push({ status: "failed", timestamp: job?.updatedAt || nowIso });
    }
    if (!history.length && status !== "pending") {
      history.push({ status, timestamp: nowIso });
    }
    return {
      name: stage.name,
      gated: stage.gated,
      produces: [...stage.produces],
      status,
      timestamp: current?.status && current.status !== "WAIT" ? nowIso : null,
      review: null,
      cost_snapshot: null,
      error: status === "failed" ? (job?.error || job?.message || null) : null,
      human_approved: null,
      partial_progress: current?.shotIndex ? { completed_scene_ids: [`sc${current.shotIndex}`] } : null,
      versions: history.length || (status === "pending" ? 0 : 1),
      history_entries: history
    };
  });
}

function captionedMasterPath(projectDir, media) {
  const preferred = ["chat.mp4", "captions.mp4", "captioned.mp4", "master.mp4", "final.mp4"];
  for (const name of preferred) {
    if (fileStat(join(projectDir, name))?.isFile()) return name;
  }
  return (media.renders || []).find((item) => /chat|caption|master|final/i.test(item.path))?.path || null;
}

function scanStudioClips(projectDir, media) {
  const clipsDir = join(projectDir, "factory", "clips");
  for (const entry of listFiles(clipsDir)) {
    const path = join(clipsDir, entry.name);
    if (!entry.isFile() || !MEDIA_VIDEO_EXT.has(extname(entry.name).toLowerCase())) continue;
    const info = fileStat(path);
    const relPath = rel(projectDir, path);
    if (!media.renders.some((item) => item.path === relPath)) {
      media.renders.push({ path: relPath, size: info?.size || 0, mtime: (info?.mtimeMs || 0) / 1000 });
    }
  }
  media.renders.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

async function loadStudioOverlay(projectDir, state) {
  const job = readJson(join(projectDir, "job.json"));
  if (!job) return state;
  let liveJob = job;
  try {
    liveJob = await readJob(job.id || basename(projectDir));
  } catch {
    liveJob = job;
  }
  const script = readJson(join(projectDir, "script.json")) || readJson(join(projectDir, "artifacts", "script.json"));
  let runEvents = [];
  if (liveJob.runId) {
    try {
      runEvents = await readRunEvents(join(projectDir, "runs", liveJob.runId));
    } catch {
      runEvents = [];
    }
  }
  if (!state.events.length && runEvents.length) {
    state.events = mapStudioEvents(runEvents);
  } else if (runEvents.length) {
    state.events = [...state.events, ...mapStudioEvents(runEvents)];
  }
  if (!state.artifacts.script && (script || liveJob.topic)) {
    state.artifacts.script = studioScriptArtifact(liveJob, script || liveJob.script || {});
  }
  if (!state.artifacts.scene_plan && script?.segments) {
    state.artifacts.scene_plan = studioScenePlan(script, liveJob);
  }
  if (!state.artifacts.asset_manifest) {
    state.artifacts.asset_manifest = studioAssetManifest(projectDir, script || liveJob.script, liveJob);
  }
  if (!state.has_pipeline_state) {
    state.stages = deriveFactoryRail(liveJob, runEvents);
    state.has_pipeline_state = true;
    state.pipeline = {
      pipeline_type: liveJob.provider || "ps4-studio",
      stages: STUDIO_RAIL.map((stage) => ({ name: stage.name, gated: stage.gated, produces: stage.produces })),
      known: true
    };
  } else if (state.pipeline.pipeline_type === "unknown" && liveJob.provider) {
    state.pipeline.pipeline_type = liveJob.provider;
  }
  if (!state.title || state.title === state.project_id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())) {
    state.title = liveJob.topic || state.title;
  }
  if (!state.storyboard && state.artifacts.scene_plan) {
    state.storyboard = buildStoryboard(projectDir, state.artifacts, state.events);
  }
  if (!state.storyboard && (script?.segments || []).length) {
    const shots = reduceLiveShots(runEvents, liveJob.artifacts || []);
    const plan = studioScenePlan(script, liveJob);
    state.artifacts.scene_plan = plan;
    const manifest = studioAssetManifest(projectDir, script, liveJob);
    state.artifacts.asset_manifest = manifest;
    state.storyboard = buildStoryboard(projectDir, { ...state.artifacts, scene_plan: plan, asset_manifest: manifest }, state.events);
    if (state.storyboard) {
      for (const card of state.storyboard.scenes) {
        const index = Number(String(card.id).replace(/\D/g, ""));
        const shot = shots[index - 1];
        if (shot?.stillUrl && !card.visual) {
          const stillName = `factory/stills/${String(index).padStart(2, "0")}.png`;
          if (fileStat(join(projectDir, stillName))?.isFile()) {
            card.visual = { id: stillName, type: "image", scene_id: card.id, path: stillName, exists: true, renderable: true };
            card.takes = [card.visual];
          }
        }
      }
    }
  }
  scanStudioClips(projectDir, state.media);
  state.media.captioned_master = captionedMasterPath(projectDir, state.media);
  if (!state.created_at) state.created_at = liveJob.createdAt || null;
  if (liveJob.updatedAt) {
    const updated = Date.parse(liveJob.updatedAt) / 1000;
    if (Number.isFinite(updated)) state.last_activity = Math.max(state.last_activity || 0, updated);
  }
  return state;
}

export async function loadBoardState(projectDir) {
  try {
    const dir = resolve(projectDir);
    const projectId = basename(dir);
    const marker = readJson(join(dir, "project.json")) || {};
    const metaJson = readJson(join(dir, "meta.json")) || {};
    const checkpoints = collectCheckpoints(dir);
    const history = collectHistory(dir);
    let pipelineType = marker.pipeline_type;
    if (!pipelineType) {
      for (const cp of Object.values(checkpoints)) {
        if (cp.pipeline_type && cp.pipeline_type !== "unknown") {
          pipelineType = cp.pipeline_type;
          break;
        }
      }
    }
    const pipelineMeta = loadPipelineMeta(pipelineType);
    const artifacts = collectArtifacts(dir, checkpoints);
    let events = readEventsFile(dir, 250);
    const media = scanMedia(dir);
    const stages = buildStageRail(pipelineMeta, checkpoints, history);
    let cost = null;
    for (const cp of Object.values(checkpoints).sort((a, b) => (b._mtime || 0) - (a._mtime || 0))) {
      if (cp.cost_snapshot) {
        cost = cp.cost_snapshot;
        break;
      }
    }
    if (!cost && artifacts.asset_manifest?.total_cost_usd != null) {
      cost = { total_spent_usd: artifacts.asset_manifest.total_cost_usd };
    }
    const last = lastActivity(dir);
    const now = Date.now() / 1000;
    for (const stage of stages) {
      if (stage.status === "in_progress" && last && (now - last) > STALL_WINDOW_SECONDS) {
        stage.stalled = true;
        stage.stalled_minutes = Math.floor((now - last) / 60);
      }
    }
    let state = {
      project_id: projectId,
      title: marker.title || metaJson.name || projectId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      pipeline: pipelineMeta,
      style_playbook: marker.style_playbook,
      created_at: marker.created_at || null,
      has_marker: Boolean(Object.keys(marker).length),
      has_pipeline_state: Boolean(Object.keys(checkpoints).length),
      stages,
      artifacts,
      storyboard: buildStoryboard(dir, artifacts, events),
      media,
      events,
      cost,
      last_activity: last,
      live: Boolean(last && (now - last) < LIVE_WINDOW_SECONDS)
    };
    state = await loadStudioOverlay(dir, state);
    const now2 = Date.now() / 1000;
    state.live = Boolean(state.last_activity && (now2 - state.last_activity) < LIVE_WINDOW_SECONDS);
    for (const stage of state.stages) {
      if (stage.status === "in_progress" && state.last_activity && (now2 - state.last_activity) > STALL_WINDOW_SECONDS) {
        stage.stalled = true;
        stage.stalled_minutes = Math.floor((now2 - state.last_activity) / 60);
      }
    }
    state.poster = findPoster(dir, state);
    state.has_marker = state.has_marker || existsSync(join(dir, "job.json"));
    return state;
  } catch {
    return {
      project_id: basename(String(projectDir)),
      title: basename(String(projectDir)),
      pipeline: { pipeline_type: "unknown", stages: [], known: false },
      style_playbook: null,
      created_at: null,
      has_marker: false,
      has_pipeline_state: false,
      stages: [],
      artifacts: {},
      storyboard: null,
      media: { renders: [], snapshots: [], music: [] },
      events: [],
      cost: null,
      last_activity: 0,
      live: false,
      poster: null
    };
  }
}

export async function summarizeProject(projectDir) {
  const state = await loadBoardState(projectDir);
  const active = state.stages.find((stage) => ["in_progress", "awaiting_human"].includes(stage.status));
  const done = state.stages.filter((stage) => stage.status === "completed");
  return {
    project_id: state.project_id,
    title: state.title,
    pipeline_type: state.pipeline.pipeline_type,
    has_pipeline_state: state.has_pipeline_state,
    poster: state.poster,
    live: state.live,
    last_activity: state.last_activity,
    active_stage: active?.name || null,
    awaiting_human: Boolean(active && active.status === "awaiting_human"),
    stage_states: state.stages
      .filter((stage) => !stage.undeclared)
      .map((stage) => ({ name: stage.name, status: stage.status })),
    completed_count: done.length,
    render_count: state.media.renders.length,
    scene_count: (state.storyboard?.scenes || []).length
  };
}

export async function listProjects(projectsDir = PROJECTS_DIR) {
  const root = resolve(projectsDir);
  if (!existsSync(root)) return [];
  const summaries = [];
  for (const entry of listFiles(root).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    try {
      summaries.push(await summarizeProject(join(root, entry.name)));
    } catch {
      summaries.push({
        project_id: entry.name,
        title: entry.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        pipeline_type: "unknown",
        has_pipeline_state: false,
        poster: null,
        live: false,
        last_activity: 0,
        active_stage: null,
        awaiting_human: false,
        stage_states: [],
        completed_count: 0,
        render_count: 0,
        scene_count: 0,
        error: "unreadable"
      });
    }
  }
  summaries.sort((a, b) => Number(!a.live) - Number(!b.live) || (b.last_activity || 0) - (a.last_activity || 0));
  return summaries;
}

export { readJsonAny };
