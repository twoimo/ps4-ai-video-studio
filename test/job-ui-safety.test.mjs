import { describe, expect, test } from "bun:test";
import {
  buildYouTubeVideoUrl,
  jobAnnouncementSignature,
  partitionRunArtifacts,
  safeSameOriginArtifactUrl,
  safeYouTubeVideoUrl,
  semanticRevalidationEligibility,
  shouldPollJobs,
  stableUiSignature
} from "../public/job-ui-safety.js";

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
  test("excludes a manually queued local job and includes queued generation providers", () => {
    expect(shouldPollJobs([{ provider: "local", status: "queued" }])).toBe(false);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "queued" }])).toBe(true);
    expect(shouldPollJobs([{ provider: "local-video", status: "queued" }])).toBe(true);
  });

  test("polls running and verifying work but not terminal or unknown queued work", () => {
    expect(shouldPollJobs([{ provider: "local", status: "running" }])).toBe(true);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "verifying" }])).toBe(true);
    expect(shouldPollJobs([{ provider: "gemini-browser", status: "completed" }])).toBe(false);
    expect(shouldPollJobs([{ provider: "unknown", status: "queued" }])).toBe(false);
    expect(shouldPollJobs(null)).toBe(false);
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
      mutable: [{ name: "final.mp4" }, { name: "runs/run-old/artifacts/final.mp4" }, { name: "runs/run-1/manifest.json" }]
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

  test("accepts only the exact same-origin artifact route", () => {
    expect(safeSameOriginArtifactUrl(path, origin)).toBe(`${origin}${path}`);
    expect(safeSameOriginArtifactUrl(`${origin}${path}`, origin)).toBe(`${origin}${path}`);
  });

  test("rejects executable, cross-origin, credentialed, query-bearing, and traversal URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      `https://evil.example${path}`,
      `http://localhost:3000${path}`,
      `http://user:pass@127.0.0.1:3000${path}`,
      `${path}?token=secret`,
      `${path}#fragment`,
      "/api/jobs/job-1/not-artifacts/final.mp4",
      "/api/jobs/job-1/artifacts/%2e%2e%2fsecret",
      "/api/jobs/%2e%2e/artifacts/final.mp4"
    ]) expect(safeSameOriginArtifactUrl(value, origin)).toBeNull();
    expect(safeSameOriginArtifactUrl(path, "javascript:alert(1)")).toBeNull();
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
