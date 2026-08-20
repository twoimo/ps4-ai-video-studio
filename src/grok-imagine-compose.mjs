import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { FACTORY_HEIGHT, FACTORY_WIDTH, SHOT_DURATION_SEC } from "./grok-imagine-factory.mjs";
import { factoryStageEvent, liveArtifact } from "./grok-imagine-live.mjs";

export const FILL_SCALE_CROP = `scale=${FACTORY_WIDTH}:${FACTORY_HEIGHT}:force_original_aspect_ratio=increase,crop=${FACTORY_WIDTH}:${FACTORY_HEIGHT}`;
export const ASS_ALIGNMENT = 2;
export const ASS_FONTSIZE = 50;
export const ASS_OUTLINE = 6;
export const ASS_MARGIN_V = 450;
export const ASS_CENTER_Y = FACTORY_HEIGHT - ASS_MARGIN_V - Math.round(ASS_FONTSIZE / 2);
export const MAX_PART_SEC = 16;
export const CHAT_SAFE_VCODEC = ["-c:v", "libx264", "-profile:v", "main", "-level", "4.0", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20", "-movflags", "+faststart"];
export const CHAT_SAFE_ACODEC = ["-c:a", "aac", "-ar", "44100", "-ac", "2"];
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

export function dialogueCuesFromScript(script) {
  const segments = script?.segments || [];
  let cursor = 0;
  return segments.map((segment) => {
    const start = cursor;
    const duration = Number(segment.durationHint) || SHOT_DURATION_SEC;
    cursor += duration;
    return { text: segment.caption || segment.narration || "", start, end: cursor };
  }).filter((cue) => cue.text);
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
  const args = ["-y", "-c:v", "libx264", "-profile:v", "main", "-level", "4.0", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-c:a", "aac", "-ar", "44100", "-ac", "2", output];
  assertNoSpecPills(args.join(" "));
  return args;
}

function commandPath(command) {
  const override = command === "ffmpeg" ? process.env.FFMPEG_BINARY : command === "ffprobe" ? process.env.FFPROBE_BINARY : null;
  if (override && existsSync(override)) return override;
  if (typeof globalThis.Bun?.which === "function") return globalThis.Bun.which(command);
  return command;
}

async function runCommand(command, args, spawnImpl = spawn) {
  const binary = commandPath(command);
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

export async function composeGrokImagine({ jobDir, script, clipPaths, jobId = "", spawnImpl = spawn, onEvent = async () => {} } = {}) {
  if (!clipPaths?.length) throw new Error("합성할 공장 클립이 없습니다.");
  const emit = onEvent;
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
    await runCommand("ffmpeg", [
      "-y", "-i", clipPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", `${vf},fps=30`,
      "-t", String(script.segments?.[index]?.durationHint || SHOT_DURATION_SEC),
      ...CHAT_SAFE_VCODEC,
      ...CHAT_SAFE_ACODEC,
      "-shortest",
      output
    ], spawnImpl);
    normalized.push(output);
  }
  const listPath = join(jobDir, "factory", "concat.txt");
  await writeFile(listPath, normalized.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const assembled = join(jobDir, "assembled.mp4");
  await emit(factoryStageEvent({ stageId: "compose", status: "RUN", message: "하드 컷 concat 중" }));
  await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", assembled], spawnImpl);
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

  const cues = dialogueCuesFromScript(script);
  const assPath = join(jobDir, "captions.ass");
  const srtPath = join(jobDir, "captions.srt");
  await writeFile(assPath, buildAssDocument(cues));
  await writeFile(srtPath, cues.map((cue, index) => {
    const start = toSrt(cue.start);
    const end = toSrt(cue.end);
    return `${index + 1}\n${start} --> ${end}\n${cue.text}\n`;
  }).join("\n"));

  const master = join(jobDir, "master.mp4");
  const burn = composeVideoFilter({ burnAssPath: assPath });
  await emit(factoryStageEvent({ stageId: "captions", status: "RUN", message: "대화 자막 번인 중 · MarginV=450" }));
  await runCommand("ffmpeg", [
    "-y", "-i", assembled,
    "-vf", burn,
    ...CHAT_SAFE_VCODEC,
    "-c:a", "copy",
    master
  ], spawnImpl);
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
  await runCommand("ffmpeg", ["-y", "-i", master, "-c", "copy", finalPath], spawnImpl);
  await runCommand("ffmpeg", ["-y", "-i", master, "-c", "copy", chatPath], spawnImpl);

  const duration = cues.at(-1)?.end || clipPaths.length * SHOT_DURATION_SEC;
  const partsDir = join(jobDir, "parts");
  await mkdir(partsDir, { recursive: true });
  const parts = [];
  await emit(factoryStageEvent({ stageId: "parts", status: "RUN", message: "채팅 파트 분할 중" }));
  for (const part of splitPartPlan(duration)) {
    const partPath = join(partsDir, part.name);
    await runCommand("ffmpeg", [
      "-y", "-ss", String(part.start), "-i", chatPath, "-t", String(part.duration),
      "-c", "copy",
      partPath
    ], spawnImpl);
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
  await runCommand("ffmpeg", ["-y", "-ss", "00:00:01", "-i", finalPath, "-frames:v", "1", "-q:v", "2", thumbnail], spawnImpl);
  return {
    master: "master.mp4",
    chat: "chat.mp4",
    final: "final.mp4",
    captionsAss: "captions.ass",
    captionsSrt: "captions.srt",
    parts,
    duration,
    vf: FILL_SCALE_CROP,
    marginV: ASS_MARGIN_V
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
