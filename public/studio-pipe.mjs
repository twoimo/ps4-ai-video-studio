export function escapePipeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

export function pipelineChipClass({ ready, blocked, paused }) {
  if (paused) return " pause";
  if (blocked) return " danger";
  if (!ready) return " warn";
  return " ok";
}

export const PIPE_PAUSED = "지금은 그림을 안 만들어요";
export const PIPE_SCRIPT_MISSING = "대본을 쓸 수 없습니다";
export const PIPE_EDIT_MISSING = "편집을 할 수 없습니다";

export function pipelineStages(health = {}) {
  const grok = Boolean(health.capabilities?.grokCli);
  const ffmpeg = Boolean(health.capabilities?.ffmpeg);
  const frozen = health.imagine?.frozen !== false;
  const pictureReady = grok && !frozen;
  return [
    { label: "대본", ready: grok, blocked: false, title: grok ? "대본 · grok CLI 텍스트" : PIPE_SCRIPT_MISSING },
    { label: "그림", ready: pictureReady, paused: frozen, title: pictureReady ? "그림 · Grok Imagine" : PIPE_PAUSED },
    { label: "움직임", ready: pictureReady, paused: frozen, title: pictureReady ? "움직임 · Grok Imagine 영상" : PIPE_PAUSED },
    { label: "편집", ready: ffmpeg, blocked: false, title: ffmpeg ? "편집 · ffmpeg" : PIPE_EDIT_MISSING }
  ];
}

export function renderStudioPipe(health = {}) {
  const stages = pipelineStages(health);
  return `<nav class="studio-pipe" aria-label="만드는 과정" title="만드는 과정">${stages.map((stage, index) => {
    const arrow = index ? `<span class="studio-pipe-arrow" aria-hidden="true">→</span>` : "";
    return `${arrow}<button type="button" class="studio-chip${pipelineChipClass(stage)}" data-open-machine title="${escapePipeHtml(stage.title)}" aria-label="${escapePipeHtml(stage.title)}">${stage.label}</button>`;
  }).join("")}</nav>`;
}

export function staticStudioPipe() {
  return renderStudioPipe({ imagine: { frozen: true }, capabilities: {} });
}

export function machineSheetHtml(health = {}) {
  const stages = pipelineStages(health);
  return `<h2 id="machine-title">사양</h2><p>${stages.map((stage) => `${stage.label} ${stage.ready ? "준비" : stage.title}`).join(" · ")}</p>`;
}
