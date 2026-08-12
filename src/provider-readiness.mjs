import { lstat, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactGeminiMonitor } from "./gemini-monitor-privacy.mjs";

export const PROVIDER_READINESS_SCHEMA_VERSION = 1;
export const PROVIDER_PROBE_SCHEMA_VERSION = 1;
export const PROVIDER_PROBE_TTL_MS = 15 * 60 * 1000;
const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const PROBE_PROVIDERS = new Set(["higgsfield", "veed"]);
const PROBE_STATUSES = new Set(["available", "blocked"]);
const PROBE_BLOCKERS = new Set([
  "authentication-required",
  "quota-exhausted",
  "free-entitlement-unavailable",
  "subscription-required",
  "billing-approval-required",
  "provider-unavailable",
  "probe-failed"
]);
const PROBE_KEYS = new Set(["schemaVersion", "provider", "observedAt", "status", "blockerCode"]);

const BLOCKER_MESSAGES = Object.freeze({
  "monitor-not-running": "Gemini 쿼터 모니터 영수증이 없습니다.",
  "monitor-invalid": "Gemini 모니터 영수증 스키마가 올바르지 않습니다.",
  "monitor-stale": "Gemini 모니터 관측이 TTL을 초과했습니다.",
  "monitor-no-profiles": "Gemini 모니터에 관측된 프로필이 없습니다.",
  "profile-observation-stale": "TTL 안에 관측된 Gemini 프로필이 없습니다.",
  "profile-observation-superseded": "최근 Gemini 프로필 관측 이후 작업 상태가 변경되어 다시 관측해야 합니다.",
  "headless-required": "사용 가능한 Gemini 프로필이 headless 모드로 확인되지 않았습니다.",
  "video-mode-unavailable": "Gemini 동영상 만들기 모드를 확인하지 못했습니다.",
  "authentication-required": "로그인 또는 인증이 필요합니다.",
  "quota-exhausted": "현재 생성 쿼터를 사용할 수 없습니다.",
  "provider-unavailable": "최근 probe에서 제공자를 사용할 수 없었습니다.",
  "api-key-not-configured": "BFL API 키가 설정되지 않았습니다.",
  "budget-cap-not-configured": "BFL 최대 크레딧 상한이 설정되지 않았습니다.",
  "cost-estimate-not-configured": "BFL 비용 추정값이 설정되지 않았습니다.",
  "generator-not-selected": "local-video 실행기로 선택된 어댑터가 없습니다.",
  "generator-not-executable": "선택된 local-video 실행기를 실행할 수 없습니다.",
  "probe-receipt-missing": "최근 외부 provider probe 영수증이 없습니다.",
  "probe-receipt-invalid": "외부 provider probe 영수증 스키마가 올바르지 않습니다.",
  "probe-receipt-stale": "외부 provider probe 영수증이 TTL을 초과했습니다.",
  "free-entitlement-unavailable": "최근 probe에서 무료 생성 권한을 확인하지 못했습니다.",
  "subscription-required": "최근 probe에서 유료 구독이 필요했습니다.",
  "billing-approval-required": "최근 probe에서 결제 승인이 필요했습니다.",
  "probe-failed": "최근 provider probe가 완료되지 않았습니다."
});

function blocker(code) {
  return { code, message: BLOCKER_MESSAGES[code] || "제공자 준비 조건을 충족하지 못했습니다." };
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveFinite(value) {
  if (!present(value)) return false;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function timestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timing(observedAt, nowMs, ttlMs) {
  const observedMs = timestamp(observedAt);
  if (observedMs === null || observedMs > nowMs + MAX_FUTURE_SKEW_MS) return { valid: false };
  const ageMs = Math.max(0, nowMs - observedMs);
  return {
    valid: true,
    fresh: ageMs <= ttlMs,
    observedAt: new Date(observedMs).toISOString(),
    expiresAt: new Date(observedMs + ttlMs).toISOString(),
    ageMs
  };
}

async function readBoundedJson(path) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECEIPT_BYTES) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function validProbeReceipt(receipt, provider) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const keys = Object.keys(receipt);
  if (keys.length !== PROBE_KEYS.size || keys.some((key) => !PROBE_KEYS.has(key))) return false;
  if (receipt.schemaVersion !== PROVIDER_PROBE_SCHEMA_VERSION || receipt.provider !== provider || !PROBE_PROVIDERS.has(receipt.provider)) return false;
  if (!PROBE_STATUSES.has(receipt.status) || timestamp(receipt.observedAt) === null) return false;
  if (receipt.status === "available") return receipt.blockerCode === null;
  return typeof receipt.blockerCode === "string" && PROBE_BLOCKERS.has(receipt.blockerCode);
}

