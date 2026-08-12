import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { generateGeminiClips } from "./gemini-browser.mjs";
import { generateLocalVideoClips } from "./local-video-provider.mjs";
import { appendRunEvent, artifactReceipt, hashFile, writeJsonAtomic, writeRunManifest } from "./run-ledger.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "./provenance.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const WORKSPACE_DIR = join(ROOT, "workspace");
export const JOBS_DIR = join(WORKSPACE_DIR, "jobs");
export const ANALYSIS_PATH = join(DATA_DIR, "channel-analysis.json");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const SUPPORTED_PROVIDERS = new Set(["local", "local-video", "gemini-browser"]);
const DEFAULT_SAY_RATE = 165;
const GEMINI_PROFILE_ROOT = resolve(process.env.HOME || "/tmp", ".ps4-ai-video-studio");
function normalizeGeminiProfile(input) {
  const cdpUrl = input.geminiCdpUrl;
  const profileDir = input.geminiProfileDir;
  if (cdpUrl === undefined && profileDir === undefined) return {};
  if (typeof cdpUrl !== "string" || typeof profileDir !== "string" || !cdpUrl || !profileDir) {
    throw new Error("Gemini 프로필을 지정할 때 CDP 주소와 프로필 경로를 함께 지정해야 합니다.");
  }
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error("Gemini CDP 주소가 올바르지 않습니다.");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.port) {
    throw new Error("Gemini CDP는 로컬 HTTP 주소만 사용할 수 있습니다.");
  }
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile !== GEMINI_PROFILE_ROOT && !resolvedProfile.startsWith(`${GEMINI_PROFILE_ROOT}/`)) {
    throw new Error("Gemini Chrome 프로필은 PS4 Studio 전용 프로필 디렉터리 안에 있어야 합니다.");
  }
  return { geminiCdpUrl: parsed.origin, geminiProfileDir: resolvedProfile };
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

export async function ensureWorkspace() {
  await mkdir(JOBS_DIR, { recursive: true });
  await mkdir(join(WORKSPACE_DIR, "uploads"), { recursive: true });
}

export async function readAnalysis() {
  return JSON.parse(await readFile(ANALYSIS_PATH, "utf8"));
}

export async function readJob(jobId) {
  return JSON.parse(await readFile(join(JOBS_DIR, jobId, "job.json"), "utf8"));
}

export async function writeJob(job) {
  const dir = join(JOBS_DIR, job.id);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, "job.json"), job);
  return job;
}

export async function updateJob(jobId, patch) {
  const current = await readJob(jobId);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeJob(next);
  return next;
}

