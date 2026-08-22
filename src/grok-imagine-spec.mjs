import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FACTORY_LOCKS,
  SHOT_SKELETON,
  TEMPLATE_DATE,
  TEMPLATE_ID,
  TEMPLATE_TITLE,
  WORLD_SLOT_IDS,
  WORLD_SLOTS,
  emptySkeleton,
  getLockedTemplate,
  renderTemplateDocument
} from "./grok-imagine-template.mjs";
import { FACTORY_CLIP_COUNT, FACTORY_UNIQUE_COUNT } from "./grok-imagine-factory.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const CORPUS_PATH = join(ROOT, "data/mysterious-architecture/corpus.json");

export const SHOT_TYPE_IDS = [
  "hook_photoreal",
  "interior_scale",
  "massing_studio",
  "spec_elevation",
  "cutaway_site",
  "cutaway_object",
  "mechanism_arrows",
  "compare_split",
  "context_clay",
  "map_3d",
  "payoff_photoreal",
  "live_action",
  "other"
];

export const SHOT_TYPE_META = {
  hook_photoreal: {
    meaning: "everyday_thing in situ, wear + trace, no dims.",
    factory: "yes",
    generate: true
  },
  interior_scale: {
    meaning: "empty built volume, one-point, one human.",
    factory: "only if user asks AND dry walkable floor. default off",
    generate: false,
    defaultOff: true
  },
  massing_studio: {
    meaning: "one object on light-gray studio; in-scene rain/pour.",
    factory: "yes",
    generate: true
  },
  spec_elevation: {
    meaning: "red arrows pin to real edges; SI ON the line.",
    factory: "yes",
    generate: true
  },
  cutaway_site: {
    meaning: "lid = everyday_thing; hidden = vertical extrusion under that lid (193/288 aligned).",
    factory: "yes",
    generate: true
  },
  cutaway_object: {
    meaning: "object sliced; internals stay inside the cut.",
    factory: "yes",
    generate: true
  },
  mechanism_arrows: {
    meaning: "red path on real surfaces; cyan only for water.",
    factory: "yes",
    generate: true
  },
  compare_split: {
    meaning: "50/50, one red X, same camera.",
    factory: "optional",
    generate: false,
    optional: true
  },
  context_clay: {
    meaning: "monochrome clay city/site + one neon accent.",
    factory: "yes",
    generate: true
  },
  map_3d: {
    meaning: "extruded district or pins.",
    factory: "only if many sites",
    generate: false
  },
  payoff_photoreal: {
    meaning: "same site, quieter.",
    factory: "yes",
    generate: true
  },
  live_action: {
    meaning: "do not clone their footage",
    factory: "do-not-clone",
    generate: false,
    doNotClone: true
  },
  other: {
    meaning: "do not invent a type",
    factory: "do-not-invent",
    generate: false,
    doNotInvent: true
  }
};

export const ERA_RULE = "ignore early_if + offtopic; spec is mature_explainer 253";

export const SITUATION_CHECKLIST = [
  "Shoot one empty real Korean civic or infrastructure site. One location. Documentary scale.",
  "The everyday_thing is already on that site: a joint, grate, railing, lamp, or bolt.",
  "The hidden_thing is a mechanism or layer under that lid — not a person.",
  "Weather is the documented weather of the same day. Do not invent a sunset.",
  "Wear and trace belong to the same site: stain, rust, wet mark, expansion joint, sediment, bolt shadow.",
  "Red graphics only as numbered pin / measures / SI on real edges, with an 8 percent safe margin.",
  "One fact → one label → one shot. No Korean or English sentences in pixels.",
  "Area m² appears only on a roof plane, and only when the quantity is sourced.",
  "No people, no silhouettes, no body in water.",
  "Keep real civic scale. Do not go toy. Do not float a park, sand, lawn, or sky box.",
  "Motion stays in-hold on the same geometry. Failed animate freezes the still. No Ken Burns.",
  "Same site from hook to payoff. image_gen once for the hook lock, then image_edit only."
];

export const HARD_FAILS = [
  "people or silhouette in frame",
  "body in water",
  "leftover SI from a previous shot",
  "invented SI that is not in sourced facts",
  "Korean or English sentences in pixels",
  "second on-image label",
  "dashed box on park / sand / lawn / sky",
  "gap-span area bracket",
  "toy scale",
  "second neighborhood",
  "white studio gap after the hook lock",
  "image_gen after the hook",
  "Ken Burns zoom on a failed animate",
  "drawbox / drawtext spec pill",
  "cloned channel footage"
];

