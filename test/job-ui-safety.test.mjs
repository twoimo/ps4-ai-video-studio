import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAX_STUDIO_BEARER_BYTES,
  STUDIO_BEARER_SESSION_KEY,
  authorizedStudioFetchOptions,
  consumeStudioBearerFragment,
  init,
  jobStatusClassToken,
  parseStudioBearerFragment,
  readStoredStudioBearer,
  validStudioBearerToken
} from "../public/app.js";
import {
  buildYouTubeVideoUrl,
  createProductionJobInertFirst,
  currentQualityEvidenceEntry,
  geminiQuotaMonitorSummary,
  invalidateQualityEvidenceCache,
  jobAnnouncementSignature,
  localClipReplacementConfirmation,
  localClipUploadExpectedRunId,
  partitionRunArtifacts,
  providerReadinessRefreshDelay,
  qualityEvidenceCacheEntryMatches,
  qualityEvidenceCacheKey,
  refreshQualityEvidenceCache,
  safeSameOriginArtifactUrl,
  safeYouTubeVideoUrl,
  semanticRevalidationEligibility,
  shouldPollJobs,
  stableUiSignature
} from "../public/job-ui-safety.js";

describe("fragment-only Studio bearer bootstrap", () => {
  const token = "t".repeat(43);

  test("accepts only bounded, whitespace-free bearer values", () => {
    expect(validStudioBearerToken(token)).toBe(true);
    expect(validStudioBearerToken("x".repeat(32))).toBe(true);
    expect(validStudioBearerToken("x".repeat(31))).toBe(false);
    expect(validStudioBearerToken(`x${"y".repeat(31)}\n`)).toBe(false);
    expect(validStudioBearerToken(`x${"y".repeat(30)}\u0000`)).toBe(false);
    expect(validStudioBearerToken("x".repeat(MAX_STUDIO_BEARER_BYTES + 1))).toBe(false);
  });

  test("parses one exact encoded #token fragment and rejects ambiguous forms", () => {
    expect(parseStudioBearerFragment(`#token=${encodeURIComponent(token)}`)).toEqual({ present: true, token });
    expect(parseStudioBearerFragment("#create")).toEqual({ present: false, token: null });
    for (const hash of [
      `#token=${token}&next=create`,
      `#next=create&token=${token}`,
      `#token=${token}&token=${token}`,
      `#token=${token}&`,
      "#token=%ZZ",
      "#token=short"
    ]) expect(parseStudioBearerFragment(hash)).toEqual({ present: true, token: null });
  });

  test("stores a valid fragment in sessionStorage and clears it before returning", () => {
    const events = [];
    const values = new Map();
    const storage = {
      setItem(key, value) { events.push("store"); values.set(key, value); },
      removeItem(key) { events.push("remove"); values.delete(key); }
    };
    const location = { hash: `#token=${token}`, pathname: "/studio", search: "?view=jobs" };
    const history = { state: { stable: true }, replaceState(state, _unused, url) { events.push("clear"); this.call = { state, url }; } };

    expect(consumeStudioBearerFragment({ location, history, storage })).toEqual({ present: true, token });
    expect(events).toEqual(["store", "clear"]);
    expect(values.get(STUDIO_BEARER_SESSION_KEY)).toBe(token);
    expect(history.call).toEqual({ state: { stable: true }, url: "/studio?view=jobs" });
  });

  test("invalid explicit fragments erase stale session credentials and are still cleared", () => {
    const values = new Map([[STUDIO_BEARER_SESSION_KEY, token]]);
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    };
    let clearedTo = null;
    const parsed = consumeStudioBearerFragment({
      location: { hash: "#token=short", pathname: "/", search: "" },
      history: { replaceState(_state, _unused, url) { clearedTo = url; } },
      storage
    });
    expect(parsed).toEqual({ present: true, token: null });
    expect(readStoredStudioBearer(storage)).toBeNull();
    expect(clearedTo).toBe("/");
  });

  test("attaches the exact bearer while suppressing ambient credentials", () => {
    const options = authorizedStudioFetchOptions({
      method: "POST",
      credentials: "include",
      headers: { authorization: "Bearer attacker", "content-type": "application/json" }
    }, token);
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("omit");
    expect(options.referrerPolicy).toBe("no-referrer");
    expect(options.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(options.headers.get("content-type")).toBe("application/json");
    expect(() => authorizedStudioFetchOptions({}, "short")).toThrow("잠겨");
  });

  test("an anonymous direct visit stays locked and performs no API request", async () => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.document = { querySelector: () => null };
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected API call"); };
    try {
      const unlocked = await init({
        location: { hash: "", pathname: "/", search: "" },
        history: {},
        storage: { getItem: () => null, removeItem() {} }
      });
      expect(unlocked).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  });
});

