import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateGeminiClips } from "../src/gemini-browser.mjs";
import { buildGeminiClipPrompt, buildGeminiGenerationRequest, canonicalGeminiResumeScriptHash } from "../src/gemini-browser.mjs";
import {
  JOBS_DIR,
  SEMANTIC_REVALIDATION_MODE,
  commitSemanticRevalidationWorkspace,
  hydrateGeminiSemanticRevalidationInputs,
  readJob,
  readGeminiSemanticRevalidationInputs,
  rollbackSemanticRevalidationWorkspace,
  runJob,
  updateJob,
  validateEvidenceBoundScript
} from "../src/pipeline.mjs";
import { LOCAL_SEMANTIC_POLICY_BINDING } from "../src/local-semantic-verifier.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "../src/provenance.mjs";
import { providerPromptBindingForSegment } from "../src/shot-patterns.mjs";
import { verifySemanticRevalidationProviderZeroBinding } from "../src/semantic-revalidation-closure.mjs";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  createStudioRequestHandler,
  prepareSemanticRevalidationContext,
  reconcileQualityRevisionJob
} from "../src/server.mjs";

const createdJobs = [];

afterEach(async () => {
  await Promise.all(createdJobs.splice(0).map((jobId) => rm(join(JOBS_DIR, jobId), { recursive: true, force: true })));
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function postRequest(path, token, body) {
  return new Request(`http://127.0.0.1:3000${path}`, {
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
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "sec-fetch-site": "same-origin"
    }
  });
}

async function treeDigest(root) {
  const records = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else records.push({ path: relative, bytes: (await stat(path)).size, sha256: await hashFile(path) });
    }
  };
  await visit(root);
  return hashJson(records);
}

