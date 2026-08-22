import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { snapshotBenchmarkFiles } from "../src/pipeline.mjs";
import { hashFile } from "../src/run-ledger.mjs";

const root = join(import.meta.dir, "..");

async function json(path) {
  return JSON.parse(await Bun.file(join(root, path)).text());
}

describe("published benchmark snapshot", () => {
  test("keeps the channel listing, metadata, analysis, and RLM population aligned", async () => {
    const [shorts, longVideos, metadata, analysis, rlm] = await Promise.all([
      json("data/channel-shorts.json"),
      json("data/channel-videos.json"),
      json("data/shorts-metadata.json"),
      json("data/channel-analysis.json"),
      json("data/rlm-benchmark-analysis.json")
    ]);

    expect(shorts.channelId).toBe("UCeEM8XgdgUyaWE1Z6_5sHbQ");
    expect(longVideos.channelId).toBe(shorts.channelId);
    expect(shorts.fetchedAt).toBe(longVideos.fetchedAt);
    expect(shorts.videos).toHaveLength(251);
    expect(longVideos.videos).toHaveLength(4);
    expect(metadata.videos).toHaveLength(shorts.videos.length);
    expect(metadata.snapshotVideoCount).toBe(shorts.videos.length);
    expect(metadata.sourceSnapshotAt).toBe(shorts.fetchedAt);
    expect(analysis.videos).toHaveLength(shorts.videos.length + longVideos.videos.length);
    expect(analysis.snapshot).toMatchObject({ totalVideos: 255, shorts: 251, longVideos: 4 });
    expect(analysis).not.toHaveProperty("editorialModel");
    expect(analysis.editorialHypothesis).toMatchObject({
      status: "hypothesis-not-measured",
      evidenceBasis: "title-and-public-metadata-heuristic"
    });
    expect(rlm.reduction.inputCount).toBe(shorts.videos.length);
    expect(rlm.sourceSnapshot).toMatchObject({ videoCount: 255, shortsCount: 251 });
    expect(rlm.provenance.sourceAnalysis.completeness).toMatchObject({
      expectedVideos: 255,
      indexedVideos: 255,
      uniqueIds: 255,
      complete: true
    });

    const ids = [...shorts.videos, ...longVideos.videos].map((video) => video.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const video of [...shorts.videos, ...longVideos.videos]) {
      expect(video.title.length).toBeGreaterThan(0);
      expect(video.viewCount).toBeGreaterThan(0);
      expect(video.durationSec).toBeGreaterThan(0);
      expect(video.timestamp).toBeGreaterThan(0);
      expect(video.url).toMatch(/^https:\/\/www\.youtube\.com\//);
    }
  });

  test("publishes a clearly non-representative, portable media sample receipt", async () => {
    const [media, rlm] = await Promise.all([
      json("data/benchmark-media-analysis.json"),
      json("data/rlm-benchmark-analysis.json")
    ]);

    expect(media.populationCount).toBe(251);
    expect(media.selected).toHaveLength(12);
    expect(media.downloadedCount).toBe(12);
    expect(media.analyses).toHaveLength(12);
    expect(media.failures).toEqual([]);
    expect(new Set(media.selected.map((item) => item.id)).size).toBe(12);
    expect(rlm.mediaEvidence.sampleCount).toBe(media.analyses.length);
    expect(rlm.mediaEvidence).toMatchObject({ audioSampleCount: 11, captionSampleCount: 11, measuredAudioQcCount: 2 });
    expect(rlm.provenance.mediaEvidenceScope).toBe(media.analyses.length);
    expect(rlm.provenance.mediaEvidenceIsRepresentative).toBe(false);

    for (const item of media.analyses) {
      expect(item.analysis.media.durationSec).toBeGreaterThan(0);
      expect(item.analysis.file).toMatch(/^workspace\/benchmark-sources\//);
      expect(isAbsolute(item.analysis.file)).toBe(false);
      expect(item.analysis.file).not.toContain("/Users/");
      expect(item.analysis.captions).not.toHaveProperty("entries");
      expect(item.analysis.captions).not.toHaveProperty("wordTimings");
      expect(item.analysis.captions.rawTextStored).toBe(false);
      expect(item.analysis.captions.entriesOmittedFromReceipt).toBe(item.analysis.captions.count);
      expect(item.analysis.captions.wordTimingsOmittedFromReceipt).toBe(item.analysis.captions.wordTimingCount);
      if (item.captionFile) {
        expect(item.captionFile.endsWith(".ko.vtt")).toBe(true);
        expect(item.analysis.captions.sourceReceipt).toMatchObject({ filename: item.captionFile, language: "ko" });
        expect(item.analysis.captions.sourceReceipt.bytes).toBeGreaterThan(0);
        expect(item.analysis.captions.sourceReceipt.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      } else {
        expect(item.analysis.captions.sourceReceipt).toBeNull();
      }
    }
  });
});

describe("run benchmark snapshot byte binding", () => {
  test("parses, writes, and receipts one captured Buffer even if every source path changes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ps4-benchmark-snapshot-"));
    try {
      const capturedAt = "2026-08-12T00:00:00.000Z";
      const fixtures = [
        {
          key: "channel",
          name: "channel-analysis.json",
          value: { snapshot: { totalVideos: 3, shorts: 2, longVideos: 1, capturedAt } }
        },
        {
          key: "duration",
          name: "shorts-metadata.json",
          value: { snapshotVideoCount: 2, sourceSnapshotAt: capturedAt }
        },
        {
          key: "rlm",
          name: "rlm-benchmark-analysis.json",
          value: { reduction: { inputCount: 2 }, mediaEvidence: { sampleCount: 1 }, analyzedAt: capturedAt }
        }
      ];
      const specs = [];
      const originals = new Map();
      for (const fixture of fixtures) {
        const source = join(temporary, `source-${fixture.name}`);
        const bytes = Buffer.from(JSON.stringify(fixture.value));
        await writeFile(source, bytes);
        specs.push({ key: fixture.key, name: fixture.name, source });
        originals.set(source, bytes);
      }
      const runDir = join(temporary, "run");
      const snapshot = await snapshotBenchmarkFiles(runDir, "run-byte-bound", {
        specs,
        readFileFn: async (source) => {
          const bytes = await readFile(source);
          await writeFile(source, JSON.stringify({ replacedAfterRead: true }));
          return bytes;
        }
      });

      for (const spec of specs) {
        const target = join(runDir, "benchmarks", spec.name);
        expect(await readFile(target)).toEqual(originals.get(spec.source));
      }
      expect(snapshot.sha256).toBe(await hashFile(join(runDir, "benchmarks", "channel-analysis.json")));
      expect(snapshot.durationMetadata.sha256).toBe(await hashFile(join(runDir, "benchmarks", "shorts-metadata.json")));
      expect(snapshot.rlmMediaEvidence.sha256).toBe(await hashFile(join(runDir, "benchmarks", "rlm-benchmark-analysis.json")));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
