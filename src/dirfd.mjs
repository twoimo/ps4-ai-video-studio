import { dlopen, ptr, read as ffiRead } from "bun:ffi";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, openSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nativeDirfdPlatformSpec, unsupportedDirfdRuntimeMessage } from "./dirfd-platform.mjs";

const PLATFORM_SPEC = nativeDirfdPlatformSpec(process.platform);
if (!PLATFORM_SPEC) throw new Error(unsupportedDirfdRuntimeMessage(process.platform));

let libc;
try {
  libc = dlopen(PLATFORM_SPEC.libcPath, {
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
    [PLATFORM_SPEC.renameNoReplaceSymbol]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
    strerror: { args: ["i32"], returns: "cstring" },
    [PLATFORM_SPEC.errnoSymbol]: { args: [], returns: "ptr" }
  });
} catch {
  throw new Error(unsupportedDirfdRuntimeMessage(process.platform));
}

const errnoNames = new Map(Object.entries(osConstants.errno || {}).map(([name, value]) => [Math.abs(value), name]));
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const AT_FDCWD = PLATFORM_SPEC.atFdcwd;
const RENAME_NOREPLACE = PLATFORM_SPEC.renameNoReplaceFlag;
const PRIVATE_STAGING_ROOT = mkdtempSync(join(tmpdir(), "ps4-dirfd-stage-"));
chmodSync(PRIVATE_STAGING_ROOT, 0o700);
const PRIVATE_STAGING_FD = openSync(PRIVATE_STAGING_ROOT, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
process.once("exit", () => {
  try { closeSync(PRIVATE_STAGING_FD); } catch {}
  try { rmSync(PRIVATE_STAGING_ROOT, { recursive: true, force: true }); } catch {}
});

function relativeEntryBuffer(name) {
  if (
    typeof name !== "string"
    || !name
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")
  ) throw new Error("dirfd-relative entry name is unsafe.");
  return Buffer.from(`${name}\0`);
}

function lastNativeError(operation) {
  const errno = ffiRead.i32(libc.symbols[PLATFORM_SPEC.errnoSymbol]());
  const message = libc.symbols.strerror(errno).toString();
  const error = new Error(`${operation}: ${message}`);
  error.errno = errno;
  error.code = errnoNames.get(Math.abs(errno)) || `ERRNO_${errno}`;
  error.syscall = operation;
  return error;
}

function checkedResult(result, operation) {
  if (result === -1) throw lastNativeError(operation);
  return result;
}

export function openDirectoryAt(directoryFd, name) {
  const entry = relativeEntryBuffer(name);
  return checkedResult(libc.symbols.openat(
    directoryFd,
    ptr(entry),
    fsConstants.O_RDONLY
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK
      | (fsConstants.O_DIRECTORY || 0)
      | (fsConstants.O_CLOEXEC || 0)
  ), `openat(${name})`);
}

export function openFileAt(directoryFd, name, flags, mode = 0o600) {
  if ((flags & fsConstants.O_CREAT) !== 0) {
    throw new Error("variadic openat(O_CREAT) is forbidden; create through a pinned pathname and verify its fd identity.");
  }
  const entry = relativeEntryBuffer(name);
  return checkedResult(libc.symbols.openat(
    directoryFd,
    ptr(entry),
    flags | fsConstants.O_NOFOLLOW | (fsConstants.O_CLOEXEC || 0)
  ), `openat(${name})`);
}

function renameNoReplaceFromPath(sourcePath, targetDirectoryFd, targetName) {
  const source = Buffer.from(`${sourcePath}\0`);
  const target = relativeEntryBuffer(targetName);
  const result = libc.symbols[PLATFORM_SPEC.renameNoReplaceSymbol](
    AT_FDCWD,
    ptr(source),
    targetDirectoryFd,
    ptr(target),
    RENAME_NOREPLACE
  );
  checkedResult(result, PLATFORM_SPEC.renameNoReplaceOperation);
}

export function createFileAt(directoryFd, name, flags, mode = 0o600, options = {}) {
  const stagingPath = join(PRIVATE_STAGING_ROOT, `${process.pid}-${randomBytes(12).toString("hex")}`);
  let stagingFd = null;
  let published = false;
  try {
    stagingFd = openSync(stagingPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
    if (Object.hasOwn(options, "initialBytes")) writeFdBuffer(stagingFd, options.initialBytes, 0);
    fsyncSync(stagingFd);
    options.beforePublish?.({ stagingFd, stagingPath, directoryFd, name });
    try {
      renameNoReplaceFromPath(stagingPath, directoryFd, name);
    } catch (error) {
      if (error?.code === "EXDEV") {
        throw new Error("dirfd immutable staging과 workspace가 서로 다른 filesystem이어서 안전한 publication을 중단합니다.");
      }
      throw error;
    }
    published = true;
    options.afterPublishBeforeSync?.({ stagingFd, stagingPath, directoryFd, name });
    syncFd(PRIVATE_STAGING_FD);
    syncFd(directoryFd);
    const publishedHandle = openFileAt(directoryFd, name, fsConstants.O_RDONLY);
    try {
      const identity = statFd(stagingFd);
      if (identity.nlink !== 1n || !sameFdIdentity(identity, statFd(publishedHandle))) {
        throw new Error("created file is not bound to its immutable published inode.");
      }
    } finally {
      closeFd(publishedHandle);
    }
    return stagingFd;
  } catch (error) {
    if (stagingFd !== null) try { closeSync(stagingFd); } catch {}
    if (!published) try { unlinkSync(stagingPath); } catch {}
    throw error;
  }
}

export function mkdirAt(directoryFd, name, mode = 0o700) {
  const entry = relativeEntryBuffer(name);
  checkedResult(libc.symbols.mkdirat(directoryFd, ptr(entry), mode), `mkdirat(${name})`);
}

export function openOrCreateDirectoryAt(directoryFd, name, mode = 0o700) {
  try {
    return openDirectoryAt(directoryFd, name);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirAt(directoryFd, name, mode);
  syncFd(directoryFd);
  return openDirectoryAt(directoryFd, name);
}

export function renameAt(sourceDirectoryFd, sourceName, targetDirectoryFd, targetName) {
  const source = relativeEntryBuffer(sourceName);
  const target = relativeEntryBuffer(targetName);
  checkedResult(
    libc.symbols.renameat(sourceDirectoryFd, ptr(source), targetDirectoryFd, ptr(target)),
    `renameat(${sourceName}, ${targetName})`
  );
}

export function renameAtNoReplace(sourceDirectoryFd, sourceName, targetDirectoryFd, targetName) {
  const source = relativeEntryBuffer(sourceName);
  const target = relativeEntryBuffer(targetName);
  checkedResult(
    libc.symbols[PLATFORM_SPEC.renameNoReplaceSymbol](
      sourceDirectoryFd,
      ptr(source),
      targetDirectoryFd,
      ptr(target),
      RENAME_NOREPLACE
    ),
    PLATFORM_SPEC.renameNoReplaceOperation
  );
}

export function unlinkAt(directoryFd, name) {
  const entry = relativeEntryBuffer(name);
  checkedResult(libc.symbols.unlinkat(directoryFd, ptr(entry), 0), `unlinkat(${name})`);
}

export function closeFd(fd) {
  closeSync(fd);
}

export function syncFd(fd) {
  fsyncSync(fd);
}

export function statFd(fd) {
  return fstatSync(fd, { bigint: true });
}

export function sameFdIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readFdBuffer(fd, options = {}) {
  const before = statFd(fd);
  const maximum = BigInt(options.maxBytes ?? Number.MAX_SAFE_INTEGER);
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER) || before.size > maximum) {
    throw new Error("dirfd-relative source is not a bounded regular file.");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesRead = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead <= 0) throw new Error("dirfd-relative source ended before its declared size.");
    offset += bytesRead;
  }
  const after = statFd(fd);
  if (
    !sameFdIdentity(before, after)
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) throw new Error("dirfd-relative source changed while it was read.");
  return bytes;
}

