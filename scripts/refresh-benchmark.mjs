import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ytDlpCommand, ytDlpInfo } from "../src/yt-dlp.mjs";

const root = resolve(import.meta.dirname, "..");
const channel = JSON.parse(await readFile(resolve(root, "data/channel-shorts.json"), "utf8"));
const tool = await ytDlpInfo();
const processHandle = Bun.spawn([
  ytDlpCommand(),
  "--skip-download",
  "--ignore-errors",
  "--no-warnings",
  "--print",
  "%(id)s\\t%(duration)s\\t%(duration_string)s\\t%(fps)s\\t%(width)s\\t%(height)s\\t%(title)s",
  "https://www.youtube.com/@신비한_건축사전_1/shorts"
], { cwd: root, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
const code = await processHandle.exited;
if (code !== 0 && !stdout.trim()) throw new Error(`yt-dlp 메타데이터 수집 실패: ${stderr.trim().slice(-1200)}`);

const metadata = new Map();
for (const line of stdout.trim().split("\n").filter(Boolean)) {
  const fields = line.split("\\t");
  const [id, duration, durationString, fps, width, height, ...titleParts] = fields;
  if (!id) continue;
  const durationSec = Number(duration);
  metadata.set(id, {
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    durationString: durationString === "NA" ? null : durationString,
    fps: Number.isFinite(Number(fps)) ? Number(fps) : null,
    width: Number.isFinite(Number(width)) ? Number(width) : null,
    height: Number.isFinite(Number(height)) ? Number(height) : null,
    title: titleParts.join("\\t")
  });
}

const videos = channel.videos.map((video) => ({ ...video, ...(metadata.get(video.id) || { durationSec: null, durationString: null, fps: null, width: null, height: null }) }));
const valid = videos.filter((video) => Number.isFinite(video.durationSec));
const durations = valid.map((video) => video.durationSec).sort((a, b) => a - b);
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
const buckets = [["0–59초", 0, 60], ["60–89초", 60, 90], ["90–119초", 90, 120], ["120초 이상", 120, Infinity]].map(([label, min, max]) => ({ label, count: valid.filter((video) => video.durationSec >= min && video.durationSec < max).length }));
const resolutions = Object.entries(Object.groupBy(valid, (video) => `${video.width}x${video.height}`)).map(([resolution, items]) => ({ resolution, count: items.length }));
const output = {
  schemaVersion: 1,
  channel: channel.channel,
  handle: channel.handle,
  source: "https://www.youtube.com/@신비한_건축사전_1/shorts",
  capturedAt: new Date().toISOString(),
  capturedWith: { tool: "yt-dlp", version: tool.version, command: "--skip-download --print metadata", updateCommand: tool.maintenance },
  snapshotVideoCount: channel.videos.length,
  metadataCount: valid.length,
  summary,
  buckets,
  resolutions,
  videos
};
await writeFile(resolve(root, "data/shorts-metadata.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ version: tool.version, snapshotVideoCount: output.snapshotVideoCount, metadataCount: output.metadataCount, summary, buckets, resolutions }, null, 2));
