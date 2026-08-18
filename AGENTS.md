# AGENTS.md

## Cursor Cloud specific instructions

### What this is
`ps4-ai-video-studio` is a single-service app: a Bun HTTP server (`src/server.mjs`, `Bun.serve`) that
serves a static web UI from `public/` and exposes a `/api/*` JSON API for an AI YouTube-Shorts
production pipeline (planning → clip generation/normalization → caption burn-in → render → AHP
quality check). All source is plain `.mjs` using only Node built-ins — there are no npm dependencies
and no lockfile, so there is nothing to `bun install`.

### Runtime / toolchain
- The app runs on **Bun** (not Node). Scripts in `package.json` all call `bun`. The startup update
  script installs Bun to `~/.bun/bin`; if `bun` is not on PATH in a shell, use `~/.bun/bin/bun` or run
  `export PATH="$HOME/.bun/bin:$PATH"`.
- `ffmpeg`/`ffprobe` are required for local rendering and are preinstalled in the base image.

### Run / lint / test / build
- Run (dev, hot reload): `bun --watch src/server.mjs` → serves http://localhost:3000 (override with `PORT`).
- Run (plain): `bun src/server.mjs` (this is `bun run start`).
- There is **no lint config, no test suite, and no build step** in this repo. "Build" is just running
  the server; do not invent build/lint/test commands.
- Quick health check: `curl -s localhost:3000/api/health`.

### Providers / external deps (important gotchas)
- Job provider defaults to `gemini-browser`, which **auto-starts on job creation** and requires a
  logged-in Chrome + Gemini session (and/or `GEMINI_API_KEY`). Without those it fails partway with a
  Korean error about not selecting the 9:16 aspect ratio. This is expected without credentials.
- To exercise the full render pipeline **with no external services**, use `provider: "local"` with
  `voiceover: false`, upload clips, then run it:
  1. `POST /api/jobs` body `{"topic":"...","provider":"local","voiceover":false,"captions":true,"clipCount":2}`
  2. `POST /api/jobs/<id>/clips` multipart field `files` (mp4/mov/webm, `type` must start with `video/`)
  3. `POST /api/jobs/<id>/run` — the run endpoint is **`run`, not `start`**.
  Output lands in `workspace/jobs/<id>/final.mp4` (also under the immutable `runs/<runId>/artifacts/`).
- **Voiceover requires macOS `say`** and therefore fails on Linux; keep `voiceover:false` here.
- All API messages/errors are in Korean — this is normal, not a bug.

### State
- Generated jobs/artifacts go under `workspace/` (gitignored). Safe to delete to reset state.
