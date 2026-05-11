#!/usr/bin/env bash
# Turns off Hermes mode — sets PRX_HERMES_ENABLED=N and stops the gateway.
# Hermes itself is NOT uninstalled; re-enable at any time via Settings or install.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}[hermes-off]${NC} $*"; }
success() { echo -e "${GREEN}[hermes-off]${NC} $*"; }
warn()    { echo -e "${YELLOW}[hermes-off]${NC} $*"; }

set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

info "Setting PRX_HERMES_ENABLED=N ..."
set_env "PRX_HERMES_ENABLED" "N"
success "PRX_HERMES_ENABLED=N written to .env"

# Stop the gateway if it is running (don't uninstall Hermes).
if pgrep -f "hermes gateway" > /dev/null 2>&1; then
  info "Stopping Hermes gateway ..."
  pkill -f "hermes gateway" && success "Gateway stopped" || warn "Could not stop gateway — stop it manually with: pkill -f 'hermes gateway'"
else
  info "Gateway was not running"
fi

echo ""
echo "  Hermes is OFF. The CLI and ~/.hermes/ data are untouched."
echo "  Re-enable any time:"
echo "    • Dashboard → Settings → Hermes Integration → Enable: Y"
echo "    • Or: bash server/integrations/hermes/scripts/install.sh"
echo ""
echo "  Restart Prevoyant Server to restore /jira-events:"
echo "    cd \"$REPO_ROOT/server\" && npm start"
