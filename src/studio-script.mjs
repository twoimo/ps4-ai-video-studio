import {
  CLIP_COUNT_LOCK,
  HARD_FAILS,
  SHOT_TYPE_META,
  TEMPLATE_ID,
  TEMPLATE_TITLE
} from "./grok-imagine-spec.mjs";
import {
  FACTORY_CLIP_COUNT,
  FACTORY_NARRATION_ARC,
  FACTORY_UNIQUE_COUNT,
  SCRIPT_CLOSER,
  SHOT_TYPE_PRIORITY,
  applyNarrationDraft,
  buildGrokImagineScript,
  extractLegalQuantities,
  inventedSiIn,
  normalizeFacts,
  publicScriptView,
  splitScriptDraftLines
} from "./grok-imagine-factory.mjs";
import { extractGrokText, runGrokText } from "./grok-imagine-cli.mjs";

export { SCRIPT_CLOSER, applyNarrationDraft, splitScriptDraftLines };

const PRIORITY_TYPES = SHOT_TYPE_PRIORITY.join(", ");
const ARC_LINES = FACTORY_NARRATION_ARC.map((beat, index) => (
  `${index + 1}. ${beat.arc} / ${beat.type} — ${arcBeatHint(beat.arc, index)}`
)).join("\n");

function arcBeatHint(arc, index) {
  if (arc === "hook") return "everyday weird thing already on the site. Never 'this video will explain'.";
  if (arc === "setup") return "why it matters. Open a knowledge gap.";
  if (arc === "build") return "one sourced fact on this beat. Therefore/but, not 'and then'.";
  if (arc === "climax") return "hidden layer / mechanism. The aha.";
  if (index === FACTORY_CLIP_COUNT - 1) return `landing only. Last line MUST be ${SCRIPT_CLOSER}. No new fact.`;
  return "same site.";
}

export function scriptDraftPrompt({ topic, facts = [] } = {}) {
  const sourced = normalizeFacts(facts);
  const typeNotes = [
    `Priority factory shot types: ${PRIORITY_TYPES}.`,
    "map_3d only if many sites. compare_split optional.",
    `Do not emit ${"live"}_action. Do not default ${"interior"}_scale.`,
    `cutaway_object: ${SHOT_TYPE_META.cutaway_object.meaning}`,
    `hook_photoreal: ${SHOT_TYPE_META.hook_photoreal.meaning}`,
    `massing_studio: ${SHOT_TYPE_META.massing_studio.meaning}`,
    `mechanism_arrows: ${SHOT_TYPE_META.mechanism_arrows.meaning}`,
    `cutaway_site: ${SHOT_TYPE_META.cutaway_site.meaning}`,
    `context_clay: ${SHOT_TYPE_META.context_clay.meaning}`,
    `payoff_photoreal: ${SHOT_TYPE_META.payoff_photoreal.meaning}`,
    `spec_elevation: ${SHOT_TYPE_META.spec_elevation.meaning}`
  ];
  return [
    "Use ONLY text. Do not call image_gen, image_edit, or image_to_video.",
    "Never use Gemini. Never invent quantities that are not in the sourced facts.",
    `You are the OpenMontage explainer Script Director for 신비한 건축사전.`,
    `Writing brief is the locked spec ${TEMPLATE_ID} (${TEMPLATE_TITLE}). Use the lock, not decoration.`,
    `주제: ${String(topic || "").trim()}`,
    "출처 사실(이 줄의 숫자만 SI로 씁니다. Never invent SI):",
    ...(sourced.length ? sourced.map((fact) => `- ${fact}`) : ["- (숫자 사실 없음. 숫자를 만들지 마세요.)"]),
    "",
    "OUTPUT LOCK",
    "- Korean only. One sentence per line.",
    `- Exactly ${FACTORY_CLIP_COUNT} lines for the ${FACTORY_UNIQUE_COUNT} unique / ${FACTORY_CLIP_COUNT} holds factory (~53s class).`,
    `- Factory stays ${CLIP_COUNT_LOCK.factoryStays}. One hold reuses the hook.`,
    "- Do not write 13–24 caption-sliced lines. Do not rebuild to 13–16 or 20–24.",
    `- Last line MUST be ${SCRIPT_CLOSER}`,
    "- No English sentences. No JSON. No labels. Narration lines only.",
    "- Never write 'this video will explain' or '이 영상에서는'.",
    "",
    "OPENMONTAGE EXPLAINER ARC — map each line to one factory shot type",
    ARC_LINES,
    ...typeNotes,
    "",
    "WORLD + FACT RULES",
    "- One continuous site. Topic nouns only in world slots.",
    "- One fact → one label → one shot.",
    "- Numberize legal SI (10,000㎡, 500톤, 5cm). Never invent SI.",
    "- No people, no silhouettes, no body in water in narration that would force a person on screen.",
    `- Hard fails include: ${HARD_FAILS.slice(0, 4).join("; ")}.`,
    "- Caption line must land on the power word of that fact (sand, cistern, lid, area, tons) so Imagine + edit split on that word.",
    "- Fill world-slot nouns from the topic + sourced facts. sourced_si and avoid stay locked.",
    "- First still is image_gen (hook lock). Later stills are image_edit. Do not call those tools from this text turn.",
    "설명 없이 대본만 출력합니다."
  ].join("\n");
}

export function assertScriptDraft(draft, facts = []) {
  const text = String(draft || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("대본이 비어 있습니다.");
  if (!String(draft || "").includes(SCRIPT_CLOSER)) {
    throw new Error(`대본은 「${SCRIPT_CLOSER}」로 끝나야 합니다.`);
  }
  const invented = inventedSiIn(text, extractLegalQuantities(normalizeFacts(facts)));
  if (invented.length) throw new Error(`대본에 출처에 없는 SI가 있습니다: ${invented.join(", ")}`);
  return true;
}

export async function draftScriptFromTopic({ topic, facts = [], runGrok = runGrokText, cwd = process.cwd() } = {}) {
  const sourced = normalizeFacts(facts);
  if (!String(topic || "").trim() || String(topic).trim().length < 4) {
    throw new Error("영상 주제를 4자 이상 입력하세요.");
  }
  if (!sourced.length) throw new Error("출처에 적힌 사실이 있어야 SI를 잠글 수 있습니다.");
  const prompt = scriptDraftPrompt({ topic, facts: sourced });
  let result;
  try {
    result = await runGrok({ prompt, cwd, timeoutMs: 90_000 });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Gemini로 대체하지 않습니다.`);
  }
  const draft = extractGrokText(result?.stdout || result?.text || "");
  if (!draft) throw new Error("공식 grok CLI가 대본을 비워 두었습니다. Gemini로 대체하지 않습니다.");
  assertScriptDraft(draft, sourced);
  const script = buildGrokImagineScript({ topic: String(topic).trim(), facts: sourced, scriptDraft: draft });
  const view = publicScriptView(script);
  return {
    draft: view.segments.map((segment) => segment.caption).join("\n"),
    topic: view.topic,
    facts: view.facts,
    closer: SCRIPT_CLOSER,
    title: view.title,
    worldSlots: view.worldSlots,
    segments: view.segments,
    script: view
  };
}
