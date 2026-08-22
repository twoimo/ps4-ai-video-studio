import { constants as fsConstants, existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { buildGeminiClipPrompt, buildGeminiGenerationRequest, canonicalGeminiResumeScriptHash, generateGeminiClips, readGeminiGenerationReceipt } from "./gemini-browser.mjs";
import { generateLocalVideoClips, readLocalVideoSubmitIntent } from "./local-video-provider.mjs";
import { acquireLocalSubprocessPermit, createLocalSemanticReceipt, LOCAL_SEMANTIC_MODEL, LOCAL_SEMANTIC_POLICY_BINDING, preflightLocalSemanticVerifier, terminateLocalSubprocessTree } from "./local-semantic-verifier.mjs";
import { appendRunEvent, artifactReceipt, hashFile, writeJsonAtomic, writeRunManifest } from "./run-ledger.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "./provenance.mjs";
import {
  deriveGeminiSubmissionLineage,
  geminiSourceGenerationEvidenceName,
  verifyGeminiSubmissionLineageClosure,
  verifyStrictCompletedGeminiTerminalReceipt
} from "./gemini-submission-lineage.mjs";
import { applyShotPatternsToScript, createShotPatternReceipt, providerPromptBindingForSegment, readShotPatternCatalog } from "./shot-patterns.mjs";
import { SEMANTIC_REVALIDATION_MODE } from "./semantic-revalidation-closure.mjs";
import { storedProviderFailure } from "./gemini-error-safety.mjs";
import { closeFd, mkdirAt, openDirectoryAt, openFileAt, readFdBuffer, renameAt, replaceFileAt, sameFdIdentity, statFd, syncFd, unlinkAt } from "./dirfd.mjs";
import { readLocalClipUploadTransactionStrict, verifyReadyLocalClipSet } from "./local-clip-upload.mjs";

export { SEMANTIC_REVALIDATION_MODE } from "./semantic-revalidation-closure.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = join(ROOT, "data");
const configuredWorkspaceDir = String(process.env.PS4_WORKSPACE_DIR || "").trim();
if (process.env.NODE_ENV !== "test" && configuredWorkspaceDir) {
  throw new Error("PS4_WORKSPACE_DIR override는 NODE_ENV=test에서만 허용됩니다.");
}
export const WORKSPACE_DIR = process.env.NODE_ENV === "test" && configuredWorkspaceDir
  ? resolve(configuredWorkspaceDir)
  : join(ROOT, "workspace");
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

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function ensureWorkspace(options = {}) {
  const trace = options.traceFn || (() => {});
  const syncWorkspaceFd = options.syncFdFn || ((fd) => syncFd(fd));
  const syncParentDirectory = options.syncDirectoryFn || syncDirectory;
  try {
    await mkdir(WORKSPACE_DIR, { recursive: false, mode: 0o700 });
    trace({ operation: "mkdir", path: WORKSPACE_DIR, options: { recursive: false, mode: 0o700 } });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const workspace = await openPlainDirectoryStrict(WORKSPACE_DIR, "workspace 저장 루트");
  let jobsFd = null;
  let uploadsFd = null;
  try {
    try {
      mkdirAt(workspace.handle.fd, "jobs", 0o700);
      trace({ operation: "mkdir", path: JOBS_DIR, options: { recursive: false, mode: 0o700 } });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    jobsFd = openDirectoryAt(workspace.handle.fd, "jobs");
    if (!statFd(jobsFd).isDirectory()) throw new Error("작업 저장 루트가 안전한 디렉터리가 아닙니다.");
    try {
      mkdirAt(workspace.handle.fd, "uploads", 0o700);
      trace({ operation: "mkdir", path: join(WORKSPACE_DIR, "uploads"), options: { recursive: false, mode: 0o700 } });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    uploadsFd = openDirectoryAt(workspace.handle.fd, "uploads");
    if (!statFd(uploadsFd).isDirectory()) throw new Error("업로드 저장 루트가 안전한 디렉터리가 아닙니다.");
    await syncWorkspaceFd(workspace.handle.fd, { path: WORKSPACE_DIR });
    trace({ operation: "fsync", path: WORKSPACE_DIR });
  } finally {
    if (uploadsFd !== null) closeFd(uploadsFd);
    if (jobsFd !== null) closeFd(jobsFd);
    await workspace.handle.close();
  }
  await syncParentDirectory(dirname(WORKSPACE_DIR), { path: dirname(WORKSPACE_DIR) });
  trace({ operation: "fsync", path: dirname(WORKSPACE_DIR) });
}

export async function readAnalysis() {
  return JSON.parse(await readFile(ANALYSIS_PATH, "utf8"));
}

const JOB_STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/u;
const JOB_ID_RESERVATION_ATTEMPTS = 16;
const MAX_SOURCE_COUNT = 12;
const MAX_TOPIC_CODEPOINTS = 500;
const MAX_TOPIC_UTF8_BYTES = 4096;
const MAX_SOURCE_URL_CODEPOINTS = 2048;
const MAX_SOURCE_URL_UTF8_BYTES = 8192;
const MAX_SOURCE_TITLE_CODEPOINTS = 500;
const MAX_SOURCE_TITLE_UTF8_BYTES = 4096;
const MAX_SOURCE_INPUT_UTF8_BYTES = 64 * 1024;
const CREDENTIAL_QUERY_WORD = /(?:^|_)(?:api_?key|access_?key|access_?token|token|secret|password|passwd|signature|sig|auth|credential|session|jwt)(?:_|$)/u;
const CREDENTIAL_QUERY_SUFFIX = /(?:apikey|accesskey|accesstoken|token|secret|password|passwd|signature|sig|auth|credential|session|jwt)$/u;
const MAX_JOB_JSON_BYTES = 16 * 1024 * 1024;

function assertJobStorageId(jobId) {
  if (typeof jobId !== "string" || !JOB_STORAGE_ID_PATTERN.test(jobId)) throw new Error("작업 저장 ID가 안전하지 않습니다.");
  return jobId;
}

function boundedCreateText(value, label, { maximumCodepoints, maximumBytes, allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new Error(`${label}은 문자열이어야 합니다.`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`${label}이 비어 있습니다.`);
  if (/\p{Cc}|\p{Cs}/u.test(trimmed)) throw new Error(`${label}에 제어 문자 또는 올바르지 않은 Unicode가 포함되어 있습니다.`);
  if ([...trimmed].length > maximumCodepoints || Buffer.byteLength(trimmed, "utf8") > maximumBytes) {
    throw new Error(`${label}이 허용된 길이를 초과했습니다.`);
  }
  return trimmed;
}

function validatedCreateSource(source, index) {
  const label = `출처 ${index + 1}`;
  let value;
  if (typeof source === "string") {
    if (source !== source.trim()) throw new Error(`${label} URL의 앞뒤 공백은 허용되지 않습니다.`);
    value = {
      url: boundedCreateText(source, `${label} URL`, {
        maximumCodepoints: MAX_SOURCE_URL_CODEPOINTS,
        maximumBytes: MAX_SOURCE_URL_UTF8_BYTES
      })
    };
  } else {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
    const keys = Object.keys(source).sort();
    if (!keys.length || keys.some((key) => !["title", "url"].includes(key)) || !Object.hasOwn(source, "url")) {
      throw new Error(`${label}에는 url과 선택적 title만 허용됩니다.`);
    }
    if (typeof source.url !== "string" || source.url !== source.url.trim()) throw new Error(`${label} URL은 앞뒤 공백 없는 문자열이어야 합니다.`);
    if (Object.hasOwn(source, "title") && (typeof source.title !== "string" || source.title !== source.title.trim())) {
      throw new Error(`${label} 제목은 앞뒤 공백 없는 문자열이어야 합니다.`);
    }
    value = {
      ...(Object.hasOwn(source, "title") ? {
        title: boundedCreateText(source.title, `${label} 제목`, {
          maximumCodepoints: MAX_SOURCE_TITLE_CODEPOINTS,
          maximumBytes: MAX_SOURCE_TITLE_UTF8_BYTES
        })
      } : {}),
      url: boundedCreateText(source.url, `${label} URL`, {
        maximumCodepoints: MAX_SOURCE_URL_CODEPOINTS,
        maximumBytes: MAX_SOURCE_URL_UTF8_BYTES
      })
    };
  }
  let parsed;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error(`${label} URL이 올바르지 않습니다.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error(`${label} URL은 http(s) 절대 URL이어야 합니다.`);
  if (parsed.username || parsed.password) throw new Error(`${label} URL 인증 정보는 허용되지 않습니다.`);
  if (value.url.includes("#")) throw new Error(`${label} URL fragment는 저장할 수 없습니다.`);
  for (const name of parsed.searchParams.keys()) {
    const canonicalName = name.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
    if (
      CREDENTIAL_QUERY_WORD.test(canonicalName)
      || CREDENTIAL_QUERY_SUFFIX.test(canonicalName)
      || canonicalName === "key"
      || canonicalName === "awsaccesskeyid"
      || canonicalName.startsWith("x_amz_")
      || canonicalName.startsWith("x_goog_")
    ) throw new Error(`${label} URL에 credential 성격의 query parameter가 있습니다.`);
  }
  return typeof source === "string" ? value.url : value;
}

function validatedCreateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("작업 생성 입력은 객체여야 합니다.");
  const topic = boundedCreateText(input.topic, "영상 주제", {
    maximumCodepoints: MAX_TOPIC_CODEPOINTS,
    maximumBytes: MAX_TOPIC_UTF8_BYTES
  });
  if (input.sources !== undefined && !Array.isArray(input.sources)) throw new Error("출처는 배열이어야 합니다.");
  const rawSources = input.sources || [];
  if (rawSources.length > MAX_SOURCE_COUNT) throw new Error(`출처는 최대 ${MAX_SOURCE_COUNT}개까지 허용합니다.`);
  const sources = rawSources.map(validatedCreateSource);
  if (Buffer.byteLength(JSON.stringify(sources), "utf8") > MAX_SOURCE_INPUT_UTF8_BYTES) {
    throw new Error("출처 입력 전체 크기가 허용된 제한을 초과했습니다.");
  }
  return { ...input, topic, sources };
}

async function openExistingJobStorageStrict(jobId) {
  const safeId = assertJobStorageId(jobId);
  const jobsRoot = await openPlainDirectoryStrict(JOBS_DIR, "작업 읽기 jobs root");
  let jobFd = null;
  try {
    jobFd = openDirectoryAt(jobsRoot.handle.fd, safeId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("작업 저장 entry가 디렉터리가 아닙니다.");
    return { safeId, jobsRoot, jobFd, jobIdentity };
  } catch (error) {
    if (jobFd !== null) closeFd(jobFd);
    await jobsRoot.handle.close().catch(() => {});
    throw error;
  }
}

async function closeExistingJobStorage(snapshot) {
  if (snapshot?.jobFd !== null && snapshot?.jobFd !== undefined) closeFd(snapshot.jobFd);
  await snapshot?.jobsRoot?.handle?.close?.().catch(() => {});
}

async function assertExistingJobStorageCurrent(snapshot, expectedJobFileIdentity = null) {
  const currentRoot = await openPlainDirectoryStrict(JOBS_DIR, "작업 저장 경계 재검증 jobs root");
  let currentJobFd = null;
  try {
    if (!sameFdIdentity(snapshot.jobsRoot.identity, currentRoot.identity)) throw new Error("작업 읽기 중 jobs root가 교체되었습니다.");
    currentJobFd = openDirectoryAt(currentRoot.handle.fd, snapshot.safeId);
    if (!sameFdIdentity(snapshot.jobIdentity, statFd(currentJobFd))) throw new Error("작업 읽기 중 job directory가 교체되었습니다.");
    if (expectedJobFileIdentity) {
      const currentFileFd = openFileAt(currentJobFd, "job.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const currentIdentity = statFd(currentFileFd);
        if (!currentIdentity.isFile() || currentIdentity.nlink !== 1n || !sameFdIdentity(expectedJobFileIdentity, currentIdentity)) {
          throw new Error("작업 읽기 중 job.json이 교체되었거나 소유 regular file이 아닙니다.");
        }
      } finally {
        closeFd(currentFileFd);
      }
    }
  } finally {
    if (currentJobFd !== null) closeFd(currentJobFd);
    await currentRoot.handle.close();
  }
}

export async function readJob(jobId) {
  const storage = await openExistingJobStorageStrict(jobId);
  let fileFd = null;
  try {
    fileFd = openFileAt(storage.jobFd, "job.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const fileIdentity = statFd(fileFd);
    if (!fileIdentity.isFile() || fileIdentity.nlink !== 1n || fileIdentity.size > BigInt(MAX_JOB_JSON_BYTES)) {
      throw new Error("job.json이 bounded single-link regular file이 아닙니다.");
    }
    const bytes = readFdBuffer(fileFd, { maxBytes: MAX_JOB_JSON_BYTES });
    const afterRead = statFd(fileFd);
    if (afterRead.nlink !== 1n || !sameFdIdentity(fileIdentity, afterRead)) throw new Error("job.json이 읽는 중 교체되었습니다.");
    await assertExistingJobStorageCurrent(storage, fileIdentity);
    let job;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      job = JSON.parse(text);
    } catch {
      throw new Error("job.json이 올바른 bounded UTF-8 JSON이 아닙니다.");
    }
    if (!job || typeof job !== "object" || Array.isArray(job) || job.id !== storage.safeId) throw new Error("작업 저장 디렉터리와 job.id가 일치하지 않습니다.");
    return job;
  } finally {
    if (fileFd !== null) closeFd(fileFd);
    await closeExistingJobStorage(storage);
  }
}

export async function writeJob(job) {
  const safeId = assertJobStorageId(job?.id);
  const bytes = Buffer.from(JSON.stringify(job, null, 2));
  if (bytes.byteLength > MAX_JOB_JSON_BYTES) throw new Error("job.json 갱신 크기가 허용된 제한을 초과했습니다.");
  const storage = await openExistingJobStorageStrict(safeId);
  let currentFd = null;
  try {
    currentFd = openFileAt(storage.jobFd, "job.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const currentIdentity = statFd(currentFd);
    if (!currentIdentity.isFile() || currentIdentity.nlink !== 1n) throw new Error("기존 job.json이 소유 single-link regular file이 아닙니다.");
    await assertExistingJobStorageCurrent(storage, currentIdentity);
    replaceFileAt(storage.jobFd, "job.json", bytes, { expectedIdentity: currentIdentity, mode: 0o600 });
    await assertExistingJobStorageCurrent(storage);
    return job;
  } finally {
    if (currentFd !== null) closeFd(currentFd);
    await closeExistingJobStorage(storage);
  }
}

export async function updateJob(jobId, patch) {
  const current = await readJob(jobId);
  if (patch && Object.hasOwn(patch, "id") && patch.id !== current.id) {
    throw new Error("작업 갱신으로 job.id를 변경할 수 없습니다.");
  }
  const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
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
      const job = await readJob(entry.name);
      if (
        typeof job.createdAt !== "string"
        || !Number.isFinite(Date.parse(job.createdAt))
        || typeof job.status !== "string"
        || !job.status.trim()
      ) throw new Error("작업 목록 메타데이터가 완전하지 않습니다.");
      jobs.push(job);
    } catch {
      // Quarantine incomplete or structurally damaged entries. A single
      // partial job must not make the complete job listing unavailable.
    }
  }
  return jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}

export async function inspectPriorPaidLocalVideoSubmissions(jobDir) {
  const durableIntent = await readLocalVideoSubmitIntent(jobDir);
  const root = join(resolve(jobDir), ".bfl-flux-video");
  let attemptDirectories;
  try {
    attemptDirectories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      const submissions = durableIntent ? [{
        runId: durableIntent.runId,
        index: 0,
        phase: "submit-intent",
        requestHash: durableIntent.requestHash,
        taskIdPresent: false
      }] : [];
      return { blocked: submissions.length > 0, submissions };
    }
    throw new Error(`기존 BFL 제출 체크포인트를 안전하게 읽을 수 없습니다 (${error.code || "unknown"}).`);
  }
  const submissions = durableIntent ? [{
    runId: durableIntent.runId,
    index: 0,
    phase: "submit-intent",
    requestHash: durableIntent.requestHash,
    taskIdPresent: false
  }] : [];
  for (const attempt of attemptDirectories) {
    if (!attempt.isDirectory() || !/^[a-f0-9]{64}$/u.test(attempt.name)) {
      throw new Error("기존 BFL 체크포인트 디렉터리에 분류할 수 없는 항목이 있습니다.");
    }
    const attemptDir = join(root, attempt.name);
    let entries;
    try {
      entries = await readdir(attemptDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`기존 BFL 제출 체크포인트를 안전하게 열 수 없습니다 (${error.code || "unknown"}).`);
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^task-\d{3}\.json$/u.test(entry.name)) {
        throw new Error("기존 BFL 체크포인트에 분류할 수 없는 파일이 있습니다.");
      }
      let checkpoint;
      try {
        checkpoint = JSON.parse(await readFile(join(attemptDir, entry.name), "utf8"));
      } catch {
        throw new Error("기존 BFL 체크포인트가 손상되어 새 유료 요청을 차단했습니다.");
      }
      if (
        checkpoint?.provider !== "bfl"
        || checkpoint?.jobId !== basename(resolve(jobDir))
        || !Number.isInteger(checkpoint?.index)
        || checkpoint.index < 1
        || typeof checkpoint?.runId !== "string"
        || !checkpoint.runId
        || !["prepared", "submitting", "submission_unknown", "submitted", "downloaded"].includes(checkpoint?.phase)
      ) {
        throw new Error("기존 BFL 체크포인트의 작업·상태 결속이 유효하지 않습니다.");
      }
      // A prior `prepared` checkpoint is also an active paid-submission intent.
      // Its orphaned generator process may advance to POST after this process
      // inspects the file, so treating it as harmless would create a cross-run
      // duplicate-submission race.
      submissions.push({
        runId: checkpoint.runId,
        index: checkpoint.index,
        phase: checkpoint.phase,
        requestHash: checkpoint.requestHash || null,
        taskIdPresent: typeof checkpoint.taskId === "string" && checkpoint.taskId.length > 0
      });
    }
  }
  submissions.sort((left, right) => left.index - right.index || left.runId.localeCompare(right.runId) || left.phase.localeCompare(right.phase));
  return { blocked: submissions.length > 0, submissions };
}

export async function assertNoPriorPaidLocalVideoSubmission(jobDir) {
  const state = await inspectPriorPaidLocalVideoSubmissions(jobDir);
  if (state.blocked) {
    const phases = [...new Set(state.submissions.map((submission) => submission.phase))].sort().join(",");
    const error = new Error(`기존 BFL 유료 제출 체크포인트(${phases})가 있어 새 run의 provider 요청을 차단했습니다. 명시적 provider-0 복구 경로가 필요합니다.`);
    error.code = "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION";
    throw error;
  }
  return state;
}

function jobCreationTimestamp(nowFn) {
  const supplied = (nowFn || (() => new Date()))();
  const value = supplied instanceof Date ? supplied : new Date(supplied);
  if (!Number.isFinite(value.getTime())) throw new Error("작업 생성 시각이 올바르지 않습니다.");
  return value.toISOString();
}

function newJobStorageId(createdAt, randomBytesFn) {
  const entropy = Buffer.from((randomBytesFn || randomBytes)(16));
  if (entropy.byteLength !== 16) throw new Error("작업 저장 ID에는 정확히 128-bit 난수가 필요합니다.");
  return `${createdAt.replace(/[:.]/g, "-")}-${entropy.toString("hex")}`;
}

async function cleanupReservedJobDirectory(reservation, state, options = {}) {
  const jobsRoot = await openPlainDirectoryStrict(JOBS_DIR, "작업 정리 저장 루트");
  let reservedFd = null;
  try {
    try {
      reservedFd = openDirectoryAt(jobsRoot.handle.fd, reservation.id);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (reservation.identity && !sameFdIdentity(reservation.identity, statFd(reservedFd))) {
      throw new Error("실패한 작업 예약 디렉터리가 다른 inode로 교체되어 자동 정리를 중단했습니다.");
    }
    const names = (await readdir(reservation.dir)).sort();
    const expected = [
      ...(state.clipsCreated ? ["clips"] : []),
      ...(state.jobFileCreated ? ["job.json"] : []),
      ...(state.normalizedCreated ? ["normalized"] : [])
    ].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new Error("실패한 작업 예약 디렉터리에 생성기가 소유하지 않은 항목이 있어 자동 정리를 중단했습니다.");
    }
    if (state.jobFileCreated) await unlink(join(reservation.dir, "job.json"));
    if (state.normalizedCreated) await rmdir(join(reservation.dir, "normalized"));
    if (state.clipsCreated) await rmdir(join(reservation.dir, "clips"));
    await rmdir(reservation.dir);
    await (options.cleanupSyncDirectoryFn || ((fd) => syncFd(fd)))(jobsRoot.handle.fd, { path: JOBS_DIR });
  } finally {
    if (reservedFd !== null) closeFd(reservedFd);
    await jobsRoot.handle.close();
  }
  options.traceFn?.({ operation: "cleanup-fsync", path: JOBS_DIR });
}

async function openPlainDirectoryStrict(path, label) {
  const pathIdentity = await lstat(path, { bigint: true });
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error(`${label}가 exact non-symlink directory가 아닙니다.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameFdIdentity(pathIdentity, identity)) {
      throw new Error(`${label}가 lstat과 fd open 사이에 교체되었습니다.`);
    }
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function createJob(input, storageOptions = {}) {
  input = validatedCreateInput(input);
  let benchmarkDuration = { recommendedTargetSec: 78, recommendedRangeSec: [54, 91] };
  try {
    const metadata = JSON.parse(await readFile(join(DATA_DIR, "shorts-metadata.json"), "utf8"));
    benchmarkDuration = metadata.recentSummary || metadata.summary || benchmarkDuration;
  } catch {
    // Keep a deterministic fallback if the benchmark profile has not been refreshed.
  }
  const sources = input.sources;
  const provider = input.provider === undefined ? "gemini-browser" : input.provider;
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
  const hasExplicitClipCount = Object.hasOwn(input, "clipCount");
  if (hasExplicitClipCount && (!Number.isSafeInteger(input.clipCount) || input.clipCount < 1 || input.clipCount > 12)) {
    throw new Error("클립 수는 1개 이상 12개 이하의 안전한 정수여야 합니다.");
  }
  const clipCount = hasExplicitClipCount ? input.clipCount : provider === "gemini-browser" ? 2 : 6;
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
  const createdAt = jobCreationTimestamp(storageOptions.nowFn);
  const trace = storageOptions.traceFn || (() => {});
  const syncNewDirectory = storageOptions.syncDirectoryFn || syncDirectory;
  const syncNewFile = storageOptions.syncFileFn || ((handle) => handle.sync());
  await ensureWorkspace(storageOptions.workspaceOptions);

  let reservation = null;
  let jobsRootSnapshot = null;
  const cleanupState = { clipsCreated: false, normalizedCreated: false, jobFileCreated: false };
  try {
    jobsRootSnapshot = await openPlainDirectoryStrict(JOBS_DIR, "작업 저장 루트");
    for (let attempt = 1; attempt <= JOB_ID_RESERVATION_ATTEMPTS; attempt += 1) {
      const id = assertJobStorageId(newJobStorageId(createdAt, storageOptions.randomBytesFn));
      const dir = join(JOBS_DIR, id);
      try {
        mkdirAt(jobsRootSnapshot.handle.fd, id, 0o700);
        reservation = { id, dir, identity: null };
        trace({ operation: "mkdir", path: dir, options: { recursive: false, mode: 0o700 }, attempt });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        trace({ operation: "collision", path: dir, attempt });
      }
    }
    if (!reservation) {
      const error = new Error(`${JOB_ID_RESERVATION_ATTEMPTS}번 시도 후에도 고유한 작업 저장 ID를 예약하지 못했습니다.`);
      error.code = "JOB_ID_RESERVATION_EXHAUSTED";
      throw error;
    }
    const reservedFd = openDirectoryAt(jobsRootSnapshot.handle.fd, reservation.id);
    try {
      reservation.identity = statFd(reservedFd);
    } finally {
      closeFd(reservedFd);
    }
    if (!reservation.identity.isDirectory()) {
      throw new Error("새 작업 예약 경로가 안전한 디렉터리가 아닙니다.");
    }

    const job = {
      id: reservation.id,
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
      createdAt,
      updatedAt: createdAt
    };

    const clipsDir = join(reservation.dir, "clips");
    await mkdir(clipsDir, { recursive: false, mode: 0o700 });
    cleanupState.clipsCreated = true;
    trace({ operation: "mkdir", path: clipsDir, options: { recursive: false, mode: 0o700 } });
    const normalizedDir = join(reservation.dir, "normalized");
    await mkdir(normalizedDir, { recursive: false, mode: 0o700 });
    cleanupState.normalizedCreated = true;
    trace({ operation: "mkdir", path: normalizedDir, options: { recursive: false, mode: 0o700 } });

    const jobPath = join(reservation.dir, "job.json");
    const serializedJob = Buffer.from(JSON.stringify(job, null, 2));
    const jobFile = await open(
      jobPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      0o600
    );
    cleanupState.jobFileCreated = true;
    try {
      await jobFile.writeFile(serializedJob);
      trace({ operation: "write", path: jobPath, bytes: serializedJob.byteLength });
      await syncNewFile(jobFile, { path: jobPath });
      trace({ operation: "fsync", path: jobPath });
      const written = await jobFile.stat({ bigint: true });
      if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(serializedJob.byteLength)) {
        throw new Error("새 job.json이 exact exclusive regular file로 기록되지 않았습니다.");
      }
    } finally {
      await jobFile.close();
    }

    await syncNewDirectory(reservation.dir, { path: reservation.dir });
    trace({ operation: "fsync", path: reservation.dir });
    await (storageOptions.syncJobsRootFn || ((fd) => syncFd(fd)))(jobsRootSnapshot.handle.fd, { path: JOBS_DIR });
    trace({ operation: "fsync", path: JOBS_DIR });
    await jobsRootSnapshot.handle.close();
    jobsRootSnapshot = null;
    return job;
  } catch (error) {
    await jobsRootSnapshot?.handle.close().catch(() => {});
    jobsRootSnapshot = null;
    if (!reservation) throw error;
    try {
      await cleanupReservedJobDirectory(reservation, cleanupState, storageOptions);
    } catch (cleanupError) {
      const combined = new Error(`작업 생성 실패 후 예약 디렉터리 정리를 완료하지 못했습니다: ${cleanupError.message}`);
      combined.code = "JOB_CREATION_CLEANUP_BLOCKED";
      combined.cause = error;
      throw combined;
    }
    throw error;
  }
}

const FFMPEG_FULL_BIN = process.env.FFMPEG_FULL_BIN || "/opt/homebrew/opt/ffmpeg-full/bin";

export const RENDER_PROCESS_POLICY = Object.freeze({
  maximumActiveProcesses: 2,
  maximumWaitingProcesses: 8,
  admissionTimeoutMs: 30_000,
  maximumTimeoutMs: 10 * 60 * 1000,
  defaultTimeoutMs: 10 * 60 * 1000,
  probeTimeoutMs: 15_000,
  speechTimeoutMs: 2 * 60 * 1000,
  maximumCombinedOutputBytes: 1024 * 1024,
  defaultCombinedOutputBytes: 1024 * 1024,
  binaryOutputBytes: 256 * 1024
});

function renderProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateRenderProcessOptions(command, args, options) {
  if (typeof command !== "string" || !command || command.length > 4096 || command.includes("\0")) {
    throw new TypeError("렌더 프로세스 명령이 올바르지 않습니다.");
  }
  if (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== "string" || arg.length > 65_536 || arg.includes("\0"))) {
    throw new TypeError("렌더 프로세스 인자가 허용 범위를 벗어났습니다.");
  }
  if (args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > 256 * 1024) {
    throw new TypeError("렌더 프로세스 인자 전체 크기가 허용 범위를 벗어났습니다.");
  }
  const timeoutMs = options.timeoutMs ?? RENDER_PROCESS_POLICY.defaultTimeoutMs;
  const maximumOutputBytes = options.maximumOutputBytes ?? RENDER_PROCESS_POLICY.defaultCombinedOutputBytes;
  const admissionTimeoutMs = options.admissionTimeoutMs ?? RENDER_PROCESS_POLICY.admissionTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RENDER_PROCESS_POLICY.maximumTimeoutMs) {
    throw new TypeError("렌더 프로세스 timeout이 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1 || maximumOutputBytes > RENDER_PROCESS_POLICY.maximumCombinedOutputBytes) {
    throw new TypeError("렌더 프로세스 출력 상한이 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs < 1 || admissionTimeoutMs > RENDER_PROCESS_POLICY.admissionTimeoutMs) {
    throw new TypeError("렌더 프로세스 실행 허가 timeout이 올바르지 않습니다.");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd || options.cwd.includes("\0"))) {
    throw new TypeError("렌더 프로세스 작업 디렉터리가 올바르지 않습니다.");
  }
  if (options.stdoutMode !== undefined && !["text", "bytes"].includes(options.stdoutMode)) {
    throw new TypeError("렌더 프로세스 stdout 형식이 올바르지 않습니다.");
  }
  return { timeoutMs, maximumOutputBytes, admissionTimeoutMs };
}

async function readBoundedRenderProcessStream(stream, state, streamName, stop) {
  const reader = stream.getReader();
  const chunks = [];
  let streamBytes = 0;
  const cancel = () => reader.cancel(`render process ${streamName} canceled`).catch(() => {});
  state.readerCancels.add(cancel);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      state.totalBytes += chunk.byteLength;
      streamBytes += chunk.byteLength;
      if (!Number.isSafeInteger(state.totalBytes) || state.totalBytes > state.maximumOutputBytes) {
        state.outputExceeded = true;
        const error = renderProcessError(
          `로컬 렌더 프로세스 stdout/stderr 합산 출력이 ${state.maximumOutputBytes}바이트 제한을 초과했습니다.`,
          "RENDER_PROCESS_OUTPUT_TOO_LARGE"
        );
        stop(error);
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, streamBytes);
  } finally {
    state.readerCancels.delete(cancel);
    reader.releaseLock();
  }
}

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

export async function runBoundedRenderProcess(command, args, options = {}) {
  const limits = validateRenderProcessOptions(command, args, options);
  const binary = commandPath(command);
  if (!binary) {
    throw new Error(`${command} 명령을 찾을 수 없습니다. 로컬 렌더링에는 ${command} 설치가 필요합니다.`);
  }
  const releasePermit = await acquireLocalSubprocessPermit({ timeoutMs: limits.admissionTimeoutMs });
  let proc = null;
  let timer = null;
  let terminalError = null;
  let rejectTermination;
  const terminationPromise = new Promise((_, rejectPromise) => { rejectTermination = rejectPromise; });
  const state = {
    totalBytes: 0,
    maximumOutputBytes: limits.maximumOutputBytes,
    outputExceeded: false,
    readerCancels: new Set()
  };
  const stop = (error) => {
    if (terminalError) return;
    terminalError = error;
    terminateLocalSubprocessTree(proc?.pid, () => proc?.kill(9));
    for (const cancel of state.readerCancels) cancel();
    rejectTermination(error);
  };
  try {
    const effectiveArgs = command === "ffmpeg"
      ? ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]
      : args;
    proc = Bun.spawn([binary, ...effectiveArgs], {
      cwd: options.cwd || ROOT,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    timer = setTimeout(() => {
      stop(renderProcessError(
        `로컬 렌더 프로세스 실행 시간이 ${limits.timeoutMs}ms 제한을 초과했습니다.`,
        "RENDER_PROCESS_TIMEOUT"
      ));
    }, limits.timeoutMs);
    timer.unref?.();
    const stdoutPromise = readBoundedRenderProcessStream(proc.stdout, state, "stdout", stop);
    const stderrPromise = readBoundedRenderProcessStream(proc.stderr, state, "stderr", stop);
    const completionPromise = Promise.allSettled([proc.exited, stdoutPromise, stderrPromise]);
    const results = await Promise.race([completionPromise, terminationPromise]);
    const streamError = results.slice(1).find((result) => result.status === "rejected")?.reason;
    if (state.outputExceeded) {
      throw streamError || renderProcessError("로컬 렌더 프로세스 출력이 허용 크기를 초과했습니다.", "RENDER_PROCESS_OUTPUT_TOO_LARGE");
    }
    if (streamError) throw streamError;
    if (results[0].status === "rejected") throw results[0].reason;
    const exitCode = results[0].value;
    const stdoutBytes = results[1].value;
    const stderrBytes = results[2].value;
    if (exitCode !== 0) {
      const detail = (stderrBytes.byteLength ? stderrBytes : stdoutBytes).toString("utf8").trim().slice(-2400);
      throw renderProcessError(`${command} 실행 실패 (${exitCode})${detail ? `: ${detail}` : ""}`, "RENDER_PROCESS_FAILED");
    }
    return {
      stdout: options.stdoutMode === "bytes" ? new Uint8Array(stdoutBytes) : stdoutBytes.toString("utf8"),
      stderr: stderrBytes.toString("utf8")
    };
  } finally {
    if (timer) clearTimeout(timer);
    releasePermit();
  }
}

async function runCommand(command, args, options = {}) {
  return runBoundedRenderProcess(command, args, { ...options, stdoutMode: "text" });
}

async function commandBytes(command, args, options = {}) {
  const result = await runBoundedRenderProcess(command, args, {
    maximumOutputBytes: RENDER_PROCESS_POLICY.binaryOutputBytes,
    ...options,
    stdoutMode: "bytes"
  });
  return result.stdout;
}

async function commandOutput(command, args) {
  const result = await runCommand(command, args, {
    timeoutMs: RENDER_PROCESS_POLICY.probeTimeoutMs,
    maximumOutputBytes: 64 * 1024
  });
  return result.stdout.trim();
}

function extractiveVisualTemplate(format = "vertical") {
  return {
    prefix: EXTRACTIVE_VISUAL_PREFIXES[format === "landscape" ? "landscape" : "vertical"],
    suffix: EXTRACTIVE_VISUAL_SUFFIX
  };
}

// This is deliberately an extractive binding check, not a factual-entailment verdict.
export const EVIDENCE_TEXT_BINDING_ALGORITHM = "deterministic-extractive-binding/v3";
const EXTRACTIVE_VISUAL_PREFIXES = Object.freeze({
  vertical: "vertical cinematic documentary visualization depicting only this evidence: ",
  landscape: "landscape cinematic documentary visualization depicting only this evidence: "
});
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

function assertExtractiveVisualBinding({ claimId, text, evidenceTexts, format = "vertical" }) {
  const target = String(text || "").trim();
  const { prefix, suffix } = extractiveVisualTemplate(format);
  const matchedIndex = evidenceTexts.findIndex((quote) => target === `${prefix}${JSON.stringify(quote)}${suffix}`);
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

function buildEvidenceTextBinding(parsed, segments, sourceMap, format = "vertical") {
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
    bindings.push(assertExtractiveVisualBinding({ claimId: segment.claimId, text: segment.visualPrompt, evidenceTexts, format }));
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

export function validateEvidenceBoundScript(parsed, sources, clipCount, generatedBy = "unknown", expectedFormat = parsed?.videoFormat || "vertical") {
  const videoFormat = expectedFormat === "landscape" ? "landscape" : "vertical";
  if (parsed?.videoFormat && parsed.videoFormat !== videoFormat) throw new Error("근거 결속 대본의 영상 비율이 현재 작업과 일치하지 않습니다.");
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
  const evidenceTextBinding = buildEvidenceTextBinding(parsed, segments, sourceMap, videoFormat);
  return {
    ...parsed,
    videoFormat,
    sources,
    researchStatus: "verified",
    evidenceTextBinding,
    evidenceTextBindingHash: evidenceTextBinding.bindingHash,
    sourceEvidence: [...sourceMap.values()].map((source) => ({ sourceId: source.url, title: source.title || source.url, fetchStatus: source.fetchStatus, sha256: source.sha256 || null, evidence: source.evidence || [] })),
    segments,
    generatedBy
  };
}

export function verifyEvidenceBoundScript(parsed, sources, clipCount, expectedFormat = parsed?.videoFormat || "vertical") {
  try {
    const validated = validateEvidenceBoundScript(parsed, sources, clipCount, parsed?.generatedBy || "verification", expectedFormat);
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

const MAX_SOURCE_SENTENCE_CANDIDATES = 4096;
const MAX_SOURCE_RANKED_CANDIDATES = 256;

function boundedSentenceSpans(text, maximumCandidates = MAX_SOURCE_SENTENCE_CANDIDATES) {
  const spans = [];
  let truncated = false;
  for (const match of String(text || "").matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu)) {
    if (spans.length >= maximumCandidates) {
      truncated = true;
      break;
    }
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && /\s/u.test(text[start])) start += 1;
    while (end > start && /\s/u.test(text[end - 1])) end -= 1;
    const leadingDirection = /^(?:(?:\([^)]{1,64}\)|(?:조금\s+)?빠르게\))\s*)+/u.exec(text.slice(start, end));
    if (leadingDirection) start += leadingDirection[0].length;
    while (start < end && /\s/u.test(text[start])) start += 1;
    if (start < end) spans.push({ start, end, quote: text.slice(start, end) });
  }
  return { spans, truncated };
}

function sentenceSpans(text) {
  return boundedSentenceSpans(text).spans;
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

function rankedEvidenceOrder(left, right) {
  return right.score - left.score || left.start - right.start || left.quote.localeCompare(right.quote, "ko");
}

function insertBoundedRankedCandidate(candidates, candidate, maximumCandidates) {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rankedEvidenceOrder(candidate, candidates[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= maximumCandidates && candidates.length >= maximumCandidates) return;
  candidates.splice(low, 0, candidate);
  if (candidates.length > maximumCandidates) candidates.pop();
}

function rankEvidenceSpansBounded(text, terms = [], options = {}) {
  const normalizedTerms = normalizeEvidenceTerms(terms);
  const priorityTerms = normalizeEvidenceTerms(options.priorityTerms || []);
  const positions = termPositions(text, normalizedTerms);
  const allowContextOnly = options.allowContextOnly === true;
  const sentenceResult = boundedSentenceSpans(text, MAX_SOURCE_SENTENCE_CANDIDATES);
  const ranked = [];
  let matchedCandidateCount = 0;
  for (const span of sentenceResult.spans) {
    const quote = span.quote;
    if (quote.length < 15 || quote.length > 440) continue;
    const length = [...quote].length;
    // Concise source propositions such as "... 이유다." are useful, fully
    // attributable hooks. Do not discard them merely for being one character
    // shorter than an ordinary narration sentence.
    if (length < 15 || length > 220) continue;
    if (!/다[.!。]+$/u.test(quote)) continue;
    if (/[!?！？]/u.test(quote) || SOURCE_BOILERPLATE_PATTERN.test(quote) || SOURCE_TECHNICAL_PATTERN.test(quote) || SOURCE_STAGE_DIRECTION_PATTERN.test(quote) || SOURCE_PROMOTIONAL_PATTERN.test(quote)) continue;
    if (/[|{}<>_=]/u.test(quote) || repeatedTokenCount(quote) >= 4) continue;
    const koreanCount = (quote.match(/[가-힣]/gu) || []).length;
    const letterCount = (quote.match(/[가-힣A-Za-z]/gu) || []).length;
    const digitCount = (quote.match(/[0-9]/gu) || []).length;
    if (koreanCount < 12 || koreanCount / Math.max(1, letterCount) < 0.68 || digitCount / Math.max(1, length) > 0.12) continue;
    const normalizedQuote = quote.normalize("NFKC").toLocaleLowerCase("ko-KR");
    const matchedTerms = normalizedTerms.filter((term) => normalizedQuote.includes(term));
    const matchedPriorityTerms = priorityTerms.filter((term) => normalizedQuote.includes(term));
    const matchedSecondaryTerms = matchedTerms.filter((term) => !matchedPriorityTerms.includes(term));
    const proximity = nearestPositionDistance(positions, Math.round((span.start + span.end) / 2));
    const contextRelevant = proximity <= 320;
    const explanatory = SOURCE_EXPLANATORY_PATTERN.test(quote);
    if (normalizedTerms.length && !matchedTerms.length && ((!contextRelevant && !allowContextOnly) || !explanatory)) continue;
    const score = matchedPriorityTerms.length * 40
      + matchedSecondaryTerms.length * 5
      + (contextRelevant ? Math.max(0, 14 - Math.floor(proximity / 32)) : 0)
      + (explanatory ? 14 : 0)
      + Math.round(koreanCount / Math.max(1, letterCount) * 10)
      + (length >= 28 && length <= 120 ? 12 : length <= 160 ? 6 : 0);
    matchedCandidateCount += 1;
    insertBoundedRankedCandidate(ranked, { ...span, score, matchedTerms, proximity }, MAX_SOURCE_RANKED_CANDIDATES);
  }
  return {
    ranked,
    sentenceCandidateCount: sentenceResult.spans.length,
    sentenceCandidatesTruncated: sentenceResult.truncated,
    matchedCandidateCount,
    rankedCandidatesTruncated: matchedCandidateCount > MAX_SOURCE_RANKED_CANDIDATES
  };
}

function rankEvidenceSpans(text, terms = [], options = {}) {
  return rankEvidenceSpansBounded(text, terms, options).ranked;
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
  // The former LCS fallback was O(length²) per pair. With 256 bounded
  // candidates and 32 selected excerpts that still permitted hundreds of
  // millions of synchronous operations. Character shingles provide a linear,
  // deterministic approximation without reopening that event-loop DoS path.
  return shingleSimilarity >= 0.68;
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

export function evidenceFallbackScript(topic, clipCount, sourceEntries = [], targetDurationSec = 78, format = "vertical") {
  const candidates = fallbackEvidenceCandidates(topic, sourceEntries);
  if (candidates.length < clipCount) throw new Error(`유효한 검증 근거 문장이 부족합니다: ${candidates.length}/${clipCount}. 메뉴·식별자가 아닌 주제 관련 설명문이 있는 출처를 추가하세요.`);
  const durationHint = Math.max(3, Number((targetDurationSec / clipCount).toFixed(2)));
  // The hook remains a complete captured sentence; only its editorial order is
  // changed. Claims, citations, and extractive verification stay byte-bound.
  const selected = selectFallbackEvidence(candidates, clipCount);
  const normalizedFormat = format === "landscape" ? "landscape" : "vertical";
  const { prefix: visualPrefix, suffix: visualSuffix } = extractiveVisualTemplate(normalizedFormat);
  const parsed = {
    videoFormat: normalizedFormat,
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
        visualPrompt: `${visualPrefix}${JSON.stringify(narration)}${visualSuffix}`,
        durationHint,
        evidenceRefs: [{ sourceId: item.sourceId, evidenceId: item.evidenceId, quote: narration }]
      };
    })
  };
  return validateEvidenceBoundScript(parsed, sourceEntries, clipCount, "evidence-extract-fallback", normalizedFormat);
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

export const SOURCE_CAPTURE_POLICY = Object.freeze({
  maximumResponseBytes: 20 * 1024 * 1024,
  maximumParseBytes: 512 * 1024,
  maximumCanonicalCharacters: 256 * 1024,
  maximumJsonDepth: 64,
  maximumJsonNodes: 8192,
  maximumSentenceCandidates: MAX_SOURCE_SENTENCE_CANDIDATES,
  maximumRankedCandidates: MAX_SOURCE_RANKED_CANDIDATES,
  maximumEvidence: 32,
  maximumActiveCaptures: 3,
  maximumWaitingCaptures: 9,
  admissionWaitTimeoutMs: 15_000,
  dnsTimeoutMs: 12_000,
  requestTimeoutMs: 12_000
});

const SOURCE_TEXT_MEDIA_TYPES = new Set([
  "application/atom+xml",
  "application/json",
  "application/ld+json",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml"
]);
const SOURCE_JSON_MEDIA_TYPES = new Set(["application/json", "application/ld+json"]);
const SOURCE_MARKUP_MEDIA_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/xml"
]);
const SOURCE_SKIPPED_MARKUP_TAGS = new Set(["footer", "form", "header", "nav", "noscript", "script", "style", "svg", "template"]);
const SOURCE_BLOCK_MARKUP_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
  "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export function normalizedSourceMediaType(value) {
  const raw = Array.isArray(value) ? (value.length === 1 ? value[0] : "") : value;
  const mediaType = String(raw || "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType) ? mediaType : "";
}

function createBoundedCanonicalBuilder(maximumCharacters) {
  const characters = [];
  let length = 0;
  let pendingWhitespace = "";
  let truncated = false;
  const appendCharacter = (character) => {
    if (length + character.length > maximumCharacters) {
      truncated = true;
      return false;
    }
    characters.push(character);
    length += character.length;
    return true;
  };
  const flushWhitespace = () => {
    if (!pendingWhitespace || !characters.length) {
      pendingWhitespace = "";
      return true;
    }
    const value = pendingWhitespace;
    pendingWhitespace = "";
    return appendCharacter(value);
  };
  return {
    append(value) {
      if (truncated) return;
      for (const character of String(value || "")) {
        if (/\s/u.test(character)) {
          if (character === "\n" || character === "\r") pendingWhitespace = "\n";
          else if (pendingWhitespace !== "\n") pendingWhitespace = " ";
          continue;
        }
        if (!flushWhitespace() || !appendCharacter(character)) break;
      }
    },
    break() {
      if (characters.length) pendingWhitespace = "\n";
    },
    finish() {
      return { text: characters.join(""), truncated };
    },
    get truncated() {
      return truncated;
    }
  };
}

function appendDecodedSourceText(builder, value) {
  if (!value || builder.truncated) return;
  builder.append(decodeSourceEntities(value));
}

function sourceMarkupTagEnd(raw, offset) {
  let quote = "";
  for (let index = offset; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function sourceMarkupTag(raw, offset, end) {
  let cursor = offset + 1;
  while (cursor < end && /\s/u.test(raw[cursor])) cursor += 1;
  const closing = raw[cursor] === "/";
  if (closing) cursor += 1;
  while (cursor < end && /\s/u.test(raw[cursor])) cursor += 1;
  const start = cursor;
  while (cursor < end && /[A-Za-z0-9:-]/u.test(raw[cursor])) cursor += 1;
  return { closing, name: raw.slice(start, cursor).toLowerCase() };
}

function sourceClosingMarkupTag(lower, tagName, offset) {
  const needle = `</${tagName}`;
  let cursor = offset;
  while (cursor < lower.length) {
    const found = lower.indexOf(needle, cursor);
    if (found < 0) return -1;
    const boundary = lower[found + needle.length] || ">";
    if (/\s|>/u.test(boundary)) return found;
    cursor = found + needle.length;
  }
  return -1;
}

function canonicalMarkupSourceText(raw) {
  const builder = createBoundedCanonicalBuilder(SOURCE_CAPTURE_POLICY.maximumCanonicalCharacters);
  const lower = raw.toLowerCase();
  let cursor = 0;
  let malformedMarkupTruncated = false;
  while (cursor < raw.length && !builder.truncated) {
    const opening = raw.indexOf("<", cursor);
    if (opening < 0) {
      appendDecodedSourceText(builder, raw.slice(cursor));
      break;
    }
    appendDecodedSourceText(builder, raw.slice(cursor, opening));
    if (raw.startsWith("<!--", opening)) {
      const end = raw.indexOf("-->", opening + 4);
      if (end < 0) {
        malformedMarkupTruncated = true;
        break;
      }
      builder.break();
      cursor = end + 3;
      continue;
    }
    const tagEnd = sourceMarkupTagEnd(raw, opening + 1);
    if (tagEnd < 0) {
      malformedMarkupTruncated = true;
      break;
    }
    const tag = sourceMarkupTag(raw, opening, tagEnd);
    if (!tag.closing && SOURCE_SKIPPED_MARKUP_TAGS.has(tag.name)) {
      const closing = sourceClosingMarkupTag(lower, tag.name, tagEnd + 1);
      if (closing < 0) {
        malformedMarkupTruncated = true;
        break;
      }
      const closingEnd = sourceMarkupTagEnd(raw, closing + 1);
      if (closingEnd < 0) {
        malformedMarkupTruncated = true;
        break;
      }
      builder.break();
      cursor = closingEnd + 1;
      continue;
    }
    if (SOURCE_BLOCK_MARKUP_TAGS.has(tag.name)) builder.break();
    else builder.append(" ");
    cursor = tagEnd + 1;
  }
  const result = builder.finish();
  return { ...result, malformedMarkupTruncated };
}

function canonicalJsonSourceText(raw) {
  const builder = createBoundedCanonicalBuilder(SOURCE_CAPTURE_POLICY.maximumCanonicalCharacters);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    builder.append(decodeSourceEntities(raw));
    return { ...builder.finish(), jsonValid: false, jsonNodeCount: 0, jsonNodesTruncated: false, jsonDepthTruncated: false };
  }
  const stack = [{ value: parsed, depth: 0 }];
  let jsonNodeCount = 0;
  let jsonNodesTruncated = false;
  let jsonDepthTruncated = false;
  while (stack.length && !builder.truncated) {
    const entry = stack.pop();
    if (jsonNodeCount >= SOURCE_CAPTURE_POLICY.maximumJsonNodes) {
      jsonNodesTruncated = true;
      break;
    }
    jsonNodeCount += 1;
    if (entry.depth > SOURCE_CAPTURE_POLICY.maximumJsonDepth) {
      jsonDepthTruncated = true;
      continue;
    }
    if (typeof entry.value === "string") {
      builder.break();
      builder.append(entry.value);
      continue;
    }
    if (!entry.value || typeof entry.value !== "object") continue;
    const remaining = Math.max(0, SOURCE_CAPTURE_POLICY.maximumJsonNodes - jsonNodeCount);
    const values = [];
    if (Array.isArray(entry.value)) {
      const accepted = Math.min(entry.value.length, remaining);
      if (accepted < entry.value.length) jsonNodesTruncated = true;
      for (let index = 0; index < accepted; index += 1) values.push(entry.value[index]);
    } else {
      for (const key in entry.value) {
        if (!Object.hasOwn(entry.value, key)) continue;
        if (values.length >= remaining) {
          jsonNodesTruncated = true;
          break;
        }
        values.push(entry.value[key]);
      }
    }
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ value: values[index], depth: entry.depth + 1 });
    }
  }
  if (stack.length) jsonNodesTruncated = true;
  return { ...builder.finish(), jsonValid: true, jsonNodeCount, jsonNodesTruncated, jsonDepthTruncated };
}

function canonicalSourceText(raw, mediaType) {
  if (SOURCE_JSON_MEDIA_TYPES.has(mediaType)) return canonicalJsonSourceText(raw);
  if (SOURCE_MARKUP_MEDIA_TYPES.has(mediaType)) {
    return { ...canonicalMarkupSourceText(raw), jsonValid: null, jsonNodeCount: 0, jsonNodesTruncated: false, jsonDepthTruncated: false };
  }
  const builder = createBoundedCanonicalBuilder(SOURCE_CAPTURE_POLICY.maximumCanonicalCharacters);
  builder.append(decodeSourceEntities(raw));
  return { ...builder.finish(), malformedMarkupTruncated: false, jsonValid: null, jsonNodeCount: 0, jsonNodesTruncated: false, jsonDepthTruncated: false };
}

function decodeSourceUtf8Prefix(bytes, truncated) {
  const maximumTrim = truncated ? Math.min(3, bytes.byteLength) : 0;
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    try {
      const value = bytes.subarray(0, bytes.byteLength - trim);
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(value), byteLength: value.byteLength };
    } catch {
      // A bounded prefix can end in the middle of one UTF-8 scalar. Only that
      // terminal scalar may be removed; other invalid UTF-8 remains invalid.
    }
  }
  return null;
}

