import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { analyzeClipMotion, clipMotionGatePolicy, clipMotionGateRequired, hasEvidenceHookFraming, JOBS_DIR, ROOT, readJob, verifyEvidenceBoundScript } from "./pipeline.mjs";
import { analyzeJobMedia } from "./frame-analysis.mjs";
import { canonicalGeminiSessionBinding, canonicalJsonHash, geminiSessionBindingHash } from "./provenance.mjs";
import { hashFile } from "./run-ledger.mjs";

export { canonicalGeminiSessionBinding, canonicalJsonHash, geminiSessionBindingHash } from "./provenance.mjs";

export const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 증거·미디어 규격", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "출처 텍스트 결속·벤치마크 적합성", weight: 10 },
  { id: "automationRecovery", label: "자동화 재현성·실패 복구", weight: 10 }
];

const RANDOM_INDEX = { 1: 0, 2: 0, 3: 0.58, 4: 0.9, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49 };
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const REQUIRED_ARTIFACTS = ["final.mp4", "captions.srt", "script.json", "thumbnail.jpg"];
const QUALITY_DIR = "quality";
const SUPPORTED_PROVIDERS = new Set(["local", "local-video", "gemini-browser"]);
const QUALITY_REVISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/;
export const QUALITY_REVISION_SCHEMA_VERSION = 2;
const runtimeQualityEvaluationHashes = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function hashJson(value) {
  return canonicalJsonHash(value);
}

function normalizedIdentity(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizedSha256(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function attestationPayload(value) {
  if (!isPlainObject(value)) return null;
  const { sha256: _sha256, hash: _hash, ...payload } = value;
  return Object.keys(payload).length ? payload : null;
}

export function committeeEvidenceHash(evidenceHashes) {
  if (!isPlainObject(evidenceHashes) || !Object.keys(evidenceHashes).length) return null;
  if (Object.values(evidenceHashes).some((value) => !normalizedSha256(value))) return null;
  return hashJson(Object.fromEntries(Object.entries(evidenceHashes).map(([path, hash]) => [path, normalizedSha256(hash)])));
}

export function committeeAttestationHash(attestation) {
  const payload = attestationPayload(attestation);
  return payload ? hashJson(payload) : null;
}

export function qualityEvaluationState({ jobStatus, manifestStatus, manifestRunStatus, finalization = false, allowPostPublicationRevision = false } = {}) {
  const finalizationEligible = finalization === true
    && jobStatus === "verifying"
    && manifestStatus === "finalizing"
    && ["verified", "needs-improvement"].includes(manifestRunStatus);
  const revisionEligible = allowPostPublicationRevision === true
    && jobStatus === "needs-improvement"
    && manifestStatus === "needs-improvement"
    && manifestRunStatus === "needs-improvement";
  return {
    phase: finalizationEligible ? "finalization" : revisionEligible ? "post-publication-revision" : "ineligible",
    semanticGateEligible: finalizationEligible || revisionEligible,
    finalizationEligible,
    revisionEligible
  };
}

export function deriveQualityRevisionTransition(fromStatus, quality) {
  if (fromStatus !== "needs-improvement") throw new Error("품질 revision은 needs-improvement 상태에서만 시작할 수 있습니다.");
  if (!quality || !["passed", "needs-improvement"].includes(quality.status) || typeof quality.semanticGate !== "boolean") {
    throw new Error("품질 revision 결과에 status와 semanticGate가 필요합니다.");
  }
  const promoted = quality.status === "passed" && quality.semanticGate === true && (!Array.isArray(quality.blockers) || quality.blockers.length === 0);
  if (quality.status === "passed" && !promoted) throw new Error("passed 품질 revision은 열린 semanticGate와 빈 blocker 집합이 필요합니다.");
  return {
    from: "needs-improvement",
    to: promoted ? "completed" : "needs-improvement",
    kind: promoted ? "promotion" : "remediation",
    terminal: promoted
  };
}

export function buildQualityRevisionEvent({ context, committeeReview, qualityArtifact, transition, createdAt = new Date().toISOString() }) {
  validateQualityRevisionContext(context);
  if (!normalizedSha256(committeeReview?.sha256) || !normalizedSha256(qualityArtifact?.sha256)) throw new Error("품질 revision 이벤트에는 위원회 리뷰와 품질 산출물 해시가 필요합니다.");
  if (!transition || transition.from !== "needs-improvement" || !["completed", "needs-improvement"].includes(transition.to)) throw new Error("품질 revision 이벤트 상태 전이가 유효하지 않습니다.");
  return {
    schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
    type: "quality_revision_sealed",
    jobId: context.jobId,
    runId: context.runId,
    revisionId: context.revisionId,
    sequence: Number(context.sequence),
    createdAt,
    baseManifestHash: context.baseManifest.sha256,
    baseQualityHash: context.baseQuality.sha256,
    supersedes: context.supersedes,
    committeeReviewHash: committeeReview.sha256,
    qualityHash: qualityArtifact.sha256,
    transition
  };
}

export function validateQualityRevisionEvent(event, manifest) {
  if (
    !event
    || event.schemaVersion !== QUALITY_REVISION_SCHEMA_VERSION
    || event.type !== "quality_revision_sealed"
    || event.jobId !== manifest?.jobId
    || event.runId !== manifest?.runId
    || event.revisionId !== manifest?.revisionId
    || Number(event.sequence) !== Number(manifest?.sequence)
    || event.baseManifestHash !== manifest?.baseManifest?.sha256
    || event.baseQualityHash !== manifest?.baseQuality?.sha256
    || hashJson(event.supersedes) !== hashJson(manifest?.supersedes)
    || event.committeeReviewHash !== manifest?.committeeReview?.sha256
    || event.qualityHash !== manifest?.quality?.sha256
    || hashJson(event.transition) !== hashJson(manifest?.transition)
  ) throw new Error("품질 revision 봉인 이벤트가 manifest 상태 전이와 결속되지 않았습니다.");
  return true;
}

function qualityRevisionRefEqual(left, right) {
  return Boolean(left && right
    && left.type === right.type
    && left.path === right.path
    && left.sha256 === right.sha256
    && Number(left.sequence) === Number(right.sequence)
    && (left.revisionId || null) === (right.revisionId || null)
    && left.effectiveStatus === right.effectiveStatus);
}

export function validateQualityRevisionContext(context) {
  if (!context || typeof context !== "object") throw new Error("품질 revision context가 필요합니다.");
  const { jobId, runId, revisionId, sequence, baseManifest, baseQuality, supersedes } = context;
  if (!jobId || !runId || !QUALITY_REVISION_ID_PATTERN.test(String(revisionId || ""))) throw new Error("품질 revision의 jobId·runId·revisionId가 유효하지 않습니다.");
  if (!Number.isInteger(Number(sequence)) || Number(sequence) < 1) throw new Error("품질 revision sequence는 1 이상의 정수여야 합니다.");
  const expectedBaseManifestPath = `runs/${runId}/manifest.json`;
  const expectedBaseQualityPath = `runs/${runId}/artifacts/quality.json`;
  if (baseManifest?.path !== expectedBaseManifestPath || !normalizedSha256(baseManifest?.sha256) || baseManifest?.status !== "needs-improvement") {
    throw new Error("품질 revision은 불변 needs-improvement base manifest에 결속되어야 합니다.");
  }
  if (baseQuality?.path !== expectedBaseQualityPath || !normalizedSha256(baseQuality?.sha256)) throw new Error("품질 revision의 base quality 선언이 유효하지 않습니다.");
  if (Number(sequence) === 1) {
    if (!qualityRevisionRefEqual(supersedes, { type: "base-run", path: expectedBaseManifestPath, sha256: baseManifest.sha256, sequence: 0, revisionId: null, effectiveStatus: "needs-improvement" })) {
      throw new Error("첫 품질 revision은 base run manifest를 supersede해야 합니다.");
    }
  } else {
    const expectedPreviousPath = `runs/${runId}/revisions/${supersedes?.revisionId || ""}/manifest.json`;
    if (supersedes?.type !== "quality-revision" || supersedes.path !== expectedPreviousPath || !normalizedSha256(supersedes.sha256) || Number(supersedes.sequence) !== Number(sequence) - 1 || supersedes.effectiveStatus !== "needs-improvement") {
      throw new Error("후속 품질 revision은 직전 needs-improvement revision manifest를 supersede해야 합니다.");
    }
  }
  return true;
}

export function bindQualityRevision(quality, context, committeeReviewHash) {
  validateQualityRevisionContext(context);
  const reviewHash = normalizedSha256(committeeReviewHash);
  if (!reviewHash) throw new Error("품질 revision에 봉인된 위원회 리뷰 해시가 필요합니다.");
  if (quality?.jobId !== context.jobId || quality?.runId !== context.runId) throw new Error("품질 산출물이 revision jobId·runId에 결속되어 있지 않습니다.");
  if (quality?.metrics?.evaluationPhase !== "post-publication-revision" || quality?.metrics?.revisionEvaluationEligible !== true) {
    throw new Error("품질 산출물이 post-publication revision 의미론 게이트에서 평가되지 않았습니다.");
  }
  const transition = deriveQualityRevisionTransition("needs-improvement", quality);
  return {
    ...quality,
    revisionId: context.revisionId,
    revisionSequence: Number(context.sequence),
    revision: {
      schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
      mode: "append-only",
      revisionId: context.revisionId,
      sequence: Number(context.sequence),
      baseManifest: context.baseManifest,
      baseQuality: context.baseQuality,
      supersedes: context.supersedes,
      committeeReviewHash: reviewHash,
      transition
    }
  };
}

function expectedGeminiRequest(job, script) {
  return {
    provider: "gemini-browser",
    topic: job.topic || "",
    format: job.format || "vertical",
    clipCount: Number(job.clipCount || script?.segments?.length || 0),
    targetDurationSec: Number(job.targetDurationSec || 0),
    targetDurationRangeSec: job.targetDurationRangeSec || null,
    captions: job.captions !== false,
    voiceover: job.voiceover !== false,
    segments: (script?.segments || []).map((segment) => ({
      durationHint: segment.durationHint || null,
      visualPrompt: segment.visualPrompt || "",
      caption: segment.caption || "",
      narration: segment.narration || ""
    }))
  };
}

function expectedLocalVideoRequest(job, script, runId, scriptHash) {
  const base = {
    schemaVersion: 1,
    jobId: job.id,
    runId,
    provider: "local-video",
    topic: job.topic || "",
    format: job.format || "vertical",
    targetDurationSec: Number(job.targetDurationSec || 0),
    targetDurationRangeSec: job.targetDurationRangeSec || null,
    segments: (script?.segments || []).map((segment, index) => ({
      index: index + 1,
      durationHint: segment.durationHint || null,
      prompt: segment.visualPrompt || "",
      visualPrompt: segment.visualPrompt || "",
      caption: segment.caption || "",
      narration: segment.narration || ""
    }))
  };
  const requestHash = hashJson({ ...base, scriptHash });
  return { ...base, requestHash, scriptHash };
}

function providerPolicy(provider) {
  if (provider === "gemini-browser") return "no-local-video-fallback";
  if (provider === "local-video") return "local-video-command-adapter-no-fallback";
  return "local-upload-edit";
}

export function verifyInputMotionGate(inputManifest, provider, recomputedClipMotion = null) {
  const entries = Array.isArray(inputManifest?.entries) ? inputManifest.entries : null;
  const gate = inputManifest?.motionGate;
  const policy = clipMotionGatePolicy();
  const required = clipMotionGateRequired(provider);
  const receiptsValid = Boolean(entries?.every((entry) => (
    entry.motion?.schemaVersion === 1
    && entry.motion.algorithm === policy.algorithm
    && hashJson(entry.motion.policy) === hashJson(policy)
    && typeof entry.motion.passed === "boolean"
    && typeof entry.motion.early?.passed === "boolean"
    && typeof entry.motion.temporal?.passed === "boolean"
    && entry.motion.passed === (entry.motion.early.passed && entry.motion.temporal.passed)
    && Array.isArray(entry.motion.blockers)
  )));
  const observedPass = Boolean(receiptsValid && entries.every((entry) => entry.motion.passed));
  const expectedFailures = receiptsValid
    ? entries.filter((entry) => !entry.motion.passed).map((entry) => ({ name: entry.name, blockers: entry.motion.blockers }))
    : null;
  const recomputedBinding = !required || Boolean(
    Array.isArray(recomputedClipMotion)
    && recomputedClipMotion.length === entries?.length
    && recomputedClipMotion.every((receipt, index) => hashJson(receipt) === hashJson(entries[index].motion))
  );
  const binding = Boolean(
    inputManifest?.schemaVersion === 3
    && gate?.schemaVersion === 1
    && gate.algorithm === policy.algorithm
    && gate.provider === provider
    && gate.approvedProvider === required
    && gate.enforced === required
    && gate.observedPass === observedPass
    && gate.enforcementPass === (!required || observedPass)
    && hashJson(gate.policy) === hashJson(policy)
    && gate.policyHash === hashJson(policy)
    && Array.isArray(gate.failures)
    && expectedFailures
    && hashJson(gate.failures) === hashJson(expectedFailures)
    && receiptsValid
    && recomputedBinding
    && (!required || observedPass)
  );
  return { binding, required, observedPass, recomputedBinding };
}

function immutableRunProvider(manifest) {
  const request = manifest?.request;
  const decision = manifest?.providerDecision;
  const provider = request?.provider;
  if (
    !SUPPORTED_PROVIDERS.has(provider)
    || decision?.requested !== provider
    || decision?.selected !== provider
    || decision?.fallbackUsed !== false
    || decision?.policy !== providerPolicy(provider)
    || request?.fallbackPolicy !== providerPolicy(provider)
    || manifest?.providerDecisionHash !== hashJson(decision)
  ) return null;
  return provider;
}

function assertSealedJobRequestBinding(job, manifest) {
  const provider = immutableRunProvider(manifest);
  if (!provider) throw new Error("봉인된 run manifest의 provider 요청·결정 결속이 유효하지 않습니다.");
  const request = manifest.request;
  const fieldsMatch = job.provider === provider
    && request.topic === job.topic
    && request.format === job.format
    && Number(request.clipCount) === Number(job.clipCount)
    && Number(request.targetDurationSec) === Number(job.targetDurationSec)
    && JSON.stringify(request.targetDurationRangeSec || []) === JSON.stringify(job.targetDurationRangeSec || [])
    && request.captions === job.captions
    && request.voiceover === job.voiceover;
  if (!fieldsMatch) throw new Error("변경 가능한 job 요청이 봉인된 run manifest 요청과 일치하지 않습니다.");
  if (provider === "gemini-browser") {
    const sessionBinding = canonicalGeminiSessionBinding(job);
    const sessionBindingHash = geminiSessionBindingHash(job);
    if (
      !sessionBinding
      || !sessionBindingHash
      || hashJson(request.geminiSessionBinding) !== sessionBindingHash
      || request.geminiSessionBindingHash !== sessionBindingHash
    ) throw new Error("변경 가능한 Gemini 세션이 봉인된 run manifest 세션과 일치하지 않습니다.");
  }
  return provider;
}

function commandPath(command) {
  const fullBin = process.env.FFMPEG_FULL_BIN || "/opt/homebrew/opt/ffmpeg-full/bin";
  const override = command === "ffmpeg" ? process.env.FFMPEG_BINARY : command === "ffprobe" ? process.env.FFPROBE_BINARY : null;
  if (override && existsSync(override)) return override;
  if ((command === "ffmpeg" || command === "ffprobe") && existsSync(join(fullBin, command))) return join(fullBin, command);
  return typeof Bun.which === "function" ? Bun.which(command) : null;
}

async function commandOutput(command, args) {
  const binary = commandPath(command);
  if (!binary) return null;
  const processHandle = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  const code = await processHandle.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) return null;
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function probeMedia(path) {
  if (!existsSync(path)) return null;
  const result = await commandOutput("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  if (!result) return null;
  try {
    const payload = JSON.parse(result.stdout);
    const videoStreams = payload.streams?.filter((stream) => stream.codec_type === "video") || [];
    const audioStreams = payload.streams?.filter((stream) => stream.codec_type === "audio") || [];
    const video = videoStreams[0] || null;
    const audio = audioStreams[0] || null;
    const duration = Number(payload.format?.duration || video?.duration || audio?.duration || 0);
    const frameRate = video?.avg_frame_rate || video?.r_frame_rate || "0/1";
    const [numerator, denominator] = frameRate.split("/").map(Number);
    return {
      path,
      duration: Number.isFinite(duration) ? duration : 0,
      width: Number(video?.width || 0),
      height: Number(video?.height || 0),
      fps: denominator ? numerator / denominator : 0,
      videoStreamCount: videoStreams.length,
      audioStreamCount: audioStreams.length,
      videoCodec: video?.codec_name || null,
      audioCodec: audio?.codec_name || null,
      sampleRate: Number(audio?.sample_rate || 0),
      channels: Number(audio?.channels || 0),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio)
    };
  } catch {
    return null;
  }
}

async function readJsonOptional(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readTextOptional(path) {
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readDirectoryOrEmptyWhenMissing(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readBaseQuality(jobDir, runId, baseManifest) {
  const expectedPath = `runs/${runId}/artifacts/quality.json`;
  const declaration = (baseManifest?.immutableArtifacts || []).find((artifact) => artifact?.name === "quality.json" && artifact.path === expectedPath);
  if (!declaration || !normalizedSha256(declaration.sha256)) throw new Error("base run manifest에 불변 quality.json 선언이 없습니다.");
  const path = resolve(jobDir, declaration.path);
  if (!path.startsWith(`${resolve(jobDir)}${sep}`)) throw new Error("base quality 산출물 경로가 작업 디렉터리를 벗어납니다.");
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || Number(declaration.bytes) !== fileStat.size || await hashExisting(path) !== declaration.sha256) throw new Error("base quality 산출물 무결성 검증에 실패했습니다.");
  const value = await readJsonOptional(path);
  if (!value || value.jobId !== baseManifest.jobId || value.runId !== runId) throw new Error("base quality 산출물이 jobId·runId에 결속되어 있지 않습니다.");
  const qualityMatchesStatus = baseManifest.status === "completed"
    ? value.status === "passed" && value.semanticGate === true
    : value.status !== "passed" && value.semanticGate !== true;
  if (!qualityMatchesStatus) throw new Error("base quality 판정이 봉인된 run 상태와 일치하지 않습니다.");
  const summaryFields = ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"];
  if (!baseManifest.qualitySummary || summaryFields.some((field) => JSON.stringify(baseManifest.qualitySummary[field]) !== JSON.stringify(value[field]))) {
    throw new Error("base quality 판정이 run manifest qualitySummary와 일치하지 않습니다.");
  }
  return { path: declaration.path, sha256: declaration.sha256, bytes: fileStat.size, value };
}

async function readRevisionArtifact(jobDir, declaration, expectedPath, label, json = true) {
  validateRevisionArtifact(declaration, expectedPath, label);
  const path = resolve(jobDir, declaration.path);
  if (!path.startsWith(`${resolve(jobDir)}${sep}`)) throw new Error(`${label} revision 산출물 경로가 작업 디렉터리를 벗어납니다.`);
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || Number(declaration.bytes) !== fileStat.size || await hashExisting(path) !== declaration.sha256) throw new Error(`${label} revision 산출물 무결성 검증에 실패했습니다.`);
  return { path, value: json ? await readJsonOptional(path) : null };
}

export async function readQualityRevisionState(jobId, runId) {
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const baseManifestPath = join(runDir, "manifest.json");
  const baseManifest = await readJsonOptional(baseManifestPath);
  if (
    !baseManifest
    || baseManifest.schemaVersion !== 1
    || baseManifest.jobId !== jobId
    || baseManifest.runId !== runId
    || !["completed", "needs-improvement"].includes(baseManifest.status)
    || (baseManifest.status === "completed" ? baseManifest.runStatus !== "verified" : baseManifest.runStatus !== "needs-improvement")
    || !Array.isArray(baseManifest.ledgerErrors)
    || baseManifest.ledgerErrors.length !== 0
    || !Array.isArray(baseManifest.immutableArtifacts)
    || new Set(baseManifest.immutableArtifacts.map((artifact) => artifact?.name)).size !== baseManifest.immutableArtifacts.length
  ) {
    throw new Error("봉인된 base run manifest가 없거나 jobId·runId에 결속되어 있지 않습니다.");
  }
  const baseManifestHash = await hashExisting(baseManifestPath);
  if (!baseManifestHash) throw new Error("base run manifest 해시를 계산하지 못했습니다.");
  const baseQuality = await readBaseQuality(jobDir, runId, baseManifest);
  const baseProvider = immutableRunProvider(baseManifest);
  if (!baseProvider || baseQuality.value.metrics?.provider !== baseProvider) {
    throw new Error("base quality provider가 불변 run 요청·결정과 일치하지 않습니다.");
  }
  const revisionsDir = join(runDir, "revisions");
  const entries = (await readDirectoryOrEmptyWhenMissing(revisionsDir))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".quality-revision-staging-"));
  if (baseManifest.status === "completed" && entries.length) throw new Error("completed base run에는 품질 revision을 추가할 수 없습니다.");
  const records = [];
  for (const entry of entries) {
    if (!QUALITY_REVISION_ID_PATTERN.test(entry.name)) throw new Error(`유효하지 않은 품질 revision 디렉터리입니다: ${entry.name}`);
    const revisionEntries = await readdir(join(revisionsDir, entry.name), { withFileTypes: true });
    const expectedRevisionFiles = new Set(["manifest.json", "committee-review.json", "quality.json", "events.jsonl"]);
    if (
      revisionEntries.length !== expectedRevisionFiles.size
      || revisionEntries.some((revisionEntry) => !revisionEntry.isFile() || !expectedRevisionFiles.has(revisionEntry.name))
    ) throw new Error(`품질 revision 디렉터리는 봉인 manifest에 선언된 네 파일만 포함해야 합니다: ${entry.name}`);
    const manifestPath = join(revisionsDir, entry.name, "manifest.json");
    const manifest = await readJsonOptional(manifestPath);
    const manifestHash = await hashExisting(manifestPath);
    if (!manifest || !manifestHash) throw new Error(`미완성 품질 revision을 복구하거나 제거해야 합니다: ${entry.name}`);
    records.push({ revisionId: entry.name, manifest, manifestPath, manifestHash });
  }
  records.sort((left, right) => Number(left.manifest.sequence) - Number(right.manifest.sequence));
  const usedReviewerIds = new Set();
  const usedAttestationHashes = new Set();
  let effectiveStatus = baseManifest.status;
  let supersedes = {
    type: "base-run",
    path: `runs/${runId}/manifest.json`,
    sha256: baseManifestHash,
    sequence: 0,
    revisionId: null,
    effectiveStatus
  };
  let latestManifest = null;
  let latestManifestHash = null;
  let latestReview = null;
  let latestQuality = null;
  let latestEventRecord = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const manifest = record.manifest;
    if (effectiveStatus === "completed") throw new Error("completed 품질 revision 뒤에는 후속 revision을 추가할 수 없습니다.");
    if (manifest.revisionId !== record.revisionId || Number(manifest.sequence) !== index + 1) throw new Error("품질 revision sequence가 연속적이지 않거나 디렉터리와 일치하지 않습니다.");
    if (manifest.baseManifest?.path !== `runs/${runId}/manifest.json` || manifest.baseManifest.sha256 !== baseManifestHash || manifest.baseManifest.status !== baseManifest.status) {
      throw new Error("품질 revision이 현재 불변 base run manifest에 결속되어 있지 않습니다.");
    }
    if (manifest.baseQuality?.path !== baseQuality.path || manifest.baseQuality.sha256 !== baseQuality.sha256) throw new Error("품질 revision이 불변 base quality에 결속되어 있지 않습니다.");
    if (!qualityRevisionRefEqual(manifest.supersedes, supersedes)) throw new Error("품질 revision이 직전 유효 상태를 supersede하지 않습니다.");
    const revisionRoot = `runs/${runId}/revisions/${record.revisionId}`;
    const reviewArtifact = await readRevisionArtifact(jobDir, manifest.committeeReview, `${revisionRoot}/committee-review.json`, "위원회 리뷰");
    const qualityArtifact = await readRevisionArtifact(jobDir, manifest.quality, `${revisionRoot}/quality.json`, "품질");
    const eventsArtifact = await readRevisionArtifact(jobDir, manifest.events, `${revisionRoot}/events.jsonl`, "이벤트", false);
    const eventLines = (await readTextOptional(eventsArtifact.path)).split("\n").filter(Boolean);
    if (eventLines.length !== 1) throw new Error("품질 revision 이벤트 로그는 정확히 하나의 봉인 이벤트를 포함해야 합니다.");
    let eventRecord;
    try {
      eventRecord = JSON.parse(eventLines[0]);
    } catch {
      throw new Error("품질 revision 이벤트 로그 JSON을 해석할 수 없습니다.");
    }
    validateCommitteeReview(reviewArtifact.value, {
      expectedJobId: jobId,
      expectedRunId: runId,
      expectedEvidenceHashes: baseQuality.value.metrics?.evidenceHashes,
      usedReviewerIds,
      usedAttestationHashes
    });
    validateQualityRevisionManifest(manifest, { review: reviewArtifact.value, quality: qualityArtifact.value, eventRecord });
    record.review = reviewArtifact.value;
    record.quality = qualityArtifact.value;
    record.eventRecord = eventRecord;
    const identity = committeeReviewIdentity(reviewArtifact.value);
    identity.reviewerIds.forEach((id) => usedReviewerIds.add(id));
    identity.attestationHashes.forEach((hash) => usedAttestationHashes.add(hash));
    effectiveStatus = manifest.effectiveStatus;
    latestManifest = manifest;
    latestManifestHash = record.manifestHash;
    latestReview = reviewArtifact.value;
    latestQuality = qualityArtifact.value;
    latestEventRecord = eventRecord;
    supersedes = {
      type: "quality-revision",
      path: `runs/${runId}/revisions/${record.revisionId}/manifest.json`,
      sha256: record.manifestHash,
      sequence: Number(manifest.sequence),
      revisionId: record.revisionId,
      effectiveStatus
    };
  }
  return {
    jobId,
    runId,
    baseManifest,
    baseManifestHash,
    baseQuality,
    revisions: records.map(({ manifest, manifestHash, review, quality, eventRecord }) => ({ manifest, manifestHash, review, quality, eventRecord })),
    latestManifest,
    latestManifestHash,
    latestReview,
    latestQuality,
    latestEventRecord,
    effectiveStatus,
    nextSequence: records.length + 1,
    supersedes,
    usedReviewerIds,
    usedAttestationHashes
  };
}

