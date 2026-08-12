import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CATALOG_PATH = join(import.meta.dirname, "..", "data", "higgsfield-prompt-patterns.json");
const CAMERA_PATTERN_IDS = Object.freeze([
  "shorts-curiosity-proof",
  "locked-static-evidence",
  "pan-discovery",
  "dolly-depth-reveal",
  "lateral-parallax-follow",
  "focus-handoff"
]);
const CONTINUITY_PATTERN_ID = "continuity-contract";
const ASSEMBLY_PATTERN_ID = "narration-visual-pair";
const ALGORITHM = "deterministic-provider-neutral-shot-patterns/v1";
const APPLICATION_MODE = "metadata-only-extractive-safe";
const PROVIDER_APPLICATION_MODE = "provider-camera-continuity-suffix/v1";
const GENERATION_PROVIDERS = new Set(["gemini-browser", "local-video"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function hashShotPatternValue(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`shot pattern catalog 필드가 없습니다: ${label}`);
  return value.trim();
}

function safeSourceUrl(value, label) {
  const parsed = new URL(requiredString(value, label));
  if (parsed.protocol !== "https:") throw new Error(`shot pattern 출처는 HTTPS여야 합니다: ${label}`);
  const officialHiggsfield = parsed.hostname === "higgsfield.ai";
  const officialSkills = parsed.hostname === "github.com" && parsed.pathname.startsWith("/higgsfield-ai/skills/");
  if (!officialHiggsfield && !officialSkills) throw new Error(`shot pattern 출처 host가 공식 allowlist에 없습니다: ${label}`);
  return parsed.toString();
}

export function validateShotPatternCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("shot pattern catalog가 객체가 아닙니다.");
  if (catalog.schemaVersion !== 1) throw new Error("shot pattern catalog schemaVersion이 지원되지 않습니다.");
  requiredString(catalog.catalogId, "catalogId");
  if (!Array.isArray(catalog.sources) || !catalog.sources.length) throw new Error("shot pattern catalog 출처가 없습니다.");
  if (!Array.isArray(catalog.patterns) || !catalog.patterns.length) throw new Error("shot pattern catalog 패턴이 없습니다.");

  const sources = new Map();
  for (const source of catalog.sources) {
    const id = requiredString(source?.id, "sources[].id");
    if (sources.has(id)) throw new Error(`shot pattern catalog 출처 ID가 중복됩니다: ${id}`);
    const url = safeSourceUrl(source.url, `${id}.url`);
    const reuse = requiredString(source.reuse, `${id}.reuse`);
    if (!["commercial-use-permitted-under-mit", "reference-only-no-verbatim-text-or-assets"].includes(reuse)) {
      throw new Error(`shot pattern catalog 출처 권리 상태가 허용되지 않습니다: ${id}`);
    }
    if (source.publisher !== "Higgsfield AI") throw new Error(`shot pattern catalog publisher가 공식 allowlist와 다릅니다: ${id}`);
    const expectedLicense = reuse === "commercial-use-permitted-under-mit" ? "MIT" : "no-redistribution-license-found";
    if (source.license !== expectedLicense) throw new Error(`shot pattern catalog license가 권리 상태와 일치하지 않습니다: ${id}`);
    sources.set(id, { ...source, id, url, reuse });
  }

  const patterns = new Map();
  for (const pattern of catalog.patterns) {
    const id = requiredString(pattern?.id, "patterns[].id");
    if (patterns.has(id)) throw new Error(`shot pattern ID가 중복됩니다: ${id}`);
    requiredString(pattern.labelKo, `${id}.labelKo`);
    requiredString(pattern.goal, `${id}.goal`);
    requiredString(pattern.template, `${id}.template`);
    if (!Array.isArray(pattern.variables) || !pattern.variables.length) throw new Error(`shot pattern 변수가 없습니다: ${id}`);
    if (new Set(pattern.variables).size !== pattern.variables.length) throw new Error(`shot pattern 변수가 중복됩니다: ${id}`);
    if (!Array.isArray(pattern.sourceIds) || !pattern.sourceIds.length || pattern.sourceIds.some((sourceId) => !sources.has(sourceId))) {
      throw new Error(`shot pattern 출처 결속이 유효하지 않습니다: ${id}`);
    }
    if (new Set(pattern.receiptFields || []).size !== (pattern.receiptFields || []).length) {
      throw new Error(`shot pattern receipt 필드가 중복됩니다: ${id}`);
    }
    patterns.set(id, pattern);
  }

  for (const id of [...CAMERA_PATTERN_IDS, CONTINUITY_PATTERN_ID, ASSEMBLY_PATTERN_ID]) {
    if (!patterns.has(id)) throw new Error(`필수 shot pattern이 없습니다: ${id}`);
  }
  return { catalog, sources, patterns, catalogHash: hashShotPatternValue(catalog) };
}

