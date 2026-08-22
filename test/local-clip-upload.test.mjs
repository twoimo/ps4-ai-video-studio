import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LOCAL_CLIP_UPLOAD_TRANSACTION,
  installLocalClipUpload,
  probeLocalClip,
  readLocalClipUploadTransactionStrict,
  recoverLocalClipUploadTransaction,
  validateLocalClipFiles,
  validateLocalClipProbeMetadata,
  verifyReadyLocalClipSet
} from "../src/local-clip-upload.mjs";
import { acquireLocalSubprocessPermit } from "../src/local-semantic-verifier.mjs";
import {
  createSessionToken,
  createStudioRequestHandler,
  recoverLocalClipUploadTransactions
} from "../src/server.mjs";
import { JOBS_DIR, createJob, readJob, writeJob } from "../src/pipeline.mjs";
import { writeJsonAtomic } from "../src/run-ledger.mjs";

const temporaryDirectories = [];
const MEDIA = Object.freeze({ durationSec: 5, width: 1080, height: 1920, codec: "h264", formatNames: ["mov", "mp4"] });

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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ps4-local-upload-"));
  temporaryDirectories.push(root);
  const job = {
    id: "job-local-upload-1",
    topic: "외부 생성 클립 편집",
    provider: "local",
    clipCount: options.clipCount ?? 2,
    status: options.status || "completed",
    stage: "완료",
    progress: 100,
    runId: "run-old",
    runStatus: "verified",
    artifacts: [{ name: "runs/run-old/artifacts/final.mp4" }],
    qualitySummary: { status: "passed" },
    duration: 20,
    warnings: ["old warning"],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z"
  };
  const jobDir = join(root, job.id);
  await mkdir(join(jobDir, "clips"), { recursive: true });
  await writeFile(join(jobDir, "clips", "old.mp4"), "old-clip");
  await writeJsonAtomic(join(jobDir, "job.json"), job);
  const readJobFn = async () => JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
  const writeJobFn = async (next) => writeJsonAtomic(join(jobDir, "job.json"), next);
  return { root, job, jobDir, readJobFn, writeJobFn };
}

async function canonicalFixture() {
  const job = await createJob({
    topic: "잘못된 UTF-8 로컬 업로드 복구 경계",
    provider: "local",
    clipCount: 2,
    targetDurationSec: 20
  });
  const jobDir = join(JOBS_DIR, job.id);
  temporaryDirectories.push(jobDir);
  return {
    job,
    jobDir,
    readJobFn: () => readJob(job.id),
    writeJobFn: (next) => writeJob(next)
  };
}

async function snapshotTree(root) {
  const records = [];
  async function visit(path, relativePath) {
    const metadata = await lstat(path, { bigint: true }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) {
      records.push({ path: relativePath, exists: false });
      return;
    }
    const record = {
      path: relativePath,
      exists: true,
      type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: Number(metadata.mode),
      nlink: String(metadata.nlink),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
      ctimeNs: String(metadata.ctimeNs)
    };
    if (metadata.isFile()) record.bytes = (await readFile(path)).toString("base64");
    records.push(record);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
    }
  }
  await visit(root, ".");
  return records;
}

async function injectInvalidUtf8StringByte(path, field, invalidBytes) {
  const bytes = await readFile(path);
  const prefix = Buffer.from(`"${field}": "`);
  const prefixOffset = bytes.indexOf(prefix);
  if (prefixOffset < 0) throw new Error(`${field} marker 문자열을 찾지 못했습니다.`);
  const valueOffset = prefixOffset + prefix.byteLength;
  const corrupted = Buffer.concat([
    bytes.subarray(0, valueOffset),
    Buffer.from(invalidBytes),
    bytes.subarray(valueOffset + 1)
  ]);
  await writeFile(path, corrupted);
}

