# DisplayX - Premiere Pro CEP Extension
In-app YouTube Reference Player for Adobe Premiere Pro (Inspired by Fred Pelle DisplayX).

## Folder Structure
- `CSXS/manifest.xml`: CEP extension manifest (CEP 9-12 / Premiere Pro 2023+ compatible).
- `.debug`: Debugging port configuration (Port 8092 for Chrome Remote Debugging).
- `index.html`: Main UI markup (Player stage, search bar, category pills, video grid).
- `css/style.css`: Modern Premiere Pro dark theme UI styling.
- `js/main.js`: Core logic for YouTube HTTPS search, autocomplete, local reverse proxy, dual-mode streaming (Direct MP4 via googlevideo & Referer-injected YouTube Embed).
- `js/CSInterface.js`: Official Adobe CEP interface library.
- `jsx/hostscript.jsx`: Adobe Premiere Pro ExtendScript host script.

## Technical Notes:
1. **Error 153 Resolution**:
   YouTube's embedded player blocks playback when embedded from `file:///` origins or cross-protocol HTTP->HTTPS without a valid Referer header (`PLAYABILITY_ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER`).
   DisplayX solves this with two complementary approaches:
   - **Mode 1: Direct Progressive MP4 (`<video>`)**: Extracts progressive MP4 googlevideo streams via `yt-dlp -g -f 18/b[ext=mp4]/best`. Bypasses YouTube embed scripts, ads, and CORS completely with native HTML5 player controls.
   - **Mode 2: Local Reverse Proxy**: Local Node server on `127.0.0.1:48292` fetches YouTube embed with `Referer: https://www.google.com/` and injects `<base href="https://www.youtube.com/">`.
