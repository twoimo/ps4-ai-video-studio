export const FACTORY_LIVE_STAGES = [
  { id: "plan", label: "기획/슬롯" },
  { id: "hook-lock", label: "훅 스틸 잠금" },
  { id: "image-edit", label: "샷별 image_edit" },
  { id: "still-qa", label: "스틸 QA" },
  { id: "animate", label: "10초 영상" },
  { id: "clip-qa", label: "클립 QA 0.3/5/9.5" },
  { id: "tts-mix", label: "TTS/믹스" },
  { id: "captions", label: "대화 자막" },
  { id: "compose", label: "fill 720×1280 합성" },
  { id: "parts", label: "채팅 파트" }
];

export const SHOT_ROLE_KO = {
  hook: "훅",
  surface: "재료",
  cutaway: "컷어웨이",
  system: "흐름",
  scale: "지붕 스케일",
  proof: "디테일",
  hold: "홀드"
};

export function factoryStageEvent({
  stageId,
  status,
  message,
  shotIndex = null,
  role = "",
  prompt = "",
  animatePrompt = "",
  artifacts = [],
  frozen = false
} = {}) {
  const stage = FACTORY_LIVE_STAGES.find((item) => item.id === stageId);
  return {
    type: "factory_stage",
    stageId,
    label: stage?.label || stageId,
    status,
    message,
    shotIndex,
    role,
    roleKo: SHOT_ROLE_KO[role] || "",
    prompt,
    animatePrompt,
    artifacts,
    frozen: Boolean(frozen)
  };
}

export function mergeLiveArtifacts(current = [], incoming = []) {
  const list = [...(Array.isArray(current) ? current : [])];
  for (const item of incoming || []) {
    if (!item?.name) continue;
    const index = list.findIndex((entry) => entry.name === item.name);
    if (index >= 0) list[index] = { ...list[index], ...item };
    else list.push(item);
  }
  return list;
}

export function liveArtifact(jobId, name, kind) {
  return {
    name,
    kind,
    url: `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`
  };
}

export function reduceFactoryStages(events = []) {
  const stages = FACTORY_LIVE_STAGES.map((stage) => ({
    ...stage,
    status: "WAIT",
    message: "",
    shotIndex: null,
    prompt: "",
    frozen: false
  }));
  for (const event of events) {
    const stageId = event.stageId || (event.type === "stage" && /기획|슬롯/.test(event.stage || "") ? "plan" : "");
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) continue;
    stage.status = event.status || (event.type === "stage" ? "RUN" : stage.status);
    if (event.message) stage.message = event.message;
    if (event.shotIndex) stage.shotIndex = event.shotIndex;
    if (event.prompt) stage.prompt = event.prompt;
    stage.frozen = Boolean(event.frozen);
  }
  return stages;
}

export function reduceLiveShots(events = [], artifacts = []) {
  const shots = Array.from({ length: 7 }, (_, index) => ({
    index: index + 1,
    status: "WAIT",
    message: "",
    stillUrl: "",
    clipUrl: "",
    frozen: false,
    prompt: "",
    role: "",
    roleKo: ""
  }));
  for (const artifact of artifacts || []) {
    const stillMatch = /factory\/stills\/(\d+)\.png$/i.exec(artifact.name || "");
    const clipMatch = /factory\/clips\/(\d+)\.mp4$/i.exec(artifact.name || "") || /clips\/(\d+)\.mp4$/i.exec(artifact.name || "");
    if (stillMatch && shots[Number(stillMatch[1]) - 1]) shots[Number(stillMatch[1]) - 1].stillUrl = artifact.url || "";
    if (clipMatch && shots[Number(clipMatch[1]) - 1]) shots[Number(clipMatch[1]) - 1].clipUrl = artifact.url || "";
  }
  for (const event of events) {
    const index = Number(event.shotIndex);
    if (!index || !shots[index - 1]) continue;
    const shot = shots[index - 1];
    if (event.status) shot.status = event.status;
    if (event.message) shot.message = event.message;
    if (event.prompt) shot.prompt = event.prompt;
    if (event.role) shot.role = event.role;
    if (event.roleKo) shot.roleKo = event.roleKo;
    shot.frozen = shot.frozen || Boolean(event.frozen);
    for (const artifact of event.artifacts || []) {
      if (/\.png$/i.test(artifact.name || "")) shot.stillUrl = artifact.url || shot.stillUrl;
      if (/\.mp4$/i.test(artifact.name || "")) shot.clipUrl = artifact.url || shot.clipUrl;
    }
  }
  return shots;
}

export function reduceLiveProofs(events = [], artifacts = []) {
  const frames = [];
  const add = (item) => {
    if (!item?.name || !/\.(png|jpe?g|webp)$/i.test(item.name)) return;
    if (!(item.kind === "proof-frame" || /factory\/proof\//i.test(item.name))) return;
    const index = frames.findIndex((entry) => entry.name === item.name);
    if (index >= 0) frames[index] = { ...frames[index], ...item };
    else frames.push({ name: item.name, kind: item.kind || "proof-frame", url: item.url || "" });
  };
  for (const artifact of artifacts || []) add(artifact);
  for (const event of events || []) {
    for (const artifact of event.artifacts || []) add(artifact);
  }
  return frames;
}

export function firstStageOrder(events = []) {
  const order = [];
  for (const event of events) {
    if (event?.type !== "factory_stage" || !event.stageId || order.includes(event.stageId)) continue;
    order.push(event.stageId);
  }
  return order;
}

export function encodeSse(event, id) {
  const name = event?.type || "message";
  const identity = id === undefined || id === null ? "" : `id: ${id}\n`;
  return `${identity}event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function liveJobView(job = {}) {
  return {
    id: job.id,
    topic: job.topic,
    facts: job.facts || [],
    provider: job.provider,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    artifacts: job.artifacts || [],
    live: job.live || null,
    runId: job.runId || null,
    duration: job.duration || null,
    updatedAt: job.updatedAt
  };
}

export function channelOneLiner(job = {}, editorial = null) {
  const fact = Array.isArray(job.facts) ? job.facts.find(Boolean) : "";
  if (fact) return String(fact).replace(/\s+/g, " ").trim();
  if (job.live?.message) return job.live.message;
  if (job.message && job.status !== "queued") return job.message;
  return editorial?.titleFormula || "익숙한 대상 + 상식과 반대되는 사실";
}
