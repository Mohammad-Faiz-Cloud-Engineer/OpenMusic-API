#!/bin/sh
# start.sh — Multi-service entrypoint for HuggingFace Docker Spaces.
#
# HF Spaces exposes a single container on port 7860.  This script starts:
#   • Node.js  (JioSaavn)     on port 7860  — the public-facing port
#   • Python   (YouTube Music) on port 8000  — internal only
#
# Both processes write to stdout/stderr so HF Spaces log streaming works.
# If either process exits unexpectedly the script exits with a non-zero code,
# which causes HF Spaces to restart the container.

set -e

# ── YouTube Music (Python / FastAPI) ─────────────────────────────────────
echo "[start.sh] Starting YouTube Music service on port 8000..."
cd /app/YouTube\ Music
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1 --no-access-log &
PYTHON_PID=$!

# ── JioSaavn (Node.js / Express) ─────────────────────────────────────────
echo "[start.sh] Starting JioSaavn service on port 7860..."
cd /app
node src/index.js &
NODE_PID=$!

# ── Wait for either process to exit ──────────────────────────────────────
# If one dies, kill the other and exit non-zero so the container restarts.
wait_any() {
  while true; do
    if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
      echo "[start.sh] YouTube Music process exited unexpectedly." >&2
      kill "$NODE_PID" 2>/dev/null || true
      exit 1
    fi
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
      echo "[start.sh] JioSaavn process exited unexpectedly." >&2
      kill "$PYTHON_PID" 2>/dev/null || true
      exit 1
    fi
    sleep 5
  done
}

# Forward SIGTERM/SIGINT to both children for graceful shutdown.
trap 'kill "$PYTHON_PID" "$NODE_PID" 2>/dev/null; exit 0' TERM INT

wait_any
