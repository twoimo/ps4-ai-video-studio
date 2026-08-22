import { createHash } from "node:crypto";
import { constants as fsConstants, fchmodSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  closeFd,
  createFileAt,
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  readFdBuffer,
  replaceFileAt,
  sameFdIdentity,
  statFd,
  syncFd
} from "./dirfd.mjs";
import {
  canonicalGeminiObservedRuntimeProof,
  canonicalGeminiSessionBinding,
  geminiObservedRuntimeProofHash,
  validateGeminiObservedRuntimeProof
} from "./provenance.mjs";

export const GEMINI_LEGACY_ABANDONMENT_NAME = "gemini-legacy-abandonment.json";

const LEGACY_GENERATION_MAX_BYTES = 16 * 1024 * 1024;
const LEGACY_JOB_MAX_BYTES = 16 * 1024 * 1024;
const LEGACY_ABANDONMENT_MAX_BYTES = 1024 * 1024;
const LEGACY_EVIDENCE_DIRECTORY_NAME = "legacy-gemini-evidence";
const LEGACY_GENERATION_EVIDENCE_NAME = "abandoned-gemini-generation.json";
const LEGACY_RECEIPT_EVIDENCE_NAME = "abandonment-receipt.json";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function legacyStorageError(message) {
  const error = new Error(message);
  error.code = "GEMINI_LEGACY_STORAGE_UNSAFE";
  return error;
}

function canonicalStoragePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw legacyStorageError(`${label} 경로가 올바르지 않습니다.`);
  }
  let target = resolve(value);
  // macOS exposes /tmp and /var as immutable OS aliases. Resolve only these
  // fixed aliases; every user-controlled symlink in the remaining ancestry is
  // rejected by the O_NOFOLLOW dirfd traversal below.
  if (process.platform === "darwin") {
    if (target === "/var" || target.startsWith("/var/")) target = `/private${target}`;
    else if (target === "/tmp" || target.startsWith("/tmp/")) target = `/private${target}`;
  }
  return target;
}

function assertLegacyJobId(jobId) {
  const normalized = String(jobId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalized)) {
    throw new Error("job ID가 올바르지 않습니다.");
  }
  return normalized;
}

function canonicalLegacyLocation({ jobsDir, jobDir, jobId, generationPath }) {
  const safeJobId = assertLegacyJobId(jobId);
  const canonicalJobsDir = canonicalStoragePath(
    jobsDir || dirname(canonicalStoragePath(jobDir, "legacy Gemini job")),
    "legacy Gemini jobs root"
  );
  const canonicalJobDir = join(canonicalJobsDir, safeJobId);
  if (jobDir != null && canonicalStoragePath(jobDir, "legacy Gemini job") !== canonicalJobDir) {
    throw legacyStorageError("legacy Gemini job 경로가 canonical jobs direct-child 경계가 아닙니다.");
  }
  const canonicalGenerationPath = join(canonicalJobDir, "gemini-generation.json");
  if (generationPath != null
    && canonicalStoragePath(generationPath, "legacy Gemini generation") !== canonicalGenerationPath) {
    throw legacyStorageError("legacy Gemini generation 경로가 canonical job leaf가 아닙니다.");
  }
  return {
    jobsDir: canonicalJobsDir,
    jobDir: canonicalJobDir,
    jobId: safeJobId,
    generationPath: canonicalGenerationPath,
    receiptPath: join(canonicalJobDir, GEMINI_LEGACY_ABANDONMENT_NAME)
  };
}

function directoryOpenFlags() {
  return fsConstants.O_RDONLY
    | fsConstants.O_NOFOLLOW
    | fsConstants.O_NONBLOCK
    | (fsConstants.O_DIRECTORY || 0);
}

function openAbsoluteDirectoryPinned(path, label) {
  const segments = path.split("/").filter(Boolean);
  const entries = [];
  let currentFd = openSync("/", directoryOpenFlags());
  try {
    let currentPath = "/";
    let identity = statFd(currentFd);
    if (!identity.isDirectory()) throw legacyStorageError(`${label} ancestry root가 디렉터리가 아닙니다.`);
    entries.push({ path: currentPath, fd: currentFd, identity });
    for (const segment of segments) {
      const nextFd = openDirectoryAt(currentFd, segment);
      identity = statFd(nextFd);
      if (!identity.isDirectory()) {
        closeFd(nextFd);
        throw legacyStorageError(`${label} ancestry가 디렉터리가 아닙니다.`);
      }
      currentPath = currentPath === "/" ? `/${segment}` : `${currentPath}/${segment}`;
      entries.push({ path: currentPath, fd: nextFd, identity });
      currentFd = nextFd;
    }
    return { path, entries, fd: currentFd, identity: entries.at(-1).identity };
  } catch (error) {
    for (const entry of entries.reverse()) {
      try { closeFd(entry.fd); } catch {}
    }
    if (entries.length === 0) {
      try { closeFd(currentFd); } catch {}
    }
    throw error;
  }
}

function closeAbsoluteDirectoryPinned(boundary) {
  for (const entry of [...(boundary?.entries || [])].reverse()) {
    try { closeFd(entry.fd); } catch {}
  }
}

