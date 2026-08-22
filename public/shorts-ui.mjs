export function hasFrozenHint(job = {}) {
  const text = [...(job.warnings || []), job.message, job.error, job.stage]
    .filter(Boolean)
    .join(" ");
  if (/고정|프리즈|freeze|frozen/i.test(text)) return true;
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  if (artifacts.some((artifact) => artifact?.frozen || artifact?.kind === "frozen-clip")) return true;
  return Array.isArray(job.clips) && job.clips.some((clip) => clip?.frozen);
}

export function shortStatus(job = {}) {
  if (job.status === "failed") return { key: "failed", label: "실패·프리즈" };
  if (job.status === "completed") {
    return hasFrozenHint(job)
      ? { key: "frozen", label: "실패·프리즈" }
      : { key: "completed", label: "완료" };
  }
  if (Number(job.queuePosition) > 0) return { key: "queued", label: `대기 ${job.queuePosition}번` };
  if (["running", "verifying"].includes(job.status)) return { key: "running", label: "생성중" };
  if (job.status === "queued" && (job.provider === "grok-imagine" || job.provider === "gemini-browser")) {
    return { key: "running", label: "생성중" };
  }
  return { key: "draft", label: "초안" };
}

export function shortStatusLabel(job) {
  return shortStatus(job).label;
}

export function importBroughtCopy(payload = {}) {
  if (payload.error) return String(payload.error);
  const imported = Array.isArray(payload.imported) ? payload.imported : [];
  const seeded = Array.isArray(payload.seeded) ? payload.seeded : [];
  const count = Number.isFinite(Number(payload.count)) ? Number(payload.count) : new Set([...imported, ...seeded]).size;
  return `가져왔어요 ${count}편`;
}

export function isPlaceholderThumbnail(artifact = {}) {
  if (artifact.placeholder === true) return true;
  const width = Number(artifact.width);
  const height = Number(artifact.height);
  if (width === 1 && height === 1) return true;
  const bytes = Number(artifact.bytes);
  if (Number.isFinite(bytes) && bytes > 0 && bytes <= 90) return true;
  return false;
}

