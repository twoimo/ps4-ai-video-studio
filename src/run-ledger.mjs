import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, path);
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
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(record)}\n`);
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