export async function listJobs() {
  await ensureWorkspace();
  const entries = await readdir(JOBS_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      jobs.push(await readJob(entry.name));
    } catch {
      // Ignore an incomplete directory while a job is being initialized.
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createJob(input) {
  await ensureWorkspace();
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  let benchmarkDuration = { recommendedTargetSec: 78, recommendedRangeSec: [54, 91] };
  try {
    const metadata = JSON.parse(await readFile(join(DATA_DIR, "shorts-metadata.json"), "utf8"));
    benchmarkDuration = metadata.recentSummary || metadata.summary || benchmarkDuration;
  } catch {
    // Keep a deterministic fallback if the benchmark profile has not been refreshed.
  }
  const sources = Array.isArray(input.sources) ? input.sources.filter((source) => source && (source.url || source.title || typeof source === "string")) : [];
  const provider = input.provider === undefined ? "gemini-browser" : input.provider;
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
  const clipCount = Math.max(1, Math.min(12, Number(input.clipCount) || (provider === "gemini-browser" ? 2 : 6)));
  const hasExplicitTargetDuration = Object.hasOwn(input, "targetDurationSec");
  const requestedTargetDuration = input.targetDurationSec;
  if (hasExplicitTargetDuration && (
    typeof requestedTargetDuration !== "number"
    || !Number.isInteger(requestedTargetDuration)
    || requestedTargetDuration < 20
    || requestedTargetDuration > 180
  )) throw new Error("목표 길이는 20초 이상 180초 이하의 정수여야 합니다.");
  const providerDefaultDuration = provider === "gemini-browser"
    ? Math.min(Number(benchmarkDuration.recommendedTargetSec || 110), clipCount * 8)
    : Number(benchmarkDuration.recommendedTargetSec || 78);
  const targetDurationSec = hasExplicitTargetDuration
    ? requestedTargetDuration
    : Math.max(20, Math.min(180, providerDefaultDuration));
  const benchmarkRange = benchmarkDuration.recommendedRangeSec || [benchmarkDuration.p10Sec || 43, benchmarkDuration.p90Sec || 104];
  const targetDurationRangeSec = hasExplicitTargetDuration
    ? provider === "gemini-browser"
      ? [Math.max(10, Math.floor(targetDurationSec * 0.8)), Math.min(180, Math.ceil(targetDurationSec * 1.2))]
      : [Math.max(1, Math.floor(targetDurationSec * 0.95)), Math.min(180, Math.ceil(targetDurationSec * 1.05))]
    : provider === "gemini-browser"
      ? [Math.max(10, Math.floor(targetDurationSec * 0.8)), Math.min(180, Math.ceil(targetDurationSec * 1.2))]
      : benchmarkRange;
  const geminiProfile = provider === "gemini-browser" ? normalizeGeminiProfile(input) : {};
  const job = {
    id,
    topic: input.topic.trim(),
    format: input.format === "landscape" ? "landscape" : "vertical",
    provider,
    ...geminiProfile,
    clipCount,
    captions: input.captions !== false,
    voiceover: input.voiceover !== false,
    sources,
    targetDurationSec,
    targetDurationRangeSec,
    status: "queued",
    stage: "대기",
    progress: 0,
    message: "제작 요청을 받았습니다.",
    warnings: [],
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const dir = join(JOBS_DIR, id);
  await mkdir(join(dir, "clips"), { recursive: true });
  await mkdir(join(dir, "normalized"), { recursive: true });
  await writeJob(job);
  return job;
}

const FFMPEG_FULL_BIN = process.env.FFMPEG_FULL_BIN || "/opt/homebrew/opt/ffmpeg-full/bin";

function commandPath(command) {
  const override = command === "ffmpeg" ? process.env.FFMPEG_BINARY : command === "ffprobe" ? process.env.FFPROBE_BINARY : null;
  if (override && existsSync(override)) return override;
  if ((command === "ffmpeg" || command === "ffprobe") && existsSync(join(FFMPEG_FULL_BIN, command))) {
    return join(FFMPEG_FULL_BIN, command);
  }
  return typeof Bun.which === "function" ? Bun.which(command) : null;
}

function hasCommand(command) {
  return Boolean(commandPath(command));
}

async function runCommand(command, args, options = {}) {
  const binary = commandPath(command);
  if (!binary) {
    throw new Error(`${command} 명령을 찾을 수 없습니다. 로컬 렌더링에는 ${command} 설치가 필요합니다.`);
  }
  const proc = Bun.spawn([binary, ...args], {
    cwd: options.cwd || ROOT,
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim().slice(-2400);
    throw new Error(`${command} 실행 실패 (${exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return { stdout, stderr };
}

async function commandBytes(command, args, options = {}) {
  const binary = commandPath(command);
  if (!binary) throw new Error(`${command} 명령을 찾을 수 없습니다.`);
  const proc = Bun.spawn([binary, ...args], {
    cwd: options.cwd || ROOT,
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdoutPromise = new Response(proc.stdout).arrayBuffer();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`${command} 실행 실패 (${exitCode})${stderr.trim() ? `: ${stderr.trim().slice(-1200)}` : ""}`);
  return new Uint8Array(stdout);
}

async function commandOutput(command, args) {
  const result = await runCommand(command, args);
  return result.stdout.trim();
}

async function callGeminiText(topic, clipCount, targetDurationSec, sourceEntries = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const promptSources = evidenceForPrompt(sourceEntries);
  if (!promptSources.length) throw new Error("대본 생성에 사용할 검증 출처 본문이 없습니다.");
  const sourceCatalog = JSON.stringify(promptSources);
  const prompt = `당신은 한국어 유튜브 다큐멘터리 쇼츠 작가다. 주제는 "${topic}"이다. 정확히 ${clipCount}개의 생성형 영상 클립으로 약 ${targetDurationSec}초의 세로 영상을 만든다. 아래 SOURCE_EVIDENCE에 실제로 적힌 사실만 사용하고, 일반 지식으로 빈칸을 채우거나 추측하지 않는다. 모든 장면에는 서로 다른 claimId와 정확히 하나의 evidenceRef를 넣는다. 각 장면의 claim·caption·narration·evidenceRef.quote는 선택한 evidence의 완전한 한 문장을 글자 하나 바꾸지 말고 동일하게 복사한다. title과 hook도 선택한 완전한 evidence 문장 하나를 그대로 복사한다. 전체 narration은 장면별 narration을 순서대로 공백 하나로 연결한다. visualPrompt는 반드시 'vertical cinematic documentary visualization depicting only this evidence: ' + JSON.stringify(선택한 완전한 문장) + '; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark'의 고정 형식만 사용한다. evidenceRefs.sourceId/evidenceId는 제공값을 그대로 쓴다. 근거가 부족하면 JSON 대신 EVIDENCE_INSUFFICIENT만 반환한다. 장면별 durationHint 합계는 목표 길이에 가깝게 한다.\nSOURCE_EVIDENCE=${sourceCatalog}\n아래 JSON만 반환한다.\n{\n  "title": "선택한 완전한 evidence 문장",\n  "hook": "선택한 완전한 evidence 문장",\n  "narration": "장면별 narration을 순서대로 연결",\n  "researchStatus": "verified",\n  "segments": [{"claimId":"claim-1", "claim":"선택한 완전한 evidence 문장", "caption":"선택한 완전한 evidence 문장", "narration":"선택한 완전한 evidence 문장", "visualPrompt":"고정 extractive evidence template", "durationHint":13, "evidenceRefs":[{"sourceId":"https://...", "evidenceId":"excerpt-1", "quote":"선택한 완전한 evidence 문장"}]}]\n}\nsegments는 정확히 ${clipCount}개다.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }, null, 2)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini 텍스트 API 오류 (${response.status}): ${detail.slice(-600)}`);
  }
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.reduce((value, part) => value + (part.text || ""), "") || "";
  if (/^EVIDENCE_INSUFFICIENT\b/i.test(text.trim())) throw new Error("Gemini가 출처 근거 부족을 보고했습니다.");
  const jsonText = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(jsonText);
  return validateEvidenceBoundScript(parsed, sourceEntries, clipCount, "gemini-api");
}
function evidenceForPrompt(sources, maxCharacters = 48000) {
  const output = [];
  let characters = 0;
  for (const source of sources) {
    if (!source || typeof source === "string" || source.fetchStatus !== "fetched" || !source.url) continue;
    const evidence = [];
    for (const item of source.evidence || []) {
      const quote = String(item.quote || "").trim().slice(0, 1600);
      if (!quote) continue;
      const entry = { evidenceId: item.id, locator: item.locator, quote };
      const size = JSON.stringify(entry).length;
      if (characters + size > maxCharacters) break;
      evidence.push(entry);
      characters += size;
    }
    if (evidence.length) output.push({ sourceId: source.url, title: source.title || source.url, sha256: source.sha256 || null, evidence });
    if (characters >= maxCharacters) break;
  }
  return output;
}

// This is deliberately an extractive binding check, not a factual-entailment verdict.
export const EVIDENCE_TEXT_BINDING_ALGORITHM = "deterministic-extractive-binding/v3";
const EXTRACTIVE_VISUAL_PREFIX = "vertical cinematic documentary visualization depicting only this evidence: ";
const EXTRACTIVE_VISUAL_SUFFIX = "; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark";

const EVIDENCE_TEXT_STOPWORDS = new Set([
  "그리고", "그러나", "하지만", "그래서", "또한", "바로", "실제로", "대한", "관한", "위한", "통한", "통해",
  "이유", "역할", "모습", "장면", "영상", "화면", "설명", "기록", "검증", "사실", "정도", "관련", "부분",
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "from", "with", "by", "in", "on", "at", "as", "is", "are", "was", "were"
]);
const VISUAL_STYLE_STOPWORDS = new Set([
  "vertical", "horizontal", "cinematic", "documentary", "visual", "visualization", "visualisation", "scene", "shot", "view", "close", "closeup", "up",
  "macro", "wide", "angle", "camera", "lens", "dolly", "pan", "tilt", "slow", "motion", "lighting", "light", "color", "grade", "style",
  "realistic", "photorealistic", "historical", "historically", "physical", "physically", "plausible", "consistent", "detailed", "detail", "show",
  "depict", "depicting", "only", "supported", "korean", "mood", "text", "subtitle", "subtitles", "logo", "logos", "added", "third", "party", "provider",
  "required", "provenance", "mark", "retain", "evidence", "quote", "no", "without", "scene", "subject", "identity", "pacing", "language",
  "this", "any", "third-party", "provider-required",
  "세로", "가로", "시네마틱", "다큐멘터리", "시각화", "장면", "카메라", "조명", "색감", "스타일", "사실적", "현실적", "역사적",
  "물리적", "타당", "일관", "텍스트", "자막", "로고", "근거", "인용", "추가", "화면", "영상", "모습"
]);
const EVIDENCE_ASSERTION_ANCHORS = [
  "완전히", "항상", "절대", "유일", "모든", "전혀", "반드시", "최초", "최대", "최소", "perfectly", "always", "never", "only", "all", "every", "first", "largest", "smallest"
];
const KOREAN_SINGLE_CONTENT = new Set(["돌", "빛", "물", "비", "틈", "눈", "땅", "흙", "길", "강", "산"]);
const KOREAN_PROPER_SUFFIX = /(?:경복궁|창덕궁|덕수궁|궁|근정전|전|문|탑|왕조|시대|특별시|광역시|대학교|대학|학교|종묘|사찰|국|청|부)$/u;
const LEXICAL_CONCEPTS = Object.freeze([
  { target: ["빠지", "빠지는", "빠져나가", "빠져나가는", "배수"], evidence: ["빠지", "빠져나", "배수", "내보내"] },
  { target: ["표면의"], evidence: ["표면"] },
  { target: ["줍니다"], evidence: ["준다", "도움"] }
]);
const VISUAL_CONCEPTS = Object.freeze([
  { prompt: ["palace", "royal", "gyeongbokgung", "geunjeongjeon", "궁궐", "경복궁", "근정전"], evidence: ["궁궐", "경복궁", "근정전", "왕실", "palace", "royal", "gyeongbokgung", "geunjeongjeon"] },
  { prompt: ["courtyard", "yard", "paving", "pavement", "floor", "ground", "마당", "바닥", "포장"], evidence: ["마당", "바닥", "박석", "돌", "포장", "courtyard", "paving", "pavement"] },
  { prompt: ["stone", "stones", "rock", "rocks", "granite", "slab", "slabs", "돌", "박석", "화강암"], evidence: ["돌", "박석", "화강암", "석재", "stone", "granite", "slab"] },
  { prompt: ["rough", "uneven", "irregular", "texture", "textured", "거친", "울퉁불퉁", "표면"], evidence: ["거친", "울퉁불퉁", "표면", "rough", "uneven", "texture"] },
  { prompt: ["surface"], evidence: ["표면", "surface"] },
  { prompt: ["rain", "rainwater", "water", "drain", "drains", "drainage", "gap", "gaps", "channel", "carry", "carries", "carrying", "flow", "flows", "flowing", "비", "빗물", "배수", "틈", "통로"], evidence: ["비", "빗물", "물", "배수", "빠져나", "틈", "통로", "rain", "water", "drain", "gap", "channel"] },
  { prompt: ["walk", "walking", "pedestrian", "foot", "slip", "slippery", "risk", "reduce", "reduces", "reducing", "보행", "걷", "미끄러"], evidence: ["보행", "걷", "발", "미끄러", "위험", "줄이", "도움", "walk", "pedestrian", "slip", "risk", "reduce"] },
  { prompt: ["reflect", "reflection", "glare", "sunlight", "빛", "반사", "눈부심"], evidence: ["빛", "반사", "눈부", "햇빛", "reflect", "glare", "sunlight"] },
  { prompt: ["soil", "sand", "earth", "masato", "마사토", "흙", "모래"], evidence: ["마사토", "흙", "모래", "토", "soil", "sand", "earth"] },
  { prompt: ["architecture", "building", "structure", "건축", "건물", "구조"], evidence: ["건축", "건물", "구조", "궁궐", "architecture", "building", "structure"] }
]);

function normalizeBindingText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[’‘`]/gu, "'").replace(/[^가-힣a-z0-9.%]+/giu, " ").trim();
}

function compactBindingText(value) {
  return normalizeBindingText(value).replace(/\s+/gu, "");
}

function koreanTokenStem(value) {
  let token = value;
  const endings = [
    "하였습니다", "되었습니다", "했습니다", "됩니다", "합니다", "입니다", "있습니다", "없습니다", "줍니다", "보입니다", "만듭니다",
    "이어집니다", "하였고", "하였으며", "했으며", "했지만", "하면서", "하도록", "하는", "하며", "하여", "해서", "하고", "된다", "되는",
    "되어", "되고", "이다", "이며", "인", "있다", "있는", "없다", "없는", "준다", "주는", "였다", "했다", "한다", "된다", "된다", "다"
  ];
  const particles = ["으로부터", "에게서", "에서부터", "으로써", "으로서", "에서는", "이라도", "에게", "에서", "까지", "부터", "처럼", "보다", "으로", "와", "과", "이", "가", "은", "는", "을", "를", "의", "에", "도", "만"];
  for (const suffix of [...endings, ...particles]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 2) {
      token = token.slice(0, -suffix.length);
      break;
    }
  }
  return token;
}

function bindingTokens(value, { visual = false } = {}) {
  const normalized = normalizeBindingText(value);
  const matches = normalized.match(/[가-힣]+|[a-z][a-z0-9'-]*|\d+(?:[.,]\d+)*(?:%|년|월|일|개|명|초|분|시간|mm|cm|km|m)?/giu) || [];
  const tokens = [];
  for (const rawValue of matches) {
    const raw = rawValue.toLocaleLowerCase("ko-KR");
    const korean = /^[가-힣]+$/u.test(raw);
    const stem = korean ? koreanTokenStem(raw) : raw.replace(/(?:'s|s)$/u, "");
    if (/^\d/u.test(raw)) continue;
    if (EVIDENCE_TEXT_STOPWORDS.has(raw) || EVIDENCE_TEXT_STOPWORDS.has(stem)) continue;
    if (visual && (VISUAL_STYLE_STOPWORDS.has(raw) || VISUAL_STYLE_STOPWORDS.has(stem))) continue;
    if (korean && stem.length < 2 && !KOREAN_SINGLE_CONTENT.has(stem)) continue;
    if (!korean && stem.length < 2) continue;
    tokens.push({ raw, stem, korean });
  }
  return [...new Map(tokens.map((token) => [`${token.korean ? "ko" : "en"}:${token.stem}`, token])).values()];
}

function unsupportedBindingTokens(targetTokens, supportedTokens, evidenceText, { visual = false } = {}) {
  const supportedKeys = new Set(supportedTokens.map((token) => `${token.korean ? "ko" : "en"}:${token.stem}`));
  const compactEvidence = compactBindingText(evidenceText);
  return targetTokens.filter((token) => {
    if (supportedKeys.has(`${token.korean ? "ko" : "en"}:${token.stem}`)) return false;
    if (token.korean && token.stem.length === 1 && compactEvidence.includes(token.stem)) return false;
    if (visual && /^(?:it|its|into)$/u.test(token.stem)) return false;
    return true;
  });
}

function embeddedQuotedEvidence(value, evidenceTexts) {
  const text = String(value || "");
  for (const match of text.matchAll(/"((?:\\.|[^"\\])*)"/gu)) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      if (evidenceTexts.includes(decoded)) return decoded;
    } catch {
      // Malformed quoted text is handled by the normal lexical checks.
    }
  }
  return null;
}

function bindingNumbers(value) {
  return [...new Set((normalizeBindingText(value).match(/\d+(?:[.,]\d+)*(?:%|년|월|일|개|명|초|분|시간|mm|cm|km|m)?/giu) || []).map((number) => number.replaceAll(",", "")))];
}

function tokenSimilarity(left, right) {
  if (left.stem === right.stem || left.raw === right.raw) return true;
  if (left.korean !== right.korean) return false;
  if (!left.korean) return left.stem.length >= 4 && right.stem.length >= 4 && (left.stem.startsWith(right.stem) || right.stem.startsWith(left.stem));
  const shorter = Math.min(left.stem.length, right.stem.length);
  if (shorter >= 3) {
    let commonPrefix = 0;
    while (commonPrefix < shorter && left.stem[commonPrefix] === right.stem[commonPrefix]) commonPrefix += 1;
    if (commonPrefix >= Math.max(2, Math.ceil(shorter * 0.6))) return true;
  }
  return false;
}

function tokenSupported(token, evidenceTokens, evidenceText, { visual = false } = {}) {
  if (evidenceTokens.some((candidate) => tokenSimilarity(token, candidate))) return true;
  const conceptSet = visual ? VISUAL_CONCEPTS : LEXICAL_CONCEPTS;
  const concept = conceptSet.find((entry) => (entry.prompt || entry.target).includes(token.raw) || (entry.prompt || entry.target).includes(token.stem));
  if (!concept) return false;
  const compactEvidence = compactBindingText(evidenceText);
  const normalizedEvidence = normalizeBindingText(evidenceText);
  return concept.evidence.some((term) => compactEvidence.includes(compactBindingText(term)) || normalizedEvidence.split(/\s+/u).includes(normalizeBindingText(term)));
}

function negativePolarity(value) {
  return /(?:[가-힣]+지\s*않|않(?:다|는|은|고|게)?|아니(?:다|며|고|라)?|없(?:다|는|고|이)?|못(?:하|한|했|해)|불가능|금지|\b(?:no|not|never|without|cannot|can't)\b)/iu.test(String(value || ""));
}

function visualNegativePolarity(value) {
  const withoutSafeProductionConstraints = String(value || "")
    .replace(/\b(?:no|without)\s+(?:added\s+)?(?:text|subtitles?|logos?)\b/giu, " ")
    .replace(/\b(?:or|and)\s+(?:third[- ]party\s+)?logos?\b/giu, " ");
  return negativePolarity(withoutSafeProductionConstraints);
}

function normalizeExtractiveProposition(value) {
  return normalizeBindingText(value).replace(/[.!?。！？]+$/u, "").trim();
}

function assertExtractiveTextBinding({ claimId, field, text, evidenceTexts, allowTerminalPunctuation = false }) {
  const target = String(text || "").trim();
  if (!target) throw new Error(`${claimId}의 ${field}가 비어 있습니다.`);
  const normalizedTarget = normalizeExtractiveProposition(target);
  const matchedIndex = evidenceTexts.findIndex((evidenceText) => {
    const normalizedEvidence = normalizeExtractiveProposition(evidenceText);
    return allowTerminalPunctuation ? normalizedTarget === normalizedEvidence : normalizeBindingText(target) === normalizeBindingText(evidenceText);
  });
  if (matchedIndex < 0) throw new Error(`${claimId}의 ${field}가 단일 인용 근거의 extractive 문장과 일치하지 않습니다.`);
  return {
    field,
    mode: "exact-extractive",
    targetHash: hashJson({ field, text: target }),
    supportEvidenceHash: hashJson(evidenceTexts[matchedIndex]),
    evidenceIndex: matchedIndex
  };
}

function assertExtractiveVisualBinding({ claimId, text, evidenceTexts }) {
  const target = String(text || "").trim();
  const matchedIndex = evidenceTexts.findIndex((quote) => target === `${EXTRACTIVE_VISUAL_PREFIX}${JSON.stringify(quote)}${EXTRACTIVE_VISUAL_SUFFIX}`);
  if (matchedIndex < 0) throw new Error(`${claimId}의 영상 프롬프트가 고정 extractive evidence template과 일치하지 않습니다.`);
  return {
    field: "영상 프롬프트",
    mode: "fixed-extractive-template",
    targetHash: hashJson({ field: "영상 프롬프트", text: target }),
    supportEvidenceHash: hashJson(evidenceTexts[matchedIndex]),
    evidenceIndex: matchedIndex
  };
}

function properNameAnchors(value, { visual = false } = {}) {
  const anchors = [];
  for (const token of String(value || "").normalize("NFKC").match(/[가-힣]{3,}|\b[A-Z][A-Za-z0-9-]{2,}\b|\b[A-Z]{2,}\b/gu) || []) {
    const normalized = token.toLocaleLowerCase("ko-KR");
    if (visual && VISUAL_STYLE_STOPWORDS.has(normalized)) continue;
    if (visual && VISUAL_CONCEPTS.some((concept) => concept.prompt.includes(normalized))) continue;
    if (/^[가-힣]+$/u.test(token)) {
      const stem = koreanTokenStem(normalized);
      if (KOREAN_PROPER_SUFFIX.test(stem)) anchors.push(stem);
    } else {
      anchors.push(normalized);
    }
  }
  return [...new Set(anchors)];
}

function assertEvidenceTextBinding({ claimId, field, text, evidenceTexts, anchorTexts = evidenceTexts, threshold, minMatches = 1, visual = false, requireAllTokens = false, singleEvidence = false, strictPolarity = false }) {
  const target = String(text || "").trim();
  if (!target) throw new Error(`${claimId}의 ${field}가 비어 있습니다.`);
  const embeddedEvidence = visual ? embeddedQuotedEvidence(target, evidenceTexts) : null;
  const textForLexicalCheck = embeddedEvidence
    ? target.replace(JSON.stringify(embeddedEvidence), " ")
    : target;
  const targetTokens = bindingTokens(textForLexicalCheck, { visual });
  const requiredMatches = Math.min(minMatches, targetTokens.length || 1);
  const numbers = bindingNumbers(target);
  const anchors = properNameAnchors(target, { visual });
  const assertionAnchors = visual ? [] : EVIDENCE_ASSERTION_ANCHORS.filter((anchor) => normalizeBindingText(target).split(/\s+/u).includes(normalizeBindingText(anchor)));
  const targetNegative = visual ? visualNegativePolarity(target) : negativePolarity(target);
  const candidates = singleEvidence
    ? evidenceTexts.map((evidenceText, index) => ({ evidenceText, anchorText: anchorTexts[index] || evidenceText }))
    : [{ evidenceText: evidenceTexts.join(" "), anchorText: anchorTexts.join(" ") }];
  const evaluations = candidates.map(({ evidenceText, anchorText }) => {
    const supportText = visual ? anchorText : evidenceText;
    const evidenceTokens = bindingTokens(supportText);
    const supported = targetTokens.filter((token) => tokenSupported(token, evidenceTokens, supportText, { visual }));
    const directSubstring = compactBindingText(target).length >= 2 && compactBindingText(evidenceText).includes(compactBindingText(target));
    const unsupportedTokens = unsupportedBindingTokens(targetTokens, supported, supportText, { visual });
    const unsupportedTokenCount = unsupportedTokens.length;
    const coverage = embeddedEvidence && unsupportedTokenCount === 0
      ? 1
      : targetTokens.length ? (targetTokens.length - unsupportedTokenCount) / targetTokens.length : directSubstring ? 1 : 0;
    const evidenceNumbers = new Set(bindingNumbers(anchorText));
    const unmatchedNumbers = numbers.filter((number) => !evidenceNumbers.has(number));
    const compactAnchors = compactBindingText(anchorText);
    const unmatchedAnchors = anchors.filter((anchor) => !compactAnchors.includes(compactBindingText(anchor)));
    const unmatchedAssertions = assertionAnchors.filter((anchor) => !normalizeBindingText(anchorText).split(/\s+/u).includes(normalizeBindingText(anchor)));
    const referenceNegative = negativePolarity(anchorText);
    const polarityMatched = !strictPolarity || targetNegative === referenceNegative;
    const effectiveSupportedCount = targetTokens.length - unsupportedTokenCount;
    const valid = (embeddedEvidence ? true : effectiveSupportedCount >= requiredMatches)
      && coverage >= threshold
      && (!requireAllTokens || unsupportedTokenCount === 0)
      && unmatchedNumbers.length === 0
      && unmatchedAnchors.length === 0
      && unmatchedAssertions.length === 0
      && polarityMatched;
    return { evidenceText, directSubstring, supported, effectiveSupportedCount, coverage, unsupportedTokenCount, unsupportedTokens, unmatchedNumbers, unmatchedAnchors, unmatchedAssertions, polarityMatched, valid };
  });
  const evaluation = evaluations.find((candidate) => candidate.valid)
    || evaluations.sort((left, right) => right.supported.length - left.supported.length || right.coverage - left.coverage)[0]
    || { evidenceText: "", directSubstring: false, supported: [], coverage: 0, unsupportedTokenCount: targetTokens.length, unmatchedNumbers: numbers, unmatchedAnchors: anchors, unmatchedAssertions: assertionAnchors, polarityMatched: false, valid: false };
  if (!evaluation.valid) {
    const reasons = [
      evaluation.effectiveSupportedCount < requiredMatches ? "핵심어 부족" : null,
      evaluation.coverage < threshold ? `토큰 커버리지 ${evaluation.coverage.toFixed(2)}` : null,
      requireAllTokens && evaluation.unsupportedTokenCount > 0 ? `미지원 내용어 ${evaluation.unsupportedTokens.map((token) => token.raw).join(", ")}` : null,
      evaluation.unmatchedNumbers.length ? "숫자 불일치" : null,
      evaluation.unmatchedAnchors.length ? "고유명사 불일치" : null,
      evaluation.unmatchedAssertions.length ? "절대 표현 불일치" : null,
      !evaluation.polarityMatched ? "부정 극성 불일치" : null
    ].filter(Boolean);
    throw new Error(`${claimId}의 ${field}가 인용 근거의 내용과 보수적으로 결속되지 않았습니다: ${reasons.join(", ")}.`);
  }
  return {
    field,
    targetHash: hashJson({ field, text: target }),
    supportEvidenceHash: hashJson(evaluation.evidenceText),
    directSubstring: evaluation.directSubstring,
    tokenCount: targetTokens.length,
    supportedTokenCount: evaluation.effectiveSupportedCount,
    coverage: Number(evaluation.coverage.toFixed(4)),
    numberCount: numbers.length,
    properNameCount: anchors.length,
    polarity: targetNegative ? "negative" : "non-negative"
  };
}

function buildEvidenceTextBinding(parsed, segments, sourceMap) {
  const segmentBindings = segments.map((segment) => {
    const evidenceRecords = segment.sourceEvidence.map((item) => ({
      sourceId: item.sourceId,
      sourceSha256: item.sourceSha256,
      evidenceId: item.evidenceId,
      locator: item.locator,
      quote: item.quote,
      parentEvidenceHash: item.parentEvidenceHash,
      contextHash: hashJson(item.context || item.quote)
    }));
    const evidenceTexts = evidenceRecords.map((item) => item.quote);
    const bindings = [];
    const explicitClaims = [
      typeof segment.claim === "string" ? segment.claim : null,
      typeof segment.claimText === "string" ? segment.claimText : null,
      ...(Array.isArray(segment.claims) ? segment.claims.map((claim) => typeof claim === "string" ? claim : claim?.claimText || claim?.text || null) : [])
    ].filter(Boolean);
    for (const claim of explicitClaims.length ? explicitClaims : [segment.narration]) {
      bindings.push(assertExtractiveTextBinding({ claimId: segment.claimId, field: "주장", text: claim, evidenceTexts, allowTerminalPunctuation: true }));
    }
    bindings.push(assertExtractiveTextBinding({ claimId: segment.claimId, field: "내레이션", text: segment.narration, evidenceTexts, allowTerminalPunctuation: true }));
    bindings.push(assertExtractiveTextBinding({ claimId: segment.claimId, field: "자막", text: segment.caption, evidenceTexts, allowTerminalPunctuation: true }));
    bindings.push(assertExtractiveVisualBinding({ claimId: segment.claimId, text: segment.visualPrompt, evidenceTexts }));
    return {
      claimId: segment.claimId,
      evidenceHash: hashJson(evidenceRecords),
      bindings
    };
  });
  const allEvidence = segments.flatMap((segment) => segment.sourceEvidence.map((item) => item.quote));
  const expectedNarration = segments.map((segment) => String(segment.narration || "").trim()).join(" ");
  if (normalizeBindingText(parsed.narration) !== normalizeBindingText(expectedNarration)) {
    throw new Error("script의 전체 내레이션이 장면별 extractive 내레이션의 순서와 일치하지 않습니다.");
  }
  const globalBindings = [
    assertExtractiveTextBinding({ claimId: "script", field: "제목", text: parsed.title, evidenceTexts: allEvidence, allowTerminalPunctuation: true }),
    assertExtractiveTextBinding({ claimId: "script", field: "훅", text: parsed.hook, evidenceTexts: allEvidence, allowTerminalPunctuation: true }),
    {
      field: "전체 내레이션",
      mode: "ordered-extractive-concatenation",
      targetHash: hashJson({ field: "전체 내레이션", text: String(parsed.narration || "").trim() }),
      supportEvidenceHash: hashJson(allEvidence)
    }
  ];
  const globalEvidenceHash = hashJson({
    segmentEvidence: segments.map((segment) => segment.sourceEvidence.map((item) => ({
      sourceId: item.sourceId,
      sourceSha256: item.sourceSha256,
      evidenceId: item.evidenceId,
      locator: item.locator,
      quote: item.quote,
      parentEvidenceHash: item.parentEvidenceHash,
      contextHash: hashJson(item.context || item.quote)
    }))),
    sourceCatalog: [...sourceMap.values()].map((source) => ({ sourceId: source.url, title: source.title || source.url, sha256: source.sha256 || null }))
  });
  const receipt = {
    schemaVersion: 3,
    algorithm: EVIDENCE_TEXT_BINDING_ALGORITHM,
    status: "extractively-bound",
    segmentCount: segments.length,
    evidenceSetHash: hashJson(segmentBindings.map(({ claimId, evidenceHash }) => ({ claimId, evidenceHash }))),
    globalEvidenceHash,
    globalBindings,
    segmentBindings
  };
  return { ...receipt, bindingHash: hashJson(receipt) };
}

function containingEvidenceSentence(parentQuote, selectedQuote) {
  const parent = String(parentQuote || "");
  const selected = String(selectedQuote || "");
  if (!parent.includes(selected)) return selected;
  return sentenceSpans(parent).find((span) => span.quote.includes(selected))?.quote || selected;
}

export function validateEvidenceBoundScript(parsed, sources, clipCount, generatedBy = "unknown") {
  if (parsed?.researchStatus !== "verified") throw new Error("근거 결속 대본은 researchStatus: verified를 명시해야 합니다.");
  if (!Array.isArray(parsed?.segments) || parsed.segments.length !== clipCount) throw new Error("요청한 클립 수의 대본을 반환하지 않았습니다.");
  const sourceMap = new Map((sources || []).filter((source) => source && typeof source !== "string" && source.fetchStatus === "fetched" && source.url).map((source) => [source.url, source]));
  if (!sourceMap.size) throw new Error("검증 가능한 출처 본문이 없어 대본 생성을 중단했습니다.");
  const claimIds = new Set();
  const segments = parsed.segments.map((segment, index) => {
    const claimId = String(segment.claimId || "").trim();
    if (!claimId || claimIds.has(claimId)) throw new Error(`${index + 1}번 장면의 claimId가 비어 있거나 중복됩니다.`);
    claimIds.add(claimId);
    if (!String(segment.caption || "").trim() || !String(segment.narration || "").trim() || !String(segment.visualPrompt || "").trim()) throw new Error(`${claimId}의 자막·내레이션·영상 프롬프트가 모두 필요합니다.`);
    if (!Array.isArray(segment.evidenceRefs) || segment.evidenceRefs.length !== 1) throw new Error(`${claimId}에는 정확히 하나의 extractive 주장 근거가 필요합니다.`);
    const sourceEvidence = segment.evidenceRefs.map((reference) => {
      const sourceId = String(reference?.sourceId || "").trim();
      const evidenceId = String(reference?.evidenceId || "").trim();
      const quote = String(reference?.quote || "").trim();
      const source = sourceMap.get(sourceId);
      const evidence = source?.evidence?.find((item) => item.id === evidenceId);
      if (!source || !evidence || !quote || !String(evidence.quote || "").includes(quote)) throw new Error(`${claimId}의 인용문이 캡처된 출처 원문과 일치하지 않습니다.`);
      const parentQuote = String(evidence.quote || "");
      const parentLocator = /^text-offset:(\d+)-(\d+)$/.exec(String(evidence.locator || ""));
      const relativeOffset = parentQuote.indexOf(quote);
      const context = containingEvidenceSentence(parentQuote, quote);
      if (normalizeBindingText(quote) !== normalizeBindingText(context)) {
        throw new Error(`${claimId}의 인용문은 캡처된 근거의 완전한 한 문장이어야 합니다.`);
      }
      const locator = parentLocator && relativeOffset >= 0
        ? `text-offset:${Number(parentLocator[1]) + relativeOffset}-${Number(parentLocator[1]) + relativeOffset + quote.length}`
        : evidence.locator;
      return {
        claimId,
        sourceId,
        title: source.title || sourceId,
        evidenceId,
        locator,
        quote,
        context,
        parentEvidenceHash: hashJson({ evidenceId, locator: evidence.locator, quote: parentQuote }),
        sourceSha256: source.sha256 || null
      };
    });
    return {
      ...segment,
      claimId,
      sourceIds: [...new Set(sourceEvidence.map((item) => item.sourceId))],
      evidenceRefs: sourceEvidence.map(({ claimId: _claimId, title: _title, sourceSha256: _sha256, ...reference }) => reference),
      sourceEvidence
    };
  });
  const evidenceTextBinding = buildEvidenceTextBinding(parsed, segments, sourceMap);
  return {
    ...parsed,
    sources,
    researchStatus: "verified",
    evidenceTextBinding,
    evidenceTextBindingHash: evidenceTextBinding.bindingHash,
    sourceEvidence: [...sourceMap.values()].map((source) => ({ sourceId: source.url, title: source.title || source.url, fetchStatus: source.fetchStatus, sha256: source.sha256 || null, evidence: source.evidence || [] })),
    segments,
    generatedBy
  };
}

export function verifyEvidenceBoundScript(parsed, sources, clipCount) {
  try {
    const validated = validateEvidenceBoundScript(parsed, sources, clipCount, parsed?.generatedBy || "verification");
    const declared = parsed?.evidenceTextBinding;
    const declaredHash = String(parsed?.evidenceTextBindingHash || "");
    const recomputed = validated.evidenceTextBinding;
    const { bindingHash: _declaredEmbeddedHash, ...declaredPayload } = declared || {};
    const verified = Boolean(
      parsed?.researchStatus === "verified"
      && declared
      && declaredHash === declared?.bindingHash
      && declaredHash === hashJson(declaredPayload)
      && declaredHash === recomputed.bindingHash
      && hashJson(declared) === hashJson(recomputed)
    );
    return { verified, bindingHash: recomputed.bindingHash, binding: recomputed, error: verified ? null : "저장된 evidence text binding 영수증이 재계산 결과와 일치하지 않습니다." };
  } catch (error) {
    return { verified: false, bindingHash: null, binding: null, error: error.message };
  }
}

const SOURCE_BOILERPLATE_PATTERN = /(?:본문\s*바로가기|주메뉴\s*바로가기|전체\s*메뉴|메뉴\s*(?:추가|삭제|닫기)|누리집\s*(?:안내|이용)|화면\s*크기|현재\s*언어|로그인|회원\s*가입|통합\s*검색|페이지\s*(?:인쇄|구성)|만족도\s*조사|의견\s*(?:등록|처리)|개인정보|저작권|고객지원센터|찾아오시는\s*길|인기\s*검색어|최근\s*검색어|목록으로\s*이동|QR\s*코드|관련\s*홈페이지|연락처|파일명|파일\s*크기|다운로드|소스\s*코드|콘텐츠\s*기본\s*정보|생산자\s*정보|기여자\s*정보|기술\s*정보|상업적\s*이용|이용\s*금지|변경\s*금지|라이선스|\bCCL\b|All\s+Rights\s+Reserved|Copyright)/iu;
const SOURCE_TECHNICAL_PATTERN = /(?:https?:\/\/|www\.|\b(?:UCI|N2[CR]|iframe)\b|\.(?:mp4|mov|webm|m4v|mkv|pdf|zip)\b|\b\d{3,4}\s*[x×]\s*\d{3,4}\b|\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|px)\b|\b[A-Z]\d{2,}(?:[-_:][A-Z0-9]+){1,}\b|(?:[a-z0-9-]+\.)+(?:com|org|net|go\.kr|or\.kr|co\.kr)\b)/iu;
const SOURCE_STAGE_DIRECTION_PATTERN = /(?:\((?:[^)]{0,24})(?:컷|초\s*후|씬|보고|전환|빠르게|남자|여자)(?:[^)]{0,24})\)|(?:조금\s+)?빠르게\))/iu;
const SOURCE_EXPLANATORY_PATTERN = /(?:때문|따라|통해|원리|기능|역할|재료|사용|구성|형성|반사|배수|보완|표면|구조|특징|만들|깔리|보이|작동|이루|도움|능력|이유)/u;
const SOURCE_PROMOTIONAL_PATTERN = /(?:소중한|아름다운|조화로운|지혜가\s*담긴|비밀|진가를\s*발휘|한결\s*편안)/u;

