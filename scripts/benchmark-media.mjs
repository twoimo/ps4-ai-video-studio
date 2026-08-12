import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { analyzeVideo } from "../src/frame-analysis.mjs";
import { sanitizeBenchmarkAnalysis, selectBenchmarkCaptionFile } from "../src/benchmark-media-receipt.mjs";
import { ytDlpCommand, ytDlpInfo } from "../src/yt-dlp.mjs";

const root = resolve(import.meta.dirname, "..");
const downloadDir = join(root, "workspace", "benchmark-sources");
await mkdir(downloadDir, { recursive: true });
const channel = JSON.parse(await readFile(join(root, "data/channel-shorts.json"), "utf8"));
const population = Array.isArray(channel.videos) ? channel.videos : [];
if (!population.length) throw new Error("분석할 Shorts 스냅샷이 비어 있습니다. 먼저 bun run channel:refresh를 실행하세요.");
const requestedLimit = Number(process.env.BENCHMARK_LIMIT || 12);
const limit = Math.max(1, Math.min(population.length, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 12));
function temporalStratifiedSample(videos, sampleSize) {
  if (sampleSize >= videos.length) return [...videos];
  if (sampleSize === 1) return [videos[0]];
  const positions = new Set();
  for (let index = 0; index < sampleSize; index += 1) {
    positions.add(Math.round(index * (videos.length - 1) / (sampleSize - 1)));
  }
  for (let index = 0; positions.size < sampleSize && index < videos.length; index += 1) positions.add(index);
  return [...positions].sort((left, right) => left - right).map((position) => videos[position]);
}
const selected = temporalStratifiedSample(population, limit);
const ytDlp = ytDlpCommand();
const downloaded = [];
const failures = [];

function portableError(value) {
  return String(value || "")
    .replaceAll(root, ".")
    .replaceAll("\\", "/")
    .trim()
    .slice(-600);
}

for (const video of selected) {
  const existing = (await readdir(downloadDir)).find((name) => name.startsWith(`${video.id}.`) && /\.(mp4|webm|mkv|mov)$/i.test(name));
  if (!existing) {
    const processHandle = Bun.spawn([
      ytDlp,
      "--no-progress",
      "--no-warnings",
      "--continue",
      "--no-overwrites",
      "-f",
      "bv*[height<=360]+ba/b[height<=360]",
      "--merge-output-format",
      "mp4",
      "-o",
      join(downloadDir, `${video.id}.%(ext)s`),
      video.url
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
    const code = await processHandle.exited;
    if (code !== 0) {
      const reason = portableError(stderr || stdout || `yt-dlp exited with ${code}`);
      failures.push({ id: video.id, title: video.title, sourceUrl: video.url, stage: "download", exitCode: code, reason });
      console.warn(`skip ${video.id}: ${reason}`);
      continue;
    }
  }
  if (process.env.BENCHMARK_SUBS === "1") {
    const captionExists = Boolean(selectBenchmarkCaptionFile(await readdir(downloadDir), video.id));
    if (!captionExists) {
      const subtitleProcess = Bun.spawn([ytDlp, "--skip-download", "--write-auto-subs", "--sub-langs", "ko,en", "--sub-format", "vtt", "-o", join(downloadDir, `${video.id}.%(ext)s`), video.url], { cwd: root, stdout: "pipe", stderr: "pipe" });
      await Promise.all([new Response(subtitleProcess.stdout).text(), new Response(subtitleProcess.stderr).text()]);
      await subtitleProcess.exited;
    }
  }
  const file = (await readdir(downloadDir)).find((name) => name.startsWith(`${video.id}.`) && /\.(mp4|webm|mkv|mov)$/i.test(name));
  if (file) downloaded.push({ ...video, path: join(downloadDir, file) });
}

const analyses = [];
for (const item of downloaded) {
  try {
    const captionFile = selectBenchmarkCaptionFile(await readdir(downloadDir), item.id);
    const captionText = captionFile ? await readFile(join(downloadDir, captionFile), "utf8") : "";
    let analysis = await analyzeVideo(item.path, { frames: true, audio: true, captionText });
    analysis.file = relative(root, item.path).split("\\").join("/");
    const frameSeries = analysis.frames?.frames;
    if (Array.isArray(frameSeries)) {
      analysis.frames.framesOmittedFromReceipt = frameSeries.length;
      analysis.frames.frames = [];
    }
    analysis = sanitizeBenchmarkAnalysis(analysis, { captionText, captionFile });
    analyses.push({ id: item.id, title: item.title, sourceUrl: item.url, captionFile: captionFile || null, analysis });
  } catch (error) {
    analyses.push({ id: item.id, title: item.title, sourceUrl: item.url, error: error.message });
  }
}

const tool = await ytDlpInfo();
const output = {
  schemaVersion: 2,
  analyzedAt: new Date().toISOString(),
  source: channel.channel,
  channelId: channel.channelId || null,
  sourceSnapshotAt: channel.fetchedAt || null,
  populationCount: population.length,
  limit,
  selectionMethod: "temporal-stratified-across-full-shorts-snapshot",
  selected: selected.map(({ id, position, title, url }) => ({ id, position, title, url })),
  downloadedCount: downloaded.length,
  failures,
  capturedWith: { tool: "yt-dlp", version: tool.version, format: "<=360p video+audio" },
  analyses
};
await writeFile(join(root, "data/benchmark-media-analysis.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ toolVersion: tool.version, requested: limit, downloaded: downloaded.length, output: "data/benchmark-media-analysis.json", durations: analyses.map((item) => item.analysis?.media?.durationSec || null) }, null, 2));