async function prepareInvalidUtf8StagingTransaction(value, { field, invalidBytes }) {
  const interrupted = new Error("simulated pre-probe interruption");
  try {
    await installLocalClipUpload(
      value.jobDir,
      value.job,
      files(
        { name: "first.mp4", body: "partially-staged-clip" },
        { name: "second.mp4", body: "not-yet-staged" }
      ),
      options(value, {
        recoverOnError: false,
        probeClipFn: async () => { throw interrupted; }
      })
    );
    throw new Error("로컬 클립 staging interruption이 발생하지 않았습니다.");
  } catch (error) {
    if (error !== interrupted) throw error;
  }
  const transaction = await readLocalClipUploadTransactionStrict(value.jobDir);
  const markerPath = join(value.jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION);
  const stagingPath = join(value.jobDir, transaction.stagingName);
  const externalRoot = await mkdtemp(join(tmpdir(), "ps4-local-upload-external-"));
  temporaryDirectories.push(externalRoot);
  const externalPath = join(externalRoot, "do-not-touch.bin");
  await writeFile(externalPath, Buffer.from([0, 1, 2, 3, 254, 255]), { mode: 0o640 });
  await injectInvalidUtf8StringByte(markerPath, field, invalidBytes);
  const snapshot = async () => ({
    job: await snapshotTree(value.jobDir),
    external: await snapshotTree(externalRoot)
  });
  return { markerPath, stagingPath, externalPath, snapshot, before: await snapshot() };
}

function files(...values) {
  return values.map((value) => new File([value.body], value.name, { type: value.type || "video/mp4" }));
}

function options(value, extra = {}) {
  return {
    readJobFn: value.readJobFn,
    writeJobFn: value.writeJobFn,
    probeClipFn: async (_path, extension) => ({ ...MEDIA, formatNames: extension === ".webm" ? ["matroska", "webm"] : ["mov", "mp4"] }),
    nowFn: () => "2026-08-13T01:02:03.000Z",
    ...extra
  };
}

async function expectAllLocalSubprocessPermitsAvailable() {
  let releaseFirst = null;
  let releaseSecond = null;
  try {
    releaseFirst = await acquireLocalSubprocessPermit({ timeoutMs: 100 });
    releaseSecond = await acquireLocalSubprocessPermit({ timeoutMs: 100 });
  } finally {
    releaseFirst?.();
    releaseSecond?.();
  }
}

