import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let temporary;
  try {
    temporary = await open(tempPath, "wx", 0o600);
    await temporary.writeFile(JSON.stringify(value, null, 2));
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await rename(tempPath, path);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await temporary?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  const file = Bun.file(path);
  const stream = file.stream();
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function appendRunEvent(runDir, event) {
  await mkdir(runDir, { recursive: true });
  const record = { timestamp: new Date().toISOString(), ...event };
  const eventPath = join(runDir, "events.jsonl");
  const file = await open(
    eventPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    0o600
  );
  try {
    const fileStat = await file.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.nlink !== 1n) {
      throw new Error("run event ledger가 exclusive regular non-symlink file이 아닙니다.");
    }
    await file.write(`${JSON.stringify(record)}\n`);
    await file.sync();
    const afterWrite = await file.stat({ bigint: true });
    if (
      !afterWrite.isFile()
      || afterWrite.nlink !== 1n
      || afterWrite.dev !== fileStat.dev
      || afterWrite.ino !== fileStat.ino
    ) throw new Error("run event ledger inode가 append 중 변경되었습니다.");
  } finally {
    await file.close();
  }
  const directory = await open(runDir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return record;
}

export async function readRunManifest(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function writeRunManifest(runDir, manifest) {
  await writeJsonAtomic(join(runDir, "manifest.json"), manifest);
  return manifest;
}

export async function artifactReceipt(jobDir, artifacts = []) {
  const receipt = [];
  for (const artifact of artifacts) {
    const path = join(jobDir, artifact.name);
    try {
      const fileStat = await stat(path);
      receipt.push({ ...artifact, path: artifact.name, bytes: fileStat.size, sha256: await hashFile(path) });
    } catch {
      receipt.push({ ...artifact, path: artifact.name, bytes: 0, sha256: null, missing: true });
    }
  }
  return receipt;
}