export async function prepareQualityRevision(jobId, runId, revisionId) {
  const job = await readJob(jobId);
  if (job.runId !== runId) throw new Error("품질 revision은 현재 작업의 runId만 허용합니다.");
  const state = await readQualityRevisionState(jobId, runId);
  if (state.baseManifest.status !== "needs-improvement" || state.baseManifest.runStatus !== "needs-improvement") throw new Error("품질 revision은 needs-improvement base run에서만 시작할 수 있습니다.");
  if (state.effectiveStatus !== "needs-improvement") throw new Error("이미 completed로 승격된 품질 revision은 terminal 상태입니다.");
  if (job.status !== state.effectiveStatus) throw new Error("작업 상태와 봉인된 품질 revision 상태가 일치하지 않습니다.");
  const context = {
    schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
    jobId,
    runId,
    revisionId,
    sequence: state.nextSequence,
    baseManifest: { path: `runs/${runId}/manifest.json`, sha256: state.baseManifestHash, status: state.baseManifest.status },
    baseQuality: { path: state.baseQuality.path, sha256: state.baseQuality.sha256 },
    supersedes: state.supersedes
  };
  validateQualityRevisionContext(context);
  return context;
}

function parseSrtEntries(value) {
  return value.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean).filter((entry) => /\d+\n\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(entry));
}

function scoreFactors(factors) {
  const possible = factors.reduce((sum, factor) => sum + factor.max, 0);
  const earned = factors.reduce((sum, factor) => sum + (factor.pass ? factor.max : 0), 0);
  return { score: possible ? round((earned / possible) * 100) : 0, earned, possible };
}

function makeCriterion(id, label, autoScore, factors, evidence, blockers = []) {
  return { id, label, autoScore: round(autoScore), committeeScore: null, score: round(autoScore), factors, evidence, blockers: [...blockers] };
}

