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
        '-f', '18/best[ext=mp4][acodec!=none]',
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
            });
        } catch (e) {
            return res.status(502).json({ error: 'yt-dlp returned non-JSON', stderr: stderr.slice(-500) });
        }
    });
});

// Stream the muxed MP4 back. Caller must check duration via /info first
// or be ready to abort if the stream gets too large.
app.post('/download', authed, (req, res) => {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required' });
    }

    // Format selector: prefer combined MP4 ≤720p (itag 18 is the canonical
    // 360p combined). Fall back to bestvideo+bestaudio merge — yt-dlp does
    // the merge internally and emits a single mp4 to stdout.
    const proxy = pickProxy();
    // Render's free tier has 512 MB RAM. Asking yt-dlp to download
    // separate video+audio streams and merge them via ffmpeg blew the
    // OOM ceiling (process got SIGKILLed at <1s with no stderr). Stick
    // to *already-muxed* combined formats (itag 18 = 360p mp4 with
    // audio, the legacy combined format YouTube still serves) so no
    // ffmpeg merge step runs in the worker.
    const args = [
        '-f', '18/best[protocol*=http][ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4][acodec!=none]',
        '--no-warnings',
        '--no-playlist',
        ...(proxy ? ['--proxy', proxy] : []),
        '-o', '-',
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let headersSent = false;
    let stderrTail = '';
    let bytesStreamed = 0;

    proc.stderr.on('data', c => {
        stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    proc.stdout.on('data', chunk => {
        bytesStreamed += chunk.length;
        if (!headersSent) {
            res.set('Content-Type', 'video/mp4');
            res.set('Cache-Control', 'no-store');
            headersSent = true;
        }
        res.write(chunk);
    });

    const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 90_000);

    proc.on('error', e => {
        if (res.writableEnded || res.headersSent) return;
        res.status(502).json({ error: `spawn failed: ${e.message}`, proxyUsed: proxy });
    });

    proc.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (res.writableEnded || res.headersSent || headersSent) {
            try { res.end(); } catch { /* noop */ }
            return;
        }
        res.status(502).json({
            error: 'yt-dlp download produced 0 bytes',
            code,
            signal,
            stderr: stderrTail.slice(-800),
            proxyUsed: proxy ? proxy.split('@').pop() : 'none',
        });
    });
    req.on('close', () => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[yt-dlp-worker] listening on :${PORT}`);
});
