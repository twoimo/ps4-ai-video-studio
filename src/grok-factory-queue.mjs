import { PROVIDER_ID as GROK_IMAGINE_PROVIDER } from "./grok-imagine-factory.mjs";

export function isGrokFactoryJob(job) {
  return job?.provider === GROK_IMAGINE_PROVIDER;
}

export function createGrokFactoryQueue({
  readJob,
  updateJob,
  launch,
  isFactoryJob = isGrokFactoryJob
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
  }

  async function runAndPump(jobId) {
    runningId = jobId;
    try {
      await updateJob(jobId, {
        queuePosition: 0,
        message: "공장 작업을 시작합니다."
      }).catch(() => {});
      await launch(jobId);
    } finally {
      if (runningId === jobId) runningId = null;
      const next = waiting.shift();
      if (next) void runAndPump(next);
      else await markWaiting();
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
    if (runningId) {
      waiting.push(jobId);
      await markWaiting();
      return true;
    }
    runningId = jobId;
    void runAndPump(jobId);
    return true;
  }

  return { accept, snapshot, markWaiting };
}