function normalizeEvidenceTerms(terms = []) {
  return [...new Set(terms.map((term) => String(term || "").normalize("NFKC").toLocaleLowerCase("ko-KR").trim()).filter((term) => term.length >= 2))];
}

function sentenceSpans(text) {
  const spans = [];
  for (const match of String(text || "").matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu)) {
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && /\s/u.test(text[start])) start += 1;
    while (end > start && /\s/u.test(text[end - 1])) end -= 1;
    const leadingDirection = /^(?:(?:\([^)]{1,64}\)|(?:조금\s+)?빠르게\))\s*)+/u.exec(text.slice(start, end));
    if (leadingDirection) start += leadingDirection[0].length;
    while (start < end && /\s/u.test(text[start])) start += 1;
    if (start < end) spans.push({ start, end, quote: text.slice(start, end) });
  }
  return spans;
}

function termPositions(text, terms) {
  const normalized = String(text || "").normalize("NFKC").toLocaleLowerCase("ko-KR");
  const positions = [];
  for (const term of terms) {
    let offset = 0;
    while (offset < normalized.length) {
      const found = normalized.indexOf(term, offset);
      if (found < 0) break;
      positions.push(found);
      offset = found + Math.max(1, term.length);
      if (positions.length >= 20000) break;
    }
    if (positions.length >= 20000) break;
  }
  return positions.sort((left, right) => left - right);
}

function nearestPositionDistance(positions, target) {
  if (!positions.length) return Number.POSITIVE_INFINITY;
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < target) low = middle + 1;
    else high = middle;
  }
  return Math.min(
    low < positions.length ? Math.abs(positions[low] - target) : Number.POSITIVE_INFINITY,
    low > 0 ? Math.abs(positions[low - 1] - target) : Number.POSITIVE_INFINITY
  );
}

function repeatedTokenCount(quote) {
  const counts = new Map();
  let maximum = 0;
  for (const token of quote.match(/[가-힣A-Za-z]{2,}/gu) || []) {
    const normalized = token.toLocaleLowerCase("ko-KR");
    const count = (counts.get(normalized) || 0) + 1;
    counts.set(normalized, count);
    maximum = Math.max(maximum, count);
  }
  return maximum;
}

function rankEvidenceSpans(text, terms = [], options = {}) {
  const normalizedTerms = normalizeEvidenceTerms(terms);
  const priorityTerms = normalizeEvidenceTerms(options.priorityTerms || []);
  const positions = termPositions(text, normalizedTerms);
  const allowContextOnly = options.allowContextOnly === true;
  return sentenceSpans(text).flatMap((span) => {
    const quote = span.quote;
    const length = [...quote].length;
    // Concise source propositions such as "... 이유다." are useful, fully
    // attributable hooks. Do not discard them merely for being one character
    // shorter than an ordinary narration sentence.
    if (length < 15 || length > 220) return [];
    if (!/다[.!。]+$/u.test(quote)) return [];
    if (/[!?！？]/u.test(quote) || SOURCE_BOILERPLATE_PATTERN.test(quote) || SOURCE_TECHNICAL_PATTERN.test(quote) || SOURCE_STAGE_DIRECTION_PATTERN.test(quote) || SOURCE_PROMOTIONAL_PATTERN.test(quote)) return [];
    if (/[|{}<>_=]/u.test(quote) || repeatedTokenCount(quote) >= 4) return [];
    const koreanCount = (quote.match(/[가-힣]/gu) || []).length;
    const letterCount = (quote.match(/[가-힣A-Za-z]/gu) || []).length;
    const digitCount = (quote.match(/[0-9]/gu) || []).length;
    if (koreanCount < 12 || koreanCount / Math.max(1, letterCount) < 0.68 || digitCount / Math.max(1, length) > 0.12) return [];
    const normalizedQuote = quote.normalize("NFKC").toLocaleLowerCase("ko-KR");
    const matchedTerms = normalizedTerms.filter((term) => normalizedQuote.includes(term));
    const matchedPriorityTerms = priorityTerms.filter((term) => normalizedQuote.includes(term));
    const matchedSecondaryTerms = matchedTerms.filter((term) => !matchedPriorityTerms.includes(term));
    const proximity = nearestPositionDistance(positions, Math.round((span.start + span.end) / 2));
    const contextRelevant = proximity <= 320;
    const explanatory = SOURCE_EXPLANATORY_PATTERN.test(quote);
    if (normalizedTerms.length && !matchedTerms.length && ((!contextRelevant && !allowContextOnly) || !explanatory)) return [];
    const score = matchedPriorityTerms.length * 40
      + matchedSecondaryTerms.length * 5
      + (contextRelevant ? Math.max(0, 14 - Math.floor(proximity / 32)) : 0)
      + (explanatory ? 14 : 0)
      + Math.round(koreanCount / Math.max(1, letterCount) * 10)
      + (length >= 28 && length <= 120 ? 12 : length <= 160 ? 6 : 0);
    return [{ ...span, score, matchedTerms, proximity }];
  }).sort((left, right) => right.score - left.score || left.start - right.start || left.quote.localeCompare(right.quote, "ko"));
}

function comparisonText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^가-힣a-z0-9]+/gu, "");
}

function characterShingles(value, size = 3) {
  const normalized = comparisonText(value);
  const shingles = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) shingles.add(normalized.slice(index, index + size));
  return { normalized, shingles };
}

