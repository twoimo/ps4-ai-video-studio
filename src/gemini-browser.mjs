import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { JOBS_DIR } from "./pipeline.mjs";
import { hashFile } from "./run-ledger.mjs";
import { canonicalGeminiSessionBinding, geminiSessionBindingHash } from "./provenance.mjs";

const DEFAULT_CDP = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || join(process.env.HOME || "/tmp", ".ps4-ai-video-studio", "chrome-profile");
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.GEMINI_VIDEO_TIMEOUT_MS || 600_000));
const MIN_NEW_HEADLESS_CHROME_MAJOR = 109;

function browserConfig(input = {}) {
  const cdpUrl = String(input.cdpUrl || DEFAULT_CDP).replace(/\/$/, "");
  const profileDir = resolve(String(input.profileDir || PROFILE_DIR));
  const profileRoot = resolve(process.env.HOME || "/tmp", ".ps4-ai-video-studio");
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error("Gemini CDP 주소가 올바르지 않습니다.");
  }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new Error("Gemini CDP는 경로·인증 정보가 없는 로컬 HTTP origin만 사용할 수 있습니다.");
  }
  if (profileDir !== profileRoot && !profileDir.startsWith(`${profileRoot}/`)) {
    throw new Error("Gemini Chrome 프로필은 PS4 Studio 전용 프로필 디렉터리 안에 있어야 합니다.");
  }
  return {
    cdpUrl: parsed.origin,
    profileDir
  };
}

