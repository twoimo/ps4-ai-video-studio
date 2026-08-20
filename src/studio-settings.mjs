import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const WORKSPACE_DIR = join(ROOT, "workspace");

export const STUDIO_CONFIG_NAME = "studio-config.json";
export const DEFAULT_EDGE_VOICE = "ko-KR-SunHiNeural";
export const DEFAULT_BGM_VOLUME = 0.08;

export const EDGE_VOICES = [
  { id: "ko-KR-SunHiNeural", label: "선희 · 여성", locale: "ko-KR", provider: "edge" },
  { id: "ko-KR-InJoonNeural", label: "인준 · 남성", locale: "ko-KR", provider: "edge" },
  { id: "ko-KR-HyunsuMultilingualNeural", label: "현수 · 남성", locale: "ko-KR", provider: "edge" }
];

export function defaultStudioSettings() {
  return {
    schemaVersion: 1,
    ttsProvider: "edge",
    ttsVoice: DEFAULT_EDGE_VOICE,
    bgmEnabled: false,
    bgmVolume: DEFAULT_BGM_VOLUME,
    ffmpegPath: ""
  };
}

export function studioConfigPath(root = ROOT) {
  return join(root === ROOT ? WORKSPACE_DIR : join(root, "workspace"), STUDIO_CONFIG_NAME);
}

export function chirpConfigured(env = process.env) {
  return Boolean(
    String(env.GOOGLE_TTS_API_KEY || "").trim()
    || String(env.GOOGLE_CLOUD_TTS_API_KEY || "").trim()
    || (
      String(env.GOOGLE_APPLICATION_CREDENTIALS || "").trim()
      && String(env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_PROJECT_ID || "").trim()
    )
  );
}

export function normalizeStudioSettings(input = {}, env = process.env) {
  const defaults = defaultStudioSettings();
  const ttsProvider = input.ttsProvider === "chirp" && chirpConfigured(env) ? "chirp" : "edge";
  const voice = String(input.ttsVoice || defaults.ttsVoice).trim() || defaults.ttsVoice;
  let bgmVolume = Number(input.bgmVolume);
  if (!Number.isFinite(bgmVolume)) bgmVolume = defaults.bgmVolume;
  bgmVolume = Math.min(1, Math.max(0, bgmVolume));
  return {
    schemaVersion: 1,
    ttsProvider,
    ttsVoice: voice,
    bgmEnabled: input.bgmEnabled === true && bgmVolume > 0,
    bgmVolume,
    ffmpegPath: String(input.ffmpegPath || "").trim()
  };
}

export async function readStudioSettings({ root = ROOT, env = process.env } = {}) {
  const path = studioConfigPath(root);
  if (!existsSync(path)) return normalizeStudioSettings(defaultStudioSettings(), env);
  try {
    return normalizeStudioSettings(JSON.parse(await readFile(path, "utf8")), env);
  } catch {
    return normalizeStudioSettings(defaultStudioSettings(), env);
  }
}

export async function writeStudioSettings(input = {}, { root = ROOT, env = process.env } = {}) {
  const settings = normalizeStudioSettings(input, env);
  const path = studioConfigPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

export function settingsPublicView(settings, env = process.env) {
  return {
    ...normalizeStudioSettings(settings, env),
    chirpAvailable: chirpConfigured(env),
    voices: EDGE_VOICES,
    songsHint: "resource/songs 또는 workspace/songs에 오디오를 넣습니다. 없으면 나레이션만 씁니다."
  };
}
