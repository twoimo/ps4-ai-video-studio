import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
  readSemanticTransactionStrict,
  recoverSemanticRevalidationWorkspace,
  rollbackSemanticRevalidationWorkspace,
  runJob,
  updateJob,
  validateEvidenceBoundScript
} from "../src/pipeline.mjs";
import { LOCAL_SEMANTIC_POLICY_BINDING } from "../src/local-semantic-verifier.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "../src/provenance.mjs";
import { providerPromptBindingForSegment } from "../src/shot-patterns.mjs";
import { loadSemanticRevalidationSource, verifySemanticRevalidationProviderZeroBinding } from "../src/semantic-revalidation-closure.mjs";
import {
  acquireJobLease,
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
      authorization: `Bearer ${token}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function getRequest(path, token) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
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
  await Promise.all([
    mkdir(join(jobDir, "clips"), { mode: 0o700 }),
    mkdir(join(jobDir, "normalized"), { mode: 0o700 })
  ]);

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
  const runtimeProof = {
    schemaVersion: 1,
    method: "cdp-browser-get-command-line-and-version",
    sessionBindingHash,
    cdpOriginHash: hashJson({ type: "gemini-cdp-origin", origin: sessionBinding.cdpOrigin }),
    profilePathHash: sessionBinding.profilePathHash,
    remoteDebuggingAddress: "127.0.0.1",
    remoteDebuggingPort: "9233",
    headless: true,
    headlessImplementation: "new",
    chromeMajor: 151,
    browserVersionHash: hashJson({ fixture: "HeadlessChrome/151.0.7922.109" }),
    commandLineHash: hashJson({ fixture: "exact-headless-command-line" })
  };
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: "HeadlessChrome/151.0.7922.109",
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    headlessRequested: true,
    headlessImplementation: "new",
    chromeMajor: 151,
    runtimeProof,
    runtimeProofHash: hashJson(runtimeProof),
    fallbackUsed: false
  };
  const request = buildGeminiGenerationRequest(generationJob, script);
  const scriptHash = hashJson(script);
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const requestHash = hashJson({ ...request, scriptHash });
  const resumeRequestHash = hashJson({ ...request, scriptHash: resumeScriptHash });
  const prompt = buildGeminiClipPrompt(generationJob, script, script.segments[0]);
  const targetConversationLineage = {
    schemaVersion: 1,
    method: "privacy-safe-cdp-target-conversation-hashes",
    targetIdHash: hashJson({ fixtureTarget: "target-1" }),
    conversationUrlHash: hashJson({ fixtureConversation: "conversation-1" })
  };
  const directSegmentLineage = {
    index: 1,
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    submissionRunId: runId,
    sourceRunId: null,
    sourceGenerationHash: null
  };
  const geminiSubmissionLineage = {
    schemaVersion: 1,
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    sourceSubmissionRunId: null,
    sourceGenerationHash: null,
    submissionRunIds: [runId],
    segments: [directSegmentLineage],
    status: "completed",
    sourceGenerationReceipt: null
  };
  const generation = {
    schemaVersion: 5,
    provider: "gemini-browser",
    jobId,
    runId,
    status: "completed",
    browser: providerAttestation.browser,
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
    requestScriptHash: requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: [],
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    submissionRunIds: [runId],
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
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null,
      targetConversationLineage,
      targetConversationLineageHash: hashJson(targetConversationLineage),
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
      geminiSubmissionLineageBinding: true,
      geminiSubmissionLineage,
      inputManifestBinding: true,
      evidenceHashes: {}
    }
  };
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
  const inputManifestReceipt = { path: inputReceipt.name, sha256: inputReceipt.sha256, entryCount: inputManifest.entries.length };
  baseQuality.metrics.inputManifest = inputManifestReceipt;
  const qualityReceipt = immutableArtifacts.find((artifact) => artifact.name === "quality.json");
  await writeFile(join(jobDir, qualityReceipt.path), `${JSON.stringify(baseQuality, null, 2)}\n`);
  qualityReceipt.bytes = (await stat(join(jobDir, qualityReceipt.path))).size;
  qualityReceipt.sha256 = await hashFile(join(jobDir, qualityReceipt.path));
  const qualitySummary = {
    ...Object.fromEntries(
      ["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"]
        .map((field) => [field, baseQuality[field]])
    ),
    inputManifest: inputManifestReceipt
  };
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
    geminiSubmissionLineage,
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

const LEGACY_EVIDENCE_FIXTURE = new Map([
  ["legacy-gemini-evidence/abandoned-gemini-generation.json", Buffer.from("sealed abandoned generation evidence\n")],
  ["legacy-gemini-evidence/abandonment-receipt.json", Buffer.from("sealed abandonment receipt evidence\n")]
]);

async function addLegacyEvidenceHydrationInputs(fixture, inputs) {
  const entries = [];
  for (const [name, bytes] of LEGACY_EVIDENCE_FIXTURE) {
    const artifact = {
      name,
      path: `runs/${fixture.runId}/artifacts/${name.replace(/[^A-Za-z0-9._-]+/g, "__")}`,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
    await writeFile(join(fixture.jobDir, artifact.path), bytes);
    inputs.manifest.immutableArtifacts.push(artifact);
    inputs.immutableByName.set(name, artifact);
    entries.push({ ...artifact, bytesValue: bytes });
  }
  inputs.legacyNames = [...LEGACY_EVIDENCE_FIXTURE.keys()];
  return entries;
}

async function writeCurrentLegacyEvidence(jobDir, entries) {
  const directory = join(jobDir, "legacy-gemini-evidence");
  await mkdir(directory, { mode: 0o700 });
  for (const entry of entries) {
    const path = join(directory, entry.name.slice("legacy-gemini-evidence/".length));
    await writeFile(path, entry.bytesValue, { mode: 0o600 });
  }
  return directory;
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

test("semantic source closure binds parsing to the exact manifest and generation bytes", async () => {
  const fixture = await createSealedGeminiFixture({ realVideo: true });
  const sourceManifestPath = join(fixture.runDir, "manifest.json");
  const generationPath = join(fixture.jobDir, fixture.generationReceipt.path);
  const manifestBytes = await readFile(sourceManifestPath);
  const generationBytes = await readFile(generationPath);
  const declaration = {
    sourceRunId: fixture.runId,
    parentManifestHash: await hashFile(sourceManifestPath),
    sourceImmutableArtifactsHash: hashJson(fixture.manifest.immutableArtifacts),
    sourceProviderProvenance: { path: fixture.generationReceipt.path, sha256: fixture.generationReceipt.sha256 }
  };
  const childManifest = { jobId: fixture.jobId, parentRunId: fixture.runId, semanticRevalidation: declaration };
  const source = await loadSemanticRevalidationSource(fixture.jobDir, childManifest);
  expect(source).toMatchObject({ sourceRunId: fixture.runId, sourceManifestHash: declaration.parentManifestHash, sourceGenerationFileHash: fixture.generationReceipt.sha256 });

  await writeFile(generationPath, JSON.stringify(JSON.parse(generationBytes.toString("utf8"))));
  await expect(loadSemanticRevalidationSource(fixture.jobDir, childManifest)).rejects.toThrow("generation immutable");
  await writeFile(generationPath, generationBytes);

  await writeFile(sourceManifestPath, JSON.stringify(JSON.parse(manifestBytes.toString("utf8"))));
  await expect(loadSemanticRevalidationSource(fixture.jobDir, childManifest)).rejects.toThrow("parent manifest 해시");
});

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
    let reacquired = null;
    await waitFor(async () => {
      reacquired = await acquireJobLease(fixture.jobId);
      return Boolean(reacquired);
    });
    await reacquired.handle.close();
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
    const sourceGenerationBytes = await readFile(join(fixture.jobDir, "gemini-generation.json"));
    const sourceGeneration = JSON.parse(sourceGenerationBytes.toString("utf8"));

    const result = await generateGeminiClips({
      ...fixture.generationJob,
      runId: childRunId,
      resumeCompletedGenerationRunId: fixture.runId,
      providerRequestsForbidden: true,
      expectedRecoverySourceGenerationReceipt: {
        bytes: sourceGenerationBytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(sourceGenerationBytes).digest("hex")}`,
        sourceRunId: fixture.runId,
        sourceGenerationHash: hashJson(sourceGeneration)
      }
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

  test("parses the source manifest and immutable JSON from their exact verified Buffer snapshots", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const manifestPath = join(fixture.runDir, "manifest.json");
    const scriptDeclaration = fixture.manifest.immutableArtifacts.find((artifact) => artifact.name === "script.json");
    const scriptPath = join(fixture.jobDir, scriptDeclaration.path);
    const replaced = new Set();

    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context, {
      readFileFn: async (path) => {
        const bytes = await readFile(path);
        if ((path === manifestPath || path === scriptPath) && !replaced.has(path)) {
          replaced.add(path);
          await writeFile(path, JSON.stringify({ replacedAfterRead: true }));
        }
        return bytes;
      }
    });

    expect(inputs.manifest).toEqual(fixture.manifest);
    expect(inputs.script).toEqual(fixture.script);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({ replacedAfterRead: true });
    expect(JSON.parse(await readFile(scriptPath, "utf8"))).toEqual({ replacedAfterRead: true });
  });

  test("writes each semantic mutable restore from the same verified source Buffer", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const scriptDeclaration = fixture.manifest.immutableArtifacts.find((artifact) => artifact.name === "script.json");
    const scriptPath = join(fixture.jobDir, scriptDeclaration.path);
    const originalScriptBytes = await readFile(scriptPath);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    let replaced = false;
    let hydration;
    try {
      hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent, {
        readArtifactFn: async (path) => {
          const bytes = await readFile(path);
          if (path === scriptPath && !replaced) {
            replaced = true;
            await writeFile(path, JSON.stringify({ replacedAfterRead: true }));
          }
          return bytes;
        }
      });
      expect(replaced).toBeTrue();
      expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(originalScriptBytes);
      expect(await hashFile(join(fixture.jobDir, "script.json"))).toBe(scriptDeclaration.sha256);
    } finally {
      if (hydration?.transaction) await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("installs an exact empty child normalized directory and rollback restores the parent inode and bytes", async () => {
    const fixture = await createSealedGeminiFixture();
    const normalizedPath = join(fixture.jobDir, "normalized");
    const parentFilePath = join(normalizedPath, "parent-01.mp4");
    await writeFile(parentFilePath, "parent normalized bytes\n");
    const parentDirectoryBefore = await lstat(normalizedPath, { bigint: true });
    const parentFileBefore = await lstat(parentFilePath, { bigint: true });
    const parentBytesBefore = await readFile(parentFilePath);
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });

    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const childDirectory = await lstat(normalizedPath, { bigint: true });
    expect(childDirectory.isDirectory()).toBeTrue();
    expect(childDirectory.isSymbolicLink()).toBeFalse();
    expect(childDirectory.mode & 0o777n).toBe(0o700n);
    expect(childDirectory.ino).not.toBe(parentDirectoryBefore.ino);
    expect(await readdir(normalizedPath)).toEqual([]);
    const backupDirectory = await lstat(join(fixture.jobDir, hydration.transaction.backupDir, "normalized"), { bigint: true });
    expect(backupDirectory.dev).toBe(parentDirectoryBefore.dev);
    expect(backupDirectory.ino).toBe(parentDirectoryBefore.ino);

    await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    const restoredDirectory = await lstat(normalizedPath, { bigint: true });
    const restoredFile = await lstat(parentFilePath, { bigint: true });
    expect(restoredDirectory.dev).toBe(parentDirectoryBefore.dev);
    expect(restoredDirectory.ino).toBe(parentDirectoryBefore.ino);
    expect(restoredDirectory.mode).toBe(parentDirectoryBefore.mode);
    expect(restoredFile.dev).toBe(parentFileBefore.dev);
    expect(restoredFile.ino).toBe(parentFileBefore.ino);
    expect(await readFile(parentFilePath)).toEqual(parentBytesBefore);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
  });

  test("rolls back the journal and backup when exclusive child normalized creation fails", async () => {
    const fixture = await createSealedGeminiFixture();
    const normalizedPath = join(fixture.jobDir, "normalized");
    const parentFilePath = join(normalizedPath, "parent-01.mp4");
    await writeFile(parentFilePath, "parent normalized bytes\n");
    const parentDirectoryBefore = await lstat(normalizedPath, { bigint: true });
    const parentFileBefore = await lstat(parentFilePath, { bigint: true });
    const parentBytesBefore = await readFile(parentFilePath);
    const parentJobBefore = await readFile(join(fixture.jobDir, "job.json"));
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    let observedDurableTransaction = false;

    await expect(hydrateGeminiSemanticRevalidationInputs(
      fixture.jobDir,
      childDir,
      childRunId,
      inputs,
      parent,
      {
        beforeNormalizedCreate: async () => {
          const marker = JSON.parse(await readFile(join(fixture.jobDir, ".semantic-revalidation-transaction.json"), "utf8"));
          expect(marker).toMatchObject({ phase: "prepared", childRunId });
          expect((await lstat(join(fixture.jobDir, marker.backupDir, "normalized"))).isDirectory()).toBeTrue();
          observedDurableTransaction = true;
          await writeFile(normalizedPath, "exclusive-create-collision", { flag: "wx" });
        }
      }
    )).rejects.toThrow();

    expect(observedDurableTransaction).toBeTrue();
    const restoredDirectory = await lstat(normalizedPath, { bigint: true });
    const restoredFile = await lstat(parentFilePath, { bigint: true });
    expect(restoredDirectory.isDirectory()).toBeTrue();
    expect(restoredDirectory.isSymbolicLink()).toBeFalse();
    expect(restoredDirectory.dev).toBe(parentDirectoryBefore.dev);
    expect(restoredDirectory.ino).toBe(parentDirectoryBefore.ino);
    expect(restoredFile.dev).toBe(parentFileBefore.dev);
    expect(restoredFile.ino).toBe(parentFileBefore.ino);
    expect(await readFile(parentFilePath)).toEqual(parentBytesBefore);
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentJobBefore);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
  });

  test("rejects hardlinked, symlinked, and foreign legacy evidence before the first workspace mutation", async () => {
    for (const attack of ["hardlink", "symlink", "foreign"]) {
      const fixture = await createSealedGeminiFixture();
      const parent = await readJob(fixture.jobId);
      const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
      const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
      const entries = await addLegacyEvidenceHydrationInputs(fixture, inputs);
      const evidenceDirectory = join(fixture.jobDir, "legacy-gemini-evidence");
      const externalJobId = `external-${randomUUID()}`;
      const externalDirectory = join(JOBS_DIR, externalJobId);
      createdJobs.push(externalJobId);
      await mkdir(evidenceDirectory, { mode: 0o700 });
      await mkdir(externalDirectory, { mode: 0o700 });
      const externalPaths = [];
      for (const entry of entries) {
        const leafName = entry.name.slice("legacy-gemini-evidence/".length);
        const externalPath = join(externalDirectory, `${attack}-${leafName}`);
        await writeFile(externalPath, entry.bytesValue, { mode: 0o600 });
        externalPaths.push(externalPath);
        if (attack === "hardlink") await link(externalPath, join(evidenceDirectory, leafName));
        else if (attack === "symlink") await symlink(externalPath, join(evidenceDirectory, leafName));
        else await writeFile(join(evidenceDirectory, leafName), entry.bytesValue, { mode: 0o600 });
      }
      if (attack === "foreign") await writeFile(join(evidenceDirectory, "foreign.json"), "foreign evidence\n", { mode: 0o600 });
      const childRunId = `child-${randomUUID()}`;
      const childDir = join(fixture.jobDir, "runs", childRunId);
      await mkdir(childDir, { recursive: true });
      const beforeJobDirectory = await lstat(fixture.jobDir, { bigint: true });
      const beforeExternal = await Promise.all(externalPaths.map(async (path) => ({
        path,
        bytes: await readFile(path),
        stat: await lstat(path, { bigint: true })
      })));

      await expect(hydrateGeminiSemanticRevalidationInputs(
        fixture.jobDir,
        childDir,
        childRunId,
        inputs,
        parent
      )).rejects.toThrow(attack === "hardlink" ? "bounded single-link regular file" : attack === "foreign" ? "foreign" : "안전하게 열 수 없습니다");

      const afterJobDirectory = await lstat(fixture.jobDir, { bigint: true });
      for (const field of ["dev", "ino", "nlink", "mode", "mtimeNs", "ctimeNs"]) {
        expect(afterJobDirectory[field]).toBe(beforeJobDirectory[field]);
      }
      for (const before of beforeExternal) {
        const after = await lstat(before.path, { bigint: true });
        expect(await readFile(before.path)).toEqual(before.bytes);
        for (const field of ["dev", "ino", "nlink", "mode", "mtimeNs", "ctimeNs"]) expect(after[field]).toBe(before.stat[field]);
      }
      expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
    }
  });

  test("restores the exact parent legacy evidence inode and leaves after a post-install fault", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const entries = await addLegacyEvidenceHydrationInputs(fixture, inputs);
    const evidenceDirectory = await writeCurrentLegacyEvidence(fixture.jobDir, entries);
    const beforeDirectory = await lstat(evidenceDirectory, { bigint: true });
    const beforeLeaves = new Map(await Promise.all(entries.map(async (entry) => {
      const path = join(fixture.jobDir, entry.name);
      return [entry.name, { bytes: await readFile(path), stat: await lstat(path, { bigint: true }) }];
    })));
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    let observedChildInstall = false;

    await expect(hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent, {
      renameEntry: async (source, destination) => {
        if (destination === join(childDir, "benchmarks", "channel-analysis.json")) {
          const childDirectory = await lstat(evidenceDirectory, { bigint: true });
          expect(childDirectory.ino).not.toBe(beforeDirectory.ino);
          observedChildInstall = true;
          throw new Error("injected post-legacy-install fault");
        }
        return rename(source, destination);
      }
    })).rejects.toThrow("injected post-legacy-install fault");

    expect(observedChildInstall).toBeTrue();
    const afterDirectory = await lstat(evidenceDirectory, { bigint: true });
    expect(afterDirectory.dev).toBe(beforeDirectory.dev);
    expect(afterDirectory.ino).toBe(beforeDirectory.ino);
    expect(afterDirectory.mode).toBe(beforeDirectory.mode);
    for (const entry of entries) {
      const path = join(fixture.jobDir, entry.name);
      const after = await lstat(path, { bigint: true });
      const before = beforeLeaves.get(entry.name);
      expect(await readFile(path)).toEqual(before.bytes);
      expect(after.dev).toBe(before.stat.dev);
      expect(after.ino).toBe(before.stat.ino);
      expect(after.mode).toBe(before.stat.mode);
    }
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
  });

  test("committed recovery keeps exact child legacy evidence and durably cleans the parent backup", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const entries = await addLegacyEvidenceHydrationInputs(fixture, inputs);
    const evidenceDirectory = await writeCurrentLegacyEvidence(fixture.jobDir, entries);
    const parentDirectory = await lstat(evidenceDirectory, { bigint: true });
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const childDirectory = await lstat(evidenceDirectory, { bigint: true });
    expect(childDirectory.ino).not.toBe(parentDirectory.ino);
    expect((await lstat(join(fixture.jobDir, hydration.transaction.backupDir, "legacy-gemini-evidence"), { bigint: true })).ino).toBe(parentDirectory.ino);
    for (const entry of entries) {
      expect(await hashFile(join(fixture.jobDir, entry.name))).toBe(entry.sha256);
      expect((await lstat(join(fixture.jobDir, entry.name), { bigint: true })).mode & 0o777n).toBe(0o600n);
    }

    const committed = await commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      removeBackup: async () => { throw new Error("injected committed cleanup crash"); }
    });
    expect(committed.phase).toBe("committed");
    expect((await readSemanticTransactionStrict(fixture.jobDir)).phase).toBe("committed");
    expect((await lstat(join(fixture.jobDir, committed.backupDir))).isDirectory()).toBeTrue();
    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("committed-cleanup");
    expect(await stat(join(fixture.jobDir, committed.backupDir)).catch(() => null)).toBeNull();
    expect(await readSemanticTransactionStrict(fixture.jobDir)).toBeNull();
    const recoveredChildDirectory = await lstat(evidenceDirectory, { bigint: true });
    expect(recoveredChildDirectory.dev).toBe(childDirectory.dev);
    expect(recoveredChildDirectory.ino).toBe(childDirectory.ino);
    for (const entry of entries) expect(await hashFile(join(fixture.jobDir, entry.name))).toBe(entry.sha256);
  });

  test("prepared-phase crash recovery restores the parent legacy evidence root", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const entries = await addLegacyEvidenceHydrationInputs(fixture, inputs);
    const evidenceDirectory = await writeCurrentLegacyEvidence(fixture.jobDir, entries);
    const parentDirectory = await lstat(evidenceDirectory, { bigint: true });
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    await writeFile(markerPath, `${JSON.stringify({ ...hydration.transaction, phase: "prepared" }, null, 2)}\n`, { mode: 0o600 });

    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("rolled-back");
    const restored = await lstat(evidenceDirectory, { bigint: true });
    expect(restored.dev).toBe(parentDirectory.dev);
    expect(restored.ino).toBe(parentDirectory.ino);
    for (const entry of entries) expect(await hashFile(join(fixture.jobDir, entry.name))).toBe(entry.sha256);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
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
    await writeFile(join(fixture.jobDir, "gemini-legacy-abandonment.json"), "append-only abandonment evidence\n");
    const beforeJob = await readFile(join(fixture.jobDir, "job.json"));
    const beforeHashes = Object.fromEntries(await Promise.all([
      ...Object.keys(originalFiles),
      "clips/parent.mp4",
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

  test("uses O_NOFOLLOW on the marker fd and rejects a symlink swap before direct recovery mutates bytes", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const preservedMarkerPath = join(fixture.jobDir, `.semantic-revalidation-preserved-${randomUUID()}`);
    const before = {
      job: await readFile(join(fixture.jobDir, "job.json")),
      sourceManifest: await readFile(join(fixture.runDir, "manifest.json")),
      installedScript: await readFile(join(fixture.jobDir, "script.json")),
      marker: await readFile(markerPath)
    };
    let swapped = false;
    try {
      await expect(readSemanticTransactionStrict(fixture.jobDir, {
        beforeMarkerOpen: async () => {
          if (!swapped) {
            swapped = true;
            await rename(markerPath, preservedMarkerPath);
            await symlink(preservedMarkerPath, markerPath);
          }
        }
      })).rejects.toThrow();
      expect(swapped).toBeTrue();
      await expect(recoverSemanticRevalidationWorkspace(fixture.jobDir)).rejects.toThrow();
      expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(before.job);
      expect(await readFile(join(fixture.runDir, "manifest.json"))).toEqual(before.sourceManifest);
      expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(before.installedScript);
      expect(await readFile(preservedMarkerPath)).toEqual(before.marker);
    } finally {
      await unlink(markerPath).catch(() => {});
      await rename(preservedMarkerPath, markerPath).catch(() => {});
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("rejects a hardlinked canonical marker before rollback or commit can mutate workspace or external metadata", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
    const externalId = `external-${randomUUID()}`;
    createdJobs.push(externalId);
    const externalDir = join(JOBS_DIR, externalId);
    const externalMarkerPath = join(externalDir, "external-marker.json");
    await mkdir(externalDir, { mode: 0o700 });
    await link(markerPath, externalMarkerPath);
    const protectedFiles = [
      join(fixture.jobDir, "job.json"),
      join(fixture.jobDir, "script.json"),
      markerPath,
      externalMarkerPath
    ];
    const before = new Map(await Promise.all(protectedFiles.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));
    const backupBefore = await lstat(backupPath, { bigint: true });
    const externalDirBefore = await lstat(externalDir, { bigint: true });
    try {
      await expect(readSemanticTransactionStrict(fixture.jobDir)).rejects.toThrow("bounded single-link regular file");
      await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow("bounded single-link regular file");
      await expect(commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow("bounded single-link regular file");
      for (const path of protectedFiles) {
        const current = await stat(path, { bigint: true });
        expect(await readFile(path)).toEqual(before.get(path).bytes);
        expect(current.dev).toBe(before.get(path).stat.dev);
        expect(current.ino).toBe(before.get(path).stat.ino);
        expect(current.nlink).toBe(before.get(path).stat.nlink);
        expect(current.mtimeNs).toBe(before.get(path).stat.mtimeNs);
        expect(current.ctimeNs).toBe(before.get(path).stat.ctimeNs);
      }
      const backupAfter = await lstat(backupPath, { bigint: true });
      expect(backupAfter.dev).toBe(backupBefore.dev);
      expect(backupAfter.ino).toBe(backupBefore.ino);
      const externalDirAfter = await lstat(externalDir, { bigint: true });
      expect(externalDirAfter.dev).toBe(externalDirBefore.dev);
      expect(externalDirAfter.ino).toBe(externalDirBefore.ino);
      expect(externalDirAfter.mtimeNs).toBe(externalDirBefore.mtimeNs);
      expect(externalDirAfter.ctimeNs).toBe(externalDirBefore.ctimeNs);
    } finally {
      await unlink(markerPath).catch(() => {});
      await rename(externalMarkerPath, markerPath).catch(() => {});
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("rejects a sparse oversized marker before rollback or commit mutates the prepared transaction", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const preservedMarkerPath = join(fixture.jobDir, `.semantic-revalidation-preserved-${randomUUID()}`);
    const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
    await rename(markerPath, preservedMarkerPath);
    const sparse = await open(markerPath, "wx", 0o600);
    try {
      await sparse.truncate(4 * 1024 * 1024 + 1);
    } finally {
      await sparse.close();
    }
    const before = {
      job: await readFile(join(fixture.jobDir, "job.json")),
      script: await readFile(join(fixture.jobDir, "script.json")),
      marker: await stat(markerPath, { bigint: true }),
      preserved: await readFile(preservedMarkerPath),
      backup: await lstat(backupPath, { bigint: true })
    };
    try {
      await expect(readSemanticTransactionStrict(fixture.jobDir)).rejects.toThrow("bounded single-link regular file");
      await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow("bounded single-link regular file");
      await expect(commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow("bounded single-link regular file");
      expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(before.job);
      expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(before.script);
      expect((await stat(markerPath, { bigint: true })).size).toBe(before.marker.size);
      expect(await readFile(preservedMarkerPath)).toEqual(before.preserved);
      const backupAfter = await lstat(backupPath, { bigint: true });
      expect(backupAfter.dev).toBe(before.backup.dev);
      expect(backupAfter.ino).toBe(before.backup.ino);
    } finally {
      await rm(markerPath, { force: true });
      await rename(preservedMarkerPath, markerPath).catch(() => {});
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("rejects invalid UTF-8 and invalid JSON markers before any recovery mutation", async () => {
    for (const attack of [
      { name: "invalid UTF-8", bytes: Buffer.from([0xff, 0xfe, 0xfd]), message: "올바른 UTF-8" },
      { name: "invalid JSON", bytes: Buffer.from("{\"phase\":", "utf8"), message: "JSON이 유효하지" }
    ]) {
      const fixture = await createSealedGeminiFixture({ realVideo: true });
      await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
      const parent = await readJob(fixture.jobId);
      const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
      const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
      const childRunId = `child-${randomUUID()}`;
      const childDir = join(fixture.jobDir, "runs", childRunId);
      await mkdir(childDir, { recursive: true });
      const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
      const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
      const preservedMarkerPath = join(fixture.jobDir, `.semantic-revalidation-preserved-${randomUUID()}`);
      const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
      await rename(markerPath, preservedMarkerPath);
      await writeFile(markerPath, attack.bytes, { flag: "wx", mode: 0o600 });
      const before = {
        job: await readFile(join(fixture.jobDir, "job.json")),
        script: await readFile(join(fixture.jobDir, "script.json")),
        marker: await readFile(markerPath),
        preserved: await readFile(preservedMarkerPath),
        backup: await lstat(backupPath, { bigint: true })
      };
      try {
        await expect(readSemanticTransactionStrict(fixture.jobDir)).rejects.toThrow(attack.message);
        await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow(attack.message);
        await expect(commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction)).rejects.toThrow(attack.message);
        expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(before.job);
        expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(before.script);
        expect(await readFile(markerPath)).toEqual(before.marker);
        expect(await readFile(preservedMarkerPath)).toEqual(before.preserved);
        const backupAfter = await lstat(backupPath, { bigint: true });
        expect(backupAfter.dev).toBe(before.backup.dev);
        expect(backupAfter.ino).toBe(before.backup.ino);
      } finally {
        await rm(markerPath, { force: true });
        await rename(preservedMarkerPath, markerPath).catch(() => {});
        await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
      }
    }
  });

  test("rejects directory and FIFO transaction markers as non-regular without blocking", async () => {
    const fixture = await createSealedGeminiFixture();
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    await mkdir(markerPath);
    await expect(readSemanticTransactionStrict(fixture.jobDir)).rejects.toThrow("bounded single-link regular file");
    await rm(markerPath, { recursive: true, force: true });

    const mkfifo = Bun.spawn(["mkfifo", markerPath], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(mkfifo.stderr).text();
    if (await mkfifo.exited !== 0) throw new Error(`mkfifo fixture failed: ${stderr}`);
    const startedAt = Date.now();
    await expect(readSemanticTransactionStrict(fixture.jobDir)).rejects.toThrow("bounded single-link regular file");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("rejects traversal and corrupt parent bytes before any rollback mutation", async () => {
    const fixture = await createSealedGeminiFixture();
    await writeFile(join(fixture.jobDir, "script.json"), "sentinel parent bytes\n");
    const sentinelHash = await hashFile(join(fixture.jobDir, "script.json"));
    const parent = await readJob(fixture.jobId);
    const parentBytes = await readFile(join(fixture.jobDir, "job.json"));
    const childRunId = `child-${randomUUID()}`;
    const base = {
      schemaVersion: 1,
      mode: SEMANTIC_REVALIDATION_MODE,
      phase: "prepared",
      jobId: fixture.jobId,
      sourceRunId: fixture.runId,
      childRunId,
      backupDir: `.semantic-revalidation-backup-${childRunId}`,
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

  test("rejects malformed embedded parent job UTF-8 before rollback or commit can mutate anything", async () => {
    for (const malformedBytes of [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")])]) {
      const fixture = await createSealedGeminiFixture();
      await writeFile(join(fixture.jobDir, "script.json"), "parent embedded UTF-8 sentinel\n");
      const parent = await readJob(fixture.jobId);
      const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
      const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
      const childRunId = `child-${randomUUID()}`;
      const childDir = join(fixture.jobDir, "runs", childRunId);
      await mkdir(childDir, { recursive: true });
      const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
      const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
      const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
      const corrupt = {
        ...hydration.transaction,
        parentJobBytesBase64: malformedBytes.toString("base64"),
        parentJobBytesSha256: `sha256:${createHash("sha256").update(malformedBytes).digest("hex")}`
      };
      await writeFile(markerPath, `${JSON.stringify(corrupt, null, 2)}\n`, { mode: 0o600 });
      const externalId = `external-${randomUUID()}`;
      const externalDir = join(JOBS_DIR, externalId);
      createdJobs.push(externalId);
      await mkdir(externalDir);
      const externalPath = join(externalDir, "sentinel.txt");
      await writeFile(externalPath, "external embedded UTF-8 sentinel\n");
      const paths = [join(fixture.jobDir, "job.json"), join(fixture.jobDir, "script.json"), markerPath, externalPath];
      const before = new Map(await Promise.all(paths.map(async (path) => [path, {
        bytes: await readFile(path),
        stat: await lstat(path, { bigint: true })
      }])));
      const backupBefore = await lstat(backupPath, { bigint: true });

      await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir)).rejects.toThrow("BOM 없는 올바른 UTF-8");
      await expect(commitSemanticRevalidationWorkspace(fixture.jobDir, corrupt)).rejects.toThrow("BOM 없는 올바른 UTF-8");
      for (const path of paths) {
        const after = await lstat(path, { bigint: true });
        expect(await readFile(path)).toEqual(before.get(path).bytes);
        for (const field of ["dev", "ino", "nlink", "mode", "mtimeNs", "ctimeNs"]) expect(after[field]).toBe(before.get(path).stat[field]);
      }
      const backupAfter = await lstat(backupPath, { bigint: true });
      expect(backupAfter.dev).toBe(backupBefore.dev);
      expect(backupAfter.ino).toBe(backupBefore.ino);

      await writeFile(markerPath, `${JSON.stringify(hydration.transaction, null, 2)}\n`, { mode: 0o600 });
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("rejects a foreign self-consistent journal before it can overwrite this job", async () => {
    const fixture = await createSealedGeminiFixture();
    const targetJobPath = join(fixture.jobDir, "job.json");
    const targetScriptPath = join(fixture.jobDir, "script.json");
    await writeFile(targetScriptPath, "target job script bytes\n");
    const originalJob = await readJob(fixture.jobId);
    const foreignJobId = `foreign-${randomUUID()}`;
    const foreignSourceRunId = `source-${randomUUID()}`;
    const foreignChildRunId = `child-${randomUUID()}`;
    const backupDir = join(fixture.jobDir, `.semantic-revalidation-backup-${foreignChildRunId}`);
    await mkdir(backupDir);
    await writeFile(join(backupDir, "script.json"), "foreign rollback source\n");
    const foreignParentJob = {
      ...originalJob,
      id: foreignJobId,
      runId: foreignSourceRunId
    };
    const foreignParentBytes = Buffer.from(JSON.stringify(foreignParentJob, null, 2));
    const foreignJournal = {
      schemaVersion: 1,
      mode: SEMANTIC_REVALIDATION_MODE,
      phase: "installed",
      jobId: foreignJobId,
      sourceRunId: foreignSourceRunId,
      childRunId: foreignChildRunId,
      backupDir: `.semantic-revalidation-backup-${foreignChildRunId}`,
      mutableEntries: ["script.json"],
      parentJob: foreignParentJob,
      parentJobBytesBase64: foreignParentBytes.toString("base64"),
      parentJobBytesSha256: `sha256:${createHash("sha256").update(foreignParentBytes).digest("hex")}`
    };
    const beforeJobBytes = await readFile(targetJobPath);
    const beforeScriptBytes = await readFile(targetScriptPath);
    const beforeJobStat = await stat(targetJobPath, { bigint: true });
    const beforeScriptStat = await stat(targetScriptPath, { bigint: true });

    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, foreignJournal)).rejects.toThrow("journal 형식");

    expect(await readFile(targetJobPath)).toEqual(beforeJobBytes);
    expect(await readFile(targetScriptPath)).toEqual(beforeScriptBytes);
    expect((await stat(targetJobPath, { bigint: true })).mtimeNs).toBe(beforeJobStat.mtimeNs);
    expect((await stat(targetScriptPath, { bigint: true })).mtimeNs).toBe(beforeScriptStat.mtimeNs);
  });

  test("detects a backup-directory symlink swap without touching job or external sentinel bytes", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
    const preservedBackupPath = join(fixture.jobDir, `.semantic-revalidation-preserved-backup-${randomUUID()}`);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const jobPath = join(fixture.jobDir, "job.json");
    const scriptPath = join(fixture.jobDir, "script.json");
    const manifestPath = join(fixture.runDir, "manifest.json");
    const externalId = `external-${randomUUID()}`;
    createdJobs.push(externalId);
    const externalDir = join(JOBS_DIR, externalId);
    const sentinelPath = join(externalDir, "sentinel.txt");
    await mkdir(externalDir);
    await writeFile(sentinelPath, "external sentinel bytes\n");
    const protectedPaths = [jobPath, scriptPath, manifestPath, markerPath, sentinelPath];
    const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
      bytes: await readFile(path),
      stat: await stat(path, { bigint: true })
    }])));
    let swapped = false;
    try {
      await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
        beforeBackupMutation: async () => {
          if (swapped) return;
          swapped = true;
          await rename(backupPath, preservedBackupPath);
          await symlink(externalDir, backupPath);
        }
      })).rejects.toThrow(/non-symlink|교체/);
      expect(swapped).toBeTrue();
      for (const path of protectedPaths) {
        expect(await readFile(path)).toEqual(before.get(path).bytes);
        expect((await stat(path, { bigint: true })).mtimeNs).toBe(before.get(path).stat.mtimeNs);
      }
    } finally {
      await unlink(backupPath).catch(() => {});
      await rename(preservedBackupPath, backupPath).catch(() => {});
      await rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction);
    }
  });

  test("keeps a durable rolled-back marker when backup-deletion fsync fails, then restart finishes cleanup", async () => {
    const fixture = await createSealedGeminiFixture({ realVideo: true });
    await writeFile(join(fixture.jobDir, "script.json"), "parent mutable script\n");
    const parent = await readJob(fixture.jobId);
    const parentBytes = await readFile(join(fixture.jobDir, "job.json"));
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
    const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);
    await writeFile(join(fixture.jobDir, "job.json"), JSON.stringify({
      ...parent,
      runId: childRunId,
      status: "running",
      runStatus: "running"
    }, null, 2));
    const cleanupOrder = [];

    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      onRecoveryCleanupStep: ({ operation }) => cleanupOrder.push(operation),
      syncCleanupDirectoryFn: async (path) => {
        expect(path).toBe(fixture.jobDir);
        cleanupOrder.push("directory-fsync-attempt");
        throw new Error("injected final rollback directory fsync failure");
      }
    })).rejects.toThrow("injected final rollback directory fsync failure");

    expect(cleanupOrder).toEqual(["terminal-marker-durable", "backup-remove", "directory-fsync-attempt"]);
    expect(await stat(backupPath).catch(() => null)).toBeNull();
    expect((await readSemanticTransactionStrict(fixture.jobDir)).phase).toBe("rolled-back");
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentBytes);
    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("rolled-back-cleanup");
    expect(await stat(markerPath).catch(() => null)).toBeNull();
  });

  test("restarts every rolled-back cleanup boundary without losing restored parent bytes", async () => {
    for (const crashOperation of ["terminal-marker-durable", "backup-remove-directory-fsync", "before-marker-remove", "marker-remove-directory-fsync"]) {
      const fixture = await createSealedGeminiFixture();
      await writeFile(join(fixture.jobDir, "script.json"), "parent rollback boundary bytes\n");
      const parent = await readJob(fixture.jobId);
      const parentJobBytes = await readFile(join(fixture.jobDir, "job.json"));
      const parentScriptBytes = await readFile(join(fixture.jobDir, "script.json"));
      const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
      const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
      const childRunId = `child-${randomUUID()}`;
      const childDir = join(fixture.jobDir, "runs", childRunId);
      await mkdir(childDir, { recursive: true });
      const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
      const markerPath = join(fixture.jobDir, ".semantic-revalidation-transaction.json");
      const backupPath = join(fixture.jobDir, hydration.transaction.backupDir);

      await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
        onRecoveryCleanupStep: ({ operation }) => {
          if (operation === crashOperation) throw new Error(`injected crash at ${crashOperation}`);
        }
      })).rejects.toThrow(`injected crash at ${crashOperation}`);

      expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentJobBytes);
      expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(parentScriptBytes);
      const marker = await readSemanticTransactionStrict(fixture.jobDir);
      if (crashOperation === "marker-remove-directory-fsync") {
        expect(marker).toBeNull();
        expect(await stat(backupPath).catch(() => null)).toBeNull();
      } else {
        expect(marker.phase).toBe("rolled-back");
        expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("rolled-back-cleanup");
      }
      expect(await stat(markerPath).catch(() => null)).toBeNull();
      expect(await stat(backupPath).catch(() => null)).toBeNull();
      expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentJobBytes);
      expect(await readFile(join(fixture.jobDir, "script.json"))).toEqual(parentScriptBytes);
    }
  });

  test("rolled-back recovery expects no legacy root when evidence was required only for the child", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const parentJobBytes = await readFile(join(fixture.jobDir, "job.json"));
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    await addLegacyEvidenceHydrationInputs(fixture, inputs);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    expect(hydration.transaction.legacyEvidence).toMatchObject({ required: true, previousPresent: false });
    expect((await lstat(join(fixture.jobDir, "legacy-gemini-evidence"))).isDirectory()).toBeTrue();

    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      onRecoveryCleanupStep: ({ operation }) => {
        if (operation === "terminal-marker-durable") throw new Error("injected crash after rolled-back CAS without parent legacy root");
      }
    })).rejects.toThrow("injected crash after rolled-back CAS without parent legacy root");

    expect((await readSemanticTransactionStrict(fixture.jobDir)).phase).toBe("rolled-back");
    expect(await stat(join(fixture.jobDir, "legacy-gemini-evidence")).catch(() => null)).toBeNull();
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentJobBytes);
    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("rolled-back-cleanup");
    expect(await readSemanticTransactionStrict(fixture.jobDir)).toBeNull();
    expect(await stat(join(fixture.jobDir, "legacy-gemini-evidence")).catch(() => null)).toBeNull();
  });

  test("restarts an installed transaction after legacy evidence was already restored before terminal CAS", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const parentJobBytes = await readFile(join(fixture.jobDir, "job.json"));
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const entries = await addLegacyEvidenceHydrationInputs(fixture, inputs);
    const evidenceDirectory = await writeCurrentLegacyEvidence(fixture.jobDir, entries);
    const parentEvidence = await lstat(evidenceDirectory, { bigint: true });
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    let injected = false;
    await expect(rollbackSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      afterLegacyEvidenceRestore: () => {
        injected = true;
        throw new Error("injected crash after legacy restore before terminal CAS");
      }
    })).rejects.toThrow("injected crash after legacy restore before terminal CAS");
    expect(injected).toBeTrue();
    expect((await readSemanticTransactionStrict(fixture.jobDir)).phase).toBe("installed");
    expect((await lstat(evidenceDirectory, { bigint: true })).ino).toBe(parentEvidence.ino);
    expect(await stat(join(fixture.jobDir, hydration.transaction.backupDir, "legacy-gemini-evidence")).catch(() => null)).toBeNull();

    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("rolled-back");
    expect(await readFile(join(fixture.jobDir, "job.json"))).toEqual(parentJobBytes);
    expect((await lstat(evidenceDirectory, { bigint: true })).ino).toBe(parentEvidence.ino);
    expect((await readdir(fixture.jobDir)).filter((name) => name.startsWith(".semantic-revalidation-"))).toEqual([]);
  });

  test("terminal committed recovery tolerates a partially removed disposable backup", async () => {
    const fixture = await createSealedGeminiFixture();
    const parent = await readJob(fixture.jobId);
    const context = await prepareSemanticRevalidationContext(parent, fixture.runId);
    const inputs = await readGeminiSemanticRevalidationInputs(parent, fixture.jobDir, context);
    const childRunId = `child-${randomUUID()}`;
    const childDir = join(fixture.jobDir, "runs", childRunId);
    await mkdir(childDir, { recursive: true });
    const hydration = await hydrateGeminiSemanticRevalidationInputs(fixture.jobDir, childDir, childRunId, inputs, parent);
    const committed = await commitSemanticRevalidationWorkspace(fixture.jobDir, hydration.transaction, {
      removeBackup: async (path) => {
        const names = await readdir(path);
        if (names.length) await rm(join(path, names[0]), { recursive: true, force: true });
        throw new Error("injected partial committed backup removal");
      }
    });
    expect(committed.phase).toBe("committed");
    expect((await readSemanticTransactionStrict(fixture.jobDir)).phase).toBe("committed");
    expect((await recoverSemanticRevalidationWorkspace(fixture.jobDir)).action).toBe("committed-cleanup");
    expect(await readSemanticTransactionStrict(fixture.jobDir)).toBeNull();
    expect(await stat(join(fixture.jobDir, committed.backupDir)).catch(() => null)).toBeNull();
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
    expect(result.semanticRevalidationFailure.message).toContain("Gemini provider 실행이 실패");
    expect(result.semanticRevalidationFailure.code).not.toContain("shot pattern plan");
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
