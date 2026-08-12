import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function canonicalJsonHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

export function canonicalGeminiSessionBinding(job) {
  const cdpUrl = String(job?.geminiCdpUrl || "").trim();
  const profileDir = String(job?.geminiProfileDir || "").trim();
  if (!cdpUrl || !profileDir) return null;
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.port) return null;
  const resolvedProfile = resolve(profileDir);
  return {
    schemaVersion: 1,
    cdpOrigin: parsed.origin,
    profileBasename: basename(resolvedProfile),
    profilePathHash: canonicalJsonHash({ type: "gemini-chrome-profile-path", path: resolvedProfile })
  };
}

export function geminiSessionBindingHash(job) {
  const binding = canonicalGeminiSessionBinding(job);
  return binding ? canonicalJsonHash(binding) : null;
}