describe("inert-first provider launch", () => {
  test("persists the returned Gemini job id before starting that exact job", async () => {
    const events = [];
    const calls = [];
    const apiCall = async (path, options) => {
      calls.push({ path, options });
      events.push(path === "/api/jobs" ? "create" : "run");
      return path === "/api/jobs" ? { job: { id: "job-gemini-1" } } : { started: true };
    };
    const result = await createProductionJobInertFirst(apiCall, { provider: "gemini-browser", topic: "safe topic" }, {
      onCreated: ({ jobId }) => events.push(`persist:${jobId}`)
    });

    expect(events).toEqual(["create", "persist:job-gemini-1", "run"]);
    expect(calls.map((entry) => entry.path)).toEqual(["/api/jobs", "/api/jobs/job-gemini-1/run"]);
    expect(JSON.parse(calls[0].options.body)).toEqual({ autoStart: false, provider: "gemini-browser", topic: "safe topic" });
    expect(result).toMatchObject({ jobId: "job-gemini-1", runAttempted: true, runError: null });
  });

  test("keeps a lost run response attached to the same durable job and never starts local modes", async () => {
    const calls = [];
    const failingApi = async (path, options) => {
      calls.push({ path, options });
      if (path === "/api/jobs") return { job: { id: "job-gemini-2" } };
      throw new Error("response lost");
    };
    const gemini = await createProductionJobInertFirst(failingApi, { provider: "gemini-browser", topic: "safe topic" });
    expect(gemini).toMatchObject({ jobId: "job-gemini-2", runAttempted: true, runError: { message: "response lost" } });
    expect(calls.map((entry) => entry.path)).toEqual(["/api/jobs", "/api/jobs/job-gemini-2/run"]);

    calls.length = 0;
    const local = await createProductionJobInertFirst(failingApi, { provider: "local", topic: "manual clips" });
    expect(local).toMatchObject({ jobId: "job-gemini-2", runAttempted: false, runError: null });
    expect(calls.map((entry) => entry.path)).toEqual(["/api/jobs"]);
    expect(JSON.parse(calls[0].options.body).autoStart).toBe(false);
  });

  test("does not start Gemini when the caller cannot checkpoint the created id", async () => {
    const calls = [];
    const apiCall = async (path) => {
      calls.push(path);
      return { job: { id: "job-gemini-3" } };
    };
    await expect(createProductionJobInertFirst(apiCall, { provider: "gemini-browser", topic: "safe topic" }, {
      onCreated: async () => { throw new Error("checkpoint unavailable"); }
    })).rejects.toThrow("checkpoint unavailable");
    expect(calls).toEqual(["/api/jobs"]);
  });
});

describe("job status class tokens", () => {
  test("preserves the fixed status classes and integrity-blocked precedence", () => {
    for (const status of ["queued", "running", "verifying", "completed", "needs-improvement", "failed"]) {
      expect(jobStatusClassToken({ status })).toBe(status);
    }
    expect(jobStatusClassToken({ status: "running", integrity: { status: "blocked" } })).toBe("integrity-blocked");
  });

  test("maps attacker-controlled and malformed statuses to one inert class token", () => {
    const maliciousStatus = `running\" onpointerenter=\"globalThis.pwned=true`;
    const classAttribute = `job-status ${jobStatusClassToken({ status: maliciousStatus })}`;
    expect(classAttribute).toBe("job-status unknown");
    expect(classAttribute).not.toContain("\"");
    expect(jobStatusClassToken({ status: ["running"] })).toBe("unknown");
    expect(jobStatusClassToken({ status: null })).toBe("unknown");
  });
});

