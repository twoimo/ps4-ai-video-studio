import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { JOBS_DIR, ROOT, readJob } from "./pipeline.mjs";
import { analyzeJobMedia } from "./frame-analysis.mjs";
import { hashFile } from "./run-ledger.mjs";

export const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 일관성·생성 품질", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "사실성·출처·벤치마크 적합성", weight: 10 },
  { id: "automationRecovery", label: "자동화 재현성·실패 복구", weight: 10 }
];

const RANDOM_INDEX = { 1: 0, 2: 0, 3: 0.58, 4: 0.9, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49 };
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const REQUIRED_ARTIFACTS = ["final.mp4", "captions.srt", "script.json", "thumbnail.jpg"];
const QUALITY_DIR = "quality";
const SUPPORTED_PROVIDERS = new Set(["local", "gemini-browser"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
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
  const [stdout, stderr] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
  const code = await processHandle.exited;
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
    const claimText = `${segment.caption || ""} ${segment.narration || ""}`;
    const terms = [...new Set(claimText.match(/박석|경복궁|근정전|배수|마사토|눈부시|미끄|석영|운모|화강암|난반사|흙먼지|궁궐|건축/gu) || [])];
    if (!ids.length || !terms.length) return false;
    return ids.some((id) => Array.isArray(sourceByUrl.get(id)?.evidence) && sourceByUrl.get(id).evidence.some((evidence) => {
      const quote = String(evidence?.quote || "");
      return quote.trim().length >= 40 && terms.some((term) => quote.includes(term));
    }));
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
      visualConsistency: "모든 클립의 화면비·프레임레이트를 정규화하고 대표 프레임을 위원회가 검수하세요.",
      editRhythm: "장면 길이·컷 경계·오디오 팝·최종 길이를 재렌더링 후 검증하세요.",
      captionsAudio: "SRT 항목 수·벤치마크 자막 밀도·음성 트랙·샘플레이트를 대조하고 한국어 자막 프레임을 확인하세요.",
      factSourceFit: "검증 가능한 1차 출처를 대본의 sources에 연결하고 placeholder 출처를 제거하세요.",
      automationRecovery: "실패 상태·재실행·필수 산출물·클립 수를 smoke test로 다시 확인하세요."
    };
    return { criterion: criterion.label, score: criterion.score, action: actions[criterion.id] };
  });
}

export function validateCommitteeReview(review) {
  if (!review || typeof review !== "object") throw new Error("위원회 리뷰 JSON이 필요합니다.");
  if (!Array.isArray(review.reviewers) || review.reviewers.length < 5) throw new Error("전문가 위원회 리뷰어는 5명 이상이어야 합니다.");
  if (review.reviewers.some((reviewer) => !reviewer || !String(reviewer.id || "").trim() || !String(reviewer.role || "").trim() || !String(reviewer.method || "").trim())) {
    throw new Error("각 위원은 id, role, method를 포함한 attestation이 필요합니다.");
  }
  for (const criterion of AHP_CRITERIA) {
    const value = review.scores?.[criterion.id];
    if (!value || !Number.isFinite(Number(value.score)) || Number(value.score) < 0 || Number(value.score) > 100 || !String(value.evidence || "").trim()) {
      throw new Error(`${criterion.label} 리뷰 점수와 근거가 필요합니다.`);
    }
  }
  return true;
}

export async function saveCommitteeReview(jobId, review) {
  validateCommitteeReview(review);
  const jobDir = join(JOBS_DIR, jobId);
  const job = await readJob(jobId);
  const latest = await readJsonOptional(join(jobDir, QUALITY_DIR, "latest.json"));
  if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local 또는 gemini-browser만 사용할 수 있습니다.");
  if (review.jobId && review.jobId !== job.id) throw new Error("위원회 리뷰가 현재 작업 식별자에 결속되어 있지 않습니다.");
  if (!review.runId || review.runId !== job.runId) throw new Error("위원회 리뷰가 현재 실행 runId에 결속되어 있지 않습니다.");
  if (!latest || latest.jobId !== job.id || latest.runId !== job.runId) throw new Error("현재 run에 결속된 품질 산출물이 없습니다.");
  const currentHashes = latest.metrics?.evidenceHashes || {};
  const reviewHashes = review.evidenceHashes || {};
  const currentPaths = Object.keys(currentHashes).sort();
  const reviewPaths = Object.keys(reviewHashes).sort();
  if (!currentPaths.length || currentPaths.length !== reviewPaths.length || currentPaths.some((path, index) => path !== reviewPaths[index] || reviewHashes[path] !== currentHashes[path])) {
    throw new Error("위원회 리뷰의 evidenceHashes가 현재 미디어·분석 산출물과 일치하지 않습니다.");
  }
  return { schemaVersion: 1, jobId, reviewedAt: new Date().toISOString(), ...review };
}