export function configuredGeminiJobProfile() {
  const config = browserConfig();
  return { geminiCdpUrl: config.cdpUrl, geminiProfileDir: config.profileDir };
}
function optionalBoolean(value, name, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name}에는 1/0, true/false, yes/no 또는 on/off만 사용할 수 있습니다.`);
}

export function resolveGeminiChromeLaunchPolicy(environment = process.env) {
  const headless = optionalBoolean(environment.GEMINI_CHROME_HEADLESS, "GEMINI_CHROME_HEADLESS", true);
  const background = !headless && optionalBoolean(environment.GEMINI_CHROME_BACKGROUND, "GEMINI_CHROME_BACKGROUND", false);
  return {
    headless,
    background,
    mode: headless ? "headless" : background ? "background" : "visible",
    headlessImplementation: headless ? "new" : null
  };
}

export function geminiChromeMajorVersion(version) {
  const match = `${version?.Browser || ""} ${version?.["User-Agent"] || ""}`.match(/(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function isHeadlessChromeVersion(version) {
  return /HeadlessChrome\//i.test(`${version?.Browser || ""} ${version?.["User-Agent"] || ""}`);
}

export function assertGeminiChromeRuntime(version, policy = resolveGeminiChromeLaunchPolicy()) {
  const chromeMajor = geminiChromeMajorVersion(version);
  if (!Number.isInteger(chromeMajor)) {
    throw new Error("연결된 CDP endpoint가 지원되는 Chrome/Chromium인지 확인할 수 없습니다.");
  }
  if (policy.headless && chromeMajor < MIN_NEW_HEADLESS_CHROME_MAJOR) {
    throw new Error(`새 Chrome 헤드리스 모드는 Chrome ${MIN_NEW_HEADLESS_CHROME_MAJOR} 이상이 필요합니다. 현재 감지 버전: ${chromeMajor}`);
  }
  const actualHeadless = isHeadlessChromeVersion(version);
  if (actualHeadless !== policy.headless) {
    const requested = policy.headless ? "headless" : policy.mode;
    const actual = actualHeadless ? "headless" : "headed";
    throw new Error(`Gemini Chrome 모드 불일치: ${requested}를 요청했지만 CDP 포트에는 ${actual} Chrome이 연결되어 있습니다. 전용 Chrome을 완전히 종료한 뒤 같은 프로필로 다시 시작하세요.`);
  }
  return { chromeMajor, actualHeadless, mode: policy.mode };
}

export function buildGeminiChromeLaunchArgs(input = {}, environment = process.env) {
  const config = browserConfig(input);
  const policy = resolveGeminiChromeLaunchPolicy(environment);
  const cdpPort = new URL(config.cdpUrl).port;
  const chromeArgs = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${config.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (policy.headless) chromeArgs.push("--headless=new", "--window-size=1440,1200");
  else if (policy.background) chromeArgs.push("--no-startup-window");
  chromeArgs.push("https://gemini.google.com/app");
  return chromeArgs;
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

export function geminiVideoQuotaMessage(value) {
  const body = String(value || "");
  const patterns = [
    /(?:지금은\s*)?동영상을 생성할 수 없습니다[^.。\n]{0,240}/i,
    /동영상을 다시 생성할 수 있습니다[^.。\n]{0,240}/i,
    /동영상[^.。\n]{0,48}(?:생성\s*)?(?:할당량|쿼터|한도)[^.。\n]{0,160}(?:소진|모두 사용|초과|도달|재설정|갱신|다시 생성)/i,
    /(?:할당량|쿼터|한도)[^.。\n]{0,48}동영상[^.。\n]{0,160}(?:소진|모두 사용|초과|도달|재설정|갱신|다시 생성)/i,
    /you(?:'|’)re out of videos[^.\n]{0,240}/i,
    /video generation (?:quota|limit)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i,
    /videos will be available again[^.\n]{0,240}/i,
    /(?:video generation|videos?)[^.\n]{0,80}(?:quota|usage limit|generation limit)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i,
    /(?:quota|usage limit|generation limit)[^.\n]{0,80}(?:video generation|videos?)[^.\n]{0,160}(?:reached|exhausted|used up|reset|available again)/i
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

export function geminiAspectRatioEvidence(format, evidence = {}) {
  const desiredRatio = format === "vertical" ? "portrait" : "landscape";
  const oppositeRatio = desiredRatio === "portrait" ? "landscape" : "portrait";
  const labelMatches = (value, ratio) => {
    const label = String(value || "").trim().toLowerCase();
    if (!label) return false;
    const selectionLabel = label.replace(/가로\s*[/·-]?\s*세로(?:\s*비율)?/g, " ");
    const portrait = /(?:\bportrait\b|세로(?:\s*모드)?|9\s*[:/x×]\s*16)/i.test(selectionLabel);
    const landscape = /(?:\blandscape\b|가로(?:\s*모드)?|16\s*[:/x×]\s*9)/i.test(selectionLabel);
    return ratio === "portrait" ? portrait && !landscape : landscape && !portrait;
  };
  const controlLabel = String(evidence.controlLabel || "").trim();
  const options = Array.isArray(evidence.options) ? evidence.options : [];
  const controlDesired = labelMatches(controlLabel, desiredRatio);
  const controlOpposite = labelMatches(controlLabel, oppositeRatio);
  const selectedDesired = options.some((option) => option?.selected === true && labelMatches(option.label, desiredRatio));
  const selectedOpposite = options.some((option) => option?.selected === true && labelMatches(option.label, oppositeRatio));
  const configured = !controlOpposite && !selectedOpposite && (controlDesired || selectedDesired);
  return {
    configured,
    desiredRatio,
    controlLabel: controlLabel || null,
    method: controlDesired ? "control-label" : selectedDesired ? "selected-state" : null,
    contradiction: controlOpposite || selectedOpposite
  };
}

function volatileGeminiScriptTimestamp(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "fetchedat"
    || normalized === "capturedat"
    || normalized === "captureat"
    || normalized === "capturetimestamp"
    || normalized === "capturedtimestamp"
    || normalized === "sourcesnapshotat";
}

export function canonicalGeminiResumeScript(value) {
  if (Array.isArray(value)) return value.map(canonicalGeminiResumeScript);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !volatileGeminiScriptTimestamp(key))
      .map(([key, nested]) => [key, canonicalGeminiResumeScript(nested)]));
  }
  return value;
}

export function canonicalGeminiResumeScriptHash(script) {
  return hashJson(canonicalGeminiResumeScript(script));
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
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(2500) });
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
  const chromeArgs = buildGeminiChromeLaunchArgs(config);
  browserProcess = spawn(binary, chromeArgs, { detached: true, stdio: "ignore" });
  browserProcess.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let version;
    try {
      version = await getVersion(config.cdpUrl);
    } catch {
      await sleep(500);
      continue;
    }
    assertGeminiChromeRuntime(version);
    return version;
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
      clearTimeout(request.timeout);
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
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Chrome 명령 시간 초과: ${method}`));
      }, 30000);
      this.pending.get(id).timeout = timeout;
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
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Chrome DevTools 세션이 닫혔습니다."));
    }
    this.pending.clear();
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
  assertGeminiChromeRuntime(version);
  const browser = new CdpBrowser(version, config.cdpUrl);
  await browser.connect();
  return browser;
}

