import { describe, expect, test } from "bun:test";
import { compareDuration } from "../src/frame-analysis.mjs";

const profile = {
  summary: { medianSec: 78, p10Sec: 57, p90Sec: 93, recommendedTargetSec: 78, recommendedRangeSec: [57, 93] },
  recentSummary: { medianSec: 110, p10Sec: 94, p90Sec: 128, recommendedTargetSec: 110, recommendedRangeSec: [96, 122] }
};

describe("duration benchmark selection", () => {
  test("uses the recent Shorts profile when no job-bound target is present", () => {
    expect(compareDuration(110, profile)).toMatchObject({
      source: "benchmark-recent",
      targetSec: 110,
      rangeSec: [96, 122],
      insideRecommendedRange: true
    });
  });

  test("uses the immutable job-bound target for quota-sized Gemini runs", () => {
    expect(compareDuration(20, profile, { targetSec: 20, rangeSec: [16, 24] })).toMatchObject({
      source: "job-bound-target",
      targetSec: 20,
      rangeSec: [16, 24],
      insideRecommendedRange: true
    });
  });
});
