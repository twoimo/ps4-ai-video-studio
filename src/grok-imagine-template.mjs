export const TEMPLATE_ID = "grok-imagine-2026-08-21";
export const TEMPLATE_DATE = "2026-08-21";
export const TEMPLATE_TITLE = "Grok Imagine 공장 잠금 프롬프트";

export const WORLD_SLOT_IDS = [
  "site",
  "weather",
  "everyday_thing",
  "hidden_thing",
  "materials",
  "wear",
  "trace",
  "palette",
  "sourced_si",
  "avoid"
];

export const WORLD_SLOTS = [
  { id: "site", label: "현장", hint: "이 주제의 빈 현장 하나. 실제 한국 스케일.", editable: true },
  { id: "weather", label: "날씨", hint: "같은 날의 기록된 날씨. 출처 없는 노을은 만들지 않음.", editable: true },
  { id: "everyday_thing", label: "일상 사물", hint: "이미 현장에 있는 보통 물건 하나.", editable: true },
  { id: "hidden_thing", label: "숨은 것", hint: "이 편이 드러내는 장치·층. 사람이 아님.", editable: true },
  { id: "materials", label: "재료", hint: "출처 사실에 적힌 재료만.", editable: true },
  { id: "wear", label: "마모", hint: "같은 현장의 나이·얼룩·녹·젖은 자국.", editable: true },
  { id: "trace", label: "흔적", hint: "물때, 신축줄눈, 볼트 그림자, 퇴적.", editable: true },
  { id: "palette", label: "팔레트", hint: "흐린 한국 공공·기반시설 다큐멘터리 색.", editable: true },
  { id: "sourced_si", label: "출처 SI", hint: "사실에 적힌 수량만. 없는 숫자는 만들지 않음.", editable: false, derived: "facts" },
  { id: "avoid", label: "피할 것", hint: "사람·실루엣·물속 신체·잔여 SI·픽셀 문장.", editable: false, locked: true }
];

export const SHOT_SKELETON = {
  aspect: "9:16",
  type: "{{type}}",
  camera: "{{camera}}",
  redGraphics: ["pin", "measures", "SI"],
  redGraphicsRule: "Red graphics only as pin / measures / SI. Never a sentence. Never a spec pill.",
  forbidden: [
    "people",
    "silhouette",
    "body in water",
    "leftover SI",
    "invented SI",
    "sentences in pixels",
    "second label",
    "image_gen after hook",
    "Ken Burns",
    "drawbox / drawtext"
  ]
};

export const FACTORY_LOCKS = [
  { id: "no-people", label: "사람 없음", rule: "No people, no silhouettes.", editable: false },
  { id: "no-body-in-water", label: "물속 신체 없음", rule: "No body in water.", editable: false },
  { id: "one-fact-one-label-one-shot", label: "한 사실 · 한 라벨 · 한 샷", rule: "One fact → one label → one shot. No sentences in pixels.", editable: false },
  { id: "area-on-roof", label: "면적은 지붕면에만", rule: "Area m² only on a roof plane, and only when sourced.", editable: false },
  { id: "hook-lock-then-edit", label: "훅 잠금 후 image_edit만", rule: "image_gen once for the hook lock. Every later still is image_edit. Never call image_gen after the hook.", editable: false },
  { id: "caption-y", label: "자막 Y", rule: "ASS Alignment=2, Fontsize=50, Outline=6, MarginV=450 (center y≈805). Dialogue captions only.", editable: false },
  { id: "fill-720-1280", label: "채우기 720×1280", rule: "Fill 720×1280: scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280.", editable: false },
  { id: "no-ken-burns", label: "Ken Burns 없음", rule: "Failed animate retries freeze the still. No Ken Burns.", editable: false },
  { id: "qa-frames", label: "클립 QA 시각", rule: "Inspect frames at 0.3 / 5 / 9.5.", editable: false },
  { id: "no-invented-si", label: "발명 SI 없음", rule: "Legal quantities come from sourced facts only. Numberize those tokens. Do not invent SI.", editable: false }
];

export const LOCKED_AVOID = "people, silhouettes, bodies in water, leftover SI, invented SI, sentences in pixels, cloned channel frames";

export function sanitizeWorldSlotOverrides(input = {}) {
  const next = {};
  if (!input || typeof input !== "object") return next;
  for (const slot of WORLD_SLOTS) {
    if (!slot.editable) continue;
    const value = String(input[slot.id] ?? "").replace(/\s+/g, " ").trim();
    if (value) next[slot.id] = value.slice(0, 240);
  }
  return next;
}

