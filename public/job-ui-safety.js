const AUTO_START_PROVIDERS = new Set(["gemini-browser", "local-video"]);
const ACTIVE_STATUSES = new Set(["running", "verifying"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

function canonicalSerializableValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("UI signature values must contain only finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError("UI signature values must be JSON-serializable.");
  if (seen.has(value)) throw new TypeError("UI signature values must not be cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalSerializableValue(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("UI signature values must use plain objects and arrays.");
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSerializableValue(value[key], seen)]));
  } finally {
    seen.delete(value);
  }
}

/**
 * Returns deterministic canonical JSON for serializable UI state.
 * This is an equality signature, not a cryptographic integrity hash.
 */
export function stableUiSignature(value) {
  return JSON.stringify(canonicalSerializableValue(value, new WeakSet()));
}

/**
 * Manual local-upload jobs must not keep the polling loop alive while queued.
 */
export function shouldPollJobs(jobs) {
  if (!Array.isArray(jobs)) return false;
  return jobs.some((job) => {
    if (!job || typeof job !== "object") return false;
    if (ACTIVE_STATUSES.has(job.status)) return true;
    return job.status === "queued" && AUTO_START_PROVIDERS.has(job.provider);
  });
}

export function semanticRevalidationEligibility(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return { eligible: false, reason: "작업 상태를 확인할 수 없습니다." };
  if (job.integrity?.status === "blocked") return { eligible: false, reason: job.integrity.message || "봉인 run 무결성 검증이 차단되었습니다." };
  const readiness = job.semanticRevalidationReadiness;
  if (readiness?.eligible !== true) return { eligible: false, reason: readiness?.reason || "현재 작업은 로컬 의미 재검수 대상이 아닙니다." };
  if (
    job.provider !== "gemini-browser"
    || job.status !== "needs-improvement"
    || job.runStatus !== "needs-improvement"
    || !job.runId
    || readiness.sourceRunId !== job.runId
    || readiness.providerRequests !== 0
  ) return { eligible: false, reason: "현재 봉인 run·상태·provider 0회 결속이 변경되었습니다." };
  return { eligible: true, sourceRunId: job.runId, providerRequests: 0 };
}

export function partitionRunArtifacts(artifacts, runId) {
  const immutablePrefix = typeof runId === "string" && runId ? `runs/${runId}/artifacts/` : null;
  const immutable = [];
  const mutable = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact || typeof artifact !== "object") continue;
    if (immutablePrefix && String(artifact.name || "").startsWith(immutablePrefix)) immutable.push(artifact);
    else mutable.push(artifact);
  }
  return { immutable, mutable };
}

function normalizedYouTubeVideo(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  if (parsed.hostname === "youtu.be") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length === 1 && VIDEO_ID_PATTERN.test(parts[0]) ? { id: parts[0], shorts: false } : null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "shorts" && VIDEO_ID_PATTERN.test(parts[1])) {
    return { id: parts[1], shorts: true };
  }
  if (parsed.pathname !== "/watch") return null;
  for (const key of parsed.searchParams.keys()) if (key !== "v") return null;
  if (parsed.searchParams.getAll("v").length !== 1 || parsed.hash) return null;
  const id = parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
  return VIDEO_ID_PATTERN.test(String(id || "")) ? { id, shorts: false } : null;
}

export function buildYouTubeVideoUrl(videoId, { shorts = false } = {}) {
  const id = String(videoId || "");
  if (!VIDEO_ID_PATTERN.test(id)) return null;
  return shorts
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Accepts only canonical YouTube watch/Shorts video destinations. Share-link
 * tracking is accepted only on youtu.be and Shorts paths, then discarded.
 */
export function safeYouTubeVideoUrl(value) {
  const video = normalizedYouTubeVideo(value);
  return video ? buildYouTubeVideoUrl(video.id, { shorts: video.shorts }) : null;
}

function safeBaseOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeDecodedPathComponent(value, { allowSlash = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (!decoded || /[\0\\]/u.test(decoded) || (!allowSlash && decoded.includes("/"))) return false;
  return !decoded.split("/").some((part) => !part || part === "." || part === "..");
}

/**
 * Resolves a run artifact link against the exact UI origin. Only the existing
 * authenticated `/api/jobs/:jobId/artifacts/:encodedName` route is accepted.
 */
export function safeSameOriginArtifactUrl(value, expectedOrigin = globalThis.location?.origin) {
  const origin = safeBaseOrigin(expectedOrigin);
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(String(value || ""), origin);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const match = /^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/u.exec(parsed.pathname);
  if (!match || !safeDecodedPathComponent(match[1]) || !safeDecodedPathComponent(match[2], { allowSlash: true })) return null;
  return parsed.href;
}

/**
 * Intentionally excludes progress so frequent percentage updates do not
 * trigger screen-reader announcements. Announce status, stage, or message
 * transitions instead.
 */
export function jobAnnouncementSignature(job) {
  if (!job || typeof job !== "object") return stableUiSignature(null);
  return stableUiSignature({
    id: typeof job.id === "string" ? job.id : null,
    status: typeof job.status === "string" ? job.status : null,
    stage: typeof job.stage === "string" ? job.stage : null,
    message: typeof job.message === "string" ? job.message : null,
    integrityStatus: typeof job.integrity?.status === "string" ? job.integrity.status : null,
    integrityMessage: typeof job.integrity?.message === "string" ? job.integrity.message : null
  });
}
