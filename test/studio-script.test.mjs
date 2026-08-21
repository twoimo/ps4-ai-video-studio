import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRIPT_CLOSER, assertScriptDraft, draftScriptFromTopic, scriptDraftPrompt } from "../src/studio-script.mjs";
import { FACTORY_CLIP_COUNT, buildShotList } from "../src/grok-imagine-factory.mjs";

const TOPIC = "빗물이 모이는 놀이터";
const FACTS = [
  "모래 아래는 저수조입니다",
  "지붕 면적 10,000㎡",
  "뚜껑 하중은 500톤입니다",
  "빗물은 모래를 지나 모입니다"
];

test("script draft prompt uses the lock as the writing brief", () => {
  const prompt = scriptDraftPrompt({ topic: TOPIC, facts: FACTS });
  assert.match(prompt, /Use ONLY text/);
  assert.match(prompt, /image_gen/);
  assert.match(prompt, /7 holds/);
  assert.match(prompt, /6 unique/);
  assert.match(prompt, /hook_photoreal/);
  assert.match(prompt, /cutaway_object/);
  assert.match(prompt, /mechanism_arrows/);
  assert.match(prompt, /massing_studio/);
  assert.match(prompt, /payoff_photoreal/);
  assert.match(prompt, /No people/);
  assert.match(prompt, /Never invent SI/);
  assert.match(prompt, new RegExp(SCRIPT_CLOSER));
  assert.doesNotMatch(prompt, /Gemini로 대체/);
  assert.match(prompt, /this video will explain/);
});

test("assertScriptDraft rejects invented SI and a missing closer", () => {
  assert.doesNotThrow(() => assertScriptDraft(`모래 아래는 저수조입니다\n${SCRIPT_CLOSER}`, FACTS));
  assert.throws(() => assertScriptDraft(`높이 48m로 올립니다\n${SCRIPT_CLOSER}`, FACTS), /출처에 없는 SI/);
  assert.throws(() => assertScriptDraft("모래 아래는 저수조입니다", FACTS), /끝나야/);
});

test("mocked grok draft splits onto 7 factory segments", async () => {
  const grokDraft = [
    "놀이터 모래가 지붕처럼 덮여 있습니다.",
    "빗물이 모래 아래로 빠지는 현장입니다.",
    "뚜껑 아래는 저수조입니다.",
    "물은 모래를 지나 저류됩니다.",
    "지붕 면적은 10,000㎡입니다.",
    "500톤 뚜껑이 하중을 받습니다.",
    SCRIPT_CLOSER
  ].join("\n");
  const result = await draftScriptFromTopic({
    topic: TOPIC,
    facts: FACTS,
    runGrok: async ({ prompt }) => {
      assert.match(prompt, /7 holds/);
      assert.match(prompt, /Use ONLY text/);
      return { stdout: grokDraft };
    }
  });
  assert.equal(result.segments.length, FACTORY_CLIP_COUNT);
  assert.equal(result.segments[0].tool, "image_gen");
  assert.ok(result.segments.slice(1).every((segment) => segment.tool === "image_edit"));
  assert.equal(result.segments.at(-1).caption, SCRIPT_CLOSER);
  assert.equal(result.closer, SCRIPT_CLOSER);
  assert.match(result.title, /신비한 건축사전/);
  assert.equal(result.worldSlots.sourced_si.includes("10,000") || result.worldSlots.sourced_si.includes("500"), true);
  assert.match(result.worldSlots.avoid, /people/);
  assert.equal(result.script.segments.length, 7);
  assert.ok(result.segments.every((segment) => segment.narration && segment.durationHint && segment.type));
  assert.doesNotMatch(result.segments.map((segment) => segment.type).join(" "), /live_action/);
  assert.equal(result.draft.split("\n").length, 7);
});

test("caption-sliced grok drafts still attach to 7 holds", async () => {
  const sliced = [
    "모래가 보입니다",
    "모래가 덮여 있습니다",
    "빗물이 빠집니다",
    "빗물이 모입니다",
    "뚜껑이 있습니다",
    "저수조입니다",
    "물이 흐릅니다",
    "모래를 지납니다",
    "면적이 넓습니다",
    "10,000㎡입니다",
    "하중이 큽니다",
    "500톤입니다",
    "마무립니다",
    SCRIPT_CLOSER
  ].join("\n");
  const result = await draftScriptFromTopic({
    topic: TOPIC,
    facts: FACTS,
    runGrok: async () => ({ text: sliced })
  });
  assert.equal(result.segments.length, 7);
  assert.equal(result.segments[0].tool, "image_gen");
  assert.ok(result.segments.slice(1).every((segment) => segment.tool === "image_edit"));
  assert.equal(result.segments.at(-1).caption, SCRIPT_CLOSER);
});

test("factory shot list already maps the 7 holds to lock types", () => {
  const list = buildShotList({ topic: TOPIC, facts: FACTS });
  assert.equal(list.shots.length, 7);
  assert.equal(list.shots[0].type, "hook_photoreal");
  assert.equal(list.shots[0].tool, "image_gen");
  assert.ok(list.shots.slice(1).every((shot) => shot.tool === "image_edit"));
  assert.equal(list.shots.at(-1).type, "payoff_photoreal");
  assert.ok(!list.shots.some((shot) => shot.type === "live_action" || shot.type === "interior_scale"));
});