describe("manual local clip upload validation", () => {
  test("validates ffprobe resource options before spawning a child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-invalid-ffprobe-options-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "spawned");
    const binary = join(directory, "marker-ffprobe.sh");
    const media = join(directory, "clip.mp4");
    await writeFile(binary, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(media, "x");

    await expect(probeLocalClip(media, ".mp4", { ffprobePath: binary, maximumOutputBytes: 1 })).rejects.toBeInstanceOf(TypeError);
    await expect(probeLocalClip(media, ".mp4", { ffprobePath: binary, maximumOutputBytes: 1024 * 1024 + 1 })).rejects.toBeInstanceOf(TypeError);
    await expect(probeLocalClip(media, ".mp4", { ffprobePath: binary, timeoutMs: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(probeLocalClip(media, ".mp4", { ffprobePath: binary, admissionTimeoutMs: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(probeLocalClip(media, ".mp4", { ffprobePath: binary, admissionTimeoutMs: 30_001 })).rejects.toBeInstanceOf(TypeError);
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
  });

  test("shares bounded subprocess admission and never spawns before a permit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-ffprobe-admission-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "spawned");
    const binary = join(directory, "valid-ffprobe.sh");
    const media = join(directory, "clip.mp4");
    await writeFile(binary, `#!/bin/sh\ntouch "${marker}"\nprintf '%s\\n' '{"format":{"format_name":"mov,mp4","duration":"5"},"streams":[{"codec_type":"video","codec_name":"h264","width":1080,"height":1920}]}'\n`, { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(media, "x");

    let releaseFirst = await acquireLocalSubprocessPermit({ timeoutMs: 500 });
    const releaseSecond = await acquireLocalSubprocessPermit({ timeoutMs: 500 });
    try {
      await expect(probeLocalClip(media, ".mp4", {
        ffprobePath: binary,
        admissionTimeoutMs: 25
      })).rejects.toMatchObject({ code: "LOCAL_SUBPROCESS_ADMISSION_TIMEOUT" });
      expect(await readFile(marker).then(() => true, () => false)).toBe(false);

      releaseFirst();
      releaseFirst = null;
      await expect(probeLocalClip(media, ".mp4", {
        ffprobePath: binary,
        admissionTimeoutMs: 100
      })).resolves.toMatchObject(MEDIA);

      const releaseAfterSuccess = await acquireLocalSubprocessPermit({ timeoutMs: 100 });
      releaseAfterSuccess();
    } finally {
      releaseFirst?.();
      releaseSecond();
    }
  });

  test("bounds ffprobe output and terminates the noisy child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-noisy-ffprobe-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "noisy-ffprobe.sh");
    const media = join(directory, "clip.mp4");
    await writeFile(binary, "#!/bin/sh\nyes x | head -c 1048576\nsleep 30\n", { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(media, "x");
    const startedAt = Date.now();
    await expect(probeLocalClip(media, ".mp4", {
      ffprobePath: binary,
      maximumOutputBytes: 4096,
      timeoutMs: 10_000
    })).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_PROBE_OUTPUT_TOO_LARGE" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expectAllLocalSubprocessPermitsAvailable();
  });

  test("releases subprocess admission after ffprobe runtime timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-timeout-ffprobe-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "timeout-ffprobe.sh");
    const media = join(directory, "clip.mp4");
    await writeFile(binary, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(media, "x");

    await expect(probeLocalClip(media, ".mp4", {
      ffprobePath: binary,
      timeoutMs: 25,
      admissionTimeoutMs: 100
    })).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_PROBE_TIMEOUT" });

    await expectAllLocalSubprocessPermitsAvailable();
  });

  test("kills an inherited-stdio ffprobe grandchild without extending the timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-timeout-ffprobe-tree-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "timeout-tree-ffprobe.sh");
    const media = join(directory, "clip.mp4");
    const pidPath = join(directory, "grandchild.pid");
    const shellPidPath = `'${pidPath.replaceAll("'", `'"'"'`)}'`;
    await writeFile(binary, `#!/bin/sh\nsleep 30 &\ngrandchild=$!\nprintf '%s' "$grandchild" > ${shellPidPath}\nwait "$grandchild"\n`, { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(media, "x");
    let grandchildPid = null;
    try {
      const startedAt = Date.now();
      await expect(probeLocalClip(media, ".mp4", {
        ffprobePath: binary,
        // Leave enough startup budget for this helper to publish the child PID
        // even while Bun is running the other subprocess-heavy test files in
        // parallel. The descendant itself sleeps for 30 seconds, so a two
        // second deadline still proves that the process tree is terminated.
        timeoutMs: 2_000,
        admissionTimeoutMs: 100
      })).rejects.toMatchObject({ code: "LOCAL_CLIP_UPLOAD_PROBE_TIMEOUT" });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThan(4_000);
      grandchildPid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      await expectProcessTreeExit(grandchildPid);
      await expectAllLocalSubprocessPermitsAvailable();
    } finally {
      if (Number.isSafeInteger(grandchildPid) && processIsAlive(grandchildPid)) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      }
    }
  });

  test("releases subprocess admission when ffprobe cannot be spawned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-spawn-error-ffprobe-"));
    temporaryDirectories.push(directory);
    const media = join(directory, "clip.mp4");
    await writeFile(media, "x");

    await expect(probeLocalClip(media, ".mp4", {
      ffprobePath: join(directory, "missing-ffprobe"),
      admissionTimeoutMs: 100
    })).rejects.toBeTruthy();
    await expectAllLocalSubprocessPermitsAvailable();
  });

  test("requires the exact job clip count before touching the previous set", async () => {
    const value = await fixture();
    const beforeJob = await readFile(join(value.jobDir, "job.json"));
    const beforeClip = await readFile(join(value.jobDir, "clips", "old.mp4"));

    await expect(installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "one.mp4", body: "one" }),
      options(value)
    )).rejects.toThrow("정확히 2개");

    expect(await readFile(join(value.jobDir, "job.json"))).toEqual(beforeJob);
    expect(await readFile(join(value.jobDir, "clips", "old.mp4"))).toEqual(beforeClip);
    expect(await readdir(value.jobDir)).not.toContain(LOCAL_CLIP_UPLOAD_TRANSACTION);
  });

  test("rejects empty, unsupported, oversized, and duplicate clip bytes", async () => {
    expect(() => validateLocalClipFiles([new File([], "empty.mp4", { type: "video/mp4" })], 1)).toThrow("비어");
    expect(() => validateLocalClipFiles([new File(["x"], "clip.txt", { type: "text/plain" })], 1)).toThrow("MP4");
    expect(() => validateLocalClipFiles([{ name: "huge.mp4", type: "video/mp4", size: 11, arrayBuffer() {} }], 1, { maxFileBytes: 10, maxTotalBytes: 20 })).toThrow("최대 크기");

    const value = await fixture();
    await expect(installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "a.mp4", body: "same" }, { name: "b.mp4", body: "same" }),
      options(value)
    )).rejects.toThrow("바이트가 같습니다");
    expect(await readFile(join(value.jobDir, "clips", "old.mp4"), "utf8")).toBe("old-clip");
  });

  test("enforces the default 64 MiB per-file and aggregate upload budget", () => {
    const upload = (name, size) => ({ name, type: "video/mp4", size, arrayBuffer() {} });
    const exact = validateLocalClipFiles([upload("exact.mp4", 64 * 1024 * 1024)], 1);
    expect(exact.totalBytes).toBe(64 * 1024 * 1024);
    expect(() => validateLocalClipFiles([upload("too-large.mp4", 64 * 1024 * 1024 + 1)], 1))
      .toThrow("64MB");
    expect(() => validateLocalClipFiles([
      upload("first.mp4", 33 * 1024 * 1024),
      upload("second.mp4", 32 * 1024 * 1024)
    ], 2)).toThrow("64MB");
  });

  test("validates actual container, video stream, duration, and bounded 4K dimensions", () => {
    const valid = {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "20.0" },
      streams: [{ codec_type: "video", codec_name: "h264", width: 2160, height: 3840 }]
    };
    expect(validateLocalClipProbeMetadata(valid, ".mp4")).toMatchObject({ durationSec: 20, width: 2160, height: 3840, codec: "h264" });
    expect(() => validateLocalClipProbeMetadata(valid, ".webm")).toThrow("컨테이너");
    expect(() => validateLocalClipProbeMetadata({ ...valid, format: { ...valid.format, duration: "0.1" } }, ".mp4")).toThrow("길이는");
    expect(() => validateLocalClipProbeMetadata({ ...valid, streams: [{ ...valid.streams[0], width: 4320 }] }, ".mp4")).toThrow("해상도");
    expect(() => validateLocalClipProbeMetadata({ format: valid.format, streams: [{ codec_type: "audio" }] }, ".mp4")).toThrow("영상 스트림");
  });
});

