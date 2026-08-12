import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FULL_BIN = process.env.FFMPEG_FULL_BIN || "/opt/homebrew/opt/ffmpeg-full/bin";

function binary(command) {
  const override = command === "ffmpeg" ? process.env.FFMPEG_BINARY : command === "ffprobe" ? process.env.FFPROBE_BINARY : null;
  if (override && existsSync(override)) return override;
  if ((command === "ffmpeg" || command === "ffprobe") && existsSync(join(FULL_BIN, command))) return join(FULL_BIN, command);
  return typeof Bun.which === "function" ? Bun.which(command) : null;
}

async function run(command, args) {
  const path = binary(command);
  if (!path) throw new Error(`${command}가 설치되어 있지 않습니다.`);
  const processHandle = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  const code = await processHandle.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) throw new Error(`${command} 실행 실패 (${code}): ${(stderr || stdout).trim().slice(-1200)}`);
  return { stdout, stderr };
}

async function probe(path) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  const payload = JSON.parse(stdout);
  const videoStreams = payload.streams?.filter((stream) => stream.codec_type === "video") || [];
  const audioStreams = payload.streams?.filter((stream) => stream.codec_type === "audio") || [];
  const video = videoStreams[0] || null;
  const audio = audioStreams[0] || null;
  const rate = (video?.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    durationSec: Number(payload.format?.duration || video?.duration || audio?.duration || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: rate[1] ? rate[0] / rate[1] : 0,
    frameCount: Number(video?.nb_frames || 0),
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    sampleRate: Number(audio?.sample_rate || 0),
    channels: Number(audio?.channels || 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio)
  };
}

function parseFrameLines(stderr) {
  const frames = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("showinfo")) continue;
    const match = line.match(/n:\s*(\d+).*?pts_time:\s*([\d.]+).*?checksum:\s*([0-9A-F]+).*?mean:\[([^\]]+)\].*?stdev:\[([^\]]+)\]/);
    if (!match) continue;
    frames.push({ frame: Number(match[1]), timeSec: Number(match[2]), checksum: match[3], mean: match[4].trim().split(/\s+/).map(Number), stdev: match[5].trim().split(/\s+/).map(Number) });
  }
  return frames;
}

async function analyzeFrames(path) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", path, "-vf", "showinfo", "-an", "-f", "null", "-"]);
  const frames = parseFrameLines(stderr);
  const { stderr: sceneStderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", path, "-vf", "select='gt(scene,0.25)',showinfo", "-an", "-f", "null", "-"]);
  const sceneFrames = parseFrameLines(sceneStderr);
  const timelineSceneFrames = sceneFrames.map((cut) => {
    const nearest = frames.reduce((best, frame) => !best || Math.abs(frame.timeSec - cut.timeSec) < Math.abs(best.timeSec - cut.timeSec) ? frame : best, null);
    return { ...cut, frame: nearest?.frame ?? cut.frame, detectorFrame: cut.frame };
  });
  const deltas = frames.slice(1).map((frame, index) => ({
    frame: frame.frame,
    timeSec: frame.timeSec,
    checksum: frame.checksum,
    delta: frame.mean.reduce((sum, value, channel) => sum + Math.abs(value - (frames[index].mean[channel] || 0)), 0)
  }));
  const sortedDeltas = deltas.map((item) => item.delta).sort((a, b) => a - b);
  const baseline = sortedDeltas.length ? sortedDeltas[Math.floor(sortedDeltas.length * 0.5)] : 0;
  const threshold = Math.max(12, baseline * 4);
  const differenceCuts = deltas.filter((item) => item.delta >= threshold).map(({ frame, timeSec, checksum, delta }) => ({ frame, timeSec, checksum, delta, detector: "frame-difference" }));
  const allCuts = [...timelineSceneFrames.map((frame) => ({ frame: frame.frame, detectorFrame: frame.detectorFrame, timeSec: frame.timeSec, checksum: frame.checksum, detector: "ffmpeg-scene" })), ...differenceCuts].sort((a, b) => a.timeSec - b.timeSec).filter((cut, index, cuts) => index === 0 || cut.timeSec - cuts[index - 1].timeSec > 0.1);
  return {
    frameCountObserved: frames.length,
    frames,
    sceneCutCount: allCuts.length,
    sceneCutThreshold: threshold,
    sceneCuts: allCuts
  };
}
function reconcileCuts(sceneCuts, expectedCutTimes = []) {
  const expected = expectedCutTimes.filter((value) => Number.isFinite(value) && value > 0);
  if (!expected.length) return { status: "not-applicable", toleranceSec: 0.75, expectedCutTimes: [], matches: [], missing: [] };
  const matches = expected.map((time) => {
    const nearest = sceneCuts.reduce((best, cut) => !best || Math.abs(cut.timeSec - time) < Math.abs(best.timeSec - time) ? cut : best, null);
    return nearest ? { expectedTimeSec: time, detectedTimeSec: nearest.timeSec, offsetSec: Number((nearest.timeSec - time).toFixed(3)), matched: Math.abs(nearest.timeSec - time) <= 0.75 } : { expectedTimeSec: time, detectedTimeSec: null, offsetSec: null, matched: false };
  });
  return { status: matches.every((match) => match.matched) ? "matched" : "mismatch", toleranceSec: 0.75, expectedCutTimes: expected, matches, missing: matches.filter((match) => !match.matched).map((match) => match.expectedTimeSec) };
}

