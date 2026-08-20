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
import { buildGrokImagineScript, FACTORY_CLIP_COUNT, PROVIDER_ID as GROK_IMAGINE_PROVIDER, SHOT_DURATION_SEC, unsupportedProviderMessage, normalizeFacts } from "./grok-imagine-factory.mjs";
import { generateGrokImagineFactory } from "./grok-imagine-provider.mjs";
import { appendRunEvent, artifactReceipt, hashFile, writeJsonAtomic, writeRunManifest } from "./run-ledger.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const WORKSPACE_DIR = join(ROOT, "workspace");
export const JOBS_DIR = join(WORKSPACE_DIR, "jobs");
export const ANALYSIS_PATH = join(DATA_DIR, "channel-analysis.json");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const SUPPORTED_PROVIDERS = new Set(["local", "local-video", "gemini-browser", "grok-imagine"]);
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
    benchmarkDuration = JSON.parse(await readFile(join(DATA_DIR, "shorts-metadata.json"), "utf8")).summary || benchmarkDuration;
  } catch {
    // Keep a deterministic fallback if the benchmark profile has not been refreshed.
  }
  const targetDurationSec = Math.max(20, Math.min(180, Number(input.targetDurationSec) || benchmarkDuration.recommendedTargetSec || 78));
  const sources = Array.isArray(input.sources) ? input.sources.filter((source) => source && (source.url || source.title || typeof source === "string")) : [];
  const provider = input.provider === undefined ? "gemini-browser" : input.provider;
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new Error(unsupportedProviderMessage());
  const geminiProfile = provider === "gemini-browser" ? normalizeGeminiProfile(input) : {};
  const factory = provider === GROK_IMAGINE_PROVIDER;
  const job = {
    id,
    topic: input.topic.trim(),
    format: factory ? "vertical" : input.format === "landscape" ? "landscape" : "vertical",
    provider,
    ...geminiProfile,
    clipCount: factory ? FACTORY_CLIP_COUNT : Math.max(1, Math.min(12, Number(input.clipCount) || 6)),
    captions: factory ? true : input.captions !== false,
    voiceover: factory ? false : input.voiceover !== false,
    facts: normalizeFacts(input.facts),
    sources,
    targetDurationSec: factory ? FACTORY_CLIP_COUNT * SHOT_DURATION_SEC : targetDurationSec,
    targetDurationRangeSec: benchmarkDuration.recommendedRangeSec || [benchmarkDuration.p10Sec || 43, benchmarkDuration.p90Sec || 104],
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim().slice(-2400);
    throw new Error(`${command} 실행 실패 (${exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return { stdout, stderr };
}

async function commandOutput(command, args) {
  const result = await runCommand(command, args);
  return result.stdout.trim();
}

async function callGeminiText(topic, clipCount, targetDurationSec, sourceEntries = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const sourceCatalog = JSON.stringify(sourceEntries.map((source) => ({ title: source.title || source.url, url: source.url })));
  const prompt = `당신은 한국어 유튜브 다큐멘터리 쇼츠 작가다. 주제는 "${topic}"이다. ${clipCount}개의 생성형 영상 클립으로 평균 ${targetDurationSec}초(벤치마크 허용 범위 54~91초)의 세로 영상을 만든다. 실제 사실을 꾸며내지 말고 아래 제공된 출처만 사용한다. 각 장면은 sourceIds에 하나 이상의 출처 URL을 연결한다. 각 장면의 durationHint 합계가 전체 목표 길이에 가깝게 되도록 한다. 제공 출처: ${sourceCatalog}. 아래 JSON만 반환한다.\n{\n  "title": "짧고 강한 제목",\n  "hook": "첫 2초 내레이션",\n  "narration": "전체 내레이션",\n  "researchStatus": "verified",\n  "segments": [{"caption":"자막 한 덩어리", "narration":"해당 장면 내레이션", "visualPrompt":"영문 시네마틱 생성 프롬프트", "durationHint":13, "sourceIds":["https://..."]}]\n}\nsegments는 정확히 ${clipCount}개다.`;
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
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  const jsonText = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed.segments) || parsed.segments.length !== clipCount) {
    throw new Error("Gemini가 요청한 클립 수의 대본을 반환하지 않았습니다.");
  }
  const sources = sourceEntries.length ? sourceEntries : Array.isArray(parsed.sources) ? parsed.sources : [];
  const sourceIds = sources.map((source) => typeof source === "string" ? source : source.url).filter(Boolean);
  return {
    ...parsed,
    sources,
    researchStatus: sourceEntries.length ? "verified" : parsed.researchStatus || "missing",
    sourceEvidence: sources.map((source) => ({ sourceId: typeof source === "string" ? source : source.url, title: typeof source === "string" ? source : source.title, fetchStatus: source.fetchStatus || "provided", sha256: source.sha256 || null, excerpt: source.excerpt || "", evidence: source.evidence || [] })),
    segments: parsed.segments.map((segment) => {
      const sourceIdsForSegment = Array.isArray(segment.sourceIds) && segment.sourceIds.length ? segment.sourceIds : sourceIds;
      return { ...segment, sourceIds: sourceIdsForSegment, sourceEvidence: sourceEvidenceFor(sources, sourceIdsForSegment, `${segment.caption || ""} ${segment.narration || ""}`) };
    }),
    generatedBy: "gemini-api"
  };
}
function sourceEvidenceFor(sources, sourceIds, context = "") {
  const ids = new Set((sourceIds || []).map((value) => typeof value === "string" ? value : value?.url).filter(Boolean));
  const terms = [...new Set(String(context).match(/박석|경복궁|근정전|배수|마사토|눈부시|미끄|석영|운모|화강암|난반사|흙먼지/giu) || [])];
  const evidence = sources
    .filter((source) => ids.has(typeof source === "string" ? source : source.url))
    .flatMap((source) => (typeof source === "string" ? [] : source.evidence || []).map((item) => ({ ...item, sourceId: source.url, title: source.title || source.url })));
  return evidence
    .map((item) => ({ item, score: terms.reduce((sum, term) => sum + (item.quote.match(new RegExp(term, "giu")) || []).length, 0) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ item }) => item);

}
function fallbackScript(topic, clipCount, sourceEntries = [], targetDurationSec = 78) {
  const seed = topic || "도시의 숨은 건축 원리";
  const subject = /경복궁|궁궐/.test(seed) ? "Gyeongbokgung palace courtyard, irregular stone palseok paving, palace architecture, visible drainage detail" : `${seed}, real architecture or infrastructure subject`;
  const title = /경복궁|궁궐/.test(seed) ? "경복궁 마당이 평평해 보여도 울퉁불퉁한 이유" : seed;
  const templates = [
    { caption: "평평해 보여도 박석입니다", narration: "평평해 보이지만, 경복궁 근정전 앞마당은 박석으로 울퉁불퉁합니다. 왜 멀리서는 한 장의 면처럼 보일까요? 가까이 다가가면 얇고 넓적한 돌과 그 틈이 보입니다. 이 영상은 그 표면과 틈을 따라가 보겠습니다.", visualPrompt: `vertical cinematic documentary establishing shot of ${subject}, real location, slow push-in, overcast natural light, no text, no logo` },
    { caption: "박석은 화강암으로 만듭니다", narration: "박석은 조선시대 궁궐과 종묘, 왕릉 같은 주요 건물의 바닥에 쓰인 건축재료입니다. 재질은 화강암이고, 석영과 운모가 많아 밝고 투명하게 보입니다. 그래서 한낮의 마당은 먼저 눈에 들어올 만큼 환하게 보입니다.", visualPrompt: `vertical documentary close-up of ${subject}, low camera angle, detailed granite and palseok surface texture, gentle handheld motion, no text, no logo` },
    { caption: "거친 표면이 빛을 흩습니다", narration: "그런데 화강암 마당은 환하면서도 눈이 부시지는 않습니다. 매끈한 표면은 빛을 한 방향으로 반사하지만, 울퉁불퉁한 표면은 반사 방향을 여러 갈래로 흩습니다. 빛이 눈에 직접 닿지 않게 되는 난반사의 원리입니다.", visualPrompt: `vertical cinematic explanatory shot of ${subject}, macro stone surface with physically plausible diffuse light, slow lateral camera move, realistic documentary color, no text` },
    { caption: "틈 아래에는 마사토가 있습니다", narration: "박석의 또 다른 비밀은 돌 사이의 틈과 그 아래에 깔린 마사토입니다. 마사토는 알갱이 크기가 커 물을 내보내는 능력이 뛰어납니다. 그래서 여름 장대비에도 박석마당에 빗물이 쉽게 차오르지 않도록 돕습니다.", visualPrompt: `vertical scientific documentary cutaway of ${subject}, physically plausible rainwater flowing through palseok gaps into coarse sand, clean diagram integrated into real scene, no text` },
    { caption: "박석과 마사토가 서로 보완합니다", narration: "마사토는 배수가 잘되지만 비에 씻겨 내려가거나 마르면 흙먼지가 생길 수 있습니다. 그 단점을 눌러 보완하는 것이 박석입니다. 돌과 마사토는 따로 놓인 재료가 아니라, 서로의 약점을 보완하는 한 조합으로 작동합니다.", visualPrompt: `vertical documentary cutaway transition from historical ${subject} to layered palseok and sand, matched camera movement and color grade, realistic, no text` },
    { caption: "과학과 미학이 함께 남았습니다", narration: "다시 처음의 마당을 보겠습니다. 박석과 마사토가 어울려 만드는 무늬는 무거운 궁궐 마당을 한결 편안하게 보이게 합니다. 빛과 물, 재료와 풍경이 함께 작동하는 모습이 오늘 남은 박석의 건축적 기록입니다.", visualPrompt: `vertical cinematic closing return to ${subject}, slow pull-back revealing the full courtyard and paving pattern, warm natural light, documentary realism, no text, no logo` }
  ];
  const segmentDuration = Math.max(3, Math.round(targetDurationSec / Math.max(1, clipCount)));
  const segments = Array.from({ length: clipCount }, (_, index) => ({
    ...templates[index % templates.length],
    durationHint: segmentDuration,
    claimId: `claim-${index + 1}`,
    sourceIds: sourceEntries.map((source) => typeof source === "string" ? source : source.url).filter(Boolean),
    sourceEvidence: sourceEvidenceFor(sourceEntries, sourceEntries.map((source) => typeof source === "string" ? source : source.url).filter(Boolean), templates[index % templates.length].narration)
  }));
  return {
    title,
    hook: segments[0].narration,
    narration: segments.map((segment) => segment.narration).join(" "),
    sources: sourceEntries,
    sourceEvidence: sourceEntries.map((source) => ({ sourceId: typeof source === "string" ? source : source.url, title: typeof source === "string" ? source : source.title, fetchStatus: source.fetchStatus || "provided", sha256: source.sha256 || null, excerpt: source.excerpt || "", evidence: source.evidence || [] })),
    researchStatus: sourceEntries.some((source) => source?.fetchStatus === "fetched") ? "verified" : sourceEntries.length ? "provided" : "missing",
    generatedBy: "local-editorial-template",
    segments
  };
}
function sourceExcerpt(bytes, contentType) {
  if (!/text\/|json|xml/i.test(contentType)) return { excerpt: "", evidence: [] };
  const raw = new TextDecoder().decode(bytes);
  const clean = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  const terms = ["박석", "경복궁", "근정전", "배수", "마사토", "눈부시", "미끄", "석영", "운모"];
  const windows = [];
  for (const term of terms) {
    for (const match of clean.matchAll(new RegExp(term, "gi"))) {
      const start = Math.max(0, match.index - 260);
      const end = Math.min(clean.length, match.index + term.length + 620);
      if (!windows.some((window) => start <= window.end && end >= window.start)) windows.push({ start, end });
    }
  }
  if (!windows.length) windows.push({ start: 0, end: Math.min(clean.length, 1600) });
  windows.sort((left, right) => left.start - right.start);
  const evidence = windows.slice(0, 8).map((window, index) => ({
    id: `excerpt-${index + 1}`,
    locator: `text-offset:${window.start}-${window.end}`,
    quote: clean.slice(window.start, window.end)
  }));
  return { excerpt: evidence.map((item) => item.quote).join(" … ").slice(0, 4000), evidence };
}
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_COUNT = 12;
const MAX_SOURCE_CONCURRENCY = 3;

function isPrivateSourceAddress(value) {
  let host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 0
      || parts[0] === 10
      || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
      || parts[0] === 127
      || parts[0] === 169 && parts[1] === 254
      || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
      || parts[0] === 192 && (parts[1] === 0 || parts[1] === 168)
      || parts[0] === 192 && parts[1] === 2
      || parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51)
      || parts[0] === 203 && parts[1] === 0 && parts[2] === 113
      || parts[0] >= 224;
  }
  if (isIP(host) === 6) return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || host.startsWith("2001:db8:");
  return false;
}
function isPrivateSourceHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || isPrivateSourceAddress(host);
}

function requestPinnedSource(url, address, signal) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestModule = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestModule({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "user-agent": "PS4-AI-Video-Studio/1.0 source-audit" },
      lookup(_hostname, options, callback) {
        const family = isIP(address);
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      ...(url.protocol === "https:" ? { servername: url.hostname } : {})
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_SOURCE_BYTES) {
          request.destroy(new Error(`출처 응답이 ${MAX_SOURCE_BYTES}바이트 제한을 초과했습니다.`));
          return;
        }
        chunks.push(Buffer.from(chunk));
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

async function captureSource(source) {
  const normalized = typeof source === "string" ? { title: source, url: source } : { ...source };
  if (!normalized.url || !/^https?:\/\//i.test(normalized.url)) return { ...normalized, fetchStatus: "invalid" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const parsedUrl = new URL(normalized.url);
    if (parsedUrl.username || parsedUrl.password) throw new Error("출처 URL 인증 정보는 허용되지 않습니다.");
    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) throw new Error("출처 URL 포트는 80 또는 443만 허용합니다.");
    if (isPrivateSourceHost(parsedUrl.hostname)) throw new Error("비공개 네트워크 출처는 허용되지 않습니다.");
    const addresses = await lookup(parsedUrl.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateSourceAddress(address))) throw new Error("출처 호스트가 공용 네트워크 주소로만 확인되지 않았습니다.");
    const publicAddress = addresses[0];
    const response = await requestPinnedSource(parsedUrl, publicAddress.address, controller.signal);
    if (response.status >= 300 && response.status < 400) return { ...normalized, fetchStatus: "redirect-blocked", httpStatus: response.status, error: "출처 리디렉션은 안전 검증을 위해 차단되었습니다.", fetchedAt: new Date().toISOString() };
    const digest = createHash("sha256").update(response.bytes).digest("hex");
    const contentTypeHeader = response.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || "application/octet-stream";
    const extracted = sourceExcerpt(response.bytes, contentType);
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
    records.push(...await Promise.all(batch.map(captureSource)));
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
    return generated || fallbackScript(job.topic, job.clipCount, job.sources, job.targetDurationSec);
  } catch (error) {
    if (process.env.GEMINI_API_KEY) {
      throw error;
    }
    return fallbackScript(job.topic, job.clipCount, job.sources, job.targetDurationSec);
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
    const parts = [];
    for (let index = 0; index < [...chunk].length; index += maxChars) parts.push([...chunk].slice(index, index + maxChars).join(""));
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

function captionEntriesForDuration(script, duration, voiceoverSync = null) {
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

const BENCHMARK_CAPTION_CUES_PER_MINUTE = 62.6;

function captionMaxChars(script, duration) {
  const segments = script?.segments || [];
  const totalTextChars = segments.reduce((sum, segment) => sum + [...String(segment.narration || segment.caption || "").replace(/\s+/g, " ").trim()].length, 0);
  const targetCueCount = Math.max(segments.length, Math.round((Number(duration) || 0) / 60 * BENCHMARK_CAPTION_CUES_PER_MINUTE));
  if (!totalTextChars || !targetCueCount) return 8;
  return Math.max(8, Math.min(12, Math.ceil(totalTextChars / targetCueCount) + 1));
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

async function createInputManifest(jobDir, runDir, jobId, runId, requestedNames = null, expectedCount = null) {
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
    selected.push({ name, relativePath: `clips/${name}`, bytes: fileStat.size, sha256, absolutePath });
  }
  const manifest = {
    schemaVersion: 1,
    runId,
    jobId,
    capturedAt: new Date().toISOString(),
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
    { key: "channel", source: ANALYSIS_PATH, name: "channel-analysis.json", meta: { expectedVideos: 244, population: "channel-all-videos" } },
    { key: "duration", source: join(DATA_DIR, "shorts-metadata.json"), name: "shorts-metadata.json", meta: { shortsCount: 242 } },
    { key: "rlm", source: join(DATA_DIR, "rlm-benchmark-analysis.json"), name: "rlm-benchmark-analysis.json", meta: { sampleCount: 3 } }
  ];
  const snapshots = {};
  for (const spec of specs) {
    const target = join(snapshotRoot, spec.name);
    const relativePath = `runs/${runId}/benchmarks/${spec.name}`;
    try {
      await copyFile(spec.source, target);
      snapshots[spec.key] = { ...spec.meta, path: relativePath, sha256: await hashFile(target) };
    } catch {
      snapshots[spec.key] = { ...spec.meta, path: relativePath, sha256: null, missing: true };
    }
  }
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
    await runCommand("ffmpeg", [
      "-y", "-i", input, "-i", masteredVoicePath,
      "-filter_complex", "[1:a]aresample=48000,volume=1.00[voice]",
      "-map", "0:v:0", "-map", "[voice]", "-t", String(target),
      "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
    ]);
    const sync = {
      schemaVersion: 1,
      source: "macOS say",
      alignment: "segment-duration-calibrated",
      estimated: true,
      voiceStyle: "documentary-ko-neutral",
      voiceSelection: configuredVoice || "system-default-korean",
      sayRate,
      loudnessTarget: { integratedLufs: -14, loudnessRangeLu: 3.5, truePeakDbfs: -1 },
      targetDurationSec: Number(target.toFixed(3)),
      voiceoverDurationSec: Number(voiceoverDurationSec.toFixed(3)),
      sourceAudioMode: "muted-when-voiceover-enabled",
      sourceAudioGain: 0,
      voiceAudioGain: 1,
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
  "captions.srt", "captions.vtt", "captions.ass", "caption-timing.json", "voiceover-sync.json", "script.json",
  "sources.json", "frame-audio-caption.json", "thumbnail.jpg", "quality.json",
  "committee-review.json", "master.mp4", "chat.mp4", "grok-imagine-generation.json"
];
function providerPolicy(provider) {
  if (provider === "gemini-browser") return "no-local-video-fallback";
  if (provider === "local-video") return "local-video-command-adapter-no-fallback";
  if (provider === GROK_IMAGINE_PROVIDER) return "official-grok-cli-imagine-factory-no-fallback";
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
  await rm(join(jobDir, "factory"), { recursive: true, force: true });
  await rm(join(jobDir, "parts"), { recursive: true, force: true });
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
    request: { topic: job.topic, provider: job.provider, format: job.format, clipCount: job.clipCount, targetDurationSec: job.targetDurationSec, targetDurationRangeSec: job.targetDurationRangeSec, captions: job.captions, voiceover: job.voiceover, fallbackPolicy: providerPolicy(job.provider) },
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
    if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error(unsupportedProviderMessage());
    await clearMutableOutputs(jobDir, job.provider === "gemini-browser", job.provider === "local-video" || job.provider === GROK_IMAGINE_PROVIDER);
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
  let grokImagineGeneration = null;
  const captureRunInputs = async (requestedNames = null, expectedCount = job.clipCount) => {
    if (inputManifest) return inputManifest;
    inputManifest = await createInputManifest(jobDir, runDir, jobId, runId, requestedNames, expectedCount);
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

    const script = job.provider === GROK_IMAGINE_PROVIDER ? buildGrokImagineScript(job) : await buildScript(job);
    await writeJsonAtomic(join(jobDir, "script.json"), script);
    await progress(18, "기획", job.provider === GROK_IMAGINE_PROVIDER
      ? `공장 슬롯과 6고유·1홀드 샷 목록 ${script.segments.length}개를 준비했습니다.`
      : `${script.generatedBy === "gemini-api" ? "Gemini" : "로컬 템플릿"} 대본과 ${script.segments.length}개 장면을 준비했습니다.`);

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
    } else if (job.provider === GROK_IMAGINE_PROVIDER) {
      await progress(24, "Grok Imagine 공장", "공식 grok CLI로 훅 잠금·image_edit·10초 애니메이션을 실행합니다. Gemini로 대체하지 않습니다.");
      grokImagineGeneration = await generateGrokImagineFactory(job, script, runId, async (value, message) => progress(24 + Math.round(value * 0.30), "Grok Imagine 공장", message));
      if (!grokImagineGeneration || grokImagineGeneration.status !== "completed" || grokImagineGeneration.runId !== runId) {
        throw new Error("Grok Imagine 공장 provenance가 현재 runId에 결속되지 않았습니다.");
      }
      const providerReceipt = {
        ...grokImagineGeneration.receipt,
        provider: GROK_IMAGINE_PROVIDER,
        model: grokImagineGeneration.model,
        modelVersion: grokImagineGeneration.modelVersion,
        modelId: grokImagineGeneration.modelId,
        requestHash: grokImagineGeneration.requestHash,
        scriptHash: grokImagineGeneration.scriptHash
      };
      await record({
        type: "provider_generation",
        provider: GROK_IMAGINE_PROVIDER,
        jobId,
        runId,
        model: grokImagineGeneration.model,
        modelVersion: grokImagineGeneration.modelVersion,
        modelId: grokImagineGeneration.modelId,
        receipt: providerReceipt,
        artifact: { name: `runs/${runId}/grok-imagine-generation.json`, path: `runs/${runId}/grok-imagine-generation.json`, sha256: providerReceipt.sha256 }
      });
      runManifest = {
        ...runManifest,
        providerReceipt,
        providerArtifact: { name: `runs/${runId}/grok-imagine-generation.json`, path: `runs/${runId}/grok-imagine-generation.json`, sha256: providerReceipt.sha256 }
      };
      await writeRunManifest(runDir, runManifest);
      await captureRunInputs(grokImagineGeneration.outputNames.map((name) => name.replace(/^clips\//, "")), script.segments.length);
    } else {
      await progress(54, "소스 확인", "업로드된 로컬 클립을 사용합니다.");
    }

    const rendered = job.provider === GROK_IMAGINE_PROVIDER
      ? {
        warnings: [],
        artifacts: [
          { name: "final.mp4", kind: "video", url: mediaPath(job.id, "final.mp4") },
          { name: "master.mp4", kind: "master-video", url: mediaPath(job.id, "master.mp4") },
          { name: "chat.mp4", kind: "chat-video", url: mediaPath(job.id, "chat.mp4") },
          { name: "captions.srt", kind: "captions", url: mediaPath(job.id, "captions.srt") },
          { name: "captions.ass", kind: "captions-ass", url: mediaPath(job.id, "captions.ass") },
          { name: "script.json", kind: "script", url: mediaPath(job.id, "script.json") },
          { name: "thumbnail.jpg", kind: "thumbnail", url: mediaPath(job.id, "thumbnail.jpg") },
          ...(grokImagineGeneration?.artifacts || [])
        ],
        duration: grokImagineGeneration?.compose?.duration || script.targetDurationSec
      }
      : await renderJob(job, script, progress, inputManifest);
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
        semanticGate: quality.semanticGate,
        runId: quality.runId,
        blockers: quality.blockers,
        inputManifest: inputManifest.receipt
      };
      await progress(98, "검수", quality.semanticGate ? `AHP ${quality.totalScore}점 · ${quality.status === "passed" ? "통과" : "개선 필요"}` : `기계 검사 ${quality.totalScore}점 · 의미론 판정 보류`, { qualitySummary });
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
      ...(grokImagineGeneration ? [{ name: `runs/${runId}/grok-imagine-generation.json`, kind: "provider-provenance", url: mediaPath(job.id, `runs/${runId}/grok-imagine-generation.json`) }] : []),
      ...(existsSync(join(jobDir, "grok-imagine-generation.json")) ? [{ name: "grok-imagine-generation.json", kind: "provider-provenance", url: mediaPath(job.id, "grok-imagine-generation.json") }] : []),
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
      script: { generatedBy: script.generatedBy, segmentCount: script.segments.length, targetDurationSec: job.targetDurationSec, sourceBundle: job.sourceBundle || { status: "missing" }, providerProvenance: grokImagineGeneration ? `runs/${runId}/grok-imagine-generation.json` : localVideoGeneration ? `runs/${runId}/local-video-generation.json` : existsSync(join(jobDir, "gemini-generation.json")) ? "gemini-generation.json" : null },
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
      semanticGate: finalizedQuality.semanticGate,
      runId: finalizedQuality.runId,
      blockers: finalizedQuality.blockers,
      inputManifest: inputManifest.receipt
    };
    const finalizedRunStatus = finalizedQuality.status === "passed" ? "verified" : "needs-improvement";
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
      status: "completed",
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
      status: "completed",
      stage: "완료",
      progress: 100,
      message: finalizedQualitySummary.semanticGate ? `영상 제작과 AHP 검사가 완료되었습니다. (${finalizedQualitySummary.totalScore}점)` : `영상 제작 완료 · 기계 검사 ${finalizedQualitySummary.totalScore}점 · 의미론 판정 보류`,
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
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return { name: safeName, path: target, size: (await stat(target)).size };
}
