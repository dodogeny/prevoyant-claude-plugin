#!/usr/bin/env bash
# SessionStart hook — installs repowise on first activation if the user has
# opted into auto-install via PRX_REPOWISE_AUTO_INSTALL=Y.  Silent no-op
# otherwise (default behaviour — never touches the user's machine without
# explicit opt-in).
#
# Cross-platform: this shell hook runs on macOS / Linux / WSL.  Windows users
# without WSL invoke plugin/install/install-repowise.js directly from the
# Cortex page button (it works under cmd.exe / PowerShell via Node).

set -e

# Skip silently unless the user explicitly opted in.
if [ "${PRX_REPOWISE_AUTO_INSTALL:-N}" != "Y" ]; then
  exit 0
fi

# Skip if already installed.
if command -v repowise >/dev/null 2>&1; then
  exit 0
fi

# Find Node — the installer is Node-based so it handles platform detection
# uniformly.  If Node isn't available, exit quietly; the user can install
# manually from the Cortex page once Node is on PATH.
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT="${CLAUDE_PLUGIN_ROOT}/install/install-repowise.js"
if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

# Best effort — never block session start.
node "$SCRIPT" >/dev/null 2>&1 || true
