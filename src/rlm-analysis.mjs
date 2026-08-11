import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

export function chunk(items, size = 32) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + value;
  return target;
}

function leafReduce(videos, chunkIndex) {
  const durations = videos.map((video) => Number(video.durationSec)).filter(Number.isFinite);
  const categories = {};
  const hooks = {};
  const resolutions = {};
  for (const video of videos) {
    for (const category of video.analysis?.categories || []) categories[category.label] = (categories[category.label] || 0) + 1;
    for (const hook of video.analysis?.hooks || []) hooks[hook.label] = (hooks[hook.label] || 0) + 1;
    const resolution = video.width && video.height ? `${video.width}x${video.height}` : "unknown";
    resolutions[resolution] = (resolutions[resolution] || 0) + 1;
  }
  return {
    level: "leaf",
    chunkIndex,
    count: videos.length,
    validDurationCount: durations.length,
    durationSum: sum(durations),
    minDurationSec: durations.length ? Math.min(...durations) : null,
    maxDurationSec: durations.length ? Math.max(...durations) : null,
    categoryCounts: categories,
    hookCounts: hooks,
    resolutionCounts: resolutions,
    titles: videos.map((video) => video.title).filter(Boolean)
  };
}

function combine(nodes, level) {
  const result = {
    level,
    childCount: nodes.length,
    count: sum(nodes.map((node) => node.count)),
    validDurationCount: sum(nodes.map((node) => node.validDurationCount)),
    durationSum: sum(nodes.map((node) => node.durationSum)),
    minDurationSec: Math.min(...nodes.map((node) => node.minDurationSec).filter(Number.isFinite)),
    maxDurationSec: Math.max(...nodes.map((node) => node.maxDurationSec).filter(Number.isFinite)),
    categoryCounts: {},
    hookCounts: {},
    resolutionCounts: {},
    children: nodes.map(({ titles, ...node }) => node)
  };
  for (const node of nodes) {
    mergeCounts(result.categoryCounts, node.categoryCounts);
    mergeCounts(result.hookCounts, node.hookCounts);
    mergeCounts(result.resolutionCounts, node.resolutionCounts);
  }
  if (!Number.isFinite(result.minDurationSec)) result.minDurationSec = null;
  if (!Number.isFinite(result.maxDurationSec)) result.maxDurationSec = null;
  return result;
}

export function recursiveReduce(items, options = {}) {
  const chunkSize = Math.max(1, Number(options.chunkSize || 32));
  let nodes = chunk(items, chunkSize).map(leafReduce);
  const levels = [nodes];
  let level = 1;
  while (nodes.length > 1) {
    nodes = chunk(nodes, chunkSize).map((group) => combine(group, `reduce-${level}`));
    levels.push(nodes);
    level += 1;
  }
  return { engine: "RLM-recursive-reducer", chunkSize, inputCount: items.length, levels, root: nodes[0] || combine([], "reduce-0") };
}

