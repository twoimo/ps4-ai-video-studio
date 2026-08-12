function ruleScore(title, patterns) {
  return patterns.reduce((score, pattern) => score + (pattern.test(title) ? 1 : 0), 0);
}

export const CATEGORY_RULES = Object.freeze([
  Object.freeze({
    id: "water",
    label: "물·도시 인프라",
    patterns: Object.freeze([
      /빗물|바닷물|강물|수돗물|(?<![가-힣])물(?:이|은|을|도|과|로|에|속|가|만|길|난리|고기|결|방울|탱크|위|아래|한\s)|(?<![가-힣])비\s*한\s*방울|(?<![가-힣])비(?:가|는|를|에|만|와|부터|까지)?\s*(?:오|내리|쏟아|맞|젖|마시|받|피하)|폭우|장마/u,
      /홍수|배수|하천|한강|댐|방조제|수도꼭지|우물|호수|갯벌|바다|해변|해저|항구/u,
      /(?<![가-힣])강(?:이|은|을|에서|으로|위|아래|바닥|하구)|화산섬|인공\s*섬|섬(?:이|은|을|에서|으로|하나|\s*\d)/u
    ])
  }),
  Object.freeze({ id: "seoul", label: "서울의 숨은 구조", patterns: Object.freeze([/서울|한강|광화문|한양|강남|북악산/u]) }),
  Object.freeze({ id: "architecture", label: "건축·구조 원리", patterns: Object.freeze([/건축|구조|아파트|건물|다리|도로|공항|터널|교량|콘크리트|유리|지붕|성벽|기둥|단열|보도블록|성당|신전|궁궐|공법/u, /돌(?:다리|기둥|벽|탑|건물|방파제|도시|을|이|로)/u]) }),
  Object.freeze({ id: "joseon", label: "조선·궁궐·성곽", patterns: Object.freeze([/조선|궁궐|경복궁|창덕궁|창경궁|종묘|한양도성|남한산성|성벽|임금|세종/u]) }),
  Object.freeze({ id: "ancient", label: "고대 문명·유산", patterns: Object.freeze([/로마|그리스|마추픽추|트로이|고대|성문|돌기둥|왕릉|유적|피라미드|신라/u]) }),
  Object.freeze({ id: "climate", label: "에너지·기후 대응", patterns: Object.freeze([/에어컨|냉방|발전소|온실|기온|환기|단열|소방|화재|폭염|냉각|뜨거운|불(?:이|을|길)/u]) })
]);

export const HOOK_RULES = Object.freeze([
  Object.freeze({ id: "why", label: "왜 그랬을까", patterns: Object.freeze([/이유|왜|비밀/u]) }),
  Object.freeze({ id: "contradiction", label: "상식 뒤집기", patterns: Object.freeze([/사실은|아닙니다|없습니다|아니라|못\s|안\s/u]) }),
  Object.freeze({ id: "scale", label: "숫자·스케일", patterns: Object.freeze([/\d/u, /(?:수십|수백|수천|수만|수억|천|만|억)\s*(?:개|명|년|톤|미터|킬로미터|층|채|마리|시간|일)(?:나|가|를|은|도|씩|쯤)?(?:\s|,|\.|$)/u]) }),
  Object.freeze({ id: "hidden", label: "숨은 장소·장치", patterns: Object.freeze([/숨어|숨은|밑에|지하|속(?:에|으로|의)|옆에|한복판/u]) }),
  Object.freeze({ id: "method", label: "불가능을 가능하게", patterns: Object.freeze([/방법|만든|세운|옮긴|붙잡|막은|해결|작동|원리|공법/u]) })
]);

export function classifyChannelTitle(value) {
  const title = String(value || "").normalize("NFC");
  const categories = CATEGORY_RULES
    .map((rule) => ({ ...rule, score: ruleScore(title, rule.patterns) }))
    .filter((rule) => rule.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map(({ id, label, score }) => ({ id, label, score }));
  const hooks = HOOK_RULES
    .map((rule) => ({ ...rule, score: ruleScore(title, rule.patterns) }))
    .filter((rule) => rule.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ id, label, score }) => ({ id, label, score }));
  const question = /[?？]/u.test(title) || /이유|왜|어디서|어떻게|무엇/u.test(title);
  const contrast = /사실은|아닙니다|없습니다|아니라|못\s|안\s/u.test(title);
  const number = hooks.some((hook) => hook.id === "scale");
  const score = Math.min(100, 28 + (question ? 20 : 0) + (contrast ? 22 : 0) + (number ? 15 : 0) + Math.min(15, categories.length * 5));
  return {
    categories,
    hooks,
    hookScore: score,
    flags: { question, contrast, number },
    confidence: "heuristic-title-only",
    evidenceRequired: true,
    method: "context-pattern-rules-v2"
  };
}

export const EDITORIAL_HYPOTHESIS = Object.freeze({
  schemaVersion: 1,
  status: "hypothesis-not-measured",
  evidenceBasis: "title-and-public-metadata-heuristic",
  limitation: "제목과 공개 메타데이터에서 세운 제작 가설이며 영상 프레임·편집·자막을 직접 관측한 결과가 아닙니다.",
  promise: "평범한 공간·시설에서 의외의 설계 원리를 발견하게 한다.",
  titleFormula: "[익숙한 대상] + [상식과 반대되는 사실] + [이유/방법/숨은 구조]",
  narrative: Object.freeze([
    Object.freeze({ step: 1, name: "0–2초 훅", detail: "결론을 숨기지 않고 낯선 사실 또는 강한 숫자로 즉시 시작" }),
    Object.freeze({ step: 2, name: "문제 재정의", detail: "시청자가 매일 보던 대상을 새 질문으로 바꿈" }),
    Object.freeze({ step: 3, name: "구조 시각화", detail: "단면·위치·물의 흐름·하중을 AI 이미지/영상으로 설명" }),
    Object.freeze({ step: 4, name: "원리 증명", detail: "역사적 맥락과 물리적 원리를 짧은 문장으로 연결" }),
    Object.freeze({ step: 5, name: "잔상", detail: "처음의 질문에 한 문장으로 답하고 다음 호기심을 남김" })
  ]),
  visualLanguage: Object.freeze(["세로 9:16", "어두운 시네마틱 톤", "고대·현대 구조의 단면/항공 시점", "큰 흰색 자막", "짧은 컷과 느린 카메라 이동"]),
  productionNotes: Object.freeze(["제목은 설명문보다 질문·반전형 문장", "사실 주장마다 출처를 수집", "AI 생성 장면은 실제 자료 영상과 구분", "자막은 2–7단어 단위로 리듬을 맞춤"])
});
