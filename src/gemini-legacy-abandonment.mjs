import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalGeminiSessionBinding } from "./provenance.mjs";

export const GEMINI_LEGACY_ABANDONMENT_NAME = "gemini-legacy-abandonment.json";

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

function isHeadlessChromeVersion(version) {
  return /HeadlessChrome\//i.test(`${version?.Browser || ""} ${version?.["User-Agent"] || ""}`);
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

export async function observeLegacyGeminiTargets({
  job,
  generation,
  fetchFn = fetch,
  now = () => new Date(),
  allowedTargetIds = []
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
  if (!isHeadlessChromeVersion(version)) throw new Error("legacy 폐기 관측에는 저장된 세션과 결속된 live headless Chrome이 필요합니다.");
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
    method: "loopback-cdp-json-read-only",
    observedAt,
    cdpOrigin: origin,
    cdpOriginHash: hashJson({ type: "gemini-cdp-origin", origin }),
    browserVersionHash: hashJson({ Browser: version.Browser || null, userAgent: version["User-Agent"] || null }),
    headless: true,
    sessionBindingHash: hashJson(binding),
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
    || observation.method !== "loopback-cdp-json-read-only"
    || observation.headless !== true
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
    || liveCdpObservation.prohibitedTargetCount !== 0
    || liveCdpObservation.authorizedTargetCount !== 1
    || liveCdpObservation.sessionBindingHash !== generation.sessionBindingHash
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
  if (observation?.schemaVersion !== 1 || observation.method !== "loopback-cdp-json-read-only"
    || observation.headless !== true || observation.prohibitedTargetCount !== 0
    || !Number.isInteger(observation.targetCount) || observation.targetCount < 0
    || !Number.isInteger(observation.geminiRootTargetCount) || observation.geminiRootTargetCount < 0
    || !Number.isFinite(Date.parse(observation.observedAt))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.cdpOriginHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.browserVersionHash || ""))
    || !/^sha256:[a-f0-9]{64}$/.test(String(observation.targetSetHash || ""))
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
        headless: observation.headless
      }
    }
  };
}

export async function readLegacyGeminiAbandonmentDecision({ jobId, jobDir, generation, generationPath }) {
  if (unsupportedLegacyGeminiFailure(generation)) {
    return { required: true, allowed: false, reason: "legacy-generation-shape-unsupported", receipt: null };
  }
  if (!legacyGeminiGenerationNeedsAbandonment(generation)) return { required: false, allowed: true, receipt: null };
  const generationBytes = await readFile(generationPath);
  const generationSha256 = hashBytes(generationBytes);
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(join(jobDir, GEMINI_LEGACY_ABANDONMENT_NAME), "utf8"));
  } catch {}
  return validateLegacyGeminiAbandonment({ jobId, generation, generationSha256, receipt });
}

export async function createLegacyGeminiAbandonment({
  jobsDir,
  jobId,
  expectedGenerationSha256,
  reason,
  assertNoLiveTarget = false,
  now = () => new Date(),
  fetchFn = fetch
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(jobId || ""))) throw new Error("job ID가 올바르지 않습니다.");
  if (assertNoLiveTarget !== true) throw new Error("--assert-no-live-target 확인이 필요합니다.");
  const normalizedExpectedHash = normalizeSha256(expectedGenerationSha256);
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length < 12 || normalizedReason.length > 500) throw new Error("폐기 사유는 12~500자로 입력하세요.");
  const resolvedJobsDir = resolve(String(jobsDir || ""));
  const jobDir = resolve(resolvedJobsDir, jobId);
  if (!jobDir.startsWith(`${resolvedJobsDir}/`)) throw new Error("job 경로가 올바르지 않습니다.");
  const generationPath = join(jobDir, "gemini-generation.json");
  const receiptPath = join(jobDir, GEMINI_LEGACY_ABANDONMENT_NAME);
  if (existsSync(receiptPath)) throw new Error("이 작업에는 이미 legacy Gemini 폐기 영수증이 있습니다.");
  const generationBytes = await readFile(generationPath);
  const actualHash = hashBytes(generationBytes);
  if (actualHash !== normalizedExpectedHash) throw new Error(`Gemini generation SHA-256가 일치하지 않습니다. 현재 값: ${actualHash}`);
  const generation = JSON.parse(generationBytes.toString("utf8"));
  if (generation.jobId !== jobId || !legacyGeminiGenerationNeedsAbandonment(generation)) {
    throw new Error("명시적 폐기가 필요한 legacy Gemini 실패 영수증이 아닙니다.");
  }
  const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
  if (job?.id !== jobId) throw new Error("저장된 job.json의 job ID가 일치하지 않습니다.");
  const liveCdpObservation = await observeLegacyGeminiTargets({ job, generation, fetchFn, now });
  const authorizedAt = now().toISOString();
  const payload = {
    schemaVersion: 2,
    type: "gemini-legacy-submission-abandonment",
    jobId,
    authorization: "explicit-operator-cli",
    operatorAssertion: "no-live-recoverable-conversation-target",
    reason: normalizedReason,
    authorizedAt,
    liveCdpObservation,
    sourceGeneration: {
      jobId,
      schemaVersion: generation.schemaVersion,
      runId: generation.runId || null,
      status: generation.status,
      sha256: actualHash
    }
  };
  const receipt = { ...payload, receiptHash: hashJson(payload) };
  await mkdir(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
    await link(temporary, receiptPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { receiptPath, receipt };
}

async function writeImmutableEvidence(path, bytes) {
  if (existsSync(path)) {
    const existing = await readFile(path);
    if (hashBytes(existing) !== hashBytes(bytes)) throw new Error("기존 legacy 보존 증거가 현재 영수증과 일치하지 않습니다.");
    return;
  }
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
}

export async function preserveLegacyGeminiAbandonmentEvidence({ jobId, jobDir, generationPath }) {
  const receiptPath = join(jobDir, GEMINI_LEGACY_ABANDONMENT_NAME);
  const generationBytes = await readFile(generationPath);
  const receiptBytes = await readFile(receiptPath);
  const generation = JSON.parse(generationBytes.toString("utf8"));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const decision = validateLegacyGeminiAbandonment({
    jobId,
    generation,
    generationSha256: hashBytes(generationBytes),
    receipt
  });
  if (!decision.allowed || !decision.required) throw new Error("legacy Gemini 폐기 증거를 보존할 수 없습니다.");
  const evidenceDir = join(jobDir, "legacy-gemini-evidence");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const generationEvidencePath = join(evidenceDir, "abandoned-gemini-generation.json");
  const receiptEvidencePath = join(evidenceDir, "abandonment-receipt.json");
  await writeImmutableEvidence(generationEvidencePath, generationBytes);
  await writeImmutableEvidence(receiptEvidencePath, receiptBytes);
  return {
    schemaVersion: 1,
    generationPath: "legacy-gemini-evidence/abandoned-gemini-generation.json",
    generationSha256: hashBytes(generationBytes),
    receiptPath: "legacy-gemini-evidence/abandonment-receipt.json",
    receiptSha256: hashBytes(receiptBytes),
    receiptHash: receipt.receiptHash
  };
}
