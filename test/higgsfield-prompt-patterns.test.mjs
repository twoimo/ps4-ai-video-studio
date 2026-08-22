import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHOT_PATTERN_APPLICATION_MODE,
  SHOT_PATTERN_PROVIDER_APPLICATION_MODE,
  applyShotPatternsToScript,
  composeProviderVisualPrompt,
  createShotPatternReceipt,
  hashShotPatternValue,
  providerPromptBindingForSegment,
  providerRequestFieldsForSegment,
  shotPatternRequiredForScript,
  validateShotPatternCatalog,
  verifyShotPatternReceipt
} from "../src/shot-patterns.mjs";
import { buildGeminiClipPrompt, buildGeminiGenerationRequest } from "../src/gemini-browser.mjs";
import {
  buildLocalVideoRequest,
  hashLocalVideoJson,
  validateLocalVideoReceipt
} from "../src/local-video-provider.mjs";
import { artifactReceipt, hashFile } from "../src/run-ledger.mjs";
import { safeShotPatternSourceUrl, shotPatternsMarkup } from "../public/shot-patterns-view.js";

const catalogUrl = new URL("../data/higgsfield-prompt-patterns.json", import.meta.url);

async function loadCatalog() {
  return JSON.parse(await readFile(fileURLToPath(catalogUrl), "utf8"));
}

function scriptFixture() {
  return {
    researchStatus: "verified",
    evidenceTextBindingHash: "sha256:evidence-binding",
    segments: [
      { claimId: "claim-1", visualPrompt: "vertical cinematic documentary visualization depicting only this evidence: \"captured fact one\"; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark", caption: "captured fact one", narration: "captured fact one", durationHint: 10 },
      { claimId: "claim-2", visualPrompt: "vertical cinematic documentary visualization depicting only this evidence: \"captured fact two\"; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark", caption: "captured fact two", narration: "captured fact two", durationHint: 10 }
    ]
  };
}

function jobFixture(provider) {
  return { id: "job-shot-pattern", provider, topic: "evidence topic", format: "vertical", clipCount: 2, targetDurationSec: 20, targetDurationRangeSec: [18, 22], captions: true, voiceover: true };
}

