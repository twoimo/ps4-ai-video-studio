import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createJob, evidenceFallbackScript, JOBS_DIR, perceptualFingerprintDistance, sourceExcerpt, validateEvidenceBoundScript, verifyEvidenceBoundScript } from "../src/pipeline.mjs";

const sources = [{
  title: "공식 건축 기록",
  url: "https://example.go.kr/architecture",
  fetchStatus: "fetched",
  sha256: `sha256:${"a".repeat(64)}`,
  evidence: [
    { id: "excerpt-1", locator: "text-offset:10-90", quote: "궁궐 마당의 돌 사이 틈은 빗물이 빠져나가는 통로로 기능한다." },
    { id: "excerpt-2", locator: "text-offset:91-170", quote: "거친 돌 표면은 보행자가 미끄러지는 위험을 줄이는 데 도움을 준다." }
  ]
}];

function script() {
  const first = sources[0].evidence[0].quote;
  const second = sources[0].evidence[1].quote;
  return {
    title: first,
    hook: first,
    narration: `${first} ${second}`,
    researchStatus: "verified",
    segments: [
      {
        claimId: "claim-1",
        claim: first,
        caption: first,
        narration: first,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(first)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        durationHint: 8,
        evidenceRefs: [{ sourceId: sources[0].url, evidenceId: "excerpt-1", quote: first }]
      },
      {
        claimId: "claim-2",
        claim: second,
        caption: second,
        narration: second,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(second)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        durationHint: 8,
        evidenceRefs: [{ sourceId: sources[0].url, evidenceId: "excerpt-2", quote: second }]
      }
    ]
  };
}

