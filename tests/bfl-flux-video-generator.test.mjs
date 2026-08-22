import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, cp, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  GLOBAL_BFL_GUARD_HOST,
  GLOBAL_BFL_GUARD_PORT,
  assertLiveBudget,
  dryRunReceipt,
  dryRunRequested,
  fetchBounded,
  generate as repositoryGenerate,
  generationPlan as repositoryGenerationPlan,
  isOfficialDeliveryHostname,
  pollingUrlFrom,
  preflightBflStorage as repositoryPreflightBflStorage,
  readJsonResponse,
  readVideoResponse,
  redactCompletedReceiptForOutput,
  redactValue,
  resultUrlFrom
} from "../scripts/bfl-flux-video-generator.mjs";
import {
  attachLocalVideoSubmissionIntent,
  localVideoPaidApprovalEvidenceBound,
  localVideoProviderRequestBodyClosureBound,
  validateLocalVideoReceipt
} from "../src/local-video-provider.mjs";
import { BFL_EXECUTOR_SNAPSHOT_NAME, buildBflExecutorBytes } from "../src/bfl-executor-snapshot.mjs";
import {
  bindBflLaunchCapabilityToRequest,
  buildBflPaidApprovalContext,
  canonicalBflRequestHash,
  consumeBflPaidApproval,
  createBflPaidApprovalReceipt,
  hashBflApprovalValue,
  persistBflPaidApproval,
  verifyBflConsumedApprovalForRequest
} from "../src/bfl-paid-approval.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/bfl-flux-video-request.json", import.meta.url), "utf8"));
const API_KEY = "bfl-test-key/with+symbols";
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXECUTOR_CLOSURE_FILES = Object.freeze([
  "scripts/bfl-flux-video-generator.mjs",
  "src/bfl-executor-snapshot.mjs",
  "src/bfl-paid-approval.mjs",
  "src/dirfd-platform.mjs",
  "src/dirfd.mjs",
  "src/run-ledger.mjs"
]);
const EXECUTOR_CLOSURE_IMPORTS = Object.freeze([
  "scripts/bfl-flux-video-generator.mjs->src/dirfd.mjs",
  "scripts/bfl-flux-video-generator.mjs->src/bfl-paid-approval.mjs",
  "src/bfl-paid-approval.mjs->src/bfl-executor-snapshot.mjs",
  "src/dirfd.mjs->src/dirfd-platform.mjs",
  "src/bfl-paid-approval.mjs->src/run-ledger.mjs"
]);
let temporaryDirectories;
let childProcesses;
let testProjectsByJobId;
let sharedTestProject;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function testHashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function testHashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function localExecutorImports(relativePath, bytes) {
  const imports = [];
  const source = bytes.toString("utf8");
  const pattern = /(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const target = resolve(dirname(join(PROJECT_ROOT, relativePath)), match[1]);
    imports.push(`${relativePath}->${target.slice(PROJECT_ROOT.length + 1).replaceAll("\\", "/")}`);
  }
  return imports.sort();
}

async function assertExactExecutorFixture(projectRoot, sourceBytes) {
  const actualFiles = [
    ...(await readdir(join(projectRoot, "scripts"))).map((name) => `scripts/${name}`),
    ...(await readdir(join(projectRoot, "src"))).map((name) => `src/${name}`)
  ].sort();
  const expectedFiles = [...EXECUTOR_CLOSURE_FILES].sort();
  const mismatches = [];
  const imports = [];
  for (const relativePath of expectedFiles) {
    const copied = await readFile(join(projectRoot, relativePath));
    const source = sourceBytes.get(relativePath);
    if (!source?.equals(copied)) {
      mismatches.push(`${relativePath}:${testHashBytes(source || Buffer.alloc(0))}->${testHashBytes(copied)}`);
    }
    imports.push(...localExecutorImports(relativePath, copied));
  }
  if (
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)
    || JSON.stringify(imports.sort()) !== JSON.stringify([...EXECUTOR_CLOSURE_IMPORTS].sort())
    || mismatches.length
  ) {
    throw new Error(`BFL temporary executor fixture mismatch: ${JSON.stringify({ actualFiles, imports: imports.sort(), mismatches })}`);
  }
  return {
    actualFiles,
    imports: imports.sort(),
    hashes: Object.fromEntries(expectedFiles.map((relativePath) => [relativePath, testHashBytes(sourceBytes.get(relativePath))]))
  };
}

function submissionIntentFor(request) {
  const unsigned = {
    schemaVersion: 1,
    type: "local-video-provider-submit-intent",
    status: "spawn-authorized",
    provider: "local-video",
    jobId: request.jobId,
    runId: request.runId,
    requestHash: request.requestHash,
    scriptHash: request.scriptHash,
    paidAuthorizationHash: request.paidAuthorization.authorizationHash,
    generatorName: request.paidAuthorization.context.adapterName,
    generatorSha256: request.paidAuthorization.context.adapterSha256,
    executorSnapshotName: request.paidAuthorization.context.executorSnapshotName,
    executorSnapshotSha256: request.paidAuthorization.context.executorSnapshotSha256,
    createdAt: request.paidAuthorization.approvedAt
  };
  return { ...unsigned, intentHash: testHashJson(unsigned) };
}

function requestFor(directory, overrides = {}) {
  return structuredClone({ ...fixture, jobWorkingDirectory: directory, ...overrides });
}

function adapterForRequest(request) {
  return testProjectsByJobId.get(request?.jobId)?.adapterModule || null;
}

function generationPlan(request, environment) {
  const adapter = adapterForRequest(request);
  return (adapter?.generationPlan || repositoryGenerationPlan)(request, environment);
}

async function generate(request, apiKey, runtime) {
  const adapter = adapterForRequest(request);
  return (adapter?.generate || repositoryGenerate)(request, apiKey, runtime);
}

async function preflightBflStorage(request, environment) {
  const adapter = adapterForRequest(request);
  return (adapter?.preflightBflStorage || repositoryPreflightBflStorage)(request, environment);
}

async function authorizedRequest(directory, overrides = {}, environment = liveEnvironment(), approvalOptions = {}) {
  const testProject = testProjectsByJobId.get(basename(directory));
  if (!testProject) throw new Error("BFL test project is not bound to its temporary job directory");
  const request = requestFor(directory, overrides);
  delete request.jobWorkingDirectory;
  request.jobId = basename(directory);
  request.clipCount = request.segments.length;
  request.captions = true;
  request.voiceover = true;
  request.jobCreatedAt = "2026-08-13T00:00:00.000Z";
  request.requestHash = canonicalBflRequestHash(request);
  const approvalEnvironment = {
    ...environment,
    BFL_API_KEY: API_KEY,
    PS4_LOCAL_VIDEO_GENERATOR: testProject.adapterPath,
    BFL_MAX_CREDITS: environment.BFL_MAX_CREDITS || "1000",
    BFL_ESTIMATED_TOTAL_CREDITS: environment.BFL_ESTIMATED_TOTAL_CREDITS
      || String(request.segments.length * 5 * (environment.BFL_VIDEO_RESOLUTION === "fhd" ? 29 : 17))
  };
  const job = {
    id: request.jobId,
    provider: "local-video",
    topic: request.topic,
    format: request.format,
    clipCount: request.clipCount,
    targetDurationSec: request.targetDurationSec,
    targetDurationRangeSec: request.targetDurationRangeSec,
    captions: request.captions,
    voiceover: request.voiceover,
    createdAt: request.jobCreatedAt
  };
  const context = await buildBflPaidApprovalContext({ root: testProject.root, job, env: approvalEnvironment });
  const now = new Date();
  const receipt = createBflPaidApprovalReceipt(context, {
    now,
    expiresAt: new Date(now.getTime() + (approvalOptions.lifetimeMs || 60 * 60 * 1000)),
    reason: approvalOptions.reason || "테스트가 정확한 provider 요청과 비용 상한을 명시적으로 승인함",
    apiKey: API_KEY
  });
  await persistBflPaidApproval(directory, receipt, { apiKey: API_KEY });
  const consumed = await consumeBflPaidApproval(directory, context, { now, apiKey: API_KEY });
  const paidAuthorization = bindBflLaunchCapabilityToRequest(consumed.capability, request, { now });
  const authorized = { ...request, paidAuthorization };
  if (context.executorSnapshotSha256 !== testProject.executorSnapshotSha256) {
    throw new Error("BFL temporary executor bytes do not match the approval context");
  }
  const executorSnapshotPath = join(directory, BFL_EXECUTOR_SNAPSHOT_NAME);
  await writeFile(executorSnapshotPath, testProject.executorSnapshotBytes, { mode: 0o500 });
  await chmod(executorSnapshotPath, 0o500);
  if (!approvalOptions.skipClaim) {
    await verifyBflConsumedApprovalForRequest(directory, paidAuthorization, authorized, {
      now,
      apiKey: API_KEY,
      adapterPath: testProject.adapterPath,
      claim: true
    });
  }
  return authorized;
}