function nearDuplicateEvidence(left, right) {
  const a = characterShingles(left);
  const b = characterShingles(right);
  if (!a.normalized || !b.normalized) return false;
  if (a.normalized === b.normalized) return true;
  if (Math.min(a.normalized.length, b.normalized.length) >= 18 && (a.normalized.includes(b.normalized) || b.normalized.includes(a.normalized))) return true;
  if (!a.shingles.size || !b.shingles.size) return false;
  let intersection = 0;
  for (const shingle of a.shingles) if (b.shingles.has(shingle)) intersection += 1;
  const union = a.shingles.size + b.shingles.size - intersection;
  const shingleSimilarity = union > 0 ? intersection / union : 0;
  if (shingleSimilarity >= 0.78) return true;
  if (shingleSimilarity < 0.32 || a.normalized.length > 220 || b.normalized.length > 220) return false;
  const shorter = a.normalized.length <= b.normalized.length ? a.normalized : b.normalized;
  const longer = a.normalized.length <= b.normalized.length ? b.normalized : a.normalized;
  let previous = new Uint16Array(shorter.length + 1);
  for (const character of longer) {
    const current = new Uint16Array(shorter.length + 1);
    for (let index = 1; index <= shorter.length; index += 1) {
      current[index] = character === shorter[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }
  return (2 * previous[shorter.length]) / (a.normalized.length + b.normalized.length) >= 0.74;
}

function fallbackEvidenceCandidates(topic, sourceEntries) {
  const topicTerms = sourceTerms(topic);
  const candidates = [];
  let capturedCharacters = 0;
  for (let sourceIndex = 0; sourceIndex < sourceEntries.length; sourceIndex += 1) {
    const source = sourceEntries[sourceIndex];
    if (!source || typeof source === "string" || source.fetchStatus !== "fetched" || !source.url) continue;
    const terms = sourceTerms(topic, source.title || "");
    for (let evidenceIndex = 0; evidenceIndex < (source.evidence || []).length; evidenceIndex += 1) {
      const item = source.evidence[evidenceIndex];
      const quote = String(item?.quote || "");
      if (!quote || capturedCharacters >= 128000) continue;
      capturedCharacters += quote.length;
      const capturedContextDistance = Number(item?.relevance?.contextDistance);
      const capturedAsRelevant = Number.isFinite(capturedContextDistance) && capturedContextDistance <= 320;
      for (const span of rankEvidenceSpans(quote, terms, { allowContextOnly: capturedAsRelevant, priorityTerms: topicTerms })) {
        candidates.push({
          ...span,
          sourceId: source.url,
          title: source.title || source.url,
          sourceSha256: source.sha256 || null,
          evidenceId: item.id,
          evidenceLocator: item.locator,
          sourceIndex,
          evidenceIndex
        });
      }
    }
  }
  const ranked = candidates.sort((left, right) => right.score - left.score
    || left.sourceIndex - right.sourceIndex
    || left.evidenceIndex - right.evidenceIndex
    || left.start - right.start
    || left.quote.localeCompare(right.quote, "ko"));
  const unique = [];
  for (const candidate of ranked) {
    if (unique.some((selected) => nearDuplicateEvidence(candidate.quote, selected.quote))) continue;
    unique.push(candidate);
    if (unique.length >= 96) break;
  }
  return unique;
}

function captionFromEvidence(quote) {
  // Keep the complete extractive proposition. Presentation wrapping happens in
  // the caption renderer; truncating here can remove a negation or predicate.
  return String(quote || "").trim().replace(/[.!。]+$/u, "");
}

export function hasEvidenceHookFraming(value) {
  const text = String(value || "").normalize("NFKC");
  return /(?:이유|왜|방법|비밀|사실|숨어|어떻게|어디서|그러나|그런데|하지만|반면|의외로|때문|통해|따라|아니(?:다|라|며|지만)|아닙니다|않(?:다|는다|습니다)|없(?:다|는|습니다)|[0-9]+)/u.test(text);
}

function evidenceHookScore(value) {
  const text = String(value || "").normalize("NFKC");
  const explicitQuestion = /(?:이유|왜|방법|비밀|어떻게|어디서)/u.test(text);
  const contrast = /(?:사실|그러나|그런데|하지만|반면|의외로|아니(?:다|라|며|지만)|아닙니다|않(?:다|는다|습니다)|없(?:다|는|습니다))/u.test(text);
  const causal = /(?:때문|통해|따라)/u.test(text);
  const scale = /[0-9]+/u.test(text);
  return explicitQuestion * 8 + contrast * 4 + causal * 2 + scale;
}

function selectFallbackEvidence(candidates, clipCount) {
  const hook = [...candidates].sort((left, right) => evidenceHookScore(right.quote) - evidenceHookScore(left.quote)
    || right.score - left.score
    || left.sourceIndex - right.sourceIndex
    || left.evidenceIndex - right.evidenceIndex
    || left.start - right.start)[0];
  if (!hook || !hasEvidenceHookFraming(hook.quote)) return candidates.slice(0, clipCount);
  return [hook, ...candidates.filter((candidate) => candidate !== hook)].slice(0, clipCount);
}

export function evidenceFallbackScript(topic, clipCount, sourceEntries = [], targetDurationSec = 78) {
  const candidates = fallbackEvidenceCandidates(topic, sourceEntries);
  if (candidates.length < clipCount) throw new Error(`유효한 검증 근거 문장이 부족합니다: ${candidates.length}/${clipCount}. 메뉴·식별자가 아닌 주제 관련 설명문이 있는 출처를 추가하거나 Gemini 텍스트 API를 설정하세요.`);
  const durationHint = Math.max(3, Number((targetDurationSec / clipCount).toFixed(2)));
  // The hook remains a complete captured sentence; only its editorial order is
  // changed. Claims, citations, and extractive verification stay byte-bound.
  const selected = selectFallbackEvidence(candidates, clipCount);
  const parsed = {
    title: selected[0].quote,
    hook: selected[0].quote,
    narration: selected.map((item) => item.quote).join(" "),
    researchStatus: "verified",
    segments: selected.map((item, index) => {
      const narration = item.quote;
      return {
        claimId: `claim-${index + 1}`,
        claim: narration,
        caption: captionFromEvidence(narration),
        narration,
        visualPrompt: `${EXTRACTIVE_VISUAL_PREFIX}${JSON.stringify(narration)}${EXTRACTIVE_VISUAL_SUFFIX}`,
        durationHint,
        evidenceRefs: [{ sourceId: item.sourceId, evidenceId: item.evidenceId, quote: narration }]
      };
    })
  };
  return validateEvidenceBoundScript(parsed, sourceEntries, clipCount, "evidence-extract-fallback");
}

function sourceTerms(topic, sourceTitle = "") {
  const stop = new Set(["대한", "관한", "이유", "방법", "사실", "영상", "공식", "홈페이지", "그리고", "에서", "으로", "하는", "있는", "보여도", "같은", "무엇", "어떻게", "왜냐하면", "http", "https", "www", "resolver", "source", "openai", "heritage"]);
  const particles = /(?:에게서|으로서|으로써|까지|부터|처럼|보다|이나|거나|에서|에게|께서|으로|로서|[이가은는을를의와과도만])$/u;
  const terms = [];
  for (const token of `${topic || ""} ${sourceTitle || ""}`.match(/[가-힣A-Za-z0-9]{2,}/gu) || []) {
    const normalized = token.toLocaleLowerCase("ko-KR");
    if (stop.has(normalized) || /\d/u.test(normalized)) continue;
    if (/^[가-힣]{3,}$/u.test(normalized)) {
      const stem = normalized.replace(particles, "");
      if (stem.length >= 2 && stem !== normalized && !stop.has(stem)) {
        terms.push(stem);
        continue;
      }
    }
    terms.push(normalized);
  }
  return [...new Set(terms)].slice(0, 20);
}

function decodeSourceEntities(value) {
  const named = new Map([["nbsp", " "], ["amp", "&"], ["quot", "\""], ["apos", "'"], ["lt", "<"], ["gt", ">"]]);
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (entity, code) => {
    if (code.startsWith("#")) {
      const numeric = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
    }
    return named.get(code.toLowerCase()) ?? entity;
  });
}

function canonicalSourceText(raw, contentType) {
  if (/json/i.test(contentType)) {
    try {
      const strings = [];
      const visit = (value) => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(JSON.parse(raw));
      return strings.map((value) => value.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n");
    } catch {
      // Invalid JSON is still handled as visible text below.
    }
  }
  const decoded = decodeSourceEntities(raw);
  const visible = decoded
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|h[1-6]|hr|li|main|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return visible;
}

export function sourceExcerpt(bytes, contentType, terms = []) {
  if (!/text\/|json|xml/i.test(contentType)) return { excerpt: "", evidence: [] };
  const raw = new TextDecoder().decode(bytes);
  const clean = canonicalSourceText(raw, contentType);
  const ranked = rankEvidenceSpans(clean, terms);
  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((existing) => nearDuplicateEvidence(candidate.quote, existing.quote))) continue;
    selected.push(candidate);
    if (selected.length >= 32) break;
  }
  selected.sort((left, right) => left.start - right.start || right.score - left.score);
  const evidence = selected.map((candidate, index) => ({
    id: `excerpt-${index + 1}`,
    locator: `text-offset:${candidate.start}-${candidate.end}`,
    quote: candidate.quote,
    relevance: {
      matchedTerms: candidate.matchedTerms,
      contextDistance: Number.isFinite(candidate.proximity) ? candidate.proximity : null
    }
  }));
  return { excerpt: evidence.map((item) => item.quote).join(" … ").slice(0, 4000), evidence };
}
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_COUNT = 12;
const MAX_SOURCE_CONCURRENCY = 3;

// Conservatively exclude RFC 6890/IANA non-public, reserved, documentation,
// transition, multicast, and local-use ranges from source-fetch targets. Keep
// these as byte-level CIDRs: equivalent IPv6 addresses have many spellings and
// fe80::/10 spans fe80:: through febf::.
const NON_PUBLIC_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

const NON_PUBLIC_IPV6_CIDRS = [
  ["::", 8], // unspecified, loopback, IPv4-compatible, translation and other reserved forms
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments, benchmarking and ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed a non-public IPv4 destination)
  ["3ffe::", 16], // former 6bone allocation, returned to IANA
  ["3fff::", 20], // documentation prefix
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local, including fe80:: through febf::
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8] // multicast
];

function normalizedSourceHost(value) {
  let host = String(value || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.replace(/\.$/, "");
}

function parseIpv4Bytes(value) {
  const input = normalizedSourceHost(value);
  if (isIP(input) !== 4) return null;
  return Uint8Array.from(input.split(".").map(Number));
}

function parseIpv6Bytes(value) {
  let input = normalizedSourceHost(value);
  // Scoped addresses are link-local in practice, and a scope identifier must
  // never be accepted from either a URL literal or a resolver response.
  if (input.includes("%") || isIP(input) !== 6) return null;
  if (input.includes(".")) {
    const colon = input.lastIndexOf(":");
    const ipv4 = parseIpv4Bytes(input.slice(colon + 1));
    if (!ipv4) return null;
    input = `${input.slice(0, colon)}:${(ipv4[0] << 8 | ipv4[1]).toString(16)}:${(ipv4[2] << 8 | ipv4[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return null;
  const words = [...left, ...Array(omitted).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return Uint8Array.from(words.flatMap((word) => [word >>> 8, word & 0xff]));
}

function addressMatchesCidr(address, network, prefixLength) {
  if (!address || !network || address.length !== network.length || prefixLength < 0 || prefixLength > address.length * 8) return false;
  const wholeBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  const remainder = prefixLength % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

function matchesAnyCidr(address, family, cidrs) {
  return cidrs.some(([network, prefixLength]) => addressMatchesCidr(address, family === 4 ? parseIpv4Bytes(network) : parseIpv6Bytes(network), prefixLength));
}

function mappedIpv4Bytes(address) {
  if (address.length !== 16) return null;
  if (address.slice(0, 10).some((byte) => byte !== 0) || address[10] !== 0xff || address[11] !== 0xff) return null;
  return address.slice(12);
}

function isPublicIpv4Bytes(address) {
  return !matchesAnyCidr(address, 4, NON_PUBLIC_IPV4_CIDRS);
}

/** Fail-closed source-fetch address policy, shared by URL literals and DNS results. */
export function isPublicSourceAddress(value) {
  const host = normalizedSourceHost(value);
  const family = isIP(host);
  if (family === 4) {
    const address = parseIpv4Bytes(host);
    return Boolean(address && isPublicIpv4Bytes(address));
  }
  if (family !== 6) return false;
  const address = parseIpv6Bytes(host);
  if (!address) return false;
  const mapped = mappedIpv4Bytes(address);
  if (mapped) return isPublicIpv4Bytes(mapped);
  const globalUnicast = addressMatchesCidr(address, parseIpv6Bytes("2000::"), 3);
  return globalUnicast && !matchesAnyCidr(address, 6, NON_PUBLIC_IPV6_CIDRS);
}

export function validatePublicSourceAddresses(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) throw new Error("출처 호스트가 공용 네트워크 주소로만 확인되지 않았습니다.");
  const normalized = addresses.map((entry) => {
    const address = typeof entry === "string" ? entry : entry?.address;
    const family = isIP(normalizedSourceHost(address));
    const declaredFamily = typeof entry === "object" && entry ? Number(entry.family) : family;
    if (!family || declaredFamily !== family || !isPublicSourceAddress(address)) throw new Error("출처 호스트가 공용 네트워크 주소로만 확인되지 않았습니다.");
    return { address: normalizedSourceHost(address), family };
  });
  return normalized;
}

function isPrivateSourceHost(hostname) {
  const host = normalizedSourceHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || Boolean(isIP(host) && !isPublicSourceAddress(host));
}

function requestPinnedSource(url, address, signal) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestModule = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHostname = normalizedSourceHost(url.hostname);
    const request = requestModule({
      protocol: url.protocol,
      hostname: requestHostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "user-agent": "PS4-AI-Video-Studio/1.0 source-audit" },
      lookup(_hostname, options, callback) {
        const family = isIP(address);
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      ...(url.protocol === "https:" && !isIP(requestHostname) ? { servername: requestHostname } : {})
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_SOURCE_BYTES) {
          request.destroy(new Error(`출처 응답이 ${MAX_SOURCE_BYTES}바이트 제한을 초과했습니다.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolveRequest({
        status: response.statusCode || 0,
        headers: response.headers,
        bytes: Buffer.concat(chunks, total)
      }));
      response.on("error", rejectRequest);
    });

    const abort = () => request.destroy(new Error("출처 요청이 취소되었습니다."));
    request.on("error", rejectRequest);
    request.setTimeout(12000, () => request.destroy(new Error("출처 요청 시간이 초과되었습니다.")));
    if (signal?.aborted) abort();
    else if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => signal.removeEventListener("abort", abort));
    }
    request.end();
  });
}

async function captureSource(source, topic = "") {
  const normalized = typeof source === "string" ? { title: source, url: source } : { ...source };
  if (!normalized.url || !/^https?:\/\//i.test(normalized.url)) return { ...normalized, fetchStatus: "invalid" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const parsedUrl = new URL(normalized.url);
    if (parsedUrl.username || parsedUrl.password) throw new Error("출처 URL 인증 정보는 허용되지 않습니다.");
    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) throw new Error("출처 URL 포트는 80 또는 443만 허용합니다.");
    if (isPrivateSourceHost(parsedUrl.hostname)) throw new Error("비공개 네트워크 출처는 허용되지 않습니다.");
    const hostname = normalizedSourceHost(parsedUrl.hostname);
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    const publicAddresses = validatePublicSourceAddresses(addresses);
    const publicAddress = publicAddresses[0];
    const response = await requestPinnedSource(parsedUrl, publicAddress.address, controller.signal);
    if (response.status >= 300 && response.status < 400) return { ...normalized, fetchStatus: "redirect-blocked", httpStatus: response.status, error: "출처 리디렉션은 안전 검증을 위해 차단되었습니다.", fetchedAt: new Date().toISOString() };
    const digest = createHash("sha256").update(response.bytes).digest("hex");
    const contentTypeHeader = response.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || "application/octet-stream";
    const extracted = sourceExcerpt(response.bytes, contentType, sourceTerms(topic, normalized.title));
    return { ...normalized, fetchStatus: response.status >= 200 && response.status < 300 ? "fetched" : "http-error", httpStatus: response.status, contentType, byteLength: response.bytes.length, sha256: `sha256:${digest}`, resolvedAddress: publicAddress.address, resolvedFamily: publicAddress.family, excerpt: extracted.excerpt, evidence: extracted.evidence, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { ...normalized, fetchStatus: error.message.includes("허용되지") || error.message.includes("제한을 초과") || error.message.includes("공용 네트워크") || error.message.includes("인증 정보") || error.message.includes("포트") ? "blocked" : "error", error: error.message, fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

async function captureSources(job) {
  const sources = job.sources || [];
  if (sources.length > MAX_SOURCE_COUNT) throw new Error(`출처는 최대 ${MAX_SOURCE_COUNT}개까지 허용합니다.`);
  const records = [];
  for (let index = 0; index < sources.length; index += MAX_SOURCE_CONCURRENCY) {
    const batch = sources.slice(index, index + MAX_SOURCE_CONCURRENCY);
    records.push(...await Promise.all(batch.map((source) => captureSource(source, job.topic))));
  }
  const fetchedCount = records.filter((source) => source.fetchStatus === "fetched").length;
  const evidenceCount = records.reduce((sum, source) => sum + (source.evidence?.length || 0), 0);
  return {
    schemaVersion: 1,
    status: records.length > 0 && fetchedCount === records.length ? "complete" : fetchedCount > 0 ? "partial" : "missing",
    fetchedCount,
    totalCount: records.length,
    evidenceCount,
    records
  };
}

export async function buildScript(job) {
  try {
    const generated = await callGeminiText(job.topic, job.clipCount, job.targetDurationSec, job.sources);
    return generated || evidenceFallbackScript(job.topic, job.clipCount, job.sources, job.targetDurationSec);
  } catch (error) {
    if (process.env.GEMINI_API_KEY) {
      throw error;
    }
    return evidenceFallbackScript(job.topic, job.clipCount, job.sources, job.targetDurationSec);
  }
}

function toSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function splitCaptionText(text, maxChars = 8) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]?/gu) || [normalized];
  const chunks = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (current && [...current, " ", ...word].length > maxChars) {
        chunks.push(current.trim());
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) chunks.push(current.trim());
  }
  return chunks.flatMap((chunk) => {
    if ([...chunk].length <= maxChars) return [chunk];
    if (!/\s/u.test(chunk) && [...chunk].length <= Math.max(16, maxChars + 4)) return [chunk];
    const parts = [];
    const characters = [...chunk];
    const safeLimit = Math.max(maxChars, 12);
    for (let index = 0; index < characters.length; index += safeLimit) parts.push(characters.slice(index, index + safeLimit).join(""));
    return parts;
  });
}

function segmentWindowsForDuration(script, duration) {
  const segments = script.segments || [];
  const weights = segments.map((segment) => Math.max(1, Number(segment.durationHint) || 5));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return segments.map((segment, index) => {
    const start = cursor;
    const end = index === segments.length - 1 ? duration : start + duration * (weights[index] / totalWeight);
    cursor = end;
    return { segment, index, start, end, durationSec: Math.max(0, end - start) };
  });
}

