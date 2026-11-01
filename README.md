# DisplayX - Premiere Pro CEP Extension

DisplayX is an in-app YouTube reference player for Adobe Premiere Pro. It is designed for editors who need to search for and watch reference videos without leaving Premiere Pro.

## Folder Structure

- `CSXS/manifest.xml`: CEP extension manifest.
- `.debug`: Chrome Remote Debugging port configuration.
- `index.html`: Main UI (player stage, search, categories, and video grid).
- `css/style.css`: Dark Premiere Pro-style interface.
- `js/main.js`: YouTube search, autocomplete, favorites/history, local player service, and thumbnail loading.
- `js/CSInterface.js`: CEP interface bridge.
- `jsx/hostscript.jsx`: ExtendScript host script.

## Playback Architecture

DisplayX uses YouTube's standard embedded player. It does not extract direct `googlevideo` MP4 URLs for playback.

When CEP Node integration is available, the extension starts a small HTTP server bound only to `127.0.0.1:48293`:

- `/player?v=VIDEO_ID` serves a lightweight local HTML page with the official YouTube `<iframe>` player. The local page uses `Referrer-Policy: origin` and `referrerpolicy="origin"` on the video frame.
- DisplayX does not load the separate YouTube IFrame Player API JavaScript. This avoids the extra API bootstrap/widget script chain that can time out in some CEP/CEF browser builds.
- The YouTube iframe owns its native playback UI and displays video-specific messages when the video is private, removed, or embedding is disabled.
- `/thumb?v=VIDEO_ID` retrieves a thumbnail from `i.ytimg.com` and tries `maxresdefault`, `sddefault`, `hqdefault`, `mqdefault`, and `default` in order. This provides a same-origin image URL to CEP/CEF and reduces blank thumbnail cards.

The server listens on loopback only; it is not exposed to the local network.

## Playback Diagnostics (v1.1.4)

When the extension is open in Premiere Pro, open this local health URL in Chrome:

`http://127.0.0.1:48293/health`

A working local server returns JSON with `"status":"ok"`.

To compare the player outside CEP, copy the 11-character YouTube video ID and open:

`http://127.0.0.1:48293/player?v=VIDEO_ID&debug=1`

Replace `VIDEO_ID` with the selected video's ID. The diagnostic overlay distinguishes the local DisplayX page from the YouTube iframe navigation event. An iframe load event alone does not prove the video rendered. To test YouTube's privacy-enhanced embed host, append `&host=nocookie` to the URL.

## Search

- The primary search engine requests YouTube search results over HTTPS and parses the page's initial video data.
- Autocomplete uses YouTube search suggestions.
- The optional `yt-dlp` fallback is used only for search results when direct search parsing is unavailable; it is not used to extract a playback URL.

## Notes and Limitations

- Playback requires an internet connection and videos must allow embedding.
- Private, deleted, age-restricted, region-restricted, or embedding-disabled videos may not play inside the extension. Use **Open in Browser** for those videos.
- Some thumbnail sizes are not provided for every video; the local thumbnail route automatically tries smaller alternatives.
- The YouTube player is controlled by YouTube's own embedded-player UI and availability rules.
- Premiere's embedded Chromium/CEP runtime must be able to load the YouTube iframe and send its HTTP Referer. The YouTube iframe itself displays video availability and embedding errors.
- CEP Node integration must be enabled by the extension manifest for the local player and thumbnail service to run.
