#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createJob, ensureWorkspace } from "../src/pipeline.mjs";
import { DEFAULT_EDGE_VOICE, readStudioSettings } from "../src/studio-settings.mjs";
import { synthesizeStudioTts } from "../src/studio-tts.mjs";

export const IMAGINE_BLOCKED = "Imagine을 시작하지 않습니다. grok image_gen / image_edit / image_to_video는 402에서 호출하지 않습니다. 초안과 TTS 미리 듣기만 합니다.";

export function printHelp(write = console.log) {
  write(`ps4-studio — 공장 초안 CLI

사용:
  node cli/studio.mjs --topic <주제> --facts <사실>
  node cli/studio.mjs --tts-preview [--text <문장>] [--voice <이름>] [--out <파일>]
  node cli/studio.mjs --help

옵션:
  --topic         쇼츠 주제 (초안 작성 시 필수)
  --facts         출처 사실. SI의 유일한 출처. 반복하거나 줄바꿈으로 여러 줄.
  --script-draft  이미 만든 한국어 대본
  --tts-preview   Imagine 없이 음성만 미리 듣기
  --text          미리 들을 문장
  --voice         Edge TTS 목소리 (기본 ${DEFAULT_EDGE_VOICE})
  --out           미리 듣기 저장 경로 (기본 voice-preview.mp3)
  --start         거부됨. Imagine을 시작하지 않습니다.

Imagine을 시작하지 않습니다. 초안 작업과 TTS 미리 듣기만 합니다.
`);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { facts: [], help: false, ttsPreview: false, start: false, topic: "", scriptDraft: "", text: "", voice: "", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--topic") options.topic = String(next() || "");
    else if (arg === "--facts") options.facts.push(String(next() || ""));
    else if (arg === "--script-draft") options.scriptDraft = String(next() || "");
    else if (arg === "--tts-preview") options.ttsPreview = true;
    else if (arg === "--text") options.text = String(next() || "");
    else if (arg === "--voice") options.voice = String(next() || "");
    else if (arg === "--out") options.out = String(next() || "");
    else if (arg === "--start") options.start = true;
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  options.facts = options.facts.flatMap((item) => String(item).split(/\r?\n/)).map((item) => item.trim()).filter(Boolean);
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error, create = createJob, synthesize = synthesizeStudioTts } = {}) {
  const options = parseArgs(argv);
  if (options.help || argv.length === 0) {
    printHelp(stdout);
    return { ok: true, help: true };
  }
  if (options.start) {
    stderr(IMAGINE_BLOCKED);
    return { ok: false, blocked: true, message: IMAGINE_BLOCKED };
  }
  if (options.ttsPreview) {
    const settings = await readStudioSettings();
    const text = options.text.trim() || "이렇게 설계된 겁니다.";
    const result = await synthesize(text, { voice: options.voice || settings.ttsVoice, provider: settings.ttsProvider });
    const out = options.out || "voice-preview.mp3";
    await writeFile(out, result.audio);
    stdout(`미리 듣기: ${out}`);
    return { ok: true, preview: out, provider: result.provider };
  }
  if (!options.topic || options.topic.trim().length < 4) throw new Error("영상 주제를 4자 이상 입력하세요.");
  if (!options.facts.length) throw new Error("출처에 적힌 사실(--facts)이 있어야 SI를 잠글 수 있습니다.");
  await ensureWorkspace();
  const job = await create({
    topic: options.topic.trim(),
    facts: options.facts,
    scriptDraft: options.scriptDraft,
    provider: "grok-imagine",
    draftOnly: true,
    startImagine: false
  });
  stdout(`초안 ${job.id}`);
  return { ok: true, job };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli/studio.mjs");
if (isMain) {
  runCli().then((result) => {
    process.exit(result?.ok === false ? 2 : 0);
  }).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