export function sourceExcerpt(bytes, contentType, terms = [], options = {}) {
  const mediaType = normalizedSourceMediaType(contentType);
  const input = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Buffer.from(bytes || []);
  const responseByteLength = Number.isSafeInteger(options.responseByteLength) && options.responseByteLength >= input.byteLength
    ? options.responseByteLength
    : input.byteLength;
  if (!SOURCE_TEXT_MEDIA_TYPES.has(mediaType)) {
    return {
      excerpt: "",
      evidence: [],
      parseStatus: "unsupported-media-type",
      parseMediaType: mediaType || null,
      parseByteLength: 0,
      parseTruncated: false,
      canonicalCharacterLength: 0,
      canonicalTruncated: false,
      sentenceCandidateCount: 0,
      sentenceCandidatesTruncated: false,
      rankedCandidateCount: 0,
      rankedCandidatesTruncated: false
    };
  }
  const parsePrefix = input.subarray(0, SOURCE_CAPTURE_POLICY.maximumParseBytes);
  const prefixTruncated = responseByteLength > parsePrefix.byteLength;
  const decoded = decodeSourceUtf8Prefix(parsePrefix, prefixTruncated);
  if (!decoded) {
    return {
      excerpt: "",
      evidence: [],
      parseStatus: "invalid-utf8",
      parseMediaType: mediaType,
      parseByteLength: parsePrefix.byteLength,
      parseTruncated: prefixTruncated,
      canonicalCharacterLength: 0,
      canonicalTruncated: false,
      sentenceCandidateCount: 0,
      sentenceCandidatesTruncated: false,
      rankedCandidateCount: 0,
      rankedCandidatesTruncated: false
    };
  }
  const canonical = canonicalSourceText(decoded.text, mediaType);
  const ranking = rankEvidenceSpansBounded(canonical.text, terms);
  const ranked = ranking.ranked;
  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((existing) => nearDuplicateEvidence(candidate.quote, existing.quote))) continue;
    selected.push(candidate);
    if (selected.length >= SOURCE_CAPTURE_POLICY.maximumEvidence) break;
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
  return {
    excerpt: evidence.map((item) => item.quote).join(" … ").slice(0, 4000),
    evidence,
    parseStatus: "parsed",
    parseMediaType: mediaType,
    parseByteLength: decoded.byteLength,
    parseTruncated: responseByteLength > decoded.byteLength,
    canonicalCharacterLength: canonical.text.length,
    canonicalTruncated: canonical.truncated === true,
    malformedMarkupTruncated: canonical.malformedMarkupTruncated === true,
    jsonValid: canonical.jsonValid,
    jsonNodeCount: canonical.jsonNodeCount,
    jsonNodesTruncated: canonical.jsonNodesTruncated,
    jsonDepthTruncated: canonical.jsonDepthTruncated,
    sentenceCandidateCount: ranking.sentenceCandidateCount,
    sentenceCandidatesTruncated: ranking.sentenceCandidatesTruncated,
    rankedCandidateCount: ranked.length,
    rankedCandidatesTruncated: ranking.rankedCandidatesTruncated
  };
}
const MAX_SOURCE_BYTES = SOURCE_CAPTURE_POLICY.maximumResponseBytes;
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

function sourceCaptureError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

let activeSourceCaptures = 0;
const sourceCaptureWaiters = [];

function releaseSourceCapturePermit() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    while (sourceCaptureWaiters.length) {
      const waiter = sourceCaptureWaiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.resolve(releaseSourceCapturePermit());
      return;
    }
    activeSourceCaptures = Math.max(0, activeSourceCaptures - 1);
  };
}

export function sourceCaptureAdmissionState() {
  return { active: activeSourceCaptures, waiting: sourceCaptureWaiters.filter((waiter) => !waiter.settled).length };
}

