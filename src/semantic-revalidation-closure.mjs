import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { LOCAL_SEMANTIC_POLICY_BINDING } from "./local-semantic-verifier.mjs";
import { canonicalJsonHash } from "./provenance.mjs";
import { hashFile } from "./run-ledger.mjs";

export const SEMANTIC_REVALIDATION_MODE = "sealed-gemini-local-semantic-revalidation/v1";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,160}$/;

export function exactSemanticRevalidationPolicy(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "hash,name,version"
    && value.name === LOCAL_SEMANTIC_POLICY_BINDING.name
    && value.version === LOCAL_SEMANTIC_POLICY_BINDING.version
    && value.hash === LOCAL_SEMANTIC_POLICY_BINDING.hash
  );
}

export async function loadSemanticRevalidationSource(jobDir, manifest) {
  const declaration = manifest?.semanticRevalidation;
  if (!declaration) return null;
  const sourceRunId = String(declaration.sourceRunId || "");
  if (!RUN_ID_PATTERN.test(sourceRunId) || sourceRunId !== manifest.parentRunId) throw new Error("semantic child의 source/parent run 결속이 유효하지 않습니다.");
  const jobRoot = resolve(jobDir);
  const sourceManifestPath = resolve(jobRoot, "runs", sourceRunId, "manifest.json");
  if (!sourceManifestPath.startsWith(`${jobRoot}${sep}`)) throw new Error("semantic child source manifest 경로가 안전하지 않습니다.");
  const sourceManifestHash = await hashFile(sourceManifestPath).catch(() => null);
  if (sourceManifestHash !== declaration.parentManifestHash) throw new Error("semantic child parent manifest 해시가 현재 봉인 원본과 다릅니다.");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  if (
    sourceManifest.jobId !== manifest.jobId
    || sourceManifest.runId !== sourceRunId
    || sourceManifest.status !== "needs-improvement"
    || sourceManifest.runStatus !== "needs-improvement"
    || sourceManifest.request?.provider !== "gemini-browser"
    || canonicalJsonHash(sourceManifest.immutableArtifacts) !== declaration.sourceImmutableArtifactsHash
  ) throw new Error("semantic child parent manifest의 봉인 상태·provider·artifact closure가 유효하지 않습니다.");
  const generationDeclaration = (sourceManifest.immutableArtifacts || []).find((artifact) => artifact?.name === "gemini-generation.json");
  if (
    !generationDeclaration
    || declaration.sourceProviderProvenance?.path !== generationDeclaration.path
    || declaration.sourceProviderProvenance?.sha256 !== generationDeclaration.sha256
  ) throw new Error("semantic child의 source provider provenance가 parent immutable generation과 다릅니다.");
  const sourceGenerationPath = resolve(jobRoot, generationDeclaration.path);
  if (!sourceGenerationPath.startsWith(`${jobRoot}${sep}`)) throw new Error("semantic child source generation 경로가 안전하지 않습니다.");
  const sourceGenerationStat = await stat(sourceGenerationPath).catch(() => null);
  if (
    !sourceGenerationStat?.isFile()
    || Number(generationDeclaration.bytes) !== sourceGenerationStat.size
    || await hashFile(sourceGenerationPath).catch(() => null) !== generationDeclaration.sha256
  ) throw new Error("semantic child source generation immutable 바이트가 선언과 다릅니다.");
  const sourceGeneration = JSON.parse(await readFile(sourceGenerationPath, "utf8"));
  return {
    sourceRunId,
    sourceManifest,
    sourceManifestHash,
    sourceGeneration,
    sourceGenerationFileHash: generationDeclaration.sha256,
    sourceGenerationHash: canonicalJsonHash(sourceGeneration)
  };
}

