import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AHP_CRITERIA,
  bindQualityRevision,
  buildQualityRevisionEvent,
  buildQualityRevisionManifest,
  canonicalGeminiSessionBinding,
  canonicalJsonHash,
  committeeAttestationHash,
  committeeDecisionHash,
  committeeEvidenceHash,
  deriveQualityRevisionTransition,
  geminiSessionBindingHash,
  qualityEvaluationState,
  prepareQualityRevision,
  readQualityRevisionState,
  saveCommitteeReview,
  validateCommitteeReview,
  validateQualityRevisionContext,
  validateQualityRevisionManifest
} from "../src/quality.mjs";
import { JOBS_DIR } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";

const JOB_ID = "job-committee-001";
const RUN_ID = "run-committee-001";
const REVISION_ID = "revision-000001";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function scores(score = 99) {
  return Object.fromEntries(AHP_CRITERIA.map((criterion) => [criterion.id, { score, evidence: `${criterion.id} evidence` }]));
}

function reviewFixture({ jobId = JOB_ID, runId = RUN_ID, ids = ["reviewer-a", "reviewer-b", "reviewer-c", "reviewer-d", "reviewer-e"], revisionId = REVISION_ID, sequence = 1 } = {}) {
  const review = {
    schemaVersion: 2,
    jobId,
    runId,
    revisionId,
    revisionSequence: sequence,
    evidenceHashes: { "final.mp4": HASH_A, "quality/frame-01.jpg": HASH_B },
    scores: scores(),
    reviewers: []
  };
  const evidenceHash = committeeEvidenceHash(review.evidenceHashes);
  const decisionHash = committeeDecisionHash(review);
  review.evidenceHash = evidenceHash;
  review.reviewers = ids.map((id, index) => {
    const role = `role-${index + 1}`;
    const method = `method-${index + 1}`;
    const attestation = {
      schemaVersion: 1,
      reviewerId: id,
      role,
      method,
      jobId,
      runId,
      revisionId,
      revisionSequence: sequence,
      evidenceHash,
      decisionHash,
      authority: `independent-${index + 1}`
    };
    return { id, role, method, attestation, attestationHash: committeeAttestationHash(attestation) };
  });
  return review;
}

function revisionContext() {
  return {
    schemaVersion: 2,
    jobId: JOB_ID,
    runId: RUN_ID,
    revisionId: REVISION_ID,
    sequence: 1,
    baseManifest: { path: `runs/${RUN_ID}/manifest.json`, sha256: HASH_A, status: "needs-improvement" },
    baseQuality: { path: `runs/${RUN_ID}/artifacts/quality.json`, sha256: HASH_B },
    supersedes: {
      type: "base-run",
      path: `runs/${RUN_ID}/manifest.json`,
      sha256: HASH_A,
      sequence: 0,
      revisionId: null,
      effectiveStatus: "needs-improvement"
    }
  };
}

function evaluatedQualityFixture({ context = revisionContext(), review = reviewFixture(), status = "passed", semanticGate = true, blockers = [] } = {}) {
  const criteria = AHP_CRITERIA.map((criterion) => ({
    id: criterion.id,
    label: criterion.label,
    autoScore: 100,
    committeeScore: Number(review.scores[criterion.id].score),
    score: Number(review.scores[criterion.id].score),
    factors: [{ id: `${criterion.id}-factor`, label: `${criterion.id} factor`, max: 100, pass: true }],
    evidence: `${criterion.id} evaluated evidence`,
    blockers: []
  }));
  const totalScore = criteria.reduce((sum, criterion) => sum + criterion.score * AHP_CRITERIA.find((item) => item.id === criterion.id).weight / 100, 0);
  const trueMetrics = Object.fromEntries([
    "providerProof", "providerDecisionBinding", "providerDecisionEventBinding", "providerAttestationBinding",
    "localVideoModelBinding", "localVideoRequestBinding", "localVideoClipBinding", "localVideoReceiptBinding",
    "providerGenerationProvenance", "generationClipBinding", "generationProvenance", "terminalRunBinding",
    "terminalEventBinding", "eventLogParsePass", "immutableClosureBinding", "immutableEvidenceBinding",
    "inputMotionGateBinding", "inputDiversityBinding", "inputManifestBinding", "runManifestBinding", "benchmarkReceiptBinding",
    "sourceSetBinding", "sourceContentBinding", "committeeEvidenceBound", "committeeAttestationValid",
    "sourceQuality", "researchStatusVerified", "evidenceTextBindingVerified", "claimEvidencePass"
  ].map((name) => [name, true]));
  return {
    schemaVersion: 1,
    jobId: context.jobId,
    runId: context.runId,
    iteration: 2,
    evaluatedAt: "2026-08-12T00:00:00.000Z",
    threshold: 98,
    status,
    totalScore,
    finalization: false,
    postPublicationRevision: true,
    prePublication: false,
    ahp: {
      matrix: [],
      weights: AHP_CRITERIA.map((criterion) => ({ id: criterion.id, targetWeight: criterion.weight, calculatedWeight: criterion.weight }))
    },
    committee: { reviewers: review.reviewers, reviewedAt: review.reviewedAt, status: "present" },
    semanticGate,
    metrics: {
      ...trueMetrics,
      evaluationPhase: "post-publication-revision",
      semanticGateStateEligible: true,
      revisionEvaluationEligible: true,
      runId: context.runId,
      revisionContext: {
        revisionId: context.revisionId,
        sequence: context.sequence,
        baseManifest: context.baseManifest,
        baseQuality: context.baseQuality,
        supersedes: context.supersedes
      },
      provider: "local-video",
      evidenceHashes: review.evidenceHashes
    },
    criteria,
    remediation: [],
    blockers
  };
}

