#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
PROFILE_DIR="${CHROME_DEBUG_PROFILE:-$HOME/.codex-tennis-chrome-profile}"
START_URL="${CHROME_DEBUG_START_URL:-https://www.tennis.de/mein-court.html}"
LOG_FILE="${CHROME_DEBUG_LOG:-/tmp/codex-tennis-chrome.log}"

if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
else
  echo "Could not find Chrome/Chromium binary." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Chrome debug endpoint already running on port $PORT"
  echo "Check: curl -s http://127.0.0.1:$PORT/json"
  exit 0
fi

nohup "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$START_URL" >"$LOG_FILE" 2>&1 &

sleep 2

if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  echo "Chrome debug session started."
  echo "Port: $PORT"
  echo "Profile: $PROFILE_DIR"
  echo "Log: $LOG_FILE"
  echo "Now log into tennis.de once in this profile. Session will persist."
else
  echo "Chrome launched but debug endpoint not reachable yet." >&2
  echo "Check log: $LOG_FILE" >&2
  exit 1
fi