describe("Higgsfield-informed prompt-pattern catalog", () => {
  test("is a versioned, spend-free, non-vendored research artifact", async () => {
    const catalog = await loadCatalog();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.catalogId).toBe("ps4-higgsfield-learning-patterns-v1");
    expect(catalog.observedAt).toBe("2026-08-12");
    expect(catalog.policy).toMatchObject({
      defaultUse: "conceptual-adaptation-only",
      providerCallsMade: false,
      generationSpend: false,
      remoteAssetsCopiedIntoProject: false
    });
  });

  test("pins MIT material and keeps unlicensed website material reference-only", async () => {
    const catalog = await loadCatalog();
    const sourceIds = new Set();

    for (const source of catalog.sources) {
      expect(sourceIds.has(source.id)).toBe(false);
      sourceIds.add(source.id);
      expect(source.publisher).toBe("Higgsfield AI");
      expect(new URL(source.url).protocol).toBe("https:");
      expect(source.localCopy).toBe(false);

      if (source.kind === "official-github-reference") {
        expect(source.url).toContain("github.com/higgsfield-ai/skills/blob/fb18134b4aabe99c4bf7ff01c8f4883400efc80d/");
        expect(source.commit).toBe("fb18134b4aabe99c4bf7ff01c8f4883400efc80d");
        expect(source.license).toBe("MIT");
        expect(source.reuse).toBe("commercial-use-permitted-under-mit");
        expect(source.licenseUrl).toContain("/LICENSE");
      } else {
        expect(new URL(source.url).hostname).toBe("higgsfield.ai");
        expect(source.license).toBe("no-redistribution-license-found");
        expect(source.reuse).toBe("reference-only-no-verbatim-text-or-assets");
      }
    }

    expect([...sourceIds]).toEqual([
      "higgsfield-skills-prompt-engineering",
      "higgsfield-skills-explainer-prompts",
      "higgsfield-academy-prompt-bank",
      "higgsfield-beginner-guide",
      "higgsfield-seedance-guide"
    ]);
  });

  test("provides unique, source-bound patterns with deterministic receipt fields", async () => {
    const catalog = await loadCatalog();
    const validSourceIds = new Set(catalog.sources.map(({ id }) => id));
    const patternIds = new Set();

    expect(catalog.patterns).toHaveLength(8);

    for (const pattern of catalog.patterns) {
      expect(patternIds.has(pattern.id)).toBe(false);
      patternIds.add(pattern.id);
      expect(pattern.labelKo.length).toBeGreaterThan(3);
      expect(pattern.goal.length).toBeGreaterThan(20);
      expect(pattern.derivation.length).toBeGreaterThan(30);
      expect(pattern.template.length).toBeGreaterThan(80);
      expect(pattern.variables.length).toBeGreaterThan(2);
      expect(pattern.guardrails.length).toBeGreaterThan(2);
      expect(pattern.receiptFields).toContain("patternId");
      expect(pattern.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of pattern.sourceIds) {
        expect(validSourceIds.has(sourceId)).toBe(true);
      }
    }

    expect([...patternIds]).toEqual([
      "shorts-curiosity-proof",
      "locked-static-evidence",
      "pan-discovery",
      "dolly-depth-reveal",
      "lateral-parallax-follow",
      "focus-handoff",
      "continuity-contract",
      "narration-visual-pair"
    ]);
  });

  test("contains no remote media copies or hidden paid execution instructions", async () => {
    const catalog = await loadCatalog();
    const serialized = JSON.stringify(catalog);

    expect(serialized).not.toContain("data:image/");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("auth login");
    expect(serialized).not.toContain("generate create");
    expect(serialized).not.toContain("Start now for free");
  });

  test("keeps the extractive visual prompt immutable while deterministically rendering camera and continuity suffixes", async () => {
    const catalog = await loadCatalog();
    const source = scriptFixture();
    const decorated = applyShotPatternsToScript(source, jobFixture("gemini-browser"), catalog);
    const repeated = applyShotPatternsToScript(source, jobFixture("gemini-browser"), catalog);

    expect(decorated.segments.map(({ visualPrompt }) => visualPrompt)).toEqual(source.segments.map(({ visualPrompt }) => visualPrompt));
    expect(decorated.shotPatternPlan.planHash).toBe(repeated.shotPatternPlan.planHash);
    expect(decorated.shotPatternPlan.applicationMode).toBe(SHOT_PATTERN_PROVIDER_APPLICATION_MODE);
    expect(decorated.shotPatternPlan).toMatchObject({ providerEligible: true, providerSubmissionPlanned: true });
    for (const segment of decorated.segments) {
      expect(segment.shotPattern.providerVisualPrompt).toBe(composeProviderVisualPrompt(
        segment.visualPrompt,
        segment.shotPattern.renderedPrompt,
        segment.shotPattern.continuityPrompt
      ));
      expect(segment.shotPattern.providerVisualPromptHash).toBe(hashShotPatternValue(segment.shotPattern.providerVisualPrompt));
      expect(segment.shotPattern.providerVisualPrompt.startsWith(segment.visualPrompt)).toBe(true);
      expect(segment.shotPattern).toMatchObject({ providerEligible: true, providerSubmissionPlanned: true });
      expect(segment.shotPattern.factualTextAdded).toBe(false);
    }
  });

  test("sends the exact bound provider prompt through Gemini and local-video requests", async () => {
    const catalog = await loadCatalog();
    const geminiJob = jobFixture("gemini-browser");
    const geminiScript = applyShotPatternsToScript(scriptFixture(), geminiJob, catalog);
    const geminiRequest = buildGeminiGenerationRequest(geminiJob, geminiScript);
    const geminiBinding = providerPromptBindingForSegment(geminiScript.segments[0], "gemini-browser");
    expect(geminiRequest.segments[0].providerVisualPrompt).toBe(geminiBinding.providerVisualPrompt);
    expect(geminiRequest.segments[0].providerVisualPromptHash).toBe(geminiBinding.providerVisualPromptHash);
    expect(buildGeminiClipPrompt(geminiJob, geminiScript, geminiScript.segments[0])).toContain(geminiBinding.providerVisualPrompt);
    expect(geminiRequest.segments[0].shotPattern).toEqual(providerRequestFieldsForSegment(geminiScript.segments[0], "gemini-browser").shotPattern);

    const localVideoJob = jobFixture("local-video");
    const localVideoScript = applyShotPatternsToScript(scriptFixture(), localVideoJob, catalog);
    const localVideoRequest = buildLocalVideoRequest(localVideoJob, localVideoScript, "run-shot-pattern");
    expect(localVideoRequest.segments[0].prompt).toBe(localVideoScript.segments[0].shotPattern.providerVisualPrompt);
    expect(localVideoRequest.segments[0].providerVisualPromptHash).toBe(localVideoScript.segments[0].shotPattern.providerVisualPromptHash);
    expect(localVideoRequest.shotPatternPlan).toMatchObject({ providerEligible: true, providerSubmissionPlanned: true, applicationMode: SHOT_PATTERN_PROVIDER_APPLICATION_MODE });
  });

  test("never mixes a vertical camera pattern into a landscape provider request", async () => {
    const catalog = await loadCatalog();
    const landscapeJob = { ...jobFixture("gemini-browser"), format: "landscape" };
    const landscapeSource = scriptFixture();
    landscapeSource.videoFormat = "landscape";
    landscapeSource.segments = landscapeSource.segments.map((segment) => ({
      ...segment,
      visualPrompt: segment.visualPrompt.replace(/^vertical\b/i, "landscape")
    }));
    const landscapeScript = applyShotPatternsToScript(landscapeSource, landscapeJob, catalog);
    for (const segment of landscapeScript.segments) {
      const prompt = buildGeminiClipPrompt(landscapeJob, landscapeScript, segment);
      expect(prompt).toContain("16:9");
      expect(prompt).not.toMatch(/\bvertical\b/i);
      expect(segment.shotPattern.continuityPrompt).toContain("aspect 16:9");
    }

    expect(() => applyShotPatternsToScript(scriptFixture(), landscapeJob, catalog))
      .toThrow("대본 비율이 현재 작업 비율과 일치하지 않습니다");
  });

  test("rejects a local-video completion that does not echo the exact provider prompt binding", async () => {
    const catalog = await loadCatalog();
    const job = jobFixture("local-video");
    const runId = "run-shot-pattern-echo";
    const script = applyShotPatternsToScript(scriptFixture(), job, catalog);
    const scriptHash = hashLocalVideoJson(script);
    const request = buildLocalVideoRequest(job, script, runId, scriptHash);
    const directory = await mkdtemp(join(tmpdir(), "ps4-local-video-echo-"));
    try {
      const clipPath = join(directory, "01.mp4");
      await writeFile(clipPath, "fixture-video-bytes");
      const clipStat = await stat(clipPath);
      const clipHash = await hashFile(clipPath);
      const receipt = {
        schemaVersion: 1,
        status: "completed",
        jobId: job.id,
        runId,
        provider: "local-video",
        model: "fixture-model",
        modelVersion: "1",
        modelId: "fixture-model-v1",
        requestHash: request.requestHash,
        scriptHash,
        segments: script.segments.map((_, index) => ({
          index: index + 1,
          path: "clips/01.mp4",
          bytes: clipStat.size,
          sha256: index === 0 ? clipHash : `sha256:${"0".repeat(64)}`
        }))
      };

      await expect(validateLocalVideoReceipt(
        receipt,
        job,
        script,
        runId,
        request,
        scriptHash,
        request.requestHash,
        directory
      )).rejects.toThrow("실제 provider 요청 echo");

      receipt.request = request;
      await expect(validateLocalVideoReceipt(
        receipt,
        job,
        script,
        runId,
        request,
        scriptHash,
        request.requestHash,
        directory
      )).rejects.toThrow("실제 provider 요청 body 결속");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps plans unsubmitted until provider completion evidence is available", async () => {
    const catalog = await loadCatalog();
    for (const provider of ["gemini-browser", "local-video", "local"]) {
      const job = jobFixture(provider);
      const script = applyShotPatternsToScript(scriptFixture(), job, catalog);
      const planned = createShotPatternReceipt(script, job, "run-shot-pattern");
      const eligible = provider !== "local";
      expect(planned).toMatchObject({ providerEligible: eligible, providerSubmissionPlanned: eligible, submittedToProvider: false, providerRequestHash: null, providerGenerationHash: null });
      expect(planned.applicationMode).toBe(eligible ? SHOT_PATTERN_PROVIDER_APPLICATION_MODE : SHOT_PATTERN_APPLICATION_MODE);
      expect(verifyShotPatternReceipt(planned)).toBe(true);
      if (eligible) {
        const completed = createShotPatternReceipt(script, job, "run-shot-pattern", {
          submittedToProvider: true,
          providerRequestHash: `sha256:${"a".repeat(64)}`,
          providerGenerationHash: `sha256:${"b".repeat(64)}`
        });
        expect(completed.submittedToProvider).toBe(true);
        expect(completed.segments.every((segment) => segment.submittedToProvider === true)).toBe(true);
        expect(completed.receiptHash).toBe(hashShotPatternValue(Object.fromEntries(Object.entries(completed).filter(([key]) => key !== "receiptHash"))));
        expect(verifyShotPatternReceipt(completed)).toBe(true);
      }
    }
  });

  test("keeps legacy scripts outside the new receipt requirement", () => {
    expect(shotPatternRequiredForScript(scriptFixture())).toBe(false);
    expect(shotPatternRequiredForScript({ ...scriptFixture(), shotPatternPlan: {} })).toBe(true);
  });

  test("keeps inherited provider lineage exclusive to explicit schema-2 receipts", async () => {
    const job = jobFixture("gemini-browser");
    const script = applyShotPatternsToScript(scriptFixture(), job, await loadCatalog());
    const evidence = {
      schemaVersion: 1,
      submittedToProvider: true,
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true,
      sourceSubmissionRunId: "source-run",
      sourceGenerationHash: `sha256:${"a".repeat(64)}`,
      providerRequestHash: `sha256:${"b".repeat(64)}`,
      providerGenerationHash: `sha256:${"c".repeat(64)}`
    };
    expect(() => createShotPatternReceipt(script, job, "child-run", evidence)).toThrow("schema-1");

    const schema2 = createShotPatternReceipt(script, job, "child-run", { ...evidence, schemaVersion: 2 });
    expect(verifyShotPatternReceipt(schema2)).toBeTrue();
    for (const field of ["providerRequestSentThisRun", "inheritedProviderSubmission", "sourceSubmissionRunId", "sourceGenerationHash"]) {
      const missingReceiptField = structuredClone(schema2);
      delete missingReceiptField[field];
      missingReceiptField.receiptHash = hashShotPatternValue(Object.fromEntries(Object.entries(missingReceiptField).filter(([key]) => key !== "receiptHash")));
      expect(verifyShotPatternReceipt(missingReceiptField)).toBeFalse();
    }
    const downgraded = structuredClone(schema2);
    downgraded.schemaVersion = 1;
    downgraded.receiptHash = hashShotPatternValue(Object.fromEntries(Object.entries(downgraded).filter(([key]) => key !== "receiptHash")));
    expect(verifyShotPatternReceipt(downgraded)).toBeFalse();
  });

  test("records mixed inherited and current-run submissions per segment without flattening history", async () => {
    const job = { ...jobFixture("gemini-browser"), id: "mixed-job" };
    const base = scriptFixture();
    const script = applyShotPatternsToScript(base, job, await loadCatalog());
    const sourceHash = `sha256:${"d".repeat(64)}`;
    const receipt = createShotPatternReceipt(script, job, "child-run", {
      schemaVersion: 2,
      submittedToProvider: true,
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: true,
      sourceSubmissionRunId: "source-run",
      sourceGenerationHash: sourceHash,
      segmentLineage: [
        {
          index: 1,
          providerRequestSentThisRun: false,
          inheritedProviderSubmission: true,
          submissionRunId: "original-submit-run",
          sourceRunId: "source-run",
          sourceGenerationHash: sourceHash
        },
        {
          index: 2,
          providerRequestSentThisRun: true,
          inheritedProviderSubmission: false,
          submissionRunId: "child-run",
          sourceRunId: null,
          sourceGenerationHash: null
        }
      ],
      providerRequestHash: `sha256:${"e".repeat(64)}`,
      providerGenerationHash: `sha256:${"f".repeat(64)}`
    });
    expect(receipt).toMatchObject({ providerRequestSentThisRun: true, inheritedProviderSubmission: true });
    expect(receipt.segments[0]).toMatchObject({
      providerRequestSentThisRun: false,
      inheritedProviderSubmission: true,
      submissionRunId: "original-submit-run",
      sourceRunId: "source-run",
      sourceSubmissionRunId: "original-submit-run",
      sourceGenerationHash: sourceHash
    });
    expect(receipt.segments[1]).toMatchObject({
      providerRequestSentThisRun: true,
      inheritedProviderSubmission: false,
      submissionRunId: "child-run",
      sourceRunId: null,
      sourceGenerationHash: null
    });
    expect(verifyShotPatternReceipt(receipt)).toBeTrue();

    const flattened = structuredClone(receipt);
    flattened.segments[0].providerRequestSentThisRun = true;
    flattened.receiptHash = hashShotPatternValue(Object.fromEntries(Object.entries(flattened).filter(([key]) => key !== "receiptHash")));
    expect(verifyShotPatternReceipt(flattened)).toBeFalse();
  });

  test("rejects non-official source hosts and rights labels before public projection", async () => {
    const catalog = await loadCatalog();
    const badHost = structuredClone(catalog);
    badHost.sources[0].url = "https://higgsfield.ai.attacker.example/prompt";
    expect(() => validateShotPatternCatalog(badHost)).toThrow("공식 allowlist");
    const badRights = structuredClone(catalog);
    badRights.sources[0].reuse = "public-domain";
    expect(() => validateShotPatternCatalog(badRights)).toThrow("권리 상태");
    const badLicense = structuredClone(catalog);
    badLicense.sources[0].license = "<img src=x onerror=alert(1)>";
    expect(() => validateShotPatternCatalog(badLicense)).toThrow("license");
  });

  test("renders only allowlisted source links and fixed rights labels", () => {
    const markup = shotPatternsMarkup({ patterns: [{
      role: "camera",
      labelKo: "<img src=x onerror=alert(1)>",
      goal: "<script>alert(1)</script>",
      rights: { code: "<bad>", label: "<svg onload=alert(1)>" },
      sources: [
        { url: "javascript:alert(1)", publisher: "<bad>", license: "<bad>" },
        { url: "https://higgsfield.ai.attacker.example/prompt", publisher: "<bad>", license: "MIT" },
        { url: "https://higgsfield.ai/academy", publisher: "<bad>", license: "MIT" }
      ]
    }] });
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("rights-reference-only");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("attacker.example");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("https://higgsfield.ai/academy");
    expect(markup).not.toContain("SENT TO PROVIDER");
    const assemblyMarkup = shotPatternsMarkup({ patterns: [{
      role: "assembly",
      labelKo: "내레이션·시각 페어",
      goal: "Local assembly reference only",
      rights: { code: "reference-only" },
      sources: []
    }] });
    expect(assemblyMarkup).toContain("REFERENCE ASSEMBLY · NOT SENT TO PROVIDER");
    expect(safeShotPatternSourceUrl("https://github.com/higgsfield-ai/skills/blob/commit/LICENSE")).toStartWith("https://github.com/");
    expect(safeShotPatternSourceUrl("https://github.com/other/repo")).toBeNull();
  });

  test("fails receipt verification after provider prompt or hash mutation", async () => {
    const catalog = await loadCatalog();
    const job = jobFixture("gemini-browser");
    const script = applyShotPatternsToScript(scriptFixture(), job, catalog);
    const receipt = createShotPatternReceipt(script, job, "run-shot-pattern");
    const mutatedPrompt = structuredClone(receipt);
    mutatedPrompt.segments[0].providerVisualPrompt += " invented fact";
    expect(verifyShotPatternReceipt(mutatedPrompt)).toBe(false);
    const mutatedHash = structuredClone(receipt);
    mutatedHash.segments[0].providerVisualPromptHash = hashShotPatternValue("forged");
    expect(verifyShotPatternReceipt(mutatedHash)).toBe(false);
  });

  test("can be copied into the same immutable artifact shape used by run finalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ps4-shot-pattern-artifact-"));
    try {
      const runId = "run-shot-pattern";
      const job = jobFixture("gemini-browser");
      const script = applyShotPatternsToScript(scriptFixture(), job, await loadCatalog());
      const receipt = createShotPatternReceipt(script, job, runId);
      const name = `runs/${runId}/shot-pattern-receipt.json`;
      const source = join(directory, name);
      await mkdir(join(directory, "runs", runId), { recursive: true });
      await writeFile(source, JSON.stringify(receipt, null, 2));
      const declaration = (await artifactReceipt(directory, [{ name, kind: "shot-pattern-receipt" }]))[0];
      const snapshotName = name.replace(/[^A-Za-z0-9._-]+/g, "__");
      const snapshot = join(directory, "runs", runId, "artifacts", snapshotName);
      await mkdir(join(directory, "runs", runId, "artifacts"), { recursive: true });
      await Bun.write(snapshot, Bun.file(source));

      expect(declaration).toMatchObject({ path: name, kind: "shot-pattern-receipt", sha256: await hashFile(source) });
      expect((await stat(snapshot)).size).toBe((await stat(source)).size);
      expect(await hashFile(snapshot)).toBe(declaration.sha256);
      expect(`runs/${runId}/artifacts/${snapshotName}`).toBe(`runs/${runId}/artifacts/runs__${runId}__shot-pattern-receipt.json`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