export function captionEntriesForDuration(script, duration, voiceoverSync = null) {
  const entries = [];
  const maxChars = captionMaxChars(script, duration);
  for (const { segment, index, start: segmentStart, end: segmentEnd } of segmentWindowsForDuration(script, duration)) {
    const syncSegment = voiceoverSync?.segments?.[index];
    const speechDuration = Number(syncSegment?.captionDurationSec);
    const captionEnd = Number.isFinite(speechDuration)
      ? Math.min(segmentEnd, segmentStart + Math.max(0.4, speechDuration))
      : segmentEnd;
    const chunks = splitCaptionText(segment.narration || segment.caption, maxChars);
    const chunkWeights = chunks.map((chunk) => Math.max(1, [...chunk.replace(/\s/g, "")].length));
    const chunkTotal = chunkWeights.reduce((sum, value) => sum + value, 0) || 1;
    let chunkCursor = segmentStart;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const start = chunkCursor;
      chunkCursor += (captionEnd - segmentStart) * (chunkWeights[chunkIndex] / chunkTotal);
      const end = chunkIndex === chunks.length - 1 ? captionEnd : chunkCursor;
      entries.push({ text: chunks[chunkIndex], start, end });
    }
  }
  return entries;
}
function captionCueEnd(entry, nextEntry = null) {
  const minimumEnd = Math.max(entry.start + 0.4, entry.end);
  return Number(Math.min(nextEntry?.start ?? minimumEnd, minimumEnd).toFixed(3));
}

const BENCHMARK_CAPTION_CUES_PER_MINUTE = 60.59;
const MINIMUM_BENCHMARK_CAPTION_DENSITY_RATIO = 0.5;

