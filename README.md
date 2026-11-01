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

- `/player?v=VIDEO_ID` serves a lightweight local HTML page that initializes the official YouTube IFrame Player API. The local page has a normal HTTP origin and sets the matching `origin` parameter and `Referrer-Policy`.
- Player readiness, buffering, and YouTube embed errors are reported back to the extension. Errors such as 101/150 (embedding disabled) and 153 (missing HTTP Referer/client identity) are shown in the player area instead of leaving an unexplained black screen.
- `/thumb?v=VIDEO_ID` retrieves a thumbnail from `i.ytimg.com` and tries `maxresdefault`, `sddefault`, `hqdefault`, `mqdefault`, and `default` in order. This provides a same-origin image URL to CEP/CEF and reduces blank thumbnail cards.

The server listens on loopback only; it is not exposed to the local network.

## Search

- The primary search engine requests YouTube search results over HTTPS and parses the page's initial video data.
- Autocomplete uses YouTube search suggestions.
- The optional `yt-dlp` fallback is used only for search results when direct search parsing is unavailable; it is not used to extract a playback URL.

## Notes and Limitations

- Playback requires an internet connection and videos must allow embedding.
- Private, deleted, age-restricted, region-restricted, or embedding-disabled videos may not play inside the extension. Use **Open in Browser** for those videos.
- Some thumbnail sizes are not provided for every video; the local thumbnail route automatically tries smaller alternatives.
- The YouTube player is controlled by YouTube's own embedded-player UI and availability rules.
- Premiere's embedded Chromium/CEP runtime must be compatible with the current YouTube IFrame Player API. If the API reports an error, the player overlay displays the reported code/message to help identify whether the cause is video restrictions, missing referrer identity, or browser compatibility.
- CEP Node integration must be enabled by the extension manifest for the local player and thumbnail service to run.