describe("evidence-bound script validation", () => {
  test("binds every claim to an exact captured quote", () => {
    const result = validateEvidenceBoundScript(script(), sources, 2, "fixture");
    expect(result.researchStatus).toBe("verified");
    expect(result.evidenceTextBinding).toMatchObject({ algorithm: "deterministic-extractive-binding/v3", status: "extractively-bound", segmentCount: 2 });
    expect(result.evidenceTextBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyEvidenceBoundScript(result, sources, 2)).toMatchObject({ verified: true, bindingHash: result.evidenceTextBindingHash });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].sourceEvidence[0].sourceSha256).toBe(sources[0].sha256);
  });

  test("fails closed when a quote is paraphrased or invented", () => {
    const tampered = script();
    tampered.segments[0].evidenceRefs[0].quote = "돌 틈은 홍수를 완전히 막는다";
    expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow("원문과 일치하지 않습니다");
  });

  test("rejects duplicate claim identifiers", () => {
    const duplicate = script();
    duplicate.segments[1].claimId = duplicate.segments[0].claimId;
    expect(() => validateEvidenceBoundScript(duplicate, sources, 2)).toThrow("비어 있거나 중복됩니다");
  });

  test("rejects unrelated claims even when every quote is genuine", () => {
    const fields = {
      claim: "화성 로켓 발사는 인류를 다른 행성으로 운송합니다.",
      narration: "화성 로켓 발사는 인류를 다른 행성으로 운송합니다.",
      caption: "화성으로 가는 로켓",
      visualPrompt: "vertical cinematic launch of a rocket from Mars, no text"
    };
    for (const [field, value] of Object.entries(fields)) {
      const tampered = script();
      tampered.segments[0][field] = value;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
  });

  test("rejects unsupported numbers, proper names, absolute claims, and polarity reversals", () => {
    for (const narration of [
      "돌 사이 틈은 500년 동안 빗물을 빠져나가게 합니다.",
      "경복궁의 돌 사이 틈은 빗물이 빠져나가는 통로입니다.",
      "돌 사이 틈은 모든 홍수를 완전히 막습니다.",
      "돌 사이 틈은 빗물이 빠져나가지 못하게 합니다."
    ]) {
      const tampered = script();
      tampered.segments[0].narration = narration;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
    for (const visualPrompt of [
      "vertical documentary palace stone paving gaps carrying rainwater in 2099, no text",
      "vertical documentary palace stone paving gaps carrying rainwater on Mars, no text"
    ]) {
      const tampered = script();
      tampered.segments[0].visualPrompt = visualPrompt;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }
  });

  test("requires verified research status and rejects a mutated binding receipt", () => {
    const unverified = script();
    unverified.researchStatus = "provided";
    expect(() => validateEvidenceBoundScript(unverified, sources, 2)).toThrow(/researchStatus: verified/);

    const validated = validateEvidenceBoundScript(script(), sources, 2);
    validated.segments[0].caption = "화성 로켓";
    expect(verifyEvidenceBoundScript(validated, sources, 2)).toMatchObject({ verified: false });

    const reordered = validateEvidenceBoundScript(script(), sources, 2);
    reordered.segments[1].narration = "미끄러질 위험은 거친 표면을 줄이는 데 도움을 줍니다.";
    expect(verifyEvidenceBoundScript(reordered, sources, 2)).toMatchObject({ verified: false });

    const replacedSources = structuredClone(sources);
    replacedSources[0].url = "https://another.example/source";
    const replaced = structuredClone(validateEvidenceBoundScript(script(), sources, 2));
    replaced.segments.forEach((segment) => {
      segment.evidenceRefs.forEach((reference) => { reference.sourceId = replacedSources[0].url; });
    });
    expect(verifyEvidenceBoundScript(replaced, replacedSources, 2)).toMatchObject({ verified: false });
  });

  test("fails closed on high-overlap contradictions and unsupported visual subjects", () => {
    for (const [field, value] of [
      ["claim", "궁궐 마당의 돌 사이 틈은 빗물을 가두는 통로로 기능한다."],
      ["narration", "궁궐 마당의 돌 사이 틈은 빗물이 안으로 들어오는 통로로 기능합니다."],
      ["caption", "빗물이 막히는 돌 틈"],
      ["visualPrompt", "palace courtyard stone gaps rainwater launch nuclear missile"]
    ]) {
      const tampered = script();
      tampered.segments[0][field] = value;
      expect(() => validateEvidenceBoundScript(tampered, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
    }

    const polarityPrefix = script();
    polarityPrefix.segments[0].claim = "궁궐 마당의 돌 사이 틈은 불안전하다.";
    expect(() => validateEvidenceBoundScript(polarityPrefix, sources, 2)).toThrow(/extractive|일치하지 않습니다/);
  });

  test("rejects relation reversal, prefix collisions, hidden scripts, and unsupported global copy", () => {
    const relationSources = [{
      title: "배수 기록",
      url: "https://example.go.kr/drain",
      fetchStatus: "fetched",
      sha256: `sha256:${"d".repeat(64)}`,
      evidence: [{ id: "relation", locator: "text-offset:0-16", quote: "빗물은 배수로를 통과한다." }]
    }];
    const relationQuote = relationSources[0].evidence[0].quote;
    const relation = {
      title: relationQuote,
      hook: relationQuote,
      narration: relationQuote,
      researchStatus: "verified",
      segments: [{
        claimId: "relation-1",
        claim: relationQuote,
        caption: relationQuote,
        narration: relationQuote,
        visualPrompt: `vertical cinematic documentary visualization depicting only this evidence: ${JSON.stringify(relationQuote)}; consistent visual style, no added text or third-party logos; retain any provider-required provenance mark`,
        evidenceRefs: [{ sourceId: relationSources[0].url, evidenceId: "relation", quote: relationQuote }]
      }]
    };
    for (const mutate of [
      (value) => { value.segments[0].claim = "배수로는 빗물을 통과한다."; },
      (value) => { value.segments[0].caption = "물, 배수로를 통과한다."; },
      (value) => { value.segments[0].visualPrompt += " 火星 核爆発"; },
      (value) => { value.title = "빗물 배수로 화성 로켓 핵폭발"; },
      (value) => { value.hook = "빗물 배수로 백 년"; }
    ]) {
      const tampered = structuredClone(relation);
      mutate(tampered);
      expect(() => validateEvidenceBoundScript(tampered, relationSources, 1)).toThrow(/extractive|일치하지 않습니다/);
    }
  });
});

describe("provider clip defaults", () => {
  test("uses a two-clip Gemini default while preserving overrides and local defaults", async () => {
    const jobs = [];
    try {
      jobs.push(await createJob({ topic: "Gemini 기본값", provider: "gemini-browser" }));
      jobs.push(await createJob({ topic: "Gemini 명시값", provider: "gemini-browser", clipCount: 12 }));
      jobs.push(await createJob({ topic: "로컬 기본값", provider: "local-video" }));
      expect(jobs.map((job) => job.clipCount)).toEqual([2, 12, 6]);
    } finally {
      await Promise.all(jobs.map((job) => rm(join(JOBS_DIR, job.id), { recursive: true, force: true })));
    }
  });
});

const heritageArticle = `<!doctype html>
<html lang="ko">
  <body>
    <nav>본문 바로가기 주메뉴 바로가기 전체 메뉴 통합 검색 로그인</nav>
    <main>
      <p>콘텐츠 기본 정보 UCI I801:1501001-001-V00356 파일명 박석_1920X1080.mp4 107.26 MB 다운로드</p>
      <article>
        <p>박석은 얇고 넓적하게 만든 돌이다.</p>
        <p>조선시대 궁궐과 종묘의 주요 건물 바닥에는 박석이 중요한 건축재료로 사용되었다.</p>
        <p>울퉁불퉁한 표면은 빛의 반사 방향을 여러 갈래로 흩어 눈에 직접 닿지 않게 한다.</p>
        <p>박석의 틈 아래에는 물을 내보내는 마사토가 깔려 있다.</p>
        <p>마사토는 알갱이 크기가 커서 물을 내보내는 능력이 탁월하다.</p>
        <p>박석 사이의 마사토를 통해 배수가 진행되기 때문에 장대비에도 빗물이 쉽게 차오르지 않는다.</p>
      </article>
    </main>
    <footer>개인정보 저작권 정책 Copyright 2026 All Rights Reserved.</footer>
  </body>
</html>`;

describe("deterministic source evidence extraction", () => {
  test("prefers relevant Korean explanatory sentences and binds exact offsets", () => {
    const extracted = sourceExcerpt(
      new TextEncoder().encode(heritageArticle),
      "text/html; charset=utf-8",
      ["경복궁", "박석", "마사토", "배수"]
    );

    expect(extracted.evidence.length).toBeGreaterThanOrEqual(4);
    for (const item of extracted.evidence) {
      expect(item.quote).toMatch(/다\.$/u);
      expect(item.quote).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
      expect(extracted.excerpt).toContain(item.quote);
      const locator = /^text-offset:(\d+)-(\d+)$/.exec(item.locator);
      expect(locator).not.toBeNull();
      expect(Number(locator[2]) - Number(locator[1])).toBe(item.quote.length);
    }
  });

  test("builds four non-hallucinated clips from captured heritage prose", () => {
    const extracted = sourceExcerpt(
      new TextEncoder().encode(heritageArticle),
      "text/html",
      ["경복궁", "박석", "마사토", "배수"]
    );
    const source = {
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/paving",
      fetchStatus: "fetched",
      sha256: `sha256:${"b".repeat(64)}`,
      ...extracted
    };
    const result = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 4, [source], 32);

    expect(result.generatedBy).toBe("evidence-extract-fallback");
    expect(result.segments).toHaveLength(4);
    expect(result.segments.filter((segment) => /마사토|배수|빗물/u.test(segment.narration)).length).toBeGreaterThanOrEqual(2);
    for (const segment of result.segments) {
      const reference = segment.evidenceRefs[0];
      const captured = source.evidence.find((item) => item.id === reference.evidenceId);
      expect(segment.narration).toBe(reference.quote);
      expect(captured.quote).toContain(reference.quote);
      expect(segment.caption).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
    }
    const rainy = result.segments.find((segment) => segment.narration.startsWith("여름,"));
    if (rainy) expect(rainy.caption).not.toBe("여름");
  });

  test("re-ranks legacy wide evidence windows and refines quote locators", () => {
    const legacyQuote = [
      "콘텐츠 기본 정보 UCI I801:1501001-001-V00356 파일명 박석_1920X1080.mp4 107.26 MB 다운로드입니다.",
      "박석은 얇고 넓적하게 만든 돌이다.",
      "조선시대 궁궐과 종묘의 주요 건물 바닥에는 박석이 중요한 건축재료로 사용되었다.",
      "울퉁불퉁한 표면은 빛의 반사 방향을 여러 갈래로 흩어 눈에 직접 닿지 않게 한다.",
      "박석의 틈 아래에는 물을 내보내는 마사토가 깔려 있다.",
      "마사토는 알갱이 크기가 커서 물을 내보내는 능력이 탁월하다.",
      "박석 사이의 마사토를 통해 배수가 진행되기 때문에 장대비에도 빗물이 쉽게 차오르지 않는다.",
      "관련 홈페이지 https://example.go.kr 연락처 02-0000-0000 전체 메뉴입니다."
    ].join(" ");
    const legacySource = {
      title: "국가유산 박석 건축 기록",
      url: "https://example.go.kr/heritage/legacy",
      fetchStatus: "fetched",
      sha256: `sha256:${"c".repeat(64)}`,
      evidence: [{ id: "excerpt-wide", locator: "text-offset:500-1500", quote: legacyQuote }]
    };
    const result = evidenceFallbackScript("경복궁 박석과 마사토의 배수 구조", 4, [legacySource], 32);

    for (const segment of result.segments) {
      expect(segment.narration).not.toMatch(/UCI|I801|\.mp4|다운로드|메뉴|Copyright|https?:\/\//iu);
      expect(segment.narration).toMatch(/다\.$/u);
      const offset = legacyQuote.indexOf(segment.narration);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(segment.sourceEvidence[0].locator).toBe(`text-offset:${500 + offset}-${500 + offset + segment.narration.length}`);
    }
  });

  test("fails closed when only menus, identifiers, or unrelated prose remain", () => {
    const unusable = {
      title: "경복궁 박석 공식 기록",
      url: "https://example.go.kr/heritage/menu-only",
      fetchStatus: "fetched",
      evidence: [{
        id: "excerpt-1",
        locator: "text-offset:0-300",
        quote: "경복궁 전체 메뉴를 선택하면 상세 정보를 볼 수 있습니다. UCI I801:1501001-001-V00356 파일명 video_1920X1080.mp4 다운로드입니다. 오늘은 날씨가 맑아서 산책하기 좋은 날입니다."
      }]
    };
    expect(() => evidenceFallbackScript("경복궁 박석 배수 구조", 4, [unusable], 32)).toThrow("유효한 검증 근거 문장이 부족합니다: 0/4");
  });
});

describe("temporal perceptual fingerprints", () => {
  test("reports zero distance for the same clip signature", () => {
    const frames = ["0000000000000000", "ffffffffffffffff"];
    expect(perceptualFingerprintDistance(frames, frames)).toBe(0);
  });

  test("separates visually different signatures", () => {
    expect(perceptualFingerprintDistance(["0000000000000000"], ["ffffffffffffffff"])).toBe(64);
  });
});
