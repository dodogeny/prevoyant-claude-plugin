#!/usr/bin/env bash
# stop.sh — stop prevoyant-server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SERVER_DIR/.server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "[prevoyant-server] Not running (no PID file found)"
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  # Wait up to 5 s for clean shutdown
  for i in 1 2 3 4 5; do
    sleep 1
    kill -0 "$PID" 2>/dev/null || break
  done
  # Force-kill if still alive
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
    echo "[prevoyant-server] Force-killed (PID $PID)"
  else
    echo "[prevoyant-server] Stopped (PID $PID)"
  fi
else
  echo "[prevoyant-server] Not running (stale PID $PID)"
fi

rm -f "$PID_FILE"
