#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu/Debian server. Run from inside the trading-bot folder:
#   bash deploy/setup_vps.sh
# Installs Python, checks BloFin is reachable from this server, and starts the bot as an
# always-on service that restarts itself after crashes and reboots.
set -euo pipefail

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="$(whoami)"

echo "==> Installing Python"
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-pip python3-venv curl

echo "==> Checking BloFin market data is reachable from this server"
if ! curl -fsS -m 20 "https://openapi.blofin.com/api/v1/market/candles?instId=BTC-USDT&bar=1H&limit=1" >/dev/null; then
  echo "!! BloFin did not respond from this server (it may block this country/region)."
  echo "!! Recreate the server in a different region, then run this script again."
  exit 1
fi
echo "    OK"

echo "==> Running the tests"
if (cd "$BOT_DIR" && python3 -m unittest discover tests >/dev/null 2>&1); then echo "    OK"
else echo "!! Some tests failed - run: cd $BOT_DIR && python3 -m unittest discover tests   and send the output to Claude"; exit 1; fi

if [ ! -f "$BOT_DIR/.env" ]; then
  cp "$BOT_DIR/.env.example" "$BOT_DIR/.env"
  echo "==> Created $BOT_DIR/.env - add your Discord/Telegram details there for phone updates"
fi

echo "==> Installing the always-on services (bot + dashboard)"
for unit in tradebot tradebot-dashboard; do
  sed -e "s|^User=.*|User=$RUN_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$BOT_DIR|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=-$BOT_DIR/.env|" \
      "$BOT_DIR/deploy/$unit.service" | sudo tee /etc/systemd/system/$unit.service >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now tradebot tradebot-dashboard
sudo systemctl restart tradebot tradebot-dashboard   # pick up new code when re-run after an update

IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "Done. The bot and dashboard are running and restart automatically (even after a reboot)."
echo
echo "  See the dashboard - on your Mac run:   ssh -L 8050:127.0.0.1:8050 $RUN_USER@$IP"
echo "                     then open:          http://127.0.0.1:8050"
echo "  Bot status:        cd $BOT_DIR && python3 run.py status"
echo "  Live log:          journalctl -u tradebot -f      (Ctrl+C to stop watching)"
echo "  Stop / start:      sudo systemctl stop tradebot / sudo systemctl start tradebot"
echo "  After editing .env: sudo systemctl restart tradebot"
