import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ANALYSIS_PATH,
  JOBS_DIR,
  ROOT,
  copyUpload,
  createJob,
  ensureWorkspace,
  listJobs,
  readAnalysis,
  readJob,
  runJob,
  updateJob
} from "./pipeline.mjs";
import { appendRunEvent, hashFile, readRunManifest, writeRunManifest } from "./run-ledger.mjs";
import { geminiBrowserStatus, startGeminiBrowser } from "./gemini-browser.mjs";
import { evaluateJob, runQualityLoop, saveCommitteeReview } from "./quality.mjs";
import { ytDlpInfo } from "./yt-dlp.mjs";
import { resolveGrokBinary } from "./grok-imagine-cli.mjs";
import { PROVIDER_ID as GROK_IMAGINE_PROVIDER } from "./grok-imagine-factory.mjs";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(ROOT, "public");
const activeJobs = new Set();
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/;
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const JOB_LEASE_FILENAME = ".run.lock";
const JOB_LEASE_WINDOW_MS = 30 * 60 * 1000;
const JOB_LEASE_HEARTBEAT_MS = JOB_LEASE_WINDOW_MS / 3;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}
await ensureWorkspace();

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(error, status = 400) {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}
function qualityErrorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /실행 중|현재 작업|봉인|runId|작업 식별자|실행 산출물/.test(message);
  return errorResponse(error, conflict ? 409 : 400);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("JSON 요청 본문을 읽지 못했습니다.");
  }
}
async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function readOptionalJsonLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function safeArtifactPath(jobId, filename) {
  const jobRoot = resolve(JOBS_DIR, jobId);
  const target = resolve(jobRoot, filename);
  if (!(target === jobRoot || target.startsWith(`${jobRoot}${sep}`))) throw new Error("허용되지 않은 파일 경로입니다.");
  return target;
}
async function readVerifiedImmutableArtifact(job, artifact, expectedName = artifact?.name) {
  if (!job?.runId || !artifact?.path || artifact.name !== expectedName) return null;
  const jobRoot = resolve(JOBS_DIR, job.id);
  const expectedPath = `runs/${job.runId}/artifacts/${String(artifact.name).replaceAll("/", "__")}`;
  if (artifact.path !== expectedPath) return null;
  const path = resolve(jobRoot, artifact.path);
  if (!path.startsWith(`${jobRoot}${sep}`)) return null;
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || Number(artifact.bytes) !== fileStat.size || !String(artifact.sha256 || "").startsWith("sha256:")) return null;
  if (await hashFile(path).catch(() => null) !== artifact.sha256) return null;
  return { path, value: await readOptionalJson(path) };
}
async function verifyImmutableRun(job, manifest) {
  if (!job?.runId || !manifest || manifest.status !== "completed" || manifest.jobId !== job.id || manifest.runId !== job.runId || !Array.isArray(manifest.ledgerErrors) || manifest.ledgerErrors.length !== 0) return false;
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const names = immutableArtifacts.map((artifact) => artifact?.name).filter(Boolean);
  const expectedPath = (name) => `runs/${job.runId}/artifacts/${String(name).replaceAll("/", "__")}`;
  const requiredNames = [
    "final.mp4",
    "captions.srt",
    "script.json",
    "thumbnail.jpg",
    "quality.json",
    "frame-audio-caption.json",
    "sources.json",
    `runs/${job.runId}/events.jsonl`,
    `runs/${job.runId}/input-manifest.json`,
    `runs/${job.runId}/benchmarks/channel-analysis.json`,
    `runs/${job.runId}/benchmarks/shorts-metadata.json`,
    `runs/${job.runId}/benchmarks/rlm-benchmark-analysis.json`
  ];
  if (new Set(names).size !== names.length || !requiredNames.every((name) => names.includes(name))) return false;
  const results = await Promise.all(immutableArtifacts.map(async (artifact) => {
    if (!artifact?.path || artifact.path !== expectedPath(artifact.name) || !String(artifact.sha256 || "").startsWith("sha256:")) return false;
    const path = resolve(JOBS_DIR, job.id, artifact.path);
    const fileStat = await stat(path).catch(() => null);
    return path.startsWith(`${resolve(JOBS_DIR, job.id)}${sep}`)
      && fileStat?.isFile()
      && Number(artifact.bytes) === fileStat.size
      && await hashFile(path).catch(() => null) === artifact.sha256;
  }));
  return results.every(Boolean);
}
async function readVerifiedRevisionArtifact(job, declaration) {
  if (!job?.runId || !declaration?.path || !String(declaration.sha256 || "").startsWith("sha256:")) return null;
  const revisionPath = /^runs\/([^/]+)\/revisions\/([^/]+)\/(?:manifest\.json|committee-review\.json|quality\.json|events\.jsonl)$/.exec(declaration.path);
  if (!revisionPath || revisionPath[1] !== job.runId) return null;
  const jobRoot = resolve(JOBS_DIR, job.id);
  const path = resolve(jobRoot, declaration.path);
  if (!path.startsWith(`${jobRoot}${sep}`)) return null;
  const jobDeclaration = Array.isArray(job.artifacts)
    ? job.artifacts.find((artifact) => artifact?.name === declaration.path && String(artifact.sha256 || "").startsWith("sha256:"))
    : null;
  if (!jobDeclaration || jobDeclaration.sha256 !== declaration.sha256) return null;
  const fileStat = await stat(path).catch(() => null);
  const expectedBytes = declaration.bytes ?? jobDeclaration.bytes;
  if (!fileStat?.isFile() || (expectedBytes != null && Number(expectedBytes) !== fileStat.size)) return null;
  if (await hashFile(path).catch(() => null) !== jobDeclaration.sha256) return null;
  return { path, value: await readOptionalJson(path) };
}

