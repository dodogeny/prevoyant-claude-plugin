#!/usr/bin/env bash
# SessionStart hook — ensures lmdb is installed when PRX_CORTEX_ENABLED=Y.
#
# Runs silently and exits 0 in all cases — never blocks session start.
#
# Why here and not only in postinstall?
#   Users who clone the repo and start the server without running
#   `npm install` first (common on first install before setup.sh finishes)
#   would get the JSONL fallback indefinitely.  This hook catches that gap by
#   installing lmdb on the first Claude Code session after Cortex is enabled.
#
# Cross-platform: runs on macOS / Linux / WSL.  Windows users without WSL
#   invoke install-lmdb.js directly via Node (the hook exits early below if
#   MSYS/MINGW is detected without a proper npm on PATH).

# Only run when Cortex is enabled.
if [ "${PRX_CORTEX_ENABLED:-N}" != "Y" ]; then
  exit 0
fi

# Need Node to run the installer.
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

INSTALLER="${CLAUDE_PLUGIN_ROOT}/install/install-lmdb.js"
if [ ! -f "$INSTALLER" ]; then
  exit 0
fi

SERVER_DIR="${CLAUDE_PLUGIN_ROOT}/../server"
LMDB_MARKER="${SERVER_DIR}/node_modules/lmdb/package.json"

# Fast path: already installed — exit immediately, no Node spawn.
if [ -f "$LMDB_MARKER" ]; then
  exit 0
fi

# Install — quiet mode so output doesn't bleed into session context.
node "$INSTALLER" --quiet >/dev/null 2>&1 || true

exit 0
