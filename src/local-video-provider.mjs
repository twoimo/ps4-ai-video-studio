import { constants as fsConstants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { hashFile, writeJsonAtomic } from "./run-ledger.mjs";
import { BFL_EXECUTOR_SNAPSHOT_NAME, persistBflExecutorSnapshot } from "./bfl-executor-snapshot.mjs";
import { JOBS_DIR } from "./pipeline.mjs";
import { providerPromptBindingForSegment, providerRequestFieldsForSegment } from "./shot-patterns.mjs";
import {
  BFL_MODEL,
  BFL_MODEL_VERSION,
  assertBflValueDoesNotContainApiKey,
  bindBflLaunchCapabilityToRequest,
  claimBflProviderExecution,
  hashBflApprovalValue,
  validateBflConsumedApprovalAuthorizationReceipt,
  validateBflProviderExecutionClaimReceipt,
  validateBflRequestClaimReceipt,
  validateHistoricalBflPaidApprovalReceipt,
  validateHistoricalBflRequestAuthorization,
  validateBflRequestAuthorization,
  verifyBflConsumedApprovalForRequest
} from "./bfl-paid-approval.mjs";
import { closeFd, openDirectoryAt, openFileAt, readFdBuffer, sameFdIdentity, statFd } from "./dirfd.mjs";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const BFL_TERMINAL_SUCCESS_STATUSES = new Set(["ready", "completed", "complete", "succeeded", "success"]);
const BFL_POLLING_ORIGINS = new Set(["https://api.bfl.ai", "https://api.eu.bfl.ai", "https://api.us.bfl.ai"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/u;
export const LOCAL_VIDEO_SUBMIT_INTENT_NAME = ".local-video-provider-submit-intent.json";
export const LOCAL_VIDEO_EXECUTOR_SNAPSHOT_NAME = BFL_EXECUTOR_SNAPSHOT_NAME;
export const LOCAL_VIDEO_SUBMIT_INTENT_MAX_BYTES = 64 * 1024;

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

async function openProviderJobsRootStrict(path) {
  const pathIdentity = await lstat(path, { bigint: true });
  if (!pathIdentity.isDirectory() || pathIdentity.isSymbolicLink?.()) throw new Error("local-video jobs root가 exact non-symlink directory가 아닙니다.");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | (fsConstants.O_DIRECTORY || 0));
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameFdIdentity(pathIdentity, identity)) throw new Error("local-video jobs root가 open 중 교체되었습니다.");
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function preflightLocalVideoStorage(jobId, runId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) throw new Error("local-video jobId가 안전하지 않습니다.");
  if (typeof runId !== "string" || !runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw new Error("local-video runId가 안전하지 않습니다.");
  }
  const jobsRoot = await openProviderJobsRootStrict(JOBS_DIR);
  const opened = [];
  try {
    const jobFd = openDirectoryAt(jobsRoot.handle.fd, jobId); opened.push(jobFd);
    const clipsFd = openDirectoryAt(jobFd, "clips"); opened.push(clipsFd);
    const runsFd = openDirectoryAt(jobFd, "runs"); opened.push(runsFd);
    const runFd = openDirectoryAt(runsFd, runId); opened.push(runFd);
    const identities = [statFd(jobFd), statFd(clipsFd), statFd(runsFd), statFd(runFd)];
    if (identities.some((identity) => !identity.isDirectory())) throw new Error("local-video 저장 ancestry가 디렉터리가 아닙니다.");
    const assertOptionalOwnedFile = (parentFd, name, label) => {
      let fd;
      try {
        fd = openFileAt(parentFd, name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw new Error(`${label}가 exact non-symlink regular file이 아닙니다.`);
      }
      try {
        const identity = statFd(fd);
        if (!identity.isFile() || identity.nlink !== 1n) throw new Error(`${label}가 single-link regular file이 아닙니다.`);
      } finally {
        closeFd(fd);
      }
    };
    assertOptionalOwnedFile(jobFd, LOCAL_VIDEO_EXECUTOR_SNAPSHOT_NAME, "local-video executor snapshot");
    assertOptionalOwnedFile(jobFd, LOCAL_VIDEO_SUBMIT_INTENT_NAME, "local-video submit intent");
    assertOptionalOwnedFile(runFd, "local-video-generation.json", "local-video generation receipt");
    const currentRoot = await openProviderJobsRootStrict(JOBS_DIR);
    const current = [];
    try {
      if (!sameFdIdentity(jobsRoot.identity, currentRoot.identity)) throw new Error("local-video jobs root가 선검증 중 교체되었습니다.");
      const currentJob = openDirectoryAt(currentRoot.handle.fd, jobId); current.push(currentJob);
      const currentClips = openDirectoryAt(currentJob, "clips"); current.push(currentClips);
      const currentRuns = openDirectoryAt(currentJob, "runs"); current.push(currentRuns);
      const currentRun = openDirectoryAt(currentRuns, runId); current.push(currentRun);
      if (current.some((fd, index) => !sameFdIdentity(identities[index], statFd(fd)))) throw new Error("local-video 저장 ancestry가 선검증 중 교체되었습니다.");
    } finally {
      for (const fd of current.reverse()) closeFd(fd);
      await currentRoot.handle.close();
    }
    return { jobDir: join(JOBS_DIR, jobId), clipsDir: join(JOBS_DIR, jobId, "clips"), runDir: join(JOBS_DIR, jobId, "runs", runId) };
  } catch (error) {
    const wrapped = new Error(`local-video 저장 경계 선검증 실패: ${error.message}`);
    wrapped.code = "LOCAL_VIDEO_STORAGE_UNSAFE";
    throw wrapped;
  } finally {
    for (const fd of opened.reverse()) closeFd(fd);
    await jobsRoot.handle.close();
  }
}

function assertNoConfiguredBflApiKey(value, apiKey = process.env.BFL_API_KEY) {
  const key = String(apiKey || "");
  if (key.trim()) assertBflValueDoesNotContainApiKey(value, key);
}

function exactLocalVideoSubmitIntentShape(intent) {
  const expected = [
    "createdAt", "executorSnapshotName", "executorSnapshotSha256", "generatorName", "generatorSha256",
    "intentHash", "jobId", "paidAuthorizationHash", "provider", "requestHash", "runId", "schemaVersion",
    "scriptHash", "status", "type"
  ];
  return Boolean(intent && typeof intent === "object" && !Array.isArray(intent)
    && Object.keys(intent).sort().join(",") === expected.sort().join(","));
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function localVideoSubmitIntentBound(intent, request) {
  if (!exactLocalVideoSubmitIntentShape(intent)) return false;
  const { intentHash, ...unsigned } = intent;
  return intent.schemaVersion === 1
    && intent.type === "local-video-provider-submit-intent"
    && intent.status === "spawn-authorized"
    && intent.provider === "local-video"
    && intent.jobId === request?.jobId
    && intent.runId === request?.runId
    && intent.requestHash === request?.requestHash
    && intent.scriptHash === request?.scriptHash
    && intent.paidAuthorizationHash === request?.paidAuthorization?.authorizationHash
    && intent.generatorName === request?.paidAuthorization?.context?.adapterName
    && intent.generatorSha256 === request?.paidAuthorization?.context?.adapterSha256
    && intent.executorSnapshotName === LOCAL_VIDEO_EXECUTOR_SNAPSHOT_NAME
    && intent.executorSnapshotSha256 === request?.paidAuthorization?.context?.executorSnapshotSha256
    && Number.isFinite(Date.parse(intent.createdAt || ""))
    && intentHash === hashJson(unsigned);
}

function localVideoSubmitIntentStorageError(message, cause = null) {
  const error = new Error(message);
  error.code = "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS";
  if (cause) error.cause = cause;
  return error;
}

function canonicalLocalVideoJobLocation(jobDir) {
  const jobsRoot = resolve(JOBS_DIR);
  const canonicalJobDir = resolve(jobDir);
  const jobId = basename(canonicalJobDir);
  if (!SAFE_JOB_ID.test(jobId) || canonicalJobDir !== join(jobsRoot, jobId)) {
    throw localVideoSubmitIntentStorageError("local-video 제출 의도 경로가 canonical jobs direct-child가 아닙니다.");
  }
  return { jobsRoot, jobDir: canonicalJobDir, jobId };
}

async function openLocalVideoJobBoundary(jobDir) {
  const location = canonicalLocalVideoJobLocation(jobDir);
  const jobsRoot = await openProviderJobsRootStrict(location.jobsRoot);
  let jobFd = null;
  try {
    jobFd = openDirectoryAt(jobsRoot.handle.fd, location.jobId);
    const jobIdentity = statFd(jobFd);
    if (!jobIdentity.isDirectory()) throw new Error("local-video job entry가 디렉터리가 아닙니다.");
    return { location, jobsRoot, jobFd, jobIdentity };
  } catch (error) {
    if (jobFd !== null) closeFd(jobFd);
    await jobsRoot.handle.close().catch(() => {});
    throw error;
  }
}

async function closeLocalVideoJobBoundary(boundary) {
  if (boundary?.jobFd !== null && boundary?.jobFd !== undefined) closeFd(boundary.jobFd);
  await boundary?.jobsRoot?.handle?.close?.().catch(() => {});
}

async function reopenLocalVideoJobBoundary(boundary) {
  const current = await openLocalVideoJobBoundary(boundary.location.jobDir);
  if (
    !sameFdIdentity(boundary.jobsRoot.identity, current.jobsRoot.identity)
    || !sameFdIdentity(boundary.jobIdentity, current.jobIdentity)
  ) {
    await closeLocalVideoJobBoundary(current);
    throw localVideoSubmitIntentStorageError("local-video 제출 의도 ancestry가 읽는 중 교체되었습니다.");
  }
  return current;
}

function sameLocalVideoIntentSnapshot(left, right) {
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

function openLocalVideoSubmitIntentLeaf(jobFd, { allowMissing = false } = {}) {
  let fd;
  try {
    fd = openFileAt(jobFd, LOCAL_VIDEO_SUBMIT_INTENT_NAME, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const identity = statFd(fd);
    if (
      !identity.isFile()
      || identity.nlink !== 1n
      || identity.size > BigInt(LOCAL_VIDEO_SUBMIT_INTENT_MAX_BYTES)
      || identity.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw localVideoSubmitIntentStorageError("local-video 제출 의도는 bounded single-link regular file이어야 합니다.");
    }
    return { fd, identity };
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function parseLocalVideoSubmitIntent(bytes) {
  let intent;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    intent = JSON.parse(text);
  } catch {
    throw localVideoSubmitIntentStorageError("local-video 제출 의도가 올바른 UTF-8 JSON이 아니어서 새 provider 실행을 차단했습니다.");
  }
  return intent;
}

export async function readLocalVideoSubmitIntent(jobDir, dependencies = {}) {
  let boundary = null;
  let leaf = null;
  try {
    boundary = await openLocalVideoJobBoundary(jobDir);
    leaf = openLocalVideoSubmitIntentLeaf(boundary.jobFd, { allowMissing: true });
    if (!leaf) {
      const current = await reopenLocalVideoJobBoundary(boundary);
      let currentLeaf = null;
      try {
        currentLeaf = openLocalVideoSubmitIntentLeaf(current.jobFd, { allowMissing: true });
        if (currentLeaf) {
          throw localVideoSubmitIntentStorageError("local-video 제출 의도가 없음 확인 중 게시되었습니다.");
        }
      } finally {
        if (currentLeaf) closeFd(currentLeaf.fd);
        await closeLocalVideoJobBoundary(current);
      }
      return null;
    }

    const bytes = readFdBuffer(leaf.fd, { maxBytes: LOCAL_VIDEO_SUBMIT_INTENT_MAX_BYTES });
    const afterRead = statFd(leaf.fd);
    if (
      afterRead.nlink !== 1n
      || !sameLocalVideoIntentSnapshot(leaf.identity, afterRead)
      || BigInt(bytes.byteLength) !== afterRead.size
    ) {
      throw localVideoSubmitIntentStorageError("local-video 제출 의도가 same-fd read 중 변경되었습니다.");
    }
    await dependencies.afterIntentBytesReadForTest?.(Buffer.from(bytes));

    const current = await reopenLocalVideoJobBoundary(boundary);
    let currentLeaf = null;
    try {
      currentLeaf = openLocalVideoSubmitIntentLeaf(current.jobFd);
      if (!sameLocalVideoIntentSnapshot(leaf.identity, currentLeaf.identity)) {
        throw localVideoSubmitIntentStorageError("local-video 제출 의도 canonical leaf가 읽는 중 교체되었습니다.");
      }
    } finally {
      if (currentLeaf) closeFd(currentLeaf.fd);
      await closeLocalVideoJobBoundary(current);
    }

    const intent = parseLocalVideoSubmitIntent(bytes);
    const { intentHash, ...unsigned } = intent || {};
    if (
      !exactLocalVideoSubmitIntentShape(intent)
      || intent?.jobId !== boundary.location.jobId
      || intent.schemaVersion !== 1
      || intent.type !== "local-video-provider-submit-intent"
      || intent.status !== "spawn-authorized"
      || intent.provider !== "local-video"
      || !/^sha256:[a-f0-9]{64}$/u.test(intent.requestHash || "")
      || !/^sha256:[a-f0-9]{64}$/u.test(intent.scriptHash || "")
      || !/^sha256:[a-f0-9]{64}$/u.test(intent.paidAuthorizationHash || "")
      || !/^sha256:[a-f0-9]{64}$/u.test(intent.generatorSha256 || "")
      || intent.executorSnapshotName !== LOCAL_VIDEO_EXECUTOR_SNAPSHOT_NAME
      || !/^sha256:[a-f0-9]{64}$/u.test(intent.executorSnapshotSha256 || "")
      || !Number.isFinite(Date.parse(intent.createdAt || ""))
      || intentHash !== hashJson(unsigned)
    ) {
      throw localVideoSubmitIntentStorageError("local-video 제출 의도 결속이 유효하지 않아 새 provider 실행을 차단했습니다.");
    }
    return intent;
  } catch (error) {
    if (error?.code === "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS") throw error;
    throw localVideoSubmitIntentStorageError(
      `local-video 제출 의도를 canonical storage에서 안전하게 읽을 수 없습니다 (${error.message || error.code || "unknown"}).`,
      error
    );
  } finally {
    if (leaf) closeFd(leaf.fd);
    await closeLocalVideoJobBoundary(boundary);
  }
}

export async function persistLocalVideoSubmitIntent(jobDir, generatorPath, executorSnapshotPath, request) {
  validateBflRequestAuthorization(request?.paidAuthorization, request);
  const generatorSha256 = await hashFile(generatorPath);
  const executorSnapshotSha256 = await hashFile(executorSnapshotPath);
  if (
    basename(generatorPath) !== request.paidAuthorization.context.adapterName
    || generatorSha256 !== request.paidAuthorization.context.adapterSha256
    || basename(executorSnapshotPath) !== LOCAL_VIDEO_EXECUTOR_SNAPSHOT_NAME
    || executorSnapshotSha256 !== request.paidAuthorization.context.executorSnapshotSha256
  ) throw new Error("local-video 실행기와 사설 스냅샷이 승인 context와 일치하지 않습니다.");
  const unsigned = {
    schemaVersion: 1,
    type: "local-video-provider-submit-intent",
    status: "spawn-authorized",
    provider: "local-video",
    jobId: request.jobId,
    runId: request.runId,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    paidAuthorizationHash: request.paidAuthorization.authorizationHash,
    generatorName: basename(generatorPath),
    generatorSha256,
    executorSnapshotName: basename(executorSnapshotPath),
    executorSnapshotSha256,
    createdAt: new Date().toISOString()
  };
  const intent = { ...unsigned, intentHash: hashJson(unsigned) };
  const path = join(resolve(jobDir), LOCAL_VIDEO_SUBMIT_INTENT_NAME);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(intent, null, 2));
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("기존 local-video 제출 의도가 있어 새 provider 프로세스를 시작하지 않습니다.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(resolve(jobDir));
  return intent;
}

function approvalWindowContains(authorization, value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp)
    && timestamp >= Date.parse(authorization?.approvedAt || "")
    && timestamp < Date.parse(authorization?.expiresAt || "");
}

export function buildLocalVideoPaidApprovalEvidence(verification, providerExecutionVerification, authorization, request, apiKey = process.env.BFL_API_KEY) {
  if (!verification?.receipt || !verification?.claimReceipt) throw new Error("BFL 승인·request claim 증거가 없습니다.");
  assertNoConfiguredBflApiKey(verification, apiKey);
  validateBflConsumedApprovalAuthorizationReceipt(verification.receipt, authorization, { apiKey });
  validateBflRequestClaimReceipt(verification.claimReceipt, authorization, request);
  const providerExecutionClaim = providerExecutionVerification?.claimReceipt;
  validateBflProviderExecutionClaimReceipt(providerExecutionClaim, authorization, request);
  const evidence = {
    schemaVersion: 1,
    type: "bfl-paid-approval-evidence",
    status: "provider-execution-bound",
    consumedReceiptName: authorization.consumedReceiptName,
    consumedReceiptText: verification.consumedReceiptText,
    consumedReceiptBytes: verification.consumedReceiptBytes,
    consumedReceiptSha256: verification.consumedReceiptSha256,
    approvalHash: authorization.approvalHash,
    requestClaim: verification.claimReceipt,
    requestClaimHash: verification.claimReceipt.claimHash,
    requestClaimText: verification.claimReceiptText,
    requestClaimBytes: verification.claimReceiptBytes,
    requestClaimSha256: verification.claimReceiptSha256,
    providerExecutionClaim,
    providerExecutionClaimHash: providerExecutionClaim.executionClaimHash,
    providerExecutionClaimText: providerExecutionVerification.claimReceiptText,
    providerExecutionClaimBytes: providerExecutionVerification.claimReceiptBytes,
    providerExecutionClaimSha256: providerExecutionVerification.claimReceiptSha256
  };
  const completedEvidence = { ...evidence, evidenceHash: hashJson(evidence) };
  assertNoConfiguredBflApiKey(completedEvidence, apiKey);
  return completedEvidence;
}

export function localVideoPaidApprovalEvidenceBound(receipt, request, apiKey = process.env.BFL_API_KEY) {
  const authorization = request?.paidAuthorization;
  const evidence = receipt?.paidApprovalEvidence;
  try {
    assertNoConfiguredBflApiKey({ evidence, paidAuthorization: receipt?.paidAuthorization }, apiKey);
  } catch {
    return false;
  }
  if (
    !validateHistoricalBflRequestAuthorization(authorization, request)
    || !evidence
    || evidence.schemaVersion !== 1
    || evidence.type !== "bfl-paid-approval-evidence"
    || evidence.status !== "provider-execution-bound"
    || evidence.consumedReceiptName !== authorization.consumedReceiptName
    || typeof evidence.consumedReceiptText !== "string"
    || Buffer.byteLength(evidence.consumedReceiptText) !== evidence.consumedReceiptBytes
    || `sha256:${createHash("sha256").update(evidence.consumedReceiptText).digest("hex")}` !== evidence.consumedReceiptSha256
    || evidence.approvalHash !== authorization.approvalHash
    || evidence.requestClaimHash !== evidence.requestClaim?.claimHash
    || typeof evidence.requestClaimText !== "string"
    || Buffer.byteLength(evidence.requestClaimText) !== evidence.requestClaimBytes
    || `sha256:${createHash("sha256").update(evidence.requestClaimText).digest("hex")}` !== evidence.requestClaimSha256
    || evidence.providerExecutionClaimHash !== evidence.providerExecutionClaim?.executionClaimHash
    || typeof evidence.providerExecutionClaimText !== "string"
    || Buffer.byteLength(evidence.providerExecutionClaimText) !== evidence.providerExecutionClaimBytes
    || `sha256:${createHash("sha256").update(evidence.providerExecutionClaimText).digest("hex")}` !== evidence.providerExecutionClaimSha256
    || hashJson(receipt.providerExecutionClaim) !== hashJson(evidence.providerExecutionClaim)
  ) return false;
  let approvalReceipt;
  try {
    approvalReceipt = JSON.parse(evidence.consumedReceiptText);
    const exactRequestClaim = JSON.parse(evidence.requestClaimText);
    const exactExecutionClaim = JSON.parse(evidence.providerExecutionClaimText);
    validateBflConsumedApprovalAuthorizationReceipt(approvalReceipt, authorization, { apiKey });
    validateBflRequestClaimReceipt(exactRequestClaim, authorization, request);
    if (hashJson(exactRequestClaim) !== hashJson(evidence.requestClaim)) return false;
    validateBflProviderExecutionClaimReceipt(exactExecutionClaim, authorization, request);
    if (hashJson(exactExecutionClaim) !== hashJson(evidence.providerExecutionClaim)) return false;
  } catch {
    return false;
  }
  const { evidenceHash, ...unsignedEvidence } = evidence;
  return Boolean(
    approvalReceipt.approvalHash === authorization.approvalHash
    && approvalReceipt.nonce === authorization.nonce
    && approvalReceipt.contextHash === authorization.contextHash
    && evidenceHash === hashJson(unsignedEvidence)
    && approvalWindowContains(authorization, receipt.submissionIntent?.createdAt)
    && Array.isArray(receipt.tasks)
    && receipt.tasks.every((task) => approvalWindowContains(authorization, task?.submissionStartedAt))
  );
}

export function attachLocalVideoSubmissionIntent(receipt, intent, request, verification, providerExecutionVerification = null, apiKey = process.env.BFL_API_KEY) {
  if (!localVideoSubmitIntentBound(intent, request)) {
    throw new Error("local-video 제출 의도가 현재 provider 요청과 결속되지 않았습니다.");
  }
  const executionVerification = providerExecutionVerification || {
    claimReceipt: receipt?.providerExecutionClaim,
    claimReceiptText: JSON.stringify(receipt?.providerExecutionClaim, null, 2),
    claimReceiptBytes: Buffer.byteLength(JSON.stringify(receipt?.providerExecutionClaim, null, 2)),
    claimReceiptSha256: `sha256:${createHash("sha256").update(JSON.stringify(receipt?.providerExecutionClaim, null, 2)).digest("hex")}`
  };
  const paidApprovalEvidence = buildLocalVideoPaidApprovalEvidence(
    verification,
    executionVerification,
    request.paidAuthorization,
    request,
    apiKey
  );
  const attached = { ...receipt, submissionIntent: intent, paidApprovalEvidence };
  assertNoConfiguredBflApiKey(attached, apiKey);
  return attached;
}

export function localVideoProviderRequestBodyClosureBound(receipt, request) {
  const expectedSegments = Array.isArray(request?.segments) ? request.segments : [];
  if (
    !receipt
    || !Array.isArray(receipt.tasks)
    || receipt.tasks.length !== expectedSegments.length
    || !Array.isArray(receipt.segments)
    || receipt.segments.length !== expectedSegments.length
    || !localVideoSubmitIntentBound(receipt.submissionIntent, request)
    || !validateBflRequestAuthorizationSafe(receipt.paidAuthorization, request)
    || !localVideoPaidApprovalEvidenceBound(receipt, request)
    || receipt.model !== BFL_MODEL
    || receipt.modelVersion !== BFL_MODEL_VERSION
    || !strictBflCompletionIdentityBound(receipt, request)
  ) return false;
  const tasks = new Map();
  for (const task of receipt.tasks) {
    const index = Number(task?.index);
    if (
      !Number.isInteger(index)
      || index < 1
      || index > expectedSegments.length
      || tasks.has(index)
      || !task.request
      || typeof task.request !== "object"
      || Array.isArray(task.request)
      || task.requestBodyHash !== hashJson(task.request)
      || task.request.prompt !== expectedSegments[index - 1]?.prompt
      || !approvedBflTaskBody(task.request, request, index)
    ) return false;
    tasks.set(index, task);
  }
  const seenSegments = new Set();
  for (const segment of receipt.segments) {
    const index = Number(segment?.index);
    const task = tasks.get(index);
    if (
      !task
      || seenSegments.has(index)
      || segment.submittedRequestBodyHash !== task.requestBodyHash
      || !segment.submittedRequestBody
      || hashJson(segment.submittedRequestBody) !== task.requestBodyHash
      || hashJson(segment.submittedRequestBody) !== hashJson(task.request)
      || segment.submittedPromptHash !== hashJson({ prompt: task.request.prompt })
    ) return false;
    seenSegments.add(index);
  }
  return tasks.size === expectedSegments.length && seenSegments.size === expectedSegments.length;
}

function exactObjectKeys(value, expected) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(","));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactBflPollingUrl(value, taskId) {
  try {
    const parsed = new URL(value);
    const ids = parsed.searchParams.getAll("id");
    return BFL_POLLING_ORIGINS.has(parsed.origin)
      && parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && parsed.pathname === "/v1/get_result"
      && ids.length === 1
      && ids[0] === taskId
      && [...parsed.searchParams.keys()].every((key) => key === "id");
  } catch {
    return false;
  }
}

function strictBflCompletionIdentityBound(receipt, request) {
  const expectedSegments = Array.isArray(request?.segments) ? request.segments : [];
  const expectedCount = expectedSegments.length;
  const taskKeys = [
    "completedAt", "estimatedCredits", "index", "pollingUrl", "providerCostCredits", "request",
    "requestBodyHash", "responseId", "responseStatus", "responseTimestamp", "resumed", "submissionResponseId",
    "submissionStartedAt", "submissionStatus", "submissionTimestamp", "submittedAt", "submittedPromptHash", "taskId"
  ];
  const segmentKeys = [
    "bytes", "completedAt", "estimatedCredits", "index", "modelVersion", "output", "path", "pollingUrl",
    "providerCostCredits", "responseId", "responseStatus", "responseTimestamp", "resumed", "sha256",
    "submissionResponseId", "submissionStartedAt", "submissionStatus", "submissionTimestamp", "submittedAt",
    "submittedPromptHash", "submittedRequestBody", "submittedRequestBodyHash", "taskId"
  ];
  if (!Array.isArray(receipt.taskIds) || receipt.taskIds.length !== expectedCount) return false;
  if (!Array.isArray(receipt.outputs) || receipt.outputs.length !== expectedCount) return false;
  if (!validTimestamp(receipt.createdAt) || !validTimestamp(receipt.completedAt)) return false;
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.createdAt)) return false;
  const ids = receipt.taskIds;
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) return false;
  if (receipt.modelId !== (ids.length === 1 ? ids[0] : ids.join(","))) return false;
  for (let offset = 0; offset < expectedCount; offset += 1) {
    const task = receipt.tasks[offset];
    const segment = receipt.segments[offset];
    const requestedSegment = expectedSegments[offset];
    const index = offset + 1;
    const expectsShotPattern = Boolean(requestedSegment?.providerVisualPromptHash);
    const expectedSegmentKeys = expectsShotPattern
      ? [...segmentKeys, "providerVisualPrompt", "providerVisualPromptHash", "shotPattern", "submittedToProvider"]
      : segmentKeys;
    if (
      !exactObjectKeys(task, taskKeys)
      || !exactObjectKeys(segment, expectedSegmentKeys)
      || task.index !== index
      || segment.index !== index
      || segment.path !== `clips/${String(index).padStart(2, "0")}.mp4`
      || segment.output !== segment.path
      || receipt.outputs[offset] !== segment.path
      || !Number.isSafeInteger(segment.bytes)
      || segment.bytes <= 0
      || !/^sha256:[a-f0-9]{64}$/u.test(segment.sha256 || "")
      || ids[offset] !== task.taskId
      || task.taskId !== segment.taskId
      || task.responseId !== task.taskId
      || segment.responseId !== task.taskId
      || task.submissionResponseId !== task.taskId
      || segment.submissionResponseId !== task.taskId
      || !exactBflPollingUrl(task.pollingUrl, task.taskId)
      || segment.pollingUrl !== task.pollingUrl
      || !BFL_TERMINAL_SUCCESS_STATUSES.has(String(task.responseStatus || "").toLowerCase())
      || segment.responseStatus !== task.responseStatus
      || !validTimestamp(task.submissionStartedAt)
      || !validTimestamp(task.submittedAt)
      || !validTimestamp(task.completedAt)
      || segment.submissionStartedAt !== task.submissionStartedAt
      || segment.submittedAt !== task.submittedAt
      || segment.completedAt !== task.completedAt
      || Date.parse(task.submittedAt) < Date.parse(task.submissionStartedAt)
      || Date.parse(task.completedAt) < Date.parse(task.submittedAt)
      || Date.parse(task.completedAt) > Date.parse(receipt.completedAt)
      || task.requestBodyHash !== segment.submittedRequestBodyHash
      || hashJson(task.request) !== hashJson(segment.submittedRequestBody)
      || task.submittedPromptHash !== segment.submittedPromptHash
      || task.responseTimestamp !== segment.responseTimestamp
      || task.submissionTimestamp !== segment.submissionTimestamp
      || task.submissionStatus !== segment.submissionStatus
      || task.providerCostCredits !== segment.providerCostCredits
      || task.estimatedCredits !== segment.estimatedCredits
      || task.resumed !== segment.resumed
      || segment.modelVersion !== BFL_MODEL_VERSION
      || (expectsShotPattern && (
        segment.providerVisualPrompt !== requestedSegment.providerVisualPrompt
        || segment.providerVisualPromptHash !== requestedSegment.providerVisualPromptHash
        || hashJson(segment.shotPattern) !== hashJson(requestedSegment.shotPattern)
        || segment.submittedToProvider !== true
      ))
    ) return false;
  }
  return true;
}

function validateBflRequestAuthorizationSafe(authorization, request) {
  return validateHistoricalBflRequestAuthorization(authorization, request);
}

function approvedBflTaskBody(body, request, index) {
  const policy = request?.paidAuthorization?.context?.requestPolicy;
  const exactKeys = [
    "aspect_ratio", "draft", "duration", "generate_audio", "mode", "prompt",
    "resolution", "safety_tolerance", "version"
  ];
  return Boolean(
    policy
    && body
    && typeof body === "object"
    && !Array.isArray(body)
    && Object.keys(body).sort().join(",") === exactKeys.sort().join(",")
    && body?.mode === "t2v"
    && body?.draft === false
    && body?.resolution === policy.resolution
    && body?.aspect_ratio === policy.aspectRatio
    && body?.generate_audio === policy.generateAudio
    && body?.safety_tolerance === policy.safetyTolerance
    && body?.duration === policy.durationsSec?.[index - 1]
    && body?.version === BFL_MODEL_VERSION
  );
}

export function buildLocalVideoRequest(job, script, runId, scriptHash = hashJson(script)) {
  const base = {
    schemaVersion: 1,
    jobId: job.id,
    runId,
    provider: "local-video",
    topic: job.topic,
    format: job.format,
    clipCount: Number(job.clipCount || script?.segments?.length || 0),
    targetDurationSec: Number(job.targetDurationSec),
    targetDurationRangeSec: job.targetDurationRangeSec || null,
    captions: job.captions !== false,
    voiceover: job.voiceover !== false,
    jobCreatedAt: String(job.createdAt || ""),
    segments: (script?.segments || []).map((segment, index) => {
      const providerBinding = providerPromptBindingForSegment(segment, "local-video");
      return {
        index: index + 1,
        durationHint: segment.durationHint || null,
        prompt: providerBinding.providerVisualPrompt,
        visualPrompt: segment.visualPrompt || "",
        caption: segment.caption || "",
        narration: segment.narration || "",
        ...providerRequestFieldsForSegment(segment, "local-video")
      };
    }),
    ...(script?.shotPatternPlan ? {
      shotPatternPlan: {
        catalogId: script.shotPatternPlan.catalogId,
        catalogHash: script.shotPatternPlan.catalogHash,
        planHash: script.shotPatternPlan.planHash,
        continuityContractHash: script.shotPatternPlan.continuityContractHash,
        applicationMode: script.shotPatternPlan.applicationMode,
        providerEligible: script.shotPatternPlan.providerEligible,
        providerSubmissionPlanned: script.shotPatternPlan.providerSubmissionPlanned
      }
    } : {})
  };
  const requestHash = hashJson({ ...base, scriptHash });
  return { ...base, requestHash, scriptHash };
}

export function withStoredBflAuthorization(baseRequest, receipt) {
  const authorization = receipt?.paidAuthorization;
  const request = { ...baseRequest, paidAuthorization: authorization };
  return validateBflRequestAuthorizationSafe(authorization, request) ? request : null;
}

function timeoutMs() {
  const value = Number(process.env.PS4_LOCAL_VIDEO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), 1000), 60 * 60 * 1000) : DEFAULT_TIMEOUT_MS;
}

