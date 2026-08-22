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

export function pinOverlayTop(node, open) {
  if (!node?.style) return;
  node.style.top = open ? "0px" : "";
}

export function pinOverlaysToVisualViewport(root = document) {
  root.querySelectorAll?.(".studio-overlay, #satellite-menu").forEach((node) => {
    const open = !node.hidden;
    pinNodeToVisualViewport(node, open);
    pinOverlayTop(node, open);
  });
}

export function scrollFocusedFieldIntoView(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") return;
  const panel = node.closest?.(".overlay-panel, .create-overlay-panel, .settings-overlay-panel, .machine-overlay-panel, .menu-overlay-panel, .short-detail-panel, .inspect-stack, .materials");
  if (panel) {
    const box = node.getBoundingClientRect();
    const frame = panel.getBoundingClientRect();
    if (box.bottom > frame.bottom) panel.scrollTop += Math.round(box.bottom - frame.bottom);
    else if (box.top < frame.top) panel.scrollTop += Math.round(box.top - frame.top);
  }
  const box = node.getBoundingClientRect();
  const vv = globalThis.visualViewport;
  const viewTop = vv ? vv.offsetTop || 0 : 0;
  const viewBottom = vv ? viewTop + vv.height : (globalThis.innerHeight || 0);
  const scroller = globalThis.document?.scrollingElement || globalThis.document?.documentElement;
  if (!scroller) return;
  if (box.bottom > viewBottom) scroller.scrollTop += Math.round(box.bottom - viewBottom);
  else if (box.top < viewTop) scroller.scrollTop += Math.round(box.top - viewTop);
}

export function scrollFocusIntoPanel(node) {
  scrollFocusedFieldIntoView(node);
}

export function hideExtraStudioChrome(root = document) {
  const extras = [...(root.querySelectorAll?.(".studio-chrome") || [])].slice(1);
  for (const node of extras) {
    node.hidden = true;
    node.setAttribute("hidden", "");
    node.setAttribute("aria-hidden", "true");
  }
}

export function bindFocusScroll(root = document) {
  if (!root || root.dataset?.focusScroll === "1") return;
  if (root.dataset) root.dataset.focusScroll = "1";
  root.addEventListener?.("focusin", (event) => {
    const target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")) return;
    scrollFocusedFieldIntoView(target);
  });
}

export function rescrollFocusedField(root = document) {
  const active = root.activeElement || globalThis.document?.activeElement;
  if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || "")) return;
  scrollFocusedFieldIntoView(active);
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

export function visualViewportKeyboardInset() {
  const vv = globalThis.visualViewport;
  if (!vv) return 0;
  const offset = vv.offsetTop || 0;
  const inner = globalThis.innerHeight || 0;
  const fromInner = Math.max(0, inner - vv.height - offset);
  if (fromInner > 0) return fromInner;
  const focused = globalThis.document?.activeElement;
  const editing = focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName || "");
  if (!editing) return 0;
  const outer = Math.max(globalThis.outerHeight || 0, globalThis.screen?.height || 0, inner);
  return Math.max(0, outer - vv.height - offset);
}

function syncVisualViewportInset() {
  const vv = globalThis.visualViewport;
  const height = vv?.height || globalThis.innerHeight || 0;
  const bottom = visualViewportKeyboardInset();
  const root = globalThis.document?.documentElement;
  root?.style?.setProperty("--vv-bottom", `${Math.round(bottom)}px`);
  root?.style?.setProperty("--vv-height", `${Math.round(height)}px`);
  root?.classList?.toggle("ime-open", bottom > 80);
  const body = globalThis.document?.body;
  if (body?.style) {
    if (bottom > 80) body.style.top = "0px";
    else body.style.removeProperty("top");
  }
  pinOverlaysToVisualViewport(globalThis.document);
  rescrollFocusedField(globalThis.document);
}

function satelliteHome(path = globalThis.location?.pathname || "") {
  if (/^\/(?:backlot\/)?p\//.test(path) || path.includes("/backlot/p/")) return "/backlot";
  if (path === "/backlot" || path === "/backlot/") return "/";
  if (path === "/template" || path.startsWith("/template/")) return "/";
  return "";
}

export function leaveSatelliteIfNeeded(event) {
  if (event?.state?.satellite !== "leave") return false;
  const home = event.state?.href || satelliteHome();
  if (!home) return false;
  globalThis.location.replace(home);
  return true;
}

export function armSatelliteHistory() {
  const home = satelliteHome();
  if (!home || globalThis.history?.state?.satellite) return;
  globalThis.history.replaceState({ satellite: "leave", href: home }, "", globalThis.location.href);
  globalThis.history.pushState({ satellite: "here" }, "", globalThis.location.href);
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.studioChrome === "auto") {
  hideExtraStudioChrome(document);
  bindStudioPipe(document);
  bindFocusScroll(document);
  void hydrateStudioChrome(document);
  syncVisualViewportInset();
  armSatelliteHistory();
  globalThis.addEventListener?.("popstate", leaveSatelliteIfNeeded);
  globalThis.visualViewport?.addEventListener("resize", syncVisualViewportInset);
  globalThis.visualViewport?.addEventListener("scroll", syncVisualViewportInset);
}