describe("Gemini quota monitor projection", () => {
  test("does not advertise the removed implicit Gemini text provider", async () => {
    const applicationSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    expect(applicationSource).not.toContain("geminiApiKey");
    expect(applicationSource).not.toContain("Gemini text API");
  });

  test("never turns a stale provider observation into current availability", () => {
    expect(geminiQuotaMonitorSummary({
      providers: {
        gemini: {
          status: "STALE",
          operational: { profileCount: 2, freshProfileCount: 0, availableCount: 1 },
          blockers: [{ code: "profile-observation-stale" }]
        }
      }
    })).toEqual({
      ready: false,
      status: "STALE",
      availableCount: 0,
      freshProfileCount: 0,
      profileCount: 2,
      label: "STALE · 0/2 계정 사용 가능 · fresh 0/2 · profile-observation-stale"
    });
  });

  test("refreshes at the first future receipt expiry and backs off stale payloads", () => {
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    expect(providerReadinessRefreshDelay({ providers: {
      gemini: { expiresAt: "2026-08-13T00:00:10.000Z" },
      bfl: { expiresAt: "2026-08-13T00:05:00.000Z" }
    } }, now)).toBe(10_250);
    expect(providerReadinessRefreshDelay({ providers: { gemini: { expiresAt: "2026-08-12T23:59:00.000Z" } } }, now)).toBe(60_000);
  });

  test("requires a fresh positive count and fails closed for inconsistent or malformed readiness", () => {
    expect(geminiQuotaMonitorSummary({ providers: { gemini: {
      status: "READY",
      operational: { profileCount: 2, freshProfileCount: 2, availableCount: 1 }
    } } })).toMatchObject({ ready: true, status: "READY", availableCount: 1 });
    expect(geminiQuotaMonitorSummary({ providers: { gemini: {
      status: "READY",
      operational: { profileCount: 2, freshProfileCount: 0, availableCount: 2 }
    } } })).toMatchObject({ ready: false, status: "BLOCKED", availableCount: 0 });
    expect(geminiQuotaMonitorSummary(null)).toMatchObject({ ready: false, status: "NOT_CONNECTED", availableCount: 0 });
  });
});

describe("deterministic UI state signatures", () => {
  test("is independent of nested object key insertion order while preserving list order", () => {
    const left = { selected: { status: "running", id: "job-1" }, jobs: [{ progress: 20, id: "job-1" }, { id: "job-2" }] };
    const right = { jobs: [{ id: "job-1", progress: 20 }, { id: "job-2" }], selected: { id: "job-1", status: "running" } };
    expect(stableUiSignature(left)).toBe(stableUiSignature(right));
    expect(stableUiSignature({ jobs: [...left.jobs].reverse() })).not.toBe(stableUiSignature({ jobs: left.jobs }));
  });

  test("fails closed for cyclic, non-finite, and non-JSON values", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => stableUiSignature(cyclic)).toThrow();
    expect(() => stableUiSignature({ progress: Number.NaN })).toThrow();
    expect(() => stableUiSignature({ callback() {} })).toThrow();
  });
});

describe("job polling policy", () => {
  test("treats every queued job as waiting until the server confirms an active status", () => {
    expect(shouldPollJobs([{ provider: "local", status: "queued" }])).toBe(false);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "queued" }])).toBe(false);
    expect(shouldPollJobs([{ provider: "local-video", status: "queued" }])).toBe(false);
  });

  test("polls running and verifying work but not terminal or unknown queued work", () => {
    expect(shouldPollJobs([{ provider: "local", status: "running" }])).toBe(true);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "verifying" }])).toBe(true);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "completed" }])).toBe(false);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "running", integrity: { status: "blocked" } }])).toBe(false);
    expect(shouldPollJobs([{ provider: "unknown", status: "queued" }])).toBe(false);
    expect(shouldPollJobs(null)).toBe(false);
  });
});