export async function acquireSourceCapturePermit(options = {}) {
  const timeoutMs = options.timeoutMs ?? SOURCE_CAPTURE_POLICY.admissionWaitTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SOURCE_CAPTURE_POLICY.admissionWaitTimeoutMs) {
    throw new TypeError("출처 capture admission timeout이 올바르지 않습니다.");
  }
  if (activeSourceCaptures < SOURCE_CAPTURE_POLICY.maximumActiveCaptures) {
    activeSourceCaptures += 1;
    return releaseSourceCapturePermit();
  }
  if (sourceCaptureWaiters.filter((waiter) => !waiter.settled).length >= SOURCE_CAPTURE_POLICY.maximumWaitingCaptures) {
    throw sourceCaptureError("출처 capture 대기열이 가득 찼습니다.", "SOURCE_CAPTURE_ADMISSION_SATURATED");
  }
  return new Promise((resolvePermit, rejectPermit) => {
    const waiter = { settled: false, resolve: resolvePermit, timer: null };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = sourceCaptureWaiters.indexOf(waiter);
      if (index >= 0) sourceCaptureWaiters.splice(index, 1);
      rejectPermit(sourceCaptureError("출처 capture 실행 허가 시간이 초과되었습니다.", "SOURCE_CAPTURE_ADMISSION_TIMEOUT"));
    }, timeoutMs);
    sourceCaptureWaiters.push(waiter);
  });
}

function sourceResponseHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value == null ? null : String(value);
}

function declaredSourceResponseLength(headers) {
  const value = sourceResponseHeader(headers, "content-length");
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) throw sourceCaptureError("출처 응답 Content-Length가 올바르지 않습니다.", "SOURCE_CONTENT_LENGTH_INVALID");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw sourceCaptureError("출처 응답 Content-Length가 올바르지 않습니다.", "SOURCE_CONTENT_LENGTH_INVALID");
  if (length > MAX_SOURCE_BYTES) {
    throw sourceCaptureError(`출처 응답이 ${MAX_SOURCE_BYTES}바이트 제한을 초과했습니다.`, "SOURCE_RESPONSE_TOO_LARGE");
  }
  return length;
}

export function requestPinnedSource(url, address, signal, options = {}) {
  if (!(url instanceof URL) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    return Promise.reject(sourceCaptureError("출처 요청 URL 경계가 올바르지 않습니다.", "SOURCE_REQUEST_URL_INVALID"));
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    return Promise.reject(sourceCaptureError("출처 URL 포트는 80 또는 443만 허용합니다.", "SOURCE_REQUEST_PORT_BLOCKED"));
  }
  if (!isPublicSourceAddress(address)) {
    return Promise.reject(sourceCaptureError("출처 요청 주소가 공용 네트워크 주소가 아닙니다.", "SOURCE_REQUEST_ADDRESS_BLOCKED"));
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const requestModule = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHostname = normalizedSourceHost(url.hostname);
    let settled = false;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolveRequest(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      rejectRequest(error);
    };
    const requestOptions = {
      protocol: url.protocol,
      hostname: requestHostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "accept-encoding": "identity",
        "user-agent": "PS4-AI-Video-Studio/1.0 source-audit"
      },
      lookup(_hostname, options, callback) {
        const family = isIP(address);
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      ...(url.protocol === "https:" && !isIP(requestHostname) ? { servername: requestHostname } : {})
    };
    const requestFactory = options.requestFactory || ((input, callback) => requestModule(input, callback));
    const request = requestFactory(requestOptions, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.on?.("error", () => {});
        response.destroy?.();
        finishResolve({
          status,
          headers: response.headers || {},
          byteLength: 0,
          sha256: null,
          parseBytes: Buffer.alloc(0),
          parseTruncated: false,
          bodySkipped: true
        });
        return;
      }
      let declaredLength;
      try {
        declaredLength = declaredSourceResponseLength(response.headers || {});
        const contentEncoding = (sourceResponseHeader(response.headers || {}, "content-encoding") || "identity").trim().toLowerCase();
        if (contentEncoding !== "identity") {
          throw sourceCaptureError("압축된 출처 응답은 허용되지 않습니다.", "SOURCE_CONTENT_ENCODING_UNSUPPORTED");
        }
      } catch (error) {
        response.on?.("error", () => {});
        response.destroy?.();
        request.destroy?.();
        finishReject(error);
        return;
      }
      const parseChunks = [];
      let parseTotal = 0;
      let total = 0;
      let responseEnded = false;
      const digest = createHash("sha256");
      const responseMediaType = normalizedSourceMediaType(sourceResponseHeader(response.headers || {}, "content-type"));
      const retainParsePrefix = SOURCE_TEXT_MEDIA_TYPES.has(responseMediaType);
      response.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (!Number.isSafeInteger(total) || total > MAX_SOURCE_BYTES) {
          const error = sourceCaptureError(`출처 응답이 ${MAX_SOURCE_BYTES}바이트 제한을 초과했습니다.`, "SOURCE_RESPONSE_TOO_LARGE");
          finishReject(error);
          response.destroy?.();
          request.destroy?.();
          return;
        }
        digest.update(bytes);
        const remaining = retainParsePrefix ? SOURCE_CAPTURE_POLICY.maximumParseBytes - parseTotal : 0;
        if (remaining > 0) {
          const retained = bytes.subarray(0, remaining);
          parseChunks.push(retained);
          parseTotal += retained.byteLength;
        }
      });
      response.on("end", () => {
        if (settled) return;
        if (response.complete === false || (declaredLength !== null && declaredLength !== total)) {
          const error = sourceCaptureError("출처 응답이 완료되기 전에 연결이 종료되었습니다.", "SOURCE_RESPONSE_INCOMPLETE");
          finishReject(error);
          response.destroy?.(error);
          request.destroy?.(error);
          return;
        }
        responseEnded = true;
        finishResolve({
          status,
          headers: response.headers || {},
          byteLength: total,
          sha256: `sha256:${digest.digest("hex")}`,
          parseBytes: Buffer.concat(parseChunks, parseTotal),
          parseTruncated: total > parseTotal,
          bodySkipped: false
        });
      });
      response.on("error", finishReject);
      const rejectIncompleteResponse = () => {
        if (responseEnded || settled) return;
        const error = sourceCaptureError("출처 응답이 완료되기 전에 연결이 종료되었습니다.", "SOURCE_RESPONSE_INCOMPLETE");
        finishReject(error);
        request.destroy?.(error);
      };
      response.on("aborted", rejectIncompleteResponse);
      response.on("close", rejectIncompleteResponse);
    });

    const abort = () => request.destroy(sourceCaptureError("출처 요청이 취소되었습니다.", "SOURCE_REQUEST_ABORTED"));
    request.on("error", finishReject);
    request.setTimeout?.(options.requestTimeoutMs || SOURCE_CAPTURE_POLICY.requestTimeoutMs, () => {
      request.destroy(sourceCaptureError("출처 요청 시간이 초과되었습니다.", "SOURCE_REQUEST_TIMEOUT"));
    });
    if (signal?.aborted) abort();
    else if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => signal.removeEventListener("abort", abort));
    }
    request.end();
  });
}

function startTimedSourceLookup(hostname, lookupFn, timeoutMs) {
  const lookupPromise = Promise.resolve().then(() => lookupFn(hostname, { all: true, verbatim: true }));
  let resultSettled = false;
  let timer = null;
  const result = new Promise((resolveLookup, rejectLookup) => {
    timer = setTimeout(() => {
      if (resultSettled) return;
      resultSettled = true;
      rejectLookup(sourceCaptureError("출처 DNS 조회 시간이 초과되었습니다.", "SOURCE_DNS_TIMEOUT"));
    }, timeoutMs);
    lookupPromise.then((addresses) => {
      if (resultSettled) return;
      resultSettled = true;
      clearTimeout(timer);
      resolveLookup(addresses);
    }, (error) => {
      if (resultSettled) return;
      resultSettled = true;
      clearTimeout(timer);
      rejectLookup(error);
    });
  });
  const settled = lookupPromise.then(() => undefined, () => undefined).finally(() => clearTimeout(timer));
  return { result, settled };
}

function sourceCaptureTimestamp(options) {
  const value = (options.nowFn || (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export async function captureSource(source, topic = "", options = {}) {
  const normalized = typeof source === "string" ? { title: source, url: source } : { ...source };
  if (!normalized.url || !/^https?:\/\//i.test(normalized.url)) return { ...normalized, fetchStatus: "invalid" };
  let releasePermit = null;
  let permitReleaseDeferred = false;
  let requestTimeout = null;
  try {
    releasePermit = await acquireSourceCapturePermit({ timeoutMs: options.admissionTimeoutMs });
    const parsedUrl = new URL(normalized.url);
    if (parsedUrl.username || parsedUrl.password) throw new Error("출처 URL 인증 정보는 허용되지 않습니다.");
    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) throw new Error("출처 URL 포트는 80 또는 443만 허용합니다.");
    if (isPrivateSourceHost(parsedUrl.hostname)) throw new Error("비공개 네트워크 출처는 허용되지 않습니다.");
    const hostname = normalizedSourceHost(parsedUrl.hostname);
    let addresses;
    if (isIP(hostname)) {
      addresses = [{ address: hostname, family: isIP(hostname) }];
    } else {
      const lookupOperation = startTimedSourceLookup(
        hostname,
        options.lookupFn || lookup,
        options.dnsTimeoutMs || SOURCE_CAPTURE_POLICY.dnsTimeoutMs
      );
      try {
        addresses = await lookupOperation.result;
      } catch (error) {
        if (error?.code === "SOURCE_DNS_TIMEOUT") {
          permitReleaseDeferred = true;
          void lookupOperation.settled.finally(() => releasePermit?.());
        }
        throw error;
      }
    }
    const publicAddresses = validatePublicSourceAddresses(addresses);
    const publicAddress = publicAddresses[0];
    const controller = new AbortController();
    requestTimeout = setTimeout(() => controller.abort(), options.requestTimeoutMs || SOURCE_CAPTURE_POLICY.requestTimeoutMs);
    const requestSourceFn = options.requestSourceFn || requestPinnedSource;
    const response = await requestSourceFn(parsedUrl, publicAddress.address, controller.signal, options.requestOptions || {});
    if (response.status >= 300 && response.status < 400) return { ...normalized, fetchStatus: "redirect-blocked", httpStatus: response.status, error: "출처 리디렉션은 안전 검증을 위해 차단되었습니다.", fetchedAt: sourceCaptureTimestamp(options) };
    if (response.status < 200 || response.status >= 300) return { ...normalized, fetchStatus: "http-error", httpStatus: response.status, fetchedAt: sourceCaptureTimestamp(options) };
    const contentTypeHeader = (response.headers || {})["content-type"];
    const contentType = normalizedSourceMediaType(contentTypeHeader) || "application/octet-stream";
    const legacyBytes = response.bytes ? Buffer.from(response.bytes) : null;
    const parseBytes = response.parseBytes ? Buffer.from(response.parseBytes) : legacyBytes || Buffer.alloc(0);
    const byteLength = Number.isSafeInteger(response.byteLength) ? response.byteLength : legacyBytes?.byteLength || 0;
    const sha256 = /^sha256:[a-f0-9]{64}$/u.test(String(response.sha256 || ""))
      ? response.sha256
      : legacyBytes ? hashBytes(legacyBytes) : hashBytes(Buffer.alloc(0));
    const extracted = sourceExcerpt(parseBytes, contentType, sourceTerms(topic, normalized.title), { responseByteLength: byteLength });
    return {
      ...normalized,
      fetchStatus: "fetched",
      httpStatus: response.status,
      contentType,
      byteLength,
      sha256,
      resolvedAddress: publicAddress.address,
      resolvedFamily: publicAddress.family,
      excerpt: extracted.excerpt,
      evidence: extracted.evidence,
      parseStatus: extracted.parseStatus,
      parseMediaType: extracted.parseMediaType,
      parseByteLength: extracted.parseByteLength,
      parseTruncated: extracted.parseTruncated,
      canonicalCharacterLength: extracted.canonicalCharacterLength,
      canonicalTruncated: extracted.canonicalTruncated,
      malformedMarkupTruncated: extracted.malformedMarkupTruncated || false,
      jsonNodeCount: extracted.jsonNodeCount || 0,
      jsonNodesTruncated: extracted.jsonNodesTruncated || false,
      jsonDepthTruncated: extracted.jsonDepthTruncated || false,
      sentenceCandidateCount: extracted.sentenceCandidateCount,
      sentenceCandidatesTruncated: extracted.sentenceCandidatesTruncated,
      rankedCandidateCount: extracted.rankedCandidateCount,
      rankedCandidatesTruncated: extracted.rankedCandidatesTruncated,
      fetchedAt: sourceCaptureTimestamp(options)
    };
  } catch (error) {
    return {
      ...normalized,
      fetchStatus: error.message.includes("허용되지") || error.message.includes("제한을 초과") || error.message.includes("공용 네트워크") || error.message.includes("인증 정보") || error.message.includes("포트") || String(error?.code || "").startsWith("SOURCE_") ? "blocked" : "error",
      error: error.message,
      errorCode: error?.code || null,
      fetchedAt: sourceCaptureTimestamp(options)
    };
  } finally {
    if (requestTimeout) clearTimeout(requestTimeout);
    if (releasePermit && !permitReleaseDeferred) releasePermit();
  }
}

export async function captureSources(job, options = {}) {
  const sources = job.sources || [];
  if (sources.length > MAX_SOURCE_COUNT) throw new Error(`출처는 최대 ${MAX_SOURCE_COUNT}개까지 허용합니다.`);
  const records = [];
  for (let index = 0; index < sources.length; index += MAX_SOURCE_CONCURRENCY) {
    const batch = sources.slice(index, index + MAX_SOURCE_CONCURRENCY);
    records.push(...await Promise.all(batch.map((source) => captureSource(source, job.topic, options))));
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
  // Script construction is deliberately local and deterministic. Provider API
  // keys must never turn a video run into an implicit, separately billable text
  // request; callers can still inject a hermetic buildScript seam into runJob.
  const script = evidenceFallbackScript(job.topic, job.clipCount, job.sources, job.targetDurationSec, job.format);
  return applyShotPatternsToScript(script, job, await readShotPatternCatalog());
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

async function probeHasVideo(path) {
  const value = await commandOutput("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=index", "-of", "csv=p=0", path]);
  return Boolean(value.trim());
}

export const RENDER_OUTPUT_POLICY = Object.freeze({
  maximumVideoBytes: 1024 * 1024 * 1024,
  maximumAudioBytes: 64 * 1024 * 1024,
  maximumThumbnailBytes: 16 * 1024 * 1024,
  maximumVideoDurationSec: 180,
  maximumSpeechDurationSec: 300
});

const RENDER_ROOT_OUTPUT_NAMES = new Set([
  "assembled.mp4",
  "final.mp4",
  "thumbnail.jpg",
  "voiced.mp4",
  "voiceover.aiff",
  "voiceover-mastered.wav"
]);
const RENDER_VOICE_PART_PATTERN = /^voiceover-\d{2}(?:-calibrated|-padded)?\.aiff$/u;

function renderOutputLocation(jobDir, outputPath) {
  const canonicalJobDir = resolve(jobDir);
  const safeJobId = assertJobStorageId(basename(canonicalJobDir));
  if (canonicalJobDir !== join(JOBS_DIR, safeJobId)) throw new Error("렌더 산출물 job 경로가 canonical jobs root 밖입니다.");
  const canonicalOutput = resolve(outputPath);
  const name = basename(canonicalOutput);
  if (
    dirname(canonicalOutput) === canonicalJobDir
    && (RENDER_ROOT_OUTPUT_NAMES.has(name) || RENDER_VOICE_PART_PATTERN.test(name))
  ) return { canonicalJobDir, safeJobId, directoryName: null, name };
  if (dirname(canonicalOutput) === join(canonicalJobDir, "normalized") && /^\d{2}\.mp4$/u.test(name)) {
    return { canonicalJobDir, safeJobId, directoryName: "normalized", name };
  }
  throw new Error("렌더 산출물 경로가 허용된 job 저장 경계 밖입니다.");
}

async function withRenderOutputDirectory(jobDir, outputPath, callback) {
  const location = renderOutputLocation(jobDir, outputPath);
  const storage = await openExistingJobStorageStrict(location.safeJobId);
  let childFd = null;
  try {
    const directoryFd = location.directoryName
      ? (childFd = openDirectoryAt(storage.jobFd, location.directoryName))
      : storage.jobFd;
    if (location.directoryName && !statFd(directoryFd).isDirectory()) throw new Error("렌더 normalized 저장 경계가 디렉터리가 아닙니다.");
    const result = await callback(directoryFd, location);
    await assertExistingJobStorageCurrent(storage);
    return result;
  } finally {
    if (childFd !== null) closeFd(childFd);
    await closeExistingJobStorage(storage);
  }
}

export async function assertRenderOutputTargetReady(jobDir, outputPath) {
  return withRenderOutputDirectory(jobDir, outputPath, async (directoryFd, location) => {
    let existingFd = null;
    try {
      existingFd = openFileAt(directoryFd, location.name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw new Error(`렌더 산출물 대상이 안전한 빈 경로가 아닙니다 (${error.code || "unknown"}).`);
    } finally {
      if (existingFd !== null) closeFd(existingFd);
    }
    throw new Error(`렌더 산출물 대상 ${location.name}이 실행 전에 이미 존재합니다.`);
  });
}

export async function verifyRenderOutputFile(jobDir, outputPath, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > RENDER_OUTPUT_POLICY.maximumVideoBytes) {
    throw new TypeError("렌더 산출물 크기 상한이 올바르지 않습니다.");
  }
  return withRenderOutputDirectory(jobDir, outputPath, async (directoryFd, location) => {
    let fileFd = null;
    try {
      fileFd = openFileAt(directoryFd, location.name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const identity = statFd(fileFd);
      if (
        !identity.isFile()
        || identity.nlink !== 1n
        || identity.size <= 0n
        || identity.size > BigInt(maximumBytes)
      ) throw new Error(`렌더 산출물 ${location.name}이 bounded single-link regular file이 아닙니다.`);
      if (!samePathEntryIdentity(directoryFd, location.name, identity)) throw new Error(`렌더 산출물 ${location.name}이 검증 중 교체되었습니다.`);
      return { bytes: Number(identity.size), identity };
    } finally {
      if (fileFd !== null) closeFd(fileFd);
    }
  });
}

async function verifyRenderMediaOutput(jobDir, outputPath, {
  maximumBytes,
  maximumDurationSec,
  expectedDurationSec = null,
  durationToleranceSec = 0.75,
  requireAudio = false,
  requireVideo = false
}) {
  const file = await verifyRenderOutputFile(jobDir, outputPath, maximumBytes);
  const durationSec = await probeDuration(outputPath);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > maximumDurationSec) {
    throw new Error(`렌더 산출물 ${basename(outputPath)}의 길이가 허용 범위를 벗어났습니다.`);
  }
  if (
    Number.isFinite(expectedDurationSec)
    && Math.abs(durationSec - expectedDurationSec) > durationToleranceSec
  ) throw new Error(`렌더 산출물 ${basename(outputPath)}의 길이가 목표와 일치하지 않습니다.`);
  if (requireVideo && !(await probeHasVideo(outputPath))) throw new Error(`렌더 산출물 ${basename(outputPath)}에 영상 스트림이 없습니다.`);
  if (requireAudio && !(await probeHasAudio(outputPath))) throw new Error(`렌더 산출물 ${basename(outputPath)}에 오디오 스트림이 없습니다.`);
  const afterProbe = await verifyRenderOutputFile(jobDir, outputPath, maximumBytes);
  if (
    !sameFdIdentity(file.identity, afterProbe.identity)
    || file.identity.size !== afterProbe.identity.size
    || file.identity.mtimeNs !== afterProbe.identity.mtimeNs
    || file.identity.ctimeNs !== afterProbe.identity.ctimeNs
  ) throw new Error(`렌더 산출물 ${basename(outputPath)}이 media postcondition 검사 중 변경되었습니다.`);
  return { ...afterProbe, durationSec };
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
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) {
    throw new Error("동작 분석 프레임 수가 허용 범위를 벗어났습니다.");
  }
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
  ], {
    maximumOutputBytes: Math.min(
      RENDER_PROCESS_POLICY.binaryOutputBytes,
      CLIP_MOTION_POLICY.frameWidth * CLIP_MOTION_POLICY.frameHeight * maxFrames + 64 * 1024
    )
  });
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
  ], { maximumOutputBytes: 64 * 1024 });
  const hashes = [];
  for (let offset = 0; offset + 64 <= bytes.length; offset += 64) hashes.push(averageHash(bytes.subarray(offset, offset + 64)));
  if (!hashes.length) throw new Error(`영상 지문을 만들 수 없습니다: ${path}`);
  return { algorithm: "temporal-ahash-8x8-v1", durationSec: Number(duration.toFixed(3)), frames: hashes };
}

