import {
  canonicalJsonHash,
  geminiObservedRuntimeProofHash,
  validateGeminiObservedRuntimeProof
} from "./provenance.mjs";
import { validateLegacyGeminiAbandonmentConsumption } from "./gemini-legacy-abandonment.mjs";
import { verifyGeminiFailureEvidence } from "./gemini-error-safety.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactJson(left, right) {
  return canonicalJsonHash(left) === canonicalJsonHash(right);
}

function canonicalConversationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname !== "gemini.google.com"
    || parsed.username
    || parsed.password
    || parsed.port) return null;
  const path = parsed.pathname.replace(/\/+$/u, "");
  return /^\/app\/[^/?#]+$/iu.test(path) ? `https://gemini.google.com${path}` : null;
}

function expectedTargetConversationLineage(targetId, conversationUrl) {
  const target = typeof targetId === "string" ? targetId.trim() : "";
  const conversation = canonicalConversationUrl(conversationUrl);
  if (!target || target.length > 256 || /[\u0000-\u001f\u007f]/u.test(target) || !conversation) return null;
  const lineage = {
    schemaVersion: 1,
    method: "privacy-safe-cdp-target-conversation-hashes",
    targetIdHash: canonicalJsonHash({ type: "gemini-cdp-target-id", value: target }),
    conversationUrlHash: canonicalJsonHash({ type: "gemini-canonical-conversation-url", value: conversation })
  };
  return { lineage, lineageHash: canonicalJsonHash(lineage) };
}

function expectedTargetIdHash(targetId) {
  const target = typeof targetId === "string" ? targetId.trim() : "";
  return target && target.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(target)
    ? canonicalJsonHash({ type: "gemini-cdp-target-id", value: target })
    : null;
}

function validPromptReadinessFailure(value) {
  if (value == null) return true;
  const expectedKeys = [
    "code",
    "expectedCanonicalHash",
    "expectedCanonicalLength",
    "expectedLength",
    "expectedNewlineCount",
    "observedCanonicalHash",
    "observedCanonicalLength",
    "observedLength",
    "observedNewlineCount",
    "promptFieldVisible",
    "recordedAt",
    "schemaVersion"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",")
    || value.schemaVersion !== 1
    || !/^GEMINI_PROMPT_[A-Z_]+$/u.test(String(value.code || ""))
    || !validDate(value.recordedAt)
    || typeof value.promptFieldVisible !== "boolean"
    || !SHA256.test(String(value.expectedCanonicalHash || ""))
    || (value.observedCanonicalHash !== null && !SHA256.test(String(value.observedCanonicalHash || "")))) return false;
  for (const key of ["expectedLength", "expectedCanonicalLength", "expectedNewlineCount"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  for (const key of ["observedLength", "observedCanonicalLength", "observedNewlineCount"]) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 0)) return false;
  }
  return true;
}

function validLegacyAbandonmentEvidenceReference(value) {
  if (value == null) return true;
  return value?.schemaVersion === 1
    && value.generationPath === "legacy-gemini-evidence/abandoned-gemini-generation.json"
    && value.receiptPath === "legacy-gemini-evidence/abandonment-receipt.json"
    && SHA256.test(String(value.generationSha256 || ""))
    && SHA256.test(String(value.receiptSha256 || ""))
    && SHA256.test(String(value.receiptHash || ""));
}

function validLegacyAbandonmentReceiptReference(value) {
  if (value == null) return true;
  return value?.path === "gemini-legacy-abandonment.json"
    && value.authorization === "explicit-operator-cli"
    && value.operatorAssertion === "no-live-recoverable-conversation-target"
    && validDate(value.authorizedAt)
    && SHA256.test(String(value.receiptHash || ""))
    && SHA256.test(String(value.sourceGenerationSha256 || ""))
    && value.liveCdpObservation?.headless === true
    && value.liveCdpObservation?.headlessImplementation === "new"
    && value.liveCdpObservation?.prohibitedTargetCount === 0
    && Number.isInteger(value.liveCdpObservation?.targetCount)
    && value.liveCdpObservation.targetCount >= 0
    && validDate(value.liveCdpObservation?.observedAt)
    && SHA256.test(String(value.liveCdpObservation?.cdpOriginHash || ""))
    && SHA256.test(String(value.liveCdpObservation?.targetSetHash || ""))
    && SHA256.test(String(value.liveCdpObservation?.runtimeProofHash || ""));
}

