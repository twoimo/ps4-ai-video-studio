import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ASS_MARGIN_V,
  buildAssDocument,
  buildDialogueCues,
  CAPTION_TIMING_PAUSE,
  composeGrokImagine,
  mixAudioArgs,
  voiceBgmMixFilter
} from "../src/grok-imagine-compose.mjs";
import { extractLegalQuantities } from "../src/grok-imagine-factory.mjs";
import { extractGrokText } from "../src/grok-imagine-cli.mjs";
import { studioOpenApi } from "../src/openapi.mjs";
import { parseArgs, printHelp, runCli, IMAGINE_BLOCKED } from "../cli/studio.mjs";
import { chirpConfigured, defaultStudioSettings, readStudioSettings, settingsPublicView, writeStudioSettings } from "../src/studio-settings.mjs";
import { SCRIPT_CLOSER, assertScriptDraft, scriptDraftPrompt } from "../src/studio-script.mjs";
import { createHash } from "node:crypto";
import {
  assemblePublicEdgeTrustedClientToken,
  decodeTtsSocketData,
  EDGE_TTS_TOKEN,
  edgeTtsUrl,
  edgeWordTimestamps,
  resolveEdgeTtsToken,
  secMsGec,
  synthesizeEdgeTts,
  ttsTimingFromWords
} from "../src/studio-tts.mjs";
import { listBgmFiles, listBgmPublicNames } from "../src/studio-bgm.mjs";
import { stripPublicPaths } from "../src/public-copy.mjs";

test("Edge TTS token is assembled from public parts or env", () => {
  const assembled = assemblePublicEdgeTrustedClientToken();
  assert.equal(assembled.length, 32);
  assert.match(assembled, /^[0-9A-F]{32}$/);
  assert.equal(
    createHash("sha256").update(assembled).digest("hex"),
    "558d7c6a7f7db444895946fe23a54ad172fd6d159f46cb34dd4db21bb27c07d7"
  );
  assert.equal(resolveEdgeTtsToken({}), assembled);
  assert.equal(resolveEdgeTtsToken({ EDGE_TTS_TRUSTED_CLIENT_TOKEN: "" }), assembled);
  assert.equal(resolveEdgeTtsToken({ EDGE_TTS_TRUSTED_CLIENT_TOKEN: "   " }), assembled);
  assert.equal(resolveEdgeTtsToken({ EDGE_TTS_TRUSTED_CLIENT_TOKEN: " override-token " }), "override-token");
  assert.equal(EDGE_TTS_TOKEN, resolveEdgeTtsToken());
  const url = edgeTtsUrl({ connectionId: "cid", nowSec: 1_700_000_000 });
  assert.match(url, /TrustedClientToken=/);
  assert.ok(url.includes(`TrustedClientToken=${assembled}`));
  const overrideUrl = edgeTtsUrl({
    connectionId: "cid",
    nowSec: 1_700_000_000,
    env: { EDGE_TTS_TRUSTED_CLIENT_TOKEN: "override-token" }
  });
  assert.ok(overrideUrl.includes("TrustedClientToken=override-token"));
  assert.doesNotMatch(overrideUrl, new RegExp(`TrustedClientToken=${assembled}`));
  const expectedGec = createHash("sha256").update((() => {
    const winEpoch = 11644473600;
    let ticks = Math.floor((1_700_000_000 + winEpoch) * 10_000_000);
    ticks -= ticks % 3_000_000_000;
    return `${ticks.toString(16).toUpperCase()}${assembled}`;
  })()).digest("hex").toUpperCase();
  assert.equal(secMsGec(1_700_000_000), expectedGec);
});