function forgeAuthorizationWindow(authorization, expiresAt) {
  const capabilityUnsigned = {
    schemaVersion: authorization.schemaVersion,
    type: "bfl-paid-launch-capability",
    provider: authorization.provider,
    status: "consumed-launch-authorized",
    approvalHash: authorization.approvalHash,
    contextHash: authorization.contextHash,
    nonce: authorization.nonce,
    approvedAt: authorization.approvedAt,
    expiresAt,
    consumedReceiptName: authorization.consumedReceiptName,
    context: authorization.context
  };
  const unsigned = {
    ...authorization,
    expiresAt,
    capabilityHash: hashBflApprovalValue(capabilityUnsigned)
  };
  delete unsigned.authorizationHash;
  return { ...unsigned, authorizationHash: hashBflApprovalValue(unsigned) };
}

function testShotPattern(patternId = "locked-static-evidence") {
  return {
    patternId,
    sourceUrls: ["https://example.com/evidence"],
    renderedCameraPromptHash: `sha256:${"1".repeat(64)}`,
    continuityContractHash: `sha256:${"2".repeat(64)}`,
    applicationMode: "provider-prompt",
    providerEligible: true,
    providerSubmissionPlanned: true,
    factualTextAdded: false
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function liveEnvironment(overrides = {}) {
  return {
    BFL_MAX_CREDITS: "1000",
    BFL_ESTIMATED_CREDITS_PER_SECOND: "17",
    BFL_POLL_INTERVAL_MS: "10",
    BFL_POLL_TIMEOUT_MS: "10000",
    ...overrides
  };
}

beforeAll(async () => {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "ps4-bfl-contract-project-")));
  const sourceBytes = new Map(await Promise.all(EXECUTOR_CLOSURE_FILES.map(async (relativePath) => (
    [relativePath, await readFile(join(PROJECT_ROOT, relativePath))]
  ))));
  await Promise.all(EXECUTOR_CLOSURE_FILES.map(async (relativePath) => {
    const destination = join(projectRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(PROJECT_ROOT, relativePath), destination);
  }));
  const fixtureDiagnostic = await assertExactExecutorFixture(projectRoot, sourceBytes);
  const adapterPath = join(projectRoot, "scripts", "bfl-flux-video-generator.mjs");
  const adapterModule = await import(pathToFileURL(adapterPath).href);
  let executorSnapshotBytes;
  try {
    executorSnapshotBytes = await buildBflExecutorBytes(adapterPath, projectRoot);
  } catch (error) {
    throw new Error(`BFL canonical temporary executor build failed: ${JSON.stringify(fixtureDiagnostic)}`, { cause: error });
  }
  const executorSnapshotSha256 = `sha256:${createHash("sha256").update(executorSnapshotBytes).digest("hex")}`;
  await mkdir(join(projectRoot, "workspace", "jobs"), { recursive: true });
  sharedTestProject = { root: projectRoot, adapterPath, adapterModule, executorSnapshotBytes, executorSnapshotSha256, fixtureDiagnostic };
});

beforeEach(() => {
  temporaryDirectories = [];
  childProcesses = [];
  testProjectsByJobId = new Map();
});