describe("append-only quality evidence cache", () => {
  const baseJob = {
    id: "job-1",
    runId: "run-1",
    status: "needs-improvement",
    runStatus: "needs-improvement",
    qualitySummary: {
      status: "needs-improvement",
      revisionId: "revision-1",
      revisionSequence: 1,
      totalScore: 91
    }
  };

  test("refreshes quality and history when the revision changes within the same run", async () => {
    let calls = 0;
    const fetchEvidence = async (job) => {
      calls += 1;
      return {
        quality: { revisionId: job.qualitySummary.revisionId, totalScore: job.qualitySummary.totalScore },
        history: [{ revisionId: job.qualitySummary.revisionId }]
      };
    };
    const first = await refreshQualityEvidenceCache(baseJob, null, fetchEvidence);
    const hit = await refreshQualityEvidenceCache(baseJob, first.entry, fetchEvidence);
    const revisedJob = {
      ...baseJob,
      status: "completed",
      runStatus: "verified",
      qualitySummary: { ...baseJob.qualitySummary, status: "passed", revisionId: "revision-2", revisionSequence: 2, totalScore: 100 }
    };
    const revised = await refreshQualityEvidenceCache(revisedJob, hit.entry, fetchEvidence);

    expect(first.refreshed).toBe(true);
    expect(hit).toEqual({ entry: first.entry, refreshed: false });
    expect(revised.refreshed).toBe(true);
    expect(revised.entry.quality).toEqual({ revisionId: "revision-2", totalScore: 100 });
    expect(revised.entry.history).toEqual([{ revisionId: "revision-2" }]);
    expect(revised.entry.cacheKey).not.toBe(first.entry.cacheKey);
    expect(qualityEvidenceCacheEntryMatches(revisedJob, revised.entry)).toBe(true);
    expect(qualityEvidenceCacheEntryMatches(revisedJob, first.entry)).toBe(false);
    expect(qualityEvidenceCacheKey(revisedJob)).not.toBe(qualityEvidenceCacheKey(baseJob));
    expect(calls).toBe(2);
  });

  test("does not let a transient GET failure become a permanent cache hit", async () => {
    let calls = 0;
    const fetchEvidence = async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary quality read failure");
      return { quality: { revisionId: "revision-1", totalScore: 91 }, history: [{ revisionId: "revision-1" }] };
    };
    const failed = await refreshQualityEvidenceCache(baseJob, null, fetchEvidence);
    const retried = await refreshQualityEvidenceCache(baseJob, failed.entry, fetchEvidence);

    expect(failed.entry).toMatchObject({ quality: null, error: "temporary quality read failure" });
    expect(retried).toMatchObject({ refreshed: true, entry: { quality: { revisionId: "revision-1", totalScore: 91 } } });
    expect(retried.entry).not.toHaveProperty("error");
    expect(calls).toBe(2);
  });

  test("never exposes a prior run quality receipt after local clips reset the job to an unrun queue", async () => {
    const cached = await refreshQualityEvidenceCache(baseJob, null, async () => ({
      quality: { status: "passed", technicalEvidenceGate: true, semanticGate: true },
      history: [{ status: "passed" }]
    }));
    const replacementJob = {
      ...baseJob,
      status: "queued",
      runStatus: "queued",
      runId: null,
      qualitySummary: null,
      localClipImport: { status: "ready", clipCount: 2, providerEvidenceEligible: false }
    };

    expect(currentQualityEvidenceEntry(baseJob, cached.entry)).toBe(cached.entry);
    expect(qualityEvidenceCacheEntryMatches(replacementJob, cached.entry)).toBe(false);
    expect(currentQualityEvidenceEntry(replacementJob, cached.entry)).toBeNull();
  });

  test("requires explicit terminal-run replacement confirmation and invalidates its cached evidence", () => {
    const terminal = { ...baseJob, provider: "local", runId: "run-sealed-123", status: "needs-improvement" };
    const confirmation = localClipReplacementConfirmation(terminal);
    expect(confirmation).toMatchObject({ runId: "run-sealed-123" });
    expect(confirmation.message).toContain("RUN run-sealed-123");
    expect(confirmation.message).toContain("source clips");
    expect(confirmation.message).toContain("작업 상세/API의 현재 결과에서 더 이상 보이지 않습니다");
    expect(confirmation.message).toContain("봉인된 run 파일은 보존");
    expect(localClipUploadExpectedRunId(terminal)).toBe("run-sealed-123");
    expect(localClipUploadExpectedRunId({ ...terminal, runId: null, status: "queued" })).toBe("");
    expect(localClipReplacementConfirmation({ ...terminal, status: "queued" })).toBeNull();
    expect(localClipReplacementConfirmation({ ...terminal, provider: "gemini-browser" })).toBeNull();

    const cache = { [terminal.id]: { cacheKey: "old", quality: { status: "passed" } }, other: { quality: null } };
    expect(invalidateQualityEvidenceCache(cache, terminal.id)).toBe(true);
    expect(cache).toEqual({ other: { quality: null } });
    expect(invalidateQualityEvidenceCache(cache, terminal.id)).toBe(false);
  });
});

