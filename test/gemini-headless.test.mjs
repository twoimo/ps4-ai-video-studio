import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertGeminiChromeRuntime,
  buildGeminiChromeLaunchArgs,
  canonicalGeminiResumeScriptHash,
  geminiAspectRatioEvidence,
  geminiChromeMajorVersion,
  geminiVideoQuotaMessage,
  isHeadlessChromeVersion,
  resolveGeminiChromeLaunchPolicy
} from "../src/gemini-browser.mjs";

const HEADLESS_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36"
};

const HEADED_151 = {
  Browser: "Chrome/151.0.7922.109",
  "User-Agent": "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36"
};
const DEDICATED_PROFILE = join(homedir(), ".ps4-ai-video-studio", "headless-test");

describe("Gemini Chrome headless launch policy", () => {
  test("defaults to the new headless mode without a background window", () => {
    expect(resolveGeminiChromeLaunchPolicy({})).toEqual({
      headless: true,
      background: false,
      mode: "headless",
      headlessImplementation: "new"
    });
  });

  test("requires an explicit false value for a visible first-login window", () => {
    expect(resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "0" })).toMatchObject({
      headless: false,
      background: false,
      mode: "visible"
    });
    expect(resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "false", GEMINI_CHROME_BACKGROUND: "1" })).toMatchObject({
      headless: false,
      background: true,
      mode: "background"
    });
  });

  test("rejects ambiguous mode values instead of silently opening a window", () => {
    expect(() => resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "sometimes" })).toThrow("GEMINI_CHROME_HEADLESS");
    expect(() => resolveGeminiChromeLaunchPolicy({ GEMINI_CHROME_HEADLESS: "0", GEMINI_CHROME_BACKGROUND: "maybe" })).toThrow("GEMINI_CHROME_BACKGROUND");
  });

  test("pins CDP to loopback and launches the persisted profile with new headless", () => {
    const args = buildGeminiChromeLaunchArgs({
      cdpUrl: "http://127.0.0.1:9444",
      profileDir: DEDICATED_PROFILE
    }, {
      GEMINI_CHROME_HEADLESS: "1"
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9444");
    expect(args).toContain(`--user-data-dir=${DEDICATED_PROFILE}`);
    expect(args).toContain("--headless=new");
    expect(args).toContain("--window-size=1440,1200");
    expect(args).not.toContain("--disable-gpu");
    expect(args).not.toContain("--no-startup-window");
  });

  test("rejects non-loopback CDP and profiles outside the dedicated root", () => {
    expect(() => buildGeminiChromeLaunchArgs({
      cdpUrl: "http://example.com:9222",
      profileDir: DEDICATED_PROFILE
    })).toThrow("로컬 HTTP origin");
    expect(() => buildGeminiChromeLaunchArgs({
      cdpUrl: "http://127.0.0.1:9222",
      profileDir: "/tmp/shared-profile"
    })).toThrow("전용 프로필");
  });
});

describe("Gemini Chrome runtime mode attestation", () => {
  test("recognizes supported Chrome 151 headless", () => {
    expect(geminiChromeMajorVersion(HEADLESS_151)).toBe(151);
    expect(isHeadlessChromeVersion(HEADLESS_151)).toBe(true);
    expect(assertGeminiChromeRuntime(HEADLESS_151, { headless: true, mode: "headless" })).toEqual({
      chromeMajor: 151,
      actualHeadless: true,
      mode: "headless"
    });
  });

  test("fails closed when an existing CDP port serves a headed browser", () => {
    expect(() => assertGeminiChromeRuntime(HEADED_151, { headless: true, mode: "headless" })).toThrow("모드 불일치");
  });

  test("fails closed for legacy or unidentified runtimes", () => {
    expect(() => assertGeminiChromeRuntime({
      Browser: "Chrome/108.0.0.0",
      "User-Agent": "HeadlessChrome/108.0.0.0"
    }, { headless: true, mode: "headless" })).toThrow("Chrome 109 이상");
    expect(() => assertGeminiChromeRuntime({ Browser: "Unknown/1" }, { headless: true, mode: "headless" })).toThrow("확인할 수 없습니다");
  });
});

describe("Gemini browser generation safety", () => {
  test("requires an authoritative aspect-ratio label or selected state", () => {
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Aspect ratio: Portrait" })).toMatchObject({
      configured: true,
      method: "control-label"
    });
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "가로세로 비율: 세로 모드" }).configured).toBe(true);
    expect(geminiAspectRatioEvidence("vertical", {
      controlLabel: "Aspect ratio",
      options: [{ label: "Portrait 9:16", selected: true }]
    })).toMatchObject({ configured: true, method: "selected-state" });
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Aspect ratio" }).configured).toBe(false);
    expect(geminiAspectRatioEvidence("vertical", { controlLabel: "Landscape 16:9" })).toMatchObject({
      configured: false,
      contradiction: true
    });
  });

  test("detects precise video quota messages without treating upgrade copy as exhaustion", () => {
    expect(geminiVideoQuotaMessage("동영상을 다시 생성할 수 있습니다: 오늘 오후 8:20")).toContain("동영상을 다시 생성할 수 있습니다");
    expect(geminiVideoQuotaMessage("Video generation limit reached. Videos will be available again tomorrow.")).toContain("Video generation limit reached");
    expect(geminiVideoQuotaMessage("업그레이드하여 더 많은 기능을 이용하세요")).toBeNull();
    expect(geminiVideoQuotaMessage("Manage quota and billing in settings")).toBeNull();
  });

  test("canonical resume hash ignores capture timestamps but binds prompts, evidence, and source hashes", () => {
    const script = {
      title: "박석 배수 구조",
      capturedAt: "2026-08-12T10:00:00.000Z",
      sources: [{
        url: "https://example.test/source",
        sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fetchedAt: "2026-08-12T10:00:01.000Z",
        evidence: [{ id: "excerpt-1", quote: "박석 사이로 물이 빠집니다." }]
      }],
      segments: [{
        visualPrompt: "vertical documentary close-up of stone drainage",
        narration: "박석 사이로 물이 빠집니다.",
        sourceEvidence: [{ sourceId: "https://example.test/source", quote: "박석 사이로 물이 빠집니다." }]
      }]
    };
    const timestampOnlyChange = structuredClone(script);
    timestampOnlyChange.capturedAt = "2026-08-12T11:00:00.000Z";
    timestampOnlyChange.sources[0].fetchedAt = "2026-08-12T11:00:01.000Z";
    expect(canonicalGeminiResumeScriptHash(timestampOnlyChange)).toBe(canonicalGeminiResumeScriptHash(script));

    for (const mutate of [
      (value) => { value.segments[0].visualPrompt += " in rain"; },
      (value) => { value.sources[0].evidence[0].quote = "다른 근거"; },
      (value) => { value.sources[0].sha256 = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }
    ]) {
      const changed = structuredClone(script);
      mutate(changed);
      expect(canonicalGeminiResumeScriptHash(changed)).not.toBe(canonicalGeminiResumeScriptHash(script));
    }
  });
});