afterEach(async () => {
  await Promise.all(childProcesses.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await rm(sharedTestProject?.root, { recursive: true, force: true });
});

async function temporaryDirectory() {
  if (!sharedTestProject) throw new Error("BFL temporary test project is not initialized");
  const jobsDirectory = join(sharedTestProject.root, "workspace", "jobs");
  const directory = await mkdtemp(join(jobsDirectory, "bfl-contract-test-"));
  await mkdir(join(directory, "clips"), { mode: 0o700 });
  temporaryDirectories.push(directory);
  testProjectsByJobId.set(basename(directory), sharedTestProject);
  return directory;
}

async function waitForChildSignal(child, signalPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(signalPath).then((entry) => entry.isFile()).catch(() => false)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`BFL crash-test child exited before its signal (${child.exitCode ?? child.signalCode})`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("BFL crash-test child did not reach its durable boundary");
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  child.kill("SIGKILL");
  const result = await exited;
  expect(result.signal).toBe("SIGKILL");
}

async function spawnCrashBoundaryChild(directory, request, mode) {
  const testProject = testProjectsByJobId.get(request.jobId);
  if (!testProject) throw new Error("BFL crash test is not bound to a temporary project");
  const requestPath = join(directory, `crash-request-${mode}.json`);
  const signalPath = join(directory, `crash-signal-${mode}`);
  const runnerPath = join(directory, `crash-runner-${mode}.mjs`);
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(runnerPath, `
import { readFile, writeFile } from "node:fs/promises";
import { generate } from ${JSON.stringify(pathToFileURL(testProject.adapterPath).href)};

const request = JSON.parse(await readFile(process.env.BFL_TEST_REQUEST_PATH, "utf8"));
const env = JSON.parse(process.env.BFL_TEST_ENV);
const mode = process.env.BFL_TEST_CRASH_MODE;
const signalPath = process.env.BFL_TEST_SIGNAL_PATH;
const forever = () => new Promise(() => {});

await generate(request, process.env.BFL_API_KEY, {
  env,
  sleep: async () => {},
  afterPreparedCheckpoints: mode === "pre-claim" ? async () => {
    await writeFile(signalPath, "prepared-before-claim");
    await forever();
  } : undefined,
  fetchImpl: async (url, options = {}) => {
    if (mode !== "submitted-ack") throw new Error("pre-claim child must not access the provider mock");
    if (options.method === "POST") {
      return new Response(JSON.stringify({
        id: "task-sigkill-submitted-1",
        polling_url: "https://api.bfl.ai/v1/get_result?id=task-sigkill-submitted-1",
        cost: 1
      }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://api.bfl.ai/")) {
      await writeFile(signalPath, "submitted-acknowledged");
      await forever();
    }
    throw new Error("submitted child reached an unexpected provider mock URL");
  }
});
`);
  const child = spawn(process.execPath, [runnerPath], {
    cwd: testProject.root,
    env: {
      ...process.env,
      BFL_API_KEY: API_KEY,
      BFL_TEST_REQUEST_PATH: requestPath,
      BFL_TEST_SIGNAL_PATH: signalPath,
      BFL_TEST_CRASH_MODE: mode,
      BFL_TEST_ENV: JSON.stringify(liveEnvironment())
    },
    stdio: "ignore"
  });
  childProcesses.push(child);
  await waitForChildSignal(child, signalPath);
  return { child, signalPath };
}

async function providerExecutionClaimNames(directory) {
  return (await readdir(directory)).filter((name) => name.startsWith("bfl-paid-provider-execution-")).sort();
}

describe("BFL delivery and polling URL validation", () => {
  it("accepts current documented delivery host forms and rejects suffix confusion", () => {
    expect(isOfficialDeliveryHostname("delivery-us1.bfl.ai")).toBe(true);
    expect(isOfficialDeliveryHostname("delivery.eu2.bfl.ai")).toBe(true);
    expect(isOfficialDeliveryHostname("delivery--us1.bfl.ai")).toBe(false);
    expect(isOfficialDeliveryHostname("delivery.us1.extra.bfl.ai")).toBe(false);
    expect(isOfficialDeliveryHostname("delivery-us1.bfl.ai.attacker.example")).toBe(false);
    expect(isOfficialDeliveryHostname("bfl.ai.attacker.example")).toBe(false);
  });

  it("accepts only HTTPS delivery URLs on an exact approved host", () => {
    const valid = "https://delivery-us1.bfl.ai/results/video.mp4?se=soon&sig=signed-value";
    expect(resultUrlFrom({ result: { video: { url: valid } } }, API_KEY, {})).toBe(valid);
    expect(() => resultUrlFrom({ result: { video: { url: "http://delivery-us1.bfl.ai/video.mp4" } } }, API_KEY, {})).toThrow("HTTPS");
    expect(() => resultUrlFrom({ result: { video: { url: "https://delivery-us1.bfl.ai.attacker.example/video.mp4" } } }, API_KEY, {})).toThrow("not an approved");
    expect(() => resultUrlFrom({ result: { video: { url: "https://127.0.0.1/video.mp4" } } }, API_KEY, {})).toThrow("private, local, or an IP literal");
    expect(() => resultUrlFrom({ result: { video: { url: "https://user:pass@delivery-us1.bfl.ai/video.mp4" } } }, API_KEY, {})).toThrow("credentials");
    expect(() => resultUrlFrom({ result: { video: { url: "https://delivery-us1.bfl.ai:444/video.mp4" } } }, API_KEY, {})).toThrow("default HTTPS port");
  });

  it("allows an explicit exact custom media hostname but rejects unsafe configuration", () => {
    const custom = "https://media.example.com/video.mp4";
    expect(resultUrlFrom({ result: { video: { url: custom } } }, API_KEY, { BFL_MEDIA_HOSTS: "media.example.com" })).toBe(custom);
    expect(() => resultUrlFrom({ result: { video: { url: custom } } }, API_KEY, { BFL_MEDIA_HOSTS: "localhost" })).toThrow("unsafe hostname");
    expect(() => resultUrlFrom({ result: { video: { url: custom } } }, API_KEY, { BFL_MEDIA_HOSTS: "https://media.example.com" })).toThrow("without schemes");
  });

  it("binds polling to an official API origin, exact path, and matching task ID", () => {
    const taskId = "task-123";
    expect(pollingUrlFrom({ polling_url: `https://api.eu.bfl.ai/v1/get_result?id=${taskId}` }, taskId, API_KEY)).toBe(`https://api.eu.bfl.ai/v1/get_result?id=${taskId}`);
    expect(() => pollingUrlFrom({ polling_url: `https://api.bfl.ai.attacker.example/v1/get_result?id=${taskId}` }, taskId, API_KEY)).toThrow("not approved");
    expect(() => pollingUrlFrom({ polling_url: `https://api.bfl.ai/v1/get_result?id=other` }, taskId, API_KEY)).toThrow("does not match");
    expect(() => pollingUrlFrom({ polling_url: `https://api.bfl.ai/v1/other?id=${taskId}` }, taskId, API_KEY)).toThrow("path is not approved");
    expect(() => pollingUrlFrom({ polling_url: `https://api.bfl.ai/v1/get_result?id=${taskId}&token=secret` }, taskId, API_KEY)).toThrow("sensitive query");
  });
});

describe("BFL bounded provider response lifecycle", () => {
  const endpoint = "https://api.bfl.ai/v1/unit-test";
  const consumeJson = (maximumBytes = 1024 * 1024) => (response, { signal }) => (
    readJsonResponse(response, "unit", { signal, maximumBytes })
  );

  it("keeps one absolute deadline across a hanging fetch and a hanging JSON body", async () => {
    const startedHeaders = Date.now();
    await expect(fetchBounded(
      endpoint,
      { headers: { accept: "application/json" } },
      30,
      async () => new Promise(() => {}),
      consumeJson()
    )).rejects.toThrow("timed out");
    expect(Date.now() - startedHeaders).toBeLessThan(1_000);

    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"'));
      },
      cancel() { canceled = true; }
    });
    const startedBody = Date.now();
    await expect(fetchBounded(
      endpoint,
      { headers: { accept: "application/json" } },
      30,
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
      consumeJson()
    )).rejects.toThrow("timed out");
    expect(Date.now() - startedBody).toBeLessThan(1_000);
    expect(canceled).toBe(true);
  });

  it("cancels slow JSON chunks when the original request deadline expires", async () => {
    let canceled = false;
    let stopped = false;
    let timer;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        timer = setTimeout(() => {
          if (!stopped) controller.enqueue(new TextEncoder().encode('"ok":true}'));
        }, 250);
      },
      cancel() {
        stopped = true;
        canceled = true;
        clearTimeout(timer);
      }
    });
    await expect(fetchBounded(
      endpoint,
      {},
      35,
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
      consumeJson()
    )).rejects.toThrow("timed out");
    expect(canceled).toBe(true);
  });

  it("bounds JSON bytes and requires exact length, MIME, identity encoding, and fatal UTF-8", async () => {
    await expect(fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response('{"oversized":true}', { headers: { "content-type": "application/json" } }),
      consumeJson(8)
    )).rejects.toThrow("maximum size");

    await expect(fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json", "content-length": "99" } }),
      consumeJson()
    )).rejects.toThrow("declared Content-Length");

    await expect(fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response('{"ok":true}', { headers: { "content-type": "text/plain" } }),
      consumeJson()
    )).rejects.toThrow("invalid Content-Type");

    await expect(fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
      consumeJson()
    )).rejects.toThrow("unsupported Content-Encoding");

    await expect(fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json", "content-length": "1" } }),
      consumeJson()
    )).rejects.toThrow("valid UTF-8");
  });

  it("accepts a complete bounded JSON response and never exposes a stream error secret", async () => {
    const bytes = new TextEncoder().encode('{"status":"ready"}');
    const parsed = await fetchBounded(
      endpoint,
      {},
      1_000,
      async () => new Response(bytes, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-encoding": "identity",
          "content-length": String(bytes.byteLength)
        }
      }),
      consumeJson()
    );
    expect(parsed).toEqual({ status: "ready" });

    const failedBody = new ReadableStream({
      start(controller) { controller.error(new Error(`upstream leaked ${API_KEY}`)); }
    });
    let message = "";
    try {
      await fetchBounded(
        endpoint,
        {},
        1_000,
        async () => new Response(failedBody, { headers: { "content-type": "application/json" } }),
        consumeJson()
      );
    } catch (error) {
      message = String(error?.message || error);
    }
    expect(message).toContain("could not be read");
    expect(message).not.toContain(API_KEY);
  });

  it("applies the same deadline, observed cap, and exact length to video bodies", async () => {
    const video = Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112);
    const collected = [];
    const bytes = await fetchBounded(
      "https://delivery-us1.bfl.ai/unit.mp4",
      {},
      1_000,
      async () => new Response(video, {
        headers: { "content-type": "video/mp4", "content-encoding": "identity", "content-length": "8" }
      }),
      (response, { signal }) => readVideoResponse(response, {
        signal,
        maximumBytes: 8,
        onChunk(chunk) { collected.push(...chunk); }
      })
    );
    expect(bytes).toBe(8);
    expect(collected).toEqual([...video]);

    await expect(readVideoResponse(
      new Response(video, { headers: { "content-type": "video/mp4", "content-length": "9" } }),
      { maximumBytes: 16 }
    )).rejects.toThrow("declared Content-Length");
    await expect(readVideoResponse(
      new Response(video, { headers: { "content-type": "text/html" } }),
      { maximumBytes: 16 }
    )).rejects.toThrow("invalid content type");
    await expect(readVideoResponse(
      new Response(video, { headers: { "content-type": "video/mp4", "content-encoding": "br" } }),
      { maximumBytes: 16 }
    )).rejects.toThrow("unsupported Content-Encoding");
    await expect(readVideoResponse(
      new Response(video, { headers: { "content-type": "video/mp4" } }),
      { maximumBytes: 4 }
    )).rejects.toThrow("maximum size");

    let canceled = false;
    const hanging = new ReadableStream({
      start(controller) { controller.enqueue(video.subarray(0, 2)); },
      cancel() { canceled = true; }
    });
    await expect(fetchBounded(
      "https://delivery-us1.bfl.ai/unit.mp4",
      {},
      30,
      async () => new Response(hanging, { headers: { "content-type": "video/mp4" } }),
      (response, { signal }) => readVideoResponse(response, { signal, maximumBytes: 16 })
    )).rejects.toThrow("timed out");
    expect(canceled).toBe(true);
  });
});

