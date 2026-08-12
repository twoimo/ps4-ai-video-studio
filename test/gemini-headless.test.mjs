import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertGeminiChromeRuntime,
  buildGeminiChromeLaunchArgs,
  geminiChromeMajorVersion,
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
