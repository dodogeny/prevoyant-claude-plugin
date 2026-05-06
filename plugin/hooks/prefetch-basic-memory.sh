#!/usr/bin/env bash
# Pre-fetch basic-memory MCP package on first session after PRX_BASIC_MEMORY_ENABLED=Y.
# Idempotent: a marker file makes subsequent sessions a fast no-op (~50 ms).
# Silent on success; never blocks session start.

set -u

# Skip when the feature is off — no point fetching what we won't run.
[ "${PRX_BASIC_MEMORY_ENABLED:-N}" = "Y" ] || exit 0

MARKER="$HOME/.prevoyant/.basic-memory-ready"

# Fast path: already cached.
[ -f "$MARKER" ] && exit 0

# uvx required — installed by setup.sh / setup.ps1 step 1/9. If missing,
# silently skip; the runtime will still attempt lazy fetch on first MCP spawn.
command -v uvx >/dev/null 2>&1 || exit 0

mkdir -p "$(dirname "$MARKER")" 2>/dev/null || exit 0

# Prime the uvx cache. Output suppressed to keep the session-start banner clean;
# failures are non-fatal — uvx will retry the download on first MCP spawn.
if uvx --quiet basic-memory --version >/dev/null 2>&1; then
  touch "$MARKER"
fi

exit 0