describe("cost and dry-run contract", () => {
  it("builds the documented t2v request shape without network access", async () => {
    const directory = await temporaryDirectory();
    const receipt = dryRunReceipt(requestFor(directory), liveEnvironment());
    expect(receipt.status).toBe("dry-run");
    expect(receipt.networkRequests).toBe(0);
    expect(receipt.contract.endpoint).toBe("https://api.bfl.ai/v1/flux-3-video");
    expect(receipt.contract.concurrency).toBe(1);
    expect(receipt.budget.operatorEstimatedTotalCredits).toBe(170);
    expect(receipt.budget.officialMinimumCredits).toBe(170);
    expect(receipt.budget.estimatedTotalCredits).toBe(170);
    expect(receipt.budget.maxCredits).toBe(1000);
    expect(receipt.budget.liveReady).toBe(true);
    expect(receipt.tasks[0].request).toEqual({
      mode: "t2v",
      prompt: fixture.segments[0].prompt,
      aspect_ratio: "9:16",
      duration: 5,
      resolution: "hd",
      version: "latest",
      generate_audio: false,
      safety_tolerance: 2,
      draft: false
    });
  });

  it("rejects unsafe media-host configuration before any live request plan", async () => {
    const directory = await temporaryDirectory();
    expect(() => generationPlan(requestFor(directory), liveEnvironment({ BFL_MEDIA_HOSTS: "http://localhost:8080" }))).toThrow("without schemes");
  });

  it("does not let request input disable an operator-forced dry run", () => {
    expect(dryRunRequested({ ...fixture, dryRun: false }, { BFL_DRY_RUN: "1" })).toBe(true);
    expect(dryRunRequested({ ...fixture, dryRun: true }, { BFL_DRY_RUN: "0" })).toBe(true);
  });

  it("fails closed when a live budget ceiling or estimate is absent or exceeded", async () => {
    const directory = await temporaryDirectory();
    const noBudget = generationPlan(requestFor(directory), {});
    expect(() => assertLiveBudget(noBudget.budget)).toThrow("requires BFL_MAX_CREDITS");
    const noEstimate = generationPlan(requestFor(directory), { BFL_MAX_CREDITS: "10" });
    expect(() => assertLiveBudget(noEstimate.budget)).toThrow("requires BFL_ESTIMATED");
    const exceeded = generationPlan(requestFor(directory), liveEnvironment({ BFL_MAX_CREDITS: "1" }));
    expect(() => assertLiveBudget(exceeded.budget)).toThrow("exceeds");

    let networkRequests = 0;
    await expect(generate(requestFor(directory), API_KEY, {
      env: {},
      fetchImpl: async () => {
        networkRequests += 1;
        throw new Error("budget validation must happen first");
      }
    })).rejects.toThrow("exact consumed paid request authorization");
    expect(networkRequests).toBe(0);
  });

  it("rejects an operator estimate below the official FLUX 3 full-render floor before any network request", async () => {
    const directory = await temporaryDirectory();
    const request = requestFor(directory);
    const hdPlan = generationPlan(request, {
      BFL_MAX_CREDITS: "1000",
      BFL_ESTIMATED_TOTAL_CREDITS: "169"
    });
    expect(hdPlan.budget.officialMinimumCredits).toBe(170);
    expect(() => assertLiveBudget(hdPlan.budget)).toThrow("below the official flux-3-video full-render floor of 170 credits");

    const fhdPlan = generationPlan(request, {
      BFL_VIDEO_RESOLUTION: "fhd",
      BFL_MAX_CREDITS: "1000",
      BFL_ESTIMATED_TOTAL_CREDITS: "290"
    });
    expect(fhdPlan.budget.officialMinimumCredits).toBe(290);
    expect(() => assertLiveBudget(fhdPlan.budget)).not.toThrow();

    let networkRequests = 0;
    await expect(generate(request, API_KEY, {
      env: {
        BFL_VIDEO_RESOLUTION: "fhd",
        BFL_MAX_CREDITS: "1000",
        BFL_ESTIMATED_TOTAL_CREDITS: "289"
      },
      fetchImpl: async () => {
        networkRequests += 1;
        throw new Error("an underpriced request must never reach the network");
      }
    })).rejects.toThrow("exact consumed paid request authorization");
    expect(networkRequests).toBe(0);
  });
});

describe("BFL storage ancestry boundary", () => {
  it("rejects preexisting clips and checkpoint symlinks without touching their external targets", async () => {
    for (const childName of ["clips", ".bfl-flux-video"]) {
      const directory = await temporaryDirectory();
      const request = requestFor(directory);
      const childPath = join(directory, childName);
      const external = await mkdtemp(join(tmpdir(), `ps4-bfl-external-${childName.replaceAll(".", "root")}-`));
      temporaryDirectories.push(external);
      const sentinel = join(external, "victim.mp4");
      await writeFile(sentinel, "external-bfl-bytes");
      if (childName === "clips") await rm(childPath, { recursive: true });
      await symlink(external, childPath);
      const beforeBytes = await readFile(sentinel);
      const beforeFileStat = await stat(sentinel, { bigint: true });
      const beforeDirStat = await stat(external, { bigint: true });

      await expect(preflightBflStorage(request, liveEnvironment())).rejects.toThrow();

      expect(await readFile(sentinel)).toEqual(beforeBytes);
      const afterFileStat = await stat(sentinel, { bigint: true });
      expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
      expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
      expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
      expect((await lstat(childPath)).isSymbolicLink()).toBe(true);
    }
  });

  it("rejects a symlinked run checkpoint parent before creating any checkpoint", async () => {
    const directory = await temporaryDirectory();
    const request = requestFor(directory);
    const plan = generationPlan(request, liveEnvironment());
    const checkpointRoot = dirname(plan.checkpointDirectory);
    const external = await mkdtemp(join(tmpdir(), "ps4-bfl-external-run-checkpoint-"));
    temporaryDirectories.push(external);
    const sentinel = join(external, "victim.json");
    await writeFile(sentinel, "external-checkpoint-bytes");
    await mkdir(checkpointRoot, { mode: 0o700 });
    await symlink(external, plan.checkpointDirectory);
    const beforeBytes = await readFile(sentinel);
    const beforeFileStat = await stat(sentinel, { bigint: true });
    const beforeDirStat = await stat(external, { bigint: true });

    await expect(preflightBflStorage(request, liveEnvironment())).rejects.toThrow();

    expect(await readFile(sentinel)).toEqual(beforeBytes);
    const afterFileStat = await stat(sentinel, { bigint: true });
    expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
    expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
    expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
  });

  it("rejects hard-linked output, checkpoint, and invocation files without changing the external inode", async () => {
    for (const targetKind of ["output", "checkpoint", "invocation"]) {
      const directory = await temporaryDirectory();
      const request = requestFor(directory);
      const plan = generationPlan(request, liveEnvironment());
      let targetPath;
      if (targetKind === "output") {
        targetPath = join(plan.clipsDirectory, plan.tasks[0].outputName);
      } else if (targetKind === "checkpoint") {
        await mkdir(plan.checkpointDirectory, { recursive: true, mode: 0o700 });
        targetPath = plan.tasks[0].checkpointPath;
      } else {
        targetPath = join(plan.jobDirectory, `.bfl-flux-video-invocation-${plan.checkpointRunName}.json`);
      }
      const external = await mkdtemp(join(tmpdir(), `ps4-bfl-external-hardlink-${targetKind}-`));
      temporaryDirectories.push(external);
      const sentinel = join(external, "victim.bin");
      await writeFile(sentinel, `external-${targetKind}-bytes`);
      await link(sentinel, targetPath);
      const beforeBytes = await readFile(sentinel);
      const beforeFileStat = await stat(sentinel, { bigint: true });
      const beforeDirStat = await stat(external, { bigint: true });

      await expect(preflightBflStorage(request, liveEnvironment())).rejects.toThrow();

      expect(await readFile(sentinel)).toEqual(beforeBytes);
      const afterFileStat = await stat(sentinel, { bigint: true });
      expect(afterFileStat.mtimeNs).toBe(beforeFileStat.mtimeNs);
      expect(afterFileStat.ctimeNs).toBe(beforeFileStat.ctimeNs);
      expect(afterFileStat.nlink).toBe(beforeFileStat.nlink);
      expect((await stat(external, { bigint: true })).mtimeNs).toBe(beforeDirStat.mtimeNs);
    }
  });
});