async function analyzeAudio(path) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", path, "-af", "silencedetect=noise=-35dB:d=0.18,volumedetect", "-vn", "-f", "null", "-"]);
  const { stderr: loudnessStderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true:framelog=verbose", "-vn", "-f", "null", "-"]);
  const { stderr: statsStderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-af", "astats=metadata=1:reset=0", "-vn", "-f", "null", "-"]);
  const silenceStarts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const meanMatch = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const maxMatch = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  const integratedMatches = [...loudnessStderr.matchAll(/\bI:\s*(-?[\d.]+)\s*LUFS/gi)];
  const rangeMatches = [...loudnessStderr.matchAll(/\bLRA:\s*(-?[\d.]+)\s*LU/gi)];
  const peakMatches = [...loudnessStderr.matchAll(/\bPeak:\s*(-?[\d.]+)\s*dBFS/gi)];
  const clippedMatches = [...statsStderr.matchAll(/Number of clipped samples:\s*([\d.]+)/gi)];
  const integratedLufs = integratedMatches.length ? Number(integratedMatches.at(-1)[1]) : null;
  const loudnessRangeLu = rangeMatches.length ? Number(rangeMatches.at(-1)[1]) : null;
  const truePeakDbfs = peakMatches.length ? Number(peakMatches.at(-1)[1]) : null;
  const clippedSamples = clippedMatches.length ? Number(clippedMatches.at(-1)[1]) : Number.isFinite(truePeakDbfs) && truePeakDbfs <= 0 ? 0 : null;
  return {
    silenceCount: silenceStarts.length,
    silenceStarts,
    silenceEnds,
    meanVolumeDb: meanMatch ? Number(meanMatch[1]) : null,
    maxVolumeDb: maxMatch ? Number(maxMatch[1]) : null,
    integratedLufs,
    loudnessRangeLu,
    truePeakDbfs,
    clippedSamples,
    clipRisk: Number.isFinite(truePeakDbfs) && truePeakDbfs > 0 ? "true-peak-over-zero" : "not-detected",
    audioQc: {
      integratedLufs,
      loudnessRangeLu,
      truePeakDbfs,
      clippedSamples,
      clipRisk: Number.isFinite(truePeakDbfs) && truePeakDbfs > 0 ? "true-peak-over-zero" : "not-detected",
      status: Number.isFinite(integratedLufs) && Number.isFinite(truePeakDbfs) && Number.isFinite(clippedSamples) ? "measured" : "incomplete"
    },
    analyzedWith: "silencedetect(-35dB/0.18s)+volumedetect+ebur128(peak=true)+astats"
  };
}

function parseTimestamp(value) {
  const match = value.match(/(\d+):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}
function parseInlineWordTimings(value, cueStartSec, cueEndSec) {
  const matches = [...value.matchAll(/<(\d+:\d{2}:\d{2}[,.]\d{3})>\s*(?:<c[^>]*>)?([^<]*?)(?:<\/c>)?(?=<|$)/g)];
  return matches.map((match, index) => {
    const startSec = parseTimestamp(match[1]);
    const next = matches[index + 1] ? parseTimestamp(matches[index + 1][1]) : cueEndSec;
    return { startSec: Math.max(cueStartSec, startSec), endSec: Math.min(cueEndSec, Math.max(startSec, next)), text: match[2].trim() };
  }).filter((word) => word.text && word.endSec >= word.startSec);
}
export function analyzeCaptions(text) {
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const mergedBlocks = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    const hasCueText = timingIndex >= 0 && lines.slice(timingIndex + 1).some((line) => line.trim());
    if (timingIndex >= 0 && !hasCueText && blocks[index + 1] && !blocks[index + 1].includes("-->")) {
      mergedBlocks.push(`${block}\n${blocks[index + 1]}`);
      index += 1;
    } else {
      mergedBlocks.push(block);
    }
  }
  const rawEntries = mergedBlocks.map((block) => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return null;
    const [start, end] = lines[timingIndex].split("-->").map((part) => part.trim());
    const cueText = lines.slice(timingIndex + 1).join(" ");
    const captionText = cueText.replace(/<\d+:\d{2}:\d{2}[,.]\d{3}>/g, "").replace(/<\/?c[^>]*>/g, "").replace(/<[^>]+>/g, "").trim();
    const startSec = parseTimestamp(start);
    const endSec = parseTimestamp(end);
    const wordTimings = parseInlineWordTimings(cueText, startSec, endSec);
    const wordCount = wordTimings.length || captionText.split(/\s+|(?<=[가-힣])(?=[가-힣])/u).filter(Boolean).length;
    const durationSec = Math.max(0, endSec - startSec);
    return { startSec, endSec, durationSec, text: captionText, characterCount: captionText.length, wordCount, wordTimings, timingSource: wordTimings.length ? "vtt-inline" : "cue", charsPerSecond: durationSec ? Number((captionText.length / durationSec).toFixed(2)) : 0 };
  }).filter(Boolean);
  const entries = rawEntries.filter((entry, index, all) => {
    const previous = all[index - 1];
    return !(entry.durationSec < 0.08 && previous && entry.text === previous.text);
  });
  const overlaps = entries.filter((entry, index) => index > 0 && entry.startSec < entries[index - 1].endSec).length;
  const totalCharacters = entries.reduce((sum, entry) => sum + entry.characterCount, 0);
  const captionDurationSec = entries.reduce((sum, entry) => sum + entry.durationSec, 0);
  const gaps = entries.slice(1).map((entry, index) => Math.max(0, entry.startSec - entries[index].endSec));
  const wordTimings = entries.flatMap((entry) => entry.wordTimings);
  return {
    count: entries.length,
    totalCharacters,
    averageCharsPerSecond: captionDurationSec ? Number((totalCharacters / captionDurationSec).toFixed(2)) : 0,
    overlaps,
    coverageSec: Number(captionDurationSec.toFixed(3)),
    coverageEndSec: entries.length ? Number(Math.max(...entries.map((entry) => entry.endSec)).toFixed(3)) : 0,
    maxGapSec: gaps.length ? Number(Math.max(...gaps).toFixed(3)) : 0,
    nearContiguousGapCount: gaps.filter((gap) => gap > 0 && gap <= 0.02).length,
    wordTimingCount: wordTimings.length,
    timingSources: { inline: entries.filter((entry) => entry.timingSource === "vtt-inline").length, cue: entries.filter((entry) => entry.timingSource === "cue").length },
    entries,
    wordTimings
  };
}