export async function runLocalVideoExecutorSnapshot(generator, input, childEnv, expectedHash, { afterOpen } = {}) {
  let processHandle;
  let executorHandle;
  try {
    executorHandle = await open(generator, "r");
    const metadata = await executorHandle.stat();
    if (!metadata.isFile()) throw new Error("local-video 사설 실행기 스냅샷이 일반 파일이 아닙니다.");
    const exactBytes = await executorHandle.readFile();
    const exactHash = `sha256:${createHash("sha256").update(exactBytes).digest("hex")}`;
    if (exactHash !== expectedHash) throw new Error("local-video 사설 실행기 스냅샷의 열린 바이트가 승인과 일치하지 않습니다.");
    await afterOpen?.();
    // Execute the already-open descriptor. Replacing either the source adapter
    // or the snapshot pathname after verification cannot change child bytes.
    processHandle = Bun.spawn([process.execPath, "/dev/fd/3"], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe", executorHandle.fd]
    });
  } catch (error) {
    await executorHandle?.close().catch(() => {});
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
    await executorHandle?.close().catch(() => {});
  }
}

export async function validateLocalVideoReceipt(receipt, job, script, runId, request, scriptHash, requestHash, clipsDir) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("local-video 생성기 영수증 JSON이 객체가 아닙니다.");
  assertNoConfiguredBflApiKey(receipt);
  if (receipt.schemaVersion !== 1) throw new Error("local-video 영수증 schemaVersion이 지원되지 않습니다.");
  if (receipt.status !== "completed") throw new Error("local-video 영수증 status가 completed가 아닙니다.");
  if (receipt.jobId !== job.id || receipt.runId !== runId) throw new Error("local-video 영수증 jobId/runId가 현재 실행과 일치하지 않습니다.");
  if (receipt.provider !== "local-video") throw new Error("local-video 영수증 provider가 local-video가 아닙니다.");
  for (const field of ["model", "modelVersion", "modelId", "requestHash", "scriptHash"]) requiredString(receipt[field], field);
  if (receipt.requestHash !== requestHash || receipt.scriptHash !== scriptHash) throw new Error("local-video 영수증 요청·스크립트 해시가 현재 실행과 일치하지 않습니다.");
  const shotPatternRequestRequired = Boolean(script?.shotPatternPlan);
  if (shotPatternRequestRequired && !receipt.request) throw new Error("local-video shot pattern 영수증에 실제 provider 요청 echo가 없습니다.");
  if (receipt.request && hashJson(receipt.request) !== hashJson(request)) throw new Error("local-video 영수증 request가 현재 요청과 일치하지 않습니다.");
  if (!Array.isArray(receipt.tasks) || receipt.tasks.length !== script.segments.length) {
    throw new Error("local-video 영수증에 실제 provider 요청 body 결속이 없습니다.");
  }
  if (!Array.isArray(receipt.segments) || receipt.segments.length !== script.segments.length) throw new Error(`local-video 영수증 장면 수가 요청과 다릅니다: ${receipt.segments?.length || 0}/${script.segments.length}`);
  if (!localVideoProviderRequestBodyClosureBound(receipt, request)) {
    throw new Error("local-video 영수증의 실제 provider 요청 body 결속이 유효하지 않습니다.");
  }
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
    const requestedSegment = request.segments[index - 1];
    const submittedTask = receipt.tasks.find((task) => Number(task?.index) === index);
    if (
      !submittedTask
      || !submittedTask.request
      || submittedTask.requestBodyHash !== hashJson(submittedTask.request)
      || segment.submittedRequestBodyHash !== submittedTask.requestBodyHash
      || submittedTask.request.prompt !== requestedSegment.prompt
    ) {
      throw new Error(`local-video 영수증의 실제 provider 요청 body가 현재 장면과 결속되지 않았습니다: ${index}`);
    }
    if (requestedSegment.providerVisualPromptHash) {
      if (segment.submittedToProvider !== true) throw new Error(`local-video shot pattern 영수증에 실제 provider 제출 표시가 없습니다: ${index}`);
      if (segment.providerVisualPrompt !== requestedSegment.providerVisualPrompt) throw new Error(`local-video 영수증 providerVisualPrompt가 요청과 다르거나 누락됐습니다: ${index}`);
      if (segment.providerVisualPromptHash !== requestedSegment.providerVisualPromptHash) throw new Error(`local-video 영수증 providerVisualPrompt 해시가 요청과 다르거나 누락됐습니다: ${index}`);
      if (hashJson(segment.shotPattern) !== hashJson(requestedSegment.shotPattern)) throw new Error(`local-video 영수증 shot pattern 결속이 요청과 다르거나 누락됐습니다: ${index}`);
    } else if (segment.submittedToProvider !== undefined && segment.submittedToProvider !== true) {
      throw new Error(`local-video 영수증 provider 제출 상태가 completed와 모순됩니다: ${index}`);
    }
    segments.push({
      ...segment,
      index,
      path: relativePath,
      output: relativePath,
      bytes: fileStat.size,
      sha256: actualHash,
      runId,
      requestHash,
      scriptHash,
      ...(requestedSegment.providerVisualPromptHash ? {
        providerVisualPrompt: requestedSegment.providerVisualPrompt,
        providerVisualPromptHash: requestedSegment.providerVisualPromptHash,
        shotPattern: requestedSegment.shotPattern,
        submittedToProvider: true
      } : {})
    });
  }
  if (seenIndices.size !== script.segments.length || !script.segments.every((_, index) => seenIndices.has(index + 1))) throw new Error("local-video 영수증 장면 번호가 요청된 모든 장면을 포함하지 않습니다.");
  return { ...receipt, schemaVersion: 1, jobId: job.id, runId, provider: "local-video", requestHash, scriptHash, request, segments: segments.sort((left, right) => left.index - right.index), outputs: segments.sort((left, right) => left.index - right.index).map((segment) => segment.path) };
}

