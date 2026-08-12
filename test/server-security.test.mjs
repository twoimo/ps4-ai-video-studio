import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST,
  MAX_UPLOAD_FILES,
  SESSION_COOKIE_NAME,
  authorizeMutationRequest,
  createSessionCookie,
  createSessionToken,
  createStudioRequestHandler,
  isLoopbackHostname,
  persistStudioToken,
  redactGeminiMonitor,
  resolveStudioToken,
  shouldIssueSessionCookie,
  startStudioServer,
  validateRequestContentLength,
  validateUploadBatch
} from "../src/server.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function mutationRequest(url, token, headers = {}) {
  const origin = new URL(url).origin;
  return new Request(url, {
    method: "POST",
    headers: {
      origin,
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "sec-fetch-site": "same-origin",
      ...headers
    }
  });
}

describe("process session tokens", () => {
  test("generates independent 256-bit base64url tokens", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(() => createSessionToken(31)).toThrow("최소 32바이트");
  });

  test("rejects weak explicit bearer secrets", () => {
    expect(() => resolveStudioToken("short-token")).toThrow("최소 32바이트");
    expect(() => resolveStudioToken(` ${"x".repeat(40)}`)).toThrow("공백 없이");
    expect(resolveStudioToken("x".repeat(40))).toBe("x".repeat(40));
  });

  test("persists the CLI bearer token in a mode-0600 runtime file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-security-test-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "runtime", "studio-token");
    const token = createSessionToken();

    await persistStudioToken(token, tokenPath);

    expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "runtime"))).mode & 0o777).toBe(0o700);
  });
});

