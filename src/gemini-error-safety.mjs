import { createHash } from "node:crypto";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PHASES = new Set(["initialization", "launch", "pipeline", "recovery"]);

function failureBytes(error) {
  if (error instanceof Error) return Buffer.from(String(error.stack || error.message || error.name));
  if (typeof error === "string") return Buffer.from(error);
  try {
    return Buffer.from(JSON.stringify(error));
  } catch {
    return Buffer.from(String(error));
  }
}

export function createGeminiFailureEvidence(error, { phase = "pipeline" } = {}) {
  const safePhase = PHASES.has(phase) ? phase : "pipeline";
  const bytes = failureBytes(error);
  const text = bytes.toString("utf8");
  const reasonCode = /you(?:'|’)re out of videos|videos will be available again|동영상 생성 할당량이 소진되었습니다|지금은 동영상을 생성할 수 없습니다|(?:할당량|쿼터).*(?:소진|사용할 수 없)|quota.*(?:exhaust|deplet|available again)/i.test(text)
    ? "quota-exhausted"
    : /세로\s*9\s*:\s*16\s*비율의\s*동영상을\s*반환하지\s*않|(?:did\s+not|didn't|failed\s+to)\s+return[^\n]*(?:vertical\s*)?9\s*:\s*16|(?:aspect\s*ratio|orientation)[^\n]*(?:mismatch|invalid|incorrect|not\s+(?:vertical\s*)?9\s*:\s*16)/i.test(text)
      ? "aspect-ratio-mismatch"
      : "generation-failed";
  return {
    schemaVersion: 1,
    code: "gemini-provider-failure-redacted",
    reasonCode,
    phase: safePhase,
    byteLength: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

export function verifyGeminiFailureEvidence(value) {
  const keys = ["byteLength", "code", "phase", "reasonCode", "schemaVersion", "sha256"].sort();
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
    && value.schemaVersion === 1
    && value.code === "gemini-provider-failure-redacted"
    && ["aspect-ratio-mismatch", "generation-failed", "quota-exhausted"].includes(value.reasonCode)
    && PHASES.has(value.phase)
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && SHA256.test(String(value.sha256 || ""))
  );
}

export function geminiFailureMessage(evidence) {
  if (!verifyGeminiFailureEvidence(evidence)) throw new TypeError("Gemini failure evidence가 유효하지 않습니다.");
  return `Gemini provider 실행이 실패했습니다 (${evidence.reasonCode}; ${evidence.sha256}).`;
}

export function storedProviderFailure(provider, error, { phase = "pipeline" } = {}) {
  if (provider !== "gemini-browser") {
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      error: error instanceof Error ? (error.stack || error.toString()) : String(error),
      evidence: null
    };
  }
  const evidence = createGeminiFailureEvidence(error, { phase });
  const message = geminiFailureMessage(evidence);
  return { message, error: evidence.reasonCode, evidence };
}

/**
 * Defends the API boundary for historical jobs created before hashed failure
 * evidence existed. Raw stored error/message/warning text is never returned.
 */
export function redactStoredGeminiJobFailure(job) {
  if (!job || typeof job !== "object" || Array.isArray(job) || job.provider !== "gemini-browser") return job;
  const hasFailureSurface = job.status === "failed"
    || job.runStatus === "failed"
    || job.error != null
    || job.providerFailureEvidence != null
    || job.semanticRevalidationFailure != null;
  if (!hasFailureSurface) return job;
  const source = job.providerFailureEvidence && verifyGeminiFailureEvidence(job.providerFailureEvidence)
    ? job.providerFailureEvidence
    : createGeminiFailureEvidence({
        message: job.message ?? null,
        error: job.error ?? null,
        warnings: job.warnings ?? null,
        semanticRevalidationFailure: job.semanticRevalidationFailure ?? null
      }, { phase: "recovery" });
  const safeMessage = geminiFailureMessage(source);
  return {
    ...job,
    message: safeMessage,
    error: source.reasonCode,
    warnings: Array.isArray(job.warnings) && job.warnings.length > 0 ? [safeMessage] : [],
    providerFailureEvidence: source,
    ...(job.semanticRevalidationFailure ? {
      semanticRevalidationFailure: {
        childRunId: typeof job.semanticRevalidationFailure.childRunId === "string" ? job.semanticRevalidationFailure.childRunId : null,
        phase: ["initialization", "pipeline"].includes(job.semanticRevalidationFailure.phase) ? job.semanticRevalidationFailure.phase : "pipeline",
        code: source.reasonCode,
        evidence: source
      }
    } : {})
  };
}
