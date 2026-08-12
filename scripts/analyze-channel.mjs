import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CATEGORY_RULES, EDITORIAL_HYPOTHESIS, HOOK_RULES, classifyChannelTitle } from "../src/channel-title-analysis.mjs";

const root = resolve(import.meta.dirname, "..");
const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 증거·미디어 규격", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "출처 텍스트 결속·벤치마크 적합성", weight: 10 },
  { id: "automationRecovery", label: "자동화 재현성·실패 복구", weight: 10 }
];

async function fileReceipt(relativePath) {
  const path = resolve(root, relativePath);
  const bytes = await readFile(path);
  const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
  return { path: relativePath, bytes: bytes.length, sha256: `sha256:${hash}` };
}
const shortMetadata = JSON.parse(await readFile(resolve(root, "data/shorts-metadata.json"), "utf8"));
const durationById = new Map(shortMetadata.videos.map((video) => [video.id, {
  durationSec: video.durationSec,
  durationString: video.durationString,
  fps: video.fps,
  width: video.width,
  height: video.height
}]));
const shortSnapshot = JSON.parse(await readFile(resolve(root, "data/channel-shorts.json"), "utf8"));
const videoSnapshot = JSON.parse(await readFile(resolve(root, "data/channel-videos.json"), "utf8"));
const shorts = shortSnapshot.videos.map((video) => ({ ...video, ...(durationById.get(video.id) || {}) }));
const longVideos = videoSnapshot.videos;
const videos = [...longVideos, ...shorts];

const categoryRules = CATEGORY_RULES;
const hookRules = HOOK_RULES;

function parseViews(value = "", exactValue = null) {
  if (Number.isFinite(Number(exactValue)) && Number(exactValue) >= 0) return Number(exactValue);
  const match = String(value || "").match(/([\d.]+)(만|천)?회/);
  if (!match) return 0;
  const multiplier = match[2] === "만" ? 10000 : match[2] === "천" ? 1000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

const enriched = videos.map((video) => ({
  ...video,
  viewCount: parseViews(video.views, video.viewCount),
  analysis: classifyChannelTitle(video.title)
}));

const categorySummary = categoryRules.map((rule) => {
  const matches = enriched.filter((video) => video.analysis.categories.some((category) => category.id === rule.id));
  const views = matches.reduce((sum, video) => sum + video.viewCount, 0);
  return {
    id: rule.id,
    label: rule.label,
    count: matches.length,
    totalViews: views,
    averageViews: matches.length ? Math.round(views / matches.length) : 0
  };
}).sort((a, b) => b.totalViews - a.totalViews);

const topVideos = [...enriched]
  .filter((video) => video.type === "short")
  .sort((a, b) => b.viewCount - a.viewCount)
  .slice(0, 20);

const hookSummary = hookRules.map((rule) => {
  const matches = enriched.filter((video) => video.analysis.hooks.some((hook) => hook.id === rule.id));
  const views = matches.reduce((sum, video) => sum + video.viewCount, 0);
  return { id: rule.id, label: rule.label, count: matches.length, averageViews: matches.length ? Math.round(views / matches.length) : 0 };
}).sort((a, b) => b.averageViews - a.averageViews);

const sourceReceipts = await Promise.all([
  fileReceipt("data/channel-shorts.json"),
  fileReceipt("data/channel-videos.json"),
  fileReceipt("data/shorts-metadata.json")
]);
const ahpWeightTotal = AHP_CRITERIA.reduce((sum, criterion) => sum + criterion.weight, 0);
const result = {
  channel: "신비한 건축사전",
  handle: "@신비한_건축사전_1",
  source: "https://www.youtube.com/@신비한_건축사전_1",
  fetchedAt: new Date().toISOString(),
  provenance: {
    snapshotVersion: 3,
    sourceType: "yt-dlp-channel-metadata",
    sourceUrl: "https://www.youtube.com/@신비한_건축사전_1",
    inputFiles: sourceReceipts,
    completeness: {
      expectedVideos: videos.length,
      indexedVideos: enriched.length,
      shorts: shorts.length,
      longVideos: longVideos.length,
      uniqueIds: new Set(videos.map((video) => video.id)).size,
      complete: videos.length === enriched.length && new Set(videos.map((video) => video.id)).size === videos.length
    },
    analysisLimitations: [
      "title classification is heuristic and does not establish visual, audio, caption, or factual entailment evidence",
      "editorialHypothesis is prescriptive guidance inferred from titles and metadata, not a measured audiovisual channel property",
      "media evidence is collected separately by benchmark:media",
      "exact source wording and original assets are not copied"
    ]
  },
  ahp: {
    schemaVersion: 1,
    weights: AHP_CRITERIA,
    weightTotal: ahpWeightTotal,
    scoreScale: "0-100 per criterion; weighted sum",
    technicalEvidenceRequires: ["approved video-generation provider", "run-bound provider/model provenance", "software-method evidence", "terminal immutable closure"],
    contentSemanticsMeasured: false
  },
  snapshot: {
    channelId: shortSnapshot.channelId || videoSnapshot.channelId || null,
    subscribers: shortSnapshot.subscriberCount || videoSnapshot.subscriberCount || null,
    totalVideos: videos.length,
    shorts: shorts.length,
    longVideos: longVideos.length,
    shortsMetadataCount: shortMetadata.metadataCount,
    capturedAt: shortSnapshot.fetchedAt || videoSnapshot.fetchedAt || null
  },
  shortsDuration: shortMetadata.summary,
  shortsRecentDuration: shortMetadata.recentSummary || null,
  editorialHypothesis: EDITORIAL_HYPOTHESIS,
  categories: categorySummary,
  hooks: hookSummary,
  topVideos: topVideos.map(({ analysis, ...video }) => ({ ...video, analysis })),
  videos: enriched
};

await mkdir(resolve(root, "data"), { recursive: true });
await writeFile(resolve(root, "data/channel-analysis.json"), JSON.stringify(result, null, 2));
console.log(`Wrote ${result.videos.length} analyzed videos to data/channel-analysis.json`);
