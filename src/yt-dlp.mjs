import { existsSync } from "node:fs";
import { join } from "node:path";

function executable() {
  const candidates = [process.env.YT_DLP_BINARY, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return typeof Bun.which === "function" ? Bun.which("yt-dlp") : null;
}

export async function ytDlpInfo() {
  const path = executable();
  if (!path) return { installed: false, path: null, version: null, maintenance: "brew install yt-dlp" };
  const processHandle = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
  const code = await processHandle.exited;
  return { installed: code === 0, path, version: code === 0 ? stdout.trim() : null, error: code === 0 ? null : stderr.trim(), maintenance: "brew upgrade yt-dlp" };
}

export function ytDlpCommand() {
  const path = executable();
  if (!path) throw new Error("yt-dlp가 설치되어 있지 않습니다. `brew install yt-dlp`를 실행하세요.");
  return path;
}
