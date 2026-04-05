#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"

if ! curl -sf "http://127.0.0.1:$PORT/json" >/dev/null; then
  echo "Debug endpoint is not reachable on port $PORT"
  exit 1
fi

echo "Debug endpoint reachable on port $PORT"
echo
curl -s "http://127.0.0.1:$PORT/json" | rg '"title"|"url"' || true
