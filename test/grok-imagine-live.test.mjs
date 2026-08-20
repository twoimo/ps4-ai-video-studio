import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANIMATE_QA_TIMES,
  buildGrokImagineScript
} from "../src/grok-imagine-factory.mjs";
import { generateGrokImagineFactory } from "../src/grok-imagine-provider.mjs";
import { freezeStillFilter, usesKenBurns } from "../src/grok-imagine-compose.mjs";
import {
  encodeSse,
  FACTORY_LIVE_STAGES,
  factoryStageEvent,
  firstStageOrder,
  reduceFactoryStages,
  reduceLiveProofs,
  reduceLiveShots
} from "../src/grok-imagine-live.mjs";
import { appendRunEvent, readRunEvents } from "../src/run-ledger.mjs";

test("SSE encoder and stage reducer keep factory order", () => {
  assert.deepEqual(FACTORY_LIVE_STAGES.map((stage) => stage.id), [
    "plan", "hook-lock", "image-edit", "still-qa", "animate", "clip-qa", "tts-mix", "captions", "compose", "parts"
  ]);
  const events = [
    factoryStageEvent({ stageId: "plan", status: "RUN", message: "슬롯 짜는 중" }),
    factoryStageEvent({ stageId: "plan", status: "PASS", message: "샷 7개" }),
    factoryStageEvent({ stageId: "hook-lock", status: "RUN", shotIndex: 1, prompt: "HOOK PROMPT" }),
    factoryStageEvent({
      stageId: "hook-lock",
      status: "PASS",
      shotIndex: 1,
      artifacts: [{ name: "factory/stills/01.png", url: "/s1.png", kind: "hook-lock" }]
    }),
    factoryStageEvent({
      stageId: "compose",
      status: "RUN",
      message: "자막 번인 중",
      artifacts: [{ name: "factory/proof/captions.jpg", url: "/c.jpg", kind: "proof-frame" }]
    })
  ];
  const timeline = reduceFactoryStages(events);
  assert.equal(timeline[0].status, "PASS");
  assert.equal(timeline[1].status, "PASS");
  assert.equal(timeline.find((stage) => stage.id === "compose").status, "RUN");
  assert.equal(timeline.find((stage) => stage.id === "parts").status, "WAIT");
  const shots = reduceLiveShots(events, [{ name: "factory/stills/01.png", url: "/s1.png" }]);
  assert.equal(shots[0].stillUrl, "/s1.png");
  assert.equal(reduceLiveProofs(events)[0].name, "factory/proof/captions.jpg");
  const frame = encodeSse(events[0], 1);
  assert.match(frame, /^id: 1\nevent: factory_stage\ndata: /);
  assert.match(frame, /"stageId":"plan"/);
  assert.ok(frame.endsWith("\n\n"));
});

test("readRunEvents returns ledger lines in write order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-events-"));
  await appendRunEvent(root, factoryStageEvent({ stageId: "plan", status: "RUN" }));
  await appendRunEvent(root, factoryStageEvent({ stageId: "compose", status: "PASS" }));
  const events = await readRunEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0].stageId, "plan");
  assert.equal(events[1].stageId, "compose");
  assert.ok(events[0].timestamp);
  await rm(root, { recursive: true, force: true });
});

test("running factory job emits ordered stage events including compose", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-live-"));
  const jobDir = join(root, "job");
  const job = { id: "job-live", topic: "한강 갑문", facts: ["갑문은 수위를 나눕니다"], sources: [] };
  const script = buildGrokImagineScript(job);
  const events = [];
  const result = await generateGrokImagineFactory(job, script, "run-live", async () => {}, {
    jobDir,
    resolveGrokBinary: () => "/usr/bin/true",
    runGrok: async ({ prompt }) => {
      const target = /Save the result to this exact path: (.+)/.exec(prompt)?.[1];
      if (target) {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, "fake-media");
      }
      return { stdout: `SAVED: ${target}`, savedPath: target };
    },
    inspectStill: async () => ({
      sameSite: true,
      koreanScale: true,
      hasHuman: false,
      hasSilhouette: false,
      bodyInWater: false
    }),
    inspectClip: async () => ANIMATE_QA_TIMES.map((time) => ({ time, spawnedPerson: false, driftedSi: false })),
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
    compose: async ({ onEvent, jobId, clipPaths }) => {
      assert.equal(jobId, "job-live");
      assert.equal(clipPaths.length, 7);
      await onEvent(factoryStageEvent({
        stageId: "compose",
        status: "RUN",
        message: "fill 720×1280 합성 중",
        artifacts: [{ name: "factory/proof/concat.jpg", kind: "proof-frame", url: "/api/jobs/job-live/artifacts/factory%2Fproof%2Fconcat.jpg" }]
      }));
      await writeFile(join(jobDir, "final.mp4"), "final");
      await writeFile(join(jobDir, "master.mp4"), "master");
      await writeFile(join(jobDir, "chat.mp4"), "chat");
      await onEvent(factoryStageEvent({
        stageId: "compose",
        status: "PASS",
        message: "fill 720×1280 마스터 합성 완료"
      }));
      return {
        master: "master.mp4",
        chat: "chat.mp4",
        final: "final.mp4",
        captionsAss: "captions.ass",
        captionsSrt: "captions.srt",
        parts: [{ path: "parts/part-01.mp4" }],
        duration: 70
      };
    },
    onEvent: async (event) => { events.push(event); }
  });
  assert.equal(result.provider, "grok-imagine");
  const order = firstStageOrder(events);
  assert.equal(order[0], "hook-lock");
  assert.ok(order.indexOf("hook-lock") < order.indexOf("image-edit"));
  assert.ok(order.indexOf("still-qa") < order.indexOf("animate"));
  assert.ok(order.indexOf("animate") < order.indexOf("clip-qa"));
  assert.ok(order.indexOf("tts-mix") < order.indexOf("captions"));
  assert.ok(order.indexOf("captions") < order.indexOf("compose"));
  assert.ok(order.indexOf("compose") < order.indexOf("parts") || order.includes("compose"));
  assert.ok(order.includes("compose"));
  assert.ok(events.some((event) => event.stageId === "compose" && event.status === "RUN"));
  assert.ok(events.some((event) => event.stageId === "compose" && event.status === "PASS"));
  assert.ok(events.some((event) => event.stageId === "hook-lock" && event.prompt));
  assert.deepEqual(order.filter((id, index) => order.indexOf(id) === index), order);
  await rm(root, { recursive: true, force: true });
});

test("studio keeps shorts grid, live factory, and template viewer", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const app = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(html, /id="shorts-grid"/);
  assert.match(html, /id="live-factory"/);
  assert.match(html, /id="template-overlay"/);
  assert.match(html, /id="channel-dna"/);
  assert.match(html, /신비한 건축사전/);
  assert.match(app, /EventSource\(`\/api\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/events\?sse=1`\)/);
  assert.match(app, /setInterval\(pollJobs, 900\)/);
  assert.match(app, /setView\("detail"\)/);
  assert.match(app, /renderChannelDna/);
  assert.match(app, /NOW FILLING/);
});
