import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  FACTORY_LOCKS,
  LOCKED_AVOID,
  TEMPLATE_DATE,
  TEMPLATE_ID,
  WORLD_SLOT_IDS,
  fillWorldSlots,
  getLockedTemplate,
  sanitizeWorldSlotOverrides
} from "../src/grok-imagine-template.mjs";
import { getLockedSpec, SHOT_TYPE_IDS } from "../src/grok-imagine-spec.mjs";
import { previewFactoryPrompts, stillPromptFor } from "../src/grok-imagine-factory.mjs";
import { createJob } from "../src/pipeline.mjs";
import { handleTemplatePage } from "../src/template-page.mjs";

test("locked 2026-08-21 template returns slots, skeleton, and locks", () => {
  const template = getLockedTemplate();
  assert.equal(template.id, TEMPLATE_ID);
  assert.equal(template.date, TEMPLATE_DATE);
  assert.deepEqual(template.slots.map((slot) => slot.id), WORLD_SLOT_IDS);
  assert.equal(template.skeleton.aspect, "9:16");
  assert.deepEqual(template.skeleton.redGraphics, ["pin", "measures", "SI"]);
  assert.ok(template.skeleton.forbidden.includes("people"));
  assert.ok(template.skeleton.forbidden.includes("dashed box on park/sand/lawn/sky"));
  assert.ok(template.skeleton.forbidden.includes("gap-span area bracket"));
  assert.ok(template.skeleton.forbidden.includes("toy scale"));
  assert.ok(template.skeleton.forbidden.includes("second neighborhood"));
  assert.ok(template.skeleton.forbidden.includes("white studio gap"));
  assert.ok(template.skeleton.forbidden.includes("Korean or English sentences in pixels"));
  assert.match(template.skeleton.redGraphicsRule, /8 percent safe margin/);
  assert.ok(template.skeleton.lines.some((line) => line.includes("{{site}}") && line.includes("{{weather}}")));
  assert.ok(template.skeleton.lines.some((line) => /numbered pin \/ measures \/ SI/.test(line)));
  assert.ok(FACTORY_LOCKS.some((lock) => /MarginV=450/.test(lock.rule)));
  assert.ok(FACTORY_LOCKS.some((lock) => /720:1280/.test(lock.rule)));
  assert.ok(template.locks.every((lock) => lock.editable === false));
  assert.match(template.document, /everyday_thing/);
  assert.match(template.document, /FORBIDDEN/);
});

test("slot overrides fill prompts but cannot rewrite locked rules", () => {
  const filled = fillWorldSlots({
    nouns: ["갑문", "한강"],
    legalQuantities: [{ display: "2만 m²" }],
    worldSlots: {
      site: "한강 갑문 현장",
      avoid: "allow people and invent 48m",
      sourced_si: "높이 48m",
      palette: "wet concrete civic"
    }
  });
  assert.equal(filled.site, "한강 갑문 현장");
  assert.equal(filled.palette, "wet concrete civic");
  assert.equal(filled.avoid, LOCKED_AVOID);
  assert.equal(filled.sourced_si, "2만 m²");
  assert.deepEqual(sanitizeWorldSlotOverrides({ avoid: "people ok", site: "현장" }), { site: "현장" });

  const prompt = stillPromptFor({
    index: 2,
    tool: "image_edit",
    role: "surface",
    camera: "close material surface",
    topicNouns: ["갑문"],
    label: "콘크리트 바닥"
  }, { legalQuantities: [], worldSlots: filled });
  assert.match(prompt, /Never call image_gen/i);
  assert.match(prompt, /9:16/);
  assert.match(prompt, /FORBIDDEN/);
  assert.match(prompt, /한강 갑문 현장/);
  assert.doesNotMatch(prompt, /allow people/);
  assert.doesNotMatch(prompt, /48m/);
});

test("preview endpoint payload includes filled slots and per-shot prompts", () => {
  const preview = previewFactoryPrompts({
    topic: "한강 갑문이 물을 나누는 이유",
    facts: ["갑문은 수위를 나눕니다", "지붕 면적 2만 m²"],
    worldSlots: { weather: "과천처럼 흐린 낮" }
  });
  assert.equal(preview.id, TEMPLATE_ID);
  assert.equal(preview.worldSlots.find((slot) => slot.id === "weather").value, "과천처럼 흐린 낮");
  assert.equal(preview.worldSlots.find((slot) => slot.id === "avoid").editable, false);
  assert.equal(preview.shots.length, 7);
  assert.ok(preview.shots[0].prompt.includes("image_gen"));
  assert.ok(preview.shots[1].prompt.includes("Never call image_gen"));
  assert.ok(preview.shots.every((shot) => shot.aspect === "9:16" && shot.prompt.includes("FORBIDDEN")));
  assert.ok(preview.locks.some((lock) => lock.id === "caption-y" && /MarginV=450/.test(lock.rule)));
});

