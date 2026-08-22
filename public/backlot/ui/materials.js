import { collectInspectPayload, fallbackCaptionPrompts, renderMaterialsPanel } from "/materials-editor.mjs";
import { getJSON } from "/backlot/ui/lib.js";

const rawProjectPath = (location.pathname.split("/p/")[1] || "").replace(/\/+$/, "");
const projectId = decodeURIComponent(rawProjectPath);
const root = document.getElementById("materials");
const creditMark = String(400 + 2);

async function readJson(url, fallback = null) {
  try {
    return await getJSON(url);
  } catch {
    return fallback;
  }
}

function status(text, kind = "") {
  let note = root?.querySelector(".materials-status");
  if (!note && root) {
    note = document.createElement("p");
    note.className = "materials-status";
    root.prepend(note);
  }
  if (!note) return;
  note.textContent = text;
  note.dataset.kind = kind;
}

function promptsForPanel(job, prompts) {
  if (Array.isArray(prompts?.shots) && prompts.shots.length) return prompts;
  const fallback = fallbackCaptionPrompts(job);
  if (!prompts) return fallback;
  return { ...prompts, shots: fallback.shots };
}

function pausedActionError(error) {
  const text = String(error?.message || error || "");
  const code = Number(error?.status);
  if (code === 400 + 2 || text.includes(creditMark) || text.includes("크레딧")) {
    return "지금은 다시 못 만들어요.";
  }
  return text;
}

async function saveMaterials() {
  const body = collectInspectPayload(root);
  const payload = await fetch(`/api/jobs/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await payload.json().catch(() => ({}));
  if (!payload.ok) {
    const error = new Error(data.error || "초안을 저장하지 못했습니다.");
    error.status = payload.status;
    throw error;
  }
  return data;
}

function bindMaterials(frozen) {
  const save = async (event) => {
    event?.preventDefault?.();
    try {
      await saveMaterials();
      status("초안을 저장했습니다.");
    } catch (error) {
      status(pausedActionError(error), "error");
    }
  };
  root.querySelector(".inspect-form")?.addEventListener("submit", save);
  root.querySelector("[data-inspect-save], .inspect-save")?.addEventListener("click", save);
  root.querySelector("[data-inspect-regen], .inspect-regen")?.addEventListener("click", async () => {
    if (frozen) return;
    try {
      await saveMaterials();
      const response = await fetch(`/api/jobs/${encodeURIComponent(projectId)}/run`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || "대기열에 넣지 못했습니다.");
        error.status = response.status;
        throw error;
      }
      status("대기열에 넣었습니다.");
    } catch (error) {
      status(pausedActionError(error), "error");
    }
  });
}

async function mountMaterials() {
  if (!root || !projectId) return;
  root.hidden = false;
  if (!root.querySelector(".lib-skeleton") && !root.querySelector(".inspect-stack")) {
    root.innerHTML = `<div class="lib-skeleton" aria-hidden="true"></div>`;
  }
  const [job, prompts, health] = await Promise.all([
    readJson(`/api/jobs/${encodeURIComponent(projectId)}`),
    readJson(`/api/jobs/${encodeURIComponent(projectId)}/prompts`),
    readJson("/api/health", {})
  ]);
  if (!job) {
    root.hidden = false;
    root.innerHTML = `<div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2></div><p class="materials-status" data-kind="error">작업을 찾지 못했습니다.</p></div>`;
    return;
  }
  const frozen = health?.imagine?.frozen !== false;
  root.hidden = false;
  root.innerHTML = renderMaterialsPanel(job, promptsForPanel(job, prompts), { frozen });
  bindMaterials(frozen);
}

mountMaterials().catch((error) => {
  if (!root) return;
  root.hidden = false;
  root.innerHTML = `<div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2></div><p class="materials-status" data-kind="error">${String(error.message || error)}</p></div>`;
});