describe("same-origin mutation authorization", () => {
  test("accepts the HttpOnly session cookie from the exact loopback origin", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://127.0.0.1:3000/api/jobs", token);

    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toEqual({ ok: true, code: "session" });
  });

  test("accepts an exact bearer token but still requires same-origin", () => {
    const token = createSessionToken();
    const request = mutationRequest("http://localhost:3000/api/jobs", token, {
      cookie: "",
      authorization: `Bearer ${token}`
    });
    expect(authorizeMutationRequest(request, new URL(request.url), { token })).toEqual({ ok: true, code: "bearer" });

    const crossOrigin = mutationRequest("http://localhost:3000/api/jobs", token, {
      origin: "https://attacker.example",
      authorization: `Bearer ${token}`
    });
    expect(authorizeMutationRequest(crossOrigin, new URL(crossOrigin.url), { token })).toMatchObject({ ok: false, code: "cross-origin" });
  });

  test("rejects missing Origin, wrong tokens, cross-site metadata, and DNS rebinding hosts", () => {
    const token = createSessionToken();
    const noOrigin = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { origin: "" });
    const wrongToken = mutationRequest("http://127.0.0.1:3000/api/jobs", "z".repeat(43));
    const crossSite = mutationRequest("http://127.0.0.1:3000/api/jobs", token, { "sec-fetch-site": "cross-site" });
    const rebound = mutationRequest("http://attacker.example:3000/api/jobs", token);

    expect(authorizeMutationRequest(noOrigin, new URL(noOrigin.url), { token })).toMatchObject({ ok: false, code: "cross-origin" });
    expect(authorizeMutationRequest(wrongToken, new URL(wrongToken.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    expect(authorizeMutationRequest(crossSite, new URL(crossSite.url), { token })).toMatchObject({ ok: false, code: "cross-site" });
    expect(authorizeMutationRequest(rebound, new URL(rebound.url), { token })).toMatchObject({ ok: false, code: "untrusted-host" });
  });

  test("requires a session for safe API methods and rejects DNS-rebinding hosts", () => {
    const token = createSessionToken();
    const unauthenticated = new Request("http://127.0.0.1:3000/api/health");
    const authenticated = new Request("http://127.0.0.1:3000/api/health", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` }
    });
    const rebound = new Request("http://attacker.example:3000/api/jobs", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authorizeMutationRequest(unauthenticated, new URL(unauthenticated.url), { token })).toMatchObject({ ok: false, code: "invalid-session" });
    expect(authorizeMutationRequest(authenticated, new URL(authenticated.url), { token })).toEqual({ ok: true, code: "safe-session" });
    expect(authorizeMutationRequest(rebound, new URL(rebound.url), { token })).toMatchObject({ ok: false, code: "untrusted-host" });
  });

  test("issues the session only for a top-level loopback UI navigation", () => {
    const token = createSessionToken();
    const navigation = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });
    const subresource = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-origin" }
    });
    const rebound = new Request("http://attacker.example:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });

    expect(shouldIssueSessionCookie(navigation)).toBe(true);
    expect(shouldIssueSessionCookie(subresource)).toBe(false);
    expect(shouldIssueSessionCookie(rebound)).toBe(false);
    expect(createSessionCookie(token)).toContain("HttpOnly; SameSite=Strict");
    expect(createSessionCookie(token)).not.toContain("Domain=");
  });

  test("enforces the gate in the actual Bun request handler while UI bootstrap remains usable", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const navigation = new Request("http://127.0.0.1:3000/", {
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    });
    const uiResponse = await handler(navigation);
    expect(uiResponse.status).toBe(200);
    expect(uiResponse.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(uiResponse.headers.get("set-cookie")).toContain("HttpOnly");

    const rejected = await handler(new Request("http://127.0.0.1:3000/api/not-found", { method: "POST" }));
    expect(rejected.status).toBe(403);

    const accepted = await handler(mutationRequest("http://127.0.0.1:3000/api/not-found", token));
    expect(accepted.status).toBe(404);
  });

  test("binds a real Bun server to the loopback interface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-server-test-"));
    temporaryDirectories.push(directory);
    const token = createSessionToken();
    const server = await startStudioServer({
      hostname: DEFAULT_HOST,
      port: 0,
      token,
      tokenPath: join(directory, "runtime", "studio-token")
    });
    try {
      expect(server.hostname).toBe(DEFAULT_HOST);
      expect(String(server.url)).toStartWith(`http://${DEFAULT_HOST}:`);

      const uiResponse = await fetch(server.url);
      const cookie = uiResponse.headers.get("set-cookie");
      expect(uiResponse.status).toBe(200);
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

      const rejected = await fetch(new URL("/api/not-found", server.url), { method: "POST" });
      expect(rejected.status).toBe(403);

      const rejectedRead = await fetch(new URL("/api/jobs", server.url));
      expect(rejectedRead.status).toBe(403);

      const acceptedRead = await fetch(new URL("/api/jobs", server.url), {
        headers: { cookie: cookie.split(";", 1)[0] }
      });
      expect(acceptedRead.status).toBe(200);

      const accepted = await fetch(new URL("/api/not-found", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: cookie.split(";", 1)[0]
        }
      });
      expect(accepted.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("monitor response redaction", () => {
  test("removes identity, profile paths, body excerpts, and nested email strings without mutating input", () => {
    const source = {
      status: "quota-blocked",
      email: "person@example.com",
      nextEmail: "next@example.com",
      profileDir: "/Users/private/.ps4/chrome-profile",
      bodyExcerpt: "secret page text",
      profiles: [{
        id: "account-1",
        email: "nested@example.com",
        profilePath: "C:\\Users\\private\\chrome-profile",
        bodyExcerpt: "another secret",
        quotaMessage: "Contact nested@example.com after reset",
        diagnostic: "using /tmp/private/chrome-profile for this run"
      }],
      quota: { account: "Google Account person@example.com", available: false }
    };

    const redacted = redactGeminiMonitor(source);
    const serialized = JSON.stringify(redacted);

    expect(redacted.status).toBe("quota-blocked");
    expect(redacted.profiles[0].id).toBe("account-1");
    expect(redacted.profiles[0].quotaMessage).toBe("Contact [redacted-email] after reset");
    expect(redacted.profiles[0].diagnostic).toBe("using [redacted-profile-path] for this run");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("nested@example.com");
    expect(serialized).not.toContain("chrome-profile");
    expect(serialized).not.toContain("secret page text");
    expect(source.email).toBe("person@example.com");
  });

  test("applies redaction on the real monitor API response", async () => {
    const token = createSessionToken();
    const handler = createStudioRequestHandler({ token });
    const response = await handler(new Request("http://127.0.0.1:3000/api/gemini/monitor", {
      headers: { authorization: `Bearer ${token}` }
    }));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toContain('"profileDir"');
    expect(serialized).not.toContain('"bodyExcerpt"');
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });
});

describe("upload resource limits", () => {
  test("enforces file count, per-file bytes, and aggregate bytes", () => {
    expect(validateUploadBatch([{ size: 40 }, { size: 60 }], {
      maxFiles: 2,
      maxFileBytes: 80,
      maxTotalBytes: 100
    })).toEqual({ count: 2, totalBytes: 100 });

    expect(() => validateUploadBatch(Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => ({ size: 1 })))).toThrow("최대");
    expect(() => validateUploadBatch([{ size: 81 }], { maxFiles: 2, maxFileBytes: 80, maxTotalBytes: 100 })).toThrow("하나의 최대");
    expect(() => validateUploadBatch([{ size: 60 }, { size: 41 }], { maxFiles: 2, maxFileBytes: 80, maxTotalBytes: 100 })).toThrow("전체 크기");
  });

  test("rejects oversized or malformed Content-Length before multipart parsing", () => {
    const oversized = new Request("http://127.0.0.1:3000/upload", { headers: { "content-length": "101" } });
    const malformed = new Request("http://127.0.0.1:3000/upload", { headers: { "content-length": "1e3" } });

    expect(() => validateRequestContentLength(oversized, 100)).toThrow("허용 크기");
    expect(() => validateRequestContentLength(malformed, 100)).toThrow("올바르지");
  });
});

describe("loopback host boundary", () => {
  test("recognizes loopback names and rejects lookalikes", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.99.4.2")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });
});
