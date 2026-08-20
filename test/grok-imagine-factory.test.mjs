import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANIMATE_QA_TIMES,
  buildGrokImagineScript,
  buildShotList,
  dialogueForShot,
  evaluateClipQa,
  evaluateStillQa,
  extractLegalQuantities,
  FACTORY_CLIP_COUNT,
  FACTORY_UNIQUE_COUNT,
  GROK_MISSING_ERROR,
  inventedSiIn,
  numberizeLegalQuantities,
  stillPromptFor,
  topicNouns,
  toolAllowedForShot
} from "../src/grok-imagine-factory.mjs";
import {
  assertSafeGrokInvocation,
  grokEnv,
  grokImagineArgs,
  parseSavedPath,
  resolveGrokBinary,
  runGrokImagine,
  withGrokLock
} from "../src/grok-imagine-cli.mjs";
import {
  ASS_ALIGNMENT,
  ASS_CENTER_Y,
  ASS_FONTSIZE,
  ASS_MARGIN_V,
  ASS_OUTLINE,
  assertNoSpecPills,
  buildAssDocument,
  composeVideoFilter,
  FILL_SCALE_CROP,
  freezeStillFilter,
  MAX_PART_SEC,
  splitPartPlan,
  usesKenBurns
} from "../src/grok-imagine-compose.mjs";
import { generateGrokImagineFactory } from "../src/grok-imagine-provider.mjs";
import { createJob } from "../src/pipeline.mjs";

test("topic-agnostic slots and 6 unique / 7 hold shot list", () => {
  const facts = [
    "한강 갑문은 수위를 나눕니다",
    "갑실 바닥은 콘크리트로 되어 있습니다",
    "단면에는 문비와 수로가 함께 보입니다",
    "물은 갑실을 통해 이동합니다",
    "지붕 면적 2만 m²",
    "문비는 수압을 받습니다"
  ];
  const list = buildShotList({ topic: "한강 갑문이 물을 나누는 이유", facts });
  assert.equal(list.shots.length, FACTORY_CLIP_COUNT);
  assert.equal(list.shots.filter((shot) => shot.unique).length, FACTORY_UNIQUE_COUNT);
  assert.equal(list.shots.filter((shot) => shot.hold).length, 1);
  assert.equal(list.shots.at(-1).role, "hold");
  assert.equal(list.shots[0].tool, "image_gen");
  assert.ok(list.shots.slice(1).every((shot) => shot.tool === "image_edit"));
  assert.ok(list.shots.slice(1).every((shot) => shot.editFrom === "hook-lock"));
  const areaShots = list.shots.filter((shot) => shot.areaAllowed && /m²/.test(shot.fact));
  assert.equal(areaShots.length, 1);
  assert.equal(areaShots[0].slotId, "roof-scale");
  assert.equal(list.shots.filter((shot) => shot.slotId !== "roof-scale" && /2만/.test(shot.fact || shot.label)).length, 0);
});

test("does not invent SI and keeps topic nouns only", () => {
  const script = buildGrokImagineScript({
    topic: "한강 갑문이 물을 나누는 이유",
    facts: ["지붕 면적 2만 m²", "갑문은 수위를 나눕니다"],
    sources: [{ title: "한강사업본부", url: "https://hangang.seoul.go.kr/" }]
  });
  const nouns = topicNouns(script.title);
  assert.ok(nouns.includes("한강") || nouns.includes("갑문") || nouns.some((noun) => /갑문|한강/.test(noun)));
  const invented = inventedSiIn(script.segments.map((segment) => segment.visualPrompt).join("\n"), script.legalQuantities);
  assert.deepEqual(invented, []);
  assert.ok(!/5000m|3\.14km|가짜/.test(script.segments.map((segment) => segment.visualPrompt).join(" ")));
  assert.ok(script.legalQuantities.some((item) => item.isArea));
});

test("numberize uses sourced quantities only", () => {
  const legal = extractLegalQuantities(["지붕 면적 2만 m²"]);
  assert.equal(numberizeLegalQuantities("지붕은 2만 제곱미터입니다", legal).includes("m²") || numberizeLegalQuantities("지붕은 2만 m²입니다", legal).includes("2만"), true);
  assert.equal(numberizeLegalQuantities("아무 숫자 없는 문장", legal), "아무 숫자 없는 문장");
  assert.ok(inventedSiIn("높이 48m", legal).length > 0);
});