export async function readShotPatternCatalog(path = CATALOG_PATH) {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  return validateShotPatternCatalog(catalog).catalog;
}

function patternRights(pattern, sources) {
  const attached = pattern.sourceIds.map((sourceId) => sources.get(sourceId));
  const mit = attached.some((source) => source.reuse === "commercial-use-permitted-under-mit");
  const referenceOnly = attached.some((source) => source.reuse === "reference-only-no-verbatim-text-or-assets");
  return {
    code: mit && referenceOnly ? "mixed" : mit ? "mit-adaptable" : "reference-only",
    label: mit && referenceOnly ? "MIT adaptable · reference only" : mit ? "MIT adaptable" : "reference only"
  };
}

function sourceLinks(pattern, sources) {
  return pattern.sourceIds.map((sourceId) => {
    const source = sources.get(sourceId);
    return {
      id: source.id,
      publisher: source.publisher,
      url: source.url,
      license: source.license,
      reuse: source.reuse
    };
  });
}

export function publicShotPatternCatalog(catalog) {
  const validated = validateShotPatternCatalog(catalog);
  return {
    schemaVersion: 1,
    catalogId: catalog.catalogId,
    catalogHash: validated.catalogHash,
    observedAt: catalog.observedAt,
    usage: {
      mode: PROVIDER_APPLICATION_MODE,
      runSubmissionState: "각 run 영수증에서 별도 검증",
      catalogResearch: {
        providerCallsMade: catalog.policy?.providerCallsMade === true,
        generationSpend: catalog.policy?.generationSpend === true,
        remoteAssetsCopiedIntoProject: catalog.policy?.remoteAssetsCopiedIntoProject === true
      },
      notice: "위 호출·지출 값은 카탈로그 연구 과정에만 적용됩니다. 실제 영상 생성 제출 여부는 각 run 영수증에서 검증합니다. 웹 자료는 출처 링크로만 참조하며 원격 레슨 미디어·프롬프트·에셋을 복제하지 않습니다."
    },
    patterns: [...CAMERA_PATTERN_IDS, CONTINUITY_PATTERN_ID, ASSEMBLY_PATTERN_ID].map((id) => {
      const pattern = validated.patterns.get(id);
      return {
        id,
        labelKo: pattern.labelKo,
        goal: pattern.goal,
        role: id === CONTINUITY_PATTERN_ID ? "continuity" : id === ASSEMBLY_PATTERN_ID ? "assembly" : "camera",
        rights: patternRights(pattern, validated.sources),
        sources: sourceLinks(pattern, validated.sources)
      };
    })
  };
}

function renderTemplate(pattern, variables) {
  const rendered = pattern.template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key) => {
    const value = variables[key];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`${pattern.id}의 안전한 렌더 변수 ${key}가 없습니다.`);
    return String(value);
  });
  if (/\{[A-Za-z][A-Za-z0-9]*\}/.test(rendered)) throw new Error(`${pattern.id} 렌더 결과에 미해결 변수가 남았습니다.`);
  return rendered;
}

function applicationMode(provider) {
  return GENERATION_PROVIDERS.has(provider) ? PROVIDER_APPLICATION_MODE : APPLICATION_MODE;
}

export function composeProviderVisualPrompt(visualPrompt, cameraPrompt, continuityPrompt) {
  const evidencePrompt = requiredString(visualPrompt, "visualPrompt");
  const camera = requiredString(cameraPrompt, "cameraPrompt");
  const continuity = requiredString(continuityPrompt, "continuityPrompt");
  return `${evidencePrompt}\nCamera-only direction (do not add facts or text): ${camera}\nContinuity-only contract (do not add facts or text): ${continuity}`;
}

