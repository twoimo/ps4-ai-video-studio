import { machineSheetHtml, pipelineStages, renderMachineSheetHtml, renderStudioPipe } from "./studio-pipe.mjs";

export { machineSheetHtml, pipelineStages, renderMachineSheetHtml, renderStudioPipe };

export function defaultOpenMachine(event) {
  event?.preventDefault?.();
  if (typeof location === "undefined") return;
  if (location.pathname === "/" || location.pathname === "") {
    if (location.hash !== "#machine") location.hash = "machine";
    else window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.assign("/#machine");
}

export function bindStudioPipe(root = document, openMachine = defaultOpenMachine) {
  root.querySelectorAll?.("[data-open-machine]").forEach((button) => {
    button.addEventListener("click", openMachine);
  });
}

export function paintStudioPipe(root = document, health = {}, openMachine = defaultOpenMachine) {
  const chips = root.querySelector?.("#studio-chips");
  if (!chips) return;
  chips.hidden = false;
  chips.removeAttribute("hidden");
  chips.innerHTML = renderStudioPipe(health);
  bindStudioPipe(chips, openMachine);
}

export function paintMachineSheet(root = document, health = {}) {
  const sheet = root.querySelector?.("#machine-root");
  if (!sheet) return;
  sheet.innerHTML = renderMachineSheetHtml(health);
}

export async function hydrateStudioChrome(root = document, { fetchHealth, openMachine } = {}) {
  const opener = openMachine || defaultOpenMachine;
  let health = {};
  try {
    const request = fetchHealth || ((path) => fetch(path).then((response) => response.json()));
    health = await request("/api/health");
  } catch {
    health = {};
  }
  paintStudioPipe(root, health, opener);
  paintMachineSheet(root, health);
  return health;
}

if (typeof window !== "undefined" && !window.__studioOpenMachine) {
  window.__studioOpenMachine = true;
  window.addEventListener("studio-open-machine", defaultOpenMachine);
}

function syncVisualViewportInset() {
  const vv = globalThis.visualViewport;
  const innerHeight = globalThis.innerHeight || 0;
  const bottom = vv ? Math.max(0, innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
  globalThis.document?.documentElement?.style?.setProperty("--vv-bottom", `${Math.round(bottom)}px`);
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.studioChrome === "auto") {
  bindStudioPipe(document);
  void hydrateStudioChrome(document);
  syncVisualViewportInset();
  globalThis.visualViewport?.addEventListener("resize", syncVisualViewportInset);
  globalThis.visualViewport?.addEventListener("scroll", syncVisualViewportInset);
}
