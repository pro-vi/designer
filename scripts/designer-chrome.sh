#!/usr/bin/env bash
# Launch a Chrome instance with remote debugging enabled, in a dedicated
# user-data-dir so the default profile's debug-port lockdown (Chrome 136+)
# doesn't block us. Sign in to Claude once inside the launched window;
# the profile persists.

set -e

PORT="${DESIGNER_CDP:-9222}"
PROFILE="$HOME/.chrome-designer-profile"

# Cross-platform Chrome resolution: CHROME_BIN wins; else per-OS default.
if [ -n "$CHROME_BIN" ]; then
  CHROME="$CHROME_BIN"
elif [ "$(uname -s)" = "Darwin" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  for c in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -x "$c" ] && CHROME="$c" && break
  done
  CHROME="${CHROME:-/usr/bin/google-chrome}"
fi

if [ ! -x "$CHROME" ]; then
  echo "[designer-chrome] Chrome not found at: $CHROME" >&2
  echo "                  Set CHROME_BIN to override." >&2
  exit 1
fi

if curl -fs -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
  echo "[designer-chrome] CDP already listening on port $PORT — nothing to do."
  echo "                  curl http://127.0.0.1:$PORT/json/version | head"
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ]; then CHROME_PAT="Google Chrome"; QUIT_HINT="Quit existing Chrome (Cmd+Q) first"; else CHROME_PAT="chrome"; QUIT_HINT="Quit existing Chrome (or 'pkill chrome') first"; fi
if pgrep -f "$CHROME_PAT" >/dev/null; then
  echo "[designer-chrome] WARNING: Chrome is already running." >&2
  echo "                  If it's NOT a debug-mode Chrome, the launched window may not get the debug port." >&2
  echo "                  $QUIT_HINT, or accept the risk and continue." >&2
fi

echo "[designer-chrome] Launching: $CHROME --remote-debugging-port=$PORT --user-data-dir=$PROFILE"
echo "[designer-chrome] Sign in to claude.ai in the new window. Then navigate to https://claude.ai/design."
echo "[designer-chrome] When done, leave this window open. The CDP server runs as long as Chrome runs."

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-search-engine-choice-screen \
  "https://claude.ai/design"
