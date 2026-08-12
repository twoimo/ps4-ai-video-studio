import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const AHP_CRITERIA = [
  { id: "hookStory", label: "훅·서사 구조", weight: 25 },
  { id: "visualConsistency", label: "시각 일관성·생성 품질", weight: 25 },
  { id: "editRhythm", label: "편집 리듬·장면 연결", weight: 15 },
  { id: "captionsAudio", label: "자막·음성·오디오 믹스", weight: 15 },
  { id: "factSourceFit", label: "사실성·출처·벤치마크 적합성", weight: 10 },
  { id: "automationRecovery", label: "자동화 재현성·실패 복구", weight: 10 }
];

async function fileReceipt(relativePath) {
  const path = resolve(root, relativePath);
  const bytes = await readFile(path);
  const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
  return { path: relativePath, bytes: bytes.length, sha256: `sha256:${hash}` };
}
const shortMetadata = JSON.parse(await readFile(resolve(root, "data/shorts-metadata.json"), "utf8"));
const durationById = new Map(shortMetadata.videos.map((video) => [video.id, video]));
const shorts = JSON.parse(await readFile(resolve(root, "data/channel-shorts.json"), "utf8")).videos.map((video) => ({ ...video, ...(durationById.get(video.id) || {}) }));
const longVideos = JSON.parse(await readFile(resolve(root, "data/channel-videos.json"), "utf8")).videos;
const videos = [...longVideos, ...shorts];

const categoryRules = [
  { id: "water", label: "물·도시 인프라", terms: ["물", "비", "홍수", "배수", "하천", "강", "댐", "방조제", "수도", "우물", "호수", "섬", "갯벌", "바다", "해변"] },
  { id: "seoul", label: "서울의 숨은 구조", terms: ["서울", "한강", "광화문", "아파트", "지하철", "도시", "한양", "강남", "북악산"] },
  { id: "architecture", label: "건축·구조 원리", terms: ["아파트", "건물", "벽", "다리", "도로", "공항", "터널", "교량", "콘크리트", "유리", "지붕", "돌", "성벽", "기둥"] },
  { id: "joseon", label: "조선·궁궐·성곽", terms: ["조선", "궁궐", "경복궁", "창덕궁", "창경궁", "종묘", "한양도성", "남한산성", "성벽", "임금", "세종"] },
  { id: "ancient", label: "고대 문명·유산", terms: ["로마", "그리스", "마추픽추", "트로이", "고대", "성문", "돌기둥", "왕릉", "유적"] },
  { id: "climate", label: "에너지·기후 대응", terms: ["에어컨", "냉방", "발전소", "온실", "열", "기온", "환기", "단열", "소방", "불"] }
];

const hookRules = [
  { id: "why", label: "왜 그랬을까", terms: ["이유", "왜", "비밀"] },
  { id: "contradiction", label: "상식 뒤집기", terms: ["사실은", "아닙니다", "없습니다", "아니라", "못", "안 "] },
  { id: "scale", label: "숫자·스케일", terms: ["만", "천", "미터", "톤", "년", "억", "층", "개"] },
  { id: "hidden", label: "숨은 장소·장치", terms: ["숨어", "밑에", "지하", "속", "옆", "그 "] },
  { id: "method", label: "불가능을 가능하게", terms: ["방법", "만든", "세운", "옮긴", "붙잡", "막은"] }
];

