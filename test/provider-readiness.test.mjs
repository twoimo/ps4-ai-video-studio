import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROVIDER_PROBE_TTL_MS,
  bflConfigurationReadiness,
  buildProviderReadiness,
  externalProbeReadiness,
  geminiMonitorReadiness
} from "../src/provider-readiness.mjs";
import { providerReadinessMarkup } from "../public/provider-readiness-view.js";
import { createSessionToken, createStudioRequestHandler } from "../src/server.mjs";

const temporaryDirectories = [];
const NOW = new Date("2026-08-12T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "ps4-provider-readiness-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "workspace", "provider-probes"), { recursive: true });
  const adapter = join(root, "scripts", "bfl-flux-video-generator.mjs");
  await writeFile(adapter, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(adapter, 0o755);
  return { root, adapter };
}

async function mutationSnapshot(path) {
  const [bytes, file, parent] = await Promise.all([
    readFile(path),
    stat(path, { bigint: true }),
    stat(dirname(path), { bigint: true })
  ]);
  return {
    bytes,
    fileMtimeNs: file.mtimeNs,
    fileCtimeNs: file.ctimeNs,
    parentMtimeNs: parent.mtimeNs,
    parentCtimeNs: parent.ctimeNs
  };
}

function freshProbe(provider = "higgsfield") {
  return {
    schemaVersion: 1,
    provider,
    observedAt: "2026-08-12T11:59:00.000Z",
    status: "available",
    blockerCode: null
  };
}

function freshMonitor() {
  return {
    schemaVersion: 2,
    updatedAt: "2026-08-12T11:59:30.000Z",
    status: "quota-available",
    profiles: [{
      id: "account-1",
      observedAt: "2026-08-12T11:59:20.000Z",
      authentication: "authenticated",
      headless: true,
      requestedHeadless: true,
      videoMode: true,
      available: true
    }]
  };
}

describe("strict provider probe receipts", () => {
  test("accepts only the exact schema and enforces the server TTL", () => {
    const fresh = {
      schemaVersion: 1,
      provider: "higgsfield",
      observedAt: "2026-08-12T11:59:00.000Z",
      status: "available",
      blockerCode: null
    };
    expect(externalProbeReadiness(fresh, "higgsfield", { now: NOW })).toMatchObject({
      status: "READY",
      evidence: "fresh-probe-receipt",
      blockers: []
    });

    const stale = { ...fresh, observedAt: new Date(NOW.getTime() - PROVIDER_PROBE_TTL_MS - 1).toISOString() };
    expect(externalProbeReadiness(stale, "higgsfield", { now: NOW })).toMatchObject({
      status: "STALE",
      blockers: [{ code: "probe-receipt-stale" }]
    });

    expect(externalProbeReadiness({ ...fresh, unexpected: "private data" }, "higgsfield", { now: NOW })).toMatchObject({
      status: "NOT_CONNECTED",
      evidence: "invalid-probe-receipt"
    });
    expect(externalProbeReadiness({ ...fresh, provider: "veed" }, "higgsfield", { now: NOW }).status).toBe("NOT_CONNECTED");
    expect(externalProbeReadiness({ ...fresh, observedAt: "2026-08-12T12:02:00.000Z" }, "higgsfield", { now: NOW }).status).toBe("NOT_CONNECTED");
    expect(externalProbeReadiness(null, "veed", { now: NOW })).toMatchObject({
      status: "NOT_CONNECTED",
      blockers: [{ code: "probe-receipt-missing" }]
    });
  });

  test("surfaces only an allowlisted explicit blocker from a fresh receipt", () => {
    const blocked = externalProbeReadiness({
      schemaVersion: 1,
      provider: "veed",
      observedAt: "2026-08-12T11:59:00.000Z",
      status: "blocked",
      blockerCode: "authentication-required"
    }, "veed", { now: NOW });
    expect(blocked).toMatchObject({ status: "BLOCKED", blockers: [{ code: "authentication-required" }] });
    expect(JSON.stringify(blocked)).not.toContain("cookie");
  });
});

