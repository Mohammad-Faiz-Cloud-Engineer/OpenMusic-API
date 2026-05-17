# ── Stage 1: Node.js dependencies ────────────────────────────────────────
# Use a named build stage so the final image only carries production assets.
FROM node:22-alpine AS node-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Final image ───────────────────────────────────────────────────────────
# node:22-alpine is the base; we layer Python on top via apk.
# Alpine's python3 + pip are sufficient — no full CPython build needed.
FROM node:22-alpine

# Install Python 3 + pip + build tools required by some pip packages.
# --no-cache keeps the layer small; versions are pinned by Alpine's package
# manager for the chosen Alpine release (not floating).
RUN apk add --no-cache \
      python3 \
      py3-pip \
      py3-numpy \
      ffmpeg \
    && python3 -m ensurepip --upgrade \
    && pip3 install --no-cache-dir --break-system-packages \
         fastapi==0.118.0 \
         uvicorn==0.37.0 \
         requests==2.32.5 \
         yt-dlp==2026.3.3

WORKDIR /app

# ── Node production modules (from build stage) ────────────────────────────
COPY --from=node-deps /app/node_modules ./node_modules

# ── Application source ────────────────────────────────────────────────────
COPY . .

# ── Runtime data directories ──────────────────────────────────────────────
# Pre-create writable data dirs so the app never has to mkdir at request time.
# /app/data          — JioSaavn tally + catalog
# /app/YouTube Music/data — YouTube Music tally + catalog
# /app/YouTube Music/song_cache — audio cache (ephemeral; mount a volume here
#                                 via OPENMUSIC_CACHE_DIR for persistence)
RUN mkdir -p \
      /app/data \
      "/app/YouTube Music/data" \
      "/app/YouTube Music/song_cache" \
    && chmod +x /app/start.sh

# ── Non-root user ─────────────────────────────────────────────────────────
# node:22-alpine ships a 'node' user (uid 1000).  We chown the writable dirs
# so the process can write tally/catalog files without running as root.
RUN chown -R node:node \
      /app/data \
      "/app/YouTube Music/data" \
      "/app/YouTube Music/song_cache"

USER node

# ── Ports & env ───────────────────────────────────────────────────────────
# 7860 — public port required by HuggingFace Spaces
# 8000 — internal Python service (not exposed externally)
EXPOSE 7860

ENV PORT=7860 \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

# ── Health check ──────────────────────────────────────────────────────────
# Checks the Node service (public port).  Python health is implicitly covered
# because Node proxies recommendation calls to Python.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:7860/health || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────
CMD ["/bin/sh", "/app/start.sh"]
