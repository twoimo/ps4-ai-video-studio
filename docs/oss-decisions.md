# Open-source decisions and ADR

## Status

Accepted for the current prototype, 2026-08-12. Revisit before a public release or a change to the rendering/provider boundary.

## Decision drivers

The project needs to produce a repeatable local MP4 while preserving evidence about every input. The selection criteria are therefore:

1. deterministic, scriptable output rather than an interactive-only editing state;
2. no forced upload of source footage to an additional service;
3. inspectable commands, files, hashes and failure modes;
4. headless operation that can be wrapped in a run receipt;
5. a small integration surface that can be tested without paid provider calls;
6. a license that can be reviewed before distribution.

GitHub star count was used only as a maintenance/community signal. It is volatile and does not establish API suitability, security, license compatibility or production readiness.

## ADR-001: Bun as the application runtime

**Decision:** accepted and used at runtime.

The server and scripts use `Bun.serve`, `Bun.spawn`, `Bun.file`, `Bun.write`, native `fetch` and WebSocket APIs. `package.json` currently declares no npm dependencies. Bun gives this small local application a single runtime without introducing an application framework.

**Trade-offs:** the code is not drop-in Node.js code even though files use ESM and Node built-ins. CI therefore installs Bun explicitly, while `node --check` is used only for syntax checks.

**License:** Bun is MIT licensed. It is installed externally and not vendored in this repository.

## ADR-002: FFmpeg/ffprobe as the media engine

**Decision:** accepted and used at runtime.

FFmpeg performs scale/pad, H.264 normalization, concat, audio timing and loudness filters, subtitle burn-in, thumbnails and temporal perceptual-hash frame extraction. `ffprobe` validates duration, streams, dimensions and media properties. This produces explicit commands and file outputs that can be hashed and placed in a run manifest.

**Why not an editor application as the core:** an interactive timeline is useful to a human editor, but the submission requirement is unattended, repeatable rendering with run-bound evidence. Adding an entire editor would not remove the need for a deterministic render backend and would enlarge the trusted surface.

**Trade-offs:** filter availability and licensing depend on the user’s FFmpeg build. The repository does not distribute an FFmpeg binary. Operators must inspect their build configuration and comply with its license.

**License:** FFmpeg is primarily LGPL-2.1-or-later, while enabling GPL components changes the applicable obligations. See [FFmpeg Legal](https://ffmpeg.org/legal.html) and the locally installed binary’s `ffmpeg -L`/build configuration.

## ADR-003: yt-dlp for public benchmark acquisition

**Decision:** accepted and used at runtime.

`yt-dlp` retrieves channel/profile metadata, flat Videos/Shorts playlists and optional low-resolution benchmark samples. The refresh code records the tool version and rejects incomplete or duplicate snapshots.

**Trade-offs:** extractors must track upstream site changes. The project exposes `bun run yt-dlp:update` and records the installed version. Downloading media is optional and must follow YouTube terms and applicable copyright rules.

**License:** yt-dlp is released under The Unlicense. It is invoked as an external executable and is not vendored. See [yt-dlp/COPYING](https://github.com/yt-dlp/yt-dlp/blob/master/COPYING).

## ADR-004: direct Chrome DevTools Protocol for Gemini UI automation

**Decision:** accepted for the current Gemini web fallback.

The repository contains a small, task-specific CDP client rather than adopting a general browser-agent runtime. It opens a target in a dedicated local Chrome profile, checks the video mode and requested aspect ratio, detects quota messages, downloads new results, and records session provenance.

**Trade-offs:** Gemini’s UI is not a stable API and selectors can break. A documented official generation API should be preferred when it supports the needed workflow. CDP automation never authorizes login/CAPTCHA/quota bypass.

Chrome is an external browser with its own terms; “Chrome CDP” is not presented here as an open-source dependency shipped by this project. Chromium licensing differs from Google Chrome distribution terms.

## ADR-005: generic receipt protocol for video providers

**Decision:** accepted and used at runtime.

The pipeline does not import each provider SDK. It executes one configured file, sends a stable JSON request over stdin, then validates a JSON receipt from stdout against job/run/request/script hashes and the generated files. The FLUX 3 adapter implements this boundary.

This keeps provider-specific networking, credentials, cost controls and retries outside the core renderer. A future Seedance, Higgsfield, ComfyUI or other adapter can be added without claiming equivalence until it emits the same verifiable receipt.

**Trade-offs:** the adapter executable is trusted code on the local machine. Receipt validation detects mismatched files and provenance but cannot sandbox a malicious executable.

## ADR-006: `browser-use/video-use`

**Decision:** researched; not adopted as runtime code.

Repository reviewed: [browser-use/video-use](https://github.com/browser-use/video-use), MIT license at the time of review.

The project is relevant as a reference for agent-driven video workflows and provider orchestration. The current repository, however, has no `video-use` dependency, import, vendored source or executed command. The narrower CDP adapter plus stdin/stdout provider contract gives tighter control over profile binding, paid retries and immutable receipts for this prototype.

**Revisit when:** a verified use case needs its broader agent workflow and it can be wrapped with the same run ID, cost ceiling, output hashes and no-fallback policy.

## ADR-007: OpenCut

**Decision:** researched; not adopted as runtime code.

Repository reviewed: [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut), MIT license at the time of review.

OpenCut is attractive as an open-source editing UI. This repository currently needs unattended assembly and evidence-first validation more than another interactive timeline, so FFmpeg remains the render engine. There is no OpenCut dependency, import, vendored source, plugin, MCP integration or runtime command in this codebase.

**Revisit when:** a human finishing UI is explicitly required and an integration can round-trip the timeline without losing source hashes, caption timing, provider provenance or the final deterministic render receipt.

## Considered but not claimed as adopted

ComfyUI, Whisper/faster-whisper/WhisperX, OpenTimelineIO, Remotion, MoneyPrinterTurbo and other AI-video projects were considered during ecosystem research. None is an installed or imported runtime dependency in the current repository. In particular, the current caption timing is script/voice-duration based; the project must not describe it as Whisper or forced alignment.

Future adoption must include:

- a concrete gap it closes;
- a pinned version or commit and license review;
- an SBOM/NOTICE update;
- deterministic test fixtures;
- integration into job/run provenance;
- explicit handling of model weights and their separate licenses;
- no paid or external calls in default CI.

## Services and non-OSS system dependencies

The following are not bundled open-source libraries in this repository:

- Google Gemini web service and optional Gemini API;
- Black Forest Labs FLUX 3 API;
- Google Chrome distribution;
- macOS `say` voice synthesis;
- YouTube as the source platform.

Their service terms, account permissions, output rights, rate limits and costs apply separately. A link to or adapter for a service does not grant rights to its models, data or outputs.

## Attribution and distribution posture

- No third-party repository source is vendored in the current tree.
- Runtime tools are installed by the operator and invoked as external executables.
- Research-only projects are named for transparency, not as dependencies or endorsements.
- The project’s own license is currently unspecified; no `LICENSE` file should be inferred from third-party licenses.
- Before distributing a binary/container, regenerate a dependency inventory and include the exact notices for every bundled artifact and FFmpeg build option.

See [`NOTICE.md`](../NOTICE.md) for the concise attribution list.