describe("semantic revalidation UI safety", () => {
  const eligible = {
    provider: "gemini-browser",
    status: "needs-improvement",
    runStatus: "needs-improvement",
    runId: "run-1",
    semanticRevalidationReadiness: { eligible: true, sourceRunId: "run-1", providerRequests: 0 }
  };

  test("requires the live job state, exact source run, integrity, and provider-zero readiness together", () => {
    expect(semanticRevalidationEligibility(eligible)).toEqual({ eligible: true, sourceRunId: "run-1", providerRequests: 0 });
    for (const job of [
      { ...eligible, provider: "local-video" },
      { ...eligible, status: "running" },
      { ...eligible, runStatus: "verified" },
      { ...eligible, integrity: { status: "blocked", message: "tampered" } },
      { ...eligible, semanticRevalidationReadiness: { eligible: true, sourceRunId: "run-old", providerRequests: 0 } },
      { ...eligible, semanticRevalidationReadiness: { eligible: true, sourceRunId: "run-1", providerRequests: 1 } }
    ]) expect(semanticRevalidationEligibility(job).eligible).toBe(false);
  });

  test("keeps immutable run artifacts separate from mutable workspace references", () => {
    const artifacts = [
      { name: "runs/run-1/artifacts/final.mp4" },
      { name: "final.mp4" },
      { name: "runs/run-old/artifacts/final.mp4" },
      { name: "runs/run-1/manifest.json" }
    ];
    expect(partitionRunArtifacts(artifacts, "run-1")).toEqual({
      immutable: [{ name: "runs/run-1/artifacts/final.mp4" }],
      revision: [],
      mutable: [{ name: "final.mp4" }, { name: "runs/run-old/artifacts/final.mp4" }, { name: "runs/run-1/manifest.json" }]
    });
  });

  test("separates current append-only revision evidence from mutable workspace references", () => {
    const revision = { name: "runs/run-1/revisions/revision-1/quality.json", sha256: `sha256:${"a".repeat(64)}` };
    expect(partitionRunArtifacts([revision, { name: "quality.json" }], "run-1")).toEqual({
      immutable: [],
      revision: [revision],
      mutable: [{ name: "quality.json" }]
    });
  });
});

describe("safe YouTube destinations", () => {
  const id = "dQw4w9WgXcQ";

  test("builds and normalizes allowlisted HTTPS video URLs", () => {
    expect(buildYouTubeVideoUrl(id)).toBe(`https://www.youtube.com/watch?v=${id}`);
    expect(buildYouTubeVideoUrl(id, { shorts: true })).toBe(`https://www.youtube.com/shorts/${id}`);
    expect(buildYouTubeVideoUrl("bad/id")).toBeNull();
    expect(safeYouTubeVideoUrl(`https://youtube.com/watch?v=${id}`)).toBe(`https://www.youtube.com/watch?v=${id}`);
    expect(safeYouTubeVideoUrl(`https://m.youtube.com/shorts/${id}?feature=share`)).toBe(`https://www.youtube.com/shorts/${id}`);
    expect(safeYouTubeVideoUrl(`https://youtu.be/${id}?si=tracking`)).toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  test("rejects executable, insecure, credentialed, cross-origin, and malformed URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      `http://www.youtube.com/watch?v=${id}`,
      `https://www.youtube.com.evil.example/watch?v=${id}`,
      `https://evil.example/watch?v=${id}`,
      `https://user:pass@www.youtube.com/watch?v=${id}`,
      `https://www.youtube.com:444/watch?v=${id}`,
      "https://www.youtube.com/watch?v=bad/id",
      `https://www.youtube.com/watch?feature=share&v=${id}`,
      `https://www.youtube.com/watch?v=${id}&v=${id}`,
      `https://www.youtube.com/watch?v=${id}#ignored`,
      `https://www.youtube.com/redirect?q=https://evil.example/&v=${id}`
    ]) expect(safeYouTubeVideoUrl(value)).toBeNull();
  });
});

