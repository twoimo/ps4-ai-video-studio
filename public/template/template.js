import { friendlyJobError, parseJsonText, throwMappedFetchError } from "../shorts-ui.mjs";
import { escapeSpecHtml, renderLockedSpec } from "../template-spec.mjs";

const APP_TITLE = "PS4_JUSTDOIT";

async function loadTemplatePage() {
  const raw = (location.hash || "").replace(/^#/, "");
  if (raw === "watch" || raw.startsWith("watch/")) {
    location.replace("/#" + (raw || "watch"));
    return;
  }
  const root = document.querySelector("#template-root");
  const title = document.querySelector("#template-title");
  if (!root) return;
  try {
    let response;
    try {
      response = await fetch("/api/grok-imagine/template");
    } catch (error) {
      throwMappedFetchError(error);
    }
    const spec = parseJsonText(await response.text());
    if (!response.ok) throw new Error(friendlyJobError(spec.error || "템플릿을 불러오지 못했습니다"));
    document.title = `템플릿 · ${APP_TITLE}`;
    if (title) {
      title.textContent = "잠긴 프롬프트";
      title.hidden = true;
    }
    root.innerHTML = renderLockedSpec(spec);
  } catch (error) {
    document.title = `템플릿 · ${APP_TITLE}`;
    if (title) title.textContent = "템플릿을 불러오지 못했습니다";
    root.innerHTML = `<div class="error-box"><b>템플릿을 불러오지 못했습니다</b><p>${escapeSpecHtml(friendlyJobError(error))}</p></div>`;
  }
}

void loadTemplatePage();
