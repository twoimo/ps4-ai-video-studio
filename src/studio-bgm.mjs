import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_BGM_VOLUME, ROOT, WORKSPACE_DIR } from "./studio-settings.mjs";

export const BGM_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"]);
export const RESOURCE_SONGS_DIR = join(ROOT, "resource", "songs");
export const WORKSPACE_SONGS_DIR = join(WORKSPACE_DIR, "songs");

export function shouldMixBgm(settings = {}) {
  const volume = Number(settings.bgmVolume);
  return settings.bgmEnabled === true && Number.isFinite(volume) && volume > 0;
}

export function songDirectories(root = ROOT) {
  const workspaceSongs = root === ROOT ? WORKSPACE_SONGS_DIR : join(root, "workspace", "songs");
  const resourceSongs = root === ROOT ? RESOURCE_SONGS_DIR : join(root, "resource", "songs");
  return [workspaceSongs, resourceSongs];
}

export async function ensureSongDirectories(root = ROOT) {
  for (const dir of songDirectories(root)) await mkdir(dir, { recursive: true });
  return songDirectories(root);
}

function isSafeSongName(name) {
  if (!name || name.startsWith(".") || name === "README.md") return false;
  return BGM_EXTENSIONS.has(extname(name).toLowerCase());
}

export async function listBgmFiles(root = ROOT) {
  const files = [];
  for (const dir of songDirectories(root)) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !isSafeSongName(entry.name)) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function resolveBgmPath(unsafePath, root = ROOT) {
  if (!unsafePath) return null;
  const allowed = songDirectories(root).map((dir) => resolve(dir));
  const candidates = [unsafePath];
  if (!String(unsafePath).startsWith("/")) {
    for (const dir of allowed) candidates.push(join(dir, unsafePath));
  }
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!existsSync(resolved)) continue;
    if (!BGM_EXTENSIONS.has(extname(resolved).toLowerCase())) continue;
    if (allowed.some((dir) => resolved === dir || resolved.startsWith(`${dir}${sep}`))) return resolved;
  }
  return null;
}

export async function pickBgmFile({ settings = {}, root = ROOT, preferred = "" } = {}) {
  if (!shouldMixBgm(settings)) return null;
  const chosen = resolveBgmPath(preferred, root);
  if (chosen) return chosen;
  const files = await listBgmFiles(root);
  return files[0] || null;
}

export { DEFAULT_BGM_VOLUME };
