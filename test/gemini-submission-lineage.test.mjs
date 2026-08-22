import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonHash } from "../src/provenance.mjs";
import {
  deriveGeminiSubmissionLineage,
  geminiSourceGenerationEvidenceName,
  verifyGeminiSubmissionLineageClosure,
  verifyStrictCompletedGeminiTerminalReceipt
} from "../src/gemini-submission-lineage.mjs";
import { preserveGeminiSourceGenerationEvidence } from "../src/pipeline.mjs";
import { createGeminiFailureEvidence } from "../src/gemini-error-safety.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceGeneration(runId = "source-run") {
  const generation = baseGeneration(runId);
  generation.status = "failed";
  generation.completedAt = "2026-08-12T12:01:00.000Z";
  generation.errorEvidence = createGeminiFailureEvidence("fixture interrupted after one completed clip", { phase: "pipeline" });
  generation.error = generation.errorEvidence.reasonCode;
  generation.errorCode = "GEMINI_FIXTURE_INTERRUPTED";
  generation.segments = [completedSegment(1, {
    runId,
    submissionRunId: runId,
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    sourceRunId: null,
    sourceGenerationHash: null,
    generation
  })];
  generation.providerRequestSentThisRun = true;
  generation.inheritedProviderSubmission = false;
  generation.submissionRunIds = [runId];
  return generation;
}

function fixtureContext() {
  const sessionBinding = {
    schemaVersion: 1,
    cdpOrigin: "http://127.0.0.1:9222",
    profileBasename: "gemini-profile",
    profilePathHash: canonicalJsonHash({ type: "gemini-chrome-profile-path", path: "/fixture/gemini-profile" })
  };
  const sessionBindingHash = canonicalJsonHash(sessionBinding);
  const runtimeProof = {
    schemaVersion: 1,
    method: "cdp-browser-get-command-line-and-version",
    sessionBindingHash,
    cdpOriginHash: canonicalJsonHash({ type: "gemini-cdp-origin", origin: sessionBinding.cdpOrigin }),
    profilePathHash: sessionBinding.profilePathHash,
    remoteDebuggingAddress: "127.0.0.1",
    remoteDebuggingPort: "9222",
    headless: true,
    headlessImplementation: "new",
    chromeMajor: 140,
    browserVersionHash: canonicalJsonHash({ browser: "HeadlessChrome/140" }),
    commandLineHash: canonicalJsonHash({ command: "privacy-safe" })
  };
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: "HeadlessChrome/140.0",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    headlessRequested: true,
    chromeMajor: 140,
    headlessImplementation: "new",
    runtimeProof,
    runtimeProofHash: canonicalJsonHash(runtimeProof),
    fallbackUsed: false
  };
  const providerDecision = { requested: "gemini-browser", selected: "gemini-browser", fallbackUsed: false, policy: "no-local-video-fallback" };
  const providerDecisionHash = canonicalJsonHash(providerDecision);
  const request = {
    provider: "gemini-browser",
    topic: "fixture lineage",
    format: "vertical",
    clipCount: 2,
    targetDurationSec: 20,
    targetDurationRangeSec: [19, 21],
    captions: true,
    voiceover: false,
    segments: [
      { durationHint: 10, visualPrompt: "first shot", caption: "first", narration: "first" },
      { durationHint: 10, visualPrompt: "second shot", caption: "second", narration: "second" }
    ]
  };
  const scriptHash = canonicalJsonHash({ fixture: "script" });
  const resumeScriptHash = canonicalJsonHash({ fixture: "resume-script" });
  return {
    sessionBinding,
    sessionBindingHash,
    providerAttestation,
    providerDecision,
    providerDecisionHash,
    request,
    scriptHash,
    resumeScriptHash,
    requestHash: canonicalJsonHash({ ...request, scriptHash }),
    resumeRequestHash: canonicalJsonHash({ ...request, scriptHash: resumeScriptHash })
  };
}

