import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ytDlpCommand, ytDlpInfo } from "../src/yt-dlp.mjs";

const root = resolve(import.meta.dirname, "..");
const handle = "@신비한_건축사전_1";
const channelUrl = `https://www.youtube.com/${handle}`;
const language = String(process.env.YT_DLP_LANGUAGE || "ko").trim() || "ko";

async function readExisting(name) {
  try {
    const value = JSON.parse(await readFile(resolve(root, "data", name), "utf8"));
    return new Map((value.videos || []).map((video) => [video.id, video]));
  } catch {
    return new Map();
  }
}

async function previousSubscriberCount() {
  try {
    const analysis = JSON.parse(await readFile(resolve(root, "data/channel-analysis.json"), "utf8"));
    return Number(analysis?.snapshot?.subscribers || 0) || null;
  } catch {
    return null;
  }
}

async function playlist(section) {
  const processHandle = Bun.spawn([
    ytDlpCommand(),
    "--flat-playlist",
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--extractor-args",
    `youtube:lang=${language}`,
    "--dump-single-json",
    `${channelUrl}/${section}`
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  const code = await processHandle.exited;
  if (code !== 0 || !stdout.trim()) {
    throw new Error(`YouTube ${section} 목록 수집 실패: ${stderr.trim().slice(-1200) || `exit ${code}`}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`YouTube ${section} 목록 응답이 JSON이 아닙니다.`);
  }
}

async function flatMetadata(section) {
  const processHandle = Bun.spawn([
    ytDlpCommand(),
    "--flat-playlist",
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--print",
    "%(id)s\\t%(view_count)s\\t%(timestamp)s\\t%(duration)s\\t%(fps)s\\t%(width)s\\t%(height)s",
    `${channelUrl}/${section}`
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  const code = await processHandle.exited;
  if (code !== 0 && !stdout.trim()) throw new Error(`YouTube ${section} 상세 메타데이터 수집 실패: ${stderr.trim().slice(-1200) || `exit ${code}`}`);
  const records = new Map();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [id, viewCount, timestampValue, durationSec, fps, width, height] = line.split("\\t");
    if (!id) continue;
    const numeric = (value) => value && value !== "NA" && Number.isFinite(Number(value)) ? Number(value) : null;
    records.set(id, {
      view_count: numeric(viewCount),
      timestamp: numeric(timestampValue),
      duration: numeric(durationSec),
      fps: numeric(fps),
      width: numeric(width),
      height: numeric(height)
    });
  }
  return records;
}

async function cachedShortMetadata() {
  try {
    const value = JSON.parse(await readFile(resolve(root, "data/shorts-metadata.json"), "utf8"));
    return new Map((value.videos || []).filter((video) => video?.id).map((video) => [video.id, {
      duration: Number.isFinite(Number(video.durationSec)) ? Number(video.durationSec) : null,
      fps: Number.isFinite(Number(video.fps)) ? Number(video.fps) : null,
      width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
      height: Number.isFinite(Number(video.height)) ? Number(video.height) : null
    }]));
  } catch {
    return new Map();
  }
}

async function hydrateMissing(entries) {
  if (!entries.length) return new Map();
  const processHandle = Bun.spawn([
    ytDlpCommand(),
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--print",
    "%(id)s\\t%(view_count)s\\t%(timestamp)s\\t%(duration)s\\t%(fps)s\\t%(width)s\\t%(height)s",
    ...entries.map((entry) => entry.type === "short"
      ? `https://www.youtube.com/shorts/${entry.id}`
      : `https://www.youtube.com/watch?v=${entry.id}`)
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  const code = await processHandle.exited;
  if (code !== 0 && !stdout.trim()) throw new Error(`누락 영상 상세 메타데이터 수집 실패: ${stderr.trim().slice(-1200) || `exit ${code}`}`);
  const records = new Map();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [id, viewCount, timestampValue, durationSec, fps, width, height] = line.split("\\t");
    if (!id) continue;
    const numeric = (value) => value && value !== "NA" && Number.isFinite(Number(value)) ? Number(value) : null;
    records.set(id, { view_count: numeric(viewCount), timestamp: numeric(timestampValue), duration: numeric(durationSec), fps: numeric(fps), width: numeric(width), height: numeric(height) });
  }
  return records;
}

async function profile() {
  const processHandle = Bun.spawn([
    ytDlpCommand(),
    "--flat-playlist",
    "--playlist-end",
    "1",
    "--skip-download",
    "--ignore-errors",
    "--no-warnings",
    "--extractor-args",
    `youtube:lang=${language}`,
    "--dump-single-json",
    channelUrl
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  const code = await processHandle.exited;
  if (code !== 0 || !stdout.trim()) throw new Error(`YouTube 채널 프로필 수집 실패: ${stderr.trim().slice(-1200) || `exit ${code}`}`);
  return JSON.parse(stdout);
}

function durationString(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function localizedViews(value) {
  const views = Number(value);
  if (!Number.isFinite(views) || views < 0) return null;
  if (views >= 100_000_000) return `조회수 ${(views / 100_000_000).toFixed(1).replace(/\.0$/u, "")}억회`;
  if (views >= 10_000) return `조회수 ${(views / 10_000).toFixed(1).replace(/\.0$/u, "")}만회`;
  if (views >= 1_000) return `조회수 ${(views / 1_000).toFixed(1).replace(/\.0$/u, "")}천회`;
  return `조회수 ${Math.round(views)}회`;
}

function bestThumbnail(entry) {
  const thumbnails = Array.isArray(entry?.thumbnails) ? entry.thumbnails.filter((item) => item?.url) : [];
  return thumbnails.sort((left, right) => Number(right.width || 0) * Number(right.height || 0) - Number(left.width || 0) * Number(left.height || 0))[0]?.url || null;
}

function normalize(payload, type, existing, metadata = new Map()) {
  const entries = Array.isArray(payload.entries) ? payload.entries.filter((entry) => entry?.id) : [];
  return entries.map((entry, index) => {
    const previous = existing.get(entry.id) || {};
    const numberOrNull = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
    const detail = metadata.get(entry.id) || {};
    const entryViews = numberOrNull(detail.view_count ?? entry.view_count);
    const previousViews = numberOrNull(previous.viewCount);
    const viewCount = entryViews ?? previousViews;
    const entryDuration = numberOrNull(detail.duration ?? entry.duration);
    const previousDuration = numberOrNull(previous.durationSec);
    const durationSec = entryDuration ?? previousDuration;
    const entryTimestamp = numberOrNull(detail.timestamp ?? entry.timestamp);
    const previousTimestamp = numberOrNull(previous.timestamp);
    return {
      ...previous,
      position: index + 1,
      id: entry.id,
      title: String(entry.title || previous.title || entry.id).trim(),
      views: entryViews !== null ? localizedViews(entryViews) : previous.views || localizedViews(previousViews),
      viewCount,
      durationSec,
      duration: entryDuration !== null ? durationString(entryDuration) : previous.duration || durationString(previousDuration),
      timestamp: entryTimestamp ?? previousTimestamp,
      fps: numberOrNull(detail.fps) ?? numberOrNull(previous.fps),
      width: numberOrNull(detail.width) ?? numberOrNull(previous.width),
      height: numberOrNull(detail.height) ?? numberOrNull(previous.height),
      thumbnail: bestThumbnail(entry) || previous.thumbnail || null,
      url: type === "short"
        ? `https://www.youtube.com/shorts/${entry.id}`
        : `https://www.youtube.com/watch?v=${entry.id}`,
      type
    };
  });
}

const [profilePayload, videosPayload, shortsPayload, videoMetadata, shortFlatMetadata, shortDurationCache, existingVideos, existingShorts, previousSubscribers, tool] = await Promise.all([
  profile(),
  playlist("videos"),
  playlist("shorts"),
  flatMetadata("videos"),
  flatMetadata("shorts"),
  cachedShortMetadata(),
  readExisting("channel-videos.json"),
  readExisting("channel-shorts.json"),
  previousSubscriberCount(),
  ytDlpInfo()
]);

const fetchedAt = new Date().toISOString();
const channel = profilePayload.channel || videosPayload.channel || shortsPayload.channel || "신비한 건축사전";
const channelId = profilePayload.channel_id || videosPayload.channel_id || shortsPayload.channel_id || null;
const subscriberCount = Number(
  profilePayload.channel_follower_count
  || videosPayload.channel_follower_count
  || shortsPayload.channel_follower_count
  || process.env.CHANNEL_SUBSCRIBER_COUNT
  || previousSubscribers
  || 0
) || null;
const description = profilePayload.description || videosPayload.description || shortsPayload.description || null;
const common = {
  schemaVersion: 2,
  channel,
  channelId,
  handle,
  source: channelUrl,
  subscriberCount,
  description,
  fetchedAt,
  capturedWith: {
    tool: "yt-dlp",
    version: tool.version,
    language,
    mode: "flat-playlist"
  }
};
for (const [id, cached] of shortDurationCache) {
  shortFlatMetadata.set(id, { ...cached, ...(shortFlatMetadata.get(id) || {}) });
  const record = shortFlatMetadata.get(id);
  if (record?.duration == null) record.duration = cached.duration;
  if (record?.fps == null) record.fps = cached.fps;
  if (record?.width == null) record.width = cached.width;
  if (record?.height == null) record.height = cached.height;
}
let videos = normalize(videosPayload, "video", existingVideos, videoMetadata);
let shorts = normalize(shortsPayload, "short", existingShorts, shortFlatMetadata);
const missing = [...videos, ...shorts].filter((video) => !Number.isFinite(video.viewCount) || !Number.isFinite(video.durationSec));
const hydrated = await hydrateMissing(missing);
if (missing.length) {
  for (const [id, detail] of hydrated) {
    const current = shortFlatMetadata.get(id) || videoMetadata.get(id) || {};
    const merged = Object.fromEntries(Object.keys({ ...current, ...detail }).map((key) => [key, detail[key] ?? current[key]]));
    if (shorts.some((video) => video.id === id)) shortFlatMetadata.set(id, merged);
    else videoMetadata.set(id, merged);
  }
  videos = normalize(videosPayload, "video", existingVideos, videoMetadata);
  shorts = normalize(shortsPayload, "short", existingShorts, shortFlatMetadata);
}

if (!videos.length || !shorts.length) throw new Error("채널의 Videos 또는 Shorts 목록이 비어 있습니다.");
if ([...videos, ...shorts].some((video) => !Number.isFinite(video.viewCount) || !Number.isFinite(video.durationSec))) {
  throw new Error("조회수 또는 길이가 누락된 영상이 있어 불완전한 스냅샷을 저장하지 않습니다.");
}
if (new Set([...videos, ...shorts].map((video) => video.id)).size !== videos.length + shorts.length) {
  throw new Error("Videos와 Shorts 사이에 중복 ID가 있어 완전한 스냅샷을 만들 수 없습니다.");
}

await Promise.all([
  writeFile(resolve(root, "data/channel-videos.json"), JSON.stringify({ ...common, videos }, null, 2)),
  writeFile(resolve(root, "data/channel-shorts.json"), JSON.stringify({ ...common, videos: shorts }, null, 2))
]);

console.log(JSON.stringify({
  channel,
  channelId,
  subscriberCount,
  videos: videos.length,
  shorts: shorts.length,
  total: videos.length + shorts.length,
  fetchedAt,
  ytDlpVersion: tool.version
}, null, 2));
