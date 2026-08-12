import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLegacyGeminiAbandonment } from "../src/gemini-legacy-abandonment.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export async function main() {
  const jobId = option("--job");
  const expectedGenerationSha256 = option("--expected-generation-sha256");
  const reason = option("--reason");
  const assertNoLiveTarget = process.argv.includes("--assert-no-live-target");
  const jobsDir = resolve(import.meta.dirname, "..", "workspace", "jobs");
  const { receiptPath, receipt } = await createLegacyGeminiAbandonment({
    jobsDir,
    jobId,
    expectedGenerationSha256,
    reason,
    assertNoLiveTarget
  });
  console.log(JSON.stringify({
    created: true,
    jobId: receipt.jobId,
    sourceGenerationSha256: receipt.sourceGeneration.sha256,
    receiptHash: receipt.receiptHash,
    receiptPath
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
