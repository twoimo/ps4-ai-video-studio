import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AHP_CRITERIA,
  committeeAttestationHash,
  canonicalJsonHash,
  committeeDecisionHash,
  committeeEvidenceHash,
  evaluateJob,
  prepareQualityRevision
} from "../src/quality.mjs";
import { JOBS_DIR, readJob } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  createStudioRequestHandler,
  sealQualityRevision,
  startStudioServer
} from "../src/server.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const createdJobs = [];

afterEach(async () => {
  await Promise.all(createdJobs.splice(0).map((jobId) => rm(join(JOBS_DIR, jobId), { recursive: true, force: true })));
});

function postRequest(path, token, body) {
  const url = `http://127.0.0.1:3000${path}`;
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function getRequest(path, token) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` }
  });
}

async function createSealedNeedsImprovementFixture() {
  const jobId = `quality-api-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  createdJobs.push(jobId);
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const baseQuality = {
    schemaVersion: 1,
    jobId,
    runId,
    iteration: 2,
    status: "needs-improvement",
    totalScore: 95,
    threshold: 98,
    semanticGate: false,
    blockers: ["committee missing"],
    metrics: { provider: "local", providerProof: true, evidenceHashes: { "final.mp4": HASH_A, "quality/frame-01.jpg": HASH_B } }
  };
  const qualitySummaryFields = ["status", "totalScore", "threshold", "semanticGate", "runId", "blockers"];
  const qualitySummary = Object.fromEntries(qualitySummaryFields.map((field) => [field, baseQuality[field]]));
  const immutableArtifacts = [];
  const writeArtifact = async (name, content) => {
    const path = join(artifactsDir, name.replaceAll("/", "__"));
    await writeFile(path, content);
    const receipt = { name, path: `runs/${runId}/artifacts/${name.replaceAll("/", "__")}`, bytes: (await stat(path)).size, sha256: await hashFile(path) };
    immutableArtifacts.push(receipt);
    return receipt;
  };
  const qualityReceipt = await writeArtifact("quality.json", JSON.stringify(baseQuality, null, 2));
  await writeArtifact("final.mp4", "fake-video");
  await writeArtifact("captions.srt", "1\n00:00:00,000 --> 00:00:01,000\ncaption\n");
  await writeArtifact("script.json", JSON.stringify({ segments: [] }));
  await writeArtifact("thumbnail.jpg", "fake-image");
  await writeArtifact("frame-audio-caption.json", JSON.stringify({ runId }));
  await writeArtifact("sources.json", JSON.stringify({ status: "complete", records: [] }));
  await writeArtifact(`runs/${runId}/input-manifest.json`, JSON.stringify({ schemaVersion: 1, jobId, runId, entries: [] }));
  await writeArtifact(`runs/${runId}/benchmarks/channel-analysis.json`, "{}");
  await writeArtifact(`runs/${runId}/benchmarks/shorts-metadata.json`, "{}");
  await writeArtifact(`runs/${runId}/benchmarks/rlm-benchmark-analysis.json`, "{}");
  await writeArtifact(`runs/${runId}/events.jsonl`, `${JSON.stringify({
    type: "quality_finalized",
    jobId,
    runId,
    status: "needs-improvement",
    qualityHash: qualityReceipt.sha256,
    qualitySummary
  })}\n`);
  const providerDecision = { requested: "local", selected: "local", fallbackUsed: false, policy: "local-upload-edit" };
  const manifest = {
    schemaVersion: 1,
    jobId,
    runId,
    status: "needs-improvement",
    runStatus: "needs-improvement",
    request: {
      topic: "품질 리비전 통합 테스트",
      provider: "local",
      format: "vertical",
      clipCount: 1,
      targetDurationSec: 78,
      targetDurationRangeSec: [60, 120],
      captions: true,
      voiceover: false,
      fallbackPolicy: "local-upload-edit"
    },
    providerDecision,
    providerDecisionHash: canonicalJsonHash(providerDecision),
    eventsPath: `runs/${runId}/events.jsonl`,
    ledgerErrors: [],
    qualitySummary,
    immutableArtifacts
  };
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const job = {
    id: jobId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runId,
    provider: "local",
    topic: "품질 리비전 통합 테스트",
    format: "vertical",
    clipCount: 1,
    targetDurationSec: 78,
    targetDurationRangeSec: [60, 120],
    captions: true,
    voiceover: false,
    status: "needs-improvement",
    runStatus: "needs-improvement",
    stage: "개선 필요",
    progress: 100,
    qualitySummary,
    artifacts: [],
    geminiCdpUrl: "http://127.0.0.1:9233",
    geminiProfileDir: "/Users/private/.ps4-ai-video-studio/test-profile"
  };
  await writeFile(join(jobDir, "job.json"), JSON.stringify(job, null, 2));
  return { jobId, runId, jobDir, runDir, job, manifest, baseQuality };
}

