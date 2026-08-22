import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  channelOneLiner,
  DEFAULT_CREATE_PROVIDER,
  formatClock,
  friendlyJobError,
  importBroughtCopy,
  jobsFromListPayload,
  parseJsonText,
  displayTitle,
  projectsFromListPayload,
  inspectVideoDownloads,
  isAbortError,
  isPlaceholderThumbnail,
  isWatchableShort,
  shortDurationSeconds,
  shortDownloads,
  shortPreview,
  shortStatus,
  shortStatusLabel,
  settingsSaveFailMessage,
  shortCardUnchanged,
  shortThumbnail,
  shortUploadPack,
  stripErrorPrefix,
  stripUiPaths,
  throwMappedFetchError
} from "../public/shorts-ui.mjs";
import { collectInspectPayload, fallbackCaptionPrompts, renderMaterialsPanel } from "../public/materials-editor.mjs";
import { machineSheetHtml, renderMachineSheetHtml, pipelineStages, PIPE_EDIT_MISSING, PIPE_PAUSED, PIPE_SCRIPT_MISSING } from "../public/studio-pipe.mjs";

const publicDir = join(process.cwd(), "public");

test("short cards map status, hook still, and duration", () => {
  assert.equal(DEFAULT_CREATE_PROVIDER, "grok-imagine");
  assert.equal(shortStatusLabel({ status: "queued", provider: "local" }), "초안");
  assert.equal(shortStatus({ status: "queued", provider: "grok-imagine" }).label, "생성중");
  assert.equal(shortStatus({ status: "queued", provider: "grok-imagine", queuePosition: 2 }).label, "대기 2번");
  assert.equal(shortStatus({ status: "running" }).label, "생성중");
  assert.equal(shortStatus({ status: "verifying" }).label, "생성중");
  assert.equal(shortStatus({ status: "completed" }).label, "완료");
  assert.equal(shortStatus({ status: "draft", duration: 50 }).label, "초안");
  assert.equal(shortStatus({ status: "failed" }).label, "실패·프리즈");
  assert.equal(shortStatus({ status: "completed", warnings: ["3번 클립을 고정했습니다"] }).label, "실패·프리즈");
  assert.equal(shortStatus({ status: "completed", clips: [{ frozen: true }] }).key, "frozen");
  const job = {
    duration: 70,
    artifacts: [
      { name: "factory/stills/01.png", kind: "hook-lock", url: "/hook.png" },
      { name: "chat.mp4", kind: "chat-video", url: "/chat.mp4" }
    ]
  };
  assert.equal(shortThumbnail(job), "/hook.png");
  assert.equal(shortDurationSeconds(job), 70);
  assert.equal(formatClock(70), "1:10");
  assert.deepEqual(shortPreview(job), { videoUrl: "/chat.mp4", poster: "/hook.png" });
  assert.equal(isWatchableShort(job), true);
  assert.equal(isWatchableShort({ status: "draft", topic: "초안" }), false);
  assert.equal(isWatchableShort({ status: "completed", artifacts: [{ name: "hook.png", kind: "hook-lock", url: "/hook.png" }] }), false);
  const playground = {
    slug: "playground-cistern",
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/seed-playground-cistern/artifacts/master.mp4" },
      { name: "chat.mp4", kind: "chat-video", url: "/api/jobs/seed-playground-cistern/artifacts/chat.mp4" }
    ]
  };
  const refuge = {
    slug: "refuge-floor",
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/seed-refuge-floor/artifacts/master.mp4" },
      { name: "final.mp4", kind: "video", url: "/api/jobs/seed-refuge-floor/artifacts/final.mp4" }
    ]
  };
  assert.equal(isWatchableShort(playground), true);
  assert.equal(isWatchableShort(refuge), true);
  assert.match(shortPreview(playground).videoUrl, /\/artifacts\/(master|chat|final)\.mp4$/);
  assert.match(shortPreview(refuge).videoUrl, /\/artifacts\/(master|chat|final)\.mp4$/);
  assert.equal(importBroughtCopy({ imported: ["a", "b"], seeded: ["b"] }), "가져왔어요 2편");
  assert.equal(importBroughtCopy({ count: 13 }), "가져왔어요 13편");
  assert.equal(importBroughtCopy({ error: "가져오지 못했습니다." }), "가져오지 못했습니다.");
  assert.equal(importBroughtCopy({ imported: ["a"], seeded: [], roots: ["/secret"], catalog: { episodes: [] } }), "가져왔어요 1편");
  assert.equal(stripUiPaths("실패 /workspace/jobs/demo/master.mp4"), "실패");
  assert.equal(stripUiPaths("404 /api/projects"), "404");
  assert.equal(friendlyJobError("ENOENT: no such file /opt/homebrew/bin/ffmpeg"), "파일을 찾지 못했습니다.");
  assert.equal(friendlyJobError("404 /api/jobs/x"), "찾지 못했습니다.");
  assert.equal(friendlyJobError("영상 주제를 4자 이상 입력하세요."), "영상 주제를 4자 이상 입력하세요.");
  assert.equal(friendlyJobError("ECONNREFUSED"), "요청에 실패했습니다.");
  assert.equal(stripErrorPrefix("Error: 연결하지 못했습니다."), "연결하지 못했습니다.");
  assert.equal(stripErrorPrefix("TypeError: Failed to fetch"), "Failed to fetch");
  assert.equal(friendlyJobError("Failed to fetch"), "연결하지 못했습니다.");
  assert.equal(friendlyJobError("Error: Failed to fetch"), "연결하지 못했습니다.");
  assert.equal(friendlyJobError("TypeError: Failed to fetch"), "연결하지 못했습니다.");
  assert.equal(friendlyJobError("unknown project: demo"), "작업을 찾지 못했습니다.");
  assert.equal(friendlyJobError("Error: unknown project: demo"), "작업을 찾지 못했습니다.");
  assert.equal(friendlyJobError(new TypeError("Cannot read properties of undefined (reading 'map')")), "지금은 처리할 수 없습니다.");
  assert.equal(friendlyJobError("TypeError: Cannot read properties of undefined (reading 'map')"), "지금은 처리할 수 없습니다.");
  assert.equal(friendlyJobError("Cannot read properties of undefined (reading 'map')"), "지금은 처리할 수 없습니다.");
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);
  assert.throws(() => throwMappedFetchError(abort), (error) => error === abort);
  assert.throws(() => throwMappedFetchError(new TypeError("Failed to fetch")), /연결하지 못했습니다/);
  assert.equal(settingsSaveFailMessage(abort), "");
  assert.deepEqual(jobsFromListPayload(undefined), []);
  assert.deepEqual(jobsFromListPayload({}), []);
  assert.deepEqual(jobsFromListPayload({ jobs: null }), []);
  assert.equal(jobsFromListPayload({ jobs: [{ id: "a" }] })[0].id, "a");
  assert.equal(jobsFromListPayload([{ id: "b" }])[0].id, "b");
  assert.deepEqual(projectsFromListPayload(undefined), []);
  assert.deepEqual(projectsFromListPayload({}), []);
  assert.deepEqual(projectsFromListPayload({ projects: null }), []);
  assert.equal(projectsFromListPayload({ projects: [{ project_id: "a" }] })[0].project_id, "a");
  assert.equal(projectsFromListPayload([{ project_id: "b" }])[0].project_id, "b");
  assert.deepEqual(parseJsonText('{"ok":true}'), { ok: true });
  assert.throws(() => parseJsonText(""), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("{"), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("not-json"), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("<!DOCTYPE html><html><body>x</body></html>"), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("<html><body>x</body></html>"), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("<!-- comment --><html>"), /불러오지 못했습니다/);
  assert.throws(() => parseJsonText("\uFEFF<!DOCTYPE html>"), /불러오지 못했습니다/);
  assert.equal(displayTitle(undefined), "");
  assert.equal(displayTitle("undefined"), "");
  assert.equal(displayTitle(null, "보드"), "보드");
  assert.equal(displayTitle("undefined", "보드"), "보드");
  assert.equal(displayTitle("한강 갑문", "보드"), "한강 갑문");
  assert.equal(displayTitle({ topic: "한강 갑문" }), "한강 갑문");
  assert.equal(displayTitle({ title: "보드 제목" }), "보드 제목");
  assert.equal(displayTitle({}), "");
  assert.equal(displayTitle("[object Object]", "보드"), "보드");
  assert.equal(displayTitle({ topic: { title: "중첩" } }), "중첩");
  assert.equal(shortCardUnchanged({ id: "a", status: "draft", topic: "abcd" }, { id: "a", status: "draft", topic: "abcd" }), true);
  assert.equal(shortCardUnchanged({ id: "a", status: "draft", topic: "abcd" }, { id: "a", status: "running", topic: "abcd" }), false);
  assert.equal(settingsSaveFailMessage("ECONNREFUSED"), "설정을 저장하지 못했습니다.");
  assert.equal(settingsSaveFailMessage("Failed to fetch"), "연결하지 못했습니다.");
  assert.equal(settingsSaveFailMessage(new TypeError("x is not a function")), "지금은 처리할 수 없습니다.");
  assert.equal(
    channelOneLiner({ facts: ["지붕은 평평해 보이지만 물은 안쪽으로 흐른다"] }, { titleFormula: "unused" }),
    "지붕은 평평해 보이지만 물은 안쪽으로 흐른다"
  );
  assert.equal(
    channelOneLiner({ status: "queued" }, { titleFormula: "[익숙한 대상] + [상식과 반대되는 사실]" }),
    "[익숙한 대상] + [상식과 반대되는 사실]"
  );
});