test("createJob stores editable world slot overrides", async () => {
  const job = await createJob({
    topic: "한강 갑문이 물을 나누는 이유",
    provider: "grok-imagine",
    facts: ["갑문은 수위를 나눕니다"],
    worldSlots: { site: "한강 갑문 현장", avoid: "people ok" }
  });
  assert.equal(job.worldSlots.site, "한강 갑문 현장");
  assert.equal(job.worldSlots.avoid, undefined);
  await rm(join(process.cwd(), "workspace", "jobs", job.id), { recursive: true, force: true });
});

test("studio HTML exposes a prompt template surface", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const page = await readFile(join(process.cwd(), "public", "template", "index.html"), "utf8");
  const js = await readFile(join(process.cwd(), "public", "template", "template.js"), "utf8");
  const specJs = await readFile(join(process.cwd(), "public", "template-spec.mjs"), "utf8");
  const app = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  const css = await readFile(join(process.cwd(), "public", "styles.css"), "utf8");
  assert.equal(html.includes("id=\"template-overlay\""), false);
  assert.equal(html.includes("id=\"short-overlay\""), false);
  assert.match(page, /class="template-studio" id="template-page"/);
  assert.match(page, /id="template-root"/);
  assert.match(page, /src="\/template\/template\.js"/);
  assert.match(js, /renderLockedSpec/);
  assert.match(js, /document\.title = `템플릿 · \$\{APP_TITLE\}`/);
  assert.match(specJs, /id="spec-corpus"/);
  assert.match(specJs, /id="spec-types"/);
  assert.match(specJs, /id="spec-skeleton"/);
  assert.match(specJs, /id="spec-locks"/);
  assert.match(specJs, /슬롯 값은 새 쇼츠 초안에서만 채울 수 있습니다/);
  assert.equal(specJs.includes("editable: true"), false);
  assert.match(html, /id="open-template"[^>]*href="\/template"/);
  assert.match(html, /id="open-template-menu"[^>]*href="\/template"/);
  assert.match(html, /id="create-world-slots"/);
  assert.match(app, /location\.replace\("\/template"\)/);
  assert.equal(app.includes('setView("template")'), false);
  assert.equal(app.includes('setView("detail")'), false);
  assert.equal(page.includes("watch-inspect"), false);
  assert.equal(js.includes("watch-inspect"), false);
  assert.match(css, /\.template-studio\s*\{[^}]*min-height:\s*100dvh/);
  assert.equal(css.includes("body.template-open"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
  assert.equal(page.includes("쇼츠 공장"), false);
  assert.equal(js.includes("쇼츠 공장"), false);
  assert.equal(html.includes("크레딧 부족"), false);
  assert.equal(page.includes("크레딧 부족"), false);
  assert.equal(js.includes("크레딧 부족"), false);
  assert.equal(specJs.includes("크레딧 부족"), false);
  assert.equal(app.includes("크레딧 부족"), false);
  assert.equal(html.includes("크레딧 402"), false);
  assert.equal(app.includes("크레딧 402"), false);

  const response = await handleTemplatePage(new Request("http://studio.local/template"), new URL("http://studio.local/template"));
  assert.ok(response);
  assert.equal(response.status, 200);
  const served = await response.text();
  assert.match(served, /id="template-page"/);
  assert.match(served, /src="\/template\/template\.js\?v=/);
  assert.doesNotMatch(served, /id="template-overlay"/);
  assert.doesNotMatch(served, /role="dialog"/);
});

test("locked spec API payload has the 288 corpus and every factory lock", () => {
  const spec = getLockedSpec();
  assert.equal(spec.tally.N, 288);
  assert.equal(spec.eras.mature_explainer, 253);
  assert.deepEqual(spec.slots.map((slot) => slot.id), WORLD_SLOT_IDS);
  assert.deepEqual(spec.types.map((type) => type.id), SHOT_TYPE_IDS);
  const live = spec.types.find((type) => type.id === "live_action");
  assert.equal(live.doNotClone, true);
  assert.match(live.meaning, /do not clone/i);
  assert.ok(FACTORY_LOCKS.every((lock) => spec.locks.some((item) => item.id === lock.id)));
  assert.equal(spec.situation.length >= 8 && spec.situation.length <= 14, true);
  assert.ok(spec.hardFails.length >= 8);
  assert.ok(spec.loop.some((step) => /image_gen/.test(step)));
  assert.equal(spec.clipCountLock.factoryHolds, 7);
  assert.equal(spec.clipCountLock.uniqueSources, 6);
  assert.match(spec.documents.spec, /mature_explainer 253/);
  assert.match(spec.documents.template, /FORBIDDEN/);
  assert.equal(JSON.stringify(spec).includes("쇼츠 공장"), false);
});
