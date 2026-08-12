import { mkdir, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { hashFile, writeJsonAtomic } from "./run-ledger.mjs";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`local-video 영수증 필드가 없습니다: ${label}`);
  return value;
}

function requestFor(job, script, runId, scriptHash) {
  const base = {
    schemaVersion: 1,
    jobId: job.id,
    runId,
    provider: "local-video",
    topic: job.topic,
    format: job.format,
    targetDurationSec: Number(job.targetDurationSec),
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

function timeoutMs() {
  const value = Number(process.env.PS4_LOCAL_VIDEO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), 1000), 60 * 60 * 1000) : DEFAULT_TIMEOUT_MS;
}

async function runGenerator(generator, input) {
  let processHandle;
  try {
    processHandle = Bun.spawn([generator], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
  } catch (error) {
    throw new Error(`local-video 생성기 실행 실패: ${error.message}`);
  }
  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  try {
    processHandle.stdin.write(`${JSON.stringify(input)}\n`);
    processHandle.stdin.end();
  } catch (error) {
    processHandle.kill?.();
    throw new Error(`local-video 생성기 입력 실패: ${error.message}`);
  }
  let timer;
  let timedOut = false;
  const exitPromise = processHandle.exited;
  try {
    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          processHandle.kill?.();
          reject(new Error(`local-video 생성기 시간이 초과되었습니다 (${timeoutMs()}ms).`));
        }, timeoutMs());
      })
    ]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) throw new Error(`local-video 생성기 시간이 초과되었습니다 (${timeoutMs()}ms).`);
    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim().slice(-2400);
      throw new Error(`local-video 생성기 실행 실패 (${exitCode})${detail ? `: ${detail}` : ""}`);
    }
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function validateReceipt(receipt, job, script, runId, request, scriptHash, requestHash, clipsDir) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("local-video 생성기 영수증 JSON이 객체가 아닙니다.");
  if (receipt.schemaVersion !== 1) throw new Error("local-video 영수증 schemaVersion이 지원되지 않습니다.");
  if (receipt.status !== "completed") throw new Error("local-video 영수증 status가 completed가 아닙니다.");
  if (receipt.jobId !== job.id || receipt.runId !== runId) throw new Error("local-video 영수증 jobId/runId가 현재 실행과 일치하지 않습니다.");
  if (receipt.provider !== "local-video") throw new Error("local-video 영수증 provider가 local-video가 아닙니다.");
  for (const field of ["model", "modelVersion", "modelId", "requestHash", "scriptHash"]) requiredString(receipt[field], field);
  if (receipt.requestHash !== requestHash || receipt.scriptHash !== scriptHash) throw new Error("local-video 영수증 요청·스크립트 해시가 현재 실행과 일치하지 않습니다.");
  if (receipt.request && hashJson(receipt.request) !== hashJson(request)) throw new Error("local-video 영수증 request가 현재 요청과 일치하지 않습니다.");
  if (!Array.isArray(receipt.segments) || receipt.segments.length !== script.segments.length) throw new Error(`local-video 영수증 장면 수가 요청과 다릅니다: ${receipt.segments?.length || 0}/${script.segments.length}`);
  const seenIndices = new Set();
  const seenPaths = new Set();
  const segments = [];
  for (const segment of receipt.segments) {
    const index = Number(segment?.index);
    if (!Number.isInteger(index) || index < 1 || index > script.segments.length || seenIndices.has(index)) throw new Error("local-video 영수증에 중복되거나 유효하지 않은 장면 번호가 있습니다.");
    seenIndices.add(index);
    const relativePath = requiredString(segment?.path || segment?.output, `segments[${index}].path`);
    if (segment.path && segment.output && segment.path !== segment.output) throw new Error(`local-video 영수증 path/output이 일치하지 않습니다: ${relativePath}`);
    if (relativePath.startsWith("/") || relativePath.includes("\\") || !/^clips\/[^/]+$/u.test(relativePath) || relativePath.includes("..")) {
      throw new Error(`local-video 영수증 클립 경로가 허용되지 않습니다: ${relativePath}`);
    }
    const extension = extname(relativePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension) || seenPaths.has(relativePath)) throw new Error(`local-video 영수증 클립 경로가 중복되거나 영상 확장자가 아닙니다: ${relativePath}`);
    seenPaths.add(relativePath);
    const absolutePath = resolve(join(clipsDir, relativePath.slice("clips/".length)));
    if (!absolutePath.startsWith(`${resolve(clipsDir)}${sep}`)) throw new Error(`local-video 영수증 클립 경로가 작업 디렉터리를 벗어났습니다: ${relativePath}`);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) throw new Error(`local-video 생성 결과 파일이 없습니다: ${relativePath}`);
    if (!Number.isInteger(Number(segment.bytes)) || Number(segment.bytes) !== fileStat.size) throw new Error(`local-video 생성 결과 바이트가 영수증과 다릅니다: ${relativePath}`);
    const sha256 = requiredString(segment.sha256, `segments[${index}].sha256`);
    const actualHash = await hashFile(absolutePath);
    if (sha256 !== actualHash) throw new Error(`local-video 생성 결과 해시가 영수증과 다릅니다: ${relativePath}`);
    segments.push({
      ...segment,
      index,
      path: relativePath,
      output: relativePath,
      bytes: fileStat.size,
      sha256: actualHash,
      runId,
      requestHash,
      scriptHash
    });
  }
  if (seenIndices.size !== script.segments.length || !script.segments.every((_, index) => seenIndices.has(index + 1))) throw new Error("local-video 영수증 장면 번호가 요청된 모든 장면을 포함하지 않습니다.");
  return { ...receipt, schemaVersion: 1, jobId: job.id, runId, provider: "local-video", requestHash, scriptHash, request, segments: segments.sort((left, right) => left.index - right.index), outputs: segments.sort((left, right) => left.index - right.index).map((segment) => segment.path) };
}