describe("same-origin artifact destinations", () => {
  const origin = "http://127.0.0.1:3000";
  const path = "/api/jobs/job-1/artifacts/runs%2Frun-1%2Fartifacts%2Ffinal.mp4";
  const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
  const expiresAt = Math.floor(nowMs / 1000) + 300;
  const capability = "a".repeat(43);
  const capablePath = `${path}?exp=${expiresAt}&cap=${capability}`;

  test("accepts only an exact same-origin artifact route with a bounded capability", () => {
    expect(safeSameOriginArtifactUrl(path, origin, { nowMs })).toBeNull();
    expect(safeSameOriginArtifactUrl(capablePath, origin, { nowMs })).toBe(`${origin}${capablePath}`);
    expect(safeSameOriginArtifactUrl(`${origin}${capablePath}`, origin, { nowMs })).toBe(`${origin}${capablePath}`);
    expect(safeSameOriginArtifactUrl(capablePath, origin, {
      jobId: "job-1",
      artifactName: "runs/run-1/artifacts/final.mp4",
      nowMs
    })).toBe(`${origin}${capablePath}`);
    expect(safeSameOriginArtifactUrl(capablePath, origin, { jobId: "job-2", artifactName: "runs/run-1/artifacts/final.mp4", nowMs })).toBeNull();
    expect(safeSameOriginArtifactUrl(capablePath, origin, { jobId: "job-1", artifactName: "runs/run-1/artifacts/other.mp4", nowMs })).toBeNull();
  });

  test("rejects executable, cross-origin, credentialed, malformed capability, and traversal URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      `https://evil.example${capablePath}`,
      `http://localhost:3000${capablePath}`,
      `http://user:pass@127.0.0.1:3000${capablePath}`,
      `${path}?token=secret`,
      `${capablePath}&extra=1`,
      `${path}?exp=${expiresAt}&exp=${expiresAt}&cap=${capability}`,
      `${path}?exp=${expiresAt}&cap=short`,
      `${path}?exp=${Math.floor(nowMs / 1000) - 1}&cap=${capability}`,
      `${path}?exp=${Math.floor(nowMs / 1000) + 3601}&cap=${capability}`,
      `${capablePath}#fragment`,
      `/api/jobs/job-1/not-artifacts/final.mp4?exp=${expiresAt}&cap=${capability}`,
      `/api/jobs/job-1/artifacts/%2e%2e%2fsecret?exp=${expiresAt}&cap=${capability}`,
      `/api/jobs/%2e%2e/artifacts/final.mp4?exp=${expiresAt}&cap=${capability}`
    ]) expect(safeSameOriginArtifactUrl(value, origin, { nowMs })).toBeNull();
    expect(safeSameOriginArtifactUrl(capablePath, "javascript:alert(1)", { nowMs })).toBeNull();
  });
});

describe("job status announcements", () => {
  test("ignores progress churn but changes for meaningful status transitions", () => {
    const base = { id: "job-1", status: "running", stage: "영상 생성", message: "생성 중", progress: 10 };
    expect(jobAnnouncementSignature(base)).toBe(jobAnnouncementSignature({ ...base, progress: 90 }));
    expect(jobAnnouncementSignature(base)).not.toBe(jobAnnouncementSignature({ ...base, status: "verifying", stage: "검증" }));
    expect(jobAnnouncementSignature(base)).not.toBe(jobAnnouncementSignature({ ...base, integrity: { status: "blocked", message: "증거 확인 필요" } }));
  });
});