test("still QA gates and image_gen lock", () => {
  const shot = {
    index: 2,
    tool: "image_edit",
    areaAllowed: false,
    topicNouns: ["갑문"],
    camera: "close",
    label: "콘크리트 바닥"
  };
  const prompt = stillPromptFor(shot, { legalQuantities: [] });
  assert.equal(toolAllowedForShot(shot, "image_edit"), true);
  assert.equal(toolAllowedForShot(shot, "image_gen"), false);
  assert.ok(/image_edit|Never call image_gen/i.test(prompt));
  const failPeople = evaluateStillQa({
    shot,
    prompt,
    analysis: { hasHuman: true, sameSite: true, koreanScale: true },
    legalQuantities: []
  });
  assert.equal(failPeople.pass, false);
  assert.ok(failPeople.failures.some((item) => item.includes("실루엣") || item.includes("사람")));
  const failWater = evaluateStillQa({
    shot,
    prompt,
    analysis: { bodyInWater: true, sameSite: true, koreanScale: true },
    legalQuantities: []
  });
  assert.equal(failWater.pass, false);
  const failArea = evaluateStillQa({
    shot,
    prompt: `${prompt} 20000 m²`,
    analysis: { sameSite: true, koreanScale: true },
    legalQuantities: []
  });
  assert.equal(failArea.pass, false);
  const pass = evaluateStillQa({
    shot,
    prompt,
    analysis: { sameSite: true, koreanScale: true, hasHuman: false, leftoverSi: false, sentencesInPixels: false },
    legalQuantities: []
  });
  assert.equal(pass.pass, true);
});

test("animate QA uses 0.3 / 5 / 9.5 and freeze path", () => {
  assert.deepEqual(ANIMATE_QA_TIMES, [0.3, 5, 9.5]);
  const missing = evaluateClipQa({ frames: [{ time: 0.3, spawnedPerson: false }] });
  assert.equal(missing.pass, false);
  const spawned = evaluateClipQa({
    frames: ANIMATE_QA_TIMES.map((time) => ({ time, spawnedPerson: time === 5 }))
  });
  assert.equal(spawned.pass, false);
  const drifted = evaluateClipQa({
    frames: ANIMATE_QA_TIMES.map((time) => ({ time, driftedSi: time === 9.5 }))
  });
  assert.equal(drifted.pass, false);
  const pass = evaluateClipQa({
    frames: ANIMATE_QA_TIMES.map((time) => ({ time, spawnedPerson: false, driftedSi: false }))
  });
  assert.equal(pass.pass, true);
});

test("compose fill vf and ASS MarginV=450", () => {
  assert.equal(FILL_SCALE_CROP, "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280");
  const vf = composeVideoFilter();
  assert.ok(vf.includes(FILL_SCALE_CROP));
  assert.equal(usesKenBurns(vf), false);
  assert.equal(usesKenBurns(freezeStillFilter()), false);
  assert.throws(() => assertNoSpecPills("scale=720:1280,drawbox=0:0:100:40"));
  assert.throws(() => assertNoSpecPills("drawtext=text=spec"));
  const ass = buildAssDocument([{ text: "갑문이 수위를 나눕니다", start: 0, end: 10 }]);
  assert.match(ass, /Alignment, MarginL, MarginR, MarginV/);
  assert.match(ass, new RegExp(`,${ASS_ALIGNMENT},10,10,${ASS_MARGIN_V},1`));
  assert.equal(ASS_FONTSIZE, 50);
  assert.equal(ASS_OUTLINE, 6);
  assert.equal(ASS_MARGIN_V, 450);
  assert.equal(ASS_CENTER_Y, 805);
  const parts = splitPartPlan(70);
  assert.ok(parts.every((part) => part.duration <= MAX_PART_SEC));
  assert.ok(parts.length >= 5);
});

test("official grok CLI adapter never uses key or login", async () => {
  assert.equal(resolveGrokBinary({ HOME: "/tmp/missing-home-ps4" }, () => null), null);
  const env = grokEnv({ PATH: "/usr/bin", XAI_API_KEY: "secret", HOME: "/tmp" });
  assert.equal(env.XAI_API_KEY, undefined);
  const args = grokImagineArgs({ prompt: "use image_gen", cwd: "/tmp", tools: ["image_gen"] });
  assert.ok(!args.includes("login"));
  assert.ok(!args.includes("logout"));
  assert.ok(args.includes("-p"));
  assert.throws(() => assertSafeGrokInvocation({ binary: "/bin/grok", args: ["login"], env: {} }));
  assert.throws(() => assertSafeGrokInvocation({ binary: "/bin/grok", args: ["-p", "x"], env: { XAI_API_KEY: "x" } }));
  await assert.rejects(() => runGrokImagine({
    prompt: "x",
    cwd: "/tmp",
    tools: ["image_gen"],
    env: { HOME: "/tmp/missing-home-ps4" },
    whichImpl: () => null
  }), (error) => error.message === GROK_MISSING_ERROR);
  assert.equal(parseSavedPath("SAVED: /tmp/out.png"), "/tmp/out.png");
});

