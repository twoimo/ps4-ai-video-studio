# Design QA status

## Current verdict

**Passed for the captured public bundle.** The current UI was served locally and captured at 320, 375, 768, 1024, and 1440 CSS-pixel widths. Every accepted image is a real PNG and is bound to the exact six-file public bundle by [`design-evidence/manifest.json`](design-evidence/manifest.json).

The visual result is responsive without horizontal shell expansion in the captured dashboard and completed-job states. The 2560×720 comparison canvas places a 1280×720 earlier product dashboard on the left and a 1280×720 rendering of the current dashboard on the right; it is a product-baseline comparison, not a StyleGallery source screenshot or conformance claim.

## Recorded evidence

- Dashboard: `final-dashboard-320x700.png`, `final-dashboard-375x812.png`, `final-dashboard-768x900.png`, `final-dashboard-1024x900.png`, and `final-dashboard-1440x900.png`.
- Completed run: `final-job-375x812.png` and `final-job-1440x900.png`.
- Historical-product/current-dashboard comparison: `final-comparison-2560x720.png`.
- Browser: Codex in-app browser, Chrome 151, device pixel ratio 1, CDP screenshots.
- Console: zero warning/error entries after the final bundle loaded.

## Interaction checks

- The skip link set `#workspace-main`, focused that exact element, and reset both document and workspace scroll positions to zero.
- A selected local-upload job retained the same `#detail-upload` file-input node and focus across a 2.3-second unchanged polling interval.
- Job/list/detail signatures suppress unchanged DOM replacement; queued manual uploads do not keep the polling loop alive.
- A compact atomic status announcer excludes percentage-only updates, while progressbars expose their name, range, and current value.
- YouTube and artifact destinations pass through explicit canonical/same-origin allowlists covered by `test/job-ui-safety.test.mjs`.
- The current completed job is labelled `기술·의미 gate 통과 · 게시 전 사람 승인 별도`, so software gate success is not presented as human approval.

## Scope

This is a visual/browser pass for the source bundle hashes in the manifest. It does not certify every possible dynamic error string, third-party browser change, assistive-technology combination, or future bundle. Re-capture and regenerate the manifest whenever any recorded public file changes.