async function readVerifiedQuality(job) {
  if (job?.status !== "completed") return null;
  const manifest = job?.runId ? await readRunManifest(join(JOBS_DIR, job.id, "runs", job.runId)) : null;
  if (!(await verifyImmutableRun(job, manifest))) return null;
  const declaration = manifest.immutableArtifacts.find((artifact) => artifact?.name === "quality.json");
  const verified = await readVerifiedImmutableArtifact(job, declaration, "quality.json");
  if (!verified?.value || verified.value.jobId !== job.id || verified.value.runId !== job.runId) return null;
  const qualitySummaryFields = ["status", "totalScore", "threshold", "semanticGate", "runId", "blockers"];
  const summaryMatches = Boolean(
    manifest.qualitySummary
    && qualitySummaryFields.every((field) => JSON.stringify(manifest.qualitySummary[field]) === JSON.stringify(verified.value[field]))
  );
  const eventArtifact = manifest.immutableArtifacts.find((artifact) => artifact?.name === `runs/${job.runId}/events.jsonl`);
  const events = eventArtifact ? await readOptionalJsonLines(resolve(JOBS_DIR, job.id, eventArtifact.path)) : null;
  const terminal = Array.isArray(events) ? events.at(-1) : null;
  const terminalMatches = Boolean(
    terminal?.type === "quality_finalized"
    && terminal.jobId === job.id
    && terminal.runId === job.runId
    && terminal.status === manifest.runStatus
    && terminal.qualityHash === declaration.sha256
    && terminal.qualitySummary
    && qualitySummaryFields.every((field) => JSON.stringify(terminal.qualitySummary[field]) === JSON.stringify(verified.value[field]))
  );
  if (!summaryMatches || !terminalMatches) return null;
  const revisionId = job?.qualitySummary?.revisionId;
  if (revisionId) {
    const revisionManifestPath = `runs/${job.runId}/revisions/${revisionId}/manifest.json`;
    const revisionJobDeclaration = Array.isArray(job.artifacts)
      ? job.artifacts.find((artifact) => artifact?.name === revisionManifestPath && String(artifact.sha256 || "").startsWith("sha256:"))
      : null;
    const revisionManifestArtifact = await readVerifiedRevisionArtifact(job, revisionJobDeclaration ? { path: revisionManifestPath, sha256: revisionJobDeclaration.sha256, bytes: revisionJobDeclaration.bytes } : null);
    const revisionManifest = revisionManifestArtifact?.value;
    const parentManifestPath = join(JOBS_DIR, job.id, revisionManifest?.parentManifest?.path || "");
    const parentManifestHash = revisionManifest?.parentManifest?.path ? await hashFile(parentManifestPath).catch(() => null) : null;
    const revisionQuality = await readVerifiedRevisionArtifact(job, revisionManifest?.quality);
    if (
      revisionManifest?.jobId === job.id
      && revisionManifest?.runId === job.runId
      && revisionManifest?.revisionId === revisionId
      && revisionManifest.parentManifest?.path === `runs/${job.runId}/manifest.json`
      && revisionManifest.parentManifest.sha256 === parentManifestHash
      && revisionQuality?.value?.jobId === job.id
      && revisionQuality.value.runId === job.runId
    ) {
      return revisionQuality.value;
    }
  }
  return verified.value;
}

async function readVerifiedQualityHistory(job) {
  const quality = await readVerifiedQuality(job);
  if (!quality) return null;
  const manifest = job?.runId ? await readRunManifest(join(JOBS_DIR, job.id, "runs", job.runId)) : null;
  const declarations = (manifest?.immutableArtifacts || [])
    .filter((artifact) => /^quality\/iteration-\d+\.json$/.test(artifact?.name || ""))
    .sort((left, right) => left.name.localeCompare(right.name));
  const values = [];
  for (const declaration of declarations) {
    const verified = await readVerifiedImmutableArtifact(job, declaration);
    if (verified?.value?.jobId === job.id && verified.value.runId === job.runId) values.push(verified.value);
  }
  return values;
}

function contentType(path) {
  const ext = extname(path).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".ass": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function withJob(jobId, callback) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  try {
    await callback();
    return true;
  } finally {
    activeJobs.delete(jobId);
  }
}