describe("committee attestation integrity", () => {
  test("accepts canonical, decision-bound reviewer attestations", () => {
    const review = reviewFixture();
    expect(validateCommitteeReview(review, { expectedJobId: JOB_ID, expectedRunId: RUN_ID })).toBe(true);
    expect(committeeDecisionHash(review)).toBe(review.reviewers[0].attestation.decisionHash);
  });

  test("rejects a well-formed but fabricated declared hash", () => {
    const review = reviewFixture();
    review.reviewers[0].attestationHash = HASH_C;
    expect(() => validateCommitteeReview(review)).toThrow(/payload 정규화 해시/);
  });

  test("rejects payload mutation after canonical hashing", () => {
    const review = reviewFixture();
    review.reviewers[0].attestation.authority = "mutated";
    expect(() => validateCommitteeReview(review)).toThrow(/payload 정규화 해시/);
  });

  test("rejects reused reviewer identities and attestations across revisions", () => {
    const first = reviewFixture();
    const second = reviewFixture({ revisionId: "revision-000002", sequence: 2 });
    expect(() => validateCommitteeReview(second, { usedReviewerIds: new Set(["REVIEWER-A"]) })).toThrow(/이미 사용/);
    expect(() => validateCommitteeReview(first, { usedAttestationHashes: new Set([first.reviewers[2].attestationHash]) })).toThrow(/이미 사용/);
  });

  test("requires the exact immutable evidence hash set", () => {
    const review = reviewFixture();
    expect(() => validateCommitteeReview(review, { expectedEvidenceHashes: { "final.mp4": HASH_A } })).toThrow(/evidenceHashes/);
  });

  test("rejects a fabricated top-level decision hash when one is declared", () => {
    const review = { ...reviewFixture(), decisionHash: HASH_C };
    expect(() => validateCommitteeReview(review)).toThrow(/decisionHash/);
  });
});

