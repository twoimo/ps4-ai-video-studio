import { inspectVideoDownloads } from "./shorts-ui.mjs";

export const INSPECT_WORLD_SLOT_IDS = [
  "site",
  "weather",
  "everyday_thing",
  "hidden_thing",
  "materials",
  "wear",
  "trace",
  "palette"
];

export function escapeMaterialsHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inspectSlotValue(slots, id, job) {
  const fromPrompt = (slots || []).find((slot) => slot.id === id)?.value;
  if (fromPrompt != null && String(fromPrompt).trim()) return fromPrompt;
  return job?.worldSlots?.[id] || "";
}

export function hiddenInspectFields(job, prompts) {
  const facts = Array.isArray(job.facts) ? job.facts.join("\n") : "";
  const slots = INSPECT_WORLD_SLOT_IDS.map((id) => `<textarea hidden class="inspect-slot" data-world-slot="${escapeMaterialsHtml(id)}">${escapeMaterialsHtml(inspectSlotValue(prompts?.worldSlots, id, job))}</textarea>`).join("");
  const shots = (prompts?.shots || []).map((shot, offset) => {
    const index = Number(shot.index || offset + 1);
    return `<article hidden class="inspect-shot" data-shot-index="${index}"><textarea class="inspect-shot-prompt" data-shot-prompt>${escapeMaterialsHtml(shot.prompt || "")}</textarea><textarea class="inspect-shot-animate" data-shot-animate>${escapeMaterialsHtml(shot.animatePrompt || "")}</textarea></article>`;
  }).join("");
  return `<textarea hidden class="inspect-facts" data-draft-facts>${escapeMaterialsHtml(facts)}</textarea>${slots}${shots}`;
}

function captionLine(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    return String(value.caption || value.narration || value.text || value.line || "").trim();
  }
  return "";
}

function captionLinesFromValue(value) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return [];
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) return value.map(captionLine).filter(Boolean);
  if (typeof value === "object") {
    if (Array.isArray(value.lines)) return captionLinesFromValue(value.lines);
    if (Array.isArray(value.segments)) return value.segments.map(captionLine).filter(Boolean);
    if (typeof value.text === "string") return captionLinesFromValue(value.text);
    if (typeof value.scriptDraft === "string") return captionLinesFromValue(value.scriptDraft);
  }
  return [];
}

export function fallbackCaptionPrompts(job = {}) {
  const captions = [
    job.lines,
    job.captions,
    job.script?.lines,
    job.script,
    job.scriptDraft
  ].reduce((found, candidate) => (found.length ? found : captionLinesFromValue(candidate)), []);
  return {
    shots: captions.map((caption, offset) => ({
      index: offset + 1,
      caption
    }))
  };
}

export function renderInspectCaptions(shots = []) {
  return shots.map((shot, offset) => {
    const index = Number(shot.index || offset + 1);
    const kind = shot.type || shot.role || "";
    return `<div class="inspect-caption" data-shot-index="${index}"><b>${index}${kind ? `<i>${escapeMaterialsHtml(kind)}</i>` : ""}</b><textarea class="inspect-shot-caption" data-shot-caption data-shot-index="${index}" rows="2">${escapeMaterialsHtml(shot.caption || shot.narration || "")}</textarea></div>`;
  }).join("");
}

export function collectInspectPayload(root) {
  const shots = {};
  root?.querySelectorAll(".inspect-shot[data-shot-index]").forEach((node) => {
    const index = Number(node.dataset.shotIndex);
    if (!Number.isInteger(index)) return;
    shots[index] = {
      index,
      prompt: node.querySelector("[data-shot-prompt], .inspect-shot-prompt")?.value || "",
      animatePrompt: node.querySelector("[data-shot-animate], .inspect-shot-animate")?.value || "",
      caption: node.querySelector("[data-shot-caption], .inspect-shot-caption")?.value || ""
    };
  });
  root?.querySelectorAll(".inspect-caption [data-shot-caption], .inspect-caption .inspect-shot-caption").forEach((input) => {
    const index = Number(input.dataset.shotIndex || input.closest("[data-shot-index]")?.dataset.shotIndex);
    if (!Number.isInteger(index)) return;
    shots[index] = {
      index,
      prompt: shots[index]?.prompt || "",
      animatePrompt: shots[index]?.animatePrompt || "",
      caption: input.value || ""
    };
  });
  return {
    topic: root.querySelector("[data-draft-topic], .inspect-topic")?.value || "",
    facts: (root.querySelector("[data-draft-facts], .inspect-facts")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    scriptDraft: root.querySelector("[data-draft-script], .inspect-script")?.value || "",
    worldSlots: Object.fromEntries([...root.querySelectorAll("[data-world-slot]")].map((input) => [input.dataset.worldSlot, input.value]).filter(([, value]) => String(value || "").trim())),
    shotOverrides: shots
  };
}

export function renderMaterialsPanel(job, prompts, { frozen = false } = {}) {
  const shots = prompts?.shots || [];
  const files = inspectVideoDownloads(job).map((item) => `<a href="${escapeMaterialsHtml(item.href)}" download>${escapeMaterialsHtml(item.label)}</a>`).join("");
  const regenClass = frozen ? "secondary-button inspect-regen is-paused" : "secondary-button inspect-regen";
  const regenLabel = frozen ? "다시 만들기 · 멈춤" : "다시 만들기";
  const regenTitle = frozen ? "지금은 그림을 안 만들어요" : "";
  return `<form class="inspect-form" novalidate onsubmit="return false"><div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2></div><label class="field-label" for="inspect-topic-${escapeMaterialsHtml(job.id)}">제목</label><input id="inspect-topic-${escapeMaterialsHtml(job.id)}" class="inspect-topic" data-draft-topic value="${escapeMaterialsHtml(job.topic || "")}" minlength="4" /><label class="field-label">대본</label><textarea class="inspect-script" data-draft-script rows="4">${escapeMaterialsHtml(job.scriptDraft || "")}</textarea><label class="field-label">자막</label>${renderInspectCaptions(shots)}${hiddenInspectFields(job, prompts)}${files ? `<div class="inspect-files">${files}</div>` : ""}<div class="inspect-actions"><button type="submit" class="primary-button inspect-save" data-inspect-save>저장</button><button type="button" class="${regenClass}" data-inspect-regen${frozen ? " disabled" : ""}${regenTitle ? ` title="${regenTitle}"` : ""}>${regenLabel}</button>${frozen ? `<p class="inspect-frozen">지금은 그림을 안 만들어요</p>` : ""}</div></div></form>`;
}
