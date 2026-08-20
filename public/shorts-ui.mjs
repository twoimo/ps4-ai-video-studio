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
  if (["running", "verifying"].includes(job.status)) return { key: "running", label: "생성중" };
  if (job.status === "queued" && (job.provider === "grok-imagine" || job.provider === "gemini-browser")) {
    return { key: "running", label: "생성중" };
  }
  return { key: "draft", label: "초안" };
}

export function shortStatusLabel(job) {
  return shortStatus(job).label;
}

export function shortThumbnail(job = {}) {
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
  const pick = (predicate) => artifacts.find((artifact) => artifact?.url && predicate(artifact))?.url || "";
  return pick((artifact) => artifact.kind === "hook-lock")
    || pick((artifact) => artifact.kind === "still")
    || pick((artifact) => artifact.kind === "thumbnail" || /thumbnail/i.test(artifact.kind || "") || /thumbnail\.(jpe?g|png|webp)$/i.test(artifact.name || ""))
    || pick((artifact) => /\.(png|jpe?g|webp)$/i.test(artifact.name || ""));
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

export function channelOneLiner(job = {}, editorial = null) {
  const fact = Array.isArray(job.facts) ? job.facts.find(Boolean) : "";
  if (fact) return String(fact).replace(/\s+/g, " ").trim();
  if (job.live?.message) return job.live.message;
  if (job.message && !["queued", "대기"].includes(job.status) && job.status !== "queued") return job.message;
  return editorial?.titleFormula || "익숙한 대상 + 상식과 반대되는 사실";
}

export const DEFAULT_CREATE_PROVIDER = "grok-imagine";