function isFreshRunningJob(job) {
  const startedAt = Date.parse(job.runStartedAt || job.updatedAt || "");
  return ["running", "verifying"].includes(job.status) && Number.isFinite(startedAt) && Date.now() - startedAt < JOB_LEASE_WINDOW_MS;
}
async function readLeaseRecord(lockPath) {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function leaseOwnerAlive(record) {
  return Boolean(record && Number.isInteger(record.pid) && isProcessAlive(record.pid));
}

async function acquireJobLease(jobId) {
  const lockPath = join(JOBS_DIR, jobId, JOB_LEASE_FILENAME);
  await mkdir(join(JOBS_DIR, jobId), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        const record = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
        const token = record.token;
        await handle.writeFile(JSON.stringify(record), "utf8");
        const heartbeat = setInterval(() => {
          try {
            if (typeof handle.utimes === "function") void handle.utimes(new Date(), new Date()).catch(() => {});
          } catch {
            // The lease is still guarded by the open descriptor if a heartbeat tick fails.
          }
        }, JOB_LEASE_HEARTBEAT_MS);
        heartbeat.unref?.();
        return { handle, heartbeat, lockPath, token };
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (!lockStat) continue;
      const job = await readJob(jobId).catch(() => null);
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (!job || isFreshRunningJob(job) || lockAge <= JOB_LEASE_WINDOW_MS) return null;
      const currentStat = await stat(lockPath).catch(() => null);
      if (!currentStat || currentStat.ino !== lockStat.ino || currentStat.mtimeMs !== lockStat.mtimeMs) continue;
      const leaseRecord = await readLeaseRecord(lockPath);
      if (leaseOwnerAlive(leaseRecord)) return null;
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw reclaimError;
      }
    }
  }
}

