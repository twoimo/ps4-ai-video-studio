import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeClipMotion, createInputManifest } from "../src/pipeline.mjs";
import { verifyInputMotionGate } from "../src/quality.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { providerDiversityClosureBound, providerMotionClosureBound } from "../src/server.mjs";

const FFMPEG = process.env.FFMPEG_BINARY
  || (existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : Bun.which("ffmpeg"));

async function ffmpeg(args) {
  if (!FFMPEG) throw new Error("clip motion gate tests require ffmpeg");
  const child = Bun.spawn([FFMPEG, "-y", "-v", "error", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`fixture ffmpeg failed (${exitCode}): ${await stderr}`);
}

async function manifestWorkspace(root, name, fixture) {
  const jobDir = join(root, name, "job");
  const runDir = join(jobDir, "runs", "run-1");
  await mkdir(join(jobDir, "clips"), { recursive: true });
  await copyFile(fixture, join(jobDir, "clips", "01.mp4"));
  return { jobDir, runDir };
}

describe("approved provider decoded-frame motion gate", () => {
  let root;
  const fixture = (name) => join(root, `${name}.mp4`);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ps4-clip-motion-gate-"));
    await Promise.all([
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=64x96:rate=12:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("moving")]),
      ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=64x96:rate=12:duration=2", "-metadata", "comment=static-red", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("static-red")]),
      ffmpeg(["-f", "lavfi", "-i", "color=c=blue:size=64x96:rate=12:duration=2", "-metadata", "comment=static-blue", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("static-blue")]),
      ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=64x96:rate=12:duration=2", "-vf", "geq=lum='if(mod(N,2),235,16)':cb=128:cr=128", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("two-frame-loop")]),
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=64x96:rate=12:duration=1", "-vf", "tpad=start_mode=clone:start_duration=1", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("delayed-motion")])
    ]);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("accepts continuous motion and exposes deterministic first-frame and temporal metrics", async () => {
    const receipt = await analyzeClipMotion(fixture("moving"));
    expect(receipt).toMatchObject({
      algorithm: "ffmpeg-luma-motion-32x32-v1",
      passed: true,
      early: { passed: true, motionStartSec: 0.125 },
      temporal: { passed: true }
    });
    expect(receipt.temporal.uniqueFrameRatio).toBeGreaterThanOrEqual(receipt.policy.minimumUniqueFrameRatio);
    expect(receipt.temporal.movingTransitionRatio).toBeGreaterThanOrEqual(receipt.policy.minimumMovingTransitionRatio);
  });

  test("rejects different-SHA static colors instead of treating container hashes as motion", async () => {
    expect(await hashFile(fixture("static-red"))).not.toBe(await hashFile(fixture("static-blue")));
    for (const name of ["static-red", "static-blue"]) {
      const receipt = await analyzeClipMotion(fixture(name));
      expect(receipt).toMatchObject({ passed: false, early: { passed: false }, temporal: { passed: false } });
      expect(receipt.temporal.uniqueFrameRatio).toBeLessThan(receipt.policy.minimumUniqueFrameRatio);
      const { jobDir, runDir } = await manifestWorkspace(root, `approved-${name}`, fixture(name));
      await expect(createInputManifest(jobDir, runDir, `job-${name}`, "run-1", ["01.mp4"], 1, "local-video"))
        .rejects.toThrow(/승인 provider 클립 동작 품질 gate/);
    }
  });

  test("rejects a short frame loop even though every adjacent transition moves", async () => {
    const receipt = await analyzeClipMotion(fixture("two-frame-loop"));
    expect(receipt.early.passed).toBe(true);
    expect(receipt.temporal.movingTransitionRatio).toBe(1);
    expect(receipt.temporal.uniqueFrameRatio).toBeLessThan(receipt.policy.minimumUniqueFrameRatio);
    expect(receipt).toMatchObject({ passed: false, temporal: { passed: false } });
  });

  test("rejects motion that starts after a static opening", async () => {
    const receipt = await analyzeClipMotion(fixture("delayed-motion"));
    expect(receipt).toMatchObject({ passed: false, early: { passed: false }, temporal: { passed: true } });
    expect(receipt.early.motionStartSec).toBeNull();
  });

  test("enforces the gate for approved providers but only measures local upload fixtures", async () => {
    const approved = await manifestWorkspace(root, "approved-moving", fixture("moving"));
    const approvedManifest = await createInputManifest(approved.jobDir, approved.runDir, "job-approved", "run-1", ["01.mp4"], 1, "gemini-browser");
    expect(approvedManifest.manifest).toMatchObject({
      schemaVersion: 3,
      motionGate: { approvedProvider: true, enforced: true, observedPass: true, enforcementPass: true },
      entries: [{ motion: { passed: true } }]
    });
    const recomputed = await analyzeClipMotion(fixture("moving"));
    expect(verifyInputMotionGate(approvedManifest.manifest, "gemini-browser", [recomputed])).toMatchObject({
      binding: true,
      required: true,
      observedPass: true,
      recomputedBinding: true
    });
    const tampered = structuredClone(approvedManifest.manifest);
    tampered.entries[0].motion.temporal.uniqueFrameRatio = 0;
    expect(verifyInputMotionGate(tampered, "gemini-browser", [recomputed]).binding).toBe(false);

    const local = await manifestWorkspace(root, "local-static", fixture("static-red"));
    const localManifest = await createInputManifest(local.jobDir, local.runDir, "job-local", "run-1", ["01.mp4"], 1, "local");
    expect(localManifest.manifest).toMatchObject({
      schemaVersion: 3,
      motionGate: { approvedProvider: false, enforced: false, observedPass: false, enforcementPass: true },
      entries: [{ motion: { passed: false } }]
    });
    expect(verifyInputMotionGate(localManifest.manifest, "local")).toMatchObject({ binding: true, required: false, observedPass: false });
  });

  test("preserves sealed legacy manifests while requiring the motion closure for schema v3", () => {
    expect(providerMotionClosureBound("gemini-browser", {}, { schemaVersion: 2 })).toBe(true);
    expect(providerMotionClosureBound("gemini-browser", { inputMotionGateBinding: true }, { schemaVersion: 2 })).toBe(false);
    expect(providerMotionClosureBound("local-video", {}, { schemaVersion: 3 })).toBe(false);
    expect(providerMotionClosureBound("local-video", {
      inputMotionGateBinding: true,
      inputMotionGate: { approvedProvider: true, enforced: true, enforcementPass: true }
    }, {
      schemaVersion: 3,
      motionGate: { provider: "local-video", approvedProvider: true, enforced: true, enforcementPass: true }
    })).toBe(true);
    expect(providerDiversityClosureBound("gemini-browser", {}, { schemaVersion: 1 })).toBe(true);
    expect(providerDiversityClosureBound("gemini-browser", { inputDiversityBinding: true }, { schemaVersion: 1 })).toBe(false);
    expect(providerDiversityClosureBound("gemini-browser", {}, { schemaVersion: 2 })).toBe(false);
    expect(providerDiversityClosureBound("gemini-browser", { inputDiversityBinding: true }, { schemaVersion: 2 })).toBe(true);
  });
});
