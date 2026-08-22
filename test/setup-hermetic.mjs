import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as childProcessModule from "node:child_process";
import { mock } from "bun:test";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { isIP } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import tls from "node:tls";

// Test-only defense in depth. It rejects non-loopback network APIs before
// socket creation and propagates itself into Bun children. Bun.fetch is a
// non-configurable runtime primitive, so the companion test forbids its use;
// CI additionally executes the suite in an isolated network namespace.
const HERMETIC_NETWORK_ERROR = "ERR_PS4_TEST_NETWORK_BLOCKED";
const HERMETIC_WORKSPACE_ERROR = "ERR_PS4_TEST_WORKSPACE_UNSAFE";
const HERMETIC_PRELOAD_FLAG = "PS4_HERMETIC_PRELOAD_ACTIVE";
const HERMETIC_LOOKUP_WRAPPER = Symbol("ps4-hermetic-lookup-wrapper");
const inheritedHermeticPreload = process.env[HERMETIC_PRELOAD_FLAG] === "1";
const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
const originalBunConnect = Bun.connect;
const originalBunSpawn = Bun.spawn;
const originalBunSpawnSync = Bun.spawnSync;
const originalBunDns = Object.fromEntries(Object.entries(Bun.dns).filter(([, value]) => typeof value === "function"));
const originalNetConnect = net.connect;
const originalNetCreateConnection = net.createConnection;
const originalSocketConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;
const originalHttp2Connect = http2.connect;
const originalHttpAgentCreateConnection = http.Agent.prototype.createConnection;
const originalDns = Object.fromEntries(Object.entries(dns).filter(([, value]) => typeof value === "function"));
const originalDnsPromises = Object.fromEntries(Object.entries(dnsPromises).filter(([, value]) => typeof value === "function"));
const originalChildProcess = Object.fromEntries(Object.entries(childProcessModule.default || childProcessModule).filter(([, value]) => typeof value === "function"));
const repositoryRoot = resolve(import.meta.dirname, "..");

function validatedHermeticWorkspace(value) {
  const workspace = String(value || "").trim();
  const resolvedWorkspace = workspace ? resolve(workspace) : "";
  const workspaceRelative = resolvedWorkspace ? relative(repositoryRoot, resolvedWorkspace) : "";
  if (
    !resolvedWorkspace
    || workspaceRelative === ""
    || (workspaceRelative !== ".." && !workspaceRelative.startsWith(`..${sep}`))
  ) {
    const error = new Error("Hermetic test child requires a workspace outside the repository.");
    error.code = HERMETIC_WORKSPACE_ERROR;
    throw error;
  }
  return resolvedWorkspace;
}

const testProjectRoot = inheritedHermeticPreload
  ? null
  : realpathSync(mkdtempSync(join(tmpdir(), "ps4-ai-video-studio-test-")));

if (!inheritedHermeticPreload) {
  process.env.NODE_ENV = "test";
  process.env.PS4_WORKSPACE_DIR = join(testProjectRoot, "workspace");
}
process.env.PS4_WORKSPACE_DIR = validatedHermeticWorkspace(process.env.PS4_WORKSPACE_DIR);
process.env[HERMETIC_PRELOAD_FLAG] = "1";
for (const name of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "http_proxy", "https_proxy"]) {
  delete process.env[name];
}

function networkBlocked(target, api) {
  const error = new Error(`Hermetic test blocked ${api}: ${String(target ?? "unknown target")}`);
  error.code = HERMETIC_NETWORK_ERROR;
  error.target = String(target ?? "unknown target");
  return error;
}

function normalizeHostname(hostname) {
  const value = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (value === "localhost") return "localhost";
  const zoneIndex = value.indexOf("%");
  return zoneIndex === -1 ? value : value.slice(0, zoneIndex);
}

function isLoopbackHostname(hostname) {
  const value = normalizeHostname(hostname);
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const mappedIpv4 = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1];
  if (mappedIpv4) return isLoopbackHostname(mappedIpv4);
  if (isIP(value) === 4) {
    const first = Number.parseInt(value.split(".")[0], 10);
    return first === 127;
  }
  return false;
}

function assertLoopback(hostname, api) {
  if (!isLoopbackHostname(hostname)) throw networkBlocked(hostname, api);
}

