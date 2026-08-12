# Higgsfield learning sources and reuse boundary

Observed on 2026-08-12. This is a read-only, free-access review. No Higgsfield generation, upload, trial, subscription, credit spend, or asset import was performed.

## What is freely accessible

The official [Higgsfield Academy](https://higgsfield.ai/academy) is publicly readable and describes real video-production workflows from a first attempt through a finished reel. Its landing page currently lists these popular courses as “Start now for free”:

| Course | Level | Modules | Listed time | Public source |
| --- | --- | ---: | ---: | --- |
| Blockbuster 4K: The AI Filmmaking Pipeline | Intermediate | 10 | 40 min | [Academy](https://higgsfield.ai/academy) |
| Build an Ultra-Realistic Short Film in 4K | Intermediate | 19 | 33 min | [Academy](https://higgsfield.ai/academy) |
| Add AI VFX to Real Footage | Advanced | 11 | 12 min | [Academy](https://higgsfield.ai/academy) |
| Make an AI Animated Short | Intermediate | 11 | 17 min | [Academy](https://higgsfield.ai/academy) |

“Free” above means the Academy advertises free course access. It does not establish that the models used by a lesson can be generated without credits.

Useful official, publicly readable guides include:

- [Beginner AI-video guide](https://higgsfield.ai/blog/how-to-make-ai-videos-beginners-guide): choose text-to-video or image-to-video intentionally; describe subject, action, setting, and camera; test cheaply; inspect the whole clip; change one variable at a time.
- [Prompt Bank](https://higgsfield.ai/academy/apps/prompt-bank): a visual reference covering 46 camera moves in the currently displayed catalog, grouped into static, pan/tilt, zoom/focus, dolly/tracking, aerial/crane, and specialty moves.
- [Camera, angle, and lens control](https://higgsfield.ai/blog/ai-video-camera-control): separates genre, lighting, camera path, speed, lens, focal length, and aperture as controllable shot decisions.
- [Seedance 2.0 prompting guide](https://higgsfield.ai/blog/seedance-prompting-guide): advocates declaring shot count, duration, and aspect ratio, then describing numbered shot actions and an escalation arc.
- [Cinema Studio guide](https://higgsfield.ai/blog/cinema-studio-3.0): demonstrates planning recurring characters and locations before scenes, and continuing from prior footage when continuity matters.
- [AI animated-short prompt library](https://higgsfield.ai/blog/guide-animation-seedance2.0): demonstrates preparing a character keyframe and recurring prop sheet before scene generation.
- [Video-to-video VFX guide](https://higgsfield.ai/blog/VFX-with-Seedance-4k): preserves source performance/camera timing while constraining the requested change.
- [Three-step ad workflow](https://higgsfield.ai/blog/cinematic_headphones): builds recurring product, character, location, and prop references before producing a connected shotlist.

## Prompt and asset reuse status

| Resource | Exact URL | Provenance | License or terms found | Safe project posture |
| --- | --- | --- | --- | --- |
| Official agent skills repository | [github.com/higgsfield-ai/skills](https://github.com/higgsfield-ai/skills) | GitHub marks the organization as verified for `higgsfield.ai` | MIT; reviewed at commit [`fb18134b…`](https://github.com/higgsfield-ai/skills/tree/fb18134b4aabe99c4bf7ff01c8f4883400efc80d) | May be used commercially under MIT; retain copyright and license notice for substantial copies |
| Official prompt-engineering reference | [Pinned file](https://github.com/higgsfield-ai/skills/blob/fb18134b4aabe99c4bf7ff01c8f4883400efc80d/higgsfield-generate/references/prompt-engineering.md) | File in the verified official repository | MIT via repository [LICENSE](https://github.com/higgsfield-ai/skills/blob/fb18134b4aabe99c4bf7ff01c8f4883400efc80d/LICENSE) | Safe to adapt with MIT compliance |
| Official explainer prompt reference | [Pinned file](https://github.com/higgsfield-ai/skills/blob/fb18134b4aabe99c4bf7ff01c8f4883400efc80d/higgsfield-video-explainer/references/prompts.md) | File in the verified official repository | MIT via repository LICENSE | Safe to adapt with MIT compliance |
| Official workflow cookbook | [Pinned file](https://github.com/higgsfield-ai/skills/blob/fb18134b4aabe99c4bf7ff01c8f4883400efc80d/COOKBOOK.md) | File in the verified official repository | MIT via repository LICENSE | Useful architecture reference; no execution or installation was performed |
| Academy Prompt Bank | [higgsfield.ai/academy/apps/prompt-bank](https://higgsfield.ai/academy/apps/prompt-bank) | Official Higgsfield site | No redistribution license found; page footer says © 2026 Higgsfield, Inc. All rights reserved | Learn the cinematography concepts; do not mirror its prompt text, previews, or media |
| Academy courses and guides | [higgsfield.ai/academy](https://higgsfield.ai/academy) | Official Higgsfield site | No course-content redistribution license found | Link to the source; do not bundle lesson video, PDF, prompt text, or assets |
| Headphone-ad shotlist | [static.higgsfield.ai/final-shotlist-headphones-ad.html](https://static.higgsfield.ai/final-shotlist-headphones-ad.html) | Linked from the official three-step ad guide | Publicly viewable, but no reuse license found | Reference-only; do not copy or distribute it in this repository |
| Downloadable Claude `.skill` files advertised by blog guides | [Ad workflow source page](https://higgsfield.ai/blog/cinematic_headphones) and [VFX workflow source page](https://higgsfield.ai/blog/vfx_4k) | Official Higgsfield blog | Described as free downloads, but no separate license was found in the public page text reviewed | Do not vendor or execute until the downloaded archive itself is inspected and its license is explicit |

The official website’s [Terms of Use](https://higgsfield.ai/terms-of-use-agreement) were last updated July 26, 2026. The page says they apply immediately to users registering on or after that date, and on August 27, 2026 to earlier users unless accepted sooner. Section 4.4 says Higgsfield does not claim a user’s inputs or outputs and does not restrict commercial use of the user’s exported outputs. That permission is about the user’s own generated material; it is not a license to republish Higgsfield-authored Academy prompts, preview media, courses, or downloadable assets. The user also remains responsible for rights in uploaded inputs and identifiable people.

The same Terms prohibit automated scraping/downloading of webpage data outside the stated search-engine exception. Therefore this project should link to the Prompt Bank, not crawl or mirror it. The official GitHub repository has a separate, explicit MIT license and is the appropriate source for reusable workflow material.

## Safe patterns adopted for this project

The machine-readable catalog at [`data/higgsfield-prompt-patterns.json`](../data/higgsfield-prompt-patterns.json) contains original wording and no Higgsfield preview assets. It turns the reusable ideas into eight provider-neutral patterns:

1. curiosity question followed by visible proof;
2. locked static observation;
3. fixed-position pan reveal;
4. dolly depth reveal;
5. lateral parallax tracking;
6. single focus handoff;
7. a shared continuity contract for every clip;
8. one narration/visual/caption block per clip.

Pattern 8 is a local assembly reference only. It is never appended to `providerVisualPrompt`, never sent in a Gemini/BFL/local-video provider request, and is labeled `REFERENCE ASSEMBLY · NOT SENT TO PROVIDER` in the web app. Patterns 1–6 plus the continuity contract are the only provider-prompt-eligible entries.

The catalog records its source IDs, rights posture, variables, guardrails, and receipt fields. Academy sources are marked `reference-only-no-verbatim-text-or-assets`; only the pinned official GitHub sources are marked as MIT-reusable.

## Implemented web-app and provider integration

The web app now surfaces a read-only “Shot patterns” panel before generation:

- show the Korean label, intent, source links, and fixed `MIT adaptable` / `reference only` rights badges;
- deterministically select one camera pattern per clip and render one unchanged continuity contract across the run;
- keep the `deterministic-extractive-binding/v3` `visualPrompt` byte-for-byte intact while constructing a separate `providerVisualPrompt` from that evidence prompt plus camera-only and continuity-only suffixes;
- send `providerVisualPrompt` through Gemini and local-video requests, while local uploads remain metadata-only;
- write `patternId`, source URLs, evidence visual-prompt hash, provider visual-prompt hash, continuity-contract hash, request hash, and completed provider-generation hash into `runs/<runId>/shot-pattern-receipt.json`;
- mark generation as planned before provider execution, and set `submittedToProvider: true` only after a completed Gemini/local-video generation receipt is present;
- include the receipt in the immutable run snapshot and quality evidence-hash set;
- never fetch remote lesson media at runtime;
- keep paid Higgsfield generation behind the existing provider-readiness and explicit budget/credit gates.

This adds the educational value of Higgsfield’s shot discipline without importing unlicensed prompt-bank text or assets, and it remains useful for Gemini, a future free Higgsfield route, or another provider.
