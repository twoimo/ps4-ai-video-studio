import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "./run-ledger.mjs";
import { PROVIDER_ID as GROK_IMAGINE_PROVIDER } from "./grok-imagine-factory.mjs";

export function isGrokFactoryJob(job) {
  return job?.provider === GROK_IMAGINE_PROVIDER;
}

export function createGrokFactoryQueue({
  readJob,
  updateJob,
  launch,
  isFactoryJob = isGrokFactoryJob,
  persistPath = null,
  isFrozen = () => false
} = {}) {
  const waiting = [];
  let runningId = null;

  function snapshot() {
    return {
      runningId,
      waiting: [...waiting],
      busy: Boolean(runningId)
    };
  }

  async function persist() {
    if (!persistPath) return;
    await writeJsonAtomic(persistPath, { waiting: [...waiting], runningId });
  }

  async function markWaiting() {
    for (let index = 0; index < waiting.length; index += 1) {
      const jobId = waiting[index];
      await updateJob(jobId, {
        status: "queued",
        stage: "대기",
        message: `공장 대기열 ${index + 1}번 · 한 번에 하나만 실행합니다`,
        queuePosition: index + 1
      }).catch(() => {});
    }
    await persist();
  }

  async function runAndPump(jobId) {
    runningId = jobId;
    await persist();
    try {
      await updateJob(jobId, {
        queuePosition: 0,
        message: "공장 작업을 시작합니다."
      }).catch(() => {});
      if (!isFrozen()) await launch(jobId);
    } finally {
      if (runningId === jobId) runningId = null;
      const next = waiting.shift();
      await persist();
      if (next && !isFrozen()) void runAndPump(next);
      else {
        if (next) waiting.unshift(next);
        await markWaiting();
      }
    }
  }

  async function accept(jobId) {
    const job = await readJob(jobId);
    if (!isFactoryJob(job)) return launch(jobId);
    if (runningId === jobId) return true;
    if (waiting.includes(jobId)) {
      await markWaiting();
      return true;
    }
    if (isFrozen() || runningId) {
      waiting.push(jobId);
      await markWaiting();
      return true;
    }
    runningId = jobId;
    await persist();
    void runAndPump(jobId);
    return true;
  }

  async function restore() {
    if (!persistPath) return snapshot();
    let saved = null;
    try {
      saved = JSON.parse(await readFile(persistPath, "utf8"));
    } catch {
      return snapshot();
    }
    const ids = [...(Array.isArray(saved.waiting) ? saved.waiting : [])];
    if (saved.runningId) ids.unshift(saved.runningId);
    runningId = null;
    waiting.length = 0;
    for (const jobId of ids) {
      if (!jobId || waiting.includes(jobId)) continue;
      const job = await readJob(jobId).catch(() => null);
      if (!job || job.status === "completed") continue;
      waiting.push(jobId);
    }
    await persist();
    if (isFrozen()) {
      await markWaiting();
      return snapshot();
    }
    const next = waiting.shift();
    if (next) void runAndPump(next);
    else await markWaiting();
    return snapshot();
  }

  return { accept, snapshot, markWaiting, restore, persist };
}
