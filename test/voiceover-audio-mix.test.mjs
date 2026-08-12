import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceoverAudioMixPolicy, voiceoverMixFfmpegArgs } from "../src/pipeline.mjs";

async function run(binary, args) {
  const process = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();
  const exitCode = await process.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`${binary} failed (${exitCode}): ${stderr.slice(-2000)}`);
  return stdout;
}

async function runBytes(binary, args) {
  const process = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(process.stdout).arrayBuffer();
  const stderrPromise = new Response(process.stderr).text();
  const exitCode = await process.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`${binary} failed (${exitCode}): ${stderr.slice(-2000)}`);
  return new Float32Array(stdout);
}

function toneAmplitude(samples, sampleRate, frequency, startSec, endSec) {
  const start = Math.floor(startSec * sampleRate);
  const end = Math.min(samples.length, Math.floor(endSec * sampleRate));
  let cosine = 0;
  let sine = 0;
  for (let index = start; index < end; index += 1) {
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    cosine += samples[index] * Math.cos(angle);
    sine += samples[index] * Math.sin(angle);
  }
  return 2 * Math.hypot(cosine, sine) / Math.max(1, end - start);
}

describe("voiceover ambient audio mix", () => {
  test("pins the provider-ambient ducking and single-AAC output policy", () => {
    const policy = voiceoverAudioMixPolicy(20);
    expect(policy).toMatchObject({
      version: "ffmpeg-sidechain-ambient/v1",
      sourceAudioMode: "preserved-low-level-sidechain-ducked",
      sourceAudio: { role: "provider-native-ambient", gainLinear: 0.22, gainDb: -13.152 },
      voiceAudio: { role: "macos-say-narration", gainLinear: 1, gainDb: 0 },
      ducking: { filter: "sidechaincompress", thresholdLinear: 0.04, ratio: 8, attackMs: 12, releaseMs: 320 },
      summing: { filter: "amix", inputs: 2, normalize: false },
      limiter: { filter: "alimiter", limitLinear: 0.95, autoLevel: false },
      output: { streamCount: 1, codec: "aac", bitrateKbps: 192, sampleRateHz: 48000, channels: 2, durationSec: 20 }
    });
    expect(policy.filterComplex).toContain("[0:a:0]");
    expect(policy.filterComplex).toContain("sidechaincompress=");
    expect(policy.filterComplex).toContain("amix=inputs=2");
    expect(policy.filterComplex).toContain("atrim=start=0:end=20.000");
    expect(voiceoverAudioMixPolicy(20).filterComplex).toBe(policy.filterComplex);
    expect(() => voiceoverAudioMixPolicy(0)).toThrow("목표 영상 길이");
  });

  test("renders a fixture with exactly one stereo AAC audio stream", async () => {
    const ffmpeg = Bun.which("ffmpeg");
    const ffprobe = Bun.which("ffprobe");
    if (!ffmpeg || !ffprobe) return;
    const directory = await mkdtemp(join(tmpdir(), "ps4-voiceover-mix-"));
    const source = join(directory, "source.mp4");
    const voice = join(directory, "voice.wav");
    const output = join(directory, "mixed.mp4");
    try {
      await run(ffmpeg, [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=2",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-shortest",
        "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-b:a", "128k", source
      ]);
      await run(ffmpeg, [
        "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0\\,0.20*sin(2*PI*880*t)):s=48000:d=2",
        "-c:a", "pcm_s16le", voice
      ]);
      await run(ffmpeg, ["-v", "error", ...voiceoverMixFfmpegArgs(source, voice, output, 2)]);
      const probe = JSON.parse(await run(ffprobe, [
        "-v", "error", "-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels,duration:format=duration", "-of", "json", output
      ]));
      const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
      expect(audioStreams).toHaveLength(1);
      expect(audioStreams[0]).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
      expect(Number(audioStreams[0].duration)).toBeGreaterThanOrEqual(1.95);
      expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(1.95);
      expect(Number(probe.format.duration)).toBeLessThanOrEqual(2.05);
      const samples = await runBytes(ffmpeg, [
        "-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-c:a", "pcm_f32le", "-"
      ]);
      const ambientWithoutNarration = toneAmplitude(samples, 48000, 220, 0.2, 0.8);
      const ambientUnderNarration = toneAmplitude(samples, 48000, 220, 1.2, 1.8);
      expect(ambientWithoutNarration).toBeGreaterThan(0.005);
      expect(ambientUnderNarration).toBeGreaterThan(0.0005);
      expect(ambientUnderNarration).toBeLessThan(ambientWithoutNarration * 0.7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
});