export function writeFdBuffer(fd, input, position = 0) {
  const bytes = Buffer.from(input);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesWritten = writeSync(fd, bytes, offset, bytes.byteLength - offset, position === null ? null : position + offset);
    if (bytesWritten <= 0) throw new Error("dirfd-relative write made no progress.");
    offset += bytesWritten;
  }
}

export function replaceFileAt(directoryFd, name, input, options = {}) {
  const publishedName = `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.new`;
  const stagingPath = join(PRIVATE_STAGING_ROOT, `${process.pid}-${randomBytes(12).toString("hex")}`);
  let stagingFd = null;
  try {
    stagingFd = openSync(stagingPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, options.mode ?? 0o600);
    writeFdBuffer(stagingFd, input, 0);
    syncFd(stagingFd);
    const source = Buffer.from(`${stagingPath}\0`);
    const target = relativeEntryBuffer(publishedName);
    try {
      checkedResult(libc.symbols.linkat(AT_FDCWD, ptr(source), directoryFd, ptr(target), 0), `linkat(${publishedName})`);
    } catch (error) {
      if (error?.code === "EXDEV") {
        throw new Error("dirfd immutable staging과 workspace가 서로 다른 filesystem이어서 안전한 replacement를 중단합니다.");
      }
      throw error;
    }
    unlinkSync(stagingPath);
    const linked = openFileAt(directoryFd, publishedName, fsConstants.O_RDONLY);
    try {
      if (!sameFdIdentity(statFd(stagingFd), statFd(linked))) throw new Error("linked replacement inode mismatch.");
    } finally {
      closeFd(linked);
    }
    options.beforeRename?.({ directoryFd, name, publishedName, stagingFd, identity: statFd(stagingFd) });
    if (Object.hasOwn(options, "expectedIdentity")) {
      let current = null;
      try {
        const currentFd = openFileAt(directoryFd, name, fsConstants.O_RDONLY);
        try { current = statFd(currentFd); } finally { closeFd(currentFd); }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (options.expectedIdentity === null ? current !== null : !current || !sameFdIdentity(options.expectedIdentity, current)) {
        throw new Error("dirfd replacement target changed before publication.");
      }
    }
    options.afterTargetCheckedBeforeRename?.({ directoryFd, name, publishedName, stagingFd, identity: statFd(stagingFd) });
    renameAt(directoryFd, publishedName, directoryFd, name);
    syncFd(directoryFd);
    const publishedTarget = openFileAt(directoryFd, name, fsConstants.O_RDONLY);
    try {
      const finalIdentity = statFd(publishedTarget);
      if (!sameFdIdentity(statFd(stagingFd), finalIdentity) || finalIdentity.nlink !== 1n) {
        throw new Error("dirfd replacement target is not the immutable staged inode.");
      }
    } finally {
      closeFd(publishedTarget);
    }
    closeFd(stagingFd);
    stagingFd = null;
  } catch (error) {
    if (stagingFd !== null) try { closeFd(stagingFd); } catch {}
    try { unlinkSync(stagingPath); } catch {}
    try { unlinkAt(directoryFd, publishedName); } catch {}
    throw error;
  }
}

export function appendFileAt(directoryFd, name, input, options = {}) {
  let previous = Buffer.alloc(0);
  let expectedIdentity = null;
  try {
    const fd = openFileAt(directoryFd, name, fsConstants.O_RDONLY);
    try {
      const identity = statFd(fd);
      if (!identity.isFile() || identity.nlink !== 1n) throw new Error("dirfd-relative append target is not an exclusive regular file.");
      expectedIdentity = identity;
      previous = readFdBuffer(fd, { maxBytes: options.maxBytes ?? 64 * 1024 * 1024 });
    } finally {
      closeFd(fd);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const combined = Buffer.concat([previous, Buffer.from(input)]);
  if (combined.byteLength > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Error("dirfd append exceeds its maximum size.");
  replaceFileAt(directoryFd, name, combined, { ...options, expectedIdentity });
}

export function readFileAt(directoryFd, name, options = {}) {
  const fd = openFileAt(directoryFd, name, fsConstants.O_RDONLY);
  try {
    return readFdBuffer(fd, options);
  } finally {
    closeFd(fd);
  }
}

export function tryLockExclusive(fd) {
  const result = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (result === 0) return true;
  const error = lastNativeError("flock(LOCK_EX|LOCK_NB)");
  if (["EWOULDBLOCK", "EAGAIN"].includes(error.code)) return false;
  throw error;
}

export function unlock(fd) {
  checkedResult(libc.symbols.flock(fd, LOCK_UN), "flock(LOCK_UN)");
}