export function providerPromptBindingForSegment(segment, provider) {
  const visualPrompt = requiredString(segment?.visualPrompt, "segment.visualPrompt");
  const shotPattern = segment?.shotPattern;
  if (!shotPattern) {
    return {
      providerVisualPrompt: visualPrompt,
      providerVisualPromptHash: hashShotPatternValue(visualPrompt),
      shotPattern: null,
      legacy: true
    };
  }
  const expectedEligible = GENERATION_PROVIDERS.has(provider);
  const expectedMode = applicationMode(provider);
  const providerVisualPrompt = composeProviderVisualPrompt(visualPrompt, shotPattern.renderedPrompt, shotPattern.continuityPrompt);
  if (shotPattern.providerVisualPrompt !== providerVisualPrompt) throw new Error("shot pattern providerVisualPrompt가 evidence·카메라·연속성 계약과 일치하지 않습니다.");
  if (shotPattern.providerVisualPromptHash !== hashShotPatternValue(providerVisualPrompt)) throw new Error("shot pattern providerVisualPrompt 해시가 유효하지 않습니다.");
  if (shotPattern.providerEligible !== expectedEligible || shotPattern.providerSubmissionPlanned !== expectedEligible || shotPattern.applicationMode !== expectedMode) {
    throw new Error(`shot pattern provider 적용 상태가 ${provider} 실행과 일치하지 않습니다.`);
  }
  return {
    providerVisualPrompt,
    providerVisualPromptHash: shotPattern.providerVisualPromptHash,
    shotPattern: {
      patternId: shotPattern.patternId,
      sourceUrls: shotPattern.sourceUrls,
      renderedCameraPromptHash: shotPattern.renderedPromptHash,
      continuityContractHash: shotPattern.continuityContractHash,
      applicationMode: shotPattern.applicationMode,
      providerEligible: shotPattern.providerEligible,
      providerSubmissionPlanned: shotPattern.providerSubmissionPlanned,
      factualTextAdded: false
    },
    legacy: false
  };
}

export function providerRequestFieldsForSegment(segment, provider) {
  if (!segment?.shotPattern) return {};
  const binding = providerPromptBindingForSegment(segment, provider);
  return {
    providerVisualPrompt: binding.providerVisualPrompt,
    providerVisualPromptHash: binding.providerVisualPromptHash,
    shotPattern: binding.shotPattern
  };
}

export function buildGeminiClipPrompt(job, script, segment) {
  const { providerVisualPrompt } = providerPromptBindingForSegment(segment, "gemini-browser");
  const format = job?.format === "vertical" ? "vertical 9:16" : "16:9";
  const duration = segment?.durationHint || Math.round(Number(job?.targetDurationSec || 0) / Math.max(1, script?.segments?.length || 1));
  return `Create a ${format} cinematic documentary video clip, exactly about ${duration} seconds. ${providerVisualPrompt}. Keep the subject physically plausible and visually consistent across clips. Use the same camera language, color grade, subject identity, and documentary pacing as the other clips. No on-screen text, no subtitles, and no third-party logos. Retain any provider-required provenance mark. Korean documentary mood.`;
}

function aspectRatio(format) {
  return format === "landscape" ? "16:9" : "9:16";
}

function continuityVariables(job) {
  return {
    aspectRatio: aspectRatio(job?.format),
    palette: "neutral documentary palette",
    lightingDirection: "consistent soft side key",
    lensFamily: "moderate wide documentary lens family",
    texture: "natural documentary finish",
    subjectIdentity: "preserve only the evidence-bound subject definition and infer no new attributes",
    audioPolicy: "subtle ambient sound only; narration and captions are added during local assembly"
  };
}

function cameraVariables(patternId, segment, index, job) {
  const durationSeconds = Math.max(1, Number(segment.durationHint) || Math.round(Number(job?.targetDurationSec || 10) / Math.max(1, Number(job?.clipCount || 1))));
  const direction = index % 2 === 0 ? "right" : "left";
  return {
    aspectRatio: aspectRatio(job?.format),
    durationSeconds,
    surprisingDetail: "the single evidence-bound detail stated above",
    setting: "the evidence-bound setting with no inferred additions",
    proofAction: "the evidence-bound physical relationship only",
    cameraMove: "slow controlled reveal",
    lighting: "a neutral soft side key kept consistent across clips",
    ambientAudio: "subtle location ambience only, with no speech",
    subject: "the evidence-bound subject",
    action: "the evidence-bound physical action only",
    shotScale: "medium-detail documentary",
    openingClue: "the evidence-bound clue",
    environment: "the evidence-bound environment only",
    landingSubject: "the same evidence-bound subject",
    direction,
    speed: "slow and even",
    endHoldSeconds: 1,
    startDistance: "a contextual medium distance",
    endDistance: "a closer evidence view",
    lens: "moderate wide-angle documentary",
    foregroundLayers: "existing evidence-bound foreground layers only",
    movementSpeed: "slow and even",
    subjectAction: "performs only the evidence-bound action",
    nearLayer: "an existing evidence-bound near layer",
    middleLayer: "the evidence-bound subject plane",
    farLayer: "an existing evidence-bound far layer",
    contextPlane: "the evidence-bound context plane",
    evidencePlane: "the evidence-bound detail plane",
    holdBeforeSeconds: 1,
    focusShiftSeconds: 1,
    holdAfterSeconds: 1,
    patternId
  };
}