function validLegacyAbandonmentClosure(generation) {
  const receipt = generation.legacySubmissionAbandonment;
  const evidence = generation.legacySubmissionAbandonmentEvidence;
  const consumptions = generation.legacySubmissionAbandonmentConsumptions;
  const hasReceipt = receipt != null;
  if (hasReceipt !== (evidence != null)
    || !validLegacyAbandonmentReceiptReference(receipt)
    || !validLegacyAbandonmentEvidenceReference(evidence)
    || (hasReceipt && (
      receipt.receiptHash !== evidence.receiptHash
      || receipt.sourceGenerationSha256 !== evidence.generationSha256
    ))
    || !Array.isArray(consumptions)
    || (!hasReceipt && consumptions.length !== 0)) return false;
  const submittedIndexes = new Set(generation.segments.map((segment) => segment.index));
  if (generation.pendingSegment) submittedIndexes.add(generation.pendingSegment.index);
  const consumed = new Set();
  for (const attestation of consumptions) {
    if (!submittedIndexes.has(attestation?.segmentIndex)
      || consumed.has(attestation?.segmentIndex)
      || !validateLegacyGeminiAbandonmentConsumption({
        attestation,
        abandonmentReceipt: receipt,
        generation
      })) return false;
    consumed.add(attestation.segmentIndex);
  }
  return !hasReceipt || [...submittedIndexes].every((index) => consumed.has(index));
}

function validRecoveryCollections(generation) {
  if (!Array.isArray(generation.recoveryAttempts)
    || !Array.isArray(generation.recoveredPendingSegments)
    || !Array.isArray(generation.rejectedResumes)
    || (generation.pendingSegment != null
      && (typeof generation.pendingSegment !== "object" || Array.isArray(generation.pendingSegment)))) return false;
  if (generation.pendingSegment != null
    && generation.pendingSegment.index !== generation.segments.length + 1) return false;
  return generation.recoveryAttempts.every((attempt, index) => (
    attempt?.attempt === index + 1
    && typeof attempt.runId === "string"
    && Boolean(attempt.runId.trim())
    && typeof attempt.submissionRunId === "string"
    && Boolean(attempt.submissionRunId.trim())
    && validDate(attempt.startedAt)
    && (attempt.completedAt == null || validDate(attempt.completedAt))
  ));
}

function validResumedCompletedGeneration(generation) {
  const resume = generation.resumedFromCompletedGeneration;
  if (resume == null) return true;
  return typeof resume.sourceRunId === "string"
    && Boolean(resume.sourceRunId.trim())
    && SHA256.test(String(resume.sourceGenerationHash || ""))
    && validDate(resume.resumedAt)
    && resume.providerRequestSent === false
    && generation.segments.every((segment) => (
      segment.sourceRunId === resume.sourceRunId
      && segment.sourceGenerationHash === resume.sourceGenerationHash
      && segment.providerRequestSentThisRun === false
      && segment.inheritedProviderSubmission === true
    ));
}

export function geminiSourceGenerationEvidenceName(runId) {
  if (typeof runId !== "string" || !runId) throw new Error("Gemini lineage runId가 필요합니다.");
  return `runs/${runId}/recovery/source-gemini-generation.json`;
}

