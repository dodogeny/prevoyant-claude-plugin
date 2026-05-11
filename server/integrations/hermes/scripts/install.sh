#!/usr/bin/env bash
# Installs the Hermes × Prevoyant integration:
#   - Sets PRX_HERMES_ENABLED=Y in .env
#   - Configures Hermes gateway URL and optional shared secret
#   - Prints Hermes registration instructions
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[hermes-install]${NC} $*"; }
success() { echo -e "${GREEN}[hermes-install]${NC} $*"; }
warn()    { echo -e "${YELLOW}[hermes-install]${NC} $*"; }
die()     { echo -e "${RED}[hermes-install] ERROR:${NC} $*"; exit 1; }

[[ -f "$ENV_FILE" ]] || die ".env not found at $REPO_ROOT — run this from inside the Prevoyant repo."

# ── Collect config ─────────────────────────────────────────────────────────────

GATEWAY_URL="${PRX_HERMES_GATEWAY_URL:-}"
if [[ -z "$GATEWAY_URL" ]]; then
  read -rp "Hermes gateway URL [default: http://localhost:8080]: " GATEWAY_URL
  GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
fi

SECRET="${PRX_HERMES_SECRET:-}"
if [[ -z "$SECRET" ]]; then
  read -rp "Shared secret for /internal/enqueue (leave blank to skip): " SECRET
fi

SERVER_PORT=$(grep -E '^WEBHOOK_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '"' || echo "3000")
SERVER_PORT="${SERVER_PORT:-3000}"

# ── Write / update .env ────────────────────────────────────────────────────────

set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

info "Writing Hermes config to $ENV_FILE ..."
set_env "PRX_HERMES_ENABLED"     "Y"
set_env "PRX_HERMES_GATEWAY_URL" "$GATEWAY_URL"
[[ -n "$SECRET" ]] && set_env "PRX_HERMES_SECRET" "$SECRET"

success "PRX_HERMES_ENABLED=Y written to .env"

# ── Print Hermes registration instructions ─────────────────────────────────────

ENQUEUE_URL="http://localhost:${SERVER_PORT}/internal/enqueue"
[[ -n "$SECRET" ]] && ENQUEUE_URL="${ENQUEUE_URL}?token=${SECRET}"

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Next: configure Hermes to forward events to Prevoyant${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  1. In your Hermes skill or decision router, call:"
echo ""
echo "       POST ${ENQUEUE_URL}"
echo "       Content-Type: application/json"
[[ -n "$SECRET" ]] && echo "       X-Hermes-Secret: ${SECRET}"
echo ""
echo "       { \"ticket_key\": \"PROJ-123\", \"event_type\": \"jira.status.in_progress\" }"
echo ""
echo "  2. Register your Jira webhook to POST to Hermes gateway:"
echo ""
echo "       ${GATEWAY_URL}/webhook/jira?token=<your-jira-token>"
echo ""
echo "  3. Hermes will receive results at:"
echo ""
echo "       POST ${GATEWAY_URL}/prevoyant/result"
echo ""
echo "  4. Restart Prevoyant Server to apply changes:"
echo ""
echo "       cd \"$REPO_ROOT/server\" && npm start"
echo ""
echo -e "${GREEN}Hermes integration installed.${NC}"