export function externalProbeReadiness(receipt, provider, { now = new Date(), ttlMs = PROVIDER_PROBE_TTL_MS } = {}) {
  if (receipt === undefined || receipt === null) {
    return {
      provider,
      status: "NOT_CONNECTED",
      evidence: "none",
      blockers: [blocker("probe-receipt-missing")]
    };
  }
  if (!validProbeReceipt(receipt, provider)) {
    return {
      provider,
      status: "NOT_CONNECTED",
      evidence: "invalid-probe-receipt",
      blockers: [blocker("probe-receipt-invalid")]
    };
  }
  const receiptTiming = timing(receipt.observedAt, now.getTime(), ttlMs);
  if (!receiptTiming.valid) {
    return {
      provider,
      status: "NOT_CONNECTED",
      evidence: "invalid-probe-receipt",
      blockers: [blocker("probe-receipt-invalid")]
    };
  }
  if (!receiptTiming.fresh) {
    return {
      provider,
      status: "STALE",
      evidence: "stale-probe-receipt",
      observedAt: receiptTiming.observedAt,
      expiresAt: receiptTiming.expiresAt,
      blockers: [blocker("probe-receipt-stale")]
    };
  }
  return {
    provider,
    status: receipt.status === "available" ? "READY" : "BLOCKED",
    evidence: "fresh-probe-receipt",
    observedAt: receiptTiming.observedAt,
    expiresAt: receiptTiming.expiresAt,
    blockers: receipt.blockerCode ? [blocker(receipt.blockerCode)] : []
  };
}

export function geminiMonitorReadiness(rawMonitor, { now = new Date(), ttlMs = PROVIDER_PROBE_TTL_MS } = {}) {
  if (rawMonitor === undefined || rawMonitor === null) {
    return {
      provider: "gemini",
      status: "NOT_CONNECTED",
      evidence: "none",
      blockers: [blocker("monitor-not-running")]
    };
  }
  const monitor = redactGeminiMonitor(rawMonitor);
  if (!monitor || monitor.schemaVersion !== 2 || !Array.isArray(monitor.profiles)) {
    return {
      provider: "gemini",
      status: "NOT_CONNECTED",
      evidence: "invalid-redacted-monitor",
      blockers: [blocker("monitor-invalid")]
    };
  }
  if (!timing(monitor.updatedAt, now.getTime(), ttlMs).valid) {
    return {
      provider: "gemini",
      status: "NOT_CONNECTED",
      evidence: "invalid-redacted-monitor",
      blockers: [blocker("monitor-invalid")]
    };
  }
  const profiles = monitor.profiles.filter((profile) => profile && typeof profile === "object" && !Array.isArray(profile));
  const profileTimings = profiles
    .map((profile) => ({ profile, timing: timing(profile.observedAt, now.getTime(), ttlMs) }))
    .filter(({ timing: profileTiming }) => profileTiming.valid)
    .sort((left, right) => timestamp(right.timing.observedAt) - timestamp(left.timing.observedAt));
  const latestProfileTiming = profileTimings[0]?.timing || null;
  const freshProfiles = profileTimings
    .filter(({ timing: profileTiming }) => profileTiming.fresh === true)
    .map(({ profile }) => profile);
  // A positive quota observation is single-use evidence. Once the monitor moves
  // on to job execution or review, that observation can no longer prove that
  // the just-used profile still has generation quota. A new profiles_observed
  // event restores status=quota-available with a new per-profile observedAt.
  const availabilityObservationCurrent = monitor.status === "quota-available";
  const authenticatedCount = freshProfiles.filter((profile) => profile.authentication === "authenticated").length;
  const headlessCount = freshProfiles.filter((profile) => profile.headless === true && profile.requestedHeadless !== false).length;
  const videoModeCount = freshProfiles.filter((profile) => profile.videoMode === true).length;
  const availableCount = availabilityObservationCurrent ? freshProfiles.filter((profile) => (
    profile.available === true
    && profile.authentication === "authenticated"
    && profile.headless === true
    && profile.requestedHeadless !== false
    && profile.videoMode === true
  )).length : 0;
  const operational = {
    profileCount: profiles.length,
    freshProfileCount: freshProfiles.length,
    availableCount,
    authenticatedCount,
    headlessCount,
    videoModeCount,
    nextCheckAt: timestamp(monitor.nextQuotaCheckAt) === null ? null : new Date(timestamp(monitor.nextQuotaCheckAt)).toISOString(),
    quotaResetAt: timestamp(monitor.quotaResetAt) === null ? null : new Date(timestamp(monitor.quotaResetAt)).toISOString()
  };
  if (latestProfileTiming && !freshProfiles.length) {
    return {
      provider: "gemini",
      status: "STALE",
      evidence: "stale-profile-observation",
      observedAt: latestProfileTiming.observedAt,
      expiresAt: latestProfileTiming.expiresAt,
      operational,
      blockers: [blocker("profile-observation-stale")]
    };
  }
  let blockerCode = null;
  if (!profiles.length) blockerCode = "monitor-no-profiles";
  else if (!freshProfiles.length) blockerCode = "profile-observation-stale";
  else if (!availabilityObservationCurrent && freshProfiles.some((profile) => profile.available === true)) blockerCode = "profile-observation-superseded";
  else if (availableCount > 0) blockerCode = null;
  else if (authenticatedCount === 0) blockerCode = "authentication-required";
  else if (headlessCount === 0) blockerCode = "headless-required";
  else if (videoModeCount === 0) blockerCode = "video-mode-unavailable";
  else if (monitor.status === "quota-blocked" || profiles.some((profile) => present(profile.quotaMessage) || present(profile.quotaResetText))) blockerCode = "quota-exhausted";
  else blockerCode = "provider-unavailable";
  return {
    provider: "gemini",
    status: availableCount > 0 ? "READY" : "BLOCKED",
    evidence: latestProfileTiming ? "fresh-profile-observation" : "missing-profile-observation",
    ...(latestProfileTiming ? {
      observedAt: latestProfileTiming.observedAt,
      expiresAt: latestProfileTiming.expiresAt
    } : {}),
    operational,
    blockers: blockerCode ? [blocker(blockerCode)] : []
  };
}

