import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { JOBS_DIR } from "./pipeline.mjs";
import { hashFile } from "./run-ledger.mjs";

const DEFAULT_CDP = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || join(process.env.HOME || "/tmp", ".ps4-ai-video-studio", "chrome-profile");
const DOWNLOAD_TIMEOUT_MS = Number(process.env.GEMINI_VIDEO_TIMEOUT_MS || 180000);
function browserConfig(input = {}) {
  return {
    cdpUrl: String(input.cdpUrl || DEFAULT_CDP).replace(/\/$/, ""),
    profileDir: String(input.profileDir || PROFILE_DIR)
  };
}
function headlessEnabled() {
  return /^(1|true|yes)$/i.test(process.env.GEMINI_CHROME_HEADLESS || "");
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function generationRequest(job, script) {
  return {
    provider: "gemini-browser",
    topic: job.topic || "",
    format: job.format || "vertical",
    clipCount: Number(job.clipCount || script?.segments?.length || 0),
    targetDurationSec: Number(job.targetDurationSec || 0),
    targetDurationRangeSec: job.targetDurationRangeSec || null,
    captions: job.captions !== false,
    voiceover: job.voiceover !== false,
    segments: (script?.segments || []).map((segment) => ({
      durationHint: segment.durationHint || null,
      visualPrompt: segment.visualPrompt || "",
      caption: segment.caption || "",
      narration: segment.narration || ""
    }))
  };
}

let browserProcess;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function probeVideoDimensions(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      filePath
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const stream = JSON.parse(stdout).streams?.[0];
        const width = Number(stream?.width);
        const height = Number(stream?.height);
        resolve(Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function clipMatchesFormat(filePath, format) {
  const dimensions = await probeVideoDimensions(filePath);
  if (!dimensions) return false;
  const isVertical = dimensions.height > dimensions.width && dimensions.height / dimensions.width >= 1.4;
  return format === "vertical" ? isVertical : !isVertical;
}

async function getVersion(baseUrl = DEFAULT_CDP) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/version`);
  if (!response.ok) throw new Error(`Chrome DevTools 연결 실패 (${response.status})`);
  return response.json();
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BINARY,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  return candidates.find((path) => Bun.file(path).size > 0) || null;
}

async function startChrome(input = {}) {
  const config = browserConfig(input);
  const binary = chromeBinary();
  if (!binary) throw new Error("Google Chrome 또는 Chromium을 찾지 못했습니다.");
  const cdpPort = new URL(config.cdpUrl).port || "9222";
  await mkdir(config.profileDir, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${config.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (headlessEnabled()) chromeArgs.push("--headless=new", "--disable-gpu", "--no-startup-window");
  else if (process.env.GEMINI_CHROME_BACKGROUND !== "0") chromeArgs.push("--no-startup-window");
  chromeArgs.push("https://gemini.google.com/app");
  browserProcess = spawn(binary, chromeArgs, { detached: true, stdio: "ignore" });
  browserProcess.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await getVersion(config.cdpUrl);
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Chrome 원격 디버깅 포트(${cdpPort})를 열지 못했습니다.`);
}

class CdpBrowser {
  constructor(version, baseUrl = DEFAULT_CDP) {
    this.version = version;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
  }

  async connect() {
    this.ws = new WebSocket(this.version.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "Chrome DevTools 오류"));
      else request.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    const created = await this.command("Target.createTarget", { url: "https://gemini.google.com/app", newWindow: true });
    this.targetId = created.targetId;
    const attached = await this.command("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await mkdir(join(process.cwd(), "workspace", "downloads"), { recursive: true });
    await this.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(process.cwd(), "workspace", "downloads") });
    await this.command("Page.enable", {}, true);
    await this.command("Runtime.enable", {}, true);
    await sleep(1200);
    return this;
  }

  command(method, params = {}, session = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome DevTools WebSocket가 닫혀 있습니다."));
    const id = this.nextId++;
    const message = { id, method, params };
    if (session && this.sessionId) message.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Chrome 명령 시간 초과: ${method}`));
      }, 30000);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true }, true);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Gemini 페이지 스크립트 오류");
    return result.result?.value;
  }

  async navigate(url) {
    await this.command("Page.navigate", { url }, true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ready = await this.evaluate("document.readyState === 'complete' || document.readyState === 'interactive'").catch(() => false);
      if (ready) break;
      await sleep(250);
    }
    await sleep(2500);
  }

  async close() {
    try {
      if (this.targetId) await this.command("Target.closeTarget", { targetId: this.targetId });
    } catch {}
    try { this.ws?.close(); } catch {}
  }
}

async function connectBrowser(input = {}) {
  const config = browserConfig(input);
  let version;
  try {
    version = await getVersion(config.cdpUrl);
  } catch {
    version = await startChrome(config);
  }
  const browser = new CdpBrowser(version, config.cdpUrl);
  await browser.connect();
  return browser;
}

async function clickVideoTool(browser, format = "vertical") {
  const desiredRatio = format === "vertical" ? "portrait" : "landscape";
  return browser.evaluate(`(async () => {
    const desiredRatio = ${JSON.stringify(desiredRatio)};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const quotaPattern = /지금은 동영상을 생성할 수 없습니다|동영상을 다시 생성할 수 있습니다|업그레이드|quota|video generation limit|usage limit|할당량|쿼터|you(?:'|’)re out of videos|videos will be available again/i;
    const chooseRatio = async () => {
      const controls = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
      const ratioControl = controls.find((el) => /aspect ratio|가로세로|landscape|portrait|가로 모드|세로 모드/i.test(text(el)));
      if (!ratioControl) return false;
      const current = text(ratioControl);
      if ((desiredRatio === "portrait" && /portrait|세로|9:16/.test(current)) || (desiredRatio === "landscape" && /landscape|가로|16:9/.test(current))) return true;
      ratioControl.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],button,[role="option"]')].filter(visible);
      const option = options.find((el) => desiredRatio === "portrait"
        ? /portrait|세로|9:16/i.test(text(el))
        : /landscape|가로|16:9/i.test(text(el)));
      if (!option) return false;
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    };
    let buttons = [];
    let body = "";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      body = (document.body?.innerText || "").slice(-6000);
      if (quotaPattern.test(body)) return { clicked: false, quota: true, body };
      buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible);
      const fields = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
      if (/동영상 만들기|create videos?/i.test(body) && fields.length) {
        return { clicked: true, label: "prompt-ready", ratioConfigured: await chooseRatio() };
      }
      const tryIt = buttons.find((el) => /사용해 보기|try it|create videos?/i.test(text(el)));
      if (tryIt) {
        tryIt.click();
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const after = (document.body?.innerText || "").slice(-6000);
        if (quotaPattern.test(after)) return { clicked: false, quota: true, body: after };
        await chooseRatio();
        return { clicked: true, label: text(tryIt) };
      }
      const video = buttons.find((el) => /동영상 만들기|create videos?/i.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
      if (video) { video.click(); await chooseRatio(); return { clicked: true, label: text(video) }; }
      const tools = buttons.find((el) => /도구|tools|더보기|more|모드/.test(text(el)));
      if (tools) {
        tools.click();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const menu = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible).find((el) => /동영상 만들기|create videos?|video/.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
        if (menu) { menu.click(); await chooseRatio(); return { clicked: true, label: text(menu) }; }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { clicked: false, buttons: buttons.map(text).filter(Boolean).slice(-40), body };
  })()`);
}

async function fillPrompt(browser, prompt) {
  const prepared = await browser.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const fields = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
    const field = fields.sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0];
    if (!field) return { filled: false, fields: 0 };
    field.focus();
    if (field.tagName === 'TEXTAREA') {
      field.select();
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return { filled: true, tag: field.tagName };
  })()`);
  if (!prepared?.filled) return prepared || { filled: false, fields: 0 };
  try {
    await browser.command("Input.insertText", { text: String(prompt) }, true);
  } catch {
    const value = JSON.stringify(String(prompt));
    await browser.evaluate(`(() => {
      const field = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!field) return false;
      if (field.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter ? setter.call(field, ${value}) : field.value = ${value};
      } else {
        field.textContent = ${value};
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
      return true;
    })()`);
  }
  await sleep(250);
  return prepared;
}

