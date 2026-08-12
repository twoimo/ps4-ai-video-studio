import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ytDlpInfo } from "../src/yt-dlp.mjs";

const root = resolve(import.meta.dirname, "..");
const channel = JSON.parse(await readFile(resolve(root, "data/channel-shorts.json"), "utf8"));
const tool = await ytDlpInfo();

const videos = (channel.videos || []).map((video) => ({
  ...video,
  durationSec: Number.isFinite(Number(video.durationSec)) ? Number(video.durationSec) : null,
  durationString: video.duration || video.durationString || null,
  fps: Number.isFinite(Number(video.fps)) ? Number(video.fps) : null,
  width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
  height: Number.isFinite(Number(video.height)) ? Number(video.height) : null
}));

const incomplete = videos.filter((video) => !Number.isFinite(video.durationSec) || !Number.isFinite(video.fps) || !Number.isFinite(video.width) || !Number.isFinite(video.height));
if (incomplete.length) {
  throw new Error(`${incomplete.length}개 Shorts의 길이·해상도 메타데이터가 없습니다. 먼저 bun run channel:refresh를 실행하세요.`);
}

const durations = videos.map((video) => video.durationSec).sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.max(0, Math.round((durations.length - 1) * value)))];
const summary = durations.length ? {
  minSec: durations[0],
  maxSec: durations.at(-1),
  meanSec: Number((durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(2)),
  medianSec: percentile(0.5),
  p10Sec: percentile(0.1),
  p90Sec: percentile(0.9),
  recommendedTargetSec: percentile(0.5),
  recommendedRangeSec: [percentile(0.25), percentile(0.75)]
} : null;
const recentWindow = videos.slice(0, Math.min(30, videos.length)).map((video) => video.durationSec).sort((left, right) => left - right);
const recentPercentile = (value) => recentWindow[Math.min(recentWindow.length - 1, Math.max(0, Math.round((recentWindow.length - 1) * value)))];
const recentSummary = recentWindow.length ? {
  population: recentWindow.length,
  meanSec: Number((recentWindow.reduce((sum, duration) => sum + duration, 0) / recentWindow.length).toFixed(2)),
  medianSec: recentPercentile(0.5),
  p25Sec: recentPercentile(0.25),
  p75Sec: recentPercentile(0.75),
  recommendedTargetSec: recentPercentile(0.5),
  recommendedRangeSec: [recentPercentile(0.25), recentPercentile(0.75)]
} : null;
const buckets = [["0–59초", 0, 60], ["60–89초", 60, 90], ["90–119초", 90, 120], ["120초 이상", 120, Infinity]].map(([label, min, max]) => ({
  label,
  count: videos.filter((video) => video.durationSec >= min && video.durationSec < max).length
}));
const resolutions = Object.entries(Object.groupBy(videos, (video) => `${video.width}x${video.height}`)).map(([resolution, items]) => ({ resolution, count: items.length }));
const output = {
  schemaVersion: 2,
  channel: channel.channel,
  channelId: channel.channelId || null,
  handle: channel.handle,
  source: `${channel.source || "https://www.youtube.com/@신비한_건축사전_1"}/shorts`,
  capturedAt: new Date().toISOString(),
  sourceSnapshotAt: channel.fetchedAt || null,
  capturedWith: {
    tool: "yt-dlp",
    version: tool.version,
    command: "channel:refresh full metadata snapshot",
    updateCommand: tool.maintenance
  },
  snapshotVideoCount: videos.length,
  metadataCount: videos.length,
  summary,
  recentSummary,
  buckets,
  resolutions,
  videos
};

await writeFile(resolve(root, "data/shorts-metadata.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  version: tool.version,
  snapshotVideoCount: output.snapshotVideoCount,
  metadataCount: output.metadataCount,
  summary,
  recentSummary,
  buckets,
  resolutions
}, null, 2));
