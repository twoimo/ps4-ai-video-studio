import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

import {
  buildGeminiGenerationRequest,
  canonicalGeminiResumeScriptHash,
  geminiTargetConversationLineage
} from "../src/gemini-browser.mjs";
import {
  JOBS_DIR,
  evidenceFallbackScript,
  readJob,
  runJob
} from "../src/pipeline.mjs";
import {
  canonicalGeminiObservedRuntimeProof,
  canonicalGeminiSessionBinding,
  canonicalJsonHash,
  geminiObservedRuntimeProofHash
} from "../src/provenance.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import {
  applyShotPatternsToScript,
  buildGeminiClipPrompt,
  providerPromptBindingForSegment,
  readShotPatternCatalog
} from "../src/shot-patterns.mjs";
import {
  LOCAL_SEMANTIC_MODEL,
  semanticFramePlan
} from "../src/local-semantic-verifier.mjs";
import {
  createSessionToken,
  createStudioRequestHandler
} from "../src/server.mjs";

const ORIGIN = "http://127.0.0.1:3000";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function postRequest(path, token, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${token}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function getRequest(path, token, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...headers
    }
  });
}

function sourceFixture() {
  const quote = "궁궐 돌바닥의 틈은 빗물이 빠져나가는 통로가 되기 때문에 마당의 배수에 도움을 준다.";
  const bytes = Buffer.from(quote);
  return {
    title: "공식 궁궐 건축 배수 기록",
    url: "https://records.example.org/palace-drainage",
    fetchStatus: "fetched",
    httpStatus: 200,
    contentType: "text/plain; charset=utf-8",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    resolvedAddress: "93.184.216.34",
    resolvedFamily: 4,
    excerpt: quote,
    evidence: [{
      id: "excerpt-1",
      locator: `text-offset:0-${quote.length}`,
      quote,
      relevance: { matchedTerms: ["궁궐", "배수"], contextDistance: 0 }
    }]
  };
}

async function buildFixtureScript(job) {
  const script = evidenceFallbackScript(
    job.topic,
    job.clipCount,
    job.sources,
    job.targetDurationSec,
    job.format
  );
  return applyShotPatternsToScript(script, job, await readShotPatternCatalog());
}