async function submitPrompt(browser) {
  const button = await browser.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const send = buttons.find((el) => /보내기|send|생성|generate|create/.test(text(el)) && !/파일|file|mode|모드/.test(text(el)));
    if (!send) return null;
    send.click();
    return text(send);
  })()`);
  if (button) return { submitted: true, method: "button", label: button };
  const hasField = await browser.evaluate(`(() => [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }))()`);
  if (!hasField) return { submitted: false };
  try {
    await browser.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, true);
    await browser.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, true);
  } catch {
    await browser.evaluate(`(() => {
      const field = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!field) return false;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return true;
    })()`);
  }
  return { submitted: true, method: "enter" };
}

async function inspectMedia(browser) {
  return browser.evaluate(`(() => ({
    videos: [...document.querySelectorAll('video')].map(v => ({ src: v.currentSrc || v.src || '', ready: v.readyState, duration: v.duration || 0 })),
    links: [...document.querySelectorAll('a')].map(a => ({ href: a.href || '', text: (a.innerText || a.getAttribute('aria-label') || '').trim() })).filter(x => x.href && (/\\.mp4|download|다운로드|내려받기/i.test(x.href + ' ' + x.text))),
    chats: [...document.querySelectorAll('a')].map(a => ({ href: a.href || '', text: (a.innerText || a.getAttribute('aria-label') || '').trim() })).filter(x => /gemini\\.google\\.com\\/app\\/[^/?#]+/i.test(x.href)),
    buttons: [...document.querySelectorAll('button,[role="button"]')].map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(-60),
    body: (document.body?.innerText || '').slice(-4000)
  }))()`);
}

async function downloadFromPage(browser, url) {
  const encoded = JSON.stringify(url);
  const result = await browser.evaluate(`(async () => {
    try {
      const response = await fetch(${encoded}, { credentials: 'include' });
      if (!response.ok) return { ok: false, status: response.status };
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 70 * 1024 * 1024) return { ok: false, status: 'too-large', bytes: buffer.byteLength };
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      return { ok: true, base64: btoa(binary), bytes: bytes.length };
    } catch (error) { return { ok: false, status: error.message }; }
  })()`);
  if (!result?.ok || !result.base64) return null;
  return Buffer.from(result.base64, "base64");
}

async function waitForClip(browser, knownMedia, deadline) {
  while (Date.now() < deadline) {
    const media = await inspectMedia(browser);
    const quotaMessage = media.body.match(/(?:지금은\s*)?동영상을 생성할 수 없습니다[^.。\n]*|동영상 생성 할당량[^.。\n]*|you(?:'|’)re out of videos[^.\n]*|videos will be available again[^.\n]*/i);
    if (quotaMessage) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${quotaMessage[0].trim()}`);
    const knownVideos = knownMedia?.videos || new Set();
    const knownLinks = knownMedia?.links || new Set();
    const knownChats = knownMedia?.chats || new Set();
    const freshChats = (media.chats || []).filter((item) => item.href && !knownChats.has(item.href));
    const chat = freshChats[0];
    if (chat?.href) {
      knownChats.add(chat.href);
      await browser.navigate(chat.href);
      continue;
    }
    const freshVideos = media.videos.filter((video) => video.src && !knownVideos.has(video.src) && video.ready > 0);
    const direct = freshVideos.find((video) => !video.src.startsWith("blob:")) || freshVideos[0];
    const freshLinks = media.links.filter((item) => item.href && !knownLinks.has(item.href));
    const link = freshLinks[0];
    if (direct?.src) {
      const data = await downloadFromPage(browser, direct.src);
      if (data) return data;
    }
    if (link?.href) {
      const data = await downloadFromPage(browser, link.href);
      if (data) return data;
    }
    await sleep(2500);
  }
  throw new Error("Gemini 영상 생성 결과를 시간 안에 찾지 못했습니다. 로그인·동영상 기능·할당량을 확인하세요.");
}