function captionMaxChars(script, duration) {
  const segments = script?.segments || [];
  const texts = segments.map((segment) => String(segment.narration || segment.caption || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const targetCueCount = Math.max(segments.length, Math.ceil((Number(duration) || 0) / 60 * BENCHMARK_CAPTION_CUES_PER_MINUTE * MINIMUM_BENCHMARK_CAPTION_DENSITY_RATIO));
  if (!texts.length || !targetCueCount) return 8;
  // Choose the widest readable chunks that still reach the measured benchmark
  // range. This avoids both deterministic under-density and artificial
  // character-by-character flashing.
  for (let maxChars = 12; maxChars >= 4; maxChars -= 1) {
    const cueCount = texts.reduce((sum, text) => sum + splitCaptionText(text, maxChars).length, 0);
    if (cueCount >= targetCueCount) return maxChars;
  }
  return 4;
}

function captionsForDuration(script, duration, voiceoverSync = null) {
  const entries = captionEntriesForDuration(script, duration, voiceoverSync);
  return entries
    .map((entry, index) => `${index + 1}\n${toSrtTime(entry.start)} --> ${toSrtTime(captionCueEnd(entry, entries[index + 1]))}\n${entry.text}\n`)
    .join("\n");
}

function toVttTime(seconds) {
  return toSrtTime(seconds).replace(",", ".");
}

function escapeVttText(text) {
  return String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function captionWords(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const words = normalized.split(" ").filter(Boolean);
  return words.length > 1 ? words : [...normalized];
}

function timedCaptionWords(entry) {
  const words = captionWords(entry.text);
  const weights = words.map((word) => Math.max(1, [...word].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = entry.start;
  return words.map((word, index) => {
    const start = cursor;
    cursor += (entry.end - entry.start) * (weights[index] / totalWeight);
    return { text: word, start, end: index === words.length - 1 ? entry.end : cursor };
  });
}

function captionsVttForDuration(script, duration, voiceoverSync = null) {
  const entries = captionEntriesForDuration(script, duration, voiceoverSync);
  const cues = entries.map((entry, index) => {
    const timedEntry = { ...entry, end: captionCueEnd(entry, entries[index + 1]) };
    const words = timedCaptionWords(timedEntry);
    const inline = words.map((word, wordIndex) => `<${toVttTime(word.start)}><c>${wordIndex ? " " : ""}${escapeVttText(word.text)}</c>`).join("");
    return { ...timedEntry, words, inline };
  });
  return ["WEBVTT", "Kind: captions", "Language: ko", "", ...cues.flatMap((cue) => [
    `${toVttTime(cue.start)} --> ${toVttTime(cue.end)}`,
    cue.inline,
    ""
  ])].join("\n");
}

function captionTimingForDuration(script, duration, voiceoverSync = null) {
  const entries = captionEntriesForDuration(script, duration, voiceoverSync);
  const cues = entries.map((entry, index) => {
    const timedEntry = { ...entry, end: captionCueEnd(entry, entries[index + 1]) };
    return { ...timedEntry, words: timedCaptionWords(timedEntry) };
  });
  return {
    schemaVersion: 1,
    source: "same script text passed to macOS say",
    alignment: "segment-duration-proportional-estimate",
    estimated: true,
    durationSec: Number(duration.toFixed(3)),
    cueCount: cues.length,
    wordTimingCount: cues.reduce((sum, cue) => sum + cue.words.length, 0),
    cues
  };
}

async function probeDuration(path) {
  const value = await commandOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`영상 길이를 읽지 못했습니다: ${path}`);
  return duration;
}

async function probeHasAudio(path) {
  const value = await commandOutput("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", path]);
  return Boolean(value.trim());
}
function atempoChain(rate) {
  let remaining = Math.max(0.01, Number(rate) || 1);
  const filters = [];
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(",");
}

function mediaPath(jobId, name) {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
}
function inputClipPath(jobDir, name) {
  const clipsDir = resolve(join(jobDir, "clips"));
  const absolutePath = resolve(clipsDir, name);
  if (absolutePath === clipsDir || !absolutePath.startsWith(`${clipsDir}/`)) {
    throw new Error(`클립 경로가 작업 디렉터리를 벗어났습니다: ${name}`);
  }
  return absolutePath;
}

function averageHash(frame) {
  const average = frame.reduce((sum, value) => sum + value, 0) / frame.length;
  let bits = 0n;
  for (const value of frame) bits = (bits << 1n) | (value >= average ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

function hammingHex(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

export function perceptualFingerprintDistance(left = [], right = []) {
  if (!left.length || !right.length) return Number.POSITIVE_INFINITY;
  const samples = Math.min(left.length, right.length);
  let distance = 0;
  for (let index = 0; index < samples; index += 1) {
    const leftIndex = samples === 1 ? 0 : Math.round(index * (left.length - 1) / (samples - 1));
    const rightIndex = samples === 1 ? 0 : Math.round(index * (right.length - 1) / (samples - 1));
    distance += hammingHex(left[leftIndex], right[rightIndex]);
  }
  return Number((distance / samples).toFixed(3));
}

const CLIP_MOTION_GATE_PROVIDERS = new Set(["gemini-browser", "local-video"]);
const CLIP_MOTION_POLICY = Object.freeze({
  algorithm: "ffmpeg-luma-motion-32x32-v1",
  frameWidth: 32,
  frameHeight: 32,
  earlyWindowSec: 1,
  earlySampleRateFps: 8,
  maximumMotionStartSec: 0.375,
  motionDeltaThreshold: 0.75,
  temporalTargetSampleCount: 32,
  temporalMinimumSampleCount: 8,
  temporalMaximumSampleRateFps: 4,
  nearDuplicateDeltaThreshold: 0.75,
  minimumMovingTransitionRatio: 0.25,
  minimumUniqueFrameRatio: 0.35,
  maximumAdjacentNearDuplicateRatio: 0.7,
  maximumStaticRunRatio: 0.5
});

export function clipMotionGateRequired(provider) {
  return CLIP_MOTION_GATE_PROVIDERS.has(provider);
}

export function clipMotionGatePolicy() {
  return { ...CLIP_MOTION_POLICY };
}

function roundedMetric(value) {
  return Number(Number(value).toFixed(4));
}

function meanAbsoluteLumaDelta(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

function rawLumaFrames(bytes) {
  const frameBytes = CLIP_MOTION_POLICY.frameWidth * CLIP_MOTION_POLICY.frameHeight;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= bytes.length; offset += frameBytes) {
    frames.push(bytes.subarray(offset, offset + frameBytes));
  }
  return frames;
}

async function sampleLumaFrames(path, { fps, maxFrames, trimEndSec = null }) {
  const filters = [];
  if (Number.isFinite(trimEndSec)) filters.push(`trim=start=0:end=${Number(trimEndSec).toFixed(6)}`, "setpts=PTS-STARTPTS");
  filters.push(
    `fps=${Number(fps).toFixed(6)}:round=near`,
    `scale=${CLIP_MOTION_POLICY.frameWidth}:${CLIP_MOTION_POLICY.frameHeight}:flags=area`,
    "format=gray"
  );
  const bytes = await commandBytes("ffmpeg", [
    "-v", "error", "-i", path,
    "-an", "-sn", "-dn",
    "-vf", filters.join(","),
    "-frames:v", String(maxFrames),
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ]);
  return rawLumaFrames(bytes);
}

function frameDigest(frame) {
  return createHash("sha256").update(frame).digest("hex").slice(0, 16);
}

function longestRun(values, predicate) {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (predicate(value)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Deterministic decoded-frame motion receipt. The first-second probe prevents a
 * still opening card, while the stratified probe catches static and short-loop
 * clips even when their container SHA-256 values differ.
 */
export async function analyzeClipMotion(path) {
  const durationSec = await probeDuration(path);
  const earlyWindowSec = Math.min(CLIP_MOTION_POLICY.earlyWindowSec, durationSec);
  const earlyMaximumFrames = Math.max(3, Math.ceil(earlyWindowSec * CLIP_MOTION_POLICY.earlySampleRateFps));
  const earlyFrames = await sampleLumaFrames(path, {
    fps: CLIP_MOTION_POLICY.earlySampleRateFps,
    maxFrames: earlyMaximumFrames,
    trimEndSec: earlyWindowSec
  });
  const temporalTarget = Math.max(
    CLIP_MOTION_POLICY.temporalMinimumSampleCount,
    Math.min(CLIP_MOTION_POLICY.temporalTargetSampleCount, Math.ceil(durationSec * CLIP_MOTION_POLICY.temporalMaximumSampleRateFps))
  );
  const temporalSampleRateFps = Math.min(CLIP_MOTION_POLICY.temporalMaximumSampleRateFps, temporalTarget / durationSec);
  const temporalFrames = await sampleLumaFrames(path, {
    fps: temporalSampleRateFps,
    maxFrames: temporalTarget
  });

  const firstFrameDeltas = earlyFrames.slice(1).map((frame) => roundedMetric(meanAbsoluteLumaDelta(earlyFrames[0], frame)));
  const firstMotionIndex = firstFrameDeltas.findIndex((delta) => delta >= CLIP_MOTION_POLICY.motionDeltaThreshold);
  const motionStartSec = firstMotionIndex < 0
    ? null
    : roundedMetric((firstMotionIndex + 1) / CLIP_MOTION_POLICY.earlySampleRateFps);
  const earlyPass = earlyFrames.length >= 3
    && Number.isFinite(motionStartSec)
    && motionStartSec <= CLIP_MOTION_POLICY.maximumMotionStartSec;

  const consecutiveDeltas = temporalFrames.slice(1).map((frame, index) => roundedMetric(meanAbsoluteLumaDelta(temporalFrames[index], frame)));
  const nearestPriorDeltas = temporalFrames.map((frame, index) => {
    if (index === 0) return null;
    let nearest = Number.POSITIVE_INFINITY;
    for (let prior = 0; prior < index; prior += 1) nearest = Math.min(nearest, meanAbsoluteLumaDelta(frame, temporalFrames[prior]));
    return roundedMetric(nearest);
  });
  const transitionCount = consecutiveDeltas.length;
  const movingTransitionRatio = transitionCount
    ? consecutiveDeltas.filter((delta) => delta >= CLIP_MOTION_POLICY.motionDeltaThreshold).length / transitionCount
    : 0;
  const adjacentNearDuplicateRatio = transitionCount
    ? consecutiveDeltas.filter((delta) => delta <= CLIP_MOTION_POLICY.nearDuplicateDeltaThreshold).length / transitionCount
    : 1;
  const uniqueFrameCount = nearestPriorDeltas.filter((delta) => delta === null || delta > CLIP_MOTION_POLICY.nearDuplicateDeltaThreshold).length;
  const uniqueFrameRatio = temporalFrames.length ? uniqueFrameCount / temporalFrames.length : 0;
  const repeatedFrameRatio = temporalFrames.length ? 1 - uniqueFrameRatio : 1;
  const longestStaticTransitionRun = longestRun(consecutiveDeltas, (delta) => delta <= CLIP_MOTION_POLICY.nearDuplicateDeltaThreshold);
  const longestStaticRunRatio = transitionCount ? longestStaticTransitionRun / transitionCount : 1;
  const temporalPass = temporalFrames.length >= CLIP_MOTION_POLICY.temporalMinimumSampleCount
    && movingTransitionRatio >= CLIP_MOTION_POLICY.minimumMovingTransitionRatio
    && uniqueFrameRatio >= CLIP_MOTION_POLICY.minimumUniqueFrameRatio
    && adjacentNearDuplicateRatio <= CLIP_MOTION_POLICY.maximumAdjacentNearDuplicateRatio
    && longestStaticRunRatio <= CLIP_MOTION_POLICY.maximumStaticRunRatio;
  const blockers = [];
  if (earlyFrames.length < 3) blockers.push("첫 1초 동작 분석 프레임이 부족합니다.");
  else if (!earlyPass) blockers.push("첫 프레임 직후 허용 시간 안에 유의미한 동작이 시작되지 않습니다.");
  if (temporalFrames.length < CLIP_MOTION_POLICY.temporalMinimumSampleCount) blockers.push("시간축 다양성 분석 프레임이 부족합니다.");
  if (movingTransitionRatio < CLIP_MOTION_POLICY.minimumMovingTransitionRatio) blockers.push("움직이는 프레임 전환 비율이 기준보다 낮습니다.");
  if (uniqueFrameRatio < CLIP_MOTION_POLICY.minimumUniqueFrameRatio) blockers.push("고유 프레임 비율이 낮아 정지 또는 짧은 반복 영상으로 판정됩니다.");
  if (adjacentNearDuplicateRatio > CLIP_MOTION_POLICY.maximumAdjacentNearDuplicateRatio) blockers.push("인접한 근중복 프레임 비율이 기준보다 높습니다.");
  if (longestStaticRunRatio > CLIP_MOTION_POLICY.maximumStaticRunRatio) blockers.push("연속 정지 구간이 허용 비율보다 깁니다.");

  return {
    schemaVersion: 1,
    algorithm: CLIP_MOTION_POLICY.algorithm,
    policy: clipMotionGatePolicy(),
    durationSec: roundedMetric(durationSec),
    early: {
      sampleRateFps: CLIP_MOTION_POLICY.earlySampleRateFps,
      frameCount: earlyFrames.length,
      frameDigests: earlyFrames.map(frameDigest),
      firstFrameDeltas,
      motionStartSec,
      passed: earlyPass
    },
    temporal: {
      sampleRateFps: roundedMetric(temporalSampleRateFps),
      frameCount: temporalFrames.length,
      frameDigests: temporalFrames.map(frameDigest),
      consecutiveDeltas,
      nearestPriorDeltas,
      movingTransitionRatio: roundedMetric(movingTransitionRatio),
      uniqueFrameCount,
      uniqueFrameRatio: roundedMetric(uniqueFrameRatio),
      repeatedFrameRatio: roundedMetric(repeatedFrameRatio),
      adjacentNearDuplicateRatio: roundedMetric(adjacentNearDuplicateRatio),
      longestStaticTransitionRun,
      longestStaticRunRatio: roundedMetric(longestStaticRunRatio),
      passed: temporalPass
    },
    passed: earlyPass && temporalPass,
    blockers
  };
}

async function perceptualFingerprint(path) {
  const duration = await probeDuration(path);
  const sampleCount = 8;
  const fps = Math.max(0.05, sampleCount / Math.max(duration, 0.1));
  const bytes = await commandBytes("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${fps.toFixed(6)},scale=8:8:flags=area,format=gray`,
    "-frames:v", String(sampleCount), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ]);
  const hashes = [];
  for (let offset = 0; offset + 64 <= bytes.length; offset += 64) hashes.push(averageHash(bytes.subarray(offset, offset + 64)));
  if (!hashes.length) throw new Error(`영상 지문을 만들 수 없습니다: ${path}`);
  return { algorithm: "temporal-ahash-8x8-v1", durationSec: Number(duration.toFixed(3)), frames: hashes };
}

export async function createInputManifest(jobDir, runDir, jobId, runId, requestedNames = null, expectedCount = null, provider = "local") {
  const clipsDir = join(jobDir, "clips");
  const names = [...new Set((requestedNames || (await readdir(clipsDir).catch(() => [])))
    .filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort())];
  if (!names.length) throw new Error("입력 manifest에 기록할 영상 클립이 없습니다.");
  if (Number.isFinite(Number(expectedCount)) && names.length !== Number(expectedCount)) {
    throw new Error(`입력 manifest 클립 수가 요청과 다릅니다: ${names.length}/${Number(expectedCount)}`);
  }
  const selected = [];
  for (const name of names) {
    const absolutePath = inputClipPath(jobDir, name);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error(`영상 클립 파일이 아닙니다: ${name}`);
    const sha256 = await hashFile(absolutePath);
    const perceptual = await perceptualFingerprint(absolutePath);
    const motion = await analyzeClipMotion(absolutePath);
    selected.push({ name, relativePath: `clips/${name}`, bytes: fileStat.size, sha256, perceptual, motion, absolutePath });
  }
  const exactHashes = new Map();
  for (const entry of selected) {
    if (exactHashes.has(entry.sha256)) throw new Error(`서로 다른 생성 클립이 필요합니다. ${exactHashes.get(entry.sha256)}와 ${entry.name}의 SHA-256이 같습니다.`);
    exactHashes.set(entry.sha256, entry.name);
  }
  const perceptualComparisons = [];
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const distance = perceptualFingerprintDistance(selected[left].perceptual.frames, selected[right].perceptual.frames);
      perceptualComparisons.push({ left: selected[left].name, right: selected[right].name, distance });
      if (distance <= 3) throw new Error(`서로 다른 장면이 필요합니다. ${selected[left].name}와 ${selected[right].name}의 지각 지문 거리가 ${distance}로 너무 가깝습니다.`);
    }
  }
  const motionRequired = clipMotionGateRequired(provider);
  const motionFailures = selected.filter((entry) => !entry.motion.passed).map((entry) => ({ name: entry.name, blockers: entry.motion.blockers }));
  if (motionRequired && motionFailures.length) {
    const detail = motionFailures.map((entry) => `${entry.name}: ${entry.blockers.join(" ")}`).join(" | ");
    throw new Error(`승인 provider 클립 동작 품질 gate를 통과하지 못했습니다. ${detail}`);
  }
  const manifest = {
    schemaVersion: 3,
    runId,
    jobId,
    capturedAt: new Date().toISOString(),
    diversityGate: { exactSha256Unique: true, perceptualAlgorithm: "temporal-ahash-8x8-v1", minimumDistanceExclusive: 3, comparisons: perceptualComparisons },
    motionGate: {
      schemaVersion: 1,
      algorithm: CLIP_MOTION_POLICY.algorithm,
      provider,
      approvedProvider: motionRequired,
      enforced: motionRequired,
      observedPass: motionFailures.length === 0,
      enforcementPass: !motionRequired || motionFailures.length === 0,
      policy: clipMotionGatePolicy(),
      policyHash: hashJson(CLIP_MOTION_POLICY),
      failures: motionFailures
    },
    entries: selected.map(({ absolutePath: _absolutePath, ...entry }) => entry)
  };
  const manifestPath = join(runDir, "input-manifest.json");
  await writeJsonAtomic(manifestPath, manifest);
  return {
    manifest,
    selected,
    path: manifestPath,
    receipt: {
      path: `runs/${runId}/input-manifest.json`,
      sha256: await hashFile(manifestPath),
      entryCount: manifest.entries.length
    }
  };
}
async function snapshotRunArtifacts(jobDir, runDir, jobId, runId, artifacts) {
  const snapshotRoot = join(runDir, "artifacts");
  await mkdir(snapshotRoot, { recursive: true });
  const snapshots = [];
  for (const artifact of artifacts) {
    const source = join(jobDir, artifact.name);
    const sourceStat = await stat(source).catch(() => null);
    if (!sourceStat?.isFile()) throw new Error(`불변 증거 산출물이 없습니다: ${artifact.name}`);
    const sourceSha256 = await hashFile(source);
    if (artifact.sha256 && artifact.sha256 !== sourceSha256) throw new Error(`증거 산출물 해시가 영수증과 다릅니다: ${artifact.name}`);
    const snapshotName = artifact.name.replace(/[^A-Za-z0-9._-]+/g, "__");
    const snapshotPath = `runs/${runId}/artifacts/${snapshotName}`;
    const target = join(jobDir, snapshotPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const targetStat = await stat(target);
    const targetSha256 = await hashFile(target);
    if (targetSha256 !== sourceSha256) throw new Error(`불변 증거 복사본 해시가 원본과 다릅니다: ${artifact.name}`);
    snapshots.push({
      ...artifact,
      url: mediaPath(jobId, snapshotPath),
      path: snapshotPath,
      bytes: targetStat.size,
      sha256: targetSha256
    });
  }
  return snapshots;
}
async function snapshotBenchmarkFiles(runDir, runId) {
  const snapshotRoot = join(runDir, "benchmarks");
  await mkdir(snapshotRoot, { recursive: true });
  const specs = [
    { key: "channel", source: ANALYSIS_PATH, name: "channel-analysis.json" },
    { key: "duration", source: join(DATA_DIR, "shorts-metadata.json"), name: "shorts-metadata.json" },
    { key: "rlm", source: join(DATA_DIR, "rlm-benchmark-analysis.json"), name: "rlm-benchmark-analysis.json" }
  ];
  const snapshots = {};
  for (const spec of specs) {
    const target = join(snapshotRoot, spec.name);
    const relativePath = `runs/${runId}/benchmarks/${spec.name}`;
    try {
      const payload = JSON.parse(await readFile(spec.source, "utf8"));
      await copyFile(spec.source, target);
      const meta = spec.key === "channel"
        ? { expectedVideos: payload.snapshot?.totalVideos ?? payload.provenance?.completeness?.expectedVideos ?? null, shortsCount: payload.snapshot?.shorts ?? null, longVideosCount: payload.snapshot?.longVideos ?? null, sourceSnapshotAt: payload.snapshot?.capturedAt ?? null, population: "channel-all-videos" }
        : spec.key === "duration"
          ? { shortsCount: payload.snapshotVideoCount ?? payload.metadataCount ?? null, sourceSnapshotAt: payload.sourceSnapshotAt ?? null }
          : { shortsCount: payload.reduction?.inputCount ?? payload.sourceSnapshot?.shortsCount ?? null, sampleCount: payload.mediaEvidence?.sampleCount ?? 0, analyzedAt: payload.analyzedAt ?? null };
      snapshots[spec.key] = { ...meta, path: relativePath, sha256: await hashFile(target) };
    } catch {
      snapshots[spec.key] = { path: relativePath, sha256: null, missing: true };
    }
  }
  if (Object.values(snapshots).some((snapshot) => snapshot.missing)) throw new Error("벤치마크 스냅샷 파일이 없습니다. bun run benchmark:refresh를 먼저 실행하세요.");
  const populationCounts = [snapshots.channel.shortsCount, snapshots.duration.shortsCount, snapshots.rlm.shortsCount];
  if (populationCounts.some((count) => !Number.isInteger(count) || count <= 0) || new Set(populationCounts).size !== 1) {
    throw new Error(`벤치마크 세대가 일치하지 않습니다: channel/duration/RLM Shorts=${populationCounts.join("/")}`);
  }
  if (!snapshots.channel.expectedVideos || snapshots.channel.expectedVideos !== snapshots.channel.shortsCount + snapshots.channel.longVideosCount) {
    throw new Error("채널 벤치마크의 전체·Shorts·롱폼 개수가 일치하지 않습니다.");
  }
  if (snapshots.channel.sourceSnapshotAt !== snapshots.duration.sourceSnapshotAt) throw new Error("채널 분석과 길이 분석의 원본 캡처 시각이 다릅니다.");
  return {
    path: snapshots.channel.path,
    sha256: snapshots.channel.sha256,
    expectedVideos: snapshots.channel.expectedVideos,
    population: snapshots.channel.population,
    durationMetadata: snapshots.duration,
    rlmMediaEvidence: snapshots.rlm
  };
}

async function bindQualityInputManifest(jobDir, receipt) {
  const qualityPaths = [
    join(jobDir, "quality.json"),
    join(jobDir, "quality", "latest.json"),
    join(jobDir, "quality", "iteration-01.json")
  ];
  for (const path of qualityPaths) {
    if (!existsSync(path)) continue;
    const quality = JSON.parse(await readFile(path, "utf8"));
    quality.inputManifest = receipt;
    quality.metrics = { ...(quality.metrics || {}), inputManifest: receipt };
    await writeJsonAtomic(path, quality);
  }
}

async function normalizeClip(input, output, format, targetDuration = null) {
  const size = format === "landscape" ? "1920:1080" : "1080:1920";
  const sourceDuration = await probeDuration(input);
  const duration = Number.isFinite(Number(targetDuration)) && Number(targetDuration) > 0 ? Number(targetDuration) : sourceDuration;
  const hasAudio = await probeHasAudio(input);
  const videoRate = duration / sourceDuration;
  const framing = format === "landscape" ? `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black` : `scale=${size}:force_original_aspect_ratio=increase,crop=${size}:(iw-ow)/2:(ih-oh)/2`;
  const vf = `${framing},setsar=1${Math.abs(videoRate - 1) > 0.001 ? `,setpts=${videoRate.toFixed(6)}*PTS` : ""},fps=30`;
  const args = ["-y", "-i", input];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-t", String(duration), "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2");
  if (hasAudio && Math.abs(videoRate - 1) > 0.001) args.push("-af", atempoChain(1 / videoRate));
  if (!hasAudio) args.push("-map", "0:v:0", "-map", "1:a:0");
  args.push("-shortest", output);
  await runCommand("ffmpeg", args);
  return duration;
}

async function renderCaptions(input, output, captionsPath, format) {
  const size = format === "landscape" ? "1920:1080" : "1080:1920";
  const escaped = captionsPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  const fontSize = format === "landscape" ? 18 : 20;
  const margin = format === "landscape" ? 56 : 140;
  const style = `FontName=Apple SD Gothic Neo,Bold=1,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${margin},WrapStyle=2,ScaledBorderAndShadow=yes`;
  await runCommand("ffmpeg", ["-y", "-i", input, "-vf", `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black,subtitles=filename='${escaped}':force_style='${style}'`, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "copy", output]);
}

export function voiceoverAudioMixPolicy(targetDuration) {
  const target = Number(targetDuration);
  if (!Number.isFinite(target) || target <= 0) throw new Error("음성 믹스 목표 영상 길이가 올바르지 않습니다.");
  const duration = target.toFixed(3);
  const sourceGain = 0.22;
  const voiceGain = 1;
  const processingTailPadSec = 1;
  const filterComplex = [
    `[0:a:0]aresample=48000:async=0:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${sourceGain.toFixed(6)},apad=pad_dur=${processingTailPadSec.toFixed(3)}[ambient]`,
    `[1:a:0]aresample=48000:async=0:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${voiceGain.toFixed(6)},apad=pad_dur=${processingTailPadSec.toFixed(3)},asplit=2[voice-sidechain][voice-mix]`,
    "[ambient][voice-sidechain]sidechaincompress=threshold=0.040000:ratio=8.000000:attack=12.000000:release=320.000000:makeup=1.000000:knee=2.500000:link=average:detection=rms:mix=1.000000[ambient-ducked]",
    `[ambient-ducked][voice-mix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.950000:attack=5.000000:release=50.000000:level=false:latency=true,atrim=start=0:end=${duration},asetpts=N/SR/TB[mixed]`
  ].join(";");
  return {
    version: "ffmpeg-sidechain-ambient/v1",
    sourceAudioMode: "preserved-low-level-sidechain-ducked",
    sourceAudio: {
      input: "0:a:0",
      role: "provider-native-ambient",
      gainLinear: sourceGain,
      gainDb: -13.152
    },
    voiceAudio: {
      input: "1:a:0",
      role: "macos-say-narration",
      gainLinear: voiceGain,
      gainDb: 0
    },
    ducking: {
      filter: "sidechaincompress",
      thresholdLinear: 0.04,
      ratio: 8,
      attackMs: 12,
      releaseMs: 320,
      makeupGain: 1,
      knee: 2.5,
      link: "average",
      detection: "rms",
      wetMix: 1
    },
    summing: {
      filter: "amix",
      inputs: 2,
      duration: "first",
      dropoutTransitionSec: 0,
      normalize: false
    },
    limiter: {
      filter: "alimiter",
      limitLinear: 0.95,
      attackMs: 5,
      releaseMs: 50,
      autoLevel: false,
      compensateLatency: true
    },
    output: {
      streamCount: 1,
      codec: "aac",
      bitrateKbps: 192,
      sampleRateHz: 48000,
      channels: 2,
      durationSec: Number(duration),
      processingTailPadSec
    },
    filterComplex
  };
}

export function voiceoverMixFfmpegArgs(input, voice, output, targetDuration) {
  const policy = voiceoverAudioMixPolicy(targetDuration);
  return [
    "-y", "-i", input, "-i", voice,
    "-filter_complex", policy.filterComplex,
    "-map", "0:v:0", "-map", "[mixed]",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-t", policy.output.durationSec.toFixed(3),
    "-c:v", "copy", "-c:a", policy.output.codec,
    "-b:a", `${policy.output.bitrateKbps}k`,
    "-ar", String(policy.output.sampleRateHz), "-ac", String(policy.output.channels),
    "-movflags", "+faststart", output
  ];
}

async function addVoiceover(input, output, script, warnings, targetDuration) {
  if (!hasCommand("say")) throw new Error("macOS say 명령이 없어 음성 합성을 수행할 수 없습니다.");
  const target = Number(targetDuration);
  if (!Number.isFinite(target) || target <= 0) throw new Error("음성 합성 목표 영상 길이가 올바르지 않습니다.");
  const configuredRate = Number(process.env.PS4_SAY_RATE || DEFAULT_SAY_RATE);
  const sayRate = Number.isFinite(configuredRate) ? Math.max(120, Math.min(220, Math.round(configuredRate))) : DEFAULT_SAY_RATE;
  const configuredVoice = String(process.env.PS4_SAY_VOICE || "").trim();
  const jobDir = dirname(output);
  const voicePath = join(jobDir, "voiceover.aiff");
  const concatPath = join(jobDir, "voiceover-concat.txt");
  const sourceSegments = Array.isArray(script?.segments) && script.segments.length
    ? script.segments
    : [{ narration: script?.narration || script?.hook || "" }];
  const voiceScript = { ...script, segments: sourceSegments };
  const windows = segmentWindowsForDuration(voiceScript, target);
  if (!windows.length) throw new Error("음성 합성에 사용할 장면 내레이션이 없습니다.");
  const audioPaths = [];
  const segmentSync = [];
  try {
    for (const { segment, index, start, end, durationSec } of windows) {
      const text = String(segment.narration || segment.caption || "").replace(/\s+/g, " ").trim();
      if (!text) throw new Error(`${index + 1}번 장면의 내레이션이 비어 있습니다.`);
      const rawPath = join(jobDir, `voiceover-${String(index + 1).padStart(2, "0")}.aiff`);
      const calibratedPath = join(jobDir, `voiceover-${String(index + 1).padStart(2, "0")}-calibrated.aiff`);
      const paddedPath = join(jobDir, `voiceover-${String(index + 1).padStart(2, "0")}-padded.aiff`);
      await runCommand("say", [
        ...(configuredVoice ? ["-v", configuredVoice] : []),
        "-r", String(sayRate),
        "-o", rawPath,
        text
      ]);
      const sourceDurationSec = await probeDuration(rawPath);
      if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) throw new Error(`${index + 1}번 장면 음성 길이를 확인할 수 없습니다.`);
      const atempoRate = sourceDurationSec > durationSec + 0.02 ? sourceDurationSec / Math.max(0.1, durationSec) : 1;
      let audioPath = rawPath;
      if (atempoRate > 1.001) {
        await runCommand("ffmpeg", ["-y", "-i", rawPath, "-filter:a", atempoChain(atempoRate), "-c:a", "pcm_s16le", calibratedPath]);
        audioPath = calibratedPath;
      }
      const calibratedDurationSec = await probeDuration(audioPath);
      if (!Number.isFinite(calibratedDurationSec) || calibratedDurationSec > durationSec + 0.15) {
        throw new Error(`${index + 1}번 장면 음성을 목표 구간에 맞추지 못했습니다.`);
      }
      const captionDurationSec = Math.min(durationSec, calibratedDurationSec);
      const padDurationSec = Math.max(0, durationSec - calibratedDurationSec);
      await runCommand("ffmpeg", [
        "-y", "-i", audioPath,
        "-af", `apad=pad_dur=${padDurationSec.toFixed(3)},atrim=duration=${durationSec.toFixed(3)},asetpts=N/SR/TB`,
        "-c:a", "pcm_s16le", paddedPath
      ]);
      const paddedDurationSec = await probeDuration(paddedPath);
      if (Math.abs(paddedDurationSec - durationSec) > 0.15) {
        throw new Error(`${index + 1}번 장면 음성 패딩 길이가 영상 구간과 다릅니다.`);
      }
      if (atempoRate > 1.15) {
        warnings.push(`${index + 1}번 장면 음성은 목표 길이에 맞추기 위해 ${atempoRate.toFixed(2)}배 빠르게 보정했습니다.`);
      }
      audioPaths.push(paddedPath);
      segmentSync.push({
        index: index + 1,
        startSec: Number(start.toFixed(3)),
        endSec: Number(end.toFixed(3)),
        targetDurationSec: Number(durationSec.toFixed(3)),
        sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
        calibratedDurationSec: Number(calibratedDurationSec.toFixed(3)),
        captionDurationSec: Number(captionDurationSec.toFixed(3)),
        silenceTailSec: Number(Math.max(0, durationSec - captionDurationSec).toFixed(3)),
        atempoRate: Number(atempoRate.toFixed(6)),
        text
      });
    }
    await writeFile(concatPath, audioPaths.map((path) => `file '${path.replaceAll("'", "'\\\\''")}'`).join("\n"));
    await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c:a", "pcm_s16le", voicePath]);
    const masteredVoicePath = join(jobDir, "voiceover-mastered.wav");
    await runCommand("ffmpeg", [
      "-y", "-i", voicePath,
      "-af", "loudnorm=I=-14:LRA=3.5:TP=-1.0:linear=false",
      "-c:a", "pcm_s16le", masteredVoicePath
    ]);
    const voiceoverDurationSec = await probeDuration(masteredVoicePath);
    const audioMixPolicy = voiceoverAudioMixPolicy(target);
    await runCommand("ffmpeg", voiceoverMixFfmpegArgs(input, masteredVoicePath, output, target));
    const sync = {
      schemaVersion: 2,
      source: "macOS say",
      alignment: "segment-duration-calibrated",
      estimated: true,
      voiceStyle: "documentary-ko-neutral",
      voiceSelection: configuredVoice || "system-default-korean",
      sayRate,
      loudnessTarget: { integratedLufs: -14, loudnessRangeLu: 3.5, truePeakDbfs: -1 },
      targetDurationSec: Number(target.toFixed(3)),
      voiceoverDurationSec: Number(voiceoverDurationSec.toFixed(3)),
      sourceAudioMode: audioMixPolicy.sourceAudioMode,
      sourceAudioGain: audioMixPolicy.sourceAudio.gainLinear,
      sourceAudioGainDb: audioMixPolicy.sourceAudio.gainDb,
      voiceAudioGain: audioMixPolicy.voiceAudio.gainLinear,
      voiceAudioGainDb: audioMixPolicy.voiceAudio.gainDb,
      audioMixPolicy,
      segments: segmentSync
    };
    await writeJsonAtomic(join(jobDir, "voiceover-sync.json"), sync);
    return { path: output, sync };
  } catch (error) {
    throw new Error(`음성 합성 실패: ${error.message}`);
  }
}

export async function renderJob(job, script, onProgress = async () => {}, inputManifest = null) {
  const jobDir = join(JOBS_DIR, job.id);
  const normalizedDir = join(jobDir, "normalized");
  const existingNormalized = (await readdir(normalizedDir).catch(() => [])).filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()));
  await Promise.all(existingNormalized.map((name) => unlink(join(normalizedDir, name)).catch(() => {})));
  const selected = Array.isArray(inputManifest?.selected)
    ? inputManifest.selected
    : Array.isArray(inputManifest?.entries)
      ? inputManifest.entries.map((entry) => ({ ...entry, absolutePath: inputClipPath(jobDir, entry.name) }))
      : null;
  const hasManifestSelection = Array.isArray(inputManifest?.selected) || Array.isArray(inputManifest?.entries);
  const selectedEntries = hasManifestSelection
    ? (selected || [])
    : (await readdir(join(jobDir, "clips"))).filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase())).sort().map((name) => ({ name, absolutePath: inputClipPath(jobDir, name) }));
  if (!selectedEntries.length) throw new Error("렌더링할 영상 클립이 없습니다. Gemini 생성 또는 클립 업로드를 먼저 완료하세요.");
  if (!hasCommand("ffmpeg") || !hasCommand("ffprobe")) throw new Error("ffmpeg와 ffprobe가 필요합니다. macOS에서는 `brew install ffmpeg`로 설치하세요.");

  const names = selectedEntries.map((entry) => entry.name);
  for (const entry of selectedEntries) {
    const fileStat = await stat(entry.absolutePath);
    if (entry.bytes != null && fileStat.size !== entry.bytes) throw new Error(`렌더 입력 크기가 manifest와 다릅니다: ${entry.name}`);
    if (entry.sha256 && await hashFile(entry.absolutePath) !== entry.sha256) throw new Error(`렌더 입력 해시가 manifest와 다릅니다: ${entry.name}`);
  }
  await onProgress(58, "편집", `${names.length}개 클립의 화면비·프레임·오디오를 통일하는 중입니다.`);
  const normalized = [];
  let totalDuration = 0;
  const hintedTotalDuration = (script?.segments || []).reduce((sum, segment) => {
    const value = Number(segment.durationHint);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const requestedDuration = Number(job.targetDurationSec);
  const renderDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? requestedDuration
    : hintedTotalDuration > 0
      ? hintedTotalDuration
      : names.length;
  const targetWindows = segmentWindowsForDuration(script, renderDuration);
  for (let index = 0; index < names.length; index += 1) {
    const input = selectedEntries[index].absolutePath;
    const output = join(normalizedDir, `${String(index + 1).padStart(2, "0")}.mp4`);
    const targetDuration = targetWindows[index]?.durationSec || renderDuration / names.length;
    const duration = await normalizeClip(input, output, job.format, targetDuration);
    normalized.push(output);
    totalDuration += duration;
    await onProgress(58 + Math.round(((index + 1) / names.length) * 12), "편집", `${index + 1}/${names.length}개 클립 정리 완료`);
  }

  const listPath = join(jobDir, "concat.txt");
  await writeFile(listPath, normalized.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const assembled = join(jobDir, "assembled.mp4");
  await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", assembled]);
  totalDuration = await probeDuration(assembled);

  const warnings = [...(job.warnings || [])];
  let audioVideo = assembled;
  let voiceoverSync = null;
  if (job.voiceover) {
    await onProgress(73, "내레이션", "로컬 음성 합성을 추가하는 중입니다.");
    const voiced = join(jobDir, "voiced.mp4");
    const voiceoverResult = await addVoiceover(assembled, voiced, script, warnings, totalDuration);
    audioVideo = voiceoverResult.path;
    voiceoverSync = voiceoverResult.sync;
  }

  const captionsPath = join(jobDir, "captions.srt");
  const captionsVttPath = join(jobDir, "captions.vtt");
  const captionTimingPath = join(jobDir, "caption-timing.json");
  await writeFile(captionsPath, job.captions ? captionsForDuration(script, totalDuration, voiceoverSync) : "");
  await writeFile(captionsVttPath, job.captions ? captionsVttForDuration(script, totalDuration, voiceoverSync) : "");
  await writeJsonAtomic(captionTimingPath, captionTimingForDuration(script, totalDuration, voiceoverSync));
  const finalPath = join(jobDir, "final.mp4");
  if (job.captions) {
    await onProgress(82, "자막", "내레이션 흐름에 맞춰 자막을 번인하는 중입니다.");
    await renderCaptions(audioVideo, finalPath, captionsPath, job.format);
  } else {
    await runCommand("ffmpeg", ["-y", "-i", audioVideo, "-c", "copy", finalPath]);
  }
  const finalDuration = await probeDuration(finalPath);

  const thumbnailPath = join(jobDir, "thumbnail.jpg");
  await runCommand("ffmpeg", ["-y", "-ss", "00:00:01", "-i", finalPath, "-frames:v", "1", "-q:v", "2", thumbnailPath]);
  await onProgress(96, "검수", "최종 파일과 미리보기 이미지를 확인하는 중입니다.");
  return {
    warnings,
    artifacts: [
      { name: "final.mp4", kind: "video", url: mediaPath(job.id, "final.mp4") },
      { name: "captions.srt", kind: "captions", url: mediaPath(job.id, "captions.srt") },
      { name: "captions.vtt", kind: "caption-timing-estimate", url: mediaPath(job.id, "captions.vtt") },
      { name: "caption-timing.json", kind: "caption-timing", url: mediaPath(job.id, "caption-timing.json") },
      ...(job.voiceover ? [{ name: "voiceover-sync.json", kind: "voiceover-caption-sync", url: mediaPath(job.id, "voiceover-sync.json") }] : []),
      { name: "script.json", kind: "script", url: mediaPath(job.id, "script.json") },
      { name: "thumbnail.jpg", kind: "thumbnail", url: mediaPath(job.id, "thumbnail.jpg") }
    ],
    duration: finalDuration
  };
}
const MUTABLE_OUTPUTS = [
  "final.mp4", "assembled.mp4", "voiced.mp4", "voiceover.aiff", "voiceover-mastered.wav", "voiceover-concat.txt", "concat.txt",
  "captions.srt", "captions.vtt", "caption-timing.json", "voiceover-sync.json", "script.json",
  "sources.json", "frame-audio-caption.json", "thumbnail.jpg", "quality.json",
  "committee-review.json"
];
function providerPolicy(provider) {
  if (provider === "gemini-browser") return "no-local-video-fallback";
  if (provider === "local-video") return "local-video-command-adapter-no-fallback";
  return "local-upload-edit";
}
async function clearMutableOutputs(jobDir, preserveGemini = false, clearLocalVideoClips = false) {
  const names = preserveGemini ? MUTABLE_OUTPUTS : [...MUTABLE_OUTPUTS, "gemini-generation.json"];
  const voiceoverParts = (await readdir(jobDir).catch(() => [])).filter((name) => /^voiceover-\d{2}(?:-calibrated|-padded)?\.aiff$/.test(name));
  await Promise.all([...names, ...voiceoverParts].map((name) => unlink(join(jobDir, name)).catch(() => {})));
  if (clearLocalVideoClips) {
    const clips = await readdir(join(jobDir, "clips"), { withFileTypes: true }).catch(() => []);
    await Promise.all(clips.filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => unlink(join(jobDir, "clips", entry.name)).catch(() => {})));
  }
  await rm(join(jobDir, "quality"), { recursive: true, force: true });
  await rm(join(jobDir, "normalized"), { recursive: true, force: true });
  await mkdir(join(jobDir, "normalized"), { recursive: true });
}

export async function runJob(jobId, options = {}) {
  let job = await readJob(jobId);
  const jobDir = join(JOBS_DIR, jobId);
  const previousRunEntries = await readdir(join(jobDir, "runs"), { withFileTypes: true }).catch(() => []);
  const previousRunIds = previousRunEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const attempt = previousRunIds.length + 1;
  const parentRunId = job.runId || null;
  const trigger = options.trigger || "manual";
  const reason = options.reason || (parentRunId ? "rerun" : "initial");
  const providerDecision = {
    requested: job.provider,
    selected: job.provider,
    fallbackUsed: false,
    policy: providerPolicy(job.provider)
  };
  const providerDecisionHash = hashJson(providerDecision);
  const geminiSessionBinding = job.provider === "gemini-browser" ? canonicalGeminiSessionBinding(job) : null;
  const geminiSessionBindingDigest = job.provider === "gemini-browser" ? geminiSessionBindingHash(job) : null;
  if (job.provider === "gemini-browser" && (!geminiSessionBinding || !geminiSessionBindingDigest)) throw new Error("Gemini 실행 세션을 안전하게 결속할 수 없습니다.");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(jobDir, "runs", runId);
  const ledgerErrors = [];
  let runManifest = {
    schemaVersion: 1,
    runId,
    jobId,
    attempt,
    parentRunId,
    trigger,
    reason,
    startedAt: new Date().toISOString(),
    status: "running",
    benchmarkSnapshot: null,
    request: {
      topic: job.topic,
      provider: job.provider,
      format: job.format,
      clipCount: job.clipCount,
      targetDurationSec: job.targetDurationSec,
      targetDurationRangeSec: job.targetDurationRangeSec,
      captions: job.captions,
      voiceover: job.voiceover,
      fallbackPolicy: providerPolicy(job.provider),
      ...(geminiSessionBinding ? { geminiSessionBinding, geminiSessionBindingHash: geminiSessionBindingDigest } : {})
    },
    providerDecision,
    providerDecisionHash,
    eventsPath: `runs/${runId}/events.jsonl`,
    inputManifest: null
  };
  const record = async (event) => {
    try {
      await appendRunEvent(runDir, event);
    } catch (error) {
      ledgerErrors.push(error.message);
      console.error(`run ledger write failed: ${error.message}`);
    }
  };
  try {
    await mkdir(runDir, { recursive: true });
    if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
    await clearMutableOutputs(jobDir, job.provider === "gemini-browser", job.provider === "local-video");
    await writeRunManifest(runDir, runManifest);
    job = await updateJob(jobId, {
      status: "running",
      stage: "준비",
      progress: 1,
      message: "실행 증거와 벤치마크를 준비하는 중입니다.",
      runId,
      runStatus: "running",
      runStartedAt: runManifest.startedAt,
      artifacts: [],
      qualitySummary: null,
      duration: null,
      error: null
    });
    const benchmarkSnapshot = await snapshotBenchmarkFiles(runDir, runId);
    runManifest = { ...runManifest, benchmarkSnapshot };
    await writeRunManifest(runDir, runManifest);
  } catch (error) {
    await record({ type: "failed", phase: "initialization", error: error.message, stack: error.stack || null });
    const eventLog = { path: `runs/${runId}/events.jsonl`, sha256: await hashFile(join(runDir, "events.jsonl")).catch(() => null) };
    runManifest = { ...runManifest, completedAt: new Date().toISOString(), status: "failed", runStatus: "failed", error: error.message, eventLog, ledgerErrors: [...ledgerErrors] };
    try {
      await writeRunManifest(runDir, runManifest);
    } catch (manifestError) {
      ledgerErrors.push(manifestError.message);
      console.error(`initialization failure manifest write failed: ${manifestError.message}`);
    }
    job = await updateJob(jobId, {
      status: "failed",
      stage: "오류",
      progress: job.progress || 0,
      message: `실행 준비 실패: ${error.message}`,
      error: error.stack || error.toString(),
      warnings: [...(job.warnings || []), ...ledgerErrors.map((entry) => `실행 기록 저장 실패: ${entry}`)],
      runId,
      runStatus: "failed",
      artifacts: [],
      qualitySummary: null,
      duration: null
    });
    if (options.onProgress) await options.onProgress(job);
    return job;
  }

  let inputManifest = null;
  let localVideoGeneration = null;
  const captureRunInputs = async (requestedNames = null, expectedCount = job.clipCount) => {
    if (inputManifest) return inputManifest;
    inputManifest = await createInputManifest(jobDir, runDir, jobId, runId, requestedNames, expectedCount, job.provider);
    runManifest = { ...runManifest, inputManifest: inputManifest.receipt };
    await writeRunManifest(runDir, runManifest);
    await record({ type: "inputs_captured", inputManifest: inputManifest.receipt, entries: inputManifest.manifest.entries });
    return inputManifest;
  };
  const progress = async (value, stage, message, extra = {}) => {
    job = await updateJob(jobId, { progress: value, stage, message, ...extra, runId });
    await record({ type: "stage", stage, progress: value, message });
    if (options.onProgress) await options.onProgress(job);
  };
  try {
    job = await updateJob(jobId, {
      status: "running",
      stage: "기획",
      progress: 4,
      message: "주제에서 영상 구조를 설계하는 중입니다.",
      runId,
      runStatus: "running",
      runStartedAt: runManifest.startedAt
    });
    await record({ type: "started", topic: job.topic, provider: job.provider });
    await record({ type: "provider_decision", jobId, runId, ...providerDecision, decisionHash: providerDecisionHash });
    if (job.provider === "local") await captureRunInputs();

    if (job.provider === "gemini-browser") {
      const previousGeneration = existsSync(join(jobDir, "gemini-generation.json")) ? JSON.parse(await readFile(join(jobDir, "gemini-generation.json"), "utf8")) : null;
      const preservePartial = previousGeneration?.status === "failed" && Array.isArray(previousGeneration.segments) && previousGeneration.segments.length > 0;
      if (!preservePartial) {
        const existing = await readdir(join(jobDir, "clips"), { withFileTypes: true }).catch(() => []);
        for (const entry of existing) {
          if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) await unlink(join(jobDir, "clips", entry.name)).catch(() => {});
        }
      }
    }
    const sourceBundle = await captureSources(job);
    await writeJsonAtomic(join(jobDir, "sources.json"), { jobId, runId, ...sourceBundle });
    job = await updateJob(jobId, { sources: sourceBundle.records, sourceBundle: { status: sourceBundle.status, fetchedCount: sourceBundle.fetchedCount, totalCount: sourceBundle.totalCount, evidenceCount: sourceBundle.evidenceCount || 0 } });
    await record({ type: "sources_captured", status: sourceBundle.status, fetchedCount: sourceBundle.fetchedCount, totalCount: sourceBundle.totalCount, evidenceCount: sourceBundle.evidenceCount || 0 });

    const script = await buildScript(job);
    await writeJsonAtomic(join(jobDir, "script.json"), script);
    await progress(18, "기획", `${script.generatedBy === "gemini-api" ? "Gemini" : "로컬 템플릿"} 대본과 ${script.segments.length}개 장면을 준비했습니다.`);

    if (job.provider === "gemini-browser") {
      await progress(24, "Gemini 영상", "Chrome의 Gemini 동영상 만들기 화면을 제어하는 중입니다.");
      const generation = await generateGeminiClips(job, script, async (value, message) => progress(24 + Math.round(value * 0.30), "Gemini 영상", message));
      if (!generation || generation.status !== "completed" || generation.runId !== runId || !generation.requestHash || !generation.scriptHash) {
        throw new Error("Gemini generation provenance가 현재 runId·요청 해시에 결속되지 않았습니다.");
      }
      await captureRunInputs(script.segments.map((_, index) => `${String(index + 1).padStart(2, "0")}.mp4`), script.segments.length);
    } else if (job.provider === "local-video") {
      await progress(24, "로컬 영상 생성", "설정된 local-video 생성기에서 장면을 생성하는 중입니다.");
      localVideoGeneration = await generateLocalVideoClips(job, script, runId, async (value, message) => progress(24 + Math.round(value * 0.30), "로컬 영상 생성", message));
      const providerReceipt = {
        ...localVideoGeneration.receipt,
        provider: "local-video",
        model: localVideoGeneration.model,
        modelVersion: localVideoGeneration.modelVersion,
        modelId: localVideoGeneration.modelId,
        requestHash: localVideoGeneration.requestHash,
        scriptHash: localVideoGeneration.scriptHash
      };
      await record({
        type: "provider_generation",
        provider: "local-video",
        jobId,
        runId,
        model: localVideoGeneration.model,
        modelVersion: localVideoGeneration.modelVersion,
        modelId: localVideoGeneration.modelId,
        receipt: providerReceipt,
        artifact: { name: `runs/${runId}/local-video-generation.json`, path: `runs/${runId}/local-video-generation.json`, sha256: providerReceipt.sha256 }
      });
      runManifest = {
        ...runManifest,
        providerReceipt,
        providerArtifact: { name: `runs/${runId}/local-video-generation.json`, path: `runs/${runId}/local-video-generation.json`, sha256: providerReceipt.sha256 }
      };
      await writeRunManifest(runDir, runManifest);
      await captureRunInputs(localVideoGeneration.outputNames.map((name) => name.replace(/^clips\//, "")), script.segments.length);
    } else {
      await progress(54, "소스 확인", "업로드된 로컬 클립을 사용합니다.");
    }

    const rendered = await renderJob(job, script, progress, inputManifest);
    job = await updateJob(jobId, {
      status: "verifying",
      stage: "검수",
      progress: 96,
      message: "최종 파일을 만들었습니다. AHP 품질 검사를 실행하는 중입니다.",
      warnings: rendered.warnings,
      artifacts: rendered.artifacts,
      duration: rendered.duration,
      scriptGeneratedBy: script.generatedBy,
      runId,
      runStatus: "verifying"
    });

    let qualitySummary = null;
    let qualityWarnings = [];
    let qualityEvidenceNames = [];
    try {
      const { evaluateJob } = await import("./quality.mjs");
      const quality = await evaluateJob(jobId, { iteration: 1, runId });
      quality.inputManifest = inputManifest.receipt;
      quality.metrics = { ...(quality.metrics || {}), inputManifest: inputManifest.receipt };
      qualityEvidenceNames = Object.keys(quality.metrics?.evidenceHashes || {});
      await bindQualityInputManifest(jobDir, inputManifest.receipt);
      qualitySummary = {
        status: quality.status,
        totalScore: quality.totalScore,
        threshold: quality.threshold,
        technicalEvidenceGate: quality.technicalEvidenceGate,
        semanticGate: quality.semanticGate,
        runId: quality.runId,
        blockers: quality.blockers,
        inputManifest: inputManifest.receipt
      };
      await progress(98, "검수", quality.technicalEvidenceGate ? `기술 증거 검사 ${quality.totalScore}점 · 콘텐츠 판정 보류` : `기술 증거 검사 ${quality.totalScore}점 · 개선 필요`, { qualitySummary });
    } catch (qualityError) {
      await record({ type: "quality_failed", error: qualityError.message });
      throw new Error(`AHP 품질 검사 실패: ${qualityError.message}`);
    }

    const artifacts = [
      ...rendered.artifacts,
      { name: "quality.json", kind: "quality", url: mediaPath(job.id, "quality.json") },
      { name: "frame-audio-caption.json", kind: "analysis", url: mediaPath(job.id, "frame-audio-caption.json") },
      { name: "sources.json", kind: "source-bundle", url: mediaPath(job.id, "sources.json") },
      ...(existsSync(join(jobDir, "gemini-generation.json")) ? [{ name: "gemini-generation.json", kind: "provider-provenance", url: mediaPath(job.id, "gemini-generation.json") }] : []),
      ...(localVideoGeneration ? [{ name: `runs/${runId}/local-video-generation.json`, kind: "provider-provenance", url: mediaPath(job.id, `runs/${runId}/local-video-generation.json`) }] : []),
      { name: `runs/${runId}/events.jsonl`, kind: "run-events", url: mediaPath(job.id, `runs/${runId}/events.jsonl`) },
      { name: `runs/${runId}/input-manifest.json`, kind: "input-manifest", url: mediaPath(job.id, `runs/${runId}/input-manifest.json`) },
      { name: `runs/${runId}/benchmarks/channel-analysis.json`, kind: "benchmark-snapshot", url: mediaPath(job.id, `runs/${runId}/benchmarks/channel-analysis.json`) },
      { name: `runs/${runId}/benchmarks/shorts-metadata.json`, kind: "benchmark-snapshot", url: mediaPath(job.id, `runs/${runId}/benchmarks/shorts-metadata.json`) },
      { name: `runs/${runId}/benchmarks/rlm-benchmark-analysis.json`, kind: "benchmark-snapshot", url: mediaPath(job.id, `runs/${runId}/benchmarks/rlm-benchmark-analysis.json`) }
    ];
    const evidenceArtifacts = qualityEvidenceNames
      .filter((name) => !artifacts.some((artifact) => artifact.name === name))
      .map((name) => ({ name, kind: "evidence", url: mediaPath(job.id, name) }));
    let snapshotArtifacts = [...artifacts, ...evidenceArtifacts];
    const sourceEntries = inputManifest.manifest.entries;
    const runStatus = qualitySummary?.status === "passed" ? "verified" : "needs-improvement";
    runManifest = {
      ...runManifest,
      status: "finalizing",
      runStatus,
      script: { generatedBy: script.generatedBy, segmentCount: script.segments.length, targetDurationSec: job.targetDurationSec, sourceBundle: job.sourceBundle || { status: "missing" }, providerProvenance: localVideoGeneration ? `runs/${runId}/local-video-generation.json` : existsSync(join(jobDir, "gemini-generation.json")) ? "gemini-generation.json" : null },
      inputs: sourceEntries,
      artifacts: await artifactReceipt(jobDir, snapshotArtifacts),
      qualitySummary,
      ledgerErrors: [...ledgerErrors]
    };
    await writeRunManifest(runDir, runManifest);
    await record({ type: "snapshot_started", artifactCount: snapshotArtifacts.length });
    let immutableArtifacts = await snapshotRunArtifacts(jobDir, runDir, job.id, runId, snapshotArtifacts);
    if (immutableArtifacts.length !== snapshotArtifacts.length) throw new Error(`불변 증거 수가 선언과 다릅니다: ${immutableArtifacts.length}/${snapshotArtifacts.length}`);
    const eventArtifacts = snapshotArtifacts.filter((artifact) => artifact.name === `runs/${runId}/events.jsonl`);
    await record({ type: "snapshot_closed", artifactCount: immutableArtifacts.length });
    const immutableEventArtifacts = await snapshotRunArtifacts(jobDir, runDir, job.id, runId, eventArtifacts);
    immutableArtifacts = [...immutableArtifacts.filter((artifact) => !eventArtifacts.some((event) => event.name === artifact.name)), ...immutableEventArtifacts];
    await record({ type: "finalization_started", jobId, runId, status: runStatus, providerDecisionHash });
    const finalizationEventArtifacts = await snapshotRunArtifacts(jobDir, runDir, job.id, runId, eventArtifacts);
    immutableArtifacts = [...immutableArtifacts.filter((artifact) => !eventArtifacts.some((event) => event.name === artifact.name)), ...finalizationEventArtifacts];
    runManifest = {
      ...runManifest,
      status: "finalizing",
      runStatus,
      artifacts: await artifactReceipt(jobDir, snapshotArtifacts),
      immutableArtifacts,
      ledgerErrors: [...ledgerErrors]
    };
    await writeRunManifest(runDir, runManifest);

    const immutableArtifactDeclarations = immutableArtifacts.map(({ path, kind, url }) => ({ name: path, kind: `immutable-${kind || "artifact"}`, url }));
    const finalArtifacts = [
      ...artifacts,
      ...immutableArtifactDeclarations,
      { name: `runs/${runId}/manifest.json`, kind: "run-manifest", url: mediaPath(job.id, `runs/${runId}/manifest.json`) }
    ];
    job = await updateJob(jobId, {
      status: "verifying",
      stage: "검수",
      progress: 98,
      message: "최종 품질 증거를 봉인하는 중입니다.",
      warnings: [...rendered.warnings, ...qualityWarnings],
      artifacts: finalArtifacts,
      duration: rendered.duration,
      scriptGeneratedBy: script.generatedBy,
      qualitySummary,
      runId,
      runStatus: "finalizing",
      error: null
    });

    let finalizedQuality;
    try {
      const { evaluateJob: evaluateFinalQuality, persistQuality } = await import("./quality.mjs");
      finalizedQuality = await evaluateFinalQuality(jobId, {
        iteration: 2,
        runId,
        persist: false,
        finalization: true,
        reuseExistingAnalysis: true,
        reuseEvidenceFrames: true
      });
      await persistQuality(jobDir, finalizedQuality);
    } catch (qualityError) {
      await record({ type: "quality_finalization_failed", error: qualityError.message });
      throw new Error(`최종 공개 후 AHP 품질 검사 실패: ${qualityError.message}`);
    }

    const finalizedQualitySummary = {
      status: finalizedQuality.status,
      totalScore: finalizedQuality.totalScore,
      threshold: finalizedQuality.threshold,
      technicalEvidenceGate: finalizedQuality.technicalEvidenceGate,
      semanticGate: finalizedQuality.semanticGate,
      runId: finalizedQuality.runId,
      blockers: finalizedQuality.blockers,
      inputManifest: inputManifest.receipt
    };
    const semanticSuccess = finalizedQuality.status === "passed" && finalizedQuality.semanticGate === true;
    const finalizedRunStatus = semanticSuccess ? "verified" : "needs-improvement";
    const finalizedManifestStatus = semanticSuccess ? "completed" : "needs-improvement";
    const qualitySnapshotInputs = [
      { name: "quality.json", kind: "quality-post-publication", url: mediaPath(job.id, "quality.json") },
      { name: "quality/iteration-01.json", kind: "quality-iteration", url: mediaPath(job.id, "quality/iteration-01.json") },
      { name: "quality/iteration-02.json", kind: "quality-iteration", url: mediaPath(job.id, "quality/iteration-02.json") }
    ];
    snapshotArtifacts = [
      ...snapshotArtifacts.filter((artifact) => !qualitySnapshotInputs.some((input) => input.name === artifact.name)),
      ...qualitySnapshotInputs
    ];
    const finalizedQualitySnapshots = await snapshotRunArtifacts(jobDir, runDir, job.id, runId, qualitySnapshotInputs);
    immutableArtifacts = [
      ...immutableArtifacts.filter((artifact) => !qualitySnapshotInputs.some((input) => input.name === artifact.name)),
      ...finalizedQualitySnapshots
    ];
    const finalizedQualityHash = await hashFile(join(jobDir, "quality.json"));
    await record({
      type: "quality_finalized",
      jobId,
      runId,
      status: finalizedRunStatus,
      providerDecisionHash,
      qualityHash: finalizedQualityHash,
      qualitySummary: finalizedQualitySummary
    });
    if (ledgerErrors.length) throw new Error(`실행 기록 저장 실패로 완료를 봉인하지 못했습니다: ${ledgerErrors.join("; ")}`);
    const finalizedEventSnapshots = await snapshotRunArtifacts(jobDir, runDir, job.id, runId, eventArtifacts);
    immutableArtifacts = [
      ...immutableArtifacts.filter((artifact) => !eventArtifacts.some((event) => event.name === artifact.name)),
      ...finalizedEventSnapshots
    ];
    runManifest = {
      ...runManifest,
      status: finalizedManifestStatus,
      completedAt: new Date().toISOString(),
      runStatus: finalizedRunStatus,
      qualitySummary: finalizedQualitySummary,
      artifacts: await artifactReceipt(jobDir, snapshotArtifacts),
      immutableArtifacts
    };
    await writeRunManifest(runDir, runManifest);

    const finalizedImmutableDeclarations = immutableArtifacts.map(({ path, kind, url }) => ({ name: path, kind: `immutable-${kind || "artifact"}`, url }));
    const finalizedArtifacts = [
      ...artifacts,
      ...finalizedImmutableDeclarations,
      { name: `runs/${runId}/manifest.json`, kind: "run-manifest", url: mediaPath(job.id, `runs/${runId}/manifest.json`) }
    ];
    job = await updateJob(jobId, {
      status: semanticSuccess ? "completed" : "needs-improvement",
      stage: semanticSuccess ? "완료" : "개선 필요",
      progress: 100,
      message: semanticSuccess
        ? `영상 제작과 AHP 검사가 완료되었습니다. (${finalizedQualitySummary.totalScore}점)`
        : `영상 파일과 기술 증거 검사만 봉인되었습니다 · 콘텐츠 의미 검토 전이므로 개선 필요 상태를 유지합니다. (${finalizedQualitySummary.totalScore}점)`,
      warnings: [...rendered.warnings, ...qualityWarnings],
      artifacts: finalizedArtifacts,
      duration: rendered.duration,
      scriptGeneratedBy: script.generatedBy,
      qualitySummary: finalizedQualitySummary,
      runId,
      runStatus: finalizedRunStatus,
      error: null
    });
    if (options.onProgress) await options.onProgress(job);
    return job;
  } catch (error) {
    await record({ type: "failed", error: error.message, stack: error.stack || null });
    const provenancePath = join(jobDir, "gemini-generation.json");
    const providerProvenance = existsSync(provenancePath) ? { path: "gemini-generation.json", sha256: await hashFile(provenancePath).catch(() => null) } : null;
    const eventLog = { path: `runs/${runId}/events.jsonl`, sha256: await hashFile(join(runDir, "events.jsonl")).catch(() => null) };
    runManifest = { ...runManifest, completedAt: new Date().toISOString(), status: "failed", runStatus: "failed", error: error.message, providerProvenance, eventLog, ledgerErrors: [...ledgerErrors] };
    try {
      await writeRunManifest(runDir, runManifest);
    } catch (manifestError) {
      ledgerErrors.push(manifestError.message);
      console.error(`failed run manifest write failed: ${manifestError.message}`);
    }
    job = await updateJob(jobId, { status: "failed", stage: "오류", progress: job.progress || 0, message: error.message, error: error.stack || error.toString(), warnings: [...(job.warnings || []), ...ledgerErrors.map((entry) => `실행 기록 저장 실패: ${entry}`)], providerProvenance, runId, runStatus: "failed" });
    if (options.onProgress) await options.onProgress(job);
    return job;
  }
}

export async function copyUpload(jobId, file, destinationDir = join(JOBS_DIR, jobId, "clips")) {
  await mkdir(destinationDir, { recursive: true });
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const target = join(destinationDir, `${Date.now()}-${safeName || "clip.mp4"}`);
  await Bun.write(target, file);
  return { name: safeName, path: target, size: (await stat(target)).size };
}