test("Edge TTS timestamps become pause-timed ASS with MarginV=450", () => {
  const words = edgeWordTimestamps([{
    Metadata: [
      { Type: "WordBoundary", Data: { Offset: 4_000_000, Duration: 3_000_000, text: { Text: "지붕" } } },
      { Type: "WordBoundary", Data: { Offset: 7_000_000, Duration: 4_000_000, text: { Text: "면적" } } },
      { Type: "WordBoundary", Data: { Offset: 12_000_000, Duration: 6_000_000, text: { Text: "20,000m²" } } },
      { Type: "WordBoundary", Data: { Offset: 32_000_000, Duration: 8_000_000, text: { Text: "이렇게" } } },
      { Type: "SentenceBoundary", Data: { Offset: 32_000_000, Duration: 20_000_000, text: { Text: SCRIPT_CLOSER } } }
    ]
  }]);
  assert.equal(words[0].start, 0.4);
  assert.equal(words[0].text, "지붕");
  const script = {
    legalQuantities: extractLegalQuantities(["지붕 면적 2만 m²"]),
    segments: [
      { caption: "지붕 면적 2만 m²", durationHint: 10 },
      { caption: SCRIPT_CLOSER, durationHint: 10 }
    ]
  };
  const built = buildDialogueCues(script, ttsTimingFromWords(words));
  assert.equal(built.pauseTimed, true);
  assert.equal(built.source, CAPTION_TIMING_PAUSE);
  assert.equal(built.cues[0].start, 0.4);
  const ass = buildAssDocument(built.cues);
  assert.match(ass, /MarginV/);
  assert.match(ass, new RegExp(`,${ASS_MARGIN_V},1`));
  assert.match(ass, /Alignment/);
  assert.match(ass, /PlayResY: 1280/);
  assert.match(ass, /Dialogue:/);
  assert.doesNotMatch(ass, /PrimaryColour.*&H00FF0000/);
});

test("BGM mix uses amix and never drawtext", () => {
  const bed = voiceBgmMixFilter({ bgm: true, bgmVolume: 0.08 });
  assert.match(bed.filterComplex, /amix=inputs=2/);
  assert.match(bed.filterComplex, /volume=0\.08/);
  assert.doesNotMatch(bed.filterComplex, /drawtext|drawbox|zoompan/i);
  const silent = voiceBgmMixFilter({ bgm: false, bgmVolume: 0 });
  assert.match(silent.filterComplex, /\[1:a\]/);
  assert.doesNotMatch(silent.filterComplex, /amix/);
  const args = mixAudioArgs({
    video: "assembled.mp4",
    voice: "voiceover.mp3",
    bgm: "workspace/songs/bed.mp3",
    bgmVolume: 0.08,
    output: "voiced.mp4"
  });
  assert.ok(args.includes("-filter_complex"));
  assert.ok(args.includes("amix=inputs=2:duration=first:dropout_transition=0[aout]".split("[aout]")[0] + "[aout]") || args.some((item) => String(item).includes("amix")));
  assert.equal(args.some((item) => /drawtext|drawbox/i.test(String(item))), false);
});

test("settings persist in workspace config", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-settings-"));
  const written = await writeStudioSettings({
    ttsProvider: "edge",
    ttsVoice: "ko-KR-InJoonNeural",
    bgmEnabled: true,
    bgmVolume: 0.12,
    ffmpegPath: "/opt/bin/ffmpeg"
  }, { root, env: {} });
  assert.equal(written.ttsVoice, "ko-KR-InJoonNeural");
  assert.equal(written.bgmEnabled, true);
  assert.equal(written.bgmVolume, 0.12);
  const read = await readStudioSettings({ root, env: {} });
  assert.deepEqual(read, written);
  const raw = JSON.parse(await readFile(join(root, "workspace", "studio-config.json"), "utf8"));
  assert.equal(raw.ffmpegPath, "/opt/bin/ffmpeg");
  const publicView = settingsPublicView(written, {});
  assert.equal("ffmpegPath" in publicView, false);
  assert.equal(chirpConfigured({}), false);
  assert.equal(defaultStudioSettings().bgmEnabled, false);
  await rm(root, { recursive: true, force: true });
});

test("OpenAPI lists create and import", () => {
  const spec = studioOpenApi();
  assert.ok(spec.paths["/api/jobs"].post);
  assert.ok(spec.paths["/api/library/import"].post);
  assert.ok(spec.paths["/api/jobs/{id}/events"].get);
  assert.ok(spec.paths["/api/jobs/{id}/artifacts/{name}"].get);
  assert.ok(spec.paths["/api/tts/preview"].post);
  assert.equal(spec.paths["/api/jobs"].post.operationId, "createJob");
  assert.equal(spec.paths["/api/library/import"].post.operationId, "importLibrary");
});

