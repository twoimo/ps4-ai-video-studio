import { displayPipelineLabel, displayStageLabel, displayTitle, friendlyJobError, projectsFromListPayload } from "../../shorts-ui.mjs";
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
    if (!event.target?.closest?.(".lib-card")) return;
    event.preventDefault();
    event.stopPropagation();
  });
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

const RAIL_STATUS = {
  completed: "완료",
  in_progress: "진행",
  awaiting_human: "확인 필요",
  failed: "실패"
};

function miniRail(states) {
  const rail = el("div", { class: "mini-rail" });
  for (const s of states) {
    const cls = s.status === "completed" ? "d"
      : s.status === "in_progress" ? "a"
      : s.status === "awaiting_human" ? "w" : "";
    const name = RAIL_LABELS[s.name] || displayStageLabel(s.name);
    const status = RAIL_STATUS[s.status] || s.status;
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
    el("span", { class: "chip" }, displayPipelineLabel(p.pipeline_type)),
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

async function render() {
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
  document.getElementById("empty").style.display = projects.length ? "none" : "block";
  for (const p of projects) grid.append(card(p));
}

function failLibrary(error) {
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");
  const grid = document.getElementById("grid");
  if (grid?.querySelector(".lib-card, .lib-skeleton")) return;
  if (count) count.textContent = "불러오지 못함";
  if (grid) grid.innerHTML = "";
  if (empty) {
    empty.style.display = "block";
    empty.textContent = friendlyJobError(error);
  }
}

initLibrary();