describe("manual local clip upload marker UTF-8 integrity", () => {
  test("direct recovery rejects a lone continuation byte without changing owned or external state", async () => {
    const value = await fixture();
    const state = await prepareInvalidUtf8StagingTransaction(value, {
      field: "createdAt",
      invalidBytes: [0x80]
    });

    await expect(recoverLocalClipUploadTransaction(value.jobDir, {
      readJobFn: value.readJobFn,
      writeJobFn: value.writeJobFn
    })).rejects.toMatchObject({
      code: "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID",
      statusCode: 409
    });
    expect(await state.snapshot()).toEqual(state.before);
  });

  test("startup recovery isolates an overlong UTF-8 marker without changing owned or external state", async () => {
    const value = await canonicalFixture();
    const state = await prepareInvalidUtf8StagingTransaction(value, {
      field: "phaseUpdatedAt",
      invalidBytes: [0xc0, 0xaf]
    });

    const blocked = await recoverLocalClipUploadTransactions();
    expect(blocked.has(value.job.id)).toBe(true);
    await expect(readLocalClipUploadTransactionStrict(value.jobDir)).rejects.toMatchObject({
      code: "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID",
      statusCode: 409
    });
    expect(await state.snapshot()).toEqual(state.before);
  });

  test("route inspection blocks a malformed UTF-8 marker without changing owned or external state", async () => {
    const value = await canonicalFixture();
    const state = await prepareInvalidUtf8StagingTransaction(value, {
      field: "createdAt",
      invalidBytes: [0xe2, 0x28, 0xa1]
    });
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });

    const response = await handler(new Request(`http://127.0.0.1:3000/api/jobs/${value.job.id}`, {
      headers: { authorization: `Bearer ${token}` }
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).integrity).toMatchObject({
      status: "blocked",
      code: "local-clip-upload-transaction-integrity-failure",
      mutableJobPreserved: true
    });
    await expect(readLocalClipUploadTransactionStrict(value.jobDir)).rejects.toMatchObject({
      code: "LOCAL_CLIP_UPLOAD_TRANSACTION_INVALID",
      statusCode: 409
    });
    expect(await state.snapshot()).toEqual(state.before);
  });
});

