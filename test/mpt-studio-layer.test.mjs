import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASS_MARGIN_V,
  buildAssDocument,
  buildDialogueCues,
  CAPTION_TIMING_PAUSE,
  mixAudioArgs,
  voiceBgmMixFilter
} from "../src/grok-imagine-compose.mjs";
import { extractLegalQuantities } from "../src/grok-imagine-factory.mjs";
import { extractGrokText } from "../src/grok-imagine-cli.mjs";
import { studioOpenApi } from "../src/openapi.mjs";
import { parseArgs, printHelp, runCli, IMAGINE_BLOCKED } from "../cli/studio.mjs";
import { chirpConfigured, defaultStudioSettings, readStudioSettings, writeStudioSettings } from "../src/studio-settings.mjs";
import { SCRIPT_CLOSER, assertScriptDraft, scriptDraftPrompt } from "../src/studio-script.mjs";
import { edgeWordTimestamps, ttsTimingFromWords } from "../src/studio-tts.mjs";

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
