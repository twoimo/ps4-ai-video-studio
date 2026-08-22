import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBflPaidApprovalContext,
  BFL_PAID_APPROVAL_NAME,
  bindBflLaunchCapabilityToRequest,
  canonicalBflRequestHash,
  claimBflProviderExecution,
  consumeBflPaidApproval,
  consumeOrRecoverBflPaidApproval,
  createBflPaidApprovalReceipt,
  hashBflApprovalValue,
  persistBflPaidApproval,
  validateBflPaidApprovalReceipt,
  validateBflRequestAuthorization,
  verifyBflConsumedApprovalForRequest
} from "../src/bfl-paid-approval.mjs";

const roots = [];
const PROJECT_ROOT = join(import.meta.dirname, "..");
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ps4-bfl-approval-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const source = join(root, "src");
  const jobDir = join(root, "workspace", "jobs", "job-paid-approval");
  await mkdir(scripts, { recursive: true });
  await mkdir(source, { recursive: true });
  await copyFile(join(PROJECT_ROOT, "scripts", "bfl-flux-video-generator.mjs"), join(scripts, "bfl-flux-video-generator.mjs"));
  await Promise.all([
    "bfl-executor-snapshot.mjs",
    "bfl-paid-approval.mjs",
    "dirfd-platform.mjs",
    "dirfd.mjs",
    "run-ledger.mjs"
  ].map((name) => copyFile(join(PROJECT_ROOT, "src", name), join(source, name))));
  await chmod(join(scripts, "bfl-flux-video-generator.mjs"), 0o755);
  const job = {
    id: "job-paid-approval",
    provider: "local-video",
    topic: "검증된 유료 생성 승인",
    format: "vertical",
    clipCount: 2,
    targetDurationSec: 20,
    targetDurationRangeSec: [19, 21],
    captions: true,
    voiceover: true,
    createdAt: "2026-08-13T00:00:00.000Z"
  };
  const env = {
    PS4_LOCAL_VIDEO_GENERATOR: join(scripts, "bfl-flux-video-generator.mjs"),
    BFL_VIDEO_RESOLUTION: "hd",
    BFL_MAX_CREDITS: "340",
    BFL_ESTIMATED_TOTAL_CREDITS: "340",
    BFL_API_KEY: "test-only-key"
  };
  const context = await buildBflPaidApprovalContext({ root, job, env });
  return { root, jobDir, job, env, context };
}