function parseViews(value = "") {
  const match = value.match(/([\d.]+)(만|천)?회/);
  if (!match) return 0;
  const multiplier = match[2] === "만" ? 10000 : match[2] === "천" ? 1000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function classify(title) {
  const categories = categoryRules
    .map((rule) => ({ ...rule, score: rule.terms.reduce((score, term) => score + (title.includes(term) ? 1 : 0), 0) }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ id, label, score }) => ({ id, label, score }));
  const hooks = hookRules
    .map((rule) => ({ ...rule, score: rule.terms.reduce((score, term) => score + (title.includes(term) ? 1 : 0), 0) }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ id, label, score }) => ({ id, label, score }));
  const question = /[?？]/.test(title) || /이유|왜|어디서|어떻게|무엇/.test(title);
  const contrast = /사실은|아닙니다|없습니다|아니라|못|안 /.test(title);
  const number = /\d|만|천|억|미터|톤|년|층|개/.test(title);
  const score = Math.min(100, 28 + (question ? 20 : 0) + (contrast ? 22 : 0) + (number ? 15 : 0) + Math.min(15, categories.length * 5));
  return {
    categories,
    hooks,
    hookScore: score,
    flags: { question, contrast, number },
    confidence: "heuristic-title-only",
    evidenceRequired: true,
    method: "keyword-rules-v1"
  };
}

const enriched = videos.map((video) => ({
  ...video,
  viewCount: parseViews(video.views),
  analysis: classify(video.title)
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
    snapshotVersion: 2,
    sourceType: "yt-dlp-channel-metadata",
    sourceUrl: "https://www.youtube.com/@신비한_건축사전_1",
    inputFiles: sourceReceipts,
    completeness: {
      expectedVideos: videos.length,
      indexedVideos: enriched.length,
      shorts: shorts.length,
      longVideos: longVideos.length,
      complete: videos.length === enriched.length
    },
    analysisLimitations: [
      "title classification is heuristic and does not establish visual, audio, caption, or factual entailment evidence",
      "media evidence is collected separately by benchmark:media",
      "exact source wording and original assets are not copied"
    ]
  },
  ahp: {
    schemaVersion: 1,
    weights: AHP_CRITERIA,
    weightTotal: ahpWeightTotal,
    scoreScale: "0-100 per criterion; weighted sum",
    semanticEligibilityRequires: ["approved video-generation provider", "run-bound provider/model provenance", "committee evidence", "terminal immutable closure"]
  },
  snapshot: { subscribers: 449000, totalVideos: videos.length, shorts: shorts.length, longVideos: longVideos.length, shortsMetadataCount: shortMetadata.metadataCount },
  shortsDuration: shortMetadata.summary,
  editorialModel: {
    promise: "평범한 공간·시설에서 의외의 설계 원리를 발견하게 한다.",
    titleFormula: "[익숙한 대상] + [상식과 반대되는 사실] + [이유/방법/숨은 구조]",
    narrative: [
      { step: 1, name: "0–2초 훅", detail: "결론을 숨기지 않고 낯선 사실 또는 강한 숫자로 즉시 시작" },
      { step: 2, name: "문제 재정의", detail: "시청자가 매일 보던 대상을 새 질문으로 바꿈" },
      { step: 3, name: "구조 시각화", detail: "단면·위치·물의 흐름·하중을 AI 이미지/영상으로 설명" },
      { step: 4, name: "원리 증명", detail: "역사적 맥락과 물리적 원리를 짧은 문장으로 연결" },
      { step: 5, name: "잔상", detail: "처음의 질문에 한 문장으로 답하고 다음 호기심을 남김" }
    ],
    visualLanguage: ["세로 9:16", "어두운 시네마틱 톤", "고대·현대 구조의 단면/항공 시점", "큰 흰색 자막", "짧은 컷과 느린 카메라 이동"],
    productionNotes: ["제목은 설명문보다 질문·반전형 문장", "사실 주장마다 출처를 수집", "AI 생성 장면은 실제 자료 영상과 구분", "자막은 2–7단어 단위로 리듬을 맞춤"]
  },
  categories: categorySummary,
  hooks: hookSummary,
  topVideos: topVideos.map(({ analysis, ...video }) => ({ ...video, analysis })),
  videos: enriched
};

await mkdir(resolve(root, "data"), { recursive: true });
await writeFile(resolve(root, "data/channel-analysis.json"), JSON.stringify(result, null, 2));
console.log(`Wrote ${result.videos.length} analyzed videos to data/channel-analysis.json`);
