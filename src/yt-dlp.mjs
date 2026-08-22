import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_SUBPROCESS_ADMISSION_POLICY,
  runLocalSemanticProcess
} from "./local-semantic-verifier.mjs";

export const YT_DLP_VERSION_POLICY = Object.freeze({
  timeoutMs: 1_000,
  maximumOutputBytes: 16 * 1024,
  admissionTimeoutMs: 1_000
});

const YT_DLP_VERSION_UNAVAILABLE = Object.freeze({
  error: "yt-dlp version probe unavailable",
  errorCode: "YT_DLP_VERSION_PROBE_UNAVAILABLE"
});

function unavailableVersion(path) {
  return {
    installed: false,
    path,
    version: null,
    ...YT_DLP_VERSION_UNAVAILABLE,
    maintenance: "brew upgrade yt-dlp"
  };
}

function executable() {
  const candidates = [process.env.YT_DLP_BINARY, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return typeof Bun.which === "function" ? Bun.which("yt-dlp") : null;
}

export async function ytDlpInfo(options = {}) {
  const path = options.executablePath || executable();
  if (!path) return { installed: false, path: null, version: null, maintenance: "brew install yt-dlp" };
  if (typeof path !== "string" || !path || path.includes("\0") || !existsSync(path)) {
    throw new TypeError("yt-dlp 실행 경로가 올바르지 않습니다.");
  }
  const timeoutMs = options.timeoutMs ?? YT_DLP_VERSION_POLICY.timeoutMs;
  const maximumBytes = options.maximumOutputBytes ?? YT_DLP_VERSION_POLICY.maximumOutputBytes;
  const admissionTimeoutMs = options.admissionTimeoutMs ?? YT_DLP_VERSION_POLICY.admissionTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new TypeError("yt-dlp version timeout이 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > YT_DLP_VERSION_POLICY.maximumOutputBytes) {
    throw new TypeError("yt-dlp version 출력 상한이 올바르지 않습니다.");
  }
  if (
    !Number.isSafeInteger(admissionTimeoutMs)
    || admissionTimeoutMs < 1
    || admissionTimeoutMs > LOCAL_SUBPROCESS_ADMISSION_POLICY.waitTimeoutMs
  ) throw new TypeError("yt-dlp version admission timeout이 올바르지 않습니다.");
  const runProcess = options.runProcessFn || runLocalSemanticProcess;
  if (typeof runProcess !== "function") throw new TypeError("yt-dlp version runner가 올바르지 않습니다.");
  try {
    const result = await runProcess(path, ["--version"], {
      timeoutMs,
      maximumBytes,
      admissionTimeoutMs
    });
    const version = typeof result?.stdout === "string" ? result.stdout.trim() : "";
    if (!/^[0-9A-Za-z._+-]{1,128}$/u.test(version)) return unavailableVersion(path);
    return {
      installed: true,
      path,
      version,
      error: null,
      errorCode: null,
      maintenance: "brew upgrade yt-dlp"
    };
  } catch {
    return unavailableVersion(path);
  }
}

export function ytDlpCommand() {
  const path = executable();
  if (!path) throw new Error("yt-dlp가 설치되어 있지 않습니다. `brew install yt-dlp`를 실행하세요.");
  return path;
}