function selectionOffset(script, catalogId) {
  const seed = hashShotPatternValue({
    catalogId,
    evidenceTextBindingHash: script?.evidenceTextBindingHash || null,
    claimIds: (script?.segments || []).map((segment) => segment.claimId || null)
  }).slice("sha256:".length, "sha256:".length + 8);
  return Number.parseInt(seed, 16) % CAMERA_PATTERN_IDS.length;
}

export function applyShotPatternsToScript(script, job, catalog) {
  if (!script || !Array.isArray(script.segments) || !script.segments.length) throw new Error("shot pattern을 적용할 대본 장면이 없습니다.");
  const expectedVideoFormat = job?.format === "landscape" ? "landscape" : "vertical";
  const promptFormats = [...new Set(script.segments.map((segment) => {
    const prompt = String(segment?.visualPrompt || "").trim();
    if (/^vertical\b/i.test(prompt)) return "vertical";
    if (/^landscape\b/i.test(prompt)) return "landscape";
    return null;
  }).filter(Boolean))];
  const declaredVideoFormat = script.videoFormat || (promptFormats.length === 1 ? promptFormats[0] : null);
  if (promptFormats.length > 1 || (declaredVideoFormat && declaredVideoFormat !== expectedVideoFormat)) {
    throw new Error("shot pattern 대본 비율이 현재 작업 비율과 일치하지 않습니다.");
  }
  const validated = validateShotPatternCatalog(catalog);
  const continuityPattern = validated.patterns.get(CONTINUITY_PATTERN_ID);
  const renderedContinuity = renderTemplate(continuityPattern, continuityVariables(job));
  const continuityContract = {
    patternId: CONTINUITY_PATTERN_ID,
    labelKo: continuityPattern.labelKo,
    sourceUrls: sourceLinks(continuityPattern, validated.sources).map((source) => source.url),
    rights: patternRights(continuityPattern, validated.sources),
    renderedPrompt: renderedContinuity,
    renderedPromptHash: hashShotPatternValue(renderedContinuity),
    factualTextAdded: false
  };
  const continuityContractHash = hashShotPatternValue(continuityContract);
  const providerEligible = GENERATION_PROVIDERS.has(job?.provider);
  const selectedApplicationMode = applicationMode(job?.provider);
  const offset = selectionOffset(script, catalog.catalogId);
  const originalVisualPrompts = script.segments.map((segment) => segment.visualPrompt);
  const segments = script.segments.map((segment, index) => {
    const patternId = CAMERA_PATTERN_IDS[(offset + index) % CAMERA_PATTERN_IDS.length];
    const pattern = validated.patterns.get(patternId);
    const renderedPrompt = renderTemplate(pattern, cameraVariables(patternId, segment, index, job));
    const providerVisualPrompt = composeProviderVisualPrompt(segment.visualPrompt, renderedPrompt, renderedContinuity);
    return {
      ...segment,
      shotPattern: {
        schemaVersion: 1,
        patternId,
        labelKo: pattern.labelKo,
        goal: pattern.goal,
        sourceUrls: sourceLinks(pattern, validated.sources).map((source) => source.url),
        rights: patternRights(pattern, validated.sources),
        renderedPrompt,
        renderedPromptHash: hashShotPatternValue(renderedPrompt),
        continuityPrompt: renderedContinuity,
        continuityContractHash,
        providerVisualPrompt,
        providerVisualPromptHash: hashShotPatternValue(providerVisualPrompt),
        applicationMode: selectedApplicationMode,
        providerEligible,
        providerSubmissionPlanned: providerEligible,
        factualTextAdded: false,
        bindingReason: "visualPrompt remains the exact deterministic-extractive-binding/v3 evidence template; only camera and continuity directions are appended in providerVisualPrompt"
      }
    };
  });
  if (segments.some((segment, index) => segment.visualPrompt !== originalVisualPrompts[index])) {
    throw new Error("shot pattern 계획이 evidence-bound visualPrompt를 변경했습니다.");
  }
  const plan = {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    catalogId: catalog.catalogId,
    catalogHash: validated.catalogHash,
    applicationMode: selectedApplicationMode,
    providerEligible,
    providerSubmissionPlanned: providerEligible,
    visualPromptContract: "deterministic-extractive-binding/v3-immutable",
    providerPromptContract: PROVIDER_APPLICATION_MODE,
    continuityContract,
    continuityContractHash,
    segmentCount: segments.length,
    segments: segments.map((segment, index) => ({
      index: index + 1,
      claimId: segment.claimId || null,
      visualPromptHash: hashShotPatternValue(originalVisualPrompts[index]),
      patternId: segment.shotPattern.patternId,
      sourceUrls: segment.shotPattern.sourceUrls,
      renderedPromptHash: segment.shotPattern.renderedPromptHash,
      providerVisualPromptHash: segment.shotPattern.providerVisualPromptHash,
      continuityContractHash
    }))
  };
  const planHash = hashShotPatternValue(plan);
  return {
    ...script,
    shotPatternPlan: { ...plan, planHash },
    segments
  };
}

