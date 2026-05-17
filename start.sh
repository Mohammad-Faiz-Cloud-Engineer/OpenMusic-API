#!/bin/sh
# start.sh — Multi-service entrypoint for HuggingFace Docker Spaces.
#
# HF Spaces exposes a single container on port 7860.  This script starts:
#   • Python   (YouTube Music / FastAPI)  on port 8000  — internal only
#   • Node.js  (JioSaavn / Express)       on port 7860  — public-facing
#
# Both processes write to stdout/stderr so HF Spaces log streaming works.
# If either process exits unexpectedly the script exits non-zero, which
# causes HF Spaces to restart the container.
#
# NOTE: Alpine Linux /bin/sh is busybox ash — use `python3`, not `python`.

set -e

# ── YouTube Music (Python / FastAPI) ─────────────────────────────────────
echo "[start.sh] Starting YouTube Music service on port 8000..."
cd "/app/YouTube Music"
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1 --no-access-log &
PYTHON_PID=$!

# ── JioSaavn (Node.js / Express) ─────────────────────────────────────────
echo "[start.sh] Starting JioSaavn service on port 7860..."
cd /app
node src/index.js &
NODE_PID=$!

echo "[start.sh] Both services started. Python PID=$PYTHON_PID  Node PID=$NODE_PID"

# ── Forward SIGTERM/SIGINT to both children for graceful shutdown ─────────
trap 'echo "[start.sh] Shutting down..."; kill "$PYTHON_PID" "$NODE_PID" 2>/dev/null; exit 0' TERM INT

# ── Monitor: exit if either child dies ───────────────────────────────────
# kill -0 checks whether the process is still alive without sending a signal.
while true; do
  if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
    echo "[start.sh] ERROR: YouTube Music process (PID $PYTHON_PID) exited unexpectedly." >&2
    kill "$NODE_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "[start.sh] ERROR: JioSaavn process (PID $NODE_PID) exited unexpectedly." >&2
    kill "$PYTHON_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5
done
