export const DIRFD_STORAGE_REQUIREMENT = "macOS with renameatx_np or glibc Linux with renameat2";

const PLATFORM_SPECS = Object.freeze({
  darwin: Object.freeze({
    libcPath: "/usr/lib/libSystem.B.dylib",
    errnoSymbol: "__error",
    renameNoReplaceSymbol: "renameatx_np",
    renameNoReplaceOperation: "renameatx_np(RENAME_EXCL)",
    atFdcwd: -2,
    renameNoReplaceFlag: 0x00000004
  }),
  linux: Object.freeze({
    libcPath: "libc.so.6",
    errnoSymbol: "__errno_location",
    renameNoReplaceSymbol: "renameat2",
    renameNoReplaceOperation: "renameat2(RENAME_NOREPLACE)",
    atFdcwd: -100,
    renameNoReplaceFlag: 1
  })
});

export function nativeDirfdPlatformSpec(platform) {
  return PLATFORM_SPECS[platform] || null;
}

export function unsupportedDirfdRuntimeMessage(platform) {
  return `dirfd storage is unavailable on ${platform}; ${DIRFD_STORAGE_REQUIREMENT} is required.`;
}
