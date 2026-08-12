import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sanitizeBenchmarkAnalysis, selectBenchmarkCaptionFile } from "../src/benchmark-media-receipt.mjs";
import { EDITORIAL_HYPOTHESIS, classifyChannelTitle } from "../src/channel-title-analysis.mjs";

function ids(items) {
  return items.map((item) => item.id);
}

describe("benchmark caption receipt privacy", () => {
  test("prefers Korean captions deterministically", () => {
    expect(selectBenchmarkCaptionFile([
      "video.en.vtt",
      "unrelated.ko.vtt",
      "video.ko.vtt"
    ], "video")).toBe("video.ko.vtt");
    expect(selectBenchmarkCaptionFile(["video.en.vtt"], "video")).toBe("video.en.vtt");
    expect(selectBenchmarkCaptionFile([], "video")).toBeNull();
  });

  test("keeps aggregate measurements and a source hash without raw cue content", () => {
    const captionText = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n배포하면 안 되는 원문";
    const analysis = {
      media: { durationSec: 1 },
      captions: {
        count: 1,
        totalCharacters: 13,
        wordTimingCount: 2,
        entries: [{ startSec: 0, endSec: 1, text: "배포하면 안 되는 원문" }],
        wordTimings: [{ startSec: 0, endSec: 0.5, text: "배포하면" }, { startSec: 0.5, endSec: 1, text: "안 되는 원문" }]
      }
    };
    const receipt = sanitizeBenchmarkAnalysis(analysis, { captionText, captionFile: "video.ko.vtt" });

    expect(receipt.captions).not.toHaveProperty("entries");
    expect(receipt.captions).not.toHaveProperty("wordTimings");
    expect(receipt.captions).toMatchObject({
      count: 1,
      wordTimingCount: 2,
      entriesOmittedFromReceipt: 1,
      wordTimingsOmittedFromReceipt: 2,
      rawTextStored: false,
      sourceReceipt: {
        filename: "video.ko.vtt",
        language: "ko",
        bytes: Buffer.byteLength(captionText),
        sha256: `sha256:${createHash("sha256").update(captionText).digest("hex")}`
      }
    });
    expect(JSON.stringify(receipt)).not.toContain("배포하면 안 되는 원문");
  });
});

describe("Korean title context rules", () => {
  test("does not confuse 비밀 or 비극 with rain and 만약 or 만든 with numeric scale", () => {
    expect(ids(classifyChannelTitle("첨성대의 비밀").categories)).not.toContain("water");
    expect(ids(classifyChannelTitle("두 남자의 호기심이 불러온 비극").categories)).not.toContain("water");
    expect(ids(classifyChannelTitle("만약 사람들이 만든 길이라면?").hooks)).not.toContain("scale");
    expect(classifyChannelTitle("만약 사람들이 만든 길이라면?").flags.number).toBe(false);
    expect(ids(classifyChannelTitle("번개를 막는 물건의 비밀").categories)).not.toContain("water");
    expect(ids(classifyChannelTitle("직원 600명이 일하는 건물을 통째로 옮긴 이유").categories)).not.toContain("water");
  });

  test("still recognizes contextual rain, water and scale patterns", () => {
    expect(ids(classifyChannelTitle("서울 인도에는 비를 마시는 보도블록이 있습니다").categories)).toContain("water");
    expect(ids(classifyChannelTitle("물을 한 방울도 안 가두는 댐이 전국에 만 개나 있는 이유").categories)).toContain("water");
    expect(ids(classifyChannelTitle("물을 한 방울도 안 가두는 댐이 전국에 만 개나 있는 이유").hooks)).toContain("scale");
    expect(ids(classifyChannelTitle("5만 톤 배가 산을 넘어갑니다").hooks)).toContain("scale");
  });

  test("publishes editorial guidance only as an unmeasured hypothesis", () => {
    expect(EDITORIAL_HYPOTHESIS).toMatchObject({
      status: "hypothesis-not-measured",
      evidenceBasis: "title-and-public-metadata-heuristic"
    });
    expect(EDITORIAL_HYPOTHESIS.limitation).toContain("직접 관측한 결과가 아닙니다");
  });
});