export async function geminiBrowserStatus(input = {}) {
  const config = browserConfig(input);
  try {
    const version = await getVersion(config.cdpUrl);
    return { connected: true, browser: version.Browser || "Chrome", headless: /HeadlessChrome/i.test(String(version["User-Agent"] || "")), cdpUrl: config.cdpUrl, profileDir: config.profileDir };
  } catch (error) {
    return { connected: false, browser: null, headless: null, cdpUrl: config.cdpUrl, profileDir: config.profileDir, message: error.message };
  }
}

export async function geminiQuotaStatus(input = {}) {
  const config = browserConfig(input);
  let browser = null;
  try {
    browser = await connectBrowser(config);
    await browser.navigate("https://gemini.google.com/videos");
    const observation = await browser.evaluate(`(() => {
      const body = document.body?.innerText || "";
      const quotaMessage = body.match(/(?:지금은\\s*)?동영상을 생성할 수 없습니다[^.。\\n]*|동영상 생성 할당량[^.。\\n]*|you(?:'|’)re out of videos[^.\\n]*|videos will be available again[^.\\n]*/i)?.[0] || null;
      const quotaResetText = body.match(/[^\\n]*(?:다시 생성할 수 있습니다|videos will be available again)[^\\n]*/i)?.[0]?.trim() || null;
      const account = [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") || "").find((value) => /Google Account:/i.test(value)) || null;
      const videoMode = /동영상 만들기|create videos?/i.test(body);
      return {
        available: videoMode && !quotaMessage,
        quotaMessage,
        quotaResetText,
        account,
        plan: body.match(/\\b(?:Pro|Plus|Ultra)\\b/)?.[0] || null,
        videoMode,
        bodyExcerpt: body.slice(-1200)
      };
    })()`);
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir,
      headless: /HeadlessChrome/i.test(String(browser.version["User-Agent"] || "")),
      ...observation
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir,
      headless: null,
      available: false,
      error: error.message
    };
  } finally {
    await browser?.close();
  }
}