describe("manual local clip upload publication", () => {
  test("keeps same-named files distinct with deterministic ordinal names and truthful provenance", async () => {
    const value = await fixture();
    const result = await installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "same.mp4", body: "first" }, { name: "same.mp4", body: "second" }),
      options(value)
    );

    expect(result).toMatchObject({ status: "committed", recovered: false, uploaded: [{ index: 1, name: "01.mp4" }, { index: 2, name: "02.mp4" }] });
    expect((await readdir(join(value.jobDir, "clips"))).sort()).toEqual(["01.mp4", "02.mp4"]);
    expect(await readFile(join(value.jobDir, "clips", "01.mp4"), "utf8")).toBe("first");
    expect(await readFile(join(value.jobDir, "clips", "02.mp4"), "utf8")).toBe("second");
    const job = await value.readJobFn();
    expect(job).toMatchObject({
      status: "queued",
      stage: "소스 준비",
      progress: 0,
      runId: null,
      runStatus: "queued",
      artifacts: [],
      localClipImport: {
        status: "ready",
        source: "manual-user-upload",
        providerEvidenceEligible: false,
        orderingPolicy: "multipart-file-order-v1",
        clipCount: 2
      }
    });
    expect(job).not.toHaveProperty("providerProvenance");
    expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
    await expect(verifyReadyLocalClipSet(value.jobDir, job)).resolves.toMatchObject({ receipt: { clipCount: 2 } });
  });

  test("rolls back old clips and terminal pointer after a crash before the forward decision", async () => {
    const value = await fixture();
    await expect(installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "a.mp4", body: "new-a" }, { name: "b.mp4", body: "new-b" }),
      options(value, {
        recoverOnError: false,
        hooks: { afterNewInstalledBeforeCommit: async () => { throw new Error("simulated power loss"); } }
      })
    )).rejects.toThrow("simulated power loss");

    expect((await readLocalClipUploadTransactionStrict(value.jobDir)).phase).toBe("swap-started");
    expect(await readFile(join(value.jobDir, "clips", "01.mp4"), "utf8")).toBe("new-a");
    expect((await value.readJobFn()).runId).toBe("run-old");

    const recovered = await recoverLocalClipUploadTransaction(value.jobDir, {
      readJobFn: value.readJobFn,
      writeJobFn: value.writeJobFn
    });
    expect(recovered.status).toBe("rolled-back");
    expect(await readFile(join(value.jobDir, "clips", "old.mp4"), "utf8")).toBe("old-clip");
    expect((await value.readJobFn()).runId).toBe("run-old");
    expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
    expect((await recoverLocalClipUploadTransaction(value.jobDir, { readJobFn: value.readJobFn, writeJobFn: value.writeJobFn })).status).toBe("absent");
  });

  test("finishes the new job pointer after a crash following the durable forward decision", async () => {
    const value = await fixture();
    await expect(installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "a.mp4", body: "new-a" }, { name: "b.webm", body: "new-b" }),
      options(value, {
        recoverOnError: false,
        hooks: { afterClipsInstalled: async () => { throw new Error("simulated power loss"); } }
      })
    )).rejects.toThrow("simulated power loss");

    expect((await readLocalClipUploadTransactionStrict(value.jobDir)).phase).toBe("clips-installed");
    expect((await value.readJobFn()).runId).toBe("run-old");
    const recovered = await recoverLocalClipUploadTransaction(value.jobDir, {
      readJobFn: value.readJobFn,
      writeJobFn: value.writeJobFn
    });
    expect(recovered.status).toBe("committed");
    expect((await value.readJobFn()).localClipImport).toMatchObject({ status: "ready", clipCount: 2 });
    expect((await readdir(join(value.jobDir, "clips"))).sort()).toEqual(["01.mp4", "02.webm"]);
    expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
  });

  test("startup rereads the canonical marker after a lease wait and forward-completes its latest phase", async () => {
    const value = await canonicalFixture();
    const ownerCrash = new Error("simulated owner crash after forward decision");
    let signalSwapStarted;
    let allowOwnerAdvance;
    const swapStarted = new Promise((resolvePromise) => { signalSwapStarted = resolvePromise; });
    const ownerMayAdvance = new Promise((resolvePromise) => { allowOwnerAdvance = resolvePromise; });
    const ownerOutcome = installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "lease-a.mp4", body: "lease-new-a" }, { name: "lease-b.webm", body: "lease-new-b" }),
      options(value, {
        recoverOnError: false,
        hooks: {
          afterNewInstalledBeforeCommit: async ({ transaction }) => {
            expect(transaction.phase).toBe("swap-started");
            signalSwapStarted();
            await ownerMayAdvance;
          },
          afterClipsInstalled: async () => { throw ownerCrash; }
        }
      })
    ).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error })
    );
    await swapStarted;

    const observedPhases = [];
    let leaseReleased = 0;
    const blocked = await recoverLocalClipUploadTransactions({
      readdirFn: async () => [{ name: value.job.id, isDirectory: () => true }],
      readTransactionFn: async (jobDir) => {
        const transaction = await readLocalClipUploadTransactionStrict(jobDir);
        observedPhases.push(transaction?.phase || null);
        return transaction;
      },
      acquireLeaseFn: async () => {
        allowOwnerAdvance();
        const outcome = await ownerOutcome;
        expect(outcome.error).toBe(ownerCrash);
        return { jobId: value.job.id };
      },
      releaseLeaseFn: async () => { leaseReleased += 1; }
    });

    expect([...blocked]).toEqual([]);
    expect(observedPhases).toEqual(["swap-started", "clips-installed"]);
    expect(leaseReleased).toBe(1);
    expect((await value.readJobFn()).localClipImport).toMatchObject({ status: "ready", clipCount: 2 });
    expect((await readdir(join(value.jobDir, "clips"))).sort()).toEqual(["01.mp4", "02.webm"]);
    expect(await readFile(join(value.jobDir, "clips", "01.mp4"), "utf8")).toBe("lease-new-a");
    expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
    expect((await readdir(value.jobDir)).filter((name) => name.startsWith(".clips-"))).toEqual([]);
  });

  test("does not remove or recover from a different same-id transaction snapshot", async () => {
    const value = await fixture();
    let expectedRemovalSnapshot = null;
    const outcome = await installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "cas-a.mp4", body: "cas-new-a" }, { name: "cas-b.mp4", body: "cas-new-b" }),
      options(value, {
        recoverOnError: false,
        hooks: {
          afterBackupRemoved: async ({ transaction }) => {
            expectedRemovalSnapshot = structuredClone(transaction);
            await writeJsonAtomic(join(value.jobDir, LOCAL_CLIP_UPLOAD_TRANSACTION), {
              ...transaction,
              phaseUpdatedAt: "2099-01-01T00:00:00.000Z"
            });
          }
        }
      })
    ).then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error })
    );

    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatchObject({ code: "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED", statusCode: 409 });
    const canonical = await readLocalClipUploadTransactionStrict(value.jobDir);
    expect(canonical).toMatchObject({
      transactionId: expectedRemovalSnapshot.transactionId,
      phase: "job-installed",
      phaseUpdatedAt: "2099-01-01T00:00:00.000Z"
    });
    const beforeStaleRecovery = await snapshotTree(value.jobDir);
    await expect(recoverLocalClipUploadTransaction(value.jobDir, {
      transaction: expectedRemovalSnapshot,
      readJobFn: value.readJobFn,
      writeJobFn: value.writeJobFn
    })).rejects.toMatchObject({
      code: "LOCAL_CLIP_UPLOAD_TRANSACTION_CHANGED",
      statusCode: 409
    });
    expect(await snapshotTree(value.jobDir)).toEqual(beforeStaleRecovery);

    await expect(recoverLocalClipUploadTransaction(value.jobDir, {
      readJobFn: value.readJobFn,
      writeJobFn: value.writeJobFn
    })).resolves.toMatchObject({ status: "committed" });
    expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
    expect((await readdir(join(value.jobDir, "clips"))).sort()).toEqual(["01.mp4", "02.mp4"]);
  });

  test("fails closed when a ready clip set is changed after publication", async () => {
    const value = await fixture();
    const result = await installLocalClipUpload(
      value.jobDir,
      value.job,
      files({ name: "a.mp4", body: "new-a" }, { name: "b.mp4", body: "new-b" }),
      options(value)
    );
    await writeFile(join(value.jobDir, "clips", "01.mp4"), "tampered");
    await expect(verifyReadyLocalClipSet(value.jobDir, result.job)).rejects.toThrow("영수증과 달라");
  });

  test("rejects a receipt whose declared duration, dimensions, policy, or timestamp is not reproduced by entries", async () => {
    for (const mutate of [
      (receipt) => { receipt.totalDurationSec += 1; },
      (receipt) => { receipt.entries[0].width = 8192; },
      (receipt) => { receipt.orderingPolicy = "filename-sort"; },
      (receipt) => { receipt.importedAt = "not-a-date"; }
    ]) {
      const value = await fixture();
      const result = await installLocalClipUpload(
        value.jobDir,
        value.job,
        files({ name: "a.mp4", body: `new-a-${temporaryDirectories.length}` }, { name: "b.mp4", body: `new-b-${temporaryDirectories.length}` }),
        options(value)
      );
      const next = structuredClone(result.job);
      mutate(next.localClipImport);
      await value.writeJobFn(next);
      await expect(verifyReadyLocalClipSet(value.jobDir, next)).rejects.toThrow("다시 업로드");
    }
  });

  test("recovers repeated hard exits during pre-probe staging without leaving hidden upload bytes", async () => {
    const value = await fixture();
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "local-clip-upload.mjs")).href;
    const ledgerUrl = pathToFileURL(join(process.cwd(), "src", "run-ledger.mjs")).href;
    const childSource = `
      import { readFile } from "node:fs/promises";
      import { installLocalClipUpload } from ${JSON.stringify(moduleUrl)};
      import { writeJsonAtomic } from ${JSON.stringify(ledgerUrl)};
      const jobDir = process.env.PS4_UPLOAD_CRASH_JOB_DIR;
      const job = JSON.parse(await readFile(jobDir + "/job.json", "utf8"));
      const readJobFn = async () => JSON.parse(await readFile(jobDir + "/job.json", "utf8"));
      const writeJobFn = async (next) => writeJsonAtomic(jobDir + "/job.json", next);
      const payload = new Uint8Array(1024 * 1024);
      await installLocalClipUpload(jobDir, job, [
        new File([payload], "first.mp4", { type: "video/mp4" }),
        new File([payload, "different"], "second.mp4", { type: "video/mp4" })
      ], {
        readJobFn,
        writeJobFn,
        probeClipFn: async () => process.exit(91)
      });
    `;
    const beforeJob = await readFile(join(value.jobDir, "job.json"));
    const beforeClip = await readFile(join(value.jobDir, "clips", "old.mp4"));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const child = Bun.spawn([process.execPath, "-e", childSource], {
        cwd: process.cwd(),
        env: { ...process.env, PS4_UPLOAD_CRASH_JOB_DIR: value.jobDir },
        stdout: "pipe",
        stderr: "pipe"
      });
      expect(await child.exited).toBe(91);
      const transaction = await readLocalClipUploadTransactionStrict(value.jobDir);
      expect(transaction.phase).toBe("staging");
      expect(transaction.stagingPlan).toHaveLength(2);
      expect(transaction.stagingPlan[0]).toEqual({ index: 1, storedName: "01.mp4", declaredBytes: 1024 * 1024 });
      expect((await readdir(value.jobDir)).filter((name) => name.startsWith(".clips-upload-"))).toHaveLength(1);

      const recovered = await recoverLocalClipUploadTransaction(value.jobDir, {
        readJobFn: value.readJobFn,
        writeJobFn: value.writeJobFn
      });
      expect(recovered).toMatchObject({ status: "rolled-back", job: "previous" });
      expect(await readLocalClipUploadTransactionStrict(value.jobDir)).toBeNull();
      expect((await readdir(value.jobDir)).filter((name) => name.startsWith(".clips-upload-"))).toEqual([]);
      expect(await readFile(join(value.jobDir, "job.json"))).toEqual(beforeJob);
      expect(await readFile(join(value.jobDir, "clips", "old.mp4"))).toEqual(beforeClip);
    }
  });
});
