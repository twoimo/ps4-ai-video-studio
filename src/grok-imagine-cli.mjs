import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { GROK_AUTH_ERROR, GROK_MISSING_ERROR } from "./grok-imagine-factory.mjs";

const FORBIDDEN_ARGS = new Set(["login", "logout", "--login", "--logout"]);
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
let grokQueue = Promise.resolve();

export function resolveGrokBinary(env = process.env, whichImpl = null) {
  const override = String(env.PS4_GROK_BIN || "").trim();
  if (override && existsSync(override)) return override;
  const which = whichImpl || defaultWhich;
  const onPath = which("grok");
  if (onPath && existsSync(onPath)) return onPath;
  const home = env.HOME || homedir();
  const fallback = join(home, ".grok", "bin", "grok");
  if (existsSync(fallback)) return fallback;
  return null;
}

function defaultWhich(command) {
  if (typeof globalThis.Bun?.which === "function") return globalThis.Bun.which(command);
  return null;
}

export function grokEnv(base = process.env) {
  const env = { ...base };
  delete env.XAI_API_KEY;
  delete env.xai_api_key;
  delete env.Xai_Api_Key;
  return env;
}

export function grokImagineArgs({ prompt, cwd, tools = [] } = {}) {
  const args = [
    "--no-auto-update",
    "--no-alt-screen",
    "--always-approve",
    "--verbatim",
    "--disable-web-search",
    "--output-format",
    "json",
    "--cwd",
    cwd,
    "-p",
    prompt
  ];
  if (tools.length) args.push("--tools", tools.join(","));
  if (args.some((arg) => FORBIDDEN_ARGS.has(String(arg).toLowerCase()))) {
    throw new Error("공식 grok CLI에 login/logout을 넘기지 않습니다.");
  }
  return args;
}

export function assertSafeGrokInvocation({ binary, args, env } = {}) {
  if (!binary) throw new Error(GROK_MISSING_ERROR);
  if (/login|logout/i.test(String(binary))) throw new Error("공식 grok CLI에 login/logout을 넘기지 않습니다.");
  if ((args || []).some((arg) => FORBIDDEN_ARGS.has(String(arg).toLowerCase()))) {
    throw new Error("공식 grok CLI에 login/logout을 넘기지 않습니다.");
  }
  if (env && (env.XAI_API_KEY || env.xai_api_key)) {
    throw new Error("공식 grok CLI에 XAI_API_KEY를 넘기지 않습니다. SuperGrok OAuth만 사용합니다.");
  }
  return true;
}

export function parseSavedPath(stdout = "") {
  const text = String(stdout || "");
  const saved = text.match(/SAVED:\s*(\S+)/);
  if (saved?.[1]) return saved[1].trim();
  try {
    const payload = JSON.parse(text.trim());
    return payload.saved || payload.path || payload.output || null;
  } catch {
    return null;
  }
}

export function buildImaginePrompt({ tool, outputPath, visualPrompt, referencePath = null }) {
  const reference = referencePath ? `Reference image path: ${referencePath}.` : "";
  return [
    `Use ONLY the ${tool} tool.`,
    tool === "image_edit" || tool === "image_to_video" ? "Never call image_gen." : "This is the canonical hook still.",
    reference,
    `Save the result to this exact path: ${outputPath}`,
    `Print SAVED: ${outputPath}`,
    "Aspect 9:16.",
    visualPrompt
  ].filter(Boolean).join("\n");
}

export async function withGrokLock(task) {
  const run = grokQueue.then(task, task);
  grokQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function extractGrokText(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return "";
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const payload = JSON.parse(line);
      const candidate = payload.message || payload.text || payload.content || payload.result || payload.output;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === "object") {
        const nested = candidate.text || candidate.content || candidate.message;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    } catch {
      // Keep scanning JSON lines from the official grok CLI.
    }
  }
  return text;
}

export async function runGrokImagine(options = {}) {
  const {
    prompt,
    cwd,
    tools,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env: inputEnv = process.env,
    spawnImpl = spawn,
    whichImpl = null,
    binary: binaryOverride = null
  } = options;
  const binary = binaryOverride || resolveGrokBinary(inputEnv, whichImpl);
  if (!binary) throw new Error(GROK_MISSING_ERROR);
  const env = grokEnv(inputEnv);
  const args = grokImagineArgs({ prompt, cwd, tools });
  assertSafeGrokInvocation({ binary, args, env });
  return withGrokLock(() => spawnGrok({ binary, args, env, cwd, timeoutMs, spawnImpl }));
}

export async function runGrokText(options = {}) {
  const prompt = String(options.prompt || "");
  if (/Use ONLY the (image_gen|image_edit|image_to_video) tool/i.test(prompt)) {
    throw new Error("텍스트 대본에는 Imagine 도구를 쓰지 않습니다. Gemini로 대체하지 않습니다.");
  }
  return runGrokImagine({
    ...options,
    tools: [],
    timeoutMs: options.timeoutMs || 90_000
  });
}

function spawnGrok({ binary, args, env, cwd, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${GROK_MISSING_ERROR} (${error.message})`));
      return;
    }
    const timer = setTimeout(() => {
      child.kill?.();
      finish(new Error(`공식 grok CLI 시간이 초과되었습니다 (${timeoutMs}ms). Gemini로 대체하지 않습니다.`));
    }, timeoutMs);
    child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (error) => finish(new Error(`${GROK_MISSING_ERROR} (${error.message})`)));
    child.on?.("close", (code) => {
      if (code !== 0) {
        const detail = `${stderr}\n${stdout}`.toLowerCase();
        if (/not signed in|not authenticated|authorizationrequired|unauthoriz/i.test(detail)) {
          finish(new Error(GROK_AUTH_ERROR));
          return;
        }
        finish(new Error(`공식 grok CLI 실행 실패 (${code}): ${(stderr || stdout).trim().slice(-1200)}`));
        return;
      }
      finish(null, { stdout, stderr, savedPath: parseSavedPath(stdout) });
    });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
  });
}
