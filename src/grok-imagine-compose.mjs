import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { FACTORY_HEIGHT, FACTORY_WIDTH, SHOT_DURATION_SEC, numberizeCaptionText } from "./grok-imagine-factory.mjs";
import { factoryStageEvent, liveArtifact } from "./grok-imagine-live.mjs";
import { pickBgmFile, shouldMixBgm } from "./studio-bgm.mjs";
import { defaultStudioSettings } from "./studio-settings.mjs";
import { narrationTextFromScript, synthesizeStudioTts, ttsTimingFromWords, writeTtsSidecar } from "./studio-tts.mjs";

export const FILL_SCALE_CROP = `scale=${FACTORY_WIDTH}:${FACTORY_HEIGHT}:force_original_aspect_ratio=increase,crop=${FACTORY_WIDTH}:${FACTORY_HEIGHT}`;
export const ASS_ALIGNMENT = 2;
export const ASS_FONTSIZE = 50;
export const ASS_OUTLINE = 6;
export const ASS_MARGIN_V = 450;
export const ASS_CENTER_Y = FACTORY_HEIGHT - ASS_MARGIN_V - Math.round(ASS_FONTSIZE / 2);
export const MAX_PART_SEC = 16;
export const CHAT_SAFE_X264_PARAMS = "keyint=15:min-keyint=15:scenecut=0:bframes=0";
export const CHAT_SAFE_VCODEC = [
  "-c:v", "libx264",
  "-profile:v", "baseline",
  "-level", "3.1",
  "-pix_fmt", "yuv420p",
  "-preset", "medium",
  "-crf", "20",
  "-x264-params", CHAT_SAFE_X264_PARAMS,
  "-movflags", "+faststart"
];
export const CHAT_SAFE_ACODEC = ["-c:a", "aac", "-ar", "44100", "-ac", "2"];
export const CAPTION_TIMING_PAUSE = "speech-pause";
export const CAPTION_TIMING_FALLBACK = "durationHint-fallback";
const FORBIDDEN_FILTERS = ["drawbox", "drawtext"];

export function composeVideoFilter({ burnAssPath = null } = {}) {
  const parts = [FILL_SCALE_CROP, "setsar=1"];
  if (burnAssPath) {
    const escaped = String(burnAssPath).replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
    parts.push(`ass='${escaped}'`);
  }
  const vf = parts.join(",");
  assertNoSpecPills(vf);
  return vf;
}

export function freezeStillFilter() {
  const vf = `${FILL_SCALE_CROP},setsar=1,fps=30`;
  assertNoSpecPills(vf);
  if (/zoompan|kenburns/i.test(vf)) throw new Error("고정 스틸에 Ken Burns를 쓰지 않습니다.");
  return vf;
}

export function assertNoSpecPills(value) {
  const text = String(value || "").toLowerCase();
  for (const token of FORBIDDEN_FILTERS) {
    if (text.includes(token)) throw new Error(`스펙 알약 필터는 금지입니다: ${token}`);
  }
  return true;
}

export function usesKenBurns(vf) {
  return /zoompan|ken[\s-]?burns/i.test(String(vf || ""));
}

function toAssTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

export function assStyleLine() {
  return `Style: Default,Apple SD Gothic Neo,${ASS_FONTSIZE},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${ASS_OUTLINE},0,${ASS_ALIGNMENT},10,10,${ASS_MARGIN_V},1`;
}