function assertLoopbackProxy(options, api) {
  if (!options || typeof options !== "object" || options.proxy == null) return;
  let proxy;
  try {
    proxy = new URL(options.proxy instanceof URL ? options.proxy.href : String(options.proxy));
  } catch {
    throw networkBlocked("invalid proxy", `${api} proxy`);
  }
  if (!proxy.hostname || !["http:", "https:"].includes(proxy.protocol)) {
    throw networkBlocked("unsupported proxy", `${api} proxy`);
  }
  assertLoopback(proxy.hostname, `${api} proxy`);
}

function urlHostname(input, defaultProtocol = "http:") {
  const value = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input ?? "");
  const parsed = new URL(value, `${defaultProtocol}//localhost`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  return parsed.hostname;
}

function socketHostname(args) {
  if (Array.isArray(args[0])) return socketHostname(args[0]);
  if (typeof args[0] === "object" && args[0] !== null) {
    const options = args[0];
    if (options.path || options.socketPath || options.unix) return null;
    return options.hostname ?? options.host ?? "localhost";
  }
  if (typeof args[0] === "string" && !/^\d+$/u.test(args[0])) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

function requestHostname(args, defaultProtocol) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return urlHostname(first, defaultProtocol);
  if (!first || typeof first !== "object") return "localhost";
  if (first.socketPath) return null;
  if (first.href) return urlHostname(first.href, defaultProtocol);
  return first.hostname ?? first.host ?? "localhost";
}

function bunConnectHostname(options) {
  if (!options || typeof options !== "object") return undefined;
  if (options.unix || options.path || options.socketPath) return null;
  return options.hostname ?? options.host ?? "localhost";
}

function guardedLookup(lookup, api) {
  if (lookup?.[HERMETIC_LOOKUP_WRAPPER]) return lookup;
  const wrapped = function hermeticLookup(hostname, options, callback) {
    const callbackIndex = typeof options === "function" ? 1 : 2;
    const originalCallback = arguments[callbackIndex];
    if (typeof originalCallback !== "function") throw networkBlocked("invalid callback", `${api} lookup`);
    const args = [...arguments];
    args[callbackIndex] = function hermeticLookupResult(error, address, family) {
      if (error) return Reflect.apply(originalCallback, this, arguments);
      try {
        const addresses = Array.isArray(address) ? address.map((entry) => entry?.address) : [address?.address || address];
        if (addresses.length === 0 || addresses.some((value) => !value)) throw networkBlocked("empty result", `${api} lookup`);
        for (const value of addresses) assertLoopback(value, `${api} lookup result`);
      } catch (lookupError) {
        return Reflect.apply(originalCallback, this, [lookupError]);
      }
      return Reflect.apply(originalCallback, this, arguments);
    };
    return Reflect.apply(lookup, this, args);
  };
  Object.defineProperty(wrapped, HERMETIC_LOOKUP_WRAPPER, { value: true });
  return wrapped;
}

function guardedSocketArgs(args, api) {
  const next = [...args];
  if (Array.isArray(next[0])) {
    const original = next[0];
    const guarded = guardedSocketArgs(original, api);
    for (const key of Object.getOwnPropertySymbols(original)) {
      Object.defineProperty(guarded, key, Object.getOwnPropertyDescriptor(original, key));
    }
    next[0] = guarded;
  }
  else if (next[0] && typeof next[0] === "object" && typeof next[0].lookup === "function") {
    next[0] = { ...next[0], lookup: guardedLookup(next[0].lookup, api) };
  }
  return next;
}

globalThis.fetch = function hermeticFetch(input, init) {
  const hostname = urlHostname(input);
  if (hostname !== null) assertLoopback(hostname, "fetch");
  assertLoopbackProxy(init, "fetch");
  return Reflect.apply(originalFetch, this, [input, init]);
};

globalThis.WebSocket = class HermeticWebSocket extends OriginalWebSocket {
  constructor(url, protocols) {
    const hostname = urlHostname(url, "ws:");
    if (hostname !== null) assertLoopback(hostname, "WebSocket");
    assertLoopbackProxy(protocols, "WebSocket");
    if (protocols === undefined) super(url);
    else super(url, protocols);
  }
};

Bun.connect = function hermeticBunConnect(options) {
  const hostname = bunConnectHostname(options);
  if (hostname !== null) assertLoopback(hostname, "Bun.connect");
  return Reflect.apply(originalBunConnect, this, arguments);
};

