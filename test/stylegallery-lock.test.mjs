import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

test("consumer reference record carries required StyleGallery fields only", async () => {
  const record = JSON.parse(await readFile(join(root, "consumer-reference/ps4-justdoit.json"), "utf8"));
  assert.deepEqual(record, {
    schema_version: "1.0",
    id: "ps4-justdoit-studio",
    artifact_mode: "consumer_local",
    maturity: "stable",
    support: { status: "active" },
    owner: { name: "PS4_JUSTDOIT", enforcement: "placeholder" },
    fixture_independence: "related",
    review_independence: "single_account",
    handoff: { status: "declared", record: "consumer-reference/ps4-justdoit.json" }
  });
});

test("lock doc declares handoff and the pinned pattern stack", async () => {
  const lock = await readFile(join(root, "docs/stylegallery-lock.md"), "utf8");
  assert.match(lock, /Consumer reference: declared/);
  assert.match(lock, /Consumer reference record: consumer-reference\/ps4-justdoit\.json/);
  assert.match(lock, /9049f132426006661ac44aea4714d07426c432e5/);
  assert.match(lock, /stylegallery@0\.1\.4/);
  assert.match(lock, /Library scroll `?\.library`?: sticky-header \+ card-grid \+ frame 9\/16/);
  assert.match(lock, /Watch scroll none: cover \+ frame 9\/16 \+ overlay-stack; `body\.watch-open #watch-feed \{ display:block \}`; no scroll-snap/);
  assert.match(lock, /Overlays scroll on card: super-center \+ clamped-card `min\(400px, calc\(100vw - 40px\)\)`; no right drawer/);
  assert.match(lock, /Board `#backlot-overlay`: cover \+ stage card-grid; scroll = panel/);
  assert.match(lock, /scroll-snap on watch/);
  assert.match(lock, /right inspect drawer/);
  assert.match(lock, /chrome leaking off 9:16/);
  assert.match(lock, /full-bleed create sheet/);
  assert.match(lock, /--bg #0b0d12/);
  assert.match(lock, /--overlay-w min\(400px, calc\(100vw - 40px\)\)/);
  assert.match(lock, /header PS4_JUSTDOIT only/);
});

test("CSS tokens, watch-open display:block, and no 쇼츠 공장", async () => {
  const css = await readFile(join(root, "public/styles.css"), "utf8");
  const html = await readFile(join(root, "public/index.html"), "utf8");
  const app = await readFile(join(root, "public/app.js"), "utf8");
  assert.match(css, /^\/\* Design lock: docs\/stylegallery-lock\.md \+ consumer-reference\/ps4-justdoit\.json \*\//);
  assert.match(css, /--bg:\s*#0b0d12/);
  assert.match(css, /--surface:\s*#141821/);
  assert.match(css, /--surface-2:\s*#1a1f2b/);
  assert.match(css, /--line:\s*rgba\(255,255,255,\.08\)/);
  assert.match(css, /--text:\s*#f4f6fb/);
  assert.match(css, /--overlay-w:\s*min\(400px,\s*calc\(100vw - 40px\)\)/);
  assert.match(css, /border-radius:\s*20px/);
  assert.match(css, /min\(400px,\s*calc\(100vw - 40px\)\)/);
  assert.match(css, /body\.watch-open #watch-feed/);
  assert.match(css, /body\.watch-open #watch-feed\.watch-feed/);
  assert.match(css, /body\.watch-open \.watch-feed\s*\{[^}]*display:\s*block/);
  assert.equal(css.includes("scroll-snap"), false);
  assert.equal(css.includes("translateX(100%)"), false);
  assert.equal(css.includes("쇼츠 공장"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
  assert.equal(app.includes("쇼츠 공장"), false);
  assert.match(html, /<h1>PS4_JUSTDOIT<\/h1>/);
  assert.equal(html.includes("쇤츠 공장"), false);
  assert.equal(css.includes("쇤츠 공장"), false);
});

test("backlot overlay is a wide board with video and no caption editor", async () => {
  const html = await readFile(join(root, "public/index.html"), "utf8");
  const css = await readFile(join(root, "public/styles.css"), "utf8");
  const app = await readFile(join(root, "public/app.js"), "utf8");
  const start = html.indexOf('id="backlot-overlay"');
  const end = html.indexOf('id="machine-overlay"');
  const overlay = start > 0 && end > start ? html.slice(start, end) : "";
  assert.match(html, /id="open-backlot"[^>]*aria-label="보드"/);
  assert.match(overlay, /id="backlot-preview-video"/);
  assert.match(overlay, /id="backlot-board"/);
  assert.match(overlay, /자막·대본은 재료 창에서 고치세요/);
  assert.equal(overlay.includes("<textarea"), false);
  assert.equal(overlay.includes("captions.ass"), false);
  assert.equal(overlay.includes("inspect-shot-caption"), false);
  assert.match(css, /#backlot-overlay \.backlot-overlay-panel[\s\S]*min\(960px,\s*calc\(100vw - 24px\)\)/);
  assert.match(css, /#backlot-preview-video[\s\S]*object-fit:\s*cover/);
  assert.match(css, /body\.watch-open \.watch-feed\s*\{[^}]*display:\s*block/);
  assert.match(app, /#backlot-preview-video/);
  assert.match(app, /backlotMasterUrl/);
  assert.match(app, /초안 열기/);
  assert.match(app, /pauseBacklotPreview/);
  assert.equal(app.includes("muted = true"), false);
  assert.equal(overlay.includes("muted"), false);
  assert.equal(html.includes("쇼츠 공장"), false);
});