export const REFERENCE_LOOP = [
  "image_gen the hook still once. This file is the world lock.",
  "QA the hook: same site, real Korean scale, no people, no leftover SI, one label if sourced.",
  "image_edit every later still from the hook lock or a passed sibling. Never call image_gen again.",
  "Animate 10s 720p 9:16 only if geometry and SI still hold at 0.3 / 5 / 9.5.",
  "If animate fails QA, freeze the still. No Ken Burns.",
  "Compose: fill 720×1280, dialogue captions only, hard cut, 16s chat parts."
];

export const CLIP_COUNT_LOCK = {
  factoryHolds: FACTORY_CLIP_COUNT,
  uniqueSources: FACTORY_UNIQUE_COUNT,
  note: "1fps/hash over-counts; user rejected per-caption cutting; ep1 = 7 holds / 6 unique sources",
  rejected: ["1fps/hash over-count", "per-caption cutting"],
  corpusSetups: {
    median: 13,
    mean: 13.89,
    mode: 13,
    range: [5, 29],
    approx90sPictures: [12, 16]
  },
  doNotRebuildTo: ["13-16", "20-24"],
  factoryStays: "6 unique sources / 7 holds"
};

export const CAPTION_LOCK = {
  alignment: 2,
  fontsize: 50,
  outline: 6,
  marginV: 450,
  centerY: 805,
  style: "white ExtraBold + black stroke",
  language: "Korean dialogue only",
  editOnly: true,
  rule: "ASS Alignment=2, Fontsize=50, Outline=6, MarginV=450 (center y≈805). Dialogue captions time to speech pauses when mix/silencedetect/word timestamps exist. Script-only is durationHint fallback and is not pause-timed. Numberize tokens."
};

export const STYLE_SHEET = {
  graphics: {
    red: "numbered pin / measures / SI lines only; 8 percent safe margin; never a sentence; never a spec pill",
    cyan: "water path only",
    numbersOnTheLine: true,
    inSceneLabels: "corpus uses Korean/English banners; factory does NOT bake Korean/English sentences"
  },
  cutaway: {
    lid: "everyday_thing",
    hidden: "vertical extrusion under that lid",
    objectCut: "internals stay inside the cut",
    lidAligned: "193/288"
  },
  compareSplit: "50/50, one red X, same camera",
  contextClay: "monochrome clay city/site + one neon accent",
  parkBox: "floating park/sand box 28/288 — factory forbids"
};

export const GRAPHICS_GRAMMAR = {
  redMixed: 191,
  numbersOnTheLine: 168,
  inSceneLabels: "they use banners but factory does NOT bake Korean/English sentences",
  dialogue: "white ExtraBold + black stroke 288/288, edit-only",
  floatingParkSandbox: "28 — factory forbids",
  captions: "Alignment=2 Fontsize=50 Outline=6 MarginV=450 (center y≈805)"
};

function readCorpus() {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
}

export function loadCorpusTally() {
  const corpus = readCorpus();
  return {
    N: corpus.N,
    eras: corpus.eras,
    reds: corpus.reds,
    labels: corpus.labels,
    captions: corpus.captions,
    letterbox: corpus.letterbox,
    motion: corpus.motion,
    site: corpus.site,
    scale: corpus.scale,
    park: corpus.park,
    nums: corpus.nums,
    lid: corpus.lid,
    setups: corpus.setups,
    types: corpus.types
  };
}

export function shotTypesFromCorpus(tally = loadCorpusTally()) {
  return SHOT_TYPE_IDS.map((id) => {
    const counts = tally.types?.[id] || { videos: 0, hits: 0 };
    const meta = SHOT_TYPE_META[id];
    return {
      id,
      videos: counts.videos,
      hits: counts.hits,
      meaning: meta.meaning,
      factory: meta.factory,
      generate: Boolean(meta.generate),
      doNotClone: Boolean(meta.doNotClone),
      doNotInvent: Boolean(meta.doNotInvent),
      defaultOff: Boolean(meta.defaultOff),
      optional: Boolean(meta.optional)
    };
  });
}