test("studio HTML is a shorts grid first with factory default create", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const chromeCss = await readFile(join(publicDir, "studio-chrome.css"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const pipe = await readFile(join(publicDir, "studio-pipe.mjs"), "utf8");
  const chrome = await readFile(join(publicDir, "studio-chrome.mjs"), "utf8");
  const home = html.slice(html.indexOf('id="shorts"'), html.indexOf('id="create-overlay"'));
  const shortsIndex = html.indexOf('id="shorts"');
  const gridIndex = html.indexOf('id="shorts-grid"');
  const createIndex = html.indexOf('id="create-overlay"');
  assert.ok(shortsIndex > 0 && gridIndex > shortsIndex);
  assert.ok(createIndex > gridIndex);
  assert.equal(html.includes('id="jobs-list"'), false);
  assert.match(html, /id="create-tile"/);
  assert.equal(html.includes("id=\"template-overlay\""), false);
  assert.equal(html.includes("id=\"short-overlay\""), false);
  assert.equal(html.includes("id=\"live-factory\""), false);
  assert.match(html, /id="import-library"/);
  assert.match(html, /id="open-template"[^>]*href="\/template"/);
  assert.match(html, /id="open-template-menu"[^>]*href="\/template"/);
  assert.match(html, /id="open-settings"/);
  assert.match(html, /대본 만들기/);
  assert.match(html, /id="settings-overlay"/);
  assert.equal(html.includes("id=\"close-short\""), false);
  assert.match(html, /목소리 미리 듣기/);
  assert.match(html, /id="voice-preview-audio" hidden>/);
  assert.match(html, /id="settings-preview-audio" hidden>/);
  assert.doesNotMatch(html, /id="voice-preview-audio"[^>]*controls/);
  assert.doesNotMatch(html, /id="settings-preview-audio"[^>]*controls/);
  assert.match(app, /removeAttribute\("controls"\)/);
  assert.equal(html.includes("완벽"), false);
  assert.match(html, /option value="grok-imagine" selected>Grok Imagine</);
  assert.equal(html.includes("Grok Imagine 공장"), false);
  assert.match(html, /<details class="advanced-create"/);
  assert.match(html, /<summary>고급<\/summary>/);
  const advanced = html.slice(html.indexOf('<details class="advanced-create"'), html.indexOf("</details>", html.indexOf('<details class="advanced-create"')));
  assert.match(advanced, /Grok Imagine으로 그림과 움직임을 만듭니다\./);
  assert.equal(/PATH|OAuth|Gemini|공장/.test(advanced), false);
  assert.match(app, /Grok Imagine으로 그림과 움직임을 만듭니다\./);
  assert.equal(/PATH의 grok|SuperGrok OAuth|Gemini로 대체/.test(app), false);
  assert.equal((home.match(/id="create-tile"/g) || []).length, 1);
  assert.match(home, /id="create-tile"[^>]*aria-label="새 쇼츠"/);
  assert.equal(home.includes("short-card-body"), false);
  assert.match(css, /aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(css, /\.library\s*\{[^}]*padding:\s*8px 0 0/);
  assert.match(chromeCss, /\.studio-chrome\s*\{[^}]*margin:\s*0 10px 8px/);
  assert.match(css, /html:has\(body\.overlay-open\),\s*body\.overlay-open\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /html:has\(body\.overlay-open\),\s*body\.overlay-open\s*\{[^}]*overscroll-behavior:\s*none/);
  assert.match(css, /html:has\(body\.overlay-open\),\s*body\.overlay-open\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /body\s*\{[^}]*overscroll-behavior:\s*none/);
  assert.match(chromeCss, /html:has\(body\.overlay-open\),\s*body\.overlay-open\s*\{[^}]*overflow:\s*hidden/);
  assert.match(chromeCss, /html:has\(body\.overlay-open\),\s*body\.overlay-open\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /@import url\('\.\/studio-chrome\.css'\)/);
  assert.match(css, /--rows:\s*1/);
  assert.match(css, /--chrome:\s*calc\(52px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(css, /--thumb-h:\s*calc\(\(var\(--vv-height,\s*100dvh\) - var\(--chrome\) - var\(--gap\)\) \/ var\(--rows\)\)/);
  assert.match(css, /--col:\s*calc\(var\(--thumb-h\) \* 9 \/ 16\)/);
  assert.equal(css.includes("round(up"), false);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*var\(--col\)\),\s*1fr\)\)/);
  assert.match(css, /grid-auto-rows:\s*auto/);
  assert.match(css, /\.shorts-grid\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*height:\s*auto/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*border-radius:\s*0/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*-webkit-touch-callout:\s*none/);
  assert.match(css, /#delete-overlay\s*\{[^}]*z-index:\s*24/);
  assert.match(css, /\.watch-feed\s*\{[^}]*container-type:\s*size/);
  assert.match(css, /100cqh/);
  assert.equal(/\.shorts-grid\s*\{[^}]*container-type/.test(css), false);
  assert.equal(css.includes("grid-template-rows: repeat(var(--n)"), false);
  assert.match(css, /minmax\(min\(100%,\s*var\(--col\)\)/);
  assert.match(html, /class="short-card short-skeleton"/);
  assert.equal((html.match(/class="short-card short-skeleton"/g) || []).length, 8);
  assert.match(app, /jobsLoaded/);
  assert.match(app, /from "\.\/studio-pipe\.mjs"/);
  assert.match(app, /from "\.\/studio-chrome\.mjs"/);
  assert.match(pipe, /export function pipelineStages/);
  assert.match(pipe, /export function renderMachineSheetHtml[\s\S]*pipelineStages\(health\)/);
  assert.match(pipe, /export function machineSheetHtml/);
  assert.match(chrome, /renderMachineSheetHtml\(health\)/);
  assert.match(pipe, /export function renderStudioPipe/);
  assert.match(chrome, /export function paintStudioPipe/);
  assert.match(chrome, /addEventListener\("studio-open-machine", defaultOpenMachine\)/);
  assert.match(chrome, /bindStudioPipe\(document\);\s*bindFocusScroll\(document\);\s*void hydrateStudioChrome\(document\);/);
  assert.match(chrome, /--vv-bottom/);
  assert.match(chrome, /visualViewport/);
  assert.match(chrome, /export function pinOverlaysToVisualViewport/);
  assert.match(chrome, /export function pinNodeToVisualViewport/);
  assert.match(chrome, /export function scrollFocusIntoPanel/);
  assert.match(chrome, /export function rescrollFocusedField/);
  assert.match(chrome, /overlayLockY/);
  assert.match(chrome, /export function restoreOverlayLockY/);
  assert.match(chrome, /behavior:\s*"instant"/);
  assert.match(chrome, /export function syncOverlayLock/);
  assert.match(chrome, /--vv-height/);
  assert.match(chrome, /node\.style\.left = `\$\{Math\.round\(vv\.offsetLeft \|\| 0\)\}px`/);
  assert.match(chrome, /node\.style\.width = `\$\{Math\.round\(vv\.width\)\}px`/);
  assert.match(chrome, /\.studio-overlay, #satellite-menu/);
  assert.match(chrome, /scrollTop/);
  assert.equal(chrome.includes("scrollIntoView"), false);
  assert.match(chromeCss, /\.studio-chrome\s*\{[^}]*display:\s*grid/);
  assert.equal(css.includes("short-card-body"), false);
  assert.match(app, /setView\("grid"\)/);
  assert.match(app, /import .*shortStatus.*from "\.\/shorts-ui\.mjs"/);
  assert.match(app, /const fallback = escapeHtml\(status\.label\)/);
  assert.equal(app.includes("(job.topic || \"쇼츠\").slice(0, 2)"), false);
  assert.equal(app.includes("short-card-body"), false);
  assert.match(app, /aria-label="새 쇼츠"/);
  assert.match(app, /aria-label="\$\{escapeHtml\(displayTitle\(job\.topic, "쇼츠"\)\)\}"/);
  assert.match(app, /function sizeShortsGrid/);
  assert.match(app, /grid\.clientWidth/);
  assert.match(app, /Math\.max\(shortLandscape \? 3 : 1,\s*Math\.ceil\(\(width \+ gap\) \/ \(col \+ gap\)\)\)/);
  assert.match(app, /function measureChrome/);
  assert.match(app, /getBoundingClientRect\(\)\.top/);
  assert.match(app, /setProperty\("--chrome"/);
  assert.match(app, /visualViewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /height - chrome - gap/);
  assert.match(app, /sizeShortsGrid\(\)/);
  assert.match(app, /addEventListener\("resize"/);
  assert.match(app, /sizeShortsGrid\(\)/);
  assert.equal(app.includes("syncShortsGridSize"), false);
  assert.equal(app.includes("shortsGridN"), false);
  assert.match(app, /function jobCardsMarkup\(\) \{\s*return state\.jobs\.map\(renderShortCard\)\.join\(""\)/);
  assert.equal(app.includes("function appendFeedPage"), false);
  assert.equal(app.includes("copies >= 12"), false);
  assert.match(app, /function bindFeedScroll/);
  assert.match(app, /<div class="feed-sentinel"><\/div>/);
  assert.match(app, /jobCardsMarkup\(\)/);
  assert.match(app, /scrollTo\(\{ top: 0/);
  assert.match(app, /new IntersectionObserver/);
  assert.match(app, /root:\s*grid/);
  assert.match(app, /rootMargin:\s*"600px"/);
  assert.match(app, /bindFeedScroll\(\)/);
  assert.match(app, /feedObserver\?\.disconnect/);
  assert.match(app, /thumb-stage/);
  assert.match(app, /function openMaterials/);
  assert.match(app, /\/backlot\/p\//);
  assert.match(app, /draftOnly:\s*true/);
  assert.equal(app.includes("autoStart"), false);
  assert.equal(app.includes("function connectBrowser"), false);
  assert.match(app, /function deleteJob/);
  assert.match(app, /method: "DELETE"/);
  assert.match(app, /contextmenu/);
  assert.match(app, /Math\.hypot\(dx, dy\) > 8/);
  assert.match(app, /pointermove/);
  assert.match(app, /pointercancel/);
  assert.match(app, /if \(fired \|\| moved\) return/);
  assert.match(app, /swallowClick = true/);
  assert.match(app, /Date\.now\(\) \+ 420/);
  assert.match(app, /if \(swallowClick \|\| Date\.now\(\) < swallowUntil\)/);
  assert.match(app, /closest\?\.\("\.short-card-detail"\)/);
  assert.match(app, /\.short-card-detail"\)\?\.addEventListener\("contextmenu"/);
  assert.match(app, /history\.pushState\(\{ deleteConfirm: 1 \}/);
  assert.match(app, /history\.pushState\(\{ studioView:/);
  assert.match(app, /history\.pushState\(\{ studioMenu: 1 \}/);
  assert.match(app, /prev === "grid" && next !== "grid"/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /closeDeleteConfirm\(\{ fromPop: true \}\)/);
  assert.match(app, /closeMenu\(null, \{ fromPop: true \}\)/);
  assert.match(app, /history\.back\(\)/);
  assert.match(app, /function askDeleteJob/);
  assert.match(app, /function closeDeleteConfirm/);
  assert.match(app, /askDeleteJob[\s\S]*syncOverlayLock/);
  assert.match(app, /closeDeleteConfirm[\s\S]*syncOverlayLock/);
  assert.match(app, /#studio-chips/);
  assert.match(app, /function renderChips/);
  assert.match(app, /function renderMachineSheet/);
  assert.match(app, /renderMachineSheetHtml\(state\.health/);
  assert.match(pipe, /export function pipelineStages/);
  assert.match(pipe, /stage\.ready \? "준비" : stage\.paused \? PIPE_PAUSED : stage\.title/);
  assert.equal(app.includes("대본 ${grok ? \"준비\" : \"없음\"}"), false);
  assert.match(pipe, /만드는 과정/);
  assert.match(pipe, /label: "대본"/);
  assert.match(pipe, /label: "그림"/);
  assert.match(pipe, /label: "움직임"/);
  assert.match(pipe, /label: "편집"/);
  assert.equal(app.includes("그림 · 멈춤"), false);
  assert.equal(app.includes("움직임 · 멈춤"), false);
  assert.equal(app.includes("크레딧 부족"), false);
  assert.equal(app.includes("크레딧 402"), false);
  assert.equal(app.includes(">grok</button>"), false);
  assert.equal(app.includes(">ffmpeg</button>"), false);
  assert.equal(app.includes("ffmpegPath"), false);
  assert.equal(app.includes("settings-ffmpeg"), false);
  assert.equal(html.includes("settings-ffmpeg"), false);
  assert.equal(html.includes("ffmpeg 경로"), false);
  assert.equal(html.includes("resource/songs"), false);
  assert.equal(html.includes("workspace/songs"), false);
  assert.match(css, /\.short-status\s*\{[^}]*z-index:\s*3/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound svg[\s\S]*?filter:\s*drop-shadow\(0 1px 6px rgba\(0,0,0,\.75\)\)/);
  assert.match(app, /names\.join\(" · "\)/);
  assert.equal(app.includes("곡 ${count}개"), false);
  assert.match(app, /function emptyGridNote/);
  assert.match(app, /id="grid-empty">쇼츠가 없습니다/);
  assert.match(app, /\$\{emptyGridNote\(\)\}/);
  assert.match(css, /\.shorts-grid \.empty-note\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(app, /importBroughtCopy\(payload\)/);
  assert.equal(app.includes("가져옴 ${imported}"), false);
  assert.equal(app.includes("시드 ${seeded}"), false);
  assert.equal(app.includes("경로 ${roots}"), false);
  assert.equal(app.includes("payload.roots"), false);
  assert.equal(app.includes("payload.catalog"), false);
  assert.equal(app.includes("window.confirm"), false);
  assert.match(app, /function askDeleteJob/);
  assert.match(html, /id="delete-overlay"/);
  assert.match(html, /id="delete-title">삭제할까요</);
  assert.equal(html.includes("window.confirm"), false);
  assert.equal(app.includes("빈 현장의 숨은 원리"), false);
  assert.match(app, /topic: topic\.trim\(\),/);
  assert.equal(app.includes(">402</button>"), false);
  assert.match(app, /#feed-banner/);
  assert.match(app, /health\?\.imagine\?\.frozen/);
  assert.equal(app.includes("Math.abs(dy) > 50"), false);
  assert.equal(app.includes("closeOpenWatchInspect"), false);
  assert.match(app, /pagehide/);
  assert.match(app, /aria-valuenow/);
  assert.match(app, /createWatchPlayer/);
  assert.equal(app.includes('class="watch-dl"'), false);
  assert.match(html, /id="studio-chips"/);
  assert.doesNotMatch(html, /id="studio-chips"[^>]*hidden/);
  assert.match(html, /class="studio-pipe"/);
  assert.match(html, />대본</);
  assert.match(html, />그림</);
  assert.match(html, />움직임</);
  assert.match(html, />편집</);
  assert.match(html, />대본<\/button>[\s\S]*studio-pipe-arrow[\s\S]*>그림<\/button>[\s\S]*studio-pipe-arrow[\s\S]*>움직임<\/button>[\s\S]*studio-pipe-arrow[\s\S]*>편집<\/button>/);
  assert.equal(html.includes("그림 · 멈춤"), false);
  assert.match(html, /id="feed-banner"/);
  assert.ok(html.indexOf('id="home-brand"') < html.indexOf('id="studio-chips"'));
  assert.ok(html.indexOf('id="studio-chips"') < html.indexOf('class="studio-chrome-actions"'));
  assert.ok(html.indexOf('id="studio-chips"') < html.indexOf('id="open-board"'));
  assert.match(html, /id="machine-overlay"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /class="studio-overlay feed-card" id="create-overlay"/);
  assert.match(html, /class="studio-overlay feed-card" id="settings-overlay"/);
  assert.equal(html.includes("id=\"template-overlay\""), false);
  assert.match(html, /id="settings-bgm-songs"/);
  assert.equal(html.includes("gemini-browser"), false);
  assert.equal(html.includes("browser-start"), false);
  assert.equal(html.includes("← 라이브러리"), false);
  assert.equal(html.includes("업로드는 나중에"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
  assert.match(app, /querySelectorAll\(`\.short-card\[data-job-id="\$\{CSS\.escape\(job\.id\)\}"\]`\)/);
  assert.equal((app.match(/function createTileMarkup/g) || []).length, 1);
  assert.match(css, /\.feed-sentinel\s*\{[^}]*height:\s*1px/);
  assert.match(css, /\.feed-sentinel\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.feed-sentinel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /\.thumb-fallback\s*\{[^}]*font-size:\s*13px/);
  assert.match(css, /\.thumb-fallback\s*\{[^}]*font-weight:\s*500/);
  assert.match(app, /status\.key === "draft" \? "—"/);
  assert.match(app, /ttsVoice/);
  assert.match(app, /create-tts-voice/);
  assert.match(css, /min-width:\s*44px/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /\.live-stages\s*\{/);
  assert.equal(css.includes("watch-inspect"), false);
  assert.equal(css.includes(".inspect-files"), false);
  const server = await readFile(join(process.cwd(), "src/server.mjs"), "utf8");
  const pipeline = await readFile(join(process.cwd(), "src/pipeline.mjs"), "utf8");
  assert.match(server, /PS4_IMAGINE_FROZEN !== "0"/);
  assert.match(server, /songs: await listBgmPublicNames\(\)/);
  assert.equal(server.includes("songs: await listBgmFiles()"), false);
  assert.match(server, /browser: \{ connected: Boolean\(browser\.connected\) \}/);
  assert.match(server, /ytDlp: \{ installed: Boolean\(ytDlp\.installed\) \}/);
  assert.match(server, /\.\.\.importPublicView\(result\)/);
  assert.equal(server.includes("...result,"), false);
  assert.match(server, /stripPublicPaths/);
  assert.match(server, /if \(next\.service === "ps4-ai-video-studio"\) return stripPublicPaths\(next\)/);
  assert.match(server, /"\.webm": "video\/webm"/);
  assert.match(server, /"\.mov": "video\/quicktime"/);
  assert.match(server, /"\.m4v": "video\/x-m4v"/);
  assert.match(server, /"\.mkv": "video\/x-matroska"/);
  assert.match(server, /"\.webp": "image\/webp"/);
  assert.match(server, /request\.method === "DELETE"/);
  assert.match(server, /FACTORY_QUEUE_PATH/);
  assert.match(pipeline, /export async function deleteJob/);
  assert.match(pipeline, /export async function saveJobDraft/);
  assert.match(pipeline, /factory-queue\.json/);
});

test("library and overlays fill the viewport instead of a phone column", async () => {
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  assert.match(css, /html,\s*body\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
  assert.match(css, /\.library\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.library\s*\{[^}]*height:\s*var\(--vv-height,\s*100dvh\)/);
  assert.match(css, /\.library\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.library\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.watch-feed\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.watch-feed\s*\{[^}]*inset:\s*0/);
  assert.match(css, /\.watch-feed\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.watch-feed\s*\{[^}]*height:\s*100%/);
  assert.equal(/\.watch-feed\s*\{[^}]*--watch-h:/.test(css), false);
  assert.equal(/\.watch-feed\s*\{[^}]*height:\s*100svh/.test(css), false);
  assert.match(css, /\.studio-overlay\s*\{[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/);
  assert.match(css, /\.studio-overlay\s*\{[^}]*padding:\s*env\(safe-area-inset-top\)\s+env\(safe-area-inset-right\)\s+env\(safe-area-inset-bottom\)\s+env\(safe-area-inset-left\)/);
  assert.match(css, /\.studio-overlay\s*\{[^}]*place-items:\s*center/);
  assert.match(css, /width:\s*min\(440px,\s*calc\(100% - 32px\)\)/);
  assert.match(css, /max-width:\s*min\(440px,\s*calc\(100% - 32px\)\)/);
  assert.doesNotMatch(css, /\.overlay-panel[\s\S]{0,220}100vw/);
  assert.match(css, /max-height:\s*min\(80dvh,\s*720px\)/);
  assert.match(css, /border-radius:\s*16px/);
  assert.match(css, /padding:\s*20px 18px 22px/);
  assert.match(css, /rgba\(0,\s*0,\s*0,\s*\.55\)/);
  assert.equal(css.includes("min(520px"), false);
  assert.equal(css.includes("min(20rem"), false);
  assert.equal(/\.create-panel[^{]*\{[^}]*100dvh/.test(css), false);
  assert.equal(/#facts[^{]*\{[^}]*36vh/.test(css), false);
  assert.equal(/\.library\s*\{[^}]*max-width:/.test(css), false);
  assert.match(css, /\.studio-overlay\.feed-card \.overlay-panel[\s\S]*height:\s*auto/);
  assert.match(css, /\.short-detail-panel \.preview-wrap\s*\{[^}]*width:\s*min\(100%,\s*10\.5rem\)/);
  assert.match(css, /\.short-detail-panel \.preview-wrap\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.equal(/\.short-detail-panel \.preview-wrap\s*\{[^}]*100dvh/.test(css), false);
  assert.match(css, /\.short-detail-panel \.detail-head[\s\S]*grid-column:\s*auto/);
  assert.match(css, /\.draft-close\s*\{[^}]*width:\s*44px/);
  assert.match(css, /\.draft-close\s*\{[^}]*height:\s*44px/);
  assert.match(css, /\.draft-close\s*\{[^}]*border-radius:\s*50%/);
  assert.match(css, /\.draft-facts\s*\{/);
  assert.match(css, /\.short-detail-layout\s*\{[^}]*display:\s*grid/);
  assert.equal(/\.short-detail-layout\s*\{[^}]*min-height:\s*calc\(100dvh/.test(css), false);
  assert.equal(/\.job-detail\s*\{[^}]*display:\s*contents/.test(css), false);
  assert.match(css, /\.create-panel\s*\{[^}]*max-width:\s*none/);
  assert.match(css, /\.create-panel\s*\{[^}]*margin:\s*0/);
});

test("home chrome drops dashboard dump and keeps a Shorts grid", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const chromeCss = await readFile(join(publicDir, "studio-chrome.css"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const homeEnd = html.indexOf('id="create-overlay"');
  const home = homeEnd > 0 ? html.slice(0, homeEnd) : html;
  assert.match(html, /<title>PS4_JUSTDOIT<\/title>/);
  assert.match(home, /id="shorts-grid"/);
  assert.match(home, /id="watch-feed"/);
  assert.match(home, /class="library-brand"/);
  assert.match(home, /<span class="brand-mark" aria-hidden="true">/);
  assert.match(home, /class="brand-mark"[\s\S]*viewBox="0 0 24 24"[\s\S]*width="24"[\s\S]*height="24"/);
  assert.match(home, /<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.2"/);
  assert.match(home, /class="brand-mark"[\s\S]*<h1>PS4_JUSTDOIT<\/h1>/);
  assert.match(home, /<h1>PS4_JUSTDOIT<\/h1>/);
  assert.equal(home.includes("library-brand-sub"), false);
  assert.equal(home.includes("건축사전"), false);
  assert.equal(home.includes("쇼츠 공장"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
  assert.equal(home.includes("<h1>쇼츠</h1>"), false);
  assert.equal(home.includes('class="sr-only">쇼츠'), false);
  assert.match(home, /id="library-more"/);
  assert.match(html, /id="menu-overlay"/);
  assert.match(html, /id="menu-title">메뉴</);
  assert.match(html, /id="close-menu"[^>]*aria-label="닫기"[^>]*>×</);
  assert.match(html, /id="machine-title">사양</);
  assert.equal(html.includes("id=\"machine-title\">머신<"), false);
  assert.equal(home.includes("더보기"), false);
  assert.match(home, /aria-label="메뉴"/);
  assert.equal(home.includes('aria-label="설정"'), false);
  assert.match(home, /class="library-gear"/);
  assert.match(home, /<svg class="library-gear"/);
  assert.match(home, /id="import-library">가져오기</);
  assert.match(home, /id="open-board"[^>]*href="\/backlot"/);
  assert.match(home, /id="open-template"[^>]*href="\/template"[^>]*>템플릿</);
  assert.match(html, /id="open-template-menu"[^>]*href="\/template"[^>]*>템플릿</);
  assert.match(home, /id="open-settings"[^>]*href="#settings"[^>]*>설정</);
  assert.match(home, /id="refresh-all">새로고침</);
  assert.equal(home.includes("이미 만든 편 가져오기"), false);
  assert.equal(home.includes("프롬프트 템플릿"), false);
  assert.equal(home.includes('id="toggle-surface"'), false);
  assert.equal(home.includes('id="toggle-watch"'), false);
  assert.equal(home.includes(">보기<"), false);
  assert.equal(home.includes("surface-toggle"), false);
  assert.match(home, /id="home-brand"/);
  assert.match(home, /href="#shorts"/);
  assert.equal(home.includes('class="watch-open"'), false);
  assert.match(html, /id="watch-feed" hidden/);
  assert.match(html, /id="shorts">/);
  assert.match(home, /id="create-tile"/);
  assert.match(chromeCss, /\.studio-chrome\s*\{[^}]*display:\s*grid/);
  assert.match(chromeCss, /\.studio-chrome\s*\{[^}]*grid-template-columns:\s*1fr 1fr max-content/);
  assert.match(chromeCss, /#satellite-menu \.overlay-panel[\s\S]*width:\s*min\(440px,\s*calc\(100% - 32px\)\)/);
  assert.doesNotMatch(chromeCss, /#satellite-menu \.overlay-panel[\s\S]{0,160}100vw/);
  assert.match(chromeCss, /\.studio-chips\s*\{[^}]*justify-self:\s*center/);
  assert.match(chromeCss, /\.studio-chrome-actions\s*\{[^}]*justify-self:\s*end/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*border:\s*0/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*border-radius:\s*0/);
  assert.match(chromeCss, /\.studio-chips\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(chromeCss, /\.studio-pipe\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*display:\s*inline/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*padding:\s*16px 4px/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*margin:\s*-16px 0/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*min-width:\s*0/);
  assert.match(chromeCss, /\.studio-chip\s*\{[^}]*min-height:\s*0/);
  assert.doesNotMatch(chromeCss, /\.studio-chip\s*\{[^}]*min-width:\s*44px/);
  assert.doesNotMatch(chromeCss, /\.studio-chip\s*\{[^}]*min-height:\s*44px/);
  assert.match(chromeCss, /\.studio-chip\.pause\s*\{[^}]*color:\s*var\(--dim/);
  assert.equal(/\.studio-chip\s*\{[^}]*border-radius:\s*999px/.test(chromeCss), false);
  assert.equal(/\.studio-chips\s*\{[^}]*flex:\s*1/.test(chromeCss), false);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*display:\s*grid/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*place-items:\s*center/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*width:\s*24px/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*height:\s*24px/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*flex:\s*0 0 24px/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*overflow:\s*hidden/);
  assert.match(chromeCss, /\.brand-mark\s*\{[^}]*color:\s*var\(--accent/);
  assert.equal(/\.brand-mark\s*\{[^}]*background:\s*var\(--accent\)/.test(chromeCss), false);
  assert.match(chromeCss, /\.library-brand h1\s*\{[^}]*overflow:\s*hidden/);
  assert.match(chromeCss, /\.library-brand h1\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(chromeCss, /\.library-brand h1\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(chromeCss, /@media \(max-width:\s*860px\)[\s\S]*#open-board[\s\S]*#open-template[\s\S]*display:\s*none/);
  assert.match(chromeCss, /@media \(max-width:\s*860px\)[\s\S]*\.studio-chrome\s*\{[^}]*grid-template-columns:\s*max-content 1fr max-content/);
  assert.match(chromeCss, /@media \(max-width:\s*860px\)[\s\S]*\.library-brand h1\s*\{[^}]*display:\s*none/);
  assert.match(chromeCss, /#satellite-menu\s*\{[^}]*padding:\s*env\(safe-area-inset-top\)\s+env\(safe-area-inset-right\)\s+env\(safe-area-inset-bottom\)\s+env\(safe-area-inset-left\)/);
  assert.equal(home.includes('width="13.6"'), false);
  assert.equal(home.includes('height="19.6"'), false);
  assert.match(app, /const APP_TITLE = "PS4_JUSTDOIT"/);
  assert.match(app, /document\.title = shortTitle \? `\$\{shortTitle\} · \$\{APP_TITLE\}` : APP_TITLE/);
  assert.match(app, /document\.title = APP_TITLE/);
  assert.equal(home.includes("class=\"sidebar\""), false);
  assert.equal(home.includes("WORKSPACE"), false);
  assert.equal(home.includes("id=\"health-capabilities\""), false);
  assert.equal(home.includes("LOCAL CAPABILITIES"), false);
  assert.equal(home.includes("Gemini Chrome"), false);
  assert.equal(home.includes("id=\"benchmark\""), false);
  assert.equal(home.includes("id=\"channel-dna\""), false);
  assert.equal(home.includes("품질 심사 위원회"), false);
  assert.equal(home.includes("AHP"), false);
  assert.equal(home.includes("가져온 편"), false);
  assert.equal(home.includes("workspace/imports"), false);
  assert.equal(html.includes("EDITORIAL INPUT"), false);
  assert.equal(html.includes("PIPELINE MONITOR"), false);
  assert.equal(html.includes("id=\"generation\""), false);
  assert.equal(html.includes('id="rendering"'), false);
  assert.equal(home.includes("id=\"health-capabilities\""), false);
});

test("watch feed pages 9:16 masters and leaves drafts on the grid", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const feed = await readFile(join(publicDir, "watch-feed.mjs"), "utf8");
  const watch = html.slice(html.indexOf('id="watch-feed"'), html.indexOf('id="shorts"'));
  assert.match(watch, /class="watch-column"/);
  assert.equal(watch.includes("watch-inspect"), false);
  assert.equal(watch.includes("inspect-dismiss"), false);
  assert.equal(watch.includes("inspect-open"), false);
  assert.equal(watch.includes("position:absolute; right:0"), false);
  assert.equal(html.includes("watch-scroller"), false);
  assert.match(html, /id="shorts-grid"/);
  assert.match(html, /id="watch-track"/);
  assert.match(watch, /aria-label="쇼츠 재생"/);
  assert.equal(watch.includes("내려받기"), false);
  assert.equal(watch.includes("다시 실행"), false);
  assert.equal(watch.includes('id="watch-player"'), false);
  assert.equal(css.includes("scroll-snap"), false);
  assert.equal(css.includes("-webkit-overflow-scrolling"), false);
  assert.equal(css.includes("backface-visibility"), false);
  assert.match(css, /\.watch-slide\s*\{[^}]*height:\s*100cqh/);
  assert.match(css, /\.watch-slide\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.watch-slide\s*\{[^}]*contain:\s*size layout/);
  assert.equal(/\.watch-slide\s*\{[^}]*isolation:\s*isolate/.test(css), false);
  assert.equal(/\.watch-slide\s*\{[^}]*height:\s*100dvh/.test(css), false);
  assert.match(css, /--watch-col:\s*min\(100%,\s*calc\(var\(--vv-height,\s*100dvh\) \* 9 \/ 16\)\)/);
  assert.match(css, /\.watch-stage\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.watch-stage\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.watch-slide\s*\{[^}]*max-width:\s*calc\(100cqh \* 9 \/ 16\)/);
  assert.match(css, /\.watch-player\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-player video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.watch-slide \.watch-poster\s*\{[^}]*object-fit:\s*cover/);
  assert.equal(css.includes(".watch-inspect"), false);
  assert.match(css, /body\.watch-open\s*\{[^}]*display:\s*block/);
  assert.match(css, /body\.watch-open \.studio-chrome\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.watch-back\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-back\s*\{[^}]*top:\s*12px/);
  assert.match(css, /\.watch-back\s*\{[^}]*left:\s*12px/);
  assert.match(css, /\.watch-back\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.watch-back\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.watch-back\s*\{[^}]*border-radius:\s*0/);
  assert.equal(/\.watch-back\s*\{[^}]*border-radius:\s*999px/.test(css), false);
  assert.equal(/\.watch-back\s*\{[^}]*background:\s*rgba/.test(css), false);
  assert.match(css, /@media \(max-width:\s*860px\)/);
  assert.match(css, /\.watch-player video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /body\.watch-open\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /body\.watch-open\s*\{[^}]*overscroll-behavior-y:\s*none/);
  assert.equal(css.includes("60dvh"), false);
  assert.equal(css.includes("40dvh"), false);
  assert.match(css, /\.watch-menu\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.watch-menu\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.watch-menu\s*\{[^}]*border-radius:\s*0/);
  assert.equal(/\.watch-menu\s*\{[^}]*border-radius:\s*50%/.test(css), false);
  assert.equal(/\.watch-menu\s*\{[^}]*background:\s*rgba/.test(css), false);
  assert.equal(/@media \(min-width:\s*861px\)[\s\S]*\.watch-menu[\s\S]*display:\s*none/.test(css), false);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*#watch-feed \.watch-column[\s\S]*max-width:\s*100%/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-menu[\s\S]*width:\s*44px/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-close[\s\S]*left:\s*max\(12px,\s*env\(safe-area-inset-left\)\)[\s\S]*right:\s*auto/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.watch-menu[\s\S]*right:\s*max\(12px,\s*env\(safe-area-inset-right\)\)/);
  assert.equal(css.includes("watch-inspect-dismiss"), false);
  assert.equal(css.includes("inspect-open"), false);
  assert.equal(css.includes(".watch-mute"), false);
  assert.equal(css.includes(".watch-actions"), false);
  assert.equal(css.includes(".watch-sheet"), false);
  const watchSlide = app.slice(app.indexOf("function watchSlideMarkup"), app.indexOf("function watchChromeMarkup"));
  assert.equal(watchSlide.includes("watch-dl"), false);
  assert.equal(watchSlide.includes("<video"), false);
  assert.match(app, /class="watch-close watch-back"/);
  assert.match(app, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(html, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(app, /function isWatchableShort|isWatchableShort\(job\)/);
  assert.match(app, /#watch\//);
  assert.match(app, /#shorts/);
  assert.match(app, /setView\("watch"/);
  assert.match(app, /setView\("grid"\)/);
  assert.equal(app.includes('setView("detail")'), false);
  assert.equal(app.includes("#short-overlay"), false);
  assert.equal(app.includes('trapOverlay("#short-overlay")'), false);
  assert.equal(app.includes('view === "detail"'), false);
  assert.equal(app.includes("state.view !== \"detail\""), false);
  assert.equal(app.includes("#job-detail"), false);
  assert.equal(app.includes("function patchDetailProgress"), false);
  assert.equal(app.includes("function renderLiveFactory"), false);
  assert.equal(/if \(view === "detail"\) return "#short"/.test(app), false);
  assert.match(app, /function hashForView[\s\S]*return "#shorts"/);
  assert.match(app, /if \(view === "machine"\) return "#machine"/);
  assert.match(app, /hash === "machine"/);
  assert.match(app, /hash === "machine" \|\| hash\.startsWith\("machine\/"\)/);
  assert.match(app, /hash === "machine"[\s\S]*setView\("machine"/);
  assert.match(app, /function resumeWatchIfVisible/);
  assert.match(app, /addEventListener\("pageshow", resumeWatchIfVisible\)/);
  assert.match(app, /addEventListener\("studio-open-machine", openMachine\)/);
  assert.match(app, /!hash \|\| hash === "shorts"/);
  assert.match(app, /hash === "watch" \|\| hash\.startsWith\("watch\/"\)/);
  assert.match(app, /const playable = watchableJobs\(\)/);
  assert.match(app, /requested\?\.id \|\| playable\[0\]\.id/);
  assert.match(app, /createSeq/);
  assert.match(app, /state\.view === "create"\) state\.createSeq \+= 1/);
  assert.match(app, /#batch-topics"\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /hash === "short"/);
  assert.match(app, /hash\.startsWith\("p\/"\) \|\| hash\.startsWith\("materials\/"\)/);
  assert.match(app, /\/backlot\/p\/\$\{encodeURIComponent\(jobId\)\}/);
  assert.match(app, /hash === "short"[\s\S]*openMaterials\(jobId\)/);
  assert.match(app, /function openMaterials/);
  const shortHash = app.slice(app.indexOf('if (hash === "short"'), app.indexOf('if (!hash || hash === "shorts")'));
  assert.match(shortHash, /openMaterials\(jobId\)/);
  assert.match(shortHash, /location\.replace\("\/backlot"\)/);
  assert.equal(shortHash.includes("state.selectedJobId"), false);
  assert.match(app, /location\.replace\("\/template"\)/);
  assert.equal(app.includes("preview-unavailable\">${escapeHtml(status.label)}"), false);
  assert.equal(app.includes("아직 영상이 없습니다"), false);
  assert.equal(app.includes('hash === "generation"'), false);
  assert.equal(app.includes('hash === "rendering"'), false);
  assert.match(app, /view: "grid"/);
  assert.equal(app.includes("toggle-surface"), false);
  assert.equal(app.includes("toggle-watch"), false);
  assert.equal(app.includes("syncSurfaceToggle"), false);
  assert.equal(app.includes("function toggleSurface"), false);
  assert.equal(app.includes("toggleWatchSurface"), false);
  assert.equal(app.includes('state.view === "watch" ? "라이브러리" : "보기"'), false);
  assert.match(app, /function openHome/);
  assert.match(app, /function openHome\(event\) \{\s*event\?\.preventDefault\(\);\s*stopWatchFeed\(\$\("#watch-feed"\)\);/);
  assert.match(app, /영상 주제를 4자 이상 입력하세요/);
  assert.match(app, /if \(isAbortError\(error\)\) return;\s*showImportResult\(\{ error:/);
  assert.doesNotMatch(app, /state\.jobs = \[\];\s*state\.jobsLoaded = true;\s*renderJobs\(\);/);
  assert.match(app, /\$\("#create-form"\)\?\.addEventListener\("submit"/);
  assert.match(app, /function fieldLines/);
  assert.match(app, /node\?\.value \?\? ""/);
  assert.match(app, /fieldLines\("#sources"\)/);
  assert.match(app, /fieldLines\("#facts"\)/);
  assert.match(app, /\$\("#provider"\)\?\.value/);
  assert.match(app, /function keepPaintedGrid/);
  assert.match(app, /throwMappedFetchError\(error\)/);
  assert.match(app, /if \(isAbortError\(error\)\) \{\s*keepPaintedGrid\(error\);\s*return;/);
  assert.match(app, /if \(isAbortError\(error\)\) \{\s*keepPaintedGrid\(error\);\s*return;\s*\}\s*enqueueToast\(error, "error"\)/);
  assert.match(app, /settingsWrite\?\.abort\(\)/);
  assert.match(app, /signal: controller.signal/);
  assert.match(app, /if \(isAbortError\(error\)\) return;\s*const text = settingsSaveFailMessage\(error\);\s*if \(!text\) return;\s*showToast\(text, "error"\)/);
  assert.match(app, /async function draftScriptFromTopic/);
  assert.match(app, /if \(isAbortError\(error\)\) return;\s*const text = friendlyJobError\(error\);/);
  assert.match(app, /if \(errorBox && text\) \{\s*errorBox\.hidden = false;/);
  assert.match(app, /\$\("#script-draft"\)\?\.value\?\.trim\(\)/);
  assert.match(app, /\$\("#topic"\)\?\.value\?\.trim\(\)/);
  assert.doesNotMatch(app, /\$\("#script-draft"\)\?\.value\.trim\(/);
  assert.doesNotMatch(app, /\$\("#topic"\)\?\.value\.trim\(/);
  assert.match(app, /new AbortController/);
  assert.equal(app.includes("error.message"), false);
  assert.equal(app.includes("$(\"#sources\").value"), false);
  assert.equal(app.includes("$(\"#provider\").value"), false);
  assert.match(app, /if \(state\.view === "watch"\) \{\s*stopWatchFeed\(\$\("#watch-feed"\)\);\s*openHome\(\);/);
  assert.match(app, /isWatchableShort\(job\)\) \{\s*setView\("watch"/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /ArrowUp/);
  assert.match(app, /stepWatchFeed\(feed, 1/);
  assert.match(app, /stepWatchFeed\(feed, -1/);
  assert.equal(app.includes("watch-scroller"), false);
  assert.equal(app.includes("afterWatchSnap"), false);
  assert.equal(app.includes("snapWatchFeed"), false);
  assert.equal(app.includes("function primeWatchVideo"), false);
  assert.equal(app.includes("}, 80);"), false);
  assert.equal(app.includes("}, 40);"), false);
  assert.equal(app.includes("toggleWatchMute"), false);
  assert.equal(app.includes("syncMuteButtons"), false);
  assert.equal(app.includes("watch-mute"), false);
  assert.equal(app.includes("watch-actions"), false);
  assert.equal(app.includes("watch-detail"), false);
  assert.equal(app.includes("watch-sheet"), false);
  assert.equal(app.includes("소리 켜기"), false);
  assert.equal(app.includes("소리 끔"), false);
  assert.equal(app.includes("소리 켬"), false);
  assert.equal(app.includes("음소거"), false);
  assert.match(app, /activateWatchSlide/);
  assert.match(app, /sizeWatchFeed/);
  assert.match(app, /wrapWatchFeed/);
  assert.match(app, /clearWatchSize/);
  assert.match(app, /sizeShortsGrid\(\)/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /orientationchange/);
  assert.match(app, /function notifyActive/);
  assert.match(app, /function mountWatchFeed/);
  assert.match(app, /data-loop="head"/);
  assert.match(app, /data-loop="tail"/);
  assert.match(app, /:not\(\[data-loop\]\)/);
  assert.match(app, /function watchFeedMarkup/);
  assert.match(app, /from "\.\/watch-feed\.mjs"/);
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view,\s*\(\) => mountWatchFeed/);
  assert.match(app, /bindWatchFeed\(root, openHome/);
  assert.match(app, /openMaterials\(jobId \|\| currentWatchSlide/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
  assert.match(app, /classList\.contains\("watch-open"\)[\s\S]*playWatchFeed/);
  assert.match(app, /classList\.contains\("watch-open"\)[\s\S]*stopWatchFeed/);
  assert.equal(app.includes("video.muted = true"), false);
  assert.equal(app.includes("muted = true"), false);
  assert.equal(watchSlide.includes(" muted"), false);
  assert.equal(app.includes("playsinline loop muted"), false);
  assert.match(feed, /pointerdown/);
  assert.match(feed, /pointerup/);
  assert.match(feed, /document\.createElement\("video"\)/);
  assert.match(feed, /activeSlide\.appendChild/);
  assert.match(app, /class="watch-menu watch-materials-toggle"/);
  assert.match(app, /class="watch-sound"/);
  assert.match(html, /class="watch-sound"[^>]*hidden/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound[\s\S]*?right:\s*0/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound[\s\S]*?left:\s*auto/);
  assert.match(css, /#watch-feed \.watch-column \.watch-sound svg[\s\S]*?filter:\s*drop-shadow\(0 1px 6px rgba\(0,0,0,\.75\)\)/);
  assert.match(app, /M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z/);
  assert.equal(html.includes("watch-inspect"), false);
  assert.equal(html.includes("inspect-dismiss"), false);
  assert.equal(app.includes("function toggleWatchInspect"), false);
  assert.equal(app.includes("closeOpenWatchInspect"), false);
  assert.equal(app.includes("closeWatchInspect"), false);
  assert.equal(app.includes("inspect-open"), false);
  assert.equal(app.includes("hydrateWatchInspect"), false);
  assert.equal(app.includes("function renderWatchInspectPanel"), false);
  assert.match(app, /function openMaterials/);
  assert.match(app, /function hideLeftoverOverlays/);
  assert.match(app, /hideLeftoverOverlays\(\);\s*state\.selectedJobId = jobId/);
  assert.match(app, /\/backlot\/p\//);
  assert.equal(app.includes("scrollIntoView"), false);
  assert.equal(app.includes('class="watch-materials"'), false);
  assert.equal(app.includes("letterbox"), false);
  assert.match(app, /class="watch-close watch-back"/);
  assert.match(app, /function openMaterials/);
  assert.match(app, /openJob/);
  assert.match(app, /function openDetail/);
  assert.match(app, /short-card-detail/);
  assert.match(css, /\.short-card-detail\s*\{[^}]*min-width:\s*44px/);
  assert.match(css, /\.short-card-detail\s*\{[^}]*min-height:\s*44px/);
  assert.match(app, />재료</);
  assert.equal(watchSlide.includes("watch-actions"), false);
  assert.equal(watchSlide.includes("watch-mute"), false);
  assert.equal(watchSlide.includes("watch-detail"), false);
  assert.equal(watchSlide.includes("상세"), false);
  assert.equal(watchSlide.includes("완벽"), false);
  assert.equal(app.includes("drawbox"), false);
  assert.equal(app.includes("drawtext"), false);
  assert.equal(/imagine/i.test(watchSlide), false);
});

test("completed short lists master chat parts and ASS downloads", () => {
  const artifacts = [
    { name: "master.mp4", kind: "master-video", url: "/api/jobs/a/artifacts/master.mp4" },
    { name: "chat.mp4", kind: "chat-video", url: "/api/jobs/a/artifacts/chat.mp4" },
    { name: "parts/part-01.mp4", kind: "part", url: "/api/jobs/a/artifacts/parts/part-01.mp4" },
    { name: "parts/part-02.mp4", kind: "part", url: "/api/jobs/a/artifacts/parts/part-02.mp4" },
    { name: "captions.ass", kind: "captions-ass", url: "/api/jobs/a/artifacts/captions.ass" }
  ];
  const downloads = shortDownloads({ artifacts });
  assert.deepEqual(downloads.map((item) => item.label), ["마스터", "채팅용", "파트 1", "파트 2", "자막 ASS"]);
  assert.ok(downloads.every((item) => item.href.includes("download=1")));
  assert.deepEqual(inspectVideoDownloads({ artifacts }).map((item) => item.label), ["마스터", "채팅용 1", "채팅용 2"]);
  assert.deepEqual(inspectVideoDownloads({
    artifacts: [
      { name: "master.mp4", url: "/api/jobs/a/artifacts/master.mp4" },
      { name: "chat.mp4", url: "/api/jobs/a/artifacts/chat.mp4" }
    ]
  }).map((item) => item.label), ["마스터", "채팅용"]);
  assert.deepEqual(inspectVideoDownloads({
    artifacts: [
      { name: "final.mp4", url: "/api/jobs/a/artifacts/final.mp4" },
      { name: "chat.mp4", url: "/api/jobs/a/artifacts/chat.mp4" }
    ]
  }).map((item) => item.label), ["최종", "채팅용"]);
  assert.deepEqual(inspectVideoDownloads({
    artifacts: [
      { name: "final.mp4", url: "/api/jobs/a/artifacts/final.mp4" },
      { name: "parts/part-01.mp4", kind: "part", url: "/api/jobs/a/artifacts/parts/part-01.mp4" }
    ]
  }).map((item) => item.label), ["최종", "채팅용 1"]);
});

test("watch inspector saves drafts and freezes regen", async () => {
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const pipe = await readFile(join(publicDir, "studio-pipe.mjs"), "utf8");
  const editor = await readFile(join(publicDir, "materials-editor.mjs"), "utf8");
  const materials = await readFile(join(publicDir, "backlot/ui/materials.js"), "utf8");
  const board = await readFile(join(publicDir, "backlot/board.html"), "utf8");
  const boardCss = await readFile(join(publicDir, "backlot/ui/board.css"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const server = await readFile(join(process.cwd(), "src/server.mjs"), "utf8");
  const pipeline = await readFile(join(process.cwd(), "src/pipeline.mjs"), "utf8");
  assert.equal(html.includes("watch-inspect"), false);
  assert.equal(html.includes("id=\"watch-inspect\""), false);
  assert.equal(html.includes("inspect-dismiss"), false);
  const menu = html.slice(html.indexOf('id="menu-actions"'), html.indexOf('id="menu-import-result"'));
  assert.match(menu, /id="open-board-menu"[^>]*href="\/backlot"/);
  assert.equal(menu.includes("재료"), false);
  assert.equal(menu.includes("watch-inspect"), false);
  assert.equal(app.includes("hydrateWatchInspect"), false);
  assert.equal(app.includes("function renderWatchInspectPanel"), false);
  assert.equal(app.includes("function toggleWatchInspect"), false);
  assert.match(app, /function openMaterials/);
  assert.match(app, /function hideLeftoverOverlays/);
  assert.match(app, /hideLeftoverOverlays\(\);\s*state\.selectedJobId = jobId/);
  assert.match(app, /location\.assign\(materialsUrl/);
  assert.match(app, /\/backlot\/p\//);
  assert.match(app, /stopWatchFeed\(\$\("#watch-feed"\)\)/);
  assert.match(app, /method: "PATCH"/);
  assert.match(editor, /export function renderMaterialsPanel/);
  assert.match(editor, /export function collectInspectPayload/);
  assert.match(editor, /inspectVideoDownloads\(job\)/);
  assert.match(editor, /import \{ displayTitle, inspectVideoDownloads \} from "\.\/shorts-ui\.mjs"/);
  assert.match(editor, /value="\$\{escapeMaterialsHtml\(displayTitle\(job\.topic\)\)\}"/);
  assert.match(editor, /shots\.length/);
  assert.match(editor, /class="inspect-files"/);
  assert.match(editor, /class="inspect-topic"/);
  assert.match(editor, /class="inspect-facts"/);
  assert.match(editor, /class="inspect-script"/);
  assert.match(editor, /class="inspect-shot-caption"/);
  assert.match(editor, /placeholder="자막"/);
  assert.match(editor, /class="inspect-shot-prompt"/);
  assert.match(editor, /class="inspect-shot-animate"/);
  assert.match(editor, /data-world-slot/);
  assert.match(editor, /class="inspect-stack"/);
  assert.match(editor, /class="inspect-caption"/);
  assert.match(editor, />제목</);
  assert.match(editor, />대본</);
  assert.match(editor, />자막</);
  assert.equal(editor.includes("자막 ASS"), false);
  assert.equal(editor.includes("captions.ass"), false);
  assert.match(editor, /class="primary-button inspect-save"[^>]*>저장</);
  assert.match(editor, /secondary-button inspect-regen/);
  assert.match(editor, /is-paused/);
  assert.match(editor, /data-inspect-regen\$\{frozen \? " inert" : ""\}/);
  assert.match(editor, /다시 만들기 · 멈춤/);
  assert.match(editor, /지금은 그림을 안 만들어요/);
  assert.match(editor, /export function fallbackCaptionPrompts/);
  assert.match(editor, /job\.lines/);
  assert.match(editor, /job\.captions/);
  assert.match(editor, /script\?\.lines/);
  assert.match(editor, /job\.scriptDraft/);
  assert.match(materials, /fallbackCaptionPrompts/);
  assert.match(materials, /pausedActionError/);
  assert.match(materials, /friendlyJobError/);
  assert.match(materials, /stripUiPaths/);
  assert.match(materials, /method: "PATCH"/);
  assert.match(materials, /friendlyJobError\(data\.error \|\| "초안을 저장하지 못했습니다\."\)/);
  assert.match(materials, /parseJsonText\(await payload\.text\(\)\)/);
  assert.match(materials, /throwMappedFetchError\(error\)/);
  assert.match(materials, /if \(isAbortError\(error\)\) return/);
  assert.match(editor, /root\?\.querySelectorAll\?\.\("\.inspect-shot/);
  assert.match(editor, /root\?\.querySelectorAll\?\.\("\.inspect-caption/);
  assert.match(editor, /node\.querySelector\?\./);
  assert.match(editor, /input\.closest\?\./);
  assert.match(editor, /root\?\.querySelector\?\.\("\[data-draft-topic\]/);
  assert.equal(materials.includes(".json().catch(() => ({}))"), false);
  assert.equal(materials.includes("Failed to fetch"), false);
  assert.match(materials, /String\(400 \+ 2\)/);
  assert.match(materials, /지금은 다시 못 만들어요/);
  assert.equal(materials.includes("402"), false);
  assert.match(pipe, /지금은 그림을 안 만들어요/);
  assert.match(pipe, /대본을 쓸 수 없습니다/);
  assert.match(pipe, /편집을 할 수 없습니다/);
  assert.match(app, /if \(state\.jobsLoaded\)/);
  assert.equal(app.includes("그림 · 멈춤"), false);
  assert.equal(/reasons\.push\("그림 · 멈춤"\)/.test(app), false);
  assert.equal(/if \(frozen\) reasons\.push/.test(app), false);
  assert.match(app, /renderMachineSheetHtml\(state\.health/);
  assert.match(pipe, /stage\.ready \? "준비" : stage\.paused \? PIPE_PAUSED : stage\.title/);
  assert.equal(pipe.includes("없음"), false);
  assert.equal(pipe.includes("지금은 다시 못 만들어요"), false);
  assert.equal(app.includes("그림 · 멈춤"), false);
  assert.equal(app.includes("움직임 · 멈춤"), false);
  assert.match(pipe, /paused: frozen/);
  assert.match(pipe, /if \(paused\) return " pause"/);
  assert.match(app, /function youtubePrepMarkup/);
  assert.equal(editor.includes("youtubePrepMarkup"), false);
  assert.equal(editor.includes("업로드 준비"), false);
  assert.equal(editor.includes("받은 파일"), false);
  assert.equal(editor.includes("그림 설명"), false);
  assert.equal(editor.includes("같은 장소 분위기"), false);
  assert.equal(editor.includes("이 영상은 이렇게 만들었어요"), false);
  assert.equal(editor.includes("watch-inspect-close"), false);
  assert.equal(app.includes("hook_photoreal"), false);
  assert.equal(editor.includes("hook_photoreal"), false);
  assert.match(board, /class="wrap" id="app"/);
  assert.doesNotMatch(board, /class="wrap work"/);
  assert.match(board, /id="materials"/);
  assert.match(board, /aria-label="재료"/);
  assert.match(board, /src="\/backlot\/ui\/materials\.js"/);
  assert.ok(board.indexOf('class="wrap" id="app"') < board.indexOf('id="materials"'), "materials follows the original wrap");
  assert.doesNotMatch(board, /id="app"[^>]*hidden/);
  assert.doesNotMatch(boardCss, /#app\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(boardCss, /\.wrap#app\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(boardCss, /body:has\([^\)]*materials[^\)]*\)[\s\S]{0,120}#app[\s\S]{0,80}display:\s*none/);
  assert.match(boardCss, /No materials-page hide/);
  assert.match(boardCss, /body:has\(#materials\) \.wrap#app/);
  assert.match(boardCss, /\.materials\s*\{[^}]*safe-area-inset-left/);
  assert.match(boardCss, /\.materials\s*\{[^}]*safe-area-inset-right/);
  assert.match(boardCss, /\.materials\s*\{[^}]*safe-area-inset-bottom/);
  assert.doesNotMatch(materials, /getElementById\("app"\)/);
  assert.doesNotMatch(materials, /#app/);
  assert.match(materials, /renderMaterialsPanel/);
  assert.match(materials, /collectInspectPayload/);
  assert.match(materials, /method: "PATCH"/);
  assert.match(materials, /\/run/);
  assert.equal(materials.includes("크레딧 부족"), false);
  assert.equal(materials.includes("크레딧 402"), false);
  assert.match(boardCss, /\.wrap\s*\{\s*max-width:\s*1440px/);
  assert.match(boardCss, /Studio extra: full-width wrap/);
  assert.match(boardCss, /\.wrap,\s*\.wrap#app,\s*\.materials\s*\{[^}]*max-width:\s*none/);
  assert.match(boardCss, /#studio-chrome/);
  assert.match(boardCss, /z-index:\s*100/);
  assert.match(boardCss, /Isolate shared chrome/);
  assert.match(boardCss, /isolation:\s*isolate/);
  assert.doesNotMatch(boardCss, /\.slate \.wordmark\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(boardCss, /\.clapper\s*\{[^}]*display:\s*none/);
  assert.match(boardCss, /\.slate \.wordmark\s*\{[^}]*display:\s*none/);
  assert.match(boardCss, /\.wrap:not\(#app\) \.lib-body h3\s*\{[^}]*text-transform:\s*none/);
  assert.match(boardCss, /body:has\(#studio-chrome\) \.wrap:not\(#app\) \.slate h1/);
  assert.match(boardCss, /Studio extra: slim board slate always, no OM wordmark\/clapper/);
  assert.match(boardCss, /\.wrap#app \.slate/);
  assert.match(boardCss, /Studio extra: slim library slate under chrome/);
  assert.match(boardCss, /body:has\(#studio-chrome\) \.wrap:not\(#app\) \.slate/);
  assert.match(app, /function emptyGridNote/);
  assert.match(app, /if \(state\.jobsLoaded\) \{\s*if \(!ffmpeg\)/);
  assert.match(app, /function overlayStartFocus/);
  assert.match(app, /root\.id === "create-overlay"/);
  assert.match(app, /createMode === "batch"/);
  assert.match(app, /querySelector\?\.\("#batch-topics"\)/);
  assert.match(app, /querySelector\?\.\("#topic"\)/);
  assert.match(app, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  assert.match(app, /if \(!coarse\)/);
  assert.match(app, /active && root\.contains\(active\)/);
  assert.match(app, /overlayFocusables\(root\)\.filter\(\(node\) => !node\.classList\?\.contains\("draft-close"\)\)/);
  assert.match(app, /\(items\[0\] \|\| overlayFocusables\(root\)\[0\]\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /id="create-overlay"[\s\S]*class="draft-close"[\s\S]*id="topic"/);
  assert.match(html, /id="close-create"[^>]*tabindex="-1"/);
  assert.match(html, /id="settings-overlay"[\s\S]*class="draft-close"[\s\S]*id="settings-tts-provider"/);
  assert.match(app, /if \(root\.id === "machine-overlay"\) \{[\s\S]*?querySelector\?\.\("\.overlay-panel"\)[\s\S]*?panel\.focus\(\{ preventScroll: true \}\);[\s\S]*?return;/);
  assert.match(html, /id="machine-overlay"[\s\S]*class="overlay-panel machine-overlay-panel"[^>]*tabindex="-1"/);
  assert.match(app, /hash\.startsWith\("p\/"\) \|\| hash\.startsWith\("materials\/"\)/);
  assert.match(app, /\/\^\(p\|materials\)/);
  assert.match(app, /\.replace\(\/\\\/\+\$\/, ""\)/);
  assert.match(app, /location\.replace\(`\/backlot\/p\/\$\{encodeURIComponent\(jobId\)\}`\)/);
  assert.match(app, /월드 슬롯을 불러오지 못했습니다/);
  assert.match(app, /hash === "batch"/);
  assert.match(app, /createMode === "batch" \? "#batch" : "#create"/);
  assert.match(app, /visualViewport/);
  assert.match(app, /--vv-bottom/);
  assert.match(app, /function pinWatchToVisualViewport/);
  assert.match(app, /pinOverlaysToVisualViewport/);
  assert.match(app, /rescrollFocusedField\(document\)/);
  assert.match(app, /syncOverlayLock/);
  assert.match(app, /--vv-height/);
  assert.match(app, /scrollFocusIntoPanel/);
  assert.match(app, /preventScroll:\s*true/);
  assert.match(app, /function sizeShortsGrid/);
  assert.match(app, /visualViewport\?\.height/);
  assert.equal(app.includes("event.submitter"), false);
  assert.match(app, /addEventListener\("submit", \(event\) => \{\s*if \(state\.createMode === "batch"\) \{\s*event\.preventDefault\(\);\s*void saveBatchDrafts\(\);/);
  assert.match(app, /String\(400 \+ 2\)/);
  assert.match(app, /지금은 다시 못 만들어요/);
  assert.equal(app.includes("402"), false);
  assert.match(app, /function refreshMachineHealth/);
  assert.match(app, /api\("\/api\/health"\)/);
  assert.match(app, /void refreshMachineHealth\(\)/);
  assert.match(app, /settingsSeq/);
  assert.match(app, /seq !== state\.settingsSeq/);
  assert.match(app, /function persistSettings/);
  assert.match(app, /addEventListener\("change", \(\) => \{ void persistSettings/);
  assert.match(app, /state\.view === "settings" && next !== "settings"\) void persistSettings/);
  assert.match(app, /await persistSettings\(\{ toast: true \}\)/);
  assert.match(app, /settingsSaveFailMessage\(error\)/);
  assert.match(app, /event\?\.target\?\.querySelector\?\.\("#create-submit"\)/);
  assert.match(html, /<form class="create-panel" id="create-form" novalidate onsubmit="return false">/);
  assert.match(html, /<form class="create-panel" id="settings-form" onsubmit="return false">/);
  assert.equal(/id="create-form"[^>]*(action=|method=)/i.test(html), false);
  assert.equal(/id="settings-form"[^>]*(action=|method=)/i.test(html), false);
  assert.match(html, /id="settings-bgm-songs"[^>]*>곡을 불러오는 중</);
  assert.equal(/id="settings-bgm-songs"[^>]*>곡 없음</.test(html), false);
  assert.match(html, /id="create-world-slots"[\s\S]*template-skeleton/);
  assert.match(app, /월드 슬롯을 불러오지 못했습니다/);
  assert.match(html, /hash === "create" \|\| hash === "batch"/);
  assert.ok(html.indexOf('hash === "create" || hash === "batch"') < html.indexOf('src="/app.js"'), "create/settings unhide before app.js");
  assert.ok(html.indexOf('setProperty("--chrome"') < html.indexOf('src="/app.js"'), "first-paint --chrome before app.js");
  assert.match(app, /leavingWatch/);
  assert.match(app, /preview-wrap video, \.shorts-grid video, audio/);
  assert.ok(html.indexOf('hash === "settings"') < html.indexOf('src="/app.js"'), "settings unhide before app.js");
  assert.ok(html.indexOf('hash === "machine"') < html.indexOf('src="/app.js"'), "machine unhide before app.js");
  const boot = html.slice(html.indexOf("hash === \"create\" || hash === \"batch\""), html.indexOf('src="/app.js"'));
  assert.match(boot, /hash === "machine" \|\| hash.indexOf\("machine\/"\) === 0/);
  assert.match(boot, /show\("machine-overlay"\)/);
  assert.match(boot, /if \(hash === "batch"\)/);
  assert.match(boot, /title\.textContent = "양산"/);
  assert.match(boot, /single\.hidden = true/);
  assert.match(boot, /batch\.hidden = false/);
  assert.match(boot, /submit\.hidden = true/);
  assert.match(boot, /actions\.hidden = false/);
  assert.match(html, /id="single-topic-field"/);
  assert.match(html, /id="batch-field" hidden/);
  assert.match(html, /id="batch-actions" hidden/);
  assert.match(css, /#batch-actions\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /#batch-actions\s*\{[^}]*bottom:\s*0/);
  assert.match(css, /--vv-bottom/);
  assert.match(css, /--vv-height:\s*100dvh/);
  assert.match(css, /\.toast\s*\{[^}]*max-width:\s*min\(360px,\s*calc\(100% - 32px\)\)/);
  assert.match(css, /\.toast\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /textarea\s*\{[^}]*max-height:\s*calc\(var\(--vv-height,\s*100dvh\) \* 0\.36\)/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*\.form-row\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(css, /#create-submit\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /input,\s*select\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.secondary-button\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /#watch-feed[\s\S]{0,180}bottom:\s*var\(--vv-bottom/);
  assert.doesNotMatch(css, /\.watch-slide-chrome[\s\S]{0,180}--vv-bottom/);
  assert.doesNotMatch(css, /\.watch-sound[\s\S]{0,180}--vv-bottom/);
  assert.doesNotMatch(css, /\.studio-overlay\s*\{[^}]*--vv-bottom/);
  assert.match(css, /input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /#delete-confirm\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /#delete-confirm\s*\{[^}]*min-width:\s*44px/);
  assert.match(boardCss, /\.materials\s*\{[^}]*var\(--vv-bottom/);
  assert.match(boardCss, /\.materials input,\s*\.materials textarea\s*\{[^}]*font-size:\s*16px/);
  assert.match(boardCss, /#studio-chrome[\s\S]*grid-template-columns:\s*1fr 1fr max-content/);
  assert.match(boardCss, /@media \(max-width:\s*860px\)[\s\S]*#studio-chrome\s*\{[^}]*grid-template-columns:\s*max-content 1fr max-content/);
  assert.match(boardCss, /@media \(max-width:\s*860px\)[\s\S]*#studio-chrome h1\s*\{[^}]*display:\s*none/);
  assert.match(editor, /<form class="inspect-form" novalidate onsubmit="return false">/);
  assert.match(editor, /type="submit"[^>]*data-inspect-save[^>]*>저장</);
  assert.match(boardCss, /\.materials \.inspect-actions\s*\{[^}]*position:\s*sticky/);
  assert.match(boardCss, /\.materials \.inspect-actions\s*\{[^}]*bottom:\s*0/);
  assert.match(materials, /inspect-form[\s\S]*addEventListener\("submit", save\)/);
  assert.match(app, /function bindEvents\(\) \{\s*bindStudioPipe\(document, openMachine\);/);
  assert.ok(app.indexOf("bindEvents();") < app.indexOf("void warnIfFactoryToolsMissing()"), "chips bind before health");
  assert.match(boardCss, /IBM Plex Sans KR/);
  assert.match(boardCss, /:root\s*\{[\s\S]*--sans:\s*'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif;/);
  assert.match(boardCss, /#studio-chrome[\s\S]*font-family:\s*var\(--sans\)/);
  assert.equal(boardCss.includes("Inter"), false);
  assert.equal(boardCss.includes("family=Inter"), false);
  const heroExtra = boardCss.slice(boardCss.lastIndexOf("Studio extra: compact 9:16 render-hero"));
  assert.match(heroExtra, /height:\s*min\(36vh,\s*320px\)/);
  assert.match(heroExtra, /aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(heroExtra, /width:\s*min\(100%,\s*calc\(min\(36vh,\s*320px\) \* 9 \/ 16\)\)/);
  assert.doesNotMatch(boardCss, /\.wrap\.work/);
  assert.doesNotMatch(boardCss, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 360px\)/);
  assert.doesNotMatch(boardCss, /@media \(max-width: 720px\)/);
  assert.doesNotMatch(boardCss, /max-width:\s*440px/);
  assert.doesNotMatch(boardCss, /max-width:\s*400px/);
  assert.match(boardCss, /\.materials \.inspect-frozen[\s\S]*color:\s*var\(--text-2\)/);
  assert.doesNotMatch(boardCss, /\.materials \.inspect-frozen[^{]*\{[^}]*var\(--red\)/);
  assert.match(boardCss, /\.materials \.inspect-regen\[inert\]/);
  assert.match(boardCss, /\.materials \.inspect-regen\.is-paused/);
  assert.match(boardCss, /pointer-events:\s*none/);
  assert.doesNotMatch(boardCss, /\.materials \.inspect-regen\.is-paused[^{]*\{[^}]*opacity:\s*\.48/);
  assert.match(boardCss, /\.materials \.inspect-stack\s*\{[^}]*gap/);
  assert.match(boardCss, /\.materials \.inspect-caption\s*\{[^}]*grid-template-columns:\s*1\.5rem/);
  assert.match(boardCss, /\.materials \.inspect-files\s*\{/);
  assert.match(app, /health\?\.imagine\?\.frozen !== false/);
  assert.equal(app.includes("class=\"watch-inspect-close\""), false);
  assert.equal(css.includes("watch-inspect"), false);
  assert.equal(css.includes("inspect-open"), false);
  assert.equal(css.includes("watch-inspect-dismiss"), false);
  assert.equal(css.includes("watch-inspect-close"), false);
  assert.equal(css.includes("translateX(100%)"), false);
  assert.equal(css.includes("40dvh"), false);
  assert.match(pipeline, /export async function saveJobDraft/);
  assert.match(pipeline, /buildGrokImagineScript/);
  assert.match(server, /request\.method === "PATCH"/);
  assert.match(server, /suffix === "draft"/);
  assert.equal(server.includes("크레딧 부족"), false);
  assert.equal(server.includes("크레딧 402"), false);
  assert.equal(app.includes("크레딧 부족"), false);
  assert.equal(app.includes("크레딧 402"), false);
  assert.equal(html.includes("크레딧 부족"), false);
  assert.equal(html.includes("크레딧 402"), false);
  const panel = renderMaterialsPanel({
    id: "job-1",
    topic: "한강 갑문",
    scriptDraft: "이렇게 설계된 겁니다.",
    facts: ["숨긴 사실"],
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/job-1/artifacts/master.mp4" },
      { name: "parts/part-01.mp4", kind: "part", url: "/api/jobs/job-1/artifacts/parts/part-01.mp4" },
      { name: "parts/part-02.mp4", kind: "part", url: "/api/jobs/job-1/artifacts/parts/part-02.mp4" }
    ]
  }, {
    shots: [{ index: 1, caption: "첫 줄", prompt: "hidden prompt", animatePrompt: "hidden move" }]
  }, { frozen: true });
  assert.match(panel, />제목</);
  assert.match(panel, /value="한강 갑문"/);
  assert.match(panel, />대본</);
  assert.match(panel, />자막</);
  assert.match(panel, /hidden class="inspect-facts"/);
  assert.match(panel, /hidden class="inspect-shot"/);
  assert.match(panel, /inspect-files/);
  assert.ok(panel.indexOf(">자막<") < panel.indexOf("inspect-files"), "downloads sit under captions");
  assert.match(panel, /마스터/);
  const noCaptions = renderMaterialsPanel({
    id: "job-2",
    topic: "한강 갑문",
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/job-2/artifacts/master.mp4" }
    ]
  }, { shots: [] });
  assert.equal(noCaptions.includes("inspect-files"), false);
  assert.equal(noCaptions.includes("마스터"), false);
  assert.match(panel, /채팅용/);
  assert.equal(panel.includes("자막 ASS"), false);
  assert.equal(panel.includes("watch-inspect-close"), false);
  assert.match(panel, /inert/);
  assert.doesNotMatch(panel, /data-inspect-regen[^>]*disabled/);
  assert.match(panel, /is-paused/);
  assert.match(panel, /다시 만들기 · 멈춤/);
  assert.match(panel, /title="지금은 그림을 안 만들어요"/);
  assert.match(panel, /지금은 그림을 안 만들어요/);
  const fakeRoot = {
    querySelectorAll(selector) {
      if (selector.includes("inspect-shot[data-shot-index]")) {
        return [{
          dataset: { shotIndex: "1" },
          querySelector(sel) {
            if (sel.includes("shot-prompt")) return { value: "hidden prompt" };
            if (sel.includes("shot-animate")) return { value: "hidden move" };
            return null;
          }
        }];
      }
      if (selector.includes("inspect-caption")) {
        return [{
          dataset: { shotIndex: "1" },
          closest() { return { dataset: { shotIndex: "1" } }; },
          value: "첫 줄"
        }];
      }
      if (selector.includes("data-world-slot")) return [];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("draft-topic") || selector.includes("inspect-topic")) return { value: "한강 갑문" };
      if (selector.includes("draft-facts") || selector.includes("inspect-facts")) return { value: "숨긴 사실" };
      if (selector.includes("draft-script") || selector.includes("inspect-script")) return { value: "이렇게 설계된 겁니다." };
      return null;
    }
  };
  assert.deepEqual(collectInspectPayload(null), {
    topic: "",
    facts: [],
    scriptDraft: "",
    worldSlots: {},
    shotOverrides: {}
  });
  assert.deepEqual(collectInspectPayload({}), {
    topic: "",
    facts: [],
    scriptDraft: "",
    worldSlots: {},
    shotOverrides: {}
  });
  assert.deepEqual(collectInspectPayload(fakeRoot), {
    topic: "한강 갑문",
    facts: ["숨긴 사실"],
    scriptDraft: "이렇게 설계된 겁니다.",
    worldSlots: {},
    shotOverrides: {
      1: { index: 1, prompt: "hidden prompt", animatePrompt: "hidden move", caption: "첫 줄" }
    }
  });
});

test("양산 batch and upload pack stay draft-only unless unfrozen", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  assert.match(app, /function showImportResult/);
  assert.match(app, /textContent = "가져오기"/);
  assert.match(html, /id="menu-import-ok">확인</);
  assert.match(html, /id="menu-batch"[^>]*href="#batch"[^>]*>양산</);
  assert.match(html, /id="batch-topics"/);
  assert.match(html, /id="batch-topics"[^>]*enterkeyhint="enter"/);
  assert.match(html, /id="batch-draft"[^>]*>[\s\S]*초안만 저장/);
  assert.match(html, /id="batch-queue"[^>]*>[\s\S]*대기열에 넣고 생성/);
  assert.equal(html.includes("id=\"batch-frozen\""), false);
  assert.equal(html.includes("크레딧 402"), false);
  assert.equal(html.includes("크레딧 부족"), false);
  assert.equal(app.includes("공장 시작"), false);
  assert.equal(app.includes("크레딧 부족"), false);
  assert.equal(app.includes("크레딧 402"), false);
  assert.match(app, /createMode = "batch"/);
  assert.match(app, /title\.textContent = batch \? "양산" : "새 쇼츠"/);
  assert.match(app, /provider: "grok-imagine"/);
  assert.match(app, /draftOnly: true/);
  assert.match(app, /function queueBatchJobs/);
  assert.match(app, /function parseBatchTopics/);
  assert.match(app, /leftover\.length/);
  assert.match(app, /line && line\.length < 4/);
  assert.match(app, /짧은 줄은 4자 이상 입력하세요/);
  assert.match(app, /function batchTopicsOrFocus/);
  assert.match(app, /friendlyJobError/);
  assert.match(app, /stripUiPaths/);
  assert.match(app, /stripErrorPrefix/);
  assert.match(app, /function enqueueToast/);
  assert.match(app, /if \(isAbortError\(message\)\) return/);
  assert.match(app, /enqueueToast\.current/);
  assert.match(app, /enqueueToast\(error, "error"\)/);
  assert.match(app, /parseJsonText\(text\)/);
  assert.match(app, /displayTitle\(/);
  assert.match(app, /parseJsonText\(event\.data\)/);
  const apiFn = app.slice(app.indexOf("async function api"), app.indexOf("function enqueueToast"));
  assert.match(apiFn, /throwMappedFetchError\(error\)/);
  assert.match(apiFn, /parseJsonText\(text\)/);
  assert.equal(apiFn.includes(".json().catch(() => ({}))"), false);
  assert.equal(app.includes(".json().catch(() => ({}))"), false);
  assert.match(app, /source\.onerror = \(\) => \{/);
  assert.doesNotMatch(app, /source\.onerror = \(\) => \{\s*source\.close\(\)/);
  assert.match(app, /function jobSseGone/);
  assert.match(app, /function endJobSseIfGone/);
  assert.match(app, /ENOENT/);
  assert.doesNotMatch(app, /addEventListener\("done", \(\) => \{\s*source\.close\(\)/);
  assert.match(app, /jobsFromListPayload\(payload\)/);
  assert.match(
    app,
    /if \(!Array\.isArray\(payload\?\.jobs\) && !Array\.isArray\(payload\)\) \{\s*throw new Error\("불러오지 못했습니다\."\);\s*\}/,
  );
  const initFn = app.slice(app.indexOf("async function init"), app.lastIndexOf("init();"));
  assert.match(initFn, /if \(isAbortError\(error\)\) return/);
  assert.match(initFn, /showToast\(error, "error"\)/);
  assert.equal(initFn.includes("state.jobs = []"), false);
  assert.equal(initFn.includes("renderJobs()"), false);
  assert.match(app, /shortCardUnchanged\(prev, job\)/);
  assert.equal(app.includes("payload.jobs.map"), false);
  assert.equal(app.includes("작업 상태 갱신 실패"), false);
  assert.equal(app.includes("Failed to fetch"), false);
  assert.equal(app.includes("요청 실패 (${response.status})"), false);
  assert.match(app, /\/run/);
  assert.match(app, /업로드 준비/);
  assert.match(app, /bindFocusTrap/);
  assert.match(app, /restoreOpener/);
  assert.equal(html.includes("gemini-browser"), false);
  assert.equal(html.includes("YouTube"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
  assert.equal(app.includes("muted = true"), false);
});

test("upload pack lists title description master parts and ASS", () => {
  const pack = shortUploadPack({
    topic: "놀이터 아래 물탱크",
    facts: ["지붕 면적 2만 m²"],
    scriptDraft: "이렇게 설계된 겁니다.",
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/a/artifacts/master.mp4" },
      { name: "parts/part-01.mp4", kind: "part", url: "/api/jobs/a/artifacts/parts/part-01.mp4" },
      { name: "captions.ass", kind: "captions-ass", url: "/api/jobs/a/artifacts/captions.ass" }
    ]
  });
  assert.equal(pack.title, "놀이터 아래 물탱크");
  assert.match(pack.description, /지붕 면적/);
  assert.match(pack.description, /이렇게 설계된 겁니다/);
  assert.deepEqual(pack.links.map((item) => item.label), ["마스터", "파트 1", "자막 ASS"]);
});

test("grid cards skip 1x1 placeholder png and use real jpg", () => {
  const job = {
    artifacts: [
      { name: "thumbnail.png", kind: "thumbnail", url: "/thumb.png", width: 1, height: 1, placeholder: true },
      { name: "thumbnail.jpg", kind: "thumbnail", url: "/thumb.jpg" }
    ]
  };
  assert.equal(isPlaceholderThumbnail(job.artifacts[0]), true);
  assert.equal(isPlaceholderThumbnail(job.artifacts[1]), false);
  assert.equal(shortThumbnail(job), "/thumb.jpg");
  assert.equal(shortPreview(job).poster, "/thumb.jpg");
  assert.equal(
    shortThumbnail({
      artifacts: [{ name: "thumbnail.png", kind: "thumbnail", url: "/thumb.png", width: 1, height: 1 }]
    }),
    ""
  );
});

test("materials fallback captions follow job.lines then captions then script then draft", () => {
  assert.deepEqual(fallbackCaptionPrompts({ lines: ["갑문", "물길"] }).shots.map((shot) => shot.caption), ["갑문", "물길"]);
  assert.deepEqual(fallbackCaptionPrompts({ captions: ["첫 자막", "둘째"] }).shots.map((shot) => shot.caption), ["첫 자막", "둘째"]);
  assert.deepEqual(fallbackCaptionPrompts({ captions: true, script: { lines: ["스크립트 줄"] } }).shots.map((shot) => shot.caption), ["스크립트 줄"]);
  assert.deepEqual(fallbackCaptionPrompts({ script: "대본 한 줄\n다음 줄" }).shots.map((shot) => shot.caption), ["대본 한 줄", "다음 줄"]);
  assert.deepEqual(fallbackCaptionPrompts({ scriptDraft: "초안 한 줄" }).shots.map((shot) => shot.caption), ["초안 한 줄"]);
  assert.deepEqual(fallbackCaptionPrompts({ captions: true, scriptDraft: "" }).shots, []);
  assert.deepEqual(fallbackCaptionPrompts({ lines: ["갑문", "", "물길"] }).shots.map((shot) => shot.caption), ["갑문", "", "물길"]);
});

test("machine sheet uses the same frozen and missing copy as chips", () => {
  const frozen = pipelineStages({ imagine: { frozen: true }, capabilities: {} });
  assert.deepEqual(frozen.map((stage) => stage.label), ["대본", "그림", "움직임", "편집"]);
  assert.equal(frozen[0].title, PIPE_SCRIPT_MISSING);
  assert.equal(frozen[1].title, PIPE_PAUSED);
  assert.equal(frozen[2].title, PIPE_PAUSED);
  assert.equal(frozen[3].title, PIPE_EDIT_MISSING);
  assert.equal(frozen[1].paused, true);
  const sheet = renderMachineSheetHtml({ imagine: { frozen: true }, capabilities: {} });
  assert.equal(sheet, machineSheetHtml({ imagine: { frozen: true }, capabilities: {} }));
  assert.match(sheet, /대본 대본을 쓸 수 없습니다/);
  assert.match(sheet, /그림 지금은 그림을 안 만들어요/);
  assert.match(sheet, /움직임 지금은 그림을 안 만들어요/);
  assert.match(sheet, /편집 편집을 할 수 없습니다/);
  assert.equal(sheet.includes("없음"), false);
  assert.equal(sheet.includes("Grok"), false);
  assert.equal(sheet.includes("Imagine"), false);
  assert.equal(sheet.includes("ffmpeg"), false);
  assert.equal(sheet.includes("CLI"), false);
  const ready = renderMachineSheetHtml({
    imagine: { frozen: false },
    capabilities: { grokCli: true, ffmpeg: true }
  });
  assert.match(ready, /대본 준비/);
  assert.match(ready, /그림 준비/);
  assert.match(ready, /움직임 준비/);
  assert.match(ready, /편집 준비/);
  assert.equal(ready.includes("Grok"), false);
  assert.equal(ready.includes("ffmpeg"), false);
});

test("public studio copy rejects leftover overlay, credit 402, tap-to-play, and wrap.work", async () => {
  const files = [
    await readFile(join(publicDir, "app.js"), "utf8"),
    await readFile(join(publicDir, "index.html"), "utf8"),
    await readFile(join(publicDir, "watch-feed.mjs"), "utf8"),
    await readFile(join(publicDir, "materials-editor.mjs"), "utf8"),
    await readFile(join(publicDir, "studio-pipe.mjs"), "utf8"),
    await readFile(join(publicDir, "studio-chrome.mjs"), "utf8"),
    await readFile(join(publicDir, "backlot/ui/materials.js"), "utf8"),
    await readFile(join(publicDir, "backlot/board.html"), "utf8"),
    await readFile(join(publicDir, "backlot/index.html"), "utf8"),
    await readFile(join(publicDir, "template/index.html"), "utf8"),
    await readFile(join(publicDir, "template/template.js"), "utf8")
  ];
  const boardCss = await readFile(join(publicDir, "backlot/ui/board.css"), "utf8");
  const app = files[0];
  for (const source of files) {
    assert.equal(source.includes("#short-overlay"), false);
    assert.equal(source.includes("크레딧 402"), false);
    assert.equal(source.includes("크레딧 부족"), false);
    assert.equal(source.includes("탭해서 재생"), false);
    assert.equal(source.includes("쇼츠 공장"), false);
    assert.equal(source.includes("class=\"wrap work\""), false);
    assert.equal(source.includes("Failed to fetch"), false);
    assert.equal(source.includes(".json().catch(() => ({}))"), false);
  }
  assert.doesNotMatch(boardCss, /\.wrap\.work/);
  assert.equal(files[3].includes("402"), false);
  assert.equal((await readFile(join(publicDir, "backlot/ui/materials.js"), "utf8")).includes("402"), false);
  assert.match(app, /location\.replace\("\/backlot"\)/);
  assert.match(app, /hash === "short"[\s\S]*openMaterials\(jobId\)/);
});