export function defaultWorldSlots({ nouns = [], legalQuantities = [] } = {}) {
  const siteNouns = (nouns || []).join(" / ");
  return {
    site: siteNouns
      ? `empty real Korean ${siteNouns} site, one location, documentary civic scale`
      : "empty real Korean civic/infrastructure site of this topic only; one location; real scale",
    weather: "overcast or the documented weather of the same day; no invented sunset",
    everyday_thing: "one ordinary object already on the site (joint, grate, railing, lamp, bolt)",
    hidden_thing: nouns[0]
      ? `the hidden working layer of ${nouns.slice(0, 2).join(" ")} — not a person`
      : "the hidden mechanism or layer this episode reveals — not a person",
    materials: "materials named only from sourced facts of this site",
    wear: "age, stain, rust, or wet mark that belongs to the same site",
    trace: "a physical trace on the same site (water stain, expansion joint, sediment, bolt shadow)",
    palette: "muted documentary: wet concrete, oxidized metal, Korean overcast civic",
    sourced_si: legalQuantities.length ? legalQuantities.map((item) => item.display || item.raw).join(", ") : "none — do not invent SI",
    avoid: LOCKED_AVOID
  };
}

export function fillWorldSlots({ nouns = [], legalQuantities = [], worldSlots = {} } = {}) {
  const defaults = defaultWorldSlots({ nouns, legalQuantities });
  const overrides = sanitizeWorldSlotOverrides(worldSlots);
  const filled = {};
  for (const slot of WORLD_SLOTS) {
    if (slot.id === "sourced_si") {
      filled[slot.id] = defaults.sourced_si;
      continue;
    }
    if (slot.id === "avoid") {
      filled[slot.id] = LOCKED_AVOID;
      continue;
    }
    filled[slot.id] = overrides[slot.id] || defaults[slot.id];
  }
  return filled;
}

function placeholder(id) {
  return `{{${id}}}`;
}

export function shotSkeletonLines(shot = {}, worldSlots = {}) {
  const type = shot.role || shot.type || placeholder("type");
  const camera = shot.camera || placeholder("camera");
  const slot = (id) => worldSlots[id] || placeholder(id);
  return [
    `${SHOT_SKELETON.aspect} still. Type: ${type}. Camera: ${camera}.`,
    `World lock — site: ${slot("site")}. weather: ${slot("weather")}. palette: ${slot("palette")}.`,
    `everyday_thing: ${slot("everyday_thing")}. hidden_thing: ${slot("hidden_thing")}.`,
    `materials: ${slot("materials")}. wear: ${slot("wear")}. trace: ${slot("trace")}.`,
    SHOT_SKELETON.redGraphicsRule,
    `sourced_si: ${slot("sourced_si")}.`,
    `FORBIDDEN: ${SHOT_SKELETON.forbidden.join("; ")}.`
  ];
}

export function fillShotStillPrompt(shot, { legalQuantities = [], emptier = false, siblingPath = null, worldSlots = null } = {}) {
  const slots = worldSlots || fillWorldSlots({
    nouns: shot.topicNouns || [],
    legalQuantities,
    worldSlots: shot.worldSlots
  });
  const nouns = (shot.topicNouns || []).join(", ");
  const legal = legalQuantities.map((item) => item.display).join(", ");
  const areaRule = shot.areaAllowed
    ? "Area m² may appear once, only as a short label on a roof plane."
    : "Do not show any area m² or leftover SI.";
  const labelRule = shot.label
    ? `One fact, one label, one shot. The only on-image label is: ${shot.label}. No sentences in pixels.`
    : "No on-image text, no sentences in pixels, no leftover SI.";
  const lockRule = shot.tool === "image_gen"
    ? "This is the canonical hook still and world lock. Use image_gen once. 9:16."
    : `Use image_edit only. Edit from ${siblingPath || "the hook lock or a passed sibling"}. Never call image_gen.`;
  const empty = emptier
    ? "Even emptier: no figures, no silhouettes, no numerals except the single sourced label, more vacant site."
    : "Empty site. No people, no silhouettes, no body in water.";
  return [
    ...shotSkeletonLines(shot, slots),
    lockRule,
    `Topic nouns only: ${nouns || "site"}.`,
    empty,
    labelRule,
    areaRule,
    legal ? `Legal quantities only: ${legal}. Do not invent SI.` : "No SI. Do not invent measurements.",
    `avoid: ${slots.avoid}.`,
    "Do not clone another channel's footage. Original still of this topic only."
  ].join(" ");
}