export function verifyStrictGeminiRecoverySourceReceipt(generation) {
  const attestation = generation?.providerAttestation;
  const proof = attestation?.runtimeProof;
  const request = generation?.request;
  const hasFailureText = Object.hasOwn(generation || {}, "error") || Object.hasOwn(generation || {}, "errorEvidence");
  if (
    generation?.schemaVersion !== 5
    || generation.provider !== "gemini-browser"
    || !["running", "failed", "completed"].includes(generation.status)
    || typeof generation.jobId !== "string"
    || !generation.jobId.trim()
    || typeof generation.runId !== "string"
    || !generation.runId.trim()
    || !request
    || typeof request !== "object"
    || Array.isArray(request)
    || request.provider !== "gemini-browser"
    || !Number.isInteger(request.clipCount)
    || request.clipCount < 1
    || !Array.isArray(request.segments)
    || request.segments.length !== request.clipCount
    || !validDate(generation.startedAt)
    || (["failed", "completed"].includes(generation.status) && !validDate(generation.completedAt))
    || !validPromptReadinessFailure(generation.promptReadinessFailure)
    || (generation.promptReadinessFailure != null
      && (generation.status !== "failed" || generation.errorCode !== generation.promptReadinessFailure.code))
    || (hasFailureText && (
      !verifyGeminiFailureEvidence(generation.errorEvidence)
      || generation.error !== generation.errorEvidence.reasonCode
      || !/^GEMINI_[A-Z0-9_]{1,95}$/u.test(String(generation.errorCode || ""))
    ))
    || !Array.isArray(generation.segments)
    || generation.segments.length > request.clipCount
    || !Array.isArray(generation.submissionRunIds)
    || !generation.sessionBinding
    || generation.sessionBindingHash !== canonicalJsonHash(generation.sessionBinding)
    || !["requestHash", "scriptHash", "resumeRequestHash", "resumeScriptHash", "providerDecisionHash", "providerAttestationHash"]
      .every((field) => SHA256.test(String(generation[field] || "")))
    || generation.requestHash !== canonicalJsonHash({ ...request, scriptHash: generation.scriptHash })
    || generation.resumeRequestHash !== canonicalJsonHash({ ...request, scriptHash: generation.resumeScriptHash })
    || generation.requestScriptHash !== generation.requestHash
    || generation.providerDecision?.requested !== "gemini-browser"
    || generation.providerDecision?.selected !== "gemini-browser"
    || generation.providerDecision?.fallbackUsed !== false
    || generation.providerDecision?.policy !== "no-local-video-fallback"
    || canonicalJsonHash(generation.providerDecision) !== generation.providerDecisionHash
    || attestation?.type !== "gemini-chrome-session"
    || attestation.provider !== "gemini-browser"
    || typeof generation.browser !== "string"
    || !generation.browser
    || attestation.browser !== generation.browser
    || attestation.sessionBindingHash !== generation.sessionBindingHash
    || canonicalJsonHash(attestation.sessionBinding) !== generation.sessionBindingHash
    || attestation.persistentProfile !== true
    || attestation.headless !== true
    || attestation.headlessRequested !== true
    || attestation.headlessImplementation !== "new"
    || !Number.isInteger(attestation.chromeMajor)
    || attestation.chromeMajor < 109
    || attestation.fallbackUsed !== false
    || !validateGeminiObservedRuntimeProof(proof, generation.sessionBinding)
    || attestation.chromeMajor !== proof.chromeMajor
    || attestation.runtimeProofHash !== geminiObservedRuntimeProofHash(proof)
    || generation.providerAttestationHash !== canonicalJsonHash(attestation)
    || !validRecoveryCollections(generation)
  ) return false;
  const targetKeys = ["conversationUrlHash", "method", "schemaVersion", "targetIdHash"].sort().join(",");
  const segmentsValid = generation.segments.every((segment, index) => {
    const lineage = segment?.targetConversationLineage;
    return segment.index === index + 1
      && segment.runId === generation.runId
      && segment.requestHash === generation.requestHash
      && segment.scriptHash === generation.scriptHash
      && segment.resumeRequestHash === generation.resumeRequestHash
      && segment.resumeScriptHash === generation.resumeScriptHash
      && segment.providerDecisionHash === generation.providerDecisionHash
      && segment.providerAttestationHash === generation.providerAttestationHash
      && segment.submittedToProvider === true
      && segment.submissionAcknowledgement
      && typeof segment.submissionAcknowledgement === "object"
      && !Array.isArray(segment.submissionAcknowledgement)
      && segment.submissionAcknowledgement.verified === true
      && typeof segment.prompt === "string"
      && Boolean(segment.prompt.trim())
      && segment.promptHash === canonicalJsonHash({ prompt: segment.prompt })
      && SHA256.test(String(segment.providerVisualPromptHash || ""))
      && SHA256.test(String(segment.sha256 || ""))
      && segment.path === segment.output
      && segment.path === `clips/${String(segment.index).padStart(2, "0")}.mp4`
      && typeof segment.providerRequestSentThisRun === "boolean"
      && typeof segment.inheritedProviderSubmission === "boolean"
      && segment.providerRequestSentThisRun !== segment.inheritedProviderSubmission
      && typeof segment.submissionRunId === "string"
      && Boolean(segment.submissionRunId)
      && (segment.providerRequestSentThisRun
        ? segment.submissionRunId === generation.runId
          && segment.sourceRunId === null
          && segment.sourceGenerationHash === null
        : typeof segment.sourceRunId === "string"
          && Boolean(segment.sourceRunId)
          && segment.sourceRunId !== generation.runId
          && SHA256.test(String(segment.sourceGenerationHash || "")))
      && Object.keys(lineage || {}).sort().join(",") === targetKeys
      && lineage.schemaVersion === 1
      && lineage.method === "privacy-safe-cdp-target-conversation-hashes"
      && SHA256.test(String(lineage.targetIdHash || ""))
      && SHA256.test(String(lineage.conversationUrlHash || ""))
      && segment.targetConversationLineageHash === canonicalJsonHash(lineage);
  });
  const submissionRunIds = [...new Set(generation.segments.map((segment) => segment.submissionRunId))].sort();
  return segmentsValid
    && generation.providerRequestSentThisRun === generation.segments.some((segment) => segment.providerRequestSentThisRun)
    && generation.inheritedProviderSubmission === generation.segments.some((segment) => segment.inheritedProviderSubmission)
    && JSON.stringify(generation.submissionRunIds) === JSON.stringify(submissionRunIds)
    && validResumedCompletedGeneration(generation)
    && validLegacyAbandonmentClosure(generation);
}

