const ACTIVE_STATUSES = new Set(["running", "verifying"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const ARTIFACT_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ARTIFACT_CAPABILITY_MAX_TTL_SECONDS = 60 * 60;

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
 * Creates every production job inertly, exposes its durable id to the caller,
 * and only then starts the exact Gemini job. A lost create response can leave
 * an extra queued record, but can never submit a provider request. A lost run
 * response remains retryable through the same job id.
 */
export async function createProductionJobInertFirst(apiCall, requestBody, options = {}) {
  if (typeof apiCall !== "function") throw new TypeError("A production API function is required.");
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    throw new TypeError("A plain production request is required.");
  }
  const inertRequest = { ...requestBody, autoStart: false };
  const created = await apiCall("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inertRequest)
  });
  const jobId = created?.job?.id;
  if (typeof jobId !== "string" || !jobId || /[\0/\\]/u.test(jobId)) {
    throw new Error("The inert job response did not contain a safe job id.");
  }
  await options.onCreated?.({ created, jobId, inertRequest });
  let runError = null;
  if (requestBody.provider === "gemini-browser") {
    try {
      await apiCall(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: "POST" });
    } catch (error) {
      runError = error instanceof Error ? error : new Error(String(error));
    }
  }
  return {
    created,
    jobId,
    inertRequest,
    runAttempted: requestBody.provider === "gemini-browser",
    runError
  };
}

/**
 * A queued record is a durable waiting state, not evidence that a worker owns
 * it. Only server-confirmed active statuses keep background polling alive.
 */
export function shouldPollJobs(jobs) {
  if (!Array.isArray(jobs)) return false;
  return jobs.some((job) => {
    if (!job || typeof job !== "object") return false;
    if (job.integrity?.status === "blocked") return false;
    return ACTIVE_STATUSES.has(job.status);
  });
}

/**
 * Binds cached quality/history to the effective append-only revision head, not
 * merely to the base run. A reviewer revision keeps the same runId while its
 * effective status and quality projection change.
 */
export function qualityEvidenceCacheKey(job) {
  if (!job || typeof job !== "object" || Array.isArray(job) || typeof job.id !== "string" || typeof job.runId !== "string") return null;
  const revisionSequence = Number(job.qualitySummary?.revisionSequence);
  return stableUiSignature({
    jobId: job.id,
    runId: job.runId,
    effectiveStatus: typeof job.status === "string" ? job.status : null,
    effectiveRunStatus: typeof job.runStatus === "string" ? job.runStatus : null,
    revisionId: typeof job.qualitySummary?.revisionId === "string" ? job.qualitySummary.revisionId : null,
    revisionSequence: Number.isSafeInteger(revisionSequence) && revisionSequence >= 0 ? revisionSequence : null,
    qualitySummarySignature: stableUiSignature(job.qualitySummary ?? null)
  });
}

export function qualityEvidenceCacheEntryMatches(job, entry) {
  const cacheKey = qualityEvidenceCacheKey(job);
  return cacheKey !== null && entry?.cacheKey === cacheKey;
}

export function currentQualityEvidenceEntry(job, entry) {
  return qualityEvidenceCacheEntryMatches(job, entry) ? entry : null;
}

export function localClipUploadExpectedRunId(job) {
  return typeof job?.runId === "string" ? job.runId : "";
}

/**
 * A terminal local run remains immutable on disk, but importing a new source
 * set deliberately moves the mutable job pointer away from that result. Make
 * that consequence explicit before the browser sends any replacement bytes.
 */
export function localClipReplacementConfirmation(job) {
  const runId = localClipUploadExpectedRunId(job);
  if (
    !job
    || job.provider !== "local"
    || !["completed", "needs-improvement"].includes(job.status)
    || !runId
  ) return null;
  return {
    runId,
    message: `현재 봉인 결과 RUN ${runId}에서 이 작업의 현재 포인터가 이탈합니다.\n\n새 업로드는 현재 source clips를 선택한 파일로 교체하고, 기존 결과와 품질은 작업 상세/API의 현재 결과에서 더 이상 보이지 않습니다. 봉인된 run 파일은 보존됩니다.\n\n계속할까요?`
  };
}

export function invalidateQualityEvidenceCache(cache, jobId) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache) || typeof jobId !== "string" || !jobId) return false;
  if (!Object.hasOwn(cache, jobId)) return false;
  delete cache[jobId];
  return true;
}

/**
 * Returns a successful cache hit only when it is bound to the current revision
 * key. Failed reads are deliberately retryable on the next refresh/selection.
 */
export async function refreshQualityEvidenceCache(job, cached, fetchEvidence) {
  const cacheKey = qualityEvidenceCacheKey(job);
  if (!cacheKey) return { entry: null, refreshed: false };
  if (qualityEvidenceCacheEntryMatches(job, cached) && cached?.quality) return { entry: cached, refreshed: false };
  if (typeof fetchEvidence !== "function") throw new TypeError("quality evidence fetch 함수가 필요합니다.");
  try {
    const result = await fetchEvidence(job);
    return {
      entry: {
        cacheKey,
        runId: job.runId,
        quality: result?.quality ?? null,
        history: Array.isArray(result?.history) ? result.history : []
      },
      refreshed: true
    };
  } catch (error) {
    return {
      entry: {
        cacheKey,
        runId: job.runId,
        error: String(error?.message || error),
        quality: null,
        history: []
      },
      refreshed: true
    };
  }
}