async function clickVideoTool(browser, format = "vertical") {
  const desiredRatio = format === "vertical" ? "portrait" : "landscape";
  return browser.evaluate(`(async () => {
    const desiredRatio = ${JSON.stringify(desiredRatio)};
    const requestedFormat = desiredRatio === "portrait" ? "vertical" : "horizontal";
    const quotaMessageFor = ${geminiVideoQuotaMessage.toString()};
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const ratioLabel = (el) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(el));
    const ratioOptionElement = (el) => el.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(el.closest('[role="menu"],[role="listbox"]'));
    const findRatioControl = () => {
      const controls = [...document.querySelectorAll('button,[role="button"]')].filter((el) => visible(el) && !ratioOptionElement(el));
      return controls.find((el) => /aspect ratio|가로세로|화면비/i.test(text(el))) || controls.find(ratioLabel) || null;
    };
    const selected = (el) => {
      if (typeof el.checked === 'boolean' && el.checked === true) return true;
      return [el.getAttribute('aria-checked'), el.getAttribute('aria-selected'), el.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const readRatioEvidence = () => {
      const ratioControl = findRatioControl();
      const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
        .filter((el) => visible(el) && ratioLabel(el))
        .map((el) => ({ label: text(el), selected: selected(el) }));
      return ratioEvidenceFor(requestedFormat, { controlLabel: ratioControl ? text(ratioControl) : '', options });
    };
    const chooseRatio = async () => {
      let ratioControl = null;
      let verification = readRatioEvidence();
      if (verification.configured) return verification;
      for (let attempt = 0; attempt < 10 && !ratioControl; attempt += 1) {
        ratioControl = findRatioControl();
        if (!ratioControl) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ratioControl) return { ...verification, reason: 'ratio-control-missing' };
      ratioControl.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')].filter(visible);
      const option = options.find((el) => el !== ratioControl
        && ratioOptionElement(el)
        && ratioEvidenceFor(requestedFormat, { options: [{ label: text(el), selected: true }] }).configured);
      if (!option) return { ...verification, reason: 'ratio-option-missing' };
      option.click();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        verification = readRatioEvidence();
        if (verification.configured) return verification;
      }
      return { ...verification, reason: 'ratio-selection-unverified' };
    };
    let buttons = [];
    let body = "";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      body = (document.body?.innerText || "").slice(-6000);
      const quotaMessage = quotaMessageFor(body);
      if (quotaMessage) return { clicked: false, quota: true, quotaMessage, body };
      buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible);
      const signIn = buttons.find((el) => /로그인|sign in/i.test(text(el)) && /accounts\.google\.com/i.test(el.href || el.closest('a')?.href || ''));
      if (signIn) return { clicked: false, authRequired: true };
      const fields = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
      if (/동영상 만들기|create videos?/i.test(body) && fields.length) {
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: "prompt-ready", ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const tryIt = buttons.find((el) => /사용해 보기|try it|create videos?/i.test(text(el)));
      if (tryIt) {
        tryIt.click();
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const after = (document.body?.innerText || "").slice(-6000);
        const afterQuotaMessage = quotaMessageFor(after);
        if (afterQuotaMessage) return { clicked: false, quota: true, quotaMessage: afterQuotaMessage, body: after };
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: text(tryIt), ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const video = buttons.find((el) => /동영상 만들기|create videos?/i.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
      if (video) {
        video.click();
        const ratioVerification = await chooseRatio();
        return { clicked: true, label: text(video), ratioConfigured: ratioVerification.configured === true, ratioVerification };
      }
      const tools = buttons.find((el) => /도구|tools|더보기|more|모드/.test(text(el)));
      if (tools) {
        tools.click();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const menu = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,div[role="option"]')].filter(visible).find((el) => /동영상 만들기|create videos?|video/.test(text(el)) && !/deselect|선택 해제/.test(text(el)));
        if (menu) {
          menu.click();
          const ratioVerification = await chooseRatio();
          return { clicked: true, label: text(menu), ratioConfigured: ratioVerification.configured === true, ratioVerification };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { clicked: false, buttons: buttons.map(text).filter(Boolean).slice(-40), body };
  })()`);
}

async function verifyVideoAspectRatio(browser, format = "vertical") {
  return browser.evaluate(`(() => {
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
    const ratioLabel = (el) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(el));
    const ratioOptionElement = (el) => el.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(el.closest('[role="menu"],[role="listbox"]'));
    const selected = (el) => {
      if (typeof el.checked === 'boolean' && el.checked === true) return true;
      return [el.getAttribute('aria-checked'), el.getAttribute('aria-selected'), el.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const controls = [...document.querySelectorAll('button,[role="button"]')].filter((el) => visible(el) && !ratioOptionElement(el));
    const ratioControl = controls.find((el) => /aspect ratio|가로세로|화면비/i.test(text(el))) || controls.find(ratioLabel) || null;
    const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
      .filter((el) => visible(el) && ratioLabel(el))
      .map((el) => ({ label: text(el), selected: selected(el) }));
    return ratioEvidenceFor(${JSON.stringify(format)}, { controlLabel: ratioControl ? text(ratioControl) : '', options });
  })()`);
}