export function verifyStrictCompletedGeminiTerminalReceipt(generation) {
  return verifyStrictGeminiRecoverySourceReceipt(generation)
    && generation.status === "completed"
    && generation.pendingSegment == null
    && validDate(generation.completedAt)
    && generation.segments.length > 0
    && generation.request?.clipCount === generation.segments.length;
}

function exactInheritedCompletedSegment(child, source) {
  return source?.index === child.index
    && source.runId === child.sourceRunId
    && source.submittedToProvider === true
    && source.submissionRunId === child.submissionRunId
    && source.prompt === child.prompt
    && source.promptHash === child.promptHash
    && source.providerVisualPromptHash === child.providerVisualPromptHash
    && source.path === child.path
    && source.output === child.output
    && source.sha256 === child.sha256
    && exactJson(source.shotPattern ?? null, child.shotPattern ?? null)
    && exactJson(source.submissionAcknowledgement, child.submissionAcknowledgement)
    && exactJson(source.targetConversationLineage, child.targetConversationLineage)
    && source.targetConversationLineageHash === child.targetConversationLineageHash;
}

function acknowledgementExtendsSource(child, source) {
  if (!child || !source || source.verified !== true || child.verified !== true) return false;
  return Object.entries(source).every(([key, value]) => exactJson(child[key], value));
}