export async function generateGeminiClips(job, script, onProgress = async () => {}) {
  const config = browserConfig({ cdpUrl: job.geminiCdpUrl, profileDir: job.geminiProfileDir });
  const browser = await connectBrowser(config);
  const jobDir = join(JOBS_DIR, job.id);
  const clipsDir = join(jobDir, "clips");
  const requestPayload = generationRequest(job, script);
  const scriptHash = hashJson(script);
  const actualHeadless = /HeadlessChrome/i.test(String(browser.version["User-Agent"] || ""));
  const requestHash = hashJson({ ...requestPayload, scriptHash });
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const providerDecisionHash = hashJson(providerDecision);
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: browser.version.Browser || null,
    cdpUrl: config.cdpUrl,
    profileDir: config.profileDir,
    persistentProfile: true,
    headless: actualHeadless,
    headlessRequested: headlessEnabled(),
    fallbackUsed: false
  };
  const providerAttestationHash = hashJson(providerAttestation);
  let previousGeneration = null;
  if (existsSync(join(jobDir, "gemini-generation.json"))) {
    try {
      previousGeneration = JSON.parse(await readFile(join(jobDir, "gemini-generation.json"), "utf8"));
    } catch {
      previousGeneration = null;
    }
  }
  const previousSegments = new Map((previousGeneration?.segments || []).map((segment) => [segment.index, segment]));
  const generation = {
    schemaVersion: 1,
    jobId: job.id,
    provider: "gemini-browser",
    profileDir: config.profileDir,
    cdpUrl: config.cdpUrl,
    browser: browser.version.Browser || null,
    startedAt: new Date().toISOString(),
    status: "running",
    runId: job.runId || null,
    requestHash,
    scriptHash,
    requestScriptHash: requestHash,
    providerAttestation,
    providerAttestationHash,
    providerDecision,
    providerDecisionHash,
    request: requestPayload,
    resumedFrom: previousGeneration?.status === "failed" ? previousGeneration.completedAt || null : null,
    segments: [],
    rejectedResumes: []
  };
  await mkdir(clipsDir, { recursive: true });
  const bindingMatches = previousGeneration?.requestHash === requestHash
    && previousGeneration?.scriptHash === scriptHash;
  const sessionBinding = previousGeneration?.provider === "gemini-browser"
    && previousGeneration.providerDecisionHash === providerDecisionHash
    && previousGeneration.providerAttestationHash === providerAttestationHash
    && previousGeneration.profileDir === config.profileDir
    && previousGeneration.cdpUrl === config.cdpUrl;
  const previousSegmentsBound = Boolean(
    previousGeneration?.runId
    && previousGeneration?.requestHash
    && previousGeneration?.scriptHash
    && Array.isArray(previousGeneration?.segments)
    && previousGeneration.segments.every((segment) => (
      segment.runId === previousGeneration.runId
      && segment.requestHash === previousGeneration.requestHash
      && segment.scriptHash === previousGeneration.scriptHash
      && segment.providerDecisionHash === previousGeneration.providerDecisionHash
      && segment.providerAttestationHash === previousGeneration.providerAttestationHash
      && segment.path === segment.output
    ))
  );
  const canResumePartial = previousGeneration?.status === "failed"
    && Array.isArray(previousGeneration.segments)
    && previousGeneration.segments.length > 0
    && bindingMatches
    && sessionBinding
    && previousSegmentsBound;
  try {
    for (let index = 0; index < script.segments.length; index += 1) {
      const segment = script.segments[index];
      const target = join(clipsDir, `${String(index + 1).padStart(2, "0")}.mp4`);
      const previousSegment = previousSegments.get(index + 1);
      const existingHashMatches = canResumePartial
        && previousSegment?.sha256
        && existsSync(target)
        && await hashFile(target).catch(() => null) === previousSegment.sha256;
      const existingFormatMatches = existingHashMatches ? await clipMatchesFormat(target, job.format) : false;
      if (existingHashMatches && existingFormatMatches) {
        const path = `clips/${String(index + 1).padStart(2, "0")}.mp4`;
        generation.segments.push({
          ...previousSegment,
          index: index + 1,
          runId: job.runId || null,
          requestHash,
          scriptHash,
          path,
          output: path,
          sourceRunId: previousGeneration.runId,
          sourceRequestHash: previousGeneration.requestHash,
          sourceScriptHash: previousGeneration.scriptHash,
          providerDecisionHash,
          providerAttestationHash,
          resumed: true
        });
        await onProgress(Math.round(((index + 1) / script.segments.length) * 100), `${index + 1}/${script.segments.length} 기존 Gemini 클립을 재사용했습니다.`);
        continue;
      }
      if (existingHashMatches && !existingFormatMatches) {
        generation.rejectedResumes.push({
          index: index + 1,
          path: `clips/${String(index + 1).padStart(2, "0")}.mp4`,
          expectedFormat: job.format,
          reason: "format-mismatch"
        });
      }
      await onProgress(Math.round((index / script.segments.length) * 100), `${index + 1}/${script.segments.length} 장면을 Gemini에 요청하는 중입니다.`);
      await browser.navigate("https://gemini.google.com/videos");
      const tool = await clickVideoTool(browser, job.format);
      const quotaText = String(tool.body || "").match(/동영상을 다시 생성할 수 있습니다[^.。\n]*|동영상 생성 할당량[^.。\n]*|you(?:'|’)re out of videos[^.\n]*|videos will be available again[^.\n]*/i)?.[0];
      if (tool.quota) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${quotaText || "계정 업그레이드 또는 할당량 갱신이 필요합니다."}`);
      if (!tool.clicked) throw new Error(`Gemini 동영상 도구를 찾지 못했습니다. 화면에 "동영상 만들기"가 활성화되어 있는지 확인하세요. 감지된 버튼: ${(tool.buttons || []).join(", ")}`);
      const prompt = `Create a ${job.format === "vertical" ? "vertical 9:16" : "16:9"} cinematic documentary video clip, exactly about ${segment.durationHint || Math.round(job.targetDurationSec / Math.max(1, script.segments.length))} seconds. ${segment.visualPrompt}. Keep the subject physically plausible and visually consistent across clips. Use the same camera language, color grade, subject identity, and documentary pacing as the other clips. No on-screen text, no subtitles, no watermark, no logos. Korean documentary mood.`;
      const filled = await fillPrompt(browser, prompt);
      if (!filled.filled) throw new Error("Gemini 입력창을 찾지 못했습니다.");
      const known = await inspectMedia(browser);
      const knownMedia = {
        videos: new Set((known.videos || []).map((video) => video.src).filter(Boolean)),
        links: new Set((known.links || []).map((item) => item.href).filter(Boolean)),
        chats: new Set((known.chats || []).map((item) => item.href).filter(Boolean))
      };
      const submitted = await submitPrompt(browser);
      if (!submitted.submitted) throw new Error("Gemini 영상 요청을 전송하지 못했습니다.");
      const bytes = await waitForClip(browser, knownMedia, Date.now() + DOWNLOAD_TIMEOUT_MS);
      await writeFile(target, bytes);
      if (!(await clipMatchesFormat(target, job.format))) {
        await unlink(target).catch(() => {});
        throw new Error(`Gemini가 ${job.format === "vertical" ? "세로 9:16" : "가로 16:9"} 비율의 영상을 반환하지 않았습니다.`);
      }
      generation.segments.push({
        index: index + 1,
        runId: job.runId || null,
        requestHash,
        scriptHash,
        durationHint: segment.durationHint || null,
        prompt,
        path: `clips/${String(index + 1).padStart(2, "0")}.mp4`,
        output: `clips/${String(index + 1).padStart(2, "0")}.mp4`,
        sha256: await hashFile(target).catch(() => null),
        providerDecisionHash,
        providerAttestationHash
      });
      await onProgress(Math.round(((index + 1) / script.segments.length) * 100), `${index + 1}/${script.segments.length} 장면 다운로드 완료`);
    }
  } catch (error) {
    generation.status = "failed";
    generation.error = error.message;
    throw error;
  } finally {
    await browser.close();
    if (generation.status === "running") generation.status = "completed";
    generation.completedAt = new Date().toISOString();
    await writeFile(join(jobDir, "gemini-generation.json"), JSON.stringify(generation, null, 2)).catch(() => {});
  }
  return generation;
}
export async function startGeminiBrowser() {
  try {
    const version = await getVersion();
    return { connected: true, started: false, browser: version.Browser || "Chrome" };
  } catch {
    const version = await startChrome();
    return { connected: true, started: true, browser: version.Browser || "Chrome" };
  }
}
