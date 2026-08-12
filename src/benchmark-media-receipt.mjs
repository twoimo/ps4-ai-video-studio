import { createHash } from "node:crypto";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function selectBenchmarkCaptionFile(files, videoId) {
  const candidates = files
    .filter((name) => name.startsWith(`${videoId}.`) && name.endsWith(".vtt"))
    .sort((left, right) => left.localeCompare(right));
  return candidates.find((name) => name.endsWith(".ko.vtt"))
    || candidates.find((name) => name.endsWith(".en.vtt"))
    || candidates[0]
    || null;
}

function captionLanguage(filename) {
  const match = String(filename || "").match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.vtt$/u);
  return match?.[1]?.toLowerCase() || null;
}

export function sanitizeBenchmarkAnalysis(analysis, { captionText = "", captionFile = null } = {}) {
  const entries = Array.isArray(analysis?.captions?.entries) ? analysis.captions.entries : [];
  const wordTimings = Array.isArray(analysis?.captions?.wordTimings) ? analysis.captions.wordTimings : [];
  const { entries: _entries, wordTimings: _wordTimings, ...captionAggregates } = analysis?.captions || {};
  const rawBytes = Buffer.byteLength(captionText, "utf8");
  return {
    ...analysis,
    captions: {
      ...captionAggregates,
      entriesOmittedFromReceipt: entries.length,
      wordTimingsOmittedFromReceipt: wordTimings.length,
      rawTextStored: false,
      sourceReceipt: captionFile ? {
        filename: captionFile,
        language: captionLanguage(captionFile),
        bytes: rawBytes,
        sha256: sha256(captionText)
      } : null
    }
  };
}
