import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hashFile, writeJsonAtomic } from "./run-ledger.mjs";
import {
  acquireLocalSubprocessPermit,
  LOCAL_SUBPROCESS_ADMISSION_POLICY,
  terminateLocalSubprocessTree
} from "./local-semantic-verifier.mjs";

export const LOCAL_CLIP_UPLOAD_TRANSACTION = ".local-clip-upload-transaction.json";
export const LOCAL_CLIP_UPLOAD_SCHEMA_VERSION = 1;
export const LOCAL_CLIP_UPLOAD_POLICY = Object.freeze({
  ordering: "multipart-file-order-v1",
  maximumDurationSec: 180,
  minimumDurationSec: 0.25,
  maximumDimension: 4096,
  maximumPixels: 4096 * 4096
});

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const MOV_FORMATS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
const MATROSKA_FORMATS = new Set(["matroska", "webm"]);
const TRANSACTION_PHASES = new Set(["staging", "prepared", "swap-started", "clips-installed", "job-installed"]);
const TRANSACTION_NAME_PATTERN = /^\.clips-(?:upload|previous)-[0-9a-f-]{36}$/u;
const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
export const MAX_FFPROBE_OUTPUT_BYTES = 1024 * 1024;

function uploadError(message, statusCode = 400, code = "LOCAL_CLIP_UPLOAD_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function localClipValueHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function sameTransactionSnapshot(left, right) {
  return localClipValueHash(left) === localClipValueHash(right)
    && isDeepStrictEqual(stableValue(left), stableValue(right));
}

function assertExpectedTransactionSnapshot(current, expected) {
  if (
    !current
    || !expected
    || current.transactionId !== expected.transactionId
    || current.phase !== expected.phase
    || !sameTransactionSnapshot(current, expected)
  ) {
    throw uploadError("로컬 클립 업로드 transaction snapshot이 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED");
  }
  return current;
}

function safeJobDirectory(jobDir, jobId = basename(resolve(jobDir))) {
  const root = resolve(jobDir);
  if (!jobId || basename(root) !== jobId || root === resolve(root, "..") || root.includes(`\0`)) {
    throw uploadError("로컬 클립 작업 디렉터리가 안전하지 않습니다.", 409, "LOCAL_CLIP_UPLOAD_PATH_UNSAFE");
  }
  return root;
}