export async function createInputManifest(jobDir, runDir, jobId, runId, requestedNames = null, expectedCount = null, provider = "local", localClipImport = null) {
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
  let localClipImportBinding = null;
  if (provider === "local" && localClipImport) {
    if (
      !localClipImport
      || localClipImport.providerEvidenceEligible !== false
      || localClipImport.clipCount !== selected.length
      || !Array.isArray(localClipImport.entries)
      || localClipImport.entries.length !== selected.length
      || !/^sha256:[a-f0-9]{64}$/u.test(localClipImport.receiptHash || "")
      || !/^sha256:[a-f0-9]{64}$/u.test(localClipImport.setHash || "")
    ) throw new Error("수동 로컬 클립 import 영수증이 입력 manifest에 결속되지 않았습니다.");
    for (let index = 0; index < selected.length; index += 1) {
      const input = selected[index];
      const imported = localClipImport.entries[index];
      if (
        imported?.index !== index + 1
        || imported.storedName !== input.name
        || imported.bytes !== input.bytes
        || imported.sha256 !== input.sha256
      ) throw new Error(`수동 로컬 클립 ${index + 1}번이 import 영수증과 다릅니다.`);
    }
    localClipImportBinding = {
      schemaVersion: localClipImport.schemaVersion,
      source: localClipImport.source,
      providerEvidenceEligible: false,
      orderingPolicy: localClipImport.orderingPolicy,
      clipCount: localClipImport.clipCount,
      setHash: localClipImport.setHash,
      receiptHash: localClipImport.receiptHash
    };
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
    ...(localClipImportBinding ? { localClipImport: localClipImportBinding } : {}),
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
    await syncFileAndParent(target);
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
  await syncDirectory(snapshotRoot);
  return snapshots;
}
export async function snapshotBenchmarkFiles(runDir, runId, options = {}) {
  const snapshotRoot = join(runDir, "benchmarks");
  await mkdir(snapshotRoot, { recursive: true });
  const specs = options.specs || [
    { key: "channel", source: ANALYSIS_PATH, name: "channel-analysis.json" },
    { key: "duration", source: join(DATA_DIR, "shorts-metadata.json"), name: "shorts-metadata.json" },
    { key: "rlm", source: join(DATA_DIR, "rlm-benchmark-analysis.json"), name: "rlm-benchmark-analysis.json" }
  ];
  const readSnapshot = options.readFileFn || readFile;
  const snapshots = {};
  for (const spec of specs) {
    const target = join(snapshotRoot, spec.name);
    const relativePath = `runs/${runId}/benchmarks/${spec.name}`;
    try {
      // Parse, persist, and receipt the exact same source snapshot. Reading the
      // JSON and then copying its path would permit a parse-A/copy-B race.
      const bytes = await readSnapshot(spec.source);
      const payload = JSON.parse(bytes.toString("utf8"));
      await writeFile(target, bytes);
      await syncFileAndParent(target);
      const meta = spec.key === "channel"
        ? { expectedVideos: payload.snapshot?.totalVideos ?? payload.provenance?.completeness?.expectedVideos ?? null, shortsCount: payload.snapshot?.shorts ?? null, longVideosCount: payload.snapshot?.longVideos ?? null, sourceSnapshotAt: payload.snapshot?.capturedAt ?? null, population: "channel-all-videos" }
        : spec.key === "duration"
          ? { shortsCount: payload.snapshotVideoCount ?? payload.metadataCount ?? null, sourceSnapshotAt: payload.sourceSnapshotAt ?? null }
          : { shortsCount: payload.reduction?.inputCount ?? payload.sourceSnapshot?.shortsCount ?? null, sampleCount: payload.mediaEvidence?.sampleCount ?? 0, analyzedAt: payload.analyzedAt ?? null };
      snapshots[spec.key] = { ...meta, path: relativePath, sha256: hashBytes(bytes) };
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
  await syncDirectory(snapshotRoot);
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

async function normalizeClip(input, output, format, targetDuration = null, jobDir = dirname(output), maximumBytes = RENDER_OUTPUT_POLICY.maximumVideoBytes) {
  const size = format === "landscape" ? "1920:1080" : "1080:1920";
  const sourceDuration = await probeDuration(input);
  const duration = Number.isFinite(Number(targetDuration)) && Number(targetDuration) > 0 ? Number(targetDuration) : sourceDuration;
  if (!Number.isFinite(duration) || duration <= 0 || duration > RENDER_OUTPUT_POLICY.maximumVideoDurationSec) {
    throw new Error("정규화 목표 영상 길이가 허용 범위를 벗어났습니다.");
  }
  const hasAudio = await probeHasAudio(input);
  const videoRate = duration / sourceDuration;
  const framing = format === "landscape" ? `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black` : `scale=${size}:force_original_aspect_ratio=increase,crop=${size}:(iw-ow)/2:(ih-oh)/2`;
  const vf = `${framing},setsar=1${Math.abs(videoRate - 1) > 0.001 ? `,setpts=${videoRate.toFixed(6)}*PTS` : ""},fps=30`;
  const args = ["-y", "-i", input];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-t", String(duration), "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2");
  if (hasAudio && Math.abs(videoRate - 1) > 0.001) args.push("-af", atempoChain(1 / videoRate));
  if (!hasAudio) args.push("-map", "0:v:0", "-map", "1:a:0");
  args.push("-shortest", "-fs", String(maximumBytes), output);
  await assertRenderOutputTargetReady(jobDir, output);
  await runCommand("ffmpeg", args);
  const verified = await verifyRenderMediaOutput(jobDir, output, {
    maximumBytes,
    maximumDurationSec: RENDER_OUTPUT_POLICY.maximumVideoDurationSec,
    expectedDurationSec: duration,
    durationToleranceSec: 0.75,
    requireVideo: true,
    requireAudio: true
  });
  return verified.durationSec;
}

async function renderCaptions(input, output, captionsPath, format, jobDir, expectedDurationSec) {
  const size = format === "landscape" ? "1920:1080" : "1080:1920";
  const escaped = captionsPath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  const fontSize = format === "landscape" ? 18 : 20;
  const margin = format === "landscape" ? 56 : 140;
  const style = `FontName=Apple SD Gothic Neo,Bold=1,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${margin},WrapStyle=2,ScaledBorderAndShadow=yes`;
  await assertRenderOutputTargetReady(jobDir, output);
  await runCommand("ffmpeg", ["-y", "-i", input, "-vf", `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=black,subtitles=filename='${escaped}':force_style='${style}'`, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "copy", "-fs", String(RENDER_OUTPUT_POLICY.maximumVideoBytes), output]);
  return verifyRenderMediaOutput(jobDir, output, {
    maximumBytes: RENDER_OUTPUT_POLICY.maximumVideoBytes,
    maximumDurationSec: RENDER_OUTPUT_POLICY.maximumVideoDurationSec,
    expectedDurationSec,
    durationToleranceSec: 0.75,
    requireVideo: true,
    requireAudio: true
  });
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
      await assertRenderOutputTargetReady(jobDir, rawPath);
      await runCommand("say", [
        ...(configuredVoice ? ["-v", configuredVoice] : []),
        "-r", String(sayRate),
        "-o", rawPath,
        text
      ], { timeoutMs: RENDER_PROCESS_POLICY.speechTimeoutMs });
      const rawReceipt = await verifyRenderMediaOutput(jobDir, rawPath, {
        maximumBytes: RENDER_OUTPUT_POLICY.maximumAudioBytes,
        maximumDurationSec: RENDER_OUTPUT_POLICY.maximumSpeechDurationSec,
        requireAudio: true
      });
      const sourceDurationSec = rawReceipt.durationSec;
      if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) throw new Error(`${index + 1}번 장면 음성 길이를 확인할 수 없습니다.`);
      const atempoRate = sourceDurationSec > durationSec + 0.02 ? sourceDurationSec / Math.max(0.1, durationSec) : 1;
      let audioPath = rawPath;
      if (atempoRate > 1.001) {
        await assertRenderOutputTargetReady(jobDir, calibratedPath);
        await runCommand("ffmpeg", ["-y", "-i", rawPath, "-filter:a", atempoChain(atempoRate), "-c:a", "pcm_s16le", "-fs", String(RENDER_OUTPUT_POLICY.maximumAudioBytes), calibratedPath]);
        await verifyRenderMediaOutput(jobDir, calibratedPath, {
          maximumBytes: RENDER_OUTPUT_POLICY.maximumAudioBytes,
          maximumDurationSec: RENDER_OUTPUT_POLICY.maximumSpeechDurationSec,
          requireAudio: true
        });
        audioPath = calibratedPath;
      }
      const calibratedDurationSec = await probeDuration(audioPath);
      if (!Number.isFinite(calibratedDurationSec) || calibratedDurationSec > durationSec + 0.15) {
        throw new Error(`${index + 1}번 장면 음성을 목표 구간에 맞추지 못했습니다.`);
      }
      const captionDurationSec = Math.min(durationSec, calibratedDurationSec);
      const padDurationSec = Math.max(0, durationSec - calibratedDurationSec);
      await assertRenderOutputTargetReady(jobDir, paddedPath);
      await runCommand("ffmpeg", [
        "-y", "-i", audioPath,
        "-af", `apad=pad_dur=${padDurationSec.toFixed(3)},atrim=duration=${durationSec.toFixed(3)},asetpts=N/SR/TB`,
        "-c:a", "pcm_s16le", "-fs", String(RENDER_OUTPUT_POLICY.maximumAudioBytes), paddedPath
      ]);
      const paddedReceipt = await verifyRenderMediaOutput(jobDir, paddedPath, {
        maximumBytes: RENDER_OUTPUT_POLICY.maximumAudioBytes,
        maximumDurationSec: RENDER_OUTPUT_POLICY.maximumSpeechDurationSec,
        expectedDurationSec: durationSec,
        durationToleranceSec: 0.15,
        requireAudio: true
      });
      const paddedDurationSec = paddedReceipt.durationSec;
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
    await assertRenderOutputTargetReady(jobDir, voicePath);
    await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c:a", "pcm_s16le", "-fs", String(RENDER_OUTPUT_POLICY.maximumAudioBytes), voicePath]);
    await verifyRenderMediaOutput(jobDir, voicePath, {
      maximumBytes: RENDER_OUTPUT_POLICY.maximumAudioBytes,
      maximumDurationSec: RENDER_OUTPUT_POLICY.maximumSpeechDurationSec,
      expectedDurationSec: target,
      durationToleranceSec: 0.75,
      requireAudio: true
    });
    const masteredVoicePath = join(jobDir, "voiceover-mastered.wav");
    await assertRenderOutputTargetReady(jobDir, masteredVoicePath);
    await runCommand("ffmpeg", [
      "-y", "-i", voicePath,
      "-af", "loudnorm=I=-14:LRA=3.5:TP=-1.0:linear=false",
      "-c:a", "pcm_s16le", "-fs", String(RENDER_OUTPUT_POLICY.maximumAudioBytes), masteredVoicePath
    ]);
    const masteredReceipt = await verifyRenderMediaOutput(jobDir, masteredVoicePath, {
      maximumBytes: RENDER_OUTPUT_POLICY.maximumAudioBytes,
      maximumDurationSec: RENDER_OUTPUT_POLICY.maximumSpeechDurationSec,
      expectedDurationSec: target,
      durationToleranceSec: 0.75,
      requireAudio: true
    });
    const voiceoverDurationSec = masteredReceipt.durationSec;
    const audioMixPolicy = voiceoverAudioMixPolicy(target);
    await assertRenderOutputTargetReady(jobDir, output);
    const mixArgs = voiceoverMixFfmpegArgs(input, masteredVoicePath, output, target);
    mixArgs.splice(mixArgs.length - 1, 0, "-fs", String(RENDER_OUTPUT_POLICY.maximumVideoBytes));
    await runCommand("ffmpeg", mixArgs);
    await verifyRenderMediaOutput(jobDir, output, {
      maximumBytes: RENDER_OUTPUT_POLICY.maximumVideoBytes,
      maximumDurationSec: RENDER_OUTPUT_POLICY.maximumVideoDurationSec,
      expectedDurationSec: target,
      durationToleranceSec: 0.75,
      requireVideo: true,
      requireAudio: true
    });
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
  await cleanupOwnedMutableOutputFiles(jobDir, { clearNormalized: true });
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
    const normalizedMaximumBytes = Math.min(
      RENDER_OUTPUT_POLICY.maximumVideoBytes,
      32 * 1024 * 1024 + Math.ceil(RENDER_OUTPUT_POLICY.maximumVideoBytes * targetDuration / renderDuration)
    );
    const duration = await normalizeClip(input, output, job.format, targetDuration, jobDir, normalizedMaximumBytes);
    normalized.push(output);
    totalDuration += duration;
    await onProgress(58 + Math.round(((index + 1) / names.length) * 12), "편집", `${index + 1}/${names.length}개 클립 정리 완료`);
  }

  const listPath = join(jobDir, "concat.txt");
  await writeFile(listPath, normalized.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const assembled = join(jobDir, "assembled.mp4");
  await assertRenderOutputTargetReady(jobDir, assembled);
  await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-fs", String(RENDER_OUTPUT_POLICY.maximumVideoBytes), assembled]);
  const assembledReceipt = await verifyRenderMediaOutput(jobDir, assembled, {
    maximumBytes: RENDER_OUTPUT_POLICY.maximumVideoBytes,
    maximumDurationSec: RENDER_OUTPUT_POLICY.maximumVideoDurationSec,
    expectedDurationSec: renderDuration,
    durationToleranceSec: Math.max(0.75, names.length / 30),
    requireVideo: true,
    requireAudio: true
  });
  totalDuration = assembledReceipt.durationSec;

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
    await renderCaptions(audioVideo, finalPath, captionsPath, job.format, jobDir, totalDuration);
  } else {
    await assertRenderOutputTargetReady(jobDir, finalPath);
    await runCommand("ffmpeg", ["-y", "-i", audioVideo, "-c", "copy", "-fs", String(RENDER_OUTPUT_POLICY.maximumVideoBytes), finalPath]);
  }
  const finalReceipt = await verifyRenderMediaOutput(jobDir, finalPath, {
    maximumBytes: RENDER_OUTPUT_POLICY.maximumVideoBytes,
    maximumDurationSec: RENDER_OUTPUT_POLICY.maximumVideoDurationSec,
    expectedDurationSec: totalDuration,
    durationToleranceSec: 0.75,
    requireVideo: true,
    requireAudio: true
  });
  const finalDuration = finalReceipt.durationSec;

  const thumbnailPath = join(jobDir, "thumbnail.jpg");
  await assertRenderOutputTargetReady(jobDir, thumbnailPath);
  await runCommand("ffmpeg", ["-y", "-ss", "00:00:01", "-i", finalPath, "-frames:v", "1", "-q:v", "2", "-fs", String(RENDER_OUTPUT_POLICY.maximumThumbnailBytes), thumbnailPath]);
  await verifyRenderOutputFile(jobDir, thumbnailPath, RENDER_OUTPUT_POLICY.maximumThumbnailBytes);
  await onProgress(96, "검수", "최종 파일과 미리보기 이미지를 확인하는 중입니다.");
  return {
    warnings,
    artifacts: [
      { name: "final.mp4", kind: "video", url: mediaPath(job.id, "final.mp4") },
      { name: "captions.srt", kind: "captions", url: mediaPath(job.id, "captions.srt") },
      { name: "captions.vtt", kind: "caption-timing-estimate", url: mediaPath(job.id, "captions.vtt") },
      { name: "caption-timing.json", kind: "caption-timing", url: mediaPath(job.id, "caption-timing.json") },
      ...(job.voiceover ? [{ name: "voiceover-sync.json", kind: "voiceover-caption-sync", url: mediaPath(job.id, "voiceover-sync.json") }] : []),
      ...(job.voiceover ? [{ name: "voiceover-mastered.wav", kind: "voiceover-master", url: mediaPath(job.id, "voiceover-mastered.wav") }] : []),
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
const SEMANTIC_REVALIDATION_TRANSACTION = ".semantic-revalidation-transaction.json";
const SEMANTIC_REVALIDATION_INTERNAL_PREFIX = ".semantic-revalidation-";
const MAX_SEMANTIC_TRANSACTION_BYTES = 4 * 1024 * 1024;
const SEMANTIC_LEGACY_EVIDENCE_DIRECTORY = "legacy-gemini-evidence";
const SEMANTIC_LEGACY_EVIDENCE_LIMITS = new Map([
  ["abandoned-gemini-generation.json", 16 * 1024 * 1024],
  ["abandonment-receipt.json", 1024 * 1024]
]);
const SEMANTIC_REVALIDATION_PROTECTED_ENTRIES = new Set([
  "job.json",
  "runs",
  ".run.lock",
  "gemini-legacy-abandonment.json",
  SEMANTIC_REVALIDATION_TRANSACTION
]);

async function syncFileAndParent(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openRunPublicationRootStrict(path, label) {
  const pathIdentity = await lstat(path, { bigint: true });
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error(`${label}이 exact non-symlink directory가 아닙니다.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameFdIdentity(pathIdentity, identity)) {
      throw new Error(`${label}이 lstat과 fd open 사이에 교체되었습니다.`);
    }
    return { path, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertRunPublicationRootPinned(snapshot) {
  const current = await openRunPublicationRootStrict(snapshot.path, "run publication job directory");
  try {
    if (!sameFdIdentity(snapshot.identity, current.identity)) {
      throw new Error("run publication job directory가 처리 중 다른 inode로 교체되었습니다.");
    }
  } finally {
    await current.handle.close();
  }
}

export async function createRunDirectoryDurably(runDir, options = {}) {
  const trace = options.traceFn || (() => {});
  const syncPinnedDirectory = options.syncFdFn || ((fd) => syncFd(fd));
  const absoluteRunDir = resolve(runDir);
  const runsDir = dirname(absoluteRunDir);
  const jobDir = dirname(runsDir);
  const runName = basename(absoluteRunDir);
  const jobName = basename(jobDir);
  const jobsRoot = dirname(jobDir);
  if (
    basename(runsDir) !== "runs"
    || dirname(absoluteRunDir) !== runsDir
    || !runName
    || runName === "."
    || runName === ".."
  ) throw new Error("run publication 경로가 exact job/runs/<runId> 구조가 아닙니다.");

  const jobsRootSnapshot = await openRunPublicationRootStrict(jobsRoot, "run publication jobs root");
  let jobFd = null;
  let runsFd = null;
  let runFd = null;
  try {
    jobFd = openDirectoryAt(jobsRootSnapshot.handle.fd, jobName);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("run publication job entry가 directory가 아닙니다.");
    await options.afterJobPinned?.({ jobDir, jobIdentity });
    try {
      runsFd = openDirectoryAt(jobFd, "runs");
      trace({ operation: "open", path: runsDir });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirAt(jobFd, "runs", 0o700);
      trace({ operation: "mkdir", path: runsDir, options: { mode: 0o700 } });
      syncPinnedDirectory(jobFd, { path: jobDir });
      trace({ operation: "fsync", path: jobDir });
      runsFd = openDirectoryAt(jobFd, "runs");
    }
    const runsIdentity = statFd(runsFd);
    if (!runsIdentity.isDirectory()) throw new Error("run publication runs entry가 directory가 아닙니다.");
    await assertRunPublicationRootPinned(jobsRootSnapshot);
    await options.afterRunsPinned?.({ jobDir, runsDir, runDir: absoluteRunDir, runsIdentity });

    mkdirAt(runsFd, runName, 0o700);
    trace({ operation: "mkdir", path: absoluteRunDir, options: { mode: 0o700 } });
    await options.afterRunCreated?.({ jobDir, runsDir, runDir: absoluteRunDir });
    // fsync(runDir) persists future children, but only fsync(runsDir) makes the
    // dirfd-relative publication of the new run directory durable.
    syncPinnedDirectory(runsFd, { path: runsDir });
    trace({ operation: "fsync", path: runsDir });
    runFd = openDirectoryAt(runsFd, runName);
    if (!statFd(runFd).isDirectory()) throw new Error("published run entry가 directory가 아닙니다.");
    await assertRunPublicationRootPinned(jobsRootSnapshot);
    const currentJob = openDirectoryAt(jobsRootSnapshot.handle.fd, jobName);
    try {
      if (!sameFdIdentity(jobIdentity, statFd(currentJob))) {
        throw new Error("run publication job directory가 처리 중 다른 inode로 교체되었습니다.");
      }
      const currentRuns = openDirectoryAt(currentJob, "runs");
      try {
        if (!sameFdIdentity(runsIdentity, statFd(currentRuns))) {
          throw new Error("run publication runs directory가 처리 중 다른 inode로 교체되었습니다.");
        }
      } finally {
        closeFd(currentRuns);
      }
    } finally {
      closeFd(currentJob);
    }
  } finally {
    if (runFd !== null) closeFd(runFd);
    if (runsFd !== null) closeFd(runsFd);
    if (jobFd !== null) closeFd(jobFd);
    await jobsRootSnapshot.handle.close().catch(() => {});
  }
}

async function writeSemanticTransaction(jobDir, journal) {
  validatedSemanticTransaction(jobDir, journal);
  const path = join(jobDir, SEMANTIC_REVALIDATION_TRANSACTION);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const bytes = Buffer.from(JSON.stringify(journal, null, 2));
  if (bytes.byteLength > MAX_SEMANTIC_TRANSACTION_BYTES) {
    throw new Error("의미 재검수 transaction marker가 허용 크기를 초과했습니다.");
  }
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await syncFileAndParent(path);
  return path;
}

async function semanticMutableEntries(jobDir, options = {}) {
  const entries = (await readdir(jobDir, { withFileTypes: true }))
    .map((entry) => entry.name)
    .filter((name) => (
      !SEMANTIC_REVALIDATION_PROTECTED_ENTRIES.has(name)
      && (options.includeLegacyEvidence !== false || name !== SEMANTIC_LEGACY_EVIDENCE_DIRECTORY)
      && !name.startsWith(SEMANTIC_REVALIDATION_INTERNAL_PREFIX)
    ))
    .sort();
  for (const name of entries) safeSemanticRootEntry(jobDir, name);
  return entries;
}

function safeSemanticRootEntry(root, name) {
  if (
    typeof name !== "string"
    || !name
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || SEMANTIC_REVALIDATION_PROTECTED_ENTRIES.has(name)
    || name.startsWith(SEMANTIC_REVALIDATION_INTERNAL_PREFIX)
  ) throw new Error("의미 재검수 transaction journal의 root entry가 안전하지 않습니다.");
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, name);
  if (dirname(target) !== absoluteRoot) throw new Error("의미 재검수 transaction 경로가 job root를 벗어납니다.");
  return target;
}

function validatedSemanticLegacyJournal(value, mutableEntries) {
  if (value == null) {
    if (mutableEntries.includes(SEMANTIC_LEGACY_EVIDENCE_DIRECTORY)) {
      throw new Error("의미 재검수 transaction legacy evidence 선언이 없습니다.");
    }
    return null;
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "entries,previousPresent,required"
    || typeof value.required !== "boolean"
    || typeof value.previousPresent !== "boolean"
    || !Array.isArray(value.entries)
  ) throw new Error("의미 재검수 transaction legacy evidence 형식이 유효하지 않습니다.");
  const expectedNames = value.required ? [...SEMANTIC_LEGACY_EVIDENCE_LIMITS.keys()].sort() : [];
  const entries = value.entries.map((entry) => {
    const maximumBytes = SEMANTIC_LEGACY_EVIDENCE_LIMITS.get(entry?.name);
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "bytes,name,path,sha256"
      || entry.path !== `${SEMANTIC_LEGACY_EVIDENCE_DIRECTORY}/${entry.name}`
      || !maximumBytes
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 1
      || entry.bytes > maximumBytes
      || !/^sha256:[a-f0-9]{64}$/u.test(String(entry.sha256 || ""))
    ) throw new Error("의미 재검수 transaction legacy evidence entry가 유효하지 않습니다.");
    return { ...entry, maximumBytes };
  });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== expectedNames.length
    || names.some((name, index) => name !== expectedNames[index])
    || (value.previousPresent && !value.required)
    || value.previousPresent !== mutableEntries.includes(SEMANTIC_LEGACY_EVIDENCE_DIRECTORY)
  ) throw new Error("의미 재검수 transaction legacy evidence 집합이 root transaction과 일치하지 않습니다.");
  return { required: value.required, previousPresent: value.previousPresent, entries };
}

function validatedSemanticTransaction(jobDir, value) {
  const jobRoot = resolve(jobDir);
  const jobId = basename(jobRoot);
  const mutableEntries = Array.isArray(value?.mutableEntries) ? value.mutableEntries : [];
  const uniqueEntries = new Set(mutableEntries);
  const sourceRunIdValid = typeof value?.sourceRunId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{5,200}$/u.test(value.sourceRunId);
  const childRunIdValid = typeof value?.childRunId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{5,200}$/u.test(value.childRunId);
  const expectedBackupDir = childRunIdValid ? `.semantic-revalidation-backup-${value.childRunId}` : null;
  if (
    value?.schemaVersion !== 1
    || value.mode !== SEMANTIC_REVALIDATION_MODE
    || !["prepared", "installed", "committed", "rolled-back"].includes(value.phase)
    || value.jobId !== jobId
    || !sourceRunIdValid
    || !childRunIdValid
    || value.sourceRunId === value.childRunId
    || value.backupDir !== expectedBackupDir
    || uniqueEntries.size !== mutableEntries.length
    || !value.parentJob
    || value.parentJob.id !== value.jobId
    || value.parentJob.runId !== value.sourceRunId
    || typeof value.parentJobBytesBase64 !== "string"
    || !value.parentJobBytesBase64
    || !/^sha256:[a-f0-9]{64}$/u.test(String(value.parentJobBytesSha256 || ""))
    || (value.phase === "rolled-back"
      ? (typeof value.rolledBackAt !== "string" || !Number.isFinite(Date.parse(value.rolledBackAt)))
      : Object.hasOwn(value, "rolledBackAt"))
  ) throw new Error("의미 재검수 transaction journal 형식이 유효하지 않습니다.");
  for (const name of mutableEntries) safeSemanticRootEntry(jobDir, name);
  validatedSemanticLegacyJournal(value.legacyEvidence, mutableEntries);
  const parentJobBytes = Buffer.from(value.parentJobBytesBase64, "base64");
  if (
    parentJobBytes.toString("base64") !== value.parentJobBytesBase64
    || `sha256:${createHash("sha256").update(parentJobBytes).digest("hex")}` !== value.parentJobBytesSha256
  ) throw new Error("의미 재검수 rollback 원본 job 바이트 결속이 유효하지 않습니다.");
  let parentJobText;
  try {
    if (parentJobBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new Error("UTF-8 BOM");
    }
    parentJobText = new TextDecoder("utf-8", { fatal: true }).decode(parentJobBytes);
  } catch {
    throw new Error("의미 재검수 rollback 원본 job 바이트가 BOM 없는 올바른 UTF-8이 아닙니다.");
  }
  let decodedParentJob;
  try {
    decodedParentJob = JSON.parse(parentJobText);
  } catch {
    throw new Error("의미 재검수 rollback 원본 job JSON이 유효하지 않습니다.");
  }
  if (
    decodedParentJob.id !== value.jobId
    || decodedParentJob.runId !== value.sourceRunId
    || hashJson(decodedParentJob) !== hashJson(value.parentJob)
  ) throw new Error("의미 재검수 rollback의 원본 job 바이트가 journal과 일치하지 않습니다.");
  return { journal: value, parentJobBytes };
}

function sameSemanticMarkerStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameSemanticDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openSemanticDirectoryStrict(path, label, options = {}) {
  const lstatDirectory = options.lstatDirectoryFn || lstat;
  const openDirectory = options.openDirectoryFn || open;
  let pathIdentity;
  try {
    pathIdentity = await lstatDirectory(path, { bigint: true });
  } catch (error) {
    if (options.allowMissing === true && error?.code === "ENOENT") return null;
    throw new Error(`의미 재검수 ${label} directory를 lstat할 수 없습니다 (${error.message}).`);
  }
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) {
    throw new Error(`의미 재검수 ${label}이 exact non-symlink directory가 아닙니다.`);
  }
  let handle;
  try {
    handle = await openDirectory(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0)
    );
  } catch (error) {
    throw new Error(`의미 재검수 ${label} directory를 안전하게 열 수 없습니다 (${error.message}).`);
  }
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameSemanticDirectoryIdentity(pathIdentity, identity)) {
      throw new Error(`의미 재검수 ${label} directory가 lstat과 fd open 사이에 교체되었습니다.`);
    }
    return { path, handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openSemanticBackupDirectoryStrict(jobDir, journal, options = {}) {
  const jobRoot = resolve(jobDir);
  const backupPath = resolve(jobRoot, journal.backupDir);
  if (dirname(backupPath) !== jobRoot) throw new Error("의미 재검수 backup 경로가 job root를 벗어납니다.");
  const jobRootSnapshot = await openSemanticDirectoryStrict(jobRoot, "job root", options);
  let backupSnapshot;
  try {
    backupSnapshot = await openSemanticDirectoryStrict(backupPath, "backup", {
      ...options,
      openDirectoryFn: options.openBackupFn || options.openDirectoryFn,
      allowMissing: options.allowMissing
    });
  } catch (error) {
    await jobRootSnapshot.handle.close().catch(() => {});
    throw error;
  }
  if (!backupSnapshot) {
    await jobRootSnapshot.handle.close().catch(() => {});
    return null;
  }
  return {
    ...backupSnapshot,
    jobRootPath: jobRoot,
    jobRootHandle: jobRootSnapshot.handle,
    jobRootIdentity: jobRootSnapshot.identity
  };
}

async function closeSemanticBackupSnapshot(snapshot) {
  await snapshot?.handle.close().catch(() => {});
  await snapshot?.jobRootHandle.close().catch(() => {});
}

async function assertSemanticBackupDirectoryIdentity(snapshot, options = {}, operation = "mutation") {
  if (!snapshot) throw new Error("의미 재검수 backup directory snapshot이 없습니다.");
  if (typeof options.beforeBackupMutation === "function") {
    await options.beforeBackupMutation({ operation, path: snapshot.path });
  }
  const current = await openSemanticBackupDirectoryStrict(snapshot.jobRootPath, { backupDir: basename(snapshot.path) }, options);
  try {
    if (
      !sameSemanticDirectoryIdentity(snapshot.jobRootIdentity, current.jobRootIdentity)
      || !sameSemanticDirectoryIdentity(snapshot.identity, current.identity)
    ) {
      throw new Error("의미 재검수 backup directory가 복구 중 다른 inode로 교체되었습니다.");
    }
  } finally {
    await closeSemanticBackupSnapshot(current);
  }
}

export async function readSemanticTransactionStrict(jobDir, options = {}) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 transaction marker");
  let markerFd = null;
  try {
    await options.beforeMarkerOpen?.({ jobDir: resolve(jobDir), jobIdentity: job.jobIdentity });
    try {
      markerFd = openFileAt(job.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const currentJob = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 transaction marker 없음 확인");
      let currentMarkerFd = null;
      try {
        if (
          !sameFdIdentity(job.jobsRoot.identity, currentJob.jobsRoot.identity)
          || !sameFdIdentity(job.jobIdentity, currentJob.jobIdentity)
        ) throw new Error("의미 재검수 transaction marker 확인 중 canonical job ancestry가 교체되었습니다.");
        try {
          currentMarkerFd = openFileAt(currentJob.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        } catch (currentError) {
          if (currentError?.code === "ENOENT") return null;
          throw currentError;
        }
        throw new Error("의미 재검수 transaction marker가 없음 확인 중 게시되었습니다.");
      } finally {
        if (currentMarkerFd !== null) closeFd(currentMarkerFd);
        await closeCanonicalSemanticJobDirectory(currentJob);
      }
    }

    const before = statFd(markerFd);
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size > BigInt(MAX_SEMANTIC_TRANSACTION_BYTES)
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("의미 재검수 transaction marker가 bounded single-link regular file이 아닙니다.");
    }
    const bytes = readFdBuffer(markerFd, { maxBytes: MAX_SEMANTIC_TRANSACTION_BYTES });
    const after = statFd(markerFd);
    if (after.nlink !== 1n || !sameSemanticMarkerStat(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error("의미 재검수 transaction marker가 읽는 동안 변경되었습니다.");
    }

    const currentJob = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 transaction marker 게시 확인");
    let currentMarkerFd = null;
    try {
      if (
        !sameFdIdentity(job.jobsRoot.identity, currentJob.jobsRoot.identity)
        || !sameFdIdentity(job.jobIdentity, currentJob.jobIdentity)
      ) throw new Error("의미 재검수 transaction marker를 읽는 동안 canonical job ancestry가 교체되었습니다.");
      currentMarkerFd = openFileAt(currentJob.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const current = statFd(currentMarkerFd);
      if (!current.isFile() || current.nlink !== 1n || !sameSemanticMarkerStat(before, current)) {
        throw new Error("의미 재검수 transaction marker canonical path가 읽는 동안 교체되었습니다.");
      }
    } finally {
      if (currentMarkerFd !== null) closeFd(currentMarkerFd);
      await closeCanonicalSemanticJobDirectory(currentJob);
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("의미 재검수 transaction marker가 올바른 UTF-8이 아닙니다.");
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`의미 재검수 transaction marker JSON이 유효하지 않습니다 (${error.message}).`);
    }
    return validatedSemanticTransaction(jobDir, value).journal;
  } finally {
    if (markerFd !== null) closeFd(markerFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function advanceSemanticTransactionCas(jobDir, expectedJournal, nextJournal, options = {}) {
  const expected = validatedSemanticTransaction(jobDir, expectedJournal).journal;
  const next = validatedSemanticTransaction(jobDir, nextJournal).journal;
  const expectedHash = hashJson(expected);
  const disk = await readSemanticTransactionStrict(jobDir, options.markerReadOptions);
  if (!disk || hashJson(disk) !== expectedHash) {
    throw new Error("의미 재검수 transaction phase CAS의 expected marker hash가 canonical marker와 일치하지 않습니다.");
  }
  const bytes = Buffer.from(JSON.stringify(next, null, 2));
  if (bytes.byteLength > MAX_SEMANTIC_TRANSACTION_BYTES) {
    throw new Error("의미 재검수 transaction marker가 허용 크기를 초과했습니다.");
  }
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 transaction phase CAS");
  let markerFd = null;
  try {
    markerFd = openFileAt(job.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const identity = statFd(markerFd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size > BigInt(MAX_SEMANTIC_TRANSACTION_BYTES)) {
      throw new Error("의미 재검수 transaction phase CAS target이 bounded single-link regular file이 아닙니다.");
    }
    const currentBytes = readFdBuffer(markerFd, { maxBytes: MAX_SEMANTIC_TRANSACTION_BYTES });
    let current;
    try {
      current = validatedSemanticTransaction(
        jobDir,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes))
      ).journal;
    } catch (error) {
      throw new Error(`의미 재검수 transaction phase CAS target을 검증할 수 없습니다 (${error.message}).`);
    }
    if (hashJson(current) !== expectedHash) {
      throw new Error("의미 재검수 transaction phase CAS target hash가 expected marker와 일치하지 않습니다.");
    }
    replaceFileAt(job.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, bytes, {
      mode: 0o600,
      expectedIdentity: identity,
      afterTargetCheckedBeforeRename: () => {
        let currentFd = null;
        try {
          currentFd = openFileAt(job.jobFd, SEMANTIC_REVALIDATION_TRANSACTION, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
          const beforeReplace = statFd(currentFd);
          const beforeReplaceBytes = readFdBuffer(currentFd, { maxBytes: MAX_SEMANTIC_TRANSACTION_BYTES });
          const beforeReplaceJournal = validatedSemanticTransaction(
            jobDir,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(beforeReplaceBytes))
          ).journal;
          if (!sameSemanticMarkerStat(identity, beforeReplace) || hashJson(beforeReplaceJournal) !== expectedHash) {
            throw new Error("의미 재검수 transaction phase CAS target이 publication 직전 변경되었습니다.");
          }
        } finally {
          if (currentFd !== null) closeFd(currentFd);
        }
      }
    });
  } finally {
    if (markerFd !== null) closeFd(markerFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
  const published = await readSemanticTransactionStrict(jobDir, options.markerReadOptions);
  if (!published || hashJson(published) !== hashJson(next)) {
    throw new Error("의미 재검수 transaction phase CAS publication 검증에 실패했습니다.");
  }
  return published;
}

async function semanticEntryStatOrNull(path, statEntry = lstat) {
  try {
    return await statEntry(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function verifySemanticRolledBackParentJob(jobDir, expectedBytes) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 rolled-back parent job");
  let fileFd = null;
  try {
    fileFd = openFileAt(job.jobFd, "job.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const before = statFd(fileFd);
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size !== BigInt(expectedBytes.byteLength)
      || before.size > BigInt(MAX_JOB_JSON_BYTES)
    ) throw new Error("의미 재검수 rolled-back parent job.json이 bounded single-link regular file이 아닙니다.");
    const bytes = readFdBuffer(fileFd, { maxBytes: MAX_JOB_JSON_BYTES });
    const after = statFd(fileFd);
    if (!sameSemanticEvidenceFingerprint(before, after) || !bytes.equals(expectedBytes)) {
      throw new Error("의미 재검수 rolled-back parent job.json이 원본 exact bytes와 다릅니다.");
    }
    const current = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 rolled-back parent job 재확인");
    let currentFd = null;
    try {
      if (
        !sameFdIdentity(job.jobsRoot.identity, current.jobsRoot.identity)
        || !sameFdIdentity(job.jobIdentity, current.jobIdentity)
      ) throw new Error("의미 재검수 rolled-back parent job ancestry가 검증 중 교체되었습니다.");
      currentFd = openFileAt(current.jobFd, "job.json", fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      if (!sameSemanticEvidenceFingerprint(before, statFd(currentFd))) {
        throw new Error("의미 재검수 rolled-back parent job.json canonical path가 검증 중 교체되었습니다.");
      }
    } finally {
      if (currentFd !== null) closeFd(currentFd);
      await closeCanonicalSemanticJobDirectory(current);
    }
  } finally {
    if (fileFd !== null) closeFd(fileFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function cleanupSemanticTerminalTransaction({
  jobRoot,
  journal,
  backupSnapshot,
  options = {},
  action,
  removeBackupFn = rm,
  removeMarkerFn = unlink,
  syncDirectoryFn = syncDirectory
}) {
  const backupDir = resolve(jobRoot, journal.backupDir);
  const markerPath = join(jobRoot, SEMANTIC_REVALIDATION_TRANSACTION);
  const cleanupStep = async (operation, path) => {
    if (typeof options.onRecoveryCleanupStep === "function") {
      await options.onRecoveryCleanupStep({ operation, path });
    }
  };
  if (backupSnapshot) {
    await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `${action}-backup-remove`);
    await removeBackupFn(backupDir, { recursive: true, force: true });
    await cleanupStep("backup-remove", backupDir);
  }
  // The terminal marker remains durable until backup absence is durable. A
  // crash before this fsync may resurrect the backup, which terminal recovery
  // safely removes; a crash after it can only leave marker+no-backup.
  await syncDirectoryFn(jobRoot);
  await cleanupStep("backup-remove-directory-fsync", jobRoot);
  await cleanupStep("before-marker-remove", markerPath);
  await removeMarkerFn(markerPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await cleanupStep("marker-remove", markerPath);
  // Backup absence was made durable before marker unlink, so either outcome
  // of a crash around this second fsync is safe and idempotent.
  await syncDirectoryFn(jobRoot);
  await cleanupStep("marker-remove-directory-fsync", jobRoot);
  return { action, journal };
}

export async function rollbackSemanticRevalidationWorkspace(jobDir, suppliedJournal = null, options = {}) {
  const supplied = suppliedJournal ? validatedSemanticTransaction(jobDir, suppliedJournal) : null;
  const diskJournal = await readSemanticTransactionStrict(jobDir, options.markerReadOptions);
  if (!diskJournal) {
    if (supplied) throw new Error("의미 재검수 rollback의 canonical transaction marker가 없습니다.");
    return null;
  }
  const validated = validatedSemanticTransaction(jobDir, diskJournal);
  if (supplied && hashJson(supplied.journal) !== hashJson(validated.journal)) {
    throw new Error("의미 재검수 rollback의 supplied journal과 canonical marker가 일치하지 않습니다.");
  }
  const journal = validated?.journal || null;
  const legacyEvidence = validatedSemanticLegacyJournal(journal.legacyEvidence, journal.mutableEntries);
  const statEntry = options.statEntry || lstat;
  const removeRecoveryBackup = options.removeBackupFn || rm;
  const removeRecoveryMarker = options.removeMarkerFn || unlink;
  const syncRecoveryCleanupDirectory = options.syncCleanupDirectoryFn || syncDirectory;
  const cleanupStep = async (operation, path) => {
    if (typeof options.onRecoveryCleanupStep === "function") {
      await options.onRecoveryCleanupStep({ operation, path });
    }
  };
  const parentJobBytes = validated.parentJobBytes;
  const jobRoot = resolve(jobDir);
  const backupDir = resolve(jobRoot, journal.backupDir);
  if (dirname(backupDir) !== jobRoot) throw new Error("의미 재검수 backup 경로가 job root를 벗어납니다.");
  const backupSnapshot = await openSemanticBackupDirectoryStrict(jobRoot, journal, {
    ...options,
    allowMissing: ["committed", "rolled-back"].includes(journal.phase)
  });
  try {
    if (["committed", "rolled-back"].includes(journal.phase)) {
      if (journal.phase === "rolled-back") {
        await verifySemanticRolledBackParentJob(jobRoot, parentJobBytes);
      }
      if (legacyEvidence) {
        const expectedLegacyEvidencePresent = journal.phase === "committed"
          ? legacyEvidence.required
          : legacyEvidence.previousPresent;
        const terminalLegacyEvidence = await inspectCanonicalSemanticLegacyEvidence(
          jobRoot,
          legacyEvidence,
          `${journal.phase} child`,
          { allowMissing: !expectedLegacyEvidencePresent }
        );
        if (terminalLegacyEvidence.present !== expectedLegacyEvidencePresent) {
          throw new Error(`의미 재검수 ${journal.phase} legacy evidence 존재 상태가 terminal transaction과 일치하지 않습니다.`);
        }
      }
      return cleanupSemanticTerminalTransaction({
        jobRoot,
        journal,
        backupSnapshot,
        options,
        action: journal.phase === "committed" ? "committed-cleanup" : "rolled-back-cleanup",
        removeBackupFn: removeRecoveryBackup,
        removeMarkerFn: removeRecoveryMarker,
        syncDirectoryFn: syncRecoveryCleanupDirectory
      });
    }
    if (legacyEvidence) {
      const backupLegacyEvidence = await inspectSemanticLegacyEvidenceDirectoryFd(
        backupDir,
        backupSnapshot.handle.fd,
        legacyEvidence,
        "rollback backup",
        { allowMissing: true }
      );
      const currentLegacyEvidence = await inspectCanonicalSemanticLegacyEvidence(
        jobRoot,
        legacyEvidence,
        "rollback child",
        { allowMissing: true }
      );
      if (legacyEvidence.previousPresent && !backupLegacyEvidence.present && !currentLegacyEvidence.present) {
        throw new Error("의미 재검수 rollback legacy evidence 원본과 현재 산출물이 모두 없습니다.");
      }
    }
    // Resolve every backup/destination state before mutating anything. Only an
    // actual ENOENT means an entry is absent; EIO/EACCES and other unknown
    // failures must preserve the journal and backup for a later safe recovery.
    const rollbackEntries = [];
    for (const name of journal.mutableEntries) {
      const destination = safeSemanticRootEntry(jobRoot, name);
      const source = resolve(backupDir, name);
      if (dirname(source) !== backupDir) throw new Error("의미 재검수 backup entry가 backup root를 벗어납니다.");
      await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `inspect:${name}`);
      const sourceStat = await semanticEntryStatOrNull(source, statEntry);
      const destinationStat = await semanticEntryStatOrNull(destination, statEntry);
      if (sourceStat?.isSymbolicLink?.()) throw new Error(`의미 재검수 backup entry가 symlink입니다: ${name}`);
      if (!sourceStat && !destinationStat) throw new Error(`의미 재검수 rollback 원본과 현재 산출물이 모두 없습니다: ${name}`);
      rollbackEntries.push({ name, destination, source, sourceStat });
    }
    // Journals written before legacy evidence became transaction-managed omit
    // legacyEvidence. Preserve their formerly protected root during upgrade
    // recovery instead of treating it as an untracked child artifact.
    const currentEntries = await semanticMutableEntries(jobDir, { includeLegacyEvidence: legacyEvidence !== null });
    for (const name of currentEntries) {
      if (!journal.mutableEntries.includes(name)) {
        await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `remove-untracked:${name}`);
        await rm(safeSemanticRootEntry(jobRoot, name), { recursive: true, force: true });
      }
    }
    for (const { name, destination, source, sourceStat } of rollbackEntries) {
      if (sourceStat) {
        await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `remove-destination:${name}`);
        await rm(destination, { recursive: true, force: true });
        await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `restore:${name}`);
        const currentSourceStat = await semanticEntryStatOrNull(source, statEntry);
        if (
          !currentSourceStat
          || currentSourceStat.isSymbolicLink?.()
          || currentSourceStat.dev !== sourceStat.dev
          || currentSourceStat.ino !== sourceStat.ino
        ) throw new Error(`의미 재검수 backup entry inode가 복구 중 변경되었습니다: ${name}`);
        // Keep the directory identity check adjacent to the path-based rename.
        // Node does not expose renameat(2), so this is the final fail-closed
        // barrier against a backup-directory swap before consuming the source.
        await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `restore-immediate:${name}`);
        if (name === SEMANTIC_LEGACY_EVIDENCE_DIRECTORY) {
          await restoreSemanticLegacyEvidenceFromBackup(jobRoot, journal.backupDir, sourceStat, options);
        } else {
          await rename(source, destination);
        }
        await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, `restore-complete:${name}`);
      } else if (name === SEMANTIC_LEGACY_EVIDENCE_DIRECTORY && legacyEvidence?.previousPresent) {
        const current = await exactCanonicalSemanticLegacyEvidenceOrMissing(jobRoot, legacyEvidence, "partially restored");
        if (!current.present) {
          throw new Error("의미 재검수 partially restored legacy evidence current root가 없습니다.");
        }
      }
    }
    await syncDirectory(jobRoot);
    await backupSnapshot.handle.sync();
    await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, "post-restore-verification");
    for (const { name, destination, source } of rollbackEntries) {
      if (!(await semanticEntryStatOrNull(destination, statEntry))) {
        throw new Error(`의미 재검수 rollback 산출물이 없습니다: ${name}`);
      }
      if (await semanticEntryStatOrNull(source, statEntry)) throw new Error(`의미 재검수 rollback backup entry가 남아 있습니다: ${name}`);
    }
    const jobPath = join(jobDir, "job.json");
    const jobTemporary = `${jobPath}.${process.pid}.${Date.now()}.semantic-rollback.tmp`;
    await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, "write-parent-job-temp");
    await writeFile(jobTemporary, parentJobBytes);
    await assertSemanticBackupDirectoryIdentity(backupSnapshot, options, "publish-parent-job");
    await rename(jobTemporary, jobPath);
    await syncFileAndParent(jobPath);
    await verifySemanticRolledBackParentJob(jobRoot, parentJobBytes);
    const rolledBack = {
      ...journal,
      phase: "rolled-back",
      rolledBackAt: new Date().toISOString()
    };
    await advanceSemanticTransactionCas(jobRoot, journal, rolledBack, options);
    journal.phase = rolledBack.phase;
    journal.rolledBackAt = rolledBack.rolledBackAt;
    await cleanupStep("terminal-marker-durable", join(jobRoot, SEMANTIC_REVALIDATION_TRANSACTION));
    return cleanupSemanticTerminalTransaction({
      jobRoot,
      journal,
      backupSnapshot,
      options,
      action: "rolled-back",
      removeBackupFn: removeRecoveryBackup,
      removeMarkerFn: removeRecoveryMarker,
      syncDirectoryFn: syncRecoveryCleanupDirectory
    });
  } finally {
    await closeSemanticBackupSnapshot(backupSnapshot);
  }
}

export async function recoverSemanticRevalidationWorkspace(jobDir, suppliedJournal = null, options = {}) {
  return rollbackSemanticRevalidationWorkspace(jobDir, suppliedJournal, options);
}

export async function commitSemanticRevalidationWorkspace(jobDir, journal, options = {}) {
  const removeBackup = options.removeBackup || rm;
  const removeJournal = options.removeJournal || unlink;
  const validated = validatedSemanticTransaction(jobDir, journal);
  const legacyEvidence = validatedSemanticLegacyJournal(validated.journal.legacyEvidence, validated.journal.mutableEntries);
  const diskJournal = await readSemanticTransactionStrict(jobDir, options.markerReadOptions);
  if (!diskJournal || hashJson(diskJournal) !== hashJson(validated.journal)) {
    throw new Error("의미 재검수 commit의 supplied journal과 canonical marker가 일치하지 않습니다.");
  }
  const committed = { ...validated.journal, phase: "committed", committedAt: new Date().toISOString() };
  // Pin the exact non-symlink backup inode before advancing the durable
  // transaction marker. A replaced path must not turn committed cleanup into
  // removal of an unrelated directory.
  const backupSnapshot = await openSemanticBackupDirectoryStrict(jobDir, committed, options);
  try {
    if (legacyEvidence) {
      await inspectCanonicalSemanticLegacyEvidence(
        jobDir,
        legacyEvidence,
        "commit child",
        { allowMissing: !legacyEvidence.required }
      );
      const backupLegacyEvidence = await inspectSemanticLegacyEvidenceDirectoryFd(
        join(jobDir, committed.backupDir),
        backupSnapshot.handle.fd,
        legacyEvidence,
        "commit backup",
        { allowMissing: true }
      );
      if (legacyEvidence.previousPresent && !backupLegacyEvidence.present) {
        throw new Error("의미 재검수 commit의 parent legacy evidence backup이 없습니다.");
      }
    }
    await advanceSemanticTransactionCas(jobDir, validated.journal, committed, options);
    // The committed marker is the transaction point of no return. Cleanup is
    // idempotent and may be finished by startup recovery; it must never turn a
    // successfully sealed child into a parent rollback.
    const cleanupErrors = [];
    try {
      await cleanupSemanticTerminalTransaction({
        jobRoot: resolve(jobDir),
        journal: committed,
        backupSnapshot,
        options,
        action: "committed-cleanup",
        removeBackupFn: removeBackup,
        removeMarkerFn: removeJournal,
        syncDirectoryFn: options.syncCleanupDirectoryFn || syncDirectory
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      const backupPath = join(jobDir, committed.backupDir);
      const journalPath = join(jobDir, SEMANTIC_REVALIDATION_TRANSACTION);
      const markerPresent = await lstat(journalPath).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        cleanupErrors.push(error);
        return false;
      });
      const backupPresent = await lstat(backupPath).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        cleanupErrors.push(error);
        return false;
      });
      console.error(`semantic revalidation committed cleanup deferred: marker=${markerPresent} backup=${backupPresent}; ${cleanupErrors.map((error) => error.message).join("; ")}`);
    }
    return committed;
  } finally {
    await closeSemanticBackupSnapshot(backupSnapshot);
  }
}
function providerPolicy(provider) {
  if (provider === "gemini-browser") return "no-local-video-fallback";
  if (provider === "local-video") return "local-video-command-adapter-no-fallback";
  return "local-upload-edit";
}

const SEMANTIC_PREFLIGHT_PROVIDERS = new Set(["gemini-browser", "local-video"]);

export async function runProviderGenerationWithSemanticPreflight({
  provider,
  generate,
  preflight = preflightLocalSemanticVerifier,
  fetchImpl = fetch,
  environment = process.env,
  onReady = null
}) {
  if (typeof generate !== "function") throw new Error("provider generation callback이 필요합니다.");
  let semanticVerifier = null;
  if (SEMANTIC_PREFLIGHT_PROVIDERS.has(provider)) {
    semanticVerifier = await preflight({ fetchImpl, environment });
    if (semanticVerifier?.available !== true || semanticVerifier?.provider !== "loopback-omlx" || semanticVerifier?.model !== LOCAL_SEMANTIC_MODEL) {
      throw new Error("로컬 OMLX 의미 검증기 사전 점검 결과를 신뢰할 수 없습니다.");
    }
    if (typeof onReady === "function") await onReady(semanticVerifier);
  }
  return { semanticVerifier, generation: await generate() };
}

function entryIdentityAt(directoryFd, name, { directory = false } = {}) {
  const fd = directory
    ? openDirectoryAt(directoryFd, name)
    : openFileAt(directoryFd, name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const identity = statFd(fd);
    if (directory ? !identity.isDirectory() : !identity.isFile() || identity.nlink !== 1n) {
      throw new Error(`작업 mutable entry ${name}의 소유권 형태가 안전하지 않습니다.`);
    }
    return identity;
  } finally {
    closeFd(fd);
  }
}

function samePathEntryIdentity(directoryFd, name, expected, options = {}) {
  try {
    return sameFdIdentity(expected, entryIdentityAt(directoryFd, name, options));
  } catch {
    return false;
  }
}

async function pinRunCleanupStorage(jobDir, { clearClips, clearNormalized, clearQuality }) {
  const safeJobId = assertJobStorageId(basename(resolve(jobDir)));
  if (resolve(jobDir) !== join(JOBS_DIR, safeJobId)) throw new Error("실행 정리 작업 경로가 jobs root의 exact child가 아닙니다.");
  const jobsRoot = await openPlainDirectoryStrict(JOBS_DIR, "실행 정리 jobs root");
  let jobFd = null;
  const children = new Map();
  try {
    jobFd = openDirectoryAt(jobsRoot.handle.fd, safeJobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("실행 정리 작업 entry가 디렉터리가 아닙니다.");
    for (const [name, required] of [["clips", true], ["normalized", clearNormalized], ["quality", false]]) {
      let fd;
      try {
        fd = openDirectoryAt(jobFd, name);
      } catch (error) {
        if (error?.code === "ENOENT" && !required) {
          children.set(name, null);
          continue;
        }
        throw new Error(`실행 정리 ${name} 디렉터리가 exact non-symlink directory가 아닙니다 (${error.code || "unknown"}).`);
      }
      const identity = statFd(fd);
      if (!identity.isDirectory()) {
        closeFd(fd);
        throw new Error(`실행 정리 ${name} entry가 디렉터리가 아닙니다.`);
      }
      children.set(name, { fd, identity });
    }
    const currentJobFd = openDirectoryAt(jobsRoot.handle.fd, safeJobId);
    try {
      if (!sameFdIdentity(jobIdentity, statFd(currentJobFd))) throw new Error("실행 정리 작업 디렉터리가 선검증 중 교체되었습니다.");
      for (const [name, child] of children) {
        if (!child) continue;
        if (!samePathEntryIdentity(currentJobFd, name, child.identity, { directory: true })) {
          throw new Error(`실행 정리 ${name} 디렉터리가 선검증 중 교체되었습니다.`);
        }
      }
    } finally {
      closeFd(currentJobFd);
    }
    const rootEntries = await readdir(jobDir, { withFileTypes: true });
    const rootNames = new Set(rootEntries.map((entry) => entry.name));
    const inspectDirectoryFiles = async (name, enabled) => {
      if (!enabled || !children.get(name)) return [];
      const entries = await readdir(join(jobDir, name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink?.()) throw new Error(`실행 정리 ${name}/${entry.name}이 소유 regular file이 아닙니다.`);
        entryIdentityAt(children.get(name).fd, entry.name);
      }
      return entries.map((entry) => entry.name);
    };
    return {
      jobDir: resolve(jobDir),
      jobsRoot,
      jobFd,
      jobIdentity,
      children,
      rootEntries,
      rootNames,
      clipsNames: await inspectDirectoryFiles("clips", clearClips),
      normalizedNames: await inspectDirectoryFiles("normalized", clearNormalized),
      qualityNames: await inspectDirectoryFiles("quality", clearQuality)
    };
  } catch (error) {
    for (const child of children.values()) if (child) closeFd(child.fd);
    if (jobFd !== null) closeFd(jobFd);
    await jobsRoot.handle.close().catch(() => {});
    throw error;
  }
}

async function closeRunCleanupStorage(snapshot) {
  for (const child of snapshot?.children?.values?.() || []) if (child) closeFd(child.fd);
  if (snapshot?.jobFd != null) closeFd(snapshot.jobFd);
  await snapshot?.jobsRoot?.handle?.close?.().catch(() => {});
}

async function assertRunCleanupStoragePinned(snapshot, phase) {
  const currentRoot = await openPlainDirectoryStrict(JOBS_DIR, `실행 정리 jobs root (${phase})`);
  let currentJobFd = null;
  try {
    if (!sameFdIdentity(snapshot.jobsRoot.identity, currentRoot.identity)) throw new Error(`실행 정리 jobs root가 ${phase} 중 교체되었습니다.`);
    currentJobFd = openDirectoryAt(currentRoot.handle.fd, basename(resolve(snapshot.jobDir || "invalid")));
    if (!sameFdIdentity(snapshot.jobIdentity, statFd(currentJobFd))) throw new Error(`실행 정리 작업 디렉터리가 ${phase} 중 교체되었습니다.`);
    for (const [name, child] of snapshot.children) {
      if (!child) continue;
      if (!samePathEntryIdentity(currentJobFd, name, child.identity, { directory: true })) throw new Error(`실행 정리 ${name} 디렉터리가 ${phase} 중 교체되었습니다.`);
    }
  } finally {
    if (currentJobFd !== null) closeFd(currentJobFd);
    await currentRoot.handle.close();
  }
}

async function preflightRunMutableStorage(jobDir) {
  const snapshot = await pinRunCleanupStorage(jobDir, { clearClips: true, clearNormalized: true, clearQuality: true });
  try {
    entryIdentityAt(snapshot.jobFd, "job.json");
    const mutableRootNames = new Set([...MUTABLE_OUTPUTS, "gemini-generation.json"]);
    for (const entry of snapshot.rootEntries) {
      if (mutableRootNames.has(entry.name) || /^voiceover-\d{2}(?:-calibrated|-padded)?\.aiff$/.test(entry.name)) {
        entryIdentityAt(snapshot.jobFd, entry.name);
      }
    }
    await assertRunCleanupStoragePinned(snapshot, "실행 선검증");
  } finally {
    await closeRunCleanupStorage(snapshot);
  }
}

async function cleanupOwnedMutableOutputFiles(jobDir, {
  rootNames = new Set(),
  clearClips = false,
  clearNormalized = false,
  clearQuality = false,
  ensureNormalized = false
} = {}) {
  const snapshot = await pinRunCleanupStorage(jobDir, { clearClips, clearNormalized, clearQuality });
  try {
    const voiceoverParts = snapshot.rootEntries
      .map((entry) => entry.name)
      .filter((name) => /^voiceover-\d{2}(?:-calibrated|-padded)?\.aiff$/.test(name));
    const selectedRootNames = [...new Set([...rootNames, ...voiceoverParts])].filter((name) => snapshot.rootNames.has(name));
    for (const name of selectedRootNames) entryIdentityAt(snapshot.jobFd, name);
    await assertRunCleanupStoragePinned(snapshot, "삭제 직전");
    for (const name of selectedRootNames) {
      const identity = entryIdentityAt(snapshot.jobFd, name);
      if (!samePathEntryIdentity(snapshot.jobFd, name, identity)) throw new Error(`실행 정리 ${name}이 삭제 직전 교체되었습니다.`);
      unlinkAt(snapshot.jobFd, name);
    }
    const deleteDirectoryFiles = (childName, names, predicate = () => true) => {
      const child = snapshot.children.get(childName);
      if (!child) return;
      for (const name of names) {
        if (!predicate(name)) continue;
        const identity = entryIdentityAt(child.fd, name);
        if (!samePathEntryIdentity(child.fd, name, identity)) throw new Error(`실행 정리 ${childName}/${name}이 삭제 직전 교체되었습니다.`);
        unlinkAt(child.fd, name);
      }
      syncFd(child.fd);
    };
    if (clearClips) deleteDirectoryFiles("clips", snapshot.clipsNames, (name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()));
    if (clearNormalized) deleteDirectoryFiles("normalized", snapshot.normalizedNames);
    if (clearQuality) deleteDirectoryFiles("quality", snapshot.qualityNames);
    if (ensureNormalized && !snapshot.children.get("normalized")) throw new Error("실행 정리 normalized 디렉터리가 없습니다.");
    syncFd(snapshot.jobFd);
    await assertRunCleanupStoragePinned(snapshot, "삭제 완료");
  } finally {
    await closeRunCleanupStorage(snapshot);
  }
}

async function clearMutableOutputs(jobDir, preserveGemini = false, clearLocalVideoClips = false, preserveGeminiInputs = false) {
  const mutable = preserveGeminiInputs
    ? MUTABLE_OUTPUTS.filter((name) => !["script.json", "sources.json"].includes(name))
    : MUTABLE_OUTPUTS;
  const names = preserveGemini ? mutable : [...mutable, "gemini-generation.json"];
  await cleanupOwnedMutableOutputFiles(jobDir, {
    rootNames: new Set(names),
    clearClips: clearLocalVideoClips,
    clearNormalized: true,
    clearQuality: true,
    ensureNormalized: true
  });
}

export function shouldPreserveGeminiRecoveryArtifacts(previousGeneration, job = null) {
  const pendingOrPartial = ["failed", "running"].includes(previousGeneration?.status)
    && (
      (Array.isArray(previousGeneration?.segments) && previousGeneration.segments.length > 0)
      || Boolean(previousGeneration?.pendingSegment)
    );
  const interruptedAfterGeneration = previousGeneration?.status === "completed"
    && !previousGeneration?.pendingSegment
    && Array.isArray(previousGeneration?.segments)
    && previousGeneration.segments.length > 0
    && ["running", "failed"].includes(job?.status)
    && ["running", "failed"].includes(job?.runStatus)
    && job?.runId === previousGeneration.runId;
  return pendingOrPartial || interruptedAfterGeneration;
}

export async function inspectRunFailureMutationState(jobDir, runDir, jobId, runId) {
  const manifestPath = join(runDir, "manifest.json");
  let bytes;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", manifest: null };
    throw new Error(`run manifest 상태를 안전하게 읽을 수 없습니다 (${error.code || "unknown"}).`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { state: "blocked", manifest: null, reason: "malformed-manifest" };
  }
  if (manifest?.schemaVersion !== 1 || manifest.jobId !== jobId || manifest.runId !== runId) {
    return { state: "blocked", manifest, reason: "manifest-binding-mismatch" };
  }
  if (["completed", "needs-improvement"].includes(manifest.status)) {
    const expectedRunStatus = manifest.status === "completed" ? "verified" : "needs-improvement";
    if (
      manifest.runStatus !== expectedRunStatus
      || !Array.isArray(manifest.ledgerErrors)
      || manifest.ledgerErrors.length > 0
      || !Array.isArray(manifest.immutableArtifacts)
      || manifest.immutableArtifacts.length === 0
    ) return { state: "blocked", manifest, reason: "terminal-manifest-shape" };
    const seen = new Set();
    const root = resolve(jobDir);
    for (const artifact of manifest.immutableArtifacts) {
      const relativePath = String(artifact?.path || artifact?.name || "");
      const absolutePath = resolve(root, relativePath);
      if (
        !relativePath
        || relativePath.startsWith("/")
        || relativePath.includes("\\")
        || relativePath.split("/").includes("..")
        || !absolutePath.startsWith(`${root}/`)
        || seen.has(relativePath)
        || !Number.isInteger(Number(artifact?.bytes))
        || Number(artifact.bytes) < 0
        || !/^sha256:[a-f0-9]{64}$/u.test(String(artifact?.sha256 || ""))
      ) return { state: "blocked", manifest, reason: "terminal-artifact-declaration" };
      seen.add(relativePath);
      const metadata = await stat(absolutePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!metadata?.isFile() || metadata.size !== Number(artifact.bytes) || await hashFile(absolutePath) !== artifact.sha256) {
        return { state: "blocked", manifest, reason: "terminal-artifact-integrity" };
      }
    }
    return { state: "sealed-terminal", manifest };
  }
  if (manifest.status === "failed" && manifest.runStatus === "failed") return { state: "already-failed", manifest };
  if (
    (manifest.status === "running" && [undefined, null, "running"].includes(manifest.runStatus))
    || (manifest.status === "finalizing" && ["verified", "needs-improvement"].includes(manifest.runStatus))
  ) return { state: "recoverable", manifest };
  return { state: "blocked", manifest, reason: "unsupported-manifest-state" };
}

async function readGeminiRecoveryInputs(job, jobDir) {
  const generationPath = join(jobDir, "gemini-generation.json");
  let sourceGenerationBytes;
  try {
    sourceGenerationBytes = await readFile(generationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Gemini 복구 generation 영수증의 원본 바이트를 읽을 수 없습니다. 기존 산출물을 지우지 않습니다 (${error.message}).`);
  }
  const generation = await readGeminiGenerationReceipt(generationPath, {
    existsFn: () => true,
    readFileFn: async () => sourceGenerationBytes
  });
  if (!generation || !shouldPreserveGeminiRecoveryArtifacts(generation, job)) return null;
  const currentGenerationBytes = await readFile(generationPath).catch((error) => {
    throw new Error(`Gemini 복구 generation 영수증을 재확인할 수 없습니다. 기존 산출물을 지우지 않습니다 (${error.message}).`);
  });
  if (!sourceGenerationBytes.equals(currentGenerationBytes)) {
    throw new Error("Gemini 복구 generation 영수증이 읽는 동안 변경되었습니다. 기존 산출물을 지우지 않습니다.");
  }
  let sourceFile;
  let script;
  try {
    sourceFile = JSON.parse(await readFile(join(jobDir, "sources.json"), "utf8"));
    script = JSON.parse(await readFile(join(jobDir, "script.json"), "utf8"));
  } catch (error) {
    throw new Error(`Gemini 복구 입력을 읽을 수 없습니다. 기존 산출물을 지우지 않습니다 (${error.message}).`);
  }
  if (sourceFile?.jobId !== job.id || !Array.isArray(sourceFile.records)
    || !script || typeof script !== "object" || !Array.isArray(script.segments)
    || script.segments.length !== Number(job.clipCount)) {
    throw new Error("Gemini 복구 입력이 저장된 job·클립 수와 일치하지 않습니다. 기존 산출물을 지우지 않습니다.");
  }
  const evidenceCheck = verifyEvidenceBoundScript(script, sourceFile.records, job.clipCount, job.format);
  if (evidenceCheck.verified !== true) {
    throw new Error(`Gemini 복구 대본의 근거 결속을 확인할 수 없습니다. 기존 산출물을 지우지 않습니다 (${evidenceCheck.error || "binding mismatch"}).`);
  }
  return {
    generation,
    sourceBundle: {
      schemaVersion: sourceFile.schemaVersion,
      status: sourceFile.status,
      fetchedCount: sourceFile.fetchedCount,
      totalCount: sourceFile.totalCount,
      evidenceCount: sourceFile.evidenceCount,
      records: sourceFile.records
    },
    script,
    completedGenerationRunId: generation.status === "completed" ? generation.runId : null,
    sourceGenerationBytes,
    sourceGenerationPath: generationPath,
    sourceGenerationReceipt: {
      bytes: sourceGenerationBytes.byteLength,
      sha256: hashBytes(sourceGenerationBytes),
      sourceRunId: generation.runId,
      sourceGenerationHash: hashJson(generation)
    }
  };
}

export async function preserveGeminiSourceGenerationEvidence(jobDir, runDir, runId, recoveryInputs) {
  const source = recoveryInputs?.sourceGenerationReceipt;
  const bytes = recoveryInputs?.sourceGenerationBytes;
  if (!source || !Buffer.isBuffer(bytes)) return null;
  if (
    !String(runId || "")
    || source.sourceRunId !== recoveryInputs.generation?.runId
    || source.bytes !== bytes.byteLength
    || source.sha256 !== hashBytes(bytes)
    || source.sourceGenerationHash !== hashJson(recoveryInputs.generation)
    || !/^sha256:[a-f0-9]{64}$/u.test(source.sha256)
    || !/^sha256:[a-f0-9]{64}$/u.test(source.sourceGenerationHash)
  ) throw new Error("Gemini source generation 원본 영수증 결속이 유효하지 않습니다.");
  if (recoveryInputs.sourceGenerationPath) {
    const current = await readFile(recoveryInputs.sourceGenerationPath).catch((error) => {
      throw new Error(`Gemini source generation 원본을 보존 직전에 읽을 수 없습니다 (${error.message}).`);
    });
    if (!current.equals(bytes)) throw new Error("Gemini source generation 원본이 보존 직전에 변경되었습니다.");
  }
  const relativePath = geminiSourceGenerationEvidenceName(runId);
  const target = join(jobDir, relativePath);
  if (resolve(dirname(target)) !== resolve(join(runDir, "recovery"))) {
    throw new Error("Gemini source generation 보존 경로가 현재 run에 결속되지 않았습니다.");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700);
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  await syncFileAndParent(target);
  await syncDirectory(runDir);
  const preserved = await readFile(target);
  const preservedStat = await stat(target);
  if (!preserved.equals(bytes) || preservedStat.size !== source.bytes || hashBytes(preserved) !== source.sha256) {
    throw new Error("보존한 Gemini source generation 원본 바이트가 입력 영수증과 다릅니다.");
  }
  return {
    schemaVersion: 1,
    path: relativePath,
    bytes: source.bytes,
    sha256: source.sha256,
    sourceRunId: source.sourceRunId,
    sourceGenerationHash: source.sourceGenerationHash
  };
}

export async function assertGeminiRecoverySourceStillExact(recoveryInputs) {
  if (!recoveryInputs?.sourceGenerationReceipt) return true;
  const expected = recoveryInputs.sourceGenerationReceipt;
  const sourcePath = recoveryInputs.sourceGenerationPath;
  if (!sourcePath) throw new Error("Gemini 복구 source generation 경로가 없습니다.");
  const bytes = await readFile(sourcePath).catch((error) => {
    throw new Error(`Gemini 복구 source generation을 provider 실행 직전에 읽을 수 없습니다 (${error.message}).`);
  });
  if (bytes.byteLength !== expected.bytes || hashBytes(bytes) !== expected.sha256) {
    throw new Error("Gemini 복구 source generation이 provider 실행 직전에 변경되었습니다. 새 요청을 전송하지 않습니다.");
  }
  return true;
}

function exactSemanticPolicyBinding(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "hash,name,version"
    && value.name === LOCAL_SEMANTIC_POLICY_BINDING.name
    && value.version === LOCAL_SEMANTIC_POLICY_BINDING.version
    && value.hash === LOCAL_SEMANTIC_POLICY_BINDING.hash
  );
}

function semanticRevalidationExpectedArtifactPath(sourceRunId, name) {
  return `runs/${sourceRunId}/artifacts/${String(name).replace(/[^A-Za-z0-9._-]+/g, "__")}`;
}

async function readSemanticImmutableArtifactBytes(jobDir, artifact, readFileFn = readFile) {
  const path = join(jobDir, artifact.path);
  const bytes = await readFileFn(path).catch((error) => {
    throw new Error(`의미 재검수 원본 immutable 산출물을 읽을 수 없습니다: ${artifact.name} (${error.message})`);
  });
  if (bytes.byteLength !== Number(artifact.bytes) || hashBytes(bytes) !== artifact.sha256) {
    throw new Error(`의미 재검수 원본 immutable 산출물 무결성이 깨졌습니다: ${artifact.name}`);
  }
  return bytes;
}

async function pinCanonicalSemanticJobDirectory(jobDir, label) {
  const safeJobId = assertJobStorageId(basename(resolve(jobDir)));
  if (resolve(jobDir) !== join(JOBS_DIR, safeJobId)) {
    throw new Error(`${label} 경로가 jobs root의 exact child가 아닙니다.`);
  }
  const jobsRoot = await openPlainDirectoryStrict(JOBS_DIR, `${label} jobs root`);
  let jobFd = null;
  try {
    jobFd = openDirectoryAt(jobsRoot.handle.fd, safeJobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error(`${label} job entry가 directory가 아닙니다.`);
    return { safeJobId, jobsRoot, jobFd, jobIdentity };
  } catch (error) {
    if (jobFd !== null) closeFd(jobFd);
    await jobsRoot.handle.close();
    throw error;
  }
}

async function closeCanonicalSemanticJobDirectory(snapshot) {
  if (snapshot?.jobFd !== null && snapshot?.jobFd !== undefined) closeFd(snapshot.jobFd);
  await snapshot?.jobsRoot?.handle.close();
}

function sameSemanticEvidenceFingerprint(left, right) {
  return Boolean(left && right
    && sameFdIdentity(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function expectedSemanticLegacyEvidence(inputs) {
  const legacyNames = Array.isArray(inputs?.legacyNames) ? [...inputs.legacyNames] : [];
  if (legacyNames.length === 0) return { required: false, entries: [] };
  const exactPaths = [...SEMANTIC_LEGACY_EVIDENCE_LIMITS.keys()]
    .map((name) => `${SEMANTIC_LEGACY_EVIDENCE_DIRECTORY}/${name}`)
    .sort();
  if (
    legacyNames.length !== exactPaths.length
    || new Set(legacyNames).size !== legacyNames.length
    || [...legacyNames].sort().some((name, index) => name !== exactPaths[index])
  ) {
    throw new Error("의미 재검수 legacy Gemini evidence 경로 집합이 exact canonical pair가 아닙니다.");
  }
  const entries = exactPaths.map((path) => {
    const name = basename(path);
    const artifact = inputs.immutableByName?.get(path);
    const maximumBytes = SEMANTIC_LEGACY_EVIDENCE_LIMITS.get(name);
    if (
      !artifact
      || artifact.name !== path
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
      || artifact.bytes > maximumBytes
      || !/^sha256:[a-f0-9]{64}$/u.test(String(artifact.sha256 || ""))
    ) throw new Error(`의미 재검수 legacy Gemini evidence 선언이 bounded immutable artifact가 아닙니다: ${path}`);
    return { name, path, bytes: artifact.bytes, sha256: artifact.sha256, maximumBytes };
  });
  return { required: true, entries };
}

async function inspectSemanticLegacyEvidenceDirectoryFd(directoryPath, directoryFd, expected, label, options = {}) {
  let evidenceFd = null;
  try {
    try {
      evidenceFd = openDirectoryAt(directoryFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    } catch (error) {
      if (options.allowMissing === true && error?.code === "ENOENT") return { present: false, identity: null, leaves: [] };
      throw new Error(`의미 재검수 ${label} legacy evidence directory를 안전하게 열 수 없습니다 (${error.message}).`);
    }
    const identity = statFd(evidenceFd);
    if (!identity.isDirectory() || (identity.mode & 0o777n) !== 0o700n) {
      throw new Error(`의미 재검수 ${label} legacy evidence가 mode-0700 directory가 아닙니다.`);
    }
    const names = (await readdir(join(directoryPath, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY))).sort();
    const expectedNames = expected.entries.map((entry) => entry.name).sort();
    if (
      !expected.required
      || names.length !== expectedNames.length
      || names.some((name, index) => name !== expectedNames[index])
    ) throw new Error(`의미 재검수 ${label} legacy evidence에 foreign 또는 누락 entry가 있습니다.`);
    const leaves = [];
    for (const declaration of expected.entries) {
      let fd = null;
      try {
        try {
          fd = openFileAt(evidenceFd, declaration.name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        } catch (error) {
          throw new Error(`의미 재검수 ${label} legacy evidence leaf를 안전하게 열 수 없습니다: ${declaration.name} (${error.message}).`);
        }
        const before = statFd(fd);
        if (
          !before.isFile()
          || before.nlink !== 1n
          || (before.mode & 0o777n) !== 0o600n
          || before.size !== BigInt(declaration.bytes)
          || before.size > BigInt(declaration.maximumBytes)
        ) throw new Error(`의미 재검수 ${label} legacy evidence leaf가 bounded single-link regular file이 아닙니다: ${declaration.name}`);
        const bytes = readFdBuffer(fd, { maxBytes: declaration.maximumBytes });
        const after = statFd(fd);
        if (
          !sameSemanticEvidenceFingerprint(before, after)
          || bytes.byteLength !== declaration.bytes
          || hashBytes(bytes) !== declaration.sha256
        ) throw new Error(`의미 재검수 ${label} legacy evidence leaf가 immutable 선언과 다릅니다: ${declaration.name}`);
        leaves.push({ ...declaration, identity: before });
      } finally {
        if (fd !== null) closeFd(fd);
      }
    }
    return { present: true, identity, leaves };
  } finally {
    if (evidenceFd !== null) closeFd(evidenceFd);
  }
}

async function inspectCanonicalSemanticLegacyEvidence(jobDir, expected, label, options = {}) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, `${label} legacy evidence`);
  try {
    const snapshot = await inspectSemanticLegacyEvidenceDirectoryFd(jobDir, job.jobFd, expected, label, options);
    const current = await pinCanonicalSemanticJobDirectory(jobDir, `${label} legacy evidence 재확인`);
    try {
      if (
        !sameFdIdentity(job.jobsRoot.identity, current.jobsRoot.identity)
        || !sameFdIdentity(job.jobIdentity, current.jobIdentity)
      ) throw new Error(`의미 재검수 ${label} legacy evidence 검사 중 canonical job ancestry가 교체되었습니다.`);
      const verified = await inspectSemanticLegacyEvidenceDirectoryFd(jobDir, current.jobFd, expected, `${label} 재확인`, options);
      if (
        snapshot.present !== verified.present
        || (snapshot.present && (
          !sameFdIdentity(snapshot.identity, verified.identity)
          || snapshot.leaves.some((leaf, index) => !sameSemanticEvidenceFingerprint(leaf.identity, verified.leaves[index]?.identity))
        ))
      ) throw new Error(`의미 재검수 ${label} legacy evidence가 검사 중 교체되었습니다.`);
    } finally {
      await closeCanonicalSemanticJobDirectory(current);
    }
    return snapshot;
  } finally {
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function exactCanonicalSemanticLegacyEvidenceOrMissing(jobDir, expected, label) {
  try {
    return await inspectCanonicalSemanticLegacyEvidence(jobDir, expected, label, { allowMissing: true });
  } catch (error) {
    throw new Error(`의미 재검수 ${label} legacy evidence current root를 exact 검증할 수 없습니다 (${error.message}).`);
  }
}

async function inspectStagedSemanticLegacyEvidence(stagingDir, expected) {
  const staging = await openSemanticDirectoryStrict(stagingDir, "legacy evidence staging");
  try {
    return await inspectSemanticLegacyEvidenceDirectoryFd(stagingDir, staging.handle.fd, expected, "staging", { allowMissing: false });
  } finally {
    await staging.handle.close();
  }
}

async function moveSemanticLegacyEvidenceToBackup(jobDir, backupName, expectedIdentity) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 legacy evidence backup");
  let backupFd = null;
  let evidenceFd = null;
  let backedUpFd = null;
  try {
    backupFd = openDirectoryAt(job.jobFd, backupName);
    evidenceFd = openDirectoryAt(job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    const currentIdentity = statFd(evidenceFd);
    if (!currentIdentity.isDirectory() || !sameFdIdentity(expectedIdentity, currentIdentity)) {
      throw new Error("의미 재검수 legacy evidence가 backup 직전 교체되었습니다.");
    }
    renameAt(job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY, backupFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    syncFd(backupFd);
    syncFd(job.jobFd);
    backedUpFd = openDirectoryAt(backupFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    if (!sameFdIdentity(expectedIdentity, statFd(backedUpFd))) {
      throw new Error("의미 재검수 legacy evidence가 exact backup inode로 이동되지 않았습니다.");
    }
  } finally {
    if (backedUpFd !== null) closeFd(backedUpFd);
    if (evidenceFd !== null) closeFd(evidenceFd);
    if (backupFd !== null) closeFd(backupFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function installStagedSemanticLegacyEvidence(jobDir, stagingDir, expectedIdentity) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 legacy evidence install");
  const staging = await openSemanticDirectoryStrict(stagingDir, "legacy evidence staging install");
  let evidenceFd = null;
  try {
    evidenceFd = openDirectoryAt(staging.handle.fd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    if (!sameFdIdentity(expectedIdentity, statFd(evidenceFd))) {
      throw new Error("의미 재검수 staging legacy evidence가 install 직전 교체되었습니다.");
    }
    renameAt(staging.handle.fd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY, job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    syncFd(job.jobFd);
    const installed = openDirectoryAt(job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    try {
      syncFd(installed);
      if (!sameFdIdentity(expectedIdentity, statFd(installed))) {
        throw new Error("의미 재검수 child legacy evidence가 exact staging inode로 게시되지 않았습니다.");
      }
    } finally {
      closeFd(installed);
    }
  } finally {
    if (evidenceFd !== null) closeFd(evidenceFd);
    await staging.handle.close();
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function restoreSemanticLegacyEvidenceFromBackup(jobDir, backupName, expectedSourceStat, options = {}) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 legacy evidence restore");
  let backupFd = null;
  let sourceFd = null;
  let restoredFd = null;
  try {
    backupFd = openDirectoryAt(job.jobFd, backupName);
    sourceFd = openDirectoryAt(backupFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    const sourceIdentity = statFd(sourceFd);
    if (
      !sourceIdentity.isDirectory()
      || sourceIdentity.dev !== BigInt(expectedSourceStat.dev)
      || sourceIdentity.ino !== BigInt(expectedSourceStat.ino)
    ) throw new Error("의미 재검수 backup legacy evidence inode가 restore 직전 변경되었습니다.");
    renameAt(backupFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY, job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    syncFd(job.jobFd);
    syncFd(backupFd);
    restoredFd = openDirectoryAt(job.jobFd, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
    if (!sameFdIdentity(sourceIdentity, statFd(restoredFd))) {
      throw new Error("의미 재검수 parent legacy evidence가 exact backup inode로 복구되지 않았습니다.");
    }
    await options.afterLegacyEvidenceRestore?.({ jobDir, backupName, identity: sourceIdentity });
  } finally {
    if (restoredFd !== null) closeFd(restoredFd);
    if (sourceFd !== null) closeFd(sourceFd);
    if (backupFd !== null) closeFd(backupFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function semanticParentNormalizedIdentity(jobDir) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 parent normalized");
  let normalizedFd = null;
  try {
    normalizedFd = openDirectoryAt(job.jobFd, "normalized");
    const identity = statFd(normalizedFd);
    if (!identity.isDirectory()) throw new Error("의미 재검수 parent normalized가 directory가 아닙니다.");
    return identity;
  } finally {
    if (normalizedFd !== null) closeFd(normalizedFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function createSemanticChildNormalizedDirectory(jobDir, backupName, parentNormalizedIdentity, options = {}) {
  const job = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 child normalized");
  let backupFd = null;
  let backupNormalizedFd = null;
  let normalizedFd = null;
  try {
    backupFd = openDirectoryAt(job.jobFd, backupName);
    backupNormalizedFd = openDirectoryAt(backupFd, "normalized");
    const backupNormalizedIdentity = statFd(backupNormalizedFd);
    if (!backupNormalizedIdentity.isDirectory() || !sameFdIdentity(parentNormalizedIdentity, backupNormalizedIdentity)) {
      throw new Error("의미 재검수 parent normalized가 exact backup inode로 이동되지 않았습니다.");
    }

    await options.beforeNormalizedCreate?.({ jobDir, jobIdentity: job.jobIdentity, backupNormalizedIdentity });
    const currentBeforeCreate = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 child normalized 재확인");
    try {
      if (
        !sameFdIdentity(job.jobsRoot.identity, currentBeforeCreate.jobsRoot.identity)
        || !sameFdIdentity(job.jobIdentity, currentBeforeCreate.jobIdentity)
      ) {
        throw new Error("의미 재검수 child job root가 normalized 생성 전에 교체되었습니다.");
      }
    } finally {
      await closeCanonicalSemanticJobDirectory(currentBeforeCreate);
    }

    mkdirAt(job.jobFd, "normalized", 0o700);
    normalizedFd = openDirectoryAt(job.jobFd, "normalized");
    const normalizedIdentity = statFd(normalizedFd);
    if (
      !normalizedIdentity.isDirectory()
      || normalizedIdentity.nlink < 1n
      || (normalizedIdentity.mode & 0o777n) !== 0o700n
    ) {
      throw new Error("의미 재검수 child normalized가 mode-0700 directory가 아닙니다.");
    }
    if ((await readdir(join(jobDir, "normalized"))).length !== 0) {
      throw new Error("의미 재검수 child normalized가 생성 직후 비어 있지 않습니다.");
    }
    syncFd(normalizedFd);
    syncFd(job.jobFd);

    const currentAfterCreate = await pinCanonicalSemanticJobDirectory(jobDir, "의미 재검수 child normalized 게시 확인");
    let currentNormalizedFd = null;
    try {
      if (
        !sameFdIdentity(job.jobsRoot.identity, currentAfterCreate.jobsRoot.identity)
        || !sameFdIdentity(job.jobIdentity, currentAfterCreate.jobIdentity)
      ) {
        throw new Error("의미 재검수 child job root가 normalized 게시 중 교체되었습니다.");
      }
      currentNormalizedFd = openDirectoryAt(currentAfterCreate.jobFd, "normalized");
      const currentNormalizedIdentity = statFd(currentNormalizedFd);
      if (
        !sameFdIdentity(normalizedIdentity, currentNormalizedIdentity)
        || normalizedIdentity.nlink !== currentNormalizedIdentity.nlink
      ) {
        throw new Error("의미 재검수 child normalized가 게시 확인 중 교체되었습니다.");
      }
    } finally {
      if (currentNormalizedFd !== null) closeFd(currentNormalizedFd);
      await closeCanonicalSemanticJobDirectory(currentAfterCreate);
    }
  } finally {
    if (normalizedFd !== null) closeFd(normalizedFd);
    if (backupNormalizedFd !== null) closeFd(backupNormalizedFd);
    if (backupFd !== null) closeFd(backupFd);
    await closeCanonicalSemanticJobDirectory(job);
  }
}

async function verifySemanticRevalidationImmutableArtifacts(jobDir, sourceRunId, manifest, options = {}) {
  const artifacts = Array.isArray(manifest?.immutableArtifacts) ? manifest.immutableArtifacts : [];
  if (!artifacts.length || new Set(artifacts.map((artifact) => artifact?.name)).size !== artifacts.length) {
    throw new Error("의미 재검수 원본의 immutable 산출물 선언이 비어 있거나 중복됩니다.");
  }
  const byName = new Map();
  const jsonBytesByName = new Map();
  const readArtifact = options.readFileFn || readFile;
  for (const artifact of artifacts) {
    const expectedPath = semanticRevalidationExpectedArtifactPath(sourceRunId, artifact?.name);
    const legacyLeafName = String(artifact?.name || "").startsWith(`${SEMANTIC_LEGACY_EVIDENCE_DIRECTORY}/`)
      ? String(artifact.name).slice(SEMANTIC_LEGACY_EVIDENCE_DIRECTORY.length + 1)
      : null;
    const legacyMaximumBytes = legacyLeafName ? SEMANTIC_LEGACY_EVIDENCE_LIMITS.get(legacyLeafName) : null;
    if (!artifact?.name || artifact.path !== expectedPath || !/^sha256:[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))) {
      throw new Error(`의미 재검수 원본의 immutable 산출물 경로·해시 선언이 유효하지 않습니다: ${artifact?.name || "unknown"}`);
    }
    if (legacyLeafName && (
      !legacyMaximumBytes
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
      || artifact.bytes > legacyMaximumBytes
    )) throw new Error(`의미 재검수 legacy Gemini evidence immutable 선언이 bounded canonical leaf가 아닙니다: ${artifact.name}`);
    const bytes = await readSemanticImmutableArtifactBytes(jobDir, artifact, readArtifact);
    byName.set(artifact.name, artifact);
    if (String(artifact.name).endsWith(".json")) jsonBytesByName.set(artifact.name, bytes);
  }
  return { byName, jsonBytesByName };
}

/**
 * Reads a sealed source run exclusively through its immutable copies. This is
 * intentionally independent from the mutable job root so a revalidation never
 * turns a stale mutable file into new provenance.
 */
export async function readGeminiSemanticRevalidationInputs(job, jobDir, context, options = {}) {
  const sourceRunId = String(context?.sourceRunId || "");
  const sourceManifestPath = `runs/${sourceRunId}/manifest.json`;
  if (
    context?.schemaVersion !== 1
    || context?.mode !== SEMANTIC_REVALIDATION_MODE
    || job?.provider !== "gemini-browser"
    || job?.status !== "needs-improvement"
    || job?.runStatus !== "needs-improvement"
    || job?.runId !== sourceRunId
    || !sourceRunId
    || context?.sourceManifest?.path !== sourceManifestPath
    || context?.sourceManifest?.status !== "needs-improvement"
    || context?.sourceManifest?.runStatus !== "needs-improvement"
    || !/^sha256:[a-f0-9]{64}$/.test(String(context?.sourceManifest?.sha256 || ""))
    || context?.providerRequestPolicy?.allowed !== false
    || context?.providerRequestPolicy?.maximumCalls !== 0
    || Object.keys(context.providerRequestPolicy).sort().join(",") !== "allowed,maximumCalls"
    || !exactSemanticPolicyBinding(context?.semanticPolicy)
  ) {
    throw new Error("의미 재검수 요청이 현재 봉인 run·provider 0회 정책·semantic policy에 정확히 결속되지 않았습니다.");
  }
  const manifestPath = join(jobDir, sourceManifestPath);
  const readSource = options.readFileFn || readFile;
  const manifestBytes = await readSource(manifestPath).catch((error) => {
    throw new Error(`의미 재검수 원본 manifest를 읽을 수 없습니다 (${error.message}).`);
  });
  if (hashBytes(manifestBytes) !== context.sourceManifest.sha256) {
    throw new Error("의미 재검수 원본 manifest 해시가 요청과 다릅니다.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`의미 재검수 원본 manifest를 읽을 수 없습니다 (${error.message}).`);
  }
  if (
    manifest?.jobId !== job.id
    || manifest.runId !== sourceRunId
    || manifest.status !== "needs-improvement"
    || manifest.runStatus !== "needs-improvement"
    || !Array.isArray(manifest.ledgerErrors)
    || manifest.ledgerErrors.length !== 0
    || manifest.request?.provider !== "gemini-browser"
    || manifest.providerDecision?.requested !== "gemini-browser"
    || manifest.providerDecision?.selected !== "gemini-browser"
    || manifest.providerDecision?.fallbackUsed !== false
    || manifest.providerDecision?.policy !== "no-local-video-fallback"
    || manifest.providerDecisionHash !== hashJson(manifest.providerDecision)
    || manifest.semanticRevalidation != null
    || hashJson(manifest.immutableArtifacts) !== context.sourceImmutableArtifactsHash
  ) {
    throw new Error("의미 재검수 원본 manifest의 봉인 상태·provider 결정·immutable closure가 유효하지 않습니다.");
  }
  const immutableSnapshots = await verifySemanticRevalidationImmutableArtifacts(jobDir, sourceRunId, manifest, { readFileFn: readSource });
  const immutableByName = immutableSnapshots.byName;
  const declaredProviderProvenance = context.sourceProviderProvenance;
  const generationDeclaration = immutableByName.get("gemini-generation.json");
  if (
    !declaredProviderProvenance
    || Object.keys(declaredProviderProvenance).sort().join(",") !== "path,sha256"
    || declaredProviderProvenance.path !== generationDeclaration?.path
    || declaredProviderProvenance.sha256 !== generationDeclaration?.sha256
  ) throw new Error("의미 재검수 요청의 immutable Gemini provider provenance 결속이 유효하지 않습니다.");
  const requiredNames = [
    "script.json",
    "sources.json",
    "gemini-generation.json",
    `runs/${sourceRunId}/input-manifest.json`,
    `runs/${sourceRunId}/semantic/receipt.json`,
    `runs/${sourceRunId}/benchmarks/channel-analysis.json`,
    `runs/${sourceRunId}/benchmarks/shorts-metadata.json`,
    `runs/${sourceRunId}/benchmarks/rlm-benchmark-analysis.json`
  ];
  if (!requiredNames.every((name) => immutableByName.has(name))) {
    throw new Error("의미 재검수에 필요한 immutable 대본·출처·provider·입력·벤치마크 산출물이 없습니다.");
  }
  const readImmutableJson = async (name) => {
    const artifact = immutableByName.get(name);
    try {
      const bytes = immutableSnapshots.jsonBytesByName.get(name);
      if (!bytes) throw new Error("검증된 JSON byte snapshot이 없습니다.");
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`의미 재검수 immutable JSON을 읽을 수 없습니다: ${name} (${error.message})`);
    }
  };
  const script = await readImmutableJson("script.json");
  const sourceFile = await readImmutableJson("sources.json");
  const sourceGenerationPath = join(jobDir, generationDeclaration.path);
  const sourceGenerationBytes = immutableSnapshots.jsonBytesByName.get("gemini-generation.json");
  if (!sourceGenerationBytes) throw new Error("의미 재검수 immutable Gemini generation byte snapshot이 없습니다.");
  const generation = await readGeminiGenerationReceipt(sourceGenerationPath, {
    existsFn: () => true,
    readFileFn: async () => sourceGenerationBytes
  });
  const lineageSourceName = geminiSourceGenerationEvidenceName(sourceRunId);
  const lineageSourceDeclaration = manifest?.geminiSubmissionLineage?.sourceGenerationReceipt?.path === lineageSourceName
    ? immutableByName.get(lineageSourceName) || null
    : null;
  let lineageSourceSnapshot = null;
  if (lineageSourceDeclaration) {
    const lineageSourceBytes = immutableSnapshots.jsonBytesByName.get(lineageSourceName);
    if (!lineageSourceBytes) throw new Error("의미 재검수 immutable Gemini source lineage byte snapshot이 없습니다.");
    try {
      lineageSourceSnapshot = {
        value: JSON.parse(lineageSourceBytes.toString("utf8")),
        bytes: lineageSourceBytes.byteLength,
        sha256: lineageSourceDeclaration.sha256
      };
    } catch (error) {
      throw new Error(`의미 재검수 immutable Gemini source lineage JSON이 손상되었습니다 (${error.message}).`);
    }
  }
  const inputManifest = await readImmutableJson(`runs/${sourceRunId}/input-manifest.json`);
  const sourceSemanticReceipt = await readImmutableJson(`runs/${sourceRunId}/semantic/receipt.json`);
  const evidenceCheck = verifyEvidenceBoundScript(script, sourceFile?.records, job.clipCount, job.format);
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const sessionBindingHash = geminiSessionBindingHash(job);
  const expectedRequest = buildGeminiGenerationRequest(job, script);
  const expectedScriptHash = hashJson(script);
  const expectedResumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const expectedRequestHash = hashJson({ ...expectedRequest, scriptHash: expectedScriptHash });
  const expectedResumeRequestHash = hashJson({ ...expectedRequest, scriptHash: expectedResumeScriptHash });
  if (
    !Array.isArray(script?.segments)
    || script.segments.length !== Number(job.clipCount)
    || sourceFile?.jobId !== job.id
    || !Array.isArray(sourceFile.records)
    || evidenceCheck.verified !== true
    || inputManifest?.jobId !== job.id
    || inputManifest.runId !== sourceRunId
    || sourceSemanticReceipt?.schemaVersion !== 1
    || sourceSemanticReceipt.jobId !== job.id
    || sourceSemanticReceipt.runId !== sourceRunId
    || sourceSemanticReceipt.status !== "failed"
    || !Array.isArray(inputManifest.entries)
    || inputManifest.entries.length !== script.segments.length
    || generation?.provider !== "gemini-browser"
    || generation.jobId !== job.id
    || generation.runId !== sourceRunId
    || generation.status !== "completed"
    || generation.pendingSegment != null
    || !Array.isArray(generation.segments)
    || generation.segments.length !== script.segments.length
    || generation.requestHash !== expectedRequestHash
    || generation.scriptHash !== expectedScriptHash
    || generation.resumeRequestHash !== expectedResumeRequestHash
    || generation.resumeScriptHash !== expectedResumeScriptHash
    || hashJson(generation.request) !== hashJson(expectedRequest)
    || !sessionBinding
    || !sessionBindingHash
    || manifest.request?.geminiSessionBindingHash !== sessionBindingHash
    || hashJson(manifest.request?.geminiSessionBinding) !== sessionBindingHash
    || generation.sessionBindingHash !== sessionBindingHash
    || hashJson(generation.sessionBinding) !== sessionBindingHash
    || generation.providerDecisionHash !== manifest.providerDecisionHash
    || hashJson(generation.providerDecision) !== manifest.providerDecisionHash
    || generation.providerAttestationHash !== hashJson(generation.providerAttestation)
    || generation.providerAttestation?.sessionBindingHash !== sessionBindingHash
    || !verifyStrictCompletedGeminiTerminalReceipt(generation)
    || !verifyGeminiSubmissionLineageClosure({
      generation,
      runId: sourceRunId,
      manifestLineage: manifest.geminiSubmissionLineage,
      sourceSnapshot: lineageSourceSnapshot,
      sourceDeclaration: lineageSourceDeclaration
    })
  ) {
    throw new Error("의미 재검수 immutable 대본·출처·입력·Gemini 완료 영수증의 결속이 유효하지 않습니다.");
  }
  const inputByPath = new Map(inputManifest.entries.map((entry) => [entry?.relativePath, entry]));
  const clipNames = [];
  for (const segment of generation.segments) {
    const relativePath = segment?.path || segment?.output;
    const input = inputByPath.get(relativePath);
    const artifact = immutableByName.get(relativePath);
    const scriptSegment = script.segments[Number(segment?.index) - 1];
    const expectedPrompt = scriptSegment ? buildGeminiClipPrompt(job, script, scriptSegment) : null;
    const expectedPromptBinding = scriptSegment ? providerPromptBindingForSegment(scriptSegment, "gemini-browser") : null;
    if (
      !/^clips\/[A-Za-z0-9._-]+$/.test(String(relativePath || ""))
      || segment.path !== relativePath
      || segment.output !== relativePath
      || segment.runId !== sourceRunId
      || segment.requestHash !== expectedRequestHash
      || segment.scriptHash !== expectedScriptHash
      || segment.resumeRequestHash !== expectedResumeRequestHash
      || segment.resumeScriptHash !== expectedResumeScriptHash
      || segment.providerDecisionHash !== manifest.providerDecisionHash
      || segment.providerAttestationHash !== generation.providerAttestationHash
      || segment.prompt !== expectedPrompt
      || segment.promptHash !== hashJson({ prompt: expectedPrompt })
      || segment.providerVisualPromptHash !== expectedPromptBinding?.providerVisualPromptHash
      || segment.submittedToProvider !== true
      || segment.submissionAcknowledgement?.verified !== true
      || input?.sha256 !== segment.sha256
      || artifact?.sha256 !== segment.sha256
      || input?.name !== relativePath.slice("clips/".length)
    ) {
      throw new Error(`의미 재검수 Gemini 클립의 immutable/input/provider 결속이 유효하지 않습니다: ${relativePath || "unknown"}`);
    }
    clipNames.push(relativePath);
  }
  if (new Set(clipNames).size !== clipNames.length || inputByPath.size !== clipNames.length) {
    throw new Error("의미 재검수 Gemini 클립 집합이 정확한 일대일 집합이 아닙니다.");
  }
  const legacyEvidence = generation.legacySubmissionAbandonmentEvidence;
  const legacyNames = legacyEvidence ? [legacyEvidence.generationPath, legacyEvidence.receiptPath] : [];
  const exactLegacyNames = [...SEMANTIC_LEGACY_EVIDENCE_LIMITS.keys()]
    .map((name) => `${SEMANTIC_LEGACY_EVIDENCE_DIRECTORY}/${name}`)
    .sort();
  if (legacyEvidence && (
    legacyEvidence.schemaVersion !== 1
    || [...legacyNames].sort().some((name, index) => name !== exactLegacyNames[index])
    || !legacyNames.every((name) => immutableByName.has(name))
    || immutableByName.get(legacyEvidence.generationPath)?.sha256 !== legacyEvidence.generationSha256
    || immutableByName.get(legacyEvidence.receiptPath)?.sha256 !== legacyEvidence.receiptSha256
    || generation.legacySubmissionAbandonment?.receiptHash !== legacyEvidence.receiptHash
    || generation.legacySubmissionAbandonment?.sourceGenerationSha256 !== legacyEvidence.generationSha256
  )) {
    throw new Error("의미 재검수 Gemini legacy abandonment 증거가 immutable closure에 결속되지 않았습니다.");
  }
  const benchmarkNames = {
    channel: `runs/${sourceRunId}/benchmarks/channel-analysis.json`,
    duration: `runs/${sourceRunId}/benchmarks/shorts-metadata.json`,
    rlm: `runs/${sourceRunId}/benchmarks/rlm-benchmark-analysis.json`
  };
  if (
    manifest.benchmarkSnapshot?.path !== benchmarkNames.channel
    || manifest.benchmarkSnapshot.sha256 !== immutableByName.get(benchmarkNames.channel)?.sha256
    || manifest.benchmarkSnapshot.durationMetadata?.path !== benchmarkNames.duration
    || manifest.benchmarkSnapshot.durationMetadata.sha256 !== immutableByName.get(benchmarkNames.duration)?.sha256
    || manifest.benchmarkSnapshot.rlmMediaEvidence?.path !== benchmarkNames.rlm
    || manifest.benchmarkSnapshot.rlmMediaEvidence.sha256 !== immutableByName.get(benchmarkNames.rlm)?.sha256
  ) {
    throw new Error("의미 재검수 원본 benchmark snapshot 결속이 유효하지 않습니다.");
  }
  return {
    sourceRunId,
    manifest,
    manifestPath,
    manifestHash: context.sourceManifest.sha256,
    immutableByName,
    script,
    sourceBundle: {
      schemaVersion: sourceFile.schemaVersion,
      status: sourceFile.status,
      fetchedCount: sourceFile.fetchedCount,
      totalCount: sourceFile.totalCount,
      evidenceCount: sourceFile.evidenceCount,
      records: sourceFile.records
    },
    generation,
    sourceGenerationBytes,
    sourceGenerationPath,
    sourceGenerationReceipt: {
      bytes: sourceGenerationBytes.byteLength,
      sha256: generationDeclaration.sha256,
      sourceRunId,
      sourceGenerationHash: hashJson(generation)
    },
    inputManifest,
    clipNames,
    legacyNames,
    benchmarkNames,
    completedGenerationRunId: sourceRunId,
    semanticPolicy: { ...LOCAL_SEMANTIC_POLICY_BINDING },
    context
  };
}

export async function hydrateGeminiSemanticRevalidationInputs(jobDir, runDir, runId, inputs, parentJob, options = {}) {
  const renameEntry = options.renameEntry || rename;
  // Recheck every immutable byte immediately before any mutable source is replaced.
  if (await hashFile(inputs.manifestPath).catch(() => null) !== inputs.manifestHash) {
    throw new Error("의미 재검수 시작 직전 원본 manifest가 변경되었습니다.");
  }
  await verifySemanticRevalidationImmutableArtifacts(jobDir, inputs.sourceRunId, inputs.manifest);
  await recoverSemanticRevalidationWorkspace(jobDir);
  const expectedLegacyEvidence = expectedSemanticLegacyEvidence(inputs);
  // This check intentionally precedes mkdtemp/mkdir/marker publication. An
  // unsafe hardlink, symlink, or foreign leaf must fail without changing job
  // root metadata or an external inode linked by the attacker.
  await inspectCanonicalSemanticLegacyEvidence(jobDir, expectedLegacyEvidence, "preflight", { allowMissing: true });
  const stagingDir = await mkdtemp(join(jobDir, ".semantic-revalidation-staging-"));
  await chmod(stagingDir, 0o700);
  const backupName = `.semantic-revalidation-backup-${runId}`;
  const backupDir = join(jobDir, backupName);
  let transaction = null;
  let backupCreated = false;
  const readArtifact = options.readArtifactFn || readFile;
  const copyVerified = async (name, target) => {
    const artifact = inputs.immutableByName.get(name);
    if (!artifact) throw new Error(`의미 재검수 복원 산출물이 없습니다: ${name}`);
    const bytes = await readSemanticImmutableArtifactBytes(jobDir, artifact, readArtifact);
    await mkdir(dirname(target), { recursive: true });
    // Hash and write the one captured Buffer so a source-path replacement
    // cannot turn a verified-A/copy-B race into mutable provenance.
    await writeFile(target, bytes);
    const targetStat = await stat(target);
    if (targetStat.size !== Number(artifact.bytes) || await hashFile(target) !== artifact.sha256) {
      throw new Error(`의미 재검수 mutable 복원본이 immutable 원본과 다릅니다: ${name}`);
    }
  };
  try {
    await copyVerified("script.json", join(stagingDir, "script.json"));
    await copyVerified("sources.json", join(stagingDir, "sources.json"));
    await copyVerified("gemini-generation.json", join(stagingDir, "gemini-generation.json"));
    for (const name of inputs.clipNames) await copyVerified(name, join(stagingDir, name));
    for (const name of inputs.legacyNames) await copyVerified(name, join(stagingDir, name));
    let stagedLegacyEvidence = null;
    if (expectedLegacyEvidence.required) {
      const stagedEvidenceDirectory = join(stagingDir, SEMANTIC_LEGACY_EVIDENCE_DIRECTORY);
      await chmod(stagedEvidenceDirectory, 0o700);
      for (const entry of expectedLegacyEvidence.entries) await chmod(join(stagedEvidenceDirectory, entry.name), 0o600);
      stagedLegacyEvidence = await inspectStagedSemanticLegacyEvidence(stagingDir, expectedLegacyEvidence);
    }
    for (const name of Object.values(inputs.benchmarkNames)) {
      const basename = name.slice(name.lastIndexOf("/") + 1);
      await copyVerified(name, join(stagingDir, "benchmarks", basename));
    }
    const currentLegacyEvidence = await inspectCanonicalSemanticLegacyEvidence(
      jobDir,
      expectedLegacyEvidence,
      "backup 직전",
      { allowMissing: true }
    );
    const mutableEntries = await semanticMutableEntries(jobDir);
    if (currentLegacyEvidence.present !== mutableEntries.includes(SEMANTIC_LEGACY_EVIDENCE_DIRECTORY)) {
      throw new Error("의미 재검수 legacy evidence preflight와 root transaction 집합이 일치하지 않습니다.");
    }
    const parentNormalizedIdentity = await semanticParentNormalizedIdentity(jobDir);
    const parentJobBytes = await readFile(join(jobDir, "job.json"));
    transaction = {
      schemaVersion: 1,
      mode: SEMANTIC_REVALIDATION_MODE,
      phase: "prepared",
      jobId: parentJob.id,
      sourceRunId: inputs.sourceRunId,
      childRunId: runId,
      createdAt: new Date().toISOString(),
      backupDir: backupName,
      mutableEntries,
      parentJob,
      parentJobBytesBase64: parentJobBytes.toString("base64"),
      parentJobBytesSha256: `sha256:${createHash("sha256").update(parentJobBytes).digest("hex")}`,
      legacyEvidence: {
        required: expectedLegacyEvidence.required,
        previousPresent: currentLegacyEvidence.present,
        entries: expectedLegacyEvidence.entries.map(({ name, path, bytes, sha256 }) => ({ name, path, bytes, sha256 }))
      },
      sourceProviderProvenance: inputs.context.sourceProviderProvenance,
      installedArtifacts: [
        ...["script.json", "sources.json", "gemini-generation.json"],
        ...inputs.clipNames,
        ...inputs.legacyNames
      ].map((name) => ({ name, sha256: inputs.immutableByName.get(name).sha256 }))
    };
    await mkdir(backupDir, { recursive: false, mode: 0o700 });
    backupCreated = true;
    await writeSemanticTransaction(jobDir, transaction);
    for (const name of mutableEntries) {
      if (name === SEMANTIC_LEGACY_EVIDENCE_DIRECTORY) {
        await moveSemanticLegacyEvidenceToBackup(jobDir, backupName, currentLegacyEvidence.identity);
      } else {
        await renameEntry(join(jobDir, name), join(backupDir, name));
      }
    }
    await syncDirectory(backupDir);
    await syncDirectory(jobDir);
    await createSemanticChildNormalizedDirectory(jobDir, backupName, parentNormalizedIdentity, options);
    for (const name of ["script.json", "sources.json", "gemini-generation.json"]) {
      await renameEntry(join(stagingDir, name), join(jobDir, name));
    }
    for (const name of inputs.clipNames) {
      await mkdir(dirname(join(jobDir, name)), { recursive: true });
      await renameEntry(join(stagingDir, name), join(jobDir, name));
    }
    if (expectedLegacyEvidence.required) {
      await installStagedSemanticLegacyEvidence(jobDir, stagingDir, stagedLegacyEvidence.identity);
    }
    for (const name of Object.values(inputs.benchmarkNames)) {
      const basename = name.slice(name.lastIndexOf("/") + 1);
      await mkdir(join(runDir, "benchmarks"), { recursive: true });
      await renameEntry(join(stagingDir, "benchmarks", basename), join(runDir, "benchmarks", basename));
    }
    await syncDirectory(jobDir);
    await syncDirectory(join(jobDir, "clips"));
    if (expectedLegacyEvidence.required) {
      await inspectCanonicalSemanticLegacyEvidence(jobDir, expectedLegacyEvidence, "child install", { allowMissing: false });
    }
    await syncDirectory(runDir);
    await syncDirectory(join(runDir, "benchmarks"));
    for (const artifact of transaction.installedArtifacts) {
      if (await hashFile(join(jobDir, artifact.name)).catch(() => null) !== artifact.sha256) {
        throw new Error(`의미 재검수 설치 산출물이 immutable 원본과 다릅니다: ${artifact.name}`);
      }
    }
    const preparedTransaction = transaction;
    transaction = { ...preparedTransaction, phase: "installed", installedAt: new Date().toISOString() };
    await advanceSemanticTransactionCas(jobDir, preparedTransaction, transaction);
  } catch (error) {
    let journal;
    try {
      journal = await readSemanticTransactionStrict(jobDir);
    } catch (markerError) {
      throw new AggregateError([error, markerError], "의미 재검수 journal 상태를 안전하게 확인할 수 없어 backup을 보존합니다.");
    }
    if (journal) {
      await rollbackSemanticRevalidationWorkspace(jobDir, journal);
    } else if (backupCreated) {
      await rm(backupDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  const replaceRun = (reference) => ({
    ...reference,
    path: String(reference.path).replace(`runs/${inputs.sourceRunId}/`, `runs/${runId}/`)
  });
  return {
    transaction,
    benchmarkSnapshot: {
      ...inputs.manifest.benchmarkSnapshot,
      path: `runs/${runId}/benchmarks/channel-analysis.json`,
      durationMetadata: replaceRun(inputs.manifest.benchmarkSnapshot.durationMetadata),
      rlmMediaEvidence: replaceRun(inputs.manifest.benchmarkSnapshot.rlmMediaEvidence)
    }
  };
}

export async function runJob(jobId, options = {}) {
  const safeJobId = assertJobStorageId(jobId);
  const jobDir = join(JOBS_DIR, safeJobId);
  // This must precede readJob, recovery, run publication, and every callback:
  // unsafe mutable child ancestry is a storage-boundary failure, not a run.
  try {
    await preflightRunMutableStorage(jobDir);
  } catch (error) {
    error.code = "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE";
    throw error;
  }
  let job = await readJob(jobId);
  if (await readLocalClipUploadTransactionStrict(jobDir)) {
    throw new Error("해결되지 않은 로컬 클립 업로드 transaction이 있어 실행을 차단했습니다.");
  }
  const verifiedLocalClipSet = job.provider === "local"
    ? await verifyReadyLocalClipSet(jobDir, job)
    : null;
  await recoverSemanticRevalidationWorkspace(jobDir);
  if (job.provider !== "local") job = await readJob(jobId);
  if (job.provider === "local-video") {
    await assertNoPriorPaidLocalVideoSubmission(jobDir);
    if (!options.paidLaunchCapability) throw new Error("local-video 유료 실행에는 server가 소비한 정확한 BFL 1회 launch capability가 필요합니다.");
  }
  const semanticRevalidationInputs = options.semanticRevalidation
    ? await readGeminiSemanticRevalidationInputs(job, jobDir, options.semanticRevalidation)
    : null;
  const semanticParentJob = semanticRevalidationInputs ? JSON.parse(JSON.stringify(job)) : null;
  let semanticWorkspaceTransaction = null;
  const geminiRecoveryInputs = semanticRevalidationInputs || (job.provider === "gemini-browser"
    ? await readGeminiRecoveryInputs(job, jobDir)
    : null);
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
  let runDirectoryDurable = false;
  let geminiSourceGenerationReceipt = null;
  let geminiSubmissionLineage = null;
  const localClipImportReceiptName = verifiedLocalClipSet ? `runs/${runId}/local-clip-import.json` : null;
  const localClipImportReceiptPath = verifiedLocalClipSet ? join(runDir, "local-clip-import.json") : null;
  let localClipImportReceiptReference = null;
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
      ...(verifiedLocalClipSet ? {
        localClipImport: {
          schemaVersion: verifiedLocalClipSet.receipt.schemaVersion,
          source: verifiedLocalClipSet.receipt.source,
          providerEvidenceEligible: false,
          orderingPolicy: verifiedLocalClipSet.receipt.orderingPolicy,
          clipCount: verifiedLocalClipSet.receipt.clipCount,
          setHash: verifiedLocalClipSet.receipt.setHash,
          receiptHash: verifiedLocalClipSet.receipt.receiptHash
        }
      } : {}),
      ...(geminiSessionBinding ? { geminiSessionBinding, geminiSessionBindingHash: geminiSessionBindingDigest } : {})
    },
    providerDecision,
    providerDecisionHash,
    eventsPath: `runs/${runId}/events.jsonl`,
    inputManifest: null,
    ...(semanticRevalidationInputs ? {
      semanticRevalidation: {
        schemaVersion: 1,
        mode: SEMANTIC_REVALIDATION_MODE,
        sourceRunId: semanticRevalidationInputs.sourceRunId,
        parentManifestHash: semanticRevalidationInputs.manifestHash,
        sourceImmutableArtifactsHash: options.semanticRevalidation.sourceImmutableArtifactsHash,
        sourceProviderProvenance: { ...options.semanticRevalidation.sourceProviderProvenance },
        semanticPolicy: { ...LOCAL_SEMANTIC_POLICY_BINDING },
        providerRequestPolicy: { allowed: false, maximumCalls: 0 },
        providerRequestSent: false
      }
    } : {})
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
    await createRunDirectoryDurably(runDir);
    runDirectoryDurable = true;
    if (!SUPPORTED_PROVIDERS.has(job.provider)) throw new Error("지원하지 않는 생성 소스입니다. local, local-video 또는 gemini-browser만 사용할 수 있습니다.");
    if (verifiedLocalClipSet) {
      await writeJsonAtomic(localClipImportReceiptPath, verifiedLocalClipSet.receipt);
      localClipImportReceiptReference = {
        path: localClipImportReceiptName,
        sha256: await hashFile(localClipImportReceiptPath),
        receiptHash: verifiedLocalClipSet.receipt.receiptHash,
        setHash: verifiedLocalClipSet.receipt.setHash,
        source: verifiedLocalClipSet.receipt.source,
        providerEvidenceEligible: false,
        clipCount: verifiedLocalClipSet.receipt.clipCount
      };
      runManifest = { ...runManifest, localClipImportReceipt: localClipImportReceiptReference };
    }
    geminiSourceGenerationReceipt = await preserveGeminiSourceGenerationEvidence(jobDir, runDir, runId, geminiRecoveryInputs);
    if (geminiRecoveryInputs && !geminiSourceGenerationReceipt) {
      throw new Error("Gemini 복구 실행에 exact source generation 보존 영수증이 없습니다.");
    }
    if (geminiSourceGenerationReceipt) {
      runManifest = {
        ...runManifest,
        geminiSubmissionLineage: {
          schemaVersion: 1,
          status: "source-preserved",
          sourceGenerationReceipt: geminiSourceGenerationReceipt
        }
      };
    }
    await writeRunManifest(runDir, runManifest);
    const hydration = semanticRevalidationInputs
      ? await hydrateGeminiSemanticRevalidationInputs(jobDir, runDir, runId, semanticRevalidationInputs, semanticParentJob)
      : null;
    semanticWorkspaceTransaction = hydration?.transaction || null;
    await clearMutableOutputs(jobDir, job.provider === "gemini-browser", job.provider === "local-video", Boolean(geminiRecoveryInputs));
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
    if (typeof options.onRunCreated === "function") await options.onRunCreated({ job, runId, parentRunId });
    runManifest = { ...runManifest, benchmarkSnapshot: hydration?.benchmarkSnapshot || await snapshotBenchmarkFiles(runDir, runId) };
    await writeRunManifest(runDir, runManifest);
  } catch (error) {
    const failure = storedProviderFailure(job.provider, error, { phase: "initialization" });
    if (!runDirectoryDurable) {
      // The run directory name was not durably published in runs/. Do not write
      // a ledger into it or move the mutable job pointer to an inode that may
      // disappear after power loss.
      if (parentRunId) {
        return updateJob(jobId, {
          message: `새 실행 디렉터리 게시 실패 · 기존 run ${parentRunId} 포인터를 유지합니다.`,
          warnings: [...(job.warnings || []), `새 실행 준비 실패: ${failure.message}`]
        }).catch(() => job);
      }
      return updateJob(jobId, {
        status: "failed",
        stage: "오류",
        progress: job.progress || 0,
        message: `실행 디렉터리 게시 실패: ${failure.message}`,
        error: failure.error,
        ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
        runStatus: "failed"
      }).catch(() => job);
    }
    await record({
      type: "failed",
      phase: "initialization",
      error: failure.error,
      ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : { stack: error.stack || null })
    });
    const eventLog = { path: `runs/${runId}/events.jsonl`, sha256: await hashFile(join(runDir, "events.jsonl")).catch(() => null) };
    runManifest = {
      ...runManifest,
      completedAt: new Date().toISOString(),
      status: "failed",
      runStatus: "failed",
      error: failure.error,
      ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
      eventLog,
      ledgerErrors: [...ledgerErrors]
    };
    try {
      await writeRunManifest(runDir, runManifest);
    } catch (manifestError) {
      ledgerErrors.push(manifestError.message);
      console.error(`initialization failure manifest write failed: ${manifestError.message}`);
    }
    if (semanticRevalidationInputs) {
      await rollbackSemanticRevalidationWorkspace(jobDir, semanticWorkspaceTransaction).catch((rollbackError) => {
        throw new Error(`의미 재검수 준비 실패 후 원본 작업영역 복구에도 실패했습니다: ${rollbackError.message}`);
      });
      job = await updateJob(jobId, {
        ...semanticParentJob,
        status: "needs-improvement",
        stage: "개선 필요",
        progress: 100,
        message: `로컬 의미 재검수 child ${runId} 실패 · 원본 봉인 run을 유지합니다.`,
        error: null,
        warnings: [...(semanticParentJob.warnings || []), `로컬 의미 재검수 child ${runId} 준비 실패: ${failure.message}`],
        providerProvenance: options.semanticRevalidation.sourceProviderProvenance,
        providerFailureEvidence: failure.evidence,
        semanticRevalidationFailure: { childRunId: runId, phase: "initialization", message: failure.message, code: failure.error, evidence: failure.evidence }
      });
    } else {
      job = await updateJob(jobId, {
        status: "failed",
        stage: "오류",
        progress: job.progress || 0,
        message: `실행 준비 실패: ${failure.message}`,
        error: failure.error,
        ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
        warnings: [...(job.warnings || []), ...ledgerErrors.map((entry) => `실행 기록 저장 실패: ${entry}`)],
        runId,
        runStatus: "failed",
        artifacts: [],
        qualitySummary: null,
        duration: null
      });
    }
    if (options.onProgress) await options.onProgress(job);
    return job;
  }

  let inputManifest = null;
  let geminiGeneration = null;
  let localVideoGeneration = null;
  let localSemanticResult = null;
  const captureRunInputs = async (requestedNames = null, expectedCount = job.clipCount) => {
    if (inputManifest) return inputManifest;
    inputManifest = await createInputManifest(
      jobDir,
      runDir,
      jobId,
      runId,
      requestedNames,
      expectedCount,
      job.provider,
      verifiedLocalClipSet?.receipt || null
    );
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
      const previousGeneration = await readGeminiGenerationReceipt(join(jobDir, "gemini-generation.json"));
      const preservePartial = Boolean(geminiRecoveryInputs) || shouldPreserveGeminiRecoveryArtifacts(previousGeneration);
      if (!preservePartial) await cleanupOwnedMutableOutputFiles(jobDir, { clearClips: true });
    }
    // These dependency seams keep the real run lifecycle testable without
    // changing production behavior. Tests may supply an already captured,
    // byte-bound source bundle; ordinary runs always use the network-hardened
    // capture implementation above.
    const captureSourcesForRun = options.captureSources || captureSources;
    const sourceBundle = geminiRecoveryInputs?.sourceBundle || await captureSourcesForRun(job);
    if (!geminiRecoveryInputs) await writeJsonAtomic(join(jobDir, "sources.json"), { jobId, runId, ...sourceBundle });
    job = await updateJob(jobId, { sources: sourceBundle.records, sourceBundle: { status: sourceBundle.status, fetchedCount: sourceBundle.fetchedCount, totalCount: sourceBundle.totalCount, evidenceCount: sourceBundle.evidenceCount || 0 } });
    await record({ type: "sources_captured", status: sourceBundle.status, fetchedCount: sourceBundle.fetchedCount, totalCount: sourceBundle.totalCount, evidenceCount: sourceBundle.evidenceCount || 0 });

    const buildScriptForRun = options.buildScript || buildScript;
    const script = geminiRecoveryInputs?.script || await buildScriptForRun(job);
    if (!geminiRecoveryInputs) await writeJsonAtomic(join(jobDir, "script.json"), script);
    else await record({
      type: "gemini_recovery_inputs_reused",
      sourceRunId: geminiRecoveryInputs.generation.runId,
      generationStatus: geminiRecoveryInputs.generation.status,
      sourceBundleHash: hashJson(geminiRecoveryInputs.sourceBundle),
      scriptHash: hashJson(script)
    });
    const shotPatternReceiptName = `runs/${runId}/shot-pattern-receipt.json`;
    const shotPatternReceiptPath = join(runDir, "shot-pattern-receipt.json");
    let shotPatternReceipt;
    let shotPatternReceiptReference;
    const persistShotPatternReceipt = async (providerEvidence = {}) => {
      shotPatternReceipt = createShotPatternReceipt(script, job, runId, providerEvidence);
      await writeJsonAtomic(shotPatternReceiptPath, shotPatternReceipt);
      shotPatternReceiptReference = {
        path: shotPatternReceiptName,
        sha256: await hashFile(shotPatternReceiptPath),
        receiptHash: shotPatternReceipt.receiptHash,
        catalogId: shotPatternReceipt.catalogId,
        catalogHash: shotPatternReceipt.catalogHash,
        continuityContractHash: shotPatternReceipt.continuityContractHash,
        segmentCount: shotPatternReceipt.segments.length,
        applicationMode: shotPatternReceipt.applicationMode,
        providerEligible: shotPatternReceipt.providerEligible,
        providerSubmissionPlanned: shotPatternReceipt.providerSubmissionPlanned,
        submittedToProvider: shotPatternReceipt.submittedToProvider,
        providerRequestSentThisRun: shotPatternReceipt.providerRequestSentThisRun,
        inheritedProviderSubmission: shotPatternReceipt.inheritedProviderSubmission,
        sourceSubmissionRunId: shotPatternReceipt.sourceSubmissionRunId,
        sourceGenerationHash: shotPatternReceipt.sourceGenerationHash,
        providerRequestHash: shotPatternReceipt.providerRequestHash,
        providerGenerationHash: shotPatternReceipt.providerGenerationHash
      };
      runManifest = { ...runManifest, shotPatterns: shotPatternReceiptReference };
      await writeRunManifest(runDir, runManifest);
      return shotPatternReceiptReference;
    };
    await persistShotPatternReceipt();
    await record({
      type: "shot_patterns_planned",
      jobId,
      runId,
      shotPatterns: shotPatternReceiptReference,
      segments: shotPatternReceipt.segments.map((segment) => ({
        index: segment.index,
        patternId: segment.patternId,
        renderedPromptHash: segment.renderedPromptHash,
        providerVisualPromptHash: segment.providerVisualPromptHash,
        continuityContractHash: segment.continuityContractHash,
        visualPromptHash: segment.visualPromptHash,
        providerSubmissionPlanned: segment.providerSubmissionPlanned,
        submittedToProvider: segment.submittedToProvider
      }))
    });
    await progress(18, "기획", `출처 결속 로컬 대본과 ${script.segments.length}개 장면을 준비했습니다.`);

    if (job.provider === "gemini-browser") {
      await progress(22, "의미 검수 준비", "영상 생성 전에 로컬 OMLX 의미 검증 모델을 확인하는 중입니다.");
      if (semanticRevalidationInputs) {
        if (
          geminiRecoveryInputs?.completedGenerationRunId !== semanticRevalidationInputs.sourceRunId
          || geminiRecoveryInputs.generation?.runId !== semanticRevalidationInputs.sourceRunId
          || geminiRecoveryInputs.generation?.status !== "completed"
        ) throw new Error("의미 재검수는 봉인된 완료 Gemini generation resume 경로만 사용할 수 있습니다. 새 provider 요청을 보내지 않습니다.");
        await record({
          type: "semantic_revalidation_provider_zero_asserted",
          phase: "before-resume",
          sourceRunId: semanticRevalidationInputs.sourceRunId,
          providerRequestSent: false,
          semanticPolicy: LOCAL_SEMANTIC_POLICY_BINDING
        });
      }
      const { generation } = await runProviderGenerationWithSemanticPreflight({
        provider: job.provider,
        preflight: options.semanticVerifierPreflight || preflightLocalSemanticVerifier,
        fetchImpl: options.semanticVerifierFetch || fetch,
        environment: options.environment || process.env,
        onReady: (ready) => record({ type: "semantic_verifier_preflight", provider: ready.provider, model: ready.model, available: true }),
        generate: async () => {
          await progress(24, "Gemini 영상", "Chrome의 Gemini 동영상 만들기 화면을 제어하는 중입니다.");
          await assertGeminiRecoverySourceStillExact(geminiRecoveryInputs);
          const recoveryBoundJob = geminiSourceGenerationReceipt
            ? {
                ...job,
                expectedRecoverySourceGenerationReceipt: {
                  bytes: geminiSourceGenerationReceipt.bytes,
                  sha256: geminiSourceGenerationReceipt.sha256,
                  sourceRunId: geminiSourceGenerationReceipt.sourceRunId,
                  sourceGenerationHash: geminiSourceGenerationReceipt.sourceGenerationHash
                }
              }
            : job;
          const generationJob = geminiRecoveryInputs?.completedGenerationRunId
            ? {
                ...recoveryBoundJob,
                resumeCompletedGenerationRunId: geminiRecoveryInputs.completedGenerationRunId,
                ...(semanticRevalidationInputs ? { providerRequestsForbidden: true } : {})
              }
            : recoveryBoundJob;
          const generateGemini = options.generateGeminiClips || generateGeminiClips;
          return generateGemini(generationJob, script, async (value, message) => progress(24 + Math.round(value * 0.30), "Gemini 영상", message));
        }
      });
      geminiGeneration = generation;
      if (!generation || generation.status !== "completed" || generation.runId !== runId || !generation.requestHash || !generation.scriptHash) {
        throw new Error("Gemini generation provenance가 현재 runId·요청 해시에 결속되지 않았습니다.");
      }
      if (!verifyStrictCompletedGeminiTerminalReceipt(generation)) {
        throw new Error("Gemini 완료 generation에 실제 headless runtime·target conversation 계보가 없습니다.");
      }
      geminiSubmissionLineage = deriveGeminiSubmissionLineage(generation, runId, geminiSourceGenerationReceipt);
      runManifest = {
        ...runManifest,
        geminiSubmissionLineage: {
          ...geminiSubmissionLineage,
          status: "completed",
          sourceGenerationReceipt: geminiSourceGenerationReceipt
        }
      };
      await writeRunManifest(runDir, runManifest);
      await record({
        type: "gemini_submission_lineage_bound",
        jobId,
        runId,
        providerRequestSentThisRun: geminiSubmissionLineage.providerRequestSentThisRun,
        inheritedProviderSubmission: geminiSubmissionLineage.inheritedProviderSubmission,
        submissionRunIds: geminiSubmissionLineage.submissionRunIds,
        sourceGenerationReceipt: geminiSourceGenerationReceipt
      });
      if (semanticRevalidationInputs && (
        generation.resumedFromCompletedGeneration?.sourceRunId !== semanticRevalidationInputs.sourceRunId
        || generation.resumedFromCompletedGeneration.providerRequestSent !== false
        || generation.segments.some((segment) => segment?.resumedCompletedGeneration !== true)
      )) {
        throw new Error("의미 재검수 Gemini resume 영수증이 provider 요청 0회에 결속되지 않았습니다.");
      }
      if (semanticRevalidationInputs) {
        runManifest = {
          ...runManifest,
          semanticRevalidation: {
            ...runManifest.semanticRevalidation,
            childGenerationHash: hashJson(generation),
            providerRequestSent: false
          }
        };
        await writeRunManifest(runDir, runManifest);
        await record({
          type: "semantic_revalidation_provider_zero_asserted",
          phase: "after-resume",
          sourceRunId: semanticRevalidationInputs.sourceRunId,
          providerRequestSent: false,
          resumedGenerationHash: hashJson(generation)
        });
      }
      await persistShotPatternReceipt({
        submittedToProvider: true,
        providerRequestSentThisRun: geminiSubmissionLineage.providerRequestSentThisRun,
        inheritedProviderSubmission: geminiSubmissionLineage.inheritedProviderSubmission,
        sourceSubmissionRunId: geminiSubmissionLineage.sourceSubmissionRunId,
        sourceGenerationHash: geminiSubmissionLineage.sourceGenerationHash,
        segmentLineage: geminiSubmissionLineage.segments,
        providerRequestHash: generation.requestHash,
        providerGenerationHash: await hashFile(join(jobDir, "gemini-generation.json"))
      });
      await record({ type: "shot_patterns_provider_bound", jobId, runId, provider: job.provider, shotPatterns: shotPatternReceiptReference });
      await captureRunInputs(script.segments.map((_, index) => `${String(index + 1).padStart(2, "0")}.mp4`), script.segments.length);
    } else if (job.provider === "local-video") {
      await progress(22, "의미 검수 준비", "영상 생성 전에 로컬 OMLX 의미 검증 모델을 확인하는 중입니다.");
      const prepared = await runProviderGenerationWithSemanticPreflight({
        provider: job.provider,
        preflight: options.semanticVerifierPreflight || preflightLocalSemanticVerifier,
        fetchImpl: options.semanticVerifierFetch || fetch,
        environment: options.environment || process.env,
        onReady: (ready) => record({ type: "semantic_verifier_preflight", provider: ready.provider, model: ready.model, available: true }),
        generate: async () => {
          await progress(24, "로컬 영상 생성", "설정된 local-video 생성기에서 장면을 생성하는 중입니다.");
          return generateLocalVideoClips(
            job,
            script,
            runId,
            async (value, message) => progress(24 + Math.round(value * 0.30), "로컬 영상 생성", message),
            { paidLaunchCapability: options.paidLaunchCapability }
          );
        }
      });
      localVideoGeneration = prepared.generation;
      await persistShotPatternReceipt({
        submittedToProvider: true,
        providerRequestHash: localVideoGeneration.requestHash,
        providerGenerationHash: localVideoGeneration.receipt.sha256
      });
      await record({ type: "shot_patterns_provider_bound", jobId, runId, provider: job.provider, shotPatterns: shotPatternReceiptReference });
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
    await progress(95, "의미 검수", "로컬 OMLX 장면·번인 자막 검사와 결정론적 provenance 결속을 실행하는 중입니다.");
    localSemanticResult = await createLocalSemanticReceipt({
      job,
      script,
      runId,
      jobDir,
      runDir,
      sourceEntailment: verifyEvidenceBoundScript(script, job.sources, job.clipCount, job.format),
      // Reuse the same explicit loopback-verifier transport/environment used
      // by the provider preflight. This enables a hermetic transport simulator
      // while retaining the complete semantic receipt construction and later
      // immutable verification path.
      fetchImpl: options.semanticVerifierFetch || fetch,
      environment: options.environment || process.env
    });
    if (semanticRevalidationInputs && (
      localSemanticResult.receipt?.schemaVersion !== LOCAL_SEMANTIC_POLICY_BINDING.version
      || !exactSemanticPolicyBinding(localSemanticResult.receipt?.semanticPolicy)
      || localSemanticResult.receipt?.evaluator?.verdictPolicyHash !== LOCAL_SEMANTIC_POLICY_BINDING.hash
    )) {
      throw new Error("의미 재검수 child receipt가 현재 schema 2 purpose-aware policy에 정확히 결속되지 않았습니다.");
    }
    runManifest = { ...runManifest, semanticReceipt: localSemanticResult.receiptReference };
    await writeRunManifest(runDir, runManifest);
    await record({
      type: "local_semantic_receipt",
      jobId,
      runId,
      status: localSemanticResult.receipt.status,
      receipt: localSemanticResult.receiptReference,
      evaluator: {
        provider: localSemanticResult.receipt.evaluator.provider,
        model: localSemanticResult.receipt.evaluator.model,
        humanReview: false,
        asrPerformed: false
      }
    });
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
      ...localSemanticResult.artifacts,
      { name: "quality.json", kind: "quality", url: mediaPath(job.id, "quality.json") },
      { name: "frame-audio-caption.json", kind: "analysis", url: mediaPath(job.id, "frame-audio-caption.json") },
      { name: "sources.json", kind: "source-bundle", url: mediaPath(job.id, "sources.json") },
      ...(existsSync(join(jobDir, "gemini-generation.json")) ? [{ name: "gemini-generation.json", kind: "provider-provenance", url: mediaPath(job.id, "gemini-generation.json") }] : []),
      ...(geminiGeneration?.legacySubmissionAbandonmentEvidence ? [
        { name: geminiGeneration.legacySubmissionAbandonmentEvidence.generationPath, kind: "legacy-provider-provenance", url: mediaPath(job.id, geminiGeneration.legacySubmissionAbandonmentEvidence.generationPath), sha256: geminiGeneration.legacySubmissionAbandonmentEvidence.generationSha256 },
        { name: geminiGeneration.legacySubmissionAbandonmentEvidence.receiptPath, kind: "legacy-abandonment-receipt", url: mediaPath(job.id, geminiGeneration.legacySubmissionAbandonmentEvidence.receiptPath), sha256: geminiGeneration.legacySubmissionAbandonmentEvidence.receiptSha256 }
      ] : []),
      ...(geminiSourceGenerationReceipt ? [{
        name: geminiSourceGenerationReceipt.path,
        kind: "source-provider-provenance",
        url: mediaPath(job.id, geminiSourceGenerationReceipt.path),
        bytes: geminiSourceGenerationReceipt.bytes,
        sha256: geminiSourceGenerationReceipt.sha256
      }] : []),
      ...(localVideoGeneration ? [{ name: `runs/${runId}/local-video-generation.json`, kind: "provider-provenance", url: mediaPath(job.id, `runs/${runId}/local-video-generation.json`) }] : []),
      ...(localClipImportReceiptReference ? [{ name: localClipImportReceiptName, kind: "manual-local-clip-import", url: mediaPath(job.id, localClipImportReceiptName) }] : []),
      { name: shotPatternReceiptName, kind: "shot-pattern-receipt", url: mediaPath(job.id, shotPatternReceiptName) },
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
      script: { generatedBy: script.generatedBy, segmentCount: script.segments.length, targetDurationSec: job.targetDurationSec, sourceBundle: job.sourceBundle || { status: "missing" }, providerProvenance: localVideoGeneration ? `runs/${runId}/local-video-generation.json` : existsSync(join(jobDir, "gemini-generation.json")) ? "gemini-generation.json" : null, shotPatterns: shotPatternReceiptReference },
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
    const finalizingManifestPath = join(runDir, "manifest.json");
    const finalizingManifestDeclaration = {
      name: `runs/${runId}/manifest.json`,
      kind: "run-manifest",
      url: mediaPath(job.id, `runs/${runId}/manifest.json`),
      bytes: (await stat(finalizingManifestPath)).size,
      sha256: await hashFile(finalizingManifestPath)
    };

    const immutableArtifactDeclarations = immutableArtifacts.map(({ path, kind, url, bytes, sha256 }) => ({
      name: path,
      kind: `immutable-${kind || "artifact"}`,
      url,
      bytes: Number(bytes),
      sha256
    }));
    const rootArtifactReceipts = new Map(runManifest.artifacts.map((artifact) => [artifact.name, artifact]));
    const receiptedRootArtifacts = snapshotArtifacts.map((artifact) => {
      const receipt = rootArtifactReceipts.get(artifact.name);
      return receipt ? { ...artifact, bytes: Number(receipt.bytes), sha256: receipt.sha256 } : artifact;
    });
    const finalArtifacts = [
      ...receiptedRootArtifacts,
      ...immutableArtifactDeclarations,
      finalizingManifestDeclaration
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
    if (semanticRevalidationInputs && (finalizedQuality.status === "passed" || finalizedQuality.semanticGate === true)) {
      throw new Error("로컬 의미 재검수만으로 reviewer 승인을 위조하거나 완료 상태로 승격할 수 없습니다.");
    }
    const semanticSuccess = !semanticRevalidationInputs && finalizedQuality.status === "passed" && finalizedQuality.semanticGate === true;
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
    const finalizedManifestPath = join(runDir, "manifest.json");
    const finalizedManifestDeclaration = {
      name: `runs/${runId}/manifest.json`,
      kind: "run-manifest",
      url: mediaPath(job.id, `runs/${runId}/manifest.json`),
      bytes: (await stat(finalizedManifestPath)).size,
      sha256: await hashFile(finalizedManifestPath)
    };

    const finalizedImmutableDeclarations = immutableArtifacts.map(({ path, kind, url, bytes, sha256 }) => ({
      name: path,
      kind: `immutable-${kind || "artifact"}`,
      url,
      bytes: Number(bytes),
      sha256
    }));
    const finalizedRootReceipts = new Map(runManifest.artifacts.map((artifact) => [artifact.name, artifact]));
    const finalizedRootArtifacts = snapshotArtifacts.map((artifact) => {
      const receipt = finalizedRootReceipts.get(artifact.name);
      return receipt ? { ...artifact, bytes: Number(receipt.bytes), sha256: receipt.sha256 } : artifact;
    });
    const finalizedArtifacts = [
      ...finalizedRootArtifacts,
      ...finalizedImmutableDeclarations,
      finalizedManifestDeclaration
    ];
    const immutableProviderArtifactName = job.provider === "gemini-browser"
      ? "gemini-generation.json"
      : job.provider === "local-video" ? `runs/${runId}/local-video-generation.json` : null;
    const immutableProviderArtifact = immutableProviderArtifactName
      ? immutableArtifacts.find((artifact) => artifact.name === immutableProviderArtifactName)
      : null;
    const providerProvenance = immutableProviderArtifact
      ? { path: immutableProviderArtifact.path, sha256: immutableProviderArtifact.sha256 }
      : null;
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
      providerProvenance,
      ...(semanticRevalidationInputs ? {
        semanticRevalidationSummary: {
          status: "sealed",
          mode: SEMANTIC_REVALIDATION_MODE,
          sourceRunId: semanticRevalidationInputs.sourceRunId,
          childRunId: runId,
          semanticPolicy: { ...LOCAL_SEMANTIC_POLICY_BINDING },
          providerRequests: 0
        }
      } : {}),
      error: null
    });
    if (semanticWorkspaceTransaction) {
      semanticWorkspaceTransaction = await commitSemanticRevalidationWorkspace(jobDir, semanticWorkspaceTransaction);
      if (options.onProgress) await options.onProgress(job).catch((error) => {
        console.error(`semantic revalidation post-commit progress callback failed: ${error.message}`);
      });
    } else if (options.onProgress) await options.onProgress(job).catch((error) => {
      console.error(`terminal post-commit progress callback failed: ${error.message}`);
    });
    return job;
  } catch (error) {
    if (semanticRevalidationInputs) {
      let committedTransaction;
      try {
        committedTransaction = await readSemanticTransactionStrict(jobDir);
      } catch (transactionError) {
        throw new AggregateError([error, transactionError], "의미 재검수 transaction 상태를 읽을 수 없어 자동 rollback을 중단합니다.");
      }
      if (committedTransaction?.phase === "committed") {
        // Publication is irreversible once the durable committed marker is
        // readable. Never append a failure event or rewrite the sealed child
        // manifest after that point; leave cleanup for this call or startup.
        await rollbackSemanticRevalidationWorkspace(jobDir, committedTransaction).catch((cleanupError) => {
          console.error(`semantic revalidation committed cleanup deferred: ${cleanupError.message}`);
        });
        if (options.onProgress) await options.onProgress(job).catch(() => {});
        return job;
      }
    }
    if (!semanticRevalidationInputs) {
      let diskState;
      try {
        diskState = await inspectRunFailureMutationState(jobDir, runDir, jobId, runId);
      } catch (inspectionError) {
        // Unknown storage errors must not be converted into permission to
        // append failure events or overwrite a potentially committed seal.
        console.error(`run ${runId} failure-state inspection blocked mutation: ${inspectionError.message}`);
        return job;
      }
      if (diskState.state === "sealed-terminal") {
        const manifest = diskState.manifest;
        return {
          ...job,
          status: manifest.status === "completed" ? "completed" : "needs-improvement",
          stage: manifest.status === "completed" ? "완료" : "개선 필요",
          progress: 100,
          runId,
          runStatus: manifest.runStatus,
          qualitySummary: manifest.qualitySummary,
          error: null
        };
      }
      if (diskState.state === "blocked") {
        console.error(`run ${runId} failure mutation blocked: ${diskState.reason}`);
        return job;
      }
      if (diskState.state === "already-failed") {
        const failure = storedProviderFailure(job.provider, error, { phase: "pipeline" });
        return updateJob(jobId, {
          status: "failed",
          stage: "오류",
          runId,
          runStatus: "failed",
          message: failure.message,
          error: failure.error,
          ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {})
        }).catch(() => job);
      }
    }
    const failure = storedProviderFailure(job.provider, error, { phase: "pipeline" });
    await record({
      type: "failed",
      error: failure.error,
      ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : { stack: error.stack || null })
    });
    const provenancePath = join(jobDir, "gemini-generation.json");
    const providerProvenance = semanticRevalidationInputs
      ? options.semanticRevalidation.sourceProviderProvenance
      : existsSync(provenancePath) ? { path: "gemini-generation.json", sha256: await hashFile(provenancePath).catch(() => null) } : null;
    const eventLog = { path: `runs/${runId}/events.jsonl`, sha256: await hashFile(join(runDir, "events.jsonl")).catch(() => null) };
    runManifest = {
      ...runManifest,
      completedAt: new Date().toISOString(),
      status: "failed",
      runStatus: "failed",
      error: failure.error,
      ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
      providerProvenance,
      eventLog,
      ledgerErrors: [...ledgerErrors]
    };
    try {
      await writeRunManifest(runDir, runManifest);
    } catch (manifestError) {
      ledgerErrors.push(manifestError.message);
      console.error(`failed run manifest write failed: ${manifestError.message}`);
    }
    if (semanticRevalidationInputs) {
      const diskTransaction = await readSemanticTransactionStrict(jobDir);
      const effectiveTransaction = diskTransaction || semanticWorkspaceTransaction;
      await rollbackSemanticRevalidationWorkspace(jobDir, effectiveTransaction).catch((rollbackError) => {
        throw new Error(`의미 재검수 실패 후 원본 작업영역 복구에도 실패했습니다: ${rollbackError.message}`);
      });
      job = await updateJob(jobId, {
        ...semanticParentJob,
        status: "needs-improvement",
        stage: "개선 필요",
        progress: 100,
        message: `로컬 의미 재검수 child ${runId} 실패 · 원본 봉인 run을 유지합니다.`,
        error: null,
        warnings: [...(semanticParentJob.warnings || []), `로컬 의미 재검수 child ${runId} 실패: ${failure.message}`],
        providerProvenance,
        providerFailureEvidence: failure.evidence,
        semanticRevalidationFailure: { childRunId: runId, phase: "pipeline", message: failure.message, code: failure.error, evidence: failure.evidence }
      });
    } else {
      job = await updateJob(jobId, {
        status: "failed",
        stage: "오류",
        progress: job.progress || 0,
        message: failure.message,
        error: failure.error,
        ...(failure.evidence ? { providerFailureEvidence: failure.evidence } : {}),
        warnings: [...(job.warnings || []), ...ledgerErrors.map((entry) => `실행 기록 저장 실패: ${entry}`)],
        providerProvenance,
        runId,
        runStatus: "failed"
      });
    }
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