function exactRecoveredPendingSegment(child, pending) {
  const recoveredIntent = pending?.status === "submit-intent"
    && pending.submittedToProvider === null
    && pending.submissionMayHaveOccurred === true
    && pending.submissionAcknowledgement === null
    && child.submissionAcknowledgement?.recoveredFromPreClickIntent === true;
  const recoveredAcknowledgement = pending?.submittedToProvider === true
    && acknowledgementExtendsSource(child.submissionAcknowledgement, pending.submissionAcknowledgement);
  if (pending?.index !== child.index
    || (!recoveredIntent && !recoveredAcknowledgement)
    || pending.submissionRunId !== child.submissionRunId
    || pending.prompt !== child.prompt
    || pending.promptHash !== child.promptHash
    || pending.providerVisualPromptHash !== child.providerVisualPromptHash
    || !exactJson(pending.shotPattern ?? null, child.shotPattern ?? null)
    || child.recovered !== true
    || child.submissionAcknowledgement?.recoveredFromCheckpoint !== true
    || child.submissionAcknowledgement?.sourceRunId !== child.submissionRunId
    || child.sourceSubmittedAt !== (pending.submittedAt || null)) return false;
  const expectedTarget = expectedTargetConversationLineage(pending.targetId, pending.conversationUrl);
  if (expectedTarget) {
    return exactJson(child.targetConversationLineage, expectedTarget.lineage)
      && child.targetConversationLineageHash === expectedTarget.lineageHash;
  }
  const targetIdHash = expectedTargetIdHash(pending.targetId);
  return Boolean(targetIdHash && child.targetConversationLineage?.targetIdHash === targetIdHash);
}

function exactImmediateSourceLineage(generation, sourceGeneration) {
  if (
    sourceGeneration.jobId !== generation.jobId
    || sourceGeneration.runId === generation.runId
    || sourceGeneration.requestHash !== generation.requestHash
    || sourceGeneration.scriptHash !== generation.scriptHash
    || sourceGeneration.resumeRequestHash !== generation.resumeRequestHash
    || sourceGeneration.resumeScriptHash !== generation.resumeScriptHash
    || !exactJson(sourceGeneration.request, generation.request)
    || sourceGeneration.sessionBindingHash !== generation.sessionBindingHash
    || !exactJson(sourceGeneration.sessionBinding, generation.sessionBinding)
    || sourceGeneration.providerDecisionHash !== generation.providerDecisionHash
    || !exactJson(sourceGeneration.providerDecision, generation.providerDecision)
    || sourceGeneration.providerAttestationHash !== generation.providerAttestationHash
    || !exactJson(sourceGeneration.providerAttestation, generation.providerAttestation)
  ) return false;
  return generation.segments.every((segment) => {
    if (segment.inheritedProviderSubmission !== true) return true;
    if (segment.sourceRunId !== sourceGeneration.runId
      || segment.sourceGenerationHash !== canonicalJsonHash(sourceGeneration)) return false;
    const sourceSegment = sourceGeneration.segments[segment.index - 1];
    if (sourceSegment?.index === segment.index) {
      return exactInheritedCompletedSegment(segment, sourceSegment);
    }
    return exactRecoveredPendingSegment(segment, sourceGeneration.pendingSegment);
  });
}

