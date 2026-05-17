#!/usr/bin/env bash
# start.sh — start prevoyant-server in the background

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SERVER_DIR/.server.pid"
LOG_FILE="$SERVER_DIR/prevoyant-server.log"
PORT="${WEBHOOK_PORT:-3000}"

# ── Already running? ──────────────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "[prevoyant-server] Already running (PID $PID)"
    echo "[prevoyant-server] Dashboard : http://localhost:${PORT}/dashboard"
    echo "[prevoyant-server] Log       : $LOG_FILE"
    exit 0
  else
    echo "[prevoyant-server] Removing stale PID file (PID $PID was not running)"
    rm -f "$PID_FILE"
  fi
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "[prevoyant-server] node_modules not found — running npm install..."
  npm install --prefix "$SERVER_DIR" --silent
  echo "[prevoyant-server] Dependencies installed."
fi

# ── Start ─────────────────────────────────────────────────────────────────────
cd "$SERVER_DIR"
node --max-old-space-size=256 index.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Give the process a moment to either bind the port or crash
sleep 2

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[prevoyant-server] Failed to start — check $LOG_FILE"
  rm -f "$PID_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi

echo "[prevoyant-server] Started     (PID $SERVER_PID)"
echo "[prevoyant-server] Dashboard : http://localhost:${PORT}/dashboard"
echo "[prevoyant-server] Health    : http://localhost:${PORT}/health"
echo "[prevoyant-server] Log       : $LOG_FILE"