const PROVIDER_READINESS_STATUSES = new Set(["READY", "CONFIGURED", "BLOCKED", "STALE", "NOT_CONNECTED"]);

/**
 * Projects the Gemini quota headline exclusively from the TTL-bounded provider
 * readiness receipt. Raw monitor snapshots may remain on disk after their
 * observation window and must never be presented as currently available.
 */
export function geminiQuotaMonitorSummary(readinessPayload) {
  const provider = readinessPayload?.providers?.gemini;
  const status = PROVIDER_READINESS_STATUSES.has(provider?.status) ? provider.status : "NOT_CONNECTED";
  const operational = provider?.operational && typeof provider.operational === "object" ? provider.operational : {};
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const profileCount = count(operational.profileCount);
  const freshProfileCount = Math.min(profileCount, count(operational.freshProfileCount));
  const reportedAvailableCount = Math.min(freshProfileCount, count(operational.availableCount));
  const ready = status === "READY" && freshProfileCount > 0 && reportedAvailableCount > 0;
  const effectiveStatus = status === "READY" && !ready ? "BLOCKED" : status;
  const availableCount = ready ? reportedAvailableCount : 0;
  const blockerCodes = Array.isArray(provider?.blockers)
    ? provider.blockers.map((entry) => entry?.code).filter((code) => typeof code === "string" && code)
    : [];
  const suffix = blockerCodes.length ? ` · ${blockerCodes.join(", ")}` : "";
  return {
    ready,
    status: effectiveStatus,
    availableCount,
    freshProfileCount,
    profileCount,
    label: `${effectiveStatus} · ${availableCount}/${profileCount} 계정 사용 가능 · fresh ${freshProfileCount}/${profileCount}${suffix}`
  };
}

export function providerReadinessRefreshDelay(readinessPayload, nowMs = Date.now()) {
  const expiries = Object.values(readinessPayload?.providers || {})
    .map((provider) => Date.parse(provider?.expiresAt || ""))
    .filter((value) => Number.isFinite(value) && value > nowMs);
  if (!expiries.length) return 60_000;
  return Math.max(1_000, Math.min(15 * 60_000, Math.min(...expiries) - nowMs + 250));
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
  const revisionPrefix = typeof runId === "string" && runId ? `runs/${runId}/revisions/` : null;
  const immutable = [];
  const revision = [];
  const mutable = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact || typeof artifact !== "object") continue;
    if (immutablePrefix && String(artifact.name || "").startsWith(immutablePrefix)) immutable.push(artifact);
    else if (revisionPrefix && String(artifact.name || "").startsWith(revisionPrefix)) revision.push(artifact);
    else mutable.push(artifact);
  }
  return { immutable, revision, mutable };
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

function decodedPathComponent(value, { allowSlash = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded || /[\0\\]/u.test(decoded) || (!allowSlash && decoded.includes("/"))) return null;
  return decoded.split("/").some((part) => !part || part === "." || part === "..") ? null : decoded;
}

/**
 * Resolves a run artifact link against the exact UI origin. Only the existing
 * authenticated `/api/jobs/:jobId/artifacts/:encodedName` route is accepted.
 */
export function safeSameOriginArtifactUrl(value, expectedOrigin = globalThis.location?.origin, expected = {}) {
  const origin = safeBaseOrigin(expectedOrigin);
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(String(value || ""), origin);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) return null;
  const match = /^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/u.exec(parsed.pathname);
  if (!match) return null;
  const jobId = decodedPathComponent(match[1]);
  const artifactName = decodedPathComponent(match[2], { allowSlash: true });
  if (!jobId || !artifactName) return null;
  if (expected.jobId !== undefined && expected.jobId !== jobId) return null;
  if (expected.artifactName !== undefined && expected.artifactName !== artifactName) return null;
  const keys = [...parsed.searchParams.keys()];
  const expiresValues = parsed.searchParams.getAll("exp");
  const capabilityValues = parsed.searchParams.getAll("cap");
  if (
    keys.length !== 2
    || new Set(keys).size !== 2
    || expiresValues.length !== 1
    || capabilityValues.length !== 1
    || !/^\d{10}$/u.test(expiresValues[0])
    || !ARTIFACT_CAPABILITY_PATTERN.test(capabilityValues[0])
  ) return null;
  const expiresAt = Number(expiresValues[0]);
  const nowSeconds = Math.floor((expected.nowMs ?? Date.now()) / 1000);
  if (
    !Number.isSafeInteger(expiresAt)
    || !Number.isSafeInteger(nowSeconds)
    || expiresAt < nowSeconds
    || expiresAt > nowSeconds + ARTIFACT_CAPABILITY_MAX_TTL_SECONDS
  ) return null;
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
