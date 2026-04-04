#!/usr/bin/env bash
# Send a TOTP code to the running SMP server
# Usage: ./src/scripts/send-mfa.sh 123456

set -euo pipefail
CODE="${1:?Usage: send-mfa.sh <totp-code>}"

# Source .env for USER_TOKEN and PORT
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../../.env" ]; then
  set -a; source "$SCRIPT_DIR/../../.env"; set +a
fi

PORT="${PORT:-7000}"
BASE="${BASE_URL:-http://localhost:$PORT}"
TOKEN="${USER_TOKEN:?USER_TOKEN must be set in .env}"

curl -s -X POST "$BASE/$TOKEN/admin/mfa" \
  -H 'Content-Type: application/json' \
  -d "{\"code\": \"$CODE\"}"
echo
