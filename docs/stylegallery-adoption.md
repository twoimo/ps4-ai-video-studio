# StyleGallery concept reference

This record explains which layout constraints informed the PS4 AI Video Studio dashboard. It is not a StyleGallery package, conformance claim, or source-code port.

## Pinned reference

- Repository: `https://github.com/changeroa/StyleGallery`
- Inspected revision: `e67b440147970c5d4f5b83f922d2593e12d09e74`
- Revision timestamp: `2026-08-02T23:18:51+09:00`
- Inspected on: `2026-08-12`
- Planning references: `GUIDE.md`, `guides/decision-tree.md`, `guides/layout-brief.md`, `recipes/dashboard.md`, `recipes/command-surface.md`, and `recipes/list-detail.md`

No `LICENSE`, `LICENSE.*`, or `COPYING*` file was found at that revision. This project therefore treats the repository only as a conceptual reference for layout constraints. No upstream file is vendored in this repository. The product selectors and declarations remain maintained here; this record makes no absolute claim about independent origin or legal status.

## Product-specific implementation

- `.app-shell` defines named `studio-rail` and `studio-workspace` grid areas.
- `.production-grid`, `.benchmark-summary`, and `.benchmark-bottom` use product-owned `auto-fit` grids for peer panels.
- `.stats-grid`, `.shot-pattern-list`, `.committee-roles`, `.provider-grid`, and `.provider-facts` use independently sized repetition rules for their own content.
- `.jobs-layout` defines an explicit list/detail grid; the list precedes detail in source order and collapses to one column on narrow screens.
- `.topbar`, `.section-heading`, `.panel-head`, and `.footer` define local heading/action grids rather than shared layout utilities.
- Wide screens use `#workspace-main` as the workspace scroll owner. Narrow screens return vertical scrolling to the document, while the labelled navigation owns only its horizontal overflow.
- The PS4 dark palette, typography, borders, radii, badges, state colors, and illustration treatment remain application-specific.

## Accessibility and update boundaries

- The skip link focuses the main workspace and resets its owning scroll container to the top.
- Job list and detail containers are not live regions. A compact atomic status node announces only meaningful status, stage, message, or integrity transitions; percentage-only polling is silent.
- Deterministic UI signatures avoid replacing job/detail DOM when their API projections have not changed. This preserves focus and a selected local file input during unrelated polling.
- A queued manual-upload job does not keep polling alive; auto-start Gemini and local-video jobs do.
- Job progress exposes progressbar name, range, and current value.
- YouTube links are restricted to canonical HTTPS video routes; artifact links and preview media are restricted to the exact same-origin artifact route.
- Reduced-motion preference disables smooth scrolling and transition duration.
- Long job names, evidence paths, provider blockers, and formulas can wrap without widening the shell.

## Consumer reference boundary

- Consumer reference: `not_applicable`.
- Reason: this repository only records conceptual layout influences. It defines no StyleGallery consumer profile, portable token record, migration readiness, or upstream conformance certification.

## Verification contract

The full checklist contract for a future exhaustive pass is to verify 320px, 375px, 768px, 1024px, and 1440px widths together with complete keyboard traversal, the skip link, focused job/control retention through polling, local file-input identity, live announcements, long content, empty states, navigation overflow, reduced motion, and wide/narrow scroll ownership.

The current pass claim is limited to the subset recorded in [`design-evidence/manifest.json`](design-evidence/manifest.json): five captured dashboard widths, two completed-job captures, one comparison PNG, zero recorded console warnings/errors, skip-link focus and scroll reset, unchanged-polling file-input/focus retention, completed-run gate wording, and the referenced safe-URL/announcement test contract. Those observations are bound to exact source-file, bundle, and image hashes with Chrome 151 metadata. The manifest does not separately attest the rest of the full checklist above, so this record makes no pass claim for those unrecorded items. The comparison image uses the product's earlier dashboard as its left-hand baseline and the current implementation on the right; it is not an upstream screenshot or a StyleGallery conformance claim. The bounded result and remaining scope are recorded in [`docs/design-qa.md`](design-qa.md).