test("one grok process at a time", async () => {
  const order = [];
  const first = withGrokLock(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("a-end");
    return "a";
  });
  const second = withGrokLock(async () => {
    order.push("b-start");
    order.push("b-end");
    return "b";
  });
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("createJob persists grok-imagine factory fields", async () => {
  const job = await createJob({
    topic: "한강 갑문이 물을 나누는 이유",
    provider: "grok-imagine",
    facts: ["지붕 면적 2만 m²", "갑문은 수위를 나눕니다"],
    sources: [{ title: "한강", url: "https://hangang.seoul.go.kr/" }],
    voiceover: true,
    format: "landscape",
    clipCount: 4
  });
  assert.equal(job.provider, "grok-imagine");
  assert.equal(job.format, "vertical");
  assert.equal(job.clipCount, 7);
  assert.equal(job.voiceover, false);
  assert.equal(job.captions, true);
  assert.equal(job.targetDurationSec, 70);
  assert.deepEqual(job.facts, ["지붕 면적 2만 m²", "갑문은 수위를 나눕니다"]);
  await rm(join(process.cwd(), "workspace", "jobs", job.id), { recursive: true, force: true });
});

test("mocked factory retries emptier then freezes without Ken Burns", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-grok-"));
  const jobDir = join(root, "job");
  const job = { id: "job-factory", topic: "한강 갑문", facts: ["갑문은 수위를 나눕니다"], sources: [] };
  const script = buildGrokImagineScript(job);
  let stillCalls = 0;
  const result = await generateGrokImagineFactory(job, script, "run-1", async () => {}, {
    jobDir,
    resolveGrokBinary: () => "/usr/bin/true",
    runGrok: async ({ prompt }) => {
      stillCalls += 1;
      const target = /Save the result to this exact path: (.+)/.exec(prompt)?.[1];
      if (target) {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, "fake-media");
      }
      return { stdout: `SAVED: ${target}`, savedPath: target };
    },
    inspectStill: async ({ shot }) => ({
      sameSite: true,
      koreanScale: true,
      hasHuman: shot.index === 1 && stillCalls === 1,
      hasSilhouette: false,
      bodyInWater: false
    }),
    inspectClip: async () => ANIMATE_QA_TIMES.map((time) => ({ time, spawnedPerson: true, driftedSi: false })),
    animateStill: async ({ clipPath }) => {
      await mkdir(join(clipPath, ".."), { recursive: true });
      await writeFile(clipPath, "clip");
    },
    freezeStill: async (stillPath, clipPath) => {
      assert.ok(!usesKenBurns(freezeStillFilter()));
      await mkdir(join(clipPath, ".."), { recursive: true });
      await writeFile(clipPath, `frozen-from-${stillPath}`);
      return { path: clipPath, frozen: true, kenBurns: false };
    },
    compose: async ({ clipPaths }) => {
      assert.equal(clipPaths.length, 7);
      await writeFile(join(jobDir, "final.mp4"), "final");
      await writeFile(join(jobDir, "master.mp4"), "master");
      await writeFile(join(jobDir, "chat.mp4"), "chat");
      return {
        master: "master.mp4",
        chat: "chat.mp4",
        final: "final.mp4",
        captionsAss: "captions.ass",
        captionsSrt: "captions.srt",
        parts: [{ path: "parts/part-01.mp4" }],
        duration: 70
      };
    }
  });
  assert.equal(result.provider, "grok-imagine");
  assert.equal(result.stills[0].tool, "image_gen");
  assert.ok(result.stills.slice(1).every((still) => still.tool === "image_edit"));
  assert.equal(result.hookLock.tool, "image_gen");
  assert.ok(result.clips.some((clip) => clip.frozen));
  const receipt = JSON.parse(await readFile(join(jobDir, "runs", "run-1", "grok-imagine-generation.json"), "utf8"));
  assert.equal(receipt.segments.length, 7);
  await rm(root, { recursive: true, force: true });
});

test("dialogue captions stay numberized and sentence-free of invented SI", () => {
  const legal = extractLegalQuantities(["지붕 면적 2만 m²"]);
  const line = dialogueForShot({ fact: "지붕 면적 2만 m²", role: "scale" }, legal);
  assert.ok(/2만/.test(line));
  assert.deepEqual(inventedSiIn(line, legal), []);
});
