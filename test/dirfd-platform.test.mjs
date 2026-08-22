import { describe, expect, test } from "bun:test";
import {
  DIRFD_STORAGE_REQUIREMENT,
  nativeDirfdPlatformSpec,
  unsupportedDirfdRuntimeMessage
} from "../src/dirfd-platform.mjs";

describe("native dirfd platform capability", () => {
  test("selects exact macOS and glibc Linux no-replace primitives", () => {
    expect(nativeDirfdPlatformSpec("darwin")).toEqual({
      libcPath: "/usr/lib/libSystem.B.dylib",
      errnoSymbol: "__error",
      renameNoReplaceSymbol: "renameatx_np",
      renameNoReplaceOperation: "renameatx_np(RENAME_EXCL)",
      atFdcwd: -2,
      renameNoReplaceFlag: 0x00000004
    });
    expect(nativeDirfdPlatformSpec("linux")).toEqual({
      libcPath: "libc.so.6",
      errnoSymbol: "__errno_location",
      renameNoReplaceSymbol: "renameat2",
      renameNoReplaceOperation: "renameat2(RENAME_NOREPLACE)",
      atFdcwd: -100,
      renameNoReplaceFlag: 1
    });
  });

  test("fails closed with one honest runtime requirement on unsupported systems", () => {
    expect(nativeDirfdPlatformSpec("win32")).toBeNull();
    expect(DIRFD_STORAGE_REQUIREMENT).toContain("macOS with renameatx_np");
    expect(DIRFD_STORAGE_REQUIREMENT).toContain("glibc Linux with renameat2");
    expect(unsupportedDirfdRuntimeMessage("linux")).toBe(
      "dirfd storage is unavailable on linux; macOS with renameatx_np or glibc Linux with renameat2 is required."
    );
  });
});
