import {
  SCRIPT_CLOSER,
  applyNarrationDraft,
  extractLegalQuantities,
  inventedSiIn,
  normalizeFacts,
  splitScriptDraftLines
} from "./grok-imagine-factory.mjs";
import { extractGrokText, runGrokText } from "./grok-imagine-cli.mjs";

export { SCRIPT_CLOSER, applyNarrationDraft, splitScriptDraftLines };

export function scriptDraftPrompt({ topic, facts = [] } = {}) {
  const sourced = normalizeFacts(facts);
  return [
    "Use ONLY text. Do not call image_gen, image_edit, or image_to_video.",
    "Never use Gemini. Never invent quantities that are not in the sourced facts.",
    "신비한 건축사전 스타일의 한국어 쇼츠 대본만 작성합니다.",
    `주제: ${String(topic || "").trim()}`,
    "출처 사실(이 줄의 숫자만 SI로 씁니다):",
    ...(sourced.length ? sourced.map((fact) => `- ${fact}`) : ["- (숫자 사실 없음. 숫자를 만들지 마세요.)"]),
    "7문장 안팎, 한 줄에 한 문장.",
    `마지막 문장은 반드시 ${SCRIPT_CLOSER}`,
    "사람 등장 금지. 영어 문장 금지. 설명 없이 대본만 출력합니다."
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
  return { draft, topic: String(topic).trim(), facts: sourced, closer: SCRIPT_CLOSER };
}
