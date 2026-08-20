import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DEFAULT_EDGE_VOICE, chirpConfigured } from "./studio-settings.mjs";

export const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_TTS_CHROMIUM = "130.0.2849.68";
const HUNDRED_NS = 10_000_000;

export function ticksToSeconds(value) {
  return Number(value || 0) / HUNDRED_NS;
}

export function edgeWordTimestamps(events = []) {
  return events.flatMap((event) => {
    const items = Array.isArray(event?.Metadata) ? event.Metadata : [event];
    return items.map((item) => {
      const type = item?.Type || item?.type || "";
      if (!/WordBoundary|SentenceBoundary/i.test(type)) return null;
      const data = item.Data || item.data || item;
      const text = String(data?.text?.Text || data?.text?.text || data?.text || data?.word || "").trim();
      const start = ticksToSeconds(data?.Offset ?? data?.offset ?? data?.start);
      const duration = ticksToSeconds(data?.Duration ?? data?.duration ?? 0);
      const end = Number.isFinite(Number(data?.end)) ? Number(data.end) : start + duration;
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), type: /Sentence/i.test(type) ? "sentence" : "word" };
    }).filter(Boolean);
  });
}

export function ttsTimingFromWords(words = []) {
  const list = Array.isArray(words) ? words.filter((item) => item?.text && Number(item.end) > Number(item.start)) : [];
  return {
    wordTimestamps: list.filter((item) => item.type !== "sentence"),
    sentenceTimestamps: list.filter((item) => item.type === "sentence"),
    words: list,
    source: "edge-tts"
  };
}

export function narrationTextFromScript(script = {}) {
  const segments = Array.isArray(script.segments) ? script.segments : [];
  const lines = segments.map((segment) => String(segment.narration || segment.caption || "").trim()).filter(Boolean);
  if (lines.length) return lines.join("\n");
  return String(script.narration || script.hook || "").trim();
}

export function edgeSsml(text, voice = DEFAULT_EDGE_VOICE, rate = "+0%") {
  const safeVoice = String(voice || DEFAULT_EDGE_VOICE).replace(/[<>&'"]/g, "");
  const body = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${safeVoice}"><prosody rate="${rate}">${body}</prosody></voice></speak>`;
}

export function secMsGec(nowSec = Date.now() / 1000) {
  const winEpoch = 11644473600;
  let ticks = Math.floor((Number(nowSec) + winEpoch) * 10_000_000);
  ticks -= ticks % 3_000_000_000;
  return createHash("sha256").update(`${ticks.toString(16).toUpperCase()}${EDGE_TTS_TOKEN}`).digest("hex").toUpperCase();
}

export function edgeTtsUrl({ connectionId = randomUUID().replace(/-/g, ""), nowSec } = {}) {
  const params = new URLSearchParams({
    TrustedClientToken: EDGE_TTS_TOKEN,
    ConnectionId: connectionId,
    "Sec-MS-GEC": secMsGec(nowSec),
    "Sec-MS-GEC-Version": `1-${EDGE_TTS_CHROMIUM}`
  });
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?${params}`;
}

function configMessage() {
  return `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "true", wordBoundaryEnabled: "true" },
          outputFormat: "audio-24khz-48kbitrate-mono-mp3"
        }
      }
    }
  })}`;
}

function ssmlMessage(ssml) {
  return `X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
}

function parseTextFrame(payload) {
  const text = String(payload || "");
  const split = text.indexOf("\r\n\r\n");
  const header = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 4) : "";
  if (/Path:audio\.metadata/i.test(header) || /Path:audio\.metadata/i.test(text)) {
    try { return { metadata: JSON.parse(body || text.replace(/^[\s\S]*\r\n\r\n/, "")) }; } catch { return { metadata: null }; }
  }
  if (/Path:turn\.end/i.test(header) || /Path:turn\.end/i.test(text)) return { turnEnd: true };
  return { text };
}

async function socketBytes(data) {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data && typeof data.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer());
  return data;
}

export async function decodeTtsSocketData(data) {
  const payload = await socketBytes(data);
  if (typeof payload === "string") return parseTextFrame(payload);
  if (!payload || typeof payload !== "object") return parseTextFrame(String(payload ?? ""));
  const raw = Buffer.from(payload);
  const headerEnd = raw.indexOf("\r\n\r\n");
  const header = headerEnd >= 0 ? raw.subarray(0, headerEnd).toString("utf8") : "";
  const body = headerEnd >= 0 ? raw.subarray(headerEnd + 4) : raw;
  if (/Path:audio\.metadata/i.test(header)) {
    try { return { metadata: JSON.parse(body.toString("utf8")) }; } catch { return { metadata: null }; }
  }
  if (/Path:turn\.end/i.test(header) || /Path:turn\.end/i.test(raw.toString("utf8"))) return { turnEnd: true };
  if (/Path:audio/i.test(header)) return { audio: body };
  if (headerEnd < 0) return { audio: raw };
  return parseTextFrame(raw.toString("utf8"));
}