async function releaseJobLease(lease) {
  clearInterval(lease.heartbeat);
  try {
    const record = await readLeaseRecord(lease.lockPath);
    if (record?.token === lease.token) await unlink(lease.lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } finally {
    await lease.handle.close().catch(() => {});
  }
}

async function withQualityLease(jobId, callback) {
  if (activeJobs.has(jobId)) return null;
  const current = await readJob(jobId);
  if (["running", "verifying"].includes(current.status)) return null;
  if (!current.runId) return null;
  const lease = await acquireJobLease(jobId);
  if (!lease) return null;
  try {
    const locked = await readJob(jobId);
    if (locked.runId !== current.runId || ["running", "verifying"].includes(locked.status)) return null;
    const result = await callback(locked);
    const after = await readJob(jobId);
    if (after.runId !== locked.runId) throw new Error("품질 검사 중 작업 runId가 변경되었습니다.");
    return result;
  } finally {
    await releaseJobLease(lease);
  }
}
async function hasUploadedVideo(jobId) {
  const entries = await readdir(join(JOBS_DIR, jobId, "clips"), { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()));
}
async function rehydrateCompletedRun(job, manifest) {
  const immutableArtifacts = Array.isArray(manifest.immutableArtifacts) ? manifest.immutableArtifacts : [];
  const jobRoot = resolve(JOBS_DIR, job.id);
  const expectedPath = (name) => `runs/${job.runId}/artifacts/${String(name).replaceAll("/", "__")}`;
  const requiredNames = new Set([
    "final.mp4",
    "captions.srt",
    "script.json",
    "thumbnail.jpg",
    "quality.json",
    "frame-audio-caption.json",
    "sources.json",
    `runs/${job.runId}/events.jsonl`,
    `runs/${job.runId}/input-manifest.json`,
    `runs/${job.runId}/benchmarks/channel-analysis.json`,
    `runs/${job.runId}/benchmarks/shorts-metadata.json`,
    `runs/${job.runId}/benchmarks/rlm-benchmark-analysis.json`
  ]);
  if (manifest.status !== "completed" || manifest.jobId !== job.id || manifest.runId !== job.runId || immutableArtifacts.length < requiredNames.size || new Set(immutableArtifacts.map((artifact) => artifact?.name)).size !== immutableArtifacts.length || manifest.runStatus === "failed" || !Array.isArray(manifest.ledgerErrors) || manifest.ledgerErrors.length !== 0 || ![...requiredNames].every((name) => immutableArtifacts.some((artifact) => artifact.name === name && artifact.path === expectedPath(name)))) return null;
  const verified = await Promise.all(immutableArtifacts.map(async (artifact) => {
    if (!artifact?.name || artifact.path !== expectedPath(artifact.name) || !String(artifact.sha256 || "").startsWith("sha256:")) return false;
    const path = resolve(jobRoot, artifact.path);
    if (!(path.startsWith(`${jobRoot}${sep}`) && (await stat(path).catch(() => null))?.isFile())) return false;
    const fileStat = await stat(path);
    return Number(artifact.bytes) === fileStat.size && await hashFile(path) === artifact.sha256;
  }));
  if (!verified.every(Boolean)) return null;
  const eventArtifact = immutableArtifacts.filter((artifact) => artifact.name === `runs/${job.runId}/events.jsonl` && artifact.path === expectedPath(artifact.name)).at(-1);
  if (!eventArtifact) return null;
  const eventPath = resolve(jobRoot, eventArtifact.path);
  const events = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const qualityArtifact = immutableArtifacts.find((artifact) => artifact.name === "quality.json" && artifact.path === expectedPath(artifact.name));
  const expectedProviderDecision = {
    requested: job.provider,
    selected: job.provider,
    fallbackUsed: false,
    policy: job.provider === "gemini-browser" ? "no-local-video-fallback" : job.provider === "local-video" ? "local-video-command-adapter-no-fallback" : job.provider === GROK_IMAGINE_PROVIDER ? "official-grok-cli-imagine-factory-no-fallback" : "local-upload-edit"
  };
  const expectedProviderDecisionHash = hashJson(expectedProviderDecision);
  const providerDecisionEvent = events.find((event) => event.type === "provider_decision");
  const providerDecisionBound = Boolean(
    manifest.providerDecision
    && hashJson(manifest.providerDecision) === expectedProviderDecisionHash
    && manifest.providerDecisionHash === expectedProviderDecisionHash
    && providerDecisionEvent?.jobId === job.id
    && providerDecisionEvent.runId === job.runId
    && providerDecisionEvent.decisionHash === expectedProviderDecisionHash
  );
  const quality = qualityArtifact ? JSON.parse(await readFile(resolve(jobRoot, qualityArtifact.path), "utf8")) : null;
  if (!quality || quality.jobId !== job.id || quality.runId !== job.runId) return null;
  const manifestQualitySummary = manifest.qualitySummary;
  const qualitySummaryFields = ["status", "totalScore", "threshold", "semanticGate", "runId", "blockers"];
  const summaryMatches = Boolean(manifestQualitySummary && qualitySummaryFields.every((field) => JSON.stringify(manifestQualitySummary[field]) === JSON.stringify(quality[field])));
  const terminalEvent = events.at(-1);
  const terminalSummary = terminalEvent?.qualitySummary;
  const terminalEventBound = Boolean(
    terminalEvent?.type === "quality_finalized"
      && terminalEvent.jobId === job.id
      && terminalEvent.runId === job.runId
      && terminalEvent.status === manifest.runStatus
      && terminalEvent.qualityHash === qualityArtifact.sha256
      && terminalSummary?.runId === quality.runId
      && qualitySummaryFields.every((field) => JSON.stringify(terminalSummary[field]) === JSON.stringify(quality[field]))
  );
  if (!providerDecisionBound || !summaryMatches || !terminalEventBound) return null;
  const qualitySummary = {
    status: quality.status,
    totalScore: quality.totalScore,
    threshold: quality.threshold,
    semanticGate: quality.semanticGate,
    runId: quality.runId,
    blockers: quality.blockers,
    inputManifest: manifestQualitySummary.inputManifest || quality.inputManifest || quality.metrics?.inputManifest || null
  };
  const artifactUrl = (path) => `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(path)}`;
  const immutableDeclarations = immutableArtifacts.map(({ path, kind }) => ({ name: path, kind: `immutable-${kind || "artifact"}`, url: artifactUrl(path) }));
  return updateJob(job.id, {
    status: "completed",
    stage: "완료",
    progress: 100,
    message: qualitySummary?.semanticGate ? `영상 제작과 AHP 검사가 완료되었습니다. (${qualitySummary.totalScore}점)` : `영상 제작 완료 · 기계 검사 ${qualitySummary?.totalScore ?? quality?.totalScore ?? 0}점 · 의미론 판정 보류`,
    artifacts: [...immutableDeclarations, { name: `runs/${job.runId}/manifest.json`, kind: "run-manifest", url: `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(`runs/${job.runId}/manifest.json`)}` }],
    duration: quality?.metrics?.finalMedia?.duration ?? job.duration ?? null,
    scriptGeneratedBy: manifest.script?.generatedBy || job.scriptGeneratedBy,
    qualitySummary,
    runId: job.runId,
    runStatus: manifest.runStatus || "needs-improvement",
    error: null
  });
}

async function closeStaleRun(job) {
  if (!job.runId) return;
  const runDir = join(JOBS_DIR, job.id, "runs", job.runId);
  const manifest = await readRunManifest(runDir);
  const recoveredAt = new Date().toISOString();
  if (!manifest) {
    await mkdir(runDir, { recursive: true });
    await writeRunManifest(runDir, {
      schemaVersion: 1,
      jobId: job.id,
      runId: job.runId,
      status: "failed",
      runStatus: "failed",
      failedAt: recoveredAt,
      artifacts: [],
      immutableArtifacts: [],
      recovery: { type: "stale-lease", recoveredAt, reason: "stale job lease recovered without a readable manifest" }
    });
    return;
  }
  await appendRunEvent(runDir, {
    type: "recovered_stale",
    status: "failed",
    reason: "stale job lease recovered",
    runId: job.runId
  });
  const eventsPath = join(runDir, "events.jsonl");
  await writeRunManifest(runDir, {
    ...manifest,
    status: "failed",
    runStatus: "failed",
    failedAt: recoveredAt,
    artifacts: [],
    immutableArtifacts: [],
    eventLog: { path: `runs/${job.runId}/events.jsonl`, sha256: await hashFile(eventsPath) },
    recovery: {
      type: "stale-lease",
      recoveredAt,
      reason: "stale job lease recovered"
    }
  });
}

async function recoverStaleJob(job) {
  if (!["running", "verifying"].includes(job.status) || isFreshRunningJob(job)) return job;
  let lease = null;
  let current = null;
  try {
    lease = await acquireJobLease(job.id);
    if (!lease) return job;
    current = await readJob(job.id).catch(() => null);
    if (!current || !["running", "verifying"].includes(current.status) || isFreshRunningJob(current)) return current || job;
    const leaseRecord = await readLeaseRecord(lease.lockPath);
    if (!leaseRecord || leaseRecord.token !== lease.token) return current;
    const runManifest = current.runId ? await readRunManifest(join(JOBS_DIR, current.id, "runs", current.runId)) : null;
    if (runManifest?.status === "completed") {
      const restored = await rehydrateCompletedRun(current, runManifest);
      if (restored) return restored;
    }
    await closeStaleRun(current);
    return await updateJob(job.id, {
      status: "failed",
      stage: "오류",
      message: "이전 실행 프로세스가 종료되어 작업을 중단했습니다. 다시 실행하세요.",
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  } catch (error) {
    let closureError = null;
    try {
      await closeStaleRun(current);
    } catch (closeError) {
      closureError = closeError;
      if (current?.runId) {
        const runDir = join(JOBS_DIR, current.id, "runs", current.runId);
        const manifest = await readRunManifest(runDir).catch(() => null);
        if (manifest) {
          await writeRunManifest(runDir, {
            ...manifest,
            status: "failed",
            runStatus: "failed",
            failedAt: new Date().toISOString(),
            artifacts: [],
            immutableArtifacts: [],
            recovery: { type: "stale-rehydrate-failed", reason: closeError.message }
          }).catch(() => {});
        }
      }
    }
    return await updateJob(job.id, {
      status: "failed",
      stage: "오류",
      message: `이전 실행 복구에 실패했습니다: ${error.message}`,
      error: [error.stack || error.toString(), closureError ? `stale-run closure failed: ${closureError.message}` : null].filter(Boolean).join("\n"),
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
  } finally {
    if (lease) await releaseJobLease(lease).catch(() => {});
  }
}

async function recoverStaleJobs(jobs) {
  return Promise.all(jobs.map((job) => recoverStaleJob(job)));
}
async function sealQualityRevision(jobId, runId, review, quality) {
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const baseManifestPath = join(runDir, "manifest.json");
  const baseManifest = await readRunManifest(runDir);
  if (!baseManifest || baseManifest.status !== "completed" || baseManifest.jobId !== jobId || baseManifest.runId !== runId) {
    throw new Error("완료된 run manifest가 없는 실행에는 위원회 리뷰를 봉인할 수 없습니다.");
  }
  if (!review?.runId || review.runId !== runId || (review.jobId && review.jobId !== jobId)) {
    throw new Error("위원회 리뷰가 현재 jobId·runId에 결속되어 있지 않습니다.");
  }
  if (!quality || quality.jobId !== jobId || quality.runId !== runId) {
    throw new Error("위원회 품질 산출물이 현재 jobId·runId에 결속되어 있지 않습니다.");
  }
  const revisionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const revisionDir = join(runDir, "revisions", revisionId);
  await mkdir(revisionDir, { recursive: true });
  const relative = (path) => path.slice(jobDir.length + 1);
  const artifactUrl = (name) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
  const reviewPath = join(revisionDir, "committee-review.json");
  const qualityPath = join(revisionDir, "quality.json");
  const eventsPath = join(revisionDir, "events.jsonl");
  await writeFile(reviewPath, JSON.stringify(review, null, 2));
  await writeFile(qualityPath, JSON.stringify(quality, null, 2));
  const reviewHash = await hashFile(reviewPath);
  const qualityHash = await hashFile(qualityPath);
  await writeFile(eventsPath, `${JSON.stringify({ schemaVersion: 1, type: "committee_reviewed", jobId, runId, revisionId, reviewHash, qualityHash, createdAt: new Date().toISOString() })}\n`);
  const eventHash = await hashFile(eventsPath);
  const revisionManifestPath = join(revisionDir, "manifest.json");
  const revisionManifest = {
    schemaVersion: 1,
    type: "quality-revision",
    status: "completed",
    jobId,
    runId,
    revisionId,
    createdAt: new Date().toISOString(),
    parentManifest: { path: relative(baseManifestPath), sha256: await hashFile(baseManifestPath) },
    committeeReview: { path: relative(reviewPath), sha256: reviewHash },
    quality: { path: relative(qualityPath), sha256: qualityHash },
    events: { path: relative(eventsPath), sha256: eventHash }
  };
  await writeFile(revisionManifestPath, JSON.stringify(revisionManifest, null, 2));
  const paths = [
    [relative(reviewPath), "committee-review-revision", reviewHash],
    [relative(qualityPath), "quality-revision", qualityHash],
    [relative(eventsPath), "quality-revision-events", eventHash],
    [relative(revisionManifestPath), "quality-revision-manifest", await hashFile(revisionManifestPath)]
  ];
  return {
    revisionId,
    manifestPath: relative(revisionManifestPath),
    artifacts: await Promise.all(paths.map(async ([name, kind, sha256]) => ({
      name,
      kind,
      bytes: (await stat(join(jobDir, name))).size,
      sha256,
      url: artifactUrl(name)
    })))
  };
}
async function markLaunchFailure(jobId, error) {
  const current = await readJob(jobId).catch(() => null);
  if (!current || current.status === "completed") return current;
  return updateJob(jobId, {
    status: "failed",
    stage: "오류",
    message: `실행 시작 실패: ${error.message}`,
    error: error.stack || error.toString(),
    runStatus: "failed",
    warnings: [...(current.warnings || []), `실행 시작 실패: ${error.message}`]
  });
}

async function startJob(jobId) {
  if (activeJobs.has(jobId)) return false;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  void withJob(jobId, async () => {
    let lease = null;
    try {
      lease = await acquireJobLease(jobId);
      if (!lease) {
        resolveStarted(false);
        return;
      }
      resolveStarted(true);
      await runJob(jobId);
    } catch (error) {
      console.error(`job ${jobId} failed to start: ${error.message}`);
      await markLaunchFailure(jobId, error).catch((persistError) => console.error(`job ${jobId} start failure persistence failed: ${persistError.message}`));
      resolveStarted(false);
    } finally {
      if (lease) await releaseJobLease(lease);
    }
  }).catch(async (error) => {
    console.error(`job ${jobId} runner failed: ${error.message}`);
    await markLaunchFailure(jobId, error).catch((persistError) => console.error(`job ${jobId} runner failure persistence failed: ${persistError.message}`));
    resolveStarted(false);
  });
  return started;
}

async function health() {
  const browser = await geminiBrowserStatus();
  const ytDlp = await ytDlpInfo();
  const command = (name) => typeof Bun.which === "function" && Boolean(Bun.which(name));
  return {
    ok: true,
    service: "ps4-ai-video-studio",
    browser,
    capabilities: {
      ffmpeg: command("ffmpeg"),
      ffprobe: command("ffprobe"),
      macSay: command("say"),
      geminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      localVideoGenerator: Boolean(String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()),
      grokCli: Boolean(resolveGrokBinary()),
      ytDlp
    },
    analysis: existsSync(ANALYSIS_PATH),
    rlmAnalysis: existsSync(join(ROOT, "data/rlm-benchmark-analysis.json"))
  };
}

async function handleApi(request, url) {
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") return json(await health());
  if (path === "/api/gemini/monitor" && request.method === "GET") return json(await readOptionalJson(join(ROOT, "workspace", "gemini-monitor.json")) || { schemaVersion: 2, status: "not-running", profiles: [] });
  if (path === "/api/channel" && request.method === "GET") return json(await readAnalysis());
  if (path === "/api/benchmark/profile" && request.method === "GET") {
    return json({
      duration: await readOptionalJson(join(ROOT, "data/shorts-metadata.json")),
      rlm: await readOptionalJson(join(ROOT, "data/rlm-benchmark-analysis.json")),
      media: await readOptionalJson(join(ROOT, "data/benchmark-media-analysis.json"))
    });
  }
  if (path === "/api/channel/videos" && request.method === "GET") {
    const analysis = await readAnalysis();
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const category = url.searchParams.get("category") || "";
    const sort = url.searchParams.get("sort") || "views";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 24)));
    let videos = analysis.videos.filter((video) => {
      const matchesQuery = !query || video.title.toLowerCase().includes(query);
      const matchesCategory = !category || video.analysis.categories.some((item) => item.id === category);
      return matchesQuery && matchesCategory;
    });
    videos.sort((a, b) => sort === "recent" ? a.position - b.position : b.viewCount - a.viewCount);
    const start = (page - 1) * limit;
    return json({ total: videos.length, page, limit, videos: videos.slice(start, start + limit) });
  }
  if (path === "/api/jobs" && request.method === "GET") return json({ jobs: await recoverStaleJobs(await listJobs()) });
  if (path === "/api/jobs" && request.method === "POST") {
    try {
      const body = await readJson(request);
      if (!body.topic || String(body.topic).trim().length < 4) throw new Error("영상 주제를 4자 이상 입력하세요.");
      const job = await createJob(body);
      if (job.provider === "gemini-browser" || job.provider === GROK_IMAGINE_PROVIDER) {
        await startJob(job.id);
      } else if (body.autoStart === true) {
        if (job.provider === "local-video") {
          if (!String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim()) throw new Error("PS4_LOCAL_VIDEO_GENERATOR가 설정되지 않아 local-video 자동 시작을 수행할 수 없습니다.");
          await startJob(job.id);
        } else {
          if (!(await hasUploadedVideo(job.id))) throw new Error("로컬 자동 시작에는 업로드된 영상 클립이 하나 이상 필요합니다.");
          await startJob(job.id);
        }
      }
      return json({ job }, 201);
    } catch (error) {
      return errorResponse(error, 400);
    }
  }
  if (path === "/api/browser/start" && request.method === "POST") return json(await startGeminiBrowser());

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2] || "";
    if (!JOB_ID_PATTERN.test(jobId)) return errorResponse(new Error("잘못된 작업 ID입니다."), 400);
    if (request.method === "GET" && suffix === "quality") {
      const current = await readJob(jobId);
      if (!current.runId) return errorResponse(new Error("현재 실행 산출물이 없어 품질 검사를 시작할 수 없습니다."), 409);
      const quality = await readVerifiedQuality(current);
      if (!quality) return errorResponse(new Error("봉인된 현재 품질 산출물을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json(quality);
    }
    if (request.method === "GET" && suffix === "quality/history") {
      const current = await readJob(jobId);
      if (!current.runId) return json({ iterations: [] });
      const iterations = await readVerifiedQualityHistory(current);
      if (iterations === null) return errorResponse(new Error("봉인된 품질 이력을 찾지 못했거나 무결성 검증에 실패했습니다."), 409);
      return json({ iterations });
    }
    if (request.method === "POST" && suffix === "quality/evaluate") {
      try {
        const body = await readJson(request);
        if (body.runId && body.runId !== (await readJob(jobId)).runId) return errorResponse(new Error("품질 검사는 현재 작업의 runId만 허용합니다."), 409);
        const quality = await withQualityLease(jobId, (lockedJob) => {
          if (body.runId && body.runId !== lockedJob.runId) throw new Error("품질 검사는 현재 작업의 runId만 허용합니다.");
          return evaluateJob(jobId, { iteration: Number(body.iteration || 1), runId: lockedJob.runId, persist: false });
        });
        if (!quality) return errorResponse(new Error("작업 실행 중에는 품질 검사를 시작할 수 없습니다."), 409);
        return json(quality);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "POST" && suffix === "quality-loop") {
      try {
        const body = await readJson(request);
        if (body.runId && body.runId !== (await readJob(jobId)).runId) return errorResponse(new Error("품질 반복 검사는 현재 작업의 runId만 허용합니다."), 409);
        const result = await withQualityLease(jobId, (lockedJob) => {
          if (body.runId && body.runId !== lockedJob.runId) throw new Error("품질 반복 검사는 현재 작업의 runId만 허용합니다.");
          return runQualityLoop(jobId, { maxIterations: body.maxIterations || 3, runId: lockedJob.runId, persist: false });
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 품질 검사를 시작할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "POST" && suffix === "committee-review") {
      try {
        const reviewInput = await readJson(request);
        const result = await withQualityLease(jobId, async (lockedJob) => {
          const review = await saveCommitteeReview(jobId, reviewInput);
          const quality = await evaluateJob(jobId, { iteration: Number(review.iteration || 1), runId: lockedJob.runId, persist: false, committee: review, allowPostPublicationRevision: true, reuseExistingAnalysis: true, reuseEvidenceFrames: true });
          const revision = await sealQualityRevision(jobId, lockedJob.runId, review, quality);
          const revisionNames = new Set(revision.artifacts.map((artifact) => artifact.name));
          const job = await updateJob(jobId, {
            artifacts: [...(lockedJob.artifacts || []).filter((artifact) => !revisionNames.has(artifact.name)), ...revision.artifacts],
            qualitySummary: {
              status: quality.status,
              totalScore: quality.totalScore,
              threshold: quality.threshold,
              semanticGate: quality.semanticGate,
              runId: quality.runId,
              blockers: quality.blockers,
              revisionId: revision.revisionId,
              revisionManifest: revision.manifestPath
            }
          });
          return { review, quality, revision, job };
        });
        if (!result) return errorResponse(new Error("작업 실행 중에는 위원회 검수를 시작할 수 없습니다."), 409);
        return json(result);
      } catch (error) {
        return qualityErrorResponse(error);
      }
    }
    if (request.method === "GET" && !suffix) return json(await readJob(jobId));
    if (request.method === "POST" && suffix === "run") {
      const current = await readJob(jobId);
      if (activeJobs.has(jobId) || isFreshRunningJob(current)) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      if (!(await startJob(jobId))) return errorResponse(new Error("이미 실행 중인 작업입니다."), 409);
      return json({ started: true, job: await readJob(jobId) });
    }
    if (request.method === "POST" && suffix === "clips") {
      if (activeJobs.has(jobId)) return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
      const current = await readJob(jobId);
      if (isFreshRunningJob(current)) return errorResponse(new Error("실행 중에는 클립을 업로드할 수 없습니다."), 409);
      const lease = await acquireJobLease(jobId);
      if (!lease) return errorResponse(new Error("다른 프로세스가 작업을 사용 중입니다."), 409);
      try {
        const form = await request.formData();
        const files = form.getAll("files").filter((value) => value instanceof File);
        if (!files.length) throw new Error("업로드할 영상 파일을 선택하세요.");
        for (const file of files) {
          const extension = extname(file.name).toLowerCase();
          if (!VIDEO_EXTENSIONS.has(extension) || (file.type && !file.type.startsWith("video/"))) throw new Error("MP4, MOV, WebM 영상만 업로드할 수 있습니다.");
          if (file.size > MAX_UPLOAD_BYTES) throw new Error("클립 하나의 최대 크기는 250MB입니다.");
        }
        const jobDir = join(JOBS_DIR, jobId);
        const stagingDir = join(jobDir, `.clips-upload-${randomUUID()}`);
        const previousClipsDir = join(jobDir, `.clips-previous-${randomUUID()}`);
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });
        try {
          const uploaded = [];
          for (const file of files) uploaded.push(await copyUpload(jobId, file, stagingDir));
          await updateJob(jobId, {
            message: `${uploaded.length}개 클립 업로드를 반영하는 중입니다. 기존 실행 증거를 무효화합니다.`,
            stage: "소스 준비",
            status: "queued",
            runId: null,
            runStatus: "queued",
            qualitySummary: null,
            artifacts: [],
            duration: null,
            error: null
          });
          const clipsDir = join(jobDir, "clips");
          const hadPreviousClips = existsSync(clipsDir);
          if (hadPreviousClips) await rename(clipsDir, previousClipsDir);
          try {
            await rename(stagingDir, clipsDir);
          } catch (error) {
            if (hadPreviousClips) await rename(previousClipsDir, clipsDir).catch(() => {});
            throw error;
          }
          await rm(previousClipsDir, { recursive: true, force: true });
          const mutableFiles = [
            "final.mp4",
            "assembled.mp4",
            "voiced.mp4",
            "voiceover.aiff",
            "concat.txt",
            "captions.srt",
            "captions.vtt",
            "caption-timing.json",
            "script.json",
            "sources.json",
            "frame-audio-caption.json",
            "thumbnail.jpg",
            "quality.json",
            "committee-review.json",
            "gemini-generation.json"
          ];
          await Promise.all(mutableFiles.map((name) => unlink(join(jobDir, name)).catch(() => {})));
          await rm(join(jobDir, "quality"), { recursive: true, force: true });
          await rm(join(jobDir, "normalized"), { recursive: true, force: true });
          await mkdir(join(jobDir, "normalized"), { recursive: true });
          const finalizedUploads = uploaded.map((item) => ({ ...item, path: join(clipsDir, basename(item.path)) }));
          const job = await updateJob(jobId, { message: `${uploaded.length}개 클립이 업로드되었습니다. 기존 실행 증거를 무효화하고 새 실행을 대기합니다.` });
          return json({ uploaded: finalizedUploads, job }, 201);
        } finally {
          await rm(stagingDir, { recursive: true, force: true });
        }
      } finally {
        await releaseJobLease(lease);
      }
    }
    if (request.method === "GET" && suffix.startsWith("artifacts/")) {
      let filename;
      try {
        filename = decodeURIComponent(suffix.slice("artifacts/".length));
      } catch {
        return errorResponse(new Error("잘못된 산출물 경로입니다."), 400);
      }
      let artifact;
      try {
        artifact = safeArtifactPath(jobId, filename);
      } catch (error) {
        return errorResponse(error, 403);
      }
      const job = await readJob(jobId);
      const declaredArtifacts = new Set(Array.isArray(job.artifacts) ? job.artifacts.map((entry) => entry?.name).filter((name) => typeof name === "string") : []);
      if (!declaredArtifacts.has(filename)) return errorResponse(new Error("선언되지 않은 작업 산출물입니다."), 404);
      const immutableMatch = /^runs\/([^/]+)\/artifacts\/(.+)$/.exec(filename);
      if (immutableMatch) {
        const [, immutableRunId] = immutableMatch;
        const manifest = await readRunManifest(join(JOBS_DIR, jobId, "runs", immutableRunId));
        const declaration = manifest?.immutableArtifacts?.find((entry) => entry?.path === filename);
        if (immutableRunId !== job.runId || manifest?.jobId !== jobId || manifest?.runId !== immutableRunId || !declaration?.sha256) {
          return errorResponse(new Error("불변 산출물 무결성 선언을 찾지 못했습니다."), 409);
        }
        const actualHash = await hashFile(artifact).catch(() => null);
        if (actualHash !== declaration.sha256) return errorResponse(new Error("불변 산출물 무결성 검증에 실패했습니다."), 409);
      }
      const revisionMatch = /^runs\/([^/]+)\/revisions\/([^/]+)\/(.+)$/.exec(filename);
      if (revisionMatch) {
        const [, revisionRunId, revisionId, revisionFile] = revisionMatch;
        const revisionManifestPath = join(JOBS_DIR, jobId, "runs", revisionRunId, "revisions", revisionId, "manifest.json");
        const revisionManifest = await readOptionalJson(revisionManifestPath);
        const revisionDeclaration = Object.values(revisionManifest || {}).find((value) => value?.path === filename && String(value.sha256 || "").startsWith("sha256:"));
        const jobDeclaration = Array.isArray(job.artifacts) ? job.artifacts.find((entry) => entry?.name === filename && String(entry?.sha256 || "").startsWith("sha256:")) : null;
        const expectedHash = jobDeclaration?.sha256;
        const declarationBound = revisionFile === "manifest.json" ? Boolean(expectedHash) : Boolean(revisionDeclaration?.sha256 && revisionDeclaration.sha256 === expectedHash);
        if (revisionRunId !== job.runId || revisionManifest?.jobId !== jobId || revisionManifest?.runId !== revisionRunId || revisionManifest?.revisionId !== revisionId || !declarationBound) {
          return errorResponse(new Error("품질 revision 무결성 선언을 찾지 못했습니다."), 409);
        }
        const actualHash = await hashFile(artifact).catch(() => null);
        if (actualHash !== expectedHash) return errorResponse(new Error("품질 revision 무결성 검증에 실패했습니다."), 409);
      }
      const file = Bun.file(artifact);
      if (!(await file.exists())) return errorResponse(new Error("파일을 찾지 못했습니다."), 404);
      const headers = { "content-type": contentType(artifact), "cache-control": "no-store" };
      if (filename === "final.mp4") headers["content-disposition"] = `inline; filename="${filename}"`;
      return new Response(file, { headers });
    }
  }
  return null;
}

async function serveStatic(pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const path = resolve(PUBLIC_DIR, requested);
  if (!(path === PUBLIC_DIR || path.startsWith(`${PUBLIC_DIR}${sep}`))) return new Response("Not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "content-type": contentType(path), "cache-control": "no-cache" } });
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, url);
        return response || errorResponse(new Error("API 경로를 찾지 못했습니다."), 404);
      }
      return await serveStatic(url.pathname);
    } catch (error) {
      console.error(error);
      return errorResponse(error, error?.message?.includes("찾지") ? 404 : 500);
    }
  }
});

console.log(`PS4 AI Video Studio: http://localhost:${server.port}`);
