// kumolab-yt-dlp-worker
//
// Runs on Render's free-tier infra. Single endpoint: POST /download with a
// YouTube URL → spawns yt-dlp, streams the muxed MP4 bytes back. Lives
// outside Vercel because YouTube blocks AWS Lambda IPs (the entire range
// Vercel runs on) with a "sign in to confirm you're not a bot" wall.
//
// YouTube *also* started blocking Render's data-center IPs, so we route
// every yt-dlp invocation through a Webshare proxy. Each request picks a
// random proxy from the PROXIES env list. PROXIES format is a
// comma-separated list of `user:pass@host:port` (or `host:port` if the
// proxy doesn't need auth, but Webshare always does).

const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '1mb' }));

const SHARED_SECRET = process.env.SHARED_SECRET || '';
const MAX_DURATION_SECONDS = 180;

// 720p H.264 muxed-mp4 ceiling. Prefers single-file muxed sources to avoid
// the ffmpeg merge step. Caps at 720p because IG/TikTok/Threads re-encode
// aggressively to ~3 Mbps regardless of source — anything above 720p is
// bandwidth thrown away. Predictable ~25–35 MB per 60s trailer through
// the Webshare proxy. Override via FORMAT env var if needed.
const YT_FORMAT_SELECTOR = process.env.FORMAT
    || 'best[height<=720][ext=mp4][acodec!=none]/best[height<=720][ext=mp4]/best[height<=720]';

// X/Twitter and Instagram don't tag formats by height the way YouTube does
// — X streams are named by bitrate (http-2048k, http-832k, …) and IG Reels
// expose a small handful of bitrate variants too. The YouTube height filter
// excludes every format on these platforms and yt-dlp errors out with
// "Requested format is not available." Use a permissive selector that just
// asks for the best available mp4. Bandwidth impact is minimal: X tops out
// around 720p natively, IG Reels typically 1080p at modest bitrates.
const SOCIAL_FORMAT_SELECTOR = 'best[ext=mp4]/best';

function isSocialHost(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return (
            host.includes('twitter.com') ||
            host.includes('x.com') ||
            host.includes('instagram.com')
        );
    } catch {
        return false;
    }
}

function formatForUrl(url) {
    return isSocialHost(url) ? SOCIAL_FORMAT_SELECTOR : YT_FORMAT_SELECTOR;
}

// The youtube:player_client extractor-args and Chrome user-agent are
// YouTube-specific bot-wall workarounds. Passing them on Twitter / IG
// requests is mostly harmless (yt-dlp scopes `youtube:` args to its
// YouTube extractor) but the user-agent override has been seen to trigger
// Cloudflare challenges on x.com. Only apply both to YouTube URLs.
function ytArgsForUrl(url) {
    if (isSocialHost(url)) return [];
    return ['--extractor-args', YT_EXTRACTOR_ARGS, '--user-agent', YT_USER_AGENT];
}

// YouTube bot-wall bypass.
//   - Use the `android` + `ios` mobile clients first, then fall back to web.
//     The mobile clients aren't gated by the "Sign in to confirm you're
//     not a bot" wall that hits Render-data-center IPs and even some
//     Webshare residential ranges.
//   - Real desktop User-Agent helps the web fallback when it's reached.
const YT_EXTRACTOR_ARGS = 'youtube:player_client=android,ios,web';
const YT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROXIES = (process.env.PROXIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

function pickProxy() {
    if (PROXIES.length === 0) return null;
    const raw = PROXIES[Math.floor(Math.random() * PROXIES.length)];
    return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
}

function authed(req, res, next) {
    if (!SHARED_SECRET) {
        return res.status(500).json({ error: 'SHARED_SECRET not configured on worker' });
    }
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
}

// Liveness probe — Render hits this to decide if the service is up.
app.get('/', (_req, res) => {
    res.status(200).send('kumolab-yt-dlp-worker ok');
});
app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, proxies: PROXIES.length });
});

// Diagnostic — actually run a download to /tmp with verbose, return stderr.
app.get('/diag-dl', (req, res) => {
    const proxy = pickProxy();
    const url = req.query.url || 'https://www.youtube.com/watch?v=yClYCc4kEp8';
    const args = [
        '-f', formatForUrl(url),
        '--no-warnings',
        '--no-playlist',
        '-v',
        ...((proxy) ? ['--proxy', proxy] : []),
        '-o', '/tmp/diag-test.%(ext)s',
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => (stdout += c.toString()));
    proc.stderr.on('data', c => (stderr += c.toString()));
    proc.on('error', e => res.status(500).json({ error: 'spawn', message: e.message }));
    proc.on('close', (code, signal) => {
        if (res.headersSent) return;
        res.status(200).json({
            code,
            signal,
            stdoutTail: stdout.slice(-800),
            stderrTail: stderr.slice(-3000),
            proxy: proxy ? proxy.split('@').pop() : 'none',
        });
    });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 60_000);
});

