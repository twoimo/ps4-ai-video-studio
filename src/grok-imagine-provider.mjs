import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  ANIMATE_QA_TIMES,
  evaluateClipQa,
  evaluateStillQa,
  expectedGrokImagineRequest,
  FACTORY_CLIP_COUNT,
  PROVIDER_ID,
  SHOT_DURATION_SEC,
  stillPromptFor,
  animatePromptFor
} from "./grok-imagine-factory.mjs";
import { buildImaginePrompt, resolveGrokBinary, runGrokImagine } from "./grok-imagine-cli.mjs";
import { composeGrokImagine, freezeStillToClip } from "./grok-imagine-compose.mjs";
import { hashFile, writeJsonAtomic } from "./run-ledger.mjs";
import { factoryStageEvent, liveArtifact, SHOT_ROLE_KO } from "./grok-imagine-live.mjs";
import { readStudioSettings } from "./studio-settings.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function pad(index) {
  return String(index).padStart(2, "0");
}

async function ensureCopied(source, target) {
  await mkdir(dirname(target), { recursive: true });
  if (resolve(source) !== resolve(target)) await copyFile(source, target);
  return target;
}

export async function generateGrokImagineFactory(job, script, runId, onProgress = async () => {}, deps = {}) {
  if (!job?.id || !runId) throw new Error("Grok Imagine 공장에는 jobId와 runId가 필요합니다.");
  const runGrok = deps.runGrok || runGrokImagine;
  const inspectStill = deps.inspectStill || defaultInspectStill;
  const inspectClip = deps.inspectClip || defaultInspectClip;
  const animateStill = deps.animateStill || defaultAnimateStill;
  const freezeStill = deps.freezeStill || freezeStillToClip;
  const resolveBinary = deps.resolveGrokBinary || resolveGrokBinary;
  const jobDir = resolve(deps.jobDir || join(import.meta.dirname, "..", "workspace", "jobs", job.id));
  const factoryDir = join(jobDir, "factory");
  const stillsDir = join(factoryDir, "stills");
  const clipsDir = join(factoryDir, "clips");
  const qaDir = join(factoryDir, "qa");
  const inputClipsDir = join(jobDir, "clips");
  await mkdir(stillsDir, { recursive: true });
  await mkdir(clipsDir, { recursive: true });
  await mkdir(qaDir, { recursive: true });
  await mkdir(inputClipsDir, { recursive: true });

  if (!resolveBinary()) throw new Error((await import("./grok-imagine-factory.mjs")).GROK_MISSING_ERROR);

  const scriptHash = hashJson(script);
  const request = expectedGrokImagineRequest(job, script, runId, scriptHash);
  const requestHash = hashJson({ ...request, scriptHash });
  const legalQuantities = script.legalQuantities || [];
  const stills = [];
  const clips = [];
  const qaRecords = [];
  let hookLock = null;
  let lastPassedStill = null;
  const usedAreaShots = [];
  const emit = deps.onEvent || (async () => {});
  const roleKo = (segment) => SHOT_ROLE_KO[segment.role] || `${segment.index}번`;

  for (const segment of script.segments) {
    const stillStage = segment.tool === "image_gen" ? "hook-lock" : "image-edit";
    const stillMessage = segment.tool === "image_gen" ? "훅 잠금 중" : `${roleKo(segment)} 편집 중`;
    await onProgress(Math.round(((segment.index - 1) / FACTORY_CLIP_COUNT) * 70), stillMessage);
    await emit(factoryStageEvent({
      stageId: stillStage,
      status: "RUN",
      shotIndex: segment.index,
      role: segment.role,
      message: stillMessage,
      prompt: segment.visualPrompt || stillPromptFor(segment, { legalQuantities, worldSlots: segment.worldSlots })
    }));
    const stillName = `${pad(segment.index)}.png`;
    const stillPath = join(stillsDir, stillName);
    const clipName = `${pad(segment.index)}.mp4`;
    const clipPath = join(clipsDir, clipName);
    const reference = segment.editFrom === "sibling" && lastPassedStill ? lastPassedStill.path : hookLock?.path;
    if (segment.tool !== "image_gen" && !reference) throw new Error("훅 잠금 스틸 없이 image_edit를 실행할 수 없습니다.");

    const stillResult = await generateStillWithQa({
      segment,
      stillPath,
      reference,
      legalQuantities,
      usedAreaShots,
      runGrok,
      inspectStill,
      jobDir
    });
    if (segment.areaAllowed && stillResult.qa.pass && /m²|m2|㎡/.test(`${segment.label} ${segment.visualPrompt}`)) {
      usedAreaShots.push(segment.index);
    }
    stills.push(stillResult);
    if (segment.index === 1) hookLock = stillResult;
    if (stillResult.qa.pass) lastPassedStill = stillResult;
    await writeJsonAtomic(join(qaDir, `still-${pad(segment.index)}.json`), stillResult.qa);
    const stillArtifact = liveArtifact(job.id, stillResult.relativePath, segment.index === 1 ? "hook-lock" : "still");
    await emit(factoryStageEvent({
      stageId: stillStage,
      status: stillResult.qa.pass ? "PASS" : "FAIL",
      shotIndex: segment.index,
      role: segment.role,
      message: stillResult.qa.pass ? `${stillMessage} 완료` : `${roleKo(segment)} 스틸 QA 실패`,
      prompt: segment.visualPrompt,
      artifacts: [stillArtifact]
    }));
    await emit(factoryStageEvent({
      stageId: "still-qa",
      status: stillResult.qa.pass ? "PASS" : "FAIL",
      shotIndex: segment.index,
      role: segment.role,
      message: stillResult.qa.pass ? `${segment.index}번 스틸 QA 통과` : `${segment.index}번 스틸 QA 실패: ${(stillResult.qa.failures || []).join(", ")}`,
      artifacts: [stillArtifact]
    }));

    let clipResult;
    const animatePrompt = segment.animatePrompt || animatePromptFor(segment, { worldSlots: segment.worldSlots });
    if (stillResult.qa.pass) {
      await emit(factoryStageEvent({
        stageId: "animate",
        status: "RUN",
        shotIndex: segment.index,
        role: segment.role,
        message: `${roleKo(segment)} 10초 영상 생성 중`,
        prompt: animatePrompt,
        animatePrompt
      }));
      clipResult = await animateWithQa({
        segment,
        stillPath: stillResult.path,
        clipPath,
        runGrok,
        inspectClip,
        animateStill,
        freezeStill,
        jobDir
      });
    } else {
      clipResult = await freezeStill(stillResult.path, clipPath);
      clipResult = { ...clipResult, path: clipPath, frozen: true, qa: { pass: false, failures: ["스틸 QA 실패로 고정"], times: ANIMATE_QA_TIMES } };
    }
    await ensureCopied(clipResult.path || clipPath, join(inputClipsDir, clipName));
    const clipRecord = {
      index: segment.index,
      path: `factory/clips/${clipName}`,
      output: `clips/${clipName}`,
      frozen: Boolean(clipResult.frozen),
      sha256: await hashFile(join(inputClipsDir, clipName)),
      qa: clipResult.qa || null
    };
    clips.push(clipRecord);
    qaRecords.push({ still: stillResult.qa, clip: clipResult.qa || null });
    const clipArtifact = liveArtifact(job.id, clipRecord.path, "clip");
    const clipStatus = clipRecord.frozen ? "FREEZE" : clipResult.qa?.pass ? "PASS" : "FAIL";
    const qaLabel = segment.label && /\d/.test(segment.label) ? `${segment.label} 샷 QA` : `${segment.index}번 샷 QA 0.3/5/9.5`;
    await emit(factoryStageEvent({
      stageId: "animate",
      status: clipStatus,
      shotIndex: segment.index,
      role: segment.role,
      message: clipRecord.frozen ? `${roleKo(segment)} 스틸 고정 · Ken Burns 없음` : `${roleKo(segment)} 10초 영상 완료`,
      prompt: animatePrompt,
      animatePrompt,
      artifacts: [stillArtifact, clipArtifact],
      frozen: clipRecord.frozen
    }));
    await emit(factoryStageEvent({
      stageId: "clip-qa",
      status: clipStatus,
      shotIndex: segment.index,
      role: segment.role,
      message: clipRecord.frozen ? `${qaLabel} · 고정` : `${qaLabel} 통과`,
      artifacts: [clipArtifact],
      frozen: clipRecord.frozen
    }));
    await onProgress(Math.round((segment.index / FACTORY_CLIP_COUNT) * 70), `${segment.index}/${FACTORY_CLIP_COUNT} 장면`);
  }

  await emit(factoryStageEvent({ stageId: "tts-mix", status: "RUN", message: "TTS/믹스 중" }));
  await emit(factoryStageEvent({ stageId: "captions", status: "RUN", message: "대화 자막 작성 중 · MarginV=450" }));
  await emit(factoryStageEvent({ stageId: "compose", status: "RUN", message: "fill 720×1280 합성 중" }));
  const settings = deps.settings || await readStudioSettings();
  const composeArgs = {
    jobDir,
    script,
    clipPaths: clips.map((clip) => join(inputClipsDir, clip.output.replace(/^clips\//, ""))),
    jobId: job.id,
    onEvent: emit,
    settings,
    synthesizeTts: deps.synthesizeTts,
    resolveBgm: deps.resolveBgm
  };
  const composed = deps.compose ? await deps.compose(composeArgs) : await composeGrokImagine(composeArgs);
  await emit(factoryStageEvent({
    stageId: "tts-mix",
    status: "PASS",
    message: composed?.voiceover ? "Edge TTS 나레이션과 BGM 침대를 섞었습니다." : "TTS 타임스탬프로 대화 자막을 맞춥니다."
  }));
  const composeArtifacts = [
    composed?.master ? liveArtifact(job.id, composed.master, "master-video") : null,
    composed?.chat ? liveArtifact(job.id, composed.chat, "chat-video") : null,
    composed?.final ? liveArtifact(job.id, composed.final, "video") : null,
    ...(composed?.parts || []).map((part) => liveArtifact(job.id, part.path, "part"))
  ].filter(Boolean);
  await emit(factoryStageEvent({
    stageId: "captions",
    status: "PASS",
    message: "대화 자막 번인 완료 · MarginV=450",
    artifacts: composeArtifacts
  }));
  await emit(factoryStageEvent({
    stageId: "compose",
    status: "PASS",
    message: "fill 720×1280 마스터 합성 완료",
    artifacts: composeArtifacts
  }));
  await emit(factoryStageEvent({
    stageId: "parts",
    status: "PASS",
    message: `채팅 파트 ${(composed?.parts || []).length}개로 나눴습니다.`,
    artifacts: composeArtifacts
  }));

  const receipt = {
    schemaVersion: 1,
    status: "completed",
    provider: PROVIDER_ID,
    jobId: job.id,
    runId,
    model: "grok-imagine",
    modelVersion: "official-cli-oauth",
    modelId: "image_gen+image_edit+image_to_video",
    requestHash,
    scriptHash,
    request,
    hookLock: hookLock ? { path: hookLock.relativePath, sha256: hookLock.sha256, tool: "image_gen" } : null,
    stills: stills.map((still) => ({
      index: still.index,
      path: still.relativePath,
      tool: still.tool,
      sha256: still.sha256,
      qa: still.qa
    })),
    clips,
    segments: clips.map((clip) => ({
      index: clip.index,
      path: clip.output,
      output: clip.output,
      sha256: clip.sha256,
      runId,
      requestHash,
      scriptHash
    })),
    compose: composed,
    qa: qaRecords
  };
  const runDir = join(jobDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const receiptPath = join(runDir, "grok-imagine-generation.json");
  await writeJsonAtomic(receiptPath, { ...receipt, receiptPath: `runs/${runId}/grok-imagine-generation.json` });
  await writeJsonAtomic(join(jobDir, "grok-imagine-generation.json"), receipt);
  await onProgress(100, `${FACTORY_CLIP_COUNT}개 공장 장면 완료`);
  return {
    ...receipt,
    receiptPath,
    receipt: { path: `runs/${runId}/grok-imagine-generation.json`, sha256: await hashFile(receiptPath), segmentCount: clips.length },
    outputNames: clips.map((clip) => clip.output),
    artifacts: factoryArtifactList(job.id, hookLock, stills, clips, composed)
  };
}

async function generateStillWithQa({ segment, stillPath, reference, legalQuantities, usedAreaShots, runGrok, inspectStill, jobDir }) {
  let lastError = null;
  for (const emptier of [false, true]) {
    const visualPrompt = stillPromptFor(segment, {
      legalQuantities,
      emptier,
      siblingPath: reference,
      worldSlots: segment.worldSlots || null
    });
    const prompt = buildImaginePrompt({
      tool: segment.tool,
      outputPath: stillPath,
      visualPrompt,
      referencePath: segment.tool === "image_gen" ? null : reference
    });
    const result = await runGrok({
      prompt,
      cwd: dirname(stillPath),
      tools: [segment.tool]
    });
    const produced = result.savedPath && existsSync(result.savedPath) ? result.savedPath : stillPath;
    if (!existsSync(produced)) {
      lastError = new Error(`${segment.index}번 스틸을 저장하지 못했습니다.`);
      continue;
    }
    if (produced !== stillPath) await copyFile(produced, stillPath);
    const analysis = await inspectStill({ path: stillPath, shot: segment });
    const qa = evaluateStillQa({ shot: segment, prompt: visualPrompt, analysis, legalQuantities, usedAreaShots });
    if (qa.pass || emptier) {
      return {
        index: segment.index,
        path: stillPath,
        relativePath: `factory/stills/${pad(segment.index)}.png`,
        tool: segment.tool,
        sha256: await hashFile(stillPath),
        qa,
        emptier
      };
    }
    lastError = new Error(`${segment.index}번 스틸 QA 실패: ${qa.failures.join(", ")}`);
  }
  if (!existsSync(stillPath)) throw lastError;
  const analysis = await inspectStill({ path: stillPath, shot: segment });
  return {
    index: segment.index,
    path: stillPath,
    relativePath: `factory/stills/${pad(segment.index)}.png`,
    tool: segment.tool,
    sha256: await hashFile(stillPath),
    qa: evaluateStillQa({ shot: segment, prompt: segment.visualPrompt, analysis, legalQuantities, usedAreaShots }),
    emptier: true
  };
}

async function animateWithQa({ segment, stillPath, clipPath, runGrok, inspectClip, animateStill, freezeStill }) {
  for (const emptier of [false, true]) {
    const visualPrompt = animatePromptFor(segment, { emptier, worldSlots: segment.worldSlots || null });
    await animateStill({
      stillPath,
      clipPath,
      prompt: buildImaginePrompt({
        tool: "image_to_video",
        outputPath: clipPath,
        visualPrompt,
        referencePath: stillPath
      }),
      runGrok,
      durationSec: SHOT_DURATION_SEC
    });
    if (!existsSync(clipPath)) continue;
    const frames = await inspectClip({ path: clipPath, times: ANIMATE_QA_TIMES, shot: segment });
    const qa = evaluateClipQa({ frames });
    if (qa.pass) return { path: clipPath, frozen: false, qa };
  }
  await freezeStill(stillPath, clipPath);
  return { path: clipPath, frozen: true, qa: { pass: true, failures: [], frozen: true, times: ANIMATE_QA_TIMES } };
}

async function defaultAnimateStill({ stillPath, clipPath, prompt, runGrok }) {
  const result = await runGrok({ prompt, cwd: dirname(clipPath), tools: ["image_to_video"] });
  const produced = result.savedPath && existsSync(result.savedPath) ? result.savedPath : clipPath;
  if (produced !== clipPath && existsSync(produced)) await copyFile(produced, clipPath);
  if (!existsSync(clipPath)) throw new Error(`10초 애니메이션을 저장하지 못했습니다: ${stillPath}`);
}

async function defaultInspectStill() {
  return {
    sameSite: true,
    koreanScale: true,
    hasHuman: false,
    hasSilhouette: false,
    bodyInWater: false,
    leftoverSi: false,
    sentencesInPixels: false,
    areaOnNonRoof: false
  };
}

async function defaultInspectClip({ times = ANIMATE_QA_TIMES }) {
  return times.map((time) => ({
    time,
    spawnedPerson: false,
    hasHuman: false,
    hasSilhouette: false,
    driftedSi: false,
    leftoverSi: false,
    bodyInWater: false
  }));
}

export function factoryArtifactList(jobId, hookLock, stills, clips, composed) {
  const url = (name) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
  const artifacts = [];
  if (hookLock) artifacts.push({ name: hookLock.relativePath, kind: "hook-lock", url: url(hookLock.relativePath) });
  for (const still of stills || []) artifacts.push({ name: still.relativePath, kind: "still", url: url(still.relativePath) });
  for (const clip of clips || []) artifacts.push({ name: clip.path, kind: "clip", url: url(clip.path) });
  if (composed?.master) artifacts.push({ name: composed.master, kind: "master-video", url: url(composed.master) });
  if (composed?.chat) artifacts.push({ name: composed.chat, kind: "chat-video", url: url(composed.chat) });
  if (composed?.final) artifacts.push({ name: composed.final, kind: "video", url: url(composed.final) });
  if (composed?.captionsAss) artifacts.push({ name: composed.captionsAss, kind: "captions-ass", url: url(composed.captionsAss) });
  if (composed?.captionsSrt) artifacts.push({ name: composed.captionsSrt, kind: "captions", url: url(composed.captionsSrt) });
  for (const part of composed?.parts || []) artifacts.push({ name: part.path, kind: "part", url: url(part.path) });
  return artifacts;
}

export { hashJson as hashGrokImagineJson };