export function deriveGeminiSubmissionLineage(generation, runId, sourceReceipt = null) {
  if (
    !verifyStrictCompletedGeminiTerminalReceipt(generation)
    || generation.runId !== runId
  ) throw new Error("Gemini 완료 generation의 실행 계보를 결속할 수 없습니다.");
  const segments = generation.segments.map((segment, index) => {
    const providerRequestSentThisRun = segment?.providerRequestSentThisRun;
    const inheritedProviderSubmission = segment?.inheritedProviderSubmission;
    const submissionRunId = String(segment?.submissionRunId || "");
    const sourceRunId = segment?.sourceRunId == null ? null : String(segment.sourceRunId);
    if (
      segment?.index !== index + 1
      || segment.submittedToProvider !== true
      || typeof providerRequestSentThisRun !== "boolean"
      || typeof inheritedProviderSubmission !== "boolean"
      || providerRequestSentThisRun === inheritedProviderSubmission
      || !submissionRunId
    ) throw new Error(`${index + 1}번 Gemini 세그먼트의 provider 제출 계보가 유효하지 않습니다.`);
    if (providerRequestSentThisRun) {
      if (submissionRunId !== runId || sourceRunId !== null || segment.sourceGenerationHash !== null) {
        throw new Error(`${index + 1}번 Gemini 신규 제출 세그먼트가 현재 run에 정확히 결속되지 않았습니다.`);
      }
    } else if (
      !sourceReceipt
      || !sourceRunId
      || sourceRunId !== sourceReceipt.sourceRunId
      || segment.sourceGenerationHash !== sourceReceipt.sourceGenerationHash
      || !SHA256.test(String(sourceReceipt.sourceGenerationHash || ""))
    ) {
      throw new Error(`${index + 1}번 Gemini 상속 세그먼트의 보존 source generation 결속이 없습니다.`);
    }
    return {
      index: index + 1,
      providerRequestSentThisRun,
      inheritedProviderSubmission,
      submissionRunId,
      sourceRunId,
      sourceGenerationHash: inheritedProviderSubmission ? sourceReceipt.sourceGenerationHash : null
    };
  });
  const providerRequestSentThisRun = segments.some((segment) => segment.providerRequestSentThisRun);
  const inheritedProviderSubmission = segments.some((segment) => segment.inheritedProviderSubmission);
  const submissionRunIds = [...new Set(segments.map((segment) => segment.submissionRunId))].sort();
  if (
    generation.providerRequestSentThisRun !== providerRequestSentThisRun
    || generation.inheritedProviderSubmission !== inheritedProviderSubmission
    || JSON.stringify(generation.submissionRunIds) !== JSON.stringify(submissionRunIds)
  ) throw new Error("Gemini generation의 top-level 제출 요약이 세그먼트별 계보와 일치하지 않습니다.");
  return {
    schemaVersion: 1,
    providerRequestSentThisRun,
    inheritedProviderSubmission,
    sourceSubmissionRunId: inheritedProviderSubmission ? sourceReceipt?.sourceRunId || null : null,
    sourceGenerationHash: inheritedProviderSubmission ? sourceReceipt?.sourceGenerationHash || null : null,
    submissionRunIds,
    segments
  };
}

export function verifyGeminiSubmissionLineageClosure({ generation, runId, manifestLineage, sourceSnapshot = null, sourceDeclaration = null } = {}) {
  try {
    if (!verifyStrictCompletedGeminiTerminalReceipt(generation)
      || !manifestLineage || manifestLineage.schemaVersion !== 1 || manifestLineage.status !== "completed") return false;
    const receipt = manifestLineage.sourceGenerationReceipt;
    const inherited = generation?.segments?.some((segment) => segment?.inheritedProviderSubmission === true) === true;
    if (inherited) {
      const expectedName = geminiSourceGenerationEvidenceName(runId);
      const expectedKeys = ["bytes", "path", "schemaVersion", "sha256", "sourceGenerationHash", "sourceRunId"];
      if (
        !receipt
        || Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",")
        || receipt.schemaVersion !== 1
        || receipt.path !== expectedName
        || !Number.isSafeInteger(Number(receipt.bytes))
        || Number(receipt.bytes) < 1
        || !SHA256.test(String(receipt.sha256 || ""))
        || !SHA256.test(String(receipt.sourceGenerationHash || ""))
        || typeof receipt.sourceRunId !== "string"
        || !receipt.sourceRunId
        || sourceSnapshot?.bytes !== Number(receipt.bytes)
        || sourceSnapshot.sha256 !== receipt.sha256
        || canonicalJsonHash(sourceSnapshot.value) !== receipt.sourceGenerationHash
        || sourceSnapshot.value?.provider !== "gemini-browser"
        || sourceSnapshot.value?.runId !== receipt.sourceRunId
        || !verifyStrictGeminiRecoverySourceReceipt(sourceSnapshot.value)
        || !exactImmediateSourceLineage(generation, sourceSnapshot.value)
        || !sourceDeclaration
        || sourceDeclaration.name !== expectedName
        || sourceDeclaration.bytes !== Number(receipt.bytes)
        || sourceDeclaration.sha256 !== receipt.sha256
      ) return false;
    } else if (receipt !== null || sourceSnapshot !== null || sourceDeclaration !== null) {
      return false;
    }
    const expected = {
      ...deriveGeminiSubmissionLineage(generation, runId, receipt),
      status: "completed",
      sourceGenerationReceipt: receipt
    };
    return canonicalJsonHash(manifestLineage) === canonicalJsonHash(expected);
  } catch {
    return false;
  }
}
