FROM node:20-alpine

# yt-dlp + ffmpeg + ca-certificates for HTTPS to YouTube.
# yt-dlp is shipped in Alpine's main repo and gets updated regularly.
RUN apk add --no-cache yt-dlp ffmpeg ca-certificates

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