function authorizedBaseRequest(job, runId = "run-paid-approval") {
  const request = {
    schemaVersion: 1,
    jobId: job.id,
    runId,
    provider: "local-video",
    topic: job.topic,
    format: job.format,
    clipCount: job.clipCount,
    targetDurationSec: job.targetDurationSec,
    targetDurationRangeSec: job.targetDurationRangeSec,
    captions: job.captions,
    voiceover: job.voiceover,
    jobCreatedAt: job.createdAt,
    segments: Array.from({ length: job.clipCount }, (_, index) => ({
      index: index + 1,
      durationHint: null,
      prompt: `bound prompt ${index + 1}`,
      visualPrompt: `bound prompt ${index + 1}`,
      caption: `bound caption ${index + 1}`,
      narration: `bound narration ${index + 1}`
    })),
    scriptHash: `sha256:${"e".repeat(64)}`
  };
  return { ...request, requestHash: canonicalBflRequestHash(request) };
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

describe("one-use BFL paid approval", () => {
  test("binds the exact job, bundled adapter, official quote, cap, and expiry", async () => {
    const { context, env } = await fixture();
    expect(context).toMatchObject({
      provider: "bfl",
      model: "flux-3-video",
      resolution: "hd",
      creditsPerSecond: 17,
      officialQuoteCredits: 340,
      officialQuoteUsd: 3.4,
      operatorEstimateCredits: 340,
      maxCredits: 340,
      adapterName: "bfl-flux-video-generator.mjs"
    });
    const now = new Date("2026-08-13T00:05:00.000Z");
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 340 credit 상한의 1회 실행을 명시적으로 승인함",
      apiKey: env.BFL_API_KEY
    });
    expect(validateBflPaidApprovalReceipt(receipt, context, { now, apiKey: env.BFL_API_KEY })).toBe(receipt);
    expect(() => validateBflPaidApprovalReceipt(receipt, { ...context, maxCredits: 341 }, { now, apiKey: env.BFL_API_KEY })).toThrow("결속되지 않았거나 만료");
    expect(() => validateBflPaidApprovalReceipt(receipt, context, { now: new Date("2026-08-13T00:36:00.000Z"), apiKey: env.BFL_API_KEY })).toThrow("만료");
  });

  test("atomically consumes a mode-0600 receipt exactly once", async () => {
    const { jobDir, context, env } = await fixture();
    const now = new Date("2026-08-13T00:05:00.000Z");
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 정확한 작업과 340 credit 상한을 승인함",
      apiKey: env.BFL_API_KEY
    });
    const path = await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const consumed = await consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY });
    expect(JSON.parse(await readFile(consumed.consumedPath, "utf8"))).toEqual(receipt);
    await expect(consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY })).rejects.toThrow("영수증이 없습니다");
  });

  test("recovers one exact consumed-no-intent capability after a launch crash but never after a request claim", async () => {
    const { jobDir, job, context, env } = await fixture();
    const now = new Date("2026-08-13T00:05:00.000Z");
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 crash-safe 단일 유료 실행 capability를 승인함",
      apiKey: env.BFL_API_KEY
    });
    await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
    const consumed = await consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY });
    const recovered = await consumeOrRecoverBflPaidApproval(jobDir, context, {
      now,
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {}
    });
    expect(recovered).toMatchObject({ recovered: true, consumedName: consumed.consumedName, capability: consumed.capability });

    const base = authorizedBaseRequest(job, "run-after-recovered-launch");
    const authorization = bindBflLaunchCapabilityToRequest(recovered.capability, base, { now });
    const request = { ...base, paidAuthorization: authorization };
    await verifyBflConsumedApprovalForRequest(jobDir, authorization, request, {
      now,
      apiKey: env.BFL_API_KEY,
      claim: true
    });
    await expect(consumeOrRecoverBflPaidApproval(jobDir, context, {
      now,
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {}
    })).rejects.toThrow("provider 요청 claim 또는 제출 intent");
  });

  test("repairs the exact link-before-unlink transition after a hard process exit", async () => {
    const { jobDir, context, env } = await fixture();
    const now = new Date();
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      reason: "사용자가 hard-exit approval 전이 복구를 승인함",
      apiKey: env.BFL_API_KEY
    });
    await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
    const moduleUrl = new URL("../src/bfl-paid-approval.mjs", import.meta.url).href;
    const childSource = `
      const approval = await import(${JSON.stringify(moduleUrl)});
      await approval.consumeOrRecoverBflPaidApproval(
        ${JSON.stringify(jobDir)},
        ${JSON.stringify(context)},
        {
          apiKey: ${JSON.stringify(env.BFL_API_KEY)},
          assertNoPriorPaidIntent: async () => {},
          syncDirectoryFn: async () => process.exit(86)
        }
      );
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(86);

    const activePath = join(jobDir, BFL_PAID_APPROVAL_NAME);
    const consumedPath = join(jobDir, `bfl-paid-approval-consumed-${receipt.nonce}.json`);
    const [activeCrashIdentity, consumedCrashIdentity] = await Promise.all([
      stat(activePath, { bigint: true }),
      stat(consumedPath, { bigint: true })
    ]);
    expect(activeCrashIdentity.ino).toBe(consumedCrashIdentity.ino);
    expect(activeCrashIdentity.nlink).toBe(2n);
    expect(consumedCrashIdentity.nlink).toBe(2n);

    const recovered = await consumeOrRecoverBflPaidApproval(jobDir, context, {
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {}
    });
    expect(recovered).toMatchObject({ recovered: true, consumedName: `bfl-paid-approval-consumed-${receipt.nonce}.json` });
    expect(await stat(activePath).catch(() => null)).toBeNull();
    expect((await stat(consumedPath, { bigint: true })).nlink).toBe(1n);
  });

  test("never unlinks the active approval before the consumed directory entry is durable", async () => {
    const { jobDir, context, env } = await fixture();
    const now = new Date();
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      reason: "사용자가 directory durability ordering 회귀를 승인함",
      apiKey: env.BFL_API_KEY
    });
    const activePath = await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
    const consumedPath = join(jobDir, `bfl-paid-approval-consumed-${receipt.nonce}.json`);
    const trace = [];
    await expect(consumeOrRecoverBflPaidApproval(jobDir, context, {
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {},
      syncDirectoryFn: async () => {
        trace.push("sync-consumed-entry");
        throw new Error("injected parent fsync failure");
      },
      hooks: {
        beforeActiveApprovalUnlink: async () => { trace.push("unlink-active"); }
      }
    })).rejects.toThrow("injected parent fsync failure");
    expect(trace).toEqual(["sync-consumed-entry"]);
    const [activeIdentity, consumedIdentity] = await Promise.all([
      stat(activePath, { bigint: true }),
      stat(consumedPath, { bigint: true })
    ]);
    expect(activeIdentity.ino).toBe(consumedIdentity.ino);
    expect(activeIdentity.nlink).toBe(2n);

    const recovered = await consumeOrRecoverBflPaidApproval(jobDir, context, {
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {}
    });
    expect(recovered.recovered).toBe(true);
    expect(await stat(activePath).catch(() => null)).toBeNull();
    expect((await stat(consumedPath, { bigint: true })).nlink).toBe(1n);
  });

  test("blocks a distinct or multiply-linked consumed collision without deleting the active approval", async () => {
    const { jobDir, context, env } = await fixture();
    const now = new Date();
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      reason: "사용자가 collision fail-closed 경계를 승인함",
      apiKey: env.BFL_API_KEY
    });
    const activePath = await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
    const consumedPath = join(jobDir, `bfl-paid-approval-consumed-${receipt.nonce}.json`);
    await writeFile(consumedPath, "foreign-collision", { mode: 0o600 });
    const activeBytes = await readFile(activePath);
    await expect(consumeOrRecoverBflPaidApproval(jobDir, context, {
      apiKey: env.BFL_API_KEY,
      assertNoPriorPaidIntent: async () => {}
    })).rejects.toThrow("동일 inode");
    expect(await readFile(activePath)).toEqual(activeBytes);
  });

  test("rejects preexisting active symlinks and external hardlinks without mutating their targets", async () => {
    for (const entryType of ["symlink", "hardlink"]) {
      const { root, jobDir, context, env } = await fixture();
      const now = new Date();
      const receipt = createBflPaidApprovalReceipt(context, {
        now,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        reason: `사용자가 ${entryType} active receipt 경계 검사를 승인함`,
        apiKey: env.BFL_API_KEY
      });
      const externalDir = join(root, `external-${entryType}`);
      await mkdir(jobDir, { recursive: true });
      const externalPath = await persistBflPaidApproval(externalDir, receipt, { apiKey: env.BFL_API_KEY });
      const activePath = join(jobDir, BFL_PAID_APPROVAL_NAME);
      if (entryType === "symlink") await symlink(externalPath, activePath);
      else await link(externalPath, activePath);
      const externalBytesBefore = await readFile(externalPath);
      const externalMtimeBefore = (await stat(externalPath)).mtimeMs;

      await expect(consumeOrRecoverBflPaidApproval(jobDir, context, {
        apiKey: env.BFL_API_KEY,
        assertNoPriorPaidIntent: async () => {}
      })).rejects.toThrow(entryType === "symlink" ? "single-link regular file" : "외부 hardlink");
      expect(await readFile(externalPath)).toEqual(externalBytesBefore);
      expect((await stat(externalPath)).mtimeMs).toBe(externalMtimeBefore);
      expect((await readdir(jobDir)).filter((name) => name.startsWith("bfl-paid-approval-consumed-"))).toEqual([]);
    }
  });

  test("rejects mutation and refuses non-bundled or under-budget configuration", async () => {
    const { root, job, env, context, jobDir } = await fixture();
    const now = new Date("2026-08-13T00:05:00.000Z");
    const receipt = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 정확한 유료 실행 상한을 승인함",
      apiKey: env.BFL_API_KEY
    });
    await persistBflPaidApproval(jobDir, { ...receipt, reason: "mutated reason" }, { apiKey: env.BFL_API_KEY });
    await expect(consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY })).rejects.toThrow("결속되지 않았거나 만료");
    await expect(buildBflPaidApprovalContext({ root, job, env: { ...env, BFL_MAX_CREDITS: "339" } })).rejects.toThrow("공식 최소 견적보다 작습니다");
    const foreign = join(root, "foreign-generator");
    await writeFile(foreign, "#!/bin/sh\n");
    await chmod(foreign, 0o755);
    await expect(buildBflPaidApprovalContext({ root, job, env: { ...env, PS4_LOCAL_VIDEO_GENERATOR: foreign } })).rejects.toThrow("정확한 BFL 어댑터");
  });

  test("quotes every provider-minimum clip and binds key, audio, safety, and the canonical request", async () => {
    const { root, job, env } = await fixture();
    const manyClips = { ...job, clipCount: 12, targetDurationSec: 20 };
    const context = await buildBflPaidApprovalContext({
      root,
      job: manyClips,
      env: { ...env, BFL_MAX_CREDITS: "1020", BFL_ESTIMATED_TOTAL_CREDITS: "1020", BFL_GENERATE_AUDIO: "yes", BFL_SAFETY_TOLERANCE: "4" }
    });
    expect(context.requestPolicy.durationsSec).toEqual(Array(12).fill(5));
    expect(context).toMatchObject({ officialQuoteCredits: 1020, maxCredits: 1020 });
    const changedKey = await buildBflPaidApprovalContext({ root, job: manyClips, env: { ...env, BFL_API_KEY: "other-key", BFL_MAX_CREDITS: "1020", BFL_ESTIMATED_TOTAL_CREDITS: "1020", BFL_GENERATE_AUDIO: "yes", BFL_SAFETY_TOLERANCE: "4" } });
    const changedAudio = await buildBflPaidApprovalContext({ root, job: manyClips, env: { ...env, BFL_MAX_CREDITS: "1020", BFL_ESTIMATED_TOTAL_CREDITS: "1020", BFL_GENERATE_AUDIO: "false", BFL_SAFETY_TOLERANCE: "4" } });
    const changedSafety = await buildBflPaidApprovalContext({ root, job: manyClips, env: { ...env, BFL_MAX_CREDITS: "1020", BFL_ESTIMATED_TOTAL_CREDITS: "1020", BFL_GENERATE_AUDIO: "yes", BFL_SAFETY_TOLERANCE: "3" } });
    expect(changedKey.contextHash).not.toBe(context.contextHash);
    expect(changedAudio.contextHash).not.toBe(context.contextHash);
    expect(changedSafety.contextHash).not.toBe(context.contextHash);
  });

  test("claims one exact request and one provider executor, rejecting mutation and replay", async () => {
    const { jobDir, job, env, context } = await fixture();
    const now = new Date("2026-08-13T00:05:00.000Z");
    const approval = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 canonical request와 단일 provider executor를 승인함",
      apiKey: env.BFL_API_KEY
    });
    await persistBflPaidApproval(jobDir, approval, { apiKey: env.BFL_API_KEY });
    const consumed = await consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY });
    const base = authorizedBaseRequest(job);
    const authorization = bindBflLaunchCapabilityToRequest(consumed.capability, base, { now });
    const request = { ...base, paidAuthorization: authorization };
    expect(validateBflRequestAuthorization(authorization, request, { now })).toBe(authorization);
    expect(() => validateBflRequestAuthorization(authorization, { ...request, topic: "mutated" }, { now })).toThrow("결속되지 않았습니다");
    const firstClaim = await verifyBflConsumedApprovalForRequest(jobDir, authorization, request, {
      now,
      apiKey: env.BFL_API_KEY,
      adapterPath: env.PS4_LOCAL_VIDEO_GENERATOR,
      claim: true
    });
    expect(firstClaim.claimReceipt.requestHash).toBe(request.requestHash);
    await expect(verifyBflConsumedApprovalForRequest(jobDir, authorization, request, { now, claim: true })).rejects.toThrow("이미 provider 요청이 claim");
    const execution = await claimBflProviderExecution(jobDir, authorization, request, { now, allowCreate: true });
    expect(execution.created).toBe(true);
    await expect(claimBflProviderExecution(jobDir, authorization, request, { now, allowCreate: true })).rejects.toThrow("이미 claim");
    expect((await claimBflProviderExecution(jobDir, authorization, request)).claimReceipt).toEqual(execution.claimReceipt);
  });

  test("rejects a self-consistent forged authorization window against the exact consumed receipt", async () => {
    const { jobDir, job, env, context } = await fixture();
    const now = new Date("2026-08-13T00:05:00.000Z");
    const approval = createBflPaidApprovalReceipt(context, {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      reason: "사용자가 정확한 30분 유효 시간 창의 유료 실행을 승인함",
      apiKey: env.BFL_API_KEY
    });
    await persistBflPaidApproval(jobDir, approval, { apiKey: env.BFL_API_KEY });
    const consumed = await consumeBflPaidApproval(jobDir, context, { now, apiKey: env.BFL_API_KEY });
    const base = authorizedBaseRequest(job, "run-forged-window");
    const authorization = bindBflLaunchCapabilityToRequest(consumed.capability, base, { now });
    const forged = forgeAuthorizationWindow(authorization, "2026-08-13T02:35:00.000Z");
    const forgedRequest = { ...base, paidAuthorization: forged };
    expect(validateBflRequestAuthorization(forged, forgedRequest, { now })).toBe(forged);
    await expect(verifyBflConsumedApprovalForRequest(jobDir, forged, forgedRequest, {
      now,
      apiKey: env.BFL_API_KEY,
      adapterPath: env.PS4_LOCAL_VIDEO_GENERATOR
    })).rejects.toThrow("consumed approval 영수증");
  });

  test("rejects a job containing the raw or URL-encoded configured API key before approval context serialization", async () => {
    const { root, job, env } = await fixture();
    await expect(buildBflPaidApprovalContext({
      root,
      job: { ...job, topic: `raw ${env.BFL_API_KEY}` },
      env
    })).rejects.toThrow("직렬화");
    const encodedEnv = { ...env, BFL_API_KEY: "key/with+symbols" };
    await expect(buildBflPaidApprovalContext({
      root,
      job: { ...job, topic: `encoded ${encodeURIComponent(encodedEnv.BFL_API_KEY)}` },
      env: encodedEnv
    })).rejects.toThrow("직렬화");
  });

  test("rejects raw and URL-encoded API keys at every approval receipt boundary while benign token wording remains valid", async () => {
    const { root, job, jobDir, env } = await fixture();
    const keyedEnv = { ...env, BFL_API_KEY: "key/with+symbols" };
    const context = await buildBflPaidApprovalContext({ root, job, env: keyedEnv });
    const now = new Date("2026-08-13T00:05:00.000Z");
    const options = {
      now,
      expiresAt: "2026-08-13T00:35:00.000Z",
      apiKey: keyedEnv.BFL_API_KEY
    };
    const benign = createBflPaidApprovalReceipt(context, {
      ...options,
      reason: "Operator reviewed token rotation and approved this exact paid attempt"
    });
    expect(validateBflPaidApprovalReceipt(benign, context, { now, apiKey: keyedEnv.BFL_API_KEY })).toBe(benign);

    for (const leaked of [keyedEnv.BFL_API_KEY, encodeURIComponent(keyedEnv.BFL_API_KEY)]) {
      expect(() => createBflPaidApprovalReceipt(context, {
        ...options,
        reason: `operator copied ${leaked} into approval reason`
      })).toThrow("직렬화·claim·제출");

      const { approvalHash: _approvalHash, ...unsigned } = benign;
      const leakedUnsigned = { ...unsigned, reason: `operator copied ${leaked} into approval reason` };
      const leakedReceipt = { ...leakedUnsigned, approvalHash: hashBflApprovalValue(leakedUnsigned) };
      expect(() => validateBflPaidApprovalReceipt(leakedReceipt, context, { now, apiKey: keyedEnv.BFL_API_KEY })).toThrow("직렬화·claim·제출");
      await expect(persistBflPaidApproval(jobDir, leakedReceipt, { apiKey: keyedEnv.BFL_API_KEY })).rejects.toThrow("직렬화·claim·제출");
      expect(await stat(join(jobDir, BFL_PAID_APPROVAL_NAME)).catch(() => null)).toBeNull();

      await mkdir(jobDir, { recursive: true });
      await writeFile(join(jobDir, BFL_PAID_APPROVAL_NAME), JSON.stringify(leakedReceipt), { mode: 0o600 });
      await expect(consumeBflPaidApproval(jobDir, context, { now, apiKey: keyedEnv.BFL_API_KEY })).rejects.toThrow("직렬화·claim·제출");
      expect((await readdir(jobDir)).some((name) => name.startsWith("bfl-paid-approval-consumed-"))).toBe(false);
      await rm(join(jobDir, BFL_PAID_APPROVAL_NAME), { force: true });
    }

    const path = await persistBflPaidApproval(jobDir, benign, { apiKey: keyedEnv.BFL_API_KEY });
    const consumed = await consumeBflPaidApproval(jobDir, context, { now, apiKey: keyedEnv.BFL_API_KEY });
    const durableText = `${await readFile(path).catch(() => Buffer.from(""))}${await readFile(consumed.consumedPath, "utf8")}`;
    expect(durableText).not.toContain(keyedEnv.BFL_API_KEY);
    expect(durableText).not.toContain(encodeURIComponent(keyedEnv.BFL_API_KEY));
  });
});