export function verifySemanticRevalidationProviderZeroBinding({
  jobId,
  runId,
  manifest,
  generation,
  childGenerationFileHash,
  shotPatternReceipt,
  source
}) {
  if (!manifest?.semanticRevalidation) return { required: false, verified: true, blockers: [] };
  const blockers = [];
  const declaration = manifest.semanticRevalidation;
  const sourceSegments = Array.isArray(source?.sourceGeneration?.segments) ? source.sourceGeneration.segments : [];
  const childSegments = Array.isArray(generation?.segments) ? generation.segments : [];
  const exactDeclaration = Boolean(
    declaration.schemaVersion === 1
    && declaration.mode === SEMANTIC_REVALIDATION_MODE
    && declaration.sourceRunId === source?.sourceRunId
    && declaration.parentManifestHash === source?.sourceManifestHash
    && declaration.sourceImmutableArtifactsHash === canonicalJsonHash(source?.sourceManifest?.immutableArtifacts)
    && declaration.sourceProviderProvenance?.sha256 === source?.sourceGenerationFileHash
    && exactSemanticRevalidationPolicy(declaration.semanticPolicy)
    && declaration.providerRequestPolicy?.allowed === false
    && declaration.providerRequestPolicy?.maximumCalls === 0
    && declaration.providerRequestSent === false
    && declaration.childGenerationHash === canonicalJsonHash(generation)
  );
  if (!exactDeclaration) blockers.push("semantic child manifest의 parent·policy·provider 0회 결속이 유효하지 않습니다.");
  const generationBound = Boolean(
    generation?.provider === "gemini-browser"
    && generation.jobId === jobId
    && generation.runId === runId
    && generation.status === "completed"
    && generation.pendingSegment == null
    && generation.resumedFromCompletedGeneration?.sourceRunId === source?.sourceRunId
    && generation.resumedFromCompletedGeneration?.sourceGenerationHash === source?.sourceGenerationHash
    && generation.resumedFromCompletedGeneration?.providerRequestSent === false
    && source?.sourceGeneration?.status === "completed"
    && source?.sourceGeneration?.runId === source?.sourceRunId
    && childSegments.length > 0
    && childSegments.length === sourceSegments.length
    && childSegments.every((segment, index) => {
      const origin = sourceSegments[index];
      return segment?.index === origin?.index
        && segment.resumedCompletedGeneration === true
        && segment.sourceRunId === source.sourceRunId
        && segment.submissionRunId === (origin.submissionRunId || origin.sourceRunId || source.sourceRunId)
        && segment.sha256 === origin.sha256
        && segment.promptHash === origin.promptHash
        && segment.providerVisualPromptHash === origin.providerVisualPromptHash;
    })
  );
  if (!generationBound) blockers.push("semantic child generation의 completed-resume·segment lineage가 parent provider 증거와 다릅니다.");
  const shotBound = Boolean(
    shotPatternReceipt?.schemaVersion === 2
    && shotPatternReceipt.jobId === jobId
    && shotPatternReceipt.runId === runId
    && shotPatternReceipt.provider === "gemini-browser"
    && shotPatternReceipt.submittedToProvider === true
    && shotPatternReceipt.providerRequestSentThisRun === false
    && shotPatternReceipt.inheritedProviderSubmission === true
    && shotPatternReceipt.sourceSubmissionRunId === source?.sourceRunId
    && shotPatternReceipt.sourceGenerationHash === source?.sourceGenerationHash
    && shotPatternReceipt.providerRequestHash === generation?.requestHash
    && /^sha256:[a-f0-9]{64}$/u.test(String(childGenerationFileHash || ""))
    && shotPatternReceipt.providerGenerationHash === childGenerationFileHash
  );
  if (!shotBound) blockers.push("semantic child shot-pattern 영수증이 source 제출 상속·이번 run 요청 0회에 결속되지 않았습니다.");
  return {
    required: true,
    verified: blockers.length === 0,
    blockers,
    sourceRunId: source?.sourceRunId || null,
    parentManifestHash: source?.sourceManifestHash || null,
    sourceGenerationFileHash: source?.sourceGenerationFileHash || null,
    sourceGenerationHash: source?.sourceGenerationHash || null,
    childGenerationHash: generation ? canonicalJsonHash(generation) : null,
    childGenerationFileHash: childGenerationFileHash || null,
    policy: declaration.semanticPolicy || null
  };
}
