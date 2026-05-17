# ── Stage 1: Node.js dependencies ────────────────────────────────────────
# Installs npm production deps in an isolated stage so the final image
# doesn't need npm/build tools at runtime.
FROM node:22-alpine AS node-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Final image ───────────────────────────────────────────────────────────
# node:22-alpine (Alpine 3.21) is the base.  We layer Python 3.12 on top
# via apk — no separate Python base image needed.
FROM node:22-alpine

# ── System packages ───────────────────────────────────────────────────────
# python3      — Python 3.12 runtime
# py3-pip      — pip for the system Python (no ensurepip needed)
# ffmpeg       — required by yt-dlp for audio post-processing
#
# numpy is intentionally NOT installed via apk here; it is installed by pip
# below so the version matches requirements.txt exactly and there is no
# conflict between the apk-managed and pip-managed copies.
RUN apk add --no-cache \
      python3 \
      py3-pip \
      ffmpeg

# ── Python dependencies ───────────────────────────────────────────────────
# --break-system-packages is required on Alpine because pip refuses to
# install into the system Python without it (PEP 668).
# Versions are pinned to match YouTube Music/requirements.txt exactly.
RUN pip3 install --no-cache-dir --break-system-packages \
      fastapi==0.118.0 \
      uvicorn==0.37.0 \
      requests==2.32.5 \
      numpy==2.3.3 \
      yt-dlp==2026.3.3

WORKDIR /app

# ── Node production modules (from build stage) ────────────────────────────
COPY --from=node-deps /app/node_modules ./node_modules

# ── Application source ────────────────────────────────────────────────────
COPY . .

# ── Runtime data directories + permissions ───────────────────────────────
# Pre-create all writable dirs and chown the entire /app tree to the `node`
# user (UID 1000) — HuggingFace Spaces runs containers as UID 1000 and will
# fail with EPERM if the working directory is owned by root.
#
# Directories:
#   /app/data                    — JioSaavn tally + catalog
#   /app/YouTube Music/data      — YouTube Music tally + catalog
#   /app/YouTube Music/song_cache — audio cache (ephemeral by default;
#                                   set OPENMUSIC_CACHE_DIR to a persistent
#                                   volume path to survive restarts)
RUN mkdir -p \
      /app/data \
      "/app/YouTube Music/data" \
      "/app/YouTube Music/song_cache" \
    && chmod +x /app/start.sh \
    && chown -R node:node /app

# ── Non-root user ─────────────────────────────────────────────────────────
# node:22-alpine ships a built-in `node` user at UID/GID 1000, which matches
# the UID HuggingFace Spaces uses at runtime.
USER node

# ── Ports & environment ───────────────────────────────────────────────────
# 7860 — the only port HuggingFace Spaces exposes publicly (set in README)
# 8000 — internal Python service; not reachable from outside the container
EXPOSE 7860

ENV PORT=7860 \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# ── Health check ──────────────────────────────────────────────────────────
# Probes the Node/Express service on the public port.
# start-period=45s gives both services time to fully initialise before
# the first check (yt-dlp import is slow on first run).
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget -qO- http://localhost:7860/health || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────
CMD ["/bin/sh", "/app/start.sh"]
