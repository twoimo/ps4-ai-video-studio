# Notices and attribution

This file records third-party software and services referenced or invoked by PS4 AI Video Studio. It is not a substitute for the corresponding license texts or service terms.

## Project license status

No license has been selected for this repository itself. No `LICENSE` file is present. Access to the source does not, by itself, grant permission to use, copy, modify, or distribute it. The rights holder must make that decision separately.

## Runtime tools actually used

### Bun

- Project: <https://github.com/oven-sh/bun>
- License: MIT
- Use: JavaScript runtime, HTTP server, subprocess and file APIs
- Distribution: installed externally; no Bun source or binary is vendored here

### FFmpeg and ffprobe

- Project: <https://ffmpeg.org/>
- Legal and license information: <https://ffmpeg.org/legal.html>
- Use: media probe, normalization, concatenation, audio processing, caption burn-in, thumbnails and media analysis
- Distribution: installed externally; no FFmpeg source or binary is vendored here

FFmpeg is primarily LGPL-2.1-or-later, but a build that enables GPL components is subject to different obligations. Compliance must be evaluated against the exact installed or distributed build.

### yt-dlp

- Project: <https://github.com/yt-dlp/yt-dlp>
- License: The Unlicense
- License text: <https://github.com/yt-dlp/yt-dlp/blob/master/COPYING>
- Use: public YouTube channel metadata and optional benchmark media acquisition
- Distribution: installed externally; no yt-dlp source or binary is vendored here

## Researched projects not used as runtime dependencies

The following repositories informed the architecture review. Their code is not imported, installed, copied, vendored or executed by the current application.

### video-use

- Project: <https://github.com/browser-use/video-use>
- License observed during review: MIT
- Status: research/ADR only

### OpenCut

- Project: <https://github.com/OpenCut-app/OpenCut>
- License observed during review: MIT
- Status: research/ADR only

Any later adoption requires rechecking the license at the exact version or commit used and updating this notice.

## External services and platform software

The application can interoperate with the following separately governed products:

- Google Gemini web service and Gemini API: <https://gemini.google.com/> and <https://ai.google.dev/>
- Black Forest Labs FLUX 3 API: <https://docs.bfl.ai/flux_3/flux3_overview>
- Google Chrome or Chromium via the Chrome DevTools Protocol
- YouTube as a public benchmark metadata source
- macOS `say` for optional local voice synthesis

These products and services are not licensed by this notice. Their current terms, account permissions, prices, model/output conditions and platform policies apply. Google, Gemini, YouTube, Chrome, Black Forest Labs, FLUX, OpenCut, video-use and other names are the property of their respective owners.

## Benchmark and generated content

The benchmark identifies the public YouTube channel `신비한 건축사전` and stores public titles, links and metadata for analysis. The committed media-analysis receipt stores aggregate frame, audio and caption measurements plus hashes of locally acquired caption files; it does not store caption cue text, word text or cue/word timing records. The project is not affiliated with or endorsed by that channel or YouTube. Optional downloaded benchmark media and raw captions are kept in ignored local workspace storage and are not intended for repository distribution.

AI-generated media, user-uploaded clips, narration, sources and final exports may carry separate copyright, privacy, publicity, trademark and platform-policy obligations. The operator is responsible for reviewing those rights before publication or submission.
