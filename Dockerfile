# Dockerfile — Media Control (derived from Screen Tinker, MIT)
# Build context = repo root. Two-stage: compile native deps (better-sqlite3,
# sharp/libvips) then a slim runtime with ffmpeg/yt-dlp/poppler for media.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++ vips-dev pkgconfig
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN apk add --no-cache ffmpeg tini vips yt-dlp poppler-utils
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
# Cache-bust: pass --build-arg CACHEBUST=$(git rev-parse HEAD) on every deploy so
# the app-code COPY layers always refresh on a new commit. (BuildKit's COPY cache
# was over-aggressively reused, freezing deployed code at the first build.)
ARG CACHEBUST=dev
RUN echo "cachebust=$CACHEBUST"
COPY server ./server
COPY frontend ./frontend
COPY scripts ./scripts
COPY VERSION ./VERSION
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
ENTRYPOINT ["/sbin/tini","--"]
WORKDIR /app/server
CMD ["node","server.js"]