function guardedSocketConnect(original, api) {
  return function hermeticSocketConnect(...args) {
    const hostname = socketHostname(args);
    if (hostname !== null) assertLoopback(hostname, api);
    return Reflect.apply(original, this, guardedSocketArgs(args, api));
  };
}

net.connect = guardedSocketConnect(originalNetConnect, "net.connect");
net.createConnection = guardedSocketConnect(originalNetCreateConnection, "net.createConnection");
net.Socket.prototype.connect = guardedSocketConnect(originalSocketConnect, "net.Socket.connect");
tls.connect = guardedSocketConnect(originalTlsConnect, "tls.connect");
http.Agent.prototype.createConnection = guardedSocketConnect(originalHttpAgentCreateConnection, "http.Agent.createConnection");

function guardedRequest(original, api, defaultProtocol) {
  return function hermeticRequest(...args) {
    const hostname = requestHostname(args, defaultProtocol);
    if (hostname !== null) assertLoopback(hostname, api);
    const options = args[0] && typeof args[0] === "object" && !(args[0] instanceof URL) ? args[0] : args[1];
    if (options && typeof options === "object") {
      if (typeof options.createConnection === "function") throw networkBlocked("custom connection", `${api} connection override`);
      const allowedAgent = defaultProtocol === "https:" ? https.globalAgent : http.globalAgent;
      if (options.agent && options.agent !== allowedAgent) throw networkBlocked("custom agent", `${api} agent override`);
      const index = options === args[0] ? 0 : 1;
      args[index] = { ...options, ...(typeof options.lookup === "function" ? { lookup: guardedLookup(options.lookup, api) } : {}) };
    }
    return Reflect.apply(original, this, args);
  };
}

http.request = guardedRequest(originalHttpRequest, "http.request", "http:");
http.get = guardedRequest(originalHttpGet, "http.get", "http:");
https.request = guardedRequest(originalHttpsRequest, "https.request", "https:");
https.get = guardedRequest(originalHttpsGet, "https.get", "https:");
http2.connect = function hermeticHttp2Connect(authority, ...args) {
  const hostname = urlHostname(authority, "https:");
  if (hostname !== null) assertLoopback(hostname, "http2.connect");
  if (args[0] && typeof args[0] === "object" && (typeof args[0].createConnection === "function" || typeof args[0].lookup === "function")) {
    throw networkBlocked("custom connection", "http2.connect override");
  }
  return Reflect.apply(originalHttp2Connect, this, [authority, ...args]);
};

function dnsHostname(name, args) {
  if (name === "lookupService") return args[0];
  if (name === "reverse") return args[0];
  return args[0];
}

function dnsServerHostname(server) {
  const value = String(server ?? "").trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(value)?.[1];
  if (bracketed) return bracketed;
  if (isIP(value)) return value;
  const ipv4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/u.exec(value)?.[1];
  return ipv4WithPort || value;
}

function assertLoopbackDnsServers(servers, api) {
  if (!Array.isArray(servers)) return;
  for (const server of servers) assertLoopback(dnsServerHostname(server), api);
}

for (const name of Object.keys(originalDns)) {
  if (!["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse", "lookupService"].includes(name)) continue;
  dns[name] = function hermeticDns(...args) {
    assertLoopback(dnsHostname(name, args), `dns.${name}`);
    return Reflect.apply(originalDns[name], this, args);
  };
}

for (const name of Object.keys(originalDnsPromises)) {
  if (!["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse", "lookupService"].includes(name)) continue;
  dnsPromises[name] = function hermeticDnsPromise(...args) {
    assertLoopback(dnsHostname(name, args), `dns.promises.${name}`);
    return Reflect.apply(originalDnsPromises[name], this, args);
  };
}

for (const [module, original, api] of [
  [dns, originalDns.setServers, "dns.setServers"],
  [dnsPromises, originalDnsPromises.setServers, "dns.promises.setServers"]
]) {
  module.setServers = function hermeticDnsServers(servers) {
    assertLoopbackDnsServers(servers, api);
    return Reflect.apply(original, this, arguments);
  };
}

