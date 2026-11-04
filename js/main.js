/**
 * main.js - DisplayX Controller
 * In-App YouTube Streaming & Reference Player for Adobe Premiere Pro
 * Inspired by Fred Pelle DisplayX
 */

(function () {
    'use strict';

    // Safe path helper fallback
    const fallbackPath = {
        dirname: function (p) {
            if (!p) return "";
            const clean = String(p).replace(/\\/g, '/');
            const idx = clean.lastIndexOf('/');
            return idx !== -1 ? clean.substring(0, idx) : clean;
        },
        join: function () {
            const parts = Array.prototype.slice.call(arguments);
            return parts.filter(Boolean).join('/').replace(/[\/\\]+/g, '/');
        },
        basename: function (p, ext) {
            if (!p) return "";
            const clean = String(p).replace(/\\/g, '/');
            const idx = clean.lastIndexOf('/');
            let name = idx !== -1 ? clean.substring(idx + 1) : clean;
            if (ext && name.endsWith(ext)) {
                name = name.slice(0, -ext.length);
            }
            return name;
        },
        extname: function (p) {
            if (!p) return "";
            const clean = String(p).replace(/\\/g, '/');
            const idx = clean.lastIndexOf('/');
            const filename = idx !== -1 ? clean.substring(idx + 1) : clean;
            const dotIdx = filename.lastIndexOf('.');
            return dotIdx !== -1 ? filename.substring(dotIdx) : "";
        }
    };

    // Locate Node.js modules in Adobe CEP
    const nodeRequire = (typeof require !== 'undefined' ? require : null) ||
                        (window.require ? window.require : null) ||
                        (window.cep_node && window.cep_node.require ? window.cep_node.require : null);

    let fs = null;
    let path = fallbackPath;
    let cp = null;
    let https = null;
    let http = null;

    if (nodeRequire) {
        try {
            fs = nodeRequire('fs');
            path = nodeRequire('path') || fallbackPath;
            cp = nodeRequire('child_process');
            https = nodeRequire('https');
            http = nodeRequire('http');
        } catch (e) {
            console.warn("Ardane YT Player: Node.js modules not fully loaded", e);
        }
    }

    const csInterface = new CSInterface();

    // Detect host application (Premiere Pro vs After Effects)
    let hostAppId = 'PPRO';
    try {
        const hostEnv = csInterface.getHostEnvironment ? csInterface.getHostEnvironment() : null;
        if (hostEnv && hostEnv.appId) {
            hostAppId = String(hostEnv.appId).toUpperCase();
        }
    } catch (e) {}
    let isAfterEffectsHostApp = (hostAppId === 'AEFT');
    function getHostAppLabel() {
        return isAfterEffectsHostApp ? 'After Effects' : 'Premiere Pro';
    }

    // Local HTTP origin for stream & thumbnail proxy (separate port per host so PPRO & AEFT can run simultaneously)
    const rootGlobalEarly = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : window);
    let PLAYER_PORT = rootGlobalEarly.__ardanePlayerPort || (isAfterEffectsHostApp ? 48294 : 48293);
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
    // Shared on globalThis so panel reloads never split the streamRegistry from an active HTTP server
    const rootGlobal = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : window);
    if (!rootGlobal.__ardaneStreamRegistry) {
        rootGlobal.__ardaneStreamRegistry = {};
    }
    const streamRegistry = rootGlobal.__ardaneStreamRegistry;
    const MAX_RAM_CHUNK = 6 * 1024 * 1024; // 6MB in RAM to prevent YouTube speed throttling

    function forwardRangeRequest(entry, clientReq, clientRes, redirectCount = 0, retryCount = 0) {
        if (redirectCount > 5) {
            if (!clientRes.headersSent) clientRes.writeHead(502);
            return clientRes.end("Too many redirects");
        }

        const targetUrl = entry.currentUrl || entry.url;
        let parsedTarget;
        try {
            parsedTarget = new URL(targetUrl);
        } catch (e) {
            if (!clientRes.headersSent) clientRes.writeHead(400);
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
            "Connection": "close"
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
            headers: reqHeaders,
            agent: false,
            timeout: 12000
        };

        let isClientClosed = false;
        clientReq.on("close", () => {
            isClientClosed = true;
            try { upstreamReq.destroy(); } catch (e) {}
        });

        const upstreamReq = requestLib.request(options, (upstreamRes) => {
            if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
                upstreamRes.resume();
                entry.currentUrl = upstreamRes.headers.location;
                return forwardRangeRequest(entry, clientReq, clientRes, redirectCount + 1, retryCount);
            }

            // If a redirected edge URL or transient upstream check returned 403/5xx, retry cleanly
            if ((upstreamRes.statusCode >= 500 || upstreamRes.statusCode === 403) && retryCount < 3 && !isClientClosed) {
                upstreamRes.resume();
                entry.currentUrl = null;
                return setTimeout(() => {
                    if (!isClientClosed && !clientRes.headersSent) {
                        forwardRangeRequest(entry, clientReq, clientRes, 0, retryCount + 1);
                    }
                }, 250);
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

            if (!clientRes.headersSent) {
                clientRes.writeHead(upstreamRes.statusCode || 200, resHeaders);
            }
            upstreamRes.pipe(clientRes);
        });

        upstreamReq.on("timeout", () => {
            upstreamReq.destroy(new Error("Upstream request timeout"));
        });

        upstreamReq.on("error", (err) => {
            if (isClientClosed) return;
            if (!clientRes.headersSent && retryCount < 2) {
                entry.currentUrl = null;
                return setTimeout(() => {
                    if (!isClientClosed && !clientRes.headersSent) {
                        forwardRangeRequest(entry, clientReq, clientRes, 0, retryCount + 1);
                    }
                }, 150);
            }
            if (!clientRes.headersSent) {
                clientRes.writeHead(502);
            }
            try { clientRes.end(); } catch (e) {}
        });

        upstreamReq.end();
    }

    // Inject exact video duration into FFmpeg streamed WebM EBML SegmentInfo header (Zero-Disk RAM Stream)
    function injectWebmDuration(chunk, durationSec) {
        if (!durationSec || durationSec <= 0 || !chunk || chunk.length < 256) return chunk;
        try {
            const segInfoTag = Buffer.from([0x15, 0x49, 0xa9, 0x66]);
            const tracksTag = Buffer.from([0x16, 0x54, 0xae, 0x6b]);
            const segIdx = chunk.indexOf(segInfoTag, 80);
            const tracksIdx = chunk.indexOf(tracksTag, segIdx > 0 ? segIdx : 80);
            if (segIdx <= 11 || tracksIdx <= segIdx) return chunk;
            const segSizeByte = chunk[segIdx + 4];
            if ((segSizeByte & 0x80) === 0) return chunk;
            const segDataLen = segSizeByte & 0x7f;
            if (segIdx + 5 + segDataLen !== tracksIdx) return chunk;
            const voidIdx = chunk.lastIndexOf(0xec, segIdx - 1);
            if (voidIdx < 0 || segIdx - voidIdx < 20) return chunk;
            const voidTotalLen = segIdx - voidIdx;
            const newVoidDataLen = voidTotalLen - 9 - 11;
            if (newVoidDataLen < 0) return chunk;

            const out = Buffer.from(chunk);
            out[voidIdx + 8] = newVoidDataLen;
            const newSegIdx = segIdx - 11;
            chunk.copy(out, newSegIdx, segIdx, tracksIdx);
            out[newSegIdx + 4] = 0x80 | (segDataLen + 11);
            const durPos = tracksIdx - 11;
            out[durPos] = 0x44;
            out[durPos + 1] = 0x89;
            out[durPos + 2] = 0x88;
            out.writeDoubleBE(durationSec * 1000.0, durPos + 3);

            // Update SeekHead pointer for SegmentInfo (15 49 a9 66 53 ac 81 <offset>) so 206 Partial Content seeking works natively
            const seekEntryTag = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x53, 0xac, 0x81]);
            const seekIdx = out.indexOf(seekEntryTag, 0);
            if (seekIdx > 0 && seekIdx < 80) {
                out[seekIdx + 7] -= 11;
            }
            return out;
        } catch (e) {
            return chunk;
        }
    }

    function cleanupActiveTranscodeSession(keepKey = null) {
        const activeSession = rootGlobal.__ardaneActiveTranscodeSession;
        if (activeSession && activeSession.key !== keepKey) {
            if (activeSession.proc) {
                try { activeSession.proc.kill('SIGKILL'); } catch (e) {}
                activeSession.proc = null;
            }
            if (activeSession.clients) {
                for (const c of activeSession.clients) {
                    try { c.end(); } catch (e) {}
                }
                activeSession.clients.clear();
            }
            activeSession.chunks = [];
            activeSession.totalBytes = 0;
            rootGlobal.__ardaneActiveTranscodeSession = null;
        }
    }

    // Real-Time In-Memory MP4 (H.264/avc1) -> WebM (VP8) RAM Stream Engine with Progressive 200 OK & Fast -ss Seeking
    function serveTranscodedMp4AsWebm(entry, clientReq, clientRes, startOffsetParam = '0', tokenParam = '') {
        if (!cp) {
            clientRes.writeHead(500);
            return clientRes.end("child_process unavailable");
        }

        const startSec = Math.max(0, parseFloat(startOffsetParam) || 0);
        const baseKey = entry.sessionKey || entry.rawSourceKey || entry.url;
        const sessionKey = `${baseKey}_s_${startSec.toFixed(2)}_${tokenParam}`;
        let session = rootGlobal.__ardaneActiveTranscodeSession;

        if (!session || session.key !== sessionKey || session.error || session.totalBytes > 4 * 1024 * 1024) {
            cleanupActiveTranscodeSession(null);

            const ffmpegBin = resolveFfmpeg();
            const rawProxyUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(entry.rawSourceKey)}`;
            const targetBitrate = (entry.height >= 1080) ? '3200k' : (entry.height >= 720 ? '2200k' : '1400k');

            const ffArgs = [
                '-hide_banner', '-loglevel', 'error',
                '-probesize', '327680',
                '-analyzeduration', '500000'
            ];
            if (startSec > 0.1) {
                ffArgs.push('-ss', startSec.toFixed(2));
            }
            ffArgs.push(
                '-reconnect', '1', '-reconnect_streamed', '1',
                '-i', rawProxyUrl,
                '-c:v', 'libvpx',
                '-deadline', 'realtime',
                '-cpu-used', '16',
                '-threads', '8',
                '-b:v', targetBitrate,
                '-crf', '10',
                '-g', '30',
                '-an',
                '-f', 'webm',
                'pipe:1'
            );

            const ffProc = cp.spawn(ffmpegBin, ffArgs, { env: getProcessEnv(), windowsHide: true });
            session = {
                key: sessionKey,
                startSec: startSec,
                proc: ffProc,
                chunks: [],
                totalBytes: 0,
                done: false,
                error: false,
                isFirstChunk: true,
                clients: new Set()
            };
            rootGlobal.__ardaneActiveTranscodeSession = session;

            const MAX_INITIAL_CACHE_BYTES = 8 * 1024 * 1024; // Keep first 8MB for any immediate duplicate probe

            ffProc.stdout.on('data', (chunk) => {
                if (session.isFirstChunk) {
                    session.isFirstChunk = false;
                    const remainingDur = Math.max(1, (entry.duration || 0) - startSec);
                    chunk = injectWebmDuration(chunk, remainingDur);
                }
                if (session.totalBytes + chunk.length <= MAX_INITIAL_CACHE_BYTES) {
                    session.chunks.push(chunk);
                }
                session.totalBytes += chunk.length;
                for (const resClient of session.clients) {
                    try {
                        resClient.write(chunk);
                    } catch (e) {
                        session.clients.delete(resClient);
                    }
                }
            });

            ffProc.on('close', (code) => {
                session.proc = null;
                session.done = true;
                if (code !== 0 && session.totalBytes === 0) {
                    session.error = true;
                }
                for (const resClient of session.clients) {
                    try { resClient.end(); } catch (e) {}
                }
                session.clients.clear();
            });

            ffProc.on('error', () => {
                session.error = true;
                session.done = true;
                for (const resClient of session.clients) {
                    try { resClient.end(); } catch (e) {}
                }
                session.clients.clear();
            });
        }

        // Send 200 OK progressive WebM stream so when FFmpeg reaches EOF near the end of the video (e.g. minute 16),
        // Chromium cleanly plays until the final frame without triggering 206 Content-Range mismatch stalls.
        clientRes.writeHead(200, {
            "Content-Type": "video/webm",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        });

        for (const existingChunk of session.chunks) {
            try {
                clientRes.write(existingChunk);
            } catch (e) {
                return;
            }
        }

        if (session.done) {
            return clientRes.end();
        }

        session.clients.add(clientRes);
        clientReq.on('close', () => {
            session.clients.delete(clientRes);
        });
    }

    function startLocalPlayerServer() {
        if (!http) return;

        // Always update the live request handler on rootGlobal so existing server instances use the latest code & registry
        rootGlobal.__ardaneRequestHandler = async (req, res) => {
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
                    service: 'Ardane YT Player Service (Pro Stream Engine Active)',
                    version: '2.0.0',
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
<title>Ardane YT Player</title>
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
                const startParam = parsed.searchParams.get('start') || '0';
                const tokenParam = parsed.searchParams.get('t') || '';
                const activeRegistry = rootGlobal.__ardaneStreamRegistry || streamRegistry;
                if (key && activeRegistry[key]) {
                    const entry = activeRegistry[key];
                    if (entry.isTranscodeMp4) {
                        return serveTranscodedMp4AsWebm(entry, req, res, startParam, tokenParam);
                    }
                    return forwardRangeRequest(entry, req, res, 0, 0);
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
            res.end('Ardane YT Player Service Active');
        };

        if (rootGlobal.__ardanePlayerServer && rootGlobal.__ardanePlayerServer.listening) {
            playerServer = rootGlobal.__ardanePlayerServer;
            if (rootGlobal.__ardanePlayerPort) {
                PLAYER_PORT = rootGlobal.__ardanePlayerPort;
            }
            return;
        }

        if (playerServer) return;
        try {
            playerServer = http.createServer((req, res) => {
                if (typeof rootGlobal.__ardaneRequestHandler === 'function') {
                    return rootGlobal.__ardaneRequestHandler(req, res);
                }
                res.writeHead(503);
                res.end();
            });

            playerServer.listen(PLAYER_PORT, '127.0.0.1', () => {
                rootGlobal.__ardanePlayerServer = playerServer;
                rootGlobal.__ardanePlayerPort = PLAYER_PORT;
                console.log(`Ardane YT Player Server running on port ${PLAYER_PORT}`);
            });

            playerServer.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    if (!rootGlobal.__ardanePlayerServer && PLAYER_PORT < 48310) {
                        PLAYER_PORT += 1;
                        setTimeout(() => {
                            try {
                                playerServer.listen(PLAYER_PORT, '127.0.0.1');
                            } catch (e) {}
                        }, 50);
                    } else {
                        console.log(`Ardane YT Player Server already active on port ${PLAYER_PORT}`);
                    }
                } else {
                    console.warn('Ardane YT Player Server notice:', err.message);
                }
            });
        } catch (e) {
            console.warn('Ardane YT Player Server init error:', e.message);
        }
    }

    startLocalPlayerServer();

    // DOM Elements
    const playerStage = document.getElementById('playerStage');
    const nativePlayer = document.getElementById('nativePlayer');
    const nativeAudio = document.getElementById('nativeAudio');
    const playerLoading = document.getElementById('playerLoading');
    const playerLoadingText = document.getElementById('playerLoadingText');
    const playerPlaceholder = document.getElementById('playerPlaceholder');

    // Custom In-Player Scrubber Controls (Active on MP4 HD Pro streams & Zoom Mode)
    const customVideoControls = document.getElementById('customVideoControls');
    const vcScrubberWrap = document.getElementById('vcScrubberWrap');
    const vcScrubberBuffered = document.getElementById('vcScrubberBuffered');
    const vcScrubberProgress = document.getElementById('vcScrubberProgress');
    const vcScrubberThumb = document.getElementById('vcScrubberThumb');
    const vcBtnPlayPause = document.getElementById('vcBtnPlayPause');
    const vcTimeText = document.getElementById('vcTimeText');
    const vcBtnFullscreen = document.getElementById('vcBtnFullscreen');

    // Premiere Pro Style Video Zoom & Pan Elements
    const btnZoom = document.getElementById('btnZoom');
    const zoomMenu = document.getElementById('zoomMenu');
    const currentZoomLabel = document.getElementById('currentZoomLabel');
    const zoomResetBadge = document.getElementById('zoomResetBadge');
    const zoomResetBadgeText = document.getElementById('zoomResetBadgeText');
    const panScrollbarH = document.getElementById('panScrollbarH');
    const panThumbH = document.getElementById('panThumbH');
    const panScrollbarV = document.getElementById('panScrollbarV');
    const panThumbV = document.getElementById('panThumbV');

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
    let isCurrentStreamTranscodeMp4 = false;
    let transcodeTimeOffset = 0;
    let activeTranscodeVKey = '';
    let isScrubbingTimeline = false;

    // Premiere Pro Program Monitor Style Zoom & Pan State
    let currentZoomScale = 1; // 1 = Fit (100%), up to 4 (400%)
    let currentPanNormX = 0.5; // 0 = far left, 0.5 = center, 1 = far right
    let currentPanNormY = 0.5; // 0 = top, 0.5 = center, 1 = bottom
    let suppressNextVideoClick = false;

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
        return String(p).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:[\/\\])/, '$1');
    }

    const isWindows = (typeof process !== 'undefined' && process.platform === 'win32') ||
                      (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || ''));

    function getExtensionRootClean() {
        try {
            const extRaw = csInterface.getSystemPath(SystemPath.EXTENSION);
            return cleanCepPath(extRaw);
        } catch (e) {
            return "";
        }
    }

    function getProcessEnv() {
        const extClean = getExtensionRootClean();
        const envBase = (typeof process !== 'undefined' && process.env) ? process.env : {};

        if (isWindows) {
            const localAppData = envBase.LOCALAPPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Local` : 'C:\\Users\\Default\\AppData\\Local');
            const appData = envBase.APPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Roaming` : '');
            const userProfile = envBase.USERPROFILE || 'C:\\Users\\Default';
            const winPaths = [
                extClean ? path.join(extClean, 'bin') : '',
                extClean ? path.join(extClean, 'bin', 'win') : '',
                `${localAppData}\\ArdaneYTPlayer\\bin`,
                `${localAppData}\\Microsoft\\WinGet\\Links`,
                `${userProfile}\\.deno\\bin`,
                'C:\\ProgramData\\chocolatey\\bin',
                'C:\\ffmpeg\\bin',
                appData ? `${appData}\\Adobe\\CEP\\extensions\\com.displayx.panel\\bin` : ''
            ].filter(Boolean);

            const existingPath = envBase.PATH || envBase.Path || '';
            const combinedWinPath = winPaths.join(';') + (existingPath ? ';' + existingPath : '');
            return Object.assign({}, envBase, {
                PATH: combinedWinPath,
                Path: combinedWinPath,
                PYTHONIOENCODING: 'utf-8'
            });
        }

        const standardPaths = [
            extClean ? `${extClean}/bin` : '',
            '/Users/ketut/.deno/bin',
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ].filter(Boolean);
        const existingPath = envBase.PATH || '';
        const combinedPath = standardPaths.join(':') + (existingPath ? ':' + existingPath : '');
        const home = envBase.HOME || '/Users/ketut';

        return Object.assign({}, envBase, {
            PATH: combinedPath,
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            HOME: home
        });
    }

    function resolveYtDlp() {
        const extClean = getExtensionRootClean();
        const envBase = (typeof process !== 'undefined' && process.env) ? process.env : {};

        if (isWindows) {
            const localAppData = envBase.LOCALAPPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Local` : '');
            const appData = envBase.APPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Roaming` : '');
            const winCandidates = [
                extClean ? path.join(extClean, 'bin', 'yt-dlp.exe') : '',
                extClean ? path.join(extClean, 'bin', 'win', 'yt-dlp.exe') : '',
                localAppData ? path.join(localAppData, 'ArdaneYTPlayer', 'bin', 'yt-dlp.exe') : '',
                appData ? path.join(appData, 'Adobe', 'CEP', 'extensions', 'com.displayx.panel', 'bin', 'yt-dlp.exe') : '',
                localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe') : '',
                'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
                'C:\\ffmpeg\\bin\\yt-dlp.exe'
            ].filter(Boolean);

            if (fs) {
                for (const p of winCandidates) {
                    try {
                        if (fs.existsSync(p)) return p;
                    } catch (e) {}
                }
            }
            return 'yt-dlp.exe';
        }

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

    function resolveFfmpeg() {
        const extClean = getExtensionRootClean();
        const envBase = (typeof process !== 'undefined' && process.env) ? process.env : {};

        if (isWindows) {
            const localAppData = envBase.LOCALAPPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Local` : '');
            const appData = envBase.APPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Roaming` : '');
            const winCandidates = [
                extClean ? path.join(extClean, 'bin', 'ffmpeg.exe') : '',
                extClean ? path.join(extClean, 'bin', 'win', 'ffmpeg.exe') : '',
                localAppData ? path.join(localAppData, 'ArdaneYTPlayer', 'bin', 'ffmpeg.exe') : '',
                appData ? path.join(appData, 'Adobe', 'CEP', 'extensions', 'com.displayx.panel', 'bin', 'ffmpeg.exe') : '',
                localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : '',
                'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
                'C:\\ffmpeg\\bin\\ffmpeg.exe'
            ].filter(Boolean);

            if (fs) {
                for (const p of winCandidates) {
                    try {
                        if (fs.existsSync(p)) return p;
                    } catch (e) {}
                }
            }
            return 'ffmpeg.exe';
        }

        const candidates = [
            extClean ? `${extClean}/bin/ffmpeg` : '',
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
            '/usr/bin/ffmpeg'
        ].filter(Boolean);

        if (fs) {
            for (const p of candidates) {
                try {
                    if (fs.existsSync(p)) return p;
                } catch (e) {}
            }
        }
        return '/opt/homebrew/bin/ffmpeg';
    }

    function resolveFfprobe() {
        const extClean = getExtensionRootClean();
        const envBase = (typeof process !== 'undefined' && process.env) ? process.env : {};

        if (isWindows) {
            const localAppData = envBase.LOCALAPPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Local` : '');
            const appData = envBase.APPDATA || (envBase.USERPROFILE ? `${envBase.USERPROFILE}\\AppData\\Roaming` : '');
            const winCandidates = [
                extClean ? path.join(extClean, 'bin', 'ffprobe.exe') : '',
                extClean ? path.join(extClean, 'bin', 'win', 'ffprobe.exe') : '',
                localAppData ? path.join(localAppData, 'ArdaneYTPlayer', 'bin', 'ffprobe.exe') : '',
                appData ? path.join(appData, 'Adobe', 'CEP', 'extensions', 'com.displayx.panel', 'bin', 'ffprobe.exe') : '',
                localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe') : '',
                'C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe',
                'C:\\ffmpeg\\bin\\ffprobe.exe'
            ].filter(Boolean);

            if (fs) {
                for (const p of winCandidates) {
                    try {
                        if (fs.existsSync(p)) return p;
                    } catch (e) {}
                }
            }
            return 'ffprobe.exe';
        }

        const candidates = [
            extClean ? `${extClean}/bin/ffprobe` : '',
            '/opt/homebrew/bin/ffprobe',
            '/usr/local/bin/ffprobe',
            '/usr/bin/ffprobe'
        ].filter(Boolean);

        if (fs) {
            for (const p of candidates) {
                try {
                    if (fs.existsSync(p)) return p;
                } catch (e) {}
            }
        }
        return '/opt/homebrew/bin/ffprobe';
    }

    function readSystemClipboard(callback) {
        if (!isWindows && cp) {
            cp.exec('/usr/bin/pbpaste', { windowsHide: true }, (err, stdout) => {
                if (!err && typeof stdout === 'string') {
                    return callback(stdout.trim());
                }
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(t => callback((t || '').trim())).catch(() => callback(''));
                } else {
                    callback('');
                }
            });
            return;
        }

        if (isWindows && cp) {
            cp.exec('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Clipboard -Raw"', { windowsHide: true, timeout: 4000 }, (err, stdout) => {
                if (!err && typeof stdout === 'string' && stdout.trim()) {
                    return callback(stdout.trim());
                }
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(t => callback((t || '').trim())).catch(() => callback(''));
                } else {
                    callback('');
                }
            });
            return;
        }

        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(t => callback((t || '').trim())).catch(() => callback(''));
        } else {
            callback('');
        }
    }

    function writeSystemClipboard(text, callback) {
        if (!text) {
            if (callback) callback(false);
            return;
        }
        if (!isWindows && cp) {
            try {
                const p = cp.spawn('/usr/bin/pbcopy', [], { windowsHide: true });
                p.stdin.write(String(text));
                p.stdin.end();
                if (callback) callback(true);
                return;
            } catch (e) {}
        }
        if (isWindows && cp) {
            try {
                const p = cp.spawn('clip', [], { windowsHide: true });
                p.stdin.write(String(text));
                p.stdin.end();
                if (callback) callback(true);
                return;
            } catch (e) {}
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(String(text)).then(() => {
                if (callback) callback(true);
            }).catch(() => {
                if (callback) callback(false);
            });
            return;
        }
        if (callback) callback(false);
    }

    function getBrowserCookieSource() {
        if (!isWindows) return 'safari';
        try {
            const envBase = (typeof process !== 'undefined' && process.env) ? process.env : {};
            const localAppData = envBase.LOCALAPPDATA || '';
            if (fs && localAppData && fs.existsSync(path.join(localAppData, 'Google', 'Chrome', 'User Data'))) {
                return 'chrome';
            }
        } catch (e) {}
        return 'edge';
    }

    function getEffectiveDuration() {
        if (currentVideo && currentVideo.id && videoMetadataCache.has(currentVideo.id)) {
            const meta = videoMetadataCache.get(currentVideo.id);
            if (meta && meta.duration > 0) return meta.duration;
        }
        if (nativePlayer && nativePlayer.duration && isFinite(nativePlayer.duration) && nativePlayer.duration > 0) {
            return nativePlayer.duration;
        }
        return 0;
    }

    function getEffectiveCurrentTime() {
        const raw = (nativePlayer && isFinite(nativePlayer.currentTime)) ? nativePlayer.currentTime : 0;
        return isCurrentStreamTranscodeMp4 ? Math.max(0, transcodeTimeOffset + raw) : Math.max(0, raw);
    }

    function formatShortTime(totalSeconds) {
        if (!totalSeconds || isNaN(totalSeconds) || totalSeconds < 0) return '0:00';
        const sec = Math.floor(totalSeconds);
        const hrs = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        const secs = sec % 60;
        const pad2 = n => String(n).padStart(2, '0');
        if (hrs > 0) return `${hrs}:${pad2(mins)}:${pad2(secs)}`;
        return `${mins}:${pad2(secs)}`;
    }

    function updatePlayheadUI(curSec, durSec) {
        const dur = durSec || getEffectiveDuration();
        if (dur <= 0) return;
        const clampedCur = Math.max(0, Math.min(dur, curSec));
        const pct = Math.max(0, Math.min(100, (clampedCur / dur) * 100));

        if (nowPlayingDuration) {
            nowPlayingDuration.textContent = `${formatTimecode(clampedCur)} / ${formatTimecode(dur)}`;
        }
        if (timelineProgress) timelineProgress.style.width = `${pct}%`;
        if (timelinePlayhead) timelinePlayhead.style.left = `${pct}%`;

        if (vcScrubberProgress) vcScrubberProgress.style.width = `${pct}%`;
        if (vcScrubberThumb) vcScrubberThumb.style.left = `${pct}%`;
        if (vcTimeText) {
            vcTimeText.textContent = `${formatShortTime(clampedCur)} / ${formatShortTime(dur)}`;
        }
        if (vcScrubberBuffered && nativePlayer) {
            try {
                if (nativePlayer.buffered && nativePlayer.buffered.length > 0) {
                    const bufEndRel = nativePlayer.buffered.end(nativePlayer.buffered.length - 1);
                    const bufEndAbs = isCurrentStreamTranscodeMp4 ? (transcodeTimeOffset + bufEndRel) : bufEndRel;
                    const bufPct = Math.max(pct, Math.min(100, (bufEndAbs / dur) * 100));
                    vcScrubberBuffered.style.width = `${bufPct}%`;
                }
            } catch (e) {}
        }
    }

    function seekVideoTo(targetSec, isLiveDrag = false) {
        if (!nativePlayer) return;
        const dur = getEffectiveDuration();
        const maxSeek = dur > 0 ? Math.max(0, dur - 0.25) : Math.max(0, targetSec);
        const clamped = Math.max(0, Math.min(maxSeek, targetSec));

        updatePlayheadUI(clamped, dur);

        // Native WebM VP9 stream: direct instant seek
        if (!isCurrentStreamTranscodeMp4) {
            try {
                nativePlayer.currentTime = clamped;
                if (nativeAudio && hasSeparateAudio) {
                    nativeAudio.currentTime = clamped;
                }
            } catch (e) {}
            return;
        }

        // MP4 HD Pro Transcode stream:
        // While user is actively dragging mouse across the scrubber bar, update visual playhead smoothly until mouseup
        if (isLiveDrag) {
            return;
        }

        // Perform fast FFmpeg -ss jump (~200-350ms) for both forward and backward seeks so cue-less WebM never stalls
        if (!activeTranscodeVKey) return;
        const wasPaused = nativePlayer.paused && !nativePlayer.ended;
        transcodeTimeOffset = clamped;
        const loadToken = ++activeStreamLoadToken;

        if (nativeAudio && hasSeparateAudio) {
            try {
                nativeAudio.pause();
                nativeAudio.currentTime = clamped;
            } catch (e) {}
        }

        showOsd(`⏩ ${formatShortTime(clamped)}`);

        const seekStreamUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(activeTranscodeVKey)}&start=${clamped.toFixed(2)}&t=${Date.now()}`;

        nativePlayer.onloadedmetadata = null;
        nativePlayer.oncanplay = null;

        let resumed = false;
        const onSeekStreamReady = () => {
            if (loadToken !== activeStreamLoadToken || resumed) return;
            resumed = true;
            hidePlayerLoading();
            try { nativePlayer.playbackRate = currentSpeed; } catch (e) {}
            if (nativeAudio && hasSeparateAudio) {
                try { nativeAudio.currentTime = clamped; } catch (e) {}
            }
            if (!wasPaused) {
                const p = nativePlayer.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            }
            syncAudioWithVideo(true);
        };

        nativePlayer.onloadedmetadata = onSeekStreamReady;
        nativePlayer.oncanplay = onSeekStreamReady;

        nativePlayer.src = seekStreamUrl;
        nativePlayer.load();
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
            cp.execFile(ytDlp, args, { env, timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
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

        const vTime = getEffectiveCurrentTime();
        const aTime = nativeAudio.currentTime || 0;
        if (forceSeek || Math.abs(vTime - aTime) > 0.12) {
            try {
                nativeAudio.currentTime = vTime;
            } catch (e) {}
        }

        const isVideoActivelyPlaying = !nativePlayer.paused && !nativePlayer.seeking && !nativePlayer.ended && nativePlayer.readyState >= 3;
        if (isVideoActivelyPlaying && nativeAudio.paused) {
            nativeAudio.play().catch(() => {});
        } else if (!isVideoActivelyPlaying && !nativeAudio.paused) {
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
        nativePlayer.addEventListener('play', () => {
            if (vcBtnPlayPause) vcBtnPlayPause.textContent = '⏸';
            syncAudioWithVideo(true);
        });
        nativePlayer.addEventListener('pause', () => {
            if (vcBtnPlayPause) vcBtnPlayPause.textContent = '▶';
            if (nativeAudio && hasSeparateAudio) nativeAudio.pause();
        });
        nativePlayer.addEventListener('seeking', () => {
            if (nativeAudio && hasSeparateAudio) {
                try { nativeAudio.currentTime = getEffectiveCurrentTime(); } catch (e) {}
            }
        });
        nativePlayer.addEventListener('seeked', () => syncAudioWithVideo(true));
        nativePlayer.addEventListener('waiting', () => { if (nativeAudio && hasSeparateAudio) nativeAudio.pause(); });
        nativePlayer.addEventListener('playing', () => {
            if (vcBtnPlayPause) vcBtnPlayPause.textContent = '⏸';
            syncAudioWithVideo(true);
        });
        nativePlayer.addEventListener('ratechange', () => {
            if (nativeAudio && hasSeparateAudio) nativeAudio.playbackRate = nativePlayer.playbackRate;
        });
        nativePlayer.addEventListener('timeupdate', () => {
            syncAudioWithVideo(false);
            const cur = getEffectiveCurrentTime();
            const dur = getEffectiveDuration();

            // Enforce In-Out Looping (Premiere Pro NLE Work Area)
            if (isLooping && loopIn !== null && loopOut !== null && loopOut > loopIn) {
                if (cur >= loopOut || cur < loopIn - 0.25) {
                    seekVideoTo(loopIn, false);
                    return;
                }
            }

            if (!isScrubbingTimeline) {
                updatePlayheadUI(cur, dur);
            }
        });

        nativePlayer.addEventListener('ended', () => {
            if (isLooping) {
                const restartTime = (loopIn !== null) ? loopIn : 0;
                seekVideoTo(restartTime, false);
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
        if (nowPlayingDuration) nowPlayingDuration.textContent = duration || '0:00';

        // Auto-scroll to top to bring video player into full view (like YouTube)
        const mainScroll = document.getElementById('mainScroll');
        if (mainScroll && mainScroll.scrollTop > 60) {
            mainScroll.scrollTo({ top: 0, behavior: 'smooth' });
        }

        updateBookmarkButtonState();
        saveToHistory(currentVideo);
        highlightActiveCard(id);

        loadInProStreamEngine(id, currentQuality);
    }

    let activeStreamLoadToken = 0;

    // Dynamically adjust Quality Menu options to match the exact resolutions available on YouTube for this video
    function updateQualityMenuForVideo(metadata) {
        if (!qualityMenu || !metadata || !metadata.webmVideos || metadata.webmVideos.length === 0) return;

        const availableHeights = metadata.webmVideos.map(f => f.height || 0).filter(Boolean);
        const maxAvailableHeight = Math.max(...availableHeights, 360);

        qualityMenu.querySelectorAll('.dx-dropdown-item').forEach(item => {
            const qVal = item.getAttribute('data-quality');
            if (qVal === 'auto') {
                item.style.display = '';
                item.textContent = `Auto (Maks ${maxAvailableHeight}p) ✨`;
                return;
            }
            const targetH = parseInt(qVal, 10);
            if (!targetH) return;

            // Show resolution option only if YouTube actually has this resolution tier for this video
            const hasTier = availableHeights.some(h => Math.abs(h - targetH) <= 40);
            item.style.display = hasTier ? '' : 'none';
        });
    }

    function loadInProStreamEngine(videoId, targetQuality = currentQuality, seekTime = null, isAutoRefetch = false) {
        if (!videoId || !nativePlayer) return;

        const requestToken = ++activeStreamLoadToken;
        playerMode = 'pro';
        currentQuality = targetQuality;

        nativePlayer.style.display = 'block';

        // Immediately detach previous handlers & pause old media so no false error fires during yt-dlp scan
        nativePlayer.onerror = null;
        nativePlayer.onplaying = null;
        nativePlayer.oncanplay = null;
        nativePlayer.onloadedmetadata = null;
        try { nativePlayer.pause(); } catch (e) {}
        if (nativeAudio) {
            try { nativeAudio.pause(); } catch (e) {}
        }

        if (activeYtDlpProc) {
            try { activeYtDlpProc.kill(); } catch (e) {}
            activeYtDlpProc = null;
        }

        // 1. Instant cache check
        if (!isAutoRefetch && videoMetadataCache.has(videoId)) {
            const cached = videoMetadataCache.get(videoId);
            if (Date.now() - cached.timestamp < 25 * 60 * 1000) {
                updateQualityMenuForVideo(cached);
                showPlayerLoading('Memuat stream video...');
                selectAndPlayStreamResolution(videoId, cached, targetQuality, seekTime, 0, 0, false);
                return;
            }
        }

        showPlayerLoading(isAutoRefetch ? 'Menyegarkan tautan stream video...' : 'Menghubungkan stream video Pro (1080p–4K)...');

        const ytDlp = resolveYtDlp();
        const args = [
            '--no-playlist',
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=default,-tv_samsung',
            '-J',
            `https://www.youtube.com/watch?v=${videoId}`
        ];
        const env = getProcessEnv();

        const proc = cp.spawn(ytDlp, args, { env, windowsHide: true });
        activeYtDlpProc = proc;
        const stdoutChunks = [];

        proc.stdout.on('data', chunk => stdoutChunks.push(chunk));

        proc.on('close', code => {
            if (activeYtDlpProc === proc) {
                activeYtDlpProc = null;
            }
            // Ignore if user already clicked another video
            if (requestToken !== activeStreamLoadToken) return;

            if (code !== 0 || stdoutChunks.length === 0) {
                console.warn('yt-dlp JSON scan failed');
                showPlayerError('Gagal mengambil data video YouTube. Coba refresh atau pilih video lain.');
                return;
            }

            try {
                const rawJson = Buffer.concat(stdoutChunks).toString('utf8');
                const info = JSON.parse(rawJson);
                const formats = info.formats || [];

                // 1. Native WebM VP9/VP8 video streams (direct hardware acceleration in Adobe CEF)
                const webmVideos = formats.filter(f => {
                    const isWebm = f.ext === 'webm' || (f.vcodec && /^(vp0?9|vp8)/i.test(f.vcodec));
                    const hasVideo = f.vcodec && f.vcodec !== 'none' && f.height;
                    const isDirectHttp = f.protocol === 'https' || f.protocol === 'http';
                    return isWebm && hasVideo && isDirectHttp && f.url;
                });

                // 2. For videos where YouTube only encodes 360p in WebM and stores 720p/1080p in MP4 (H.264/avc1),
                // include missing HD heights from MP4 (avc1) and stream them via Real-Time RAM WebM Engine (0MB disk)
                const webmHeights = new Set(webmVideos.map(f => f.height));
                const mp4Videos = formats.filter(f => {
                    const isMp4H264 = (f.ext === 'mp4' || /^(avc1|h264)/i.test(f.vcodec || '')) && !/^(av01)/i.test(f.vcodec || '');
                    const hasVideo = f.vcodec && f.vcodec !== 'none' && f.height && f.height >= 480;
                    const isDirectHttp = f.protocol === 'https' || f.protocol === 'http';
                    return isMp4H264 && hasVideo && isDirectHttp && f.url;
                });

                mp4Videos.sort((a, b) => {
                    if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
                    if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
                    return (b.tbr || 0) - (a.tbr || 0);
                });

                const addedMp4Heights = new Set();
                for (const mp4Fmt of mp4Videos) {
                    const h = mp4Fmt.height;
                    const alreadyHasNearHeight = Array.from(webmHeights).some(wh => Math.abs(wh - h) <= 30);
                    if (!alreadyHasNearHeight && !addedMp4Heights.has(h)) {
                        addedMp4Heights.add(h);
                        webmVideos.push(Object.assign({}, mp4Fmt, {
                            isTranscodeMp4: true
                        }));
                    }
                }

                webmVideos.sort((a, b) => {
                    if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
                    // Always prefer native WebM over transcode at the exact same resolution
                    if (Boolean(a.isTranscodeMp4) !== Boolean(b.isTranscodeMp4)) {
                        return a.isTranscodeMp4 ? 1 : -1;
                    }
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
                    console.log('No playable video formats found');
                    showPlayerError('Format stream video tidak ditemukan untuk video ini.');
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
                updateQualityMenuForVideo(metadata);
                selectAndPlayStreamResolution(videoId, metadata, targetQuality, seekTime, 0, 0, isAutoRefetch);

            } catch (err) {
                console.error('Error parsing yt-dlp metadata:', err);
                showPlayerError('Gagal memproses stream video: ' + (err.message || 'Format tidak valid'));
            }
        });
    }

    function selectAndPlayStreamResolution(
        videoId,
        metadata,
        targetQuality = 'auto',
        preserveTimeSec = null,
        candidateIndex = 0,
        retryAttempt = 0,
        hasRefetchedMeta = false
    ) {
        if (!metadata || !metadata.webmVideos || metadata.webmVideos.length === 0) {
            showPlayerError('Stream video tidak tersedia untuk resolusi ini.');
            return;
        }

        startLocalPlayerServer();
        const loadToken = ++activeStreamLoadToken;

        const maxH = targetQuality === 'auto' ? Infinity : parseInt(targetQuality, 10);
        let candidates = metadata.webmVideos.filter(f => (f.height || 0) <= maxH + 30);
        if (candidates.length === 0) candidates = metadata.webmVideos;

        const safeIndex = Math.min(candidateIndex, candidates.length - 1);
        const chosenVideo = candidates[safeIndex];
        const bestAudio = metadata.opusAudios && metadata.opusAudios.length > 0 ? metadata.opusAudios[0] : null;

        currentVideoFps = chosenVideo.fps || metadata.fps || 30;

        const activeRegistry = (typeof rootGlobal !== 'undefined' && rootGlobal.__ardaneStreamRegistry)
            ? rootGlobal.__ardaneStreamRegistry
            : streamRegistry;

        const vKey = `video_${videoId}_${chosenVideo.format_id || chosenVideo.height}`;
        const existingVEntry = activeRegistry[vKey];

        isCurrentStreamTranscodeMp4 = Boolean(chosenVideo.isTranscodeMp4);
        activeTranscodeVKey = vKey;
        transcodeTimeOffset = (isCurrentStreamTranscodeMp4 && preserveTimeSec && preserveTimeSec > 0) ? preserveTimeSec : 0;

        // Toggle custom in-player scrubber controls for MP4 HD Pro streams or when Zoomed In so controls stay crisp at 100% scale
        const useCustomOverlayControls = Boolean(isCurrentStreamTranscodeMp4 || currentZoomScale > 1.001);
        if (nativePlayer) {
            nativePlayer.controls = !useCustomOverlayControls;
        }
        if (customVideoControls) {
            customVideoControls.style.display = useCustomOverlayControls ? 'flex' : 'none';
        }
        if (vcScrubberBuffered) {
            vcScrubberBuffered.style.width = '0%';
        }
        updatePlayheadUI(preserveTimeSec || 0, metadata.duration || 0);
        updateVideoZoomAndPan();

        if (chosenVideo.isTranscodeMp4) {
            const rawSourceKey = `raw_${vKey}`;
            const existingRawEntry = activeRegistry[rawSourceKey];
            activeRegistry[rawSourceKey] = {
                url: chosenVideo.url,
                currentUrl: (retryAttempt === 0 && existingRawEntry && existingRawEntry.url === chosenVideo.url) ? existingRawEntry.currentUrl : null,
                headers: chosenVideo.http_headers || {},
                filesize: chosenVideo.filesize || chosenVideo.filesize_approx || 0,
                mimeType: 'video/mp4',
                isTranscodeMp4: false
            };
            streamRegistry[rawSourceKey] = activeRegistry[rawSourceKey];

            activeRegistry[vKey] = {
                url: chosenVideo.url,
                rawSourceKey: rawSourceKey,
                sessionKey: vKey,
                isTranscodeMp4: true,
                height: chosenVideo.height || 1080,
                fps: currentVideoFps || 30,
                duration: metadata.duration || 0,
                mimeType: 'video/webm'
            };
            streamRegistry[vKey] = activeRegistry[vKey];
        } else {
            cleanupActiveTranscodeSession(null);
            activeRegistry[vKey] = {
                url: chosenVideo.url,
                currentUrl: (retryAttempt === 0 && existingVEntry && existingVEntry.url === chosenVideo.url) ? existingVEntry.currentUrl : null,
                headers: chosenVideo.http_headers || {},
                filesize: chosenVideo.filesize || chosenVideo.filesize_approx || 0,
                mimeType: 'video/webm',
                isTranscodeMp4: false
            };
            streamRegistry[vKey] = activeRegistry[vKey];
        }

        const startQuery = (isCurrentStreamTranscodeMp4 && transcodeTimeOffset > 0) ? `&start=${transcodeTimeOffset.toFixed(2)}` : '';
        const cacheBust = retryAttempt > 0 ? `&r=${retryAttempt}&t=${Date.now()}` : '';
        const vStreamUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(vKey)}${startQuery}${cacheBust}`;

        if (bestAudio && bestAudio.url) {
            const aKey = `audio_${videoId}_${bestAudio.format_id || 'opus'}`;
            const existingAEntry = activeRegistry[aKey];
            activeRegistry[aKey] = {
                url: bestAudio.url,
                currentUrl: (retryAttempt === 0 && existingAEntry && existingAEntry.url === bestAudio.url) ? existingAEntry.currentUrl : null,
                headers: bestAudio.http_headers || {},
                filesize: bestAudio.filesize || bestAudio.filesize_approx || 0,
                mimeType: 'audio/webm'
            };
            streamRegistry[aKey] = activeRegistry[aKey];

            const aStreamUrl = `http://127.0.0.1:${PLAYER_PORT}/stream?key=${encodeURIComponent(aKey)}${cacheBust}`;
            if (nativeAudio && (nativeAudio.src !== aStreamUrl || retryAttempt > 0)) {
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

        let pendingSeek = (preserveTimeSec !== null && preserveTimeSec > 0 && !chosenVideo.isTranscodeMp4) ? preserveTimeSec : null;
        let hasStartedPlayback = false;

        const triggerSafePlay = () => {
            if (loadToken !== activeStreamLoadToken) return;
            hidePlayerLoading();
            if (!hasStartedPlayback) {
                hasStartedPlayback = true;
                if (pendingSeek !== null) {
                    try {
                        nativePlayer.currentTime = pendingSeek;
                        if (nativeAudio && hasSeparateAudio) nativeAudio.currentTime = pendingSeek;
                    } catch (e) {}
                    pendingSeek = null;
                } else if (isCurrentStreamTranscodeMp4 && transcodeTimeOffset > 0 && nativeAudio && hasSeparateAudio) {
                    try { nativeAudio.currentTime = transcodeTimeOffset; } catch (e) {}
                }
                try { nativePlayer.playbackRate = currentSpeed; } catch (e) {}
                applyAudioSettings();
                updateLoopUI();
                const p = nativePlayer.play();
                if (p) p.catch(() => {});
                syncAudioWithVideo(true);
            }
        };

        nativePlayer.onloadedmetadata = triggerSafePlay;
        nativePlayer.oncanplay = triggerSafePlay;

        nativePlayer.onplaying = () => {
            if (loadToken !== activeStreamLoadToken) return;
            hidePlayerLoading();
            syncAudioWithVideo(true);
        };

        nativePlayer.onerror = () => {
            if (loadToken !== activeStreamLoadToken) return;
            const err = nativePlayer.error;
            if (err && err.code === 1) return; // Routine abort ignored

            const currentPlayTime = getEffectiveCurrentTime() > 0
                ? getEffectiveCurrentTime()
                : preserveTimeSec;

            // Automatic Self-Healing Stage 1: Re-trigger stream connection (up to 2 automatic retries)
            if (retryAttempt < 2) {
                console.log(`[Ardane Stream] Auto-retry ${retryAttempt + 1}/2 for ${videoId} (${chosenVideo.height}p)...`);
                showPlayerLoading('Menyiapkan ulang aliran stream...');
                setTimeout(() => {
                    if (loadToken !== activeStreamLoadToken) return;
                    selectAndPlayStreamResolution(
                        videoId,
                        metadata,
                        targetQuality,
                        currentPlayTime,
                        safeIndex,
                        retryAttempt + 1,
                        hasRefetchedMeta
                    );
                }, 320);
                return;
            }

            // Automatic Self-Healing Stage 2: Step down to next available resolution (e.g. 1440p -> 1080p -> 720p)
            if (safeIndex + 1 < candidates.length) {
                const nextVideo = candidates[safeIndex + 1];
                console.log(`[Ardane Stream] Stepping down resolution from ${chosenVideo.height}p to ${nextVideo.height}p...`);
                showPlayerLoading(`Menyesuaikan resolusi stream (${nextVideo.height}p)...`);
                setTimeout(() => {
                    if (loadToken !== activeStreamLoadToken) return;
                    selectAndPlayStreamResolution(
                        videoId,
                        metadata,
                        targetQuality,
                        currentPlayTime,
                        safeIndex + 1,
                        0,
                        hasRefetchedMeta
                    );
                }, 250);
                return;
            }

            // Automatic Self-Healing Stage 3: Re-fetch fresh yt-dlp metadata if cached URL expired
            if (!hasRefetchedMeta) {
                console.log(`[Ardane Stream] Refreshing yt-dlp stream URLs for ${videoId}...`);
                videoMetadataCache.delete(videoId);
                loadInProStreamEngine(videoId, targetQuality, currentPlayTime, true);
                return;
            }

            hidePlayerLoading();
            console.warn('Native player error after all retries:', err);
            showPlayerError('Pemutar video mengalami kendala stream. Coba ganti resolusi atau pilih video lain.');
        };

        nativePlayer.src = vStreamUrl;
        nativePlayer.load();

        // Update UI Label
        const actualResLabel = `${chosenVideo.height}p`;
        if (currentQualityLabel) {
            currentQualityLabel.textContent = targetQuality === 'auto' ? `Auto (${actualResLabel})` : actualResLabel;
        }
        document.querySelectorAll('#qualityMenu .dx-dropdown-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('data-quality') === targetQuality);
        });

        if (retryAttempt === 0) {
            const engineTag = chosenVideo.isTranscodeMp4 ? 'HD Pro' : 'WebM';
            showOsd(`📺 ${actualResLabel} ${engineTag} • ${Math.round(currentVideoFps)}fps`);
        }
    }

    function changeQuality(newQuality, label) {
        if (!currentVideo || !currentVideo.id) return;
        const prevTime = getEffectiveCurrentTime();
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
        const currentFrame = Math.round(getEffectiveCurrentTime() * fps);
        const targetFrame = forward ? currentFrame + count : Math.max(0, currentFrame - count);
        const targetSec = Math.max(0, targetFrame * frameDuration);
        seekVideoTo(targetSec, false);
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
        const cur = getEffectiveCurrentTime();
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
        const cur = getEffectiveCurrentTime();
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
        seekVideoTo(loopIn, false);
        showOsd(`⏮️ Jump to In: ${formatTimecode(loopIn)}`);
    }

    function jumpToOut() {
        if (!nativePlayer || loopOut === null) return;
        seekVideoTo(loopOut, false);
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
        const dur = getEffectiveDuration();
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

        const proc = cp.spawn(ytDlp, args, { env: getProcessEnv(), windowsHide: true });

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
                        <button type="button" class="dx-card-dl-btn" title="Download video ini ke Bin Premiere Pro" onclick="event.stopPropagation(); window.ArdaneYT.download('${item.id}', '${escapeHtml(item.title)}')">&#11015; Download</button>
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

    // Export global play & download methods for inline card onclick
    window.ArdaneYT = window.DisplayX = {
        play: function (id, title, channel, duration) {
            playVideo(id, title, channel, duration);
        },
        download: function (id) {
            if (!id) return;
            const url = `https://www.youtube.com/watch?v=${id}`;
            sendVideoToDownloader(url, null, null);
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
    // CLIPBOARD AUTO-DETECTION (YouTube & Multi-Platform)
    // ==========================================
    const btnDownloadClipboard = document.getElementById('btnDownloadClipboard');

    function isSupportedDownloadMediaUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const lower = url.trim().toLowerCase();
        return (
            lower.includes('youtube.com/watch') ||
            lower.includes('youtu.be/') ||
            lower.includes('youtube.com/shorts') ||
            lower.includes('tiktok.com/') ||
            lower.includes('instagram.com/p/') ||
            lower.includes('instagram.com/reel/') ||
            lower.includes('facebook.com/') ||
            lower.includes('fb.watch/') ||
            lower.includes('twitter.com/') ||
            lower.includes('x.com/')
        );
    }

    function checkClipboard() {
        readSystemClipboard((text) => {
            if (!text) return;
            if (text && text !== lastDetectedClipboard) {
                const vidId = extractYouTubeId(text);
                const isMedia = isSupportedDownloadMediaUrl(text);
                if (vidId || isMedia) {
                    lastDetectedClipboard = text;
                    const shortText = text.length > 34 ? text.substring(0, 34) + '...' : text;
                    clipboardText.textContent = vidId
                        ? `Link YouTube: ${shortText}`
                        : `Link Media: ${shortText}`;
                    clipboardBanner.style.display = 'flex';

                    if (btnPlayClipboard) {
                        btnPlayClipboard.style.display = vidId ? 'inline-block' : 'none';
                        btnPlayClipboard.onclick = () => {
                            switchModeTab('player');
                            playVideo(vidId, "Video dari Clipboard", "YouTube", "");
                            clipboardBanner.style.display = 'none';
                        };
                    }

                    if (btnDownloadClipboard) {
                        btnDownloadClipboard.onclick = () => {
                            clipboardBanner.style.display = 'none';
                            sendVideoToDownloader(text, null, null);
                        };
                    }
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
        writeSystemClipboard(link, (ok) => {
            if (ok) {
                showToast("📋 Link disalin ke clipboard!");
            } else {
                showToast(`Link: ${link}`);
            }
        });
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

    // Unified Scrubber Click + Drag Helper (for both NLE Timeline Bar & In-Player Scrubber)
    function bindScrubberDrag(trackElement) {
        if (!trackElement) return;

        const computeTargetSec = (clientX) => {
            const dur = getEffectiveDuration();
            if (!dur || dur <= 0) return null;
            const rect = trackElement.getBoundingClientRect();
            if (!rect.width) return null;
            const clickX = Math.max(0, Math.min(rect.width, clientX - rect.left));
            const pct = clickX / rect.width;
            return pct * dur;
        };

        trackElement.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const initialSec = computeTargetSec(e.clientX);
            if (initialSec === null) return;

            isScrubbingTimeline = true;
            let lastDragSec = initialSec;
            seekVideoTo(initialSec, true);

            const onMouseMove = (moveEvt) => {
                if (!isScrubbingTimeline) return;
                const moveSec = computeTargetSec(moveEvt.clientX);
                if (moveSec !== null) {
                    lastDragSec = moveSec;
                    seekVideoTo(moveSec, true);
                }
            };

            const onMouseUp = (upEvt) => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                if (!isScrubbingTimeline) return;
                isScrubbingTimeline = false;
                const finalSec = computeTargetSec(upEvt.clientX);
                seekVideoTo(finalSec !== null ? finalSec : lastDragSec, false);
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    bindScrubberDrag(timelineTrack);
    bindScrubberDrag(vcScrubberWrap);

    function toggleVideoPlayPause() {
        if (!nativePlayer) return;
        if (nativePlayer.paused) {
            const dur = getEffectiveDuration();
            const cur = getEffectiveCurrentTime();
            if (nativePlayer.ended || (dur > 0 && cur >= dur - 0.4)) {
                const restartTime = (loopIn !== null) ? loopIn : 0;
                seekVideoTo(restartTime, false);
                const p = nativePlayer.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
                showOsd('▶ Play');
                return;
            }
            if (isCurrentStreamTranscodeMp4 && (nativePlayer.readyState < 2 || nativePlayer.error)) {
                seekVideoTo(cur, false);
                const p = nativePlayer.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
                showOsd('▶ Play');
                return;
            }
            const p = nativePlayer.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
            showOsd('▶ Play');
        } else {
            nativePlayer.pause();
            if (nativeAudio && hasSeparateAudio) nativeAudio.pause();
            showOsd('⏸️ Pause');
        }
    }

    if (vcBtnPlayPause) {
        vcBtnPlayPause.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleVideoPlayPause();
        });
    }

    if (vcBtnFullscreen) {
        vcBtnFullscreen.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!nativePlayer) return;
            const targetEl = playerStage || nativePlayer;
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else if (targetEl.requestFullscreen) {
                targetEl.requestFullscreen().catch(() => {});
            }
        });
    }

    if (nativePlayer) {
        nativePlayer.addEventListener('click', (e) => {
            if (suppressNextVideoClick) {
                suppressNextVideoClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // When custom controls are active (MP4 HD Pro or Zoom Mode), clicking video surface toggles Play/Pause like YouTube
            if (isCurrentStreamTranscodeMp4 || currentZoomScale > 1.001) {
                toggleVideoPlayPause();
            }
        });
    }

    // ==========================================================================
    // PREMIERE PRO PROGRAM MONITOR STYLE VIDEO ZOOM & PAN (LEFT/RIGHT, UP/DOWN)
    // ==========================================================================
    function syncZoomDropdownHighlight(scaleVal) {
        if (!zoomMenu) return;
        zoomMenu.querySelectorAll('.dx-dropdown-item').forEach(item => {
            const z = parseFloat(item.getAttribute('data-zoom') || '1');
            item.classList.toggle('active', Math.abs(z - scaleVal) < 0.04);
        });
    }

    function updateVideoZoomAndPan() {
        if (!nativePlayer || !playerStage) return;

        if (currentZoomScale <= 1.005) {
            currentZoomScale = 1;
            currentPanNormX = 0.5;
            currentPanNormY = 0.5;

            playerStage.classList.remove('is-zoomed', 'is-panning');
            nativePlayer.style.transform = '';

            if (panScrollbarH) panScrollbarH.style.display = 'none';
            if (panScrollbarV) panScrollbarV.style.display = 'none';
            if (zoomResetBadge) zoomResetBadge.style.display = 'none';
            if (currentZoomLabel) currentZoomLabel.textContent = 'Fit';
            if (btnZoom) btnZoom.classList.remove('active');
            syncZoomDropdownHighlight(1);

            if (currentVideo && nativePlayer.style.display !== 'none') {
                nativePlayer.controls = !isCurrentStreamTranscodeMp4;
                if (customVideoControls) {
                    customVideoControls.style.display = isCurrentStreamTranscodeMp4 ? 'flex' : 'none';
                }
            }
            return;
        }

        currentZoomScale = Math.max(1, Math.min(4, currentZoomScale));
        currentPanNormX = Math.max(0, Math.min(1, currentPanNormX));
        currentPanNormY = Math.max(0, Math.min(1, currentPanNormY));

        playerStage.classList.add('is-zoomed');

        const stageW = playerStage.clientWidth || 480;
        const stageH = playerStage.clientHeight || 270;
        const maxPanX = ((currentZoomScale - 1) * stageW) / 2;
        const maxPanY = ((currentZoomScale - 1) * stageH) / 2;

        // normX: 0 = left edge (+maxPanX), 0.5 = center (0), 1 = right edge (-maxPanX)
        // normY: 0 = top edge (+maxPanY), 0.5 = center (0), 1 = bottom edge (-maxPanY)
        const panX = (0.5 - currentPanNormX) * 2 * maxPanX;
        const panY = (0.5 - currentPanNormY) * 2 * maxPanY;

        nativePlayer.style.transformOrigin = 'center center';
        nativePlayer.style.transform = `translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0) scale(${currentZoomScale.toFixed(3)})`;

        // Keep bottom controls at 100% crisp scale (not magnified with the video element)
        if (currentVideo && nativePlayer.style.display !== 'none') {
            nativePlayer.controls = false;
            if (customVideoControls) {
                customVideoControls.style.display = 'flex';
            }
        }

        const pctText = `${Math.round(currentZoomScale * 100)}%`;
        if (currentZoomLabel) currentZoomLabel.textContent = pctText;
        if (btnZoom) btnZoom.classList.add('active');
        if (zoomResetBadge) {
            zoomResetBadge.style.display = 'inline-flex';
            if (zoomResetBadgeText) zoomResetBadgeText.textContent = `🔍 ${pctText}`;
        }
        syncZoomDropdownHighlight(currentZoomScale);

        // Update Premiere Pro Style Horizontal & Vertical Pan Scrollbars
        const thumbFraction = Math.max(0.15, Math.min(1, 1 / currentZoomScale));
        const thumbPct = thumbFraction * 100;
        const maxOffsetPct = 100 - thumbPct;

        if (panScrollbarH && panThumbH) {
            panScrollbarH.style.display = 'block';
            panThumbH.style.width = `${thumbPct.toFixed(2)}%`;
            panThumbH.style.left = `${(currentPanNormX * maxOffsetPct).toFixed(2)}%`;
        }
        if (panScrollbarV && panThumbV) {
            panScrollbarV.style.display = 'block';
            panThumbV.style.height = `${thumbPct.toFixed(2)}%`;
            panThumbV.style.top = `${(currentPanNormY * maxOffsetPct).toFixed(2)}%`;
        }
    }

    function setVideoZoom(newScale, showFeedback = true) {
        const clamped = Math.max(1, Math.min(4, Number(newScale) || 1));
        if (clamped <= 1.005) {
            currentZoomScale = 1;
            currentPanNormX = 0.5;
            currentPanNormY = 0.5;
            updateVideoZoomAndPan();
            if (showFeedback) showOsd('🖥️ Zoom: Fit (100%)');
        } else {
            currentZoomScale = clamped;
            updateVideoZoomAndPan();
            if (showFeedback) showOsd(`🔍 Zoom: ${Math.round(currentZoomScale * 100)}% (Drag untuk Geser)`);
        }
    }

    // 1. Direct Drag Panning on Video Canvas (Hand Tool) when Zoomed In
    if (nativePlayer && playerStage) {
        nativePlayer.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || currentZoomScale <= 1.005) return;
            e.preventDefault();

            const startX = e.clientX;
            const startY = e.clientY;
            const startNormX = currentPanNormX;
            const startNormY = currentPanNormY;
            const stageW = playerStage.clientWidth || 480;
            const stageH = playerStage.clientHeight || 270;
            const maxPanX = Math.max(1, ((currentZoomScale - 1) * stageW) / 2);
            const maxPanY = Math.max(1, ((currentZoomScale - 1) * stageH) / 2);
            let movedDist = 0;

            playerStage.classList.add('is-panning');

            const onMove = (moveEvt) => {
                const dx = moveEvt.clientX - startX;
                const dy = moveEvt.clientY - startY;
                movedDist = Math.max(movedDist, Math.hypot(dx, dy));

                // Dragging right (dx > 0) moves view towards left edge (normX decreases)
                currentPanNormX = Math.max(0, Math.min(1, startNormX - (dx / (2 * maxPanX))));
                currentPanNormY = Math.max(0, Math.min(1, startNormY - (dy / (2 * maxPanY))));
                updateVideoZoomAndPan();
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                playerStage.classList.remove('is-panning');
                if (movedDist > 4) {
                    suppressNextVideoClick = true;
                    setTimeout(() => { suppressNextVideoClick = false; }, 120);
                }
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        // Double-click zoomed video to reset back to Fit (100%)
        nativePlayer.addEventListener('dblclick', (e) => {
            if (currentZoomScale > 1.005) {
                e.preventDefault();
                e.stopPropagation();
                setVideoZoom(1, true);
            }
        });
    }

    // 2. Premiere Pro Style Horizontal & Vertical Scrollbar Dragging
    if (panScrollbarH && panThumbH) {
        panScrollbarH.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || currentZoomScale <= 1.005) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = panScrollbarH.getBoundingClientRect();
            const thumbFraction = Math.max(0.15, Math.min(1, 1 / currentZoomScale));
            const usableTrackW = Math.max(1, rect.width * (1 - thumbFraction));
            const thumbW = rect.width * thumbFraction;

            const isThumbClick = (e.target === panThumbH);
            const startX = e.clientX;
            let startNormX = currentPanNormX;

            if (!isThumbClick) {
                const clickRel = e.clientX - rect.left - (thumbW / 2);
                startNormX = Math.max(0, Math.min(1, clickRel / usableTrackW));
                currentPanNormX = startNormX;
                updateVideoZoomAndPan();
            }

            const onMove = (moveEvt) => {
                const dx = moveEvt.clientX - startX;
                currentPanNormX = Math.max(0, Math.min(1, startNormX + (dx / usableTrackW)));
                updateVideoZoomAndPan();
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }

    if (panScrollbarV && panThumbV) {
        panScrollbarV.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || currentZoomScale <= 1.005) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = panScrollbarV.getBoundingClientRect();
            const thumbFraction = Math.max(0.15, Math.min(1, 1 / currentZoomScale));
            const usableTrackH = Math.max(1, rect.height * (1 - thumbFraction));
            const thumbH = rect.height * thumbFraction;

            const isThumbClick = (e.target === panThumbV);
            const startY = e.clientY;
            let startNormY = currentPanNormY;

            if (!isThumbClick) {
                const clickRel = e.clientY - rect.top - (thumbH / 2);
                startNormY = Math.max(0, Math.min(1, clickRel / usableTrackH));
                currentPanNormY = startNormY;
                updateVideoZoomAndPan();
            }

            const onMove = (moveEvt) => {
                const dy = moveEvt.clientY - startY;
                currentPanNormY = Math.max(0, Math.min(1, startNormY + (dy / usableTrackH)));
                updateVideoZoomAndPan();
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }

    // 3. Mouse Wheel / Trackpad Zoom (Alt/Cmd/Ctrl + Scroll) & Two-Finger Pan when Zoomed In
    if (playerStage) {
        playerStage.addEventListener('wheel', (e) => {
            if (!currentVideo || !nativePlayer || nativePlayer.style.display === 'none') return;

            // Alt + Scroll or Cmd/Ctrl + Scroll (or Trackpad Pinch): Zoom In / Out
            if (e.altKey || e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();

                const rect = playerStage.getBoundingClientRect();
                const cursorRelX = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
                const cursorRelY = rect.height > 0 ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;

                const zoomDelta = e.deltaY < 0 ? 0.25 : -0.25;
                const nextScale = Math.max(1, Math.min(4, +(currentZoomScale + zoomDelta).toFixed(2)));

                if (currentZoomScale <= 1.005 && nextScale > 1.005) {
                    currentPanNormX = cursorRelX;
                    currentPanNormY = cursorRelY;
                }
                setVideoZoom(nextScale, true);
                return;
            }

            // When already zoomed in (> 100%), scrolling over the video pans left/right & up/down
            if (currentZoomScale > 1.005) {
                e.preventDefault();
                e.stopPropagation();
                const stageW = playerStage.clientWidth || 480;
                const stageH = playerStage.clientHeight || 270;
                const maxPanX = Math.max(1, ((currentZoomScale - 1) * stageW) / 2);
                const maxPanY = Math.max(1, ((currentZoomScale - 1) * stageH) / 2);

                const panDx = e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) ? e.deltaY : e.deltaX;
                const panDy = e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) ? 0 : e.deltaY;

                currentPanNormX = Math.max(0, Math.min(1, currentPanNormX + (panDx / (2 * maxPanX))));
                currentPanNormY = Math.max(0, Math.min(1, currentPanNormY + (panDy / (2 * maxPanY))));
                updateVideoZoomAndPan();
            }
        }, { passive: false });
    }

    if (zoomResetBadge) {
        zoomResetBadge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setVideoZoom(1, true);
        });
    }

    window.addEventListener('resize', () => {
        if (currentZoomScale > 1.005) {
            updateVideoZoomAndPan();
        }
    });

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

        readSystemClipboard((clip) => {
            if (clip) {
                processUrl(clip);
            } else if (urlInput && urlInput.value.trim()) {
                processUrl(urlInput.value.trim());
            } else {
                if (urlInput) urlInput.focus();
                showToast('Salin (Copy) link YouTube terlebih dahulu.');
            }
        });
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
            if (zoomMenu) zoomMenu.style.display = 'none';
            if (speedMenu) speedMenu.style.display = 'none';
        });
    }

    // Zoom Dropdown Menu Toggle
    if (btnZoom) {
        btnZoom.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = zoomMenu && zoomMenu.style.display !== 'none';
            if (zoomMenu) zoomMenu.style.display = isOpen ? 'none' : 'block';
            if (qualityMenu) qualityMenu.style.display = 'none';
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
            if (zoomMenu) zoomMenu.style.display = 'none';
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

    // Zoom Menu Item Clicks
    if (zoomMenu) {
        zoomMenu.querySelectorAll('.dx-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const z = parseFloat(item.getAttribute('data-zoom') || '1');
                setVideoZoom(z, true);
                zoomMenu.style.display = 'none';
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
        if (zoomMenu) zoomMenu.style.display = 'none';
        if (speedMenu) speedMenu.style.display = 'none';
    });

    // Global Keyboard Shortcuts (NLE Standard: In/Out, Loop, Frame Step, Play/Pause, Seek, Audio)
    window.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
        if (isInput) return; // Do not intercept if user is typing in URL input or search input
        if (paneDownloader && paneDownloader.style.display !== 'none') return; // Do not intercept in Downloader tab

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
            toggleVideoPlayPause();
        } else if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowLeft') {
            e.preventDefault();
            if (nativePlayer) {
                seekVideoTo(Math.max(0, getEffectiveCurrentTime() - 5), false);
                showOsd('⏪ -5s');
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (nativePlayer) {
                const dur = getEffectiveDuration() || Infinity;
                seekVideoTo(Math.min(dur, getEffectiveCurrentTime() + 5), false);
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
        } else if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            setVideoZoom(Math.min(4, +(currentZoomScale + 0.25).toFixed(2)), true);
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            setVideoZoom(Math.max(1, +(currentZoomScale - 0.25).toFixed(2)), true);
        } else if (e.key === '0' || e.key === '\\') {
            e.preventDefault();
            setVideoZoom(1, true);
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

    // ==========================================================================
    // MODE NAVIGATION TABS & MULTI-PLATFORM DOWNLOADER + BIN IMPORTER ENGINE
    // ==========================================================================
    const tabBtnPlayer = document.getElementById('tabBtnPlayer');
    const tabBtnDownloader = document.getElementById('tabBtnDownloader');
    const panePlayer = document.getElementById('panePlayer');
    const paneDownloader = document.getElementById('paneDownloader');
    const btnSendToDownloader = document.getElementById('btnSendToDownloader');

    // Downloader DOM Elements
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const btnRefresh = document.getElementById('btnRefresh');
    const savePathText = document.getElementById('savePathText');

    const ytUrlInput = document.getElementById('ytUrl');
    const btnPasteDlUrl = document.getElementById('btnPasteDlUrl');
    const btnAnalyze = document.getElementById('btnAnalyze');
    const analyzeIcon = document.getElementById('analyzeIcon');
    const analyzeText = document.getElementById('analyzeText');
    const platformBadge = document.getElementById('platformBadge');

    const formatSelect = document.getElementById('formatSelect');
    const detectStatus = document.getElementById('detectStatus');

    const videoInfoBox = document.getElementById('videoInfoBox');
    const videoThumb = document.getElementById('videoThumb');
    const videoTitle = document.getElementById('videoTitle');
    const videoDuration = document.getElementById('videoDuration');
    const videoMaxRes = document.getElementById('videoMaxRes');

    const checkCookies = document.getElementById('checkCookies');
    const checkSegment = document.getElementById('checkSegment');
    const segmentInputs = document.getElementById('segmentInputs');
    const tcHeaderHint = document.getElementById('tcHeaderHint');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    const binNameInput = document.getElementById('binName');

    const startH = document.getElementById('startH');
    const startM = document.getElementById('startM');
    const startS = document.getElementById('startS');
    const endH = document.getElementById('endH');
    const endM = document.getElementById('endM');
    const endS = document.getElementById('endS');
    const btnResetStart = document.getElementById('btnResetStart');
    const btnSetFullEnd = document.getElementById('btnSetFullEnd');
    const tcBadge = document.getElementById('tcBadge');
    const tcDurationText = document.getElementById('tcDurationText');
    const btnNudgeMinus10 = document.getElementById('btnNudgeMinus10');
    const btnNudgePlus10 = document.getElementById('btnNudgePlus10');
    const btnNudgeMinus60 = document.getElementById('btnNudgeMinus60');
    const btnNudgePlus60 = document.getElementById('btnNudgePlus60');

    const btnDownload = document.getElementById('btnDownload');
    const btnDownloadText = document.getElementById('btnDownloadText');
    const toastBox = document.getElementById('toastBox');

    const progressCard = document.getElementById('progressCard');
    const progressPhase = document.getElementById('progressPhase');
    const progressPercent = document.getElementById('progressPercent');
    const progressBar = document.getElementById('progressBar');
    const progressSpeed = document.getElementById('progressSpeed');
    const progressEta = document.getElementById('progressEta');

    const logToggle = document.getElementById('logToggle');
    const logContent = document.getElementById('logContent');
    const logClearBtn = document.getElementById('logClearBtn');

    // Downloader State
    let currentProjectPath = "";
    let currentTargetFolder = "";
    let isProjectValid = false;
    let isDownloading = false;
    let isAnalyzing = false;
    let currentVideoDurationSec = 0;
    let activeAnalyzedUrl = "";
    let preserveCustomSegment = false;

    function switchModeTab(tabName) {
        const isDownloader = (tabName === 'downloader');
        if (tabBtnPlayer) tabBtnPlayer.classList.toggle('active', !isDownloader);
        if (tabBtnDownloader) tabBtnDownloader.classList.toggle('active', isDownloader);
        if (panePlayer) panePlayer.style.display = isDownloader ? 'none' : 'flex';
        if (paneDownloader) paneDownloader.style.display = isDownloader ? 'flex' : 'none';

        if (isDownloader) {
            if (nativePlayer && !nativePlayer.paused) {
                try { nativePlayer.pause(); } catch (e) {}
            }
            if (nativeAudio && !nativeAudio.paused) {
                try { nativeAudio.pause(); } catch (e) {}
            }
            checkProjectStatus();
            const mainScroll = document.getElementById('mainScroll');
            if (mainScroll) mainScroll.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    if (tabBtnPlayer) {
        tabBtnPlayer.addEventListener('click', () => switchModeTab('player'));
    }
    if (tabBtnDownloader) {
        tabBtnDownloader.addEventListener('click', () => switchModeTab('downloader'));
    }

    // Bridge: Send Video (and optional In/Out Range) from Player to Downloader Tab
    function sendVideoToDownloader(url, customStartSec = null, customEndSec = null) {
        if (!url) return;
        switchModeTab('downloader');

        if (ytUrlInput) {
            ytUrlInput.value = url;
            updatePlatformBadge(url);
        }

        if (formatSelect && currentQuality && currentQuality !== 'auto') {
            const matchingOpt = formatSelect.querySelector(`option[value="${currentQuality}"]`);
            if (matchingOpt) {
                formatSelect.value = currentQuality;
            }
        }

        if (customStartSec !== null || customEndSec !== null) {
            preserveCustomSegment = true;
            const sSec = customStartSec !== null ? Math.floor(customStartSec) : 0;
            const eSec = customEndSec !== null ? Math.ceil(customEndSec) : (nativePlayer && nativePlayer.duration ? Math.ceil(nativePlayer.duration) : sSec + 60);
            if (checkSegment) checkSegment.checked = true;
            if (segmentInputs) segmentInputs.style.display = 'flex';
            if (tcHeaderHint) tcHeaderHint.style.display = 'inline';
            setTimecodeFromSeconds('start', sSec);
            setTimecodeFromSeconds('end', Math.max(sSec + 1, eSec));
            updateTimecodeValues();
            showToast(`✂️ Rentang In-Out (${formatTimecode(sSec)} - ${formatTimecode(eSec)}) disinkronkan ke Downloader!`);
        } else {
            preserveCustomSegment = false;
        }

        analyzeCurrentLink();
    }

    if (btnSendToDownloader) {
        btnSendToDownloader.addEventListener('click', () => {
            if (!currentVideo || !currentVideo.id) {
                showToast("Putar atau pilih video terlebih dahulu!");
                return;
            }
            const url = `https://www.youtube.com/watch?v=${currentVideo.id}`;
            if (loopIn !== null || loopOut !== null) {
                const sSec = loopIn !== null ? loopIn : 0;
                const eSec = loopOut !== null ? loopOut : (nativePlayer && nativePlayer.duration ? nativePlayer.duration : null);
                sendVideoToDownloader(url, sSec, eSec);
            } else {
                sendVideoToDownloader(url, null, null);
            }
        });
    }

    function getPlatformInfo(url) {
        if (!url) return { name: "YouTube • TikTok • IG • FB", icon: "", color: "#8bb8e8" };
        const u = url.toLowerCase();
        if (u.includes("youtube.com") || u.includes("youtu.be")) {
            return { name: "YouTube", icon: "▶️", color: "#ff4d4d" };
        }
        if (u.includes("instagram.com")) {
            return { name: "Instagram", icon: "📷", color: "#e1306c" };
        }
        if (u.includes("tiktok.com")) {
            return { name: "TikTok", icon: "🎵", color: "#00f2fe" };
        }
        if (u.includes("facebook.com") || u.includes("fb.watch")) {
            return { name: "Facebook", icon: "👥", color: "#1877f2" };
        }
        if (u.includes("twitter.com") || u.includes("x.com")) {
            return { name: "X / Twitter", icon: "🐦", color: "#1da1f2" };
        }
        return { name: "Media Web", icon: "🌐", color: "#1473e6" };
    }

    function updatePlatformBadge(url) {
        if (!platformBadge) return;
        const p = getPlatformInfo(url);
        platformBadge.textContent = `${p.icon} ${p.name}`.trim();
        platformBadge.style.color = p.color;
    }

    function resolveDownloaderBinaries() {
        return {
            ytDlpPath: resolveYtDlp(),
            ffmpegPath: resolveFfmpeg(),
            ffprobePath: resolveFfprobe()
        };
    }

    // Ensure ExtendScript functions are always up-to-date in Premiere Pro & After Effects even on simple HTML Reload
    const HOST_EXTENDSCRIPT_CODE = `
        function escapeJSONString(str) {
            if (!str) return '""';
            return '"' + String(str).replace(/\\\\/g, '\\\\\\\\')
                            .replace(/"/g, '\\\\"')
                            .replace(/\\n/g, '\\\\n')
                            .replace(/\\r/g, '\\\\r')
                            .replace(/\\t/g, '\\\\t') + '"';
        }
        function isAfterEffectsHost() {
            try {
                if (typeof FolderItem !== "undefined") return true;
                if (app && app.project && typeof app.project.importFile === "function" && !app.project.rootItem) return true;
            } catch (e) {}
            return false;
        }
        function getProjectInfo() {
            try {
                if (!app || !app.project) {
                    return '{"hasProject":false,"isSaved":false,"projectPath":"","projectName":"","hostApp":"UNKNOWN"}';
                }
                var proj = app.project;
                var isAE = isAfterEffectsHost();
                var hostApp = isAE ? "AEFT" : "PPRO";
                var pPath = "";
                var pName = "";
                if (isAE) {
                    if (proj.file) {
                        pPath = proj.file.fsName ? String(proj.file.fsName) : (proj.file.fullName ? String(proj.file.fullName) : "");
                        try {
                            pName = proj.file.name ? decodeURI(String(proj.file.name)) : "";
                        } catch (de) {
                            pName = proj.file.name ? String(proj.file.name) : "";
                        }
                    }
                } else {
                    pPath = proj.path ? String(proj.path) : "";
                    pName = proj.name ? String(proj.name) : "";
                    if (!pPath && proj.file && proj.file.fsName) {
                        pPath = String(proj.file.fsName);
                    }
                }
                var isSaved = (pPath !== null && pPath !== "" && pPath.length > 0);
                return '{"hasProject":true,"isSaved":' + (isSaved ? 'true' : 'false') +
                       ',"hostApp":' + escapeJSONString(hostApp) +
                       ',"projectPath":' + escapeJSONString(pPath) +
                       ',"projectName":' + escapeJSONString(pName) + '}';
            } catch (err) {
                return '{"hasProject":false,"error":' + escapeJSONString(err.toString()) + '}';
            }
        }
        function getOrCreateBin(binName) {
            if (!binName) binName = "YT Downloads";
            var root = app.project.rootItem;
            if (!root) return null;
            for (var i = 0; i < root.children.numItems; i++) {
                var child = root.children[i];
                if (child && child.name === binName && (child.type === ProjectItemType.BIN || child.type === 2)) {
                    return child;
                }
            }
            try {
                return root.createBin(binName);
            } catch (e) {
                return root;
            }
        }
        function getOrCreateAEFolder(folderName) {
            if (!folderName) folderName = "YT Downloads";
            var proj = app.project;
            if (!proj || !proj.items) return null;
            for (var i = 1; i <= proj.items.length; i++) {
                var item = proj.items[i];
                if (item && (item instanceof FolderItem) && item.name === folderName && item.parentFolder === proj.rootFolder) {
                    return item;
                }
            }
            try {
                return proj.items.addFolder(folderName);
            } catch (e) {
                return null;
            }
        }
        function importFileToBin(filePath, binName) {
            try {
                if (!app || !app.project) {
                    return '{"success":false,"error":"Tidak ada project yang terbuka."}';
                }
                if (!filePath) {
                    return '{"success":false,"error":"File path kosong."}';
                }
                var fileObj = new File(filePath);
                if (!fileObj.exists) {
                    return '{"success":false,"error":"File fisik tidak ditemukan di: " + ' + escapeJSONString(filePath) + '}';
                }
                var targetBinName = binName || "YT Downloads";
                if (isAfterEffectsHost()) {
                    var io = new ImportOptions(fileObj);
                    try {
                        io.sequence = false;
                        if (typeof ImportAsType !== "undefined" && io.canImportAs && io.canImportAs(ImportAsType.FOOTAGE)) {
                            io.importAs = ImportAsType.FOOTAGE;
                        }
                    } catch (ioErr) {}
                    var importedItem = app.project.importFile(io);
                    var targetFolder = getOrCreateAEFolder(targetBinName);
                    if (importedItem && targetFolder) {
                        try {
                            importedItem.parentFolder = targetFolder;
                        } catch (moveErr) {}
                    }
                    return '{"success":true,"hostApp":"AEFT","message":"File berhasil di-import ke folder After Effects","binName":' + escapeJSONString(targetBinName) + ',"filePath":' + escapeJSONString(fileObj.fsName) + '}';
                }
                var targetBin = getOrCreateBin(targetBinName);
                var fileArray = [fileObj.fsName];
                var beforeCount = targetBin && targetBin.children ? targetBin.children.numItems : 0;
                app.project.importFiles(fileArray, true, targetBin, false);
                if (targetBin && targetBin !== app.project.rootItem) {
                    var afterCount = targetBin.children ? targetBin.children.numItems : 0;
                    if (afterCount === beforeCount) {
                        var root = app.project.rootItem;
                        var fileNameOnly = fileObj.name;
                        for (var j = root.children.numItems - 1; j >= 0; j--) {
                            var item = root.children[j];
                            if (item && item.name === fileNameOnly) {
                                item.moveProjectItem(targetBin);
                                break;
                            }
                        }
                    }
                }
                return '{"success":true,"hostApp":"PPRO","message":"File berhasil di-import ke bin Premiere Pro","binName":' + escapeJSONString(targetBinName) + ',"filePath":' + escapeJSONString(fileObj.fsName) + '}';
            } catch (err) {
                return '{"success":false,"error":' + escapeJSONString(err.toString()) + '}';
            }
        }
    `;

    function appendLog(message) {
        console.log(message);
        if (!logContent) return;
        const timestamp = new Date().toLocaleTimeString();
        logContent.textContent += `[${timestamp}] ${message}\n`;
        logContent.scrollTop = logContent.scrollHeight;
    }

    function showDlToast(message, type = 'success', duration = 5000) {
        showToast(message);
        if (!toastBox) return;
        toastBox.className = `toast ${type}`;
        toastBox.textContent = message;
        toastBox.style.display = 'block';
        if (duration > 0) {
            setTimeout(() => {
                toastBox.style.display = 'none';
            }, duration);
        }
    }

    function checkProjectStatus(onCheckedCallback) {
        if (!statusDot || !statusText) {
            if (typeof onCheckedCallback === 'function') onCheckedCallback(false);
            return;
        }
        csInterface.evalScript(HOST_EXTENDSCRIPT_CODE + '\ngetProjectInfo();', function (result) {
            try {
                if (!result || result === 'EvalScript error.') {
                    statusDot.className = 'dot disconnected';
                    statusText.textContent = `Tidak dapat terhubung ke ${getHostAppLabel()}`;
                    isProjectValid = false;
                    if (typeof onCheckedCallback === 'function') onCheckedCallback(false);
                    return;
                }

                const info = JSON.parse(result);
                if (info.hostApp === 'AEFT') {
                    isAfterEffectsHostApp = true;
                } else if (info.hostApp === 'PPRO') {
                    isAfterEffectsHostApp = false;
                }
                const hostLabel = getHostAppLabel();
                appendLog(`Project check (${hostLabel}): ${JSON.stringify(info)}`);

                if (!info.hasProject) {
                    statusDot.className = 'dot disconnected';
                    statusText.textContent = "Tidak ada project terbuka";
                    if (savePathText) savePathText.textContent = `Buka atau buat project di ${hostLabel}`;
                    isProjectValid = false;
                    if (btnDownload) btnDownload.disabled = true;
                    if (typeof onCheckedCallback === 'function') onCheckedCallback(false);
                    return;
                }

                const hasPath = Boolean(info.projectPath && info.projectPath.length > 0);
                if (!hasPath) {
                    statusDot.className = 'dot';
                    statusText.textContent = `Project ${hostLabel} belum disimpan (Unsaved)`;
                    if (savePathText) savePathText.textContent = `Simpan project ${hostLabel} (Cmd+S / Ctrl+S) terlebih dahulu!`;
                    isProjectValid = false;
                    if (btnDownload) btnDownload.disabled = true;
                    if (typeof onCheckedCallback === 'function') onCheckedCallback(false);
                    return;
                }

                currentProjectPath = cleanCepPath(info.projectPath);
                const projectDir = path.dirname(currentProjectPath);
                currentTargetFolder = path.join(projectDir, "YT Downloads");

                try {
                    if (fs && fs.mkdirSync && !fs.existsSync(currentTargetFolder)) {
                        fs.mkdirSync(currentTargetFolder, { recursive: true });
                    }
                } catch (mkdirErr) {
                    appendLog("Info folder: " + mkdirErr.message);
                }

                statusDot.className = 'dot connected';
                statusText.textContent = `Aktif (${hostLabel}): ${info.projectName || 'Project'}`;
                if (savePathText) savePathText.textContent = currentTargetFolder;
                isProjectValid = true;
                if (btnDownload) btnDownload.disabled = isDownloading;
                if (typeof onCheckedCallback === 'function') onCheckedCallback(true);
            } catch (e) {
                appendLog("Error parsing getProjectInfo: " + e.message);
                statusDot.className = 'dot disconnected';
                statusText.textContent = "Error komunikasi ExtendScript: " + e.message;
                isProjectValid = false;
                if (typeof onCheckedCallback === 'function') onCheckedCallback(false);
            }
        });
    }

    function fetchThumbnailBase64(thumbUrl, callback) {
        if (!thumbUrl || (!https && !http)) {
            return callback(thumbUrl || "");
        }
        try {
            const client = thumbUrl.startsWith('https') ? https : http;
            client.get(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return fetchThumbnailBase64(res.headers.location, callback);
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const mime = res.headers['content-type'] || 'image/jpeg';
                    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
                    callback(dataUri);
                });
            }).on('error', (err) => {
                appendLog(`Thumbnail note: ${err.message}`);
                callback(thumbUrl);
            });
        } catch (e) {
            callback(thumbUrl);
        }
    }

    function resetPreviewState() {
        if (videoInfoBox) videoInfoBox.style.display = 'none';
        if (videoThumb) videoThumb.src = '';
        if (detectStatus) detectStatus.textContent = '';
        activeAnalyzedUrl = '';
        currentVideoDurationSec = 0;
    }

    function formatSecondsToTime(sec) {
        if (!sec || isNaN(sec)) return "--:--";
        const total = Math.floor(sec);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        if (h > 0) {
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function analyzeCurrentLink() {
        if (isAnalyzing || isDownloading || !ytUrlInput) return;

        const url = ytUrlInput.value.trim();
        if (!url) {
            showDlToast("Harap masukkan link media terlebih dahulu!", "error");
            ytUrlInput.focus();
            return;
        }

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            showDlToast("URL tidak valid. Masukkan link yang lengkap (https://...).", "error");
            return;
        }

        isAnalyzing = true;
        if (btnAnalyze) btnAnalyze.disabled = true;
        if (analyzeIcon) analyzeIcon.innerHTML = '&#9203;';
        if (analyzeText) analyzeText.textContent = 'Mengecek...';
        if (detectStatus) {
            detectStatus.textContent = '⏳ Mengambil info video...';
            detectStatus.style.color = '#7ab7ff';
        }

        resetPreviewState();

        const { ytDlpPath } = resolveDownloaderBinaries();
        appendLog(`Memulai analisis URL: ${url}`);

        const isYouTubeUrl = /youtube\.com|youtu\.be/i.test(url);
        const args = [
            '-J',
            '--no-playlist'
        ];
        if (isYouTubeUrl) {
            args.push('--extractor-args', 'youtube:player_client=default,-tv_samsung');
        } else {
            args.push('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        }
        args.push(url);

        if (checkCookies && checkCookies.checked) {
            const cookieBrowser = getBrowserCookieSource();
            args.splice(1, 0, '--cookies-from-browser', cookieBrowser);
            appendLog(`Menggunakan cookie ${cookieBrowser} untuk otentikasi`);
        }

        let stdoutData = "";
        let stderrData = "";

        const metaProc = cp.spawn(ytDlpPath, args, { env: getProcessEnv(), windowsHide: true });

        metaProc.stdout.on('data', (chunk) => {
            stdoutData += chunk.toString();
        });

        metaProc.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        metaProc.on('close', (code) => {
            isAnalyzing = false;
            if (btnAnalyze) btnAnalyze.disabled = false;
            if (analyzeIcon) analyzeIcon.innerHTML = '&#128269;';
            if (analyzeText) analyzeText.textContent = 'Analyze';

            if (code === 0 && stdoutData) {
                try {
                    const info = JSON.parse(stdoutData);
                    activeAnalyzedUrl = url;
                    appendLog(`Media terdeteksi: "${info.title}" [${info.extractor || 'Web'}]`);

                    currentVideoDurationSec = Number(info.duration) || 0;
                    if (videoDuration) videoDuration.textContent = info.duration_string || formatSecondsToTime(currentVideoDurationSec);

                    // Sync segment timecode picker unless custom In/Out was transferred from Player
                    if (!preserveCustomSegment) {
                        setTimecodeFromSeconds('start', 0);
                        if (currentVideoDurationSec > 0) {
                            setTimecodeFromSeconds('end', currentVideoDurationSec);
                        } else {
                            setTimecodeFromSeconds('end', 60);
                        }
                    }
                    preserveCustomSegment = false;
                    updateTimecodeValues();

                    if (videoInfoBox) videoInfoBox.style.display = 'flex';
                    if (videoTitle) videoTitle.textContent = info.title || (getPlatformInfo(url).name + " Video");

                    if (info.thumbnail && videoThumb) {
                        fetchThumbnailBase64(info.thumbnail, (b64) => {
                            videoThumb.src = b64;
                        });
                    }

                    const formats = info.formats || [];
                    const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
                    const heights = Array.from(new Set(videoFormats.map(f => Number(f.height))))
                                         .filter(h => !isNaN(h) && h > 0)
                                         .sort((a, b) => b - a);

                    appendLog(`Resolusi terdeteksi: ${heights.length ? heights.join(', ') + 'p' : 'Default Stream'}`);

                    if (formatSelect) {
                        const prevSelectedVal = formatSelect.value || 'best_video';
                        formatSelect.innerHTML = '';
                        const platform = getPlatformInfo(url).name;

                        if (heights.length > 0) {
                            const topRes = heights[0];
                            if (videoMaxRes) videoMaxRes.textContent = topRes >= 2160 ? '4K UHD' : (topRes >= 1440 ? '2K QHD' : `${topRes}p`);

                            const bestOpt = document.createElement('option');
                            bestOpt.value = 'best_video';
                            bestOpt.textContent = `⭐ Kualitas Terbaik (${topRes}p - H.264 MP4)`;
                            formatSelect.appendChild(bestOpt);

                            heights.forEach(h => {
                                const opt = document.createElement('option');
                                opt.value = String(h);
                                let label = `${h}p (H.264 MP4)`;
                                if (h >= 2160) label = `🎬 4K Ultra HD (${h}p H.264)`;
                                else if (h >= 1440) label = `🎬 2K Quad HD (${h}p H.264)`;
                                else if (h >= 1080) label = `🎬 Full HD (${h}p H.264)`;
                                else if (h >= 720) label = `🎬 HD (${h}p H.264)`;
                                else if (h >= 480) label = `Standard (${h}p H.264)`;
                                else label = `Low (${h}p H.264)`;

                                opt.textContent = label;
                                formatSelect.appendChild(opt);
                            });
                        } else {
                            if (videoMaxRes) videoMaxRes.textContent = "HD MP4";
                            const defaultOpt = document.createElement('option');
                            defaultOpt.value = 'best_video';
                            defaultOpt.textContent = `⭐ Kualitas Terbaik (${platform} H.264 MP4)`;
                            formatSelect.appendChild(defaultOpt);
                        }

                        const mp3Opt = document.createElement('option');
                        mp3Opt.value = 'mp3';
                        mp3Opt.textContent = '🎵 Audio Saja (MP3 320kbps)';
                        formatSelect.appendChild(mp3Opt);

                        const wavOpt = document.createElement('option');
                        wavOpt.value = 'wav';
                        wavOpt.textContent = '🎵 Audio Saja (WAV Lossless)';
                        formatSelect.appendChild(wavOpt);

                        // Preserve user's selected resolution if available on this video; otherwise select 'best_video' (topRes)
                        const hasPrevOption = Array.from(formatSelect.options).some(o => o.value === prevSelectedVal);
                        formatSelect.value = hasPrevOption ? prevSelectedVal : 'best_video';
                    }

                    if (detectStatus) {
                        detectStatus.textContent = `✅ ${getPlatformInfo(url).name} Siap Didownload`;
                        detectStatus.style.color = "#30d158";
                    }
                    showDlToast(`Media "${info.title || 'Video'}" siap didownload!`, "success", 3000);
                } catch (parseErr) {
                    appendLog(`JSON parse note: ${parseErr.message}`);
                    if (detectStatus) detectStatus.textContent = "Format standar siap";
                }
            } else {
                appendLog(`Analisis gagal (code ${code}): ${stderrData}`);
                if (detectStatus) {
                    detectStatus.textContent = "Gagal memuat info media";
                    detectStatus.style.color = "#ff6961";
                }
                showDlToast("Gagal menganalisis link. Pastikan link publik atau coba centang Cookie.", "error", 5000);
            }
        });

        metaProc.on('error', (err) => {
            isAnalyzing = false;
            if (btnAnalyze) btnAnalyze.disabled = false;
            if (analyzeIcon) analyzeIcon.innerHTML = '&#128269;';
            if (analyzeText) analyzeText.textContent = 'Analyze';
            appendLog(`Spawn analyze error: ${err.message}`);
            showDlToast(`Error: ${err.message}`, "error");
        });
    }

    if (ytUrlInput) {
        ytUrlInput.addEventListener('input', function () {
            const val = this.value.trim();
            updatePlatformBadge(val);
            if (val !== activeAnalyzedUrl) {
                resetPreviewState();
            }
        });

        ytUrlInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                analyzeCurrentLink();
            }
        });

        ytUrlInput.addEventListener('paste', function () {
            setTimeout(() => {
                const val = ytUrlInput.value.trim();
                updatePlatformBadge(val);
                resetPreviewState();
                if (val.length > 10) {
                    analyzeCurrentLink();
                }
            }, 80);
        });
    }

    if (btnPasteDlUrl) {
        btnPasteDlUrl.addEventListener('click', () => {
            readSystemClipboard((clip) => {
                if (clip) {
                    if (ytUrlInput) ytUrlInput.value = clip;
                    updatePlatformBadge(clip);
                    analyzeCurrentLink();
                } else {
                    showDlToast("Clipboard kosong.", "error", 2000);
                }
            });
        });
    }

    if (btnAnalyze) {
        btnAnalyze.addEventListener('click', analyzeCurrentLink);
    }

    // Timecode Segment Controller
    function getTimecodeSeconds(type) {
        const hInput = type === 'start' ? startH : endH;
        const mInput = type === 'start' ? startM : endM;
        const sInput = type === 'start' ? startS : endS;

        const h = parseInt(hInput ? hInput.value : 0, 10) || 0;
        const m = parseInt(mInput ? mInput.value : 0, 10) || 0;
        const s = parseInt(sInput ? sInput.value : 0, 10) || 0;

        return (h * 3600) + (m * 60) + s;
    }

    function setTimecodeFromSeconds(type, totalSec) {
        let sec = Math.max(0, Math.floor(Number(totalSec) || 0));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);

        const hInput = type === 'start' ? startH : endH;
        const mInput = type === 'start' ? startM : endM;
        const sInput = type === 'start' ? startS : endS;

        if (hInput) hInput.value = String(Math.min(99, h)).padStart(2, '0');
        if (mInput) mInput.value = String(Math.min(59, m)).padStart(2, '0');
        if (sInput) sInput.value = String(Math.min(59, s)).padStart(2, '0');
    }

    function updateTimecodeValues() {
        if (!startH || !endH) return;

        const startSec = getTimecodeSeconds('start');
        const endSec = getTimecodeSeconds('end');

        const sH = String(parseInt(startH.value, 10) || 0).padStart(2, '0');
        const sM = String(parseInt(startM.value, 10) || 0).padStart(2, '0');
        const sS = String(parseInt(startS.value, 10) || 0).padStart(2, '0');
        const eH = String(parseInt(endH.value, 10) || 0).padStart(2, '0');
        const eM = String(parseInt(endM.value, 10) || 0).padStart(2, '0');
        const eS = String(parseInt(endS.value, 10) || 0).padStart(2, '0');

        if (startTimeInput) startTimeInput.value = `${sH}:${sM}:${sS}`;
        if (endTimeInput) endTimeInput.value = `${eH}:${eM}:${eS}`;

        const diffSec = endSec - startSec;

        if (diffSec <= 0) {
            if (tcBadge) tcBadge.classList.add('error');
            if (tcDurationText) tcDurationText.textContent = 'Selesai harus > Mulai!';
        } else {
            if (tcBadge) tcBadge.classList.remove('error');
            const h = Math.floor(diffSec / 3600);
            const m = Math.floor((diffSec % 3600) / 60);
            const s = Math.floor(diffSec % 60);
            let timeStr = "";
            if (h > 0) {
                timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            } else {
                timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            }
            if (tcDurationText) {
                tcDurationText.textContent = `${timeStr} (${diffSec}s)`;
            }
        }
    }

    function setupTcInputBehavior(input, maxVal, nextInput, prevInput) {
        if (!input) return;

        input.addEventListener('focus', function () {
            this.select();
        });

        input.addEventListener('blur', function () {
            let val = parseInt(this.value, 10);
            if (isNaN(val) || val < 0) val = 0;
            if (val > maxVal) val = maxVal;
            this.value = String(val).padStart(2, '0');
            updateTimecodeValues();
        });

        input.addEventListener('wheel', function (e) {
            e.preventDefault();
            let val = parseInt(this.value, 10) || 0;
            if (e.deltaY < 0) {
                val = Math.min(maxVal, val + 1);
            } else {
                val = Math.max(0, val - 1);
            }
            this.value = String(val).padStart(2, '0');
            updateTimecodeValues();
        }, { passive: false });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                let val = (parseInt(this.value, 10) || 0) + 1;
                if (val > maxVal) val = maxVal;
                this.value = String(val).padStart(2, '0');
                updateTimecodeValues();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                let val = (parseInt(this.value, 10) || 0) - 1;
                if (val < 0) val = 0;
                this.value = String(val).padStart(2, '0');
                updateTimecodeValues();
            } else if (e.key === 'ArrowRight' && nextInput && this.selectionStart === this.value.length) {
                nextInput.focus();
                nextInput.select();
            } else if (e.key === 'ArrowLeft' && prevInput && this.selectionStart === 0) {
                prevInput.focus();
                prevInput.select();
            }
        });

        input.addEventListener('input', function () {
            let raw = this.value.replace(/[^0-9]/g, '');
            if (raw.length >= 2) {
                let val = parseInt(raw, 10);
                if (val > maxVal) val = maxVal;
                this.value = String(val).padStart(2, '0');
                if (nextInput) {
                    nextInput.focus();
                    nextInput.select();
                }
            }
            updateTimecodeValues();
        });
    }

    setupTcInputBehavior(startH, 99, startM, null);
    setupTcInputBehavior(startM, 59, startS, startH);
    setupTcInputBehavior(startS, 59, endH, startM);

    setupTcInputBehavior(endH, 99, endM, startS);
    setupTcInputBehavior(endM, 59, endS, endH);
    setupTcInputBehavior(endS, 59, null, endM);

    if (btnResetStart) {
        btnResetStart.addEventListener('click', () => {
            setTimecodeFromSeconds('start', 0);
            updateTimecodeValues();
            showDlToast("Waktu mulai di-reset ke 00:00:00", "success", 1500);
        });
    }

    if (btnSetFullEnd) {
        btnSetFullEnd.addEventListener('click', () => {
            const targetSec = currentVideoDurationSec > 0 ? currentVideoDurationSec : 300;
            setTimecodeFromSeconds('end', targetSec);
            updateTimecodeValues();
            showDlToast(currentVideoDurationSec > 0 ? "Waktu selesai di-set sesuai durasi video." : "Waktu selesai di-set ke 00:05:00", "success", 1500);
        });
    }

    function nudgeEndTime(deltaSec) {
        const curEnd = getTimecodeSeconds('end');
        const startSec = getTimecodeSeconds('start');
        let newEnd = curEnd + deltaSec;
        if (newEnd <= startSec) newEnd = startSec + 1;
        if (currentVideoDurationSec > 0 && newEnd > currentVideoDurationSec) {
            newEnd = currentVideoDurationSec;
        }
        setTimecodeFromSeconds('end', newEnd);
        updateTimecodeValues();
    }

    if (btnNudgeMinus10) btnNudgeMinus10.addEventListener('click', () => nudgeEndTime(-10));
    if (btnNudgePlus10) btnNudgePlus10.addEventListener('click', () => nudgeEndTime(10));
    if (btnNudgeMinus60) btnNudgeMinus60.addEventListener('click', () => nudgeEndTime(-60));
    if (btnNudgePlus60) btnNudgePlus60.addEventListener('click', () => nudgeEndTime(60));

    if (checkSegment) {
        checkSegment.addEventListener('change', function () {
            if (this.checked) {
                if (segmentInputs) segmentInputs.style.display = 'flex';
                if (tcHeaderHint) tcHeaderHint.style.display = 'inline';
                const endSec = getTimecodeSeconds('end');
                if (endSec <= 60 && currentVideoDurationSec > 0) {
                    setTimecodeFromSeconds('end', currentVideoDurationSec);
                }
                updateTimecodeValues();
            } else {
                if (segmentInputs) segmentInputs.style.display = 'none';
                if (tcHeaderHint) tcHeaderHint.style.display = 'none';
            }
        });
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', function () {
            checkProjectStatus();
            showDlToast("Status project diperbarui.", "success", 2000);
        });
    }

    if (logToggle) {
        logToggle.addEventListener('click', function (e) {
            if (e.target === logClearBtn) {
                if (logContent) logContent.textContent = '';
                return;
            }
            if (!logContent) return;
            if (logContent.style.display === 'block') {
                logContent.style.display = 'none';
                logToggle.querySelector('span').innerHTML = '&#9654; Log Aktivitas / Terminal';
            } else {
                logContent.style.display = 'block';
                logToggle.querySelector('span').innerHTML = '&#9660; Log Aktivitas / Terminal';
            }
        });
    }

    function cleanTimestamp(val) {
        if (!val) return "";
        return val.trim().replace(/\s+/g, '');
    }

    function getStreamCodec(ffprobePath, filePath, streamType) {
        if (!cp || !cp.spawnSync) return "";
        try {
            const res = cp.spawnSync(ffprobePath, [
                "-v", "error",
                "-select_streams", streamType,
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                filePath
            ], { env: getProcessEnv(), timeout: 10000, windowsHide: true });
            return res.stdout ? res.stdout.toString().trim().toLowerCase() : "";
        } catch (e) {
            return "";
        }
    }

    function ensurePremiereCompatibility(filePath, ffmpegPath, ffprobePath, callback) {
        const ext = path.extname ? path.extname(filePath).toLowerCase() : filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

        if (ext === '.mp3' || ext === '.wav') {
            if (progressBar) progressBar.style.width = '100%';
            if (progressPercent) progressPercent.textContent = '100%';
            callback(filePath);
            return;
        }

        const vCodec = getStreamCodec(ffprobePath, filePath, 'v:0');
        const aCodec = getStreamCodec(ffprobePath, filePath, 'a:0');
        appendLog(`Analisis Codec File: Video=[${vCodec || 'unknown'}], Audio=[${aCodec || 'unknown'}]`);

        const isH264 = (vCodec === 'h264');
        const isAAC = (aCodec === 'aac' || aCodec === '');

        if (isH264 && isAAC && ext === '.mp4') {
            appendLog("Format file sudah H.264 & AAC murni (100% Premiere Compatible).");
            if (progressBar) progressBar.style.width = '96%';
            if (progressPercent) progressPercent.textContent = '96%';
            callback(filePath);
            return;
        }

        if (progressPhase) progressPhase.textContent = 'Menyesuaikan format ke H.264 & AAC...';
        if (progressBar) progressBar.style.width = '72%';
        if (progressPercent) progressPercent.textContent = '72%';
        if (progressSpeed) progressSpeed.textContent = 'FFmpeg Encoding...';
        appendLog(`Codec [${vCodec}/${aCodec}] disesuaikan ke H.264/AAC agar terbaca di Premiere Pro.`);

        const dir = path.dirname(filePath);
        const base = path.basename ? path.basename(filePath, ext) : filePath.split('/').pop().replace(ext, '');
        const tempOutput = path.join(dir, `${base}_pr_temp.mp4`);
        const finalMp4 = path.join(dir, `${base}.mp4`);

        const ffmpegArgs = ['-y', '-i', filePath];

        if (!isH264) {
            ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p');
        } else {
            ffmpegArgs.push('-c:v', 'copy');
        }

        if (!isAAC && aCodec) {
            ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
        } else {
            ffmpegArgs.push('-c:a', 'copy');
        }

        ffmpegArgs.push('-movflags', '+faststart', tempOutput);

        appendLog(`Menjalankan penyesuaian: ffmpeg ${ffmpegArgs.join(' ')}`);

        const ffProc = cp.spawn(ffmpegPath, ffmpegArgs, { env: getProcessEnv(), windowsHide: true });
        let detectedFileDurationSec = currentVideoDurationSec > 0 ? currentVideoDurationSec : 0;

        ffProc.stderr.on('data', (d) => {
            const str = d.toString();

            const durMatch = str.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (durMatch) {
                const parsedDur = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]);
                if (parsedDur > 0) {
                    detectedFileDurationSec = parsedDur;
                }
            }

            const timeMatch = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (timeMatch && detectedFileDurationSec > 0) {
                const currentSec = (+timeMatch[1]) * 3600 + (+timeMatch[2]) * 60 + (+timeMatch[3]);
                const progressRatio = Math.min(1, currentSec / detectedFileDurationSec);
                const combinedPct = 70 + Math.round(progressRatio * 26);
                if (progressBar) progressBar.style.width = `${combinedPct}%`;
                if (progressPercent) progressPercent.textContent = `${combinedPct}%`;
                if (progressPhase) progressPhase.textContent = `Menyesuaikan Codec H.264 Premiere: ${Math.round(progressRatio * 100)}%`;

                const speedMatch = str.match(/speed=\s*([0-9.]+x)/);
                if (speedMatch) {
                    const spdStr = speedMatch[1];
                    if (progressSpeed) progressSpeed.textContent = `FFmpeg ${spdStr}`;
                    const spdVal = parseFloat(spdStr);
                    if (spdVal > 0 && progressEta) {
                        const remSec = Math.max(0, Math.ceil((detectedFileDurationSec - currentSec) / spdVal));
                        progressEta.textContent = remSec > 0 ? `ETA: ~${remSec}s` : 'ETA: Selesai...';
                    }
                }
            }
        });

        ffProc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tempOutput)) {
                appendLog("Konversi codec ke H.264 & AAC berhasil!");
                if (progressBar) progressBar.style.width = '96%';
                if (progressPercent) progressPercent.textContent = '96%';
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    if (fs.existsSync(finalMp4) && finalMp4 !== tempOutput) {
                        fs.unlinkSync(finalMp4);
                    }
                    fs.renameSync(tempOutput, finalMp4);
                    callback(finalMp4);
                } catch (e) {
                    appendLog(`Rename error: ${e.message}`);
                    callback(tempOutput);
                }
            } else {
                appendLog(`Penyesuaian FFmpeg selesai dengan code ${code}.`);
                callback(filePath);
            }
        });

        ffProc.on('error', (err) => {
            appendLog(`FFmpeg error: ${err.message}`);
            callback(filePath);
        });
    }

    if (btnDownload) {
        btnDownload.addEventListener('click', function () {
            if (isDownloading) return;

            const url = ytUrlInput ? ytUrlInput.value.trim() : "";
            if (!url) {
                showDlToast("Harap masukkan link media terlebih dahulu!", "error");
                if (ytUrlInput) ytUrlInput.focus();
                return;
            }

            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                showDlToast("URL tidak valid. Masukkan link yang lengkap (https://...).", "error");
                return;
            }

            const proceedWithDownload = () => {
                const binName = (binNameInput && binNameInput.value.trim()) ? binNameInput.value.trim() : "YT Downloads";
                const formatChoice = formatSelect ? formatSelect.value : 'best_video';
                const useSegment = Boolean(checkSegment && checkSegment.checked);
                if (useSegment) {
                    updateTimecodeValues();
                    const startSec = getTimecodeSeconds('start');
                    const endSec = getTimecodeSeconds('end');
                    if (endSec <= startSec) {
                        showDlToast("Waktu Selesai (End) harus lebih besar dari waktu Mulai (Start)!", "error");
                        return;
                    }
                }
                const startVal = cleanTimestamp(startTimeInput ? startTimeInput.value : "");
                const endVal = cleanTimestamp(endTimeInput ? endTimeInput.value : "");

                if (!cp || !cp.spawn) {
                    showDlToast(`Node.js runtime belum aktif. Muat ulang panel di ${getHostAppLabel()}.`, "error");
                    return;
                }

                startDownload({ url, formatChoice, useSegment, startVal, endVal, binName });
            };

            // Re-verify project save path automatically so saving with Cmd+S works immediately
            checkProjectStatus((valid) => {
                if (!valid || !isProjectValid || !currentTargetFolder) {
                    showDlToast(`Project belum disimpan. Silakan simpan (Cmd+S / Ctrl+S) project ${getHostAppLabel()} Anda!`, "error");
                    return;
                }
                proceedWithDownload();
            });
        });
    }

    function startDownload({ url, formatChoice, useSegment, startVal, endVal, binName }) {
        isDownloading = true;
        if (btnDownload) btnDownload.disabled = true;
        if (btnDownloadText) btnDownloadText.textContent = "Sedang Memproses...";
        if (progressCard) progressCard.style.display = 'block';
        if (progressBar) progressBar.style.width = '0%';
        if (progressPercent) progressPercent.textContent = '0%';
        if (progressPhase) progressPhase.textContent = 'Menghubungkan ke server media...';
        if (progressSpeed) progressSpeed.textContent = '';
        if (progressEta) progressEta.textContent = 'ETA: Menghitung...';

        const { ytDlpPath, ffmpegPath, ffprobePath } = resolveDownloaderBinaries();
        appendLog(`Menggunakan yt-dlp: ${ytDlpPath}`);
        appendLog(`Target folder: ${currentTargetFolder}`);

        const isAudioOnly = (formatChoice === 'mp3' || formatChoice === 'wav');
        const outputTemplate = isAudioOnly
            ? path.join(currentTargetFolder, '%(title)s [%(id)s].%(ext)s')
            : path.join(currentTargetFolder, '%(title)s [%(id)s] [%(height)sp].%(ext)s');

        const isYouTubeUrl = /youtube\.com|youtu\.be/i.test(url);
        const args = [
            '--no-playlist',
            '--no-quiet',
            '--progress',
            '--newline',
            '--force-overwrites',
            '--print', 'after_move:filepath',
            '--ffmpeg-location', ffmpegPath
        ];

        if (isYouTubeUrl) {
            args.push('--extractor-args', 'youtube:player_client=default,-tv_samsung');
        } else {
            args.push('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        }

        args.push('-o', outputTemplate, url);

        if (checkCookies && checkCookies.checked) {
            args.splice(1, 0, '--cookies-from-browser', getBrowserCookieSource());
        }

        if (formatChoice === 'best_video') {
            args.splice(
                1,
                0,
                '-f', 'bestvideo+bestaudio/best',
                '-S', 'res,vcodec:h264,vcodec:vp9,acodec:m4a',
                '--merge-output-format', 'mp4'
            );
            appendLog('Target resolusi: Kualitas Terbaik (Resolusi Tertinggi 4K/2K/1080p)');
        } else if (formatChoice === 'mp3') {
            args.splice(1, 0, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
        } else if (formatChoice === 'wav') {
            args.splice(1, 0, '-x', '--audio-format', 'wav');
        } else if (!isNaN(Number(formatChoice))) {
            const h = Number(formatChoice);
            args.splice(
                1,
                0,
                '-f', `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
                '-S', `res:${h},vcodec:h264,vcodec:vp9,acodec:m4a`,
                '--merge-output-format', 'mp4'
            );
            appendLog(`Target resolusi: ${h}p (Prioritas: Resolusi ${h}p -> H.264 & AAC MP4)`);
        } else {
            args.splice(
                1,
                0,
                '-f', 'bestvideo+bestaudio/best',
                '-S', 'res,vcodec:h264,vcodec:vp9,acodec:m4a',
                '--merge-output-format', 'mp4'
            );
        }

        if (useSegment && startVal && endVal) {
            const sectionArg = `*${startVal}-${endVal}`;
            args.splice(1, 0, '--download-sections', sectionArg, '--force-keyframes-at-cuts');
            appendLog(`Mengaktifkan potongan durasi: ${sectionArg}`);
        }

        appendLog(`Menjalankan perintah: ${ytDlpPath} ${args.join(' ')}`);

        let downloadedFilePath = "";
        let highestDownloadMappedPct = 0;
        let downloadStreamIndex = 0;
        const expectedDurationSec = (useSegment && startVal && endVal)
            ? Math.max(1, getTimecodeSeconds('end') - getTimecodeSeconds('start'))
            : (currentVideoDurationSec > 0 ? currentVideoDurationSec : 0);

        const proc = cp.spawn(ytDlpPath, args, { env: getProcessEnv(), windowsHide: true });

        function setDownloadProgressUI(mappedPct, phaseText, speedText = null, etaText = null) {
            const safePct = Math.max(highestDownloadMappedPct, Math.min(69, Math.round(mappedPct)));
            highestDownloadMappedPct = safePct;
            if (progressBar) progressBar.style.width = `${safePct}%`;
            if (progressPercent) progressPercent.textContent = `${safePct}%`;
            if (phaseText && progressPhase) progressPhase.textContent = phaseText;
            if (speedText !== null && progressSpeed) progressSpeed.textContent = speedText;
            if (etaText !== null && progressEta) progressEta.textContent = etaText;
        }

        function handleChunkText(text) {
            const lines = text.split(/[\r\n]+/);

            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('[download]') || trimmed.startsWith('[Merger]') || trimmed.startsWith('[info]')) {
                    appendLog(trimmed);
                }

                // Stage 1: Initial connection & metadata extraction feedback (0% -> 7%)
                if (highestDownloadMappedPct < 8) {
                    if (trimmed.includes('Extracting URL') || trimmed.includes('Downloading webpage')) {
                        setDownloadProgressUI(3, 'Menghubungkan ke server YouTube...');
                    } else if (trimmed.includes('player API JSON') || trimmed.includes('m3u8 information')) {
                        setDownloadProgressUI(5, 'Mengambil informasi stream resolusi tinggi...');
                    } else if (trimmed.includes('Downloading 1 format') || trimmed.includes('Downloading m3u8 manifest')) {
                        setDownloadProgressUI(7, 'Memulai pengunduhan stream media...');
                    }
                }

                // Track when yt-dlp switches from Video stream (Stream 1) to Audio stream (Stream 2)
                if (trimmed.startsWith('[download] Destination:')) {
                    downloadStreamIndex++;
                }

                // Stage 2A: Standard yt-dlp [download] X.X% progress lines
                if (trimmed.startsWith('[download]') && trimmed.includes('%')) {
                    // Ignore tiny HLS initialization header fragment (frag 0/N) that prints 100.0% before frag 1/N starts
                    if (/\(frag\s+0\//i.test(trimmed)) {
                        continue;
                    }

                    const percentMatch = trimmed.match(/(\d+(?:\.\d+)?)%/);
                    if (percentMatch) {
                        const rawPct = parseFloat(percentMatch[1]);
                        // Video track is ~88% of download time (mapped 8% -> 62%), Audio track is ~12% (mapped 62% -> 68%)
                        let mappedPct;
                        if (isAudioOnly) {
                            mappedPct = 8 + Math.round((rawPct / 100) * 60);
                        } else if (downloadStreamIndex <= 1) {
                            mappedPct = 8 + Math.round((rawPct / 100) * 54);
                        } else {
                            mappedPct = 62 + Math.round((rawPct / 100) * 6);
                        }

                        const fragMatch = trimmed.match(/\(frag\s+(\d+\/\d+)\)/i);
                        const fragLabel = fragMatch ? ` • Frag ${fragMatch[1]}` : '';
                        const streamLabel = (!isAudioOnly && downloadStreamIndex > 1) ? 'Audio' : 'Video';
                        const phaseLabel = useSegment
                            ? `Mengunduh segmen ${streamLabel} (${rawPct.toFixed(0)}%${fragLabel})...`
                            : `Mengunduh ${streamLabel} (${rawPct.toFixed(0)}%${fragLabel})...`;

                        setDownloadProgressUI(mappedPct, phaseLabel);
                    }

                    const speedMatch = trimmed.match(/at\s+([0-9.]+\s*[a-zA-Z\/]+)/);
                    if (speedMatch && !speedMatch[1].includes('Unknown') && progressSpeed) {
                        progressSpeed.textContent = speedMatch[1];
                    }

                    const etaMatch = trimmed.match(/ETA\s+([0-9:]+)/);
                    if (etaMatch && progressEta) {
                        progressEta.textContent = `ETA: ${etaMatch[1]}`;
                    }
                } else if (trimmed.includes('time=') && expectedDurationSec > 0) {
                    // Stage 2B: FFmpeg downloader progress (used when --download-sections / segment cutting is active)
                    const timeMatch = trimmed.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (timeMatch) {
                        const curSec = (+timeMatch[1]) * 3600 + (+timeMatch[2]) * 60 + (+timeMatch[3]);
                        const ratio = Math.min(1, curSec / expectedDurationSec);
                        const mappedPct = 8 + Math.round(ratio * 60);
                        setDownloadProgressUI(mappedPct, `Mengunduh segmen (${Math.round(ratio * 100)}%)...`);
                    }
                } else if (trimmed.includes('[Merger]') || trimmed.includes('[ExtractAudio]')) {
                    setDownloadProgressUI(69, 'Menggabungkan aliran video & audio...');
                } else if (trimmed.startsWith('/') || trimmed.match(/^[A-Za-z]:\\/)) {
                    downloadedFilePath = trimmed;
                }
            }
        }

        proc.stdout.on('data', (data) => {
            handleChunkText(data.toString());
        });

        proc.stderr.on('data', (data) => {
            handleChunkText(data.toString());
        });

        proc.on('close', (code) => {
            if (code === 0) {
                if (progressBar) progressBar.style.width = '70%';
                if (progressPercent) progressPercent.textContent = '70%';
                if (progressPhase) progressPhase.textContent = `Memverifikasi kompatibilitas codec ${getHostAppLabel()}...`;

                if (!downloadedFilePath || (fs && fs.existsSync && !fs.existsSync(downloadedFilePath))) {
                    downloadedFilePath = getLatestFileInFolder(currentTargetFolder);
                }

                if (downloadedFilePath) {
                    appendLog(`Download selesai: ${downloadedFilePath}`);

                    ensurePremiereCompatibility(downloadedFilePath, ffmpegPath, ffprobePath, (finalPath) => {
                        if (progressBar) progressBar.style.width = '98%';
                        if (progressPercent) progressPercent.textContent = '98%';
                        if (progressPhase) progressPhase.textContent = `Memasukkan ke Bin ${getHostAppLabel()}...`;
                        if (progressSpeed) progressSpeed.textContent = '';
                        if (progressEta) progressEta.textContent = 'Selesai';
                        appendLog(`File final siap dimasukkan: ${finalPath}`);
                        importToPremiereBin(finalPath, binName);
                    });
                } else {
                    isDownloading = false;
                    if (btnDownload) btnDownload.disabled = false;
                    if (btnDownloadText) btnDownloadText.textContent = "Download & Masukkan ke Bin";
                    showDlToast("Download selesai, namun path file tidak terdeteksi.", "error");
                }
            } else {
                isDownloading = false;
                if (btnDownload) btnDownload.disabled = false;
                if (btnDownloadText) btnDownloadText.textContent = "Download & Masukkan ke Bin";
                if (progressCard) progressCard.style.display = 'none';
                showDlToast(`Gagal mendownload media (Exit code: ${code}). Cek log terminal.`, "error");
            }
        });

        proc.on('error', (err) => {
            isDownloading = false;
            if (btnDownload) btnDownload.disabled = false;
            if (btnDownloadText) btnDownloadText.textContent = "Download & Masukkan ke Bin";
            if (progressCard) progressCard.style.display = 'none';
            appendLog(`Process error: ${err.message}`);
            showDlToast(`Gagal menjalankan downloader: ${err.message}`, "error");
        });
    }

    function getLatestFileInFolder(dir) {
        if (!fs || !fs.readdirSync) return "";
        try {
            const files = fs.readdirSync(dir);
            let latestFile = "";
            let latestMtime = 0;

            for (const file of files) {
                if (file.startsWith('.')) continue;
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isFile() && stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestFile = fullPath;
                }
            }
            return latestFile;
        } catch (e) {
            appendLog(`Error finding latest file: ${e.message}`);
            return "";
        }
    }

    function importToPremiereBin(filePath, binName) {
        const scriptCall = `importFileToBin(${JSON.stringify(filePath)}, ${JSON.stringify(binName)})`;
        appendLog(`Memanggil ExtendScript: ${scriptCall}`);

        csInterface.evalScript(HOST_EXTENDSCRIPT_CODE + '\n' + scriptCall, function (result) {
            isDownloading = false;
            if (btnDownload) btnDownload.disabled = false;
            if (btnDownloadText) btnDownloadText.textContent = "Download & Masukkan ke Bin";

            appendLog(`Hasil ExtendScript: ${result}`);
            const hostLabel = getHostAppLabel();
            try {
                const res = JSON.parse(result);
                if (res.success) {
                    if (progressBar) progressBar.style.width = '100%';
                    if (progressPercent) progressPercent.textContent = '100%';
                    if (progressPhase) progressPhase.textContent = `Selesai dimasukkan ke Bin ${hostLabel}: "${binName}"!`;
                    showDlToast(`Berhasil! Media masuk ke Bin "${binName}" di ${hostLabel}.`, "success", 7000);
                } else {
                    showDlToast(`Gagal import ke ${hostLabel}: ${res.error || 'Unknown error'}`, "error");
                }
            } catch (e) {
                showDlToast(`Download berhasil! Silakan cek Bin di ${hostLabel}.`, "success");
            }

            setTimeout(() => {
                if (!isDownloading && progressCard) {
                    progressCard.style.display = 'none';
                }
            }, 4000);
        });
    }

    // ==========================================
    // INITIALIZATION
    // ==========================================
    window.addEventListener('DOMContentLoaded', () => {
        // Initial search for premiere pro tutorials
        searchYouTube("premiere pro tutorial");

        // Initialize Downloader status & timecodes
        checkProjectStatus();
        updateTimecodeValues();

        // Clipboard polling
        checkClipboard();
        setInterval(checkClipboard, 2500);

        window.addEventListener('focus', () => {
            checkProjectStatus();
            checkClipboard();
        });
    });

})();
