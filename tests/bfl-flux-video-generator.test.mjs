import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertLiveBudget,
  dryRunReceipt,
  dryRunRequested,
  generate,
  generationPlan,
  isOfficialDeliveryHostname,
  pollingUrlFrom,
  redactValue,
  resultUrlFrom
} from "../scripts/bfl-flux-video-generator.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/bfl-flux-video-request.json", import.meta.url), "utf8"));
const API_KEY = "bfl-test-key/with+symbols";
let temporaryDirectories;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function testHashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function requestFor(directory, overrides = {}) {
  return structuredClone({ ...fixture, jobWorkingDirectory: directory, ...overrides });
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
    BFL_MAX_CREDITS: "10",
    BFL_ESTIMATED_CREDITS_PER_SECOND: "0.2",
    BFL_POLL_INTERVAL_MS: "10",
    BFL_POLL_TIMEOUT_MS: "10000",
    ...overrides
  };
}

beforeEach(() => {
  temporaryDirectories = [];
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ps4-bfl-generator-test-"));
  temporaryDirectories.push(directory);
  return directory;
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

describe("cost and dry-run contract", () => {
  it("builds the documented t2v request shape without network access", async () => {
    const directory = await temporaryDirectory();
    const receipt = dryRunReceipt(requestFor(directory), liveEnvironment());
    expect(receipt.status).toBe("dry-run");
    expect(receipt.networkRequests).toBe(0);
    expect(receipt.contract.endpoint).toBe("https://api.bfl.ai/v1/flux-3-video");
    expect(receipt.contract.concurrency).toBe(1);
    expect(receipt.budget.estimatedTotalCredits).toBe(2);
    expect(receipt.budget.maxCredits).toBe(10);
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
    })).rejects.toThrow("requires BFL_MAX_CREDITS");
    expect(networkRequests).toBe(0);
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

describe("paid submission checkpoint and resume", () => {
  it("persists each task and never submits completed tasks again", async () => {
    const directory = await temporaryDirectory();
    const request = requestFor(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
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
      env: liveEnvironment(),
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
    const request = requestFor(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
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

  it("uses provider-reported cost to stop before the next paid submission", async () => {
    const directory = await temporaryDirectory();
    const request = requestFor(directory);
    let postAttempts = 0;
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        postAttempts += 1;
        return jsonResponse({
          id: `task-budget-${postAttempts}`,
          polling_url: `https://api.bfl.ai/v1/get_result?id=task-budget-${postAttempts}`,
          cost: 2
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
      env: liveEnvironment({ BFL_MAX_CREDITS: "2" }),
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow("budget guard stopped before task 2");
    expect(postAttempts).toBe(1);
  });

  it("records an ambiguous POST outcome and refuses any automatic paid retry", async () => {
    const directory = await temporaryDirectory();
    const request = requestFor(directory, { segments: [fixture.segments[0]], targetDurationSec: 5 });
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

  it("copies an actual provider shot-pattern binding into completed segment receipts", async () => {
    const directory = await temporaryDirectory();
    const providerVisualPrompt = `${fixture.segments[0].prompt}\nCamera-only direction: fixed tripod`;
    const request = requestFor(directory, {
      segments: [{
        ...fixture.segments[0],
        prompt: providerVisualPrompt,
        providerVisualPrompt,
        providerVisualPromptHash: testHashJson(providerVisualPrompt),
        shotPattern: { patternId: "locked-static-evidence", submittedToProvider: false }
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
    expect(receipt.segments[0].submittedPromptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.segments[0].submittedRequestBodyHash).toBe(receipt.tasks[0].requestBodyHash);
    expect(receipt.tasks[0].request.prompt).toBe(providerVisualPrompt);
  });

  it("rejects a mismatched shot-pattern prompt before any paid BFL request", async () => {
    const directory = await temporaryDirectory();
    let fetchCount = 0;
    const providerVisualPrompt = `${fixture.segments[0].prompt}\nCamera-only direction: fixed tripod`;
    const request = requestFor(directory, {
      segments: [{
        ...fixture.segments[0],
        prompt: "different prompt that must never be submitted",
        providerVisualPrompt,
        providerVisualPromptHash: `sha256:${"a".repeat(64)}`,
        shotPattern: { patternId: "locked-static-evidence" }
      }],
      targetDurationSec: 5
    });
    await expect(generate(request, API_KEY, {
      env: liveEnvironment(),
      fetchImpl: async () => { fetchCount += 1; throw new Error("must not be called"); },
      sleep: async () => {}
    })).rejects.toThrow("providerVisualPrompt must equal the submitted prompt");
    expect(fetchCount).toBe(0);
  });
});