export function createShotPatternReceipt(script, job, runId, providerEvidence = {}) {
  const schemaVersion = providerEvidence.schemaVersion === 1 ? 1 : 2;
  const plan = script?.shotPatternPlan;
  if (!plan || plan.planHash !== hashShotPatternValue(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planHash")))) {
    throw new Error("shot pattern plan 해시가 유효하지 않습니다.");
  }
  if (!Array.isArray(script.segments) || script.segments.length !== plan.segmentCount) throw new Error("shot pattern 장면 수가 대본과 다릅니다.");
  const submittedToProvider = providerEvidence.submittedToProvider === true;
  const inheritedProviderSubmission = providerEvidence.inheritedProviderSubmission === true;
  const providerRequestSentThisRun = providerEvidence.providerRequestSentThisRun === undefined
    ? submittedToProvider && !inheritedProviderSubmission
    : providerEvidence.providerRequestSentThisRun === true;
  const sourceSubmissionRunId = providerEvidence.sourceSubmissionRunId || null;
  const sourceGenerationHash = providerEvidence.sourceGenerationHash || null;
  if (schemaVersion === 1 && (
    inheritedProviderSubmission
    || providerEvidence.providerRequestSentThisRun !== undefined
    || providerEvidence.sourceSubmissionRunId !== undefined
    || providerEvidence.sourceGenerationHash !== undefined
  )) throw new Error("schema-1 shot pattern 영수증에는 provider 상속 lineage를 기록할 수 없습니다.");
  if (submittedToProvider && (!plan.providerEligible || !plan.providerSubmissionPlanned)) throw new Error("provider 제출은 생성 가능한 shot pattern 계획에서만 봉인할 수 있습니다.");
  const providerRequestHash = providerEvidence.providerRequestHash || null;
  const providerGenerationHash = providerEvidence.providerGenerationHash || null;
  if (submittedToProvider && (!/^sha256:[a-f0-9]{64}$/u.test(String(providerRequestHash || "")) || !/^sha256:[a-f0-9]{64}$/u.test(String(providerGenerationHash || "")))) {
    throw new Error("실제 provider 제출 봉인에는 요청 해시와 완료 generation 영수증 해시가 필요합니다.");
  }
  if (!submittedToProvider && (providerRequestHash || providerGenerationHash)) throw new Error("미제출 shot pattern 영수증에는 provider 완료 증거를 넣을 수 없습니다.");
  if (inheritedProviderSubmission) {
    if (!submittedToProvider || providerRequestSentThisRun || !requiredString(sourceSubmissionRunId, "sourceSubmissionRunId") || !/^sha256:[a-f0-9]{64}$/u.test(String(sourceGenerationHash || ""))) {
      throw new Error("상속 provider 제출 영수증은 source run·generation 해시와 이번 run 요청 0회에 결속되어야 합니다.");
    }
  } else if (sourceSubmissionRunId || sourceGenerationHash || providerRequestSentThisRun !== submittedToProvider) {
    throw new Error("직접 provider 제출 영수증의 이번 run 요청·source lineage가 일치하지 않습니다.");
  }
  const segments = script.segments.map((segment, index) => {
    const planned = plan.segments[index];
    const providerBinding = providerPromptBindingForSegment(segment, job?.provider);
    if (!segment.shotPattern || segment.shotPattern.patternId !== planned.patternId) throw new Error(`${index + 1}번 shot pattern이 계획과 다릅니다.`);
    if (segment.shotPattern.renderedPromptHash !== hashShotPatternValue(segment.shotPattern.renderedPrompt)) throw new Error(`${index + 1}번 shot pattern 렌더 해시가 유효하지 않습니다.`);
    if (segment.visualPrompt !== undefined && planned.visualPromptHash !== hashShotPatternValue(segment.visualPrompt)) throw new Error(`${index + 1}번 evidence visualPrompt 해시가 계획과 다릅니다.`);
    if (planned.providerVisualPromptHash !== providerBinding.providerVisualPromptHash) throw new Error(`${index + 1}번 providerVisualPrompt 해시가 계획과 다릅니다.`);
    if (segment.shotPattern.continuityContractHash !== plan.continuityContractHash) throw new Error(`${index + 1}번 연속성 계약 해시가 계획과 다릅니다.`);
    return {
      index: index + 1,
      claimId: segment.claimId || null,
      patternId: segment.shotPattern.patternId,
      sourceUrls: segment.shotPattern.sourceUrls,
      rights: segment.shotPattern.rights,
      renderedPrompt: segment.shotPattern.renderedPrompt,
      renderedPromptHash: segment.shotPattern.renderedPromptHash,
      continuityPrompt: segment.shotPattern.continuityPrompt,
      visualPrompt: segment.visualPrompt,
      visualPromptHash: planned.visualPromptHash,
      providerVisualPrompt: providerBinding.providerVisualPrompt,
      providerVisualPromptHash: providerBinding.providerVisualPromptHash,
      continuityContractHash: plan.continuityContractHash,
      applicationMode: plan.applicationMode,
      providerEligible: plan.providerEligible,
      providerSubmissionPlanned: plan.providerSubmissionPlanned,
      submittedToProvider,
      ...(schemaVersion >= 2 ? {
        providerRequestSentThisRun,
        inheritedProviderSubmission,
        sourceSubmissionRunId,
        sourceGenerationHash
      } : {}),
      providerRequestHash,
      factualTextAdded: false
    };
  });
  const receipt = {
    schemaVersion,
    algorithm: ALGORITHM,
    status: "sealed",
    jobId: requiredString(job?.id, "jobId"),
    runId: requiredString(runId, "runId"),
    provider: requiredString(job?.provider, "provider"),
    catalogId: plan.catalogId,
    catalogHash: plan.catalogHash,
    planHash: plan.planHash,
    evidenceTextBindingHash: script.evidenceTextBindingHash || null,
    visualPromptContract: plan.visualPromptContract,
    providerPromptContract: plan.providerPromptContract,
    applicationMode: plan.applicationMode,
    providerEligible: plan.providerEligible,
    providerSubmissionPlanned: plan.providerSubmissionPlanned,
    submittedToProvider,
    ...(schemaVersion >= 2 ? {
      providerRequestSentThisRun,
      inheritedProviderSubmission,
      sourceSubmissionRunId,
      sourceGenerationHash
    } : {}),
    providerRequestHash,
    providerGenerationHash,
    continuityContract: plan.continuityContract,
    continuityContractHash: plan.continuityContractHash,
    segmentCount: plan.segmentCount,
    segments
  };
  return { ...receipt, receiptHash: hashShotPatternValue(receipt) };
}

export function verifyShotPatternReceipt(receipt) {
  if (!receipt || ![1, 2].includes(receipt.schemaVersion) || receipt.status !== "sealed" || receipt.algorithm !== ALGORITHM) return false;
  const { receiptHash, ...payload } = receipt;
  if (receiptHash !== hashShotPatternValue(payload)) return false;
  if (receipt.continuityContractHash !== hashShotPatternValue(receipt.continuityContract)) return false;
  const expectedEligible = GENERATION_PROVIDERS.has(receipt.provider);
  const expectedMode = applicationMode(receipt.provider);
  const schema2Fields = ["providerRequestSentThisRun", "inheritedProviderSubmission", "sourceSubmissionRunId", "sourceGenerationHash"];
  const schemaFieldsValid = receipt.schemaVersion === 2
    ? schema2Fields.every((field) => Object.hasOwn(receipt, field))
      && typeof receipt.providerRequestSentThisRun === "boolean"
      && typeof receipt.inheritedProviderSubmission === "boolean"
    : schema2Fields.every((field) => !Object.hasOwn(receipt, field));
  if (!schemaFieldsValid) return false;
  const inheritedProviderSubmission = receipt.inheritedProviderSubmission === true;
  const providerRequestSentThisRun = receipt.providerRequestSentThisRun === undefined
    ? receipt.submittedToProvider === true
    : receipt.providerRequestSentThisRun === true;
  const lineageValid = inheritedProviderSubmission
    ? receipt.submittedToProvider === true
      && providerRequestSentThisRun === false
      && typeof receipt.sourceSubmissionRunId === "string"
      && Boolean(receipt.sourceSubmissionRunId)
      && /^sha256:[a-f0-9]{64}$/u.test(String(receipt.sourceGenerationHash || ""))
    : providerRequestSentThisRun === (receipt.submittedToProvider === true)
      && (receipt.sourceSubmissionRunId == null)
      && (receipt.sourceGenerationHash == null);
  const submissionEvidenceValid = receipt.submittedToProvider
    ? expectedEligible
      && /^sha256:[a-f0-9]{64}$/u.test(String(receipt.providerRequestHash || ""))
      && /^sha256:[a-f0-9]{64}$/u.test(String(receipt.providerGenerationHash || ""))
    : receipt.providerRequestHash === null && receipt.providerGenerationHash === null;
  return receipt.providerEligible === expectedEligible
    && receipt.providerSubmissionPlanned === expectedEligible
    && submissionEvidenceValid
    && lineageValid
    && receipt.applicationMode === expectedMode
    && Array.isArray(receipt.segments)
    && Number.isInteger(receipt.segmentCount)
    && receipt.segmentCount > 0
    && receipt.segments.length === receipt.segmentCount
    && receipt.segments.every((segment, index) => (
      (receipt.schemaVersion === 2
        ? schema2Fields.every((field) => Object.hasOwn(segment, field))
          && typeof segment.providerRequestSentThisRun === "boolean"
          && typeof segment.inheritedProviderSubmission === "boolean"
        : schema2Fields.every((field) => !Object.hasOwn(segment, field)))
      &&
      segment.index === index + 1
      && segment.renderedPromptHash === hashShotPatternValue(segment.renderedPrompt)
      && segment.visualPromptHash === hashShotPatternValue(segment.visualPrompt)
      && segment.providerVisualPrompt === composeProviderVisualPrompt(segment.visualPrompt, segment.renderedPrompt, segment.continuityPrompt)
      && segment.providerVisualPromptHash === hashShotPatternValue(segment.providerVisualPrompt)
      && segment.continuityContractHash === receipt.continuityContractHash
      && segment.applicationMode === expectedMode
      && segment.providerEligible === expectedEligible
      && segment.providerSubmissionPlanned === expectedEligible
      && segment.submittedToProvider === receipt.submittedToProvider
      && (segment.providerRequestSentThisRun === undefined ? segment.submittedToProvider === true : segment.providerRequestSentThisRun === true) === providerRequestSentThisRun
      && (segment.inheritedProviderSubmission === true) === inheritedProviderSubmission
      && (segment.sourceSubmissionRunId ?? null) === (receipt.sourceSubmissionRunId ?? null)
      && (segment.sourceGenerationHash ?? null) === (receipt.sourceGenerationHash ?? null)
      && segment.providerRequestHash === receipt.providerRequestHash
      && segment.factualTextAdded === false
    ));
}

export function shotPatternRequiredForScript(script) {
  return Boolean(script?.shotPatternPlan);
}

export { ALGORITHM as SHOT_PATTERN_ALGORITHM, APPLICATION_MODE as SHOT_PATTERN_APPLICATION_MODE, PROVIDER_APPLICATION_MODE as SHOT_PATTERN_PROVIDER_APPLICATION_MODE, CAMERA_PATTERN_IDS, CATALOG_PATH as SHOT_PATTERN_CATALOG_PATH };