describe("configuration-only BFL readiness", () => {
  test("reports presence booleans without returning secret or budget values", async () => {
    const { root, adapter } = await fixtureRoot();
    const result = await bflConfigurationReadiness(root, {
      BFL_API_KEY: "do-not-return-this-key",
      BFL_MAX_CREDITS: "12.5",
      BFL_ESTIMATED_CREDITS_PER_SECOND: "0.5",
      PS4_LOCAL_VIDEO_GENERATOR: adapter
    });
    expect(result).toMatchObject({
      status: "CONFIGURED",
      evidence: "local-configuration-only",
      liveConnectionVerified: false,
      configuration: {
        apiKeyConfigured: true,
        budgetCapConfigured: true,
        costEstimateConfigured: true,
        generatorSelected: true,
        selectedGeneratorExecutable: true,
        bundledAdapterAvailable: true,
        bundledAdapterSelected: true
      },
      blockers: []
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("do-not-return-this-key");
    expect(serialized).not.toContain("12.5");
    expect(serialized).not.toContain(adapter);
  });

  test("distinguishes the available bundled adapter from an actually selected generator", async () => {
    const { root } = await fixtureRoot();
    const result = await bflConfigurationReadiness(root, {});
    expect(result.configuration).toMatchObject({
      bundledAdapterAvailable: true,
      bundledAdapterSelected: false,
      generatorSelected: false
    });
    expect(result.blockers.map(({ code }) => code)).toEqual([
      "api-key-not-configured",
      "budget-cap-not-configured",
      "cost-estimate-not-configured",
      "generator-not-selected"
    ]);
  });

  test("rejects zero, negative, non-finite, and malformed BFL budget values", async () => {
    const { root, adapter } = await fixtureRoot();
    for (const value of ["0", "-1", "garbage", "Infinity", "NaN"]) {
      const result = await bflConfigurationReadiness(root, {
        BFL_API_KEY: "configured-but-never-returned",
        BFL_MAX_CREDITS: value,
        BFL_ESTIMATED_TOTAL_CREDITS: value,
        PS4_LOCAL_VIDEO_GENERATOR: adapter
      });
      expect(result.status).toBe("BLOCKED");
      expect(result.configuration).toMatchObject({ budgetCapConfigured: false, costEstimateConfigured: false });
      expect(result.blockers.map(({ code }) => code)).toContain("budget-cap-not-configured");
      expect(result.blockers.map(({ code }) => code)).toContain("cost-estimate-not-configured");
    }
  });
});

describe("readiness projection and UI", () => {
  test("rejects linked external probe and monitor receipts without touching their bytes or metadata", async () => {
    for (const kind of ["hardlink", "symlink"]) {
      const { root } = await fixtureRoot();
      const externalDir = join(root, `external-${kind}`);
      await mkdir(externalDir);
      const externalProbe = join(externalDir, "higgsfield.json");
      const externalMonitor = join(externalDir, "gemini-monitor.json");
      await writeFile(externalProbe, JSON.stringify(freshProbe()));
      await writeFile(externalMonitor, JSON.stringify(freshMonitor()));
      const probeLeaf = join(root, "workspace", "provider-probes", "higgsfield.json");
      const monitorLeaf = join(root, "workspace", "gemini-monitor.json");
      if (kind === "hardlink") {
        await link(externalProbe, probeLeaf);
        await link(externalMonitor, monitorLeaf);
      } else {
        await symlink(externalProbe, probeLeaf);
        await symlink(externalMonitor, monitorLeaf);
      }
      const beforeProbe = await mutationSnapshot(externalProbe);
      const beforeMonitor = await mutationSnapshot(externalMonitor);

      const result = await buildProviderReadiness({ root, env: {}, now: NOW });

      expect(result.providers.higgsfield.status).toBe("NOT_CONNECTED");
      expect(result.providers.gemini.status).toBe("NOT_CONNECTED");
      expect(await mutationSnapshot(externalProbe)).toEqual(beforeProbe);
      expect(await mutationSnapshot(externalMonitor)).toEqual(beforeMonitor);
    }
  });

  test("rejects oversized, non-UTF-8, and aliased probe ancestry as disconnected evidence", async () => {
    const { root } = await fixtureRoot();
    const probeRoot = join(root, "workspace", "provider-probes");
    const higgsfieldPath = join(probeRoot, "higgsfield.json");
    await writeFile(higgsfieldPath, Buffer.alloc(8 * 1024 + 1, 0x61));
    expect((await buildProviderReadiness({ root, env: {}, now: NOW })).providers.higgsfield.status).toBe("NOT_CONNECTED");
    await writeFile(higgsfieldPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    expect((await buildProviderReadiness({ root, env: {}, now: NOW })).providers.higgsfield.status).toBe("NOT_CONNECTED");

    const externalProbeRoot = join(root, "external-probe-root");
    await mkdir(externalProbeRoot);
    const externalProbe = join(externalProbeRoot, "higgsfield.json");
    await writeFile(externalProbe, JSON.stringify(freshProbe()));
    await rm(probeRoot, { recursive: true });
    await symlink(externalProbeRoot, probeRoot, "dir");
    const before = await mutationSnapshot(externalProbe);
    const result = await buildProviderReadiness({ root, env: {}, now: NOW });
    expect(result.providers.higgsfield.status).toBe("NOT_CONNECTED");
    expect(await mutationSnapshot(externalProbe)).toEqual(before);
  });

  test("does not follow an aliased workspace root for readiness evidence", async () => {
    const { root } = await fixtureRoot();
    const workspace = join(root, "workspace");
    const externalWorkspace = join(root, "external-workspace");
    await mkdir(join(externalWorkspace, "provider-probes"), { recursive: true });
    const externalMonitor = join(externalWorkspace, "gemini-monitor.json");
    const externalProbe = join(externalWorkspace, "provider-probes", "higgsfield.json");
    await writeFile(externalMonitor, JSON.stringify(freshMonitor()));
    await writeFile(externalProbe, JSON.stringify(freshProbe()));
    await rm(workspace, { recursive: true });
    await symlink(externalWorkspace, workspace, "dir");
    const beforeMonitor = await mutationSnapshot(externalMonitor);
    const beforeProbe = await mutationSnapshot(externalProbe);

    const result = await buildProviderReadiness({ root, env: {}, now: NOW });

    expect(result.providers.gemini.status).toBe("NOT_CONNECTED");
    expect(result.providers.higgsfield.status).toBe("NOT_CONNECTED");
    expect(await mutationSnapshot(externalMonitor)).toEqual(beforeMonitor);
    expect(await mutationSnapshot(externalProbe)).toEqual(beforeProbe);
  });

  test("projects a redacted Gemini monitor and fixed receipt locations", async () => {
    const { root } = await fixtureRoot();
    await writeFile(join(root, "workspace", "gemini-monitor.json"), JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-08-12T11:59:30.000Z",
      status: "quota-blocked",
      email: "private@example.com",
      profiles: [{
        id: "account-1",
        observedAt: "2026-08-12T11:59:20.000Z",
        email: "private@example.com",
        profileDir: "/Users/private/chrome-profile",
        authentication: "authenticated",
        headless: true,
        requestedHeadless: true,
        videoMode: true,
        available: false,
        quotaMessage: "No videos"
      }]
    }));
    await writeFile(join(root, "workspace", "provider-probes", "higgsfield.json"), JSON.stringify({
      schemaVersion: 1,
      provider: "higgsfield",
      observedAt: "2026-08-12T11:59:00.000Z",
      status: "blocked",
      blockerCode: "subscription-required"
    }));
    const result = await buildProviderReadiness({ root, env: {}, now: NOW });
    const serialized = JSON.stringify(result);
    expect(result.providers.gemini).toMatchObject({
      status: "BLOCKED",
      operational: { profileCount: 1, freshProfileCount: 1, authenticatedCount: 1, headlessCount: 1, videoModeCount: 1 },
      blockers: [{ code: "quota-exhausted" }]
    });
    expect(result.providers.higgsfield).toMatchObject({ status: "BLOCKED", blockers: [{ code: "subscription-required" }] });
    expect(result.providers.veed.status).toBe("NOT_CONNECTED");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("No videos");
  });

  test("renders status and escapes every blocker field", () => {
    const markup = providerReadinessMarkup({
      providers: {
        bfl: {
          provider: "bfl",
          status: "BLOCKED",
          evidence: "local-configuration-only",
          liveConnectionVerified: false,
          configuration: { bundledAdapterAvailable: true, bundledAdapterSelected: false },
          blockers: [{ code: "<bad>", message: "<img src=x onerror=alert(1)>" }]
        }
      }
    });
    expect(markup).toContain("AVAILABLE · NOT SELECTED");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("NOT CONNECTED");
  });

  test("keeps the readiness endpoint inside the existing authenticated GET boundary", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const rejected = await handler(new Request("http://127.0.0.1:3000/api/providers/readiness"));
    const accepted = await handler(new Request("http://127.0.0.1:3000/api/providers/readiness", {
      headers: { authorization: `Bearer ${token}` }
    }));
    const rejectedPost = await handler(new Request("http://127.0.0.1:3000/api/providers/readiness", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "sec-fetch-site": "same-origin"
      }
    }));
    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).providers).toContainKeys(["gemini", "bfl", "higgsfield", "veed"]);
    expect(rejectedPost.status).toBe(404);
  });
});

