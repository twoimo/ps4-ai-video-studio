import {
  fillShotAnimatePrompt,
  fillShotStillPrompt,
  fillWorldSlots,
  inspectScriptPrompts,
  sanitizeWorldSlotOverrides
} from "./grok-imagine-template.mjs";

export const SCRIPT_CLOSER = "이렇게 설계된 겁니다.";

export const PROVIDER_ID = "grok-imagine";
export const PROVIDER_POLICY = "official-grok-cli-imagine-factory-no-fallback";
export const FACTORY_CLIP_COUNT = 7;
export const FACTORY_UNIQUE_COUNT = 6;
export const SHOT_DURATION_SEC = 10;
export const FACTORY_WIDTH = 720;
export const FACTORY_HEIGHT = 1280;
export const ANIMATE_QA_TIMES = [0.3, 5, 9.5];

export const GROK_MISSING_ERROR = "공식 grok CLI를 찾지 못했습니다. SuperGrok OAuth가 이미 되어 있는 기기에서 PATH의 grok 또는 ~/.grok/bin/grok로 실행하세요. Gemini로 대체하지 않습니다.";
export const GROK_AUTH_ERROR = "공식 grok CLI는 있으나 SuperGrok OAuth 세션이 없습니다. 이미 로그인된 기기에서 실행하세요. grok login/logout을 대신 실행하지 않으며 Gemini로 대체하지 않습니다.";
export const NO_GEMINI_FALLBACK = "Grok Imagine 공장은 Gemini로 대체하지 않습니다.";

const SI_PATTERN = /(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*)(?:m²|m2|㎡|km²|km2|km|mm|cm|m\b|층|°C|℃|t\b|톤|ℓ|L\b)|(?:[일이삼사오육칠팔구십백천만억]+)\s*(?:만)?\s*(?:m²|m2|㎡|제곱미터|평|층)|(?:\d+(?:\.\d+)?)\s*만\s*(?:m²|m2|㎡|제곱미터|평|톤|층)?/giu;
const FORBIDDEN_TOOLS_AFTER_HOOK = ["image_gen"];

export const UNIQUE_SLOT_TEMPLATES = [
  { id: "hook-wide", role: "hook", camera: "wide empty site, same world lock, no people", areaAllowed: false },
  { id: "material", role: "surface", camera: "close material surface, one short label", areaAllowed: false },
  { id: "section", role: "cutaway", camera: "section through the same structure, empty", areaAllowed: false },
  { id: "flow", role: "system", camera: "flow or load path, no body in water", areaAllowed: false },
  { id: "roof-scale", role: "scale", camera: "roof plane only when an area quantity is sourced", areaAllowed: true },
  { id: "detail", role: "proof", camera: "one mechanism detail of the same site", areaAllowed: false }
];

export const HOLD_SLOT_TEMPLATE = {
  id: "hold-return",
  role: "hold",
  camera: "return to the hook lock, no new label, no new quantity",
  areaAllowed: false,
  unique: false,
  holdOf: "hook-wide"
};

export const FACTORY_NARRATION_ARC = [
  { arc: "hook", type: "hook_photoreal" },
  { arc: "setup", type: "massing_studio" },
  { arc: "build", type: "cutaway_object" },
  { arc: "build", type: "mechanism_arrows" },
  { arc: "build", type: "cutaway_site" },
  { arc: "climax", type: "context_clay" },
  { arc: "landing", type: "payoff_photoreal" }
];

export const SHOT_TYPE_PRIORITY = [
  "cutaway_object",
  "hook_photoreal",
  "massing_studio",
  "mechanism_arrows",
  "cutaway_site",
  "context_clay",
  "payoff_photoreal",
  "spec_elevation"
];

const POWER_WORDS = /모래상자|저수조|물탱크|대피공간|놀이터|콘크리트|빗물|뚜껑|지붕|면적|모래|톤|갑문|수로|문비|볼트|대피|저류|우수/;

