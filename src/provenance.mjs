import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const GEMINI_MIN_NEW_HEADLESS_CHROME_MAJOR = 109;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function canonicalJsonHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

export function canonicalGeminiSessionBinding(job) {
  const cdpUrl = String(job?.geminiCdpUrl || "").trim();
  const profileDir = String(job?.geminiProfileDir || "").trim();
  if (!cdpUrl || !profileDir) return null;
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.port) return null;
  const resolvedProfile = resolve(profileDir);
  return {
    schemaVersion: 1,
    cdpOrigin: parsed.origin,
    profileBasename: basename(resolvedProfile),
    profilePathHash: canonicalJsonHash({ type: "gemini-chrome-profile-path", path: resolvedProfile })
  };
}

export function geminiSessionBindingHash(job) {
  const binding = canonicalGeminiSessionBinding(job);
  return binding ? canonicalJsonHash(binding) : null;
}

function exactArgument(argumentsList, prefix, expected) {
  const matches = argumentsList.filter((argument) => argument === prefix || argument.startsWith(`${prefix}=`));
  return matches.length === 1 && matches[0] === expected;
}

function observedChromeMajor(version = {}) {
  const text = `${version.product || version.Browser || ""} ${version.userAgent || version["User-Agent"] || ""}`;
  const match = text.match(/(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function observedHeadlessChrome(version = {}) {
  return /HeadlessChrome\//i.test(`${version.product || version.Browser || ""} ${version.userAgent || version["User-Agent"] || ""}`);
}

/**
 * Convert the two authoritative browser-scope CDP observations into a
 * privacy-safe receipt. Raw command-line arguments (including the profile
 * path) never leave this boundary; only exact-match facts and hashes do.
 */
export function canonicalGeminiObservedRuntimeProof({ job, version, commandLine }) {
  const binding = canonicalGeminiSessionBinding(job);
  if (!binding) throw new Error("Gemini observed runtime의 세션 결속을 확인할 수 없습니다.");
  const argumentsList = commandLine?.arguments;
  if (!Array.isArray(argumentsList) || argumentsList.length < 1 || argumentsList.length > 4_096
    || argumentsList.some((argument) => typeof argument !== "string" || argument.length > 32_768 || /[\u0000\r\n]/u.test(argument))) {
    throw new Error("CDP Browser.getBrowserCommandLine 응답이 올바르지 않습니다.");
  }
  const profilePath = resolve(String(job?.geminiProfileDir || ""));
  const parsedOrigin = new URL(binding.cdpOrigin);
  const remotePort = parsedOrigin.port;
  if (!exactArgument(argumentsList, "--user-data-dir", `--user-data-dir=${profilePath}`)) {
    throw new Error("실제 Chrome --user-data-dir가 저장된 Gemini 전용 프로필과 정확히 일치하지 않습니다.");
  }
  if (!exactArgument(argumentsList, "--remote-debugging-port", `--remote-debugging-port=${remotePort}`)) {
    throw new Error("실제 Chrome remote debugging port가 저장된 Gemini CDP port와 정확히 일치하지 않습니다.");
  }
  if (!exactArgument(argumentsList, "--remote-debugging-address", "--remote-debugging-address=127.0.0.1")
    || argumentsList.some((argument) => argument === "--remote-debugging-pipe" || argument.startsWith("--remote-debugging-pipe="))) {
    throw new Error("실제 Chrome remote debugging endpoint가 loopback TCP로 정확히 제한되지 않았습니다.");
  }
  const headlessArguments = argumentsList.filter((argument) => argument === "--headless" || argument.startsWith("--headless="));
  if (headlessArguments.length !== 1 || headlessArguments[0] !== "--headless=new") {
    throw new Error("Gemini 생성에는 실제 Chrome --headless=new 명령행 증명이 필요합니다.");
  }
  const chromeMajor = observedChromeMajor(version);
  if (!Number.isInteger(chromeMajor) || chromeMajor < GEMINI_MIN_NEW_HEADLESS_CHROME_MAJOR || !observedHeadlessChrome(version)) {
    throw new Error(`Gemini 생성에는 Chrome ${GEMINI_MIN_NEW_HEADLESS_CHROME_MAJOR} 이상의 실제 new headless runtime 증명이 필요합니다.`);
  }
  const browserVersion = {
    product: String(version?.product || version?.Browser || ""),
    userAgent: String(version?.userAgent || version?.["User-Agent"] || ""),
    protocolVersion: String(version?.protocolVersion || version?.["Protocol-Version"] || "") || null,
    revision: String(version?.revision || "") || null
  };
  return {
    schemaVersion: 1,
    method: "cdp-browser-get-command-line-and-version",
    sessionBindingHash: canonicalJsonHash(binding),
    cdpOriginHash: canonicalJsonHash({ type: "gemini-cdp-origin", origin: binding.cdpOrigin }),
    profilePathHash: binding.profilePathHash,
    remoteDebuggingAddress: "127.0.0.1",
    remoteDebuggingPort: remotePort,
    headless: true,
    headlessImplementation: "new",
    chromeMajor,
    browserVersionHash: canonicalJsonHash(browserVersion),
    commandLineHash: canonicalJsonHash({ type: "gemini-browser-command-line", arguments: argumentsList })
  };
}

export function geminiObservedRuntimeProofHash(proof) {
  return canonicalJsonHash(proof);
}

export function validateGeminiObservedRuntimeProof(proof, job) {
  const binding = job?.schemaVersion === 1
    && typeof job?.cdpOrigin === "string"
    && typeof job?.profilePathHash === "string"
    ? job
    : canonicalGeminiSessionBinding(job);
  if (!binding || !proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const expectedKeys = [
    "browserVersionHash",
    "cdpOriginHash",
    "chromeMajor",
    "commandLineHash",
    "headless",
    "headlessImplementation",
    "method",
    "profilePathHash",
    "remoteDebuggingAddress",
    "remoteDebuggingPort",
    "schemaVersion",
    "sessionBindingHash"
  ];
  const hashPattern = /^sha256:[a-f0-9]{64}$/;
  return JSON.stringify(Object.keys(proof).sort()) === JSON.stringify(expectedKeys.sort())
    && proof.schemaVersion === 1
    && proof.method === "cdp-browser-get-command-line-and-version"
    && proof.sessionBindingHash === canonicalJsonHash(binding)
    && proof.cdpOriginHash === canonicalJsonHash({ type: "gemini-cdp-origin", origin: binding.cdpOrigin })
    && proof.profilePathHash === binding.profilePathHash
    && proof.remoteDebuggingAddress === "127.0.0.1"
    && proof.remoteDebuggingPort === new URL(binding.cdpOrigin).port
    && proof.headless === true
    && proof.headlessImplementation === "new"
    && Number.isInteger(proof.chromeMajor)
    && proof.chromeMajor >= GEMINI_MIN_NEW_HEADLESS_CHROME_MAJOR
    && hashPattern.test(String(proof.browserVersionHash || ""))
    && hashPattern.test(String(proof.commandLineHash || ""));
}
