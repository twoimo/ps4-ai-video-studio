#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBflValueDoesNotContainApiKey,
  buildBflPaidApprovalContext,
  createBflPaidApprovalReceipt,
  persistBflPaidApproval
} from "../src/bfl-paid-approval.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/u;

function parseArguments(argv) {
  const result = { mode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--inspect" || argument === "--approve") {
      if (result.mode) throw new Error("--inspect와 --approve 중 하나만 선택하세요.");
      result.mode = argument.slice(2);
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`알 수 없는 인자입니다: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} 값이 필요합니다.`);
    result[key] = value;
    index += 1;
  }
  if (!result.mode) throw new Error("--inspect 또는 --approve가 필요합니다.");
  if (!JOB_ID.test(String(result.job || ""))) throw new Error("안전한 --job ID가 필요합니다.");
  return result;
}

async function readJob(jobId) {
  const jobPath = join(ROOT, "workspace", "jobs", jobId, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  if (job.id !== jobId) throw new Error("job.json ID가 저장 디렉터리와 일치하지 않습니다.");
  return { job, jobDir: dirname(jobPath) };
}

export async function runBflPaidApprovalCli(argv, options = {}) {
  const args = parseArguments(argv);
  const { job, jobDir } = await readJob(args.job);
  const env = options.env || process.env;
  const context = await buildBflPaidApprovalContext({ root: ROOT, job, env });
  if (args.mode === "inspect") return { mode: "inspect", context };
  if (args.expectedContextHash !== context.contextHash) throw new Error("--expected-context-hash가 현재 승인 context와 일치하지 않습니다.");
  if (Number(args.maxCredits) !== context.maxCredits) throw new Error("--max-credits가 현재 BFL 상한과 일치하지 않습니다.");
  if (Number(args.quoteCredits) !== context.officialQuoteCredits) throw new Error("--quote-credits가 공식 최소 견적과 일치하지 않습니다.");
  if (args.assertOnePaidAttempt !== "yes") throw new Error("--assert-one-paid-attempt yes가 필요합니다.");
  assertBflValueDoesNotContainApiKey(args.reason, env.BFL_API_KEY);
  const receipt = createBflPaidApprovalReceipt(context, {
    expiresAt: args.expiresAt,
    reason: args.reason,
    now: options.now || new Date(),
    apiKey: env.BFL_API_KEY
  });
  const path = await persistBflPaidApproval(jobDir, receipt, { apiKey: env.BFL_API_KEY });
  return {
    mode: "approved",
    jobId: job.id,
    approvalHash: receipt.approvalHash,
    contextHash: context.contextHash,
    expiresAt: receipt.expiresAt,
    maxCredits: context.maxCredits,
    officialQuoteCredits: context.officialQuoteCredits,
    officialQuoteUsd: context.officialQuoteUsd,
    path: path.slice(ROOT.length + 1)
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runBflPaidApprovalCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`bfl-paid-approval: ${error.message}\n`);
    process.exitCode = 1;
  });
}