describe("Gemini monitor TTL", () => {
  test("derives readiness timestamps from profile observations rather than monitor events", () => {
    const fresh = {
      schemaVersion: 2,
      updatedAt: "2026-08-12T11:59:00.000Z",
      status: "quota-available",
      profiles: [{
        observedAt: "2026-08-12T11:59:30.000Z",
        available: true,
        authentication: "authenticated",
        headless: true,
        requestedHeadless: true,
        videoMode: true
      }]
    };
    expect(geminiMonitorReadiness(fresh, { now: NOW })).toMatchObject({
      status: "READY",
      evidence: "fresh-profile-observation",
      observedAt: "2026-08-12T11:59:30.000Z",
      expiresAt: "2026-08-12T12:14:30.000Z"
    });
    expect(geminiMonitorReadiness({
      ...fresh,
      updatedAt: "2026-08-12T11:59:59.000Z",
      profiles: [{ ...fresh.profiles[0], observedAt: "2026-08-12T10:00:00.000Z" }]
    }, { now: NOW })).toMatchObject({
      status: "STALE",
      evidence: "stale-profile-observation",
      observedAt: "2026-08-12T10:00:00.000Z",
      blockers: [{ code: "profile-observation-stale" }]
    });
    expect(geminiMonitorReadiness({ ...fresh, updatedAt: "invalid" }, { now: NOW }).status).toBe("NOT_CONNECTED");
    expect(geminiMonitorReadiness({ profiles: [] }, { now: NOW }).status).toBe("NOT_CONNECTED");
  });

  test("invalidates an available observation after generation or review supersedes it", () => {
    const profile = {
      observedAt: "2026-08-12T11:59:30.000Z",
      available: true,
      authentication: "authenticated",
      headless: true,
      requestedHeadless: true,
      videoMode: true
    };
    const result = geminiMonitorReadiness({
      schemaVersion: 2,
      updatedAt: "2026-08-12T11:59:55.000Z",
      status: "review-needs-remediation",
      profiles: [profile]
    }, { now: NOW });
    expect(result).toMatchObject({
      status: "BLOCKED",
      evidence: "fresh-profile-observation",
      observedAt: profile.observedAt,
      operational: { freshProfileCount: 1, availableCount: 0 },
      blockers: [{ code: "profile-observation-superseded" }]
    });
    expect(result.observedAt).not.toBe("2026-08-12T11:59:55.000Z");
  });

  test("never reports READY from an unauthenticated, headed, stale, or non-video profile", () => {
    const profile = {
      observedAt: "2026-08-12T11:59:30.000Z",
      available: true,
      authentication: "authenticated",
      headless: true,
      requestedHeadless: true,
      videoMode: true
    };
    const monitor = { schemaVersion: 2, updatedAt: "2026-08-12T11:59:40.000Z", status: "quota-available", profiles: [profile] };
    expect(geminiMonitorReadiness({ ...monitor, profiles: [{ ...profile, authentication: "sign-in-required" }] }, { now: NOW })).toMatchObject({
      status: "BLOCKED",
      blockers: [{ code: "authentication-required" }]
    });
    expect(geminiMonitorReadiness({ ...monitor, profiles: [{ ...profile, headless: false }] }, { now: NOW })).toMatchObject({
      status: "BLOCKED",
      blockers: [{ code: "headless-required" }]
    });
    expect(geminiMonitorReadiness({ ...monitor, profiles: [{ ...profile, videoMode: false }] }, { now: NOW })).toMatchObject({
      status: "BLOCKED",
      blockers: [{ code: "video-mode-unavailable" }]
    });
    expect(geminiMonitorReadiness({ ...monitor, profiles: [{ ...profile, observedAt: "2026-08-12T10:00:00.000Z" }] }, { now: NOW })).toMatchObject({
      status: "STALE",
      blockers: [{ code: "profile-observation-stale" }]
    });
    expect(geminiMonitorReadiness({ ...monitor, profiles: [{ ...profile, observedAt: undefined }] }, { now: NOW })).toMatchObject({
      status: "BLOCKED",
      operational: { freshProfileCount: 0, availableCount: 0 },
      blockers: [{ code: "profile-observation-stale" }]
    });
  });
});
