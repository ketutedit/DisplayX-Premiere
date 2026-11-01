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

    // Local HTTP Player Service (Reverse-Proxy for YouTube Embed with Valid Referer)
    const PLAYER_PORT = 48292;
    let playerServer = null;

    function startLocalPlayerServer() {
        if (playerServer || !http) return;
        try {
            playerServer = http.createServer((req, res) => {
                let parsed;
                try {
                    parsed = new URL(req.url, `http://127.0.0.1:${PLAYER_PORT}`);
                } catch (e) {
                    res.writeHead(400);
                    return res.end();
                }

                if (parsed.pathname === '/player') {
                    const vidId = parsed.searchParams.get('v') || '';
                    const isLoop = parsed.searchParams.get('loop') === '1';
                    const loopParam = isLoop ? `&loop=1&playlist=${vidId}` : '';

                    if (!vidId) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        return res.end('Missing video id');
                    }

                    // Direct reverse proxy from YouTube embed with valid Google Referer (Bypasses Error 153)
                    const ytOpts = {
                        hostname: 'www.youtube.com',
                        path: `/embed/${vidId}?autoplay=1&playsinline=1&rel=0${loopParam}`,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                            'Referer': 'https://www.google.com/',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        }
                    };

                    const proxyReq = https.get(ytOpts, (ytRes) => {
                        let chunks = [];
                        ytRes.on('data', c => chunks.push(c));
                        ytRes.on('end', () => {
                            let html = Buffer.concat(chunks).toString('utf-8');
                            // Inject base href tag so all relative assets & scripts resolve to youtube.com
                            if (html.includes('<head>')) {
                                html = html.replace('<head>', '<head><base href="https://www.youtube.com/">');
                            } else if (html.includes('<head ')) {
                                html = html.replace(/<head[^>]*>/, '$&<base href="https://www.youtube.com/">');
                            }

                            res.writeHead(200, {
                                'Content-Type': 'text/html; charset=utf-8',
                                'Access-Control-Allow-Origin': '*',
                                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                                'Referrer-Policy': 'origin'
                            });
                            res.end(html);
                        });
                    });

                    proxyReq.on('error', (err) => {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('DisplayX Proxy Connection Error: ' + err.message);
                    });
                    return;
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
    const playerFrame = document.getElementById('playerFrame');
    const nativePlayer = document.getElementById('nativePlayer');
    const playerLoading = document.getElementById('playerLoading');
    const playerLoadingText = document.getElementById('playerLoadingText');
    const playerPlaceholder = document.getElementById('playerPlaceholder');

    const nowPlayingBar = document.getElementById('nowPlayingBar');
    const nowPlayingTitle = document.getElementById('nowPlayingTitle');
    const nowPlayingChannel = document.getElementById('nowPlayingChannel');
    const nowPlayingDuration = document.getElementById('nowPlayingDuration');
    const btnTogglePlayerMode = document.getElementById('btnTogglePlayerMode');
    const btnBookmark = document.getElementById('btnBookmark');
    const bookmarkIcon = document.getElementById('bookmarkIcon');
    const btnCopyLink = document.getElementById('btnCopyLink');
    const btnOpenNowPlaying = document.getElementById('btnOpenNowPlaying');

    const searchInput = document.getElementById('searchInput');
    const btnSearch = document.getElementById('btnSearch');
    const btnClearSearch = document.getElementById('btnClearSearch');
    const suggestionsList = document.getElementById('suggestionsList');

    const categoryPills = document.querySelectorAll('.dx-pill');
    const sectionTitle = document.getElementById('sectionTitle');
    const videoGrid = document.getElementById('videoGrid');
    const btnViewGrid = document.getElementById('btnViewGrid');
    const btnViewList = document.getElementById('btnViewList');

    const btnToggleLoop = document.getElementById('btnToggleLoop');
    const btnToggleTheater = document.getElementById('btnToggleTheater');
    const btnExternalBrowser = document.getElementById('btnExternalBrowser');

    const clipboardBanner = document.getElementById('clipboardBanner');
    const clipboardText = document.getElementById('clipboardText');
    const btnPlayClipboard = document.getElementById('btnPlayClipboard');
    const btnCloseClipboard = document.getElementById('btnCloseClipboard');

    const toastMessage = document.getElementById('toastMessage');

    // State
    let currentVideo = null; // { id, title, channel, duration }
    let playerMode = 'direct'; // 'direct' (HTML5 Video Stream via googlevideo) | 'embed' (YouTube Iframe Proxy)
    let isLooping = false;
    let isSearching = false;
    let lastDetectedClipboard = "";
    let searchDebounceTimer = null;

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

    function extractYouTubeId(url) {
        if (!url || typeof url !== 'string') return null;
        const clean = url.trim();

        // 11 characters ID
        if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) {
            return clean;
        }

        // Standard watch
        const watchMatch = clean.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (watchMatch) return watchMatch[1];

        // youtu.be
        const beMatch = clean.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        if (beMatch) return beMatch[1];

        // shorts
        const shortsMatch = clean.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) return shortsMatch[1];

        // embed
        const embedMatch = clean.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) return embedMatch[1];

        return null;
    }

    // ==========================================
    // STREAM EXTRACTOR & DUAL-MODE PLAYER CONTROLLER
    // ==========================================
    function getDirectStreamUrl(vidId, callback) {
        if (!cp || !cp.spawn) {
            return callback(new Error("child_process not available"));
        }

        const ytDlp = resolveYtDlp();
        const targetUrl = `https://www.youtube.com/watch?v=${vidId}`;
        const args = [
            '-g',
            '-f', '18/b[ext=mp4]/best',
            '--no-warnings',
            targetUrl
        ];

        let stdout = '';
        let stderr = '';
        const proc = cp.spawn(ytDlp, args, { env: getProcessEnv() });

        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', (code) => {
            const streamUrl = stdout.trim().split('\n')[0];
            if (code === 0 && streamUrl && streamUrl.startsWith('http')) {
                callback(null, streamUrl);
            } else {
                callback(new Error(stderr || `yt-dlp exit ${code}`));
            }
        });

        proc.on('error', (err) => callback(err));
    }

    function showPlayerLoading(text) {
        if (playerLoading) {
            if (playerLoadingText) playerLoadingText.textContent = text || 'Memuat Video...';
            playerLoading.style.display = 'flex';
        }
    }

    function hidePlayerLoading() {
        if (playerLoading) {
            playerLoading.style.display = 'none';
        }
    }

    function playVideo(id, title = "YouTube Video", channel = "", duration = "", requestedMode = null) {
        if (!id) return;

        currentVideo = { id, title, channel, duration };
        if (playerPlaceholder) playerPlaceholder.style.display = 'none';

        // Update Now Playing Bar
        if (nowPlayingBar) nowPlayingBar.style.display = 'flex';
        if (nowPlayingTitle) {
            nowPlayingTitle.textContent = title;
            nowPlayingTitle.title = title;
        }
        if (nowPlayingChannel) nowPlayingChannel.textContent = channel || 'YouTube Creator';
        if (nowPlayingDuration) nowPlayingDuration.textContent = duration ? `• ${duration}` : '';

        updateBookmarkButtonState();
        saveToHistory(currentVideo);
        highlightActiveCard(id);

        if (requestedMode) {
            playerMode = requestedMode;
        }

        if (playerMode === 'direct') {
            loadDirectStream(id, title);
        } else {
            loadEmbedStream(id);
        }
    }

    function loadDirectStream(id, title) {
        showPlayerLoading("Menyiapkan stream video MP4...");
        if (btnTogglePlayerMode) {
            btnTogglePlayerMode.innerHTML = '🎬 Mode: MP4';
            btnTogglePlayerMode.title = 'Sedang memutar stream direct MP4. Klik untuk ganti ke mode Embed YouTube.';
        }

        getDirectStreamUrl(id, (err, streamUrl) => {
            if (err || !streamUrl) {
                console.warn("Direct stream failed, falling back to Embed:", err ? err.message : "No stream");
                showToast("Stream direct tidak tersedia, beralih ke Embed...");
                loadEmbedStream(id);
                return;
            }

            hidePlayerLoading();
            if (playerFrame) {
                playerFrame.style.display = 'none';
                playerFrame.src = 'about:blank';
            }
            if (nativePlayer) {
                nativePlayer.style.display = 'block';
                nativePlayer.src = streamUrl;
                nativePlayer.loop = isLooping;
                nativePlayer.play().catch(e => {
                    console.log("Autoplay notice:", e);
                });
            }
            showToast(`Memutar (MP4): ${title.length > 25 ? title.substring(0, 25) + '...' : title}`);
        });
    }

    function loadEmbedStream(id) {
        hidePlayerLoading();
        if (nativePlayer) {
            try { nativePlayer.pause(); } catch(e) {}
            nativePlayer.src = '';
            nativePlayer.style.display = 'none';
        }

        if (btnTogglePlayerMode) {
            btnTogglePlayerMode.innerHTML = '📺 Mode: Embed';
            btnTogglePlayerMode.title = 'Sedang memutar mode Embed YouTube. Klik untuk ganti ke direct MP4.';
        }

        if (playerFrame) {
            playerFrame.style.display = 'block';
            let targetUrl = "";
            if (http) {
                targetUrl = `http://127.0.0.1:${PLAYER_PORT}/player?v=${id}${isLooping ? '&loop=1' : ''}`;
            } else {
                targetUrl = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0${isLooping ? '&loop=1&playlist=' + id : ''}`;
            }
            playerFrame.src = targetUrl;
        }

        showToast(`Memutar (Embed): ${currentVideo ? (currentVideo.title.length > 25 ? currentVideo.title.substring(0, 25) + '...' : currentVideo.title) : 'Video'}`);
    }

    function togglePlayerMode() {
        if (!currentVideo || !currentVideo.id) {
            playerMode = (playerMode === 'direct') ? 'embed' : 'direct';
            if (btnTogglePlayerMode) {
                btnTogglePlayerMode.innerHTML = playerMode === 'direct' ? '🎬 Mode: MP4' : '📺 Mode: Embed';
            }
            showToast(`Mode pemutar diubah ke: ${playerMode === 'direct' ? 'Direct MP4' : 'YouTube Embed'}`);
            return;
        }

        if (playerMode === 'direct') {
            playerMode = 'embed';
            loadEmbedStream(currentVideo.id);
        } else {
            playerMode = 'direct';
            loadDirectStream(currentVideo.id, currentVideo.title);
        }
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

    // Engine 2: Local yt-dlp Process Search (Fallback with getProcessEnv)
    function searchYouTubeYtDlp(query, callback) {
        if (!cp || !cp.spawn) {
            return callback(new Error("child_process not available"));
        }

        const ytDlp = resolveYtDlp();
        const args = [
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

        // Try Fast Direct Engine first
        searchYouTubeDirect(clean, (err, items) => {
            if (!err && items && items.length > 0) {
                isSearching = false;
                renderVideoCards(items);
                return;
            }

            // Fallback to yt-dlp engine with full environment
            console.log("Direct search fallback to yt-dlp:", err ? err.message : "No items");
            searchYouTubeYtDlp(clean, (err2, items2) => {
                isSearching = false;
                if (!err2 && items2 && items2.length > 0) {
                    renderVideoCards(items2);
                    return;
                }

                // If both engines failed, display clean error
                videoGrid.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-muted);">
                        Gagal memuat hasil pencarian atau koneksi terputus.<br>
                        <small style="color: var(--text-sub);">${err2 ? err2.message : (err ? err.message : '')}</small>
                    </div>
                `;
            });
        });
    }

    function renderVideoCards(items) {
        videoGrid.innerHTML = items.map(item => {
            const isPlaying = currentVideo && currentVideo.id === item.id;
            const thumbUrl = `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`;
            const viewsText = formatViewCount(item.views);

            return `
                <div class="dx-card ${isPlaying ? 'playing' : ''}" data-id="${item.id}" 
                     onclick="window.DisplayX.play('${item.id}', '${escapeHtml(item.title)}', '${escapeHtml(item.channel)}', '${escapeHtml(item.duration)}')">
                    <div class="dx-thumb-wrap">
                        <img src="${thumbUrl}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/${item.id}/default.jpg'">
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

        // If in embed mode, reload embed with loop param
        if (playerMode === 'embed' && currentVideo && currentVideo.id) {
            loadEmbedStream(currentVideo.id);
        }
    });

    // Toggle Player Mode (MP4 Direct vs Embed)
    if (btnTogglePlayerMode) {
        btnTogglePlayerMode.addEventListener('click', () => {
            togglePlayerMode();
        });
    }

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
