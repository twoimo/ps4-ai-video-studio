const brew = typeof Bun.which === "function" ? Bun.which("brew") : null;
if (!brew) throw new Error("Homebrew가 필요합니다. yt-dlp를 최신으로 유지하려면 Homebrew를 설치하세요.");
const processHandle = Bun.spawn([brew, "upgrade", "yt-dlp"], { stdout: "inherit", stderr: "inherit" });
const code = await processHandle.exited;
if (code !== 0) throw new Error(`yt-dlp 업데이트 실패 (${code})`);
const version = Bun.spawn([brew, "--prefix", "yt-dlp"], { stdout: "pipe", stderr: "pipe" });
const [stdout] = await Promise.all([new Response(version.stdout).text(), new Response(version.stderr).text()]);
console.log(`yt-dlp 유지 경로: ${stdout.trim()}`);
