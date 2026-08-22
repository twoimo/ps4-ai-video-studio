import { describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { acquireSourceCapturePermit, assertNoPriorPaidLocalVideoSubmission, assertRenderOutputTargetReady, captionEntriesForDuration, captureSource, captureSources, createJob, createRunDirectoryDurably, evidenceFallbackScript, hasEvidenceHookFraming, inspectPriorPaidLocalVideoSubmissions, inspectRunFailureMutationState, isPublicSourceAddress, JOBS_DIR, normalizedSourceMediaType, perceptualFingerprintDistance, readJob, RENDER_OUTPUT_POLICY, requestPinnedSource, runBoundedRenderProcess, runJob, shouldPreserveGeminiRecoveryArtifacts, SOURCE_CAPTURE_POLICY, sourceCaptureAdmissionState, sourceExcerpt, updateJob, validateEvidenceBoundScript, validatePublicSourceAddresses, verifyEvidenceBoundScript, verifyRenderOutputFile } from "../src/pipeline.mjs";
import { hashLocalVideoJson, LOCAL_VIDEO_SUBMIT_INTENT_MAX_BYTES, LOCAL_VIDEO_SUBMIT_INTENT_NAME, readLocalVideoSubmitIntent } from "../src/local-video-provider.mjs";
import { LOCAL_CLIP_UPLOAD_TRANSACTION, verifyReadyLocalClipSet } from "../src/local-clip-upload.mjs";
import { hashFile } from "../src/run-ledger.mjs";
import { closeFd, createFileAt, openFileAt, replaceFileAt, statFd, syncFd } from "../src/dirfd.mjs";

const sources = [{
  title: "공식 건축 기록",
  url: "https://example.go.kr/architecture",
  fetchStatus: "fetched",
  sha256: `sha256:${"a".repeat(64)}`,
  evidence: [
    { id: "excerpt-1", locator: "text-offset:10-90", quote: "궁궐 마당의 돌 사이 틈은 빗물이 빠져나가는 통로로 기능한다." },
    { id: "excerpt-2", locator: "text-offset:91-170", quote: "거친 돌 표면은 보행자가 미끄러지는 위험을 줄이는 데 도움을 준다." }
  ]
}];

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function expectProcessTreeExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  expect(processIsAlive(pid)).toBe(false);
}

describe("bounded local render processes", () => {
  test("rejects invalid limits before spawning and releases permits after output overflow", async () => {
    await expect(runBoundedRenderProcess(process.execPath, ["-e", "process.exit(91)"], {
      maximumOutputBytes: 0,
      timeoutMs: 1000
    })).rejects.toThrow("출력 상한");

    await expect(runBoundedRenderProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192))"], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    })).rejects.toMatchObject({ code: "RENDER_PROCESS_OUTPUT_TOO_LARGE" });
    await expect(runBoundedRenderProcess(process.execPath, ["-e", "process.stdout.write('o'.repeat(700)); process.stderr.write('e'.repeat(700))"], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    })).rejects.toMatchObject({ code: "RENDER_PROCESS_OUTPUT_TOO_LARGE" });

    const recovered = await runBoundedRenderProcess(process.execPath, ["-e", "process.stdout.write('released')"], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    });
    expect(recovered.stdout).toBe("released");
  });

  test("kills a hung child at the hard timeout and releases its global permit", async () => {
    const started = Date.now();
    await expect(runBoundedRenderProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      maximumOutputBytes: 1024,
      timeoutMs: 80
    })).rejects.toMatchObject({ code: "RENDER_PROCESS_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);

    const recovered = await runBoundedRenderProcess(process.execPath, ["-e", "process.stderr.write('ok')"], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    });
    expect(recovered.stderr).toBe("ok");
  });

  test("kills an inherited-stdio render grandchild without extending the hard timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-render-process-tree-"));
    const pidPath = join(root, "grandchild.pid");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      `writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));`,
      'setInterval(() => {}, 1000);'
    ].join("\n");
    let grandchildPid = null;
    try {
      const startedAt = Date.now();
      await expect(runBoundedRenderProcess(process.execPath, ["-e", childSource], {
        maximumOutputBytes: 1024,
        timeoutMs: 300
      })).rejects.toMatchObject({ code: "RENDER_PROCESS_TIMEOUT" });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1_200);
      grandchildPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      await expectProcessTreeExit(grandchildPid);
      await expect(runBoundedRenderProcess(process.execPath, ["-e", "process.stdout.write('reacquired')"], {
        maximumOutputBytes: 1024,
        timeoutMs: 1_000,
        admissionTimeoutMs: 100
      })).resolves.toMatchObject({ stdout: "reacquired" });
    } finally {
      if (Number.isSafeInteger(grandchildPid) && processIsAlive(grandchildPid)) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("admits at most two subprocesses globally and fails a third bounded waiter", async () => {
    const childSource = "setTimeout(() => process.exit(0), 250)";
    const first = runBoundedRenderProcess(process.execPath, ["-e", childSource], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    });
    const second = runBoundedRenderProcess(process.execPath, ["-e", childSource], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(runBoundedRenderProcess(process.execPath, ["-e", "process.exit(0)"], {
      maximumOutputBytes: 1024,
      timeoutMs: 1000,
      admissionTimeoutMs: 40
    })).rejects.toMatchObject({ code: "LOCAL_SUBPROCESS_ADMISSION_TIMEOUT" });
    await Promise.all([first, second]);
  });
});