export function renderSpecDocument(tally = loadCorpusTally()) {
  const types = shotTypesFromCorpus(tally);
  const typeLines = types.map((type) => (
    `- \`${type.id}\` — ${type.meaning} factory: ${type.factory}. corpus ${type.videos} videos / ${type.hits} hits.`
  ));
  const situation = SITUATION_CHECKLIST.map((line, index) => `${index + 1}. ${line}`).join("\n");
  const fails = HARD_FAILS.map((line) => `- ${line}`).join("\n");
  const loop = REFERENCE_LOOP.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return [
    `# ${TEMPLATE_TITLE} — locked spec`,
    "",
    `잠금 날짜: ${TEMPLATE_DATE}`,
    `식별자: \`${TEMPLATE_ID}\``,
    `코퍼스: @60chtptkd N=${tally.N} (analyzed 2026-08-20)`,
    "",
    "## Era",
    "",
    `- mature_explainer ${tally.eras.mature_explainer}`,
    `- offtopic ${tally.eras.offtopic}`,
    `- early_if ${tally.eras.early_if}`,
    `- Rule: ${ERA_RULE}`,
    "",
    "## Unique setups",
    "",
    `- median ${tally.setups.median} / mean ${tally.setups.mean} / mode ${tally.setups.mode} / range ${tally.setups.min}–${tally.setups.max}`,
    "- ~90s shorts are 12–16 pictures",
    `- Factory stays ${CLIP_COUNT_LOCK.factoryStays}. Do not rebuild to 13–16 or 20–24.`,
    "",
    "## Site / scale / motion",
    "",
    `- Same site ${tally.site.yes}/${tally.N}`,
    `- Real scale ${tally.scale.real}/${tally.N} (they go toy ${tally.scale.toy} — factory does not)`,
    `- Letterbox almost never (${tally.letterbox.no}/${tally.N} no)`,
    `- Motion in-hold ${tally.motion.yes}/${tally.N}`,
    "",
    "## Shot types",
    "",
    ...typeLines,
    "",
    "## Graphics grammar",
    "",
    `- red mixed ${tally.reds.mixed}`,
    `- numbers on the line ${tally.nums.yes}`,
    `- ${GRAPHICS_GRAMMAR.inSceneLabels}`,
    `- ${GRAPHICS_GRAMMAR.dialogue}`,
    `- floating park/sand box ${tally.park.yes} — factory forbids`,
    `- captions ${GRAPHICS_GRAMMAR.captions}`,
    "",
    "## Situation checklist",
    "",
    situation,
    "",
    "## Hard fails",
    "",
    fails,
    "",
    "## Reference-first loop",
    "",
    loop,
    "",
    "## CLIP_COUNT lock",
    "",
    CLIP_COUNT_LOCK.note,
    "",
    "## STYLE_SHEET",
    "",
    `- graphics: ${STYLE_SHEET.graphics.red}`,
    `- cutaway lid: ${STYLE_SHEET.cutaway.lid} → hidden ${STYLE_SHEET.cutaway.hidden}`,
    ""
  ].join("\n");
}

export function getLockedSpec() {
  const template = getLockedTemplate();
  const tally = loadCorpusTally();
  return {
    ...template,
    schemaVersion: 2,
    tally,
    eras: tally.eras,
    eraRule: ERA_RULE,
    types: shotTypesFromCorpus(tally),
    slots: WORLD_SLOTS.map((slot) => ({ ...slot, placeholder: `{{${slot.id}}}` })),
    skeleton: emptySkeleton(),
    locks: FACTORY_LOCKS,
    situation: SITUATION_CHECKLIST,
    hardFails: HARD_FAILS,
    loop: REFERENCE_LOOP,
    captions: CAPTION_LOCK,
    clipCountLock: CLIP_COUNT_LOCK,
    styleSheet: STYLE_SHEET,
    graphicsGrammar: GRAPHICS_GRAMMAR,
    documents: {
      template: renderTemplateDocument(),
      spec: renderSpecDocument(tally)
    },
    slotIds: WORLD_SLOT_IDS,
    skeletonForbidden: SHOT_SKELETON.forbidden,
    title: TEMPLATE_TITLE,
    id: TEMPLATE_ID,
    date: TEMPLATE_DATE
  };
}