export async function generateLocalVideoClips(job, script, runId = job?.runId, onProgress = async () => {}) {
  if (!job?.id || !runId) throw new Error("local-video 생성에는 jobId와 runId가 필요합니다.");
  const generator = String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim();
  if (!generator) throw new Error("PS4_LOCAL_VIDEO_GENERATOR가 설정되지 않았습니다.");
  const generatorPath = resolve(generator);
  const generatorStat = await stat(generatorPath).catch(() => null);
  if (!generatorStat?.isFile() || (generatorStat.mode & 0o111) === 0) throw new Error(`PS4_LOCAL_VIDEO_GENERATOR 실행 파일을 찾을 수 없거나 실행 권한이 없습니다: ${generator}`);
  if (!Array.isArray(script?.segments) || !script.segments.length) throw new Error("local-video 생성에는 대본 장면이 필요합니다.");
  const scriptHash = hashJson(script);
  const request = requestFor(job, script, runId, scriptHash);
  const requestHash = request.requestHash;
  const jobDir = resolve(join(import.meta.dirname, "..", "workspace", "jobs", job.id));
  const clipsDir = join(jobDir, "clips");
  const runDir = join(jobDir, "runs", runId);
  await mkdir(clipsDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const stdout = await runGenerator(generatorPath, request);
  let receipt;
  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    throw new Error("local-video 생성기가 유효한 JSON 영수증을 반환하지 않았습니다.");
  }
  const validated = await validateReceipt(receipt, job, script, runId, request, scriptHash, requestHash, clipsDir);
  const receiptPath = join(runDir, "local-video-generation.json");
  await writeJsonAtomic(receiptPath, { ...validated, receiptPath: `runs/${runId}/local-video-generation.json` });
  await onProgress(100, `${validated.segments.length}개 local-video 클립 생성 완료`);
  return {
    ...validated,
    receiptPath,
    receipt: { path: `runs/${runId}/local-video-generation.json`, sha256: await hashFile(receiptPath), segmentCount: validated.segments.length },
    outputNames: validated.segments.map((segment) => segment.path)
  };
}

export { hashJson as hashLocalVideoJson };