export async function analyzeBenchmarkRLM(options = {}) {
  const analysis = JSON.parse(await readFile(join(ROOT, "data/channel-analysis.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(ROOT, "data/shorts-metadata.json"), "utf8"));
  const byId = new Map(metadata.videos.map((video) => [video.id, video]));
  const shorts = analysis.videos.filter((video) => video.type === "short").map((video) => ({ ...video, ...(byId.get(video.id) || {}) }));
  let mediaEvidence = null;
  try {
    const captured = JSON.parse(await readFile(join(ROOT, "data/benchmark-media-analysis.json"), "utf8"));
    const analyzed = captured.analyses.map((item) => item.analysis).filter(Boolean);
    const captionRates = analyzed.map((item) => item.media.durationSec > 0 ? item.captions.count * 60 / item.media.durationSec : null).filter(Number.isFinite);
    const wordTimingRates = analyzed.map((item) => item.captions.count > 0 ? item.captions.wordTimingCount / item.captions.count : null).filter(Number.isFinite);
    mediaEvidence = {
      sampleCount: analyzed.length,
      averageDurationSec: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.media.durationSec, 0) / analyzed.length).toFixed(2)) : null,
      averageFps: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.media.fps, 0) / analyzed.length).toFixed(2)) : null,
      averageSceneCuts: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.frames.sceneCutCount, 0) / analyzed.length).toFixed(2)) : null,
      averageSilenceCount: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.audio.silenceCount, 0) / analyzed.length).toFixed(2)) : null,
      averageCaptionCount: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.captions.count, 0) / analyzed.length).toFixed(2)) : null,
      averageCaptionCps: analyzed.length ? Number((analyzed.reduce((sum, item) => sum + item.captions.averageCharsPerSecond, 0) / analyzed.length).toFixed(2)) : null,
      averageCaptionCuesPerMinute: captionRates.length ? Number((captionRates.reduce((sum, value) => sum + value, 0) / captionRates.length).toFixed(2)) : null,
      captionCuesPerMinuteRange: captionRates.length ? [Number(Math.min(...captionRates).toFixed(2)), Number(Math.max(...captionRates).toFixed(2))] : null,
      averageWordTimingCoverage: wordTimingRates.length ? Number((wordTimingRates.reduce((sum, value) => sum + value, 0) / wordTimingRates.length).toFixed(3)) : null,
      evidence: analyzed.map((item) => ({ durationSec: item.media.durationSec, frameCount: item.frames.frameCountObserved, sceneCutCount: item.frames.sceneCutCount, silenceCount: item.audio.silenceCount, captionCount: item.captions.count, captionCuesPerMinute: item.media.durationSec > 0 ? Number((item.captions.count * 60 / item.media.durationSec).toFixed(2)) : null, wordTimingCoverage: item.captions.count > 0 ? Number((item.captions.wordTimingCount / item.captions.count).toFixed(3)) : null }))
    };
  } catch {
    mediaEvidence = { sampleCount: 0, evidence: [], status: "no local benchmark media captured" };
  }
  const result = {
    schemaVersion: 1,
    analyzedAt: new Date().toISOString(),
    source: analysis.source,
    sourceSnapshot: { channel: analysis.channel, videoCount: analysis.videos.length, shortsCount: shorts.length, durationProfile: metadata.summary, metadataCapturedWith: metadata.capturedWith },
    provenance: {
      sourceAnalysis: analysis.provenance || null,
      mediaEvidenceScope: mediaEvidence?.sampleCount || 0,
      mediaEvidenceIsRepresentative: Boolean(mediaEvidence?.sampleCount && mediaEvidence.sampleCount >= shorts.length),
      limitations: [
        "RLM aggregates metadata and sampled media evidence; it does not prove semantic equivalence",
        "sampled frame/audio/caption evidence must not be treated as full-channel coverage",
        "AHP scores require run-bound production evidence and committee review"
      ]
    },
    ahp: analysis.ahp || {
      schemaVersion: 1,
      weights: [
        { id: "hookStory", weight: 25 },
        { id: "visualConsistency", weight: 25 },
        { id: "editRhythm", weight: 15 },
        { id: "captionsAudio", weight: 15 },
        { id: "factSourceFit", weight: 10 },
        { id: "automationRecovery", weight: 10 }
      ],
      weightTotal: 100
    },
    mediaEvidence,
    methodology: { name: "recursive language model style reducer", chunkSize: Number(options.chunkSize || 32), leafFields: ["duration", "resolution", "categories", "hooks", "titles"], reduction: "leaf summaries are recursively combined without loading raw evidence into one prompt" },
    reduction: recursiveReduce(shorts, { chunkSize: options.chunkSize || 32 }),
    ahpMapping: {
      hookStory: ["hookCounts", "titles"],
      visualConsistency: ["resolutionCounts"],
      editRhythm: ["durationSum", "minDurationSec", "maxDurationSec"],
      captionsAudio: ["frame-audio-caption evidence generated per production artifact"],
      factSourceFit: ["categories", "titles"],
      automationRecovery: ["chunk and reduction receipts"]
    }
  };
  await writeFile(join(ROOT, "data/rlm-benchmark-analysis.json"), JSON.stringify(result, null, 2));
  return result;
}
