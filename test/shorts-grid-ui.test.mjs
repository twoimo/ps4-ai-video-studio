import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  channelOneLiner,
  DEFAULT_CREATE_PROVIDER,
  formatClock,
  isPlaceholderThumbnail,
  isWatchableShort,
  shortDurationSeconds,
  shortDownloads,
  shortPreview,
  shortStatus,
  shortStatusLabel,
  shortThumbnail,
  shortUploadPack
} from "../public/shorts-ui.mjs";

const publicDir = join(process.cwd(), "public");

test("short cards map status, hook still, and duration", () => {
  assert.equal(DEFAULT_CREATE_PROVIDER, "grok-imagine");
  assert.equal(shortStatusLabel({ status: "queued", provider: "local" }), "초안");
  assert.equal(shortStatus({ status: "queued", provider: "grok-imagine" }).label, "생성중");
  assert.equal(shortStatus({ status: "queued", provider: "grok-imagine", queuePosition: 2 }).label, "대기 2");
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
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const home = html.slice(html.indexOf('id="shorts"'), html.indexOf('id="create-overlay"'));
  const shortsIndex = html.indexOf('id="shorts"');
  const gridIndex = html.indexOf('id="shorts-grid"');
  const createIndex = html.indexOf('id="create-overlay"');
  assert.ok(shortsIndex > 0 && gridIndex > shortsIndex);
  assert.ok(createIndex > gridIndex);
  assert.equal(html.includes('id="jobs-list"'), false);
  assert.match(html, /id="create-tile"/);
  assert.match(html, /id="template-overlay"/);
  assert.match(html, /id="live-factory"/);
  assert.match(html, /id="import-library"/);
  assert.match(html, /id="open-template"/);
  assert.match(html, /id="open-settings"/);
  assert.match(html, /대본 만들기/);
  assert.match(html, /id="settings-overlay"/);
  assert.match(html, /class="studio-overlay feed-card" id="short-overlay"/);
  assert.match(html, /class="draft-close"[^>]*id="close-short"[^>]*aria-label="닫기"/);
  assert.match(html, /id="close-short"[^>]*>×</);
  const shortOverlay = html.slice(html.indexOf('id="short-overlay"'), html.indexOf('id="toast"'));
  assert.equal(shortOverlay.includes("overlay-chrome"), false);
  assert.equal(shortOverlay.includes("← 라이브러리"), false);
  assert.match(html, /목소리 미리 듣기/);
  assert.equal(html.includes("완벽"), false);
  assert.match(html, /option value="grok-imagine" selected/);
  assert.match(html, /<details class="advanced-create"/);
  assert.match(html, /<summary>고급<\/summary>/);
  assert.equal((home.match(/id="create-tile"/g) || []).length, 1);
  assert.match(home, /id="create-tile"[^>]*aria-label="새 쇼츠"/);
  assert.equal(home.includes("short-card-body"), false);
  assert.match(css, /aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(css, /\.library\s*\{[^}]*padding:\s*8px 0 0/);
  assert.match(css, /\.studio-chrome\s*\{[^}]*margin:\s*0 10px 8px/);
  assert.match(css, /--rows:\s*1/);
  assert.match(css, /--thumb-h:\s*calc\(\(100dvh - var\(--chrome\) - var\(--gap\)\) \/ var\(--rows\)\)/);
  assert.match(css, /--col:\s*calc\(var\(--thumb-h\) \* 9 \/ 16\)/);
  assert.match(css, /--n:\s*4/);
  assert.equal(css.includes("round(up"), false);
  assert.match(css, /grid-template-columns:\s*repeat\(var\(--n\),\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /grid-auto-rows:\s*auto/);
  assert.match(css, /\.shorts-grid\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*height:\s*auto/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*border-radius:\s*0/);
  assert.match(css, /\.short-card-thumb\s*\{[^}]*border:\s*0/);
  assert.equal(css.includes("container-type: size"), false);
  assert.equal(css.includes("100cqh"), false);
  assert.equal(css.includes("grid-template-rows: repeat(var(--n)"), false);
  assert.equal(/repeat\(auto-fill,\s*minmax\(min\(100%,\s*var\(--col\)\),\s*1fr\)\)/.test(css), false);
  assert.equal(css.includes("short-card-body"), false);
  assert.match(app, /setView\("grid"\)/);
  assert.match(app, /import .*shortStatus.*from "\.\/shorts-ui\.mjs"/);
  assert.match(app, /const fallback = escapeHtml\(status\.label\)/);
  assert.equal(app.includes("(job.topic || \"쇼츠\").slice(0, 2)"), false);
  assert.equal(app.includes("short-card-body"), false);
  assert.match(app, /aria-label="새 쇼츠"/);
  assert.match(app, /aria-label="\$\{escapeHtml\(job\.topic \|\| "쇼츠"\)\}"/);
  assert.match(app, /function sizeShortsGrid/);
  assert.match(app, /grid\.clientWidth/);
  assert.match(app, /Math\.max\(shortLandscape \? 3 : 1,\s*Math\.ceil\(\(width \+ gap\) \/ \(col \+ gap\)\)\)/);
  assert.match(app, /innerHeight - 52 - gap/);
  assert.match(app, /sizeShortsGrid\(\)/);
  assert.match(app, /addEventListener\("resize", sizeShortsGrid\)/);
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
  assert.match(app, /class="draft-script"/);
  assert.match(app, /class="draft-slots"/);
  assert.match(app, /id="run-draft"/);
  assert.match(app, /draftOnly:\s*true/);
  assert.equal(app.includes("autoStart"), false);
  assert.equal(app.includes("function connectBrowser"), false);
  assert.match(app, /function deleteJob/);
  assert.match(app, /method: "DELETE"/);
  assert.match(app, /contextmenu/);
  assert.match(app, /#studio-chips/);
  assert.match(app, /#feed-banner/);
  assert.match(app, /health\.imagine\?\.frozen/);
  assert.match(app, /Math\.abs\(dy\) > 50/);
  assert.match(app, /pagehide/);
  assert.match(app, /aria-valuenow/);
  assert.match(app, /preload = "auto"/);
  assert.match(app, /class="watch-dl"/);
  assert.match(html, /id="studio-chips"/);
  assert.match(html, /id="feed-banner"/);
  assert.match(html, /id="machine-overlay"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /class="studio-overlay feed-card" id="create-overlay"/);
  assert.match(html, /class="studio-overlay feed-card" id="settings-overlay"/);
  assert.match(html, /class="studio-overlay feed-card" id="template-overlay"/);
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
  assert.match(css, /\.watch-dl\s*\{/);
  const server = await readFile(join(process.cwd(), "src/server.mjs"), "utf8");
  const pipeline = await readFile(join(process.cwd(), "src/pipeline.mjs"), "utf8");
  assert.match(server, /PS4_IMAGINE_FROZEN !== "0"/);
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
  assert.match(css, /\.library\s*\{[^}]*height:\s*100dvh/);
  assert.match(css, /\.library\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.library\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.watch-feed\s*\{[^}]*height:\s*100dvh/);
  assert.match(css, /\.studio-overlay\s*\{[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/);
  assert.match(css, /\.overlay-panel\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
  assert.equal(css.includes("min(720px"), false);
  assert.equal(css.includes("min(520px"), false);
  assert.equal(css.includes("min(440px"), false);
  assert.equal(/\.library\s*\{[^}]*max-width:/.test(css), false);
  assert.match(css, /\.studio-overlay\.feed-card \.overlay-panel[\s\S]*width:\s*min\(20rem,\s*calc\(100vw - 32px\)\)/);
  assert.match(css, /\.studio-overlay\.feed-card \.overlay-panel[\s\S]*height:\s*auto/);
  assert.match(css, /\.studio-overlay\.feed-card \.overlay-panel[\s\S]*max-height:\s*calc\(100dvh - 48px\)/);
  assert.match(css, /--player-h:\s*calc\(100dvh/);
  assert.match(css, /\.short-detail-panel \.preview-wrap\s*\{[^}]*width:\s*min\(100%,\s*10\.5rem\)/);
  assert.match(css, /\.short-detail-panel \.preview-wrap\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.equal(/\.short-detail-panel \.preview-wrap\s*\{[^}]*100dvh/.test(css), false);
  assert.match(css, /\.short-detail-panel \.detail-head[\s\S]*grid-column:\s*auto/);
  assert.match(css, /\.draft-close\s*\{[^}]*border-radius:\s*50%/);
  assert.match(css, /\.draft-facts\s*\{/);
  assert.match(css, /\.short-detail-layout\s*\{[^}]*display:\s*grid/);
  assert.equal(/\.short-detail-layout\s*\{[^}]*min-height:\s*calc\(100dvh/.test(css), false);
  assert.equal(/\.job-detail\s*\{[^}]*display:\s*contents/.test(css), false);
  assert.match(css, /\.create-panel\s*\{[^}]*max-width:\s*36rem/);
  assert.match(css, /\.create-panel\s*\{[^}]*margin:\s*0/);
});

test("home chrome drops dashboard dump and keeps a Shorts grid", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
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
  assert.equal(home.includes("더보기"), false);
  assert.match(home, /aria-label="메뉴"/);
  assert.equal(home.includes('aria-label="설정"'), false);
  assert.match(home, /class="library-gear"/);
  assert.match(home, /<svg class="library-gear"/);
  assert.match(home, /id="import-library">가져오기</);
  assert.match(home, /id="open-template">템플릿</);
  assert.match(home, /id="open-settings">설정</);
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
  assert.match(css, /\.studio-chrome\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(css, /\.brand-mark\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.brand-mark\s*\{[^}]*place-items:\s*center/);
  assert.match(css, /\.brand-mark\s*\{[^}]*width:\s*24px/);
  assert.match(css, /\.brand-mark\s*\{[^}]*height:\s*24px/);
  assert.match(css, /\.brand-mark\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(css, /\.brand-mark\s*\{[^}]*flex:\s*0 0 24px/);
  assert.match(css, /\.brand-mark\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.brand-mark\s*\{[^}]*color:\s*var\(--accent\)/);
  assert.equal(/\.brand-mark\s*\{[^}]*background:\s*var\(--accent\)/.test(css), false);
  assert.equal(home.includes('width="13.6"'), false);
  assert.equal(home.includes('height="19.6"'), false);
  assert.match(app, /const APP_TITLE = "PS4_JUSTDOIT"/);
  assert.match(app, /document\.title = `템플릿 · \$\{APP_TITLE\}`/);
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

test("watch feed snaps 9:16 masters and leaves drafts on the grid", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const watch = html.slice(html.indexOf('id="watch-feed"'), html.indexOf('id="shorts"'));
  assert.match(html, /id="watch-scroller"/);
  assert.match(html, /id="shorts-grid"/);
  assert.match(watch, /aria-label="쇼츠 재생"/);
  assert.equal(watch.includes("내려받기"), false);
  assert.equal(watch.includes("다시 실행"), false);
  assert.match(css, /\.watch-scroller\s*\{[^}]*scroll-snap-type:\s*y\s+mandatory/);
  assert.match(css, /\.watch-slide\s*\{[^}]*height:\s*100dvh/);
  assert.match(css, /--watch-col:\s*min\(100vw,\s*calc\(100dvh \* 9 \/ 16\)\)/);
  assert.match(css, /\.watch-stage\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(css, /\.watch-stage\s*\{[^}]*height:\s*100dvh/);
  assert.match(css, /\.watch-stage video,\s*\.watch-stage \.watch-poster\s*\{[^}]*object-fit:\s*contain/);
  assert.match(css, /body\.watch-open\s*\{[^}]*display:\s*block/);
  assert.match(css, /body\.watch-open \.studio-chrome\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.watch-back\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-back\s*\{[^}]*top:\s*12px/);
  assert.match(css, /\.watch-back\s*\{[^}]*right:\s*12px/);
  assert.match(css, /\.watch-back\s*\{[^}]*background:\s*none/);
  assert.match(css, /\.watch-back\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.watch-back\s*\{[^}]*border-radius:\s*0/);
  assert.equal(/\.watch-back\s*\{[^}]*border-radius:\s*999px/.test(css), false);
  assert.equal(/\.watch-back\s*\{[^}]*background:\s*rgba/.test(css), false);
  assert.match(css, /\.watch-dl\s*\{[^}]*top:\s*64px/);
  assert.match(css, /@media \(max-width:\s*860px\)/);
  assert.match(css, /60dvh/);
  assert.equal(css.includes(".watch-mute"), false);
  assert.equal(css.includes(".watch-actions"), false);
  assert.equal(css.includes(".watch-sheet"), false);
  const watchSlide = app.slice(app.indexOf("function renderWatchSlide"), app.indexOf("function bindWatchSlide"));
  assert.match(app, /watch-close watch-back[\s\S]*watch-slide-chrome[\s\S]*watch-inspect[\s\S]*<\/article>/);
  assert.match(app, /class="watch-close watch-back"/);
  assert.match(app, /class="watch-close watch-back"[^>]*aria-label="닫기">×</);
  assert.match(app, /function isWatchableShort|isWatchableShort\(job\)/);
  assert.match(app, /#watch\//);
  assert.match(app, /#shorts/);
  assert.match(app, /setView\("watch"/);
  assert.match(app, /setView\("grid"\)/);
  assert.match(app, /setView\("detail"\)/);
  assert.equal(/if \(view === "detail"\) return "#short"/.test(app), false);
  assert.match(app, /function hashForView[\s\S]*return "#shorts"/);
  assert.match(app, /!hash \|\| hash === "shorts"/);
  assert.match(app, /hash === "watch" \|\| hash\.startsWith\("watch\/"\)/);
  assert.match(app, /hash === "short"/);
  assert.match(app, /hash === "short"[\s\S]*setView\("detail"/);
  assert.match(app, /class="draft-facts"/);
  assert.match(app, /\.slice\(0,\s*4\)/);
  assert.match(app, /preview-unavailable">\$\{escapeHtml\(status\.label\)\}/);
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
  assert.match(app, /if \(state\.view === "watch"\) \{\s*stopWatchFeed\(\$\("#watch-feed"\)\);\s*openHome\(\);/);
  assert.match(app, /isWatchableShort\(job\)\) setView\("watch"/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /ArrowUp/);
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
  assert.match(app, /from "\.\/watch-feed\.mjs"/);
  assert.match(app, /syncWatchFeed\(watchFeed, state\.view\)/);
  assert.match(app, /bindWatchFeed\(\$\("#watch-feed"\), openHome\)/);
  assert.match(app, /stopWatchFeed\(feed\);\s*openHome\(event\)/);
  assert.match(app, /classList\.contains\("watch-open"\)[\s\S]*playWatchFeed/);
  assert.match(app, /classList\.contains\("watch-open"\)[\s\S]*stopWatchFeed/);
  assert.equal(app.includes("video.muted = true"), false);
  assert.equal(watchSlide.includes(" muted"), false);
  assert.match(app, /video\.removeAttribute\("src"\)/);
  assert.match(app, /playsinline loop preload/);
  assert.equal(app.includes("playsinline loop muted"), false);
  assert.equal(app.includes("letterbox"), false);
  assert.match(app, /class="watch-close watch-back"/);
  assert.match(app, /다시 실행/);
  assert.match(app, /openJob/);
  assert.match(app, /function openDetail/);
  assert.match(app, /short-card-detail/);
  assert.match(app, />상세</);
  assert.equal(watchSlide.includes("watch-actions"), false);
  assert.equal(watchSlide.includes("watch-mute"), false);
  assert.equal(watchSlide.includes("watch-detail"), false);
  assert.equal(watchSlide.includes("상세"), false);
  assert.equal(watchSlide.includes("완벽"), false);
  assert.equal(app.includes("drawbox"), false);
  assert.equal(app.includes("drawtext"), false);
  assert.equal(/imagine/i.test(app.slice(app.indexOf("function renderWatchSlide"), app.indexOf("function bindWatchSlide"))), false);
});

test("completed short lists master chat parts and ASS downloads", () => {
  const downloads = shortDownloads({
    artifacts: [
      { name: "master.mp4", kind: "master-video", url: "/api/jobs/a/artifacts/master.mp4" },
      { name: "chat.mp4", kind: "chat-video", url: "/api/jobs/a/artifacts/chat.mp4" },
      { name: "parts/part-01.mp4", kind: "part", url: "/api/jobs/a/artifacts/parts/part-01.mp4" },
      { name: "captions.ass", kind: "captions-ass", url: "/api/jobs/a/artifacts/captions.ass" }
    ]
  });
  assert.deepEqual(downloads.map((item) => item.label), ["마스터", "채팅용", "파트 1", "자막 ASS"]);
  assert.ok(downloads.every((item) => item.href.includes("download=1")));
});

test("watch inspector saves drafts and freezes regen", async () => {
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  const server = await readFile(join(process.cwd(), "src/server.mjs"), "utf8");
  const pipeline = await readFile(join(process.cwd(), "src/pipeline.mjs"), "utf8");
  assert.match(app, /class="watch-inspect"/);
  assert.match(app, /hydrateWatchInspect/);
  assert.match(app, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/prompts/);
  assert.match(app, /method: "PATCH"/);
  assert.match(app, /이 영상은 이렇게 만들었어요/);
  assert.match(app, /왼쪽 영상을 만든 글이에요/);
  assert.match(app, /class="inspect-topic"/);
  assert.match(app, /class="inspect-facts"/);
  assert.match(app, /class="inspect-script"/);
  assert.match(app, /class="inspect-shot-caption"/);
  assert.match(app, /data-world-slot/);
  assert.match(app, /같은 장소 분위기/);
  assert.match(app, /장면 1 · 첫 장면|장면 \$\{index\}/);
  assert.match(app, /화면에 뜨는 자막/);
  assert.match(app, />그림 설명</);
  assert.match(app, />움직임</);
  assert.match(app, /받은 파일/);
  assert.match(app, /유튜브에 아직 올리지 않아요/);
  assert.match(app, /data-inspect-save>글만 저장/);
  assert.match(app, /data-inspect-regen[\s\S]*영상 다시 만들기/);
  assert.match(app, /지금은 크레딧이 없어서 새 영상을 못 만들어요/);
  assert.equal(app.includes("hook_photoreal"), false);
  assert.match(app, /health\?\.imagine\?\.frozen !== false/);
  assert.match(app, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/run/);
  assert.match(css, /\.watch-inspect\s*\{[^}]*360px/);
  assert.match(css, /@media \(max-width:\s*860px\)[\s\S]*40dvh/);
  assert.match(pipeline, /export async function saveJobDraft/);
  assert.match(pipeline, /buildGrokImagineScript/);
  assert.match(server, /request\.method === "PATCH"/);
  assert.match(server, /suffix === "draft"/);
  assert.match(server, /크레딧 402/);
});

test("양산 batch and upload pack stay draft-only unless unfrozen", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const app = await readFile(join(publicDir, "app.js"), "utf8");
  assert.match(html, /id="menu-batch">양산</);
  assert.match(html, /id="batch-topics"/);
  assert.match(html, /id="batch-draft"[^>]*>[\s\S]*초안만 저장/);
  assert.match(html, /id="batch-queue"[^>]*>[\s\S]*대기열에 넣고 생성/);
  assert.match(html, /id="batch-frozen"[^>]*>크레딧 402</);
  assert.match(app, /createMode = "batch"/);
  assert.match(app, /title\.textContent = batch \? "양산" : "새 쇼츠"/);
  assert.match(app, /provider: "grok-imagine"/);
  assert.match(app, /draftOnly: true/);
  assert.match(app, /function queueBatchJobs/);
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