export async function persistQuality(jobDir, quality) {
  if (!quality?.jobId || !quality?.runId) throw new Error("품질 산출물에 jobId와 runId가 필요합니다.");
  const expectedJobDir = resolve(join(JOBS_DIR, quality.jobId));
  if (resolve(jobDir) !== expectedJobDir) throw new Error("품질 산출물 경로가 작업 식별자와 일치하지 않습니다.");
  const job = await readJob(quality.jobId).catch(() => null);
  if (!job || job.runId !== quality.runId) throw new Error("품질 산출물이 현재 실행 runId에 결속되어 있지 않습니다.");
  if (job.status === "completed" && !quality.revisionId) throw new Error("봉인된 실행의 품질은 sealed revision 없이 덮어쓸 수 없습니다.");
  await mkdir(join(jobDir, QUALITY_DIR), { recursive: true });
  await writeFile(join(jobDir, QUALITY_DIR, `iteration-${String(quality.iteration).padStart(2, "0")}.json`), JSON.stringify(quality, null, 2));
  await writeFile(join(jobDir, QUALITY_DIR, "latest.json"), JSON.stringify(quality, null, 2));
  await writeFile(join(jobDir, "quality.json"), JSON.stringify(quality, null, 2));
}
export async function evaluateJob(jobId, options = {}) {
  const job = await readJob(jobId);
  if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local 또는 gemini-browser만 사용할 수 있습니다.");
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
  if (job.status === "completed" && runManifest.status === "completed" && options.allowPostPublicationRevision !== true) {
    throw new Error("봉인된 실행의 품질은 sealed revision 없이 다시 평가할 수 없습니다.");
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
  const currentClipHashes = await Promise.all(clips.map((path) => hashExisting(path)));
  const generationSegments = Array.isArray(geminiGeneration?.segments) ? geminiGeneration.segments : [];
  const geminiRequest = expectedGeminiRequest(job, script);
  const expectedGeminiScriptHash = hashJson(script);
  const expectedGeminiRequestHash = hashJson({ ...geminiRequest, scriptHash: expectedGeminiScriptHash });
  const expectedGeminiProfileDir = process.env.CHROME_PROFILE_DIR || join(process.env.HOME || "/tmp", ".ps4-ai-video-studio", "chrome-profile");
  const expectedGeminiCdpUrl = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
  const expectedProviderDecision = {
    requested: job.provider,
    selected: job.provider,
    fallbackUsed: false,
    policy: job.provider === "gemini-browser" ? "no-local-video-fallback" : "local-upload-edit"
  };
  const expectedProviderDecisionHash = hashJson(expectedProviderDecision);
  const providerAttestation = geminiGeneration?.providerAttestation;
  const providerAttestationBinding = Boolean(
    providerAttestation?.type === "gemini-chrome-session"
    && providerAttestation.provider === "gemini-browser"
    && providerAttestation.browser === geminiGeneration?.browser
    && providerAttestation.cdpUrl === expectedGeminiCdpUrl
    && providerAttestation.profileDir === expectedGeminiProfileDir
    && providerAttestation.persistentProfile === true
    && providerAttestation.fallbackUsed === false
    && geminiGeneration?.providerAttestationHash === hashJson(providerAttestation)
  );
  const generationProvenance = geminiGeneration?.provider === "gemini-browser"
    && geminiGeneration.jobId === jobId
    && geminiGeneration.profileDir === expectedGeminiProfileDir
    && geminiGeneration.cdpUrl === expectedGeminiCdpUrl
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
  const runInputReceipt = runManifest?.inputManifest;
  const inputManifestReceiptBound = Boolean(
    runInputReceipt
    && runInputReceipt.path === evidenceRelative(jobDir, inputManifestPath)
    && runInputReceipt.sha256 === inputManifestHash
    && runInputReceipt.entryCount === manifestEntries?.length
  );
  const inputManifestBinding = Boolean(
    inputManifest?.schemaVersion === 1
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
    && inputManifestReceiptBound
  );
  const benchmarkSnapshot = runManifest?.benchmarkSnapshot;
  const benchmarkChannelHash = await hashExisting(benchmarkChannelPath);
  const benchmarkDurationHash = await hashExisting(benchmarkDurationPath);
  const benchmarkRlmHash = await hashExisting(benchmarkRlmPath);
  const request = runManifest?.request;
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
    && request?.fallbackPolicy === (job.provider === "gemini-browser" ? "no-local-video-fallback" : "local-upload-edit")
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
  const terminalRunBinding = Boolean(
    (job.status === "completed" || finalizationReady)
    && ["completed", "finalizing"].includes(runManifest?.status)
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
  const providerProof = job.provider === "local" || (generationClipBinding && providerDecisionBinding && providerDecisionEventBinding);
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
  const claimEvidencePass = segmentClaimEvidence(script, sources);
  const title = script?.title || job.topic || "";
  const titleHasHookPattern = /이유|왜|방법|비밀|사실|아닙니다|않습니다|없습니다|숨어|어떻게|어디서|하지만|[0-9]+/.test(title);
  const completeSegments = Array.isArray(script?.segments) && script.segments.length >= expectedSegments && script.segments.every((segment) => segment.caption && segment.narration && segment.visualPrompt);
  const finalHasTarget = finalMedia?.width === target.width && finalMedia?.height === target.height;
  const sourceDurationSum = clipMedia.filter(Boolean).reduce((sum, media) => sum + media.duration, 0);
  const durationSum = normalizedMedia.filter(Boolean).reduce((sum, media) => sum + media.duration, 0);
  const durationDelta = finalMedia && durationSum ? Math.abs(finalMedia.duration - durationSum) : Number.POSITIVE_INFINITY;
  const readOnlySealed = job.status === "completed" && options.allowPostPublicationRevision === true;
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
        frameAudioCaption = await analyzeJobMedia(jobDir, { frames: options.frames !== false, audio: options.audio !== false, runId: options.runId || job.runId || null, benchmarkPath: benchmarkDurationPath });
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
  const committeeEvidenceBound = Boolean(committee?.runId && committee.runId === (options.runId || job.runId) && immutableEvidenceBinding && Object.keys(evidenceHashes).every((path) => committee.evidenceHashes?.[path] === evidenceHashes[path]));
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
    { id: "researchStatus", label: "리서치 상태 명시", max: 10, pass: ["verified", "provided", "gemini-api"].includes(script?.researchStatus) || Boolean(script?.sources?.length) },
    { id: "claimMapping", label: "장면별 출처·인용 매핑", max: 10, pass: claimEvidencePass },
    { id: "benchmarkFit", label: "건축·인프라 주제 적합", max: 10, pass: /건축|궁궐|경복궁|도시|다리|도로|물|성|공항|아파트|하천|구조|에어컨|발전소/.test(`${job.topic} ${title}`) }
  ];
  const automationFactors = [
    { id: "completed", label: "작업 완료 상태", max: 20, pass: ["completed", "verifying"].includes(job.status) },
    { id: "artifacts", label: "필수 산출물", max: 20, pass: REQUIRED_ARTIFACTS.every((name) => existsSync(join(jobDir, name))) },
    { id: "clips", label: "클립 수 충족", max: 20, pass: clips.length >= actualClipTarget },
    { id: "jobId", label: "작업 디렉터리 영속성", max: 15, pass: existsSync(join(jobDir, "job.json")) && existsSync(join(jobDir, "script.json")) },
    { id: "warnings", label: "실패·경고 없음", max: 15, pass: (job.warnings || []).length === 0 && ["completed", "verifying"].includes(job.status) },
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
      auto.evidence = `${auto.evidence}; 위원회 ${auto.committeeScore}점: ${String(review.evidence).trim()}`;
    }
    if (criterion.id === "factSourceFit" && !sourceQuality) auto.blockers.push("검증 가능한 출처 번들이 없습니다.");
    if (criterion.id === "factSourceFit" && !claimEvidencePass) auto.blockers.push("장면별 출처에 인용 가능한 원문 근거가 없습니다.");
    if (criterion.id === "visualConsistency" && !committeeScores.visualConsistency) auto.blockers.push("대표 프레임에 대한 위원회 시각 검수가 없습니다.");
    if (criterion.id === "visualConsistency" && !frameAudioCaption) auto.blockers.push(`프레임·음성·자막 분석 실패${frameAudioCaptionError ? `: ${frameAudioCaptionError}` : ""}`);
    return auto;
  });
  const ahp = calculateAHP();
  const totalScore = round(criteria.reduce((sum, criterion) => sum + criterion.score * (AHP_CRITERIA.find((item) => item.id === criterion.id)?.weight || 0) / 100, 0));
  const blockers = criteria.flatMap((criterion) => criterion.blockers.map((blocker) => `${criterion.label}: ${blocker}`));
  const semanticGate = job.provider === "gemini-browser"
    && (job.status === "completed" || finalizationReady)
    && providerProof
    && generationProvenance
    && terminalRunBinding
    && immutableClosureBinding
    && immutableEvidenceBinding
    && inputManifestBinding
    && runManifestBinding
    && benchmarkReceiptBinding
    && committeeEvidenceBound
    && Boolean(frameAudioCaption)
    && sourceQuality
    && sourceSetBinding
    && claimEvidencePass;
  if (!committee) blockers.push("전문가 위원회 리뷰 파일이 없습니다.");
  if (finalMedia && finalMedia.audioStreamCount !== 1) blockers.push(`최종 오디오 트랙 수가 1개가 아닙니다: ${finalMedia.audioStreamCount}개`);
  if (committee && !committeeEvidenceBound) blockers.push("전문가 위원회 리뷰가 현재 runId·미디어 해시와 결속되지 않았습니다.");
  if (!inputManifestBinding) blockers.push("현재 실행의 입력 manifest가 요청한 클립 집합과 결속되지 않았습니다.");
  if (!runManifestBinding) blockers.push("현재 실행의 run manifest가 작업·요청 식별자와 결속되지 않았습니다.");
  if (!benchmarkReceiptBinding) blockers.push("벤치마크 스냅샷 영수증이 현재 실행과 결속되지 않았습니다.");
  if (!eventLogParsePass) blockers.push("불변 run 이벤트 로그에 해석할 수 없는 JSON 행이 있습니다.");
  if (!sourceSetBinding) blockers.push("요청한 출처 집합과 캡처된 출처 집합이 일치하지 않습니다.");
  if (job.provider !== "gemini-browser") blockers.push("실제 Gemini 브라우저 생성 산출물만 의미론적 98점 판정에 사용할 수 있습니다.");
  if (job.provider === "gemini-browser" && !providerProof) blockers.push("Gemini 브라우저 생성 provenance 기록이 없거나 요청한 클립 수를 채우지 못했습니다.");
  if (job.provider === "gemini-browser" && !providerDecisionBinding) blockers.push("Gemini 실행 provider 결정과 fallback 금지 정책이 run manifest에 결속되지 않았습니다.");
  if (job.provider === "gemini-browser" && !providerDecisionEventBinding) blockers.push("Gemini provider 결정 이벤트의 해시·runId 결속이 검증되지 않았습니다.");
  if (job.provider === "gemini-browser" && !generationProvenance) blockers.push("Gemini 브라우저 요청·스크립트·Chrome 프로필 provenance 해시가 검증되지 않았습니다.");
  if (job.provider === "gemini-browser" && !terminalRunBinding) blockers.push("Gemini 의미론 판정은 완료된 작업과 terminal run manifest에서만 허용됩니다.");
  if (job.provider === "gemini-browser" && !immutableClosureBinding) blockers.push("Gemini 의미론 판정에 필요한 불변 산출물·이벤트 해시 폐쇄가 없습니다.");
  if (job.provider === "gemini-browser" && !immutableEvidenceBinding) blockers.push("Gemini 의미론 판정에 사용한 품질·미디어 해시가 불변 run 산출물과 일치하지 않습니다.");
  if (!claimEvidencePass) blockers.push("장면별 주장에 연결된 인용 가능한 출처 근거가 없습니다.");
  const reportedJobStatus = finalizationReady ? "completed" : job.status;
  const quality = {
    schemaVersion: 1,
    jobId,
    runId: options.runId || job.runId || null,
    iteration: Number(options.iteration || 1),
    evaluatedAt: new Date().toISOString(),
    threshold: 98,
    status: totalScore >= 98 && semanticGate && blockers.length === 0 ? "passed" : "needs-improvement",
    totalScore,
    ahp,
    committee: committee ? { reviewers: committee.reviewers, reviewedAt: committee.reviewedAt, status: "present" } : { reviewers: [], status: "missing" },
    semanticGate,
    metrics: {
      jobStatus: reportedJobStatus,
      observedJobStatus: job.status,
      evaluationPhase: finalizationReady ? "post-publication" : job.status === "verifying" ? "pre-publication" : "post-publication",
      provider: job.provider,
      providerProof,
      providerDecisionBinding,
      providerDecisionEventBinding,
      providerAttestationBinding,
      geminiGeneration: geminiGeneration ? { status: geminiGeneration.status, segmentCount: geminiGeneration.segments?.length || 0, browser: geminiGeneration.browser, profileDir: geminiGeneration.profileDir } : null,
      generationClipBinding,
      generationProvenance,
      terminalRunBinding,
      terminalEventBinding,
      eventLogParsePass,
      immutableClosureBinding,
      immutableEvidenceBinding,
      runId: currentRunId,
      inputManifest: inputManifest ? { path: evidenceRelative(jobDir, inputManifestPath), sha256: inputManifestHash, entryCount: manifestEntries?.length || 0 } : null,
      inputManifestBinding,
      runManifestBinding,
      benchmarkReceiptBinding,
      sourceSetBinding,
      sourceContentBinding,
      committeeEvidenceBound,
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