function childPath(root, name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw uploadError("로컬 클립 transaction 항목 이름이 안전하지 않습니다.", 409, "LOCAL_CLIP_UPLOAD_PATH_UNSAFE");
  }
  const path = resolve(root, name);
  if (!path.startsWith(`${root}${sep}`)) throw uploadError("로컬 클립 transaction 경로가 작업 밖을 가리킵니다.", 409, "LOCAL_CLIP_UPLOAD_PATH_UNSAFE");
  return path;
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPlainDirectory(path, label) {
  const value = await lstat(path, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!value) return null;
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw uploadError(`${label}이 안전한 디렉터리가 아닙니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
  }
  return value;
}

async function hashRegularFile(path, maximumBytes = MAX_SNAPSHOT_BYTES) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw uploadError("클립 세트에 bounded exclusive regular file이 아닌 항목이 있습니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
    }
    const digest = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, Number(before.size))));
    let position = 0;
    while (position < Number(before.size)) {
      const length = Math.min(chunk.byteLength, Number(before.size) - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) throw uploadError("클립 파일이 선언된 크기보다 일찍 끝났습니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.nlink !== 1n
    ) throw uploadError("검증 중 클립 파일이 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_CHANGED");
    return { bytes: Number(before.size), sha256: `sha256:${digest.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

function canonicalDirectoryReceipt(entries) {
  const canonicalEntries = entries
    .map((entry) => ({ name: entry.name, bytes: Number(entry.bytes), sha256: entry.sha256 }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const unsigned = {
    schemaVersion: 1,
    entryCount: canonicalEntries.length,
    totalBytes: canonicalEntries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries: canonicalEntries
  };
  return { ...unsigned, setHash: localClipValueHash(unsigned) };
}

async function snapshotDirectory(path, label, options = {}) {
  const directoryStat = await assertPlainDirectory(path, label);
  if (!directoryStat) {
    if (options.allowAbsent) return null;
    throw uploadError(`${label}을 찾을 수 없습니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_MISSING");
  }
  const directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY || 0));
  try {
    const before = await directory.stat({ bigint: true });
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > (options.maxEntries ?? MAX_SNAPSHOT_ENTRIES)) {
      throw uploadError(`${label}에 허용 수보다 많은 항목이 있습니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
    }
    const records = [];
    let totalBytes = 0;
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.includes("/") || entry.name.includes("\0")) {
        throw uploadError(`${label}에 안전한 일반 파일이 아닌 항목이 있습니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
      }
      const receipt = await hashRegularFile(join(path, entry.name), options.maxBytes ?? MAX_SNAPSHOT_BYTES);
      totalBytes += receipt.bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > (options.maxTotalBytes ?? MAX_SNAPSHOT_BYTES)) {
        throw uploadError(`${label}의 전체 크기가 안전 한도를 초과합니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
      }
      records.push({ name: entry.name, ...receipt });
    }
    const after = await directory.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw uploadError(`${label}이 검증 중 변경되었습니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_CHANGED");
    }
    return canonicalDirectoryReceipt(records);
  } finally {
    await directory.close();
  }
}

function validDirectoryReceipt(value) {
  if (
    !value
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount < 0
    || value.entryCount > MAX_SNAPSHOT_ENTRIES
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
    || value.totalBytes > MAX_SNAPSHOT_BYTES
    || !Array.isArray(value.entries)
    || value.entries.length !== value.entryCount
  ) return false;
  const seen = new Set();
  for (const entry of value.entries) {
    if (
      !entry
      || typeof entry.name !== "string"
      || !entry.name
      || entry.name.includes("/")
      || entry.name.includes("\0")
      || seen.has(entry.name)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256 || "")
    ) return false;
    seen.add(entry.name);
  }
  const canonical = canonicalDirectoryReceipt(value.entries);
  return canonical.entryCount === value.entryCount
    && canonical.totalBytes === value.totalBytes
    && canonical.setHash === value.setHash;
}

function validStagingPlan(value, expectedHash) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 12
    || expectedHash !== localClipValueHash(value)
  ) return false;
  let totalBytes = 0;
  const names = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const extension = extname(String(entry?.storedName || "")).toLowerCase();
    if (
      !entry
      || Object.keys(entry).sort().join(",") !== ["declaredBytes", "index", "storedName"].sort().join(",")
      || entry.index !== index + 1
      || entry.storedName !== `${String(index + 1).padStart(2, "0")}${extension}`
      || !ALLOWED_EXTENSIONS.has(extension)
      || names.has(entry.storedName)
      || !Number.isSafeInteger(entry.declaredBytes)
      || entry.declaredBytes <= 0
      || entry.declaredBytes > MAX_SNAPSHOT_BYTES
    ) return false;
    names.add(entry.storedName);
    totalBytes += entry.declaredBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_BYTES) return false;
  }
  return true;
}

async function inspectDirectory(path, expected, label) {
  const actual = await snapshotDirectory(path, label, { allowAbsent: true });
  if (!actual) return { state: "absent", receipt: null };
  return { state: actual.setHash === expected.setHash ? "match" : "foreign", receipt: actual };
}

async function removeExpectedDirectory(path, expected, label) {
  const state = await inspectDirectory(path, expected, label);
  if (state.state === "absent") return false;
  if (state.state !== "match") throw uploadError(`${label}이 transaction 영수증과 달라 삭제하지 않았습니다.`, 409, "LOCAL_CLIP_UPLOAD_STORAGE_CHANGED");
  await rm(path, { recursive: true, force: false });
  return true;
}

function fileExtension(file) {
  return extname(String(file?.name || "")).toLowerCase();
}

export function validateLocalClipFiles(files, expectedCount, limits = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 12) {
    throw uploadError("작업의 기대 클립 수가 올바르지 않습니다.", 409, "LOCAL_CLIP_UPLOAD_JOB_INVALID");
  }
  if (list.length !== expectedCount) {
    throw uploadError(`이 작업에는 정확히 ${expectedCount}개 클립이 필요합니다. 현재 ${list.length}개를 선택했습니다.`, 400, "LOCAL_CLIP_UPLOAD_COUNT_MISMATCH");
  }
  const maxFileBytes = limits.maxFileBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  let totalBytes = 0;
  for (const file of list) {
    const size = Number(file?.size);
    const extension = fileExtension(file);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw uploadError("MP4, MOV, WebM, M4V, MKV 영상만 업로드할 수 있습니다.", 400, "LOCAL_CLIP_UPLOAD_EXTENSION_INVALID");
    }
    if (file?.type && !String(file.type).toLowerCase().startsWith("video/")) {
      throw uploadError("영상 MIME 형식의 파일만 업로드할 수 있습니다.", 400, "LOCAL_CLIP_UPLOAD_MIME_INVALID");
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw uploadError("비어 있거나 크기를 확인할 수 없는 클립은 업로드할 수 없습니다.", 400, "LOCAL_CLIP_UPLOAD_SIZE_INVALID");
    }
    if (size > maxFileBytes) throw uploadError(`클립 하나의 최대 크기는 ${Math.floor(maxFileBytes / 1024 / 1024)}MB입니다.`, 413, "LOCAL_CLIP_UPLOAD_FILE_TOO_LARGE");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw uploadError(`클립 전체 크기는 ${Math.floor(maxTotalBytes / 1024 / 1024)}MB를 넘을 수 없습니다.`, 413, "LOCAL_CLIP_UPLOAD_TOTAL_TOO_LARGE");
    }
    if (typeof file.arrayBuffer !== "function") throw uploadError("업로드 파일 본문을 읽을 수 없습니다.", 400, "LOCAL_CLIP_UPLOAD_BODY_INVALID");
  }
  return { files: list, count: list.length, totalBytes };
}

export function validateLocalClipProbeMetadata(raw, extension, policy = LOCAL_CLIP_UPLOAD_POLICY) {
  const formatNames = String(raw?.format?.format_name || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const videoStreams = Array.isArray(raw?.streams) ? raw.streams.filter((stream) => stream?.codec_type === "video") : [];
  if (!formatNames.length || !videoStreams.length) throw uploadError("디코딩 가능한 영상 스트림을 찾지 못했습니다.", 400, "LOCAL_CLIP_UPLOAD_MEDIA_INVALID");
  const allowedFormats = [".mp4", ".mov", ".m4v"].includes(extension) ? MOV_FORMATS : MATROSKA_FORMATS;
  if (!formatNames.some((name) => allowedFormats.has(name))) {
    throw uploadError("파일 확장자와 실제 영상 컨테이너가 일치하지 않습니다.", 400, "LOCAL_CLIP_UPLOAD_CONTAINER_MISMATCH");
  }
  const stream = videoStreams.find((item) => Number(item.width) > 0 && Number(item.height) > 0);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationSec = Number(raw?.format?.duration ?? stream?.duration);
  if (!Number.isFinite(durationSec) || durationSec < policy.minimumDurationSec || durationSec > policy.maximumDurationSec) {
    throw uploadError(`클립 길이는 ${policy.minimumDurationSec}초 이상 ${policy.maximumDurationSec}초 이하여야 합니다.`, 400, "LOCAL_CLIP_UPLOAD_DURATION_INVALID");
  }
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 16
    || height < 16
    || width > policy.maximumDimension
    || height > policy.maximumDimension
    || width * height > policy.maximumPixels
  ) throw uploadError(`클립 해상도는 각 변 ${policy.maximumDimension}px 이하의 유효한 영상이어야 합니다.`, 400, "LOCAL_CLIP_UPLOAD_DIMENSIONS_INVALID");
  return {
    durationSec: Number(durationSec.toFixed(3)),
    width,
    height,
    codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
    formatNames: [...new Set(formatNames)].sort()
  };
}

function resolveFfprobe(options = {}) {
  const explicit = String(options.ffprobePath || process.env.FFPROBE_BINARY || "").trim();
  if (explicit) return explicit;
  const fullBin = String(process.env.FFMPEG_FULL_BIN || "/opt/homebrew/opt/ffmpeg-full/bin");
  const bundled = join(fullBin, "ffprobe");
  if (typeof Bun.which === "function") return Bun.which(bundled) || Bun.which("ffprobe");
  return null;
}

async function readBoundedProcessOutput(stream, maximumBytes, onLimit, readerCancels) {
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  const cancel = () => reader.cancel("ffprobe output canceled").catch(() => {});
  readerCancels.add(cancel);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        const error = uploadError("ffprobe 출력이 허용 크기를 초과했습니다.", 400, "LOCAL_CLIP_UPLOAD_PROBE_OUTPUT_TOO_LARGE");
        onLimit(error);
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    readerCancels.delete(cancel);
    reader.releaseLock();
  }
}

export async function probeLocalClip(path, extension = extname(path).toLowerCase(), options = {}) {
  const binary = resolveFfprobe(options);
  if (!binary) throw uploadError("ffprobe를 찾을 수 없어 업로드 영상을 검증하지 못했습니다.", 503, "LOCAL_CLIP_UPLOAD_FFPROBE_MISSING");
  const maximumOutputBytes = options.maximumOutputBytes ?? MAX_FFPROBE_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const admissionTimeoutMs = options.admissionTimeoutMs ?? LOCAL_SUBPROCESS_ADMISSION_POLICY.waitTimeoutMs;
  if (
    !Number.isSafeInteger(maximumOutputBytes)
    || maximumOutputBytes < 1024
    || maximumOutputBytes > MAX_FFPROBE_OUTPUT_BYTES
  ) {
    throw new TypeError("ffprobe 출력 상한이 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("ffprobe timeout이 올바르지 않습니다.");
  }
  if (
    !Number.isSafeInteger(admissionTimeoutMs)
    || admissionTimeoutMs < 1
    || admissionTimeoutMs > LOCAL_SUBPROCESS_ADMISSION_POLICY.waitTimeoutMs
  ) {
    throw new TypeError("ffprobe subprocess admission timeout이 올바르지 않습니다.");
  }
  const releasePermit = await acquireLocalSubprocessPermit({ timeoutMs: admissionTimeoutMs });
  let timer = null;
  try {
    const processHandle = Bun.spawn([
      binary,
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,duration",
      "-of", "json",
      path
    ], { detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let outputExceeded = false;
    let terminalError = null;
    let rejectTermination;
    const terminationPromise = new Promise((_, rejectPromise) => { rejectTermination = rejectPromise; });
    const readerCancels = new Set();
    const stop = (error, isOutputLimit = false) => {
      if (terminalError) return;
      terminalError = error;
      outputExceeded = isOutputLimit;
      terminateLocalSubprocessTree(processHandle.pid, () => processHandle.kill(9));
      for (const cancel of readerCancels) cancel();
      rejectTermination(error);
    };
    timer = setTimeout(() => {
      stop(uploadError("업로드 영상 검사 시간이 초과되었습니다.", 408, "LOCAL_CLIP_UPLOAD_PROBE_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    const stopForOutputLimit = (error) => stop(error, true);
    const stdoutPromise = readBoundedProcessOutput(processHandle.stdout, maximumOutputBytes, stopForOutputLimit, readerCancels);
    const stderrPromise = readBoundedProcessOutput(processHandle.stderr, maximumOutputBytes, stopForOutputLimit, readerCancels);
    const completionPromise = Promise.allSettled([processHandle.exited, stdoutPromise, stderrPromise]);
    const results = await Promise.race([completionPromise, terminationPromise]);
    const outputError = results.slice(1).find((result) => result.status === "rejected")?.reason;
    if (outputExceeded) throw outputError || uploadError("ffprobe 출력이 허용 크기를 초과했습니다.", 400, "LOCAL_CLIP_UPLOAD_PROBE_OUTPUT_TOO_LARGE");
    if (outputError) throw outputError;
    const exitCode = results[0].value;
    const stdout = results[1].value;
    const stderr = results[2].value;
    if (exitCode !== 0) throw uploadError(`영상 파일을 해석할 수 없습니다${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : "."}`, 400, "LOCAL_CLIP_UPLOAD_PROBE_FAILED");
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw uploadError("ffprobe 영상 검사 결과가 올바른 JSON이 아닙니다.", 500, "LOCAL_CLIP_UPLOAD_PROBE_INVALID");
    }
    return validateLocalClipProbeMetadata(parsed, extension, options.policy || LOCAL_CLIP_UPLOAD_POLICY);
  } finally {
    if (timer) clearTimeout(timer);
    releasePermit();
  }
}

async function writeUploadedFile(path, file) {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const reader = typeof file.stream === "function" ? file.stream().getReader() : null;
    let position = 0;
    if (!reader) {
      const bytes = Buffer.from(await file.arrayBuffer());
      await handle.writeFile(bytes);
      position = bytes.byteLength;
    } else {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = Buffer.from(value);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position);
            if (bytesWritten <= 0) throw uploadError("업로드 staging 쓰기가 진행되지 않았습니다.", 500, "LOCAL_CLIP_UPLOAD_WRITE_FAILED");
            offset += bytesWritten;
            position += bytesWritten;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (position !== Number(file.size)) throw uploadError("업로드 파일 크기가 전송 중 변경되었습니다.", 400, "LOCAL_CLIP_UPLOAD_BODY_CHANGED");
    await handle.sync();
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.nlink !== 1n || fileStat.size !== BigInt(position)) {
      throw uploadError("업로드 staging 파일이 안전한 일반 파일이 아닙니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE");
    }
  } finally {
    await handle.close();
  }
}

function buildLocalClipImport(job, entries, importedAt) {
  const directoryReceipt = canonicalDirectoryReceipt(entries);
  const unsigned = {
    schemaVersion: 1,
    type: "manual-local-clip-import",
    status: "ready",
    jobId: job.id,
    source: "manual-user-upload",
    providerEvidenceEligible: false,
    orderingPolicy: LOCAL_CLIP_UPLOAD_POLICY.ordering,
    importedAt,
    clipCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalDurationSec: Number(entries.reduce((sum, entry) => sum + entry.durationSec, 0).toFixed(3)),
    setHash: directoryReceipt.setHash,
    entries: entries.map((entry, index) => ({
      index: index + 1,
      storedName: entry.name,
      bytes: entry.bytes,
      sha256: entry.sha256,
      durationSec: entry.durationSec,
      width: entry.width,
      height: entry.height,
      codec: entry.codec,
      formatNames: entry.formatNames
    }))
  };
  return { ...unsigned, receiptHash: localClipValueHash(unsigned) };
}

function buildTargetJob(job, localClipImport, now) {
  const next = { ...job };
  for (const key of [
    "integrity",
    "runId",
    "runStatus",
    "runStartedAt",
    "parentRunId",
    "qualitySummary",
    "duration",
    "error",
    "providerProvenance",
    "providerFailureEvidence",
    "sourceBundle",
    "semanticRevalidationFailure",
    "semanticRevalidationReadiness"
  ]) delete next[key];
  return {
    ...next,
    status: "queued",
    stage: "소스 준비",
    progress: 0,
    message: `${localClipImport.clipCount}개 로컬 클립을 검증·교체했습니다. 선택 순서대로 새 실행을 기다립니다.`,
    warnings: ["수동 업로드에는 API task 영수증이 없으므로 AI provider 기술 증거로 사용하지 않습니다."],
    artifacts: [],
    runId: null,
    runStatus: "queued",
    qualitySummary: null,
    duration: null,
    error: null,
    localClipImport,
    updatedAt: now
  };
}

function validLocalClipImport(value, job) {
  if (
    !value
    || value.schemaVersion !== 1
    || value.type !== "manual-local-clip-import"
    || value.status !== "ready"
    || value.jobId !== job.id
    || value.source !== "manual-user-upload"
    || value.providerEvidenceEligible !== false
    || value.orderingPolicy !== LOCAL_CLIP_UPLOAD_POLICY.ordering
    || typeof value.importedAt !== "string"
    || !Number.isFinite(Date.parse(value.importedAt))
    || value.clipCount !== job.clipCount
    || !Array.isArray(value.entries)
    || value.entries.length !== job.clipCount
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes <= 0
    || !Number.isFinite(value.totalDurationSec)
    || value.totalDurationSec <= 0
  ) return false;
  if (Object.keys(value).sort().join(",") !== [
    "clipCount",
    "entries",
    "importedAt",
    "jobId",
    "orderingPolicy",
    "providerEvidenceEligible",
    "receiptHash",
    "schemaVersion",
    "setHash",
    "source",
    "status",
    "totalBytes",
    "totalDurationSec",
    "type"
  ].sort().join(",")) return false;
  const { receiptHash, ...unsigned } = value;
  if (receiptHash !== localClipValueHash(unsigned)) return false;
  const names = new Set();
  let totalDurationSec = 0;
  let totalBytes = 0;
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    if (
      Object.keys(entry || {}).sort().join(",") !== ["bytes", "codec", "durationSec", "formatNames", "height", "index", "sha256", "storedName", "width"].sort().join(",")
      ||
      entry?.index !== index + 1
      || typeof entry.storedName !== "string"
      || names.has(entry.storedName)
      || !ALLOWED_EXTENSIONS.has(extname(entry.storedName).toLowerCase())
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256 || "")
      || !Number.isFinite(entry.durationSec)
      || entry.durationSec < LOCAL_CLIP_UPLOAD_POLICY.minimumDurationSec
      || entry.durationSec > LOCAL_CLIP_UPLOAD_POLICY.maximumDurationSec
      || !Number.isSafeInteger(entry.width)
      || !Number.isSafeInteger(entry.height)
      || entry.width < 16
      || entry.height < 16
      || entry.width > LOCAL_CLIP_UPLOAD_POLICY.maximumDimension
      || entry.height > LOCAL_CLIP_UPLOAD_POLICY.maximumDimension
      || entry.width * entry.height > LOCAL_CLIP_UPLOAD_POLICY.maximumPixels
      || (entry.codec !== null && typeof entry.codec !== "string")
      || !Array.isArray(entry.formatNames)
      || !entry.formatNames.length
      || entry.formatNames.some((name) => typeof name !== "string" || !name)
    ) return false;
    names.add(entry.storedName);
    totalBytes += entry.bytes;
    totalDurationSec += entry.durationSec;
  }
  const receipt = canonicalDirectoryReceipt(value.entries.map((entry) => ({ name: entry.storedName, bytes: entry.bytes, sha256: entry.sha256 })));
  return receipt.setHash === value.setHash
    && receipt.totalBytes === value.totalBytes
    && totalBytes === value.totalBytes
    && Number(totalDurationSec.toFixed(3)) === value.totalDurationSec;
}

function validateTransaction(value, jobDir) {
  const jobId = basename(resolve(jobDir));
  if (
    !value
    || value.schemaVersion !== LOCAL_CLIP_UPLOAD_SCHEMA_VERSION
    || value.type !== "local-clip-upload-transaction"
    || value.jobId !== jobId
    || typeof value.transactionId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.transactionId)
    || !TRANSACTION_PHASES.has(value.phase)
    || value.stagingName !== `.clips-upload-${value.transactionId}`
    || value.backupName !== `.clips-previous-${value.transactionId}`
    || !TRANSACTION_NAME_PATTERN.test(value.stagingName)
    || !TRANSACTION_NAME_PATTERN.test(value.backupName)
    || !validDirectoryReceipt(value.previousClips)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.previousJobHash || "")
  ) throw uploadError("로컬 클립 업로드 transaction marker가 손상되었거나 작업과 결속되지 않았습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID");
  if (value.phase === "staging") {
    if (
      !validStagingPlan(value.stagingPlan, value.stagingPlanHash)
      || ["nextClips", "nextJob", "nextJobHash"].some((key) => Object.hasOwn(value, key))
    ) throw uploadError("로컬 클립 staging intent가 손상되었거나 작업과 결속되지 않았습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID");
    return value;
  }
  if (
    !validDirectoryReceipt(value.nextClips)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.nextJobHash || "")
    || value.nextJobHash !== localClipValueHash(value.nextJob)
    || value.nextJob?.id !== jobId
    || value.nextJob?.provider !== "local"
    || !validLocalClipImport(value.nextJob?.localClipImport, value.nextJob)
    || value.nextJob.localClipImport.setHash !== value.nextClips.setHash
    || ["stagingPlan", "stagingPlanHash"].some((key) => Object.hasOwn(value, key))
  ) throw uploadError("로컬 클립 업로드 transaction marker가 손상되었거나 작업과 결속되지 않았습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID");
  return value;
}

async function readBoundedJson(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_TRANSACTION_BYTES)) {
      throw uploadError("로컬 클립 transaction marker가 bounded exclusive regular file이 아닙니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_UNSAFE");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw uploadError("로컬 클립 transaction marker가 읽는 중 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED");
    }
    try {
      return JSON.parse(FATAL_UTF8_DECODER.decode(bytes));
    } catch {
      throw uploadError("로컬 클립 transaction marker JSON이 손상되었습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID");
    }
  } finally {
    await handle.close();
  }
}

export async function readLocalClipUploadTransactionStrict(jobDir) {
  const root = safeJobDirectory(jobDir);
  if (!(await assertPlainDirectory(root, "작업 디렉터리"))) {
    throw uploadError("작업 디렉터리를 찾을 수 없습니다.", 404, "LOCAL_CLIP_UPLOAD_JOB_MISSING");
  }
  const markerPath = childPath(root, LOCAL_CLIP_UPLOAD_TRANSACTION);
  let value;
  try {
    value = await readBoundedJson(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return validateTransaction(value, root);
}

async function writeTransaction(jobDir, transaction, options = {}) {
  const markerPath = childPath(jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION);
  if (options.requireAbsent) {
    const current = await lstat(markerPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (current) throw uploadError("해결되지 않은 로컬 클립 업로드 transaction이 이미 있습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_EXISTS");
  } else {
    const current = await readLocalClipUploadTransactionStrict(jobDir);
    assertExpectedTransactionSnapshot(current, options.expectedTransaction);
    if (current.transactionId !== transaction.transactionId) {
      throw uploadError("로컬 클립 업로드 transaction identity가 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED");
    }
  }
  validateTransaction(transaction, jobDir);
  await writeJsonAtomic(markerPath, transaction);
}

async function removeTransaction(jobDir, expectedTransaction) {
  const current = await readLocalClipUploadTransactionStrict(jobDir);
  assertExpectedTransactionSnapshot(current, expectedTransaction);
  await unlink(childPath(jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION));
  await syncDirectory(jobDir);
}

async function advanceTransaction(jobDir, transaction, phase) {
  const next = { ...transaction, phase, phaseUpdatedAt: new Date().toISOString() };
  await writeTransaction(jobDir, next, { expectedTransaction: transaction });
  return next;
}

async function directoryStates(jobDir, transaction) {
  const [clips, staging, backup] = await Promise.all([
    inspectDirectory(childPath(jobDir, "clips"), transaction.nextClips, "현재 clips"),
    inspectDirectory(childPath(jobDir, transaction.stagingName), transaction.nextClips, "업로드 staging"),
    inspectDirectory(childPath(jobDir, transaction.backupName), transaction.previousClips, "이전 clips backup")
  ]);
  const oldClips = clips.state === "absent"
    ? clips
    : await inspectDirectory(childPath(jobDir, "clips"), transaction.previousClips, "현재 clips");
  return { clips, oldClips, staging, backup };
}

async function inspectOwnedPartialStaging(path, transaction) {
  const maximumEntryBytes = Math.max(...transaction.stagingPlan.map((entry) => entry.declaredBytes));
  const maximumTotalBytes = transaction.stagingPlan.reduce((sum, entry) => sum + entry.declaredBytes, 0);
  const actual = await snapshotDirectory(path, "미완료 업로드 staging", {
    allowAbsent: true,
    maxEntries: transaction.stagingPlan.length,
    maxBytes: maximumEntryBytes,
    maxTotalBytes: maximumTotalBytes
  });
  if (!actual) return { state: "absent", receipt: null };
  for (let index = 0; index < actual.entries.length; index += 1) {
    const entry = actual.entries[index];
    const planned = transaction.stagingPlan[index];
    if (
      entry.name !== planned.storedName
      || entry.bytes > planned.declaredBytes
      || (index < actual.entries.length - 1 && entry.bytes !== planned.declaredBytes)
    ) throw uploadError("미완료 업로드 staging이 durable intent와 다릅니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_CHANGED");
  }
  return { state: "owned", receipt: actual };
}

async function rollbackStagingTransaction(jobDir, transaction, currentJob) {
  if (localClipValueHash(currentJob) !== transaction.previousJobHash) {
    throw uploadError("미완료 staging intent의 이전 job.json 결속이 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_JOB_CHANGED");
  }
  const clips = await inspectDirectory(childPath(jobDir, "clips"), transaction.previousClips, "현재 clips");
  if (clips.state !== "match") {
    throw uploadError("staging 중 현재 clips가 이전 세트 영수증과 달라 복구를 차단했습니다.", 409, "LOCAL_CLIP_UPLOAD_RECOVERY_BLOCKED");
  }
  const backupPath = childPath(jobDir, transaction.backupName);
  const backup = await lstat(backupPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (backup) {
    throw uploadError("staging 단계에 예상하지 않은 clips backup이 있어 복구를 차단했습니다.", 409, "LOCAL_CLIP_UPLOAD_RECOVERY_BLOCKED");
  }
  const stagingPath = childPath(jobDir, transaction.stagingName);
  const staging = await inspectOwnedPartialStaging(stagingPath, transaction);
  if (staging.state === "owned") {
    await rm(stagingPath, { recursive: true, force: false });
    await syncDirectory(jobDir);
  }
  await removeTransaction(jobDir, transaction);
  return { status: "rolled-back", job: "previous" };
}

async function rollbackPreparedTransaction(jobDir, transaction, states) {
  const clipsPath = childPath(jobDir, "clips");
  const stagePath = childPath(jobDir, transaction.stagingName);
  const backupPath = childPath(jobDir, transaction.backupName);
  if (states.backup.state === "absent" && states.oldClips.state === "match") {
    if (states.staging.state === "match") await removeExpectedDirectory(stagePath, transaction.nextClips, "업로드 staging");
    else if (states.staging.state !== "absent") throw uploadError("업로드 staging이 transaction과 다릅니다.", 409, "LOCAL_CLIP_UPLOAD_STORAGE_CHANGED");
    await syncDirectory(jobDir);
    await removeTransaction(jobDir, transaction);
    return { status: "rolled-back", job: "previous" };
  }
  if (states.backup.state === "match" && states.clips.state === "absent" && states.staging.state === "match") {
    await rename(backupPath, clipsPath);
    await syncDirectory(jobDir);
    await removeExpectedDirectory(stagePath, transaction.nextClips, "업로드 staging");
    await syncDirectory(jobDir);
    await removeTransaction(jobDir, transaction);
    return { status: "rolled-back", job: "previous" };
  }
  if (states.backup.state === "match" && states.clips.state === "match" && states.staging.state === "absent") {
    await rename(clipsPath, stagePath);
    await rename(backupPath, clipsPath);
    await syncDirectory(jobDir);
    await removeExpectedDirectory(stagePath, transaction.nextClips, "미완료 새 clips");
    await syncDirectory(jobDir);
    await removeTransaction(jobDir, transaction);
    return { status: "rolled-back", job: "previous" };
  }
  if (states.backup.state === "absent" && states.staging.state === "absent" && states.oldClips.state === "match") {
    await removeTransaction(jobDir, transaction);
    return { status: "rolled-back", job: "previous" };
  }
  throw uploadError("미완료 로컬 클립 교체 상태를 안전하게 원복할 수 없습니다.", 409, "LOCAL_CLIP_UPLOAD_RECOVERY_BLOCKED");
}

async function finishCommittedTransaction(jobDir, transaction, states, currentJob, writeJobFn) {
  if (states.clips.state !== "match" || states.staging.state !== "absent" || !["match", "absent"].includes(states.backup.state)) {
    throw uploadError("commit된 로컬 클립 세트가 transaction 영수증과 일치하지 않습니다.", 409, "LOCAL_CLIP_UPLOAD_RECOVERY_BLOCKED");
  }
  const jobHash = localClipValueHash(currentJob);
  if (jobHash === transaction.previousJobHash) {
    await writeJobFn(transaction.nextJob);
  } else if (jobHash !== transaction.nextJobHash) {
    throw uploadError("로컬 클립 교체 중 job.json이 예상하지 않은 값으로 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_JOB_CHANGED");
  }
  if (transaction.phase !== "job-installed") {
    transaction = await advanceTransaction(jobDir, transaction, "job-installed");
  }
  if (states.backup.state === "match") {
    await removeExpectedDirectory(childPath(jobDir, transaction.backupName), transaction.previousClips, "이전 clips backup");
    await syncDirectory(jobDir);
  }
  await removeTransaction(jobDir, transaction);
  return { status: "committed", job: transaction.nextJob };
}

export async function recoverLocalClipUploadTransaction(jobDir, options = {}) {
  const root = safeJobDirectory(jobDir);
  const transaction = await readLocalClipUploadTransactionStrict(root);
  if (options.transaction && !transaction) {
    throw uploadError("복구하려는 로컬 클립 transaction marker가 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED");
  }
  if (!transaction) return { status: "absent", job: null };
  validateTransaction(transaction, root);
  if (options.transaction) {
    validateTransaction(options.transaction, root);
    assertExpectedTransactionSnapshot(transaction, options.transaction);
  }
  if (typeof options.readJobFn !== "function" || typeof options.writeJobFn !== "function") {
    throw new TypeError("로컬 클립 transaction 복구에는 readJobFn과 writeJobFn이 필요합니다.");
  }
  const currentJob = await options.readJobFn(transaction.jobId);
  if (transaction.phase === "staging") {
    return rollbackStagingTransaction(root, transaction, currentJob);
  }
  const jobHash = localClipValueHash(currentJob);
  const states = await directoryStates(root, transaction);
  if (["clips-installed", "job-installed"].includes(transaction.phase) || jobHash === transaction.nextJobHash) {
    return finishCommittedTransaction(root, transaction, states, currentJob, options.writeJobFn);
  }
  if (jobHash !== transaction.previousJobHash) {
    throw uploadError("미완료 로컬 클립 교체의 이전 job.json 결속이 변경되었습니다.", 409, "LOCAL_CLIP_UPLOAD_JOB_CHANGED");
  }
  return rollbackPreparedTransaction(root, transaction, states);
}

export async function verifyReadyLocalClipSet(jobDir, job) {
  const root = safeJobDirectory(jobDir, job?.id);
  if (!(await assertPlainDirectory(root, "작업 디렉터리"))) {
    throw uploadError("작업 디렉터리를 찾을 수 없습니다.", 404, "LOCAL_CLIP_UPLOAD_JOB_MISSING");
  }
  if (job?.provider !== "local") throw uploadError("수동 클립 준비 검사는 local 작업에만 허용됩니다.", 409, "LOCAL_CLIP_UPLOAD_PROVIDER_INVALID");
  if (!validLocalClipImport(job.localClipImport, job)) {
    throw uploadError(`정확히 ${job.clipCount}개 클립을 다시 업로드해 검증 영수증을 만드세요.`, 409, "LOCAL_CLIP_UPLOAD_RECEIPT_MISSING");
  }
  const expected = canonicalDirectoryReceipt(job.localClipImport.entries.map((entry) => ({
    name: entry.storedName,
    bytes: entry.bytes,
    sha256: entry.sha256
  })));
  const actual = await snapshotDirectory(childPath(root, "clips"), "현재 clips");
  if (actual.setHash !== expected.setHash || actual.entryCount !== job.clipCount || actual.setHash !== job.localClipImport.setHash) {
    throw uploadError("업로드 클립 세트가 job 영수증과 달라 실행을 차단했습니다. 클립을 다시 업로드하세요.", 409, "LOCAL_CLIP_UPLOAD_SET_CHANGED");
  }
  return { receipt: job.localClipImport, directory: actual };
}

export async function installLocalClipUpload(jobDir, job, files, options = {}) {
  const root = safeJobDirectory(jobDir, job?.id);
  if (job?.provider !== "local") throw uploadError("클립 업로드는 local 편집 작업에만 허용됩니다.", 409, "LOCAL_CLIP_UPLOAD_PROVIDER_INVALID");
  if (typeof options.writeJobFn !== "function" || typeof options.readJobFn !== "function") {
    throw new TypeError("로컬 클립 업로드에는 readJobFn과 writeJobFn이 필요합니다.");
  }
  validateLocalClipFiles(files, job.clipCount, options.limits);
  const rootStat = await assertPlainDirectory(root, "작업 디렉터리");
  if (!rootStat) throw uploadError("작업 디렉터리를 찾을 수 없습니다.", 404, "LOCAL_CLIP_UPLOAD_JOB_MISSING");
  if (await readLocalClipUploadTransactionStrict(root)) {
    throw uploadError("이전 로컬 클립 업로드 transaction을 먼저 복구해야 합니다.", 409, "LOCAL_CLIP_UPLOAD_TRANSACTION_EXISTS");
  }
  const clipsPath = childPath(root, "clips");
  if (!(await assertPlainDirectory(clipsPath, "현재 clips"))) {
    await mkdir(clipsPath, { mode: 0o700 });
    await syncDirectory(root);
  }
  const previousClips = await snapshotDirectory(clipsPath, "현재 clips");
  const transactionId = randomUUID();
  const stagingName = `.clips-upload-${transactionId}`;
  const backupName = `.clips-previous-${transactionId}`;
  const stagingPath = childPath(root, stagingName);
  const backupPath = childPath(root, backupName);
  let journalWritten = false;
  const createdAt = (options.nowFn || (() => new Date().toISOString()))();
  const stagingPlan = files.map((file, index) => ({
    index: index + 1,
    storedName: `${String(index + 1).padStart(2, "0")}${fileExtension(file)}`,
    declaredBytes: Number(file.size)
  }));
  let transaction = {
    schemaVersion: LOCAL_CLIP_UPLOAD_SCHEMA_VERSION,
    type: "local-clip-upload-transaction",
    transactionId,
    jobId: job.id,
    phase: "staging",
    createdAt,
    phaseUpdatedAt: createdAt,
    stagingName,
    backupName,
    previousJobHash: localClipValueHash(job),
    previousClips,
    stagingPlan,
    stagingPlanHash: localClipValueHash(stagingPlan)
  };
  try {
    await writeTransaction(root, transaction, { requireAbsent: true });
    journalWritten = true;
    await options.hooks?.afterStagingIntent?.({ transaction });
    await mkdir(stagingPath, { mode: 0o700 });
    await syncDirectory(root);
    await options.hooks?.afterStagingCreated?.({ transaction });
    const entries = [];
    const exactHashes = new Map();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const extension = fileExtension(file);
      const storedName = `${String(index + 1).padStart(2, "0")}${extension}`;
      const target = childPath(stagingPath, storedName);
      await writeUploadedFile(target, file);
      const media = await (options.probeClipFn || probeLocalClip)(target, extension, options.probeOptions || {});
      const fileStat = await stat(target);
      const sha256 = await hashFile(target);
      if (exactHashes.has(sha256)) {
        throw uploadError(`서로 다른 클립이 필요합니다. ${exactHashes.get(sha256)}번과 ${index + 1}번 클립의 바이트가 같습니다.`, 400, "LOCAL_CLIP_UPLOAD_DUPLICATE");
      }
      exactHashes.set(sha256, index + 1);
      entries.push({ name: storedName, bytes: fileStat.size, sha256, ...media });
    }
    await syncDirectory(stagingPath);
    const nextClips = await snapshotDirectory(stagingPath, "업로드 staging", { maxEntries: 12, maxTotalBytes: options.limits?.maxTotalBytes ?? 64 * 1024 * 1024 });
    const importedAt = createdAt;
    const localClipImport = buildLocalClipImport(job, entries, importedAt);
    if (localClipImport.setHash !== nextClips.setHash) throw uploadError("staging 클립 영수증 결속에 실패했습니다.", 409, "LOCAL_CLIP_UPLOAD_RECEIPT_INVALID");
    const nextJob = buildTargetJob(job, localClipImport, importedAt);
    const stagingTransaction = transaction;
    transaction = {
      schemaVersion: LOCAL_CLIP_UPLOAD_SCHEMA_VERSION,
      type: "local-clip-upload-transaction",
      transactionId,
      jobId: job.id,
      phase: "prepared",
      createdAt: importedAt,
      phaseUpdatedAt: importedAt,
      stagingName,
      backupName,
      previousJobHash: localClipValueHash(job),
      nextJobHash: localClipValueHash(nextJob),
      previousClips,
      nextClips,
      nextJob
    };
    await writeTransaction(root, transaction, { expectedTransaction: stagingTransaction });
    await options.hooks?.afterPrepared?.({ transaction });
    transaction = await advanceTransaction(root, transaction, "swap-started");
    await rename(clipsPath, backupPath);
    await syncDirectory(root);
    await options.hooks?.afterOldMoved?.({ transaction });
    await rename(stagingPath, clipsPath);
    await syncDirectory(root);
    await options.hooks?.afterNewInstalledBeforeCommit?.({ transaction });
    transaction = await advanceTransaction(root, transaction, "clips-installed");
    await options.hooks?.afterClipsInstalled?.({ transaction });
    await options.writeJobFn(nextJob);
    transaction = await advanceTransaction(root, transaction, "job-installed");
    await options.hooks?.afterJobInstalled?.({ transaction });
    await removeExpectedDirectory(backupPath, previousClips, "이전 clips backup");
    await syncDirectory(root);
    await options.hooks?.afterBackupRemoved?.({ transaction });
    await removeTransaction(root, transaction);
    return {
      status: "committed",
      recovered: false,
      job: nextJob,
      uploaded: localClipImport.entries.map((entry) => ({
        index: entry.index,
        name: entry.storedName,
        size: entry.bytes,
        sha256: entry.sha256,
        durationSec: entry.durationSec,
        width: entry.width,
        height: entry.height
      }))
    };
  } catch (error) {
    if (!journalWritten) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      await syncDirectory(root).catch(() => {});
      throw error;
    }
    if (options.recoverOnError === false) throw error;
    let recovery;
    try {
      recovery = await recoverLocalClipUploadTransaction(root, {
        readJobFn: options.readJobFn,
        writeJobFn: options.writeJobFn
      });
    } catch (recoveryError) {
      const combined = uploadError(`클립 업로드 실패 후 transaction 복구도 완료하지 못했습니다: ${recoveryError.message}`, 409, "LOCAL_CLIP_UPLOAD_RECOVERY_BLOCKED");
      combined.cause = error;
      throw combined;
    }
    if (recovery.status === "committed") {
      const committedJob = await options.readJobFn(job.id);
      return {
        status: "committed",
        recovered: true,
        job: committedJob,
        uploaded: committedJob.localClipImport.entries.map((entry) => ({
          index: entry.index,
          name: entry.storedName,
          size: entry.bytes,
          sha256: entry.sha256,
          durationSec: entry.durationSec,
          width: entry.width,
          height: entry.height
        }))
      };
    }
    throw error;
  }
}