export function normalizeFacts(input) {
  if (Array.isArray(input)) return input.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return String(input || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function topicNouns(topic) {
  const cleaned = String(topic || "")
    .replace(/[?？!！.。,，]/g, " ")
    .replace(/(을까|일까|인가|하는|되는|위한|대한|관련|이유|방법|비밀|원리|이야기)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((token) => token.length >= 2 && !/^\d/.test(token));
  return [...new Set(tokens)].slice(0, 6);
}

export function extractLegalQuantities(facts = []) {
  const seen = new Set();
  const quantities = [];
  for (const fact of facts) {
    const text = String(fact || "");
    for (const match of text.matchAll(SI_PATTERN)) {
      const raw = match[0].replace(/\s+/g, " ").trim();
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      quantities.push({
        raw,
        display: numberizeToken(raw),
        isArea: /m²|m2|㎡|제곱미터/i.test(raw)
      });
    }
  }
  return quantities;
}

function numberizeToken(raw) {
  const koreanMap = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
  let value = String(raw).replace(/\s+/g, "");
  value = value.replace(/([일이삼사오육칠팔구])만/g, (_, digit) => String(koreanMap[digit] * 10000));
  value = value.replace(/(\d+(?:\.\d+)?)만/g, (_, n) => String(Number(n) * 10000));
  value = value
    .replace(/제곱미터/g, "m²")
    .replace(/m2/gi, "m²")
    .replace(/㎡/g, "m²")
    .replace(/km2/gi, "km²");
  value = value.replace(/\d{4,}(?!\.)/g, (digits) => Number(digits).toLocaleString("en-US"));
  return value.trim();
}

export function numberizeCaptionText(text, legalQuantities = []) {
  let next = numberizeLegalQuantities(text, legalQuantities);
  next = String(next).replace(new RegExp(SI_PATTERN.source, "giu"), (match) => numberizeToken(match));
  return next;
}

export function numberizeLegalQuantities(text, legalQuantities = []) {
  let next = String(text || "");
  const sorted = [...legalQuantities].sort((left, right) => right.raw.length - left.raw.length);
  for (const quantity of sorted) {
    if (!quantity?.raw) continue;
    const pattern = new RegExp(escapeRegExp(quantity.raw), "giu");
    next = next.replace(pattern, quantity.display);
    if (quantity.isArea) {
      next = next.replace(/제곱미터/g, "m²");
    }
  }
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inventedSiIn(text, legalQuantities = []) {
  const allowed = new Set(legalQuantities.flatMap((item) => [normalizeSi(item.raw), normalizeSi(item.display)]));
  const found = [];
  for (const match of String(text || "").matchAll(SI_PATTERN)) {
    const normalized = normalizeSi(match[0]);
    if (!allowed.has(normalized)) found.push(match[0].trim());
  }
  return found;
}

function normalizeSi(value) {
  return numberizeToken(value).replace(/,/g, "").replace(/\s+/g, "").toLowerCase();
}

export function topicAgnosticSlots(nouns = []) {
  const topicNoun = nouns[0] || "site";
  return UNIQUE_SLOT_TEMPLATES.map((slot) => ({
    ...slot,
    unique: true,
    topicNoun,
    promptNouns: nouns,
    description: `${slot.camera}; topic nouns only: ${nouns.join(", ") || topicNoun}`
  }));
}

function factLabel(fact, index) {
  const compact = String(fact || "").replace(/\s+/g, " ").trim();
  if (!compact) return `사실 ${index + 1}`;
  const clause = compact.split(/[.。!！?？]/)[0].trim();
  const words = clause.split(" ").filter(Boolean);
  return words.slice(0, 6).join(" ");
}

export function manySitesIn(topic = "", facts = []) {
  const text = [topic, ...normalizeFacts(facts)].join(" ");
  const places = text.match(/[가-힣]{2,}(?:특별시|광역시|시|군|구|동|읍|면|강|항|역|공원|단지|지구)/g) || [];
  return new Set(places).size >= 3;
}

export function wantsCompareSplit(facts = []) {
  return normalizeFacts(facts).some((fact) => /비교|아니라|대신|한쪽|다른쪽|vs\.?/i.test(fact));
}

export function powerWordLabel(line, legalQuantities = []) {
  const numberized = numberizeCaptionText(line, legalQuantities);
  const si = extractLegalQuantities([numberized])[0];
  if (si?.display) return si.display;
  const power = numberized.match(POWER_WORDS);
  if (power) return power[0];
  const words = numberized.replace(/[^\p{L}\p{N}㎡°]+/gu, " ").trim().split(/\s+/).filter((word) => word.length >= 2);
  return words.at(-1) || words[0] || "";
}

function narrationTypeForShot(index, { areaAllowed = false, hasAreaFact = false, manySites = false, compare = false } = {}) {
  const beat = FACTORY_NARRATION_ARC[index] || FACTORY_NARRATION_ARC.at(-1);
  if (index === 4 && hasAreaFact && areaAllowed) return { ...beat, type: "spec_elevation" };
  if (index === 4 && manySites && !hasAreaFact) return { ...beat, type: "map_3d" };
  if (index === 3 && compare) return { ...beat, type: "compare_split" };
  return beat;
}

function matchFactForLine(line, facts = []) {
  const compact = String(line || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const hit = normalizeFacts(facts).find((fact) => {
    const head = fact.slice(0, 8);
    const lineHead = compact.replace(SCRIPT_CLOSER, "").slice(0, 8);
    return (head && compact.includes(head)) || (lineHead && fact.includes(lineHead));
  });
  return hit || "";
}

export function normalizeFactoryDraftLines(draft = "", count = FACTORY_CLIP_COUNT) {
  const lines = splitScriptDraftLines(draft);
  const closerAt = lines.findIndex((line) => line.includes(SCRIPT_CLOSER));
  const body = (closerAt >= 0 ? lines.slice(0, closerAt) : lines.filter((line) => !line.includes(SCRIPT_CLOSER)))
    .slice(0, Math.max(0, count - 1));
  while (body.length < count - 1) body.push("");
  return [...body.slice(0, count - 1), SCRIPT_CLOSER];
}

export function buildShotList({ topic, facts = [], sources = [] }) {
  const nouns = topicNouns(topic);
  const legalQuantities = extractLegalQuantities(facts);
  const slots = topicAgnosticSlots(nouns);
  const manySites = manySitesIn(topic, facts);
  const compare = wantsCompareSplit(facts);
  const factPool = facts.map((fact, index) => ({
    fact,
    index,
    quantity: extractLegalQuantities([fact])[0] || null,
    isArea: Boolean(extractLegalQuantities([fact]).find((item) => item.isArea)),
    used: false
  }));
  const uniqueShots = slots.map((slot, index) => {
    const areaFact = slot.areaAllowed ? factPool.find((item) => item.isArea && !item.used) : null;
    const plainFact = !slot.areaAllowed ? factPool.find((item) => !item.isArea && !item.used) : null;
    const chosen = areaFact || plainFact;
    if (chosen) chosen.used = true;
    const assignedFact = chosen?.fact || "";
    const label = assignedFact ? powerWordLabel(assignedFact, legalQuantities) || factLabel(assignedFact, chosen?.index ?? index) : "";
    const beat = narrationTypeForShot(index, {
      areaAllowed: Boolean(slot.areaAllowed),
      hasAreaFact: Boolean(areaFact),
      manySites,
      compare
    });
    return {
      index: index + 1,
      slotId: slot.id,
      role: slot.role,
      type: beat.type,
      arc: beat.arc,
      unique: true,
      hold: false,
      areaAllowed: Boolean(slot.areaAllowed),
      fact: assignedFact,
      label,
      sourceIds: sourceIdsFor(sources),
      camera: slot.camera,
      topicNouns: nouns,
      tool: index === 0 ? "image_gen" : "image_edit",
      editFrom: index === 0 ? null : "hook-lock"
    };
  });
  const landing = FACTORY_NARRATION_ARC[FACTORY_CLIP_COUNT - 1];
  const hold = {
    index: FACTORY_CLIP_COUNT,
    slotId: HOLD_SLOT_TEMPLATE.id,
    role: HOLD_SLOT_TEMPLATE.role,
    type: landing.type,
    arc: landing.arc,
    unique: false,
    hold: true,
    holdOf: HOLD_SLOT_TEMPLATE.holdOf,
    areaAllowed: false,
    fact: uniqueShots[0]?.fact || "",
    label: "",
    sourceIds: sourceIdsFor(sources),
    camera: HOLD_SLOT_TEMPLATE.camera,
    topicNouns: nouns,
    tool: "image_edit",
    editFrom: "hook-lock"
  };
  return {
    schemaVersion: 1,
    uniqueCount: uniqueShots.length,
    holdCount: 1,
    legalQuantities,
    shots: [...uniqueShots, hold]
  };
}

function sourceIdsFor(sources) {
  return (sources || []).map((source) => typeof source === "string" ? source : source.url).filter(Boolean);
}

export function splitScriptDraftLines(draft = "") {
  return String(draft || "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

export function applyNarrationDraft(segments = [], draft = "", legalQuantities = [], facts = []) {
  if (!String(draft || "").trim()) return segments;
  const text = String(draft).replace(/\s+/g, " ").trim();
  if (!String(draft).includes(SCRIPT_CLOSER)) {
    throw new Error(`대본은 「${SCRIPT_CLOSER}」로 끝나야 합니다.`);
  }
  const inventedDraft = inventedSiIn(text, legalQuantities);
  if (inventedDraft.length) throw new Error(`대본에 출처에 없는 SI가 있습니다: ${inventedDraft.join(", ")}`);
  const lines = normalizeFactoryDraftLines(draft, segments.length || FACTORY_CLIP_COUNT);
  return segments.map((segment, index) => {
    const last = index === segments.length - 1;
    const raw = last ? SCRIPT_CLOSER : (lines[index] || segment.narration || segment.caption || "");
    const invented = inventedSiIn(raw, legalQuantities);
    if (invented.length) throw new Error(`대본에 출처에 없는 SI가 있습니다: ${invented.join(", ")}`);
    const caption = numberizeCaptionText(raw, legalQuantities);
    const fact = last ? (segment.fact || "") : (matchFactForLine(caption, facts) || segment.fact || "");
    const label = last ? "" : (caption ? powerWordLabel(caption, legalQuantities) || segment.label : segment.label);
    return { ...segment, narration: caption, caption, fact, label };
  });
}

export function dialogueForShot(shot, legalQuantities) {
  const source = shot.hold ? shot.fact || shot.label : shot.fact || shot.label;
  const raw = String(source || "").replace(/\s+/g, " ").trim();
  if (!raw) return shot.role === "hook" ? "이 구조부터 보겠습니다" : "같은 현장에서 이어서 봅니다";
  const clause = raw.split(/[.。]/)[0].trim();
  return numberizeCaptionText(clause, legalQuantities);
}

export function stillPromptFor(shot, { legalQuantities = [], emptier = false, siblingPath = null, worldSlots = null } = {}) {
  return fillShotStillPrompt(shot, { legalQuantities, emptier, siblingPath, worldSlots });
}

export function animatePromptFor(shot, { emptier = false, worldSlots = null } = {}) {
  return fillShotAnimatePrompt(shot, { emptier, worldSlots });
}

export function toolAllowedForShot(shot, tool) {
  if (shot.tool === "image_gen") return tool === "image_gen";
  return tool === "image_edit" && !FORBIDDEN_TOOLS_AFTER_HOOK.includes(tool);
}

export function evaluateStillQa({ shot, prompt, analysis = {}, legalQuantities = [], usedAreaShots = [] } = {}) {
  const failures = [];
  if (analysis.hasHuman || analysis.hasSilhouette) failures.push("사람·실루엣");
  if (analysis.bodyInWater) failures.push("물속 신체");
  if (analysis.sameSite === false) failures.push("다른 장소");
  if (analysis.koreanScale === false) failures.push("한국 스케일 불일치");
  if (analysis.leftoverSi) failures.push("잔여 SI");
  if (analysis.sentencesInPixels) failures.push("픽셀 문장");
  if (analysis.areaOnNonRoof || (hasAreaIn(prompt, shot) && !shot.areaAllowed)) failures.push("면적은 지붕면에만");
  if (shot.areaAllowed && usedAreaShots.some((index) => index !== shot.index)) failures.push("면적 숫자 반복");
  const invented = inventedSiIn(prompt, legalQuantities);
  if (invented.length) failures.push(`발명 SI: ${invented.join(", ")}`);
  if (shot.tool !== "image_gen" && /(?:use only the image_gen|\buse image_gen\b)/i.test(prompt)) {
    failures.push("훅 이후 image_gen");
  }
  return { pass: failures.length === 0, failures, provenance: "still-qa" };
}

function hasAreaIn(text, shot) {
  if (shot?.areaAllowed) return false;
  return /(?:\d|[일이삼사오육칠팔구십백천만억]).{0,6}(?:m²|m2|㎡|제곱미터)/i.test(String(text || ""));
}

export function evaluateClipQa({ frames = [] } = {}) {
  const missingTimes = ANIMATE_QA_TIMES.filter((time) => !frames.some((frame) => Number(frame.time) === time));
  const failures = [];
  if (missingTimes.length) failures.push(`프레임 시각 누락: ${missingTimes.join(", ")}`);
  if (frames.some((frame) => frame.spawnedPerson || frame.hasHuman || frame.hasSilhouette)) failures.push("생성된 사람·실루엣");
  if (frames.some((frame) => frame.driftedSi || frame.leftoverSi)) failures.push("드리프트 SI");
  if (frames.some((frame) => frame.bodyInWater)) failures.push("물속 신체");
  return { pass: failures.length === 0, failures, times: ANIMATE_QA_TIMES, provenance: "clip-qa" };
}

export function buildGrokImagineScript(job) {
  const facts = normalizeFacts(job.facts);
  const sources = Array.isArray(job.sources) ? job.sources : [];
  const shotList = buildShotList({ topic: job.topic, facts, sources });
  const legalQuantities = shotList.legalQuantities;
  const nouns = topicNouns(job.topic);
  const worldSlotOverrides = sanitizeWorldSlotOverrides({
    ...proposeWorldSlotsFromFacts(job.topic, facts),
    ...(job.worldSlots || job.worldSlotOverrides || {})
  });
  const worldSlots = fillWorldSlots({ nouns, legalQuantities, worldSlots: worldSlotOverrides });
  const inventedSlots = inventedSiIn(Object.values(worldSlots).join("\n"), legalQuantities);
  if (inventedSlots.length) {
    throw new Error(`월드 슬롯에 출처에 없는 SI가 들어 있습니다: ${inventedSlots.join(", ")}`);
  }
  const slots = topicAgnosticSlots(nouns);
  const segments = shotList.shots.map((shot) => {
    const dialogue = dialogueForShot(shot, legalQuantities);
    return {
      ...shot,
      caption: dialogue,
      narration: dialogue,
      visualPrompt: stillPromptFor(shot, { legalQuantities, worldSlots }),
      animatePrompt: animatePromptFor(shot, { worldSlots }),
      durationHint: SHOT_DURATION_SEC,
      sourceIds: shot.sourceIds,
      claimId: `claim-${shot.index}`,
      worldSlots
    };
  });
  const narrated = job.scriptDraft ? applyNarrationDraft(segments, job.scriptDraft, legalQuantities, facts) : segments;
  const invented = inventedSiIn(narrated.map((segment) => `${segment.visualPrompt} ${segment.caption}`).join("\n"), legalQuantities);
  if (invented.length) {
    throw new Error(`슬롯·샷 목록에 출처에 없는 SI가 들어 있습니다: ${invented.join(", ")}`);
  }
  return {
    title: titleFromTopic(job.topic),
    topic: job.topic,
    hook: narrated[0]?.narration || job.topic,
    narration: narrated.map((segment) => segment.narration).join(" "),
    scriptDraft: job.scriptDraft || narrated.map((segment) => segment.caption).filter(Boolean).join("\n"),
    closer: SCRIPT_CLOSER,
    sources,
    facts,
    legalQuantities,
    topicNouns: nouns,
    worldSlots,
    worldSlotOverrides,
    slots,
    shotList: shotList.shots,
    researchStatus: sources.length || facts.length ? "provided" : "missing",
    generatedBy: "grok-imagine-factory",
    clipCount: FACTORY_CLIP_COUNT,
    uniqueCount: FACTORY_UNIQUE_COUNT,
    holdCount: 1,
    targetDurationSec: FACTORY_CLIP_COUNT * SHOT_DURATION_SEC,
    segments: narrated
  };
}

export function titleFromTopic(topic) {
  const clean = String(topic || "").replace(/\s+/g, " ").trim();
  return clean ? `신비한 건축사전 · ${clean}` : "신비한 건축사전";
}

export function proposeWorldSlotsFromFacts(topic, facts = []) {
  const nouns = topicNouns(topic);
  const joined = normalizeFacts(facts).join(" ");
  const power = joined.match(POWER_WORDS);
  const material = joined.match(/콘크리트|모래|철근|볼트|문비|뚜껑|금속/);
  const hidden = joined.match(/저수조|물탱크|대피공간|수로|갑실|저류|우수|문비|지붕/);
  const next = {};
  if (nouns.length) {
    next.site = `empty real Korean ${nouns.join(" / ")} site, one location, documentary civic scale`;
  }
  if (power) next.everyday_thing = `one ${power[0]} already on the same site — not a person`;
  if (hidden) next.hidden_thing = `the hidden ${hidden[0]} layer of this site — not a person`;
  if (material) next.materials = material[0];
  return next;
}

export function publicScriptView(script) {
  if (!script) return null;
  return {
    title: script.title || titleFromTopic(script.topic),
    topic: script.topic || "",
    facts: script.facts || [],
    worldSlots: script.worldSlots || {},
    closer: SCRIPT_CLOSER,
    clipCount: script.clipCount || FACTORY_CLIP_COUNT,
    uniqueCount: script.uniqueCount || FACTORY_UNIQUE_COUNT,
    segments: (script.segments || []).map((segment, index) => ({
      index: Number.isInteger(segment.index) ? segment.index : index + 1,
      role: segment.role,
      type: segment.type || segment.role,
      arc: segment.arc || null,
      camera: segment.camera,
      fact: segment.fact || "",
      label: segment.label || "",
      narration: segment.narration || segment.caption || "",
      caption: segment.caption || segment.narration || "",
      durationHint: segment.durationHint || segment.durationSec || SHOT_DURATION_SEC,
      tool: segment.tool
    }))
  };
}

export function previewFactoryPrompts(input = {}) {
  return inspectScriptPrompts(buildGrokImagineScript(input), { source: "preview" });
}

export function inspectJobPrompts(job, script = null) {
  if (script?.segments?.length) return inspectScriptPrompts(script, { source: "script" });
  return previewFactoryPrompts(job || {});
}

export function expectedGrokImagineRequest(job, script, runId, scriptHash) {
  const segments = (script?.segments || []).map((segment, index) => ({
    index: index + 1,
    durationHint: SHOT_DURATION_SEC,
    tool: segment.tool,
    editFrom: segment.editFrom || null,
    prompt: segment.visualPrompt || "",
    visualPrompt: segment.visualPrompt || "",
    caption: segment.caption || "",
    narration: segment.narration || "",
    unique: segment.unique !== false,
    hold: Boolean(segment.hold)
  }));
  return {
    schemaVersion: 1,
    jobId: job.id,
    runId,
    provider: PROVIDER_ID,
    topic: job.topic || "",
    format: "vertical",
    width: FACTORY_WIDTH,
    height: FACTORY_HEIGHT,
    targetDurationSec: FACTORY_CLIP_COUNT * SHOT_DURATION_SEC,
    clipCount: FACTORY_CLIP_COUNT,
    facts: normalizeFacts(job.facts),
    legalQuantities: script?.legalQuantities || [],
    segments,
    scriptHash
  };
}

export function factoryMediaTarget() {
  return { width: FACTORY_WIDTH, height: FACTORY_HEIGHT };
}

export function unsupportedProviderMessage() {
  return "지원하지 않는 생성 소스입니다. local, local-video, gemini-browser 또는 grok-imagine만 사용할 수 있습니다.";
}