function isPlaceholderSource(source) {
  const value = typeof source === "string" ? source : `${source?.title || ""} ${source?.url || ""}`;
  return /주제에 맞는|확인할 출처|placeholder|예시|추후/i.test(value);
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.map((source) => typeof source === "string" ? { title: source, url: source } : source).filter((source) => source && (source.url || source.title));
}
function segmentClaimEvidence(script, sources) {
  if (!Array.isArray(script?.segments) || !script.segments.length) return false;
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  return script.segments.every((segment) => {
    const ids = Array.isArray(segment.sourceIds) ? segment.sourceIds.filter(Boolean) : [];
    const claimIds = [
      ...(segment.claimId ? [segment.claimId] : []),
      ...(Array.isArray(segment.claimIds) ? segment.claimIds : []),
      ...(Array.isArray(segment.claims) ? segment.claims.map((claim) => claim?.claimId) : [])
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const uniqueClaimIds = [...new Set(claimIds)];
    if (!ids.length || !uniqueClaimIds.length || uniqueClaimIds.length !== claimIds.length) return false;
    const segmentEvidence = Array.isArray(segment.sourceEvidence) ? segment.sourceEvidence : [];
    const resolvedSources = ids.map((id) => sourceByUrl.get(id));
    if (resolvedSources.some((source) => !source || !/^https?:\/\/\S+$/i.test(String(source.url || "")) || !String(source.sha256 || "").startsWith("sha256:") || !(Number(source.byteLength) > 0))) return false;
    const evidence = resolvedSources.flatMap((source) => [
      source,
      ...(Array.isArray(source.evidence) ? source.evidence : [])
    ]).concat(segmentEvidence).filter((item) => item && (!item.sourceId || ids.includes(item.sourceId)));
    const evidenceForClaim = (claimId) => evidence.filter((item) => {
      const itemClaimIds = [
        ...(item.claimId ? [item.claimId] : []),
        ...(Array.isArray(item.claimIds) ? item.claimIds : [])
      ].map((value) => String(value || "").trim()).filter(Boolean);
      return itemClaimIds.includes(claimId);
    });
    return uniqueClaimIds.every((claimId) => evidenceForClaim(claimId).some((item) => {
        const quote = String(item.quote || "").trim();
        const locator = String(item.locator || item.offset || "").trim();
        const explicitClaim = String(item.claimText || item.text || "").trim();
        const evidenceHash = String(item.evidenceHash || item.sha256 || "").trim();
        const hasExactQuote = quote.length > 0 && locator.length > 0;
        const hasHashedClaim = explicitClaim.length > 0 && /^sha256:[a-f0-9]{64}$/i.test(evidenceHash);
        return hasExactQuote || hasHashedClaim;
      })) && ids.every((id) => evidence.some((item) => item.sourceId === id || sourceByUrl.get(id) === item));
  });
}

function buildPairwiseMatrix() {
  return AHP_CRITERIA.map((row) => AHP_CRITERIA.map((column) => round(row.weight / column.weight, 6)));
}

function calculateAHP() {
  const matrix = buildPairwiseMatrix();
  const columnSums = AHP_CRITERIA.map((_, column) => matrix.reduce((sum, row) => sum + row[column], 0));
  const normalized = matrix.map((row) => row.map((value, column) => value / columnSums[column]));
  const weights = normalized.map((row) => row.reduce((sum, value) => sum + value, 0) / AHP_CRITERIA.length);
  const lambdaMax = weights.reduce((sum, weight, index) => sum + (matrix[index].reduce((rowSum, value, column) => rowSum + value * weights[column], 0) / weight), 0) / AHP_CRITERIA.length;
  const consistencyIndex = AHP_CRITERIA.length > 1 ? (lambdaMax - AHP_CRITERIA.length) / (AHP_CRITERIA.length - 1) : 0;
  const consistencyRatio = consistencyIndex / (RANDOM_INDEX[AHP_CRITERIA.length] || 1);
  return { matrix, weights: AHP_CRITERIA.map((criterion, index) => ({ id: criterion.id, label: criterion.label, targetWeight: criterion.weight, calculatedWeight: round(weights[index] * 100, 2) })), lambdaMax: round(lambdaMax, 6), consistencyIndex: round(consistencyIndex, 6), consistencyRatio: round(consistencyRatio, 6) };
}

function mediaTarget(format) {
  return format === "landscape" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

async function extractEvidenceFrames(jobDir, media) {
  const frameDir = join(jobDir, QUALITY_DIR, "frames");
  await mkdir(frameDir, { recursive: true });
  if (!media?.duration || !commandPath("ffmpeg")) return [];
  const moments = [...new Set([0.5, Math.max(0.5, media.duration / 2), Math.max(0.5, media.duration - 0.5)].map((value) => Math.min(Math.max(value, 0.1), Math.max(0.1, media.duration - 0.05))))];
  const frames = [];
  for (let index = 0; index < moments.length; index += 1) {
    const path = join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    const result = await commandOutput("ffmpeg", ["-y", "-i", media.path, "-ss", String(moments[index]), "-frames:v", "1", "-q:v", "2", path]);
    if (result && existsSync(path)) frames.push({ path, time: round(moments[index], 2), sha256: await hashFile(path) });
  }
  return frames;
}
async function readExistingEvidenceFrames(jobDir, media) {
  if (!media?.duration) return [];
  const moments = [...new Set([0.5, Math.max(0.5, media.duration / 2), Math.max(0.5, media.duration - 0.5)].map((value) => Math.min(Math.max(value, 0.1), Math.max(0.1, media.duration - 0.05))))];
  const frames = [];
  for (let index = 0; index < moments.length; index += 1) {
    const path = join(jobDir, QUALITY_DIR, "frames", `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    const frameStat = await stat(path).catch(() => null);
    if (!frameStat?.isFile()) return [];
    frames.push({ path, time: round(moments[index], 2), sha256: await hashFile(path) });
  }
  return frames;
}

function evidenceRelative(jobDir, path) {
  return path.startsWith(`${jobDir}/`) ? path.slice(jobDir.length + 1) : path;
}
async function hashExisting(path) {
  return existsSync(path) ? hashFile(path).catch(() => null) : null;
}

function remediationFor(criteria) {
  return [...criteria].sort((left, right) => left.score - right.score).filter((criterion) => criterion.score < 98).slice(0, 3).map((criterion) => {
    const actions = {
      hookStory: "훅·제목·장면별 내레이션·자막 필드를 모두 채우고 반전형 제목 구조를 유지하세요.",
      visualConsistency: "모든 클립의 화면비·프레임레이트를 정규화하고 대표 프레임에 대한 별도 시각 검토 증거를 추가하세요.",
      editRhythm: "장면 길이·컷 경계·오디오 팝·최종 길이를 재렌더링 후 검증하세요.",
      captionsAudio: "SRT 항목 수·벤치마크 자막 밀도·음성 트랙·샘플레이트를 대조하고 한국어 자막 프레임을 확인하세요.",
      factSourceFit: "검증 가능한 1차 출처를 대본의 sources에 연결하고 placeholder 출처를 제거하세요.",
      automationRecovery: "실패 상태·재실행·필수 산출물·클립 수를 smoke test로 다시 확인하세요."
    };
    return { criterion: criterion.label, score: criterion.score, action: actions[criterion.id] };
  });
}

export function committeeReviewIdentity(review) {
  const reviewers = Array.isArray(review?.reviewers) ? review.reviewers : [];
  return {
    reviewerIds: reviewers.map((reviewer) => normalizedIdentity(reviewer?.id)).filter(Boolean).sort(),
    attestationHashes: reviewers.map((reviewer) => normalizedSha256(reviewer?.attestationHash || reviewer?.provenanceHash)).filter(Boolean).sort(),
    evidenceHash: committeeEvidenceHash(review?.evidenceHashes)
  };
}

export function committeeDecisionHash(review) {
  if (!review || !review.jobId || !review.runId || !committeeEvidenceHash(review.evidenceHashes) || !isPlainObject(review.scores)) return null;
  return hashJson({
    jobId: String(review.jobId),
    runId: String(review.runId),
    revisionId: review.revisionId || null,
    revisionSequence: review.revisionSequence == null ? null : Number(review.revisionSequence),
    evidenceHash: committeeEvidenceHash(review.evidenceHashes),
    scores: review.scores
  });
}

export function validateCommitteeReview(review, options = {}) {
  if (!review || typeof review !== "object") throw new Error("5-method software reviewer payload JSON이 필요합니다.");
  if (!Array.isArray(review.reviewers) || review.reviewers.length !== 5) throw new Error("reviewer payload는 서로 다른 5개 role을 정확히 포함해야 합니다. 이는 5명의 실제 사람을 뜻하지 않습니다.");
  const jobId = String(review.jobId || "").trim();
  const runId = String(review.runId || "").trim();
  if (!jobId || !runId) throw new Error("위원회 리뷰는 jobId와 runId에 결속되어야 합니다.");
  if (options.expectedJobId && jobId !== options.expectedJobId) throw new Error("위원회 리뷰가 현재 작업 식별자에 결속되어 있지 않습니다.");
  if (options.expectedRunId && runId !== options.expectedRunId) throw new Error("위원회 리뷰가 현재 실행 runId에 결속되어 있지 않습니다.");
  const evidenceHash = committeeEvidenceHash(review.evidenceHashes);
  if (!evidenceHash) throw new Error("위원회 리뷰의 evidenceHashes가 비어 있거나 유효한 SHA-256 집합이 아닙니다.");
  if (review.evidenceHash && normalizedSha256(review.evidenceHash) !== evidenceHash) throw new Error("위원회 리뷰의 evidenceHash가 evidenceHashes 정규화 해시와 일치하지 않습니다.");
  if (options.expectedEvidenceHashes && evidenceHash !== committeeEvidenceHash(options.expectedEvidenceHashes)) {
    throw new Error("위원회 리뷰의 evidenceHashes가 현재 미디어·분석 산출물과 일치하지 않습니다.");
  }
  const reviewers = review.reviewers.map((reviewer) => ({
    ...reviewer,
    id: String(reviewer?.id || "").trim(),
    role: String(reviewer?.role || "").trim(),
    method: String(reviewer?.method || "").trim()
  }));
  if (reviewers.some((reviewer) => !reviewer.id || !reviewer.role || !reviewer.method)) {
    throw new Error("각 위원은 id, role, method를 포함한 attestation이 필요합니다.");
  }
  if (new Set(reviewers.map((reviewer) => normalizedIdentity(reviewer.id))).size !== reviewers.length) throw new Error("위원회 리뷰어 id는 중복될 수 없습니다.");
  if (new Set(reviewers.map((reviewer) => normalizedIdentity(reviewer.role))).size !== reviewers.length) throw new Error("위원회 리뷰어 role은 서로 달라야 합니다.");
  if (new Set(reviewers.map((reviewer) => normalizedIdentity(reviewer.method))).size !== reviewers.length) throw new Error("위원회 리뷰어 method는 서로 달라야 합니다.");
  const usedReviewerIds = new Set(Array.from(options.usedReviewerIds || [], normalizedIdentity).filter(Boolean));
  const usedAttestationHashes = new Set(Array.from(options.usedAttestationHashes || [], normalizedSha256).filter(Boolean));
  const currentAttestationHashes = new Set();
  const decisionHash = committeeDecisionHash(review);
  if (review.decisionHash != null && normalizedSha256(review.decisionHash) !== decisionHash) {
    throw new Error("위원회 리뷰의 decisionHash가 점수·증거·revision 결속의 정규화 해시와 일치하지 않습니다.");
  }
  reviewers.forEach((reviewer) => {
    const attestation = reviewer.attestation ?? reviewer.provenance ?? null;
    if (reviewer.attestation && reviewer.provenance && hashJson(reviewer.attestation) !== hashJson(reviewer.provenance)) throw new Error(`위원 ${reviewer.id}의 attestation payload 별칭이 서로 다릅니다.`);
    const declaredHashes = [reviewer.attestationHash, reviewer.provenanceHash].filter((value) => value != null && String(value).trim()).map(normalizedSha256);
    if (!declaredHashes.length || declaredHashes.some((hash) => !hash) || new Set(declaredHashes).size !== 1) throw new Error(`위원 ${reviewer.id}의 독립 attestation hash가 없거나 형식이 올바르지 않습니다.`);
    const computedHash = committeeAttestationHash(attestation);
    if (!computedHash || declaredHashes[0] !== computedHash) throw new Error(`위원 ${reviewer.id}의 attestation hash가 payload 정규화 해시와 일치하지 않습니다.`);
    const embeddedHashes = [attestation?.sha256, attestation?.hash].filter((value) => value != null && String(value).trim()).map(normalizedSha256);
    if (embeddedHashes.some((hash) => !hash) || embeddedHashes.some((hash) => hash !== computedHash)) throw new Error(`위원 ${reviewer.id}의 내장 attestation hash가 payload 정규화 해시와 일치하지 않습니다.`);
    const payload = attestationPayload(attestation);
    if (
      normalizedIdentity(payload?.reviewerId) !== normalizedIdentity(reviewer.id)
      || normalizedIdentity(payload?.role) !== normalizedIdentity(reviewer.role)
      || normalizedIdentity(payload?.method) !== normalizedIdentity(reviewer.method)
      || String(payload?.jobId || "").trim() !== jobId
      || String(payload?.runId || "").trim() !== runId
      || normalizedSha256(payload?.evidenceHash) !== evidenceHash
      || normalizedSha256(payload?.decisionHash) !== decisionHash
      || (review.revisionId && String(payload?.revisionId || "") !== review.revisionId)
      || (review.revisionSequence != null && Number(payload?.revisionSequence) !== Number(review.revisionSequence))
    ) throw new Error(`위원 ${reviewer.id}의 attestation payload가 reviewer·job·run·evidence에 결속되지 않았습니다.`);
    const reviewerKey = normalizedIdentity(reviewer.id);
    if (usedReviewerIds.has(reviewerKey)) throw new Error(`위원 ${reviewer.id}는 이 run의 이전 위원회 revision에서 이미 사용되었습니다.`);
    if (currentAttestationHashes.has(computedHash)) throw new Error("위원회 내에서 동일한 attestation payload를 재사용할 수 없습니다.");
    if (usedAttestationHashes.has(computedHash)) throw new Error(`위원 ${reviewer.id}의 attestation은 이 run의 이전 위원회 revision에서 이미 사용되었습니다.`);
    currentAttestationHashes.add(computedHash);
  });
  for (const criterion of AHP_CRITERIA) {
    const value = review.scores?.[criterion.id];
    if (!value || !Number.isFinite(Number(value.score)) || Number(value.score) < 0 || Number(value.score) > 100 || !String(value.evidence || "").trim()) {
      throw new Error(`${criterion.label} 리뷰 점수와 근거가 필요합니다.`);
    }
  }
  return true;
}

function committeeReviewValid(review) {
  try {
    return validateCommitteeReview(review);
  } catch {
    return false;
  }
}

function validateRevisionArtifact(declaration, expectedPath, label) {
  if (
    declaration?.path !== expectedPath
    || !normalizedSha256(declaration?.sha256)
    || !Number.isInteger(Number(declaration?.bytes))
    || Number(declaration.bytes) <= 0
  ) throw new Error(`${label} revision 산출물 선언이 유효하지 않습니다.`);
  return true;
}

function revisionMetricContext(context) {
  return {
    revisionId: context.revisionId,
    sequence: Number(context.sequence),
    baseManifest: context.baseManifest,
    baseQuality: context.baseQuality,
    supersedes: context.supersedes
  };
}

export function validateQualityRevisionEvaluation(quality, { context, review } = {}) {
  validateQualityRevisionContext(context);
  validateCommitteeReview(review, { expectedJobId: context.jobId, expectedRunId: context.runId });
  if (
    !isPlainObject(quality)
    || quality.schemaVersion !== 1
    || quality.jobId !== context.jobId
    || quality.runId !== context.runId
    || !Number.isInteger(Number(quality.iteration))
    || Number(quality.iteration) < 1
    || !Number.isFinite(Date.parse(quality.evaluatedAt))
    || Number(quality.threshold) !== 98
    || quality.finalization !== false
    || quality.postPublicationRevision !== true
    || quality.prePublication !== false
  ) throw new Error("품질 revision은 evaluateJob의 완전한 post-publication 평가 schema를 포함해야 합니다.");

  const metrics = quality.metrics;
  if (
    !isPlainObject(metrics)
    || metrics.evaluationPhase !== "post-publication-revision"
    || metrics.semanticGateStateEligible !== true
    || metrics.revisionEvaluationEligible !== true
    || metrics.runId !== context.runId
    || hashJson(metrics.revisionContext) !== hashJson(revisionMetricContext(context))
    || !SUPPORTED_PROVIDERS.has(metrics.provider)
  ) throw new Error("품질 revision 평가가 현재 context·provider 의미론 게이트에 결속되어 있지 않습니다.");

  const booleanMetricNames = [
    "providerProof",
    "providerDecisionBinding",
    "providerDecisionEventBinding",
    "providerAttestationBinding",
    "localVideoModelBinding",
    "localVideoRequestBinding",
    "localVideoClipBinding",
    "localVideoReceiptBinding",
    "providerGenerationProvenance",
    "generationClipBinding",
    "generationProvenance",
    "terminalRunBinding",
    "terminalEventBinding",
    "eventLogParsePass",
    "immutableClosureBinding",
    "immutableEvidenceBinding",
    "inputMotionGateBinding",
    "inputDiversityBinding",
    "inputManifestBinding",
    "runManifestBinding",
    "benchmarkReceiptBinding",
    "sourceSetBinding",
    "sourceContentBinding",
    "researchStatusVerified",
    "evidenceTextBindingVerified",
    "committeeEvidenceBound",
    "committeeAttestationValid",
    "sourceQuality",
    "claimEvidencePass"
  ];
  if (booleanMetricNames.some((name) => typeof metrics[name] !== "boolean")) {
    throw new Error("품질 revision 평가의 자동 검증 metric schema가 불완전합니다.");
  }

  const evidenceHash = committeeEvidenceHash(metrics.evidenceHashes);
  const reviewEvidenceHash = committeeEvidenceHash(review.evidenceHashes);
  const evidenceMatches = Boolean(evidenceHash && evidenceHash === reviewEvidenceHash);
  const expectedCommitteeEvidenceBound = evidenceMatches && metrics.immutableEvidenceBinding === true;
  if (metrics.committeeEvidenceBound !== expectedCommitteeEvidenceBound || metrics.committeeAttestationValid !== true) {
    throw new Error("품질 revision 평가가 봉인 증거와 reviewer payload에 일관되게 결속되어 있지 않습니다.");
  }
  if (
    quality.committee?.status !== "present"
    || hashJson(quality.committee.reviewers) !== hashJson(review.reviewers)
  ) throw new Error("품질 revision 평가의 reviewer 집합이 제출 payload와 일치하지 않습니다.");

  if (!Array.isArray(quality.criteria) || quality.criteria.length !== AHP_CRITERIA.length) {
    throw new Error("품질 revision 평가에는 전체 AHP 기준이 필요합니다.");
  }
  const criteriaById = new Map(quality.criteria.map((criterion) => [criterion?.id, criterion]));
  if (criteriaById.size !== AHP_CRITERIA.length || AHP_CRITERIA.some((criterion) => !criteriaById.has(criterion.id))) {
    throw new Error("품질 revision 평가의 AHP 기준 id 집합이 유효하지 않습니다.");
  }
  for (const criterionDefinition of AHP_CRITERIA) {
    const criterion = criteriaById.get(criterionDefinition.id);
    const reviewScore = Number(review.scores[criterionDefinition.id].score);
    if (
      !Array.isArray(criterion.factors)
      || !criterion.factors.length
      || criterion.factors.some((factor) => !factor?.id || !Number.isFinite(Number(factor.max)) || Number(factor.max) <= 0 || typeof factor.pass !== "boolean")
      || !Array.isArray(criterion.blockers)
      || criterion.blockers.some((blocker) => !String(blocker || "").trim())
      || !String(criterion.evidence || "").trim()
    ) throw new Error(`${criterionDefinition.label} 평가 구조가 완전하지 않습니다.`);
    const automaticScore = scoreFactors(criterion.factors).score;
    const effectiveScore = round(Math.min(automaticScore, reviewScore));
    if (
      Number(criterion.autoScore) !== automaticScore
      || Number(criterion.committeeScore) !== reviewScore
      || Number(criterion.score) !== effectiveScore
    ) throw new Error(`${criterionDefinition.label} 점수가 자동 측정·reviewer 점수에서 재현되지 않습니다.`);
  }
  const expectedTotalScore = round(AHP_CRITERIA.reduce((sum, definition) => (
    sum + Number(criteriaById.get(definition.id).score) * definition.weight / 100
  ), 0));
  if (Number(quality.totalScore) !== expectedTotalScore) throw new Error("품질 revision 총점이 AHP 기준 점수에서 재현되지 않습니다.");
  if (
    !isPlainObject(quality.ahp)
    || !Array.isArray(quality.ahp.matrix)
    || !Array.isArray(quality.ahp.weights)
    || quality.ahp.weights.length !== AHP_CRITERIA.length
    || AHP_CRITERIA.some((definition) => !quality.ahp.weights.some((weight) => weight?.id === definition.id && Number(weight.targetWeight) === definition.weight))
  ) throw new Error("품질 revision AHP 계산 증거가 불완전합니다.");
  if (!Array.isArray(quality.blockers) || quality.blockers.some((blocker) => !String(blocker || "").trim()) || !Array.isArray(quality.remediation)) {
    throw new Error("품질 revision blocker·remediation schema가 유효하지 않습니다.");
  }

  const requiredSemanticBindings = [
    "providerProof",
    "providerGenerationProvenance",
    "terminalRunBinding",
    "terminalEventBinding",
    "immutableClosureBinding",
    "immutableEvidenceBinding",
    "inputMotionGateBinding",
    "inputDiversityBinding",
    "inputManifestBinding",
    "runManifestBinding",
    "benchmarkReceiptBinding",
    "sourceSetBinding",
    "sourceContentBinding",
    "researchStatusVerified",
    "evidenceTextBindingVerified",
    "committeeEvidenceBound",
    "committeeAttestationValid",
    "sourceQuality",
    "claimEvidencePass"
  ];
  if (quality.semanticGate === true && (
    metrics.provider === "local"
    || requiredSemanticBindings.some((name) => metrics[name] !== true)
  )) throw new Error("열린 semanticGate가 필수 불변 증거 결속으로 재현되지 않습니다.");
  const expectedStatus = expectedTotalScore >= 98 && quality.semanticGate === true && quality.blockers.length === 0
    ? "passed"
    : "needs-improvement";
  if (quality.status !== expectedStatus) throw new Error("품질 revision status가 총점·semanticGate·blocker에서 재현되지 않습니다.");
  return true;
}

export function assertRuntimeQualityRevisionEvaluation(quality, options) {
  validateQualityRevisionEvaluation(quality, options);
  const evaluationHash = runtimeQualityEvaluationHashes.get(quality);
  if (!evaluationHash || evaluationHash !== hashJson(quality)) {
    throw new Error("품질 revision은 현재 프로세스의 evaluateJob 결과 객체만 봉인할 수 있습니다.");
  }
  return true;
}

export function validateQualityRevisionManifest(manifest, { context = null, review = null, quality = null, eventRecord = null } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("품질 revision manifest가 필요합니다.");
  if (manifest.schemaVersion !== QUALITY_REVISION_SCHEMA_VERSION || manifest.type !== "quality-revision" || manifest.sealStatus !== "sealed") {
    throw new Error("품질 revision manifest schema 또는 봉인 상태가 유효하지 않습니다.");
  }
  const manifestContext = {
    schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
    jobId: manifest.jobId,
    runId: manifest.runId,
    revisionId: manifest.revisionId,
    sequence: manifest.sequence,
    baseManifest: manifest.baseManifest,
    baseQuality: manifest.baseQuality,
    supersedes: manifest.supersedes
  };
  validateQualityRevisionContext(manifestContext);
  if (context) {
    validateQualityRevisionContext(context);
    if (hashJson(manifestContext) !== hashJson({ ...context, schemaVersion: QUALITY_REVISION_SCHEMA_VERSION })) throw new Error("품질 revision manifest가 준비된 context와 일치하지 않습니다.");
  }
  if (!review || !quality) throw new Error("품질 revision manifest 검증에는 위원회 리뷰와 품질 산출물이 필요합니다.");
  validateQualityRevisionEvaluation(quality, { context: manifestContext, review });
  validateCommitteeReview(review, { expectedJobId: manifest.jobId, expectedRunId: manifest.runId });
  if (review.revisionId !== manifest.revisionId || Number(review.revisionSequence) !== Number(manifest.sequence)) throw new Error("위원회 리뷰가 revisionId·sequence에 결속되어 있지 않습니다.");
  const transition = deriveQualityRevisionTransition("needs-improvement", quality);
  if (hashJson(manifest.transition) !== hashJson(transition) || manifest.status !== transition.to || manifest.effectiveStatus !== transition.to) {
    throw new Error("품질 revision 상태 전이가 품질 판정과 일치하지 않습니다.");
  }
  if (
    quality.jobId !== manifest.jobId
    || quality.runId !== manifest.runId
    || quality.revisionId !== manifest.revisionId
    || Number(quality.revisionSequence) !== Number(manifest.sequence)
    || quality.revision?.mode !== "append-only"
    || hashJson(quality.revision?.baseManifest) !== hashJson(manifest.baseManifest)
    || hashJson(quality.revision?.baseQuality) !== hashJson(manifest.baseQuality)
    || hashJson(quality.revision?.supersedes) !== hashJson(manifest.supersedes)
    || hashJson(quality.revision?.transition) !== hashJson(transition)
  ) throw new Error("품질 산출물이 append-only revision manifest에 결속되어 있지 않습니다.");
  const revisionRoot = `runs/${manifest.runId}/revisions/${manifest.revisionId}`;
  validateRevisionArtifact(manifest.committeeReview, `${revisionRoot}/committee-review.json`, "위원회 리뷰");
  validateRevisionArtifact(manifest.quality, `${revisionRoot}/quality.json`, "품질");
  validateRevisionArtifact(manifest.events, `${revisionRoot}/events.jsonl`, "이벤트");
  validateQualityRevisionEvent(eventRecord, manifest);
  if (quality.revision.committeeReviewHash !== manifest.committeeReview.sha256) throw new Error("품질 산출물이 봉인된 위원회 리뷰 해시에 결속되어 있지 않습니다.");
  const identity = committeeReviewIdentity(review);
  if (
    manifest.evidenceHash !== identity.evidenceHash
    || hashJson(manifest.reviewerIds) !== hashJson(identity.reviewerIds)
    || hashJson(manifest.attestationHashes) !== hashJson(identity.attestationHashes)
  ) throw new Error("품질 revision manifest의 위원회 identity 집합이 리뷰와 일치하지 않습니다.");
  return true;
}

export function buildQualityRevisionManifest({ context, review, quality, committeeReview, qualityArtifact, events, eventRecord, createdAt = new Date().toISOString() }) {
  validateQualityRevisionContext(context);
  const transition = deriveQualityRevisionTransition("needs-improvement", quality);
  const identity = committeeReviewIdentity(review);
  const manifest = {
    schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
    type: "quality-revision",
    sealStatus: "sealed",
    status: transition.to,
    effectiveStatus: transition.to,
    jobId: context.jobId,
    runId: context.runId,
    revisionId: context.revisionId,
    sequence: Number(context.sequence),
    createdAt,
    immutableBase: true,
    baseManifest: context.baseManifest,
    baseQuality: context.baseQuality,
    supersedes: context.supersedes,
    transition,
    evidenceHash: identity.evidenceHash,
    reviewerIds: identity.reviewerIds,
    attestationHashes: identity.attestationHashes,
    committeeReview,
    quality: qualityArtifact,
    events
  };
  validateQualityRevisionManifest(manifest, { context, review, quality, eventRecord });
  return manifest;
}

export async function saveCommitteeReview(jobId, review, options = {}) {
  if (!review || typeof review !== "object") throw new Error("위원회 리뷰 JSON이 필요합니다.");
  const job = await readJob(jobId);
  if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
  if (review.jobId && review.jobId !== job.id) throw new Error("위원회 리뷰가 현재 작업 식별자에 결속되어 있지 않습니다.");
  if (!review.runId || review.runId !== job.runId) throw new Error("위원회 리뷰가 현재 실행 runId에 결속되어 있지 않습니다.");
  const state = await readQualityRevisionState(jobId, job.runId);
  if (state.baseManifest.status !== "needs-improvement" || state.baseManifest.runStatus !== "needs-improvement" || state.effectiveStatus !== "needs-improvement" || job.status !== "needs-improvement") {
    throw new Error("위원회 리뷰는 봉인된 needs-improvement 상태를 승격하는 revision에서만 제출할 수 있습니다.");
  }
  const revisionContext = options.revisionContext;
  if (!revisionContext) throw new Error("위원회 리뷰에는 준비된 append-only revision context가 필요합니다.");
  const expectedContext = await prepareQualityRevision(jobId, job.runId, revisionContext.revisionId);
  if (hashJson(revisionContext) !== hashJson(expectedContext)) throw new Error("위원회 리뷰의 revision context가 현재 append-only head와 일치하지 않습니다.");
  if (review.revisionId !== revisionContext.revisionId || Number(review.revisionSequence) !== Number(revisionContext.sequence)) {
    throw new Error("위원회 리뷰가 준비된 revisionId·sequence에 결속되어 있지 않습니다.");
  }
  const currentHashes = state.baseQuality.value.metrics?.evidenceHashes || {};
  const normalizedReview = {
    ...review,
    schemaVersion: QUALITY_REVISION_SCHEMA_VERSION,
    jobId,
    runId: job.runId,
    reviewedAt: new Date().toISOString(),
    evidenceHash: committeeEvidenceHash(review.evidenceHashes),
    reviewers: (review.reviewers || []).map((reviewer) => ({
      ...reviewer,
      id: String(reviewer?.id || "").trim(),
      role: String(reviewer?.role || "").trim(),
      method: String(reviewer?.method || "").trim(),
      ...(reviewer?.attestationHash ? { attestationHash: normalizedSha256(reviewer.attestationHash) || reviewer.attestationHash } : {}),
      ...(reviewer?.provenanceHash ? { provenanceHash: normalizedSha256(reviewer.provenanceHash) || reviewer.provenanceHash } : {})
    })),
    revisionId: revisionContext.revisionId,
    revisionSequence: Number(revisionContext.sequence)
  };
  validateCommitteeReview(normalizedReview, {
    expectedJobId: jobId,
    expectedRunId: job.runId,
    expectedEvidenceHashes: currentHashes,
    usedReviewerIds: state.usedReviewerIds,
    usedAttestationHashes: state.usedAttestationHashes
  });
  return normalizedReview;
}


export async function persistQuality(jobDir, quality) {
  if (!quality?.jobId || !quality?.runId) throw new Error("품질 산출물에 jobId와 runId가 필요합니다.");
  const expectedJobDir = resolve(join(JOBS_DIR, quality.jobId));
  if (resolve(jobDir) !== expectedJobDir) throw new Error("품질 산출물 경로가 작업 식별자와 일치하지 않습니다.");
  const job = await readJob(quality.jobId).catch(() => null);
  if (!job || job.runId !== quality.runId) throw new Error("품질 산출물이 현재 실행 runId에 결속되어 있지 않습니다.");
  if (["running", "verifying"].includes(job.status) && quality.finalization !== true && quality.prePublication !== true) throw new Error("실행 중인 작업의 품질은 봉인할 수 없습니다.");
  if (["completed", "needs-improvement"].includes(job.status)) throw new Error("봉인된 base run 품질은 덮어쓸 수 없습니다. 별도 append-only revision 디렉터리에 봉인하세요.");
  await mkdir(join(jobDir, QUALITY_DIR), { recursive: true });
  await writeFile(join(jobDir, QUALITY_DIR, `iteration-${String(quality.iteration).padStart(2, "0")}.json`), JSON.stringify(quality, null, 2));
  await writeFile(join(jobDir, QUALITY_DIR, "latest.json"), JSON.stringify(quality, null, 2));
  await writeFile(join(jobDir, "quality.json"), JSON.stringify(quality, null, 2));
}
export async function evaluateJob(jobId, options = {}) {
  const job = await readJob(jobId);
  if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
  if (options.runId && options.runId !== job.runId) throw new Error("품질 검사는 현재 작업의 runId만 허용합니다.");
  const currentRunId = job.runId || null;
  if (!currentRunId) throw new Error("현재 실행 산출물이 없어 품질 검사를 시작할 수 없습니다.");
  const jobDir = join(JOBS_DIR, jobId);
  const script = await readJsonOptional(join(jobDir, "script.json"));
  const committee = options.committee || await readJsonOptional(join(jobDir, QUALITY_DIR, "committee-review.json")) || await readJsonOptional(join(jobDir, "committee-review.json"));
  const sourceBundle = await readJsonOptional(join(jobDir, "sources.json"));
  const runDir = join(jobDir, "runs", currentRunId);
  const runManifest = await readJsonOptional(join(runDir, "manifest.json"));
  if (!runManifest || runManifest.schemaVersion !== 1 || runManifest.jobId !== jobId || runManifest.runId !== currentRunId) {
    throw new Error("현재 실행의 run manifest가 없거나 작업 식별자와 일치하지 않습니다.");
  }
  const sealedRun = ["completed", "needs-improvement"].includes(job.status) && ["completed", "needs-improvement"].includes(runManifest.status);
  if (sealedRun) assertSealedJobRequestBinding(job, runManifest);
  let revisionContext = null;
  let revisionState = null;
  if (sealedRun) {
    if (options.allowPostPublicationRevision !== true) throw new Error("봉인된 실행의 품질은 sealed revision 없이 다시 평가할 수 없습니다.");
    if (job.status !== "needs-improvement" || runManifest.status !== "needs-improvement" || runManifest.runStatus !== "needs-improvement") {
      throw new Error("completed 품질 상태는 terminal이며 후속 revision으로 다시 평가할 수 없습니다.");
    }
    if (!options.revisionContext) throw new Error("봉인 후 품질 재평가에는 append-only revision context가 필요합니다.");
    revisionContext = options.revisionContext;
    const expectedContext = await prepareQualityRevision(jobId, currentRunId, revisionContext.revisionId);
    if (hashJson(revisionContext) !== hashJson(expectedContext)) throw new Error("품질 재평가의 revision context가 현재 append-only head와 일치하지 않습니다.");
    revisionState = await readQualityRevisionState(jobId, currentRunId);
    if (!committee) throw new Error("봉인 후 품질 revision에는 위원회 리뷰가 필요합니다.");
    if (committee.revisionId !== revisionContext.revisionId || Number(committee.revisionSequence) !== Number(revisionContext.sequence)) {
      throw new Error("위원회 리뷰가 현재 revisionId·sequence에 결속되어 있지 않습니다.");
    }
    validateCommitteeReview(committee, {
      expectedJobId: jobId,
      expectedRunId: currentRunId,
      expectedEvidenceHashes: revisionState.baseQuality.value.metrics?.evidenceHashes,
      usedReviewerIds: revisionState.usedReviewerIds,
      usedAttestationHashes: revisionState.usedAttestationHashes
    });
  }
  const runBenchmarkDir = join(runDir, "benchmarks");
  const benchmarkChannelPath = join(runBenchmarkDir, "channel-analysis.json");
  const benchmarkDurationPath = existsSync(join(runBenchmarkDir, "shorts-metadata.json")) ? join(runBenchmarkDir, "shorts-metadata.json") : join(ROOT, "data/shorts-metadata.json");
  const benchmarkRlmPath = existsSync(join(runBenchmarkDir, "rlm-benchmark-analysis.json")) ? join(runBenchmarkDir, "rlm-benchmark-analysis.json") : join(ROOT, "data/rlm-benchmark-analysis.json");
  const rlmBenchmark = await readJsonOptional(benchmarkRlmPath);
  const inputManifestPath = join(runDir, "input-manifest.json");
  const inputManifest = await readJsonOptional(inputManifestPath);
  const inputManifestHash = await hashExisting(inputManifestPath);
  const manifestEntries = Array.isArray(inputManifest?.entries) ? inputManifest.entries : null;
  const manifestClipPaths = manifestEntries
    ? manifestEntries.map((entry) => {
        const relativePath = String(entry.relativePath || "");
        const candidate = join(jobDir, relativePath);
        return candidate.startsWith(`${join(jobDir, "clips")}/`) ? candidate : null;
      }).filter(Boolean)
    : null;
  const clipDirectoryEntries = (await readdir(join(jobDir, "clips"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
  const currentClipNames = clipDirectoryEntries.map((entry) => entry.name);
  const currentClipPaths = currentClipNames.map((name) => join(jobDir, "clips", name));
  const currentClipStats = await Promise.all(currentClipNames.map(async (name) => {
    const fileStat = await stat(join(jobDir, "clips", name)).catch(() => null);
    const sha256 = fileStat ? await hashExisting(join(jobDir, "clips", name)) : null;
    return { name, bytes: fileStat?.size || null, sha256 };
  }));
  const clips = manifestClipPaths?.length ? manifestClipPaths : currentClipPaths;
  const normalized = (await readdir(join(jobDir, "normalized"), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mp4").map((entry) => join(jobDir, "normalized", entry.name)).sort();
  const finalPath = join(jobDir, "final.mp4");
  const assembledPath = join(jobDir, "assembled.mp4");
  const finalMedia = await probeMedia(finalPath);
  const normalizedMedia = await Promise.all(normalized.map(probeMedia));
  const clipMedia = await Promise.all(clips.map(probeMedia));
  const captions = parseSrtEntries(await readTextOptional(join(jobDir, "captions.srt")));
  const sources = normalizeSources(script?.sources || job.sources);
  const captionTiming = await readJsonOptional(join(jobDir, "caption-timing.json"));
  const voiceoverSync = await readJsonOptional(join(jobDir, "voiceover-sync.json"));
  const target = mediaTarget(job.format);
  const expectedSegments = Math.max(1, Number(script?.segments?.length || job.clipCount || 1));
  const actualClipTarget = Math.max(1, Number(job.clipCount || expectedSegments));
  const geminiGeneration = await readJsonOptional(join(jobDir, "gemini-generation.json"));
  const localVideoGenerationPath = join(runDir, "local-video-generation.json");
  const localVideoGeneration = await readJsonOptional(localVideoGenerationPath);
  const localVideoReceiptHash = await hashExisting(localVideoGenerationPath);
  const currentClipHashes = await Promise.all(clips.map((path) => hashExisting(path)));
  const generationSegments = Array.isArray(geminiGeneration?.segments) ? geminiGeneration.segments : [];
  const geminiRequest = expectedGeminiRequest(job, script);
  const expectedGeminiScriptHash = hashJson(script);
  const expectedGeminiRequestHash = hashJson({ ...geminiRequest, scriptHash: expectedGeminiScriptHash });
  const expectedGeminiSessionBinding = canonicalGeminiSessionBinding(job);
  const expectedGeminiSessionBindingHash = geminiSessionBindingHash(job);
  const expectedProviderDecision = {
    requested: job.provider,
    selected: job.provider,
    fallbackUsed: false,
    policy: providerPolicy(job.provider)
  };
  const expectedProviderDecisionHash = hashJson(expectedProviderDecision);
  const providerAttestation = geminiGeneration?.providerAttestation;
  const providerAttestationBinding = Boolean(
    expectedGeminiSessionBinding
    && expectedGeminiSessionBindingHash
    && providerAttestation?.type === "gemini-chrome-session"
    && providerAttestation.provider === "gemini-browser"
    && providerAttestation.browser === geminiGeneration?.browser
    && hashJson(providerAttestation.sessionBinding) === expectedGeminiSessionBindingHash
    && providerAttestation.sessionBindingHash === expectedGeminiSessionBindingHash
    && !Object.hasOwn(providerAttestation, "cdpUrl")
    && !Object.hasOwn(providerAttestation, "profileDir")
    && providerAttestation.persistentProfile === true
    && providerAttestation.fallbackUsed === false
    && geminiGeneration?.providerAttestationHash === hashJson(providerAttestation)
  );
  const generationProvenance = geminiGeneration?.provider === "gemini-browser"
    && geminiGeneration.jobId === jobId
    && expectedGeminiSessionBindingHash
    && geminiGeneration.sessionBinding
    && hashJson(geminiGeneration.sessionBinding) === expectedGeminiSessionBindingHash
    && geminiGeneration.sessionBindingHash === expectedGeminiSessionBindingHash
    && !Object.hasOwn(geminiGeneration, "cdpUrl")
    && !Object.hasOwn(geminiGeneration, "profileDir")
    && Boolean(geminiGeneration.browser)
    && providerAttestationBinding
    && geminiGeneration.request
    && hashJson(geminiGeneration.request) === hashJson(geminiRequest)
    && geminiGeneration.providerDecision
    && hashJson(geminiGeneration.providerDecision) === expectedProviderDecisionHash
    && geminiGeneration.requestHash === expectedGeminiRequestHash
    && geminiGeneration.scriptHash === expectedGeminiScriptHash
    && geminiGeneration.requestScriptHash === expectedGeminiRequestHash
    && geminiGeneration.providerDecisionHash === expectedProviderDecisionHash;
  const generationClipBinding = generationProvenance
    && geminiGeneration.status === "completed"
    && geminiGeneration.runId === currentRunId
    && generationSegments.length === actualClipTarget
    && generationSegments.every((segment, index) => {
      const expectedPath = evidenceRelative(jobDir, clips[index] || "");
      return segment.index === index + 1
        && segment.runId === currentRunId
        && segment.requestHash === geminiGeneration.requestHash
        && segment.scriptHash === geminiGeneration.scriptHash
        && segment.path === expectedPath
        && segment.output === expectedPath
        && segment.sha256
        && segment.sha256 === currentClipHashes[index]
        && segment.providerDecisionHash === expectedProviderDecisionHash
        && segment.providerAttestationHash === geminiGeneration.providerAttestationHash;
    });
  const localVideoScriptHash = hashJson(script);
  const localVideoRequest = expectedLocalVideoRequest(job, script, currentRunId, localVideoScriptHash);
  const localVideoRequestHash = localVideoRequest.requestHash;
  const localVideoSegments = Array.isArray(localVideoGeneration?.segments) ? localVideoGeneration.segments : [];
  const localVideoModelBinding = Boolean(
    localVideoGeneration?.provider === "local-video"
    && localVideoGeneration.jobId === jobId
    && localVideoGeneration.runId === currentRunId
    && localVideoGeneration.model
    && localVideoGeneration.modelVersion
    && localVideoGeneration.modelId
    && localVideoGeneration.requestHash === localVideoRequestHash
    && localVideoGeneration.scriptHash === localVideoScriptHash
    && localVideoGeneration.request
    && hashJson(localVideoGeneration.request) === hashJson(localVideoRequest)
  );
  const localVideoClipBinding = localVideoModelBinding
    && localVideoGeneration.status === "completed"
    && localVideoSegments.length === actualClipTarget
    && localVideoSegments.every((segment, index) => {
      const expectedPath = evidenceRelative(jobDir, clips[index] || "");
      return segment.index === index + 1
        && segment.runId === currentRunId
        && segment.requestHash === localVideoRequestHash
        && segment.scriptHash === localVideoScriptHash
        && segment.path === expectedPath
        && segment.output === expectedPath
        && segment.sha256
        && segment.sha256 === currentClipHashes[index];
    });
  const localVideoReceiptBinding = Boolean(
    job.provider === "local-video"
    && localVideoModelBinding
    && runManifest?.providerReceipt?.path === evidenceRelative(jobDir, localVideoGenerationPath)
    && runManifest.providerReceipt.sha256 === localVideoReceiptHash
    && runManifest.providerArtifact?.sha256 === localVideoReceiptHash
  );
  const runInputReceipt = runManifest?.inputManifest;
  const inputManifestReceiptBound = Boolean(
    runInputReceipt
    && runInputReceipt.path === evidenceRelative(jobDir, inputManifestPath)
    && runInputReceipt.sha256 === inputManifestHash
    && runInputReceipt.entryCount === manifestEntries?.length
  );
  const motionGate = inputManifest?.motionGate;
  const motionRequired = clipMotionGateRequired(job.provider);
  let recomputedClipMotion = null;
  let motionRecomputationError = null;
  if (motionRequired && manifestEntries?.length === currentClipPaths.length) {
    try {
      recomputedClipMotion = [];
      for (const path of currentClipPaths) recomputedClipMotion.push(await analyzeClipMotion(path));
    } catch (error) {
      motionRecomputationError = error.message;
    }
  }
  const inputMotionGateBinding = verifyInputMotionGate(inputManifest, job.provider, recomputedClipMotion).binding;
  const diversity = inputManifest?.diversityGate;
  const expectedComparisonCount = manifestEntries ? manifestEntries.length * (manifestEntries.length - 1) / 2 : -1;
  const inputDiversityBinding = Boolean(
    inputManifest?.schemaVersion === 3
    && diversity?.exactSha256Unique === true
    && diversity.perceptualAlgorithm === "temporal-ahash-8x8-v1"
    && Number(diversity.minimumDistanceExclusive) === 3
    && Array.isArray(diversity.comparisons)
    && diversity.comparisons.length === expectedComparisonCount
    && diversity.comparisons.every((comparison) => Number(comparison.distance) > 3)
    && manifestEntries?.every((entry) => entry.perceptual?.algorithm === "temporal-ahash-8x8-v1" && Array.isArray(entry.perceptual.frames) && entry.perceptual.frames.length > 0)
    && new Set(manifestEntries?.map((entry) => entry.sha256)).size === manifestEntries?.length
    && inputMotionGateBinding
  );
  const inputManifestBinding = Boolean(
    inputManifest?.schemaVersion === 3
    && inputManifest.jobId === jobId
    && inputManifest.runId === currentRunId
    && currentRunId === job.runId
    && manifestEntries
    && manifestEntries.length === actualClipTarget
    && manifestEntries.length === currentClipStats.length
    && manifestEntries.every((entry, index) => {
      const current = currentClipStats[index];
      return current
        && entry.name === current.name
        && entry.relativePath === `clips/${current.name}`
        && Number(entry.bytes) === current.bytes
        && entry.sha256 === current.sha256;
    })
    && inputDiversityBinding
    && inputManifestReceiptBound
  );
  const benchmarkSnapshot = runManifest?.benchmarkSnapshot;
  const benchmarkChannelHash = await hashExisting(benchmarkChannelPath);
  const benchmarkDurationHash = await hashExisting(benchmarkDurationPath);
  const benchmarkRlmHash = await hashExisting(benchmarkRlmPath);
  const request = runManifest?.request;
  const geminiRequestSessionBinding = job.provider !== "gemini-browser" || Boolean(
    expectedGeminiSessionBindingHash
    && request?.geminiSessionBinding
    && hashJson(request.geminiSessionBinding) === expectedGeminiSessionBindingHash
    && request.geminiSessionBindingHash === expectedGeminiSessionBindingHash
    && !Object.hasOwn(request, "geminiCdpUrl")
    && !Object.hasOwn(request, "geminiProfileDir")
    && !Object.hasOwn(request, "profileDir")
    && !Object.hasOwn(request, "cdpUrl")
  );
  const runManifestBinding = Boolean(
    runManifest?.schemaVersion === 1
    && runManifest.jobId === jobId
    && runManifest.runId === currentRunId
    && request?.topic === job.topic
    && request?.provider === job.provider
    && request?.format === job.format
    && Number(request?.clipCount) === Number(job.clipCount)
    && Number(request?.targetDurationSec) === Number(job.targetDurationSec)
    && JSON.stringify(request?.targetDurationRangeSec || []) === JSON.stringify(job.targetDurationRangeSec || [])
    && request?.captions === job.captions
    && request?.voiceover === job.voiceover
    && request?.fallbackPolicy === providerPolicy(job.provider)
    && geminiRequestSessionBinding
    && runManifest.eventsPath === `runs/${currentRunId}/events.jsonl`
  );
  const providerDecisionBinding = Boolean(
    runManifest?.providerDecision
    && hashJson(runManifest.providerDecision) === expectedProviderDecisionHash
    && runManifest.providerDecisionHash === expectedProviderDecisionHash
    && runManifest.providerDecision.requested === job.provider
    && runManifest.providerDecision.selected === job.provider
    && runManifest.providerDecision.fallbackUsed === false
    && runManifest.providerDecision.policy === expectedProviderDecision.policy
  );
  const benchmarkReceiptBinding = Boolean(
    runManifestBinding
    && benchmarkChannelHash
    && benchmarkDurationHash
    && benchmarkRlmHash
    && benchmarkSnapshot?.path === evidenceRelative(jobDir, benchmarkChannelPath)
    && benchmarkSnapshot.sha256 === benchmarkChannelHash
    && benchmarkSnapshot.durationMetadata?.path === evidenceRelative(jobDir, benchmarkDurationPath)
    && benchmarkSnapshot.durationMetadata.sha256 === benchmarkDurationHash
    && benchmarkSnapshot.rlmMediaEvidence?.path === evidenceRelative(jobDir, benchmarkRlmPath)
    && benchmarkSnapshot.rlmMediaEvidence.sha256 === benchmarkRlmHash
  );
  const immutableArtifacts = Array.isArray(runManifest?.immutableArtifacts) ? runManifest.immutableArtifacts : [];
  const expectedImmutablePath = (name) => `runs/${currentRunId}/artifacts/${String(name).replaceAll("/", "__")}`;
  const finalizationReady = options.finalization === true && job.status === "verifying";
  const evaluationState = qualityEvaluationState({
    jobStatus: job.status,
    manifestStatus: runManifest.status,
    manifestRunStatus: runManifest.runStatus,
    finalization: options.finalization === true,
    allowPostPublicationRevision: options.allowPostPublicationRevision === true
  });
  const terminalRunBinding = Boolean(
    (["completed", "needs-improvement"].includes(job.status) || finalizationReady)
    && ["completed", "needs-improvement", "finalizing"].includes(runManifest?.status)
    && runManifest.jobId === jobId
    && runManifest.runId === currentRunId
    && runManifest.eventsPath === `runs/${currentRunId}/events.jsonl`
    && runManifest.runStatus !== "failed"
    && Array.isArray(runManifest.ledgerErrors)
    && runManifest.ledgerErrors.length === 0
  );
  const immutableEventArtifact = immutableArtifacts.filter((artifact) => artifact.name === `runs/${currentRunId}/events.jsonl` && artifact.path === expectedImmutablePath(artifact.name)).at(-1);
  const eventLogText = terminalRunBinding && immutableEventArtifact ? await readTextOptional(resolve(jobDir, immutableEventArtifact.path)) : "";
  let eventLogParsePass = true;
  const eventRecords = [];
  for (const line of eventLogText.split("\n").filter(Boolean)) {
    try {
      eventRecords.push(JSON.parse(line));
    } catch {
      eventLogParsePass = false;
    }
  }
  const terminalEvent = eventRecords.at(-1);
  const providerDecisionEvent = eventRecords.find((event) => event.type === "provider_decision");
  const providerDecisionEventBinding = Boolean(
    providerDecisionEvent?.jobId === jobId
    && providerDecisionEvent.runId === currentRunId
    && providerDecisionEvent.requested === expectedProviderDecision.requested
    && providerDecisionEvent.selected === expectedProviderDecision.selected
    && providerDecisionEvent.fallbackUsed === expectedProviderDecision.fallbackUsed
    && providerDecisionEvent.policy === expectedProviderDecision.policy
    && providerDecisionEvent.decisionHash === expectedProviderDecisionHash
  );
  const qualityImmutableArtifact = immutableArtifacts.find((artifact) => artifact.name === "quality.json" && artifact.path === expectedImmutablePath(artifact.name));
  const terminalEventBinding = Boolean(
    eventLogParsePass
    && (
    terminalEvent?.type === "completed"
      ? terminalEvent.jobId === jobId
        && terminalEvent.runId === currentRunId
        && terminalEvent.status === runManifest.runStatus
        && terminalEvent.providerDecisionHash === expectedProviderDecisionHash
      : terminalEvent?.type === "quality_finalized"
        ? terminalEvent.jobId === jobId
          && terminalEvent.runId === currentRunId
          && terminalEvent.status === runManifest.runStatus
          && terminalEvent.qualityHash === qualityImmutableArtifact?.sha256
          && terminalEvent.qualitySummary?.runId === currentRunId
        : finalizationReady
          && terminalEvent?.type === "finalization_started"
          && terminalEvent.jobId === jobId
          && terminalEvent.runId === currentRunId
          && terminalEvent.status === runManifest.runStatus
          && terminalEvent.providerDecisionHash === expectedProviderDecisionHash
    )
  );
  const immutableClosureBinding = Boolean(
    terminalRunBinding
    && terminalEventBinding
    && immutableArtifacts.length > 0
    && new Set(immutableArtifacts.map((artifact) => artifact.name)).size === immutableArtifacts.length
    && (await Promise.all(immutableArtifacts.map(async (artifact) => {
      const relativePath = String(artifact.path || "");
      const artifactPath = resolve(jobDir, relativePath);
      return artifact.path === expectedImmutablePath(artifact.name)
        && artifactPath.startsWith(`${resolve(jobDir)}${sep}`)
        && String(artifact.sha256 || "").startsWith("sha256:")
        && Number(artifact.bytes) === (await stat(artifactPath).catch(() => null))?.size
        && await hashExisting(artifactPath) === artifact.sha256;
    }))).every(Boolean)
  );
  const providerProof = job.provider === "local"
    || (job.provider === "gemini-browser" && generationClipBinding && providerDecisionBinding && providerDecisionEventBinding)
    || (job.provider === "local-video" && localVideoClipBinding && localVideoReceiptBinding && providerDecisionBinding && providerDecisionEventBinding);
  const providerGenerationProvenance = job.provider === "gemini-browser" ? generationProvenance : job.provider === "local-video" ? localVideoModelBinding : false;
  const generatedCaptionCuesPerMinute = finalMedia?.duration > 0 ? round(captions.length * 60 / finalMedia.duration, 2) : null;
  const benchmarkCaptionDensity = Number(rlmBenchmark?.mediaEvidence?.averageCaptionCuesPerMinute);
  const normalizedSpecs = normalizedMedia.filter(Boolean).map((media) => `${media.width}x${media.height}@${round(media.fps, 2)}`);
  const sameNormalizedSpec = normalizedSpecs.length > 0 && normalizedSpecs.every((value) => value === normalizedSpecs[0]);
  const requestedSourceUrls = [...new Set(sources.map((source) => source.url).filter(Boolean))];
  const bundledSourceUrls = [...new Set((sourceBundle?.records || []).map((source) => source.url).filter(Boolean))];
  const sourceSetBinding = requestedSourceUrls.length === bundledSourceUrls.length && requestedSourceUrls.every((url) => bundledSourceUrls.includes(url));
  const sourceRecordsByUrl = new Map((sourceBundle?.records || []).map((source) => [source.url, source]));
  const sourceContentBinding = requestedSourceUrls.length === bundledSourceUrls.length && requestedSourceUrls.every((url) => {
    const requested = sources.find((source) => source.url === url);
    const bundled = sourceRecordsByUrl.get(url);
    return Boolean(requested && bundled && requested.sha256 === bundled.sha256 && Number(requested.byteLength) === Number(bundled.byteLength) && JSON.stringify(requested.evidence || []) === JSON.stringify(bundled.evidence || []));
  });
  const sourceQuality = sources.length > 0 && sourceSetBinding && sourceContentBinding && sourceBundle?.status === "complete" && sourceBundle.records?.length === sources.length && sourceBundle.records.every((source) => source.fetchStatus === "fetched" && source.sha256 && source.byteLength > 0) && sources.every((source) => source.url && /^https?:\/\//i.test(source.url) && !isPlaceholderSource(source));
  const researchStatusVerified = script?.researchStatus === "verified";
  const evidenceTextBinding = verifyEvidenceBoundScript(script, sources, expectedSegments);
  const evidenceTextBindingVerified = evidenceTextBinding.verified === true;
  const claimEvidencePass = researchStatusVerified && evidenceTextBindingVerified && segmentClaimEvidence(script, sources);
  const title = script?.title || job.topic || "";
  const titleHasHookPattern = hasEvidenceHookFraming(title);
  const completeSegments = Array.isArray(script?.segments) && script.segments.length >= expectedSegments && script.segments.every((segment) => segment.caption && segment.narration && segment.visualPrompt);
  const finalHasTarget = finalMedia?.width === target.width && finalMedia?.height === target.height;
  const sourceDurationSum = clipMedia.filter(Boolean).reduce((sum, media) => sum + media.duration, 0);
  const durationSum = normalizedMedia.filter(Boolean).reduce((sum, media) => sum + media.duration, 0);
  const durationDelta = finalMedia && durationSum ? Math.abs(finalMedia.duration - durationSum) : Number.POSITIVE_INFINITY;
  const readOnlySealed = evaluationState.revisionEligible;
  const frameEvidence = options.reuseEvidenceFrames || readOnlySealed
    ? await readExistingEvidenceFrames(jobDir, finalMedia)
    : options.extractFrames === false ? [] : await extractEvidenceFrames(jobDir, finalMedia);
  let frameAudioCaption = null;
  let frameAudioCaptionError = null;
  if (finalMedia) {
    try {
      const existingAnalysis = options.reuseExistingAnalysis || readOnlySealed ? await readJsonOptional(join(jobDir, QUALITY_DIR, "frame-audio-caption.json")) : null;
      if (existingAnalysis?.runId === currentRunId) {
        frameAudioCaption = existingAnalysis;
      } else if (readOnlySealed) {
        frameAudioCaptionError = "봉인된 실행의 기존 프레임·음성·자막 분석을 찾지 못했습니다.";
      } else {
        frameAudioCaption = await analyzeJobMedia(jobDir, {
          frames: options.frames !== false,
          audio: options.audio !== false,
          runId: options.runId || job.runId || null,
          benchmarkPath: benchmarkDurationPath,
          expectedDuration: { targetSec: job.targetDurationSec, rangeSec: job.targetDurationRangeSec }
        });
      }
    } catch (error) {
      frameAudioCaptionError = error.message;
    }
  }
  const durationProfilePass = Boolean(frameAudioCaption?.benchmarkDuration?.insideRecommendedRange);
  const analyzedPaths = [...new Set([
    finalPath,
    assembledPath,
    join(jobDir, "captions.srt"),
    join(jobDir, "script.json"),
    join(jobDir, "sources.json"),
    benchmarkChannelPath,
    benchmarkDurationPath,
    benchmarkRlmPath,
    inputManifestPath,
    join(jobDir, "frame-audio-caption.json"),
    join(jobDir, "captions.vtt"),
    join(jobDir, "caption-timing.json"),
    ...(voiceoverSync ? [join(jobDir, "voiceover-sync.json")] : []),
    ...(geminiGeneration ? [join(jobDir, "gemini-generation.json")] : []),
    ...(localVideoGeneration ? [localVideoGenerationPath] : []),
    join(jobDir, QUALITY_DIR, "frame-audio-caption.json"),
    ...clips,
    ...normalized,
    ...frameEvidence.map((frame) => frame.path)
  ])];
  const evidenceHashes = Object.fromEntries((await Promise.all(analyzedPaths.map(async (path) => [evidenceRelative(jobDir, path), await hashExisting(path)]))).filter(([, hash]) => hash));
  const immutableByName = new Map(immutableArtifacts.map((artifact) => [artifact.name, artifact]));
  const immutableEvidenceBinding = Boolean(
    immutableClosureBinding
    && Object.keys(evidenceHashes).length > 0
    && Object.entries(evidenceHashes).every(([path, hash]) => immutableByName.get(path)?.sha256 === hash)
  );
  const committeeEvidenceBound = Boolean(
    committeeReviewValid(committee)
    && committee?.runId
    && committee.runId === (options.runId || job.runId)
    && immutableEvidenceBinding
    && committeeEvidenceHash(committee.evidenceHashes) === committeeEvidenceHash(evidenceHashes)
  );
  const captionSpeechDurationSec = voiceoverSync?.alignment === "segment-duration-calibrated" && Array.isArray(voiceoverSync.segments)
    ? voiceoverSync.segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.captionDurationSec) || 0), 0)
    : null;
  const captionSpeechCoverageRatio = Number.isFinite(captionSpeechDurationSec) && captionSpeechDurationSec > 0
    ? Number((frameAudioCaption?.captions?.coverageSec / captionSpeechDurationSec).toFixed(4))
    : null;
  const captionCoveragePass = !job.captions || Boolean(
    frameAudioCaption?.captions?.overlaps === 0
    && frameAudioCaption.captions.captionOverrunSec <= 0.05
    && (Number.isFinite(captionSpeechCoverageRatio) ? captionSpeechCoverageRatio >= 0.98 && captionSpeechCoverageRatio <= 1.02 : frameAudioCaption.captions.coverageRatio >= 0.98)
  );
  const audioQcPass = Boolean(frameAudioCaption?.audio?.audioQc?.status === "measured");
  const cutReconciliationPass = Boolean(frameAudioCaption?.cutReconciliation && ["matched", "not-applicable"].includes(frameAudioCaption.cutReconciliation.status));
  const captionDensityPass = !job.captions || Boolean(Number.isFinite(generatedCaptionCuesPerMinute) && Number.isFinite(benchmarkCaptionDensity) && generatedCaptionCuesPerMinute / benchmarkCaptionDensity >= 0.5 && generatedCaptionCuesPerMinute / benchmarkCaptionDensity <= 1.5);

  const hookFactors = [
    { id: "title", label: "제목 존재", max: 15, pass: Boolean(title.trim()) },
    { id: "hook", label: "첫 훅 존재", max: 15, pass: Boolean(script?.hook?.trim()) },
    { id: "segments", label: `${expectedSegments}개 장면 구조`, max: 15, pass: Array.isArray(script?.segments) && script.segments.length >= expectedSegments },
    { id: "segmentFields", label: "장면별 내레이션·자막·프롬프트", max: 25, pass: completeSegments },
    { id: "titlePattern", label: "벤치마크 훅 문법", max: 15, pass: titleHasHookPattern },
    { id: "narration", label: "전체 내레이션 연결", max: 15, pass: Boolean(script?.narration?.trim()) }
  ];
  const visualFactors = [
    { id: "final", label: "최종 영상 존재", max: 15, pass: Boolean(finalMedia?.hasVideo) },
    { id: "target", label: `${target.width}x${target.height} 화면비`, max: 20, pass: finalHasTarget },
    { id: "fps", label: "30fps 정규화", max: 10, pass: Boolean(finalMedia && Math.abs(finalMedia.fps - 30) <= 0.5) },
    { id: "normalized", label: "정규화 클립 존재", max: 15, pass: normalized.length >= actualClipTarget },
    { id: "sameSpec", label: "클립 사양 일치", max: 15, pass: sameNormalizedSpec },
    { id: "frames", label: "프레임 단위 분석 증거", max: 10, pass: Boolean(frameAudioCaption?.frames?.frameCountObserved > 0) },
    { id: "providerMotion", label: "클립 첫 프레임 동작·시간축 다양성", max: 15, pass: !motionRequired || inputMotionGateBinding },
    { id: "clipCount", label: "생성 클립 수 충족", max: 15, pass: clips.length >= actualClipTarget }
  ];
  const editFactors = [
    { id: "assembled", label: "합성 파일 존재", max: 15, pass: existsSync(assembledPath) },
    { id: "normalized", label: "정규화 단계 완료", max: 15, pass: normalized.length >= actualClipTarget },
    { id: "duration", label: "길이 보존", max: 15, pass: durationDelta <= 0.35 },
    { id: "durationProfile", label: "벤치마크 평균 길이 범위", max: 10, pass: durationProfilePass },
    { id: "cutReconciliation", label: "클립 경계·프레임 컷 정합", max: 10, pass: cutReconciliationPass },
    { id: "video", label: "최종 비디오 트랙", max: 15, pass: Boolean(finalMedia?.hasVideo) },
    { id: "audio", label: "최종 단일 오디오 트랙", max: 15, pass: finalMedia?.audioStreamCount === 1 },
    { id: "thumbnail", label: "썸네일 생성", max: 5, pass: existsSync(join(jobDir, "thumbnail.jpg")) }
  ];
  const audioFactors = [
    { id: "captionsFile", label: "SRT 생성", max: 15, pass: !job.captions || captions.length > 0 },
    { id: "captionCount", label: "장면 수와 자막 수 정합", max: 15, pass: !job.captions || captions.length >= expectedSegments },
    { id: "captionCoverage", label: "자막 타임라인 커버리지", max: 10, pass: captionCoveragePass },
    { id: "captionDensity", label: "벤치마크 자막 밀도", max: 5, pass: captionDensityPass },
    { id: "audio", label: "단일 오디오 트랙", max: 15, pass: finalMedia?.audioStreamCount === 1 },
    { id: "sampleRate", label: "48kHz 오디오", max: 10, pass: Boolean(finalMedia?.sampleRate === 48000) },
    { id: "frameCaptionAudio", label: "프레임·자막·음성 분석 완료", max: 15, pass: Boolean(frameAudioCaption && frameAudioCaption.captions.count === captions.length && frameAudioCaption.audio) },
    { id: "audioQc", label: "LUFS·true peak·클리핑 분석", max: 10, pass: audioQcPass },
    { id: "warnings", label: "오디오 경고 없음", max: 5, pass: (job.warnings || []).length === 0 }
  ];
  const sourceFactors = [
    { id: "sourceCount", label: "출처 1개 이상", max: 25, pass: sources.length > 0 },
    { id: "sourceQuality", label: "검증 가능한 URL 출처", max: 25, pass: sourceQuality },
    { id: "noPlaceholder", label: "placeholder 출처 없음", max: 20, pass: sources.length > 0 && sources.every((source) => !isPlaceholderSource(source)) },
    { id: "researchStatus", label: "리서치 상태·재계산 가능한 extractive binding 영수증", max: 10, pass: researchStatusVerified && evidenceTextBindingVerified },
    { id: "claimMapping", label: "장면별 출처·인용 매핑", max: 10, pass: claimEvidencePass },
    { id: "benchmarkFit", label: "건축·인프라 주제 적합", max: 10, pass: /건축|궁궐|경복궁|도시|다리|도로|물|성|공항|아파트|하천|구조|에어컨|발전소/.test(`${job.topic} ${title}`) }
  ];
  const automationFactors = [
    { id: "completed", label: "작업 완료 상태", max: 20, pass: ["completed", "needs-improvement", "verifying"].includes(job.status) },
    { id: "artifacts", label: "필수 산출물", max: 20, pass: REQUIRED_ARTIFACTS.every((name) => existsSync(join(jobDir, name))) },
    { id: "clips", label: "클립 수 충족", max: 20, pass: clips.length >= actualClipTarget },
    { id: "jobId", label: "작업 디렉터리 영속성", max: 15, pass: existsSync(join(jobDir, "job.json")) && existsSync(join(jobDir, "script.json")) },
    { id: "warnings", label: "실패·경고 없음", max: 15, pass: (job.warnings || []).length === 0 && ["completed", "needs-improvement", "verifying"].includes(job.status) },
    { id: "provider", label: "자동 소스 지정·입력 결속", max: 10, pass: providerProof && inputManifestBinding && runManifestBinding && benchmarkReceiptBinding && sourceSetBinding }
  ];

  const factorGroups = { hookStory: hookFactors, visualConsistency: visualFactors, editRhythm: editFactors, captionsAudio: audioFactors, factSourceFit: sourceFactors, automationRecovery: automationFactors };
  const autoScores = Object.fromEntries(Object.entries(factorGroups).map(([id, factors]) => [id, scoreFactors(factors).score]));
  const committeeScores = committee?.scores || {};
  const criteria = AHP_CRITERIA.map((criterion) => {
    const auto = makeCriterion(criterion.id, criterion.label, autoScores[criterion.id], factorGroups[criterion.id], `${factorGroups[criterion.id].filter((factor) => factor.pass).map((factor) => factor.label).join(", ")} / 자동 측정 ${autoScores[criterion.id]}점`);
    const review = committeeScores[criterion.id];
    if (review && Number.isFinite(Number(review.score))) {
      auto.committeeScore = clamp(review.score);
      auto.score = round(Math.min(auto.autoScore, auto.committeeScore));
      auto.evidence = `${auto.evidence}; reviewer payload ${auto.committeeScore}점: ${String(review.evidence).trim()}`;
    }
    if (criterion.id === "factSourceFit" && !sourceQuality) auto.blockers.push("검증 가능한 출처 번들이 없습니다.");
    if (criterion.id === "factSourceFit" && !claimEvidencePass) auto.blockers.push("장면별 출처에 인용 가능한 원문 근거가 없습니다.");
    if (criterion.id === "visualConsistency" && !committeeScores.visualConsistency) auto.blockers.push("대표 프레임에 대한 reviewer payload가 없습니다.");
    if (criterion.id === "visualConsistency" && !frameAudioCaption) auto.blockers.push(`프레임·음성·자막 분석 실패${frameAudioCaptionError ? `: ${frameAudioCaptionError}` : ""}`);
    return auto;
  });
  const ahp = calculateAHP();
  const totalScore = round(criteria.reduce((sum, criterion) => sum + criterion.score * (AHP_CRITERIA.find((item) => item.id === criterion.id)?.weight || 0) / 100, 0));
  const blockers = criteria.flatMap((criterion) => criterion.blockers.map((blocker) => `${criterion.label}: ${blocker}`));
  const technicalEvidenceGate = (job.provider === "gemini-browser" || job.provider === "local-video")
    && evaluationState.semanticGateEligible
    && providerProof
    && providerGenerationProvenance
    && terminalRunBinding
    && terminalEventBinding
    && immutableClosureBinding
    && immutableEvidenceBinding
    && inputMotionGateBinding
    && inputDiversityBinding
    && inputManifestBinding
    && runManifestBinding
    && benchmarkReceiptBinding
    && committeeEvidenceBound
    && Boolean(frameAudioCaption)
    && sourceQuality
    && sourceSetBinding
    && sourceContentBinding
    && researchStatusVerified
    && evidenceTextBindingVerified
    && claimEvidencePass;
  // The current evaluator proves file/hash/media/source-text structure only.
  // It does not run a content VLM, burned-caption OCR, narration ASR alignment,
  // or a factual-entailment model, so an autonomous content verdict is unsafe.
  const contentSemanticsVerified = false;
  const semanticGate = technicalEvidenceGate && contentSemanticsVerified;
  if (!committee) blockers.push("5-method software reviewer payload 파일이 없습니다.");
  if (committee && !committeeReviewValid(committee)) blockers.push("reviewer payload의 고유 id·role·method와 attestation hash가 검증되지 않았습니다. 이 해시는 사람의 신원·독립성 인증이 아닙니다.");
  if (finalMedia && finalMedia.audioStreamCount !== 1) blockers.push(`최종 오디오 트랙 수가 1개가 아닙니다: ${finalMedia.audioStreamCount}개`);
  if (committee && !committeeEvidenceBound) blockers.push("reviewer payload가 현재 runId·미디어 해시와 결속되지 않았습니다.");
  if (motionRequired && !inputMotionGateBinding) blockers.push(`승인 provider 클립의 첫 프레임 동작·시간축 다양성·근중복 gate가 재현되지 않았습니다${motionRecomputationError ? `: ${motionRecomputationError}` : ""}`);
  if (!inputDiversityBinding) blockers.push("입력 클립의 SHA-256 고유성 또는 시간축 지각 다양성 gate가 검증되지 않았습니다.");
  if (!inputManifestBinding) blockers.push("현재 실행의 입력 manifest가 요청한 클립 집합과 결속되지 않았습니다.");
  if (!runManifestBinding) blockers.push("현재 실행의 run manifest가 작업·요청 식별자와 결속되지 않았습니다.");
  if (job.provider === "gemini-browser" && !geminiRequestSessionBinding) blockers.push("run manifest의 Gemini 요청이 저장된 세션의 정규화 binding hash와 결속되지 않았습니다.");
  if (!benchmarkReceiptBinding) blockers.push("벤치마크 스냅샷 영수증이 현재 실행과 결속되지 않았습니다.");
  if (!eventLogParsePass) blockers.push("불변 run 이벤트 로그에 해석할 수 없는 JSON 행이 있습니다.");
  if (!sourceSetBinding) blockers.push("요청한 출처 집합과 캡처된 출처 집합이 일치하지 않습니다.");
  if (job.provider === "local") blockers.push("local 업로드·편집 산출물은 의미론적 98점 판정에 사용할 수 없습니다.");
  if (job.provider === "gemini-browser" && !providerProof) blockers.push("Gemini 브라우저 생성 provenance 기록이 없거나 요청한 클립 수를 채우지 못했습니다.");
  if (job.provider === "gemini-browser" && !expectedGeminiSessionBinding) blockers.push("Gemini 세션 provenance는 작업 생성 시 저장된 geminiCdpUrl·geminiProfileDir에 결속되어야 합니다.");
  if (job.provider === "gemini-browser" && !providerDecisionBinding) blockers.push("Gemini 실행 provider 결정과 fallback 금지 정책이 run manifest에 결속되지 않았습니다.");
  if (job.provider === "gemini-browser" && !providerDecisionEventBinding) blockers.push("Gemini provider 결정 이벤트의 해시·runId 결속이 검증되지 않았습니다.");
  if (job.provider === "gemini-browser" && !generationProvenance) blockers.push("Gemini 브라우저 요청·스크립트·Chrome 프로필 provenance 해시가 검증되지 않았습니다.");
  if (job.provider === "gemini-browser" && !terminalRunBinding) blockers.push("Gemini 의미론 판정은 완료된 작업과 terminal run manifest에서만 허용됩니다.");
  if (job.provider === "gemini-browser" && !immutableClosureBinding) blockers.push("Gemini 의미론 판정에 필요한 불변 산출물·이벤트 해시 폐쇄가 없습니다.");
  if (job.provider === "gemini-browser" && !immutableEvidenceBinding) blockers.push("Gemini 의미론 판정에 사용한 품질·미디어 해시가 불변 run 산출물과 일치하지 않습니다.");
  if (job.provider === "local-video" && !localVideoModelBinding) blockers.push("local-video 생성 영수증의 provider·model·요청·스크립트 해시 결속이 검증되지 않았습니다.");
  if (job.provider === "local-video" && !localVideoReceiptBinding) blockers.push("local-video 생성 영수증이 현재 run 산출물로 봉인되지 않았습니다.");
  if (!researchStatusVerified) blockers.push("대본 researchStatus가 verified로 검증되지 않았습니다.");
  if (!evidenceTextBindingVerified) blockers.push(`대본의 주장·내레이션·자막·영상 프롬프트가 인용 근거와 결속되지 않았습니다${evidenceTextBinding.error ? `: ${evidenceTextBinding.error}` : ""}`);
  if (!claimEvidencePass) blockers.push("장면별 주장에 연결된 인용 가능한 출처 근거와 텍스트 결속이 없습니다.");
  if (!contentSemanticsVerified) blockers.push("콘텐츠 의미 품질은 자동 판정하지 않습니다. VLM 장면 관련성·번인 자막 OCR·ASR 정렬·사실 함의에 대한 사람 또는 별도 검증이 필요합니다.");
  const reportedJobStatus = finalizationReady ? "verifying" : job.status;
  const quality = {
    schemaVersion: 1,
    jobId,
    runId: options.runId || job.runId || null,
    iteration: Number(options.iteration || 1),
    evaluatedAt: new Date().toISOString(),
    threshold: 98,
    status: totalScore >= 98 && semanticGate && blockers.length === 0 ? "passed" : "needs-improvement",
    totalScore,
    finalization: evaluationState.finalizationEligible,
    postPublicationRevision: evaluationState.revisionEligible,
    prePublication: !evaluationState.finalizationEligible && !evaluationState.revisionEligible,
    ahp,
    committee: committee ? { reviewers: committee.reviewers, reviewedAt: committee.reviewedAt, status: "present" } : { reviewers: [], status: "missing" },
    technicalEvidenceGate,
    semanticGate,
    metrics: {
      technicalEvidenceGate,
      contentSemanticsVerified,
      jobStatus: reportedJobStatus,
      observedJobStatus: job.status,
      evaluationPhase: evaluationState.phase === "finalization" ? "post-publication" : evaluationState.phase,
      semanticGateStateEligible: evaluationState.semanticGateEligible,
      revisionEvaluationEligible: evaluationState.revisionEligible,
      revisionContext: revisionContext ? {
        revisionId: revisionContext.revisionId,
        sequence: revisionContext.sequence,
        baseManifest: revisionContext.baseManifest,
        baseQuality: revisionContext.baseQuality,
        supersedes: revisionContext.supersedes
      } : null,
      provider: job.provider,
      providerProof,
      providerDecisionBinding,
      providerDecisionEventBinding,
      providerAttestationBinding,
      geminiGeneration: geminiGeneration ? { status: geminiGeneration.status, segmentCount: geminiGeneration.segments?.length || 0, browser: geminiGeneration.browser, sessionBinding: geminiGeneration.sessionBinding, sessionBindingHash: geminiGeneration.sessionBindingHash } : null,
      localVideoGeneration: localVideoGeneration ? { status: localVideoGeneration.status, segmentCount: localVideoSegments.length, model: localVideoGeneration.model, modelVersion: localVideoGeneration.modelVersion, modelId: localVideoGeneration.modelId, receiptPath: evidenceRelative(jobDir, localVideoGenerationPath), receiptSha256: localVideoReceiptHash } : null,
      localVideoModelBinding,
      localVideoRequestBinding: Boolean(localVideoGeneration?.request && hashJson(localVideoGeneration.request) === hashJson(localVideoRequest)),
      localVideoClipBinding,
      localVideoReceiptBinding,
      providerGenerationProvenance,
      generationClipBinding,
      generationProvenance,
      terminalRunBinding,
      terminalEventBinding,
      eventLogParsePass,
      immutableClosureBinding,
      immutableEvidenceBinding,
      runId: currentRunId,
      geminiSessionBinding: expectedGeminiSessionBinding,
      geminiSessionBindingHash: expectedGeminiSessionBindingHash,
      geminiRequestSessionBinding,
      inputManifest: inputManifest ? { path: evidenceRelative(jobDir, inputManifestPath), sha256: inputManifestHash, entryCount: manifestEntries?.length || 0 } : null,
      inputMotionGate: motionGate ? {
        algorithm: motionGate.algorithm,
        approvedProvider: motionGate.approvedProvider,
        enforced: motionGate.enforced,
        observedPass: motionGate.observedPass,
        enforcementPass: motionGate.enforcementPass,
        failures: motionGate.failures,
        recomputed: motionRequired,
        recomputationError: motionRecomputationError
      } : null,
      inputMotionGateBinding,
      inputDiversityBinding,
      inputManifestBinding,
      runManifestBinding,
      benchmarkReceiptBinding,
      sourceSetBinding,
      sourceContentBinding,
      researchStatusVerified,
      evidenceTextBindingVerified,
      evidenceTextBindingHash: evidenceTextBinding.bindingHash,
      evidenceTextBindingAlgorithm: evidenceTextBinding.binding?.algorithm || null,
      committeeEvidenceBound,
      committeeAttestationValid: committeeReviewValid(committee),
      format: job.format,
      topic: job.topic,
      expectedSegments,
      expectedClips: actualClipTarget,
      clipCount: clips.length,
      normalizedCount: normalized.length,
      finalMedia,
      durationSum: round(durationSum, 3),
      sourceDurationSum: round(sourceDurationSum, 3),
      durationDelta: Number.isFinite(durationDelta) ? round(durationDelta, 3) : null,
      captionsCount: captions.length,
      generatedCaptionCuesPerMinute,
      benchmarkCaptionDensity: Number.isFinite(benchmarkCaptionDensity) ? benchmarkCaptionDensity : null,
      captionDensityRatio: Number.isFinite(generatedCaptionCuesPerMinute) && Number.isFinite(benchmarkCaptionDensity) && benchmarkCaptionDensity > 0 ? round(generatedCaptionCuesPerMinute / benchmarkCaptionDensity, 2) : null,
      captionTiming: captionTiming ? { alignment: captionTiming.alignment, estimated: Boolean(captionTiming.estimated), wordTimingCount: captionTiming.wordTimingCount } : null,
      voiceoverSync: voiceoverSync ? {
        alignment: voiceoverSync.alignment || null,
        estimated: Boolean(voiceoverSync.estimated),
        voiceStyle: voiceoverSync.voiceStyle || null,
        voiceSelection: voiceoverSync.voiceSelection || null,
        sayRate: voiceoverSync.sayRate ?? null,
        loudnessTarget: voiceoverSync.loudnessTarget || null,
        sourceAudioMode: voiceoverSync.sourceAudioMode || null,
        sourceAudioGain: voiceoverSync.sourceAudioGain ?? null,
        targetDurationSec: voiceoverSync.targetDurationSec ?? null,
        voiceoverDurationSec: voiceoverSync.voiceoverDurationSec ?? null,
        segmentCount: Array.isArray(voiceoverSync.segments) ? voiceoverSync.segments.length : 0
      } : null,
      captionSpeechDurationSec,
      captionSpeechCoverageRatio,
      benchmarkRlm: { path: evidenceRelative(jobDir, benchmarkRlmPath), sha256: benchmarkRlmHash },
      sourceCount: sources.length,
      sourceQuality,
      claimEvidencePass,
      sourceBundle: sourceBundle ? { status: sourceBundle.status, fetchedCount: sourceBundle.fetchedCount, totalCount: sourceBundle.totalCount, evidenceCount: sourceBundle.evidenceCount || 0 } : { status: "missing", fetchedCount: 0, totalCount: 0, evidenceCount: 0 },
      evidenceFrames: frameEvidence.map((frame) => ({ path: evidenceRelative(jobDir, frame.path), time: frame.time, sha256: frame.sha256 })),
      evidenceHashes,
      frameAudioCaption: frameAudioCaption ? {
        path: "quality/frame-audio-caption.json",
        frameCountObserved: frameAudioCaption.frames.frameCountObserved,
        sceneCutCount: frameAudioCaption.frames.sceneCutCount,
        cutReconciliation: frameAudioCaption.cutReconciliation,
        silenceCount: frameAudioCaption.audio.silenceCount,
        meanVolumeDb: frameAudioCaption.audio.meanVolumeDb,
        captionCount: frameAudioCaption.captions.count,
        averageCharsPerSecond: frameAudioCaption.captions.averageCharsPerSecond,
        captionCoverageRatio: frameAudioCaption.captions.coverageRatio,
        uncaptionedTailSec: frameAudioCaption.captions.uncaptionedTailSec,
        captionOverrunSec: frameAudioCaption.captions.captionOverrunSec,
        wordTimingCount: frameAudioCaption.captions.wordTimingCount,
        audioQc: frameAudioCaption.audio.audioQc,
        integratedLufs: frameAudioCaption.audio.integratedLufs,
        loudnessRangeLu: frameAudioCaption.audio.loudnessRangeLu,
        truePeakDbfs: frameAudioCaption.audio.truePeakDbfs,
        clippedSamples: frameAudioCaption.audio.clippedSamples,
        benchmarkDuration: frameAudioCaption.benchmarkDuration
      } : null,
      frameAudioCaptionError
    },
    criteria,
    remediation: remediationFor(criteria),
    blockers
  };
  runtimeQualityEvaluationHashes.set(quality, hashJson(quality));
  if (options.persist !== false) await persistQuality(jobDir, quality);
  return quality;
}

export async function runQualityLoop(jobId, options = {}) {
  const maxIterations = Math.max(1, Math.min(10, Number(options.maxIterations || 3)));
  const history = [];
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const quality = await evaluateJob(jobId, { ...options, iteration });
    history.push({ iteration, totalScore: quality.totalScore, status: quality.status, remediation: quality.remediation });
    if (options.onIteration) await options.onIteration(quality);
    if (quality.status === "passed") break;
    if (iteration < maxIterations) await sleep(100);
  }
  const latest = history.at(-1);
  return { jobId, status: latest?.status || "needs-improvement", totalScore: latest?.totalScore || 0, iterations: history };
}

export async function listQuality(jobId) {
  const dir = join(JOBS_DIR, jobId, QUALITY_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const iterations = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^iteration-\d+\.json$/.test(entry.name)) continue;
    const value = await readJsonOptional(join(dir, entry.name));
    if (value) iterations.push(value);
  }
  return iterations.sort((a, b) => a.iteration - b.iteration);
}