describe("render output storage postconditions", () => {
  test("rejects symlink and hard-link targets without changing external bytes", async () => {
    const job = await createJob({ topic: "렌더 산출물 링크 차단", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-render-output-external-"));
    const victim = join(externalDir, "victim.mp4");
    await writeFile(victim, "external-render-target");
    const before = await readFile(victim);
    const beforeStat = await stat(victim, { bigint: true });
    try {
      const finalPath = join(jobDir, "final.mp4");
      await symlink(victim, finalPath);
      await expect(assertRenderOutputTargetReady(jobDir, finalPath)).rejects.toThrow();
      await unlink(finalPath);
      await link(victim, finalPath);
      await expect(assertRenderOutputTargetReady(jobDir, finalPath)).rejects.toThrow();
      await expect(verifyRenderOutputFile(jobDir, finalPath, RENDER_OUTPUT_POLICY.maximumVideoBytes)).rejects.toThrow("single-link");
      expect(await readFile(victim)).toEqual(before);
      const afterStat = await stat(victim, { bigint: true });
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
      expect(afterStat.nlink).toBe(beforeStat.nlink + 1n);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects empty and oversized owned output files", async () => {
    const job = await createJob({ topic: "렌더 산출물 크기 차단", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const output = join(jobDir, "thumbnail.jpg");
    try {
      await writeFile(output, "");
      await expect(verifyRenderOutputFile(jobDir, output, 16)).rejects.toThrow("bounded single-link");
      await writeFile(output, Buffer.alloc(17));
      await expect(verifyRenderOutputFile(jobDir, output, 16)).rejects.toThrow("bounded single-link");
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

describe("run directory durability", () => {
  test("uses fixed-signature openat and publishes exact-mode immutable files without replacing an existing name", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-dirfd-contract-"));
    const directory = await import("node:fs/promises").then(({ open }) => open(root, "r"));
    try {
      expect(() => openFileAt(directory.fd, "forbidden", fsConstants.O_RDWR | fsConstants.O_CREAT)).toThrow("O_CREAT");
      const first = createFileAt(directory.fd, "lease", fsConstants.O_RDWR, 0o600);
      try {
        expect(statFd(first).mode & 0o777n).toBe(0o600n);
        expect(() => createFileAt(directory.fd, "lease", fsConstants.O_RDWR, 0o600)).toThrow();
        expect(statFd(first).nlink).toBe(1n);
      } finally {
        closeFd(first);
      }
      expect((await stat(join(root, "lease"), { bigint: true })).mode & 0o777n).toBe(0o600n);
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves a restart-usable single-link canonical inode when creation stops after atomic publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-dirfd-contract-"));
    const { open } = await import("node:fs/promises");
    const directory = await open(root, "r");
    try {
      expect(() => createFileAt(directory.fd, "lease", fsConstants.O_RDWR, 0o600, {
        afterPublishBeforeSync: () => { throw new Error("injected publication crash boundary"); }
      })).toThrow("injected publication crash boundary");
      const canonical = openFileAt(directory.fd, "lease", fsConstants.O_RDWR);
      try {
        expect(statFd(canonical).nlink).toBe(1n);
        expect(statFd(canonical).mode & 0o777n).toBe(0o600n);
      } finally {
        closeFd(canonical);
      }
      expect(() => createFileAt(directory.fd, "lease", fsConstants.O_RDWR, 0o600)).toThrow();
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects an exact replacement target swap before rename without changing the replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-dirfd-contract-"));
    const { open } = await import("node:fs/promises");
    const directory = await open(root, "r");
    await writeFile(join(root, "target"), "old");
    const oldFd = openFileAt(directory.fd, "target", fsConstants.O_RDONLY);
    const oldIdentity = statFd(oldFd);
    closeFd(oldFd);
    try {
      expect(() => replaceFileAt(directory.fd, "target", "new", {
        expectedIdentity: oldIdentity,
        beforeRename: () => {
          renameSync(join(root, "target"), join(root, "preserved"));
          writeFileSync(join(root, "target"), "replacement");
        }
      })).toThrow();
      expect(await readFile(join(root, "target"), "utf8")).toBe("replacement");
      expect(await readFile(join(root, "preserved"), "utf8")).toBe("old");
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates initialized dirfd-relative files and publishes a no-replace rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-dirfd-contract-"));
    const { open } = await import("node:fs/promises");
    const { renameAtNoReplace } = await import("../src/dirfd.mjs");
    const directory = await open(root, "r");
    try {
      const created = createFileAt(directory.fd, "source", fsConstants.O_RDWR, 0o600, { initialBytes: Buffer.from("initialized") });
      closeFd(created);
      renameAtNoReplace(directory.fd, "source", directory.fd, "target");
      expect(await readFile(join(root, "target"), "utf8")).toBe("initialized");
      await writeFile(join(root, "collision"), "preserve");
      const second = createFileAt(directory.fd, "source", fsConstants.O_RDWR, 0o600, { initialBytes: Buffer.from("second") });
      closeFd(second);
      expect(() => renameAtNoReplace(directory.fd, "source", directory.fd, "collision")).toThrow();
      expect(await readFile(join(root, "collision"), "utf8")).toBe("preserve");
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes each newly created directory through its parent fsync before run writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-run-publication-"));
    const jobDir = join(root, "job-1");
    const runsDir = join(jobDir, "runs");
    const runDir = join(runsDir, "run-1");
    const operations = [];
    await mkdir(jobDir);

    try {
      await createRunDirectoryDurably(runDir, {
        traceFn: (operation) => operations.push(operation),
        syncFdFn: (_fd, context) => operations.push({ operation: "native-fsync", path: context.path })
      });

      expect(operations).toEqual([
        { operation: "mkdir", path: runsDir, options: { mode: 0o700 } },
        { operation: "native-fsync", path: jobDir },
        { operation: "fsync", path: jobDir },
        { operation: "mkdir", path: runDir, options: { mode: 0o700 } },
        { operation: "native-fsync", path: runsDir },
        { operation: "fsync", path: runsDir }
      ]);
      expect((await stat(runDir)).isDirectory()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails before callers can write a run ledger when runs-parent fsync is unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-run-publication-"));
    const jobDir = join(root, "job-2");
    const runsDir = join(jobDir, "runs");
    const runDir = join(runsDir, "run-2");
    const operations = [];
    await mkdir(jobDir);

    try {
      await expect(createRunDirectoryDurably(runDir, {
        traceFn: (operation) => operations.push(`${operation.operation}:${operation.path}`),
        syncFdFn: (_fd, context) => {
          operations.push(`native-fsync:${context.path}`);
          if (context.path === runsDir) throw new Error("injected runs parent fsync failure");
        }
      })).rejects.toThrow("injected runs parent fsync failure");

      expect(operations).toEqual([
        `mkdir:${runsDir}`,
        `native-fsync:${jobDir}`,
        `fsync:${jobDir}`,
        `mkdir:${runDir}`,
        `native-fsync:${runsDir}`
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never follows a preexisting runs symlink into external storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-run-publication-"));
    const jobDir = join(root, "job-3");
    const externalDir = join(root, "external");
    await mkdir(jobDir);
    await mkdir(externalDir);
    await symlink(externalDir, join(jobDir, "runs"));
    const before = (await stat(externalDir, { bigint: true })).mtimeNs;
    try {
      await expect(createRunDirectoryDurably(join(jobDir, "runs", "run-3"))).rejects.toThrow();
      expect(await readdir(externalDir)).toEqual([]);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins the original runs inode and creates nothing outside it after a pathname swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-run-publication-"));
    const jobDir = join(root, "job-4");
    const runsDir = join(jobDir, "runs");
    const preservedRunsDir = join(jobDir, "preserved-runs");
    const externalDir = join(root, "external");
    await mkdir(runsDir, { recursive: true });
    await mkdir(externalDir);
    const before = (await stat(externalDir, { bigint: true })).mtimeNs;
    try {
      await expect(createRunDirectoryDurably(join(runsDir, "run-4"), {
        afterRunsPinned: async () => {
          await rename(runsDir, preservedRunsDir);
          await symlink(externalDir, runsDir);
        }
      })).rejects.toThrow();
      expect(await readdir(externalDir)).toEqual([]);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(before);
      expect((await lstat(join(preservedRunsDir, "run-4"))).isDirectory()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("job creation durability", () => {
  const fixedNow = () => new Date("2026-08-13T11:22:33.444Z");
  const idFor = (byte) => `2026-08-13T11-22-33-444Z-${Buffer.alloc(16, byte).toString("hex")}`;

  test("durably publishes a first job from a clean workspace before acknowledging it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-first-job-durability-"));
    const workspace = join(root, "workspace");
    const jobsDir = join(workspace, "jobs");
    const jobId = idFor(0x10);
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "pipeline.mjs")).href;
    const childSource = `
      import { fsyncSync } from "node:fs";
      import { open } from "node:fs/promises";
      import { createJob } from ${JSON.stringify(moduleUrl)};
      const operations = [];
      const syncPath = async (path) => {
        const handle = await open(path, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      };
      const job = await createJob({ topic: "첫 작업 내구성", provider: "local", clipCount: 1 }, {
        nowFn: () => new Date("2026-08-13T11:22:33.444Z"),
        randomBytesFn: () => Buffer.alloc(16, 0x10),
        workspaceOptions: {
          traceFn: (operation) => operations.push(operation),
          syncFdFn: (fd, context) => {
            operations.push({ operation: "native-fsync", path: context.path });
            fsyncSync(fd);
          },
          syncDirectoryFn: async (path) => {
            operations.push({ operation: "native-fsync", path });
            await syncPath(path);
          }
        }
      });
      console.log(JSON.stringify({ job, operations }));
    `;
    try {
      const child = Bun.spawn([process.execPath, "-e", childSource], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test", PS4_WORKSPACE_DIR: workspace },
        stdout: "pipe",
        stderr: "pipe"
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(await stderr).toBe("");
      const { job, operations } = JSON.parse(await stdout);
      expect(job.id).toBe(jobId);
      expect(operations.map((operation) => `${operation.operation}:${operation.path}`)).toEqual([
        `mkdir:${workspace}`,
        `mkdir:${jobsDir}`,
        `mkdir:${join(workspace, "uploads")}`,
        `native-fsync:${workspace}`,
        `fsync:${workspace}`,
        `native-fsync:${dirname(workspace)}`,
        `fsync:${dirname(workspace)}`
      ]);
      expect(JSON.parse(await readFile(join(jobsDir, jobId, "job.json"), "utf8"))).toEqual(job);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries an exclusively reserved 128-bit ID collision without touching the existing job", async () => {
    const collisionId = idFor(0x11);
    const nextId = idFor(0x22);
    const collisionDir = join(JOBS_DIR, collisionId);
    await mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
    await mkdir(collisionDir, { recursive: false, mode: 0o700 });
    await writeFile(join(collisionDir, "sentinel"), "existing-job");
    const generated = [Buffer.alloc(16, 0x11), Buffer.alloc(16, 0x22)];
    const operations = [];
    try {
      const job = await createJob({ topic: "충돌 예약 재시도", provider: "local", clipCount: 1 }, {
        nowFn: fixedNow,
        randomBytesFn: () => generated.shift(),
        traceFn: (operation) => operations.push(operation)
      });
      expect(job.id).toBe(nextId);
      expect(await readFile(join(collisionDir, "sentinel"), "utf8")).toBe("existing-job");
      expect(operations.filter((operation) => operation.operation === "collision")).toEqual([
        { operation: "collision", path: collisionDir, attempt: 1 }
      ]);
      expect(JSON.parse(await readFile(join(JOBS_DIR, nextId, "job.json"), "utf8"))).toEqual(job);
      expect((await readdir(join(JOBS_DIR, nextId))).sort()).toEqual(["clips", "job.json", "normalized"]);
    } finally {
      await rm(collisionDir, { recursive: true, force: true });
      await rm(join(JOBS_DIR, nextId), { recursive: true, force: true });
    }
  });

  test("concurrent creators at one clock instant resolve an injected first-ID collision", async () => {
    const firstId = idFor(0x51);
    const leftFallback = idFor(0x52);
    const rightFallback = idFor(0x53);
    const leftValues = [Buffer.alloc(16, 0x51), Buffer.alloc(16, 0x52)];
    const rightValues = [Buffer.alloc(16, 0x51), Buffer.alloc(16, 0x53)];
    const possibleIds = [firstId, leftFallback, rightFallback];
    try {
      const [left, right] = await Promise.all([
        createJob({ topic: "동시 생성 왼쪽", provider: "local", clipCount: 1 }, {
          nowFn: fixedNow,
          randomBytesFn: () => leftValues.shift()
        }),
        createJob({ topic: "동시 생성 오른쪽", provider: "local", clipCount: 1 }, {
          nowFn: fixedNow,
          randomBytesFn: () => rightValues.shift()
        })
      ]);
      expect(new Set([left.id, right.id]).size).toBe(2);
      expect([left.id, right.id]).toContain(firstId);
      expect([left.id, right.id].every((id) => possibleIds.includes(id))).toBeTrue();
      expect(JSON.parse(await readFile(join(JOBS_DIR, left.id, "job.json"), "utf8"))).toEqual(left);
      expect(JSON.parse(await readFile(join(JOBS_DIR, right.id, "job.json"), "utf8"))).toEqual(right);
    } finally {
      await Promise.all(possibleIds.map((id) => rm(join(JOBS_DIR, id), { recursive: true, force: true })));
    }
  });

  test("bounds repeated ID collisions without overwriting the reserved entry", async () => {
    const collisionId = idFor(0x54);
    const collisionDir = join(JOBS_DIR, collisionId);
    let generated = 0;
    await mkdir(collisionDir, { recursive: false, mode: 0o700 });
    await writeFile(join(collisionDir, "sentinel"), "reserved");
    try {
      await expect(createJob({ topic: "충돌 한도 검증", provider: "local", clipCount: 1 }, {
        nowFn: fixedNow,
        randomBytesFn: () => {
          generated += 1;
          return Buffer.alloc(16, 0x54);
        }
      })).rejects.toMatchObject({ code: "JOB_ID_RESERVATION_EXHAUSTED" });
      expect(generated).toBe(16);
      expect(await readFile(join(collisionDir, "sentinel"), "utf8")).toBe("reserved");
      expect(await readdir(collisionDir)).toEqual(["sentinel"]);
    } finally {
      await rm(collisionDir, { recursive: true, force: true });
    }
  });

  test("fsyncs the exact job file, job contents, and jobs-root publication before acknowledgement", async () => {
    const jobId = idFor(0x33);
    const jobDir = join(JOBS_DIR, jobId);
    const operations = [];
    try {
      const job = await createJob({ topic: "내구성 순서 검증", provider: "local", clipCount: 1 }, {
        nowFn: fixedNow,
        randomBytesFn: () => Buffer.alloc(16, 0x33),
        traceFn: (operation) => operations.push(operation),
        syncFileFn: async (handle, context) => {
          operations.push({ operation: "native-fsync", path: context.path });
          await handle.sync();
        },
        syncDirectoryFn: async (path) => {
          operations.push({ operation: "native-fsync", path });
          const handle = await import("node:fs/promises").then(({ open }) => open(path, "r"));
          try { await handle.sync(); } finally { await handle.close(); }
        },
        syncJobsRootFn: (fd, context) => {
          operations.push({ operation: "native-fsync", path: context.path });
          syncFd(fd);
        }
      });
      expect(job.id).toBe(jobId);
      const important = operations.filter((operation) => ["write", "native-fsync", "fsync"].includes(operation.operation));
      expect(important.map((operation) => `${operation.operation}:${operation.path}`)).toEqual([
        `write:${join(jobDir, "job.json")}`,
        `native-fsync:${join(jobDir, "job.json")}`,
        `fsync:${join(jobDir, "job.json")}`,
        `native-fsync:${jobDir}`,
        `fsync:${jobDir}`,
        `native-fsync:${JOBS_DIR}`,
        `fsync:${JOBS_DIR}`
      ]);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("removes the exact reservation and fsyncs its parent when jobs-root publication fsync fails", async () => {
    const jobId = idFor(0x44);
    const jobDir = join(JOBS_DIR, jobId);
    const operations = [];
    await expect(createJob({ topic: "실패 정리 검증", provider: "local", clipCount: 1 }, {
      nowFn: fixedNow,
      randomBytesFn: () => Buffer.alloc(16, 0x44),
      syncJobsRootFn: () => { throw new Error("injected jobs-root fsync failure"); },
      cleanupSyncDirectoryFn: (fd, context) => {
        operations.push(`cleanup-fsync:${context.path}`);
        syncFd(fd);
      }
    })).rejects.toThrow("injected jobs-root fsync failure");
    expect(await lstat(jobDir).then(() => true, (error) => error?.code !== "ENOENT")).toBeFalse();
    expect(operations).toEqual([`cleanup-fsync:${JOBS_DIR}`]);
  });

  test("rejects coerced, fractional, and out-of-range clip counts before reserving a directory", async () => {
    await mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
    const before = (await readdir(JOBS_DIR)).sort();
    for (const clipCount of ["2", 1.5, 0, 13, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(createJob({ topic: "엄격한 클립 수", provider: "local", clipCount }, {
        nowFn: fixedNow,
        randomBytesFn: () => { throw new Error("identity reservation must not run"); }
      })).rejects.toThrow("안전한 정수");
    }
    expect((await readdir(JOBS_DIR)).sort()).toEqual(before);
  });

  test("rejects a preexisting jobs-root symlink without changing its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-job-root-symlink-"));
    const workspace = join(root, "workspace");
    const external = join(root, "external");
    const sentinel = join(external, "sentinel");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(external, { mode: 0o700 });
    await writeFile(sentinel, "external-bytes");
    await symlink(external, join(workspace, "jobs"));
    const beforeBytes = await readFile(sentinel);
    const beforeMtime = (await stat(external, { bigint: true })).mtimeNs;
    const beforeSentinelMtime = (await stat(sentinel, { bigint: true })).mtimeNs;
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "pipeline.mjs")).href;
    const childSource = `
      import { createJob } from ${JSON.stringify(moduleUrl)};
      try {
        await createJob({ topic: "symlink root rejection", provider: "local", clipCount: 1 });
        process.exit(91);
      } catch {
        process.exit(0);
      }
    `;
    try {
      const child = Bun.spawn([process.execPath, "-e", childSource], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test", PS4_WORKSPACE_DIR: workspace },
        stdout: "pipe",
        stderr: "pipe"
      });
      expect(await child.exited).toBe(0);
      expect(await readFile(sentinel)).toEqual(beforeBytes);
      expect((await stat(sentinel, { bigint: true })).mtimeNs).toBe(beforeSentinelMtime);
      expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeMtime);
      expect(await readdir(external)).toEqual(["sentinel"]);
      expect((await readdir(workspace)).sort()).toEqual(["jobs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function script() {
  const first = sources[0].evidence[0].quote;
  const second = sources[0].evidence[1].quote;
  return {
    title: first,
    hook: first,
    narration: `${first} ${second}`,
    researchStatus: "verified",
    segments: [
      {
        claimId: "claim-1",
        claim: first,
        caption: first,
        narration: first,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(first)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        durationHint: 8,
        evidenceRefs: [{ sourceId: sources[0].url, evidenceId: "excerpt-1", quote: first }]
      },
      {
        claimId: "claim-2",
        claim: second,
        caption: second,
        narration: second,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(second)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        durationHint: 8,
        evidenceRefs: [{ sourceId: sources[0].url, evidenceId: "excerpt-2", quote: second }]
      }
    ]
  };
}

describe("Gemini crash-safe artifact preservation", () => {
  test("preserves completed clips and pending submissions from failed or hard-crashed runs", () => {
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "running", segments: [{ index: 1 }] })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "failed", segments: [], pendingSegment: { status: "ambiguous-submitted" } })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "failed", segments: [], pendingSegment: { status: "submit-intent" } })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "running", segments: [], pendingSegment: { status: "submitted-awaiting-result" } })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "failed", segments: [] })).toBe(false);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "completed", segments: [{ index: 1 }] })).toBe(false);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "completed", runId: "interrupted-run", segments: [{ index: 1 }] }, {
      status: "running",
      runStatus: "running",
      runId: "interrupted-run"
    })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "completed", runId: "startup-recovered-run", segments: [{ index: 1 }] }, {
      status: "failed",
      runStatus: "failed",
      runId: "startup-recovered-run"
    })).toBe(true);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "completed", runId: "old-run", segments: [{ index: 1 }] }, {
      status: "failed",
      runStatus: "failed",
      runId: "different-run"
    })).toBe(false);
    expect(shouldPreserveGeminiRecoveryArtifacts({ status: "completed", runId: "completed-run", segments: [{ index: 1 }] }, {
      status: "completed",
      runStatus: "verified",
      runId: "completed-run"
    })).toBe(false);
  });
});

describe("terminal seal failure boundary", () => {
  test("never downgrades a verified terminal manifest after a post-seal error", async () => {
    const job = await createJob({ topic: "완료 봉인 보존 회귀", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const runId = "terminal-seal-run";
    const runDir = join(jobDir, "runs", runId);
    const artifactPath = join(runDir, "artifacts", "final.mp4");
    try {
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await writeFile(artifactPath, "sealed-final-bytes");
      const declaration = {
        path: `runs/${runId}/artifacts/final.mp4`,
        bytes: (await readFile(artifactPath)).byteLength,
        sha256: await hashFile(artifactPath)
      };
      await writeFile(join(runDir, "manifest.json"), JSON.stringify({
        schemaVersion: 1,
        jobId: job.id,
        runId,
        status: "completed",
        runStatus: "verified",
        ledgerErrors: [],
        qualitySummary: { status: "passed", runId },
        immutableArtifacts: [declaration]
      }));
      expect(await inspectRunFailureMutationState(jobDir, runDir, job.id, runId)).toMatchObject({ state: "sealed-terminal" });
      await writeFile(artifactPath, "tampered-after-seal");
      expect(await inspectRunFailureMutationState(jobDir, runDir, job.id, runId)).toMatchObject({ state: "blocked", reason: "terminal-artifact-integrity" });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

describe("manual local import run boundary", () => {
  test("direct runJob rejects an unreceipted local clip set before creating a run or mutating the job", async () => {
    const job = await createJob({ topic: "수동 클립 영수증 필수", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    await writeFile(join(jobDir, "clips", "01.mp4"), "unreceipted-local-clip");
    const beforeJob = await readFile(join(jobDir, "job.json"));

    await expect(runJob(job.id)).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_RECEIPT_MISSING" });

    expect(await readFile(join(jobDir, "job.json"))).toEqual(beforeJob);
    expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
    expect(await readFile(join(jobDir, "clips", "01.mp4"), "utf8")).toBe("unreceipted-local-clip");
  });

  test("direct runJob rejects a corrupt upload marker before creating a run or mutating the job", async () => {
    const job = await createJob({ topic: "손상 업로드 marker 실행 차단", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const beforeJob = await readFile(join(jobDir, "job.json"));
    await writeFile(join(jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION), "{not-valid-json");

    await expect(runJob(job.id)).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID" });

    expect(await readFile(join(jobDir, "job.json"))).toEqual(beforeJob);
    expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
    expect(await readFile(join(jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION), "utf8")).toBe("{not-valid-json");
  });

  test("rejects a preexisting symlinked job root without touching the external target", async () => {
    const job = await createJob({ topic: "작업 루트 심볼릭 링크 차단", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const externalDir = join(JOBS_DIR, `.external-${job.id}`);
    await rename(jobDir, externalDir);
    await symlink(externalDir, jobDir);
    const externalJobPath = join(externalDir, "job.json");
    const beforeBytes = await readFile(externalJobPath);
    const beforeStat = await stat(externalJobPath, { bigint: true });
    try {
      await expect(verifyReadyLocalClipSet(jobDir, job)).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE" });
      await expect(runJob(job.id)).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE" });
      expect(await readFile(externalJobPath)).toEqual(beforeBytes);
      const afterStat = await stat(externalJobPath, { bigint: true });
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
      expect(await stat(join(externalDir, "runs")).catch(() => null)).toBeNull();
    } finally {
      await unlink(jobDir).catch(() => {});
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked clips directory before creating a run or mutating either job or external storage", async () => {
    const job = await createJob({ topic: "클립 저장 경계 심볼릭 링크 차단", provider: "local-video", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const clipsDir = join(jobDir, "clips");
    const preservedClips = join(jobDir, "preserved-clips");
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-external-clips-"));
    const externalVideo = join(externalDir, "victim.mp4");
    await writeFile(externalVideo, "external-video-must-not-change");
    await rename(clipsDir, preservedClips);
    await symlink(externalDir, clipsDir);
    const beforeJob = await readFile(join(jobDir, "job.json"));
    const beforeExternal = await readFile(externalVideo);
    const beforeExternalStat = await stat(externalVideo, { bigint: true });
    const beforeDirectoryStat = await stat(externalDir, { bigint: true });
    try {
      await expect(runJob(job.id, { paidLaunchCapability: {} })).rejects.toThrow();
      expect(await readFile(join(jobDir, "job.json"))).toEqual(beforeJob);
      expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
      expect(await readFile(externalVideo)).toEqual(beforeExternal);
      expect((await stat(externalVideo, { bigint: true })).mtimeNs).toBe(beforeExternalStat.mtimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeDirectoryStat.mtimeNs);
    } finally {
      await unlink(clipsDir).catch(() => {});
      await rm(jobDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects symlinked normalized and quality directories before any run or external mutation", async () => {
    for (const childName of ["normalized", "quality"]) {
      const job = await createJob({ topic: `${childName} 저장 경계 심볼릭 링크 차단`, provider: "local-video", clipCount: 1, targetDurationSec: 20 });
      const jobDir = join(JOBS_DIR, job.id);
      const childPath = join(jobDir, childName);
      const externalDir = await mkdtemp(join(tmpdir(), `ps4-external-${childName}-`));
      const externalFile = join(externalDir, "victim.bin");
      await writeFile(externalFile, `external-${childName}-must-not-change`);
      if (childName === "normalized") await rename(childPath, join(jobDir, "preserved-normalized"));
      await symlink(externalDir, childPath);
      const beforeJob = await readFile(join(jobDir, "job.json"));
      const beforeExternal = await readFile(externalFile);
      const beforeExternalStat = await stat(externalFile, { bigint: true });
      const beforeDirectoryStat = await stat(externalDir, { bigint: true });
      try {
        await expect(runJob(job.id, { paidLaunchCapability: {} })).rejects.toThrow();
        expect(await readFile(join(jobDir, "job.json"))).toEqual(beforeJob);
        expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
        expect(await readFile(externalFile)).toEqual(beforeExternal);
        expect((await stat(externalFile, { bigint: true })).mtimeNs).toBe(beforeExternalStat.mtimeNs);
        expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeDirectoryStat.mtimeNs);
      } finally {
        await unlink(childPath).catch(() => {});
        await rm(jobDir, { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    }
  });

  test("rejects hard-linked mutable files in root, clips, normalized, and quality before mutation", async () => {
    for (const relativePath of ["final.mp4", "clips/01.mp4", "normalized/01.mp4", "quality/iteration-01.json"]) {
      const job = await createJob({ topic: `${relativePath} 하드링크 차단`, provider: "local-video", clipCount: 1, targetDurationSec: 20 });
      const jobDir = join(JOBS_DIR, job.id);
      const externalDir = await mkdtemp(join(tmpdir(), "ps4-external-hardlink-"));
      const externalFile = join(externalDir, "victim.bin");
      const targetPath = join(jobDir, relativePath);
      await writeFile(externalFile, `external-hardlink-${relativePath}`);
      await mkdir(dirname(targetPath), { recursive: true });
      await link(externalFile, targetPath);
      const beforeJob = await readFile(join(jobDir, "job.json"));
      const beforeExternal = await readFile(externalFile);
      const beforeExternalStat = await stat(externalFile, { bigint: true });
      try {
        await expect(runJob(job.id, { paidLaunchCapability: {} })).rejects.toThrow();
        expect(await readFile(join(jobDir, "job.json"))).toEqual(beforeJob);
        expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
        expect(await readFile(externalFile)).toEqual(beforeExternal);
        const afterExternalStat = await stat(externalFile, { bigint: true });
        expect(afterExternalStat.mtimeNs).toBe(beforeExternalStat.mtimeNs);
        expect(afterExternalStat.ctimeNs).toBe(beforeExternalStat.ctimeNs);
        expect(afterExternalStat.nlink).toBe(beforeExternalStat.nlink);
      } finally {
        await rm(jobDir, { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    }
  });

  test("rejects symlinked or hard-linked job.json before readJob, run publication, or external mutation", async () => {
    for (const linkType of ["symlink", "hardlink"]) {
      const job = await createJob({ topic: `job.json ${linkType} 차단`, provider: "local-video", clipCount: 1, targetDurationSec: 20 });
      const jobDir = join(JOBS_DIR, job.id);
      const jobPath = join(jobDir, "job.json");
      const externalDir = await mkdtemp(join(tmpdir(), `ps4-external-job-${linkType}-`));
      const externalFile = join(externalDir, "job.json");
      await writeFile(externalFile, await readFile(jobPath));
      await unlink(jobPath);
      if (linkType === "symlink") await symlink(externalFile, jobPath);
      else await link(externalFile, jobPath);
      const beforeExternal = await readFile(externalFile);
      const beforeExternalStat = await stat(externalFile, { bigint: true });
      const beforeDirectoryStat = await stat(externalDir, { bigint: true });
      try {
        await expect(runJob(job.id, { paidLaunchCapability: {} })).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_STORAGE_UNSAFE" });
        expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
        expect(await readFile(externalFile)).toEqual(beforeExternal);
        const afterExternalStat = await stat(externalFile, { bigint: true });
        expect(afterExternalStat.mtimeNs).toBe(beforeExternalStat.mtimeNs);
        expect(afterExternalStat.ctimeNs).toBe(beforeExternalStat.ctimeNs);
        expect(afterExternalStat.nlink).toBe(beforeExternalStat.nlink);
        expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeDirectoryStat.mtimeNs);
      } finally {
        await rm(jobDir, { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    }
  });
});

describe("job creation strict input boundary", () => {
  test("rejects malformed or secret-bearing metadata before workspace mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ps4-create-input-boundary-"));
    const workspace = join(root, "workspace");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "pipeline.mjs")).href;
    const invalidInputs = [
      { topic: "x".repeat(501), provider: "local", sources: [] },
      { topic: "잘못된 출처 배열", provider: "local", sources: "https://example.com" },
      { topic: "출처 개수 제한", provider: "local", sources: Array.from({ length: 13 }, (_, index) => `https://example.com/${index}`) },
      { topic: "출처 객체 형태", provider: "local", sources: [{ url: "https://example.com", unexpected: true }] },
      { topic: "출처 URL scheme", provider: "local", sources: [{ url: "file:///etc/passwd" }] },
      { topic: "출처 URL 인증", provider: "local", sources: [{ url: "https://user:pass@example.com/private" }] },
      { topic: "출처 URL fragment", provider: "local", sources: [{ url: "https://example.com/page#private" }] },
      { topic: "출처 URL secret query", provider: "local", sources: [{ url: "https://example.com/page?access-token=private" }] },
      { topic: "AWS signed URL credential", provider: "local", sources: [{ url: "https://example.com/page?X-Amz-Credential=private" }] },
      { topic: "Google signed URL signature", provider: "local", sources: [{ url: "https://example.com/page?X-Goog-Signature=private" }] },
      { topic: "AWS legacy access key", provider: "local", sources: [{ url: "https://example.com/page?AWSAccessKeyId=private" }] }
    ];
    const validInput = {
      topic: "엄격 입력 정상 생성",
      provider: "local",
      sources: [{ title: "공식 자료", url: "https://example.com/watch?id=1&v=2&utm_source=test" }]
    };
    const childSource = `
      import { stat } from "node:fs/promises";
      import { createJob } from ${JSON.stringify(moduleUrl)};
      const invalidInputs = ${JSON.stringify(invalidInputs)};
      for (const input of invalidInputs) {
        let rejected = false;
        try { await createJob(input); } catch { rejected = true; }
        if (!rejected || await stat(${JSON.stringify(workspace)}).then(() => true, () => false)) process.exit(91);
      }
      const job = await createJob(${JSON.stringify(validInput)});
      process.stdout.write(JSON.stringify({ topic: job.topic, sources: job.sources }));
    `;
    try {
      const child = Bun.spawn([process.execPath, "-e", childSource], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test", PS4_WORKSPACE_DIR: workspace },
        stdout: "pipe",
        stderr: "pipe"
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ topic: validInput.topic, sources: validInput.sources });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("job metadata storage boundary", () => {
  test("readJob and updateJob reject a symlinked job directory without touching external metadata", async () => {
    const job = await createJob({ topic: "readJob 작업 루트 링크 차단", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const externalDir = join(JOBS_DIR, `.external-read-${job.id}`);
    await rename(jobDir, externalDir);
    await symlink(externalDir, jobDir);
    const externalJob = join(externalDir, "job.json");
    const beforeBytes = await readFile(externalJob);
    const beforeFileStat = await stat(externalJob, { bigint: true });
    const beforeDirStat = await stat(externalDir, { bigint: true });
    try {
      await expect(readJob(job.id)).rejects.toThrow();
      await expect(updateJob(job.id, { message: "must-not-write" })).rejects.toThrow();
      expect(await readFile(externalJob)).toEqual(beforeBytes);
      const afterFileStat = await stat(externalJob, { bigint: true });
      expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
      expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
    } finally {
      await unlink(jobDir).catch(() => {});
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("readJob and updateJob reject symlinked and hard-linked job.json without changing the external inode", async () => {
    for (const linkType of ["symlink", "hardlink"]) {
      const job = await createJob({ topic: `readJob ${linkType} metadata 차단`, provider: "local", clipCount: 1, targetDurationSec: 20 });
      const jobDir = join(JOBS_DIR, job.id);
      const jobPath = join(jobDir, "job.json");
      const externalDir = await mkdtemp(join(tmpdir(), `ps4-read-job-${linkType}-`));
      const externalFile = join(externalDir, "job.json");
      await writeFile(externalFile, await readFile(jobPath));
      await unlink(jobPath);
      if (linkType === "symlink") await symlink(externalFile, jobPath);
      else await link(externalFile, jobPath);
      const beforeBytes = await readFile(externalFile);
      const beforeFileStat = await stat(externalFile, { bigint: true });
      const beforeDirStat = await stat(externalDir, { bigint: true });
      try {
        await expect(readJob(job.id)).rejects.toThrow();
        await expect(updateJob(job.id, { message: "must-not-write" })).rejects.toThrow();
        expect(await readFile(externalFile)).toEqual(beforeBytes);
        const afterFileStat = await stat(externalFile, { bigint: true });
        expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
        expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
        expect(afterFileStat.nlink).toBe(beforeFileStat.nlink);
        expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
      } finally {
        await rm(jobDir, { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    }
  });

  test("bounds job.json before JSON parsing and leaves oversized bytes unchanged", async () => {
    const job = await createJob({ topic: "job.json 바이트 상한", provider: "local", clipCount: 1, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const jobPath = join(jobDir, "job.json");
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
    await writeFile(jobPath, oversized);
    const beforeStat = await stat(jobPath, { bigint: true });
    try {
      await expect(readJob(job.id)).rejects.toThrow("bounded single-link regular file");
      await expect(updateJob(job.id, { message: "must-not-write" })).rejects.toThrow("bounded single-link regular file");
      expect(await readFile(jobPath)).toEqual(oversized);
      const afterStat = await stat(jobPath, { bigint: true });
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
      expect(afterStat.ctimeNs).toBe(beforeStat.ctimeNs);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("rejects malformed UTF-8 job bytes before reads, updates, run publication, or provider callbacks", async () => {
    const replacementCharacter = "\uFFFD";
    const job = await createJob({
      topic: `job.json UTF-8 alias ${replacementCharacter}`,
      provider: "local-video",
      clipCount: 1,
      targetDurationSec: 20
    });
    const jobDir = join(JOBS_DIR, job.id);
    const jobPath = join(jobDir, "job.json");
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-invalid-job-utf8-external-"));
    const externalMetadata = join(externalDir, "metadata.json");
    await writeFile(externalMetadata, '{"mustRemain":"exact"}');
    const exactBytes = await readFile(jobPath);
    const encodedReplacement = Buffer.from(replacementCharacter, "utf8");
    const replacementOffset = exactBytes.indexOf(encodedReplacement);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    const malformedBytes = Buffer.concat([
      exactBytes.subarray(0, replacementOffset),
      Buffer.from([0xff]),
      exactBytes.subarray(replacementOffset + encodedReplacement.byteLength)
    ]);
    // The legacy replacement decoder still produced parseable JSON, making
    // this an alias of a cosmetically valid U+FFFD topic.
    expect(JSON.parse(malformedBytes.toString("utf8"))).toEqual(JSON.parse(exactBytes.toString("utf8")));
    await writeFile(jobPath, malformedBytes);

    const beforeJobStat = await stat(jobPath, { bigint: true });
    const beforeJobDirStat = await stat(jobDir, { bigint: true });
    const beforeExternalBytes = await readFile(externalMetadata);
    const beforeExternalStat = await stat(externalMetadata, { bigint: true });
    const beforeExternalDirStat = await stat(externalDir, { bigint: true });
    let providerCallbacks = 0;
    const providerTrap = async () => {
      providerCallbacks += 1;
      throw new Error("provider callback must not run");
    };
    const expectedError = "job.json이 올바른 bounded UTF-8 JSON이 아닙니다.";
    try {
      await expect(readJob(job.id)).rejects.toThrow(expectedError);
      await expect(updateJob(job.id, { message: "must-not-write" })).rejects.toThrow(expectedError);
      await expect(runJob(job.id, {
        paidLaunchCapability: {},
        onRunCreated: providerTrap,
        onProgress: providerTrap,
        captureSources: providerTrap,
        buildScript: providerTrap,
        semanticVerifierPreflight: providerTrap,
        generateLocalVideoClips: providerTrap
      })).rejects.toThrow(expectedError);

      expect(providerCallbacks).toBe(0);
      expect(await readFile(jobPath)).toEqual(malformedBytes);
      expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
      expect(await stat(join(jobDir, ".bfl-flux-video")).catch(() => null)).toBeNull();
      const afterJobStat = await stat(jobPath, { bigint: true });
      expect(afterJobStat.mtimeNs).toBe(beforeJobStat.mtimeNs);
      expect(afterJobStat.ctimeNs).toBe(beforeJobStat.ctimeNs);
      expect((await stat(jobDir, { bigint: true })).mtimeNs).toBe(beforeJobDirStat.mtimeNs);
      expect(await readFile(externalMetadata)).toEqual(beforeExternalBytes);
      const afterExternalStat = await stat(externalMetadata, { bigint: true });
      expect(afterExternalStat.mtimeNs).toBe(beforeExternalStat.mtimeNs);
      expect(afterExternalStat.ctimeNs).toBe(beforeExternalStat.ctimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(beforeExternalDirStat.mtimeNs);

      // Fatal decoding must not accidentally make a previously rejected UTF-8
      // BOM acceptable by stripping it before JSON.parse.
      const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), exactBytes]);
      await writeFile(jobPath, bomBytes);
      await expect(readJob(job.id)).rejects.toThrow(expectedError);
      expect(await readFile(jobPath)).toEqual(bomBytes);
      expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
    } finally {
      await rm(jobDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });
});

describe("BFL cross-run paid submission fence", () => {
  function validSubmitIntent(jobId, overrides = {}) {
    const unsigned = {
      schemaVersion: 1,
      type: "local-video-provider-submit-intent",
      status: "spawn-authorized",
      provider: "local-video",
      jobId,
      runId: "prior-parent-run",
      requestHash: `sha256:${"d".repeat(64)}`,
      scriptHash: `sha256:${"e".repeat(64)}`,
      paidAuthorizationHash: `sha256:${"f".repeat(64)}`,
      generatorName: "bfl-flux-video-generator.mjs",
      generatorSha256: `sha256:${"1".repeat(64)}`,
      executorSnapshotName: ".bfl-paid-executor.mjs",
      executorSnapshotSha256: `sha256:${"2".repeat(64)}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      ...overrides
    };
    return { ...unsigned, intentHash: hashLocalVideoJson(unsigned) };
  }

  test("blocks a new run before deleting clips or mutating the job when any prior paid outcome exists", async () => {
    const job = await createJob({ topic: "BFL 중복 결제 차단", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const clipPath = join(jobDir, "clips", "01.mp4");
    const checkpointDir = join(jobDir, ".bfl-flux-video", "a".repeat(64));
    try {
      await mkdir(checkpointDir, { recursive: true });
      await writeFile(clipPath, "already-paid-output");
      await writeFile(join(checkpointDir, "task-001.json"), JSON.stringify({
        schemaVersion: 1,
        provider: "bfl",
        jobId: job.id,
        runId: "prior-paid-run",
        requestHash: `sha256:${"b".repeat(64)}`,
        index: 1,
        phase: "submission_unknown"
      }));
      await writeFile(join(checkpointDir, "task-002.json"), JSON.stringify({
        schemaVersion: 1,
        provider: "bfl",
        jobId: job.id,
        runId: "prior-prepared-run",
        requestHash: `sha256:${"c".repeat(64)}`,
        index: 2,
        phase: "prepared"
      }));
      const intent = validSubmitIntent(job.id);
      await writeFile(join(jobDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME), JSON.stringify(intent));
      const jobBefore = await readFile(join(jobDir, "job.json"), "utf8");
      expect(await readLocalVideoSubmitIntent(jobDir)).toEqual(intent);
      expect(await inspectPriorPaidLocalVideoSubmissions(jobDir)).toMatchObject({
        blocked: true,
        submissions: [
          { runId: "prior-parent-run", index: 0, phase: "submit-intent", taskIdPresent: false },
          { runId: "prior-paid-run", index: 1, phase: "submission_unknown", taskIdPresent: false },
          { runId: "prior-prepared-run", index: 2, phase: "prepared", taskIdPresent: false }
        ]
      });
      await expect(assertNoPriorPaidLocalVideoSubmission(jobDir)).rejects.toMatchObject({ code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION" });
      await expect(runJob(job.id)).rejects.toMatchObject({ code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION" });
      expect(await readFile(clipPath, "utf8")).toBe("already-paid-output");
      expect(await readFile(join(jobDir, "job.json"), "utf8")).toBe(jobBefore);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  test("treats unsafe submit-intent bytes as ambiguous paid state without touching external metadata", async () => {
    const job = await createJob({ topic: "BFL 제출 의도 저장 경계", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const intentPath = join(jobDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-local-video-intent-"));
    const externalPath = join(externalDir, "intent.json");
    const validBytes = Buffer.from(JSON.stringify(validSubmitIntent(job.id)));
    try {
      await writeFile(externalPath, validBytes);
      await link(externalPath, intentPath);
      const hardlinkBefore = await stat(externalPath, { bigint: true });
      const externalDirBefore = await stat(externalDir, { bigint: true });
      const externalBytesBefore = await readFile(externalPath);
      await expect(readLocalVideoSubmitIntent(jobDir)).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
      await expect(inspectPriorPaidLocalVideoSubmissions(jobDir)).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
      expect(await readFile(externalPath)).toEqual(externalBytesBefore);
      const hardlinkAfter = await stat(externalPath, { bigint: true });
      expect(hardlinkAfter.nlink).toBe(hardlinkBefore.nlink);
      expect(hardlinkAfter.mtimeNs).toBe(hardlinkBefore.mtimeNs);
      expect(hardlinkAfter.ctimeNs).toBe(hardlinkBefore.ctimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(externalDirBefore.mtimeNs);

      await unlink(intentPath);
      await symlink(externalPath, intentPath);
      const symlinkTargetBefore = await stat(externalPath, { bigint: true });
      const symlinkExternalDirBefore = await stat(externalDir, { bigint: true });
      await expect(readLocalVideoSubmitIntent(jobDir)).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
      const symlinkTargetAfter = await stat(externalPath, { bigint: true });
      expect(symlinkTargetAfter.mtimeNs).toBe(symlinkTargetBefore.mtimeNs);
      expect(symlinkTargetAfter.ctimeNs).toBe(symlinkTargetBefore.ctimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(symlinkExternalDirBefore.mtimeNs);

      const rejectedBytes = [
        Buffer.alloc(LOCAL_VIDEO_SUBMIT_INTENT_MAX_BYTES + 1, 0x20),
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validBytes])
      ];
      for (const bytes of rejectedBytes) {
        await unlink(intentPath).catch(() => {});
        await writeFile(intentPath, bytes);
        await expect(readLocalVideoSubmitIntent(jobDir)).rejects.toMatchObject({
          code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
        });
      }

      const jobBefore = await readFile(join(jobDir, "job.json"));
      expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
      expect(await stat(join(jobDir, ".bfl-flux-video")).catch(() => null)).toBeNull();
      await expect(runJob(job.id, { paidLaunchCapability: { untrusted: true } })).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
      expect(await readFile(join(jobDir, "job.json"))).toEqual(jobBefore);
      expect(await stat(join(jobDir, "runs")).catch(() => null)).toBeNull();
      expect(await stat(join(jobDir, ".bfl-flux-video")).catch(() => null)).toBeNull();
    } finally {
      await rm(jobDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rechecks canonical job ancestry and the exact intent leaf after its single byte snapshot", async () => {
    const job = await createJob({ topic: "BFL 제출 의도 재검증", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const jobDir = join(JOBS_DIR, job.id);
    const intentPath = join(jobDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME);
    const preservedPath = join(jobDir, ".preserved-local-video-intent.json");
    const initialBytes = Buffer.from(JSON.stringify(validSubmitIntent(job.id)));
    const replacementBytes = Buffer.from(JSON.stringify(validSubmitIntent(job.id, { runId: "replacement-parent-run" })));
    const aliasJob = await createJob({ topic: "BFL 제출 의도 ancestry alias", provider: "local-video", clipCount: 2, targetDurationSec: 20 });
    const aliasJobDir = join(JOBS_DIR, aliasJob.id);
    const externalDir = await mkdtemp(join(tmpdir(), "ps4-local-video-intent-alias-"));
    try {
      await writeFile(intentPath, initialBytes);
      let hookBytes = null;
      await expect(readLocalVideoSubmitIntent(jobDir, {
        afterIntentBytesReadForTest: async (bytes) => {
          hookBytes = bytes;
          await rename(intentPath, preservedPath);
          await writeFile(intentPath, replacementBytes);
        }
      })).rejects.toMatchObject({ code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS" });
      expect(hookBytes).toEqual(initialBytes);
      expect(await readFile(preservedPath)).toEqual(initialBytes);

      await writeFile(join(externalDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME), JSON.stringify(validSubmitIntent(aliasJob.id)));
      await rm(aliasJobDir, { recursive: true, force: true });
      await symlink(externalDir, aliasJobDir);
      const externalIntentBefore = await stat(join(externalDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME), { bigint: true });
      const externalDirBefore = await stat(externalDir, { bigint: true });
      await expect(readLocalVideoSubmitIntent(aliasJobDir)).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
      const externalIntentAfter = await stat(join(externalDir, LOCAL_VIDEO_SUBMIT_INTENT_NAME), { bigint: true });
      expect(externalIntentAfter.mtimeNs).toBe(externalIntentBefore.mtimeNs);
      expect(externalIntentAfter.ctimeNs).toBe(externalIntentBefore.ctimeNs);
      expect((await stat(externalDir, { bigint: true })).mtimeNs).toBe(externalDirBefore.mtimeNs);
      await expect(readLocalVideoSubmitIntent(externalDir)).rejects.toMatchObject({
        code: "LOCAL_VIDEO_PRIOR_PAID_SUBMISSION_AMBIGUOUS"
      });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
      await rm(aliasJobDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });
});

describe("evidence-bound script validation", () => {
  test("binds every claim to an exact captured quote", () => {
    const result = validateEvidenceBoundScript(script(), sources, 2, "fixture");
    expect(result.researchStatus).toBe("verified");
    expect(result.evidenceTextBinding).toMatchObject({ algorithm: "deterministic-extractive-binding/v3", status: "extractively-bound", segmentCount: 2 });
    expect(result.evidenceTextBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyEvidenceBoundScript(result, sources, 2)).toMatchObject({ verified: true, bindingHash: result.evidenceTextBindingHash });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].sourceEvidence[0].sourceSha256).toBe(sources[0].sha256);
  });

  test("fails closed when a quote is paraphrased or invented", () => {
    const tampered = script();
    tampered.segments[0].evidenceRefs[0].quote = "돌 틈은 홍수를 완전히 막는다";
    expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow("원문과 일치하지 않습니다");
  });

  test("rejects duplicate claim identifiers", () => {
    const duplicate = script();
    duplicate.segments[1].claimId = duplicate.segments[0].claimId;
    expect(() => validateEvidenceBoundScript(duplicate, sources, 2)).toThrow("비어 있거나 중복됩니다");
  });

  test("rejects unrelated claims even when every quote is genuine", () => {
    const fields = {
      claim: "화성 로켓 발사는 인류를 다른 행성으로 운송합니다.",
      narration: "화성 로켓 발사는 인류를 다른 행성으로 운송합니다.",
      caption: "화성으로 가는 로켓",
      visualPrompt: "vertical cinematic launch of a rocket from Mars, no text"
    };
    for (const [field, value] of Object.entries(fields)) {
      const tampered = script();
      tampered.segments[0][field] = value;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
  });

  test("rejects unsupported numbers, proper names, absolute claims, and polarity reversals", () => {
    for (const narration of [
      "돌 사이 틈은 500년 동안 빗물을 빠져나가게 합니다.",
      "경복궁의 돌 사이 틈은 빗물이 빠져나가는 통로입니다.",
      "돌 사이 틈은 모든 홍수를 완전히 막습니다.",
      "돌 사이 틈은 빗물이 빠져나가지 못하게 합니다."
    ]) {
      const tampered = script();
      tampered.segments[0].narration = narration;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
    for (const visualPrompt of [
      "vertical documentary palace stone paving gaps carrying rainwater in 2099, no text",
      "vertical documentary palace stone paving gaps carrying rainwater on Mars, no text"
    ]) {
      const tampered = script();
      tampered.segments[0].visualPrompt = visualPrompt;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
  });

  test("requires verified research status and rejects a mutated binding receipt", () => {
    const unverified = script();
    unverified.researchStatus = "provided";
    expect(() => validateEvidenceBoundScript(unverified, sources, 2)).toThrow(/researchStatus: verified/);

    const validated = validateEvidenceBoundScript(script(), sources, 2);
    validated.segments[0].caption = "화성 로켓";
    expect(verifyEvidenceBoundScript(validated, sources, 2)).toMatchObject({ verified: false });

    const reordered = validateEvidenceBoundScript(script(), sources, 2);
    reordered.segments[1].narration = "미끄러질 위험은 거친 표면을 줄이는 데 도움을 줍니다.";
    expect(verifyEvidenceBoundScript(reordered, sources, 2)).toMatchObject({ verified: false });

    const replacedSources = structuredClone(sources);
    replacedSources[0].url = "https://another.example/source";
    const replaced = structuredClone(validateEvidenceBoundScript(script(), sources, 2));
    replaced.segments.forEach((segment) => {
      segment.evidenceRefs.forEach((reference) => { reference.sourceId = replacedSources[0].url; });
    });
    expect(verifyEvidenceBoundScript(replaced, replacedSources, 2)).toMatchObject({ verified: false });
  });

  test("fails closed on high-overlap contradictions and unsupported visual subjects", () => {
    for (const [field, value] of [
      ["claim", "궁궐 마당의 돌 사이 틈은 빗물을 가두는 통로로 기능한다."],
      ["narration", "궁궐 마당의 돌 사이 틈은 빗물이 안으로 들어오는 통로로 기능합니다."],
      ["caption", "빗물이 막히는 돌 틈"],
      ["visualPrompt", "palace courtyard stone gaps rainwater launch nuclear missile"]
    ]) {
      const tampered = script();
      tampered.segments[0][field] = value;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }

    const polarityPrefix = script();
    polarityPrefix.segments[0].claim = "궁궐 마당의 돌 사이 틈은 불안전하다.";
    expect(() => validateEvidenceBoundScript(polarityPrefix, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
  });

  test("rejects relation reversal, prefix collisions, hidden scripts, and unsupported global copy", () => {
    const relationSources = [{
      title: "배수 기록",
      url: "https://example.go.kr/drain",
      fetchStatus: "fetched",
      sha256: `sha256:${"d".repeat(64)}`,
      evidence: [{ id: "relation", locator: "text-offset:0-16", quote: "빗물은 배수로를 통과한다." }]
    }];
    const relationQuote = relationSources[0].evidence[0].quote;
    const relation = {
      title: relationQuote,
      hook: relationQuote,
      narration: relationQuote,
      researchStatus: "verified",
      segments: [{
        claimId: "relation-1",
        claim: relationQuote,
        caption: relationQuote,
        narration: relationQuote,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(relationQuote)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        evidenceRefs: [{ sourceId: relationSources[0].url, evidenceId: "relation", quote: relationQuote }]
      }]
    };
    for (const mutate of [
      (value) => { value.segments[0].claim = "배수로는 빗물을 통과한다."; },
      (value) => { value.segments[0].caption = "물, 배수로를 통과한다."; },
      (value) => { value.segments[0].visualPrompt += " 火星 核爆発"; },
      (value) => { value.title = "빗물 배수로 화성 로켓 핵폭발"; },
      (value) => { value.hook = "빗물 배수로 백 년"; }
    ]) {
      const tampered = structuredClone(relation);
      mutate(tampered);
      expect(() => validateEvidenceBoundScript(tampered, relationSources, 1)).toThrow(/extractive|일치하지 않습니다/);
    }
  });
});

describe("provider clip defaults", () => {
  test("never turns legacy Gemini text environment variables into an implicit provider request", async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "pipeline.mjs")).href;
    const source = {
      title: "공식 건축 기록",
      url: "https://example.go.kr/architecture",
      fetchStatus: "fetched",
      sha256: `sha256:${"a".repeat(64)}`,
      evidence: [{ id: "excerpt-1", locator: "text-offset:0-31", quote: "궁궐 마당의 돌 사이 틈은 빗물이 빠져나가는 통로로 기능한다." }]
    };
    const childSource = `
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error("unexpected provider request");
      };
      const { buildScript } = await import(${JSON.stringify(moduleUrl)});
      const script = await buildScript({
        topic: "경복궁 마당 배수 구조",
        provider: "gemini-browser",
        format: "vertical",
        clipCount: 1,
        targetDurationSec: 20,
        sources: [${JSON.stringify(source)}]
      });
      process.stdout.write(JSON.stringify({ fetchCalls, generatedBy: script.generatedBy }));
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GEMINI_API_KEY: "legacy-key-must-remain-inert",
        GEMINI_TEXT_MODEL: "legacy-model-must-remain-inert"
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ fetchCalls: 0, generatedBy: "evidence-extract-fallback" });
  });

  test("uses a two-clip Gemini default while preserving overrides and local defaults", async () => {
    const jobs = [];
    try {
      jobs.push(await createJob({ topic: "Gemini 기본값", provider: "gemini-browser" }));
      jobs.push(await createJob({ topic: "Gemini 명시값", provider: "gemini-browser", clipCount: 12 }));
      jobs.push(await createJob({ topic: "로컬 기본값", provider: "local-video" }));
      expect(jobs.map((job) => job.clipCount)).toEqual([2, 12, 6]);
    } finally {
      await Promise.all(jobs.map((job) => rm(join(JOBS_DIR, job.id), { recursive: true, force: true })));
    }
  });

  test("binds an explicit local-video duration to its own tolerance instead of the channel-wide range", async () => {
    const jobs = [];
    try {
      jobs.push(await createJob({ topic: "FLUX 명시 길이", provider: "local-video", clipCount: 2, targetDurationSec: 20 }));
      jobs.push(await createJob({ topic: "FLUX 벤치마크 길이", provider: "local-video", clipCount: 6 }));
      expect(jobs[0]).toMatchObject({ targetDurationSec: 20, targetDurationRangeSec: [19, 21] });
      expect(jobs[1].targetDurationRangeSec).not.toEqual([19, 21]);
      expect(jobs[1].targetDurationRangeSec[0]).toBeLessThan(jobs[1].targetDurationSec);
      expect(jobs[1].targetDurationRangeSec[1]).toBeGreaterThan(jobs[1].targetDurationSec);
    } finally {
      await Promise.all(jobs.map((job) => rm(join(JOBS_DIR, job.id), { recursive: true, force: true })));
    }
  });

  test("rejects malformed or silently clamped explicit durations", async () => {
    for (const targetDurationSec of [19, 181, 20.5, "20", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(createJob({ topic: "길이 계약 검증", provider: "local-video", targetDurationSec }))
        .rejects.toThrow("20초 이상 180초 이하의 정수");
    }
  });
});

const heritageArticle = `<!doctype html>
<html lang="ko">
  <body>
    <nav>본문 바로가기 주메뉴 바로가기 전체 메뉴 통합 검색 로그인</nav>
    <main>
      <p>콘텐츠 기본 정보 UCI I801:1501001-001-V00356 파일명 박석_1920X1080.mp4 107.26 MB 다운로드</p>
      <article>
        <p>박석은 얇고 넓적하게 만든 돌이다.</p>
        <p>조선시대 궁궐과 종묘의 주요 건물 바닥에는 박석이 중요한 건축재료로 사용되었다.</p>
        <p>울퉁불퉁한 표면은 빛의 반사 방향을 여러 갈래로 흩어 눈에 직접 닿지 않게 한다.</p>
        <p>박석의 틈 아래에는 물을 내보내는 마사토가 깔려 있다.</p>
        <p>마사토는 알갱이 크기가 커서 물을 내보내는 능력이 탁월하다.</p>
        <p>박석 사이의 마사토를 통해 배수가 진행되기 때문에 장대비에도 빗물이 쉽게 차오르지 않는다.</p>
      </article>
    </main>
    <footer>개인정보 저작권 정책 Copyright 2026 All Rights Reserved.</footer>
  </body>
</html>`;

describe("deterministic source evidence extraction", () => {
  test("prefers relevant Korean explanatory sentences and binds exact offsets", () => {
    const extracted = sourceExcerpt(
      new TextEncoder().encode(heritageArticle),
      "text/html; charset=utf-8",
      ["경복궁", "박석", "마사토", "배수"]
    );

    expect(extracted.evidence.length).toBeGreaterThanOrEqual(4);
    for (const item of extracted.evidence) {
      expect(item.quote).toMatch(/다\.$/u);
      expect(item.quote).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
      expect(extracted.excerpt).toContain(item.quote);
      const locator = /^text-offset:(\d+)-(\d+)$/.exec(item.locator);
      expect(locator).not.toBeNull();
      expect(Number(locator[2]) - Number(locator[1])).toBe(item.quote.length);
    }
  });

  test("builds four non-hallucinated clips from captured heritage prose", () => {
    const extracted = sourceExcerpt(
      new TextEncoder().encode(heritageArticle),
      "text/html",
      ["경복궁", "박석", "마사토", "배수"]
    );
    const source = {
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/paving",
      fetchStatus: "fetched",
      sha256: `sha256:${"b".repeat(64)}`,
      ...extracted
    };
    const result = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 4, [source], 32);

    expect(result.generatedBy).toBe("evidence-extract-fallback");
    expect(hasEvidenceHookFraming(result.title)).toBe(true);
    expect(result.title).toBe(result.segments[0].narration);
    expect(result.segments).toHaveLength(4);
    expect(result.segments.filter((segment) => /마사토|배수|빗물/u.test(segment.narration)).length).toBeGreaterThanOrEqual(2);
    for (const segment of result.segments) {
      const reference = segment.evidenceRefs[0];
      const captured = source.evidence.find((item) => item.id === reference.evidenceId);
      expect(segment.narration).toBe(reference.quote);
      expect(captured.quote).toContain(reference.quote);
      expect(segment.caption).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
    }
    const rainy = result.segments.find((segment) => segment.narration.startsWith("여름,"));
    if (rainy) expect(rainy.caption).not.toBe("여름");
  });

  test("keeps a 20-second evidence fallback inside the benchmark caption-density range", () => {
    const twoClip = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 2, [{
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/paving",
      fetchStatus: "fetched",
      sha256: `sha256:${"e".repeat(64)}`,
      ...sourceExcerpt(new TextEncoder().encode(heritageArticle), "text/html", ["경복궁", "박석", "마사토", "배수"])
    }], 20);
    const cues = captionEntriesForDuration(twoClip, 20);
    const cuesPerMinute = cues.length * 60 / 20;

    expect(cuesPerMinute).toBeGreaterThanOrEqual(60.59 * 0.5);
    expect(cuesPerMinute).toBeLessThanOrEqual(60.59 * 1.5);
    expect(Math.min(...cues.map((cue) => cue.end - cue.start))).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...cues.map((cue) => [...cue.text].length))).toBeLessThanOrEqual(12);
  });

  test("builds an aspect-aware extractive prompt for landscape jobs", () => {
    const landscape = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 2, [{
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/paving",
      fetchStatus: "fetched",
      sha256: `sha256:${"f".repeat(64)}`,
      ...sourceExcerpt(new TextEncoder().encode(heritageArticle), "text/html", ["경복궁", "박석", "마사토", "배수"])
    }], 20, "landscape");

    expect(landscape.videoFormat).toBe("landscape");
    expect(landscape.segments.every((segment) => segment.visualPrompt.startsWith("landscape cinematic documentary"))).toBe(true);
    expect(landscape.segments.every((segment) => !/\bvertical\b/i.test(segment.visualPrompt))).toBe(true);
    expect(verifyEvidenceBoundScript(landscape, landscape.sources, 2).verified).toBe(true);
  });

  test("re-ranks legacy wide evidence windows and refines quote locators", () => {
    const legacyQuote = [
      "콘텐츠 기본 정보 UCI I801:1501001-001-V00356 파일명 박석_1920X1080.mp4 107.26 MB 다운로드입니다.",
      "박석은 얇고 넓적하게 만든 돌이다.",
      "조선시대 궁궐과 종묘의 주요 건물 바닥에는 박석이 중요한 건축재료로 사용되었다.",
      "울퉁불퉁한 표면은 빛의 반사 방향을 여러 갈래로 흩어 눈에 직접 닿지 않게 한다.",
      "박석의 틈 아래에는 물을 내보내는 마사토가 깔려 있다.",
      "마사토는 알갱이 크기가 커서 물을 내보내는 능력이 탁월하다.",
      "박석 사이의 마사토를 통해 배수가 진행되기 때문에 장대비에도 빗물이 쉽게 차오르지 않는다.",
      "관련 홈페이지 https://example.go.kr 연락처 02-0000-0000 전체 메뉴입니다."
    ].join(" ");
    const legacySource = {
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/legacy",
      fetchStatus: "fetched",
      sha256: `sha256:${"c".repeat(64)}`,
      evidence: [{ id: "excerpt-wide", locator: "text-offset:500-1500", quote: legacyQuote }]
    };
    const result = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 4, [legacySource], 32);

    for (const segment of result.segments) {
      expect(segment.narration).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
      expect(segment.narration).toMatch(/다\.$/u);
      const offset = legacyQuote.indexOf(segment.narration);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(segment.sourceEvidence[0].locator).toBe(`text-offset:${500 + offset}-${500 + offset + segment.narration.length}`);
    }
  });

  test("fails closed when only menus, identifiers, or unrelated prose remain", () => {
    const unusable = {
      title: "경복궁 박석 공식 기록",
      url: "https://example.go.kr/heritage/menu-only",
      fetchStatus: "fetched",
      evidence: [{
        id: "excerpt-1",
        locator: "text-offset:0-300",
        quote: "경복궁 전체 메뉴를 선택하면 상세 정보를 볼 수 있습니다. UCI I801:1501001-001-V00356 파일명 video_1920X1080.mp4 다운로드입니다. 오늘은 날씨가 맑아서 산책하기 좋은 날입니다."
      }]
    };
    expect(() => evidenceFallbackScript("경복궁 박석 배수 구조", 4, [unusable], 32)).toThrow("유효한 검증 근거 문장이 부족합니다: 0/4");
  });
});

function fakeSourceRequestFactory(fixture, trace = {}) {
  trace.requests = trace.requests || 0;
  trace.requestDestroyed = trace.requestDestroyed || 0;
  trace.responseDestroyed = trace.responseDestroyed || 0;
  trace.emittedBytes = trace.emittedBytes || 0;
  return (_requestOptions, onResponse) => {
    trace.requests += 1;
    trace.requestOptions = _requestOptions;
    const request = new EventEmitter();
    let requestDestroyed = false;
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (requestDestroyed) return request;
      requestDestroyed = true;
      trace.requestDestroyed += 1;
      queueMicrotask(() => {
        if (error) request.emit("error", error);
        request.emit("close");
      });
      return request;
    };
    request.end = () => {
      queueMicrotask(() => {
        if (requestDestroyed) return;
        const response = new EventEmitter();
        response.statusCode = fixture.status || 200;
        response.headers = fixture.headers || {};
        response.complete = fixture.complete;
        let responseDestroyed = false;
        response.destroy = () => {
          if (!responseDestroyed) trace.responseDestroyed += 1;
          responseDestroyed = true;
          return response;
        };
        onResponse(response);
        queueMicrotask(() => {
          for (const chunk of fixture.chunks || []) {
            if (responseDestroyed || requestDestroyed) break;
            const bytes = Buffer.from(chunk);
            trace.emittedBytes += bytes.byteLength;
            response.emit("data", bytes);
          }
          if (!responseDestroyed && !requestDestroyed) response.emit(fixture.terminalEvent || "end");
          request.emit("close");
        });
      });
      return request;
    };
    return request;
  };
}

describe("source fetch and parser resource boundaries", () => {
  test("uses an exact textual media allowlist and publishes bounded parse receipts", () => {
    expect(normalizedSourceMediaType("Text/HTML ; charset=UTF-8")).toBe("text/html");
    for (const spoof of ["application/jsonp", "text/htmlx", "image/svg+xml", "application/octet-stream; text/plain"]) {
      expect(sourceExcerpt(Buffer.from("검증 가능한 문장 때문에 작동한다."), spoof, ["검증"])).toMatchObject({
        parseStatus: "unsupported-media-type",
        parseByteLength: 0,
        parseTruncated: false,
        evidence: []
      });
    }

    const largePlainText = Buffer.alloc(1024 * 1024, "a");
    const bounded = sourceExcerpt(largePlainText, "text/plain; charset=utf-8", ["검증"]);
    expect(bounded.parseByteLength).toBe(SOURCE_CAPTURE_POLICY.maximumParseBytes);
    expect(bounded.parseTruncated).toBe(true);
    expect(bounded.canonicalCharacterLength).toBeLessThanOrEqual(SOURCE_CAPTURE_POLICY.maximumCanonicalCharacters);
    expect(bounded.canonicalTruncated).toBe(true);
  });

  test("terminates malformed skip-tag markup linearly inside the parse prefix", () => {
    const malicious = Buffer.from("<script>".repeat(512 * 1024));
    const startedAt = performance.now();
    const bounded = sourceExcerpt(malicious, "text/html", ["검증"]);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(3_000);
    expect(bounded).toMatchObject({
      parseStatus: "parsed",
      parseByteLength: SOURCE_CAPTURE_POLICY.maximumParseBytes,
      parseTruncated: true,
      malformedMarkupTruncated: true,
      evidence: []
    });
  }, 3_500);

  test("caps JSON traversal, sentence scans, ranked candidates, and evidence", () => {
    const json = sourceExcerpt(
      Buffer.from(JSON.stringify(Array.from({ length: 9_000 }, () => "근거 문자열"))),
      "application/json",
      ["근거"]
    );
    expect(json.jsonValid).toBe(true);
    expect(json.jsonNodeCount).toBe(SOURCE_CAPTURE_POLICY.maximumJsonNodes);
    expect(json.jsonNodesTruncated).toBe(true);

    const wideObject = sourceExcerpt(
      Buffer.from(JSON.stringify(Object.fromEntries(Array.from({ length: 9_000 }, (_, index) => [`k${index}`, "근거"])))),
      "application/json",
      ["근거"]
    );
    expect(wideObject.jsonNodeCount).toBe(SOURCE_CAPTURE_POLICY.maximumJsonNodes);
    expect(wideObject.jsonNodesTruncated).toBe(true);

    const deep = sourceExcerpt(
      Buffer.from(`${"[".repeat(66)}"깊은 근거 문자열"${"]".repeat(66)}`),
      "application/json",
      ["근거"]
    );
    expect(deep.jsonDepthTruncated).toBe(true);

    const sentence = "가나다라마바사아자차카타파하나 때문에 작동한다.\n";
    const manySentences = sourceExcerpt(Buffer.from(sentence.repeat(20_000)), "text/plain", ["가나다라"]);
    expect(manySentences.sentenceCandidateCount).toBe(SOURCE_CAPTURE_POLICY.maximumSentenceCandidates);
    expect(manySentences.sentenceCandidatesTruncated).toBe(true);
    expect(manySentences.rankedCandidateCount).toBe(SOURCE_CAPTURE_POLICY.maximumRankedCandidates);
    expect(manySentences.rankedCandidatesTruncated).toBe(true);
    expect(manySentences.evidence.length).toBeLessThanOrEqual(SOURCE_CAPTURE_POLICY.maximumEvidence);
  });

  test("streams the full accepted response hash while retaining only the parse prefix", async () => {
    const chunks = [Buffer.alloc(300 * 1024, "a"), Buffer.alloc(300 * 1024, "b")];
    const bytes = Buffer.concat(chunks);
    const trace = {};
    const result = await requestPinnedSource(
      new URL("https://example.test/source"),
      "93.184.216.34",
      undefined,
      { requestFactory: fakeSourceRequestFactory({ status: 200, headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) }, chunks }, trace) }
    );

    expect(trace).toMatchObject({ requests: 1, emittedBytes: bytes.byteLength, responseDestroyed: 0 });
    expect(trace.requestOptions.headers).toEqual({
      "accept-encoding": "identity",
      "user-agent": "PS4-AI-Video-Studio/1.0 source-audit"
    });
    expect(trace.requestOptions.headers.authorization).toBeUndefined();
    expect(trace.requestOptions.headers.cookie).toBeUndefined();
    let pinnedLookup;
    trace.requestOptions.lookup("rebind.invalid", {}, (_error, address, family) => { pinnedLookup = { address, family }; });
    expect(pinnedLookup).toEqual({ address: "93.184.216.34", family: 4 });
    expect(result).toMatchObject({
      status: 200,
      byteLength: bytes.byteLength,
      parseTruncated: true,
      bodySkipped: false,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
    expect(result.parseBytes.byteLength).toBe(SOURCE_CAPTURE_POLICY.maximumParseBytes);
    expect(result.parseBytes).toEqual(bytes.subarray(0, SOURCE_CAPTURE_POLICY.maximumParseBytes));
  });

  test("rejects oversized declarations and encoded bodies before reading data", async () => {
    for (const headers of [
      { "content-type": "text/plain", "content-length": String(SOURCE_CAPTURE_POLICY.maximumResponseBytes + 1) },
      { "content-type": "text/plain", "content-length": "12, 13" },
      { "content-type": "text/plain", "content-encoding": "gzip" }
    ]) {
      const trace = {};
      await expect(requestPinnedSource(
        new URL("https://example.test/source"),
        "93.184.216.34",
        undefined,
        { requestFactory: fakeSourceRequestFactory({ status: 200, headers, chunks: [Buffer.alloc(1024)] }, trace) }
      )).rejects.toThrow();
      expect(trace.requests).toBe(1);
      expect(trace.emittedBytes).toBe(0);
      expect(trace.responseDestroyed).toBe(1);
    }
  });

  test("destroys a chunked response immediately after the full-body byte cap", async () => {
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const trace = {};
    await expect(requestPinnedSource(
      new URL("https://example.test/source"),
      "93.184.216.34",
      undefined,
      { requestFactory: fakeSourceRequestFactory({ status: 200, headers: { "content-type": "text/plain" }, chunks: Array(21).fill(chunk) }, trace) }
    )).rejects.toMatchObject({ code: "SOURCE_RESPONSE_TOO_LARGE" });
    expect(trace.emittedBytes).toBe(21 * 1024 * 1024);
    expect(trace.responseDestroyed).toBe(1);
    expect(trace.requestDestroyed).toBe(1);
  });

  test("rejects incomplete bodies and releases the global permit", async () => {
    for (const fixture of [
      { terminalEvent: "aborted", complete: false, contentLength: 2_048 },
      { terminalEvent: "close", complete: false, contentLength: 2_048 },
      { terminalEvent: "end", complete: true, contentLength: 2_048 }
    ]) {
      const trace = {};
      const result = await captureSource({ title: "불완전 응답", url: "https://example.test/source" }, "응답", {
        admissionTimeoutMs: 100,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        requestSourceFn: (url, address, signal) => requestPinnedSource(url, address, signal, {
          requestFactory: fakeSourceRequestFactory({
            status: 200,
            headers: { "content-type": "text/plain", "content-length": String(fixture.contentLength) },
            chunks: [Buffer.alloc(1024)],
            terminalEvent: fixture.terminalEvent,
            complete: fixture.complete
          }, trace)
        })
      });
      expect(result).toMatchObject({ fetchStatus: "blocked", errorCode: "SOURCE_RESPONSE_INCOMPLETE" });
      expect(trace).toMatchObject({ emittedBytes: 1024, requestDestroyed: 1 });
      expect(sourceCaptureAdmissionState()).toEqual({ active: 0, waiting: 0 });
    }
  });

  test("does not follow redirects or buffer redirect and non-success bodies", async () => {
    for (const status of [302, 404]) {
      const trace = {};
      const result = await requestPinnedSource(
        new URL("https://example.test/source"),
        "93.184.216.34",
        undefined,
        { requestFactory: fakeSourceRequestFactory({ status, headers: { location: "http://127.0.0.1/private" }, chunks: [Buffer.alloc(1024)] }, trace) }
      );
      expect(result).toMatchObject({ status, byteLength: 0, sha256: null, bodySkipped: true });
      expect(trace).toMatchObject({ requests: 1, emittedBytes: 0, responseDestroyed: 1 });
    }
  });

  test("rejects private, mapped, transition, or mixed DNS results before requests", () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "2002:7f00:1::"]) {
      expect(isPublicSourceAddress(address)).toBe(false);
    }
    expect(isPublicSourceAddress("8.8.8.8")).toBe(true);
    expect(isPublicSourceAddress("2606:4700:4700::1111")).toBe(true);
    expect(() => validatePublicSourceAddresses([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ])).toThrow("공용 네트워크");
  });

  test("shares three capture permits and nine waiters across distinct jobs", async () => {
    const fixedBytes = Buffer.from("가나다라마바사아자차카타파하나 때문에 작동한다.");
    const fixedResponse = {
      status: 200,
      headers: { "content-type": "text/plain" },
      byteLength: fixedBytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(fixedBytes).digest("hex")}`,
      parseBytes: fixedBytes,
      parseTruncated: false
    };
    let releaseInitialRequests;
    const initialRequestGate = new Promise((resolvePromise) => { releaseInitialRequests = resolvePromise; });
    let calls = 0;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const requestSourceFn = async () => {
      const call = ++calls;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        if (call <= SOURCE_CAPTURE_POLICY.maximumActiveCaptures) {
          await initialRequestGate;
        }
        return fixedResponse;
      } finally {
        activeRequests -= 1;
      }
    };
    const options = {
      admissionTimeoutMs: 1_000,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      requestSourceFn
    };
    const jobs = Array.from({ length: 13 }, (_, index) => ({
      topic: "전역 출처 admission",
      sources: [{ title: `출처 ${index}`, url: `https://source-${index}.example.test/article` }]
    }));
    const captures = jobs.map((job) => captureSources(job, options));

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = sourceCaptureAdmissionState();
      if (state.active === 3 && state.waiting === 9) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    }
    expect(sourceCaptureAdmissionState()).toEqual({ active: 3, waiting: 9 });
    releaseInitialRequests();
    const results = await Promise.all(captures);
    const records = results.flatMap((result) => result.records);

    expect(maximumActiveRequests).toBe(SOURCE_CAPTURE_POLICY.maximumActiveCaptures);
    expect(records.filter((record) => record.fetchStatus === "fetched")).toHaveLength(12);
    expect(records.filter((record) => record.errorCode === "SOURCE_CAPTURE_ADMISSION_SATURATED")).toHaveLength(1);
    expect(sourceCaptureAdmissionState()).toEqual({ active: 0, waiting: 0 });
  });

  test("times out DNS absolutely but retains its permit until late lookup settlement", async () => {
    let settleLookup;
    const lookupResult = new Promise((resolvePromise) => { settleLookup = resolvePromise; });
    let requestCalls = 0;
    const capture = captureSource({ title: "느린 DNS", url: "https://slow-dns.example.test/source" }, "DNS", {
      admissionTimeoutMs: 100,
      dnsTimeoutMs: 20,
      lookupFn: () => lookupResult,
      requestSourceFn: async () => {
        requestCalls += 1;
        throw new Error("DNS timeout 뒤 요청 금지");
      }
    });
    const result = await capture;
    expect(result).toMatchObject({ fetchStatus: "blocked", errorCode: "SOURCE_DNS_TIMEOUT" });
    expect(requestCalls).toBe(0);
    expect(sourceCaptureAdmissionState()).toEqual({ active: 1, waiting: 0 });

    settleLookup([{ address: "93.184.216.34", family: 4 }]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(sourceCaptureAdmissionState()).toEqual({ active: 0, waiting: 0 });
  });

  test("rejects invalid admission timeouts without consuming a permit", async () => {
    await expect(acquireSourceCapturePermit({ timeoutMs: 0 })).rejects.toThrow("admission timeout");
    expect(sourceCaptureAdmissionState()).toEqual({ active: 0, waiting: 0 });
  });

  test("removes a timed-out global capture waiter and releases all owners", async () => {
    const releases = await Promise.all(Array.from(
      { length: SOURCE_CAPTURE_POLICY.maximumActiveCaptures },
      () => acquireSourceCapturePermit({ timeoutMs: 100 })
    ));
    try {
      await expect(acquireSourceCapturePermit({ timeoutMs: 20 })).rejects.toMatchObject({ code: "SOURCE_CAPTURE_ADMISSION_TIMEOUT" });
      expect(sourceCaptureAdmissionState()).toEqual({ active: 3, waiting: 0 });
    } finally {
      releases.forEach((release) => release());
    }
    expect(sourceCaptureAdmissionState()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("temporal perceptual fingerprints", () => {
  test("reports zero distance for the same clip signature", () => {
    const frames = ["0000000000000000", "ffffffffffffffff"];
    expect(perceptualFingerprintDistance(frames, frames)).toBe(0);
  });

  test("separates visually different signatures", () => {
    expect(perceptualFingerprintDistance(["0000000000000000"], ["ffffffffffffffff"])).toBe(64);
  });
});