export async function generateLocalVideoClips(job, script, runId = job?.runId, onProgress = async () => {}, options = {}) {
  if (!job?.id || !runId) throw new Error("local-video 생성에는 jobId와 runId가 필요합니다.");
  // runJob has already published the exact run directory. Re-pin the complete
  // ancestry here because this exported provider boundary can also be called directly.
  const storage = await preflightLocalVideoStorage(job.id, runId);
  const generator = String(process.env.PS4_LOCAL_VIDEO_GENERATOR || "").trim();
  if (!generator) throw new Error("PS4_LOCAL_VIDEO_GENERATOR가 설정되지 않았습니다.");
  const generatorPath = resolve(generator);
  const generatorStat = await stat(generatorPath).catch(() => null);
  if (!generatorStat?.isFile() || (generatorStat.mode & 0o111) === 0) throw new Error(`PS4_LOCAL_VIDEO_GENERATOR 실행 파일을 찾을 수 없거나 실행 권한이 없습니다: ${generator}`);
  if (!Array.isArray(script?.segments) || !script.segments.length) throw new Error("local-video 생성에는 대본 장면이 필요합니다.");
  const scriptHash = hashJson(script);
  const baseRequest = buildLocalVideoRequest(job, script, runId, scriptHash);
  const paidAuthorization = bindBflLaunchCapabilityToRequest(options.paidLaunchCapability, baseRequest);
  const request = { ...baseRequest, paidAuthorization };
  assertBflValueDoesNotContainApiKey(request, process.env.BFL_API_KEY);
  if (
    basename(generatorPath) !== paidAuthorization.context.adapterName
    || await hashFile(generatorPath) !== paidAuthorization.context.adapterSha256
  ) throw new Error("실행할 local-video 생성기가 승인된 BFL 어댑터 바이트와 일치하지 않습니다.");
  const requestHash = request.requestHash;
  const { jobDir, clipsDir, runDir } = storage;
  const projectRoot = resolve(import.meta.dirname, "..");
  const executorSnapshotPath = await persistBflExecutorSnapshot(
    jobDir,
    generatorPath,
    projectRoot,
    paidAuthorization.context.executorSnapshotSha256
  );
  const approvalVerification = await verifyBflConsumedApprovalForRequest(jobDir, paidAuthorization, request, {
    apiKey: process.env.BFL_API_KEY,
    adapterPath: generatorPath,
    claim: true
  });
  const submissionIntent = await persistLocalVideoSubmitIntent(jobDir, generatorPath, executorSnapshotPath, request);
  const policy = paidAuthorization.context.requestPolicy;
  const childEnv = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    BFL_API_KEY: process.env.BFL_API_KEY,
    BFL_VIDEO_RESOLUTION: policy.resolution,
    BFL_GENERATE_AUDIO: policy.generateAudio ? "1" : "0",
    BFL_SAFETY_TOLERANCE: String(policy.safetyTolerance),
    BFL_MAX_CREDITS: String(paidAuthorization.context.maxCredits),
    BFL_ESTIMATED_TOTAL_CREDITS: String(paidAuthorization.context.operatorEstimateCredits),
    BFL_POLL_TIMEOUT_MS: process.env.BFL_POLL_TIMEOUT_MS,
    BFL_POLL_INTERVAL_MS: process.env.BFL_POLL_INTERVAL_MS,
    BFL_MAX_MEDIA_BYTES: process.env.BFL_MAX_MEDIA_BYTES,
    BFL_MEDIA_HOSTS: process.env.BFL_MEDIA_HOSTS
  }).filter(([, value]) => typeof value === "string" && value.length > 0));
  if (await hashFile(executorSnapshotPath) !== paidAuthorization.context.executorSnapshotSha256) {
    throw new Error("스폰 직전 BFL 사설 실행기 스냅샷 바이트가 승인과 일치하지 않습니다.");
  }
  const stdout = await runLocalVideoExecutorSnapshot(
    executorSnapshotPath,
    request,
    childEnv,
    paidAuthorization.context.executorSnapshotSha256
  );
  let receipt;
  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    throw new Error("local-video 생성기가 유효한 JSON 영수증을 반환하지 않았습니다.");
  }
  const providerExecutionVerification = await claimBflProviderExecution(jobDir, paidAuthorization, request);
  if (hashJson(providerExecutionVerification.claimReceipt) !== hashJson(receipt?.providerExecutionClaim)) {
    throw new Error("local-video 생성기 영수증의 provider execution claim이 durable claim과 일치하지 않습니다.");
  }
  const validated = await validateLocalVideoReceipt(
    attachLocalVideoSubmissionIntent(receipt, submissionIntent, request, approvalVerification, providerExecutionVerification, process.env.BFL_API_KEY),
    job,
    script,
    runId,
    request,
    scriptHash,
    requestHash,
    clipsDir
  );
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