describe("redaction", () => {
  it("redacts nested credentials, encoded API keys, signed query values, and fragments", () => {
    const redacted = redactValue({
      authorization: `Bearer ${API_KEY}`,
      nested: {
        apiKey: API_KEY,
        url: `https://delivery-us1.bfl.ai/video.mp4?sig=signed&token=abc&safe=ok#private`,
        text: `failure ${encodeURIComponent(API_KEY)}`,
        embedded: "download https://delivery-us1.bfl.ai/video.mp4?sig=embedded-secret&safe=ok then use Authorization: Bearer another-secret"
      }
    }, API_KEY);
    expect(redacted.authorization).toBe("[redacted]");
    expect(redacted.nested.apiKey).toBe("[redacted]");
    expect(redacted.nested.url).not.toContain("signed");
    expect(redacted.nested.url).not.toContain("token=abc");
    expect(redacted.nested.url).toContain("safe=ok");
    expect(redacted.nested.url).not.toContain("#private");
    expect(redacted.nested.text).not.toContain(API_KEY);
    expect(redacted.nested.text).not.toContain(encodeURIComponent(API_KEY));
    expect(redacted.nested.embedded).not.toContain("embedded-secret");
    expect(redacted.nested.embedded).not.toContain("another-secret");
  });
});

describe("paid test harness isolation", () => {
  it("uses an exact six-file executor closure under a temporary project outside the production workspace", async () => {
    const directory = await temporaryDirectory();
    expect(await realpath(sharedTestProject.root)).toBe(sharedTestProject.root);
    expect(resolve(directory).startsWith(`${resolve(PROJECT_ROOT, "workspace")}/`)).toBe(false);
    expect(resolve(directory).startsWith(`${resolve(sharedTestProject.root, "workspace", "jobs")}/`)).toBe(true);
    expect(sharedTestProject.fixtureDiagnostic.actualFiles).toEqual([...EXECUTOR_CLOSURE_FILES].sort());
    expect(sharedTestProject.fixtureDiagnostic.imports).toEqual([...EXECUTOR_CLOSURE_IMPORTS].sort());
    for (const relativePath of EXECUTOR_CLOSURE_FILES) {
      const [source, isolated] = await Promise.all([
        readFile(join(PROJECT_ROOT, relativePath)),
        readFile(join(sharedTestProject.root, relativePath))
      ]);
      expect(Buffer.compare(source, isolated)).toBe(0);
    }
  });
});