function isRasterName(name = "") {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function rasterRank(artifact = {}) {
  const name = artifact.name || "";
  if (/\.(jpe?g|webp)$/i.test(name)) return 0;
  if (/\.png$/i.test(name)) return 1;
  return 2;
}

function pickRaster(artifacts, predicate) {
  const matches = artifacts.filter((artifact) => artifact?.url && predicate(artifact));
  if (!matches.length) return "";
  const real = matches.filter((artifact) => !isPlaceholderThumbnail(artifact));
  const pool = real.length ? real : [];
  if (!pool.length) return "";
  return [...pool].sort((left, right) => rasterRank(left) - rasterRank(right))[0].url;
}

export function shortThumbnail(job = {}) {
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  return pickRaster(artifacts, (artifact) => artifact.kind === "hook-lock")
    || pickRaster(artifacts, (artifact) => artifact.kind === "still")
    || pickRaster(artifacts, (artifact) => artifact.kind === "thumbnail" || /thumbnail/i.test(artifact.kind || "") || /thumbnail\.(jpe?g|png|webp)$/i.test(artifact.name || ""))
    || pickRaster(artifacts, (artifact) => isRasterName(artifact.name || ""));
}

export function shortDurationSeconds(job = {}) {
  const value = Number(job.duration || job.targetDurationSec || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatClock(seconds) {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function shortPreview(job = {}) {
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  const byKind = (...kinds) => artifacts.find((artifact) => kinds.includes(artifact?.kind) && artifact.url);
  const bySuffix = (suffix) => artifacts.find((artifact) => artifact?.url && job.runId && artifact.name === `runs/${job.runId}/artifacts/${suffix}`);
  const video = byKind("chat-video", "master-video", "video")
    || bySuffix("final.mp4")
    || artifacts.find((artifact) => artifact?.url && /\.mp4$/i.test(artifact.name || ""));
  return {
    videoUrl: video?.url || "",
    poster: shortThumbnail(job) || bySuffix("thumbnail.jpg")?.url || ""
  };
}

export function isWatchableShort(job = {}) {
  return Boolean(shortPreview(job).videoUrl);
}

export function channelOneLiner(job = {}, editorial = null) {
  const fact = Array.isArray(job.facts) ? job.facts.find(Boolean) : "";
  if (fact) return String(fact).replace(/\s+/g, " ").trim();
  if (job.live?.message) return job.live.message;
  if (job.message && !["queued", "대기"].includes(job.status) && job.status !== "queued") return job.message;
  return editorial?.titleFormula || "익숙한 대상 + 상식과 반대되는 사실";
}

export const DEFAULT_CREATE_PROVIDER = "grok-imagine";

export function downloadLabel(artifact = {}) {
  const name = String(artifact.name || "");
  if (/(?:^|\/)master\.mp4$/i.test(name)) return "마스터";
  if (/(?:^|\/)chat\.mp4$/i.test(name)) return "채팅용";
  if (/(?:^|\/)final\.mp4$/i.test(name)) return "최종";
  if (/(?:^|\/)captions\.ass$/i.test(name)) return "자막 ASS";
  if (/(?:^|\/)captions\.srt$/i.test(name)) return "자막 SRT";
  const part = name.match(/part-(\d+)\.mp4$/i);
  if (part) return `파트 ${Number(part[1])}`;
  return name.split("/").pop() || name;
}

export function shortDownloads(job = {}) {
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  const seen = new Set();
  const picks = [];
  const take = (predicate) => {
    for (const artifact of artifacts) {
      if (!artifact?.url || seen.has(artifact.name)) continue;
      if (!predicate(artifact)) continue;
      seen.add(artifact.name);
      picks.push({
        ...artifact,
        label: downloadLabel(artifact),
        href: `${artifact.url}${artifact.url.includes("?") ? "&" : "?"}download=1`
      });
    }
  };
  take((artifact) => /(?:^|\/)master\.mp4$/i.test(artifact.name || ""));
  take((artifact) => /(?:^|\/)chat\.mp4$/i.test(artifact.name || ""));
  take((artifact) => /parts\/part-\d+\.mp4$/i.test(artifact.name || "") || artifact.kind === "part");
  take((artifact) => /(?:^|\/)captions\.ass$/i.test(artifact.name || ""));
  return picks;
}

export function inspectVideoDownloads(job = {}) {
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  const href = (artifact) => `${artifact.url}${artifact.url.includes("?") ? "&" : "?"}download=1`;
  const picks = [];
  const master = artifacts.find((artifact) => artifact?.url && /(?:^|\/)master\.mp4$/i.test(artifact.name || ""));
  if (master) picks.push({ ...master, label: "마스터", href: href(master) });
  const final = !master && artifacts.find((artifact) => artifact?.url && /(?:^|\/)final\.mp4$/i.test(artifact.name || ""));
  if (final) picks.push({ ...final, label: "최종", href: href(final) });
  const parts = artifacts
    .filter((artifact) => artifact?.url && (/(?:^|\/)parts\/part-\d+\.mp4$/i.test(artifact.name || "") || artifact.kind === "part"))
    .sort((left, right) => Number((left.name || "").match(/part-(\d+)/i)?.[1] || 0) - Number((right.name || "").match(/part-(\d+)/i)?.[1] || 0));
  if (parts.length) {
    for (const part of parts) {
      const number = Number((part.name || "").match(/part-(\d+)/i)?.[1] || picks.length);
      picks.push({ ...part, label: `채팅용 ${number}`, href: href(part) });
    }
    return picks;
  }
  const chat = artifacts.find((artifact) => artifact?.url && /(?:^|\/)chat\.mp4$/i.test(artifact.name || ""));
  if (chat) picks.push({ ...chat, label: "채팅용", href: href(chat) });
  return picks;
}

export function shortUploadPack(job = {}) {
  const downloads = shortDownloads(job);
  const facts = Array.isArray(job.facts) ? job.facts.map((item) => String(item).trim()).filter(Boolean) : [];
  const description = [...facts, String(job.scriptDraft || "").trim()].filter(Boolean).join("\n");
  return {
    title: String(job.topic || "").trim(),
    description,
    links: downloads.filter((item) => /마스터|파트|ASS/.test(item.label))
  };
}
