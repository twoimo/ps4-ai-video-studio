import { friendlyJobError, importBroughtCopy, isAbortError, parseJsonText, rememberStudioCreateMode, throwMappedFetchError } from "./shorts-ui.mjs";
import { pinOverlaysToVisualViewport, syncOverlayLock } from "./studio-chrome.mjs";

function syncOverlayOpen(root = document) {
  const overlay = root.querySelector?.("#satellite-menu");
  const open = Boolean(overlay && !overlay.hidden);
  if (typeof document !== "undefined") document.body?.classList?.toggle("overlay-open", open);
  pinOverlaysToVisualViewport(root);
  syncOverlayLock(typeof document !== "undefined" ? document : root);
}

export function resetSatelliteMenu(root = document) {
  const title = root.querySelector?.("#satellite-menu-title");
  const actions = root.querySelector?.("#satellite-menu-actions");
  const result = root.querySelector?.("#satellite-import-result");
  if (title) title.textContent = "가져오기";
  if (actions) actions.hidden = false;
  if (result) result.hidden = true;
}

function showSatelliteImportResult(root, payload = {}) {
  const overlay = root.querySelector?.("#satellite-menu");
  const title = root.querySelector?.("#satellite-menu-title");
  const actions = root.querySelector?.("#satellite-menu-actions");
  const result = root.querySelector?.("#satellite-import-result");
  const summary = root.querySelector?.("#satellite-import-summary");
  if (title) title.textContent = "가져오기";
  if (summary) summary.textContent = importBroughtCopy(payload);
  if (actions) actions.hidden = true;
  if (result) result.hidden = false;
  if (overlay) overlay.hidden = false;
  syncOverlayOpen(root);
}

export async function importSatelliteLibrary(root = document, request = fetch) {
  rememberStudioCreateMode(sessionStorage, "single");
  resetSatelliteMenu(root);
  const overlay = root.querySelector?.("#satellite-menu");
  if (overlay) overlay.hidden = false;
  syncOverlayOpen(root);
  let response;
  try {
    response = await request("/api/library/import", { method: "POST" });
  } catch (error) {
    throwMappedFetchError(error);
  }
  let payload;
  try {
    payload = parseJsonText(await response.text());
  } catch (error) {
    throwMappedFetchError(error);
  }
  if (!response.ok) {
    const error = new Error(friendlyJobError(payload.error || "가져오지 못했습니다."));
    error.status = response.status;
    throw error;
  }
  resetSatelliteMenu(root);
  showSatelliteImportResult(root, payload);
  return payload;
}

export function bindSatelliteMenu(root = document, request = fetch) {
  if (!root || root.dataset?.satelliteMenu === "1") return;
  if (root.dataset) root.dataset.satelliteMenu = "1";
  const close = (event) => {
    event?.preventDefault?.();
    const overlay = root.querySelector?.("#satellite-menu");
    if (overlay) overlay.hidden = true;
    resetSatelliteMenu(root);
    syncOverlayOpen(root);
  };
  const backToMenu = (event) => {
    event?.preventDefault?.();
    resetSatelliteMenu(root);
  };
  root.querySelectorAll?.("[data-close-satellite]").forEach((node) => {
    node.addEventListener("click", (event) => {
      const result = root.querySelector?.("#satellite-import-result");
      if (result && !result.hidden) {
        backToMenu(event);
        return;
      }
      close(event);
    });
  });
  root.querySelector?.("#satellite-import-close")?.addEventListener("click", backToMenu);
  root.querySelector?.("#satellite-import-ok")?.addEventListener("click", close);
  const run = async (event) => {
    event?.preventDefault?.();
    try {
      await importSatelliteLibrary(root, request);
    } catch (error) {
      if (isAbortError(error)) return;
      const summary = root.querySelector?.("#satellite-import-summary");
      const overlay = root.querySelector?.("#satellite-menu");
      const actions = root.querySelector?.("#satellite-menu-actions");
      const result = root.querySelector?.("#satellite-import-result");
      if (overlay) overlay.hidden = false;
      syncOverlayOpen(root);
      if (actions) actions.hidden = true;
      if (result) result.hidden = false;
      if (summary) summary.textContent = friendlyJobError(error);
    }
  };
  root.querySelector?.("#satellite-import")?.addEventListener("click", run);
  root.querySelector?.("#satellite-import-run")?.addEventListener("click", run);
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.studioChrome === "auto") {
  bindSatelliteMenu(document);
}
