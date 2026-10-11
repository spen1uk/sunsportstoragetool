#!/bin/bash
# Optional: start Jarvis automatically when you log in to this Mac, and restart it if it crashes.
#   bash scripts/autostart.sh install | uninstall | status
# Runs as YOU (a per-user LaunchAgent): no admin rights, no system changes, loopback-only. Logs: data/jarvis.log
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"; LABEL="uk.jarvis.local"
AGENT_DIR="${JARVIS_AGENT_DIR:-$HOME/Library/LaunchAgents}"; PLIST="$AGENT_DIR/$LABEL.plist"; DRY="${JARVIS_AGENT_DRYRUN:-}"
PORT="${JARVIS_PORT:-8788}"; NODE="$(command -v node || true)"
die() { echo "$1" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
[ -n "$DRY" ] || [ "$(uname)" = "Darwin" ] || die "This is for macOS only."
case "${1:-}" in
  install)
    [ -n "$NODE" ] || die "Node.js not found."
    cd "$DIR"; node server/setup.ts --check 2>/dev/null || die "Run  bash scripts/launch.sh  once first (it creates your passphrase), then install auto-start."
    [ -f web/dist/index.html ] || die "Dashboard isn't built yet. Run  bash scripts/launch.sh  once first."
    mkdir -p "$AGENT_DIR" "$DIR/data"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(esc "$NODE")</string><string>$(esc "$DIR")/server/index.ts</string></array>
  <key>WorkingDirectory</key><string>$(esc "$DIR")</string>
  <key>EnvironmentVariables</key><dict><key>JARVIS_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(esc "$DIR")/data/jarvis.log</string>
  <key>StandardErrorPath</key><string>$(esc "$DIR")/data/jarvis.log</string>
</dict></plist>
PL
    chmod 600 "$PLIST"
    if [ -n "$DRY" ]; then echo "Wrote $PLIST (dry run: not loaded)"; exit 0; fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed. Jarvis now starts at login at http://127.0.0.1:$PORT and restarts if it stops."
    echo "Logs: $DIR/data/jarvis.log     Remove with: bash scripts/autostart.sh uninstall"
    echo "Note: it uses this Node: $NODE. If you change Node versions, run install again." ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "Auto-start removed. (Jarvis itself and your data are untouched.)" ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "Auto-start: installed and loaded."; else echo "Auto-start: not installed."; fi
    curl -s --max-time 2 "http://127.0.0.1:$PORT/api/me" | grep -q '"authenticated"' && echo "Jarvis is answering on port $PORT." || echo "Jarvis is not answering on port $PORT." ;;
  *) echo "usage: bash scripts/autostart.sh install | uninstall | status" ;;
esac