test("CLI --help and draft job without Imagine", async () => {
  const lines = [];
  printHelp((text) => lines.push(text));
  assert.match(lines.join("\n"), /--topic/);
  assert.match(lines.join("\n"), /--facts/);
  const help = await runCli(["--help"], { stdout: () => {}, stderr: () => {} });
  assert.equal(help.help, true);
  assert.deepEqual(parseArgs(["--topic", "안방 옆 작은 방", "--facts", "대피공간은 2㎡입니다"]).facts, ["대피공간은 2㎡입니다"]);
  const created = [];
  const draft = await runCli(["--topic", "안방 옆 작은 방은 창고가 아닙니다", "--facts", "대피공간은 세대마다 2㎡입니다"], {
    stdout: () => {},
    stderr: () => {},
    create: async (input) => {
      created.push(input);
      return { id: "draft-1", ...input, status: "draft" };
    }
  });
  assert.equal(draft.ok, true);
  assert.equal(created[0].draftOnly, true);
  assert.equal(created[0].startImagine, false);
  assert.equal(created[0].provider, "grok-imagine");
  const blocked = await runCli(["--start", "--topic", "주제입니다", "--facts", "사실 2㎡"], {
    stdout: () => {},
    stderr: () => {}
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /402/);
  assert.equal(blocked.message, IMAGINE_BLOCKED);
  const previewRoot = await mkdtemp(join(tmpdir(), "ps4-cli-preview-"));
  const previewOut = join(previewRoot, "voice-preview.mp3");
  const preview = await runCli(["--tts-preview", "--text", "이렇게 설계된 겁니다.", "--voice", "ko-KR-SunHiNeural", "--out", previewOut], {
    stdout: () => {},
    stderr: () => {},
    synthesize: async (text, options) => {
      assert.match(text, /이렇게 설계된 겁니다/);
      assert.equal(options.voice, "ko-KR-SunHiNeural");
      return { provider: "edge", audio: Buffer.from("ID3PREVIEW") };
    }
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, previewOut);
  assert.equal(await readFile(previewOut, "utf8"), "ID3PREVIEW");
  await rm(previewRoot, { recursive: true, force: true });
});

test("script draft stays sourced-fact SI and ends with the closer", () => {
  const facts = ["대피공간은 세대마다 2㎡입니다"];
  const prompt = scriptDraftPrompt({ topic: "안방 옆 작은 방은 창고가 아닙니다", facts });
  assert.match(prompt, /Use ONLY text/);
  assert.match(prompt, /image_gen/);
  assert.match(prompt, new RegExp(SCRIPT_CLOSER));
  assert.doesNotMatch(prompt, /Gemini로 대체/);
  assert.doesNotThrow(() => assertScriptDraft(`대피공간은 세대마다 2㎡입니다\n${SCRIPT_CLOSER}`, facts));
  assert.throws(() => assertScriptDraft(`높이 48m로 올립니다\n${SCRIPT_CLOSER}`, facts), /출처에 없는 SI/);
  assert.equal(extractGrokText('{"message":"이렇게 설계된 겁니다."}'), SCRIPT_CLOSER);
});

test("Edge TTS decodes Blob, ArrayBuffer, and binary metadata frames", async () => {
  const mp3 = Buffer.from("ID3FAKEMP3");
  const audioFrame = Buffer.concat([Buffer.from("Path:audio\r\n\r\n"), mp3]);
  const fromBlob = await decodeTtsSocketData(new Blob([audioFrame]));
  assert.deepEqual(Buffer.from(fromBlob.audio), mp3);
  const meta = { Metadata: [{ Type: "WordBoundary", Data: { Offset: 4_000_000, Duration: 3_000_000, text: { Text: "지붕" } } }] };
  const metaFrame = Buffer.from(`Path:audio.metadata\r\n\r\n${JSON.stringify(meta)}`, "utf8");
  const fromAb = await decodeTtsSocketData(metaFrame.buffer.slice(metaFrame.byteOffset, metaFrame.byteOffset + metaFrame.byteLength));
  assert.equal(fromAb.metadata.Metadata[0].Data.text.Text, "지붕");
  const ended = await decodeTtsSocketData("Path:turn.end\r\n\r\n");
  assert.equal(ended.turnEnd, true);
});

test("Edge TTS mock WebSocket returns Korean preview audio and word timestamps", async () => {
  class MockEdgeSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.emit("open"));
    }
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    close() {}
    send(payload) {
      if (!String(payload).includes("Path:ssml")) return;
      queueMicrotask(() => {
        const mp3 = Buffer.from("ID3PREVIEW");
        const audio = Buffer.concat([Buffer.from("X-RequestId:1\r\nPath:audio\r\n\r\n"), mp3]);
        this.emit("message", { data: new Blob([audio]) });
        const meta = JSON.stringify({
          Metadata: [
            { Type: "WordBoundary", Data: { Offset: 4_000_000, Duration: 3_000_000, text: { Text: "지붕" } } },
            { Type: "WordBoundary", Data: { Offset: 7_000_000, Duration: 4_000_000, text: { Text: "면적" } } }
          ]
        });
        this.emit("message", { data: Buffer.from(`Path:audio.metadata\r\n\r\n${meta}`, "utf8") });
        this.emit("message", { data: "Path:turn.end\r\n\r\n" });
      });
    }
    emit(name, event) {
      for (const fn of this.listeners[name] || []) fn(event);
    }
  }
  const result = await synthesizeEdgeTts("지붕 면적", { WebSocketImpl: MockEdgeSocket, voice: "ko-KR-SunHiNeural" });
  assert.equal(result.provider, "edge");
  assert.equal(result.voice, "ko-KR-SunHiNeural");
  assert.equal(result.audio.toString(), "ID3PREVIEW");
  assert.equal(result.wordTimestamps[0].text, "지붕");
  assert.equal(result.wordTimestamps[0].start, 0.4);
});

