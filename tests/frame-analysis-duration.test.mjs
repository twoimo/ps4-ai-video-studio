import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCaptions, analyzeJobMedia, compareDuration, runFrameAnalysisCommand } from "../src/frame-analysis.mjs";

const profile = {
  summary: { medianSec: 78, p10Sec: 57, p90Sec: 93, recommendedTargetSec: 78, recommendedRangeSec: [57, 93] },
  recentSummary: { medianSec: 110, p10Sec: 94, p90Sec: 128, recommendedTargetSec: 110, recommendedRangeSec: [96, 122] }
};

describe("duration benchmark selection", () => {
  test("uses the recent Shorts profile when no job-bound target is present", () => {
    expect(compareDuration(110, profile)).toMatchObject({
      source: "benchmark-recent",
      targetSec: 110,
      rangeSec: [96, 122],
      insideRecommendedRange: true
    });
  });

  test("uses the immutable job-bound target for quota-sized Gemini runs", () => {
    expect(compareDuration(20, profile, { targetSec: 20, rangeSec: [16, 24] })).toMatchObject({
      source: "job-bound-target",
      targetSec: 20,
      rangeSec: [16, 24],
      insideRecommendedRange: true
    });
  });
});

describe("frame-analysis resource and storage boundaries", () => {
  test("kills subprocesses that exceed combined output or runtime limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-frame-analysis-process-"));
    const noisy = join(root, "noisy-ffmpeg");
    const hanging = join(root, "hanging-ffmpeg");
    const previous = process.env.FFMPEG_BINARY;
    try {
      await Promise.all([
        writeFile(noisy, `#!${process.execPath}\nwhile (true) process.stdout.write(Buffer.alloc(4096));\n`),
        writeFile(hanging, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`)
      ]);
      await Promise.all([chmod(noisy, 0o700), chmod(hanging, 0o700)]);

      process.env.FFMPEG_BINARY = noisy;
      const outputStartedAt = Date.now();
      await expect(runFrameAnalysisCommand("ffmpeg", [], { maximumBytes: 1024, timeoutMs: 5_000 }))
        .rejects.toThrow("출력이 허용 크기를 초과");
      expect(Date.now() - outputStartedAt).toBeLessThan(5_000);

      process.env.FFMPEG_BINARY = hanging;
      const timeoutStartedAt = Date.now();
      await expect(runFrameAnalysisCommand("ffmpeg", [], { maximumBytes: 1024, timeoutMs: 50 }))
        .rejects.toThrow("실행 시간이 제한을 초과");
      expect(Date.now() - timeoutStartedAt).toBeLessThan(2_000);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_BINARY;
      else process.env.FFMPEG_BINARY = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds caption parsing before allocating cue arrays", () => {
    expect(() => analyzeCaptions("x".repeat(4 * 1024 * 1024 + 1))).toThrow("크기가 제한을 초과");
  });

  test("rejects symlinked and hardlinked analysis outputs without external mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-frame-analysis-storage-"));
    const fakeFfmpeg = join(root, "fake-ffmpeg");
    const fakeFfprobe = join(root, "fake-ffprobe");
    const previousFfmpeg = process.env.FFMPEG_BINARY;
    const previousFfprobe = process.env.FFPROBE_BINARY;
    await Promise.all([
      writeFile(fakeFfmpeg, `#!${process.execPath}\nprocess.exit(0);\n`),
      writeFile(fakeFfprobe, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({streams:[{codec_type:"video",codec_name:"h264",width:576,height:1024,avg_frame_rate:"30/1",nb_frames:"30"}],format:{duration:"1"}}));\n`)
    ]);
    await Promise.all([chmod(fakeFfmpeg, 0o700), chmod(fakeFfprobe, 0o700)]);
    process.env.FFMPEG_BINARY = fakeFfmpeg;
    process.env.FFPROBE_BINARY = fakeFfprobe;
    try {
      const symlinkJob = join(root, "symlink-job");
      const external = join(root, "external");
      const sentinel = join(external, "sentinel.txt");
      await Promise.all([mkdir(symlinkJob), mkdir(external)]);
      await Promise.all([writeFile(join(symlinkJob, "final.mp4"), "fixture"), writeFile(sentinel, "must-stay-exact")]);
      await symlink(external, join(symlinkJob, "quality"));
      const beforeDirectory = await stat(external, { bigint: true });
      const beforeSentinel = await stat(sentinel, { bigint: true });
      const beforeEntries = await readdir(external);
      await expect(analyzeJobMedia(symlinkJob, { audio: false })).rejects.toThrow();
      const afterDirectory = await stat(external, { bigint: true });
      const afterSentinel = await stat(sentinel, { bigint: true });
      expect(await readdir(external)).toEqual(beforeEntries);
      expect(await readFile(sentinel, "utf8")).toBe("must-stay-exact");
      expect(afterDirectory.mtimeNs).toBe(beforeDirectory.mtimeNs);
      expect(afterSentinel.mtimeNs).toBe(beforeSentinel.mtimeNs);
      expect(afterSentinel.ctimeNs).toBe(beforeSentinel.ctimeNs);
      await unlink(join(symlinkJob, "quality"));

      for (const relativePath of ["frame-audio-caption.json", "quality/frame-audio-caption.json"]) {
        const jobDir = join(root, relativePath.startsWith("quality/") ? "quality-hardlink-job" : "root-hardlink-job");
        const outside = join(root, `${jobDir.split("/").at(-1)}-outside`);
        const outsideFile = join(outside, "sentinel.json");
        await Promise.all([mkdir(join(jobDir, "quality"), { recursive: true }), mkdir(outside)]);
        await Promise.all([writeFile(join(jobDir, "final.mp4"), "fixture"), writeFile(outsideFile, '{"safe":true}')]);
        await link(outsideFile, join(jobDir, relativePath));
        const before = await stat(outsideFile, { bigint: true });
        const outsideEntries = await readdir(outside);
        await expect(analyzeJobMedia(jobDir, { audio: false })).rejects.toThrow("단독 regular file");
        const after = await stat(outsideFile, { bigint: true });
        expect(await readdir(outside)).toEqual(outsideEntries);
        expect(await readFile(outsideFile, "utf8")).toBe('{"safe":true}');
        expect(after.nlink).toBe(before.nlink);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        expect(after.ctimeNs).toBe(before.ctimeNs);
      }
    } finally {
      if (previousFfmpeg === undefined) delete process.env.FFMPEG_BINARY;
      else process.env.FFMPEG_BINARY = previousFfmpeg;
      if (previousFfprobe === undefined) delete process.env.FFPROBE_BINARY;
      else process.env.FFPROBE_BINARY = previousFfprobe;
      await rm(root, { recursive: true, force: true });
    }
  });
});