function buildReview(jobId, runId, revisionContext, evidenceHashes) {
  const scores = Object.fromEntries(AHP_CRITERIA.map((criterion) => [criterion.id, { score: 99, evidence: `${criterion.id} independently reviewed` }]));
  const review = {
    schemaVersion: 2,
    jobId,
    runId,
    revisionId: revisionContext.revisionId,
    revisionSequence: revisionContext.sequence,
    evidenceHashes,
    evidenceHash: committeeEvidenceHash(evidenceHashes),
    scores,
    reviewers: []
  };
  const decisionHash = committeeDecisionHash(review);
  review.reviewers = Array.from({ length: 5 }, (_, index) => {
    const id = `reviewer-${index + 1}`;
    const role = `role-${index + 1}`;
    const method = `method-${index + 1}`;
    const attestation = {
      schemaVersion: 1,
      reviewerId: id,
      role,
      method,
      jobId,
      runId,
      revisionId: revisionContext.revisionId,
      revisionSequence: revisionContext.sequence,
      evidenceHash: review.evidenceHash,
      decisionHash,
      authority: `independent-${index + 1}`
    };
    return { id, role, method, attestation, attestationHash: committeeAttestationHash(attestation) };
  });
  return review;
}

describe("quality revision API", () => {
  test("persists the configured Gemini session at job creation while redacting its profile path", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(postRequest("/api/jobs", token, {
      topic: "Gemini 세션 결속 생성 테스트",
      provider: "gemini-browser",
      autoStart: false,
      clipCount: 4,
      captions: true,
      voiceover: false,
      sources: []
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    createdJobs.push(payload.job.id);
    const persisted = await readJob(payload.job.id);
    expect(persisted.geminiCdpUrl).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
    expect(persisted.geminiProfileDir).toContain(".ps4-ai-video-studio");
    expect(payload.job).not.toHaveProperty("geminiProfileDir");
    expect(payload.job.geminiSessionBinding).toMatchObject({ cdpOrigin: persisted.geminiCdpUrl });
    expect(payload.job.geminiSessionBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("prepares a run-bound revision and redacts the persisted Chrome profile path", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      provider: "gemini-browser",
      runStatus: "verified",
      qualitySummary: { ...fixture.job.qualitySummary, totalScore: 1 }
    }, null, 2));
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(postRequest(`/api/jobs/${fixture.jobId}/quality/revisions/prepare`, token, {}));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.revisionContext).toMatchObject({ jobId: fixture.jobId, runId: fixture.runId, sequence: 1 });
    expect(payload.evidenceHashes).toEqual(fixture.baseQuality.metrics.evidenceHashes);
    expect(payload.evidenceHash).toBe(committeeEvidenceHash(payload.evidenceHashes));
    const reconciledBase = await readJob(fixture.jobId);
    expect(reconciledBase.provider).toBe("local");
    expect(reconciledBase.runStatus).toBe("needs-improvement");
    expect(reconciledBase.qualitySummary.totalScore).toBe(95);
    expect(reconciledBase.qualitySummary).not.toHaveProperty("revisionId");

    const review = buildReview(fixture.jobId, fixture.runId, payload.revisionContext, payload.evidenceHashes);
    const tamperedContext = {
      ...payload.revisionContext,
      baseManifest: { ...payload.revisionContext.baseManifest, sha256: HASH_A }
    };
    const tamperedSubmit = await handler(postRequest(`/api/jobs/${fixture.jobId}/quality/revisions/submit`, token, {
      revisionContext: tamperedContext,
      review
    }));
    expect(tamperedSubmit.status).toBe(400);
    expect((await tamperedSubmit.json()).error).toContain("append-only head");

    const jobResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    const publicJob = await jobResponse.json();
    expect(JSON.stringify(publicJob)).not.toContain("/Users/private");
    expect(publicJob).not.toHaveProperty("geminiProfileDir");
    expect(publicJob.geminiSessionBinding.profileBasename).toBe("test-profile");

    const oldShape = await handler(postRequest(`/api/jobs/${fixture.jobId}/committee-review`, token, { reviewers: [] }));
    expect(oldShape.status).toBe(400);
    expect((await oldShape.json()).error).toContain("revisionContext");
  });

  test("rejects fabricated evaluations, seals a trusted overlay, and reconciles a crash-orphaned pointer", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const baseManifestBefore = await readFile(join(fixture.runDir, "manifest.json"), "utf8");
    const revisionContext = await prepareQualityRevision(fixture.jobId, fixture.runId, "revision-integration-000001");
    const review = buildReview(fixture.jobId, fixture.runId, revisionContext, fixture.baseQuality.metrics.evidenceHashes);
    const fabricated = {
      schemaVersion: 1,
      jobId: fixture.jobId,
      runId: fixture.runId,
      iteration: 3,
      status: "passed",
      totalScore: 99,
      threshold: 98,
      semanticGate: true,
      blockers: [],
      metrics: { evaluationPhase: "post-publication-revision", revisionEvaluationEligible: true }
    };
    await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, fabricated)).rejects.toThrow(/evaluateJob/);
    const evaluated = await evaluateJob(fixture.jobId, {
      iteration: 3,
      runId: fixture.runId,
      persist: false,
      committee: review,
      allowPostPublicationRevision: true,
      revisionContext,
      reuseExistingAnalysis: true,
      reuseEvidenceFrames: true
    });
    await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, structuredClone(evaluated))).rejects.toThrow(/evaluateJob/);
    const revision = await sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(baseManifestBefore);
    expect(revision.manifest).toMatchObject({ schemaVersion: 2, sealStatus: "sealed", effectiveStatus: "needs-improvement", immutableBase: true });
    expect((await readJob(fixture.jobId)).qualitySummary).not.toHaveProperty("revisionId");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const qualityResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality`, token));
    expect(qualityResponse.status).toBe(200);
    expect(await qualityResponse.json()).toMatchObject({ status: "needs-improvement", semanticGate: false, revisionId: revision.revisionId });
    const reconciled = await readJob(fixture.jobId);
    expect(reconciled.qualitySummary).toMatchObject({ revisionId: revision.revisionId, revisionSequence: 1 });
    expect(reconciled.artifacts.filter((artifact) => artifact.name.startsWith(`runs/${fixture.runId}/revisions/`))).toHaveLength(4);
    const historyResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality/history`, token));
    const history = await historyResponse.json();
    expect(history.iterations.at(-1)).toMatchObject({ revisionId: revision.revisionId, status: "needs-improvement" });

    const manifestArtifactResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(revision.manifestPath)}`, token));
    expect(manifestArtifactResponse.status).toBe(200);
    reconciled.provider = "gemini-browser";
    reconciled.runStatus = "verified";
    reconciled.artifacts.push({ ...revision.artifacts.find((artifact) => artifact.name === revision.manifestPath) });
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(reconciled, null, 2));
    const repairedResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(repairedResponse.status).toBe(200);
    const repaired = await readJob(fixture.jobId);
    expect(repaired.provider).toBe("local");
    expect(repaired.runStatus).toBe("needs-improvement");
    expect(repaired.artifacts.filter((artifact) => artifact.name === revision.manifestPath)).toHaveLength(1);
  });

  test("isolates a corrupt historical job during startup and list reconciliation", async () => {
    const invalid = await createSealedNeedsImprovementFixture();
    const valid = await createSealedNeedsImprovementFixture();
    await mkdir(join(invalid.runDir, "revisions"), { recursive: true });
    await mkdir(join(valid.runDir, "revisions"), { recursive: true });

    const invalidJob = await readJob(invalid.jobId);
    invalidJob.createdAt = "2026-08-12T02:00:00.000Z";
    invalidJob.updatedAt = invalidJob.createdAt;
    await writeFile(join(invalid.jobDir, "job.json"), JSON.stringify(invalidJob, null, 2));
    const finalReceipt = invalid.manifest.immutableArtifacts.find((artifact) => artifact.name === "final.mp4");
    await writeFile(join(invalid.jobDir, finalReceipt.path), "tampered-historical-video");
    const invalidJobBefore = await readFile(join(invalid.jobDir, "job.json"), "utf8");

    const validJob = await readJob(valid.jobId);
    validJob.createdAt = "2026-08-12T01:00:00.000Z";
    validJob.updatedAt = validJob.createdAt;
    validJob.provider = "gemini-browser";
    validJob.runStatus = "verified";
    validJob.qualitySummary = { ...validJob.qualitySummary, totalScore: 1 };
    await writeFile(join(valid.jobDir, "job.json"), JSON.stringify(validJob, null, 2));

    let server;
    try {
      const token = createSessionToken();
      server = await startStudioServer({
        port: 0,
        token,
        tokenPath: join(valid.jobDir, ".studio-token")
      });
      const startupRepaired = await readJob(valid.jobId);
      expect(startupRepaired.provider).toBe("local");
      expect(startupRepaired.runStatus).toBe("needs-improvement");
      expect(startupRepaired.qualitySummary.totalScore).toBe(95);
      expect(await readFile(join(invalid.jobDir, "job.json"), "utf8")).toBe(invalidJobBefore);

      const response = await fetch(`http://127.0.0.1:${server.port}/api/jobs`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const payload = await response.json();
      expect(response.status).toBe(200);
      const visibleInvalid = payload.jobs.find((job) => job.id === invalid.jobId);
      const visibleValid = payload.jobs.find((job) => job.id === valid.jobId);
      expect(visibleInvalid.integrity).toEqual({
        status: "blocked",
        code: "sealed-run-integrity-failure",
        message: "봉인된 실행의 무결성 검증에 실패해 자동 복구와 품질 판정을 차단했습니다.",
        mutableJobPreserved: true
      });
      expect(visibleValid).not.toHaveProperty("integrity");
      expect(await readFile(join(invalid.jobDir, "job.json"), "utf8")).toBe(invalidJobBefore);
    } finally {
      server?.stop(true);
    }
  });
});