test("settings PUT merges TTS without wiping BGM", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-settings-merge-"));
  await writeStudioSettings({
    ttsVoice: "ko-KR-SunHiNeural",
    bgmEnabled: true,
    bgmVolume: 0.12,
    ffmpegPath: "/opt/bin/ffmpeg"
  }, { root, env: {} });
  const merged = await writeStudioSettings({ ttsVoice: "ko-KR-InJoonNeural", ttsProvider: "edge" }, { root, env: {} });
  assert.equal(merged.ttsVoice, "ko-KR-InJoonNeural");
  assert.equal(merged.bgmEnabled, true);
  assert.equal(merged.bgmVolume, 0.12);
  assert.equal(merged.ffmpegPath, "/opt/bin/ffmpeg");
  await rm(root, { recursive: true, force: true });
});

test("OpenAPI documents ttsVoice on create", () => {
  const spec = studioOpenApi();
  assert.equal(spec.paths["/api/jobs"].post.requestBody.content["application/json"].schema.properties.ttsVoice.type, "string");
  assert.deepEqual(spec.paths["/api/jobs"].post.requestBody.content["application/json"].schema.properties.ttsProvider.enum, ["edge", "chirp"]);
});

test("resource/songs stays empty of MoneyPrinterTurbo rips", async () => {
  const names = await readdir(join(process.cwd(), "resource", "songs"));
  assert.ok(names.includes("README.md"));
  assert.deepEqual(names.filter((name) => !name.startsWith(".") && name !== "README.md"), []);
  const listed = await listBgmFiles(join(process.cwd()));
  assert.equal(listed.every((path) => !path.includes("resource/songs/") || !/\.(mp3|m4a|wav)$/i.test(path)), true);
});

test("stripPublicPaths removes filesystem paths from job and health messages", () => {
  assert.equal(
    stripPublicPaths("클립을 /workspace/jobs/demo/master.mp4 에서 읽지 못했습니다."),
    "클립을 에서 읽지 못했습니다."
  );
  assert.equal(stripPublicPaths("대기 1번"), "대기 1번");
  const job = stripPublicPaths({
    message: "실패 /opt/homebrew/bin/ffmpeg",
    error: "ENOENT workspace/imports/a.mp4",
    artifacts: [{ url: "/api/jobs/demo/artifacts/master.mp4" }]
  });
  assert.equal(job.message.includes("/opt/"), false);
  assert.equal(job.error.includes("workspace/imports"), false);
  assert.equal(job.artifacts[0].url, "/api/jobs/demo/artifacts/master.mp4");
  const health = stripPublicPaths({
    service: "ps4-ai-video-studio",
    browser: { connected: true },
    capabilities: { ytDlp: { installed: true } },
    message: "profile /Users/demo/.ps4-ai-video-studio/chrome"
  });
  assert.equal(health.browser.connected, true);
  assert.equal(health.capabilities.ytDlp.installed, true);
  assert.equal(health.message.includes("/Users/"), false);
});

