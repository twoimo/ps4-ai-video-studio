import { displayPipelineLabel, displayStageLabel, displayTitle, friendlyJobError, keepPaintedGrid, projectsFromListPayload } from "../../shorts-ui.mjs";
import { el, fmtAgo, getJSON, readStoredTheme, writeStoredTheme, subscribe, thumbURL } from "/backlot/ui/lib.js";

const grid = document.getElementById("grid");
const app = document.getElementById("app") || grid;
let currentTheme = readStoredTheme();

function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = currentTheme;
  writeStoredTheme(currentTheme);
}

function renderThemeToggle() {
  const next = currentTheme === "light" ? "dark" : "light";
  return el("button", {
    class: "theme-toggle",
    type: "button",
    title: `Switch to ${next} theme`,
    "aria-label": `Switch to ${next} theme`,
    "aria-pressed": currentTheme === "light" ? "true" : "false",
    onclick: () => {
      applyTheme(next);
      const replacement = renderThemeToggle();
      document.querySelector(".theme-toggle").replaceWith(replacement);
    },
  }, el("span", { class: "theme-toggle-icon", "aria-hidden": "true" }, currentTheme === "light" ? "☾" : "☀"));
}

function initLibrary() {
  if (!app) return;
  applyTheme(currentTheme);
  document.getElementById("liveBadge")?.before(renderThemeToggle());
  grid?.addEventListener("contextmenu", (event) => {
    const card = event.target?.closest?.(".lib-card");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    armClickSwallow(card);
  });
  grid?.addEventListener("click", (event) => {
    const card = event.target?.closest?.(".lib-card");
    if (!card?.dataset?.clickSwallow) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  render().catch(failLibrary);
  if (!new URLSearchParams(location.search).has("static")) {
    subscribe("/api/library/events", () => render().catch(failLibrary));
  }
}

const RAIL_LABELS = {
  script: "대본",
  "hook-lock": "첫 장면",
  "image-edit": "그림 고치기",
  animate: "움직이기",
  compose: "편집",
  scene_plan: "첫 장면",
  assets: "그림 고치기",
  edit: "편집"
};

function armClickSwallow(node) {
  if (!node) return;
  node.dataset.clickSwallow = "1";
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    node.removeEventListener("click", swallow, true);
    delete node.dataset.clickSwallow;
  };
  node.addEventListener("click", swallow, true);
}

function stageStatusKo(status) {
  const labels = {
    completed: "완료",
    in_progress: "진행",
    awaiting_human: "확인 필요",
    failed: "실패"
  };
  return labels[String(status || "")] || "단계";
}

function miniRail(states) {
  const rail = el("div", { class: "mini-rail" });
  for (const s of states) {
    const cls = s.status === "completed" ? "d"
      : s.status === "in_progress" ? "a"
      : s.status === "awaiting_human" ? "w" : "";
    const name = RAIL_LABELS[s.name] || displayStageLabel(s.name);
    const status = stageStatusKo(s.status);
    rail.append(el("i", { class: cls, title: `${name}: ${status}` }));
  }
  return rail;
}

function card(p) {
  const poster = el("div", { class: "lib-poster" });
  if (p.poster) {
    poster.append(el("img", { src: thumbURL(p.project_id, p.poster, 640), loading: "lazy", alt: "" }));
  } else {
    poster.append(el("span", { class: "lp-txt" }, "NO MEDIA YET"));
  }
  if (p.live && p.active_stage) {
    poster.append(el("span", { class: "lp-live" },
      el("span", { class: "dot" }),
      p.awaiting_human ? "◈ 확인 필요" : `진행 · ${displayStageLabel(p.active_stage)}`));
  } else if (p.awaiting_human) {
    poster.append(el("span", { class: "lp-live" }, "◈ 확인 필요"));
  }

  const meta = el("div", { class: "lb-meta" },
    p.pipeline_type && p.pipeline_type !== "style_playbook" ? el("span", { class: "chip" }, displayPipelineLabel(p.pipeline_type)) : null,
    p.scene_count ? el("span", { class: "chip" }, `${p.scene_count} scenes`) : null,
    p.render_count ? el("span", { class: "chip" }, `${p.render_count} renders`) : null,
    el("span", { class: "when" }, fmtAgo(p.last_activity)),
  );

  const staticSuffix = new URLSearchParams(location.search).has("static") ? "?static=1" : "";
  return el("a", { class: `lib-card${p.live ? " live-card" : ""}`, href: `/p/${p.project_id}${staticSuffix}`, style: "text-decoration:none;color:inherit" },
    poster,
    el("div", { class: "lib-body" },
      el("h3", {}, displayTitle(p.title, p.project_id, "보드")),
      meta,
      p.stage_states.length ? miniRail(p.stage_states) : null,
    ),
  );
}

function syncLibraryEmpty(hasProjects = false) {
  const empty = document.getElementById("empty");
  if (!empty) return;
  const busy = grid?.dataset?.busy === "1" || Boolean(grid?.querySelector(".is-skeleton"));
  const hide = busy || hasProjects;
  empty.hidden = hide;
  empty.style.display = hide ? "none" : "block";
}

async function render() {
  if (grid) grid.dataset.busy = "1";
  syncLibraryEmpty(true);
  const payload = await getJSON("/api/projects");
  if (!Array.isArray(payload?.projects) && !Array.isArray(payload)) {
    throw new Error("불러오지 못했습니다.");
  }
  const projects = projectsFromListPayload(payload);
  document.getElementById("count").textContent = `${projects.length} projects`;
  const liveCount = projects.filter((p) => p.live).length;
  const badge = document.getElementById("liveBadge");
  badge.classList.toggle("idle", liveCount === 0);
  document.getElementById("liveText").textContent = liveCount ? `${liveCount} 진행` : "대기";
  grid.innerHTML = "";
  if (grid) delete grid.dataset.busy;
  for (const p of projects) grid.append(card(p));
  syncLibraryEmpty(Boolean(projects.length));
}

function failLibrary(error) {
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");
  const grid = document.getElementById("grid");
  if (keepPaintedGrid(grid) && grid?.querySelector(".lib-card:not(.is-skeleton)")) return;
  if (count) count.textContent = "불러오지 못함";
  if (grid) {
    grid.innerHTML = "";
    delete grid.dataset.busy;
  }
  if (empty) {
    empty.hidden = false;
    empty.style.display = "block";
    empty.textContent = friendlyJobError(error);
  }
}

initLibrary();
