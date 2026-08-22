import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  createPrivateJsonFileExclusiveStrict,
  GEMINI_MONITOR_PRIVATE_FILE_LIMITS,
  projectGeminiMonitorProfileObservation,
  readAndSyncPrivateJsonFileStrict,
  readPrivateJsonFileStrict
} from "./gemini-monitor-privacy.mjs";

const SIGNAL_KIND = "ultragoal-resume-request";
const SIGNAL_TTL_MS = 15 * 60 * 1000;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SIGNAL_EVENTS = new Set([
  "automated-review-needs-remediation",
  "automated-review-reconciliation-required",
  "production-complete",
  "production-started",
  "production-staged",
  "provider-available",
  "provider-blocked"
]);
const SIGNAL_STATUSES = new Set([
  "automated-reviewing",
  "failed",
  "monitoring",
  "production-complete",
  "production-staged",
  "quota-available",
  "quota-blocked",
  "queued",
  "review-needs-remediation",
  "review-reconciliation-required",
  "running",
  "unknown",
  "waiting-alternate-profile"
]);
const NEXT_ACTION = Object.freeze({
  "automated-review-needs-remediation": "resume_ultragoal_for_evidence_remediation",
  "automated-review-reconciliation-required": "resume_ultragoal_for_revision_reconciliation",
  "production-complete": "resume_ultragoal_for_quality_gate",
  "production-started": "observe_bound_production_run",
  "production-staged": "resume_ultragoal_and_continue_gemini",
  "provider-available": "resume_ultragoal_and_continue_gemini",
  "provider-blocked": "wait_for_quota_or_human_verification"
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashValue(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function exactIso(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field}가 필요합니다.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${field}가 exact ISO timestamp가 아닙니다.`);
  return value;
}

function safeIdentifier(value, field, nullable = true) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new TypeError(`${field}가 유효하지 않습니다.`);
  }
  return value;
}

function projectProfileObservations(profiles) {
  if (!Array.isArray(profiles)) throw new TypeError("UltraGoal profile observations가 배열이 아닙니다.");
  const projected = profiles.map((profile) => projectGeminiMonitorProfileObservation(profile));
  if (new Set(projected.map((profile) => profile.id)).size !== projected.length) {
    throw new TypeError("UltraGoal profile observations에 중복 profileId가 있습니다.");
  }
  return projected;
}

function completionEvidence(completion) {
  if (completion == null) return null;
  const keys = completion && typeof completion === "object" && !Array.isArray(completion)
    ? Object.keys(completion).sort()
    : [];
  return {
    keyCount: keys.length,
    sha256: hashValue(completion)
  };
}

function immutableSignalFields(signal) {
  return {
    schemaVersion: signal.schemaVersion,
    kind: signal.kind,
    goalId: signal.goalId,
    event: signal.event,
    sequence: signal.sequence,
    observedAt: signal.observedAt,
    expiresAt: signal.expiresAt,
    ttlMs: signal.ttlMs,
    requiresGoalResume: signal.requiresGoalResume,
    nextAction: signal.nextAction,
    jobId: signal.jobId,
    runId: signal.runId,
    status: signal.status,
    profileId: signal.profileId,
    profileObservations: signal.profileObservations,
    profileObservationHash: signal.profileObservationHash,
    completionEvidence: signal.completionEvidence,
    requestFingerprint: signal.requestFingerprint
  };
}

function requestFingerprint(fields) {
  return hashValue({
    goalId: fields.goalId,
    event: fields.event,
    requiresGoalResume: fields.requiresGoalResume,
    nextAction: fields.nextAction,
    jobId: fields.jobId,
    runId: fields.runId,
    status: fields.status,
    profileId: fields.profileId,
    profileObservationHash: fields.profileObservationHash,
    completionEvidence: fields.completionEvidence
  });
}

export function verifyUltragoalResumeSignal(value) {
  const expectedKeys = [
    "completionEvidence",
    "event",
    "expiresAt",
    "goalId",
    "jobId",
    "kind",
    "nextAction",
    "observedAt",
    "profileId",
    "profileObservationHash",
    "profileObservations",
    "requestFingerprint",
    "requiresGoalResume",
    "runId",
    "schemaVersion",
    "sequence",
    "signalId",
    "status",
    "ttlMs"
  ].sort();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.schemaVersion !== 2
    || value.kind !== SIGNAL_KIND
    || !/^G[0-9]{3,8}$/.test(String(value.goalId || ""))
    || !SIGNAL_EVENTS.has(value.event)
    || !SIGNAL_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Number.isSafeInteger(value.ttlMs) || value.ttlMs < 60_000 || value.ttlMs > 60 * 60 * 1000
    || typeof value.requiresGoalResume !== "boolean"
    || value.requiresGoalResume !== ["provider-available", "production-staged", "production-complete"].includes(value.event)
    || value.nextAction !== NEXT_ACTION[value.event]
    || !SHA256.test(String(value.profileObservationHash || ""))
    || !SHA256.test(String(value.requestFingerprint || ""))
    || !SHA256.test(String(value.signalId || ""))) {
    throw new Error("UltraGoal signal 구조가 유효하지 않습니다.");
  }
  safeIdentifier(value.jobId, "jobId");
  safeIdentifier(value.runId, "runId");
  safeIdentifier(value.profileId, "profileId");
  const observedAt = exactIso(value.observedAt, "observedAt");
  const expiresAt = exactIso(value.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) - Date.parse(observedAt) !== value.ttlMs) throw new Error("UltraGoal signal TTL 결속이 유효하지 않습니다.");
  const observations = projectProfileObservations(value.profileObservations);
  if (canonicalJson(observations) !== canonicalJson(value.profileObservations)
    || hashValue(observations) !== value.profileObservationHash) {
    throw new Error("UltraGoal profile observation hash가 일치하지 않습니다.");
  }
  if (value.profileId != null && !observations.some((profile) => profile.id === value.profileId)) {
    throw new Error("UltraGoal selected profile이 observation에 결속되지 않았습니다.");
  }
  const selectedObservation = observations.find((profile) => profile.id === value.profileId) || null;
  if (value.event === "provider-available" && (!selectedObservation || selectedObservation.available !== true)) {
    throw new Error("UltraGoal provider-available signal이 available profile에 결속되지 않았습니다.");
  }
  if (value.event === "production-staged" && (!value.jobId || value.runId !== null || !selectedObservation)) {
    throw new Error("UltraGoal production-staged signal의 job/profile 결속이 유효하지 않습니다.");
  }
  if (["production-started", "production-complete"].includes(value.event)
    && (!value.jobId || !value.runId || !selectedObservation)) {
    throw new Error("UltraGoal production signal의 job/run/profile 결속이 유효하지 않습니다.");
  }
  if (value.completionEvidence !== null && (
    !value.completionEvidence
    || typeof value.completionEvidence !== "object"
    || Array.isArray(value.completionEvidence)
    || JSON.stringify(Object.keys(value.completionEvidence).sort()) !== JSON.stringify(["keyCount", "sha256"])
    || !Number.isSafeInteger(value.completionEvidence.keyCount)
    || value.completionEvidence.keyCount < 0
    || !SHA256.test(String(value.completionEvidence.sha256 || ""))
  )) throw new Error("UltraGoal completion evidence가 유효하지 않습니다.");
  if (requestFingerprint(value) !== value.requestFingerprint) throw new Error("UltraGoal request fingerprint가 일치하지 않습니다.");
  if (hashValue(immutableSignalFields(value)) !== value.signalId) throw new Error("UltraGoal signalId가 일치하지 않습니다.");
  return value;
}

export function createUltragoalResumeSignal({
  event,
  goalId = "G005",
  observedAt = new Date().toISOString(),
  ttlMs = SIGNAL_TTL_MS,
  sequence = 1,
  previousSignal = null,
  jobId = null,
  runId = null,
  profileId = null,
  status = "unknown",
  profiles = [],
  completion = null
} = {}) {
  if (!SIGNAL_EVENTS.has(event)) throw new TypeError("UltraGoal event가 유효하지 않습니다.");
  if (!SIGNAL_STATUSES.has(status)) throw new TypeError("UltraGoal status가 유효하지 않습니다.");
  safeIdentifier(goalId, "goalId", false);
  const issued = exactIso(observedAt, "observedAt");
  const duration = Number(ttlMs);
  if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 60 * 60 * 1000) throw new TypeError("UltraGoal TTL이 유효하지 않습니다.");
  const profileObservations = projectProfileObservations(profiles);
  const selectedProfileId = safeIdentifier(profileId, "profileId");
  if (selectedProfileId != null && !profileObservations.some((profile) => profile.id === selectedProfileId)) {
    throw new TypeError("UltraGoal selected profile observation이 없습니다.");
  }
  const previous = previousSignal == null ? null : verifyUltragoalResumeSignal(previousSignal);
  const requestedSequence = previous ? previous.sequence + 1 : Number(sequence);
  if (!Number.isSafeInteger(requestedSequence) || requestedSequence < 1) throw new TypeError("UltraGoal sequence가 유효하지 않습니다.");
  const requiresGoalResume = ["provider-available", "production-staged", "production-complete"].includes(event);
  const fields = {
    schemaVersion: 2,
    kind: SIGNAL_KIND,
    goalId,
    event,
    sequence: requestedSequence,
    observedAt: issued,
    expiresAt: new Date(Date.parse(issued) + duration).toISOString(),
    ttlMs: duration,
    requiresGoalResume,
    nextAction: NEXT_ACTION[event],
    jobId: safeIdentifier(jobId, "jobId"),
    runId: safeIdentifier(runId, "runId"),
    status,
    profileId: selectedProfileId,
    profileObservations,
    profileObservationHash: hashValue(profileObservations),
    completionEvidence: completionEvidence(completion)
  };
  fields.requestFingerprint = requestFingerprint(fields);
  if (previous
    && previous.requestFingerprint === fields.requestFingerprint
    && Date.parse(issued) < Date.parse(previous.expiresAt)) return previous;
  const signal = { ...fields, signalId: hashValue(fields) };
  return verifyUltragoalResumeSignal(signal);
}

async function readSignalIfPresent(path, readFileFn) {
  try {
    return readFileFn
      ? JSON.parse(await readFileFn(path, "utf8"))
      : await readPrivateJsonFileStrict(path, {
          maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes
        });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`UltraGoal signal을 exact하게 읽을 수 없습니다 (${error.message}).`);
  }
}

export async function publishUltragoalResumeSignal(signalPath, input, {
  readFileFn = null,
  openFn = null,
  writeSignal
} = {}) {
  if (typeof signalPath !== "string" || !signalPath.trim() || typeof writeSignal !== "function") {
    throw new TypeError("UltraGoal signal publisher 입력이 유효하지 않습니다.");
  }
  const previousValue = await readSignalIfPresent(signalPath, readFileFn);
  const previousSignal = previousValue == null || previousValue?.schemaVersion === 1
    ? null
    : verifyUltragoalResumeSignal(previousValue);
  const signal = createUltragoalResumeSignal({ ...input, previousSignal });
  if (previousSignal?.signalId === signal.signalId) {
    const durableSignal = verifyUltragoalResumeSignal(await readAndSyncExactJson(signalPath, openFn));
    if (durableSignal.signalId !== signal.signalId) {
      throw new Error("UltraGoal idempotent signal이 durable exact file과 일치하지 않습니다.");
    }
    return { signal: durableSignal, published: false, idempotent: true };
  }
  await writeSignal(signalPath, signal);
  return { signal, published: true, idempotent: false };
}

function consumptionClaimFields(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    signalId: value.signalId,
    sequence: value.sequence,
    consumerHash: value.consumerHash,
    consumedAt: value.consumedAt
  };
}

function verifyConsumptionClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "claimHash", "consumedAt", "consumerHash", "kind", "schemaVersion", "sequence", "signalId"
    ])
    || value.schemaVersion !== 1
    || value.kind !== "ultragoal-resume-consumption"
    || !SHA256.test(String(value.signalId || ""))
    || !SHA256.test(String(value.consumerHash || ""))
    || !SHA256.test(String(value.claimHash || ""))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error("UltraGoal consumption claim이 유효하지 않습니다.");
  }
  exactIso(value.consumedAt, "consumedAt");
  if (hashValue(consumptionClaimFields(value)) !== value.claimHash) throw new Error("UltraGoal consumption claim hash가 일치하지 않습니다.");
  return value;
}

async function syncDirectory(path, openFn) {
  const handle = await openFn(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readAndSyncExactJson(path, openFn) {
  if (!openFn) {
    return readAndSyncPrivateJsonFileStrict(path, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes
    });
  }
  const handle = await openFn(path, "r");
  let bytes;
  try {
    bytes = await handle.readFile();
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path), openFn);
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`UltraGoal durable exact file을 읽을 수 없습니다 (${error.message}).`);
  }
}

/**
 * Claims one signal exactly once. The durable exclusive claim is authoritative
 * even if a consumer crashes before acknowledging the wakeup. Repeating the
 * same consumerId is idempotent; a different consumer cannot steal the claim.
 */
export async function consumeUltragoalResumeSignal(signalPath, {
  expectedSignalId,
  consumerId,
  now = new Date().toISOString()
} = {}, dependencies = {}) {
  const readFileFn = dependencies.readFileFn || null;
  const openFn = dependencies.openFn || null;
  const signal = verifyUltragoalResumeSignal(await readSignalIfPresent(signalPath, readFileFn));
  if (signal.signalId !== expectedSignalId) throw new Error("UltraGoal expected signalId가 현재 signal과 일치하지 않습니다.");
  const consumedAt = exactIso(now, "consumedAt");
  if (Date.parse(consumedAt) >= Date.parse(signal.expiresAt)) {
    const error = new Error("UltraGoal signal이 만료되어 소비하지 않습니다.");
    error.code = "ULTRAGOAL_SIGNAL_EXPIRED";
    throw error;
  }
  safeIdentifier(consumerId, "consumerId", false);
  const consumerHash = hashValue({ consumerId });
  const fields = {
    schemaVersion: 1,
    kind: "ultragoal-resume-consumption",
    signalId: signal.signalId,
    sequence: signal.sequence,
    consumerHash,
    consumedAt
  };
  const claim = { ...fields, claimHash: hashValue(fields) };
  const claimPath = `${signalPath}.consumed-${signal.sequence}.json`;
  let handle = null;
  try {
    if (openFn) handle = await openFn(claimPath, "wx", 0o600);
    else await createPrivateJsonFileExclusiveStrict(claimPath, claim, {
      maxBytes: GEMINI_MONITOR_PRIVATE_FILE_LIMITS.signalBytes
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = verifyConsumptionClaim(await readAndSyncExactJson(claimPath, openFn));
    if (existing.signalId === signal.signalId && existing.consumerHash === consumerHash) {
      return { signal, claim: existing, claimPath, consumed: true, idempotent: true };
    }
    const consumedError = new Error("UltraGoal signal은 이미 다른 소비자가 소비했습니다.");
    consumedError.code = "ULTRAGOAL_SIGNAL_ALREADY_CONSUMED";
    throw consumedError;
  }
  if (handle) {
    try {
      await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
      if (typeof handle.chmod === "function") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(claimPath), openFn);
  }
  return { signal, claim, claimPath, consumed: true, idempotent: false };
}
