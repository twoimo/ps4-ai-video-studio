function syncOverlayOpen(root = document) {
  const overlay = root.querySelector?.("#satellite-menu");
  const open = Boolean(overlay && !overlay.hidden);
  if (typeof document !== "undefined") document.body?.classList?.toggle("overlay-open", open);
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
  const imported = payload.imported?.length || 0;
  const seeded = payload.seeded?.length || 0;
  const roots = payload.roots?.length || 0;
  if (title) title.textContent = "가져오기";
  if (summary) summary.textContent = `가져옴 ${imported} · 시드 ${seeded} · 경로 ${roots}`;
  if (actions) actions.hidden = true;
  if (result) result.hidden = false;
  if (overlay) overlay.hidden = false;
  syncOverlayOpen(root);
}

export async function importSatelliteLibrary(root = document, request = fetch) {
  resetSatelliteMenu(root);
  const overlay = root.querySelector?.("#satellite-menu");
  if (overlay) overlay.hidden = false;
  syncOverlayOpen(root);
  const response = await request("/api/library/import", { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "가져오지 못했습니다.");
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
  root.querySelectorAll?.("[data-close-satellite]").forEach((node) => {
    node.addEventListener("click", close);
  });
  root.querySelector?.("#satellite-import-ok")?.addEventListener("click", close);
  const run = async (event) => {
    event?.preventDefault?.();
    try {
      await importSatelliteLibrary(root, request);
    } catch (error) {
      const summary = root.querySelector?.("#satellite-import-summary");
      const overlay = root.querySelector?.("#satellite-menu");
      const actions = root.querySelector?.("#satellite-menu-actions");
      const result = root.querySelector?.("#satellite-import-result");
      if (overlay) overlay.hidden = false;
      syncOverlayOpen(root);
      if (actions) actions.hidden = true;
      if (result) result.hidden = false;
      if (summary) summary.textContent = error.message || "가져오지 못했습니다.";
    }
  };
  root.querySelector?.("#satellite-import")?.addEventListener("click", run);
  root.querySelector?.("#satellite-import-run")?.addEventListener("click", run);
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.studioChrome === "auto") {
  bindSatelliteMenu(document);
}
