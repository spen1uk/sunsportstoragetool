#!/bin/bash
# Starts Jarvis on this Mac. Safe to run repeatedly: it sets up what's missing, rebuilds if the code changed,
# reuses an already-running Jarvis, and refuses to fight another program over the port.
set -e
cd "$(dirname "$0")/.."
PORT="${JARVIS_PORT:-8788}"; URL="http://127.0.0.1:$PORT"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install the current LTS from https://nodejs.org, then run this again."
IFS=. read -r MA MI _ <<<"$(node -p 'process.versions.node')"
if [ "$MA" -lt 22 ] || { [ "$MA" -eq 22 ] && [ "$MI" -lt 18 ]; }; then die "Node $(node -v) is too old. Jarvis needs 22.18 or newer (nodejs.org, LTS)."; fi

# Already running? Then just open it.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -s --max-time 2 "$URL/api/me" 2>/dev/null | grep -q '"authenticated"'; then
    say "Jarvis is already running at $URL"; [ -z "$JARVIS_NO_OPEN" ] && command -v open >/dev/null 2>&1 && open "$URL"; exit 0
  fi
  die "Something else is already using port $PORT, and it isn't Jarvis. Leave it alone and pick another port, e.g.:  JARVIS_PORT=$((PORT+1)) bash scripts/launch.sh"
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then say "Installing dependencies…"; npm ci; fi
if ! node server/setup.ts --check 2>/dev/null; then
  say "First-time setup: creating your owner passphrase"; echo "It is shown ONCE. Copy it into your password manager now."
  node server/setup.ts 2>&1 | grep -v ExperimentalWarning | grep -v 'trace-warnings'
  if [ -t 0 ]; then read -r -p "Press Enter once you have saved it… " _; fi
fi
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html web/vite.config.ts -newer web/dist/index.html 2>/dev/null | head -1)" ]; then say "Building the dashboard…"; npm run build; fi

say "Starting Jarvis at $URL   (press Ctrl+C to stop)"
if [ -z "$JARVIS_NO_OPEN" ] && command -v open >/dev/null 2>&1; then ( sleep 2; open "$URL" ) & fi
JARVIS_PORT="$PORT" exec node server/index.ts