export function buildAssDocument(cues = []) {
  const events = cues.map((cue) => {
    const text = String(cue.text || "").replace(/\n/g, "\\N").replace(/[{}]/g, "");
    return `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Default,,0,0,0,,${text}`;
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${FACTORY_WIDTH}`,
    `PlayResY: ${FACTORY_HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    assStyleLine(),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    ""
  ].join("\n");
}

function captionText(segment, legalQuantities = []) {
  return numberizeCaptionText(segment?.caption || segment?.narration || "", legalQuantities);
}

function asRange(item = {}) {
  const start = Number(item.start ?? item.silence_start ?? item.begin);
  const end = Number(item.end ?? item.silence_end ?? item.stop);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function collectWordTimestamps(timing = {}) {
  const lists = [
    timing.wordTimestamps,
    timing.words,
    timing.mix?.wordTimestamps,
    timing.mix?.words,
    timing.captionTiming?.wordTimestamps,
    timing.captionTiming?.words
  ];
  for (const list of lists) {
    if (!Array.isArray(list) || !list.length) continue;
    return list.map((item) => {
      const range = asRange(item);
      const text = String(item.text || item.word || "").trim();
      return range && text ? { ...range, text } : null;
    }).filter(Boolean);
  }
  return [];
}

function collectSilence(timing = {}) {
  const lists = [
    timing.silencedetect,
    timing.silence,
    timing.pauses,
    timing.mix?.silencedetect,
    timing.mix?.silence,
    timing.mix?.pauses
  ];
  for (const list of lists) {
    if (!Array.isArray(list) || !list.length) continue;
    return list.map(asRange).filter(Boolean).sort((left, right) => left.start - right.start);
  }
  return [];
}

function collectSpeech(timing = {}, duration = 0) {
  const listed = timing.speech || timing.mix?.speech || timing.speechWindows;
  if (Array.isArray(listed) && listed.length) return listed.map(asRange).filter(Boolean);
  const silence = collectSilence(timing);
  if (!silence.length) return [];
  const windows = [];
  let cursor = 0;
  for (const gap of silence) {
    if (gap.start > cursor + 0.04) windows.push({ start: cursor, end: gap.start });
    cursor = Math.max(cursor, gap.end);
  }
  if (duration && cursor < duration - 0.04) windows.push({ start: cursor, end: duration });
  return windows;
}

function fallbackDialogueCues(script, legalQuantities) {
  const segments = script?.segments || [];
  let cursor = 0;
  return segments.map((segment) => {
    const text = captionText(segment, legalQuantities);
    const start = cursor;
    const duration = Number(segment.durationHint) || SHOT_DURATION_SEC;
    cursor += duration;
    return text ? { text, start, end: Number(cursor.toFixed(3)), pauseTimed: false, source: CAPTION_TIMING_FALLBACK } : null;
  }).filter(Boolean);
}

function groupWordsByPauses(words, gapSec = 0.25) {
  const groups = [];
  let current = [];
  for (const word of words) {
    if (current.length && word.start - current.at(-1).end >= gapSec) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

function cuesFromWordTimestamps(script, words, legalQuantities) {
  const segments = (script?.segments || []).filter((segment) => captionText(segment, legalQuantities));
  if (!segments.length || !words.length) return [];
  const groups = groupWordsByPauses(words);
  return segments.map((segment, segmentIndex) => {
    const text = captionText(segment, legalQuantities);
    const group = groups[Math.min(segmentIndex, groups.length - 1)] || words;
    return {
      text,
      start: group[0].start,
      end: group.at(-1).end,
      pauseTimed: true,
      source: CAPTION_TIMING_PAUSE
    };
  });
}

function cuesFromSpeechWindows(script, windows, legalQuantities) {
  const texts = (script?.segments || []).map((segment) => captionText(segment, legalQuantities)).filter(Boolean);
  if (!texts.length || !windows.length) return [];
  return texts.map((text, index) => {
    const window = windows[Math.min(index, windows.length - 1)];
    const span = (window.end - window.start) / Math.max(1, texts.length - windows.length + 1);
    if (windows.length >= texts.length) {
      return { text, start: windows[index].start, end: windows[index].end, pauseTimed: true, source: CAPTION_TIMING_PAUSE };
    }
    const start = window.start + span * Math.max(0, index - (texts.length - windows.length));
    return { text, start, end: Math.min(window.end, start + span), pauseTimed: true, source: CAPTION_TIMING_PAUSE };
  });
}

export function resolveCaptionTiming(script = {}, timing = null) {
  return timing || script.captionTiming || script.mix || (
    script.wordTimestamps || script.silencedetect || script.speech
      ? script
      : null
  );
}

export function buildDialogueCues(script, timing = null) {
  const legalQuantities = script?.legalQuantities || [];
  const source = resolveCaptionTiming(script, timing);
  const words = collectWordTimestamps(source || {});
  if (words.length) {
    const cues = cuesFromWordTimestamps(script, words, legalQuantities);
    if (cues.length) return { cues, pauseTimed: true, source: CAPTION_TIMING_PAUSE };
  }
  const duration = (script?.segments || []).reduce((sum, segment) => sum + (Number(segment.durationHint) || SHOT_DURATION_SEC), 0);
  const speech = collectSpeech(source || {}, duration);
  if (speech.length) {
    const cues = cuesFromSpeechWindows(script, speech, legalQuantities);
    if (cues.length) return { cues, pauseTimed: true, source: CAPTION_TIMING_PAUSE };
  }
  return {
    cues: fallbackDialogueCues(script, legalQuantities),
    pauseTimed: false,
    source: CAPTION_TIMING_FALLBACK
  };
}

export function dialogueCuesFromScript(script, timing = null) {
  const { cues, pauseTimed, source } = buildDialogueCues(script, timing);
  cues.pauseTimed = pauseTimed;
  cues.source = source;
  return cues;
}

export async function loadCaptionTiming(script, jobDir = "") {
  const inline = resolveCaptionTiming(script);
  if (inline) return inline;
  if (!jobDir) return null;
  for (const name of ["caption-timing.json", "mix.json", "silencedetect.json", "word-timestamps.json"]) {
    const path = join(jobDir, name);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      // Skip a broken sidecar and keep looking.
    }
  }
  return null;
}

export function splitPartPlan(durationSec, maxPartSec = MAX_PART_SEC) {
  const duration = Math.max(0, Number(durationSec) || 0);
  const parts = [];
  let start = 0;
  let index = 1;
  while (start < duration - 0.01) {
    const length = Math.min(maxPartSec, duration - start);
    parts.push({
      index,
      name: `part-${String(index).padStart(2, "0")}.mp4`,
      start: Number(start.toFixed(3)),
      duration: Number(length.toFixed(3))
    });
    start += length;
    index += 1;
  }
  return parts;
}

export function chatSafeEncodeArgs(output) {
  const args = ["-y", ...CHAT_SAFE_VCODEC, ...CHAT_SAFE_ACODEC, output];
  assertNoSpecPills(args.join(" "));
  return args;
}

export function voiceBgmMixFilter({ bgm = false, bgmVolume = 0.08 } = {}) {
  const volume = Math.min(1, Math.max(0, Number(bgmVolume) || 0));
  const filterComplex = !bgm || volume <= 0
    ? "[1:a]aresample=44100,aformat=channel_layouts=stereo[aout]"
    : `[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=1[vo];[2:a]aresample=44100,aformat=channel_layouts=stereo,volume=${volume},aloop=loop=-1:size=2e+09[bg];[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
  assertNoSpecPills(filterComplex);
  if (/drawtext|drawbox/i.test(filterComplex)) throw new Error("BGM 믹스에 drawtext/drawbox를 쓰지 않습니다.");
  return {
    filterComplex,
    mapAudio: "[aout]",
    extraInputs: bgm && volume > 0 ? 1 : 0
  };
}

export function mixAudioArgs({ video, voice, bgm = null, bgmVolume = 0.08, output }) {
  const mix = voiceBgmMixFilter({ bgm: Boolean(bgm), bgmVolume });
  const args = ["-y", "-i", video, "-i", voice];
  if (mix.extraInputs && bgm) args.push("-i", bgm);
  args.push("-filter_complex", mix.filterComplex, "-map", "0:v:0", "-map", mix.mapAudio);
  assertNoSpecPills(args.join(" "));
  args.push(output);
  return args;
}

function commandPath(command, settings = {}) {
  if (command === "ffmpeg" && settings.ffmpegPath && existsSync(settings.ffmpegPath)) return settings.ffmpegPath;
  const override = command === "ffmpeg" ? process.env.FFMPEG_BINARY : command === "ffprobe" ? process.env.FFPROBE_BINARY : null;
  if (override && existsSync(override)) return override;
  if (typeof globalThis.Bun?.which === "function") return globalThis.Bun.which(command);
  return command;
}

async function runCommand(command, args, spawnImpl = spawn, settings = {}) {
  const binary = commandPath(command, settings);
  if (!binary) throw new Error(`${command} 명령을 찾을 수 없습니다.`);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (error) => reject(new Error(`${command} 실행 실패: ${error.message}`)));
    child.on?.("close", (code) => {
      if (code !== 0) reject(new Error(`${command} 실행 실패 (${code}): ${(stderr || stdout).trim().slice(-1200)}`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function freezeStillToClip(stillPath, outputPath, { durationSec = SHOT_DURATION_SEC, spawnImpl = spawn } = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  const vf = freezeStillFilter();
  await runCommand("ffmpeg", [
    "-y", "-loop", "1", "-i", stillPath,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t", String(durationSec),
    "-vf", vf,
    ...CHAT_SAFE_VCODEC,
    ...CHAT_SAFE_ACODEC,
    "-shortest",
    outputPath
  ], spawnImpl);
  return { path: outputPath, frozen: true, kenBurns: false };
}

async function extractProofFrame(input, output, spawnImpl = spawn) {
  await mkdir(dirname(output), { recursive: true });
  await runCommand("ffmpeg", ["-y", "-ss", "00:00:00.3", "-i", input, "-frames:v", "1", "-q:v", "2", output], spawnImpl);
}

function proofArtifact(jobId, name) {
  return jobId ? [liveArtifact(jobId, name, "proof-frame")] : [];
}

export async function composeGrokImagine({
  jobDir,
  script,
  clipPaths,
  jobId = "",
  spawnImpl = spawn,
  onEvent = async () => {},
  settings = defaultStudioSettings(),
  synthesizeTts = synthesizeStudioTts,
  resolveBgm = pickBgmFile
} = {}) {
  if (!clipPaths?.length) throw new Error("합성할 공장 클립이 없습니다.");
  const emit = onEvent;
  const ff = (args) => runCommand("ffmpeg", args, spawnImpl, settings);
  const vf = composeVideoFilter();
  assertNoSpecPills(vf);
  const normalizedDir = join(jobDir, "factory", "normalized");
  const proofDir = join(jobDir, "factory", "proof");
  await mkdir(normalizedDir, { recursive: true });
  await mkdir(proofDir, { recursive: true });
  const normalized = [];
  for (const [index, clipPath] of clipPaths.entries()) {
    await emit(factoryStageEvent({
      stageId: "compose",
      status: "RUN",
      shotIndex: index + 1,
      message: `${index + 1}번 클립 fill 720×1280 정규화 중`
    }));
    const output = join(normalizedDir, `${String(index + 1).padStart(2, "0")}.mp4`);
    await ff([
      "-y", "-i", clipPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", `${vf},fps=30`,
      "-t", String(script.segments?.[index]?.durationHint || SHOT_DURATION_SEC),
      ...CHAT_SAFE_VCODEC,
      ...CHAT_SAFE_ACODEC,
      "-shortest",
      output
    ]);
    normalized.push(output);
  }
  const listPath = join(jobDir, "factory", "concat.txt");
  await writeFile(listPath, normalized.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const assembled = join(jobDir, "assembled.mp4");
  await emit(factoryStageEvent({ stageId: "compose", status: "RUN", message: "하드 컷 concat 중" }));
  await ff(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", assembled]);
  const concatFrame = join(proofDir, "concat.jpg");
  try { await extractProofFrame(assembled, concatFrame, spawnImpl); } catch { /* proof frames are live UX only */ }
  if (existsSync(concatFrame)) {
    await emit(factoryStageEvent({
      stageId: "compose",
      status: "RUN",
      message: "하드 컷 concat 증명 프레임",
      artifacts: proofArtifact(jobId, "factory/proof/concat.jpg")
    }));
  }

  let voiced = assembled;
  const narration = narrationTextFromScript(script);
  if (narration && typeof synthesizeTts === "function") {
    await emit(factoryStageEvent({ stageId: "tts-mix", status: "RUN", message: "Edge TTS 나레이션 중" }));
    let tts;
    try {
      tts = await synthesizeTts(narration, { voice: settings.ttsVoice, provider: settings.ttsProvider });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Gemini로 대체하지 않습니다.`);
    }
    const sidecar = await writeTtsSidecar(jobDir, tts);
    const timingSidecar = sidecar.timing?.wordTimestamps?.length ? sidecar.timing : ttsTimingFromWords(tts.words || tts.wordTimestamps || []);
    await writeFile(join(jobDir, "word-timestamps.json"), JSON.stringify(timingSidecar, null, 2));
    const bgmPath = shouldMixBgm(settings) ? await resolveBgm({ settings, preferred: settings.bgmFile }) : null;
    const mixed = join(jobDir, "voiced.mp4");
    const mix = voiceBgmMixFilter({ bgm: Boolean(bgmPath), bgmVolume: settings.bgmVolume });
    const mixArgs = ["-y", "-i", assembled, "-i", sidecar.audioPath];
    if (mix.extraInputs && bgmPath) mixArgs.push("-i", bgmPath);
    mixArgs.push("-filter_complex", mix.filterComplex, "-map", "0:v:0", "-map", mix.mapAudio, ...CHAT_SAFE_VCODEC, ...CHAT_SAFE_ACODEC, mixed);
    assertNoSpecPills(mixArgs.join(" "));
    await ff(mixArgs);
    voiced = mixed;
    await writeFile(join(jobDir, "mix.json"), JSON.stringify({
      schemaVersion: 1,
      ...timingSidecar,
      bgm: Boolean(bgmPath),
      bgmVolume: bgmPath ? settings.bgmVolume : 0,
      filter: voiceBgmMixFilter({ bgm: Boolean(bgmPath), bgmVolume: settings.bgmVolume }).filterComplex
    }, null, 2));
  }

  const timing = await loadCaptionTiming(script, jobDir);
  const built = buildDialogueCues(script, timing);
  const cues = built.cues;
  const assPath = join(jobDir, "captions.ass");
  const srtPath = join(jobDir, "captions.srt");
  await writeFile(join(jobDir, "caption-timing.json"), JSON.stringify({
    schemaVersion: 1,
    pauseTimed: built.pauseTimed,
    source: built.source,
    alignment: built.pauseTimed ? CAPTION_TIMING_PAUSE : CAPTION_TIMING_FALLBACK,
    estimated: !built.pauseTimed,
    marginV: ASS_MARGIN_V,
    cues
  }, null, 2));
  await writeFile(assPath, buildAssDocument(cues));
  await writeFile(srtPath, cues.map((cue, index) => {
    const start = toSrt(cue.start);
    const end = toSrt(cue.end);
    return `${index + 1}\n${start} --> ${end}\n${cue.text}\n`;
  }).join("\n"));

  const master = join(jobDir, "master.mp4");
  const burn = composeVideoFilter({ burnAssPath: assPath });
  await emit(factoryStageEvent({ stageId: "captions", status: "RUN", message: "대화 자막 번인 중 · MarginV=450" }));
  await ff([
    "-y", "-i", voiced,
    "-vf", burn,
    ...CHAT_SAFE_VCODEC,
    "-c:a", "copy",
    master
  ]);
  const captionFrame = join(proofDir, "captions.jpg");
  try { await extractProofFrame(master, captionFrame, spawnImpl); } catch { /* proof frames are live UX only */ }
  if (existsSync(captionFrame)) {
    await emit(factoryStageEvent({
      stageId: "captions",
      status: "RUN",
      message: "자막 번인 증명 프레임 · MarginV=450",
      artifacts: proofArtifact(jobId, "factory/proof/captions.jpg")
    }));
  }
  const finalPath = join(jobDir, "final.mp4");
  const chatPath = join(jobDir, "chat.mp4");
  await ff(["-y", "-i", master, "-c", "copy", finalPath]);
  await ff(["-y", "-i", master, "-c", "copy", chatPath]);

  const duration = cues.at(-1)?.end || clipPaths.length * SHOT_DURATION_SEC;
  const partsDir = join(jobDir, "parts");
  await mkdir(partsDir, { recursive: true });
  const parts = [];
  await emit(factoryStageEvent({ stageId: "parts", status: "RUN", message: "채팅 파트 분할 중" }));
  for (const part of splitPartPlan(duration)) {
    const partPath = join(partsDir, part.name);
    await ff([
      "-y", "-ss", String(part.start), "-i", chatPath, "-t", String(part.duration),
      "-c", "copy",
      partPath
    ]);
    parts.push({ ...part, path: `parts/${part.name}` });
    const partFrame = join(proofDir, `part-${String(part.index).padStart(2, "0")}.jpg`);
    try { await extractProofFrame(partPath, partFrame, spawnImpl); } catch { /* proof frames are live UX only */ }
    if (existsSync(partFrame)) {
      await emit(factoryStageEvent({
        stageId: "parts",
        status: "RUN",
        message: `${part.name} 분할 증명 프레임`,
        artifacts: proofArtifact(jobId, `factory/proof/part-${String(part.index).padStart(2, "0")}.jpg`)
      }));
    }
  }
  const thumbnail = join(jobDir, "thumbnail.jpg");
  await ff(["-y", "-ss", "00:00:01", "-i", finalPath, "-frames:v", "1", "-q:v", "2", thumbnail]);
  return {
    master: "master.mp4",
    chat: "chat.mp4",
    final: "final.mp4",
    captionsAss: "captions.ass",
    captionsSrt: "captions.srt",
    voiceover: existsSync(join(jobDir, "voiceover.mp3")) ? "voiceover.mp3" : null,
    parts,
    duration,
    vf: FILL_SCALE_CROP,
    marginV: ASS_MARGIN_V,
    captionTiming: { pauseTimed: built.pauseTimed, source: built.source }
  };
}

function toSrt(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