function baseGeneration(runId) {
  const context = fixtureContext();
  return {
    schemaVersion: 5,
    provider: "gemini-browser",
    jobId: "job-lineage",
    runId,
    status: "running",
    pendingSegment: null,
    browser: context.providerAttestation.browser,
    startedAt: "2026-08-12T12:00:00.000Z",
    promptReadinessFailure: null,
    request: context.request,
    requestHash: context.requestHash,
    requestScriptHash: context.requestHash,
    scriptHash: context.scriptHash,
    resumeRequestHash: context.resumeRequestHash,
    resumeScriptHash: context.resumeScriptHash,
    providerDecision: context.providerDecision,
    providerDecisionHash: context.providerDecisionHash,
    sessionBinding: context.sessionBinding,
    sessionBindingHash: context.sessionBindingHash,
    providerAttestation: context.providerAttestation,
    providerAttestationHash: canonicalJsonHash(context.providerAttestation),
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: [],
    providerRequestSentThisRun: false,
    inheritedProviderSubmission: false,
    submissionRunIds: [],
    segments: []
  };
}

function targetLineage(index) {
  const lineage = {
    schemaVersion: 1,
    method: "privacy-safe-cdp-target-conversation-hashes",
    targetIdHash: canonicalJsonHash({ type: "gemini-cdp-target-id", value: `fixture-target-${index}` }),
    conversationUrlHash: canonicalJsonHash({ type: "gemini-canonical-conversation-url", value: `https://gemini.google.com/app/fixture-${index}` })
  };
  return { targetConversationLineage: lineage, targetConversationLineageHash: canonicalJsonHash(lineage) };
}

function completedSegment(index, {
  runId,
  submissionRunId,
  providerRequestSentThisRun,
  inheritedProviderSubmission,
  sourceRunId,
  sourceGenerationHash,
  generation
}) {
  const prompt = `exact fixture prompt ${index}`;
  return {
    index,
    submittedToProvider: true,
    providerRequestSentThisRun,
    inheritedProviderSubmission,
    submissionRunId,
    sourceRunId,
    sourceGenerationHash,
    runId,
    requestHash: generation.requestHash,
    scriptHash: generation.scriptHash,
    resumeRequestHash: generation.resumeRequestHash,
    resumeScriptHash: generation.resumeScriptHash,
    providerDecisionHash: generation.providerDecisionHash,
    providerAttestationHash: generation.providerAttestationHash,
    prompt,
    promptHash: canonicalJsonHash({ prompt }),
    providerVisualPromptHash: canonicalJsonHash({ providerVisualPrompt: index }),
    shotPattern: { patternId: `fixture-${index}` },
    submissionAcknowledgement: { verified: true, clickCount: 1, evidenceTypes: ["user-message"] },
    path: `clips/${String(index).padStart(2, "0")}.mp4`,
    output: `clips/${String(index).padStart(2, "0")}.mp4`,
    sha256: canonicalJsonHash({ clip: index }),
    ...targetLineage(index)
  };
}

function completedGeneration(runId, sourceRunId, sourceGenerationHash) {
  const generation = baseGeneration(runId);
  generation.status = "completed";
  generation.completedAt = "2026-08-12T12:02:00.000Z";
  generation.segments = [
    completedSegment(1, {
      runId,
      submissionRunId: sourceRunId,
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true,
      sourceRunId,
      sourceGenerationHash,
      generation
    }),
    completedSegment(2, {
      runId,
      submissionRunId: runId,
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null,
      generation
    })
  ];
  generation.providerRequestSentThisRun = true;
  generation.inheritedProviderSubmission = true;
  generation.submissionRunIds = [runId, sourceRunId].sort();
  return generation;
}