export function geminiPromptSubmissionDomState(prompt, root, currentHref = "") {
  const normalizeEditorText = (value) => String(value ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
  const expectedPrompt = normalizeEditorText(prompt);
  const query = (selector) => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const visible = (element) => {
    const rect = element?.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const labels = (element) => [
    element?.innerText,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title")
  ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
  const disabled = (element) => Boolean(
    element?.disabled
    || /^(?:true|disabled)$/i.test(element?.getAttribute?.("aria-disabled") || "")
    || /^(?:disabled)$/i.test(element?.getAttribute?.("data-state") || "")
  );
  const fields = query('textarea,[contenteditable="true"],[role="textbox"]')
    .filter(visible)
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
  const field = fields[0] || null;
  const promptValue = field
    ? normalizeEditorText(field.tagName === "TEXTAREA" || field.tagName === "INPUT" ? field.value || "" : field.innerText ?? field.textContent ?? "")
    : null;
  const buttons = query('button,[role="button"]').filter(visible);
  const send = buttons.find(exactSendLabel) || null;
  const stopResponseCount = buttons.filter((element) => labels(element).some((value) => /^(?:stop response|stop generating|응답 중지|생성 중지)(?: button| 버튼)?$/i.test(value))).length;
  const userMessageNodes = query([
    "user-query",
    '[data-message-author-role="user"]',
    '[data-test-id*="user-query"]',
    '[data-testid*="user-query"]',
    '[class*="user-query"]',
    '[class*="user-message"]',
    '[class*="query-content"]'
  ].join(","));
  const userMessageMatchCount = userMessageNodes.filter((element) => {
    if (!visible(element) || element === field || element.contains?.(field)) return false;
    const value = normalizeEditorText(element.innerText ?? element.textContent ?? "");
    return value === expectedPrompt;
  }).length;
  const generationNodes = query([
    "model-response",
    '[data-test-id*="model-response"]',
    '[data-testid*="model-response"]',
    '[class*="model-response"]',
    '[role="progressbar"]',
    '[aria-busy="true"]',
    "video",
    'a[href*="download"]',
    'a[href$=".mp4"]'
  ].join(",")).filter(visible);
  const generationEvidenceKeys = generationNodes.map((element, index) => {
    const href = element.href || element.getAttribute?.("href") || "";
    const source = element.currentSrc || element.src || element.getAttribute?.("src") || "";
    const label = labels(element).join(" ").slice(0, 160);
    return `${String(element.tagName || "node").toLowerCase()}:${href || source || label || index}`;
  });
  const conversationUrl = /gemini\.google\.com\/app\/[^/?#]+/i.test(String(currentHref)) ? String(currentHref) : null;
  return {
    promptFieldVisible: Boolean(field),
    promptValue,
    sendPresent: Boolean(send),
    sendEnabled: Boolean(send && !disabled(send)),
    sendLabel: send ? labels(send).join(" ") : null,
    userMessageMatchCount,
    stopResponseCount,
    generationEvidenceCount: generationNodes.length,
    generationEvidenceKeys,
    conversationUrl
  };
}

export function geminiPromptSubmissionEvidence(prompt, baseline = {}, observation = {}) {
  const expectedPrompt = String(prompt ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
  const baselineKeys = new Set(Array.isArray(baseline.generationEvidenceKeys) ? baseline.generationEvidenceKeys : []);
  const currentKeys = Array.isArray(observation.generationEvidenceKeys) ? observation.generationEvidenceKeys : [];
  const userMessageAppeared = Number(observation.userMessageMatchCount || 0) > Number(baseline.userMessageMatchCount || 0);
  const stopResponseAppeared = Number(observation.stopResponseCount || 0) > Number(baseline.stopResponseCount || 0);
  const generationEvidenceAppeared = Number(observation.generationEvidenceCount || 0) > Number(baseline.generationEvidenceCount || 0)
    || currentKeys.some((key) => !baselineKeys.has(key))
    || Boolean(observation.conversationUrl && observation.conversationUrl !== baseline.conversationUrl);
  const evidenceTypes = [
    userMessageAppeared ? "user-message" : null,
    stopResponseAppeared ? "stop-response" : null,
    generationEvidenceAppeared ? "generation" : null
  ].filter(Boolean);
  const promptCleared = observation.promptFieldVisible === true && observation.promptValue === "";
  const exactPromptRetained = observation.promptFieldVisible === true && observation.promptValue === expectedPrompt;
  return {
    verified: promptCleared && evidenceTypes.length > 0,
    promptCleared,
    exactPromptRetained,
    hasNewEvidence: evidenceTypes.length > 0,
    evidenceTypes,
    sendEnabled: observation.sendEnabled === true
  };
}

export function geminiPromptRetryDecision(prompt, format, baseline = {}, observation = {}, ratioEvidence = {}) {
  const submission = geminiPromptSubmissionEvidence(prompt, baseline, observation);
  if (submission.hasNewEvidence) return { eligible: false, reason: "submission-evidence-observed", submission };
  if (!submission.exactPromptRetained) return { eligible: false, reason: "exact-prompt-not-retained", submission };
  if (!submission.sendEnabled) return { eligible: false, reason: "send-control-not-enabled", submission };
  if (ratioEvidence.configured !== true || ratioEvidence.contradiction === true) {
    return {
      eligible: false,
      reason: `${format === "vertical" ? "portrait" : "landscape"}-ratio-unverified`,
      submission
    };
  }
  return { eligible: true, reason: "safe-bounded-retry", submission };
}

export async function confirmGeminiPromptSubmission({
  prompt,
  format = "vertical",
  observe,
  initialClick,
  retryClick,
  sleepFn = sleep,
  pollsPerWindow = 32,
  pollIntervalMs = 250,
  maxClickAttempts = 2
}) {
  if (typeof observe !== "function" || typeof initialClick !== "function" || typeof retryClick !== "function") {
    throw new TypeError("Gemini 제출 확인에는 observe, initialClick, retryClick 함수가 필요합니다.");
  }
  const baseline = await observe();
  const expectedPrompt = String(prompt ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
  if (baseline?.promptFieldVisible !== true || baseline.promptValue !== expectedPrompt) {
    return { submitted: false, reason: "exact-prompt-not-ready", clickCount: 0, baseline };
  }
  const firstClick = await initialClick();
  if (firstClick?.clicked !== true) {
    return { submitted: false, reason: firstClick?.reason || "initial-submit-control-unavailable", clickCount: 0, baseline, click: firstClick || null };
  }

  let clickCount = 1;
  let evidenceObserved = false;
  const evidenceTypes = new Set();
  let lastObservation = baseline;
  let lastSubmission = geminiPromptSubmissionEvidence(prompt, baseline, baseline);
  const windows = Math.max(1, Number(maxClickAttempts) || 1);
  const polls = Math.max(1, Number(pollsPerWindow) || 1);

  for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
    for (let pollIndex = 0; pollIndex < polls; pollIndex += 1) {
      lastObservation = await observe();
      lastSubmission = geminiPromptSubmissionEvidence(prompt, baseline, lastObservation);
      for (const type of lastSubmission.evidenceTypes) evidenceTypes.add(type);
      evidenceObserved ||= lastSubmission.hasNewEvidence;
      if (lastSubmission.promptCleared && evidenceObserved) {
        return {
          submitted: true,
          verified: true,
          method: firstClick.method || "button",
          clickCount,
          evidenceTypes: [...evidenceTypes],
          observation: lastObservation
        };
      }
      if (pollIndex + 1 < polls) await sleepFn(pollIntervalMs);
    }

    if (evidenceObserved) {
      if (windowIndex + 1 < windows) continue;
      break;
    }
    if (clickCount >= windows) break;
    const retry = await retryClick({ baseline, observation: lastObservation, clickCount });
    if (retry?.evidence?.hasNewEvidence) {
      for (const type of retry.evidence.evidenceTypes || []) evidenceTypes.add(type);
      evidenceObserved = true;
      lastObservation = retry.observation || lastObservation;
      continue;
    }
    if (retry?.clicked !== true) {
      return {
        submitted: false,
        reason: retry?.reason || "bounded-retry-rejected",
        clickCount,
        evidenceTypes: [...evidenceTypes],
        observation: retry?.observation || lastObservation
      };
    }
    clickCount += 1;
  }

  return {
    submitted: false,
    reason: evidenceObserved
      ? "submission-evidence-without-cleared-input"
      : lastSubmission.promptCleared
        ? "prompt-cleared-without-submission-evidence"
        : "submission-unverified",
    clickCount,
    evidenceTypes: [...evidenceTypes],
    observation: lastObservation
  };
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

async function inspectPromptSubmission(browser, prompt) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    return stateFor(${JSON.stringify(String(prompt))}, document, location.href);
  })()`);
}

async function clickPromptSubmit(browser, prompt) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    const expectedPrompt = ${JSON.stringify(String(prompt))};
    const observation = stateFor(expectedPrompt, document, location.href);
    if (!observation.promptFieldVisible || observation.promptValue !== expectedPrompt) {
      return { clicked: false, reason: 'exact-prompt-not-ready', observation };
    }
    if (!observation.sendEnabled) {
      return { clicked: false, reason: observation.sendPresent ? 'send-control-disabled' : 'send-control-missing', observation };
    }
    const visible = (element) => { const rect = element?.getBoundingClientRect?.(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
    const labels = (element) => [element?.innerText, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
    const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
    const send = [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(exactSendLabel);
    if (!send) return { clicked: false, reason: 'send-control-missing', observation };
    send.click();
    return { clicked: true, method: 'button', label: labels(send).join(' '), observation };
  })()`);
}

async function retryPromptSubmit(browser, prompt, format, baseline) {
  return browser.evaluate(`(() => {
    const stateFor = ${geminiPromptSubmissionDomState.toString()};
    const geminiPromptSubmissionEvidence = ${geminiPromptSubmissionEvidence.toString()};
    const retryFor = ${geminiPromptRetryDecision.toString()};
    const ratioEvidenceFor = ${geminiAspectRatioEvidence.toString()};
    const expectedPrompt = ${JSON.stringify(String(prompt))};
    const requestedFormat = ${JSON.stringify(format)};
    const baseline = ${JSON.stringify(baseline)};
    const visible = (element) => { const rect = element?.getBoundingClientRect?.(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
    const labels = (element) => [element?.innerText, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
    const text = (element) => labels(element).join(' ').trim().toLowerCase();
    const ratioLabel = (element) => /aspect ratio|가로세로|화면비|landscape|portrait|가로 모드|세로 모드|9\\s*[:/x×]\\s*16|16\\s*[:/x×]\\s*9/i.test(text(element));
    const ratioOptionElement = (element) => element.matches('input-companion-item,[role="menuitemradio"],[role="radio"],[role="option"]')
      || Boolean(element.closest('[role="menu"],[role="listbox"]'));
    const selected = (element) => {
      if (typeof element.checked === 'boolean' && element.checked === true) return true;
      return [element.getAttribute('aria-checked'), element.getAttribute('aria-selected'), element.getAttribute('data-state')]
        .some((value) => /^(?:true|checked|selected|on)$/i.test(value || ''));
    };
    const controls = [...document.querySelectorAll('button,[role="button"]')].filter((element) => visible(element) && !ratioOptionElement(element));
    const ratioControl = controls.find((element) => /aspect ratio|가로세로|화면비/i.test(text(element))) || controls.find(ratioLabel) || null;
    const options = [...document.querySelectorAll('input-companion-item,[role="menuitemradio"],[role="radio"],button,[role="option"]')]
      .filter((element) => visible(element) && ratioLabel(element))
      .map((element) => ({ label: text(element), selected: selected(element) }));
    const ratioVerification = ratioEvidenceFor(requestedFormat, { controlLabel: ratioControl ? text(ratioControl) : '', options });
    const observation = stateFor(expectedPrompt, document, location.href);
    const decision = retryFor(expectedPrompt, requestedFormat, baseline, observation, ratioVerification);
    if (!decision.eligible) {
      return { clicked: false, reason: decision.reason, observation, evidence: decision.submission, ratioVerification };
    }
    const exactSendLabel = (element) => labels(element).some((value) => /^(?:send(?: message)?|send message button|보내기|메시지 보내기|보내기 버튼)$/i.test(value));
    const send = [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(exactSendLabel);
    if (!send) return { clicked: false, reason: 'send-control-missing', observation, evidence: decision.submission, ratioVerification };
    send.click();
    return { clicked: true, method: 'button', label: labels(send).join(' '), observation, evidence: decision.submission, ratioVerification };
  })()`);
}

async function submitPrompt(browser, prompt, format) {
  return confirmGeminiPromptSubmission({
    prompt,
    format,
    observe: () => inspectPromptSubmission(browser, prompt),
    initialClick: () => clickPromptSubmit(browser, prompt),
    retryClick: ({ baseline }) => retryPromptSubmit(browser, prompt, format, baseline)
  });
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
    const quotaMessage = geminiVideoQuotaMessage(media.body);
    if (quotaMessage) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${quotaMessage}`);
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
  let config = null;
  let version = null;
  let policy = null;
  try {
    config = browserConfig(input);
    policy = resolveGeminiChromeLaunchPolicy();
    version = await getVersion(config.cdpUrl);
    const runtime = assertGeminiChromeRuntime(version, policy);
    return {
      connected: true,
      browser: version.Browser || "Chrome",
      chromeMajor: runtime.chromeMajor,
      headless: runtime.actualHeadless,
      requestedHeadless: policy.headless,
      mode: runtime.mode,
      cdpUrl: config.cdpUrl,
      profileDir: config.profileDir
    };
  } catch (error) {
    return {
      connected: false,
      browser: version?.Browser || null,
      headless: version ? isHeadlessChromeVersion(version) : null,
      requestedHeadless: policy?.headless ?? null,
      cdpUrl: config?.cdpUrl || null,
      profileDir: config?.profileDir || null,
      message: error.message
    };
  }
}

export async function geminiQuotaStatus(input = {}) {
  const config = browserConfig(input);
  let browser = null;
  try {
    browser = await connectBrowser(config);
    await browser.navigate("https://gemini.google.com/videos");
    const observation = await browser.evaluate(`(() => {
      const quotaMessageFor = ${geminiVideoQuotaMessage.toString()};
      const body = document.body?.innerText || "";
      const quotaMessage = quotaMessageFor(body);
      const quotaResetText = body.match(/[^\\n]*(?:다시 생성할 수 있습니다|videos will be available again)[^\\n]*/i)?.[0]?.trim() || null;
      const account = [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") || "").find((value) => /Google (?:Account|계정)(?::|\\s)/i.test(value)) || null;
      const signInRequired = [...document.querySelectorAll("a,button,[role='button']")].some((el) => /로그인|sign in/i.test([el.innerText, el.getAttribute('aria-label')].filter(Boolean).join(' ')) && /accounts\\.google\\.com/i.test(el.href || el.closest('a')?.href || ''));
      const videoMode = /동영상 만들기|create videos?/i.test(body);
      return {
        available: videoMode && !quotaMessage && !signInRequired,
        quotaMessage,
        quotaResetText,
        account,
        authentication: account ? "authenticated" : signInRequired ? "sign-in-required" : "unknown",
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
      headless: isHeadlessChromeVersion(browser.version),
      requestedHeadless: resolveGeminiChromeLaunchPolicy().headless,
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
  const resumeScriptHash = canonicalGeminiResumeScriptHash(script);
  const launchPolicy = resolveGeminiChromeLaunchPolicy();
  const runtime = assertGeminiChromeRuntime(browser.version, launchPolicy);
  const actualHeadless = runtime.actualHeadless;
  const requestHash = hashJson({ ...requestPayload, scriptHash });
  const resumeRequestHash = hashJson({ ...requestPayload, scriptHash: resumeScriptHash });
  const providerDecision = {
    requested: "gemini-browser",
    selected: "gemini-browser",
    fallbackUsed: false,
    policy: "no-local-video-fallback"
  };
  const providerDecisionHash = hashJson(providerDecision);
  const sessionBinding = canonicalGeminiSessionBinding(job);
  const sessionBindingHash = geminiSessionBindingHash(job);
  if (!sessionBinding || !sessionBindingHash) throw new Error("Gemini 실행 세션을 안전하게 결속할 수 없습니다.");
  const providerAttestation = {
    type: "gemini-chrome-session",
    provider: "gemini-browser",
    browser: browser.version.Browser || null,
    sessionBinding,
    sessionBindingHash,
    persistentProfile: true,
    headless: actualHeadless,
    headlessRequested: launchPolicy.headless,
    chromeMajor: runtime.chromeMajor,
    headlessImplementation: launchPolicy.headlessImplementation,
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
    schemaVersion: 3,
    jobId: job.id,
    provider: "gemini-browser",
    sessionBinding,
    sessionBindingHash,
    browser: browser.version.Browser || null,
    startedAt: new Date().toISOString(),
    status: "running",
    runId: job.runId || null,
    requestHash,
    scriptHash,
    resumeRequestHash,
    resumeScriptHash,
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
  const bindingMatches = previousGeneration?.resumeRequestHash === resumeRequestHash
    && previousGeneration?.resumeScriptHash === resumeScriptHash;
  const resumeSessionMatches = previousGeneration?.provider === "gemini-browser"
    && previousGeneration.providerDecisionHash === providerDecisionHash
    && previousGeneration.providerAttestationHash === providerAttestationHash
    && previousGeneration.sessionBindingHash === sessionBindingHash
    && hashJson(previousGeneration.sessionBinding) === sessionBindingHash;
  const previousSegmentsBound = Boolean(
    previousGeneration?.runId
    && previousGeneration?.requestHash
    && previousGeneration?.scriptHash
    && previousGeneration?.resumeRequestHash
    && previousGeneration?.resumeScriptHash
    && Array.isArray(previousGeneration?.segments)
    && previousGeneration.segments.every((segment) => (
      segment.runId === previousGeneration.runId
      && segment.requestHash === previousGeneration.requestHash
      && segment.scriptHash === previousGeneration.scriptHash
      && segment.resumeRequestHash === previousGeneration.resumeRequestHash
      && segment.resumeScriptHash === previousGeneration.resumeScriptHash
      && segment.providerDecisionHash === previousGeneration.providerDecisionHash
      && segment.providerAttestationHash === previousGeneration.providerAttestationHash
      && segment.path === segment.output
    ))
  );
  const canResumePartial = previousGeneration?.status === "failed"
    && Array.isArray(previousGeneration.segments)
    && previousGeneration.segments.length > 0
    && bindingMatches
    && resumeSessionMatches
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
          resumeRequestHash,
          resumeScriptHash,
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
      if (tool.authRequired) throw new Error("Gemini 전용 프로필의 로그인 세션이 만료되었습니다. GEMINI_CHROME_HEADLESS=0으로 같은 프로필을 열어 직접 로그인한 뒤 headless로 다시 시작하세요.");
      if (tool.quota) throw new Error(`Gemini 동영상 생성 할당량이 소진되었습니다. ${tool.quotaMessage || "할당량 갱신이 필요합니다."}`);
      if (!tool.clicked) throw new Error(`Gemini 동영상 도구를 찾지 못했습니다. 화면에 "동영상 만들기"가 활성화되어 있는지 확인하세요. 감지된 버튼: ${(tool.buttons || []).join(", ")}`);
      if (tool.ratioConfigured !== true) throw new Error(`Gemini에서 ${job.format === "vertical" ? "세로 9:16" : "가로 16:9"} 화면비를 선택하지 못했습니다. 생성 요청을 보내지 않고 재시도합니다.`);
      const prompt = `Create a ${job.format === "vertical" ? "vertical 9:16" : "16:9"} cinematic documentary video clip, exactly about ${segment.durationHint || Math.round(job.targetDurationSec / Math.max(1, script.segments.length))} seconds. ${segment.visualPrompt}. Keep the subject physically plausible and visually consistent across clips. Use the same camera language, color grade, subject identity, and documentary pacing as the other clips. No on-screen text, no subtitles, and no third-party logos. Retain any provider-required provenance mark. Korean documentary mood.`;
      const filled = await fillPrompt(browser, prompt);
      if (!filled.filled) throw new Error("Gemini 입력창을 찾지 못했습니다.");
      const submissionRatio = await verifyVideoAspectRatio(browser, job.format);
      if (submissionRatio?.configured !== true) {
        throw new Error(`Gemini에서 ${job.format === "vertical" ? "세로 9:16" : "가로 16:9"} 화면비의 선택 상태를 전송 직전에 확인하지 못했습니다. 생성 요청을 보내지 않고 재시도합니다.`);
      }
      const known = await inspectMedia(browser);
      const knownMedia = {
        videos: new Set((known.videos || []).map((video) => video.src).filter(Boolean)),
        links: new Set((known.links || []).map((item) => item.href).filter(Boolean)),
        chats: new Set((known.chats || []).map((item) => item.href).filter(Boolean))
      };
      const submitted = await submitPrompt(browser, prompt, job.format);
      if (!submitted.submitted || submitted.verified !== true) {
        throw new Error(`Gemini 영상 요청 전송을 확인하지 못했습니다 (${submitted.reason || "authoritative-submit-evidence-missing"}). 입력창 초기화와 사용자 메시지·응답 중지·생성 상태 중 하나를 함께 확인해야 합니다.`);
      }
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
        resumeRequestHash,
        resumeScriptHash,
        durationHint: segment.durationHint || null,
        prompt,
        submissionAcknowledgement: {
          verified: true,
          clickCount: submitted.clickCount,
          evidenceTypes: submitted.evidenceTypes
        },
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
export async function startGeminiBrowser(input = {}) {
  const config = browserConfig(input);
  const policy = resolveGeminiChromeLaunchPolicy();
  let version;
  try {
    version = await getVersion(config.cdpUrl);
  } catch {
    version = await startChrome(config);
    const startedRuntime = assertGeminiChromeRuntime(version, policy);
    return { connected: true, started: true, browser: version.Browser || "Chrome", headless: startedRuntime.actualHeadless, requestedHeadless: policy.headless, chromeMajor: startedRuntime.chromeMajor };
  }
  const runtime = assertGeminiChromeRuntime(version, policy);
  return { connected: true, started: false, browser: version.Browser || "Chrome", headless: runtime.actualHeadless, requestedHeadless: policy.headless, chromeMajor: runtime.chromeMajor };
}
