import { describe, expect, test } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { lookup as dnsLookup, Resolver as DnsResolver, setServers as dnsSetServers } from "node:dns";
import { lookup as dnsLookupPromise, Resolver as DnsPromiseResolver, setServers as dnsPromiseSetServers } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { captureSource, JOBS_DIR, ROOT, WORKSPACE_DIR } from "../src/pipeline.mjs";
import { STUDIO_TOKEN_PATH } from "../src/server.mjs";
import { HERMETIC_NETWORK_ERROR, HERMETIC_PRELOAD_FLAG, isLoopbackHostname } from "./setup-hermetic.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function blocked(action, api) {
  let error = null;
  try {
    action();
  } catch (value) {
    error = value;
  }
  expect(error).toMatchObject({ code: HERMETIC_NETWORK_ERROR });
  expect(error.message).toContain(api);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function pathIdentity(path) {
  const value = await lstat(path, { bigint: true }).catch(() => null);
  return value ? {
    dev: String(value.dev),
    ino: String(value.ino),
    mode: String(value.mode),
    nlink: String(value.nlink),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs)
  } : null;
}

describe("hermetic test workspace", () => {
  test("loads every pipeline fixture under the preloaded temporary project root", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env[HERMETIC_PRELOAD_FLAG]).toBe("1");
    expect(process.env.BUN_OPTIONS).toContain(`--preload=${new URL("./setup-hermetic.mjs", import.meta.url).href}`);
    expect(ROOT).toBe(repositoryRoot);
    expect(WORKSPACE_DIR).toBe(resolve(process.env.PS4_WORKSPACE_DIR));
    expect(WORKSPACE_DIR).not.toBe(resolve(ROOT, "workspace"));
    expect(realpathSync(resolve(WORKSPACE_DIR, ".."))).not.toBe(ROOT);
    expect(JOBS_DIR).toBe(resolve(WORKSPACE_DIR, "jobs"));
    expect(STUDIO_TOKEN_PATH).toBe(resolve(WORKSPACE_DIR, ".runtime", "studio-token"));
  });

  test("rejects project-root overrides outside the test runtime", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", `await import(${JSON.stringify(new URL("../src/pipeline.mjs", import.meta.url).href)});`],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PS4_WORKSPACE_DIR: WORKSPACE_DIR
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("PS4_WORKSPACE_DIR override");
  });

  test("rejects non-loopback network APIs before they can open a socket", () => {
    const publicHttp = "http://203.0.113.10:80/blocked";
    const publicHttps = "https://198.51.100.20/blocked";
    blocked(() => fetch(publicHttps), "fetch");
    blocked(() => fetch("http://127.0.0.1:1/blocked-proxy", { proxy: publicHttp }), "fetch proxy");
    blocked(() => fetch("http://127.0.0.1:1/blocked-proxy", { proxy: "not-an-absolute-proxy" }), "fetch proxy");
    blocked(() => new WebSocket("wss://example.test/socket"), "WebSocket");
    blocked(() => new WebSocket("ws://127.0.0.1:1/socket", { proxy: publicHttp }), "WebSocket proxy");
    blocked(() => Bun.connect({ hostname: "192.0.2.30", port: 443, socket: {} }), "Bun.connect");
    blocked(() => netConnect({ host: "203.0.113.10", port: 80 }), "net.connect");
    blocked(() => netConnect({ host: "203.0.113.10", port: 80, lookup: () => "127.0.0.1" }), "net.connect");
    blocked(() => tlsConnect({ host: "198.51.100.20", port: 443 }), "tls.connect");
    blocked(() => httpRequest(publicHttp), "http.request");
    blocked(() => new HttpAgent().createConnection({ host: "203.0.113.10", port: 80 }), "http.Agent.createConnection");
    blocked(() => httpsRequest(publicHttps), "https.request");
    blocked(() => http2Connect(publicHttps), "http2.connect");
    blocked(() => dnsLookup("example.test", () => {}), "dns.lookup");
    blocked(() => dnsLookupPromise("example.test"), "dns.promises.lookup");
    blocked(() => Bun.dns.lookup("example.test"), "Bun.dns.lookup");
    blocked(() => dnsSetServers(["203.0.113.53"]), "dns.setServers");
    blocked(() => dnsPromiseSetServers(["[2001:db8::53]:53"]), "dns.promises.setServers");
    blocked(() => new DnsResolver().resolve4("example.test", () => {}), "dns.Resolver.resolve4");
    blocked(() => new DnsPromiseResolver().resolve4("example.test"), "dns.promises.Resolver.resolve4");
  });

  test("allows loopback HTTP and injected in-process source mocks", async () => {
    expect([
      "localhost",
      "127.0.0.1",
      "127.255.255.254",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1"
    ].every(isLoopbackHostname)).toBe(true);
    expect(["0.0.0.0", "192.0.2.1", "::", "example.test"].some(isLoopbackHostname)).toBe(false);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("loopback-ok")
    });
    try {
      const response = await fetch(server.url);
      expect(await response.text()).toBe("loopback-ok");
      await new Promise((resolveConnection, rejectConnection) => {
        const socket = netConnect({
          host: "localhost",
          port: server.port,
          lookup(_hostname, options, callback) {
            if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          }
        });
        socket.once("connect", () => {
          socket.destroy();
          resolveConnection();
        });
        socket.once("error", rejectConnection);
      });
      const rejectedLookup = await new Promise((resolveError) => {
        const socket = netConnect({
          host: "localhost",
          port: server.port,
          lookup(_hostname, options, callback) {
            if (options?.all) callback(null, [{ address: "203.0.113.10", family: 4 }]);
            else callback(null, "203.0.113.10", 4);
          }
        });
        socket.once("error", resolveError);
      });
      expect(rejectedLookup).toMatchObject({ code: HERMETIC_NETWORK_ERROR });
      expect(rejectedLookup.message).toContain("lookup result");
      const nodeHttpBody = await new Promise((resolveBody, rejectBody) => {
        const request = httpRequest(server.url, async (nodeResponse) => {
          try {
            resolveBody(await new Response(nodeResponse).text());
          } catch (error) {
            rejectBody(error);
          }
        });
        request.once("error", rejectBody);
        request.end();
      });
      expect(nodeHttpBody).toBe("loopback-ok");
    } finally {
      server.stop(true);
    }

    const body = Buffer.from("공식 자료의 검증 가능한 문장입니다.");
    let lookupCalls = 0;
    let requestCalls = 0;
    const captured = await captureSource({ title: "공식 자료", url: "https://fixture.example/article" }, "검증", {
      lookupFn: async () => {
        lookupCalls += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      requestSourceFn: async () => {
        requestCalls += 1;
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          bytes: body,
          byteLength: body.byteLength
        };
      }
    });
    expect({ lookupCalls, requestCalls, status: captured.fetchStatus }).toEqual({
      lookupCalls: 1,
      requestCalls: 1,
      status: "fetched"
    });
  });

  test("propagates the preload into Bun children without overriding explicit runtime mode", () => {
    const childSource = `
      if (process.env.NODE_ENV !== "production") process.exit(90);
      if (process.env.${HERMETIC_PRELOAD_FLAG} !== "1") process.exit(91);
      try {
        fetch("https://203.0.113.10/blocked");
        process.exit(92);
      } catch (error) {
        if (error?.code !== ${JSON.stringify(HERMETIC_NETWORK_ERROR)}) process.exit(93);
      }
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", childSource],
      cwd: resolve(WORKSPACE_DIR, ".."),
      env: { NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);

    const nodeChild = nodeSpawnSync(process.execPath, ["-e", childSource], {
      cwd: resolve(WORKSPACE_DIR, ".."),
      env: { NODE_ENV: "production" },
      encoding: "utf8"
    });
    expect(nodeChild.status, nodeChild.stderr).toBe(0);
  });

  test("inherits the temporary workspace through partial Bun child environments", async () => {
    const liveWorkspace = resolve(repositoryRoot, "workspace");
    const liveBefore = await pathIdentity(liveWorkspace);
    const pipelineUrl = new URL("../src/pipeline.mjs", import.meta.url).href;
    const markers = [];
    try {
      for (const [index, env] of [{}, { NODE_ENV: "test" }].entries()) {
        const marker = join(WORKSPACE_DIR, `partial-child-env-${index}.txt`);
        markers.push(marker);
        const childSource = `
          import { mkdir, writeFile } from "node:fs/promises";
          import { dirname } from "node:path";
          const pipeline = await import(${JSON.stringify(pipelineUrl)});
          const expected = ${JSON.stringify(WORKSPACE_DIR)};
          const live = ${JSON.stringify(liveWorkspace)};
          if (pipeline.WORKSPACE_DIR !== expected || pipeline.WORKSPACE_DIR === live) process.exit(94);
          if (process.env.PS4_WORKSPACE_DIR !== expected || process.env.NODE_ENV !== "test") process.exit(95);
          const marker = ${JSON.stringify(marker)};
          await mkdir(dirname(marker), { recursive: true });
          await writeFile(marker, "temporary-child-only", { flag: "wx" });
          process.stdout.write(JSON.stringify({ workspace: pipeline.WORKSPACE_DIR, nodeEnv: process.env.NODE_ENV }));
        `;
        const child = Bun.spawnSync({
          cmd: [process.execPath, "-e", childSource],
          cwd: resolve(WORKSPACE_DIR, ".."),
          env,
          stdout: "pipe",
          stderr: "pipe"
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        expect(JSON.parse(child.stdout.toString())).toEqual({ workspace: WORKSPACE_DIR, nodeEnv: "test" });
        expect(await readFile(marker, "utf8")).toBe("temporary-child-only");
      }
      expect(await pathIdentity(liveWorkspace)).toEqual(liveBefore);
    } finally {
      await Promise.all(markers.map((path) => rm(path, { force: true })));
    }
  });

  test("rejects a shell grandchild workspace override during preload before source import", async () => {
    const liveWorkspace = resolve(repositoryRoot, "workspace");
    const liveBefore = await pathIdentity(liveWorkspace);
    const marker = join(liveWorkspace, `.hermetic-grandchild-escape-${process.pid}.txt`);
    await rm(marker, { force: true });
    const pipelineUrl = new URL("../src/pipeline.mjs", import.meta.url).href;
    const childSource = `
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(marker)}, "unsafe-live-workspace-write");
      await import(${JSON.stringify(pipelineUrl)});
      process.exit(96);
    `;
    try {
      const child = Bun.spawnSync([
        "env",
        `PS4_WORKSPACE_DIR=${liveWorkspace}`,
        process.execPath,
        "-e",
        childSource
      ], {
        cwd: repositoryRoot,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe"
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("ERR_PS4_TEST_WORKSPACE_UNSAFE");
      expect(await pathIdentity(marker)).toBeNull();
      expect(await pathIdentity(liveWorkspace)).toEqual(liveBefore);
    } finally {
      await rm(marker, { force: true });
    }
  });

  test("keeps unpatchable Bun.fetch and external network tools out of test-loaded sources", async () => {
    const files = (await Promise.all(["src", "scripts", "test", "tests"].map((directory) => sourceFiles(resolve(repositoryRoot, directory))))).flat();
    const directBunFetch = [
      new RegExp(`\\b${"Bun"}\\s*\\.\\s*${"fetch"}\\b`, "u"),
      new RegExp(`\\b${"Bun"}\\s*\\[\\s*[\"']${"fetch"}[\"']\\s*\\]`, "u"),
      new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${"fetch"}\\b[^}]*\\}\\s*=\\s*${"Bun"}\\b`, "u")
    ];
    const externalTool = /(?:^|[^A-Za-z0-9_])(?:curl|wget|nc|ncat|socat|ssh|scp)(?=$|[^A-Za-z0-9_])/u;
    const violations = [];
    for (const path of files) {
      if (path === resolve(import.meta.filename) || path === resolve(import.meta.dirname, "setup-hermetic.mjs")) continue;
      const source = await readFile(path, "utf8");
      if (directBunFetch.some((pattern) => pattern.test(source))) violations.push(`${path}: Bun.fetch`);
      if (path.includes(`${resolve(repositoryRoot, "test")}/`) || path.includes(`${resolve(repositoryRoot, "tests")}/`)) {
        if (externalTool.test(source)) violations.push(`${path}: external network command`);
      }
    }
    expect(violations).toEqual([]);
  });
});
