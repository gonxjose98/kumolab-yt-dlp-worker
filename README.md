# kumolab-yt-dlp-worker

Tiny HTTP service that runs `yt-dlp` on demand for [KumoLab](https://kumolabanime.com).

**Why it exists.** YouTube blocks AWS Lambda IPs (Vercel's runtime) with a "sign in to confirm you're not a bot" wall, so trailer downloads fail from the main app. This worker runs on Render's clean IP range, gets the bytes for us, and streams them back over HTTPS.

## API

All authenticated endpoints require `Authorization: Bearer ${SHARED_SECRET}`.

- `GET /healthz` — liveness probe, public
- `POST /info` — returns `{ title, duration, videoId, channel }` for a YouTube URL
- `POST /download` — streams the muxed MP4 (≤720p, ≤180s) back to the caller

## Deploy

Render free tier:
- Web Service, Docker runtime
- Public repo source: this one
- Env: `SHARED_SECRET=<random 32+ char string>`
- Health check path: `/healthz`

## Local dev

```bash
npm install
SHARED_SECRET=dev npm start
```
