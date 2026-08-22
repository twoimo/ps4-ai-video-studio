import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJob } from "../src/pipeline.mjs";
import { loadBoardState, listProjects, safeMediaPath, safeProjectDir, STUDIO_RAIL } from "../src/backlot-state.mjs";
import { backlotHealth, handleBacklotApi, handleBacklotMedia, handleBacklotPage } from "../src/backlot-server.mjs";
import { getLockedSpec } from "../src/grok-imagine-spec.mjs";
import { FACTORY_LOCKS, WORLD_SLOT_IDS } from "../src/grok-imagine-template.mjs";

async function api(path) {
  const url = new URL(`http://backlot.local${path}`);
  return handleBacklotApi(new Request(url), url);
}

test("Backlot health, projects, and state match the upstream board contract", async () => {
  assert.deepEqual(backlotHealth(), { ok: true, app: "backlot" });
  const job = await createJob({
    topic: "한강 갑문이 물을 나누는 이유",
    provider: "local",
    voiceover: false,
    captions: true,
    draftOnly: true,
    clipCount: 2
  });
  try {
    const projectsRes = await api("/api/projects");
    assert.equal(projectsRes.status, 200);
    const projects = await projectsRes.json();
    assert.ok(Array.isArray(projects));
    const card = projects.find((item) => item.project_id === job.id);
    assert.ok(card, "job is a Backlot project");
    assert.equal(card.title, job.topic);
    assert.equal(typeof card.has_pipeline_state, "boolean");
    assert.ok("stage_states" in card);
    assert.ok("render_count" in card);
    assert.ok("scene_count" in card);

    const stateRes = await api(`/api/project/${encodeURIComponent(job.id)}/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.project_id, job.id);
    assert.ok(state.pipeline?.pipeline_type);
    assert.ok(Array.isArray(state.stages));
    assert.deepEqual(state.stages.map((stage) => stage.name), STUDIO_RAIL.map((stage) => stage.name));
    assert.ok(state.stages.some((stage) => stage.name === "script"));
    assert.ok(state.stages.some((stage) => stage.name === "hook-lock"));
    assert.ok(state.stages.some((stage) => stage.name === "image-edit"));
    assert.ok(state.stages.some((stage) => stage.name === "animate"));
    assert.ok(state.stages.some((stage) => stage.name === "compose"));
    assert.ok(state.artifacts);
    assert.ok(state.media);
    assert.ok(Array.isArray(state.media.renders));
    assert.ok(Array.isArray(state.events));
    assert.ok("live" in state);
    assert.ok(state.artifacts.script?.title);

    const missing = await api("/api/project/not-a-real-project/state");
    assert.equal(missing.status, 404);
  } finally {
    await rm(join(process.cwd(), "workspace", "jobs", job.id), { recursive: true, force: true });
  }
});

test("Backlot UI mounts the real library and board, not a 400 overlay", async () => {
  const root = process.cwd();
  const library = await readFile(join(root, "public/backlot/index.html"), "utf8");
  const board = await readFile(join(root, "public/backlot/board.html"), "utf8");
  const boardJs = await readFile(join(root, "public/backlot/ui/board.js"), "utf8");
  const libraryJs = await readFile(join(root, "public/backlot/ui/library.js"), "utf8");
  const libJs = await readFile(join(root, "public/backlot/ui/lib.js"), "utf8");
  const css = await readFile(join(root, "public/backlot/ui/board.css"), "utf8");
  const home = await readFile(join(root, "public/index.html"), "utf8");
  const app = await readFile(join(root, "public/app.js"), "utf8");

  assert.match(library, /class="lib-grid" id="grid"/);
  assert.match(library, /id="liveBadge"/);
  assert.match(library, /class="wordmark">Backlot</);
  assert.match(board, /class="wrap" id="app"/);
  assert.doesNotMatch(board, /class="wrap work"/);
  assert.match(board, /id="materials"/);
  assert.match(board, /aria-label="재료"/);
  assert.doesNotMatch(board, /<aside[^>]*id="materials"[^>]*hidden/);
  assert.match(board, /id="materials"[^>]*>\s*<div class="lib-skeleton"/);
  assert.match(board, /src="\/backlot\/ui\/materials\.js"/);
  assert.ok(board.indexOf('class="wrap" id="app"') < board.indexOf('id="materials"'), "materials follows the original wrap");
  assert.match(board, /id="modal"/);
  assert.match(board, /id="player"/);
  assert.match(boardJs, /function renderSlate/);
  assert.match(boardJs, /function renderRail/);
  assert.match(boardJs, /function renderDrawer/);
  assert.match(boardJs, /function renderScriptCard/);
  assert.match(boardJs, /function renderApprovalReview/);
  assert.match(boardJs, /function renderDecisions/);
  assert.match(boardJs, /function renderActivity/);
  assert.match(boardJs, /function renderStoryboard/);
  assert.match(boardJs, /function renderRenders/);
  assert.match(boardJs, /function renderFoundMedia/);
  assert.match(boardJs, /function renderNoState/);
  assert.match(boardJs, /function renderAwaitingNotice/);
  assert.match(boardJs, /function renderReplayBar/);
  assert.match(boardJs, /subscribe\(`\/api\/project\/\$\{encodeURIComponent\(projectId\)\}\/events`/);
  assert.match(libraryJs, /subscribe\("\/api\/library\/events"/);
  assert.match(libJs, /export function subscribe/);
  assert.match(libJs, /export const STAGE_ICONS/);
  assert.match(css, /\.clapper/);
  assert.match(css, /\.slate/);
  assert.match(css, /\.rail/);
  assert.match(css, /\.filmstrip/);
  assert.match(css, /\.replay-bar/);
  assert.match(home, /id="open-board"[^>]*href="\/backlot"/);
  assert.match(home, /id="open-board-menu"[^>]*href="\/backlot"/);
  assert.equal(home.includes('id="backlot-overlay"'), false);
  assert.equal(app.includes('setView("backlot")'), false);
  assert.equal(app.includes("openBoard"), false);
  const specJs = await readFile(join(root, "public/template-spec.mjs"), "utf8");
  assert.match(specJs, /id="spec-corpus"/);
  assert.match(specJs, /id="spec-types"/);
  assert.match(specJs, /id="spec-skeleton"/);
  assert.match(specJs, /id="spec-locks"/);
  assert.match(specJs, /id="spec-situation"/);
  assert.match(specJs, /id="spec-loop"/);
  assert.equal(app.includes('setView("template")'), false);
  assert.equal(app.includes('id="template-overlay"'), false);
  assert.match(boardJs, /from "\/backlot\/ui\/lib\.js"/);
  assert.match(boardJs, /href: "\/"/);
  assert.match(libraryJs, /from "\/backlot\/ui\/lib\.js"/);
  assert.match(libraryJs, /href: `\/p\/\$\{p\.project_id\}/);
  assert.doesNotMatch(boardJs, /bindBacklotLeave|pauseBacklotMedia|studio-master|studio-return/);
  assert.doesNotMatch(libJs, /bindBacklotLeave|pauseBacklotMedia/);
  assert.doesNotMatch(library, /backlot-close|viewport-fit/);
  assert.match(library, /PS4_JUSTDOIT/);
  assert.match(library, /id="studio-chrome"/);
  assert.match(library, /id="studio-chips"/);
  assert.match(library, />대본</);
  assert.match(library, />그림</);
  assert.match(library, />움직임</);
  assert.match(library, />편집</);
  assert.match(library, />보드</);
  assert.match(library, />템플릿</);
  assert.match(library, /href="\/#create">새 쇼츠</);
  assert.match(library, /href="\/#settings">설정</);
  assert.equal(library.includes("aria-label=\"메뉴\""), false);
  assert.equal(library.includes("그림 · 멈춤"), false);
  assert.match(library, /src="\/studio-chrome\.mjs"/);
  assert.match(board, /id="studio-chrome"/);
  assert.match(board, /id="studio-chips"/);
  assert.match(board, /id="studio-chips"[\s\S]*data-open-machine[\s\S]*>대본</);
  assert.match(board, />대본</);
  assert.match(board, />보드</);
  assert.match(board, /href="\/#create">새 쇼츠</);
  assert.match(board, /href="\/#settings">설정</);
  assert.equal(board.includes("그림 · 멈춤"), false);
  assert.match(board, /src="\/studio-chrome\.mjs"/);
  assert.doesNotMatch(boardJs, /main\.append\(script\)/);
  assert.doesNotMatch(boardJs, /if \(script\) main\.append/);
  assert.match(css, /\.wrap\s*\{\s*max-width:\s*1440px/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.board\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /\.wrap\.work/);
  assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 360px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 720px\)/);
  assert.match(css, /Studio extra: materials after the original wrap/);
  assert.ok(css.indexOf(".wrap { max-width: 1440px") < css.indexOf("Studio extra: materials"), "materials CSS is appended after OM");
  assert.match(css, /Studio extra: full-width wrap/);
  assert.ok(css.indexOf("Studio extra: materials") < css.indexOf("Studio extra: full-width wrap"), "full-width override follows materials extra");
  assert.match(css, /\.wrap,\s*\.wrap#app,\s*\.materials\s*\{[^}]*max-width:\s*none/);
  assert.match(css, /body:has\(#studio-chrome\) \.slate \.wordmark/);
  assert.match(css, /body:has\(#studio-chrome\) \.wrap:not\(#app\) \.slate h1/);
  assert.match(css, /IBM Plex Sans KR/);
  assert.match(css, /#studio-chrome[\s\S]*font-family:\s*var\(--sans\)/);
  assert.equal(css.includes("family=Inter"), false);
  assert.match(css, /height:\s*min\(36vh,\s*320px\)/);
  assert.match(css, /aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(boardJs, /대본/);
  assert.match(boardJs, /첫 장면/);
  assert.match(boardJs, /그림 고치기/);
  assert.match(boardJs, /움직이기/);
  assert.match(boardJs, /완성 영상/);
  assert.match(boardJs, /가져온 클립/);
  assert.match(libJs, /방금/);
  assert.match(libJs, /분 전/);
  assert.match(libraryJs, /확인 필요/);
  assert.match(libraryJs, /진행/);
  assert.match(library, /id="satellite-import">가져오기</);
  assert.match(board, /id="satellite-import">가져오기</);
  assert.match(library, /src="\/satellite-menu\.mjs"/);
  assert.match(board, /src="\/satellite-menu\.mjs"/);
  const satellite = await readFile(join(root, "public/satellite-menu.mjs"), "utf8");
  assert.match(satellite, /export function resetSatelliteMenu/);
  assert.match(satellite, /\/api\/library\/import/);
  assert.match(satellite, /method: "POST"/);
  assert.match(satellite, /resetSatelliteMenu\(root\)/);
  assert.match(board, /class="lib-skeleton"/);
  assert.match(board, /id="materials"/);
  assert.doesNotMatch(css, /max-width:\s*440px/);
  assert.doesNotMatch(css, /max-width:\s*400px/);
  assert.doesNotMatch(board, /목록/);
  assert.doesNotMatch(board, /자세히/);
  assert.doesNotMatch(boardJs, /대본 → 그림 → 움직임 → 편집/);
  assert.doesNotMatch(boardJs, /function renderBeginner/);
  assert.doesNotMatch(css, /--bg:\s*#0b0d12/);
  assert.equal(library.includes("쇼츠 공장"), false);
  assert.equal(board.includes("쇼츠 공장"), false);
  assert.equal(boardJs.includes("쇼츠 공장"), false);
  assert.equal(home.includes("쇼츠 공장"), false);
  const materialsJs = await readFile(join(root, "public/backlot/ui/materials.js"), "utf8");
  const editor = await readFile(join(root, "public/materials-editor.mjs"), "utf8");
  assert.equal(materialsJs.includes("쇼츠 공장"), false);
  assert.equal(editor.includes("쇼츠 공장"), false);
  assert.match(materialsJs, /method: "PATCH"/);
  assert.match(materialsJs, /\/run/);

  const page = await handleBacklotPage(new Request("http://backlot.local/backlot"), new URL("http://backlot.local/backlot"));
  assert.ok(page);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="grid"/);
  assert.match(html, /class="lib-grid"/);
  assert.doesNotMatch(html, /id="backlot-overlay"/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /\/backlot\/backlot\//);

  const boardPage = await handleBacklotPage(new Request("http://backlot.local/backlot/p/demo"), new URL("http://backlot.local/backlot/p/demo"));
  const boardHtml = await boardPage.text();
  assert.match(boardHtml, /id="app"/);
  assert.match(boardHtml, /id="materials"/);
  assert.match(boardHtml, /src="\/backlot\/ui\/board\.js\?v=/);
  assert.match(boardHtml, /src="\/backlot\/ui\/materials\.js\?v=/);
  assert.doesNotMatch(boardHtml, /\/backlot\/backlot\//);
  assert.doesNotMatch(boardHtml, /id="backlot-overlay"/);
  assert.doesNotMatch(boardHtml, /role="dialog"/);
  assert.doesNotMatch(boardHtml, /id="watch-inspect"/);
  assert.doesNotMatch(boardHtml, /id="short-overlay"/);

  const alias = await handleBacklotPage(new Request("http://backlot.local/p/demo"), new URL("http://backlot.local/p/demo"));
  assert.match(await alias.text(), /id="app"/);

  for (const path of ["/backlot", "/p/demo", "/backlot/p/demo"]) {
    const head = await handleBacklotPage(new Request(`http://backlot.local${path}`, { method: "HEAD" }), new URL(`http://backlot.local${path}`));
    assert.ok(head);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  }
  assert.match(boardJs, /replace\(\/\\\/\+\$\/, ""\)/);
  assert.match(libraryJs, /불러오지 못함/);
});

test("OpenMontage-shaped projects and path escape stay defensive", async () => {
  const dir = join(process.cwd(), "workspace", "jobs", "om-shaped-board-fixture");
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "renders"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({
    title: "OM Fixture",
    pipeline_type: "openmontage",
    created_at: "2026-08-21T00:00:00Z"
  }));
  await writeFile(join(dir, "checkpoint_script.json"), JSON.stringify({
    status: "completed",
    timestamp: "2026-08-21T00:01:00Z",
    artifacts: { script: "artifacts/script.json" }
  }));
  await writeFile(join(dir, "artifacts/script.json"), JSON.stringify({
    title: "OM Fixture",
    total_duration_seconds: 20,
    sections: [{ id: "sc1", label: "Hook", text: "이렇게 설계된 겁니다.", start_seconds: 0, end_seconds: 10 }]
  }));
  await writeFile(join(dir, "artifacts/scene_plan.json"), JSON.stringify({
    scenes: [{ id: "sc1", type: "hook", description: "empty site", start_seconds: 0, end_seconds: 10 }]
  }));
  try {
    const state = await loadBoardState(dir);
    assert.equal(state.title, "OM Fixture");
    assert.equal(state.has_pipeline_state, true);
    assert.ok(state.stages.some((stage) => stage.name === "script" && stage.status === "completed"));
    assert.equal(state.artifacts.script.title, "OM Fixture");
    assert.equal(state.storyboard.scenes[0].id, "sc1");
    const listed = await listProjects();
    assert.ok(listed.some((item) => item.project_id === "om-shaped-board-fixture"));
    const projectDir = safeProjectDir("om-shaped-board-fixture");
    assert.throws(() => safeProjectDir("../etc"), { status: 400 });
    assert.throws(() => safeMediaPath(projectDir, "../secret.txt"), { status: 403 });
    const sneaky = new URL("http://backlot.local/media/om-shaped-board-fixture/nested.txt");
    sneaky.pathname = "/media/om-shaped-board-fixture/..%2Fsecret.txt";
    const escaped = await handleBacklotMedia(new Request(sneaky), sneaky);
    assert.ok(!escaped || [400, 403, 404].includes(escaped.status));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("template spec JSON still carries N=288, slots, locks, and live_action do-not-clone", () => {
  const spec = getLockedSpec();
  assert.equal(spec.tally.N, 288);
  assert.deepEqual(spec.slotIds, WORLD_SLOT_IDS);
  assert.ok(FACTORY_LOCKS.every((lock) => spec.locks.some((item) => item.id === lock.id && item.editable === false)));
  const live = spec.types.find((type) => type.id === "live_action");
  assert.equal(live.factory, "do-not-clone");
  assert.equal(JSON.stringify(spec).includes("쇼츠 공장"), false);
});
