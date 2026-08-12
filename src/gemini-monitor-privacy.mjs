import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_MONITOR_KEYS = new Set([
  "account",
  "accountname",
  "bodyexcerpt",
    "displayname",
    "email",
    "identity",
    "nextemail",
  "profiledir",
  "profilepath",
  "userdata",
  "userdatadir"
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveMonitorKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_MONITOR_KEYS.has(normalized)
    || normalized.includes("bodyexcerpt")
    || normalized.includes("email")
    || (normalized.includes("profile") && /(?:dir|directory|path)$/.test(normalized));
}

export function sanitizeGeminiMonitorString(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:file:\/\/)?\/[^\s"'<>]*(?:profile|user-data-dir)[^\s"'<>]*/gi, "[redacted-profile-path]")
    .replace(/[A-Z]:\\Users\\[^\s"'<>]*(?:profile|user-data-dir)[^\s"'<>]*/gi, "[redacted-profile-path]")
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s"'<>/]+(?=\/)/gi, "/[redacted-user]")
    .replace(/[A-Z]:\\Users\\[^\\\s"'<>]+/gi, "C:\\Users\\[redacted-user]");
}

function safeOperationalError(value) {
  const firstLine = sanitizeGeminiMonitorString(value).split(/\r?\n/, 1)[0].trim();
  return firstLine ? firstLine.slice(0, 500) : null;
}

/**
 * Returns a deep, non-mutating public/persistable monitor view.
 *
 * Profile directories, account identity, page excerpts and raw error text are
 * deliberately omitted. Strings in otherwise safe fields are also scrubbed so
 * an email or profile path cannot escape through a diagnostic message.
 */
export function redactGeminiMonitor(value) {
  if (Array.isArray(value)) return value.map((item) => redactGeminiMonitor(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
      isSensitiveMonitorKey(key)
        ? []
        : [
            [key, ["error", "lasterror"].includes(normalizedKey(key)) && typeof entry === "string"
              ? safeOperationalError(entry)
              : redactGeminiMonitor(entry)]
          ]
    )));
  }
  return typeof value === "string" ? sanitizeGeminiMonitorString(value) : value;
}

async function ensurePrivateParent(filePath) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
}

export async function readRedactedGeminiMonitorState(filePath) {
  const raw = await readIfPresent(filePath);
  if (raw == null) return null;
  try {
    return redactGeminiMonitor(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writePrivateJson(filePath, value) {
  await ensurePrivateParent(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(redactGeminiMonitor(value), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function persistGeminiMonitorEvent({
  statePath,
  logPath,
  state,
  event,
  details = {},
  now = new Date(),
  logger = console.log
}) {
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  const safeDetails = redactGeminiMonitor(details);
  const diskState = await readRedactedGeminiMonitorState(statePath);
  const memoryState = redactGeminiMonitor(state);
  const nextState = diskState && typeof diskState === "object"
    ? { ...memoryState, ...diskState, ...safeDetails, updatedAt }
    : { ...memoryState, ...safeDetails, updatedAt };
  const record = {
    schemaVersion: 2,
    ...safeDetails,
    event: sanitizeGeminiMonitorString(event),
    at: updatedAt
  };

  await writePrivateJson(statePath, nextState);
  await ensurePrivateParent(logPath);
  await appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(logPath, 0o600);
  logger?.(JSON.stringify({ event: record.event, ...safeDetails }));
  return nextState;
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function replacePrivateText(filePath, text) {
  await ensurePrivateParent(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function privacyParseFailure(line) {
  return {
    schemaVersion: 2,
    event: "privacy_redaction_parse_failure",
    originalSha256: `sha256:${createHash("sha256").update(line).digest("hex")}`
  };
}

/**
 * One-way migration for monitor artifacts produced by earlier builds.
 * Malformed JSONL records are replaced by a hash-only marker rather than
 * retaining potentially sensitive source text.
 */
export async function scrubGeminiMonitorArtifacts({ statePath, logPath, signalPath } = {}) {
  const scrubbed = [];
  for (const filePath of [statePath, signalPath].filter(Boolean)) {
    const raw = await readIfPresent(filePath);
    if (raw == null) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = privacyParseFailure(raw);
    }
    await writePrivateJson(filePath, value);
    scrubbed.push(filePath);
  }

  if (logPath) {
    const raw = await readIfPresent(logPath);
    if (raw != null) {
      const records = raw.split(/\r?\n/).filter(Boolean).map((line) => {
        try {
          return redactGeminiMonitor(JSON.parse(line));
        } catch {
          return privacyParseFailure(line);
        }
      });
      await replacePrivateText(logPath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "");
      scrubbed.push(logPath);
    }
  }
  return scrubbed;
}