function listenSocket(socket, name, fn) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(name, fn);
  else if (typeof socket.on === "function") socket.on(name, fn);
  else socket[`on${name}`] = fn;
}

export async function synthesizeEdgeTts(text, {
  voice = DEFAULT_EDGE_VOICE,
  WebSocketImpl = globalThis.WebSocket,
  nowSec
} = {}) {
  const spoken = String(text || "").trim();
  if (!spoken) throw new Error("미리 들을 문장이 없습니다.");
  if (!WebSocketImpl) throw new Error("Edge TTS를 실행할 WebSocket이 없습니다.");
  const url = edgeTtsUrl({ nowSec });
  const chunks = [];
  const events = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocketImpl(url, {
      headers: {
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_TTS_CHROMIUM} Safari/537.36 Edg/${EDGE_TTS_CHROMIUM}`,
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
      }
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try { socket.close?.(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Edge TTS 시간이 초과되었습니다. Gemini로 대체하지 않습니다.")), 45_000);
    let chain = Promise.resolve();
    listenSocket(socket, "open", () => {
      try {
        socket.send(configMessage());
        socket.send(ssmlMessage(edgeSsml(spoken, voice)));
      } catch (error) {
        clearTimeout(timer);
        finish(error);
      }
    });
    listenSocket(socket, "message", (event) => {
      chain = chain.then(async () => {
        if (settled) return;
        const parsed = await decodeTtsSocketData(event?.data ?? event);
        if (parsed.audio?.length) chunks.push(Buffer.from(parsed.audio));
        if (parsed.metadata) events.push(parsed.metadata);
        if (parsed.turnEnd || (parsed.text && /Path:turn\.end/i.test(parsed.text))) {
          clearTimeout(timer);
          finish(null);
        }
      }).catch((error) => {
        clearTimeout(timer);
        finish(error);
      });
    });
    listenSocket(socket, "error", () => {
      clearTimeout(timer);
      finish(new Error("Edge TTS 연결에 실패했습니다. Gemini로 대체하지 않습니다."));
    });
    listenSocket(socket, "close", () => {
      clearTimeout(timer);
      void chain.finally(() => finish(null));
    });
  });
  const audio = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (!audio.length) throw new Error("Edge TTS가 오디오를 반환하지 않았습니다. Gemini로 대체하지 않습니다.");
  const words = edgeWordTimestamps(events);
  return {
    provider: "edge",
    voice,
    audio,
    mime: "audio/mpeg",
    ...ttsTimingFromWords(words)
  };
}

export async function synthesizeChirpTts(text, {
  voice = "ko-KR-Chirp3-HD-Charon",
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!chirpConfigured(env)) throw new Error("Google Chirp 환경이 없습니다. 고급에서 Edge TTS를 쓰세요.");
  const key = String(env.GOOGLE_TTS_API_KEY || env.GOOGLE_CLOUD_TTS_API_KEY || "").trim();
  if (!key || !fetchImpl) throw new Error("Google Chirp 키가 없어 음성을 만들지 못했습니다. Gemini로 대체하지 않습니다.");
  const response = await fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text: String(text || "").trim() },
      voice: { languageCode: "ko-KR", name: voice, modelName: "chirp" },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1 }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.audioContent) {
    throw new Error(payload.error?.message || "Google Chirp TTS가 실패했습니다. Gemini로 대체하지 않습니다.");
  }
  return {
    provider: "chirp",
    voice,
    audio: Buffer.from(payload.audioContent, "base64"),
    mime: "audio/mpeg",
    wordTimestamps: [],
    sentenceTimestamps: [],
    words: [],
    source: "chirp"
  };
}

export async function synthesizeStudioTts(text, options = {}) {
  const provider = options.provider === "chirp" ? "chirp" : "edge";
  if (provider === "chirp") return synthesizeChirpTts(text, options);
  return synthesizeEdgeTts(text, options);
}

export async function writeTtsSidecar(jobDir, result, filename = "voiceover.mp3") {
  const audioPath = `${jobDir.replace(/\/$/, "")}/${filename}`;
  await writeFile(audioPath, result.audio);
  return {
    audioPath,
    timing: ttsTimingFromWords(result.words || result.wordTimestamps || []),
    provider: result.provider,
    voice: result.voice
  };
}