test("BGM public list is filenames only", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-bgm-public-"));
  const songsDir = join(root, "workspace", "songs");
  await mkdir(songsDir, { recursive: true });
  await writeFile(join(songsDir, "bed.mp3"), Buffer.from("x"));
  const files = await listBgmFiles(root);
  const names = await listBgmPublicNames(root);
  assert.equal(files.some((path) => path.includes("/")), true);
  assert.deepEqual(names, ["bed.mp3"]);
  assert.equal(names.every((name) => !name.includes("/") && !name.includes("\\")), true);
  await rm(root, { recursive: true, force: true });
});

test("compose injects Edge timestamps into locked ASS and BGM amix", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps4-compose-"));
  const jobDir = join(root, "job");
  await mkdir(jobDir, { recursive: true });
  const clip = join(root, "clip.mp4");
  const bgm = join(root, "bed.mp3");
  await writeFile(clip, Buffer.from("clip"));
  await writeFile(bgm, Buffer.from("bgm"));
  const script = {
    legalQuantities: extractLegalQuantities(["지붕 면적 2만 m²"]),
    segments: [
      { narration: "지붕 면적 2만 m²", caption: "지붕 면적 2만 m²", durationHint: 10 },
      { narration: SCRIPT_CLOSER, caption: SCRIPT_CLOSER, durationHint: 10 }
    ]
  };
  const fakeSpawn = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const output = args.at(-1);
    queueMicrotask(async () => {
      if (typeof output === "string" && (output.includes("/") || /\.(mp4|jpg|png|wav|mp3)$/i.test(output))) {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, Buffer.from("ok"));
      }
      child.emit("close", 0);
    });
    return child;
  };
  const composed = await composeGrokImagine({
    jobDir,
    script,
    clipPaths: [clip],
    spawnImpl: fakeSpawn,
    settings: {
      ttsProvider: "edge",
      ttsVoice: "ko-KR-InJoonNeural",
      bgmEnabled: true,
      bgmVolume: 0.08
    },
    synthesizeTts: async (text, options) => {
      assert.match(text, /지붕/);
      assert.equal(options.voice, "ko-KR-InJoonNeural");
      assert.equal(options.provider, "edge");
      return {
        provider: "edge",
        voice: options.voice,
        audio: Buffer.from("ID3VOICE"),
        mime: "audio/mpeg",
        ...ttsTimingFromWords([
          { text: "지붕", start: 0.4, end: 0.7, type: "word" },
          { text: "면적", start: 0.7, end: 1.1, type: "word" },
          { text: "이렇게", start: 2.0, end: 2.8, type: "word" }
        ])
      };
    },
    resolveBgm: async () => bgm
  });
  const ass = await readFile(join(jobDir, "captions.ass"), "utf8");
  const mix = JSON.parse(await readFile(join(jobDir, "mix.json"), "utf8"));
  const timing = JSON.parse(await readFile(join(jobDir, "word-timestamps.json"), "utf8"));
  assert.match(ass, new RegExp(`,${ASS_MARGIN_V},1`));
  assert.match(ass, /Dialogue:/);
  assert.doesNotMatch(ass, /drawtext|drawbox/i);
  assert.match(mix.filter, /amix=inputs=2/);
  assert.doesNotMatch(mix.filter, /drawtext|drawbox/i);
  assert.equal(mix.bgm, true);
  assert.equal(timing.wordTimestamps[0].text, "지붕");
  assert.equal(composed.marginV, ASS_MARGIN_V);
  assert.equal(composed.captionTiming.source, CAPTION_TIMING_PAUSE);
  assert.equal(composed.voiceover, "voiceover.mp3");
  assert.equal(composed.captionsAss, "captions.ass");
  await rm(root, { recursive: true, force: true });
});
