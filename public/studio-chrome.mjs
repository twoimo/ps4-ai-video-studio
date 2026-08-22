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

export function pinNodeToVisualViewport(node, open) {
  if (!node?.style) return;
  const vv = globalThis.visualViewport;
  if (!open || !vv) {
    node.style.top = "";
    node.style.left = "";
    node.style.right = "";
    node.style.bottom = "";
    node.style.width = "";
    node.style.height = "";
    return;
  }
  node.style.left = `${Math.round(vv.offsetLeft || 0)}px`;
  node.style.width = `${Math.round(vv.width)}px`;
  node.style.right = "auto";
  node.style.top = `${Math.round(vv.offsetTop || 0)}px`;
  node.style.height = `${Math.round(vv.height)}px`;
  node.style.bottom = "auto";
}

export function pinOverlaysToVisualViewport(root = document) {
  root.querySelectorAll?.(".studio-overlay").forEach((node) => {
    pinNodeToVisualViewport(node, !node.hidden);
  });
}

export function scrollFocusIntoPanel(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") return;
  const panel = node.closest?.(".overlay-panel, .create-overlay-panel, .settings-overlay-panel, .machine-overlay-panel, .menu-overlay-panel, .short-detail-panel");
  const box = node.getBoundingClientRect();
  if (panel) {
    const frame = panel.getBoundingClientRect();
    if (box.bottom > frame.bottom) panel.scrollTop += Math.round(box.bottom - frame.bottom);
    else if (box.top < frame.top) panel.scrollTop += Math.round(box.top - frame.top);
    return;
  }
  const vv = globalThis.visualViewport;
  const viewTop = vv ? vv.offsetTop || 0 : 0;
  const viewBottom = vv ? viewTop + vv.height : (globalThis.innerHeight || 0);
  const scroller = globalThis.document?.scrollingElement || globalThis.document?.documentElement;
  if (!scroller) return;
  if (box.bottom > viewBottom) scroller.scrollTop += Math.round(box.bottom - viewBottom);
  else if (box.top < viewTop) scroller.scrollTop += Math.round(box.top - viewTop);
}

export function bindFocusScroll(root = document) {
  if (!root || root.dataset?.focusScroll === "1") return;
  if (root.dataset) root.dataset.focusScroll = "1";
  root.addEventListener?.("focusin", (event) => {
    const target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")) return;
    scrollFocusIntoPanel(target);
  });
}

export function rescrollFocusedField(root = document) {
  const active = root.activeElement || globalThis.document?.activeElement;
  if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || "")) return;
  scrollFocusIntoPanel(active);
}

let overlayLockY = 0;
let overlayLocked = false;

export function restoreOverlayLockY() {
  const y = overlayLockY;
  overlayLockY = 0;
  overlayLocked = false;
  if (typeof globalThis.scrollTo === "function") globalThis.scrollTo({ top: y, left: 0, behavior: "instant" });
}

export function syncOverlayLock(root = document) {
  const open = Boolean(root.body?.classList?.contains("overlay-open"));
  if (open) {
    if (overlayLocked) return;
    overlayLocked = true;
    overlayLockY = globalThis.scrollY || root.scrollingElement?.scrollTop || root.documentElement?.scrollTop || 0;
    return;
  }
  if (!overlayLocked) return;
  restoreOverlayLockY();
}

function syncVisualViewportInset() {
  const vv = globalThis.visualViewport;
  const innerHeight = globalThis.innerHeight || 0;
  const height = vv?.height || innerHeight;
  const bottom = vv ? Math.max(0, innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
  globalThis.document?.documentElement?.style?.setProperty("--vv-bottom", `${Math.round(bottom)}px`);
  globalThis.document?.documentElement?.style?.setProperty("--vv-height", `${Math.round(height)}px`);
  pinOverlaysToVisualViewport(globalThis.document);
  rescrollFocusedField(globalThis.document);
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.studioChrome === "auto") {
  bindStudioPipe(document);
  bindFocusScroll(document);
  void hydrateStudioChrome(document);
  syncVisualViewportInset();
  globalThis.visualViewport?.addEventListener("resize", syncVisualViewportInset);
  globalThis.visualViewport?.addEventListener("scroll", syncVisualViewportInset);
}