describe("append-only quality promotion state", () => {
  test("opens the formerly unreachable semantic gate only for needs-improvement revision", () => {
    expect(qualityEvaluationState({
      jobStatus: "needs-improvement",
      manifestStatus: "needs-improvement",
      manifestRunStatus: "needs-improvement",
      allowPostPublicationRevision: true
    })).toEqual({ phase: "post-publication-revision", semanticGateEligible: true, finalizationEligible: false, revisionEligible: true });
    expect(qualityEvaluationState({
      jobStatus: "completed",
      manifestStatus: "completed",
      manifestRunStatus: "verified",
      allowPostPublicationRevision: true
    }).semanticGateEligible).toBe(false);
  });

  test("permits only needs-improvement to completed promotion or append-only remediation", () => {
    expect(deriveQualityRevisionTransition("needs-improvement", { status: "passed", semanticGate: true, blockers: [] })).toEqual({
      from: "needs-improvement", to: "completed", kind: "promotion", terminal: true
    });
    expect(deriveQualityRevisionTransition("needs-improvement", { status: "needs-improvement", semanticGate: false, blockers: ["fix"] }).to).toBe("needs-improvement");
    expect(() => deriveQualityRevisionTransition("completed", { status: "passed", semanticGate: true, blockers: [] })).toThrow(/needs-improvement/);
    expect(() => deriveQualityRevisionTransition("needs-improvement", { status: "passed", semanticGate: false, blockers: [] })).toThrow(/semanticGate/);
  });

  test("binds quality and manifest to immutable base and superseded head", () => {
    const context = revisionContext();
    const review = reviewFixture();
    const evaluated = evaluatedQualityFixture({ context, review });
    const quality = bindQualityRevision(evaluated, context, HASH_C);
    const root = `runs/${RUN_ID}/revisions/${REVISION_ID}`;
    const committeeReview = { path: `${root}/committee-review.json`, sha256: HASH_C, bytes: 111 };
    const qualityArtifact = { path: `${root}/quality.json`, sha256: HASH_D, bytes: 222 };
    const eventRecord = buildQualityRevisionEvent({
      context,
      committeeReview,
      qualityArtifact,
      transition: quality.revision.transition,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    const manifest = buildQualityRevisionManifest({
      context,
      review,
      quality,
      committeeReview,
      qualityArtifact,
      events: { path: `${root}/events.jsonl`, sha256: canonicalJsonHash({ event: 1 }), bytes: 333 },
      eventRecord,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    expect(manifest.immutableBase).toBe(true);
    expect(manifest.transition.to).toBe("completed");
    expect(validateQualityRevisionManifest(manifest, { context, review, quality, eventRecord })).toBe(true);
    expect(() => validateQualityRevisionManifest(manifest, { context, review, quality, eventRecord: { ...eventRecord, qualityHash: HASH_A } })).toThrow(/봉인 이벤트/);
    expect(() => validateQualityRevisionContext({ ...context, supersedes: { ...context.supersedes, sha256: HASH_D } })).toThrow(/supersede/);
  });

  test("requires each later revision to supersede exactly the previous unpromoted manifest", () => {
    const context = {
      ...revisionContext(),
      revisionId: "revision-000002",
      sequence: 2,
      supersedes: {
        type: "quality-revision",
        path: `runs/${RUN_ID}/revisions/revision-000001/manifest.json`,
        sha256: HASH_C,
        sequence: 1,
        revisionId: "revision-000001",
        effectiveStatus: "needs-improvement"
      }
    };
    expect(validateQualityRevisionContext(context)).toBe(true);
    expect(() => validateQualityRevisionContext({ ...context, supersedes: { ...context.supersedes, sequence: 0 } })).toThrow(/직전/);
  });

  test("walks the sealed revision chain and rejects reviewer replay", async () => {
    const jobId = `quality-test-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const runDir = join(jobDir, "runs", runId);
    const baseQualityPath = join(runDir, "artifacts", "quality.json");
    try {
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      const baseQuality = {
        schemaVersion: 1,
        jobId,
        runId,
        status: "needs-improvement",
        semanticGate: false,
        totalScore: 95,
        threshold: 98,
        blockers: ["committee missing"],
        metrics: { provider: "local-video", evidenceHashes: { "final.mp4": HASH_A, "quality/frame-01.jpg": HASH_B } }
      };
      await writeFile(baseQualityPath, JSON.stringify(baseQuality, null, 2));
      const baseQualityStat = await stat(baseQualityPath);
      const providerDecision = { requested: "local-video", selected: "local-video", fallbackUsed: false, policy: "local-video-command-adapter-no-fallback" };
      const baseManifest = {
        schemaVersion: 1,
        jobId,
        runId,
        status: "needs-improvement",
        runStatus: "needs-improvement",
        request: { provider: "local-video", fallbackPolicy: "local-video-command-adapter-no-fallback" },
        providerDecision,
        providerDecisionHash: canonicalJsonHash(providerDecision),
        ledgerErrors: [],
        qualitySummary: Object.fromEntries(["status", "totalScore", "threshold", "semanticGate", "runId", "blockers"].map((field) => [field, baseQuality[field]])),
        immutableArtifacts: [{ name: "quality.json", path: `runs/${runId}/artifacts/quality.json`, bytes: baseQualityStat.size, sha256: await hashFile(baseQualityPath) }]
      };
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(baseManifest, null, 2));
      await writeFile(join(jobDir, "job.json"), JSON.stringify({ id: jobId, runId, status: "needs-improvement", provider: "local-video" }, null, 2));

      const revisionsPath = join(runDir, "revisions");
      await writeFile(revisionsPath, "not-a-directory");
      await expect(readQualityRevisionState(jobId, runId)).rejects.toMatchObject({ code: "ENOTDIR" });
      await rm(revisionsPath);

      const context = await prepareQualityRevision(jobId, runId, "revision-chain-000001");
      const submitted = reviewFixture({ jobId, runId, revisionId: context.revisionId, sequence: context.sequence });
      await expect(saveCommitteeReview(jobId, submitted)).rejects.toThrow(/revision context/);
      const review = await saveCommitteeReview(jobId, submitted, { revisionContext: context });
      const revisionDir = join(runDir, "revisions", context.revisionId);
      await mkdir(revisionDir, { recursive: true });
      const reviewPath = join(revisionDir, "committee-review.json");
      await writeFile(reviewPath, JSON.stringify(review, null, 2));
      const reviewDeclaration = { path: `runs/${runId}/revisions/${context.revisionId}/committee-review.json`, sha256: await hashFile(reviewPath), bytes: (await stat(reviewPath)).size };
      const evaluated = evaluatedQualityFixture({ context, review, status: "needs-improvement", semanticGate: false, blockers: ["remediation required"] });
      const quality = bindQualityRevision(evaluated, context, reviewDeclaration.sha256);
      const qualityPath = join(revisionDir, "quality.json");
      await writeFile(qualityPath, JSON.stringify(quality, null, 2));
      const qualityDeclaration = { path: `runs/${runId}/revisions/${context.revisionId}/quality.json`, sha256: await hashFile(qualityPath), bytes: (await stat(qualityPath)).size };
      const eventRecord = buildQualityRevisionEvent({ context, committeeReview: reviewDeclaration, qualityArtifact: qualityDeclaration, transition: quality.revision.transition });
      const eventsPath = join(revisionDir, "events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify(eventRecord)}\n`);
      const eventsDeclaration = { path: `runs/${runId}/revisions/${context.revisionId}/events.jsonl`, sha256: await hashFile(eventsPath), bytes: (await stat(eventsPath)).size };
      const manifest = buildQualityRevisionManifest({ context, review, quality, committeeReview: reviewDeclaration, qualityArtifact: qualityDeclaration, events: eventsDeclaration, eventRecord });
      await writeFile(join(revisionDir, "manifest.json"), JSON.stringify(manifest, null, 2));

      const state = await readQualityRevisionState(jobId, runId);
      expect(state.nextSequence).toBe(2);
      expect(state.effectiveStatus).toBe("needs-improvement");
      expect(state.latestQuality.revisionId).toBe(context.revisionId);
      const unexpectedPath = join(revisionDir, "unsealed.json");
      await writeFile(unexpectedPath, "{}");
      await expect(readQualityRevisionState(jobId, runId)).rejects.toThrow(/네 파일/);
      await rm(unexpectedPath);
      const nextContext = await prepareQualityRevision(jobId, runId, "revision-chain-000002");
      const replay = reviewFixture({ jobId, runId, revisionId: nextContext.revisionId, sequence: nextContext.sequence });
      await expect(saveCommitteeReview(jobId, replay, { revisionContext: nextContext })).rejects.toThrow(/이미 사용/);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

describe("Gemini session provenance", () => {
  test("uses persisted job configuration and exposes only a sanitized canonical binding", () => {
    const job = { geminiCdpUrl: "http://127.0.0.1:9233/path?ignored=1", geminiProfileDir: "/Users/private/person/.ps4-ai-video-studio/chrome-work" };
    const binding = canonicalGeminiSessionBinding(job);
    expect(binding.cdpOrigin).toBe("http://127.0.0.1:9233");
    expect(binding.profileBasename).toBe("chrome-work");
    expect(binding.profilePathHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(binding)).not.toContain("/Users/private/person");
    expect(geminiSessionBindingHash(job)).toBe(canonicalJsonHash(binding));
  });

  test("does not fall back to process environment when persisted config is missing", () => {
    expect(canonicalGeminiSessionBinding({})).toBeNull();
    expect(geminiSessionBindingHash({ geminiCdpUrl: "http://127.0.0.1:9222" })).toBeNull();
  });
});