describe("paid submission checkpoint and resume", () => {
  it("rejects a checkpoint whose stored request does not match its canonical body hash before any network request", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const env = liveEnvironment();
    const plan = generationPlan(request, env);
    const task = plan.tasks[0];
    await mkdir(plan.checkpointDirectory, { recursive: true });
    await writeFile(task.checkpointPath, JSON.stringify({
      schemaVersion: 1,
      provider: "bfl",
      model: "flux-3-video",
      modelVersion: "latest",
      jobId: request.jobId,
      runId: request.runId,
      requestHash: request.requestHash,
      scriptHash: request.scriptHash,
      index: task.index,
      requestBodyHash: task.requestBodyHash,
      request: { ...task.body, prompt: "mutated checkpoint prompt" },
      estimatedCredits: task.estimatedCredits,
      output: task.relativePath,
      phase: "prepared",
      preparedAt: new Date().toISOString()
    }));
    let networkRequests = 0;
    await expect(generate(request, API_KEY, {
      env,
      fetchImpl: async () => {
        networkRequests += 1;
        throw new Error("a corrupt checkpoint must never reach the network");
      },
      sleep: async () => {}
    })).rejects.toThrow("checkpoint request body hash is invalid");
    expect(networkRequests).toBe(0);
  });

  it("persists each task and never submits completed tasks again", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    let postCount = 0;
    let pollCount = 0;
    let downloadCount = 0;
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        postCount += 1;
        return jsonResponse({
          id: "task-paid-1",
          polling_url: "https://api.bfl.ai/v1/get_result?id=task-paid-1",
          cost: 1
        });
      }
      if (String(url).startsWith("https://api.bfl.ai/v1/get_result")) {
        pollCount += 1;
        return jsonResponse({
          id: "task-paid-1",
          status: "Ready",
          result: { video: { url: "https://delivery-us1.bfl.ai/results/task-paid-1.mp4?sig=temporary" } }
        });
      }
      if (String(url).startsWith("https://delivery-us1.bfl.ai/")) {
        downloadCount += 1;
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const first = await generate(request, API_KEY, { env: liveEnvironment(), fetchImpl, sleep: async () => {} });
    expect(first.status).toBe("completed");
    expect(first.cost.providerReportedCredits).toBe(1);
    expect(postCount).toBe(1);
    expect(pollCount).toBe(1);
    expect(downloadCount).toBe(1);

    const second = await generate(request, API_KEY, {
      env: liveEnvironment({
        BFL_MAX_CREDITS: "1",
        BFL_ESTIMATED_CREDITS_PER_SECOND: "",
        BFL_ESTIMATED_TOTAL_CREDITS: "1"
      }),
      fetchImpl: async () => {
        throw new Error("resume must not access the network");
      },
      sleep: async () => {}
    });
    expect(second.status).toBe("completed");
    expect(second.tasks[0].resumed).toBe(true);
    expect(postCount).toBe(1);

    const plan = generationPlan(request, liveEnvironment());
    const checkpoint = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(checkpoint.phase).toBe("downloaded");
    expect(checkpoint.taskId).toBe("task-paid-1");
    expect(checkpoint.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("resumes polling a known paid task after a process-level failure without another POST", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    let postAttempts = 0;
    let firstPoll = true;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          postAttempts += 1;
          return jsonResponse({
            id: "task-resume-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-resume-1",
            cost: 1
          });
        }
        if (firstPoll && String(url).startsWith("https://api.bfl.ai/")) {
          firstPoll = false;
          throw new Error("temporary poll outage");
        }
        throw new Error(`unexpected URL ${url}`);
      },
      sleep: async () => {}
    })).rejects.toThrow("BFL request failed");
    expect(postAttempts).toBe(1);

    const resumed = await generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          postAttempts += 1;
          throw new Error("a known task must not be submitted twice");
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-resume-1",
            status: "Ready",
            result: { video: { url: "https://delivery-eu2.bfl.ai/results/task-resume-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.tasks[0].resumed).toBe(true);
    expect(postAttempts).toBe(1);
  });

  it("recovers submitted work under an existing execution claim and stops at the first prepared task without another POST", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory);
    let postCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "POST") {
          postCount += 1;
          return jsonResponse({
            id: "task-mixed-recovery-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-mixed-recovery-1",
            cost: 1
          });
        }
        throw new Error("stop after the first task is durably submitted");
      },
      sleep: async () => {}
    })).rejects.toThrow("BFL request failed");
    expect(postCount).toBe(1);

    const plan = generationPlan(request, liveEnvironment());
    expect(JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8")).phase).toBe("submitted");
    expect(JSON.parse(await readFile(plan.tasks[1].checkpointPath, "utf8")).phase).toBe("prepared");

    let recoveryPostCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          recoveryPostCount += 1;
          throw new Error("provider-zero recovery must never POST");
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-mixed-recovery-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-mixed-recovery-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    })).rejects.toThrow("provider-zero recovery stopped at prepared task 2");
    expect(recoveryPostCount).toBe(0);
    const recoveredFirst = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    const untouchedSecond = JSON.parse(await readFile(plan.tasks[1].checkpointPath, "utf8"));
    expect(recoveredFirst).toMatchObject({ phase: "downloaded", taskId: "task-mixed-recovery-1" });
    expect(untouchedSecond).toMatchObject({ phase: "prepared", index: 2 });
  });

  it("recovers a known submitted task with zero new POSTs after the budget floor and ceiling tighten", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    let firstRunPosts = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "POST") {
          firstRunPosts += 1;
          return jsonResponse({
            id: "task-legacy-budget-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-legacy-budget-1",
            cost: 1
          });
        }
        throw new Error("temporary poll outage after the paid task was acknowledged");
      },
      sleep: async () => {}
    })).rejects.toThrow("BFL request failed");
    expect(firstRunPosts).toBe(1);

    const plan = generationPlan(request, liveEnvironment());
    const submitted = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(submitted.phase).toBe("submitted");
    await writeFile(plan.tasks[0].checkpointPath, JSON.stringify({
      ...submitted,
      estimatedCredits: 1
    }, null, 2));

    let secondRunPosts = 0;
    const recovered = await generate(request, API_KEY, {
      env: liveEnvironment({
        BFL_MAX_CREDITS: "1",
        BFL_ESTIMATED_CREDITS_PER_SECOND: "",
        BFL_ESTIMATED_TOTAL_CREDITS: "1"
      }),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          secondRunPosts += 1;
          throw new Error("known paid tasks must never be resubmitted");
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-legacy-budget-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-legacy-budget-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.tasks[0]).toMatchObject({ taskId: "task-legacy-budget-1", resumed: true });
    expect(recovered.cost).toMatchObject({ estimatedCredits: 85, maxCredits: 1000 });
    expect(secondRunPosts).toBe(0);
  });

  it("uses provider-reported cost to stop before the next paid submission", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, {}, liveEnvironment({
      BFL_MAX_CREDITS: "170",
      BFL_ESTIMATED_TOTAL_CREDITS: "170"
    }));
    let postAttempts = 0;
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        postAttempts += 1;
        return jsonResponse({
          id: `task-budget-${postAttempts}`,
          polling_url: `https://api.bfl.ai/v1/get_result?id=task-budget-${postAttempts}`,
          cost: 100
        });
      }
      if (String(url).startsWith("https://api.bfl.ai/")) {
        return jsonResponse({
          id: "task-budget-1",
          status: "Ready",
          result: { video: { url: "https://delivery-us1.bfl.ai/results/task-budget-1.mp4?sig=temporary" } }
        });
      }
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
        headers: { "content-type": "video/mp4", "content-length": "8" }
      });
    };
    await expect(generate(request, API_KEY, {
      env: liveEnvironment({ BFL_MAX_CREDITS: "170" }),
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow("budget guard stopped before task 2");
    expect(postAttempts).toBe(1);
  });

  it("counts an unknown prior provider cost as at least its estimate before another paid submission", async () => {
    const directory = await temporaryDirectory();
    const third = { ...fixture.segments[1], index: 3, prompt: "A third distinct architecture shot" };
    const request = await authorizedRequest(directory, {
      segments: [fixture.segments[0], fixture.segments[1], third],
      targetDurationSec: 15,
      targetDurationRangeSec: [15, 20]
    }, liveEnvironment({
      BFL_MAX_CREDITS: "255",
      BFL_ESTIMATED_TOTAL_CREDITS: "255"
    }));
    let postAttempts = 0;
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        postAttempts += 1;
        const id = `task-unknown-cost-${postAttempts}`;
        return jsonResponse({
          id,
          polling_url: `https://api.bfl.ai/v1/get_result?id=${id}`,
          ...(postAttempts === 2 ? { cost: 170 } : {})
        });
      }
      if (String(url).startsWith("https://api.bfl.ai/")) {
        const id = `task-unknown-cost-${postAttempts}`;
        return jsonResponse({
          id,
          status: "Ready",
          result: { video: { url: `https://delivery-us1.bfl.ai/results/${id}.mp4?sig=temporary` } }
        });
      }
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
        headers: { "content-type": "video/mp4", "content-length": "8" }
      });
    };
    await expect(generate(request, API_KEY, {
      env: liveEnvironment({ BFL_MAX_CREDITS: "255" }),
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow("budget guard stopped before task 3");
    expect(postAttempts).toBe(2);
  });

  it("records an ambiguous POST outcome and refuses any automatic paid retry", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    let postAttempts = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async () => {
        postAttempts += 1;
        throw new Error("connection reset after upload");
      },
      sleep: async () => {}
    })).rejects.toThrow("submission outcome is unknown");
    expect(postAttempts).toBe(1);

    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async () => {
        postAttempts += 1;
        throw new Error("must not be called");
      },
      sleep: async () => {}
    })).rejects.toThrow("automatic paid resubmission is disabled");
    expect(postAttempts).toBe(1);
  });

  it("re-attests expiry after the durable submitting checkpoint and makes zero late POSTs", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(
      directory,
      { segments: [fixture.segments[0]], targetDurationSec: 5 },
      liveEnvironment(),
      { lifetimeMs: 80 }
    );
    let postCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      beforePaidPost: async () => new Promise((resolve) => setTimeout(resolve, 100)),
      fetchImpl: async () => { postCount += 1; throw new Error("expired request must not reach provider"); },
      sleep: async () => {}
    })).rejects.toThrow("만료 경계와 일치하지 않습니다");
    expect(postCount).toBe(0);
  });

  it("sends zero requests when a hook replaces the approved task body with a proxy before POST", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    let fetchCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      beforePaidPost: async ({ task }) => {
        task.body = new Proxy({ ...task.body, duration: 20 }, {
          ownKeys: (target) => Reflect.ownKeys(target),
          get: (target, key) => Reflect.get(target, key)
        });
      },
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("mutated body must not reach provider");
      },
      sleep: async () => {}
    })).rejects.toThrow("body changed after the durable pre-POST authorization check");
    expect(fetchCount).toBe(0);
  });

  it("serializes one approved canonical POST body and rejects a concurrent checkpoint owner", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const plan = generationPlan(request, liveEnvironment());
    let postCount = 0;
    let secondFetchCount = 0;
    let pollEnteredResolve;
    let releasePollResolve;
    const pollEntered = new Promise((resolve) => { pollEnteredResolve = resolve; });
    const releasePoll = new Promise((resolve) => { releasePollResolve = resolve; });
    const first = generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          postCount += 1;
          const expectedText = JSON.stringify(stableValue(plan.tasks[0].body));
          expect(options.body).toBe(expectedText);
          return jsonResponse({
            id: "task-exclusive-owner-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-exclusive-owner-1",
            cost: 1
          });
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          pollEnteredResolve();
          await releasePoll;
          return jsonResponse({
            id: "task-exclusive-owner-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-exclusive-owner-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    await pollEntered;
    const submittedBeforeRace = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(submittedBeforeRace).toMatchObject({ phase: "submitted", taskId: "task-exclusive-owner-1" });

    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async () => {
        secondFetchCount += 1;
        throw new Error("losing invocation must not access provider");
      },
      sleep: async () => {}
    })).rejects.toThrow("already owns this exact request");
    const submittedAfterRace = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(submittedAfterRace).toEqual(submittedBeforeRace);
    expect(postCount).toBe(1);
    expect(secondFetchCount).toBe(0);

    releasePollResolve();
    const receipt = await first;
    const finalCheckpoint = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(finalCheckpoint).toMatchObject({ phase: "downloaded", taskId: "task-exclusive-owner-1" });
    expect(receipt).toMatchObject({
      status: "completed",
      modelId: "task-exclusive-owner-1",
      taskIds: ["task-exclusive-owner-1"],
      outputs: ["clips/01.mp4"]
    });
    expect(receipt.tasks[0].taskId).toBe(receipt.segments[0].taskId);
    expect(receipt.segments[0].sha256).toBe(finalCheckpoint.sha256);
  });

  it("fails closed before checkpoint or provider access when an unknown process holds the global guard", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const plan = generationPlan(request, liveEnvironment());
    const unknownGuard = createServer((socket) => socket.destroy());
    await new Promise((resolveListen, rejectListen) => {
      unknownGuard.once("error", rejectListen);
      unknownGuard.listen({ host: GLOBAL_BFL_GUARD_HOST, port: GLOBAL_BFL_GUARD_PORT, exclusive: true }, resolveListen);
    });
    let fetchCount = 0;
    try {
      await expect(generate(request, API_KEY, {
        env: liveEnvironment(),
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("unknown guard owner must block provider access");
        }
      })).rejects.toThrow("unknown process holds the global paid-executor guard");
    } finally {
      await new Promise((resolveClose) => unknownGuard.close(resolveClose));
    }
    expect(fetchCount).toBe(0);
    expect(await stat(plan.checkpointDirectory).catch(() => null)).toBeNull();
  });

  it("takes over a SIGKILL-stale kernel-guarded lease before claim and preserves paid eligibility", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const plan = generationPlan(request, liveEnvironment());
    const { child } = await spawnCrashBoundaryChild(directory, request, "pre-claim");

    const prepared = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(prepared).toMatchObject({ phase: "prepared", index: 1 });
    expect(await providerExecutionClaimNames(directory)).toEqual([]);
    const leaseName = (await readdir(directory)).find((name) => name.startsWith(".bfl-flux-video-invocation-"));
    expect(leaseName).toBeTruthy();
    const staleLease = JSON.parse(await readFile(join(directory, leaseName), "utf8"));
    expect(staleLease.mode).toBe("pending");

    await killChild(child);
    let postCount = 0;
    let takeoverLease = null;
    const receipt = await generate(request, API_KEY, {
      env: liveEnvironment(),
      afterInvocationLeaseAcquired: async ({ path }) => {
        takeoverLease = JSON.parse(await readFile(path, "utf8"));
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          postCount += 1;
          return jsonResponse({
            id: "task-sigkill-preclaim-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-sigkill-preclaim-1",
            cost: 1
          });
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-sigkill-preclaim-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-sigkill-preclaim-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    expect(takeoverLease.takeoverOfLeaseHash).toBe(staleLease.leaseHash);
    expect(takeoverLease.ownerNonce).not.toBe(staleLease.ownerNonce);
    expect(receipt).toMatchObject({ status: "completed", taskIds: ["task-sigkill-preclaim-1"] });
    expect(postCount).toBe(1);
  });

  it("resumes one unexpired all-prepared attempt after an injected crash immediately after execution claim", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const plan = generationPlan(request, liveEnvironment());
    let firstFetchCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      afterProviderExecutionClaim: async ({ checkpoint, executionClaim }) => {
        expect(checkpoint.phase).toBe("prepared");
        expect(executionClaim.status).toBe("provider-executor-claimed");
        throw new Error("injected crash immediately after execution claim");
      },
      fetchImpl: async () => {
        firstFetchCount += 1;
        throw new Error("post-claim crash must precede every provider request");
      },
      sleep: async () => {}
    })).rejects.toThrow("injected crash immediately after execution claim");
    expect(firstFetchCount).toBe(0);
    expect(JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8")).phase).toBe("prepared");
    expect(await providerExecutionClaimNames(directory)).toHaveLength(1);

    let retryPosts = 0;
    const receipt = await generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          retryPosts += 1;
          return jsonResponse({
            id: "task-postclaim-retry-1",
            polling_url: "https://api.bfl.ai/v1/get_result?id=task-postclaim-retry-1",
            cost: 1
          });
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-postclaim-retry-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-postclaim-retry-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    expect(receipt).toMatchObject({ status: "completed", taskIds: ["task-postclaim-retry-1"] });
    expect(retryPosts).toBe(1);
    expect(await providerExecutionClaimNames(directory)).toHaveLength(1);
  });

  it("takes over a SIGKILL-stale submitted acknowledgement only in provider-zero recovery mode", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const plan = generationPlan(request, liveEnvironment());
    const { child } = await spawnCrashBoundaryChild(directory, request, "submitted-ack");

    const submitted = JSON.parse(await readFile(plan.tasks[0].checkpointPath, "utf8"));
    expect(submitted).toMatchObject({ phase: "submitted", taskId: "task-sigkill-submitted-1" });
    expect(await providerExecutionClaimNames(directory)).toHaveLength(1);
    const leaseName = (await readdir(directory)).find((name) => name.startsWith(".bfl-flux-video-invocation-"));
    const staleLease = JSON.parse(await readFile(join(directory, leaseName), "utf8"));
    expect(staleLease.mode).toBe("paid-owner");

    await killChild(child);
    let postCount = 0;
    let takeoverLease = null;
    const receipt = await generate(request, API_KEY, {
      env: liveEnvironment(),
      afterInvocationLeaseAcquired: async ({ path }) => {
        takeoverLease = JSON.parse(await readFile(path, "utf8"));
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") {
          postCount += 1;
          throw new Error("a submitted acknowledgement must never be posted again");
        }
        if (String(url).startsWith("https://api.bfl.ai/")) {
          return jsonResponse({
            id: "task-sigkill-submitted-1",
            status: "Ready",
            result: { video: { url: "https://delivery-us1.bfl.ai/results/task-sigkill-submitted-1.mp4?sig=temporary" } }
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "content-type": "video/mp4", "content-length": "8" }
        });
      },
      sleep: async () => {}
    });
    expect(takeoverLease.takeoverOfLeaseHash).toBe(staleLease.leaseHash);
    expect(receipt).toMatchObject({ status: "completed", taskIds: ["task-sigkill-submitted-1"] });
    expect(receipt.tasks[0].resumed).toBe(true);
    expect(postCount).toBe(0);
  });

  it("makes zero POSTs for a self-consistent forged expiry window that disagrees with the consumed receipt", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const forgedAuthorization = forgeAuthorizationWindow(
      request.paidAuthorization,
      new Date(Date.parse(request.paidAuthorization.expiresAt) + 60 * 60 * 1000).toISOString()
    );
    const forgedRequest = { ...request, paidAuthorization: forgedAuthorization };
    let fetchCount = 0;
    await expect(generate(forgedRequest, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async () => { fetchCount += 1; throw new Error("forged window must not reach provider"); },
      sleep: async () => {}
    })).rejects.toThrow("consumed approval 영수증");
    expect(fetchCount).toBe(0);
  });

  it("ignores an alternate runtime project root so copied approval evidence cannot buy a second execution", async () => {
    const directory = await temporaryDirectory();
    const request = await authorizedRequest(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
    const alternateRoot = await mkdtemp(join(tmpdir(), "ps4-bfl-alternate-root-"));
    temporaryDirectories.push(alternateRoot);
    const copiedJob = join(alternateRoot, "workspace", "jobs", request.jobId);
    await mkdir(dirname(copiedJob), { recursive: true });
    await cp(directory, copiedJob, { recursive: true });
    const hiddenCanonical = `${directory}-hidden`;
    temporaryDirectories.push(hiddenCanonical);
    await rename(directory, hiddenCanonical);
    let fetchCount = 0;
    await expect(generate(request, API_KEY, {
      env: liveEnvironment({ PS4_BFL_PROJECT_ROOT: alternateRoot }),
      fetchImpl: async () => { fetchCount += 1; throw new Error("copied evidence must not reach provider"); },
      sleep: async () => {}
    })).rejects.toThrow("검증할 수 없습니다");
    expect(fetchCount).toBe(0);
  });

  it("blocks raw and URL-encoded API keys in signed prompts before claim, checkpoint, or network", async () => {
    for (const leaked of [API_KEY, encodeURIComponent(API_KEY)]) {
      const directory = await temporaryDirectory();
      const request = await authorizedRequest(
        directory,
        { segments: [{ ...fixture.segments[0], prompt: `never serialize ${leaked}` }], targetDurationSec: 5 },
        liveEnvironment(),
        { skipClaim: true }
      );
      const plan = generationPlan(request, liveEnvironment());
      let fetchCount = 0;
      await expect(generate(request, API_KEY, {
        env: liveEnvironment(),
        fetchImpl: async () => { fetchCount += 1; throw new Error("secret-bearing request must not reach provider"); },
        sleep: async () => {}
      })).rejects.toThrow("직렬화·claim·제출");
      expect(fetchCount).toBe(0);
      expect(await stat(plan.checkpointDirectory).catch(() => null)).toBeNull();
      const claimPath = join(directory, `bfl-paid-claim-${request.paidAuthorization.nonce}.json`);
      expect(await stat(claimPath).catch(() => null)).toBeNull();
    }
  });

  it("blocks raw and URL-encoded API keys in approval reasons before durable evidence or provider access", async () => {
    for (const leaked of [API_KEY, encodeURIComponent(API_KEY)]) {
      const directory = await temporaryDirectory();
      let providerRequests = 0;
      await expect(authorizedRequest(
        directory,
        { segments: [fixture.segments[0]], targetDurationSec: 5 },
        liveEnvironment(),
        { reason: `operator copied ${leaked} into the paid approval reason` }
      )).rejects.toThrow("직렬화·claim·제출");
      expect(providerRequests).toBe(0);
      const durableNames = await readdir(directory);
      expect(durableNames.some((name) => (
        name.startsWith("bfl-paid-")
        || name.startsWith(".bfl-flux-video")
        || name === ".local-video-provider-submit-intent.json"
      ))).toBe(false);
    }
  });

  it("copies an actual provider shot-pattern binding into completed segment receipts", async () => {
    const directory = await temporaryDirectory();
    const providerVisualPrompt = `${fixture.segments[0].prompt}\nCamera-only direction: fixed tripod`;
    const request = await authorizedRequest(directory, {
      topic: "token: stone / secret=architecture",
      segments: [{
        ...fixture.segments[0],
        prompt: providerVisualPrompt,
        providerVisualPrompt,
        providerVisualPromptHash: testHashJson(providerVisualPrompt),
        shotPattern: testShotPattern()
      }],
      targetDurationSec: 5
    });
    const receipt = await generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST") return jsonResponse({ id: "task-pattern-1", polling_url: "https://api.bfl.ai/v1/get_result?id=task-pattern-1", cost: 1 });
        if (String(url).startsWith("https://api.bfl.ai/")) return jsonResponse({ id: "task-pattern-1", status: "Ready", result: { video: { url: "https://delivery-us1.bfl.ai/results/task-pattern-1.mp4?sig=temporary" } } });
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4", "content-length": "8" } });
      },
      sleep: async () => {}
    });
    expect(receipt.segments[0]).toMatchObject({
      providerVisualPrompt,
      providerVisualPromptHash: testHashJson(providerVisualPrompt),
      submittedToProvider: true,
      shotPattern: request.segments[0].shotPattern
    });
    expect(receipt.request.topic).toBe("token: stone / secret=architecture");
    expect(receipt.segments[0].submittedPromptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.segments[0].submittedRequestBodyHash).toBe(receipt.tasks[0].requestBodyHash);
    expect(receipt.tasks[0].request.prompt).toBe(providerVisualPrompt);
    expect(receipt.tasks[0].request).toMatchObject({
      mode: "t2v",
      prompt: providerVisualPrompt,
      aspect_ratio: "9:16",
      duration: 5,
      resolution: "hd",
      version: "latest",
      generate_audio: false,
      safety_tolerance: 2,
      draft: false
    });
    expect(receipt.tasks[0].requestBodyHash).toBe(testHashJson(receipt.tasks[0].request));
    const cliReceipt = redactCompletedReceiptForOutput(receipt, API_KEY);
    expect(cliReceipt.paidAuthorization).toEqual(receipt.paidAuthorization);
    expect(cliReceipt.providerExecutionClaim).toEqual(receipt.providerExecutionClaim);
    const approvalVerification = await verifyBflConsumedApprovalForRequest(
      directory,
      request.paidAuthorization,
      request,
      { historical: true, requireClaim: true }
    );
    expect(() => attachLocalVideoSubmissionIntent(
      cliReceipt,
      submissionIntentFor(request),
      request,
      { ...approvalVerification, consumedReceiptText: `${approvalVerification.consumedReceiptText} ${API_KEY}` },
      null,
      API_KEY
    )).toThrow("직렬화·claim·제출");
    const pipelineReceipt = await validateLocalVideoReceipt(
      attachLocalVideoSubmissionIntent(
        cliReceipt,
        submissionIntentFor(request),
        request,
        approvalVerification,
        null,
        API_KEY
      ),
      { id: request.jobId },
      { segments: request.segments },
      request.runId,
      request,
      request.scriptHash,
      request.requestHash,
      join(directory, "clips")
    );
    expect(pipelineReceipt.segments[0].sha256).toBe(receipt.segments[0].sha256);
    expect(pipelineReceipt.tasks[0].request).toEqual(receipt.tasks[0].request);
    expect(JSON.stringify(pipelineReceipt)).not.toContain(API_KEY);
    expect(JSON.stringify(pipelineReceipt)).not.toContain(encodeURIComponent(API_KEY));

    const secretEvidence = structuredClone(pipelineReceipt);
    secretEvidence.paidApprovalEvidence.consumedReceiptText += ` ${encodeURIComponent(API_KEY)}`;
    expect(localVideoPaidApprovalEvidenceBound(secretEvidence, request, API_KEY)).toBe(false);

    const extraBody = structuredClone(pipelineReceipt);
    extraBody.tasks[0].request.unexpected_paid_option = true;
    extraBody.tasks[0].requestBodyHash = testHashJson(extraBody.tasks[0].request);
    extraBody.segments[0].submittedRequestBody = structuredClone(extraBody.tasks[0].request);
    extraBody.segments[0].submittedRequestBodyHash = extraBody.tasks[0].requestBodyHash;
    expect(localVideoProviderRequestBodyClosureBound(extraBody, request)).toBe(false);

    for (const mutate of [
      (value) => { value.taskIds = []; },
      (value) => { value.modelId = "different-provider-id"; },
      (value) => { value.tasks[0].responseId = "other-task"; },
      (value) => { value.segments[0].submissionResponseId = "other-task"; },
      (value) => { value.tasks[0].pollingUrl = "https://api.bfl.ai/v1/get_result?id=other-task"; },
      (value) => { value.tasks[0].responseStatus = "running"; },
      (value) => { delete value.tasks[0].completedAt; },
      (value) => { value.segments[0].unexpected = true; }
    ]) {
      const changed = structuredClone(pipelineReceipt);
      mutate(changed);
      expect(localVideoProviderRequestBodyClosureBound(changed, request)).toBe(false);
    }

    const forgedAuthorization = forgeAuthorizationWindow(
      request.paidAuthorization,
      new Date(Date.parse(request.paidAuthorization.expiresAt) + 60 * 60 * 1000).toISOString()
    );
    expect(localVideoPaidApprovalEvidenceBound(pipelineReceipt, { ...request, paidAuthorization: forgedAuthorization })).toBe(false);

    const swappedIntent = structuredClone(pipelineReceipt);
    swappedIntent.submissionIntent.generatorSha256 = `sha256:${"f".repeat(64)}`;
    const { intentHash: _intentHash, ...unsignedIntent } = swappedIntent.submissionIntent;
    swappedIntent.submissionIntent.intentHash = testHashJson(unsignedIntent);
    expect(localVideoProviderRequestBodyClosureBound(swappedIntent, request)).toBe(false);
  });

  it("rejects a mismatched shot-pattern prompt before any paid BFL request", async () => {
    const directory = await temporaryDirectory();
    const providerVisualPrompt = `${fixture.segments[0].prompt}\nCamera-only direction: fixed tripod`;
    await expect(authorizedRequest(directory, {
      segments: [{
        ...fixture.segments[0],
        prompt: "different prompt that must never be submitted",
        providerVisualPrompt,
        providerVisualPromptHash: `sha256:${"a".repeat(64)}`,
        shotPattern: testShotPattern()
      }],
      targetDurationSec: 5
    })).rejects.toThrow("launch capability");
    expect(await stat(join(directory, ".bfl-flux-video")).catch(() => null)).toBeNull();
  });
});
