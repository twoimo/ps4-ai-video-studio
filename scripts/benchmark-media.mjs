import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { analyzeVideo } from "../src/frame-analysis.mjs";
import { ytDlpCommand, ytDlpInfo } from "../src/yt-dlp.mjs";

const root = resolve(import.meta.dirname, "..");
const limit = Math.max(1, Math.min(242, Number(process.env.BENCHMARK_LIMIT || 3)));
const downloadDir = join(root, "workspace", "benchmark-sources");
await mkdir(downloadDir, { recursive: true });
const channel = JSON.parse(await readFile(join(root, "data/channel-shorts.json"), "utf8"));
const selected = channel.videos.slice(0, limit);
const ytDlp = ytDlpCommand();
const downloaded = [];

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
      console.warn(`skip ${video.id}: ${(stderr || stdout).trim().slice(-600)}`);
      continue;
    }
  }
  if (process.env.BENCHMARK_SUBS === "1") {
    const captionExists = (await readdir(downloadDir)).some((name) => name.startsWith(`${video.id}.`) && name.endsWith(".vtt"));
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
    const captionFile = (await readdir(downloadDir)).find((name) => name.startsWith(`${item.id}.`) && name.endsWith(".vtt"));
    const captionText = captionFile ? await readFile(join(downloadDir, captionFile), "utf8") : "";
    const analysis = await analyzeVideo(item.path, { frames: true, audio: true, captionText });
    analyses.push({ id: item.id, title: item.title, sourceUrl: item.url, captionFile: captionFile || null, analysis });
  } catch (error) {
    analyses.push({ id: item.id, title: item.title, sourceUrl: item.url, error: error.message });
  }
}

const tool = await ytDlpInfo();
const output = { schemaVersion: 1, analyzedAt: new Date().toISOString(), source: channel.channel, limit, downloadedCount: downloaded.length, capturedWith: { tool: "yt-dlp", version: tool.version, format: "<=360p video+audio" }, analyses };
await writeFile(join(root, "data/benchmark-media-analysis.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ toolVersion: tool.version, requested: limit, downloaded: downloaded.length, output: "data/benchmark-media-analysis.json", durations: analyses.map((item) => item.analysis?.media?.durationSec || null) }, null, 2));
