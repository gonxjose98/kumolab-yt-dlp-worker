// kumolab-yt-dlp-worker
//
// Runs on Render's free-tier infra. Single endpoint: POST /download with a
// YouTube URL → spawns yt-dlp, streams the muxed MP4 bytes back. Lives
// outside Vercel because YouTube blocks AWS Lambda IPs (the entire range
// Vercel runs on) with a "sign in to confirm you're not a bot" wall.
// Render's IPs aren't on that blocklist.

const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '1mb' }));

const SHARED_SECRET = process.env.SHARED_SECRET || '';
const MAX_DURATION_SECONDS = 180;

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
    res.status(200).json({ ok: true, ytdlp: !!process.env.PATH });
});

// Quick metadata probe. Used by callers to decide whether to fetch the
// full bytes (e.g. duration check before downloading 80 MB).
app.post('/info', authed, (req, res) => {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required' });
    }

    const args = [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
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
    const args = [
        '-f', 'best[ext=mp4][height<=720]/18/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best',
        '--merge-output-format', 'mp4',
        '--no-warnings',
        '--no-playlist',
        '--match-filter', `duration <= ${MAX_DURATION_SECONDS}`,
        '-o', '-',
        url,
    ];
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let headersSent = false;
    let stderrTail = '';

    proc.stderr.on('data', c => {
        stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    proc.stdout.once('data', () => {
        if (!headersSent) {
            res.set('Content-Type', 'video/mp4');
            res.set('Cache-Control', 'no-store');
            headersSent = true;
        }
    });
    proc.stdout.pipe(res);

    const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 90_000);

    proc.on('close', code => {
        clearTimeout(killTimer);
        if (code !== 0 && !headersSent) {
            res.status(502).json({ error: 'yt-dlp download failed', code, stderr: stderrTail.slice(-500) });
        }
    });
    req.on('close', () => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[yt-dlp-worker] listening on :${PORT}`);
});