describe("Gemini submission lineage closure", () => {
  test("preserves the exact source receipt bytes durably before the mutable root can be overwritten", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "ps4-gemini-lineage-"));
    roots.push(jobDir);
    const runId = "child-run";
    const runDir = join(jobDir, "runs", runId);
    const sourcePath = join(jobDir, "gemini-generation.json");
    const source = sourceGeneration();
    const bytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    await writeFile(sourcePath, bytes);
    const receipt = await preserveGeminiSourceGenerationEvidence(jobDir, runDir, runId, {
      generation: source,
      sourceGenerationBytes: bytes,
      sourceGenerationPath: sourcePath,
      sourceGenerationReceipt: {
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        sourceRunId: source.runId,
        sourceGenerationHash: canonicalJsonHash(source)
      }
    });
    const preserved = await readFile(join(jobDir, receipt.path));
    expect(preserved.equals(bytes)).toBeTrue();
    expect(receipt).toEqual({
      schemaVersion: 1,
      path: geminiSourceGenerationEvidenceName(runId),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      sourceRunId: source.runId,
      sourceGenerationHash: canonicalJsonHash(source)
    });
    expect((await stat(join(jobDir, receipt.path))).mode & 0o777).toBe(0o600);
  });

  test("rejects a source receipt changed after its exact bytes were captured", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "ps4-gemini-lineage-"));
    roots.push(jobDir);
    const sourcePath = join(jobDir, "gemini-generation.json");
    const source = sourceGeneration();
    const bytes = Buffer.from(JSON.stringify(source));
    await writeFile(sourcePath, `${JSON.stringify({ ...source, status: "running" })}\n`);
    await expect(preserveGeminiSourceGenerationEvidence(jobDir, join(jobDir, "runs/child-run"), "child-run", {
      generation: source,
      sourceGenerationBytes: bytes,
      sourceGenerationPath: sourcePath,
      sourceGenerationReceipt: {
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        sourceRunId: source.runId,
        sourceGenerationHash: canonicalJsonHash(source)
      }
    })).rejects.toThrow("보존 직전에 변경");
  });

  test("binds mixed old/new segments to their true submission runs and the exact source JSON", () => {
    const runId = "child-run";
    const source = sourceGeneration();
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    const sourceReceipt = {
      schemaVersion: 1,
      path: geminiSourceGenerationEvidenceName(runId),
      bytes: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      sourceRunId: source.runId,
      sourceGenerationHash: canonicalJsonHash(source)
    };
    const generation = completedGeneration(runId, source.runId, sourceReceipt.sourceGenerationHash);
    const lineage = deriveGeminiSubmissionLineage(generation, runId, sourceReceipt);
    const manifestLineage = { ...lineage, status: "completed", sourceGenerationReceipt: sourceReceipt };
    const sourceDeclaration = { name: sourceReceipt.path, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 };
    const sourceSnapshot = { value: source, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 };
    expect(lineage).toMatchObject({
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: true,
      sourceSubmissionRunId: source.runId,
      sourceGenerationHash: sourceReceipt.sourceGenerationHash,
      submissionRunIds: ["child-run", source.runId]
    });
    expect(lineage.segments[0]).toMatchObject({ submissionRunId: source.runId, sourceRunId: source.runId, providerRequestSentThisRun: false });
    expect(lineage.segments[1]).toMatchObject({ submissionRunId: runId, sourceRunId: null, providerRequestSentThisRun: true });
    expect(verifyGeminiSubmissionLineageClosure({ generation, runId, manifestLineage, sourceSnapshot, sourceDeclaration })).toBeTrue();
    expect(verifyStrictCompletedGeminiTerminalReceipt(generation)).toBeTrue();
    expect(verifyGeminiSubmissionLineageClosure({
      generation,
      runId,
      manifestLineage,
      sourceSnapshot: { ...sourceSnapshot, sha256: `sha256:${"0".repeat(64)}` },
      sourceDeclaration
    })).toBeFalse();

    const wrongSource = structuredClone(generation);
    wrongSource.segments[0].sourceGenerationHash = `sha256:${"f".repeat(64)}`;
    expect(() => deriveGeminiSubmissionLineage(wrongSource, runId, sourceReceipt)).toThrow("source generation");
  });

  test("rejects completed terminal receipts with missing or mutated request, acknowledgement, prompt, clip, runtime, or target evidence", () => {
    const source = sourceGeneration();
    const generation = completedGeneration("child-run", source.runId, canonicalJsonHash(source));
    const changedRequest = structuredClone(generation);
    changedRequest.request.topic = "mutated after hashing";
    expect(verifyStrictCompletedGeminiTerminalReceipt(changedRequest)).toBeFalse();

    const noAcknowledgement = structuredClone(generation);
    delete noAcknowledgement.segments[0].submissionAcknowledgement;
    expect(verifyStrictCompletedGeminiTerminalReceipt(noAcknowledgement)).toBeFalse();

    const changedPrompt = structuredClone(generation);
    changedPrompt.segments[0].prompt += " mutated";
    expect(verifyStrictCompletedGeminiTerminalReceipt(changedPrompt)).toBeFalse();

    const changedPath = structuredClone(generation);
    changedPath.segments[0].path = "clips/99.mp4";
    expect(verifyStrictCompletedGeminiTerminalReceipt(changedPath)).toBeFalse();

    const changedSha = structuredClone(generation);
    changedSha.segments[0].sha256 = "not-a-sha256";
    expect(verifyStrictCompletedGeminiTerminalReceipt(changedSha)).toBeFalse();

    const noProof = structuredClone(generation);
    delete noProof.providerAttestation.runtimeProof;
    noProof.providerAttestationHash = canonicalJsonHash(noProof.providerAttestation);
    noProof.segments.forEach((segment) => { segment.providerAttestationHash = noProof.providerAttestationHash; });
    expect(verifyStrictCompletedGeminiTerminalReceipt(noProof)).toBeFalse();

    const wrongTarget = structuredClone(generation);
    wrongTarget.segments[0].targetConversationLineage.targetIdHash = `sha256:${"e".repeat(64)}`;
    expect(verifyStrictCompletedGeminiTerminalReceipt(wrongTarget)).toBeFalse();

    const headed = structuredClone(generation);
    headed.providerAttestation.headless = false;
    headed.providerAttestationHash = canonicalJsonHash(headed.providerAttestation);
    headed.segments.forEach((segment) => { segment.providerAttestationHash = headed.providerAttestationHash; });
    expect(verifyStrictCompletedGeminiTerminalReceipt(headed)).toBeFalse();

    const legacySchema4 = structuredClone(generation);
    legacySchema4.schemaVersion = 4;
    expect(verifyStrictCompletedGeminiTerminalReceipt(legacySchema4)).toBeFalse();
  });

  test("requires inherited child evidence to equal the immediate source completed segment", () => {
    const runId = "child-run";
    const source = sourceGeneration();
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    const sourceReceipt = {
      schemaVersion: 1,
      path: geminiSourceGenerationEvidenceName(runId),
      bytes: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      sourceRunId: source.runId,
      sourceGenerationHash: canonicalJsonHash(source)
    };
    const generation = completedGeneration(runId, source.runId, sourceReceipt.sourceGenerationHash);
    const lineage = deriveGeminiSubmissionLineage(generation, runId, sourceReceipt);
    const manifestLineage = { ...lineage, status: "completed", sourceGenerationReceipt: sourceReceipt };
    const sourceDeclaration = { name: sourceReceipt.path, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 };
    const sourceSnapshot = { value: source, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 };
    const verify = (candidate) => verifyGeminiSubmissionLineageClosure({
      generation: candidate,
      runId,
      manifestLineage,
      sourceSnapshot,
      sourceDeclaration
    });
    expect(verify(generation)).toBeTrue();

    const changedSubmission = structuredClone(generation);
    changedSubmission.segments[0].submissionRunId = "different-original-submit";
    changedSubmission.submissionRunIds = ["different-original-submit", runId].sort();
    expect(verify(changedSubmission)).toBeFalse();

    const changedAcknowledgement = structuredClone(generation);
    changedAcknowledgement.segments[0].submissionAcknowledgement.evidenceTypes = ["generation"];
    expect(verify(changedAcknowledgement)).toBeFalse();

    const changedVisualPrompt = structuredClone(generation);
    changedVisualPrompt.segments[0].providerVisualPromptHash = canonicalJsonHash({ providerVisualPrompt: "different" });
    expect(verify(changedVisualPrompt)).toBeFalse();

    const changedClipSha = structuredClone(generation);
    changedClipSha.segments[0].sha256 = canonicalJsonHash({ clip: "different-valid-sha" });
    expect(verify(changedClipSha)).toBeFalse();

    const changedTarget = structuredClone(generation);
    changedTarget.segments[0].targetConversationLineage.targetIdHash = canonicalJsonHash({ target: "different" });
    changedTarget.segments[0].targetConversationLineageHash = canonicalJsonHash(changedTarget.segments[0].targetConversationLineage);
    expect(verify(changedTarget)).toBeFalse();
  });

  test("binds a recovered pending segment to the immediate source checkpoint without claiming a new provider request", () => {
    const runId = "pending-child-run";
    const source = sourceGeneration("pending-source-run");
    const prompt = "exact fixture prompt 2";
    source.pendingSegment = {
      schemaVersion: 2,
      status: "submitted-awaiting-result",
      index: 2,
      runId: source.runId,
      submissionRunId: source.runId,
      submittedToProvider: true,
      submissionMayHaveOccurred: true,
      submittedAt: "2026-08-12T12:00:30.000Z",
      prompt,
      promptHash: canonicalJsonHash({ prompt }),
      providerVisualPromptHash: canonicalJsonHash({ providerVisualPrompt: 2 }),
      shotPattern: { patternId: "fixture-2" },
      targetId: "fixture-target-2",
      conversationUrl: "https://gemini.google.com/app/fixture-2",
      submissionAcknowledgement: { verified: true, clickCount: 1, evidenceTypes: ["user-message"] }
    };
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    const sourceReceipt = {
      schemaVersion: 1,
      path: geminiSourceGenerationEvidenceName(runId),
      bytes: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      sourceRunId: source.runId,
      sourceGenerationHash: canonicalJsonHash(source)
    };
    const generation = completedGeneration(runId, source.runId, sourceReceipt.sourceGenerationHash);
    generation.segments[1] = {
      ...generation.segments[1],
      submissionRunId: source.runId,
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true,
      sourceRunId: source.runId,
      sourceGenerationHash: sourceReceipt.sourceGenerationHash,
      recovered: true,
      sourceSubmittedAt: source.pendingSegment.submittedAt,
      submissionAcknowledgement: {
        ...source.pendingSegment.submissionAcknowledgement,
        recoveredFromCheckpoint: true,
        sourceRunId: source.runId
      }
    };
    generation.providerRequestSentThisRun = false;
    generation.inheritedProviderSubmission = true;
    generation.submissionRunIds = [source.runId];
    const lineage = deriveGeminiSubmissionLineage(generation, runId, sourceReceipt);
    const manifestLineage = { ...lineage, status: "completed", sourceGenerationReceipt: sourceReceipt };
    expect(verifyGeminiSubmissionLineageClosure({
      generation,
      runId,
      manifestLineage,
      sourceSnapshot: { value: source, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 },
      sourceDeclaration: { name: sourceReceipt.path, bytes: sourceReceipt.bytes, sha256: sourceReceipt.sha256 }
    })).toBeTrue();
    expect(lineage).toMatchObject({ providerRequestSentThisRun: false, inheritedProviderSubmission: true });
  });

  test("fails closed when schema-5 segment or top-level exact lineage fields are absent", () => {
    const source = sourceGeneration();
    const receipt = {
      sourceRunId: source.runId,
      sourceGenerationHash: canonicalJsonHash(source)
    };
    const missingSegmentField = completedGeneration("child-run", source.runId, receipt.sourceGenerationHash);
    delete missingSegmentField.segments[0].providerRequestSentThisRun;
    expect(() => deriveGeminiSubmissionLineage(missingSegmentField, "child-run", receipt)).toThrow("실행 계보");

    const missingSummary = completedGeneration("child-run", source.runId, receipt.sourceGenerationHash);
    delete missingSummary.submissionRunIds;
    expect(() => deriveGeminiSubmissionLineage(missingSummary, "child-run", receipt)).toThrow("실행 계보");
  });
});
