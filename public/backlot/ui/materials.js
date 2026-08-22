import { collectInspectPayload, renderMaterialsPanel } from "/materials-editor.mjs";
import { getJSON } from "/backlot/ui/lib.js";

const rawProjectPath = (location.pathname.split("/p/")[1] || "").replace(/\/+$/, "");
const projectId = decodeURIComponent(rawProjectPath);
const root = document.getElementById("materials");

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

async function saveMaterials() {
  const body = collectInspectPayload(root);
  const payload = await fetch(`/api/jobs/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await payload.json().catch(() => ({}));
  if (!payload.ok) throw new Error(data.error || "초안을 저장하지 못했습니다.");
  return data;
}

function bindMaterials(frozen) {
  root.querySelector("[data-inspect-save], .inspect-save")?.addEventListener("click", async () => {
    try {
      await saveMaterials();
      status("초안을 저장했습니다.");
    } catch (error) {
      status(error.message, "error");
    }
  });
  root.querySelector("[data-inspect-regen], .inspect-regen")?.addEventListener("click", async () => {
    if (frozen) {
      status("크레딧 부족", "error");
      return;
    }
    try {
      await saveMaterials();
      const response = await fetch(`/api/jobs/${encodeURIComponent(projectId)}/run`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "대기열에 넣지 못했습니다.");
      status("대기열에 넣었습니다.");
    } catch (error) {
      status(error.message, "error");
    }
  });
}

async function mountMaterials() {
  if (!root || !projectId) return;
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
  root.innerHTML = renderMaterialsPanel(job, prompts, { frozen });
  bindMaterials(frozen);
}

mountMaterials().catch((error) => {
  if (!root) return;
  root.hidden = false;
  root.innerHTML = `<div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2></div><p class="materials-status" data-kind="error">${String(error.message || error)}</p></div>`;
});