async function readBenchmarkProfile(path = null) {
  try {
    return JSON.parse(await readFile(path || join(ROOT, "data/shorts-metadata.json"), "utf8"));
  } catch {
    return null;
  }
}

export function compareDuration(durationSec, profile, expected = null) {
  const expectedRange = Array.isArray(expected?.rangeSec) && expected.rangeSec.length === 2
    ? expected.rangeSec.map(Number)
    : null;
  const expectedTarget = Number(expected?.targetSec);
  if (
    Number.isFinite(durationSec)
    && Number.isFinite(expectedTarget)
    && expectedRange?.every(Number.isFinite)
    && expectedRange[0] >= 0
    && expectedRange[1] >= expectedRange[0]
  ) {
    return {
      available: true,
      source: "job-bound-target",
      targetSec: expectedTarget,
      rangeSec: expectedRange,
      deltaFromTargetSec: Number((durationSec - expectedTarget).toFixed(2)),
      insideRecommendedRange: durationSec >= expectedRange[0] && durationSec <= expectedRange[1]
    };
  }
  const summary = profile?.recentSummary || profile?.summary;
  if (!summary || !Number.isFinite(durationSec)) return { available: false };
  const range = summary.recommendedRangeSec || [summary.p10Sec, summary.p90Sec];
  return { available: true, source: profile?.recentSummary ? "benchmark-recent" : "benchmark-overall", targetSec: summary.recommendedTargetSec, rangeSec: range, deltaFromMedianSec: Number((durationSec - summary.medianSec).toFixed(2)), insideP10P90: durationSec >= summary.p10Sec && durationSec <= summary.p90Sec, insideRecommendedRange: durationSec >= range[0] && durationSec <= range[1] };
}

