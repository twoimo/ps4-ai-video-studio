import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
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
  ARTIFACT_STREAM_CHUNK_BYTES,
  IMMUTABLE_ARTIFACT_POLICY,
  MAX_CONCURRENT_STALE_JOB_RECOVERIES,
  acquireJobLease,
  announceStudioServer,
  createVerifiedArtifactStream,
  createSessionToken,
  createStudioRequestHandler,
  immutableArtifactReadLimit,
  projectQualityTruthfulness,
  readVerifiedArtifactRange,
  redactJobResponse,
  recoverStaleJobs,
  recoverSemanticRevalidationTransactions,
  releaseJobLease,
  sealQualityRevision,
  startJob,
  startStudioServer,
  verifyImmutableArtifactDeclarations,
  verifyFileReceipt
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
      authorization: `Bearer ${token}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function getRequest(path, token, headers = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers }
  });
}

function jsonBytesWithInvalidUtf8(value, marker) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  const markerOffset = bytes.indexOf(Buffer.from(marker));
  if (markerOffset < 0) throw new Error("invalid UTF-8 fixture marker를 찾지 못했습니다.");
  bytes[markerOffset] = 0x80;
  return bytes;
}

async function createSealedNeedsImprovementFixture(options = {}) {
  const jobId = `quality-api-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  createdJobs.push(jobId);
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const completed = options.completed === true;
  const sealedStatus = completed ? "completed" : "needs-improvement";
  const sealedRunStatus = completed ? "verified" : "needs-improvement";
  const baseQuality = {
    schemaVersion: 1,
    jobId,
    runId,
    iteration: 2,
    status: completed ? "passed" : "needs-improvement",
    totalScore: completed ? 100 : 95,
    threshold: 98,
    technicalEvidenceGate: completed,
    semanticGate: completed,
    blockers: completed ? [] : ["committee missing"],
    metrics: {
      provider: "local",
      providerProof: options.truthfulLocal === true ? false : true,
      ...(options.truthfulLocal === true ? { providerEvidenceEligible: false } : {}),
      technicalEvidenceGate: completed,
      contentSemanticsVerified: completed,
      evidenceHashes: { "final.mp4": HASH_A, "quality/frame-01.jpg": HASH_B }
    }
  };
  const qualitySummaryFields = ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"];
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
  if (options.includeHistoricalIteration === true) {
    const iterationNames = options.historicalIterationNames || [options.historicalIterationName || "quality/iteration-2.json"];
    for (const iterationName of iterationNames) await writeArtifact(iterationName, JSON.stringify(baseQuality, null, 2));
  }
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
  const providerDecision = { requested: "local", selected: "local", fallbackUsed: false, policy: "local-upload-edit" };
  const terminalEvents = [];
  if (options.includeProviderDecisionEvent === true) terminalEvents.push({
    type: "provider_decision",
    jobId,
    runId,
    ...providerDecision,
    decisionHash: canonicalJsonHash(providerDecision)
  });
  terminalEvents.push({
    type: "quality_finalized",
    jobId,
    runId,
    status: sealedRunStatus,
    qualityHash: qualityReceipt.sha256,
    qualitySummary
  });
  await writeArtifact(`runs/${runId}/events.jsonl`, `${terminalEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const manifest = {
    schemaVersion: 1,
    jobId,
    runId,
    status: sealedStatus,
    runStatus: sealedRunStatus,
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
    status: sealedStatus,
    runStatus: sealedRunStatus,
    stage: completed ? "완료" : "개선 필요",
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
  test("announces only the exact custom Studio token used by the server", () => {
    const customToken = `custom/${"a".repeat(32)}?scope=temp`;
    const logged = [];
    const originalConsoleLog = console.log;
    console.log = (...values) => logged.push(values.join(" "));
    try {
      announceStudioServer({ port: 43123 }, {
        hostname: "127.0.0.1",
        token: customToken
      });
    } finally {
      console.log = originalConsoleLog;
    }

    expect(logged).toEqual([
      `PS4 AI Video Studio: http://127.0.0.1:43123/#token=${encodeURIComponent(customToken)}`
    ]);
    expect(logged[0]).not.toContain("custom/");
  });

  test("bounds stale-job recovery concurrency and preserves input ordering", async () => {
    const jobs = Array.from({ length: 13 }, (_, index) => ({
      id: `bounded-recovery-${String(index).padStart(2, "0")}`,
      status: "running",
      index
    }));
    let active = 0;
    let maximumActive = 0;
    const recoveryErrors = [];
    const recovered = await recoverStaleJobs(jobs, new Set(), new Set(), {
      recoverJobFn: async (job) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await Bun.sleep((jobs.length - job.index) % 5 + 1);
          if (job.index === 6) throw new Error("injected isolated recovery failure");
          return { ...job, status: "failed", recoveredIndex: job.index };
        } finally {
          active -= 1;
        }
      },
      onRecoveryError: (job, error) => recoveryErrors.push([job.index, error.message])
    });

    expect(maximumActive).toBe(MAX_CONCURRENT_STALE_JOB_RECOVERIES);
    expect(active).toBe(0);
    expect(recovered.map((job) => job.id)).toEqual(jobs.map((job) => job.id));
    expect(recovered.filter((job) => job.recoveredIndex !== undefined).map((job) => job.recoveredIndex)).toEqual(
      jobs.filter((job) => job.index !== 6).map((job) => job.index)
    );
    expect(recovered[6].integrity).toMatchObject({ status: "blocked", code: "stale-job-recovery-failure" });
    expect(recoveryErrors).toEqual([[6, "injected isolated recovery failure"]]);
  });

  test("downgrades every public view of a completed legacy local seal without changing sealed bytes", async () => {
    const fixture = await createSealedNeedsImprovementFixture({
      completed: true,
      includeHistoricalIteration: true,
      historicalIterationNames: ["quality/iteration-02.json", "quality/iteration-2.json"]
    });
    const qualityPath = join(fixture.runDir, "artifacts", "quality.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    const sealedQualityBefore = await readFile(qualityPath, "utf8");
    const sealedManifestBefore = await readFile(manifestPath, "utf8");
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const expectedPublicState = {
      status: "needs-improvement",
      runStatus: "needs-improvement",
      stage: "개선 필요",
      technicalEvidenceGate: false,
      semanticGate: false,
      contentSemanticsVerified: false,
      providerProof: false,
      providerEvidenceEligible: false,
      legacyProviderProofSemantics: "local-input-binding-v1",
      legacyRawArtifactAccessBlocked: true,
      qualitySummary: {
        status: "needs-improvement",
        technicalEvidenceGate: false,
        semanticGate: false,
        contentSemanticsVerified: false,
        providerProof: false,
        providerEvidenceEligible: false
      }
    };

    const listResponse = await handler(getRequest("/api/jobs", token));
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).jobs.find((job) => job.id === fixture.jobId)).toMatchObject(expectedPublicState);

    const jobResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(jobResponse.status).toBe(200);
    expect(await jobResponse.json()).toMatchObject(expectedPublicState);

    const storedWithUntrustedImportMarker = { ...(await readJob(fixture.jobId)), localClipImport: { status: "ready" } };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(storedWithUntrustedImportMarker, null, 2));
    const markedJobResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(markedJobResponse.status).toBe(200);
    expect(await markedJobResponse.json()).toMatchObject(expectedPublicState);

    const expectedPublicQuality = {
      status: "needs-improvement",
      technicalEvidenceGate: false,
      semanticGate: false,
      legacyProviderProofSemantics: "local-input-binding-v1",
      legacyRawArtifactAccessBlocked: true,
      metrics: {
        providerProof: false,
        providerEvidenceEligible: false,
        technicalEvidenceGate: false,
        contentSemanticsVerified: false
      }
    };
    const qualityResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality`, token));
    expect(qualityResponse.status).toBe(200);
    expect(await qualityResponse.json()).toMatchObject(expectedPublicQuality);
    const historyResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality/history`, token));
    expect(historyResponse.status).toBe(200);
    const projectedHistory = (await historyResponse.json()).iterations;
    expect(projectedHistory).toHaveLength(2);
    expect(projectedHistory.every((entry) => (
      entry.technicalEvidenceGate === false
      && entry.metrics?.providerProof === false
      && entry.metrics?.providerEvidenceEligible === false
    ))).toBeTrue();

    const rawLegacyNames = [
      `runs/${fixture.runId}/manifest.json`,
      "quality.json",
      `runs/${fixture.runId}/artifacts/quality.json`,
      "quality/iteration-02.json",
      `runs/${fixture.runId}/artifacts/quality__iteration-02.json`,
      "quality/iteration-2.json",
      `runs/${fixture.runId}/artifacts/quality__iteration-2.json`
    ];
    const rawPaths = [manifestPath, ...fixture.manifest.immutableArtifacts
      .filter((entry) => entry.name === "quality.json" || /^quality\/iteration-\d+\.json$/u.test(entry.name))
      .map((entry) => join(fixture.jobDir, entry.path))];
    const sealedSnapshots = new Map(await Promise.all(rawPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      mtimeNs: (await stat(path, { bigint: true })).mtimeNs
    }])));
    for (let index = 0; index < rawLegacyNames.length; index += 1) {
      const name = rawLegacyNames[index];
      const encoded = index % 2 === 0 ? encodeURIComponent(name) : name;
      for (const range of [null, "bytes=0-"]) {
        const response = await handler(getRequest(
          `/api/jobs/${fixture.jobId}/artifacts/${encoded}`,
          token,
          range ? { range } : {}
        ));
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain(`/api/jobs/${fixture.jobId}/quality`);
      }
    }
    for (const [path, snapshot] of sealedSnapshots) {
      expect(await readFile(path)).toEqual(snapshot.bytes);
      expect((await stat(path, { bigint: true })).mtimeNs).toBe(snapshot.mtimeNs);
    }
    const undeclaredAlias = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/quality/latest.json`, token));
    expect(undeclaredAlias.status).toBe(404);
    const undeclaredImmutable = await handler(getRequest(
      `/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(`runs/${fixture.runId}/artifacts/quality__latest.json`)}`,
      token
    ));
    expect(undeclaredImmutable.status).toBe(404);
    const nonQuality = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token));
    expect(nonQuality.status).toBe(200);
    expect(await nonQuality.text()).toBe("fake-video");

    expect((await readJob(fixture.jobId)).status).toBe("completed");
    expect((await readJob(fixture.jobId)).runStatus).toBe("verified");
    expect(await readFile(qualityPath, "utf8")).toBe(sealedQualityBefore);
    expect(await readFile(manifestPath, "utf8")).toBe(sealedManifestBefore);
  });

  test("projects historical local provider-proof semantics truthfully without mutating sealed evidence", async () => {
    const fixture = await createSealedNeedsImprovementFixture({ includeHistoricalIteration: true });
    const qualityPath = join(fixture.runDir, "artifacts", "quality.json");
    const sealedBefore = await readFile(qualityPath, "utf8");
    const projected = projectQualityTruthfulness(fixture.baseQuality);

    expect(projected).toMatchObject({
      status: "needs-improvement",
      technicalEvidenceGate: false,
      semanticGate: false,
      legacyProviderProofSemantics: "local-input-binding-v1",
      metrics: {
        provider: "local",
        providerProof: false,
        providerEvidenceEligible: false,
        technicalEvidenceGate: false,
        legacyProviderProofSemantics: "local-input-binding-v1"
      }
    });
    expect(fixture.baseQuality.metrics.providerProof).toBe(true);
    expect(fixture.baseQuality.metrics).not.toHaveProperty("providerEvidenceEligible");
    expect(await readFile(qualityPath, "utf8")).toBe(sealedBefore);

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const qualityResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality`, token));
    expect(qualityResponse.status).toBe(200);
    expect(await qualityResponse.json()).toMatchObject({ legacyProviderProofSemantics: "local-input-binding-v1", technicalEvidenceGate: false, metrics: { providerProof: false, providerEvidenceEligible: false } });
    const historyResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality/history`, token));
    expect(historyResponse.status).toBe(200);
    expect((await historyResponse.json()).iterations[0]).toMatchObject({ legacyProviderProofSemantics: "local-input-binding-v1", technicalEvidenceGate: false, metrics: { providerProof: false, providerEvidenceEligible: false } });
    expect(await readFile(qualityPath, "utf8")).toBe(sealedBefore);
  });

  test("keeps truthful current local quality and non-quality evidence directly available", async () => {
    const fixture = await createSealedNeedsImprovementFixture({ truthfulLocal: true });
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const qualityDeclaration = fixture.manifest.immutableArtifacts.find((entry) => entry.name === "quality.json");
    for (const name of [
      "quality.json",
      qualityDeclaration.path,
      `runs/${fixture.runId}/manifest.json`,
      "final.mp4"
    ]) {
      const response = await handler(getRequest(
        `/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(name)}`,
        token
      ));
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const rawQuality = await (await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/quality.json`, token))).json();
    expect(rawQuality).toMatchObject({
      technicalEvidenceGate: false,
      semanticGate: false,
      metrics: { providerProof: false, providerEvidenceEligible: false }
    });
  });

  test("uses the kernel lease instead of fresh or future timestamps for live admission and crash recovery", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const futureTimestamp = "2999-01-01T00:00:00.000Z";
    const runningManifest = {
      ...fixture.manifest,
      status: "running",
      runStatus: "running",
      ledgerErrors: []
    };
    const runningJob = {
      ...fixture.job,
      provider: "gemini-browser",
      status: "running",
      runStatus: "running",
      runStartedAt: futureTimestamp,
      updatedAt: futureTimestamp
    };
    const jobPath = join(fixture.jobDir, "job.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    await writeFile(jobPath, JSON.stringify(runningJob, null, 2));
    await writeFile(manifestPath, JSON.stringify(runningManifest, null, 2));
    const jobBytesBefore = await readFile(jobPath);
    const manifestBytesBefore = await readFile(manifestPath);
    const lease = await acquireJobLease(fixture.jobId);
    expect(lease).not.toBeNull();

    let startCalls = 0;
    let statusAtRetry = null;
    const token = createSessionToken();
    const handler = createStudioRequestHandler({
      token,
      startJobFn: async () => {
        startCalls += 1;
        statusAtRetry = (await readJob(fixture.jobId)).status;
        return true;
      }
    });
    try {
      let multipartParses = 0;
      const clipRequest = postRequest(`/api/jobs/${fixture.jobId}/clips`, token, {});
      clipRequest.headers.set("content-type", "multipart/form-data; boundary=live-lease-boundary");
      Object.defineProperty(clipRequest, "formData", {
        configurable: true,
        value: async () => {
          multipartParses += 1;
          return new FormData();
        }
      });
      const busyMutations = [
        postRequest(`/api/jobs/${fixture.jobId}/run`, token, {}),
        postRequest(`/api/jobs/${fixture.jobId}/semantic/revalidate`, token, { sourceRunId: fixture.runId }),
        postRequest(`/api/jobs/${fixture.jobId}/quality/evaluate`, token, { runId: fixture.runId }),
        clipRequest
      ];
      for (const mutation of busyMutations) {
        const busy = await handler(mutation);
        expect(busy.status).toBe(409);
        expect(await readFile(jobPath)).toEqual(jobBytesBefore);
        expect(await readFile(manifestPath)).toEqual(manifestBytesBefore);
      }
      expect(startCalls).toBe(0);
      expect(multipartParses).toBe(0);
    } finally {
      await releaseJobLease(lease);
    }

    const retry = await handler(postRequest(`/api/jobs/${fixture.jobId}/run`, token, {}));
    expect(retry.status).toBe(200);
    expect(startCalls).toBe(1);
    expect(statusAtRetry).toBe("failed");
    expect((await readJob(fixture.jobId)).status).toBe("failed");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      status: "failed",
      runStatus: "failed",
      recovery: { type: "stale-lease" }
    });
  });

  test("rechecks and recovers the exact running pointer after startJob owns the lease", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    await writeFile(join(fixture.runDir, "manifest.json"), JSON.stringify({
      ...fixture.manifest,
      status: "running",
      runStatus: "running",
      ledgerErrors: []
    }, null, 2));
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2999-01-01T00:00:00.000Z",
      updatedAt: "2999-01-01T00:00:00.000Z"
    }, null, 2));
    let runnerStatus = null;
    const started = await startJob(fixture.jobId, {
      runner: async (_jobId, options) => {
        runnerStatus = (await readJob(fixture.jobId)).status;
        await options.onRunCreated({ runId: `run-${randomUUID()}` });
      }
    });

    expect(started).toBe(true);
    expect(runnerStatus).toBe("failed");
    expect((await readJob(fixture.jobId)).status).toBe("failed");
  });

  test("rehydrates an exact terminal manifest immediately despite a future running timestamp", async () => {
    const fixture = await createSealedNeedsImprovementFixture({ includeProviderDecisionEvent: true });
    const manifestBytesBefore = await readFile(join(fixture.runDir, "manifest.json"));
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      status: "running",
      runStatus: "running",
      stage: "검증 중",
      progress: 95,
      runStartedAt: "2999-01-01T00:00:00.000Z",
      updatedAt: "2999-01-01T00:00:00.000Z"
    }, null, 2));

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);

    expect(response.status).toBe(200);
    expect(visible).toMatchObject({ id: fixture.jobId, status: "needs-improvement", runStatus: "needs-improvement" });
    expect(await readJob(fixture.jobId)).toMatchObject({ status: "needs-improvement", runStatus: "needs-improvement" });
    expect(await readFile(join(fixture.runDir, "manifest.json"))).toEqual(manifestBytesBefore);
  });

  test("preserves a sealed terminal run when stale-pointer rehydration detects immutable corruption", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const staleJob = {
      ...fixture.job,
      status: "running",
      runStatus: "running",
      stage: "검증 중",
      progress: 95,
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(staleJob, null, 2));
    const declaration = fixture.manifest.immutableArtifacts.find((entry) => entry.name === "final.mp4");
    await writeFile(join(fixture.jobDir, declaration.path), "tampered-sealed-video");
    const jobBytesBefore = await readFile(join(fixture.jobDir, "job.json"), "utf8");
    const manifestBytesBefore = await readFile(join(fixture.runDir, "manifest.json"), "utf8");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const payload = await response.json();
    const visible = payload.jobs.find((job) => job.id === fixture.jobId);

    expect(response.status).toBe(200);
    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true });
    expect(await readFile(join(fixture.jobDir, "job.json"), "utf8")).toBe(jobBytesBefore);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(manifestBytesBefore);
  });

  test("never overwrites an unreadable existing manifest while recovering a stale running pointer", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const staleJob = {
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(staleJob, null, 2));
    await writeFile(join(fixture.runDir, "manifest.json"), "{corrupt-existing-manifest");
    const jobBytesBefore = await readFile(join(fixture.jobDir, "job.json"), "utf8");
    const manifestBytesBefore = await readFile(join(fixture.runDir, "manifest.json"), "utf8");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const payload = await response.json();
    const visible = payload.jobs.find((job) => job.id === fixture.jobId);

    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true });
    expect(await readFile(join(fixture.jobDir, "job.json"), "utf8")).toBe(jobBytesBefore);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(manifestBytesBefore);
  });

  test("rejects invalid UTF-8 in a structurally recoverable stale manifest without mutating durable state", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const jobPath = join(fixture.jobDir, "job.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    const eventsPath = join(fixture.runDir, "events.jsonl");
    const lockPath = join(fixture.jobDir, ".run.lock");
    const staleJob = {
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    };
    const unverifiedTopic = "INVALID_UTF8_STALE_TOPIC";
    const staleManifestBytes = jsonBytesWithInvalidUtf8({
      schemaVersion: 1,
      jobId: fixture.jobId,
      runId: fixture.runId,
      status: "running",
      runStatus: "running",
      ledgerErrors: [],
      request: { topic: unverifiedTopic }
    }, unverifiedTopic);
    expect(JSON.parse(staleManifestBytes.toString("utf8"))).toMatchObject({
      schemaVersion: 1,
      jobId: fixture.jobId,
      runId: fixture.runId,
      status: "running",
      runStatus: "running",
      ledgerErrors: []
    });
    await writeFile(jobPath, JSON.stringify(staleJob, null, 2));
    await writeFile(manifestPath, staleManifestBytes);
    await writeFile(eventsPath, `${JSON.stringify({ type: "run_started", jobId: fixture.jobId, runId: fixture.runId })}\n`);
    // Pre-create the permanent flock inode so lease admission itself cannot
    // account for a parent-directory metadata change in this recovery probe.
    await writeFile(lockPath, Buffer.alloc(0), { mode: 0o600 });

    const artifactDir = join(fixture.runDir, "artifacts");
    const artifactPaths = (await readdir(artifactDir)).map((name) => join(artifactDir, name));
    const protectedPaths = [jobPath, manifestPath, eventsPath, lockPath, ...artifactPaths];
    const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));
    const protectedDirectories = [
      fixture.jobDir,
      join(fixture.jobDir, "runs"),
      fixture.runDir,
      artifactDir
    ];
    const directoryEntriesBefore = new Map(await Promise.all(protectedDirectories.map(async (path) => [path, await readdir(path)])));
    const directoryStatsBefore = new Map(await Promise.all(protectedDirectories.map(async (path) => [path, await stat(path, { bigint: true })])));

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);

    expect(response.status).toBe(200);
    expect(visible).toMatchObject({
      id: fixture.jobId,
      integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
    });
    for (const path of protectedPaths) {
      const snapshot = before.get(path);
      const after = await stat(path, { bigint: true });
      expect(await readFile(path)).toEqual(snapshot.bytes);
      expect(after.ino).toBe(snapshot.stat.ino);
      expect(after.size).toBe(snapshot.stat.size);
      expect(after.mtimeNs).toBe(snapshot.stat.mtimeNs);
      expect(after.ctimeNs).toBe(snapshot.stat.ctimeNs);
    }
    for (const path of protectedDirectories) {
      const snapshot = directoryStatsBefore.get(path);
      const after = await stat(path, { bigint: true });
      expect(await readdir(path)).toEqual(directoryEntriesBefore.get(path));
      expect(after.ino).toBe(snapshot.ino);
      expect(after.mtimeNs).toBe(snapshot.mtimeNs);
      expect(after.ctimeNs).toBe(snapshot.ctimeNs);
    }
  });

  test("rejects terminal local clip replacement before parsing multipart bytes when the sealed run is corrupt", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const jobPath = join(fixture.jobDir, "job.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    await writeFile(manifestPath, "{corrupt-existing-manifest");
    const jobBytesBefore = await readFile(jobPath);
    const manifestBytesBefore = await readFile(manifestPath);
    const entriesBefore = await readdir(fixture.jobDir);
    let multipartParses = 0;
    let probeCalls = 0;
    const token = createSessionToken();
    const handler = createStudioRequestHandler({
      token,
      localClipUploadOptions: {
        probeClipFn: async () => {
          probeCalls += 1;
          return { durationSec: 5, width: 1080, height: 1920, codec: "h264", formatNames: ["mp4"] };
        }
      }
    });
    const request = postRequest(`/api/jobs/${fixture.jobId}/clips`, token, {});
    request.headers.set("content-type", "multipart/form-data; boundary=test-boundary");
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        multipartParses += 1;
        const form = new FormData();
        form.append("expectedRunId", fixture.runId);
        form.append("files", new File(["must-not-be-read"], "replacement.mp4", { type: "video/mp4" }));
        return form;
      }
    });

    const response = await handler(request);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("기존 봉인 실행의 무결성");
    expect(multipartParses).toBe(0);
    expect(probeCalls).toBe(0);
    expect(await readFile(jobPath)).toEqual(jobBytesBefore);
    expect(await readFile(manifestPath)).toEqual(manifestBytesBefore);
    const entriesAfter = await readdir(fixture.jobDir);
    expect(entriesAfter.filter((name) => name !== ".run.lock")).toEqual(entriesBefore);
    expect(entriesAfter.some((name) => name.startsWith(".clips-upload-"))).toBe(false);
  });

  test("binds terminal clip replacement to the exact run the user confirmed", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const jobPath = join(fixture.jobDir, "job.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    let probeCalls = 0;
    const token = createSessionToken();
    const handler = createStudioRequestHandler({
      token,
      localClipUploadOptions: {
        probeClipFn: async () => {
          probeCalls += 1;
          return { durationSec: 5, width: 1080, height: 1920, codec: "h264", formatNames: ["mp4"] };
        }
      }
    });
    // Model the state the user actually confirmed: the UI first loaded the
    // current terminal pointer, including any legitimate pointer rehydration.
    const currentResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(currentResponse.status).toBe(200);
    expect((await currentResponse.json()).runId).toBe(fixture.runId);
    const jobBytesBefore = await readFile(jobPath);
    const manifestBytesBefore = await readFile(manifestPath);
    const jobMtimeBefore = (await stat(jobPath, { bigint: true })).mtimeNs;
    const manifestMtimeBefore = (await stat(manifestPath, { bigint: true })).mtimeNs;
    const upload = (expectedRunId, bytes) => {
      const form = new FormData();
      form.append("expectedRunId", expectedRunId);
      form.append("files", new File([bytes], "replacement.mp4", { type: "video/mp4" }));
      return handler(new Request(`http://127.0.0.1:3000/api/jobs/${fixture.jobId}/clips`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "same-origin"
        },
        body: form
      }));
    };

    const staleRunId = `run-${randomUUID()}`;
    const stale = await upload(staleRunId, "must-not-be-written");
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("확인한 실행 결과가 현재 작업 포인터와 달라");
    expect(probeCalls).toBe(0);
    expect(await readFile(jobPath)).toEqual(jobBytesBefore);
    expect(await readFile(manifestPath)).toEqual(manifestBytesBefore);
    expect((await stat(jobPath, { bigint: true })).mtimeNs).toBe(jobMtimeBefore);
    expect((await stat(manifestPath, { bigint: true })).mtimeNs).toBe(manifestMtimeBefore);
    expect((await readdir(fixture.jobDir)).some((name) => name.startsWith(".clips-upload-"))).toBe(false);
    expect(await stat(join(fixture.jobDir, "clips")).catch(() => null)).toBeNull();

    const exact = await upload(fixture.runId, "exact-confirmed-source");
    expect(exact.status).toBe(201);
    expect((await exact.json()).job).toMatchObject({ status: "queued", runId: null, localClipImport: { status: "ready", clipCount: 1 } });
    expect(probeCalls).toBe(1);
    expect(await readFile(join(fixture.jobDir, "clips", "01.mp4"), "utf8")).toBe("exact-confirmed-source");
    expect(await readFile(manifestPath)).toEqual(manifestBytesBefore);
  });

  test("admits only one multipart upload before parsing and releases the slot after failure", async () => {
    const first = await createSealedNeedsImprovementFixture();
    const second = await createSealedNeedsImprovementFixture();
    const token = createSessionToken();
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    let firstParses = 0;
    let secondParses = 0;
    const handler = createStudioRequestHandler({ token });
    const uploadRequest = (fixture, parse) => {
      const request = postRequest(`/api/jobs/${fixture.jobId}/clips`, token, {});
      request.headers.set("content-type", "multipart/form-data; boundary=test-boundary");
      Object.defineProperty(request, "formData", { configurable: true, value: parse });
      return request;
    };
    const firstPromise = handler(uploadRequest(first, async () => {
      firstParses += 1;
      await firstBlocked;
      throw new Error("intentional parse failure");
    }));
    while (firstParses === 0) await Bun.sleep(1);
    const rejected = await handler(uploadRequest(second, async () => {
      secondParses += 1;
      return new FormData();
    }));
    expect(rejected.status).toBe(429);
    expect(secondParses).toBe(0);
    releaseFirst();
    expect((await firstPromise).status).toBe(500);

    const retried = await handler(uploadRequest(second, async () => {
      secondParses += 1;
      return new FormData();
    }));
    expect(retried.status).toBe(409);
    expect(secondParses).toBe(1);
  });

  test("never rewrites a parseable manifest that is foreign or structurally invalid", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const staleJob = {
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(staleJob, null, 2));
    await writeFile(join(fixture.runDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: "foreign-job",
      runId: "foreign-run",
      status: "running",
      ledgerErrors: []
    }, null, 2));
    const jobBytesBefore = await readFile(join(fixture.jobDir, "job.json"), "utf8");
    const manifestBytesBefore = await readFile(join(fixture.runDir, "manifest.json"), "utf8");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);

    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true });
    expect(await readFile(join(fixture.jobDir, "job.json"), "utf8")).toBe(jobBytesBefore);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(manifestBytesBefore);
  });

  test("preserves the job pointer when an exact-bound stale manifest has an invalid recoverable shape", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const staleJob = {
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(staleJob, null, 2));
    await writeFile(join(fixture.runDir, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      jobId: fixture.jobId,
      runId: fixture.runId,
      status: "running",
      ledgerErrors: []
    }, null, 2));
    const jobBytesBefore = await readFile(join(fixture.jobDir, "job.json"), "utf8");
    const manifestBytesBefore = await readFile(join(fixture.runDir, "manifest.json"), "utf8");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);
    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true });
    expect(await readFile(join(fixture.jobDir, "job.json"), "utf8")).toBe(jobBytesBefore);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(manifestBytesBefore);
  });

  test("closes an exact finalizing crash as failed instead of quarantining it forever", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    await writeFile(join(fixture.runDir, "manifest.json"), JSON.stringify({
      ...fixture.manifest,
      status: "finalizing",
      runStatus: "needs-improvement",
      ledgerErrors: []
    }, null, 2));
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      status: "verifying",
      runStatus: "finalizing",
      runStartedAt: "2999-01-01T00:00:00.000Z",
      updatedAt: "2999-01-01T00:00:00.000Z"
    }, null, 2));

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);
    expect(visible.status).toBe("failed");
    expect(visible.runStatus).toBe("failed");
    expect(visible).not.toHaveProperty("integrity");
    expect((await readJob(fixture.jobId)).status).toBe("failed");
    expect(JSON.parse(await readFile(join(fixture.runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "failed",
      runStatus: "failed",
      recovery: { type: "stale-lease" }
    });
  });

  test("finishes an exact already-failed manifest pointer without rewriting its evidence", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const failedManifest = {
      ...fixture.manifest,
      status: "failed",
      runStatus: "failed",
      failedAt: "2000-01-01T00:00:00.000Z",
      recovery: { type: "pipeline-failure", reason: "durably failed before job pointer update" },
      ledgerErrors: []
    };
    const manifestBytes = `${JSON.stringify(failedManifest, null, 2)}\n`;
    await writeFile(join(fixture.runDir, "manifest.json"), manifestBytes);
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      status: "verifying",
      runStatus: "finalizing",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    }, null, 2));

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);
    expect(visible.status).toBe("failed");
    expect(visible.runStatus).toBe("failed");
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(manifestBytes);
  });

  test("marks terminal job pointers blocked when their manifest is absent, malformed, invalid UTF-8, or nonterminal", async () => {
    const fixtures = await Promise.all(Array.from({ length: 4 }, () => createSealedNeedsImprovementFixture()));
    for (const fixture of fixtures) {
      await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
        ...fixture.job,
        status: "completed",
        runStatus: "verified"
      }, null, 2));
    }
    await unlink(join(fixtures[0].runDir, "manifest.json"));
    await writeFile(join(fixtures[1].runDir, "manifest.json"), "{not-json");
    const invalidUtf8Topic = "INVALID_UTF8_TERMINAL_TOPIC";
    const invalidUtf8Bytes = jsonBytesWithInvalidUtf8({
      ...fixtures[2].manifest,
      request: { ...fixtures[2].manifest.request, topic: invalidUtf8Topic }
    }, invalidUtf8Topic);
    await writeFile(join(fixtures[2].runDir, "manifest.json"), invalidUtf8Bytes);
    await writeFile(join(fixtures[3].runDir, "manifest.json"), JSON.stringify({
      ...fixtures[3].manifest,
      status: "running",
      runStatus: "running"
    }, null, 2));

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    for (const fixture of fixtures) {
      const response = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: fixture.jobId,
        integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
      });
    }
    expect(await readFile(join(fixtures[2].runDir, "manifest.json"))).toEqual(invalidUtf8Bytes);
  });

  test("marks terminal job pointers blocked when runId is missing or unsafe", async () => {
    const fixtures = await Promise.all(Array.from({ length: 3 }, () => createSealedNeedsImprovementFixture()));
    const runIds = [null, "", "../outside-run"];
    for (const [index, fixture] of fixtures.entries()) {
      await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
        ...fixture.job,
        status: index === 0 ? "completed" : "needs-improvement",
        runStatus: index === 0 ? "verified" : "needs-improvement",
        runId: runIds[index]
      }, null, 2));
    }
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const payload = await response.json();
    for (const fixture of fixtures) {
      expect(payload.jobs.find((job) => job.id === fixture.jobId)).toMatchObject({
        integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
      });
    }
  });

  test("ignores a storage directory whose embedded job id is foreign without touching that target", async () => {
    const storageId = `storage-${randomUUID()}`;
    const foreignId = `foreign-${randomUUID()}`;
    const storageDir = join(JOBS_DIR, storageId);
    const foreignDir = join(JOBS_DIR, foreignId);
    createdJobs.push(storageId, foreignId);
    await mkdir(storageDir, { recursive: true });
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(storageDir, "job.json"), JSON.stringify({
      id: foreignId,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      status: "running",
      runStatus: "running",
      runId: `run-${randomUUID()}`
    }));
    const sentinelPath = join(foreignDir, "sentinel.txt");
    await writeFile(sentinelPath, "untouched");
    const sentinelBefore = await readFile(sentinelPath, "utf8");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(getRequest("/api/jobs", token));
    const payload = await response.json();
    expect(payload.jobs.some((job) => job.id === foreignId)).toBe(false);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelBefore);
    expect(await stat(join(foreignDir, ".run.lock")).catch((error) => error?.code)).toBe("ENOENT");
  });

  test("quarantines a partial same-id job record without breaking the valid job list", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const partialId = `partial-${randomUUID()}`;
    createdJobs.push(partialId);
    await mkdir(join(JOBS_DIR, partialId), { recursive: true });
    await writeFile(join(JOBS_DIR, partialId, "job.json"), JSON.stringify({ id: partialId }));

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.jobs.some((job) => job.id === fixture.jobId)).toBe(true);
    expect(payload.jobs.some((job) => job.id === partialId)).toBe(false);
  });

  test("rebuilds public artifact URLs from the exact job and artifact names", () => {
    const jobId = `projection-${randomUUID()}`;
    const name = "runs/run-1/artifacts/final.mp4";
    const token = createSessionToken();
    const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
    const projected = redactJobResponse({
      id: jobId,
      artifacts: [{ name, kind: "immutable-video", url: `/api/jobs/${jobId}/artifacts/clips__segment-1.mp4` }]
    }, {
      artifactCapabilityToken: token,
      artifactCapabilityOptions: { nowMs, ttlSeconds: 60 }
    });
    expect(projected.artifacts).toHaveLength(1);
    expect(projected.artifacts[0]).toMatchObject({ name, kind: "immutable-video" });
    const projectedUrl = new URL(projected.artifacts[0].url, "http://127.0.0.1:3000");
    expect(projectedUrl.pathname).toBe(`/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`);
    expect(projectedUrl.searchParams.get("exp")).toBe(String(Math.floor(nowMs / 1000) + 60));
    expect(projectedUrl.searchParams.get("cap")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("never exposes historical Gemini DOM labels or conversation errors through the job API projection", () => {
    const privateDomText = "Retry label from private Gemini conversation: 민감한 대화 본문";
    const projected = redactJobResponse({
      id: `projection-${randomUUID()}`,
      provider: "gemini-browser",
      status: "failed",
      runStatus: "failed",
      stage: "오류",
      message: privateDomText,
      error: `${privateDomText}\n at https://gemini.google.com/app/private`,
      warnings: [privateDomText],
      artifacts: []
    });
    const serialized = JSON.stringify(projected);
    expect(projected.error).toBe("generation-failed");
    expect(projected.providerFailureEvidence).toMatchObject({
      schemaVersion: 1,
      code: "gemini-provider-failure-redacted",
      reasonCode: "generation-failed",
      phase: "recovery"
    });
    expect(projected.providerFailureEvidence.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(serialized).not.toContain(privateDomText);
    expect(serialized).not.toContain("gemini.google.com/app/private");
    expect(serialized).not.toContain("Retry label");
  });

  test("reads only the requested sealed byte range after whole-file verification", async () => {
    const jobId = `range-${randomUUID()}`;
    createdJobs.push(jobId);
    const path = join(JOBS_DIR, jobId, "large.bin");
    await mkdir(join(JOBS_DIR, jobId), { recursive: true });
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
    await writeFile(path, bytes);
    const receipt = { bytes: bytes.byteLength, sha256: await hashFile(path) };
    const first = await readVerifiedArtifactRange(path, receipt, "bytes=17-17");
    expect(first.body.byteLength).toBe(1);
    expect(first.body[0]).toBe(0x61);
    expect(first.totalBytes).toBe(bytes.byteLength);
    const cached = await readVerifiedArtifactRange(path, receipt, "bytes=1024-1031");
    expect(cached.body.byteLength).toBe(8);
    expect(cached.range).toEqual({ start: 1024, end: 1031 });
  });

  test("bounds immutable JSON and event snapshots before whole-file allocation", () => {
    expect(immutableArtifactReadLimit({ json: true })).toBe(16 * 1024 * 1024);
    expect(immutableArtifactReadLimit({ json: false })).toBe(64 * 1024 * 1024);
    expect(immutableArtifactReadLimit()).toBe(16 * 1024 * 1024);
  });

  test("preflights every immutable declaration before opening files and bounds verifier fan-out", async () => {
    const job = { id: `artifact-policy-${randomUUID()}`, runId: `run-${randomUUID()}` };
    const declaration = (name, bytes = 1, sha256 = HASH_A) => ({
      name,
      path: `runs/${job.runId}/artifacts/${name.replaceAll("/", "__")}`,
      bytes,
      sha256
    });
    const valid = Array.from({ length: 12 }, (_unused, index) => declaration(`artifact-${index}.bin`));
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    expect(await verifyImmutableArtifactDeclarations(job, valid, {
      verifyFileReceiptFn: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(5);
        active -= 1;
        return true;
      }
    })).toBe(true);
    expect(calls).toBe(valid.length);
    expect(maximumActive).toBe(IMMUTABLE_ARTIFACT_POLICY.maximumConcurrentVerifications);
    expect(maximumActive).toBeLessThanOrEqual(4);

    const assertRejectedBeforeOpen = async (artifacts) => {
      let opened = 0;
      expect(await verifyImmutableArtifactDeclarations(job, artifacts, {
        verifyFileReceiptFn: async () => {
          opened += 1;
          return true;
        }
      })).toBe(false);
      expect(opened).toBe(0);
    };
    await assertRejectedBeforeOpen([
      ...valid,
      declaration("invalid-hash.bin", 1, "sha256:not-a-digest")
    ]);
    await assertRejectedBeforeOpen([
      declaration("duplicate-name.bin"),
      declaration("duplicate-name.bin")
    ]);
    await assertRejectedBeforeOpen([
      declaration("colliding/path.bin"),
      declaration("colliding__path.bin")
    ]);
    await assertRejectedBeforeOpen([
      declaration("../non-canonical.bin")
    ]);
    await assertRejectedBeforeOpen(Array.from(
      { length: 4_096 },
      (_unused, index) => declaration(`too-many-${index}.bin`)
    ));
    await assertRejectedBeforeOpen([
      declaration("oversized-file.bin", IMMUTABLE_ARTIFACT_POLICY.maximumFileBytes + 1)
    ]);
    await assertRejectedBeforeOpen([
      ...Array.from(
        { length: IMMUTABLE_ARTIFACT_POLICY.maximumAggregateBytes / IMMUTABLE_ARTIFACT_POLICY.maximumFileBytes },
        (_unused, index) => declaration(`aggregate-${index}.bin`, IMMUTABLE_ARTIFACT_POLICY.maximumFileBytes)
      ),
      declaration("aggregate-overflow.bin", 1)
    ]);
    await assertRejectedBeforeOpen([
      declaration("unsafe-integer.bin", Number.MAX_SAFE_INTEGER)
    ]);
  });

  test("globally bounds immutable verification across concurrent callers", async () => {
    const job = { id: `artifact-global-${randomUUID()}`, runId: `run-${randomUUID()}` };
    const declarations = (group) => Array.from({ length: 8 }, (_unused, index) => {
      const name = `artifact-${group}-${index}.bin`;
      return {
        name,
        path: `runs/${job.runId}/artifacts/${name}`,
        bytes: 1,
        sha256: HASH_A
      };
    });
    let active = 0;
    let maximumActive = 0;
    const verifyFileReceiptFn = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(10);
      active -= 1;
      return true;
    };

    const results = await Promise.all([0, 1, 2].map((group) => verifyImmutableArtifactDeclarations(
      job,
      declarations(group),
      { verifyFileReceiptFn }
    )));

    expect(results).toEqual([true, true, true]);
    expect(maximumActive).toBe(IMMUTABLE_ARTIFACT_POLICY.maximumConcurrentVerifications);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  test("fails closed on immutable verification timeout and queue overflow, then releases every permit", async () => {
    const job = { id: `artifact-admission-${randomUUID()}`, runId: `run-${randomUUID()}` };
    const declaration = (name) => ({
      name,
      path: `runs/${job.runId}/artifacts/${name}`,
      bytes: 1,
      sha256: HASH_A
    });
    let unblock;
    const blocked = new Promise((resolvePromise) => { unblock = resolvePromise; });
    let holderStarts = 0;
    let holdersReady;
    const allHoldersReady = new Promise((resolvePromise) => { holdersReady = resolvePromise; });
    const holders = verifyImmutableArtifactDeclarations(
      job,
      Array.from({ length: 4 }, (_unused, index) => declaration(`holder-${index}.bin`)),
      {
        verifyFileReceiptFn: async () => {
          holderStarts += 1;
          if (holderStarts === IMMUTABLE_ARTIFACT_POLICY.maximumConcurrentVerifications) holdersReady();
          await blocked;
          return true;
        }
      }
    );
    await allHoldersReady;

    let timedVerifierCalls = 0;
    expect(await verifyImmutableArtifactDeclarations(job, [declaration("timed.bin")], {
      verificationAdmissionTimeoutMs: 15,
      verifyFileReceiptFn: async () => {
        timedVerifierCalls += 1;
        return true;
      }
    })).toBe(false);
    expect(timedVerifierCalls).toBe(0);

    let queuedVerifierCalls = 0;
    const queued = Array.from(
      { length: IMMUTABLE_ARTIFACT_POLICY.maximumVerificationWaiters },
      (_unused, index) => verifyImmutableArtifactDeclarations(job, [declaration(`queued-${index}.bin`)], {
        verificationAdmissionTimeoutMs: 1_000,
        verifyFileReceiptFn: async () => {
          queuedVerifierCalls += 1;
          return true;
        }
      })
    );
    let overflowVerifierCalls = 0;
    expect(await verifyImmutableArtifactDeclarations(job, [declaration("overflow.bin")], {
      verificationAdmissionTimeoutMs: 1_000,
      verifyFileReceiptFn: async () => {
        overflowVerifierCalls += 1;
        return true;
      }
    })).toBe(false);
    expect(overflowVerifierCalls).toBe(0);

    unblock();
    expect(await holders).toBe(true);
    expect(await Promise.all(queued)).toEqual(Array(IMMUTABLE_ARTIFACT_POLICY.maximumVerificationWaiters).fill(true));
    expect(queuedVerifierCalls).toBe(IMMUTABLE_ARTIFACT_POLICY.maximumVerificationWaiters);

    expect(await verifyImmutableArtifactDeclarations(job, [declaration("throws.bin")], {
      verifyFileReceiptFn: async () => { throw new Error("injected verifier failure"); }
    })).toBe(false);
    let recoveredCalls = 0;
    expect(await verifyImmutableArtifactDeclarations(job, [declaration("recovered.bin")], {
      verificationAdmissionTimeoutMs: 50,
      verifyFileReceiptFn: async () => {
        recoveredCalls += 1;
        return true;
      }
    })).toBe(true);
    expect(recoveredCalls).toBe(1);
  });

  test("streams verified whole artifacts in fixed chunks and releases concurrency on cancel and completion", async () => {
    const jobId = `stream-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const path = join(jobDir, "large.bin");
    await mkdir(jobDir, { recursive: true });
    const bytes = Buffer.alloc(ARTIFACT_STREAM_CHUNK_BYTES * 3 + 17, 0x63);
    await writeFile(path, bytes);
    const receipt = { bytes: bytes.byteLength, sha256: await hashFile(path) };

    const first = await createVerifiedArtifactStream(path, receipt, null, { maximumActiveStreams: 1 });
    expect(first.contentLength).toBe(bytes.byteLength);
    const reader = first.stream.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value.byteLength).toBeLessThanOrEqual(ARTIFACT_STREAM_CHUNK_BYTES);
    await expect(createVerifiedArtifactStream(path, receipt, null, { maximumActiveStreams: 1 })).rejects.toMatchObject({ statusCode: 429 });
    await reader.cancel();

    const second = await createVerifiedArtifactStream(path, receipt, "bytes=1-2", { maximumActiveStreams: 1 });
    expect(Buffer.from(await new Response(second.stream).arrayBuffer())).toEqual(bytes.subarray(1, 3));
    const third = await createVerifiedArtifactStream(path, receipt, "bytes=3-3", { maximumActiveStreams: 1 });
    expect(Buffer.from(await new Response(third.stream).arrayBuffer())).toEqual(bytes.subarray(3, 4));
  });

  test("releases a verified artifact slot after idle timeout", async () => {
    const jobId = `stream-idle-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const path = join(jobDir, "idle.bin");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path, "idle-stream");
    const receipt = { bytes: 11, sha256: await hashFile(path) };
    const idle = await createVerifiedArtifactStream(path, receipt, null, { maximumActiveStreams: 1, idleTimeoutMs: 5 });
    await Bun.sleep(20);
    const replacement = await createVerifiedArtifactStream(path, receipt, null, { maximumActiveStreams: 1 });
    expect(await new Response(replacement.stream).text()).toBe("idle-stream");
    await expect(new Response(idle.stream).text()).rejects.toThrow("유휴 시간");
  });

  test("releases an artifact slot when ancestry pinning fails before open", async () => {
    const jobId = `stream-pin-release-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const path = join(jobDir, "valid.bin");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path, "valid");
    const receipt = { bytes: 5, sha256: await hashFile(path) };

    await expect(createVerifiedArtifactStream(
      join(tmpdir(), `outside-job-storage-${randomUUID()}`, "missing.bin"),
      receipt,
      null,
      { maximumActiveStreams: 1 }
    )).rejects.toThrow();

    const replacement = await createVerifiedArtifactStream(path, receipt, null, { maximumActiveStreams: 1 });
    expect(await new Response(replacement.stream).text()).toBe("valid");
  });

  test("rejects hardlinked artifact receipts without changing the external inode", async () => {
    const jobId = `hardlink-artifact-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-artifact-hardlink-"));
    const external = join(externalDir, "sentinel.bin");
    const path = join(jobDir, "artifact.bin");
    await mkdir(jobDir, { recursive: true });
    await writeFile(external, "external-sentinel");
    const before = await stat(external, { bigint: true });
    const beforeBytes = await readFile(external);
    await link(external, path);
    const receipt = { bytes: beforeBytes.byteLength, sha256: await hashFile(external) };
    expect(await verifyFileReceipt(path, receipt.bytes, receipt.sha256)).toBe(false);
    await expect(createVerifiedArtifactStream(path, receipt)).rejects.toThrow("exclusive regular file");
    const after = await stat(external, { bigint: true });
    expect(await readFile(external)).toEqual(beforeBytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await rm(externalDir, { recursive: true, force: true });
  });

  test("binds receipt hashing and cache publication to one fd and the unchanged path inode", async () => {
    const jobId = `receipt-race-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const path = join(jobDir, "artifact.bin");
    const replacement = join(jobDir, "replacement.bin");
    const preserved = join(jobDir, "preserved.bin");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path, "AAAA");
    await writeFile(replacement, "BBBB");
    const expectedHash = await hashFile(path);

    const verified = await verifyFileReceipt(path, 4, expectedHash, {
      afterInitialStat: async () => {
        await rename(path, preserved);
        await rename(replacement, path);
      }
    });

    expect(verified).toBe(false);
    expect(await readFile(path, "utf8")).toBe("BBBB");
    expect(await readFile(preserved, "utf8")).toBe("AAAA");
    expect(await verifyFileReceipt(path, 4, expectedHash)).toBe(false);
    await expect(readVerifiedArtifactRange(path, { bytes: 4, sha256: expectedHash })).rejects.toThrow("해시");
  });

  test("quarantines a stale job whose run directory is a symlink without writing outside the job", async () => {
    const jobId = `stale-symlink-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const externalDir = join(JOBS_DIR, `.external-stale-run-${randomUUID()}`);
    createdJobs.push(jobId, basename(externalDir));
    await mkdir(join(jobDir, "runs"), { recursive: true });
    await mkdir(externalDir, { recursive: true });
    const oldTimestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      id: jobId,
      topic: "stale symlink recovery fixture",
      provider: "local",
      status: "running",
      runStatus: "running",
      runId,
      runStartedAt: oldTimestamp,
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
      artifacts: []
    }, null, 2));
    const manifestPath = join(externalDir, "manifest.json");
    const eventsPath = join(externalDir, "events.jsonl");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      jobId,
      runId,
      status: "running",
      runStatus: "running",
      ledgerErrors: []
    }, null, 2));
    await writeFile(eventsPath, "external-sentinel\n");
    await symlink(externalDir, join(jobDir, "runs", runId));
    const before = {
      manifest: await readFile(manifestPath),
      events: await readFile(eventsPath),
      directoryMtime: (await stat(externalDir, { bigint: true })).mtimeNs
    };

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    expect(response.status).toBe(200);
    const visible = (await response.json()).jobs.find((job) => job.id === jobId);
    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure" });
    expect(await readFile(manifestPath)).toEqual(before.manifest);
    expect(await readFile(eventsPath)).toEqual(before.events);
    expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(before.directoryMtime);
  });

  test("rejects a terminal pointer whose sealed run ancestry is symlinked outside the job", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const externalDir = join(JOBS_DIR, `.external-terminal-run-${randomUUID()}`);
    await rename(fixture.runDir, externalDir);
    await symlink(externalDir, fixture.runDir);
    const manifestPath = join(externalDir, "manifest.json");
    const before = {
      manifest: await readFile(manifestPath),
      directoryMtime: (await stat(externalDir, { bigint: true })).mtimeNs
    };
    try {
      const token = createSessionToken();
      const response = await createStudioRequestHandler({ token })(getRequest(`/api/jobs/${fixture.jobId}`, token));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: fixture.jobId,
        integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
      });
      expect(await readFile(manifestPath)).toEqual(before.manifest);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(before.directoryMtime);
    } finally {
      await unlink(fixture.runDir).catch(() => {});
      await rename(externalDir, fixture.runDir).catch(() => {});
    }
  });

  test("rejects a symlinked quality revision root even when the external chain is empty", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const revisionsPath = join(fixture.runDir, "revisions");
    const externalDir = join(JOBS_DIR, `.external-revision-read-${randomUUID()}`);
    await mkdir(externalDir, { recursive: true });
    await symlink(externalDir, revisionsPath);
    const directoryMtime = (await stat(externalDir, { bigint: true })).mtimeNs;
    try {
      const token = createSessionToken();
      const response = await createStudioRequestHandler({ token })(getRequest(`/api/jobs/${fixture.jobId}`, token));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: fixture.jobId,
        integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
      });
      expect(await readdir(externalDir)).toEqual([]);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(directoryMtime);
    } finally {
      await unlink(revisionsPath).catch(() => {});
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("does not claim a lease after its flocked canonical inode is replaced", async () => {
    const jobId = `lease-race-${randomUUID()}`;
    createdJobs.push(jobId);
    const jobDir = join(JOBS_DIR, jobId);
    const lockPath = join(jobDir, ".run.lock");
    const preservedPath = join(jobDir, ".preserved-run.lock");
    const oldTimestamp = "2026-01-01T00:00:00.000Z";
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      id: jobId,
      topic: "lease replacement fixture",
      provider: "local",
      status: "failed",
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
      artifacts: []
    }, null, 2));
    const staleBytes = JSON.stringify({ token: "stale-token", pid: 99999999, createdAt: oldTimestamp });
    const replacementBytes = JSON.stringify({ token: "replacement-token", pid: process.pid, createdAt: new Date().toISOString() });
    await writeFile(lockPath, staleBytes);
    await utimes(lockPath, new Date(oldTimestamp), new Date(oldTimestamp));
    let swapped = false;

    const lease = await acquireJobLease(jobId, {
      beforeStaleLeaseReclaim: async () => {
        if (swapped) return;
        swapped = true;
        await rename(lockPath, preservedPath);
        await writeFile(lockPath, replacementBytes);
      }
    });

    expect(lease).toBeNull();
    expect(swapped).toBe(true);
    expect(await readFile(lockPath, "utf8")).toBe(replacementBytes);
    expect(await readFile(preservedPath, "utf8")).toBe(staleBytes);
    expect((await readdir(jobDir)).some((name) => name.startsWith(".run.lock.stale-"))).toBe(false);
  });

  test("does not follow a symlinked job ancestry when acquiring a lease", async () => {
    const jobId = `lease-parent-symlink-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-lease-external-"));
    createdJobs.push(jobId);
    await symlink(externalDir, jobDir);
    const before = (await stat(externalDir, { bigint: true })).mtimeNs;
    try {
      await expect(acquireJobLease(jobId)).rejects.toThrow();
      expect(await readdir(externalDir)).toEqual([]);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(before);
    } finally {
      await unlink(jobDir).catch(() => {});
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("does not truncate a hardlinked external sentinel presented as a lease", async () => {
    const jobId = `lease-hardlink-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const sentinelDir = await mkdtemp(join(JOBS_DIR, ".lease-sentinel-"));
    const sentinelPath = join(sentinelDir, "sentinel.txt");
    const sentinelBytes = "DO-NOT-CHANGE";
    createdJobs.push(jobId, basename(sentinelDir));
    await mkdir(jobDir);
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o640 });
    await link(sentinelPath, join(jobDir, ".run.lock"));
    const before = await stat(sentinelPath, { bigint: true });

    expect(await acquireJobLease(jobId)).toBeNull();
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelBytes);
    const after = await stat(sentinelPath, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  test("never overwrites a valid live legacy lease during flock protocol migration", async () => {
    const jobId = `lease-legacy-live-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const lockPath = join(jobDir, ".run.lock");
    createdJobs.push(jobId);
    await mkdir(jobDir);
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      id: jobId,
      topic: "legacy lease migration fixture",
      provider: "local",
      status: "failed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: []
    }, null, 2));
    const legacyBytes = JSON.stringify({ token: "legacy-live", pid: process.pid, createdAt: new Date().toISOString() });
    await writeFile(lockPath, legacyBytes);

    expect(await acquireJobLease(jobId)).toBeNull();
    expect(await readFile(lockPath, "utf8")).toBe(legacyBytes);
    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest(`/api/jobs/${jobId}`, token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      integrity: {
        status: "blocked",
        code: "legacy-job-lease-migration-required",
        mutableJobPreserved: true
      }
    });
  });

  test("leaves an old malformed legacy lease untouched for explicit operator migration", async () => {
    const jobId = `lease-legacy-partial-${randomUUID()}`;
    const jobDir = join(JOBS_DIR, jobId);
    const lockPath = join(jobDir, ".run.lock");
    createdJobs.push(jobId);
    await mkdir(jobDir);
    await writeFile(lockPath, "{partial-old-legacy");
    await utimes(lockPath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

    expect(await acquireJobLease(jobId)).toBeNull();
    expect(await readFile(lockPath, "utf8")).toBe("{partial-old-legacy");
  });

  test("rejects a hardlinked stale events ledger without changing the external sentinel", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    await writeFile(join(fixture.runDir, "manifest.json"), JSON.stringify({
      ...fixture.manifest,
      status: "running",
      runStatus: "running",
      ledgerErrors: []
    }, null, 2));
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      status: "running",
      runStatus: "running",
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    }, null, 2));
    const sentinelDir = await mkdtemp(join(JOBS_DIR, ".events-sentinel-"));
    const sentinelPath = join(sentinelDir, "sentinel.txt");
    createdJobs.push(basename(sentinelDir));
    await writeFile(sentinelPath, "EVENT-SENTINEL\n");
    await unlink(join(fixture.runDir, "events.jsonl")).catch(() => {});
    await link(sentinelPath, join(fixture.runDir, "events.jsonl"));
    const before = await stat(sentinelPath, { bigint: true });

    const token = createSessionToken();
    const response = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    const visible = (await response.json()).jobs.find((job) => job.id === fixture.jobId);
    expect(visible.integrity).toMatchObject({ status: "blocked", code: "sealed-run-integrity-failure" });
    expect(await readFile(sentinelPath, "utf8")).toBe("EVENT-SENTINEL\n");
    expect((await stat(sentinelPath, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });

  test("fails only jobs-root discovery globally and isolates every per-job semantic transaction error", async () => {
    const ioError = Object.assign(new Error("injected storage I/O failure"), { code: "EIO" });
    await expect(recoverSemanticRevalidationTransactions({ readdirFn: async () => { throw ioError; } })).rejects.toBe(ioError);

    const statFailureJobId = `transaction-${randomUUID()}`;
    const statFailureBlocked = await recoverSemanticRevalidationTransactions({
      readdirFn: async () => [{ name: statFailureJobId, isDirectory: () => true }],
      readTransactionFn: async () => { throw ioError; }
    });
    expect(statFailureBlocked.has(statFailureJobId)).toBeTrue();

    let nonRegularRecoveryCalls = 0;
    const nonRegularJobId = `transaction-${randomUUID()}`;
    const blockedJobIds = await recoverSemanticRevalidationTransactions({
      readdirFn: async () => [{ name: nonRegularJobId, isDirectory: () => true }],
      readTransactionFn: async () => { throw new Error("regular non-symlink file이 아닙니다."); },
      recoverFn: async () => { nonRegularRecoveryCalls += 1; }
    });
    expect(blockedJobIds.has(nonRegularJobId)).toBeTrue();
    expect(nonRegularRecoveryCalls).toBe(0);

    const damaged = await createSealedNeedsImprovementFixture();
    const symlinkDamaged = await createSealedNeedsImprovementFixture();
    const healthy = await createSealedNeedsImprovementFixture();
    await mkdir(join(damaged.jobDir, ".semantic-revalidation-transaction.json"));
    const symlinkTarget = join(symlinkDamaged.jobDir, "job.json");
    const symlinkTargetBefore = await readFile(symlinkTarget);
    await symlink(symlinkTarget, join(symlinkDamaged.jobDir, ".semantic-revalidation-transaction.json"));
    const token = createSessionToken();
    const listResponse = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()).jobs;
    expect(listed.find((job) => job.id === damaged.jobId)?.integrity).toMatchObject({
      status: "blocked",
      code: "semantic-transaction-integrity-failure",
      mutableJobPreserved: true
    });
    expect(listed.find((job) => job.id === symlinkDamaged.jobId)?.integrity?.code).toBe("semantic-transaction-integrity-failure");
    expect(await readFile(symlinkTarget)).toEqual(symlinkTargetBefore);
    expect(listed.find((job) => job.id === healthy.jobId)?.integrity).toBeUndefined();

    const fixture = await createSealedNeedsImprovementFixture();
    const journalPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    await writeFile(journalPath, "durable-unresolved-journal");
    const jobBefore = await readFile(join(fixture.jobDir, "job.json"));
    const recoveryFailureBlocked = await recoverSemanticRevalidationTransactions({
      readdirFn: async () => [{ name: fixture.jobId, isDirectory: () => true }],
      readTransactionFn: async () => ({ schemaVersion: 1, fixture: true }),
      recoverFn: async () => { throw ioError; }
    });
    expect(recoveryFailureBlocked.has(fixture.jobId)).toBeTrue();
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(jobBefore);
    expect(await readFile(journalPath, "utf8")).toBe("durable-unresolved-journal");

    const malformedListResponse = await createStudioRequestHandler({ token })(getRequest("/api/jobs", token));
    expect(malformedListResponse.status).toBe(200);
    const afterMalformed = (await malformedListResponse.json()).jobs;
    expect(afterMalformed.find((job) => job.id === fixture.jobId)?.integrity?.code).toBe("semantic-transaction-integrity-failure");
    expect(afterMalformed.find((job) => job.id === healthy.jobId)?.integrity).toBeUndefined();

    const leaseReleaseJobId = `transaction-${randomUUID()}`;
    const leaseReleaseBlocked = await recoverSemanticRevalidationTransactions({
      readdirFn: async () => [{ name: leaseReleaseJobId, isDirectory: () => true }],
      readTransactionFn: async () => ({ schemaVersion: 1, fixture: true }),
      acquireLeaseFn: async () => ({ lockPath: "/not-used", token: "fixture" }),
      recoverFn: async () => {},
      releaseLeaseFn: async () => { throw new Error("injected lease release failure"); }
    });
    expect(leaseReleaseBlocked.has(leaseReleaseJobId)).toBeTrue();
  });

  test("blocks every job mutation before bytes or runners change when the transaction marker is corrupt", async () => {
    const damaged = await createSealedNeedsImprovementFixture();
    const healthy = await createSealedNeedsImprovementFixture();
    const markerPath = join(damaged.jobDir, ".semantic-revalidation-transaction.json");
    const manifestPath = join(damaged.runDir, "manifest.json");
    await writeFile(markerPath, "{malformed-transaction-json");
    const before = {
      job: await readFile(join(damaged.jobDir, "job.json")),
      manifest: await readFile(manifestPath),
      marker: await readFile(markerPath)
    };
    let startCalls = 0;
    let semanticRunnerCalls = 0;
    const token = createSessionToken();
    const handler = createStudioRequestHandler({
      token,
      startJobFn: async () => { startCalls += 1; return true; },
      semanticRevalidationRunner: async () => { semanticRunnerCalls += 1; }
    });
    const mutations = [
      ["quality/evaluate", { runId: damaged.runId }],
      ["quality-loop", { runId: damaged.runId }],
      ["quality/revisions/prepare", { runId: damaged.runId }],
      ["quality/revisions/submit", { revisionContext: {}, review: {} }],
      ["semantic/revalidate", { sourceRunId: damaged.runId }],
      ["run", {}],
      ["clips", {}]
    ];
    for (const [suffix, body] of mutations) {
      const response = await handler(postRequest(`/api/jobs/${damaged.jobId}/${suffix}`, token, body));
      expect(response.status).toBe(409);
      expect(await readFile(join(damaged.jobDir, "job.json"))).toEqual(before.job);
      expect(await readFile(manifestPath)).toEqual(before.manifest);
      expect(await readFile(markerPath)).toEqual(before.marker);
    }
    expect(startCalls).toBe(0);
    expect(semanticRunnerCalls).toBe(0);

    const single = await handler(getRequest(`/api/jobs/${damaged.jobId}`, token));
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({
      id: damaged.jobId,
      integrity: { status: "blocked", code: "semantic-transaction-integrity-failure", mutableJobPreserved: true }
    });
    const list = await handler(getRequest("/api/jobs", token));
    expect(list.status).toBe(200);
    const jobs = (await list.json()).jobs;
    expect(jobs.find((job) => job.id === damaged.jobId)?.integrity?.code).toBe("semantic-transaction-integrity-failure");
    expect(jobs.find((job) => job.id === healthy.jobId)?.integrity).toBeUndefined();
    expect(await readFile(join(damaged.jobDir, "job.json"))).toEqual(before.job);
    expect(await readFile(manifestPath)).toEqual(before.manifest);
    expect(await readFile(markerPath)).toEqual(before.marker);
  });

  test("serves sealed mutable artifacts only while they match the immutable snapshot", async () => {
    const fixture = await createSealedNeedsImprovementFixture({ truthfulLocal: true });
    const immutableFinal = fixture.manifest.immutableArtifacts.find((entry) => entry.name === "final.mp4");
    expect(immutableFinal).toBeTruthy();
    const directRange = await readVerifiedArtifactRange(join(fixture.jobDir, immutableFinal.path), immutableFinal, "bytes=0-0");
    expect(directRange).toMatchObject({ totalBytes: immutableFinal.bytes, range: { start: 0, end: 0 } });
    expect(directRange.body.byteLength).toBe(1);
    await writeFile(join(fixture.jobDir, "final.mp4"), "fake-video");
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      artifacts: [
        { name: "final.mp4", kind: "video", url: `/api/jobs/${fixture.jobId}/artifacts/final.mp4` },
        { name: immutableFinal.path, kind: "immutable-video", bytes: immutableFinal.bytes, sha256: immutableFinal.sha256, url: `/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(immutableFinal.path)}` }
      ]
    }, null, 2));

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const mutableBefore = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token));
    expect(mutableBefore.status).toBe(200);
    expect(await mutableBefore.text()).toBe("fake-video");
    const reconciledJob = await (await handler(getRequest(`/api/jobs/${fixture.jobId}`, token))).json();
    expect(reconciledJob.artifacts.find((artifact) => artifact.name === "final.mp4")).toMatchObject({
      bytes: immutableFinal.bytes,
      sha256: immutableFinal.sha256
    });
    const manifestDeclaration = reconciledJob.artifacts.find((artifact) => artifact.name === `runs/${fixture.runId}/manifest.json`);
    expect(manifestDeclaration).toMatchObject({ kind: "run-manifest" });
    expect(manifestDeclaration.bytes).toBeGreaterThan(0);
    expect(manifestDeclaration.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    const manifestResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(manifestDeclaration.name)}`, token));
    const manifestBody = Buffer.from(await manifestResponse.arrayBuffer());
    expect(manifestResponse.status).toBe(200);
    expect(manifestBody.byteLength).toBe(manifestDeclaration.bytes);
    expect(`sha256:${new Bun.CryptoHasher("sha256").update(manifestBody).digest("hex")}`).toBe(manifestDeclaration.sha256);
    const rangeResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token, { range: "bytes=0-3" }));
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(rangeResponse.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("content-length")).toBe("4");
    expect(await rangeResponse.text()).toBe("fake");
    const invalidRange = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token, { range: "bytes=20-30" }));
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("content-range")).toBe("bytes */10");
    await writeFile(join(fixture.jobDir, "final.mp4"), "evil-video");
    expect(await (await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token))).text()).toBe("fake-video");

    await unlink(join(fixture.jobDir, fixture.manifest.immutableArtifacts.find((entry) => entry.name === "final.mp4").path));
    const mutableAfter = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token));
    expect(mutableAfter.status).toBe(500);

    await writeFile(join(fixture.jobDir, immutableFinal.path), "fake-video");
    const immutableResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(immutableFinal.path)}`, token));
    expect(immutableResponse.status).toBe(200);
    expect(await immutableResponse.text()).toBe("fake-video");
  });

  test("does not let a live cross-process lease bypass terminal integrity or mutable artifact checks", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const immutableFinal = fixture.manifest.immutableArtifacts.find((entry) => entry.name === "final.mp4");
    await writeFile(join(fixture.jobDir, "final.mp4"), "evil-video");
    await writeFile(join(fixture.jobDir, immutableFinal.path), "evil-video");
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...fixture.job,
      artifacts: [{ name: "final.mp4", kind: "video", url: `/api/jobs/${fixture.jobId}/artifacts/final.mp4` }]
    }, null, 2));
    const lease = await acquireJobLease(fixture.jobId);
    expect(lease).not.toBeNull();
    try {
      const token = createSessionToken();
      const handler = createStudioRequestHandler({ token });
      const jobResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
      expect(jobResponse.status).toBe(200);
      expect(await jobResponse.json()).toMatchObject({ integrity: { status: "blocked", code: "sealed-run-integrity-failure" } });
      const artifactResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token));
      expect(artifactResponse.status).toBe(500);
      expect(await artifactResponse.text()).toContain("불변 산출물 무결성");

      await writeFile(join(fixture.jobDir, immutableFinal.path), "fake-video");
      const mutableResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/final.mp4`, token));
      expect(mutableResponse.status).toBe(500);
      expect(await mutableResponse.text()).toContain("terminal 작업 포인터");
    } finally {
      await lease.handle.close();
    }
  });

  test("blocks a live terminal pointer whose quality input receipt or provenance differs from the seal", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const canonical = await (await handler(getRequest(`/api/jobs/${fixture.jobId}`, token))).json();
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...(await readJob(fixture.jobId)),
      qualitySummary: {
        ...canonical.qualitySummary,
        inputManifest: { path: "forged-input.json", sha256: HASH_A }
      },
      providerProvenance: { path: "forged-provider.json", sha256: HASH_B }
    }, null, 2));
    const lease = await acquireJobLease(fixture.jobId);
    expect(lease).not.toBeNull();
    try {
      const response = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ integrity: { status: "blocked", code: "sealed-run-integrity-failure" } });
    } finally {
      await lease.handle.close();
    }
  });

  test("preserves and blocks a sealed manifest whose input receipt contradicts immutable evidence", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const manifestPath = join(fixture.runDir, "manifest.json");
    const corrupted = JSON.parse(await readFile(manifestPath, "utf8"));
    corrupted.qualitySummary.inputManifest = {
      path: `runs/${fixture.runId}/input-manifest.json`,
      sha256: HASH_A,
      entryCount: 0
    };
    const corruptedBytes = `${JSON.stringify(corrupted, null, 2)}\n`;
    await writeFile(manifestPath, corruptedBytes);
    const jobBefore = await readFile(join(fixture.jobDir, "job.json"), "utf8");

    const response = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      integrity: { status: "blocked", code: "sealed-run-integrity-failure", mutableJobPreserved: true }
    });
    expect(await readFile(manifestPath, "utf8")).toBe(corruptedBytes);
    expect(await readFile(join(fixture.jobDir, "job.json"), "utf8")).toBe(jobBefore);
  });

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
    let failedRunDirectorySync = false;
    await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated, {
      syncDirectoryFn: async (path) => {
        if (path === fixture.runDir) {
          failedRunDirectorySync = true;
          throw new Error("injected first revisions publication fsync failure");
        }
        throw new Error(`unexpected directory sync before runDir: ${path}`);
      }
    })).rejects.toThrow("injected first revisions publication fsync failure");
    expect(failedRunDirectorySync).toBeTrue();
    expect(await readdir(join(fixture.runDir, "revisions"))).toEqual([]);
    const durabilitySteps = [];
    const revision = await sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated, {
      onDurabilityStep: (step) => durabilitySteps.push({
        operation: step.operation,
        name: step.path.slice(step.path.lastIndexOf("/") + 1)
      })
    });
    expect(durabilitySteps).toEqual([
      { operation: "directory-fsync", name: fixture.runId },
      { operation: "file-fsync", name: "committee-review.json" },
      { operation: "file-fsync", name: "quality.json" },
      { operation: "file-fsync", name: "events.jsonl" },
      { operation: "file-fsync", name: "manifest.json" },
      { operation: "directory-fsync", name: expect.stringContaining(".quality-revision-staging-") },
      { operation: "rename", name: revisionContext.revisionId },
      { operation: "directory-fsync", name: "revisions" }
    ]);
    expect(await readFile(join(fixture.runDir, "manifest.json"), "utf8")).toBe(baseManifestBefore);
    expect(revision.manifest).toMatchObject({ schemaVersion: 2, sealStatus: "sealed", effectiveStatus: "needs-improvement", immutableBase: true });
    expect((await readJob(fixture.jobId)).qualitySummary).not.toHaveProperty("revisionId");

    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const qualityResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality`, token));
    expect(qualityResponse.status).toBe(200);
    expect(await qualityResponse.json()).toMatchObject({ status: "needs-improvement", semanticGate: false, revisionId: revision.revisionId, metrics: { providerProof: false, providerEvidenceEligible: false } });
    const reconciled = await readJob(fixture.jobId);
    expect(reconciled.qualitySummary).toMatchObject({ revisionId: revision.revisionId, revisionSequence: 1 });
    expect(reconciled.artifacts.filter((artifact) => artifact.name.startsWith(`runs/${fixture.runId}/revisions/`))).toHaveLength(4);
    const historyResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/quality/history`, token));
    const history = await historyResponse.json();
    expect(history.iterations[0]).toMatchObject({ technicalEvidenceGate: false, metrics: { providerProof: false, providerEvidenceEligible: false } });
    expect(history.iterations.at(-1)).toMatchObject({ revisionId: revision.revisionId, status: "needs-improvement" });

    const revisionQualityPath = join(fixture.jobDir, revision.manifest.quality.path);
    const revisionQualityBefore = await readFile(revisionQualityPath);
    const revisionQualityMtimeBefore = (await stat(revisionQualityPath, { bigint: true })).mtimeNs;
    for (const range of [null, "bytes=0-"]) {
      const rawRevisionQuality = await handler(getRequest(
        `/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(revision.manifest.quality.path)}`,
        token,
        range ? { range } : {}
      ));
      expect(rawRevisionQuality.status).toBe(409);
      expect((await rawRevisionQuality.json()).error).toContain("quality/history");
    }
    expect(await readFile(revisionQualityPath)).toEqual(revisionQualityBefore);
    expect((await stat(revisionQualityPath, { bigint: true })).mtimeNs).toBe(revisionQualityMtimeBefore);

    const manifestArtifactResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(revision.manifestPath)}`, token));
    expect(manifestArtifactResponse.status).toBe(200);
    reconciled.provider = "gemini-browser";
    reconciled.runStatus = "verified";
    reconciled.artifacts.push({ ...revision.artifacts.find((artifact) => artifact.name === revision.manifestPath) });
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(reconciled, null, 2));
    const repairedResponse = await handler(getRequest(`/api/jobs/${fixture.jobId}`, token));
    expect(repairedResponse.status).toBe(200);
    expect(await repairedResponse.json()).toMatchObject({ providerProof: false, providerEvidenceEligible: false, legacyProviderProofSemantics: "local-input-binding-v1", qualitySummary: { technicalEvidenceGate: false } });
    const repaired = await readJob(fixture.jobId);
    expect(repaired.provider).toBe("local");
    expect(repaired.runStatus).toBe("needs-improvement");
    expect(repaired.artifacts.filter((artifact) => artifact.name === revision.manifestPath)).toHaveLength(1);

    const revisionManifestPath = join(fixture.jobDir, revision.manifestPath);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-revision-hardlink-"));
    const externalManifest = join(externalDir, "manifest.json");
    const revisionManifestBytes = await readFile(revisionManifestPath);
    await writeFile(externalManifest, revisionManifestBytes);
    await unlink(revisionManifestPath);
    await link(externalManifest, revisionManifestPath);
    const externalBefore = await stat(externalManifest, { bigint: true });
    try {
      const hardlinkResponse = await handler(getRequest(
        `/api/jobs/${fixture.jobId}/artifacts/${encodeURIComponent(revision.manifestPath)}`,
        token
      ));
      expect(hardlinkResponse.status).toBe(409);
      expect(await readFile(externalManifest)).toEqual(revisionManifestBytes);
      const externalAfter = await stat(externalManifest, { bigint: true });
      expect(externalAfter.ino).toBe(externalBefore.ino);
      expect(externalAfter.mtimeNs).toBe(externalBefore.mtimeNs);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects a revisions-directory symlink without writing outside the pinned run ancestry", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const revisionContext = await prepareQualityRevision(fixture.jobId, fixture.runId, "revision-symlink-000001");
    const review = buildReview(fixture.jobId, fixture.runId, revisionContext, fixture.baseQuality.metrics.evidenceHashes);
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
    const externalJobId = `quality-external-${randomUUID()}`;
    createdJobs.push(externalJobId);
    const externalDir = join(JOBS_DIR, externalJobId);
    const sentinelPath = join(externalDir, "sentinel.txt");
    const revisionsPath = join(fixture.runDir, "revisions");
    await mkdir(externalDir);
    await writeFile(sentinelPath, "external quality sentinel\n");
    const externalDirectoryStatBefore = await stat(externalDir, { bigint: true });
    await symlink(externalDir, revisionsPath);
    const protectedPaths = [
      join(fixture.jobDir, "job.json"),
      join(fixture.runDir, "manifest.json"),
      sentinelPath
    ];
    const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));

    await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated)).rejects.toThrow("non-symlink directory");

    for (const path of protectedPaths) {
      expect(await readFile(path)).toEqual(before.get(path).bytes);
      expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.get(path).stat.mtimeNs);
    }
    expect(await readdir(externalDir)).toEqual(["sentinel.txt"]);
    expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(externalDirectoryStatBefore.mtimeNs);
    expect((await stat(revisionsPath)).isDirectory()).toBeTrue();
  });

  test("rejects a symlinked run directory before creating revisions outside the job", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const revisionContext = await prepareQualityRevision(fixture.jobId, fixture.runId, "revision-run-link-000001");
    const review = buildReview(fixture.jobId, fixture.runId, revisionContext, fixture.baseQuality.metrics.evidenceHashes);
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
    const externalJobId = `quality-run-external-${randomUUID()}`;
    createdJobs.push(externalJobId);
    const externalRunDir = join(JOBS_DIR, externalJobId);
    const sentinelPath = join(externalRunDir, "sentinel.txt");
    await rename(fixture.runDir, externalRunDir);
    await writeFile(sentinelPath, "external run sentinel\n");
    await symlink(externalRunDir, fixture.runDir);
    const protectedPaths = [join(fixture.jobDir, "job.json"), join(externalRunDir, "manifest.json"), sentinelPath];
    const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));
    const externalEntriesBefore = await readdir(externalRunDir);
    const externalDirectoryStatBefore = await stat(externalRunDir, { bigint: true });

    await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated)).rejects.toThrow("run 경로가 exact non-symlink directory");

    for (const path of protectedPaths) {
      expect(await readFile(path)).toEqual(before.get(path).bytes);
      expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.get(path).stat.mtimeNs);
    }
    expect(await readdir(externalRunDir)).toEqual(externalEntriesBefore);
    expect((await stat(externalRunDir, { bigint: true })).mtimeNs).toBe(externalDirectoryStatBefore.mtimeNs);
  });

  test("detects a pinned revisions-directory symlink swap before staging creation", async () => {
    const fixture = await createSealedNeedsImprovementFixture();
    const revisionContext = await prepareQualityRevision(fixture.jobId, fixture.runId, "revision-race-000001");
    const review = buildReview(fixture.jobId, fixture.runId, revisionContext, fixture.baseQuality.metrics.evidenceHashes);
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
    const externalJobId = `quality-race-external-${randomUUID()}`;
    createdJobs.push(externalJobId);
    const externalDir = join(JOBS_DIR, externalJobId);
    const sentinelPath = join(externalDir, "sentinel.txt");
    const revisionsPath = join(fixture.runDir, "revisions");
    const preservedRevisionsPath = join(fixture.runDir, `.preserved-revisions-${randomUUID()}`);
    await mkdir(externalDir);
    await writeFile(sentinelPath, "external quality race sentinel\n");
    const protectedPaths = [join(fixture.jobDir, "job.json"), join(fixture.runDir, "manifest.json"), sentinelPath];
    const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));
    const externalDirectoryStatBefore = await stat(externalDir, { bigint: true });
    let swapped = false;
    try {
      await expect(sealQualityRevision(fixture.jobId, fixture.runId, revisionContext, review, evaluated, {
        beforeQualityRevisionPathCheck: async ({ operation }) => {
          if (swapped || operation !== "staging-create") return;
          swapped = true;
          await rename(revisionsPath, preservedRevisionsPath);
          await symlink(externalDir, revisionsPath);
        }
      })).rejects.toThrow(/non-symlink directory|다른 inode/);
      expect(swapped).toBeTrue();
      for (const path of protectedPaths) {
        expect(await readFile(path)).toEqual(before.get(path).bytes);
        expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.get(path).stat.mtimeNs);
      }
      expect(await readdir(externalDir)).toEqual(["sentinel.txt"]);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(externalDirectoryStatBefore.mtimeNs);
    } finally {
      await unlink(revisionsPath).catch(() => {});
      await rename(preservedRevisionsPath, revisionsPath).catch(() => {});
    }
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
        tokenPath: join(valid.jobDir, ".runtime", "studio-token"),
        serverLeasePath: join(valid.jobDir, ".runtime", "studio-server.lock")
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
