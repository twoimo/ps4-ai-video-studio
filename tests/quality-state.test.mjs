import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  extractEvidenceFrames,
  frameAnalysisSourceBindingMatches,
  frameAnalysisSourceReceipt,
  geminiSessionBindingHash,
  QUALITY_RESOURCE_POLICY,
  qualityEvaluationState,
  prepareQualityRevision,
  persistQuality,
  readQualityRevisionState,
  saveCommitteeReview,
  snapshotQualityEvidenceBuffer,
  validateImmutableQualityDeclarations,
  validateCommitteeReview,
  validateQualityRevisionContext,
  validateQualityRevisionManifest,
  verifyImmutableQualityClosure
} from "../src/quality.mjs";
import { createJob, JOBS_DIR, updateJob } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";

const JOB_ID = "job-committee-001";
const RUN_ID = "run-committee-001";
const REVISION_ID = "revision-000001";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

async function createRevisionResourceBase() {
  const jobId = `quality-resource-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const jobDir = join(JOBS_DIR, jobId);
  const runDir = join(jobDir, "runs", runId);
  const baseQualityPath = join(runDir, "artifacts", "quality.json");
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const baseQuality = {
    schemaVersion: 1,
    jobId,
    runId,
    status: "needs-improvement",
    semanticGate: false,
    totalScore: 95,
    threshold: 98,
    blockers: ["review required"],
    metrics: { provider: "local-video", evidenceHashes: { "final.mp4": HASH_A } }
  };
  await writeFile(baseQualityPath, JSON.stringify(baseQuality));
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
    qualitySummary: Object.fromEntries(["status", "totalScore", "threshold", "technicalEvidenceGate", "semanticGate", "runId", "blockers"].map((field) => [field, baseQuality[field]])),
    immutableArtifacts: [{
      name: "quality.json",
      path: `runs/${runId}/artifacts/quality.json`,
      bytes: baseQualityStat.size,
      sha256: await hashFile(baseQualityPath)
    }]
  };
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(baseManifest));
  return { jobId, runId, jobDir, runDir };
}

describe("exact quality evidence snapshots", () => {
  test("derives JSON, byte length, and SHA-256 from one copied Buffer", () => {
    const original = Buffer.from('{"status":"first"}');
    const expectedBytes = Buffer.from(original);
    const snapshot = snapshotQualityEvidenceBuffer(original);
    original.fill(0x78);

    expect(snapshot.value).toEqual({ status: "first" });
    expect(snapshot.text).toBe(expectedBytes.toString("utf8"));
    expect(snapshot.bytes).toBe(expectedBytes.byteLength);
    expect(snapshot.sha256).toBe(`sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`);
  });

  test("derives JSONL text and SHA-256 from the same copied Buffer", () => {
    const original = Buffer.from('{"type":"sealed"}\n');
    const expectedBytes = Buffer.from(original);
    const snapshot = snapshotQualityEvidenceBuffer(original, { json: false });
    original.fill(0x79);

    expect(snapshot.value).toBeNull();
    expect(snapshot.text).toBe('{"type":"sealed"}\n');
    expect(snapshot.sha256).toBe(`sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`);
  });

  test("keeps provider gate parsing and evidence hashing bound to exact raw bytes", () => {
    const compact = Buffer.from('{"provider":"gemini-browser","status":"completed"}');
    const formatted = Buffer.from('{\n  "provider": "gemini-browser",\n  "status": "completed"\n}\n');
    const compactSnapshot = snapshotQualityEvidenceBuffer(compact);
    const formattedSnapshot = snapshotQualityEvidenceBuffer(formatted);

    expect(compactSnapshot.value).toEqual(formattedSnapshot.value);
    expect(compactSnapshot.sha256).not.toBe(formattedSnapshot.sha256);
    expect(compactSnapshot.sha256).toBe(`sha256:${createHash("sha256").update(compact).digest("hex")}`);
    expect(formattedSnapshot.sha256).toBe(`sha256:${createHash("sha256").update(formatted).digest("hex")}`);
  });

  test("rejects reused frame analysis when the final media path is replaced after analysis", () => {
    const mutableFinal = Buffer.from("exact-final-media-A");
    const analyzedFinal = snapshotQualityEvidenceBuffer(mutableFinal, { json: false });
    const captions = snapshotQualityEvidenceBuffer(Buffer.from("caption A"), { json: false });
    const normalized = snapshotQualityEvidenceBuffer(Buffer.from("normalized A"), { json: false });
    const analyzedSource = frameAnalysisSourceReceipt({
      finalSnapshot: analyzedFinal,
      captionsSnapshot: captions,
      captionsPath: "captions.srt",
      normalized: [{ name: "normalized/clip-01.mp4", snapshot: normalized }]
    });

    mutableFinal.fill(0x42);
    const replacedFinal = snapshotQualityEvidenceBuffer(mutableFinal, { json: false });
    const currentSource = frameAnalysisSourceReceipt({
      finalSnapshot: replacedFinal,
      captionsSnapshot: captions,
      captionsPath: "captions.srt",
      normalized: [{ name: "normalized/clip-01.mp4", snapshot: normalized }]
    });

    expect(frameAnalysisSourceBindingMatches(analyzedSource, analyzedSource)).toBe(true);
    expect(frameAnalysisSourceBindingMatches(analyzedSource, currentSource)).toBe(false);
    expect(analyzedSource.sha256).toBe(`sha256:${createHash("sha256").update(Buffer.from("exact-final-media-A")).digest("hex")}`);
  });
});

describe("immutable quality closure resource bounds", () => {
  const artifact = (runId, index, bytes = 1) => ({
    name: `artifact-${String(index).padStart(3, "0")}.bin`,
    path: `runs/${runId}/artifacts/artifact-${String(index).padStart(3, "0")}.bin`,
    bytes,
    sha256: `sha256:${String(index % 10).repeat(64)}`
  });

  test("rejects excessive declaration count and aggregate bytes before invoking a reader", async () => {
    const runId = "run-resource-preflight";
    let reads = 0;
    const reader = async () => {
      reads += 1;
      throw new Error("reader must not run");
    };
    const tooMany = Array.from({ length: QUALITY_RESOURCE_POLICY.immutableMaximumArtifacts + 1 }, (_, index) => artifact(runId, index));
    await expect(verifyImmutableQualityClosure({ jobDir: "/unused", runId, artifacts: tooMany, reader }))
      .rejects.toThrow("선언 수가 제한");
    expect(reads).toBe(0);

    const overBudget = Array.from({ length: 5 }, (_, index) => artifact(runId, index, QUALITY_RESOURCE_POLICY.immutableMaximumArtifactBytes));
    await expect(verifyImmutableQualityClosure({ jobDir: "/unused", runId, artifacts: overBudget, reader }))
      .rejects.toThrow("합산 크기");
    expect(reads).toBe(0);
  });

  test("validates immutable declarations sequentially and returns no partial receipts on failure", async () => {
    const runId = "run-resource-sequential";
    const declarations = Array.from({ length: 3 }, (_, index) => artifact(runId, index, index + 1));
    expect(validateImmutableQualityDeclarations(declarations, runId)).toBe(declarations);
    let active = 0;
    let maximumActive = 0;
    const visited = [];
    const reader = async (_path, { artifact: declaration }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      visited.push(declaration.name);
      await Promise.resolve();
      active -= 1;
      return declaration.name.endsWith("001.bin")
        ? { bytes: declaration.bytes, sha256: HASH_A }
        : { bytes: declaration.bytes, sha256: declaration.sha256 };
    };
    const result = await verifyImmutableQualityClosure({ jobDir: "/unused", runId, artifacts: declarations, reader });
    expect(result.binding).toBe(false);
    expect(result.receipts.size).toBe(0);
    expect(visited).toEqual(declarations.slice(0, 2).map((entry) => entry.name));
    expect(maximumActive).toBe(1);
  });

  test("keeps only bounded hash receipts for a valid immutable closure", async () => {
    const runId = "run-resource-valid";
    const declarations = Array.from({ length: 3 }, (_, index) => artifact(runId, index, index + 1));
    const result = await verifyImmutableQualityClosure({
      jobDir: "/unused",
      runId,
      artifacts: declarations,
      reader: async (_path, { artifact: declaration }) => ({ bytes: declaration.bytes, sha256: declaration.sha256 })
    });
    expect(result.binding).toBe(true);
    expect([...result.receipts.values()]).toHaveLength(3);
    expect([...result.receipts.values()].every((receipt) => !Object.hasOwn(receipt, "buffer"))).toBe(true);
  });

  test("streams an actual immutable file into a receipt and rejects a symlink replacement", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "ps4-quality-closure-"));
    const runId = "run-resource-file";
    const artifactDir = join(jobDir, "runs", runId, "artifacts");
    const artifactPath = join(artifactDir, "final.mp4");
    const externalPath = join(jobDir, "external.mp4");
    const bytes = Buffer.from("bounded immutable evidence");
    const declaration = {
      name: "final.mp4",
      path: `runs/${runId}/artifacts/final.mp4`,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(artifactPath, bytes);
      const verified = await verifyImmutableQualityClosure({ jobDir, runId, artifacts: [declaration] });
      expect(verified.binding).toBe(true);
      expect(verified.receipts.get("final.mp4")).toMatchObject({ bytes: bytes.byteLength, sha256: declaration.sha256 });
      expect(Object.hasOwn(verified.receipts.get("final.mp4"), "buffer")).toBe(false);

      await writeFile(externalPath, bytes);
      await rm(artifactPath);
      await symlink(externalPath, artifactPath);
      const replaced = await verifyImmutableQualityClosure({ jobDir, runId, artifacts: [declaration] });
      expect(replaced).toEqual({ binding: false, receipts: new Map() });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

describe("quality output storage boundaries", () => {
  test("rejects nested path aliases instead of reopening their basename at the jobs root", async () => {
    const job = await createJob({ topic: `품질 nested alias ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    try {
      await expect(extractEvidenceFrames(join(jobDir, "nested-alias"), { duration: 1, path: join(jobDir, "final.mp4") }))
        .rejects.toThrow("단일 작업 디렉터리");
      expect(await stat(join(jobDir, "quality")).catch(() => null)).toBeNull();
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked quality directory before changing external bytes or metadata", async () => {
    const job = await createJob({ topic: `품질 출력 symlink ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const runId = `run-${randomUUID()}`;
    await updateJob(job.id, { runId, status: "verifying" });
    const jobDir = join(JOBS_DIR, job.id);
    const qualityPath = join(jobDir, "quality");
    const externalDir = join(tmpdir(), `ps4-quality-external-${randomUUID()}`);
    const sentinel = join(externalDir, "sentinel.txt");
    try {
      await mkdir(externalDir, { recursive: true });
      await writeFile(sentinel, "must-stay-exact");
      await symlink(externalDir, qualityPath);
      const beforeDirectory = await stat(externalDir, { bigint: true });
      const beforeSentinel = await stat(sentinel, { bigint: true });
      const beforeEntries = await readdir(externalDir);
      await expect(persistQuality(jobDir, { jobId: job.id, runId, iteration: 1, finalization: true }))
        .rejects.toThrow();
      const afterDirectory = await stat(externalDir, { bigint: true });
      const afterSentinel = await stat(sentinel, { bigint: true });
      expect(await readdir(externalDir)).toEqual(beforeEntries);
      expect(await readFile(sentinel, "utf8")).toBe("must-stay-exact");
      expect(afterDirectory.mtimeNs).toBe(beforeDirectory.mtimeNs);
      expect(afterSentinel.mtimeNs).toBe(beforeSentinel.mtimeNs);
      expect(afterSentinel.ctimeNs).toBe(beforeSentinel.ctimeNs);
    } finally {
      await unlink(qualityPath).catch(() => {});
      await Promise.all([
        rm(jobDir, { recursive: true, force: true }),
        rm(externalDir, { recursive: true, force: true })
      ]);
    }
  });

  test("rejects hardlinked quality leaves before unlinking or rewriting the external inode", async () => {
    for (const relativePath of ["quality/iteration-01.json", "quality/latest.json", "quality.json"]) {
      const job = await createJob({ topic: `품질 출력 hardlink ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
      const runId = `run-${randomUUID()}`;
      await updateJob(job.id, { runId, status: "verifying" });
      const jobDir = join(JOBS_DIR, job.id);
      const target = join(jobDir, relativePath);
      const externalDir = join(tmpdir(), `ps4-quality-hardlink-${randomUUID()}`);
      const sentinel = join(externalDir, "sentinel.json");
      try {
        await Promise.all([mkdir(join(jobDir, "quality"), { recursive: true }), mkdir(externalDir, { recursive: true })]);
        await writeFile(sentinel, '{"safe":true}');
        await link(sentinel, target);
        const before = await stat(sentinel, { bigint: true });
        const beforeEntries = await readdir(externalDir);
        await expect(persistQuality(jobDir, { jobId: job.id, runId, iteration: 1, finalization: true }))
          .rejects.toThrow("단독 regular file");
        const after = await stat(sentinel, { bigint: true });
        expect(await readdir(externalDir)).toEqual(beforeEntries);
        expect(await readFile(sentinel, "utf8")).toBe('{"safe":true}');
        expect(after.nlink).toBe(before.nlink);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        expect(after.ctimeNs).toBe(before.ctimeNs);
      } finally {
        await Promise.all([
          rm(jobDir, { recursive: true, force: true }),
          rm(externalDir, { recursive: true, force: true })
        ]);
      }
    }
  });

  test("rejects a symlinked frames directory before ffmpeg can write external output", async () => {
    const job = await createJob({ topic: `품질 프레임 symlink ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const qualityDir = join(jobDir, "quality");
    const framesPath = join(qualityDir, "frames");
    const externalDir = join(tmpdir(), `ps4-quality-frames-${randomUUID()}`);
    const sentinel = join(externalDir, "sentinel.txt");
    try {
      await Promise.all([mkdir(qualityDir, { recursive: true }), mkdir(externalDir, { recursive: true })]);
      await writeFile(sentinel, "must-stay-exact");
      await symlink(externalDir, framesPath);
      const beforeDirectory = await stat(externalDir, { bigint: true });
      const beforeSentinel = await stat(sentinel, { bigint: true });
      const beforeEntries = await readdir(externalDir);
      await expect(extractEvidenceFrames(jobDir, { duration: 1, path: join(jobDir, "final.mp4") })).rejects.toThrow();
      const afterDirectory = await stat(externalDir, { bigint: true });
      const afterSentinel = await stat(sentinel, { bigint: true });
      expect(await readdir(externalDir)).toEqual(beforeEntries);
      expect(await readFile(sentinel, "utf8")).toBe("must-stay-exact");
      expect(afterDirectory.mtimeNs).toBe(beforeDirectory.mtimeNs);
      expect(afterSentinel.mtimeNs).toBe(beforeSentinel.mtimeNs);
      expect(afterSentinel.ctimeNs).toBe(beforeSentinel.ctimeNs);
    } finally {
      await unlink(framesPath).catch(() => {});
      await Promise.all([
        rm(jobDir, { recursive: true, force: true }),
        rm(externalDir, { recursive: true, force: true })
      ]);
    }
  });

  test("rejects a hardlinked frame leaf before starting extraction or touching the external inode", async () => {
    const job = await createJob({ topic: `품질 프레임 hardlink ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const framesDir = join(jobDir, "quality", "frames");
    const externalDir = join(tmpdir(), `ps4-quality-frame-hardlink-${randomUUID()}`);
    const sentinel = join(externalDir, "sentinel.jpg");
    try {
      await Promise.all([mkdir(framesDir, { recursive: true }), mkdir(externalDir, { recursive: true })]);
      await writeFile(sentinel, "must-stay-exact");
      await link(sentinel, join(framesDir, "frame-01.jpg"));
      const before = await stat(sentinel, { bigint: true });
      const beforeEntries = await readdir(externalDir);
      await expect(extractEvidenceFrames(jobDir, { duration: 1, path: join(jobDir, "final.mp4") }))
        .rejects.toThrow("단독 regular file");
      const after = await stat(sentinel, { bigint: true });
      expect(await readdir(externalDir)).toEqual(beforeEntries);
      expect(await readFile(sentinel, "utf8")).toBe("must-stay-exact");
      expect(after.nlink).toBe(before.nlink);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).toBe(before.ctimeNs);
    } finally {
      await Promise.all([
        rm(jobDir, { recursive: true, force: true }),
        rm(externalDir, { recursive: true, force: true })
      ]);
    }
  });

  test("kills an overproducing ffmpeg and leaves no published quality frame", async () => {
    const job = await createJob({ topic: `품질 프레임 출력 상한 ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const fakeFfmpeg = join(tmpdir(), `ps4-quality-noisy-ffmpeg-${randomUUID()}`);
    const previous = process.env.FFMPEG_BINARY;
    try {
      await writeFile(fakeFfmpeg, `#!${process.execPath}\nwhile (true) process.stdout.write(Buffer.alloc(4096));\n`);
      await chmod(fakeFfmpeg, 0o700);
      process.env.FFMPEG_BINARY = fakeFfmpeg;
      const startedAt = Date.now();
      await expect(extractEvidenceFrames(jobDir, { duration: 1, path: join(jobDir, "final.mp4") }))
        .rejects.toThrow("출력이 허용 크기를 초과");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await readdir(join(jobDir, "quality", "frames"))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_BINARY;
      else process.env.FFMPEG_BINARY = previous;
      await Promise.all([
        rm(jobDir, { recursive: true, force: true }),
        rm(fakeFfmpeg, { force: true })
      ]);
    }
  });

  test("publishes a bounded snapshot when real ffmpeg succeeds with empty stdout", async () => {
    const ffmpeg = process.env.FFMPEG_BINARY || Bun.which("ffmpeg");
    if (!ffmpeg) return;
    const job = await createJob({ topic: `품질 프레임 실제 추출 ${randomUUID()}`, provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const finalPath = join(jobDir, "final.mp4");
    try {
      const generated = Bun.spawn([
        ffmpeg,
        "-v", "error",
        "-y",
        "-f", "lavfi",
        "-i", "color=c=royalblue:s=576x1024:d=1:r=30",
        "-pix_fmt", "yuv420p",
        finalPath
      ], { stdout: "ignore", stderr: "pipe" });
      const stderrPromise = new Response(generated.stderr).text();
      const code = await generated.exited;
      expect(code, await stderrPromise).toBe(0);

      const frames = await extractEvidenceFrames(jobDir, { duration: 1, path: finalPath });
      expect(frames.length).toBeGreaterThan(0);
      const published = await readFile(frames[0].path);
      expect(published.byteLength).toBe(frames[0].snapshot.bytes);
      expect(`sha256:${createHash("sha256").update(published).digest("hex")}`).toBe(frames[0].sha256);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

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
  test("rejects excessive revision directories before inspecting their payloads", async () => {
    const fixture = await createRevisionResourceBase();
    const revisionsDir = join(fixture.runDir, "revisions");
    try {
      await mkdir(revisionsDir, { recursive: true });
      await Promise.all(Array.from({ length: QUALITY_RESOURCE_POLICY.revisionMaximumCount + 1 }, (_, index) => (
        mkdir(join(revisionsDir, `revision-resource-${String(index).padStart(3, "0")}`))
      )));
      await expect(readQualityRevisionState(fixture.jobId, fixture.runId)).rejects.toThrow("revision 수가 제한");
    } finally {
      await rm(fixture.jobDir, { recursive: true, force: true });
    }
  });

  test("rejects an oversized sparse revision event before parsing any revision JSON", async () => {
    const fixture = await createRevisionResourceBase();
    const revisionDir = join(fixture.runDir, "revisions", "revision-resource-oversized");
    const eventPath = join(revisionDir, "events.jsonl");
    let eventHandle;
    try {
      await mkdir(revisionDir, { recursive: true });
      await Promise.all([
        writeFile(join(revisionDir, "manifest.json"), "not-json"),
        writeFile(join(revisionDir, "committee-review.json"), "{}"),
        writeFile(join(revisionDir, "quality.json"), "{}")
      ]);
      eventHandle = await open(eventPath, "wx", 0o600);
      await eventHandle.truncate(QUALITY_RESOURCE_POLICY.revisionEventsMaximumBytes + 1);
      await eventHandle.close();
      eventHandle = null;
      await expect(readQualityRevisionState(fixture.jobId, fixture.runId)).rejects.toThrow("크기가 제한된 단독 regular file");
    } finally {
      await eventHandle?.close().catch(() => {});
      await rm(fixture.jobDir, { recursive: true, force: true });
    }
  });

  test("rejects oversized revision JSON and aggregate bytes during metadata preflight", async () => {
    for (const scenario of [
      { leaf: "quality.json", bytes: QUALITY_RESOURCE_POLICY.revisionJsonMaximumBytes + 1, message: "크기가 제한된 단독 regular file" },
      { leaf: "events.jsonl", bytes: QUALITY_RESOURCE_POLICY.revisionEventsMaximumBytes, message: "합산 크기" }
    ]) {
      const fixture = await createRevisionResourceBase();
      const revisionDir = join(fixture.runDir, "revisions", `revision-resource-${scenario.leaf.startsWith("quality") ? "json" : "aggregate"}`);
      let oversizedHandle;
      try {
        await mkdir(revisionDir, { recursive: true });
        await Promise.all([
          writeFile(join(revisionDir, "manifest.json"), "not-json"),
          writeFile(join(revisionDir, "committee-review.json"), "{}"),
          writeFile(join(revisionDir, "quality.json"), "{}"),
          writeFile(join(revisionDir, "events.jsonl"), "{}\n")
        ]);
        await rm(join(revisionDir, scenario.leaf));
        oversizedHandle = await open(join(revisionDir, scenario.leaf), "wx", 0o600);
        await oversizedHandle.truncate(scenario.bytes);
        await oversizedHandle.close();
        oversizedHandle = null;
        await expect(readQualityRevisionState(fixture.jobId, fixture.runId)).rejects.toThrow(scenario.message);
      } finally {
        await oversizedHandle?.close().catch(() => {});
        await rm(fixture.jobDir, { recursive: true, force: true });
      }
    }
  });

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
    expect(() => validateQualityRevisionContext({
      ...context,
      sequence: QUALITY_RESOURCE_POLICY.revisionMaximumCount + 1
    })).toThrow(/이하여야/);
  });

  test("blocks malformed UTF-8 committee evidence before a sealed terminal promotion is accepted", async () => {
    const fixture = await createRevisionResourceBase();
    const jobPath = join(fixture.jobDir, "job.json");
    const baseQualityPath = join(fixture.runDir, "artifacts", "quality.json");
    try {
      await writeFile(jobPath, JSON.stringify({
        id: fixture.jobId,
        runId: fixture.runId,
        status: "needs-improvement",
        provider: "local-video"
      }, null, 2));
      const context = await prepareQualityRevision(fixture.jobId, fixture.runId, "revision-invalid-utf8-000001");
      const review = reviewFixture({
        jobId: fixture.jobId,
        runId: fixture.runId,
        revisionId: context.revisionId,
        sequence: context.sequence
      });
      review.scores.hookStory.evidence += " cosmetic \uFFFD marker";
      const decisionHash = committeeDecisionHash(review);
      for (const reviewer of review.reviewers) {
        reviewer.attestation.decisionHash = decisionHash;
        reviewer.attestationHash = committeeAttestationHash(reviewer.attestation);
      }
      expect(validateCommitteeReview(review, {
        expectedJobId: fixture.jobId,
        expectedRunId: fixture.runId,
        expectedEvidenceHashes: review.evidenceHashes
      })).toBe(true);

      const revisionDir = join(fixture.runDir, "revisions", context.revisionId);
      await mkdir(revisionDir, { recursive: true });
      const reviewPath = join(revisionDir, "committee-review.json");
      const validReviewBytes = Buffer.from(JSON.stringify(review, null, 2));
      const replacementOffset = validReviewBytes.indexOf(Buffer.from("\uFFFD", "utf8"));
      expect(replacementOffset).toBeGreaterThanOrEqual(0);
      const malformedReviewBytes = Buffer.concat([
        validReviewBytes.subarray(0, replacementOffset),
        Buffer.from([0xff]),
        validReviewBytes.subarray(replacementOffset + Buffer.byteLength("\uFFFD"))
      ]);
      // A non-fatal decoder aliases the invalid byte to the same U+FFFD value,
      // so every normalized committee/attestation hash remains valid.
      expect(JSON.parse(malformedReviewBytes.toString("utf8"))).toEqual(review);
      await writeFile(reviewPath, malformedReviewBytes);
      const reviewDeclaration = {
        path: `runs/${fixture.runId}/revisions/${context.revisionId}/committee-review.json`,
        sha256: await hashFile(reviewPath),
        bytes: malformedReviewBytes.byteLength
      };
      const evaluated = evaluatedQualityFixture({ context, review });
      const quality = bindQualityRevision(evaluated, context, reviewDeclaration.sha256);
      const qualityPath = join(revisionDir, "quality.json");
      await writeFile(qualityPath, JSON.stringify(quality, null, 2));
      const qualityDeclaration = {
        path: `runs/${fixture.runId}/revisions/${context.revisionId}/quality.json`,
        sha256: await hashFile(qualityPath),
        bytes: (await stat(qualityPath)).size
      };
      const eventRecord = buildQualityRevisionEvent({
        context,
        committeeReview: reviewDeclaration,
        qualityArtifact: qualityDeclaration,
        transition: quality.revision.transition
      });
      const eventsPath = join(revisionDir, "events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify(eventRecord)}\n`);
      const eventsDeclaration = {
        path: `runs/${fixture.runId}/revisions/${context.revisionId}/events.jsonl`,
        sha256: await hashFile(eventsPath),
        bytes: (await stat(eventsPath)).size
      };
      const manifest = buildQualityRevisionManifest({
        context,
        review,
        quality,
        committeeReview: reviewDeclaration,
        qualityArtifact: qualityDeclaration,
        events: eventsDeclaration,
        eventRecord
      });
      expect(manifest.transition).toMatchObject({ to: "completed", terminal: true });
      const manifestPath = join(revisionDir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const protectedPaths = [jobPath, baseQualityPath, reviewPath, qualityPath, eventsPath, manifestPath];
      const before = new Map(await Promise.all(protectedPaths.map(async (path) => [path, {
        bytes: await readFile(path),
        stat: await stat(path, { bigint: true })
      }])));
      const expectedError = "위원회 리뷰 revision 산출물 무결성 검증에 실패했습니다.";
      await expect(readQualityRevisionState(fixture.jobId, fixture.runId)).rejects.toThrow(expectedError);
      await expect(prepareQualityRevision(fixture.jobId, fixture.runId, "revision-must-not-open-000002")).rejects.toThrow(expectedError);
      await expect(saveCommitteeReview(fixture.jobId, review, { revisionContext: context })).rejects.toThrow(expectedError);
      for (const path of protectedPaths) {
        const prior = before.get(path);
        expect(await readFile(path)).toEqual(prior.bytes);
        const after = await stat(path, { bigint: true });
        expect(after.mtimeNs).toBe(prior.stat.mtimeNs);
        expect(after.ctimeNs).toBe(prior.stat.ctimeNs);
      }
      expect(JSON.parse(await readFile(jobPath, "utf8")).status).toBe("needs-improvement");
      expect(JSON.parse(await readFile(baseQualityPath, "utf8")).status).toBe("needs-improvement");
    } finally {
      await rm(fixture.jobDir, { recursive: true, force: true });
    }
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