export function fillShotAnimatePrompt(shot, { emptier = false, worldSlots = null } = {}) {
  const slots = worldSlots || {};
  const empty = emptier
    ? "Even emptier motion: no spawned person, no drifted numerals, no new objects."
    : "Keep the still's empty site. Do not spawn a person or silhouette. Do not drift or add SI.";
  return [
    "Use image_to_video only. Animate this still for 10 seconds at 720p 9:16.",
    empty,
    `Camera: slow ${shot.role === "hold" ? "hold / slight settle" : "documentary move"} on the same site.`,
    `Stay inside site: ${slots.site || "the hook lock"}. palette: ${slots.palette || "same documentary grade"}.`,
    `FORBIDDEN: ${SHOT_SKELETON.forbidden.join("; ")}.`,
    "No Ken Burns zoom on a failed retry. No new labels."
  ].join(" ");
}

export function emptySkeleton() {
  return {
    aspect: SHOT_SKELETON.aspect,
    type: SHOT_SKELETON.type,
    camera: SHOT_SKELETON.camera,
    redGraphics: SHOT_SKELETON.redGraphics,
    redGraphicsRule: SHOT_SKELETON.redGraphicsRule,
    forbidden: SHOT_SKELETON.forbidden,
    lines: shotSkeletonLines({}, {
      site: "{{site}}",
      weather: "{{weather}}",
      everyday_thing: "{{everyday_thing}}",
      hidden_thing: "{{hidden_thing}}",
      materials: "{{materials}}",
      wear: "{{wear}}",
      trace: "{{trace}}",
      palette: "{{palette}}",
      sourced_si: "{{sourced_si}}"
    })
  };
}

export function renderTemplateDocument() {
  const slots = WORLD_SLOTS.map((slot) => `- \`${slot.id}\` — ${slot.label}. ${slot.hint}${slot.editable ? "" : " (잠금·읽기 전용)"}`).join("\n");
  const locks = FACTORY_LOCKS.map((lock) => `- **${lock.label}** (\`${lock.id}\`): ${lock.rule}`).join("\n");
  return [
    `# ${TEMPLATE_TITLE}`,
    "",
    `잠금 날짜: ${TEMPLATE_DATE}`,
    `식별자: \`${TEMPLATE_ID}\``,
    "",
    "주제 비의존 월드 슬롯. 값은 채워도 되고, FORBIDDEN·자막 Y·사람 없음 규칙은 바꾸지 않습니다.",
    "",
    "## 월드 슬롯",
    "",
    slots,
    "",
    "## 샷 스켈레톤",
    "",
    ...emptySkeleton().lines.map((line) => `- ${line}`),
    "",
    "## 공장 잠금",
    "",
    locks,
    ""
  ].join("\n");
}

export function getLockedTemplate() {
  return {
    schemaVersion: 1,
    id: TEMPLATE_ID,
    date: TEMPLATE_DATE,
    title: TEMPLATE_TITLE,
    slots: WORLD_SLOTS.map((slot) => ({ ...slot, placeholder: `{{${slot.id}}}` })),
    skeleton: emptySkeleton(),
    locks: FACTORY_LOCKS,
    document: renderTemplateDocument()
  };
}

export function inspectScriptPrompts(script, { source = "script" } = {}) {
  const worldSlots = script.worldSlots || fillWorldSlots({
    nouns: script.topicNouns || [],
    legalQuantities: script.legalQuantities || [],
    worldSlots: script.worldSlotOverrides
  });
  return {
    schemaVersion: 1,
    id: TEMPLATE_ID,
    date: TEMPLATE_DATE,
    source,
    topic: script.title || "",
    facts: script.facts || [],
    worldSlots: WORLD_SLOTS.map((slot) => ({
      ...slot,
      value: worldSlots[slot.id] || "",
      placeholder: `{{${slot.id}}}`
    })),
    skeleton: emptySkeleton(),
    locks: FACTORY_LOCKS,
    shots: (script.segments || []).map((segment) => ({
      index: segment.index,
      slotId: segment.slotId,
      role: segment.role,
      type: segment.role,
      camera: segment.camera,
      tool: segment.tool,
      label: segment.label || "",
      fact: segment.fact || "",
      aspect: "9:16",
      prompt: segment.visualPrompt || "",
      animatePrompt: segment.animatePrompt || "",
      caption: segment.caption || ""
    }))
  };
}