// Diagnostic — run yt-dlp with verbose flag and the configured proxy
// against a known-good URL. Returns whatever stdout + stderr yt-dlp emits.
app.get('/diag', (req, res) => {
    const proxy = pickProxy();
    const url = req.query.url || 'https://www.youtube.com/watch?v=yClYCc4kEp8';
    const useProxy = req.query.proxy !== '0';
    const args = [
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        ...((useProxy && proxy) ? ['--proxy', proxy] : []),
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => (stdout += c));
    proc.stderr.on('data', c => (stderr += c));
    proc.on('error', e => res.status(500).json({ error: 'spawn', message: e.message, args, proxy }));
    proc.on('close', (code, signal) => {
        if (res.headersSent) return;
        res.status(200).json({
            code,
            signal,
            stdoutBytes: stdout.length,
            stdoutHead: stdout.slice(0, 200),
            stderr: stderr.slice(-1500),
            proxy: proxy ? proxy.split('@').pop() : 'none',
            useProxy,
        });
    });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30_000);
});

// Quick metadata probe. Used by callers to decide whether to fetch the
// full bytes (e.g. duration check before downloading 80 MB).
app.post('/info', authed, (req, res) => {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required' });
    }

    const proxy = pickProxy();
    const args = [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        ...ytArgsForUrl(url),
        ...(proxy ? ['--proxy', proxy] : []),
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => (stdout += c));
    proc.stderr.on('data', c => (stderr += c));
    proc.on('close', code => {
        if (code !== 0) {
            return res.status(502).json({ error: 'yt-dlp info failed', code, stderr: stderr.slice(-500) });
        }
        try {
            const info = JSON.parse(stdout);
            return res.json({
                title: info.title,
                duration: info.duration,
                videoId: info.id,
                channel: info.channel,
                description: info.description || '',
                fulltitle: info.fulltitle || info.title || '',
            });
        } catch (e) {
            return res.status(502).json({ error: 'yt-dlp returned non-JSON', stderr: stderr.slice(-500) });
        }
    });
});

// Download → save to /tmp → stream the file back → cleanup.
//
// yt-dlp's `-o -` (stdout pipe) silently SIGKILLs within 150ms when
// downloading itag 18 mp4 over the proxy. Saving to a file works
// reliably (proven via /diag-dl: 8.7 MB in 5s through Webshare).
const fs = require('fs');
const crypto = require('crypto');

app.post('/download', authed, (req, res) => {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required' });
    }

    const proxy = pickProxy();
    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpPath = `/tmp/dl-${tmpId}.mp4`;
    const args = [
        '-f', formatForUrl(url),
        '--no-warnings',
        '--no-playlist',
        '--no-progress',
        ...ytArgsForUrl(url),
        ...(proxy ? ['--proxy', proxy] : []),
        '-o', tmpPath,
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', c => { stderrTail = (stderrTail + c.toString()).slice(-2000); });

    const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 90_000);

    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* noop */ } };

    proc.on('error', e => {
        clearTimeout(killTimer);
        cleanup();
        if (res.headersSent) return;
        res.status(502).json({ error: `spawn failed: ${e.message}` });
    });

    proc.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (code !== 0 || !fs.existsSync(tmpPath)) {
            cleanup();
            if (res.headersSent) return;
            return res.status(502).json({
                error: code !== 0 ? 'yt-dlp download failed' : 'yt-dlp produced no file',
                code,
                signal,
                stderr: stderrTail.slice(-800),
                proxyUsed: proxy ? proxy.split('@').pop() : 'none',
            });
        }
        const stat = fs.statSync(tmpPath);
        res.set('Content-Type', 'video/mp4');
        res.set('Content-Length', String(stat.size));
        res.set('Cache-Control', 'no-store');
        const stream = fs.createReadStream(tmpPath);
        stream.on('error', err => {
            cleanup();
            if (!res.headersSent) res.status(500).json({ error: 'read stream failed', message: err.message });
        });
        stream.on('end', cleanup);
        stream.pipe(res);
    });

    // No req.on('close') handler — Express was firing close immediately
    // after the body parser finished reading the JSON, which killed the
    // proc within milliseconds. The killTimer (90s ceiling) and the
    // proc.on('close') cleanup are enough.
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[yt-dlp-worker] listening on :${PORT}`);
});
