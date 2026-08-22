import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  BFL_EXECUTOR_SNAPSHOT_NAME,
  buildBflExecutorSnapshotDigest,
  persistBflExecutorSnapshot
} from "../src/bfl-executor-snapshot.mjs";
import { preflightLocalVideoStorage, runLocalVideoExecutorSnapshot } from "../src/local-video-provider.mjs";
import { JOBS_DIR } from "../src/pipeline.mjs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTER_PATH = join(PROJECT_ROOT, "scripts", "bfl-flux-video-generator.mjs");
const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(prefix = "ps4-bfl-executor-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function copiedSourceClosure() {
  const root = await temporaryRoot("ps4-bfl-source-closure-");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await copyFile(ADAPTER_PATH, join(root, "scripts", "bfl-flux-video-generator.mjs"));
  await chmod(join(root, "scripts", "bfl-flux-video-generator.mjs"), 0o755);
  await Promise.all([
    "bfl-executor-snapshot.mjs", "bfl-paid-approval.mjs", "dirfd-platform.mjs", "dirfd.mjs", "run-ledger.mjs"
  ].map((name) => copyFile(join(PROJECT_ROOT, "src", name), join(root, "src", name))));
  return root;
}

describe("BFL paid executor immutable snapshot", () => {
  test("persists one deterministic self-contained bundle without configured credentials", async () => {
    const jobDir = await temporaryRoot();
    const secret = "bfl-private-test-key-never-bundled";
    const approvedHash = await buildBflExecutorSnapshotDigest(ADAPTER_PATH, PROJECT_ROOT);
    const path = await persistBflExecutorSnapshot(jobDir, ADAPTER_PATH, PROJECT_ROOT, approvedHash);
    const bytes = await readFile(path);
    expect(path).toBe(join(jobDir, BFL_EXECUTOR_SNAPSHOT_NAME));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(approvedHash);
    expect(bytes.toString("utf8")).not.toContain(secret);
    expect((await stat(path)).mode & 0o777).toBe(0o500);
  });

  test("blocks a transitive module mutation made after approval before a runnable snapshot exists", async () => {
    const root = await copiedSourceClosure();
    const generator = join(root, "scripts", "bfl-flux-video-generator.mjs");
    const jobDir = join(root, "workspace", "jobs", "job-transitive-mutation");
    await mkdir(jobDir, { recursive: true });
    const approvedHash = await buildBflExecutorSnapshotDigest(generator, root);
    const ledgerPath = join(root, "src", "run-ledger.mjs");
    await writeFile(ledgerPath, `${await readFile(ledgerPath, "utf8")}\nglobalThis.__postApprovalMutation = true;\n`);
    await expect(persistBflExecutorSnapshot(jobDir, generator, root, approvedHash))
      .rejects.toThrow("승인 뒤 변경");
    expect(await stat(join(jobDir, BFL_EXECUTOR_SNAPSHOT_NAME)).catch(() => null)).toBeNull();
  });

  test("executes the exact open descriptor when the snapshot pathname is replaced after verification", async () => {
    const root = await temporaryRoot();
    const snapshotPath = join(root, BFL_EXECUTOR_SNAPSHOT_NAME);
    const approvedBytes = Buffer.from("const chunks=[]; for await (const c of process.stdin) chunks.push(c); process.stdout.write(JSON.stringify({marker:'approved',input:Buffer.concat(chunks).toString('utf8')}));\n");
    await writeFile(snapshotPath, approvedBytes, { mode: 0o500 });
    const approvedHash = `sha256:${createHash("sha256").update(approvedBytes).digest("hex")}`;
    const secret = "fd-race-secret-never-exposed";
    const stdout = await runLocalVideoExecutorSnapshot(
      snapshotPath,
      { exact: "request" },
      { PATH: process.env.PATH, BFL_API_KEY: secret },
      approvedHash,
      {
        afterOpen: async () => {
          await rename(snapshotPath, `${snapshotPath}.approved`);
          await writeFile(snapshotPath, "process.stdout.write(process.env.BFL_API_KEY || 'replacement-ran');\n", { mode: 0o500 });
        }
      }
    );
    expect(JSON.parse(stdout)).toEqual({ marker: "approved", input: '{"exact":"request"}\n' });
    expect(stdout).not.toContain(secret);
  });
});

describe("local-video provider storage preflight", () => {
  test("rejects a symlinked clips or runs child before provider spawn or external mutation", async () => {
    for (const childName of ["clips", "runs"]) {
      const jobId = `provider-preflight-${childName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const runId = "run-1";
      const jobDir = join(JOBS_DIR, jobId);
      const external = await temporaryRoot(`ps4-provider-external-${childName}-`);
      const sentinel = join(external, "victim.bin");
      await writeFile(sentinel, "external-provider-bytes");
      await mkdir(jobDir, { recursive: true });
      if (childName === "clips") {
        await mkdir(join(jobDir, "runs", runId), { recursive: true });
      } else {
        await mkdir(join(jobDir, "clips"), { recursive: true });
      }
      await symlink(external, join(jobDir, childName));
      const beforeBytes = await readFile(sentinel);
      const beforeFileStat = await stat(sentinel, { bigint: true });
      const beforeDirStat = await stat(external, { bigint: true });
      try {
        await expect(preflightLocalVideoStorage(jobId, runId)).rejects.toMatchObject({ code: "LOCAL_VIDEO_STORAGE_UNSAFE" });
        expect(await readFile(sentinel)).toEqual(beforeBytes);
        const afterFileStat = await stat(sentinel, { bigint: true });
        expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
        expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
        expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
      } finally {
        await unlink(join(jobDir, childName)).catch(() => {});
        await rm(jobDir, { recursive: true, force: true });
      }
    }
  });

  test("rejects hard-linked provider snapshot, submit intent, and run receipt without external inode mutation", async () => {
    for (const targetKind of ["snapshot", "intent", "receipt"]) {
      const jobId = `provider-hardlink-${targetKind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const runId = "run-1";
      const jobDir = join(JOBS_DIR, jobId);
      const runDir = join(jobDir, "runs", runId);
      await mkdir(join(jobDir, "clips"), { recursive: true });
      await mkdir(runDir, { recursive: true });
      const targetPath = targetKind === "snapshot"
        ? join(jobDir, BFL_EXECUTOR_SNAPSHOT_NAME)
        : targetKind === "intent"
          ? join(jobDir, ".local-video-provider-submit-intent.json")
          : join(runDir, "local-video-generation.json");
      const external = await temporaryRoot(`ps4-provider-hardlink-${targetKind}-`);
      const sentinel = join(external, "victim.bin");
      await writeFile(sentinel, `external-provider-${targetKind}`);
      await link(sentinel, targetPath);
      const beforeBytes = await readFile(sentinel);
      const beforeFileStat = await stat(sentinel, { bigint: true });
      const beforeDirStat = await stat(external, { bigint: true });
      try {
        await expect(preflightLocalVideoStorage(jobId, runId)).rejects.toMatchObject({ code: "LOCAL_VIDEO_STORAGE_UNSAFE" });
        expect(await readFile(sentinel)).toEqual(beforeBytes);
        const afterFileStat = await stat(sentinel, { bigint: true });
        expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
        expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
        expect(afterFileStat.nlink).toBe(beforeFileStat.nlink);
        expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
      } finally {
        await rm(jobDir, { recursive: true, force: true });
      }
    }
  });
});