async function runCommand(command, args) {
  const child = Bun.spawn({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) throw new Error(`${command} failed (${exitCode}): ${stderr.slice(-2_000)}`);
}

async function writeDeterministicMotionClip(path, durationSec) {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("offline lifecycle fixture requires ffmpeg");
  await runCommand(ffmpeg, [
    "-v", "error",
    "-y",
    "-f", "lavfi",
    "-i", `testsrc2=size=360x640:rate=30:duration=${durationSec}`,
    "-f", "lavfi",
    "-i", `sine=frequency=330:sample_rate=48000:duration=${durationSec}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-shortest",
    path
  ]);
}

async function simulateSchema5GeminiGeneration(job, script) {
  const jobDir = join(JOBS_DIR, job.id);
  const runId = job.runId;
  const clipPath = join(jobDir, "clips", "01.mp4");
  await writeDeterministicMotionClip(clipPath, job.targetDurationSec);
  const clipSha256 = await hashFile(clipPath);
  const request = buildGeminiGenerationRequest(job, script);
  const scriptHash = canonicalJsonHash(script);
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const requestHash = canonicalJsonHash({ ...request, scriptHash });
  const resumeRequestHash = canonicalJsonHash({ ...request, scriptHash: resumeScriptHash });
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const providerDecisionHash = canonicalJsonHash(providerDecision);
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const sessionBindingHash = canonicalJsonHash(sessionBinding);
  const browser = "Chrome/151.0.7922.109";
  const version = {
    product: browser,
    userAgent: "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36",
    protocolVersion: "1.3",
    revision: "offline-lifecycle-simulator"
  };
  const runtimeProof = canonicalGeminiObservedRuntimeProof({
    job,
    version,
    commandLine: {
      arguments: [
        "chrome",
        `--user-data-dir=${job.geminiProfileDir}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${new URL(job.geminiCdpUrl).port}`,
        "--headless=new"
      ]
    }
  });
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser,
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: true,
    headlessRequested: true,
    chromeMajor: 151,
    headlessImplementation: "new",
    runtimeProof,
    runtimeProofHash: geminiObservedRuntimeProofHash(runtimeProof),
    fallbackUsed: false
  };
  const providerAttestationHash = canonicalJsonHash(providerAttestation);
  const prompt = buildGeminiClipPrompt(job, script, script.segments[0]);
  const promptBinding = providerPromptBindingForSegment(script.segments[0], "gemini-browser");
  const target = geminiTargetConversationLineage(
    "offline-simulated-target",
    "https://gemini.google.com/app/offline-simulated-conversation"
  );
  const now = new Date().toISOString();
  const generation = {
    schemaVersion: 5,
    provider: "gemini-browser",
    jobId: job.id,
    runId,
    status: "completed",
    browser,
    startedAt: now,
    completedAt: now,
    request,
    requestHash,
    requestScriptHash: requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
    sessionBinding,
    sessionBindingHash,
    providerDecision,
    providerDecisionHash,
    providerAttestation,
    providerAttestationHash,
    segments: [{
      index: 1,
      runId,
      submissionRunId: runId,
      requestHash,
      scriptHash,
      resumeRequestHash,
      resumeScriptHash,
      providerDecisionHash,
      providerAttestationHash,
      durationHint: script.segments[0].durationHint,
      prompt,
      promptHash: canonicalJsonHash({ prompt }),
      providerVisualPromptHash: promptBinding.providerVisualPromptHash,
      shotPattern: promptBinding.shotPattern,
      targetConversationLineage: target.lineage,
      targetConversationLineageHash: target.lineageHash,
      submittedToProvider: true,
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceRunId: null,
      sourceGenerationHash: null,
      submissionAcknowledgement: {
        verified: true,
        clickCount: 1,
        evidenceTypes: ["offline-deterministic-provider-simulator"]
      },
      path: "clips/01.mp4",
      output: "clips/01.mp4",
      sha256: clipSha256
    }],
    providerRequestSentThisRun: true,
    inheritedProviderSubmission: false,
    submissionRunIds: [runId],
    pendingSegment: null,
    recoveryAttempts: [],
    recoveredPendingSegments: [],
    rejectedResumes: [],
    legacySubmissionAbandonment: null,
    legacySubmissionAbandonmentEvidence: null,
    legacySubmissionAbandonmentConsumptions: []
  };
  await writeFile(join(jobDir, "gemini-generation.json"), JSON.stringify(generation, null, 2));
  return generation;
}

function simulatedOmlxTransport(jobId, counters) {
  let planByFrameId = null;
  return async (_url, init) => {
    counters.semanticRequests += 1;
    if (!planByFrameId) {
      const jobDir = join(JOBS_DIR, jobId);
      const [script, timing, sync] = await Promise.all([
        readFile(join(jobDir, "script.json"), "utf8").then(JSON.parse),
        readFile(join(jobDir, "caption-timing.json"), "utf8").then(JSON.parse),
        readFile(join(jobDir, "voiceover-sync.json"), "utf8").then(JSON.parse).catch(() => null)
      ]);
      planByFrameId = new Map(semanticFramePlan(script, timing, sync).map((frame) => [frame.frameId, frame]));
    }
    const request = JSON.parse(String(init?.body || "{}"));
    const prompt = request?.messages?.[1]?.content?.find((entry) => entry?.type === "text")?.text || "";
    const match = prompt.match(/<UNTRUSTED_REFERENCE_JSON>(.*?)<\/UNTRUSTED_REFERENCE_JSON>/su);
    const untrusted = match ? JSON.parse(match[1]) : null;
    const frame = planByFrameId.get(untrusted?.frameId);
    if (!frame) throw new Error("semantic simulator received an unknown frame id");
    const decision = {
      frameId: frame.frameId,
      sceneMatchesEvidence: true,
      observedScene: "결정론적 테스트 패턴 영상의 움직이는 도형과 번인 자막을 관찰했다.",
      visibleCaption: frame.purpose === "caption-cue" ? frame.expectedCaption : "",
      unexpectedText: [],
      confidence: 0.99
    };
    return new Response(JSON.stringify({
      model: LOCAL_SEMANTIC_MODEL,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(decision) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("offline provider-simulated schema-5 lifecycle harness", () => {
  test("runs the authenticated create/run lifecycle, seals immutable evidence, and rehydrates a stale pointer without provider or source network access", async () => {
    for (const command of ["ffmpeg", "ffprobe"]) {
      if (!Bun.which(command)) throw new Error(`offline lifecycle fixture requires ${command}`);
    }
    const token = createSessionToken();
    const source = sourceFixture();
    const counters = { sourceCaptures: 0, providerSimulations: 0, semanticRequests: 0 };
    let terminalJob = null;
    let generated = null;
    let jobId = null;
    const handler = createStudioRequestHandler({
      token,
      startJobFn: async (id) => {
        jobId = id;
        terminalJob = await runJob(id, {
          captureSources: async () => {
            counters.sourceCaptures += 1;
            return {
              schemaVersion: 1,
              status: "complete",
              fetchedCount: 1,
              totalCount: 1,
              evidenceCount: source.evidence.length,
              records: [structuredClone(source)]
            };
          },
          buildScript: buildFixtureScript,
          semanticVerifierPreflight: async () => ({
            available: true,
            provider: "loopback-omlx",
            model: LOCAL_SEMANTIC_MODEL
          }),
          semanticVerifierFetch: simulatedOmlxTransport(id, counters),
          environment: {
            PS4_OMLX_BASE_URL: "http://127.0.0.1:18000/v1",
            PS4_OMLX_TIMEOUT_MS: "30000"
          },
          generateGeminiClips: async (job, script) => {
            counters.providerSimulations += 1;
            generated = await simulateSchema5GeminiGeneration(job, script);
            return generated;
          }
        });
        return true;
      }
    });

    const createdResponse = await handler(postRequest("/api/jobs", token, {
      topic: "궁궐 건축 배수 구조의 이유",
      provider: "gemini-browser",
      autoStart: false,
      clipCount: 1,
      targetDurationSec: 20,
      format: "vertical",
      captions: true,
      voiceover: false,
      // The public create contract accepts only operator-supplied source
      // identity. Fetch status, hashes, excerpts, and evidence are trusted
      // capture outputs supplied by the injected offline capture seam above.
      sources: [{ title: source.title, url: source.url }],
      geminiCdpUrl: "http://127.0.0.1:9222",
      geminiProfileDir: join(homedir(), ".ps4-ai-video-studio", "offline-schema5-lifecycle")
    }));
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).job;
    jobId = created.id;

    const runResponse = await handler(postRequest(`/api/jobs/${encodeURIComponent(jobId)}/run`, token, {}));
    expect(runResponse.status).toBe(200);
    expect(counters).toMatchObject({ sourceCaptures: 1, providerSimulations: 1 });
    if (counters.semanticRequests === 0) throw new Error(`semantic stage not reached: ${JSON.stringify(terminalJob)}`);
    expect(counters.semanticRequests).toBeGreaterThan(0);
    expect(generated).toMatchObject({
      schemaVersion: 5,
      provider: "gemini-browser",
      jobId,
      status: "completed",
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false
    });
    expect(terminalJob).toMatchObject({
      id: jobId,
      provider: "gemini-browser",
      status: "needs-improvement",
      runStatus: "needs-improvement",
      progress: 100
    });
    expect(terminalJob.qualitySummary).toMatchObject({
      technicalEvidenceGate: false,
      semanticGate: false
    });
    expect(terminalJob.qualitySummary.blockers).toContain("5-method software reviewer payload 파일이 없습니다.");

    const jobDir = join(JOBS_DIR, jobId);
    const runDir = join(jobDir, "runs", terminalJob.runId);
    const manifestPath = join(runDir, "manifest.json");
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const manifestHash = sha256(manifestBytes);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      jobId,
      runId: terminalJob.runId,
      status: "needs-improvement",
      runStatus: "needs-improvement",
      ledgerErrors: []
    });
    expect(manifest.geminiSubmissionLineage).toMatchObject({
      schemaVersion: 1,
      status: "completed",
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      sourceGenerationReceipt: null
    });
    expect(manifest.immutableArtifacts.length).toBeGreaterThan(20);
    expect(manifest.immutableArtifacts.some((entry) => entry.name === "gemini-generation.json")).toBeTrue();
    expect(manifest.immutableArtifacts.some((entry) => entry.name === `runs/${terminalJob.runId}/semantic/receipt.json`)).toBeTrue();
    expect(manifest.immutableArtifacts.some((entry) => entry.name === "quality.json")).toBeTrue();
    const quality = JSON.parse(await readFile(join(jobDir, "quality.json"), "utf8"));
    expect(quality).toMatchObject({
      finalization: true,
      status: "needs-improvement",
      technicalEvidenceGate: false,
      semanticGate: false,
      metrics: {
        provider: "gemini-browser",
        providerProof: true,
        providerGenerationProvenance: true,
        geminiSubmissionLineageBinding: true,
        contentSemanticsVerified: false,
        localSemanticReceipt: { status: "failed", verified: false },
        inputMotionGate: { enforced: true, observedPass: true, enforcementPass: true }
      }
    });

    const stored = await readJob(jobId);
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      ...stored,
      status: "running",
      runStatus: "running",
      stage: "검증 중",
      progress: 95,
      runStartedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      artifacts: [],
      qualitySummary: null
    }, null, 2));

    const listResponse = await handler(getRequest("/api/jobs", token));
    expect(listResponse.status).toBe(200);
    const visible = (await listResponse.json()).jobs.find((job) => job.id === jobId);
    expect(visible).toMatchObject({
      id: jobId,
      provider: "gemini-browser",
      status: "needs-improvement",
      runStatus: "needs-improvement",
      progress: 100
    });
    expect(visible).not.toHaveProperty("integrity");
    expect(sha256(await readFile(manifestPath))).toBe(manifestHash);

    const artifactResponse = await handler(getRequest(`/api/jobs/${encodeURIComponent(jobId)}/artifacts/final.mp4`, token, {
      range: "bytes=0-127"
    }));
    expect(artifactResponse.status).toBe(206);
    expect(Number(artifactResponse.headers.get("content-length"))).toBeGreaterThan(0);
    expect(Number(artifactResponse.headers.get("content-length"))).toBeLessThanOrEqual(128);
    expect((await stat(join(jobDir, "final.mp4"))).size).toBeGreaterThan(0);
  }, 240_000);
});
