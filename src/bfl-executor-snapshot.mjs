import { createHash } from "node:crypto";
import { chmod, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const BFL_EXECUTOR_SNAPSHOT_NAME = ".bfl-paid-executor.mjs";

const APPROVED_SOURCE_CLOSURE = new Set([
  "scripts/bfl-flux-video-generator.mjs",
  "src/bfl-executor-snapshot.mjs",
  "src/bfl-paid-approval.mjs",
  "src/dirfd-platform.mjs",
  "src/dirfd.mjs",
  "src/run-ledger.mjs"
]);

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function buildBflExecutorBytes(generatorPath, projectRoot) {
  const resolvedRoot = await realpath(resolve(projectRoot));
  const result = await Bun.build({
    entrypoints: [resolve(generatorPath)],
    target: "bun",
    format: "esm",
    minify: false,
    write: false,
    metafile: true,
    define: { "import.meta.dirname": JSON.stringify(join(resolvedRoot, "scripts")) }
  });
  if (!result.success || result.outputs.length !== 1 || result.logs.length) {
    throw new Error("승인된 BFL 실행기의 전이 소스 번들을 만들 수 없습니다.");
  }
  const inputs = Object.keys(result.metafile?.inputs || {}).map((value) => {
    const absolute = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
    return relative(resolvedRoot, absolute).replaceAll("\\", "/");
  });
  if (inputs.length !== APPROVED_SOURCE_CLOSURE.size || inputs.some((value) => !APPROVED_SOURCE_CLOSURE.has(value))) {
    throw new Error("BFL 실행기 전이 소스 closure가 승인된 파일 집합과 다릅니다.");
  }
  return Buffer.from(await result.outputs[0].arrayBuffer());
}

export async function buildBflExecutorSnapshotDigest(generatorPath, projectRoot) {
  return sha256Bytes(await buildBflExecutorBytes(generatorPath, projectRoot));
}

export async function persistBflExecutorSnapshot(jobDir, generatorPath, projectRoot, expectedHash) {
  const bytes = await buildBflExecutorBytes(generatorPath, projectRoot);
  const actualHash = sha256Bytes(bytes);
  if (actualHash !== expectedHash) throw new Error("BFL 실행기 전이 소스가 승인 뒤 변경되어 provider 실행을 차단했습니다.");
  const root = resolve(jobDir);
  const path = join(root, BFL_EXECUTOR_SNAPSHOT_NAME);
  const temporaryPath = join(root, `${BFL_EXECUTOR_SNAPSHOT_NAME}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o500);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, 0o500);
    await rename(temporaryPath, path);
    await syncDirectory(root);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  if (sha256Bytes(Buffer.from(await Bun.file(path).arrayBuffer())) !== expectedHash) {
    throw new Error("BFL 사설 실행기 스냅샷의 바이트 검증에 실패했습니다.");
  }
  return path;
}