export async function analyzeVideo(path, options = {}) {
  const media = await probe(path);
  const frames = options.frames === false ? { frameCountObserved: 0, frames: [], sceneCutCount: 0, sceneCuts: [] } : await analyzeFrames(path);
  const audio = media.hasAudio && options.audio !== false ? await analyzeAudio(path) : { silenceCount: 0, silenceStarts: [], silenceEnds: [], meanVolumeDb: null, maxVolumeDb: null, integratedLufs: null, loudnessRangeLu: null, truePeakDbfs: null, clippedSamples: null, audioQc: { status: "incomplete" }, analyzedWith: null };
  const parsedCaptions = options.captionText ? analyzeCaptions(options.captionText) : { count: 0, totalCharacters: 0, averageCharsPerSecond: 0, overlaps: 0, coverageSec: 0, coverageEndSec: 0, maxGapSec: 0, nearContiguousGapCount: 0, wordTimingCount: 0, timingSources: { inline: 0, cue: 0 }, entries: [], wordTimings: [] };
  const captions = {
    ...parsedCaptions,
    coverageRatio: media.durationSec > 0 ? Number(Math.min(1, parsedCaptions.coverageSec / media.durationSec).toFixed(4)) : 0,
    uncaptionedTailSec: Number(Math.max(0, media.durationSec - parsedCaptions.coverageEndSec).toFixed(3)),
    captionOverrunSec: Number(Math.max(0, parsedCaptions.coverageEndSec - media.durationSec).toFixed(3)),
  };
  const benchmark = await readBenchmarkProfile(options.benchmarkPath);
  const cutReconciliation = reconcileCuts(frames.sceneCuts || [], options.expectedCutTimes || []);
  return { schemaVersion: 1, analyzedAt: new Date().toISOString(), runId: options.runId || null, file: path, media, frames, audio, captions, cutReconciliation, benchmarkDuration: compareDuration(media.durationSec, benchmark, options.expectedDuration) };
}

export async function analyzeJobMedia(jobDir, options = {}) {
  const finalPath = join(jobDir, "final.mp4");
  if (!existsSync(finalPath)) throw new Error("프레임 분석할 final.mp4가 없습니다.");
  const captionPath = existsSync(join(jobDir, "captions.vtt")) ? join(jobDir, "captions.vtt") : join(jobDir, "captions.srt");
  const captionText = existsSync(captionPath) ? await readFile(captionPath, "utf8") : "";
  const normalizedNames = (await readdir(join(jobDir, "normalized")).catch(() => [])).filter((name) => /\.(mp4|mov|webm|m4v|mkv)$/i.test(name)).sort();
  const expectedCutTimes = [];
  let cursor = 0;
  for (let index = 0; index < normalizedNames.length; index += 1) {
    const media = await probe(join(jobDir, "normalized", normalizedNames[index]));
    cursor += media.durationSec;
    if (index < normalizedNames.length - 1) expectedCutTimes.push(cursor);
  }
  const analysis = await analyzeVideo(finalPath, { ...options, captionText, expectedCutTimes });
  const qualityDir = join(jobDir, "quality");
  await mkdir(qualityDir, { recursive: true });
  await writeFile(join(qualityDir, "frame-audio-caption.json"), JSON.stringify(analysis, null, 2));
  await writeFile(join(jobDir, "frame-audio-caption.json"), JSON.stringify(analysis, null, 2));
  return analysis;
}
