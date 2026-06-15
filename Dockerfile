# Dockerfile — Media Control (derived from Screen Tinker, MIT)
# Build context = repo root. Two-stage: compile native deps (better-sqlite3,
# sharp/libvips) then a slim runtime with ffmpeg/yt-dlp/poppler for media.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++ vips-dev pkgconfig
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
# poppler-utils: PDF page-1 -> image (pdftoppm) for PDF thumbnails.
# libreoffice + fonts: headless office->PDF so PowerPoint/Word/Excel/ODF uploads
#   (incl. exports with no embedded preview, e.g. Gamma) get a real slide/page
#   thumbnail. Verified: soffice converts a real PPTX -> PDF in ~6s on this base.
# chromium + nss/freetype/harfbuzz/fonts: headless screenshots of third-party
#   websites (Website broadcasting) so sites that block framing still render on
#   walls + in multiview frames. Verified: screenshots google.com in ~2s.
# libheif-tools + libde265: decode iPhone HEIC/HEIF (HEVC-coded) stills -> JPEG
#   (sharp's bundled libheif only does AVIF). One cached layer (before CACHEBUST)
#   so code deploys don't re-pull these.
RUN apk add --no-cache ffmpeg tini vips yt-dlp poppler-utils \
    libreoffice ttf-dejavu fontconfig \
    chromium nss freetype harfbuzz ttf-freefont font-noto \
    libheif-tools libde265
ENV CHROMIUM_BIN=/usr/bin/chromium-browser
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