async function executableFile(path) {
  const metadata = path ? await stat(path).catch(() => null) : null;
  return Boolean(metadata?.isFile() && (metadata.mode & 0o111) !== 0);
}

export async function bflConfigurationReadiness(root, env = process.env) {
  const bundledPath = resolve(root, "scripts", "bfl-flux-video-generator.mjs");
  const configuredPath = present(env.PS4_LOCAL_VIDEO_GENERATOR) ? resolve(env.PS4_LOCAL_VIDEO_GENERATOR.trim()) : null;
  const bundledAdapterAvailable = await executableFile(bundledPath);
  const selectedGeneratorExecutable = await executableFile(configuredPath);
  const keyConfigured = present(env.BFL_API_KEY);
  const budgetCapConfigured = positiveFinite(env.BFL_MAX_CREDITS);
  const costEstimateConfigured = [
    env.BFL_ESTIMATED_TOTAL_CREDITS,
    env.BFL_ESTIMATED_CREDITS_PER_SECOND,
    env.BFL_ESTIMATED_CREDITS_PER_REQUEST
  ].some(positiveFinite);
  const blockers = [];
  if (!keyConfigured) blockers.push(blocker("api-key-not-configured"));
  if (!budgetCapConfigured) blockers.push(blocker("budget-cap-not-configured"));
  if (!costEstimateConfigured) blockers.push(blocker("cost-estimate-not-configured"));
  if (!configuredPath) blockers.push(blocker("generator-not-selected"));
  else if (!selectedGeneratorExecutable) blockers.push(blocker("generator-not-executable"));
  return {
    provider: "bfl",
    status: blockers.length ? "BLOCKED" : "CONFIGURED",
    evidence: "local-configuration-only",
    liveConnectionVerified: false,
    configuration: {
      apiKeyConfigured: keyConfigured,
      budgetCapConfigured,
      costEstimateConfigured,
      generatorSelected: Boolean(configuredPath),
      selectedGeneratorExecutable,
      bundledAdapterAvailable,
      bundledAdapterSelected: Boolean(configuredPath && configuredPath === bundledPath)
    },
    blockers
  };
}

export async function buildProviderReadiness({ root, env = process.env, now = new Date(), ttlMs = PROVIDER_PROBE_TTL_MS } = {}) {
  if (!root) throw new Error("provider readiness root is required");
  const monitorPath = join(root, "workspace", "gemini-monitor.json");
  const probeRoot = join(root, "workspace", "provider-probes");
  const [monitor, higgsfieldReceipt, veedReceipt, bfl] = await Promise.all([
    readBoundedJson(monitorPath),
    readBoundedJson(join(probeRoot, "higgsfield.json")),
    readBoundedJson(join(probeRoot, "veed.json")),
    bflConfigurationReadiness(root, env)
  ]);
  return {
    schemaVersion: PROVIDER_READINESS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    probeTtlMs: ttlMs,
    providers: {
      gemini: geminiMonitorReadiness(monitor, { now, ttlMs }),
      bfl,
      higgsfield: externalProbeReadiness(higgsfieldReceipt, "higgsfield", { now, ttlMs }),
      veed: externalProbeReadiness(veedReceipt, "veed", { now, ttlMs })
    }
  };
}
