# StyleGallery design lock

Pinned StyleGallery: https://github.com/changeroa/StyleGallery @ `9049f132426006661ac44aea4714d07426c432e5` (stylegallery@0.1.4).

Consumer reference: declared
Consumer reference record: consumer-reference/ps4-justdoit.json

This handoff is consumer-local. Visual tokens and product chrome stay in `public/styles.css`. StyleGallery owns spatial pattern names only.

## Pattern stack

- Library scroll `.library`: sticky-header + card-grid + frame 9/16
- Watch scroll none: cover + frame 9/16 + overlay-stack; `body.watch-open #watch-feed { display:block }`; no scroll-snap
- Overlays scroll on card: super-center + clamped-card `min(400px, calc(100vw - 40px))`; no right drawer

## Rejected

- scroll-snap on watch
- right inspect drawer
- chrome leaking off 9:16
- full-bleed create sheet

## Consumer-local tokens

In `public/styles.css`:

- `--bg #0b0d12`
- `--surface #141821`
- `--surface-2 #1a1f2b`
- `--line rgba(255,255,255,.08)`
- `--text #f4f6fb`
- `--overlay-w min(400px, calc(100vw - 40px))`
- radius 20
- header PS4_JUSTDOIT only