function guardResolver(Resolver, api) {
  const prototype = Object.getPrototypeOf(new Resolver());
  for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
    const original = prototype[name];
    if (typeof original !== "function") continue;
    prototype[name] = function hermeticResolver(hostname) {
      assertLoopback(hostname, `${api}.${name}`);
      return Reflect.apply(original, this, arguments);
    };
  }
  const originalSetServers = prototype.setServers;
  if (typeof originalSetServers === "function") {
    prototype.setServers = function hermeticResolverServers(servers) {
      assertLoopbackDnsServers(servers, `${api}.setServers`);
      return Reflect.apply(originalSetServers, this, arguments);
    };
  }
}

guardResolver(dns.Resolver, "dns.Resolver");
guardResolver(dnsPromises.Resolver, "dns.promises.Resolver");

for (const name of Object.keys(originalBunDns)) {
  if (name === "getServers" || name === "getCacheStats") continue;
  Bun.dns[name] = function hermeticBunDns(hostname) {
    assertLoopback(hostname, `Bun.dns.${name}`);
    return Reflect.apply(originalBunDns[name], this, arguments);
  };
}

function mockBuiltin(specifier, moduleDefault, replacements = {}) {
  mock.module(specifier, () => ({ ...moduleDefault, ...replacements, default: moduleDefault }));
}

mockBuiltin("node:net", net, { connect: net.connect, createConnection: net.createConnection });
mockBuiltin("node:tls", tls, { connect: tls.connect });
mockBuiltin("node:http", http, { request: http.request, get: http.get });
mockBuiltin("node:https", https, { request: https.request, get: https.get });
mockBuiltin("node:http2", http2, { connect: http2.connect });
mockBuiltin("node:dns", dns);
mockBuiltin("node:dns/promises", dnsPromises);

function withHermeticBunOptions(env) {
  const next = { ...process.env, ...(env || {}) };
  next.PS4_WORKSPACE_DIR = validatedHermeticWorkspace(next.PS4_WORKSPACE_DIR || process.env.PS4_WORKSPACE_DIR);
  if (!String(next.NODE_ENV || "").trim()) next.NODE_ENV = process.env.NODE_ENV || "test";
  for (const name of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "http_proxy", "https_proxy"]) {
    delete next[name];
  }
  const preload = `--preload=${import.meta.url}`;
  const values = String(next.BUN_OPTIONS || "").split(/\s+/u).filter(Boolean);
  if (!values.includes(preload)) values.push(preload);
  next.BUN_OPTIONS = values.join(" ");
  next[HERMETIC_PRELOAD_FLAG] = "1";
  return next;
}

process.env.BUN_OPTIONS = withHermeticBunOptions(process.env).BUN_OPTIONS;

function withHermeticChildOptions(args, optionsIndex) {
  const next = [...args];
  const options = next[optionsIndex];
  if (typeof options === "function") return next;
  next[optionsIndex] = { ...(options || {}), env: withHermeticBunOptions(options?.env) };
  return next;
}

const mutableChildProcess = childProcessModule.default || childProcessModule;
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  mutableChildProcess[name] = function hermeticChildProcess(...args) {
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
    return Reflect.apply(originalChildProcess[name], this, withHermeticChildOptions(args, optionsIndex));
  };
}
for (const name of ["exec", "execSync"]) {
  mutableChildProcess[name] = function hermeticChildProcessShell(...args) {
    return Reflect.apply(originalChildProcess[name], this, withHermeticChildOptions(args, 1));
  };
}
mockBuiltin("node:child_process", mutableChildProcess);

function normalizedBunSpawnArgs(args) {
  if (Array.isArray(args[0]) || typeof args[0] === "string") {
    const options = args[1] || {};
    return [args[0], { ...options, env: withHermeticBunOptions(options.env) }];
  }
  const options = args[0] || {};
  return [{ ...options, env: withHermeticBunOptions(options.env) }];
}

Bun.spawn = function hermeticBunSpawn(...args) {
  return Reflect.apply(originalBunSpawn, this, normalizedBunSpawnArgs(args));
};

Bun.spawnSync = function hermeticBunSpawnSync(...args) {
  return Reflect.apply(originalBunSpawnSync, this, normalizedBunSpawnArgs(args));
};

export { HERMETIC_NETWORK_ERROR, HERMETIC_PRELOAD_FLAG, isLoopbackHostname };

process.on("exit", () => {
  if (testProjectRoot) rmSync(testProjectRoot, { recursive: true, force: true });
});
