#!/bin/bash
# Optional: run the Mac helper (pushes a read-only copy of Calendar/Notes to your Jarvis server) when you log in, every 15 minutes.
#   bash scripts/bridge-autostart.sh install | uninstall | status
# Per-user LaunchAgent: no admin rights. Set up the helper first:  npm run bridge:setup
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"; LABEL="uk.jarvis.bridge"
AGENT_DIR="${JARVIS_AGENT_DIR:-$HOME/Library/LaunchAgents}"; PLIST="$AGENT_DIR/$LABEL.plist"; DRY="${JARVIS_AGENT_DRYRUN:-}"
NODE="$(command -v node || true)"
die() { echo "$1" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
[ -n "$DRY" ] || [ "$(uname)" = "Darwin" ] || die "This is for macOS only."
case "${1:-}" in
  install)
    [ -n "$NODE" ] || die "Node.js not found."
    [ -f "${JARVIS_BRIDGE_CONFIG:-$HOME/.jarvis-bridge.json}" ] || die "Run  npm run bridge:setup  first."
    mkdir -p "$AGENT_DIR" "$DIR/data"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(esc "$NODE")</string><string>$(esc "$DIR")/server/bridge-mac.ts</string><string>--loop</string></array>
  <key>WorkingDirectory</key><string>$(esc "$DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(esc "$DIR")/data/bridge.log</string>
  <key>StandardErrorPath</key><string>$(esc "$DIR")/data/bridge.log</string>
</dict></plist>
PL
    chmod 600 "$PLIST"
    if [ -n "$DRY" ]; then echo "Wrote $PLIST (dry run: not loaded)"; exit 0; fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed. The helper runs at login and every 15 minutes. Logs: $DIR/data/bridge.log (counts only, never your content)." ;;
  uninstall) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "Helper auto-start removed." ;;
  status) if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "Helper auto-start: installed and loaded."; else echo "Helper auto-start: not installed."; fi ;;
  *) echo "usage: bash scripts/bridge-autostart.sh install | uninstall | status" ;;
esac