function openLegacyJobBoundary(location) {
  const jobsRoot = openAbsoluteDirectoryPinned(location.jobsDir, "legacy Gemini jobs root");
  let jobFd = null;
  try {
    jobFd = openDirectoryAt(jobsRoot.fd, location.jobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw legacyStorageError("legacy Gemini job entry가 디렉터리가 아닙니다.");
    return { location, jobsRoot, jobFd, jobIdentity };
  } catch (error) {
    if (jobFd !== null) closeFd(jobFd);
    closeAbsoluteDirectoryPinned(jobsRoot);
    throw error;
  }
}

function closeLegacyJobBoundary(boundary) {
  if (boundary?.jobFd !== null && boundary?.jobFd !== undefined) {
    try { closeFd(boundary.jobFd); } catch {}
  }
  closeAbsoluteDirectoryPinned(boundary?.jobsRoot);
}

function sameDirectoryAncestry(left, right) {
  return left.entries.length === right.entries.length
    && left.entries.every((entry, index) => (
      entry.path === right.entries[index].path
      && sameFdIdentity(entry.identity, right.entries[index].identity)
    ));
}

function reopenLegacyJobBoundary(boundary) {
  const current = openLegacyJobBoundary(boundary.location);
  if (!sameDirectoryAncestry(boundary.jobsRoot, current.jobsRoot)
    || !sameFdIdentity(boundary.jobIdentity, current.jobIdentity)) {
    closeLegacyJobBoundary(current);
    throw legacyStorageError("legacy Gemini canonical jobs/job ancestry가 처리 중 교체되었습니다.");
  }
  return current;
}

function sameFileFingerprint(left, right) {
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

function openStrictLegacyLeaf(directoryFd, name, maximumBytes, { allowMissing = false } = {}) {
  let fd;
  try {
    fd = openFileAt(directoryFd, name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size > BigInt(maximumBytes)) {
      throw legacyStorageError(`${name}은 bounded single-link regular file이어야 합니다.`);
    }
    return { fd, identity };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function readStrictLegacyLeaf(boundary, name, maximumBytes, { allowMissing = false } = {}) {
  const leaf = openStrictLegacyLeaf(boundary.jobFd, name, maximumBytes, { allowMissing });
  if (!leaf) {
    const current = reopenLegacyJobBoundary(boundary);
    try {
      const canonical = openStrictLegacyLeaf(current.jobFd, name, maximumBytes, { allowMissing: true });
      if (canonical) {
        closeFd(canonical.fd);
        throw legacyStorageError(`${name} canonical path가 missing 확인 중 생성되었습니다.`);
      }
    } finally {
      closeLegacyJobBoundary(current);
    }
    return null;
  }
  try {
    const bytes = readFdBuffer(leaf.fd, { maxBytes: maximumBytes });
    const after = statFd(leaf.fd);
    if (after.nlink !== 1n || !sameFileFingerprint(leaf.identity, after)) {
      throw legacyStorageError(`${name}이 same-fd bounded read 중 변경되었습니다.`);
    }
    const current = reopenLegacyJobBoundary(boundary);
    let canonical = null;
    try {
      canonical = openStrictLegacyLeaf(current.jobFd, name, maximumBytes);
      if (!sameFileFingerprint(leaf.identity, canonical.identity)) {
        throw legacyStorageError(`${name} canonical path가 읽는 중 교체되었습니다.`);
      }
    } finally {
      if (canonical) closeFd(canonical.fd);
      closeLegacyJobBoundary(current);
    }
    return { bytes, identity: leaf.identity };
  } finally {
    closeFd(leaf.fd);
  }
}

function assertLegacyLeafCurrent(boundary, name, maximumBytes, expectedIdentity) {
  const current = reopenLegacyJobBoundary(boundary);
  let leaf = null;
  try {
    leaf = openStrictLegacyLeaf(current.jobFd, name, maximumBytes, { allowMissing: expectedIdentity === null });
    if (expectedIdentity === null ? leaf !== null : !leaf || !sameFileFingerprint(expectedIdentity, leaf.identity)) {
      throw legacyStorageError(`${name} canonical path가 검증 이후 변경되었습니다.`);
    }
  } finally {
    if (leaf) closeFd(leaf.fd);
    closeLegacyJobBoundary(current);
  }
}

function strictLegacyUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw legacyStorageError(`${label}이 올바른 UTF-8이 아닙니다.`);
  }
}

function parseStrictLegacyJson(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(strictLegacyUtf8(bytes, label));
  } catch (error) {
    if (error?.code === "GEMINI_LEGACY_STORAGE_UNSAFE") throw error;
    throw legacyStorageError(`${label}이 올바른 JSON이 아닙니다.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw legacyStorageError(`${label}은 JSON object여야 합니다.`);
  }
  return parsed;
}

function assertSuppliedGenerationMatches(actual, supplied) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)
    || hashJson(actual) !== hashJson(supplied)) {
    throw legacyStorageError("supplied legacy generation이 canonical generation bytes와 일치하지 않습니다.");
  }
}

function openExistingEvidenceBoundary(jobBoundary, { allowMissing = false } = {}) {
  let evidenceFd;
  try {
    evidenceFd = openDirectoryAt(jobBoundary.jobFd, LEGACY_EVIDENCE_DIRECTORY_NAME);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const evidenceIdentity = statFd(evidenceFd);
    if (!evidenceIdentity.isDirectory() || (evidenceIdentity.mode & 0o077n) !== 0n) {
      throw legacyStorageError("legacy Gemini evidence ancestry는 private directory여야 합니다.");
    }
    return { evidenceFd, evidenceIdentity };
  } catch (error) {
    closeFd(evidenceFd);
    throw error;
  }
}

function closeEvidenceBoundary(evidence) {
  if (evidence?.evidenceFd !== null && evidence?.evidenceFd !== undefined) {
    try { closeFd(evidence.evidenceFd); } catch {}
  }
}

function reopenEvidenceBoundary(jobBoundary, evidenceIdentity) {
  const currentJob = reopenLegacyJobBoundary(jobBoundary);
  let evidence = null;
  try {
    evidence = openExistingEvidenceBoundary(currentJob);
    if (!sameFdIdentity(evidenceIdentity, evidence.evidenceIdentity)) {
      throw legacyStorageError("legacy Gemini evidence directory가 처리 중 교체되었습니다.");
    }
    return { currentJob, evidence };
  } catch (error) {
    closeEvidenceBoundary(evidence);
    closeLegacyJobBoundary(currentJob);
    throw error;
  }
}

function closeReopenedEvidenceBoundary(current) {
  closeEvidenceBoundary(current?.evidence);
  closeLegacyJobBoundary(current?.currentJob);
}

function readStrictEvidenceLeaf(jobBoundary, evidence, name, maximumBytes, { allowMissing = false } = {}) {
  const leaf = openStrictLegacyLeaf(evidence.evidenceFd, name, maximumBytes, { allowMissing });
  if (!leaf) {
    const current = reopenEvidenceBoundary(jobBoundary, evidence.evidenceIdentity);
    try {
      const canonical = openStrictLegacyLeaf(current.evidence.evidenceFd, name, maximumBytes, { allowMissing: true });
      if (canonical) {
        closeFd(canonical.fd);
        throw legacyStorageError(`${name} canonical evidence path가 missing 확인 중 생성되었습니다.`);
      }
    } finally {
      closeReopenedEvidenceBoundary(current);
    }
    return null;
  }
  try {
    if ((leaf.identity.mode & 0o077n) !== 0n) {
      throw legacyStorageError(`${name} evidence는 private regular file이어야 합니다.`);
    }
    const bytes = readFdBuffer(leaf.fd, { maxBytes: maximumBytes });
    const after = statFd(leaf.fd);
    if (after.nlink !== 1n || !sameFileFingerprint(leaf.identity, after)) {
      throw legacyStorageError(`${name} evidence가 same-fd bounded read 중 변경되었습니다.`);
    }
    const current = reopenEvidenceBoundary(jobBoundary, evidence.evidenceIdentity);
    let canonical = null;
    try {
      canonical = openStrictLegacyLeaf(current.evidence.evidenceFd, name, maximumBytes);
      if (!sameFileFingerprint(leaf.identity, canonical.identity)) {
        throw legacyStorageError(`${name} canonical evidence path가 읽는 중 교체되었습니다.`);
      }
    } finally {
      if (canonical) closeFd(canonical.fd);
      closeReopenedEvidenceBoundary(current);
    }
    return { bytes, identity: leaf.identity };
  } finally {
    closeFd(leaf.fd);
  }
}

function assertEvidenceLeafCurrent(jobBoundary, evidence, name, maximumBytes, expectedIdentity) {
  const current = reopenEvidenceBoundary(jobBoundary, evidence.evidenceIdentity);
  let leaf = null;
  try {
    leaf = openStrictLegacyLeaf(current.evidence.evidenceFd, name, maximumBytes, { allowMissing: expectedIdentity === null });
    if (expectedIdentity === null ? leaf !== null : !leaf || !sameFileFingerprint(expectedIdentity, leaf.identity)) {
      throw legacyStorageError(`${name} canonical evidence path가 검증 이후 변경되었습니다.`);
    }
  } finally {
    if (leaf) closeFd(leaf.fd);
    closeReopenedEvidenceBoundary(current);
  }
}

function publishLegacyReceipt(jobBoundary, bytes) {
  if (bytes.byteLength > LEGACY_ABANDONMENT_MAX_BYTES) {
    throw legacyStorageError("legacy Gemini 폐기 영수증이 byte limit을 초과했습니다.");
  }
  let fd = null;
  try {
    fd = createFileAt(
      jobBoundary.jobFd,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      fsConstants.O_RDWR,
      0o600,
      { initialBytes: bytes }
    );
    fchmodSync(fd, 0o600);
    syncFd(fd);
    syncFd(jobBoundary.jobFd);
    const identity = statFd(fd);
    if (!identity.isFile() || identity.nlink !== 1n || identity.size !== BigInt(bytes.byteLength)) {
      throw legacyStorageError("legacy Gemini 폐기 영수증 publication이 안전하지 않습니다.");
    }
    return identity;
  } finally {
    if (fd !== null) closeFd(fd);
  }
}

function publishEvidenceLeaf(evidence, name, bytes, maximumBytes) {
  if (bytes.byteLength > maximumBytes) throw legacyStorageError(`${name} evidence가 byte limit을 초과했습니다.`);
  replaceFileAt(evidence.evidenceFd, name, bytes, {
    mode: 0o400,
    expectedIdentity: null
  });
  const leaf = openStrictLegacyLeaf(evidence.evidenceFd, name, maximumBytes);
  try {
    fchmodSync(leaf.fd, 0o400);
    syncFd(leaf.fd);
    const identity = statFd(leaf.fd);
    if (!sameFdIdentity(leaf.identity, identity)
      || identity.nlink !== 1n
      || identity.size !== BigInt(bytes.byteLength)
      || (identity.mode & 0o777n) !== 0o400n) {
      throw legacyStorageError(`${name} evidence publication이 안전하지 않습니다.`);
    }
    return identity;
  } finally {
    closeFd(leaf.fd);
  }
}

function parseLoopbackOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error("저장된 Gemini CDP origin이 올바르지 않습니다."); }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || !parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("저장된 Gemini CDP는 경로·인증 정보가 없는 loopback HTTP origin이어야 합니다.");
  }
  return parsed.origin;
}

function canonicalTargetClass(target = {}) {
  let parsed;
  try { parsed = new URL(String(target.url || "")); } catch { return "invalid-url"; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "gemini.google.com") return String(target.type || "unknown").toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path === "/app") return "gemini-root";
  if (/^\/app\/[^/]+$/i.test(path)) return "gemini-conversation";
  if (/^\/videos(?:\/|$)/i.test(path)) return "gemini-generation";
  return "gemini-other";
}

function normalizedTargetIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function jsonListTargetIdentifier(target = {}) {
  const value = normalizedTargetIdentifier(target.id);
  if (!value) return null;
  const protocolAlias = target.targetId == null ? value : normalizedTargetIdentifier(target.targetId);
  return protocolAlias === value ? value : null;
}

function canonicalGeminiSubmissionUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "gemini.google.com"
    || parsed.port || parsed.username || parsed.password) return null;
  return parsed.pathname.replace(/\/+$/, "") === "/videos"
    ? "https://gemini.google.com/videos"
    : null;
}

function targetIdentifier(target = {}) {
  const value = normalizedTargetIdentifier(target.id ?? target.targetId);
  return value && value.length <= 256 ? value : null;
}

async function fetchCdpJson(origin, path, fetchFn) {
  let response;
  try {
    response = await fetchFn(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(2_500),
      headers: { accept: "application/json" }
    });
  } catch (error) {
    throw new Error(`저장된 loopback CDP를 읽을 수 없습니다 (${error.message}).`);
  }
  if (!response?.ok) throw new Error(`저장된 loopback CDP 응답이 올바르지 않습니다 (${response?.status || "unknown"}).`);
  try { return await response.json(); } catch { throw new Error("저장된 loopback CDP가 malformed JSON을 반환했습니다."); }
}

async function readLegacyBrowserRuntime(version, expectedOrigin, WebSocketImpl = WebSocket) {
  let parsed;
  try { parsed = new URL(String(version?.webSocketDebuggerUrl || "")); } catch {
    throw new Error("저장된 loopback CDP browser WebSocket endpoint가 없습니다.");
  }
  const expected = new URL(parseLoopbackOrigin(expectedOrigin));
  if (parsed.protocol !== "ws:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.port !== expected.port || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9._~-]{1,256}$/.test(parsed.pathname)) {
    throw new Error("저장된 CDP browser WebSocket은 loopback endpoint여야 합니다.");
  }
  return new Promise((resolveRuntime, rejectRuntime) => {
    let socket;
    let settled = false;
    const results = new Map();
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      if (error) rejectRuntime(error);
      else resolveRuntime({ commandLine: results.get(1), version: results.get(2) });
    };
    const timer = setTimeout(() => finish(new Error("CDP browser-scope runtime 관측 시간이 초과되었습니다.")), 2_500);
    try { socket = new WebSocketImpl(parsed.href); } catch {
      finish(new Error("CDP browser-scope runtime 관측 연결을 만들 수 없습니다."));
      return;
    }
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: "Browser.getBrowserCommandLine", params: {} }));
        socket.send(JSON.stringify({ id: 2, method: "Browser.getVersion", params: {} }));
      } catch {
        finish(new Error("CDP browser-scope runtime 관측 명령을 보낼 수 없습니다."));
      }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); } catch {
        finish(new Error("CDP browser-scope runtime 관측 응답이 malformed JSON입니다."));
        return;
      }
      if (![1, 2].includes(message?.id)) return;
      if (message.error || !message.result) {
        finish(new Error("CDP browser-scope runtime 관측 명령이 거부되었습니다."));
        return;
      }
      results.set(message.id, message.result);
      if (results.size === 2) finish();
    });
    socket.addEventListener("error", () => finish(new Error("CDP browser-scope runtime 관측 연결에 실패했습니다.")), { once: true });
  });
}

export async function observeLegacyGeminiTargets({
  job,
  generation,
  fetchFn = fetch,
  now = () => new Date(),
  allowedTargetIds = [],
  readBrowserRuntimeFn = fetchFn?.readBrowserRuntimeFn || readLegacyBrowserRuntime
}) {
  const binding = canonicalGeminiSessionBinding(job);
  if (!binding) throw new Error("저장된 job의 Gemini 세션 결속을 확인할 수 없습니다.");
  const origin = parseLoopbackOrigin(binding.cdpOrigin);
  if (generation?.sessionBinding?.cdpOrigin !== origin
    || generation?.sessionBinding?.profilePathHash !== binding.profilePathHash
    || generation?.sessionBinding?.profileBasename !== binding.profileBasename) {
    throw new Error("저장된 job과 legacy generation의 Gemini 세션 결속이 일치하지 않습니다.");
  }
  const version = await fetchCdpJson(origin, "/json/version", fetchFn);
  const observedRuntime = await readBrowserRuntimeFn(version, origin);
  const runtimeProof = canonicalGeminiObservedRuntimeProof({
    job,
    version: observedRuntime?.version,
    commandLine: observedRuntime?.commandLine
  });
  if (!validateGeminiObservedRuntimeProof(runtimeProof, job)) {
    throw new Error("legacy 폐기 관측에는 저장된 세션과 결속된 실제 --headless=new Chrome 증명이 필요합니다.");
  }
  const targets = await fetchCdpJson(origin, "/json/list", fetchFn);
  if (!Array.isArray(targets) || targets.length > 10_000) throw new Error("저장된 loopback CDP target 목록이 올바르지 않습니다.");
  if (targets.some((target) => !target || typeof target !== "object"
    || typeof target.type !== "string" || typeof target.url !== "string"
    || !jsonListTargetIdentifier(target) || canonicalTargetClass(target) === "invalid-url")) {
    throw new Error("저장된 loopback CDP target 목록에 malformed 항목이 있습니다.");
  }
  const allowed = new Set((Array.isArray(allowedTargetIds) ? allowedTargetIds : [])
    .map(normalizedTargetIdentifier)
    .filter(Boolean));
  if (allowed.size !== (Array.isArray(allowedTargetIds) ? allowedTargetIds.length : 0)) {
    throw new Error("허용할 Gemini CDP target ID가 올바르지 않습니다.");
  }
  const classes = targets.map(canonicalTargetClass);
  const allowedMatches = targets
    .map((target, index) => allowed.has(jsonListTargetIdentifier(target)) ? index : -1)
    .filter((index) => index >= 0);
  const authorizedTargetIndexes = allowedMatches.filter((index) => (
    String(targets[index].type).toLowerCase() === "page"
    && (classes[index] === "gemini-root" || canonicalGeminiSubmissionUrl(targets[index].url) != null)
  ));
  if (allowed.size > 0 && (allowedMatches.length !== allowed.size || authorizedTargetIndexes.length !== allowed.size)) {
    throw new Error("현재 제출 직전 Gemini target을 live CDP 목록에서 정확히 결속할 수 없습니다.");
  }
  const prohibitedTargetCount = targets.filter((target, index) => (
    !allowed.has(jsonListTargetIdentifier(target))
    && ["gemini-conversation", "gemini-generation"].includes(classes[index])
  )).length;
  if (prohibitedTargetCount > 0) {
    throw new Error("기존 Gemini 대화 또는 생성 target이 남아 있어 legacy 제출을 폐기할 수 없습니다.");
  }
  const authorizedTargets = authorizedTargetIndexes.map((index) => targets[index]);
  const observedAt = now().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("관측 시각이 올바르지 않습니다.");
  const sanitizedTargets = targets.map((target, index) => ({
    ordinal: index,
    type: String(target.type).toLowerCase().slice(0, 40),
    class: classes[index],
    authorizedForCurrentSubmission: authorizedTargetIndexes.includes(index),
    targetIdHash: hashJson({ type: "cdp-target-id", value: jsonListTargetIdentifier(target) }),
    targetUrlHash: hashJson({ type: "cdp-target-url", value: String(target.url) })
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schemaVersion: 1,
    method: "loopback-cdp-json-and-browser-protocol-read-only",
    observedAt,
    cdpOrigin: origin,
    cdpOriginHash: hashJson({ type: "gemini-cdp-origin", origin }),
    browserVersionHash: runtimeProof.browserVersionHash,
    headless: true,
    headlessImplementation: "new",
    sessionBindingHash: hashJson(binding),
    runtimeProof,
    runtimeProofHash: geminiObservedRuntimeProofHash(runtimeProof),
    targetCount: targets.length,
    prohibitedTargetCount,
    authorizedTargetCount: authorizedTargets.length,
    authorizedTargetIdHashes: authorizedTargets
      .map((target) => hashJson({ type: "cdp-target-id", value: jsonListTargetIdentifier(target) }))
      .sort(),
    authorizedTargetSetHash: hashJson(sanitizedTargets.filter((target) => target.authorizedForCurrentSubmission)),
    geminiRootTargetCount: classes.filter((value) => value === "gemini-root").length,
    targetSetHash: hashJson(sanitizedTargets)
  };
}

function consumptionPayload(attestation) {
  const { attestationHash: _attestationHash, ...payload } = attestation || {};
  return payload;
}

export function validateLegacyGeminiAbandonmentConsumption({ attestation, abandonmentReceipt, generation }) {
  if (!attestation || attestation.schemaVersion !== 1 || attestation.type !== "gemini-legacy-abandonment-consumption") return false;
  const observation = attestation.liveCdpObservation;
  const observedAt = Date.parse(observation?.observedAt);
  const consumedAt = Date.parse(attestation.consumedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(consumedAt) || consumedAt < observedAt || consumedAt - observedAt > 60_000) return false;
  const generationBindings = [
    ...(Array.isArray(generation?.segments) ? generation.segments : []),
    ...(generation?.pendingSegment ? [generation.pendingSegment] : [])
  ];
  const exactSubmissionBinding = generationBindings.some((binding) => (
    binding?.index === attestation.segmentIndex
    && binding.promptHash === attestation.promptHash
    && (binding.submissionRunId || binding.sourceRunId || binding.runId) === attestation.runId
  ));
  if (!String(attestation.runId || "").trim()
    || !/^sha256:[a-f0-9]{64}$/.test(String(attestation.requestHash || ""))
    || attestation.requestHash !== generation?.requestHash
    || attestation.resumeRequestHash !== generation?.resumeRequestHash
    || !Number.isInteger(attestation.segmentIndex) || attestation.segmentIndex < 1
    || attestation.segmentIndex > Number(generation?.request?.clipCount || 0)
    || !/^sha256:[a-f0-9]{64}$/.test(String(attestation.promptHash || ""))
    || attestation.sourceAbandonmentReceiptHash !== abandonmentReceipt?.receiptHash
    || attestation.sourceGenerationSha256 !== abandonmentReceipt?.sourceGenerationSha256
    || !/^sha256:[a-f0-9]{64}$/.test(String(attestation.currentTargetIdHash || ""))
    || !exactSubmissionBinding) return false;
  if (observation?.schemaVersion !== 1
    || observation.method !== "loopback-cdp-json-and-browser-protocol-read-only"
    || observation.headless !== true
    || observation.headlessImplementation !== "new"
    || observation.prohibitedTargetCount !== 0
    || observation.authorizedTargetCount !== 1
    || !Array.isArray(observation.authorizedTargetIdHashes)
    || observation.authorizedTargetIdHashes.length !== 1
    || observation.authorizedTargetIdHashes[0] !== attestation.currentTargetIdHash
    || !Number.isInteger(observation.targetCount) || observation.targetCount < 1
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.cdpOriginHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.browserVersionHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.targetSetHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.authorizedTargetSetHash || ""))
    || observation.runtimeProofHash !== geminiObservedRuntimeProofHash(observation.runtimeProof)
    || observation.runtimeProofHash !== abandonmentReceipt?.liveCdpObservation?.runtimeProofHash
    || !validateGeminiObservedRuntimeProof(observation.runtimeProof, generation?.sessionBinding)
    || observation.sessionBindingHash !== generation?.sessionBindingHash
    || observation.cdpOriginHash !== abandonmentReceipt?.liveCdpObservation?.cdpOriginHash) return false;
  return attestation.attestationHash === hashJson(consumptionPayload(attestation));
}

export async function attestLegacyGeminiAbandonmentConsumption({
  job,
  generation,
  abandonmentReceipt,
  currentTargetId,
  runId,
  requestHash,
  resumeRequestHash,
  segmentIndex,
  promptHash,
  fetchFn = fetch,
  now = () => new Date(),
  observeFn = observeLegacyGeminiTargets
}) {
  const normalizedTargetId = targetIdentifier({ id: currentTargetId });
  if (!normalizedTargetId) throw new Error("현재 제출 직전 Gemini target ID가 올바르지 않습니다.");
  if (!abandonmentReceipt || !/^sha256:[a-f0-9]{64}$/.test(String(abandonmentReceipt.receiptHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(abandonmentReceipt.sourceGenerationSha256 || ""))) {
    throw new Error("legacy 폐기 영수증 결속이 올바르지 않습니다.");
  }
  if (!String(runId || "").trim() || !/^sha256:[a-f0-9]{64}$/.test(String(requestHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(resumeRequestHash || ""))
    || !Number.isInteger(segmentIndex) || segmentIndex < 1
    || !/^sha256:[a-f0-9]{64}$/.test(String(promptHash || ""))) {
    throw new Error("legacy 폐기 소비 요청 결속이 올바르지 않습니다.");
  }
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const exactSubmissionBinding = [
    ...(Array.isArray(generation?.segments) ? generation.segments : []),
    ...(generation?.pendingSegment ? [generation.pendingSegment] : [])
  ].some((binding) => binding?.index === segmentIndex
    && binding.promptHash === promptHash
    && (binding.submissionRunId || binding.sourceRunId || binding.runId) === runId);
  if (!sessionBinding
    || generation?.jobId !== job?.id
    || generation?.runId !== runId
    || generation?.requestHash !== requestHash
    || generation?.resumeRequestHash !== resumeRequestHash
    || generation?.sessionBindingHash !== hashJson(sessionBinding)
    || segmentIndex > Number(generation?.request?.clipCount || 0)
    || !exactSubmissionBinding) {
    throw new Error("legacy 폐기 소비의 job·요청·세션 결속이 일치하지 않습니다.");
  }
  const liveCdpObservation = await observeFn({
    job,
    generation,
    fetchFn,
    now,
    allowedTargetIds: [normalizedTargetId]
  });
  if (liveCdpObservation?.headless !== true
    || liveCdpObservation.headlessImplementation !== "new"
    || liveCdpObservation.prohibitedTargetCount !== 0
    || liveCdpObservation.authorizedTargetCount !== 1
    || liveCdpObservation.sessionBindingHash !== generation.sessionBindingHash
    || liveCdpObservation.runtimeProofHash !== abandonmentReceipt.liveCdpObservation?.runtimeProofHash
    || liveCdpObservation.cdpOriginHash !== abandonmentReceipt.liveCdpObservation?.cdpOriginHash) {
    throw new Error("legacy 폐기 소비 직전 CDP 관측을 신뢰할 수 없습니다.");
  }
  const consumedAt = now().toISOString();
  if (!Number.isFinite(Date.parse(consumedAt))) throw new Error("legacy 폐기 소비 시각이 올바르지 않습니다.");
  const payload = {
    schemaVersion: 1,
    type: "gemini-legacy-abandonment-consumption",
    consumedAt,
    runId: String(runId),
    requestHash,
    resumeRequestHash,
    segmentIndex,
    promptHash,
    sourceAbandonmentReceiptHash: abandonmentReceipt.receiptHash,
    sourceGenerationSha256: abandonmentReceipt.sourceGenerationSha256,
    currentTargetIdHash: hashJson({ type: "cdp-target-id", value: normalizedTargetId }),
    liveCdpObservation
  };
  return { ...payload, attestationHash: hashJson(payload) };
}

function normalizeSha256(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const withPrefix = /^[a-f0-9]{64}$/.test(normalized) ? `sha256:${normalized}` : normalized;
  if (!/^sha256:[a-f0-9]{64}$/.test(withPrefix)) throw new Error("expected generation SHA-256가 올바르지 않습니다.");
  return withPrefix;
}

function abandonmentPayload(receipt) {
  const { receiptHash: _receiptHash, ...payload } = receipt || {};
  return payload;
}

export function legacyGeminiGenerationNeedsAbandonment(generation) {
  return Boolean(
    generation?.provider === "gemini-browser"
    && Number(generation?.schemaVersion || 0) < 4
    && generation?.status === "failed"
    && (!Array.isArray(generation?.segments) || generation.segments.length === 0)
  );
}

export function unsupportedLegacyGeminiFailure(generation) {
  return Boolean(
    generation?.provider === "gemini-browser"
    && Number(generation?.schemaVersion || 0) < 4
    && ["failed", "running"].includes(generation?.status)
    && !legacyGeminiGenerationNeedsAbandonment(generation)
  );
}

export function validateLegacyGeminiAbandonment({ jobId, generation, generationSha256, receipt }) {
  if (!legacyGeminiGenerationNeedsAbandonment(generation)) {
    return { required: false, allowed: true, receipt: null };
  }
  const reject = (reason) => ({ required: true, allowed: false, reason, receipt: null });
  if (!receipt || typeof receipt !== "object") return reject("operator-abandonment-receipt-missing");
  if (receipt.schemaVersion !== 2 || receipt.type !== "gemini-legacy-submission-abandonment") return reject("operator-abandonment-schema-invalid");
  if (receipt.jobId !== jobId || receipt.sourceGeneration?.jobId !== jobId) return reject("operator-abandonment-job-mismatch");
  if (receipt.sourceGeneration?.sha256 !== generationSha256) return reject("operator-abandonment-generation-hash-mismatch");
  if (receipt.sourceGeneration?.schemaVersion !== generation.schemaVersion) return reject("operator-abandonment-generation-schema-mismatch");
  if (receipt.sourceGeneration?.runId !== (generation.runId || null)) return reject("operator-abandonment-run-mismatch");
  if (receipt.sourceGeneration?.status !== generation.status) return reject("operator-abandonment-status-mismatch");
  if (receipt.authorization !== "explicit-operator-cli") return reject("operator-abandonment-authorization-invalid");
  if (receipt.operatorAssertion !== "no-live-recoverable-conversation-target") return reject("operator-abandonment-assertion-missing");
  const observation = receipt.liveCdpObservation;
  let observationOriginValid = false;
  try {
    observationOriginValid = hashJson({ type: "gemini-cdp-origin", origin: parseLoopbackOrigin(observation?.cdpOrigin) }) === observation?.cdpOriginHash;
  } catch {}
  if (observation?.schemaVersion !== 1 || observation.method !== "loopback-cdp-json-and-browser-protocol-read-only"
    || observation.headless !== true || observation.headlessImplementation !== "new" || observation.prohibitedTargetCount !== 0
    || !Number.isInteger(observation.targetCount) || observation.targetCount < 0
    || !Number.isInteger(observation.geminiRootTargetCount) || observation.geminiRootTargetCount < 0
    || !Number.isFinite(Date.parse(observation.observedAt))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.cdpOriginHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.browserVersionHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.targetSetHash || ""))
    || observation.runtimeProofHash !== geminiObservedRuntimeProofHash(observation.runtimeProof)
    || !validateGeminiObservedRuntimeProof(observation.runtimeProof, generation.sessionBinding)
    || observation.sessionBindingHash !== generation.sessionBindingHash
    || !observationOriginValid) {
    return reject("operator-abandonment-cdp-observation-invalid");
  }
  if (!Number.isFinite(Date.parse(receipt.authorizedAt))) return reject("operator-abandonment-time-invalid");
  if (typeof receipt.reason !== "string" || receipt.reason.trim().length < 12 || receipt.reason.length > 500) return reject("operator-abandonment-reason-invalid");
  if (receipt.receiptHash !== hashJson(abandonmentPayload(receipt))) return reject("operator-abandonment-integrity-failed");
  return {
    required: true,
    allowed: true,
    reason: "explicit-operator-abandonment",
    receipt: {
      path: GEMINI_LEGACY_ABANDONMENT_NAME,
      receiptHash: receipt.receiptHash,
      sourceGenerationSha256: generationSha256,
      authorizedAt: receipt.authorizedAt,
      authorization: receipt.authorization,
      operatorAssertion: receipt.operatorAssertion,
      liveCdpObservation: {
        observedAt: observation.observedAt,
        cdpOriginHash: observation.cdpOriginHash,
        targetCount: observation.targetCount,
        prohibitedTargetCount: observation.prohibitedTargetCount,
        targetSetHash: observation.targetSetHash,
        headless: observation.headless,
        headlessImplementation: observation.headlessImplementation,
        runtimeProofHash: observation.runtimeProofHash
      }
    }
  };
}

export async function readLegacyGeminiAbandonmentDecision(
  { jobId, jobDir, generation, generationPath },
  dependencies = {}
) {
  const location = canonicalLegacyLocation({ jobId, jobDir, generationPath });
  const boundary = openLegacyJobBoundary(location);
  try {
    const generationSnapshot = readStrictLegacyLeaf(
      boundary,
      "gemini-generation.json",
      LEGACY_GENERATION_MAX_BYTES
    );
    const canonicalGeneration = parseStrictLegacyJson(generationSnapshot.bytes, "gemini-generation.json");
    assertSuppliedGenerationMatches(canonicalGeneration, generation);
    if (canonicalGeneration.jobId !== location.jobId) {
      throw legacyStorageError("canonical legacy generation의 job ID가 일치하지 않습니다.");
    }
    await dependencies.afterGenerationReadForTest?.({ location, generationSnapshot });
    assertLegacyLeafCurrent(
      boundary,
      "gemini-generation.json",
      LEGACY_GENERATION_MAX_BYTES,
      generationSnapshot.identity
    );
    if (unsupportedLegacyGeminiFailure(canonicalGeneration)) {
      return { required: true, allowed: false, reason: "legacy-generation-shape-unsupported", receipt: null };
    }
    if (!legacyGeminiGenerationNeedsAbandonment(canonicalGeneration)) {
      return { required: false, allowed: true, receipt: null };
    }
    const receiptSnapshot = readStrictLegacyLeaf(
      boundary,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      { allowMissing: true }
    );
    const receipt = receiptSnapshot
      ? parseStrictLegacyJson(receiptSnapshot.bytes, GEMINI_LEGACY_ABANDONMENT_NAME)
      : null;
    assertLegacyLeafCurrent(
      boundary,
      "gemini-generation.json",
      LEGACY_GENERATION_MAX_BYTES,
      generationSnapshot.identity
    );
    assertLegacyLeafCurrent(
      boundary,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      receiptSnapshot?.identity || null
    );
    return validateLegacyGeminiAbandonment({
      jobId: location.jobId,
      generation: canonicalGeneration,
      generationSha256: hashBytes(generationSnapshot.bytes),
      receipt
    });
  } finally {
    closeLegacyJobBoundary(boundary);
  }
}

export async function createLegacyGeminiAbandonment({
  jobsDir,
  jobId,
  expectedGenerationSha256,
  reason,
  assertNoLiveTarget = false,
  now = () => new Date(),
  fetchFn = fetch
}, dependencies = {}) {
  const safeJobId = assertLegacyJobId(jobId);
  if (assertNoLiveTarget !== true) throw new Error("--assert-no-live-target 확인이 필요합니다.");
  const normalizedExpectedHash = normalizeSha256(expectedGenerationSha256);
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length < 12 || normalizedReason.length > 500) throw new Error("폐기 사유는 12~500자로 입력하세요.");
  const location = canonicalLegacyLocation({ jobsDir, jobId: safeJobId });
  const boundary = openLegacyJobBoundary(location);
  try {
    const generationSnapshot = readStrictLegacyLeaf(
      boundary,
      "gemini-generation.json",
      LEGACY_GENERATION_MAX_BYTES
    );
    const actualHash = hashBytes(generationSnapshot.bytes);
    if (actualHash !== normalizedExpectedHash) {
      throw new Error(`Gemini generation SHA-256가 일치하지 않습니다. 현재 값: ${actualHash}`);
    }
    const generation = parseStrictLegacyJson(generationSnapshot.bytes, "gemini-generation.json");
    if (generation.jobId !== safeJobId || !legacyGeminiGenerationNeedsAbandonment(generation)) {
      throw new Error("명시적 폐기가 필요한 legacy Gemini 실패 영수증이 아닙니다.");
    }
    const jobSnapshot = readStrictLegacyLeaf(boundary, "job.json", LEGACY_JOB_MAX_BYTES);
    const job = parseStrictLegacyJson(jobSnapshot.bytes, "job.json");
    if (job.id !== safeJobId) throw new Error("저장된 job.json의 job ID가 일치하지 않습니다.");
    const existingReceipt = readStrictLegacyLeaf(
      boundary,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      { allowMissing: true }
    );
    if (existingReceipt) throw new Error("이 작업에는 이미 legacy Gemini 폐기 영수증이 있습니다.");

    await dependencies.afterPinnedReadForTest?.({ location, generationSnapshot, jobSnapshot });
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    assertLegacyLeafCurrent(boundary, "job.json", LEGACY_JOB_MAX_BYTES, jobSnapshot.identity);
    assertLegacyLeafCurrent(boundary, GEMINI_LEGACY_ABANDONMENT_NAME, LEGACY_ABANDONMENT_MAX_BYTES, null);

    const liveCdpObservation = await observeLegacyGeminiTargets({ job, generation, fetchFn, now });
    const authorizedAt = now().toISOString();
    const payload = {
      schemaVersion: 2,
      type: "gemini-legacy-submission-abandonment",
      jobId: safeJobId,
      authorization: "explicit-operator-cli",
      operatorAssertion: "no-live-recoverable-conversation-target",
      reason: normalizedReason,
      authorizedAt,
      liveCdpObservation,
      sourceGeneration: {
        jobId: safeJobId,
        schemaVersion: generation.schemaVersion,
        runId: generation.runId || null,
        status: generation.status,
        sha256: actualHash
      }
    };
    const receipt = { ...payload, receiptHash: hashJson(payload) };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
    if (receiptBytes.byteLength > LEGACY_ABANDONMENT_MAX_BYTES) {
      throw legacyStorageError("legacy Gemini 폐기 영수증이 byte limit을 초과했습니다.");
    }

    await dependencies.beforeReceiptPublishForTest?.({ location, receipt });
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    assertLegacyLeafCurrent(boundary, "job.json", LEGACY_JOB_MAX_BYTES, jobSnapshot.identity);
    assertLegacyLeafCurrent(boundary, GEMINI_LEGACY_ABANDONMENT_NAME, LEGACY_ABANDONMENT_MAX_BYTES, null);
    const receiptIdentity = publishLegacyReceipt(boundary, receiptBytes);
    assertLegacyLeafCurrent(
      boundary,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      receiptIdentity
    );
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    return { receiptPath: location.receiptPath, receipt };
  } finally {
    closeLegacyJobBoundary(boundary);
  }
}

export async function preserveLegacyGeminiAbandonmentEvidence({ jobId, jobDir, generationPath }, dependencies = {}) {
  const location = canonicalLegacyLocation({ jobId, jobDir, generationPath });
  const boundary = openLegacyJobBoundary(location);
  let evidence = null;
  try {
    const generationSnapshot = readStrictLegacyLeaf(
      boundary,
      "gemini-generation.json",
      LEGACY_GENERATION_MAX_BYTES
    );
    const receiptSnapshot = readStrictLegacyLeaf(
      boundary,
      GEMINI_LEGACY_ABANDONMENT_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES
    );
    const generation = parseStrictLegacyJson(generationSnapshot.bytes, "gemini-generation.json");
    const receipt = parseStrictLegacyJson(receiptSnapshot.bytes, GEMINI_LEGACY_ABANDONMENT_NAME);
    if (generation.jobId !== location.jobId) {
      throw legacyStorageError("canonical legacy generation의 job ID가 일치하지 않습니다.");
    }
    const generationSha256 = hashBytes(generationSnapshot.bytes);
    const decision = validateLegacyGeminiAbandonment({
      jobId: location.jobId,
      generation,
      generationSha256,
      receipt
    });
    if (!decision.allowed || !decision.required) throw new Error("legacy Gemini 폐기 증거를 보존할 수 없습니다.");

    await dependencies.afterEvidenceSourceReadForTest?.({ location, generationSnapshot, receiptSnapshot });
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    assertLegacyLeafCurrent(boundary, GEMINI_LEGACY_ABANDONMENT_NAME, LEGACY_ABANDONMENT_MAX_BYTES, receiptSnapshot.identity);

    evidence = openExistingEvidenceBoundary(boundary, { allowMissing: true });
    if (!evidence) {
      mkdirAt(boundary.jobFd, LEGACY_EVIDENCE_DIRECTORY_NAME, 0o700);
      syncFd(boundary.jobFd);
      evidence = openExistingEvidenceBoundary(boundary);
      syncFd(evidence.evidenceFd);
      const canonical = reopenEvidenceBoundary(boundary, evidence.evidenceIdentity);
      closeReopenedEvidenceBoundary(canonical);
    }

    const existingGeneration = readStrictEvidenceLeaf(
      boundary,
      evidence,
      LEGACY_GENERATION_EVIDENCE_NAME,
      LEGACY_GENERATION_MAX_BYTES,
      { allowMissing: true }
    );
    const existingReceipt = readStrictEvidenceLeaf(
      boundary,
      evidence,
      LEGACY_RECEIPT_EVIDENCE_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      { allowMissing: true }
    );
    if (existingGeneration && !existingGeneration.bytes.equals(generationSnapshot.bytes)) {
      throw new Error("기존 legacy generation 보존 증거가 현재 영수증과 일치하지 않습니다.");
    }
    if (existingReceipt && !existingReceipt.bytes.equals(receiptSnapshot.bytes)) {
      throw new Error("기존 legacy 폐기 보존 증거가 현재 영수증과 일치하지 않습니다.");
    }

    await dependencies.beforeEvidencePublishForTest?.({ location });
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    assertLegacyLeafCurrent(boundary, GEMINI_LEGACY_ABANDONMENT_NAME, LEGACY_ABANDONMENT_MAX_BYTES, receiptSnapshot.identity);
    assertEvidenceLeafCurrent(
      boundary,
      evidence,
      LEGACY_GENERATION_EVIDENCE_NAME,
      LEGACY_GENERATION_MAX_BYTES,
      existingGeneration?.identity || null
    );
    assertEvidenceLeafCurrent(
      boundary,
      evidence,
      LEGACY_RECEIPT_EVIDENCE_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      existingReceipt?.identity || null
    );

    const generationEvidenceIdentity = existingGeneration?.identity
      || publishEvidenceLeaf(evidence, LEGACY_GENERATION_EVIDENCE_NAME, generationSnapshot.bytes, LEGACY_GENERATION_MAX_BYTES);
    const receiptEvidenceIdentity = existingReceipt?.identity
      || publishEvidenceLeaf(evidence, LEGACY_RECEIPT_EVIDENCE_NAME, receiptSnapshot.bytes, LEGACY_ABANDONMENT_MAX_BYTES);
    if (existingGeneration) {
      const leaf = openStrictLegacyLeaf(evidence.evidenceFd, LEGACY_GENERATION_EVIDENCE_NAME, LEGACY_GENERATION_MAX_BYTES);
      try { syncFd(leaf.fd); } finally { closeFd(leaf.fd); }
    }
    if (existingReceipt) {
      const leaf = openStrictLegacyLeaf(evidence.evidenceFd, LEGACY_RECEIPT_EVIDENCE_NAME, LEGACY_ABANDONMENT_MAX_BYTES);
      try { syncFd(leaf.fd); } finally { closeFd(leaf.fd); }
    }
    syncFd(evidence.evidenceFd);
    syncFd(boundary.jobFd);

    assertEvidenceLeafCurrent(
      boundary,
      evidence,
      LEGACY_GENERATION_EVIDENCE_NAME,
      LEGACY_GENERATION_MAX_BYTES,
      generationEvidenceIdentity
    );
    assertEvidenceLeafCurrent(
      boundary,
      evidence,
      LEGACY_RECEIPT_EVIDENCE_NAME,
      LEGACY_ABANDONMENT_MAX_BYTES,
      receiptEvidenceIdentity
    );
    assertLegacyLeafCurrent(boundary, "gemini-generation.json", LEGACY_GENERATION_MAX_BYTES, generationSnapshot.identity);
    assertLegacyLeafCurrent(boundary, GEMINI_LEGACY_ABANDONMENT_NAME, LEGACY_ABANDONMENT_MAX_BYTES, receiptSnapshot.identity);

    return {
      schemaVersion: 1,
      generationPath: `${LEGACY_EVIDENCE_DIRECTORY_NAME}/${LEGACY_GENERATION_EVIDENCE_NAME}`,
      generationSha256,
      receiptPath: `${LEGACY_EVIDENCE_DIRECTORY_NAME}/${LEGACY_RECEIPT_EVIDENCE_NAME}`,
      receiptSha256: hashBytes(receiptSnapshot.bytes),
      receiptHash: receipt.receiptHash
    };
  } finally {
    closeEvidenceBoundary(evidence);
    closeLegacyJobBoundary(boundary);
  }
}
