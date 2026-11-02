/**
 * main.js - DisplayX Controller
 * In-App YouTube Streaming & Reference Player for Adobe Premiere Pro
 * Inspired by Fred Pelle DisplayX
 */

(function () {
    'use strict';

    // Locate Node.js modules in Adobe CEP
    const nodeRequire = (typeof require !== 'undefined' ? require : null) ||
                        (window.require ? window.require : null) ||
                        (window.cep_node && window.cep_node.require ? window.cep_node.require : null);

    let fs = null;
    let cp = null;
    let https = null;
    let http = null;

    if (nodeRequire) {
        try {
            fs = nodeRequire('fs');
            cp = nodeRequire('child_process');
            https = nodeRequire('https');
            http = nodeRequire('http');
        } catch (e) {
            console.warn("DisplayX: Node.js modules not fully loaded", e);
        }
    }

    const csInterface = new CSInterface();

    // Local HTTP origin for the official YouTube embed and thumbnail proxy
    const PLAYER_PORT = 48293;
    let playerServer = null;
    let playerLoadTimer = null;

    // Proxy YouTube thumbnails through localhost so CEP/CEF does not need to
    // load i.ytimg.com directly from a file:// extension origin.
    function serveThumbnail(videoId, res) {
        if (!https) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            return res.end('Thumbnail service unavailable');
        }

        const variants = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', 'default'];

        function tryVariant(index) {
            if (res.finished) return;
            if (index >= variants.length) {
                if (!res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                    res.end('Thumbnail not found');
                }
                return;
            }

            const imagePath = `/vi/${videoId}/${variants[index]}.jpg`;
            let advanced = false;
            const next = () => {
                if (advanced) return;
                advanced = true;
                tryVariant(index + 1);
            };

            const request = https.get({
                hostname: 'i.ytimg.com',
                path: imagePath,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
                }
            }, (upstream) => {
                if (upstream.statusCode !== 200) {
                    upstream.resume();
                    return next();
                }

                res.writeHead(200, {
                    'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                    'X-Content-Type-Options': 'nosniff'
                });
                upstream.on('error', () => {
                    if (!res.destroyed) res.destroy();
                });
                upstream.pipe(res);
            });

            request.on('error', next);
            request.setTimeout(6000, () => request.destroy(new Error('Thumbnail request timed out')));
        }

        tryVariant(0);
    }

    // In-Memory Stream Registry & 6MB Range Chunking Proxy (Zero-Disk Storage Architecture)
    const streamRegistry = {};
    const MAX_RAM_CHUNK = 6 * 1024 * 1024; // 6MB in RAM to prevent YouTube speed throttling

    function forwardRangeRequest(entry, clientReq, clientRes, redirectCount = 0) {
        if (redirectCount > 5) {
            clientRes.writeHead(502);
            return clientRes.end("Too many redirects");
        }

        const targetUrl = entry.currentUrl || entry.url;
        let parsedTarget;
        try {
            parsedTarget = new URL(targetUrl);
        } catch (e) {
            clientRes.writeHead(400);
            return clientRes.end("Invalid target URL");
        }

        let totalSize = entry.filesize || 0;
        if (!totalSize && parsedTarget.searchParams.has('clen')) {
            totalSize = parseInt(parsedTarget.searchParams.get('clen'), 10) || 0;
        }

        const reqHeaders = {
            "User-Agent": (entry.headers && entry.headers["User-Agent"]) ||
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Connection": "keep-alive"
        };

        const incomingRange = clientReq.headers["range"];
        if (incomingRange && totalSize > 0) {
            const match = incomingRange.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                const start = parseInt(match[1], 10);
                let end = match[2] ? parseInt(match[2], 10) : Math.min(totalSize - 1, start + MAX_RAM_CHUNK - 1);
                if (end - start >= MAX_RAM_CHUNK) {
                    end = Math.min(totalSize - 1, start + MAX_RAM_CHUNK - 1);
                }
                reqHeaders["Range"] = `bytes=${start}-${end}`;
            } else {
                reqHeaders["Range"] = incomingRange;
            }
        } else if (incomingRange) {
            reqHeaders["Range"] = incomingRange;
        }

        const requestLib = parsedTarget.protocol === "http:" ? http : https;
        const options = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port || (parsedTarget.protocol === "http:" ? 80 : 443),
            path: parsedTarget.pathname + parsedTarget.search,
            method: "GET",
            headers: reqHeaders
        };

        const upstreamReq = requestLib.request(options, (upstreamRes) => {
            if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
                upstreamRes.resume();
                entry.currentUrl = upstreamRes.headers.location;
                return forwardRangeRequest(entry, clientReq, clientRes, redirectCount + 1);
            }

            const resHeaders = {
                "Content-Type": entry.mimeType || upstreamRes.headers["content-type"] || "video/webm",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store"
            };
            if (upstreamRes.headers["content-range"]) {
                resHeaders["Content-Range"] = upstreamRes.headers["content-range"];
            }
            if (upstreamRes.headers["content-length"]) {
                resHeaders["Content-Length"] = upstreamRes.headers["content-length"];
            }

            clientRes.writeHead(upstreamRes.statusCode || 200, resHeaders);
            upstreamRes.pipe(clientRes);

            clientReq.on("close", () => {
                try { upstreamReq.destroy(); } catch (e) {}
            });
        });

        upstreamReq.on("error", (err) => {
            if (!clientRes.headersSent) {
                clientRes.writeHead(502);
            }
            clientRes.end();
        });

        upstreamReq.end();
    }

    function startLocalPlayerServer() {
        if (playerServer || !http) return;
        try {
            playerServer = http.createServer(async (req, res) => {
                let parsed;
                try {
                    parsed = new URL(req.url, `http://127.0.0.1:${PLAYER_PORT}`);
                } catch (e) {
                    res.writeHead(400);
                    return res.end();
                }

                if (parsed.pathname === '/health') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'Access-Control-Allow-Origin': '*'
                    });
                    return res.end(JSON.stringify({
                        status: 'ok',
                        service: 'DisplayX Player Service (RefTube Pro Engine Active)',
                        version: '2.5.0',
                        port: PLAYER_PORT
                    }));
                }

                if (parsed.pathname === '/player') {
                    const vidId = parsed.searchParams.get('v') || '';
                    const isLoop = parsed.searchParams.get('loop') === '1';
                    const embedDomain = parsed.searchParams.get('host') === 'nocookie'
                        ? 'www.youtube-nocookie.com'
                        : 'www.youtube.com';

                    if (!/^[a-zA-Z0-9_-]{11}$/.test(vidId)) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        return res.end('Invalid YouTube video id');
                    }

                    const loopParams = isLoop ? `&loop=1&playlist=${vidId}` : '';
                    const embedUrl = `https://${embedDomain}/embed/${vidId}?autoplay=1&playsinline=1&controls=1&rel=0&modestbranding=1${loopParams}`;
                    const playerHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="referrer" content="origin">
<title>DisplayX Player</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
#yt-player { width: 100%; height: 100%; border: none; display: block; background: #000; }
</style>
</head>
<body>
<iframe
  id="yt-player"
  src="${embedUrl}"
  title="YouTube video player"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  allowfullscreen
  referrerpolicy="origin"></iframe>
</body>
</html>`;

                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'Referrer-Policy': 'origin',
                        'X-Content-Type-Options': 'nosniff'
                    });
                    return res.end(playerHtml);
                }

                if (parsed.pathname === '/stream') {
                    // RefTube Pro In-Memory Stream Key (Direct WebM VP9 Video / Opus Audio in RAM)
                    const key = parsed.searchParams.get('key');
                    if (key && streamRegistry[key]) {
                        return forwardRangeRequest(streamRegistry[key], req, res, 0);
                    }

                    // Fallback to direct video id
                    const vidId = parsed.searchParams.get('v') || '';
                    const quality = parsed.searchParams.get('q') || 'auto';
                    if (!/^[a-zA-Z0-9_-]{11}$/.test(vidId)) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        return res.end('Invalid YouTube video id or stream key');
                    }
                    try {
                        const directUrl = await resolveStreamUrl(vidId, quality);
                        const target = new URL(directUrl);
                        const reqHeaders = {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': '*/*'
                        };
                        if (req.headers.range) reqHeaders['Range'] = req.headers.range;
                        const upstream = https.request({
                            hostname: target.hostname,
                            path: target.pathname + target.search,
                            method: 'GET',
                            headers: reqHeaders
                        }, (upRes) => {
                            const outHeaders = {
                                'Content-Type': upRes.headers['content-type'] || 'video/mp4',
                                'Accept-Ranges': 'bytes',
                                'Access-Control-Allow-Origin': '*'
                            };
                            if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];
                            if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
                            res.writeHead(upRes.statusCode, outHeaders);
                            upRes.pipe(res);
                        });
                        upstream.on('error', (err) => {
                            if (!res.headersSent) res.writeHead(502);
                            res.end('Upstream stream error: ' + err.message);
                        });
                        req.on('close', () => { try { upstream.destroy(); } catch (e) {} });
                        upstream.end();
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                        res.end('Stream error: ' + err.message);
                    }
                    return;
                }

                if (parsed.pathname === '/thumb') {
                    const vidId = parsed.searchParams.get('v') || '';
                    if (!/^[a-zA-Z0-9_-]{11}$/.test(vidId)) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        return res.end('Invalid YouTube video id');
                    }
                    return serveThumbnail(vidId, res);
                }

                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('DisplayX Player Service Active');
            });

            playerServer.listen(PLAYER_PORT, '127.0.0.1', () => {
                console.log(`DisplayX Player Server running on port ${PLAYER_PORT}`);
            });

            playerServer.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`DisplayX Player Server already active on port ${PLAYER_PORT}`);
                } else {
                    console.warn('DisplayX Server notice:', err.message);
                }
            });
        } catch (e) {
            console.warn('DisplayX Server init error:', e.message);
        }
    }

    startLocalPlayerServer();

    window.addEventListener('beforeunload', () => {
        if (playerServer) {
            try { playerServer.close(); } catch (e) {}
        }
    });

    // DOM Elements
    const playerStage = document.getElementById('playerStage');
    const nativePlayer = document.getElementById('nativePlayer');
    const nativeAudio = document.getElementById('nativeAudio');
    const playerLoading = document.getElementById('playerLoading');
    const playerLoadingText = document.getElementById('playerLoadingText');
    const playerPlaceholder = document.getElementById('playerPlaceholder');

    // Timeline Bar Elements
    const timelineBar = document.getElementById('timelineBar');
    const timelineTrack = document.getElementById('timelineTrack');
    const timelineProgress = document.getElementById('timelineProgress');
    const timelineLoopRegion = document.getElementById('timelineLoopRegion');
    const timelineMarkerIn = document.getElementById('timelineMarkerIn');
    const timelineMarkerOut = document.getElementById('timelineMarkerOut');
    const timelinePlayhead = document.getElementById('timelinePlayhead');

    // Now Playing Bar Elements
    const nowPlayingBar = document.getElementById('nowPlayingBar');
    const nowPlayingTitle = document.getElementById('nowPlayingTitle');
    const nowPlayingChannel = document.getElementById('nowPlayingChannel');
    const nowPlayingDuration = document.getElementById('nowPlayingDuration');
    const loopRangeBadge = document.getElementById('loopRangeBadge');

    // In / Out & Loop Controls
    const btnMarkIn = document.getElementById('btnMarkIn');
    const btnMarkOut = document.getElementById('btnMarkOut');
    const btnClearInOut = document.getElementById('btnClearInOut');
    const btnToggleLoop = document.getElementById('btnToggleLoop');
    const btnHeaderLoop = document.getElementById('btnHeaderLoop');

    const btnAudioToggle = document.getElementById('btnAudioToggle');
    const volumeSlider = document.getElementById('volumeSlider');
    const btnBookmark = document.getElementById('btnBookmark');
    const bookmarkIcon = document.getElementById('bookmarkIcon');
    const btnCopyLink = document.getElementById('btnCopyLink');
    const btnOpenNowPlaying = document.getElementById('btnOpenNowPlaying');

    const playerOsd = document.getElementById('playerOsd');
    const btnStepBack = document.getElementById('btnStepBack');
    const btnStepForward = document.getElementById('btnStepForward');
    const btnQuality = document.getElementById('btnQuality');
    const qualityMenu = document.getElementById('qualityMenu');
    const currentQualityLabel = document.getElementById('currentQualityLabel');
    const btnSpeed = document.getElementById('btnSpeed');
    const speedMenu = document.getElementById('speedMenu');
    const currentSpeedLabel = document.getElementById('currentSpeedLabel');

    // Box 1: Direct YouTube URL / Paste Stream
    const urlInput = document.getElementById('urlInput');
    const btnClearUrl = document.getElementById('btnClearUrl');
    const btnStreamUrl = document.getElementById('btnStreamUrl');
    const btnPasteClipboardDirect = document.getElementById('btnPasteClipboardDirect');

    // Box 2: Search YouTube
    const searchInput = document.getElementById('searchInput');
    const btnSearch = document.getElementById('btnSearch');
    const btnClearSearch = document.getElementById('btnClearSearch');
    const suggestionsList = document.getElementById('suggestionsList');

    const categoryPills = document.querySelectorAll('.dx-pill');
    const sectionTitle = document.getElementById('sectionTitle');
    const videoGrid = document.getElementById('videoGrid');
    const btnViewGrid = document.getElementById('btnViewGrid');
    const btnViewList = document.getElementById('btnViewList');

    const btnToggleTheater = document.getElementById('btnToggleTheater');
    const btnExternalBrowser = document.getElementById('btnExternalBrowser');

    const clipboardBanner = document.getElementById('clipboardBanner');
    const clipboardText = document.getElementById('clipboardText');
    const btnPlayClipboard = document.getElementById('btnPlayClipboard');
    const btnCloseClipboard = document.getElementById('btnCloseClipboard');

    const toastMessage = document.getElementById('toastMessage');

    // State (Zero-Disk Pro Stream Architecture: WebM VP9 Video + Opus Audio in RAM)
    let currentVideo = null; // { id, title, channel, duration }
    let playerMode = 'pro'; // Pure Pro Stream
    let currentQuality = 'auto'; // 'auto', '2160', '1440', '1080', '720', '480', '360'
    let currentSpeed = 1.0;
    let currentVideoFps = 30;
    let hasSeparateAudio = false;
    let isAudioMuted = false;
    let audioVolume = 0.85;

    // Loop & In/Out Range State (Premiere Pro NLE Style)
    let isLooping = true; // Enabled by default for reference reviewing
    let loopIn = null; // in seconds
    let loopOut = null; // in seconds

    let isSearching = false;
    let lastDetectedClipboard = "";
    let searchDebounceTimer = null;
    let osdTimer = null;
    let activeYtDlpProc = null;
    const videoMetadataCache = new Map();

    // Local Storage Keys
    const STORAGE_KEY_FAVORITES = 'displayx_favorites';
    const STORAGE_KEY_HISTORY = 'displayx_history';

    // ==========================================
    // UTILITIES & ENVIRONMENT HELPERS
    // ==========================================
    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatViewCount(count) {
        if (!count) return "";
        if (typeof count === 'string' && (count.includes('views') || count.includes('view') || count.includes('tayangan'))) {
            return count;
        }
        const num = Number(count);
        if (!num || isNaN(num)) return count ? String(count) : "";
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M views';
        if (num >= 1000) return Math.round(num / 1000) + 'K views';
        return num + ' views';
    }

    function showToast(text, duration = 3000) {
        if (!toastMessage) return;
        toastMessage.textContent = text;
        toastMessage.classList.add('show');
        setTimeout(() => {
            toastMessage.classList.remove('show');
        }, duration);
    }

    function cleanCepPath(p) {
        if (!p) return "";
        try { p = decodeURIComponent(p); } catch (e) {
            try { p = decodeURI(p); } catch (e2) {}
        }
        return String(p).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:\/)/, '$1');
    }

    function getProcessEnv() {
        const standardPaths = [
            '/Users/ketut/.deno/bin',
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ];
        const existingPath = (typeof process !== 'undefined' && process.env && process.env.PATH) ? process.env.PATH : '';
        const combinedPath = standardPaths.join(':') + (existingPath ? ':' + existingPath : '');
        const home = (typeof process !== 'undefined' && process.env && process.env.HOME) ? process.env.HOME : '/Users/ketut';

        return Object.assign({}, (typeof process !== 'undefined' && process.env) ? process.env : {}, {
            PATH: combinedPath,
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            HOME: home
        });
    }

    function resolveYtDlp() {
        let extClean = "";
        try {
            const extRaw = csInterface.getSystemPath(SystemPath.EXTENSION);
            extClean = cleanCepPath(extRaw);
        } catch (e) {}

        const candidates = [
            extClean ? `${extClean}/bin/yt-dlp` : '',
            '/Users/ketut/.gemini/antigravity/scratch/com.displayx.panel/bin/yt-dlp',
            '/opt/homebrew/bin/yt-dlp',
            '/usr/local/bin/yt-dlp',
            '/Users/ketut/.gemini/antigravity/scratch/com.ytdownload.panel/bin/yt-dlp'
        ].filter(Boolean);

        if (fs) {
            for (const p of candidates) {
                try {
                    if (fs.existsSync(p)) return p;
                } catch (e) {}
            }
        }
        return '/opt/homebrew/bin/yt-dlp';
    }

    const streamUrlCache = new Map();
    function resolveStreamUrl(videoId, quality = 'auto') {
        const cacheKey = `${videoId}_${quality}`;
        return new Promise((resolve, reject) => {
            if (streamUrlCache.has(cacheKey)) {
                const entry = streamUrlCache.get(cacheKey);
                if (Date.now() - entry.time < 15 * 60 * 1000) {
                    return resolve(entry.url);
                }
            }
            if (!cp) return reject(new Error("child_process not available"));
            const ytDlp = resolveYtDlp();

            let formatRule = '22/18/b[ext=mp4]/best[ext=mp4]/best';
            if (quality === '720') {
                formatRule = '22/b[ext=mp4][height<=720]/18/best[ext=mp4]';
            } else if (quality === '480') {
                formatRule = '18/b[ext=mp4][height<=480]/best[height<=480]';
            } else if (quality === '360') {
                formatRule = '18/b[ext=mp4][height<=360]';
            }

            const args = ['--force-ipv4', '-g', '-f', formatRule, `https://www.youtube.com/watch?v=${videoId}`];
            const env = getProcessEnv();
            cp.execFile(ytDlp, args, { env, timeout: 20000 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                const url = stdout.trim().split('\n')[0].trim();
                if (!url || !url.startsWith('http')) return reject(new Error("Invalid stream URL"));
                streamUrlCache.set(cacheKey, { url, time: Date.now() });
                resolve(url);
            });
        });
    }

    function extractYouTubeId(url) {
        if (!url || typeof url !== 'string') return null;
        const clean = url.trim();

        // 11 characters ID
        if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) {
            return clean;
        }

        // Comprehensive match for all YouTube URL variants (watch, youtu.be, shorts, live, embed, v)
        const match = clean.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|live\/|watch\?v=|watch\?.+&v=))([\w-]{11})/i);
        if (match) return match[1];

        // Query param fallback
        const queryMatch = clean.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (queryMatch) return queryMatch[1];

        return null;
    }

    // ==========================================
    // YOUTUBE PLAYER CONTROLLER
    // ==========================================
    function showPlayerLoading(text) {
        if (playerLoading) {
            if (playerLoadingText) playerLoadingText.textContent = text || 'Memuat Video...';
            playerLoading.style.display = 'flex';
        }
    }

    function showPlayerError(message) {
        if (!playerLoading) {
            showToast(message, 8000);
            return;
        }
        if (playerLoadingText) playerLoadingText.textContent = message;
        playerLoading.classList.add('dx-player-error');
        playerLoading.style.display = 'flex';
    }

    function hidePlayerLoading() {
        if (playerLoading) {
            playerLoading.classList.remove('dx-player-error');
            playerLoading.style.display = 'none';
        }
    }

    // ==========================================
    // REFTUBE PRO DUAL-STREAM ENGINE (VP9 + OPUS)
    // ==========================================
    function applyAudioSettings() {
        if (!nativeAudio) return;
        nativeAudio.muted = isAudioMuted;
        nativeAudio.volume = isAudioMuted ? 0 : audioVolume;

        if (nativePlayer) {
            nativePlayer.muted = true; // Video element is pure WebM VP9 video
        }

        if (btnAudioToggle) {
            if (isAudioMuted || audioVolume === 0) {
                btnAudioToggle.textContent = '🔇 Mute';
                btnAudioToggle.classList.remove('audio-active');
                btnAudioToggle.classList.add('audio-muted');
            } else {
                btnAudioToggle.textContent = '🔊 Audio';
                btnAudioToggle.classList.add('audio-active');
                btnAudioToggle.classList.remove('audio-muted');
            }
        }

        if (volumeSlider) {
            volumeSlider.value = isAudioMuted ? 0 : Math.round(audioVolume * 100);
        }
    }

    function syncAudioWithVideo(forceSeek = false) {
        if (!nativePlayer || !nativeAudio || !hasSeparateAudio) {
            return;
        }

        nativePlayer.muted = true;
        nativeAudio.muted = isAudioMuted;
        nativeAudio.volume = isAudioMuted ? 0 : audioVolume;
        nativeAudio.playbackRate = nativePlayer.playbackRate || 1;

        if (isAudioMuted) {
            if (!nativeAudio.paused) nativeAudio.pause();
            return;
        }

        const vTime = nativePlayer.currentTime || 0;
        const aTime = nativeAudio.currentTime || 0;
        if (forceSeek || Math.abs(vTime - aTime) > 0.08) {
            try {
                nativeAudio.currentTime = vTime;
            } catch (e) {}
        }

        if (!nativePlayer.paused && nativeAudio.paused && nativePlayer.readyState >= 2) {
            nativeAudio.play().catch(() => {});
        } else if (nativePlayer.paused && !nativeAudio.paused) {
            nativeAudio.pause();
        }
    }

    function toggleAudioMute() {
        isAudioMuted = !isAudioMuted;
        applyAudioSettings();
        if (!isAudioMuted && hasSeparateAudio && nativePlayer && !nativePlayer.paused) {
            nativeAudio.play().catch(() => {});
        }
        showOsd(isAudioMuted ? '🔇 Audio Dimatikan' : `🔊 Audio Aktif (${Math.round(audioVolume * 100)}%)`);
    }

    function changeVolumeRelative(delta) {
        audioVolume = Math.min(1.0, Math.max(0.0, audioVolume + delta));
        if (audioVolume > 0 && isAudioMuted) {
            isAudioMuted = false;
        } else if (audioVolume === 0) {
            isAudioMuted = true;
        }
        applyAudioSettings();
        if (!isAudioMuted && hasSeparateAudio && nativePlayer && !nativePlayer.paused && nativeAudio.paused) {
            nativeAudio.play().catch(() => {});
        }
        showOsd(`🔊 Volume: ${Math.round(audioVolume * 100)}%`);
    }

    if (nativePlayer) {
        nativePlayer.addEventListener('play', () => syncAudioWithVideo(true));
        nativePlayer.addEventListener('pause', () => { if (nativeAudio && hasSeparateAudio) nativeAudio.pause(); });
        nativePlayer.addEventListener('seeking', () => {
            if (nativeAudio && hasSeparateAudio) {
                try { nativeAudio.currentTime = nativePlayer.currentTime; } catch (e) {}
            }
        });
        nativePlayer.addEventListener('seeked', () => syncAudioWithVideo(true));
        nativePlayer.addEventListener('waiting', () => { if (nativeAudio && hasSeparateAudio) nativeAudio.pause(); });
        nativePlayer.addEventListener('playing', () => syncAudioWithVideo(true));
        nativePlayer.addEventListener('ratechange', () => {
            if (nativeAudio && hasSeparateAudio) nativeAudio.playbackRate = nativePlayer.playbackRate;
        });
        nativePlayer.addEventListener('timeupdate', () => {
            syncAudioWithVideo(false);
            const cur = nativePlayer.currentTime || 0;
            const dur = nativePlayer.duration || 0;

            // Enforce In-Out Looping (Premiere Pro NLE Work Area)
            if (isLooping && loopIn !== null && loopOut !== null && loopOut > loopIn) {
                if (cur >= loopOut || cur < loopIn - 0.15) {
                    nativePlayer.currentTime = loopIn;
                    if (nativeAudio && hasSeparateAudio) {
                        try { nativeAudio.currentTime = loopIn; } catch (e) {}
                    }
                }
            }

            if (nowPlayingDuration && dur > 0) {
                nowPlayingDuration.textContent = `${formatTimecode(cur)} / ${formatTimecode(dur)}`;
            }

            // Update Timeline Scrubber Bar
            if (dur > 0 && timelineProgress) {
                const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
                timelineProgress.style.width = `${pct}%`;
                if (timelinePlayhead) timelinePlayhead.style.left = `${pct}%`;
            }
        });

        nativePlayer.addEventListener('ended', () => {
            if (isLooping) {
                const restartTime = (loopIn !== null) ? loopIn : 0;
                nativePlayer.currentTime = restartTime;
                if (nativeAudio && hasSeparateAudio) {
                    try { nativeAudio.currentTime = restartTime; } catch (e) {}
                }
                nativePlayer.play().catch(() => {});
            }
        });
    }

    function playVideo(id, title = "YouTube Video", channel = "", duration = "") {
        if (!id) return;

        currentVideo = { id, title, channel, duration };
        if (playerPlaceholder) playerPlaceholder.style.display = 'none';

        // Reset In/Out loop range for new video
        loopIn = null;
        loopOut = null;
        updateLoopUI();

        // Update Now Playing Bar and Timeline Scrubber
        if (nowPlayingBar) nowPlayingBar.style.display = 'flex';
        if (timelineBar) timelineBar.style.display = 'block';
        if (nowPlayingTitle) {
            nowPlayingTitle.textContent = title;
            nowPlayingTitle.title = title;
        }
        if (nowPlayingChannel) nowPlayingChannel.textContent = channel || 'YouTube Creator';
        if (nowPlayingDuration) nowPlayingDuration.textContent = duration ? `• ${duration}` : '';

        updateBookmarkButtonState();
        saveToHistory(currentVideo);
        highlightActiveCard(id);

        loadInProStreamEngine(id, currentQuality);
    }

    function loadInProStreamEngine(videoId, targetQuality = currentQuality, seekTime = null) {
        if (!videoId || !nativePlayer) return;

        playerMode = 'pro';
        currentQuality = targetQuality;

        nativePlayer.style.display = 'block';

        if (activeYtDlpProc) {
            try { activeYtDlpProc.kill(); } catch (e) {}
            activeYtDlpProc = null;
        }

        // 1. Instant cache check
        if (videoMetadataCache.has(videoId)) {
            const cached = videoMetadataCache.get(videoId);
            if (Date.now() - cached.timestamp < 30 * 60 * 1000) {
                selectAndPlayStreamResolution(videoId, cached, targetQuality, seekTime);
                return;
            }
        }

        showPlayerLoading('Menghubungkan stream video Pro (1080p–4K)...');

        const ytDlp = resolveYtDlp();
        const args = ['--no-playlist', '--no-warnings', '-J', `https://www.youtube.com/watch?v=${videoId}`];
        const env = getProcessEnv();

        const proc = cp.spawn(ytDlp, args, { env });
        activeYtDlpProc = proc;
        const stdoutChunks = [];

        proc.stdout.on('data', chunk => stdoutChunks.push(chunk));

        proc.on('close', code => {
            activeYtDlpProc = null;
            if (code !== 0 || stdoutChunks.length === 0) {
                console.warn('yt-dlp JSON scan failed');
                showPlayerError('Gagal mengambil data video YouTube. Coba refresh atau pilih video lain.');
                return;
            }

            try {
                const rawJson = Buffer.concat(stdoutChunks).toString('utf8');
                const info = JSON.parse(rawJson);
                const formats = info.formats || [];

                // Filter WebM VP9/VP8 video streams (native hardware acceleration in Adobe CEF)
                const webmVideos = formats.filter(f => {
                    const isWebm = f.ext === 'webm' || (f.vcodec && /^(vp0?9|vp8)/i.test(f.vcodec));
                    const hasVideo = f.vcodec && f.vcodec !== 'none' && f.height;
                    const isDirectHttp = f.protocol === 'https' || f.protocol === 'http';
                    return isWebm && hasVideo && isDirectHttp && f.url;
                });

                webmVideos.sort((a, b) => {
                    if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
                    if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
                    return (b.tbr || 0) - (a.tbr || 0);
                });

                // Filter WebM Opus/Vorbis audio streams (itag 251/250/249)
                const opusAudios = formats.filter(f => {
                    const isOpus = f.ext === 'webm' || (f.acodec && /^(opus|vorbis)/i.test(f.acodec));
                    const isAudioOnly = (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none';
                    const isDirectHttp = f.protocol === 'https' || f.protocol === 'http';
                    return isOpus && isAudioOnly && isDirectHttp && f.url;
                });

                opusAudios.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

                if (webmVideos.length === 0) {
                    console.log('No WebM formats found');
                    showPlayerError('Format stream video (WebM VP9) tidak ditemukan untuk video ini.');
                    return;
                }

                const realTitle = info.title || (currentVideo ? currentVideo.title : 'YouTube Video');
                const realChannel = info.uploader || info.channel || (currentVideo ? currentVideo.channel : 'YouTube Creator');
                if (currentVideo && currentVideo.id === videoId) {
                    currentVideo.title = realTitle;
                    currentVideo.channel = realChannel;
                    if (nowPlayingTitle) {
                        nowPlayingTitle.textContent = realTitle;
                        nowPlayingTitle.title = realTitle;
                    }
                    if (nowPlayingChannel) {
                        nowPlayingChannel.textContent = realChannel;
                    }
                }

                const metadata = {
                    title: realTitle,
                    channel: realChannel,
                    webmVideos,
                    opusAudios,
                    fps: webmVideos[0].fps || 30,
                    duration: info.duration || 0,
                    timestamp: Date.now()
                };

                videoMetadataCache.set(videoId, metadata);
                selectAndPlayStreamResolution(videoId, metadata, targetQuality, seekTime);

            } catch (err) {
                console.error('Error parsing yt-dlp metadata:', err);
                showPlayerError('Gagal memproses stream video: ' + (err.message || 'Format tidak valid'));
            }
        });
    }

    function selectAndPlayStreamResolution(videoId, metadata, targetQuality = 'auto', preserveTimeSec = null) {
        if (!metadata || !metadata.webmVideos || metadata.webmVideos.length === 0) {
            showPlayerError('Stream video tidak tersedia untuk resolusi ini.');
            return;
        }

        const maxH = targetQuality === 'auto' ? Infinity : parseInt(targetQuality, 10);
        let candidates = metadata.webmVideos.filter(f => (f.height || 0) <= maxH);
        if (candidates.length === 0) candidates = metadata.webmVideos;

        const chosenVideo = candidates[0];
        const bestAudio = metadata.opusAudios && metadata.opusAudios.length > 0 ? metadata.opusAudios[0] : null;

        currentVideoFps = chosenVideo.fps || metadata.fps || 30;

        const vKey = `video_${videoId}_${chosenVideo.format_id || chosenVideo.height}`;
        streamRegistry[vKey] = {
            url: chosenVideo.url,
            headers: chosenVideo.http_headers || {},
            filesize: chosenVideo.filesize || chosenVideo.filesize_approx || 0,
            mimeType: 'video/webm'
        };

        const vStreamUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(vKey)}`;

        if (bestAudio && bestAudio.url) {
            const aKey = `audio_${videoId}_${bestAudio.format_id || 'opus'}`;
            streamRegistry[aKey] = {
                url: bestAudio.url,
                headers: bestAudio.http_headers || {},
                filesize: bestAudio.filesize || bestAudio.filesize_approx || 0,
                mimeType: 'audio/webm'
            };
            const aStreamUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(aKey)}`;
            if (nativeAudio && nativeAudio.src !== aStreamUrl) {
                nativeAudio.src = aStreamUrl;
                nativeAudio.load();
            }
            hasSeparateAudio = true;
        } else {
            hasSeparateAudio = false;
        }

        // Clean previous handlers to prevent abort loops
        nativePlayer.onerror = null;
        nativePlayer.onplaying = null;
        nativePlayer.oncanplay = null;
        nativePlayer.onloadedmetadata = null;

        try { nativePlayer.pause(); } catch (e) {}

        let pendingSeek = (preserveTimeSec !== null && preserveTimeSec > 0) ? preserveTimeSec : null;

        nativePlayer.onloadedmetadata = () => {
            hidePlayerLoading();
            if (pendingSeek !== null) {
                try {
                    nativePlayer.currentTime = pendingSeek;
                    if (nativeAudio && hasSeparateAudio) nativeAudio.currentTime = pendingSeek;
                } catch (e) {}
                pendingSeek = null;
            }
            try { nativePlayer.playbackRate = currentSpeed; } catch (e) {}
            applyAudioSettings();
            updateLoopUI();
            syncAudioWithVideo(true);
            const p = nativePlayer.play();
            if (p) p.catch(() => {});
        };

        nativePlayer.onplaying = () => {
            hidePlayerLoading();
            syncAudioWithVideo(true);
        };

        nativePlayer.oncanplay = () => hidePlayerLoading();

        nativePlayer.onerror = (e) => {
            hidePlayerLoading();
            const err = nativePlayer.error;
            if (err && err.code === 1) return; // Routine abort ignored
            console.warn('Native player error:', err);
            showPlayerError('Pemutar video mengalami kendala stream. Coba ganti resolusi atau pilih video lain.');
        };

        nativePlayer.src = vStreamUrl;
        nativePlayer.load();
        const p = nativePlayer.play();
        if (p) p.catch(() => {});

        // Update UI Label
        const actualResLabel = `${chosenVideo.height}p`;
        if (currentQualityLabel) {
            currentQualityLabel.textContent = targetQuality === 'auto' ? `Auto (${actualResLabel})` : actualResLabel;
        }
        document.querySelectorAll('#qualityMenu .dx-dropdown-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('data-quality') === targetQuality);
        });

        showOsd(`📺 ${actualResLabel} WebM • ${Math.round(currentVideoFps)}fps`);
    }

    function changeQuality(newQuality, label) {
        if (!currentVideo || !currentVideo.id) return;
        const prevTime = nativePlayer ? nativePlayer.currentTime : 0;
        currentQuality = newQuality;
        if (currentQualityLabel) currentQualityLabel.textContent = label;

        document.querySelectorAll('#qualityMenu .dx-dropdown-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('data-quality') === newQuality);
        });

        showOsd(`⚙️ Kualitas: ${label}`);

        if (videoMetadataCache.has(currentVideo.id)) {
            selectAndPlayStreamResolution(currentVideo.id, videoMetadataCache.get(currentVideo.id), newQuality, prevTime);
        } else {
            loadInProStreamEngine(currentVideo.id, newQuality, prevTime);
        }
    }

    function changeSpeed(newSpeed, label) {
        currentSpeed = parseFloat(newSpeed);
        if (nativePlayer) {
            nativePlayer.playbackRate = currentSpeed;
        }
        if (nativeAudio && hasSeparateAudio) {
            nativeAudio.playbackRate = currentSpeed;
        }
        if (currentSpeedLabel) currentSpeedLabel.textContent = label;

        document.querySelectorAll('#speedMenu .dx-dropdown-item').forEach(item => {
            item.classList.toggle('active', parseFloat(item.getAttribute('data-speed')) === currentSpeed);
        });

        showOsd(`⚡ Kecepatan: ${label}`);
    }

    // Frame-by-Frame Navigation (Premiere Pro Standard: , and .)
    function stepFrame(forward = true, count = 1) {
        if (!currentVideo || !nativePlayer) return;
        const fps = currentVideoFps || 30;
        const frameDuration = 1 / fps;

        if (!nativePlayer.paused) {
            nativePlayer.pause();
            if (nativeAudio && hasSeparateAudio) nativeAudio.pause();
        }
        const currentFrame = Math.round((nativePlayer.currentTime || 0) * fps);
        const targetFrame = forward ? currentFrame + count : Math.max(0, currentFrame - count);
        const targetSec = Math.max(0, targetFrame * frameDuration);
        nativePlayer.currentTime = targetSec;
        if (nativeAudio && hasSeparateAudio) {
            try { nativeAudio.currentTime = targetSec; } catch (e) {}
        }
        showFrameOsd(forward, targetSec, count);
    }

    function showFrameOsd(forward, sec, count = 1) {
        const timecode = formatTimecode(sec);
        const countText = count > 1 ? `${count} Frames` : '1 Frame';
        const directionText = forward ? `+${countText} ⏭️` : `⏮️ -${countText}`;
        showOsd(`${directionText} • ${timecode}`);
    }

    // In/Out Looping Functions (Premiere Pro NLE Style)
    function setMarkIn() {
        if (!nativePlayer) return;
        const cur = nativePlayer.currentTime || 0;
        loopIn = cur;
        if (loopOut !== null && loopOut <= loopIn) {
            loopOut = null;
        }
        updateLoopUI();
        const fps = currentVideoFps || 30;
        const frame = Math.round(cur * fps);
        showOsd(`📍 Mark In: ${formatTimecode(cur)} [F:${frame}]`);
    }

    function setMarkOut() {
        if (!nativePlayer) return;
        const cur = nativePlayer.currentTime || 0;
        if (loopIn === null || cur > loopIn) {
            loopOut = cur;
            isLooping = true;
        } else {
            loopOut = cur;
            loopIn = Math.max(0, cur - 2);
        }
        updateLoopUI();
        const fps = currentVideoFps || 30;
        const frame = Math.round(cur * fps);
        const loopLen = (loopIn !== null) ? (loopOut - loopIn).toFixed(1) : 0;
        showOsd(`📍 Mark Out: ${formatTimecode(cur)} [F:${frame}] (Loop: ${loopLen}s)`);
    }

    function clearInOut() {
        loopIn = null;
        loopOut = null;
        updateLoopUI();
        showOsd('✕ In/Out Dihapus');
    }

    function toggleLoop() {
        isLooping = !isLooping;
        updateLoopUI();
        showOsd(isLooping ? '🔁 Loop Aktif' : 'Loop Dinonaktifkan');
    }

    function jumpToIn() {
        if (!nativePlayer || loopIn === null) return;
        nativePlayer.currentTime = loopIn;
        if (nativeAudio && hasSeparateAudio) {
            try { nativeAudio.currentTime = loopIn; } catch (e) {}
        }
        showOsd(`⏮️ Jump to In: ${formatTimecode(loopIn)}`);
    }

    function jumpToOut() {
        if (!nativePlayer || loopOut === null) return;
        nativePlayer.currentTime = loopOut;
        if (nativeAudio && hasSeparateAudio) {
            try { nativeAudio.currentTime = loopOut; } catch (e) {}
        }
        showOsd(`⏭️ Jump to Out: ${formatTimecode(loopOut)}`);
    }

    function updateLoopUI() {
        if (btnToggleLoop) {
            btnToggleLoop.classList.toggle('active', isLooping);
        }
        if (btnHeaderLoop) {
            btnHeaderLoop.classList.toggle('active', isLooping);
        }
        if (btnMarkIn) {
            btnMarkIn.classList.toggle('in-active', loopIn !== null);
        }
        if (btnMarkOut) {
            btnMarkOut.classList.toggle('out-active', loopOut !== null);
        }
        if (btnClearInOut) {
            btnClearInOut.style.display = (loopIn !== null || loopOut !== null) ? 'inline-flex' : 'none';
        }

        if (loopRangeBadge) {
            if (loopIn !== null && loopOut !== null && loopOut > loopIn) {
                loopRangeBadge.textContent = `🔁 In-Out: ${formatTimecode(loopIn)} → ${formatTimecode(loopOut)}`;
                loopRangeBadge.style.display = 'inline-flex';
            } else if (loopIn !== null) {
                loopRangeBadge.textContent = `🔁 In: ${formatTimecode(loopIn)} → End`;
                loopRangeBadge.style.display = 'inline-flex';
            } else if (loopOut !== null) {
                loopRangeBadge.textContent = `🔁 Start → Out: ${formatTimecode(loopOut)}`;
                loopRangeBadge.style.display = 'inline-flex';
            } else {
                loopRangeBadge.style.display = 'none';
            }
        }

        updateTimelineMarkers();
    }

    function updateTimelineMarkers() {
        if (!nativePlayer) return;
        const dur = nativePlayer.duration || 0;
        if (dur <= 0) return;

        if (timelineMarkerIn) {
            if (loopIn !== null) {
                const inPct = Math.max(0, Math.min(100, (loopIn / dur) * 100));
                timelineMarkerIn.style.left = `${inPct}%`;
                timelineMarkerIn.style.display = 'block';
            } else {
                timelineMarkerIn.style.display = 'none';
            }
        }

        if (timelineMarkerOut) {
            if (loopOut !== null) {
                const outPct = Math.max(0, Math.min(100, (loopOut / dur) * 100));
                timelineMarkerOut.style.left = `${outPct}%`;
                timelineMarkerOut.style.display = 'block';
            } else {
                timelineMarkerOut.style.display = 'none';
            }
        }

        if (timelineLoopRegion) {
            if (loopIn !== null && loopOut !== null && loopOut > loopIn) {
                const startPct = (loopIn / dur) * 100;
                const widthPct = ((loopOut - loopIn) / dur) * 100;
                timelineLoopRegion.style.left = `${startPct}%`;
                timelineLoopRegion.style.width = `${widthPct}%`;
                timelineLoopRegion.style.display = 'block';
            } else {
                timelineLoopRegion.style.display = 'none';
            }
        }
    }

    function formatTimecode(totalSeconds) {
        if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
        const fps = currentVideoFps || 30;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const frames = Math.floor((totalSeconds % 1) * fps);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
    }

    function showOsd(text) {
        if (!playerOsd) return;
        playerOsd.textContent = text;
        playerOsd.style.display = 'flex';
        playerOsd.style.opacity = '1';
        playerOsd.style.transform = 'translateY(0)';
        if (osdTimer) clearTimeout(osdTimer);
        osdTimer = setTimeout(() => {
            playerOsd.style.opacity = '0';
            playerOsd.style.transform = 'translateY(-4px)';
            setTimeout(() => { if (playerOsd) playerOsd.style.display = 'none'; }, 250);
        }, 1100);
    }

    function highlightActiveCard(activeId) {
        document.querySelectorAll('.dx-card').forEach(card => {
            if (card.getAttribute('data-id') === activeId) {
                card.classList.add('playing');
            } else {
                card.classList.remove('playing');
            }
        });
    }

    // ==========================================
    // BOOKMARKS / FAVORITES & HISTORY
    // ==========================================
    function getFavorites() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES)) || [];
        } catch (e) {
            return [];
        }
    }

    function saveFavorites(favs) {
        try {
            localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favs));
        } catch (e) {}
    }

    function isFavorited(id) {
        const favs = getFavorites();
        return favs.some(item => item.id === id);
    }

    function toggleFavorite(video) {
        if (!video || !video.id) return;
        let favs = getFavorites();
        const exists = favs.some(item => item.id === video.id);

        if (exists) {
            favs = favs.filter(item => item.id !== video.id);
            showToast("Dihapus dari Favorit");
        } else {
            favs.unshift(video);
            if (favs.length > 50) favs = favs.slice(0, 50);
            showToast("⭐ Disimpan ke Favorit!");
        }

        saveFavorites(favs);
        updateBookmarkButtonState();

        // If currently viewing favorites, refresh view
        const activePill = document.querySelector('.dx-pill.active');
        if (activePill && activePill.getAttribute('data-mode') === 'favorites') {
            renderFavoritesList();
        }
    }

    function updateBookmarkButtonState() {
        if (!currentVideo || !btnBookmark) return;
        const fav = isFavorited(currentVideo.id);
        if (fav) {
            btnBookmark.classList.add('active');
            bookmarkIcon.innerHTML = '&#9733;';
        } else {
            btnBookmark.classList.remove('active');
            bookmarkIcon.innerHTML = '&#9734;';
        }
    }

    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || [];
        } catch (e) {
            return [];
        }
    }

    function saveToHistory(video) {
        if (!video || !video.id) return;
        let hist = getHistory();
        hist = hist.filter(item => item.id !== video.id);
        hist.unshift(video);
        if (hist.length > 40) hist = hist.slice(0, 40);
        try {
            localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(hist));
        } catch (e) {}
    }

    function renderFavoritesList() {
        sectionTitle.textContent = "⭐ Video Favorit Disimpan";
        const favs = getFavorites();
        if (favs.length === 0) {
            videoGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-sub);">
                    Belum ada video favorit disimpan.<br>
                    Klik ikon ⭐ pada video yang Anda sukai untuk menyimpannya di sini.
                </div>
            `;
            return;
        }
        renderVideoCards(favs);
    }

    function renderHistoryList() {
        sectionTitle.textContent = "🕒 Riwayat Video Terakhir";
        const hist = getHistory();
        if (hist.length === 0) {
            videoGrid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-sub);">
                    Belum ada riwayat tontonan.
                </div>
            `;
            return;
        }
        renderVideoCards(hist);
    }

    // ==========================================
    // YOUTUBE SEARCH ENGINES (DIRECT HTTPS + YT-DLP FALLBACK)
    // ==========================================
    function showSkeletonLoading() {
        const skeletons = Array.from({ length: 6 }).map(() => `
            <div class="dx-skeleton-card">
                <div class="dx-skeleton-thumb"></div>
                <div class="dx-skeleton-lines">
                    <div class="dx-skeleton-line" style="width: 85%;"></div>
                    <div class="dx-skeleton-line" style="width: 50%;"></div>
                </div>
            </div>
        `).join('');
        videoGrid.innerHTML = skeletons;
    }

    // Engine 1: Direct YouTube HTTPS Search (Ultra fast, ~300ms, no CLI dependency)
    function searchYouTubeDirect(query, callback) {
        if (!https) return callback(new Error("Node https not available"));

        const q = encodeURIComponent(query);
        const opts = {
            hostname: "www.youtube.com",
            path: "/results?search_query=" + q,
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            }
        };

        const req = https.get(opts, (res) => {
            let data = "";
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/var ytInitialData = ({.*?});<\/script>/);
                if (!match) return callback(new Error("Data pattern not found"));
                try {
                    const json = JSON.parse(match[1]);
                    const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
                    const videos = [];

                    for (const section of contents) {
                        const items = (section.itemSectionRenderer && section.itemSectionRenderer.contents) || [];
                        for (const item of items) {
                            if (item.videoRenderer) {
                                const vr = item.videoRenderer;
                                videos.push({
                                    id: vr.videoId,
                                    title: vr.title && vr.title.runs ? vr.title.runs.map(r => r.text).join("") : (vr.title && vr.title.simpleText ? vr.title.simpleText : "Video"),
                                    duration: vr.lengthText ? vr.lengthText.simpleText : "",
                                    channel: vr.ownerText && vr.ownerText.runs ? vr.ownerText.runs.map(r => r.text).join("") : "YouTube",
                                    views: vr.viewCountText ? (vr.viewCountText.simpleText || (vr.viewCountText.runs ? vr.viewCountText.runs.map(r => r.text).join("") : "")) : ""
                                });
                            }
                        }
                    }

                    if (videos.length > 0) {
                        callback(null, videos);
                    } else {
                        callback(new Error("No videos found in direct search"));
                    }
                } catch (err) {
                    callback(err);
                }
            });
        });

        req.on('error', (err) => callback(err));
        req.setTimeout(7000, () => req.destroy(new Error("Timeout")));
    }

    // Engine 1: YouTube Data API v3 (Fastest & Most Reliable)
    const YOUTUBE_API_KEY = 'AIzaSyAvX-Y68jZ2vh3qjHhgPV95m27-A0W8MCY';
    function searchYouTubeApi(query, callback) {
        if (!https) return callback(new Error("Node https not available"));
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=15&q=${encodeURIComponent(query)}&type=video&regionCode=ID&key=${YOUTUBE_API_KEY}`;
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) return callback(new Error(`API Error HTTP ${res.statusCode}`));
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.items && parsed.items.length > 0) {
                        const items = parsed.items.map(item => ({
                            id: item.id.videoId,
                            title: item.snippet.title,
                            channel: item.snippet.channelTitle,
                            duration: '',
                            views: ''
                        }));
                        callback(null, items);
                    } else {
                        callback(new Error("No items"));
                    }
                } catch (e) { callback(e); }
            });
        });
        req.on('error', callback);
        req.setTimeout(8000, () => req.destroy(new Error("Timeout")));
    }

    // Engine 2: Local yt-dlp Process Search (Fallback with getProcessEnv)
    function searchYouTubeYtDlp(query, callback) {
        if (!cp || !cp.spawn) {
            return callback(new Error("child_process not available"));
        }

        const ytDlp = resolveYtDlp();
        const args = [
            '--force-ipv4',
            '--flat-playlist',
            '--no-warnings',
            '--print', '%(id)s||%(title)s||%(duration_string)s||%(uploader)s||%(view_count)s',
            `ytsearch14:${query}`
        ];

        let stdoutData = "";
        let stderrData = "";

        const proc = cp.spawn(ytDlp, args, { env: getProcessEnv() });

        proc.stdout.on('data', d => stdoutData += d.toString());
        proc.stderr.on('data', d => stderrData += d.toString());

        proc.on('error', err => callback(err));

        proc.on('close', (code) => {
            if (code !== 0 && !stdoutData) {
                return callback(new Error(stderrData || `yt-dlp exited with code ${code}`));
            }
            const lines = stdoutData.trim().split('\n').filter(Boolean);
            const items = lines.map(line => {
                const parts = line.split('||');
                return {
                    id: parts[0] || '',
                    title: parts[1] || 'Video Referensi',
                    duration: parts[2] || '',
                    channel: parts[3] || 'Creator',
                    views: parts[4] || ''
                };
            }).filter(x => x.id);

            callback(null, items);
        });
    }

    // Unified Search Dispatcher
    function searchYouTube(query) {
        if (isSearching) return;

        const clean = (query || '').trim();
        if (!clean) return;

        // Check if query is actually a direct YouTube link
        const directId = extractYouTubeId(clean);
        if (directId) {
            playVideo(directId, "Video YouTube", "YouTube", "");
            return;
        }

        isSearching = true;
        showSkeletonLoading();
        sectionTitle.textContent = `Hasil Pencarian: "${clean}"`;

        // Attempt 1: YouTube Data API v3 (Instant)
        searchYouTubeApi(clean, (err, items) => {
            if (!err && items && items.length > 0) {
                isSearching = false;
                renderVideoCards(items);
                return;
            }

            // Attempt 2: Direct Search (Scrape fallback)
            searchYouTubeDirect(clean, (err2, items2) => {
                if (!err2 && items2 && items2.length > 0) {
                    isSearching = false;
                    renderVideoCards(items2);
                    return;
                }

                // Attempt 3: Local yt-dlp Process Search
                searchYouTubeYtDlp(clean, (err3, items3) => {
                    isSearching = false;
                    if (!err3 && items3 && items3.length > 0) {
                        renderVideoCards(items3);
                        return;
                    }

                    // If all engines failed, display clean error
                    videoGrid.innerHTML = `
                        <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-muted);">
                            Gagal memuat hasil pencarian atau koneksi terputus.<br>
                            <small style="color: var(--text-sub);">${err3 ? err3.message : (err ? err.message : '')}</small>
                        </div>
                    `;
                });
            });
        });
    }

    function renderVideoCards(items) {
        videoGrid.innerHTML = items.map(item => {
            const isPlaying = currentVideo && currentVideo.id === item.id;
            const thumbUrl = http ? `http://127.0.0.1:${PLAYER_PORT}/thumb?v=${encodeURIComponent(item.id)}` : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
            const viewsText = formatViewCount(item.views);

            return `
                <div class="dx-card ${isPlaying ? 'playing' : ''}" data-id="${item.id}" 
                     onclick="window.DisplayX.play('${item.id}', '${escapeHtml(item.title)}', '${escapeHtml(item.channel)}', '${escapeHtml(item.duration)}')">
                    <div class="dx-thumb-wrap">
                        <img src="${thumbUrl}" data-video-id="${item.id}" data-fallback-index="0" alt="${escapeHtml(item.title)}" loading="lazy" onerror="window.DisplayX.thumbnailFallback(this)">
                        ${item.duration ? `<span class="dx-dur-badge">${escapeHtml(item.duration)}</span>` : ''}
                        <div class="dx-play-overlay">
                            <div class="dx-play-circle">&#9658;</div>
                        </div>
                    </div>
                    <div class="dx-card-info">
                        <div class="dx-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="dx-card-meta">
                            <span class="dx-card-channel">${escapeHtml(item.channel)}</span>
                            ${viewsText ? `<span class="dx-card-views">${viewsText}</span>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Export global play method for inline card onclick
    window.DisplayX = {
        play: function (id, title, channel, duration) {
            playVideo(id, title, channel, duration);
        },
        thumbnailFallback: function (img) {
            if (!img) return;
            const id = img.getAttribute('data-video-id') || '';
            if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
                img.onerror = null;
                return;
            }

            const fallbacks = [
                `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
                `https://i.ytimg.com/vi/${id}/default.jpg`
            ];
            const index = Number(img.getAttribute('data-fallback-index') || 0);
            if (index < fallbacks.length) {
                img.setAttribute('data-fallback-index', String(index + 1));
                img.src = fallbacks[index];
            } else {
                img.onerror = null;
                img.style.visibility = 'hidden';
            }
        }
    };

    // ==========================================
    // AUTOCOMPLETE SUGGESTIONS
    // ==========================================
    function fetchSuggestions(query) {
        if (!https || !query || query.length < 2) {
            suggestionsList.style.display = 'none';
            return;
        }

        const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
        try {
            https.get(url, (res) => {
                let data = "";
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const list = parsed[1] || [];
                        renderSuggestions(list);
                    } catch (e) {
                        suggestionsList.style.display = 'none';
                    }
                });
            }).on('error', () => {
                suggestionsList.style.display = 'none';
            });
        } catch (e) {
            suggestionsList.style.display = 'none';
        }
    }

    function renderSuggestions(list) {
        if (!list || list.length === 0) {
            suggestionsList.style.display = 'none';
            return;
        }

        suggestionsList.innerHTML = list.slice(0, 8).map(s => `
            <div class="dx-suggestion-item" data-val="${escapeHtml(s)}">
                <span class="dx-suggestion-icon">&#128269;</span>
                <span>${escapeHtml(s)}</span>
            </div>
        `).join('');

        suggestionsList.style.display = 'block';

        suggestionsList.querySelectorAll('.dx-suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.getAttribute('data-val');
                searchInput.value = val;
                suggestionsList.style.display = 'none';
                searchYouTube(val);
            });
        });
    }

    // ==========================================
    // CLIPBOARD AUTO-DETECTION
    // ==========================================
    function checkClipboard() {
        if (!cp) return;
        cp.exec('/usr/bin/pbpaste', (err, stdout) => {
            if (err || !stdout) return;
            const text = stdout.trim();
            if (text && text !== lastDetectedClipboard) {
                const vidId = extractYouTubeId(text);
                if (vidId) {
                    lastDetectedClipboard = text;
                    clipboardText.textContent = `Link YouTube terdeteksi: ${text.length > 36 ? text.substring(0, 36) + '...' : text}`;
                    clipboardBanner.style.display = 'flex';

                    btnPlayClipboard.onclick = () => {
                        playVideo(vidId, "Video dari Clipboard", "YouTube", "");
                        clipboardBanner.style.display = 'none';
                    };
                }
            }
        });
    }

    // ==========================================
    // EVENT LISTENERS & SETUP
    // ==========================================
    // Search Button Click
    btnSearch.addEventListener('click', () => {
        const val = searchInput.value.trim();
        if (val) {
            suggestionsList.style.display = 'none';
            searchYouTube(val);
        }
    });

    // Enter Key on Search Input
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = searchInput.value.trim();
            if (val) {
                suggestionsList.style.display = 'none';
                searchYouTube(val);
            }
        }
    });

    // Search Input Typing (Debounced Suggestions)
    searchInput.addEventListener('input', function () {
        const val = this.value.trim();
        btnClearSearch.style.display = val ? 'block' : 'none';

        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            if (val.startsWith('http://') || val.startsWith('https://')) {
                suggestionsList.style.display = 'none';
                return;
            }
            fetchSuggestions(val);
        }, 250);
    });

    // Clear Search Input
    btnClearSearch.addEventListener('click', () => {
        searchInput.value = '';
        btnClearSearch.style.display = 'none';
        suggestionsList.style.display = 'none';
        searchInput.focus();
    });

    // Close suggestions on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dx-search-wrap')) {
            suggestionsList.style.display = 'none';
        }
    });

    // Category Pills
    categoryPills.forEach(pill => {
        pill.addEventListener('click', function () {
            categoryPills.forEach(p => p.classList.remove('active'));
            this.classList.add('active');

            const mode = this.getAttribute('data-mode');
            const q = this.getAttribute('data-query');

            if (mode === 'favorites') {
                renderFavoritesList();
            } else if (mode === 'history') {
                renderHistoryList();
            } else if (q) {
                searchInput.value = q;
                btnClearSearch.style.display = 'block';
                searchYouTube(q);
            }
        });
    });

    // View Toggles (Grid vs List)
    btnViewGrid.addEventListener('click', () => {
        btnViewGrid.classList.add('active');
        btnViewList.classList.remove('active');
        videoGrid.classList.remove('list-view');
    });

    btnViewList.addEventListener('click', () => {
        btnViewList.classList.add('active');
        btnViewGrid.classList.remove('active');
        videoGrid.classList.add('list-view');
    });

    // Loop Toggle
    btnToggleLoop.addEventListener('click', () => {
        isLooping = !isLooping;
        btnToggleLoop.classList.toggle('active', isLooping);
        showToast(isLooping ? "🔁 Loop Video Aktif" : "Loop Video Dinonaktifkan");

        if (nativePlayer) {
            nativePlayer.loop = isLooping;
        }
    });

    // Theater Mode Toggle
    btnToggleTheater.addEventListener('click', () => {
        const isTheater = document.body.classList.toggle('theater-mode');
        btnToggleTheater.classList.toggle('active', isTheater);
        showToast(isTheater ? "📺 Mode Theater Aktif" : "Mode Standar Aktif");
    });

    // External Browser Open
    btnExternalBrowser.addEventListener('click', () => {
        const url = currentVideo && currentVideo.id 
                    ? `https://www.youtube.com/watch?v=${currentVideo.id}` 
                    : "https://www.youtube.com";
        csInterface.openURLInDefaultBrowser(url);
        showToast("Membuka di browser default (Safari/Chrome)...");
    });

    // Bookmark / Favorite Button in Player Bar
    btnBookmark.addEventListener('click', () => {
        if (currentVideo) {
            toggleFavorite(currentVideo);
        }
    });

    // Copy Video Link
    btnCopyLink.addEventListener('click', () => {
        if (!currentVideo || !currentVideo.id) return;
        const link = `https://www.youtube.com/watch?v=${currentVideo.id}`;
        if (cp) {
            const p = cp.spawn('/usr/bin/pbcopy');
            p.stdin.write(link);
            p.stdin.end();
            showToast("📋 Link disalin ke clipboard!");
        } else {
            showToast(`Link: ${link}`);
        }
    });

    // Open Current Video in Browser Button
    if (btnOpenNowPlaying) {
        btnOpenNowPlaying.addEventListener('click', () => {
            if (!currentVideo || !currentVideo.id) return;
            const url = `https://www.youtube.com/watch?v=${currentVideo.id}`;
            csInterface.openURLInDefaultBrowser(url);
            showToast("Membuka di browser default (Safari/Chrome)...");
        });
    }

    // Close Clipboard Banner
    btnCloseClipboard.addEventListener('click', () => {
        clipboardBanner.style.display = 'none';
    });

    // Audio Toggle Button
    if (btnAudioToggle) {
        btnAudioToggle.addEventListener('click', () => {
            toggleAudioMute();
        });
    }

    // Volume Slider Input
    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const val = parseInt(volumeSlider.value, 10);
            audioVolume = Math.max(0, Math.min(1, val / 100));
            if (val === 0) {
                isAudioMuted = true;
            } else if (isAudioMuted) {
                isAudioMuted = false;
            }
            applyAudioSettings();
            if (!isAudioMuted && hasSeparateAudio && nativePlayer && !nativePlayer.paused && nativeAudio.paused) {
                nativeAudio.play().catch(() => {});
            }
            showOsd(`🔊 Volume: ${val}%`);
        });
    }

    // In/Out Looping Button Event Listeners
    if (btnMarkIn) {
        btnMarkIn.addEventListener('click', setMarkIn);
    }
    if (btnMarkOut) {
        btnMarkOut.addEventListener('click', setMarkOut);
    }
    if (btnClearInOut) {
        btnClearInOut.addEventListener('click', clearInOut);
    }
    if (btnToggleLoop) {
        btnToggleLoop.addEventListener('click', toggleLoop);
    }
    if (btnHeaderLoop) {
        btnHeaderLoop.addEventListener('click', toggleLoop);
    }

    // Timeline Track Click to Seek
    if (timelineTrack) {
        timelineTrack.addEventListener('click', (e) => {
            if (!nativePlayer || !nativePlayer.duration) return;
            const rect = timelineTrack.getBoundingClientRect();
            const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const pct = clickX / rect.width;
            const targetSec = pct * nativePlayer.duration;
            nativePlayer.currentTime = targetSec;
            if (nativeAudio && hasSeparateAudio) {
                try { nativeAudio.currentTime = targetSec; } catch (err) {}
            }
        });
    }

    // ==========================================
    // BOX 1: DIRECT YOUTUBE LINK / PASTE STREAM
    // ==========================================
    function handleStreamUrlInput() {
        if (!urlInput) return;
        const val = urlInput.value.trim();
        if (!val) {
            showToast('Ketik atau paste link YouTube terlebih dahulu.');
            urlInput.focus();
            return;
        }
        const vidId = extractYouTubeId(val);
        if (vidId) {
            showToast(`🚀 Memutar stream video: ${vidId}`);
            playVideo(vidId, "Video dari Link", "YouTube Link", "");
        } else {
            showToast('Bukan link YouTube valid. Contoh: https://youtu.be/...');
            urlInput.focus();
        }
    }

    function handlePasteClipboardDirect() {
        const processUrl = (text) => {
            if (!text) {
                showToast('Clipboard kosong. Silakan salin link YouTube terlebih dahulu.');
                return;
            }
            const vidId = extractYouTubeId(text);
            if (vidId) {
                if (urlInput) {
                    urlInput.value = text.trim();
                    if (btnClearUrl) btnClearUrl.style.display = 'block';
                }
                showToast(`🚀 Memutar dari Clipboard: ${vidId}`);
                playVideo(vidId, "Video dari Link", "YouTube Link", "");
            } else {
                showToast('Clipboard tidak berisi link YouTube valid.');
                if (urlInput) urlInput.focus();
            }
        };

        if (cp) {
            cp.exec('/usr/bin/pbpaste', (err, stdout) => {
                const clip = (!err && stdout) ? stdout.trim() : '';
                if (clip) {
                    processUrl(clip);
                } else if (urlInput && urlInput.value.trim()) {
                    processUrl(urlInput.value.trim());
                } else {
                    if (urlInput) urlInput.focus();
                    showToast('Salin (Copy) link YouTube terlebih dahulu.');
                }
            });
        } else if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(processUrl).catch(() => {
                if (urlInput && urlInput.value.trim()) {
                    processUrl(urlInput.value.trim());
                }
            });
        }
    }

    if (btnStreamUrl) {
        btnStreamUrl.addEventListener('click', handleStreamUrlInput);
    }

    if (btnPasteClipboardDirect) {
        btnPasteClipboardDirect.addEventListener('click', handlePasteClipboardDirect);
    }

    if (urlInput) {
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleStreamUrlInput();
            }
        });

        urlInput.addEventListener('input', function () {
            if (btnClearUrl) btnClearUrl.style.display = this.value.trim() ? 'block' : 'none';
        });

        urlInput.addEventListener('paste', () => {
            setTimeout(() => {
                const val = urlInput.value.trim();
                const vidId = extractYouTubeId(val);
                if (vidId) {
                    showToast('🔗 Link terdeteksi, memutar stream...');
                    playVideo(vidId, "Video dari Link", "YouTube Link", "");
                }
            }, 60);
        });
    }

    if (btnClearUrl) {
        btnClearUrl.addEventListener('click', () => {
            if (urlInput) urlInput.value = '';
            btnClearUrl.style.display = 'none';
            if (urlInput) urlInput.focus();
        });
    }

    // ==========================================
    // BOX 2: SEARCH YOUTUBE TUTORIALS & VIDEOS
    // ==========================================
    btnSearch.addEventListener('click', () => {
        const val = searchInput.value.trim();
        if (val) {
            suggestionsList.style.display = 'none';
            searchYouTube(val);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = searchInput.value.trim();
            if (val) {
                suggestionsList.style.display = 'none';
                searchYouTube(val);
            }
        }
    });

    searchInput.addEventListener('input', function () {
        const val = this.value.trim();
        btnClearSearch.style.display = val ? 'block' : 'none';

        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            if (val.startsWith('http://') || val.startsWith('https://')) {
                suggestionsList.style.display = 'none';
                return;
            }
            fetchSuggestions(val);
        }, 250);
    });

    btnClearSearch.addEventListener('click', () => {
        searchInput.value = '';
        btnClearSearch.style.display = 'none';
        suggestionsList.style.display = 'none';
        searchInput.focus();
    });

    if (searchInput) {
        searchInput.addEventListener('paste', () => {
            setTimeout(() => {
                const val = searchInput.value.trim();
                const vidId = extractYouTubeId(val);
                if (vidId) {
                    showToast('🔗 Link terdeteksi di pencarian, memuat stream...');
                    playVideo(vidId, "Video dari Link", "YouTube Link", "");
                }
            }, 60);
        });
    }

    // Frame-by-Frame Step Buttons
    if (btnStepBack) {
        btnStepBack.addEventListener('click', () => stepFrame(false, 1));
    }
    if (btnStepForward) {
        btnStepForward.addEventListener('click', () => stepFrame(true, 1));
    }

    // Quality Dropdown Menu Toggle
    if (btnQuality) {
        btnQuality.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = qualityMenu && qualityMenu.style.display !== 'none';
            if (qualityMenu) qualityMenu.style.display = isOpen ? 'none' : 'block';
            if (speedMenu) speedMenu.style.display = 'none';
        });
    }

    // Speed Dropdown Menu Toggle
    if (btnSpeed) {
        btnSpeed.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = speedMenu && speedMenu.style.display !== 'none';
            if (speedMenu) speedMenu.style.display = isOpen ? 'none' : 'block';
            if (qualityMenu) qualityMenu.style.display = 'none';
        });
    }

    // Quality Menu Item Clicks
    if (qualityMenu) {
        qualityMenu.querySelectorAll('.dx-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const q = item.getAttribute('data-quality');
                const label = item.textContent.replace('✨', '').trim();
                changeQuality(q, label);
                qualityMenu.style.display = 'none';
            });
        });
    }

    // Speed Menu Item Clicks
    if (speedMenu) {
        speedMenu.querySelectorAll('.dx-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = item.getAttribute('data-speed');
                const label = item.textContent.trim().split(' ')[0];
                changeSpeed(s, label);
                speedMenu.style.display = 'none';
            });
        });
    }

    // Close Dropdowns on Click Outside
    document.addEventListener('click', () => {
        if (qualityMenu) qualityMenu.style.display = 'none';
        if (speedMenu) speedMenu.style.display = 'none';
    });

    // Global Keyboard Shortcuts (NLE Standard: In/Out, Loop, Frame Step, Play/Pause, Seek, Audio)
    window.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
        if (isInput) return; // Do not intercept if user is typing in URL input or search input

        if (e.key === 'i' || e.key === 'I') {
            e.preventDefault();
            if (e.shiftKey) jumpToIn();
            else setMarkIn();
        } else if (e.key === 'o' || e.key === 'O') {
            e.preventDefault();
            if (e.shiftKey) jumpToOut();
            else setMarkOut();
        } else if (e.key === 'x' || e.key === 'X') {
            e.preventDefault();
            clearInOut();
        } else if (e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            toggleLoop();
        } else if (e.key === ',' || e.code === 'Comma') {
            e.preventDefault();
            stepFrame(false, e.shiftKey ? 10 : 1);
        } else if (e.key === '.' || e.code === 'Period') {
            e.preventDefault();
            stepFrame(true, e.shiftKey ? 10 : 1);
        } else if (e.key === ' ' || e.code === 'Space' || e.key === 'k' || e.key === 'K') {
            e.preventDefault();
            if (nativePlayer) {
                if (nativePlayer.paused) {
                    const p = nativePlayer.play();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                    showOsd('▶ Play');
                } else {
                    nativePlayer.pause();
                    if (nativeAudio && hasSeparateAudio) nativeAudio.pause();
                    showOsd('⏸️ Pause');
                }
            }
        } else if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowLeft') {
            e.preventDefault();
            if (nativePlayer) {
                nativePlayer.currentTime = Math.max(0, nativePlayer.currentTime - 5);
                if (nativeAudio && hasSeparateAudio) nativeAudio.currentTime = nativePlayer.currentTime;
                showOsd('⏪ -5s');
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (nativePlayer) {
                nativePlayer.currentTime = Math.min((nativePlayer.duration || Infinity), nativePlayer.currentTime + 5);
                if (nativeAudio && hasSeparateAudio) nativeAudio.currentTime = nativePlayer.currentTime;
                showOsd('⏩ +5s');
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            changeVolumeRelative(0.05);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            changeVolumeRelative(-0.05);
        } else if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            toggleAudioMute();
        } else if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            if (nativePlayer) {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else if (nativePlayer.requestFullscreen) {
                    nativePlayer.requestFullscreen();
                }
            }
        }
    });

    // Placeholder click triggers search focus
    playerPlaceholder.addEventListener('click', () => {
        searchInput.focus();
    });

    // ==========================================
    // INITIALIZATION
    // ==========================================
    window.addEventListener('DOMContentLoaded', () => {
        // Initial search for premiere pro tutorials
        searchYouTube("premiere pro tutorial");

        // Clipboard polling
        checkClipboard();
        setInterval(checkClipboard, 2500);

        window.addEventListener('focus', () => {
            checkClipboard();
        });
    });

})();