async function createSealedGeminiFixture({ realVideo = false } = {}) {
  const jobId = `semantic-${randomUUID()}`;
  const runId = `source-${randomUUID()}`;
  createdJobs.push(jobId);
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const quote = "궁궐 마당의 돌 사이 틈은 빗물이 빠져나가는 통로로 기능한다.";
  const sources = [{
    title: "공식 건축 기록",
    url: "https://example.go.kr/architecture",
    fetchStatus: "fetched",
    sha256: `sha256:${"a".repeat(64)}`,
    byteLength: 128,
    evidence: [{ id: "excerpt-1", locator: "text-offset:0-40", quote }]
  }];
  const script = validateEvidenceBoundScript({
    title: quote,
    hook: quote,
    narration: quote,
    researchStatus: "verified",
    videoFormat: "vertical",
    segments: [{
      claimId: "claim-1",
      claim: quote,
      caption: quote,
      narration: quote,
      visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(quote)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
      durationHint: 8,
      evidenceRefs: [{ sourceId: sources[0].url, evidenceId: "excerpt-1", quote }]
    }]
  }, sources, 1, "fixture", "vertical");
  const sourceFile = { schemaVersion: 1, jobId, runId, status: "complete", fetchedCount: 1, totalCount: 1, evidenceCount: 1, records: sources };
  let clipBytes = Buffer.from("immutable-gemini-video-fixture");
  if (realVideo) {
    const temporaryClipPath = join(jobDir, ".semantic-revalidation-fixture.mp4");
    const ffmpeg = Bun.spawn([
      "ffmpeg", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=royalblue:s=180x320:d=0.2:r=10",
      "-pix_fmt", "yuv420p",
      temporaryClipPath
    ], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(ffmpeg.stderr).text();
    const exitCode = await ffmpeg.exited;
    if (exitCode !== 0) throw new Error(`ffmpeg fixture creation failed: ${stderr}`);
    clipBytes = await readFile(temporaryClipPath);
    await rm(temporaryClipPath, { force: true });
  }
  const clipSha = `sha256:${createHash("sha256").update(clipBytes).digest("hex")}`;
  const inputManifest = {
    schemaVersion: 1,
    jobId,
    runId,
    entries: [{ name: "01.mp4", relativePath: "clips/01.mp4", bytes: clipBytes.length, sha256: clipSha }]
  };
  const providerDecision = { requested: "gemini-browser", selected: "gemini-browser", fallbackUsed: false, policy: "no-local-video-fallback" };
  const geminiProfileDir = join(homedir(), ".ps4-ai-video-studio", `semantic-test-${jobId}`);
  const generationJob = {
    id: jobId,
    runId,
    provider: "gemini-browser",
    topic: "봉인 Gemini 의미 재검수",
    format: "vertical",
    clipCount: 1,
    targetDurationSec: 20,
    targetDurationRangeSec: [19, 21],
    captions: true,
    voiceover: false,
    geminiCdpUrl: "http://127.0.0.1:9233",
    geminiProfileDir
  };
  const sessionBinding = canonicalGeminiSessionBinding(generationJob);
  const sessionBindingHash = geminiSessionBindingHash(generationJob);
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: "Chrome/151.0.7922.109",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    fallbackUsed: false
  };
  const request = buildGeminiGenerationRequest(generationJob, script);
  const scriptHash = hashJson(script);
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const requestHash = hashJson({ ...request, scriptHash });
  const resumeRequestHash = hashJson({ ...request, scriptHash: resumeScriptHash });
  const prompt = buildGeminiClipPrompt(generationJob, script, script.segments[0]);
  const generation = {
    schemaVersion: 4,
    provider: "gemini-browser",
    jobId,
    runId,
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    pendingSegment: null,
    promptReadinessFailure: null,
    request,
    providerDecision,
    providerDecisionHash: hashJson(providerDecision),
    providerAttestation,
    providerAttestationHash: hashJson(providerAttestation),
    sessionBinding,
    sessionBindingHash,
    requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: [],
    segments: [{
      index: 1,
      runId,
      submissionRunId: runId,
      path: "clips/01.mp4",
      output: "clips/01.mp4",
      sha256: clipSha,
      requestHash,
      scriptHash,
      resumeRequestHash,
      resumeScriptHash,
      providerDecisionHash: hashJson(providerDecision),
      providerAttestationHash: hashJson(providerAttestation),
      prompt,
      promptHash: hashJson({ prompt }),
      providerVisualPromptHash: providerPromptBindingForSegment(script.segments[0], "gemini-browser").providerVisualPromptHash,
      submittedToProvider: true,
      submissionAcknowledgement: { verified: true }
    }]
  };
  const baseQuality = {
    schemaVersion: 1,
    jobId,
    runId,
    iteration: 2,
    status: "needs-improvement",
    totalScore: 94,
    threshold: 98,
    technicalEvidenceGate: false,
    semanticGate: false,
    blockers: ["legacy semantic policy false negative"],
    metrics: {
      provider: "gemini-browser",
      providerProof: true,
      generationProvenance: true,
      generationClipBinding: true,
      providerDecisionBinding: true,
      providerDecisionEventBinding: true,
      inputManifestBinding: true,
      evidenceHashes: {}
    }
  };
  const qualitySummary = Object.fromEntries(
    ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"]
      .map((field) => [field, baseQuality[field]])
  );
  const immutableArtifacts = [];
  const writeArtifact = async (name, content) => {
    const path = join(artifactsDir, name.replaceAll("/", "__"));
    await writeFile(path, content);
    const receipt = {
      name,
      path: `runs/${runId}/artifacts/${name.replaceAll("/", "__")}`,
      bytes: (await stat(path)).size,
      sha256: await hashFile(path)
    };
    immutableArtifacts.push(receipt);
    return receipt;
  };
  await writeArtifact("final.mp4", "sealed-final");
  await writeArtifact("captions.srt", "1\n00:00:00,000 --> 00:00:01,000\ncaption\n");
  await writeArtifact("script.json", `${JSON.stringify(script, null, 2)}\n`);
  await writeArtifact("thumbnail.jpg", "sealed-thumbnail");
  await writeArtifact("quality.json", `${JSON.stringify(baseQuality, null, 2)}\n`);
  await writeArtifact("frame-audio-caption.json", `${JSON.stringify({ jobId, runId })}\n`);
  await writeArtifact("sources.json", `${JSON.stringify(sourceFile, null, 2)}\n`);
  await writeArtifact(`runs/${runId}/events.jsonl`, `${JSON.stringify({ type: "quality_finalized", jobId, runId })}\n`);
  const inputReceipt = await writeArtifact(`runs/${runId}/input-manifest.json`, `${JSON.stringify(inputManifest, null, 2)}\n`);
  await writeArtifact(`runs/${runId}/semantic/receipt.json`, `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    runId,
    status: "failed",
    failureCodes: ["frame-004:scene-relevance", "semantic-receipt-verdict"]
  }, null, 2)}\n`);
  const channelReceipt = await writeArtifact(`runs/${runId}/benchmarks/channel-analysis.json`, "{}\n");
  const durationReceipt = await writeArtifact(`runs/${runId}/benchmarks/shorts-metadata.json`, "{}\n");
  const rlmReceipt = await writeArtifact(`runs/${runId}/benchmarks/rlm-benchmark-analysis.json`, "{}\n");
  const generationReceipt = await writeArtifact("gemini-generation.json", `${JSON.stringify(generation, null, 2)}\n`);
  const clipReceipt = await writeArtifact("clips/01.mp4", clipBytes);
  const manifest = {
    schemaVersion: 1,
    jobId,
    runId,
    status: "needs-improvement",
    runStatus: "needs-improvement",
    request: {
      topic: "봉인 Gemini 의미 재검수",
      provider: "gemini-browser",
      format: "vertical",
      clipCount: 1,
      targetDurationSec: 20,
      targetDurationRangeSec: [19, 21],
      captions: true,
      voiceover: false,
      fallbackPolicy: "no-local-video-fallback"
      ,geminiSessionBinding: sessionBinding
      ,geminiSessionBindingHash: sessionBindingHash
    },
    providerDecision,
    providerDecisionHash: hashJson(providerDecision),
    benchmarkSnapshot: {
      path: channelReceipt.name,
      sha256: channelReceipt.sha256,
      durationMetadata: { path: durationReceipt.name, sha256: durationReceipt.sha256 },
      rlmMediaEvidence: { path: rlmReceipt.name, sha256: rlmReceipt.sha256 }
    },
    inputManifest: { path: inputReceipt.name, sha256: inputReceipt.sha256 },
    qualitySummary,
    ledgerErrors: [],
    immutableArtifacts
  };
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const job = {
    id: jobId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: "gemini-browser",
    topic: manifest.request.topic,
    format: "vertical",
    clipCount: 1,
    targetDurationSec: 20,
    targetDurationRangeSec: [19, 21],
    captions: true,
    voiceover: false,
    sources,
    status: "needs-improvement",
    runStatus: "needs-improvement",
    stage: "개선 필요",
    progress: 100,
    runId,
    qualitySummary,
    artifacts: [],
    providerProvenance: { path: "gemini-generation.json", sha256: `sha256:${"0".repeat(64)}` },
    geminiCdpUrl: generationJob.geminiCdpUrl,
    geminiProfileDir
  };
  await writeFile(join(jobDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  return { jobId, runId, jobDir, runDir, manifest, generationReceipt, clipReceipt, script, generationJob };
}

function childRunner({ failAfterCreation = false, hold = null } = {}) {
  return async (jobId, options) => {
    const source = await readJob(jobId);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(JOBS_DIR, jobId, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      jobId,
      runId: childRunId,
      parentRunId: source.runId,
      trigger: options.trigger,
      reason: options.reason,
      status: "running",
      runStatus: "running",
      semanticRevalidation: {
        mode: options.semanticRevalidation.mode,
        sourceRunId: options.semanticRevalidation.sourceRunId,
        parentManifestHash: options.semanticRevalidation.sourceManifest.sha256,
        semanticPolicy: options.semanticRevalidation.semanticPolicy,
        providerRequestPolicy: options.semanticRevalidation.providerRequestPolicy,
        providerRequestSent: false
      }
    };
    await writeFile(join(childDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await updateJob(jobId, { runId: childRunId, status: "running", runStatus: "running", stage: "의미 재검수", runStartedAt: new Date().toISOString() });
    await options.onRunCreated({ job: await readJob(jobId), runId: childRunId, parentRunId: source.runId });
    if (hold) await hold;
    if (failAfterCreation) {
      await writeFile(join(childDir, "manifest.json"), `${JSON.stringify({ ...manifest, status: "failed", runStatus: "failed", error: "injected local verifier failure" }, null, 2)}\n`);
      return updateJob(jobId, { status: "failed", runStatus: "failed", message: "injected local verifier failure" });
    }
    await writeFile(join(childDir, "manifest.json"), `${JSON.stringify({ ...manifest, status: "needs-improvement", runStatus: "needs-improvement" }, null, 2)}\n`);
    return updateJob(jobId, { status: "needs-improvement", runStatus: "needs-improvement", stage: "개선 필요" });
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}

describe("append-only semantic revalidation", () => {
  test("creates a policy-bound child with provider calls zero and leaves every source-run byte unchanged", async () => {
    const fixture = await createSealedGeminiFixture();
    const before = await treeDigest(fixture.runDir);
    const token = createSessionToken();
    let providerCalls = 0;
    const runner = childRunner();
    const handler = createStudioRequestHandler({
      token,
      semanticRevalidationRunner: async (...args) => {
        expect(args[1].semanticRevalidation.providerRequestPolicy).toEqual({ allowed: false, maximumCalls: 0 });
        expect(args[1].semanticRevalidation.semanticPolicy).toEqual(LOCAL_SEMANTIC_POLICY_BINDING);
        return runner(...args);
      }
    });
    const response = await handler(postRequest(`/api/jobs/${fixture.jobId}/semantic/revalidate`, token, { sourceRunId: fixture.runId }));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ started: true, sourceRunId: fixture.runId, providerRequests: 0, semanticPolicy: LOCAL_SEMANTIC_POLICY_BINDING });
    expect(providerCalls).toBe(0);
    await waitFor(async () => (await readJob(fixture.jobId)).status === "needs-improvement");
    expect(await treeDigest(fixture.runDir)).toBe(before);
    const childManifest = JSON.parse(await readFile(join(fixture.jobDir, "runs", payload.childRunId, "manifest.json"), "utf8"));
    expect(childManifest).toMatchObject({
      parentRunId: fixture.runId,
      trigger: "semantic-revalidation",
      status: "needs-improvement",
      semanticRevalidation: {
        mode: SEMANTIC_REVALIDATION_MODE,
        sourceRunId: fixture.runId,
        semanticPolicy: LOCAL_SEMANTIC_POLICY_BINDING,
        providerRequestPolicy: { allowed: false, maximumCalls: 0 },
        providerRequestSent: false
      }
    });
  });

  test("rejects immutable tampering and wrong active state before a child or provider call", async () => {
    const fixture = await createSealedGeminiFixture();
    const token = createSessionToken();
    let runnerCalls = 0;
    const handler = createStudioRequestHandler({ token, semanticRevalidationRunner: async () => { runnerCalls += 1; } });
    await writeFile(join(fixture.runDir, "artifacts", "script.json"), "tampered\n");
    const tampered = await handler(postRequest(`/api/jobs/${fixture.jobId}/semantic/revalidate`, token, { sourceRunId: fixture.runId }));
    expect(tampered.status).toBe(409);
    expect(runnerCalls).toBe(0);

    const activeFixture = await createSealedGeminiFixture();
    await updateJob(activeFixture.jobId, { status: "running", runStatus: "running", runStartedAt: new Date().toISOString() });
    const active = await handler(postRequest(`/api/jobs/${activeFixture.jobId}/semantic/revalidate`, token, { sourceRunId: activeFixture.runId }));
    expect(active.status).toBe(409);
    expect(runnerCalls).toBe(0);
  });

  test("seals child failure, releases the lease, preserves source bytes, and rejects a concurrent duplicate", async () => {
    const fixture = await createSealedGeminiFixture();
    const before = await treeDigest(fixture.runDir);
    const token = createSessionToken();
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });
    const handler = createStudioRequestHandler({ token, semanticRevalidationRunner: childRunner({ failAfterCreation: true, hold }) });
    const first = await handler(postRequest(`/api/jobs/${fixture.jobId}/semantic/revalidate`, token, { sourceRunId: fixture.runId }));
    const firstPayload = await first.json();
    expect(first.status).toBe(202);

    const duplicate = await handler(postRequest(`/api/jobs/${fixture.jobId}/semantic/revalidate`, token, { sourceRunId: fixture.runId }));
    expect(duplicate.status).toBe(409);
    releaseHold();
    await waitFor(async () => (await readJob(fixture.jobId)).status === "failed");
    const child = JSON.parse(await readFile(join(fixture.jobDir, "runs", firstPayload.childRunId, "manifest.json"), "utf8"));
    expect(child).toMatchObject({ status: "failed", runStatus: "failed", error: "injected local verifier failure" });
    expect(await treeDigest(fixture.runDir)).toBe(before);
    await waitFor(async () => !(await stat(join(fixture.jobDir, ".run.lock")).catch(() => null)));
  });

  test("derives the public providerProvenance pointer from the immutable generation artifact", async () => {
    const fixture = await createSealedGeminiFixture();
    const reconciled = await reconcileQualityRevisionJob(await readJob(fixture.jobId));
    expect(reconciled.providerProvenance).toEqual({
      path: fixture.generationReceipt.path,
      sha256: fixture.generationReceipt.sha256
    });
    expect(reconciled.providerProvenance.path).not.toBe("gemini-generation.json");
  });

  test("hard-fences provider access when a zero-provider run is not on the exact completed-resume branch", async () => {
    const jobId = `semantic-fence-${randomUUID()}`;
    createdJobs.push(jobId);
    await mkdir(join(JOBS_DIR, jobId), { recursive: true });
    const job = {
      id: jobId,
      runId: `child-${randomUUID()}`,
      provider: "gemini-browser",
      providerRequestsForbidden: true,
      geminiCdpUrl: "http://127.0.0.1:65534",
      geminiProfileDir: join(homedir(), ".ps4-ai-video-studio", `fence-${jobId}`),
      topic: "provider zero fence",
      format: "vertical",
      clipCount: 1,
      targetDurationSec: 20,
      targetDurationRangeSec: [19, 21],
      captions: true,
      voiceover: false
    };
    await expect(generateGeminiClips(job, { segments: [{}] })).rejects.toThrow("provider 요청 0회");
    expect(await stat(join(JOBS_DIR, jobId, "gemini-generation.json")).catch(() => null)).toBeNull();
  });

  test("reuses the sealed completed generation through the real provider-zero resume branch", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    const sourceDigest = await treeDigest(fixture.runDir);
    await mkdir(join(fixture.jobDir, "clips"), { recursive: true });
    await copyFile(join(fixture.jobDir, fixture.generationReceipt.path), join(fixture.jobDir, "gemini-generation.json"));
    await copyFile(join(fixture.jobDir, fixture.clipReceipt.path), join(fixture.jobDir, "clips", "01.mp4"));
    const progress = [];
    const childRunId = `child-${randomUUID()}`;

    const result = await generateGeminiClips({
      ...fixture.generationJob,
      runId: childRunId,
      resumeCompletedGenerationRunId: fixture.runId,
      providerRequestsForbidden: true
    }, fixture.script, async (_percent, message) => progress.push(message));

    expect(result.runId).toBe(childRunId);
    expect(result.resumedFromCompletedGeneration).toMatchObject({
      sourceRunId: fixture.runId,
      providerRequestSent: false
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      sourceRunId: fixture.runId,
      submissionRunId: fixture.runId,
      resumedCompletedGeneration: true
    });
    expect(progress.at(-1)).toContain("provider 요청 없이 복구");
    const sourceGeneration = JSON.parse(await readFile(join(fixture.jobDir, fixture.generationReceipt.path), "utf8"));
    const sourceManifestHash = await hashFile(join(fixture.runDir, "manifest.json"));
    const childGenerationFileHash = hashJson({ immutableChildGeneration: result });
    const childManifest = {
      jobId: fixture.jobId,
      runId: childRunId,
      parentRunId: fixture.runId,
      semanticRevalidation: {
        schemaVersion: 1,
        mode: SEMANTIC_REVALIDATION_MODE,
        sourceRunId: fixture.runId,
        parentManifestHash: sourceManifestHash,
        sourceImmutableArtifactsHash: hashJson(fixture.manifest.immutableArtifacts),
        sourceProviderProvenance: { path: fixture.generationReceipt.path, sha256: fixture.generationReceipt.sha256 },
        semanticPolicy: LOCAL_SEMANTIC_POLICY_BINDING,
        providerRequestPolicy: { allowed: false, maximumCalls: 0 },
        providerRequestSent: false,
        childGenerationHash: hashJson(result)
      }
    };
    const source = {
      sourceRunId: fixture.runId,
      sourceManifest: fixture.manifest,
      sourceManifestHash,
      sourceGeneration,
      sourceGenerationFileHash: fixture.generationReceipt.sha256,
      sourceGenerationHash: hashJson(sourceGeneration)
    };
    const shotPatternReceipt = {
      schemaVersion: 2,
      jobId: fixture.jobId,
      runId: childRunId,
      provider: "gemini-browser",
      submittedToProvider: true,
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true,
      sourceSubmissionRunId: fixture.runId,
      sourceGenerationHash: source.sourceGenerationHash,
      providerRequestHash: result.requestHash,
      providerGenerationHash: childGenerationFileHash
    };
    const closure = verifySemanticRevalidationProviderZeroBinding({
      jobId: fixture.jobId,
      runId: childRunId,
      manifest: childManifest,
      generation: result,
      childGenerationFileHash,
      shotPatternReceipt,
      source
    });
    expect(closure).toMatchObject({ required: true, verified: true, childGenerationFileHash });
    expect(verifySemanticRevalidationProviderZeroBinding({
      jobId: fixture.jobId,
      runId: childRunId,
      manifest: childManifest,
      generation: result,
      childGenerationFileHash: hashJson({ tampered: true }),
      shotPatternReceipt,
      source
    }).verified).toBeFalse();
    expect(await treeDigest(fixture.runDir)).toBe(sourceDigest);
  });

  test("rejects an inexact policy binding before mutable staging", async () => {
    const fixture = await createSealedGeminiFixture();
    const job = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(job, fixture.runId);
    context.semanticPolicy = { ...context.semanticPolicy, version: "2" };
    await expect(readGeminiSemanticRevalidationInputs(job, fixture.jobDir, context)).rejects.toThrow("semantic policy");
  });

  test("rolls back every mutable root byte when transactional publication faults after backup", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    const sourceDigest = await treeDigest(fixture.runDir);
    const originalFiles = {
      "script.json": "parent mutable script\n",
      "sources.json": "parent mutable sources\n",
      "gemini-generation.json": "parent mutable generation\n",
      "final.mp4": "parent mutable final\n"
    };
    for (const [name, value] of Object.entries(originalFiles)) await writeFile(join(fixture.jobDir, name), value);
    await mkdir(join(fixture.jobDir, "clips"), { recursive: true });
    await writeFile(join(fixture.jobDir, "clips", "parent.mp4"), "parent mutable clip\n");
    await mkdir(join(fixture.jobDir, "legacy-gemini-evidence"), { recursive: true });
    await writeFile(join(fixture.jobDir, "legacy-gemini-evidence", "submission.json"), "append-only legacy evidence\n");
    await writeFile(join(fixture.jobDir, "gemini-legacy-abandonment.json"), "append-only abandonment evidence\n");
    const beforeJob = await readFile(join(fixture.jobDir, "job.json"));
    const beforeHashes = Object.fromEntries(await Promise.all([
      ...Object.keys(originalFiles),
      "clips/parent.mp4",
      "legacy-gemini-evidence/submission.json",
      "gemini-legacy-abandonment.json"
    ].map(async (name) => [name, await hashFile(join(fixture.jobDir, name))])));
    const parentJob = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parentJob, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parentJob, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });

    await expect(hydrateGeminiSemanticRevalidationInputs(
      fixture.jobDir,
      childDir,
      childRunId,
      inputs,
      parentJob,
      {
        renameEntry: async (source, destination) => {
          if (source.includes(".semantic-revalidation-staging-") && destination === join(fixture.jobDir, "sources.json")) {
            throw new Error("injected transactional rename fault");
          }
          return rename(source, destination);
        }
      }
    )).rejects.toThrow("injected transactional rename fault");

    for (const [name, sha256] of Object.entries(beforeHashes)) expect(await hashFile(join(fixture.jobDir, name))).toBe(sha256);
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(beforeJob);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
    expect(await treeDigest(fixture.runDir)).toBe(sourceDigest);
  });

  test("never rolls back a live semantic transaction owned by another process lease", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parentScriptHash = await hashFile(join(fixture.jobDir, "script.json"));
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const transactionPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const installedScriptHash = await hashFile(join(fixture.jobDir, "script.json"));
    expect(installedScriptHash).not.toBe(parentScriptHash);
    expect((await stat(transactionPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(fixture.jobDir, hydration.transaction.backupDir))).mode & 0o777).toBe(0o700);

    const lockPath = join(fixture.jobDir, ".run.lock");
    await writeFile(lockPath, JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }));
    try {
      const token = createSessionToken();
      const handler = createStudioRequestHandler({ token });
      const response = await handler(getRequest("/api/jobs", token));
      expect(response.status).toBe(200);
      expect((await stat(transactionPath)).isFile()).toBeTrue();
      expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(installedScriptHash);
    } finally {
      await rm(lockPath, { force: true });
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(parentScriptHash);
    expect(await stat(transactionPath).catch(() => null)).toBeNull();
  });

  test("rejects traversal and corrupt parent bytes before any rollback mutation", async () => {
    const fixture = await createSealedGeminiFixture();
    await writeFile(join(fixture.jobDir, "script.json"), "sentinel parent bytes\n");
    const sentinelHash = await hashFile(join(fixture.jobDir, "script.json"));
    const parent = await readJob(fixture.jobId);
    const parentBytes = await readFile(join(fixture.jobDir, "job.json"));
    const base = {
      schemaVersion: 1,
      mode: SEMANTIC_REVALIDATION_MODE,
      phase: "prepared",
      jobId: fixture.jobId,
      sourceRunId: fixture.runId,
      childRunId: `child-${randomUUID()}`,
      backupDir: `.semantic-revalidation-backup-child-${randomUUID()}`,
      parentJob: parent,
      parentJobBytesBase64: parentBytes.toString("base64"),
      parentJobBytesSha256: await hashFile(join(fixture.jobDir, "job.json"))
    };
    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, { ...base, mutableEntries: [".."] })).rejects.toThrow("root entry");
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(sentinelHash);

    const corruptBytes = Buffer.from("not-json", "utf8");
    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, {
      ...base,
      mutableEntries: ["script.json"],
      parentJobBytesBase64: corruptBytes.toString("base64"),
      parentJobBytesSha256: `sha256:${createHash("sha256").update(corruptBytes).digest("hex")}`
    })).rejects.toThrow("job JSON");
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(sentinelHash);
  });

  test("preserves the transaction when rollback cannot classify a backup stat error", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const transactionPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
    const injectedPath = join(backupPath, hydration.transaction.mutableEntries[0]);
    const installedScriptHash = await hashFile(join(fixture.jobDir, "script.json"));
    const childJob = { ...parent, runId: childRunId, status: "running", runStatus: "running" };
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify(childJob, null, 2));

    const ioError = new Error("injected rollback backup EIO");
    ioError.code = "EIO";
    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      statEntry: async (path) => {
        if (path === injectedPath) throw ioError;
        return stat(path);
      }
    })).rejects.toThrow("injected rollback backup EIO");

    expect((await stat(transactionPath)).isFile()).toBeTrue();
    expect((await stat(backupPath)).isDirectory()).toBeTrue();
    expect(JSON.parse(await readFile(join(fixture.jobDir, "job.json"), "utf8"))).toEqual(childJob);
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(installedScriptHash);

    await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    expect((await readJob(fixture.jobId)).runId).toBe(fixture.runId);
    expect(await stat(transactionPath).catch(() => null)).toBeNull();
  });

  test("treats cleanup failure after the durable committed marker as committed success", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const childScriptHash = await hashFile(join(fixture.jobDir, "script.json"));

    const committed = await commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      removeJournal: async () => { throw new Error("injected post-commit unlink failure"); }
    });
    expect(committed.phase).toBe("committed");
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(childScriptHash);
    const transactionPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    expect(JSON.parse(await readFile(transactionPath, "utf8")).phase).toBe("committed");
    expect((await rollbackSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("committed-cleanup");
    expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(childScriptHash);
    expect(await stat(transactionPath).catch(() => null)).toBeNull();
  });

  test("real runJob failure after hydration seals the child but restores the parent pointer and mutable bytes", async () => {
    const fixture = await createSealedGeminiFixture();
    const parentRunDigest = await treeDigest(fixture.runDir);
    const mutable = {
      "script.json": "parent script bytes\n",
      "sources.json": "parent sources bytes\n",
      "gemini-generation.json": "parent provider bytes\n",
      "final.mp4": "parent final bytes\n"
    };
    for (const [name, value] of Object.entries(mutable)) await writeFile(join(fixture.jobDir, name), value);
    await mkdir(join(fixture.jobDir, "clips"), { recursive: true });
    await writeFile(join(fixture.jobDir, "clips", "parent.mp4"), "parent clip bytes\n");
    const beforeHashes = Object.fromEntries(await Promise.all([
      ...Object.keys(mutable),
      "clips/parent.mp4"
    ].map(async (name) => [name, await hashFile(join(fixture.jobDir, name))])));
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);

    const result = await runJob(fixture.jobId, {
      trigger: "semantic-revalidation",
      reason: "purpose-aware-local-semantic-policy-upgrade",
      semanticRevalidation: context,
      semanticVerifierPreflight: async () => {
        throw new Error("injected verifier outage after hydration");
      }
    });

    expect(result).toMatchObject({
      status: "needs-improvement",
      runStatus: "needs-improvement",
      runId: fixture.runId,
      providerProvenance: context.sourceProviderProvenance,
      error: null
    });
    expect(result.semanticRevalidationFailure).toMatchObject({ phase: "pipeline" });
    expect(result.semanticRevalidationFailure.message).toContain("shot pattern plan");
    for (const [name, sha256] of Object.entries(beforeHashes)) expect(await hashFile(join(fixture.jobDir, name))).toBe(sha256);
    expect(await treeDigest(fixture.runDir)).toBe(parentRunDigest);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
    const childRunId = result.semanticRevalidationFailure.childRunId;
    const childManifest = JSON.parse(await readFile(join(fixture.jobDir, "runs", childRunId, "manifest.json"), "utf8"));
    expect(childManifest).toMatchObject({
      status: "failed",
      runStatus: "failed",
      providerProvenance: context.sourceProviderProvenance,
      semanticRevalidation: { sourceRunId: fixture.runId, providerRequestSent: false }
    });
  });
});
