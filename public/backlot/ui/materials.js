import { collectInspectPayload, fallbackCaptionPrompts, renderMaterialsPanel } from "/materials-editor.mjs";
import { friendlyJobError, isAbortError, parseJsonText, stripUiPaths, throwMappedFetchError } from "../../shorts-ui.mjs";
import { bindFocusScroll } from "/studio-chrome.mjs";
import { getJSON, projectIdFromPath } from "/backlot/ui/lib.js";

const projectId = projectIdFromPath(location.pathname);
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

function toast(text, kind = "") {
  status(text, kind);
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
  return friendlyJobError(error);
}

async function saveMaterials() {
  const body = collectInspectPayload(root);
  if (String(body.topic || "").trim().length < 4) {
    const error = new Error("영상 주제를 4자 이상 입력하세요.");
    error.status = 400;
    throw error;
  }
  let payload;
  try {
    payload = await fetch(`/api/jobs/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throwMappedFetchError(error);
  }
  let data;
  try {
    data = parseJsonText(await payload.text());
  } catch (error) {
    throwMappedFetchError(error);
  }
  if (!payload.ok) {
    const error = new Error(friendlyJobError(data.error || "초안을 저장하지 못했습니다."));
    error.status = payload.status;
    throw error;
  }
  return data;
}

function bindMaterials(frozen) {
  root.addEventListener("contextmenu", (event) => {
    if (!event.target?.closest?.(".inspect-files a, a[download]")) return;
    event.preventDefault();
    event.stopPropagation();
  });
  root.querySelector("[data-draft-topic], .inspect-topic")?.addEventListener("invalid", (event) => {
    event.preventDefault();
    toast("영상 주제를 4자 이상 입력하세요.", "error");
  });
  const save = async (event) => {
    event?.preventDefault?.();
    const topic = root.querySelector("[data-draft-topic], .inspect-topic");
    if (String(topic?.value || "").trim().length < 4) {
      toast("영상 주제를 4자 이상 입력하세요.", "error");
      return;
    }
    const button = root.querySelector("[data-inspect-save], .inspect-save");
    if (button) {
      button.disabled = true;
      button.textContent = "저장 중…";
    }
    try {
      await saveMaterials();
      status("초안을 저장했습니다.");
    } catch (error) {
      status(pausedActionError(error), "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "저장";
      }
    }
  };
  root.querySelector(".inspect-form")?.addEventListener("submit", save);
  root.querySelector("[data-inspect-save], .inspect-save")?.addEventListener("click", save);
  root.querySelector("[data-inspect-regen], .inspect-regen")?.addEventListener("click", async (event) => {
    const button = event?.currentTarget;
    if (button?.disabled || button?.inert || button?.hasAttribute?.("inert")) return;
    try {
      const health = await readJson("/api/health", {});
      if (health?.imagine?.frozen !== false) {
        status("지금은 그림을 안 만들어요.", "error");
        if (button) {
          button.inert = true;
          button.setAttribute("inert", "");
          button.classList.add("is-paused");
        }
        return;
      }
      if (button) button.disabled = true;
      await saveMaterials();
      let response;
      try {
        response = await fetch(`/api/jobs/${encodeURIComponent(projectId)}/run`, { method: "POST" });
      } catch (error) {
        throwMappedFetchError(error);
      }
      let data;
      try {
        data = parseJsonText(await response.text());
      } catch (error) {
        throwMappedFetchError(error);
      }
      if (!response.ok) {
        const error = new Error(friendlyJobError(data.error || "대기열에 넣지 못했습니다."));
        error.status = response.status;
        throw error;
      }
      status("대기열에 넣었습니다.");
    } catch (error) {
      if (button && !frozen) button.disabled = false;
      if (isAbortError(error)) return;
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
  bindFocusScroll(root);
}

mountMaterials().catch((error) => {
  if (!root) return;
  root.hidden = false;
  root.innerHTML = `<div class="inspect-stack"><div class="inspect-stack-head"><h2>재료</h2></div><p class="materials-status" data-kind="error">${stripUiPaths(friendlyJobError(error))}</p></div>`;
});
