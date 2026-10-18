# Connecting Jarvis to the trading bot

This is the contract between the trading bot and your assistant ("Jarvis"). Whoever builds Jarvis
only needs this page.

## Setup (on the machine running the bot)

```
python3 run.py jarvis
```

Paste Jarvis's webhook URL, or leave it blank if Jarvis isn't ready yet. The command creates two
private keys, saves everything in `.env` and prints the keys for you to give to Jarvis:

| Key | Jarvis uses it to... |
|---|---|
| `JARVIS_SECRET` | check that incoming messages really come from your bot |
| `JARVIS_API_TOKEN` | ask the bot for a status update |

Running it again keeps the same keys, so you only pair Jarvis once. On the server, restart afterwards:
`sudo systemctl restart tradebot tradebot-dashboard`.

## 1. Bot → Jarvis: news (webhook)

For every event the bot sends `POST <JARVIS_WEBHOOK_URL>` with a JSON body:

```js
import crypto from "node:crypto";

function fromMyBot(rawBody, signatureHeader, secret) {
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signatureHeader || "");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

## 2. Jarvis → bot: "How's the trading bot doing?"

```
GET http://<bot-server>:8050/api/jarvis/summary
Authorization: Bearer <JARVIS_API_TOKEN>
```

Response:

```json
{
  "text": "Paper account is at $107.56, up 7.6% since the start. 32 closed trades, winning 28% of them. BTC is in a long trade, up $0.66. Setups forming on ETH, SOL.",
  "data": {"equity": 107.56, "return_pct": 7.56, "today": 0.0, "closed_trades": 32, "win_rate": 28.1,
           "drawdown_pct": 0.0, "open_trades": [{"coin": "BTC", "side": "LONG", "unrealised": 0.66}],
           "setups_forming": ["ETH", "SOL"], "halted": false, "as_of": "2026-10-18 00:00 UTC", "mode": "paper"}
}
```

`text` is written to be read aloud or texted as-is. A wrong or missing token gets `401`.

**Network:** by default the dashboard server only listens on the bot's own machine (127.0.0.1).
- **Jarvis on the same server:** use `http://127.0.0.1:8050`. Nothing else needed. This is the
  easiest option.
- **Jarvis somewhere else:** connect the two machines privately, e.g. with Tailscale (free).
  Don't open port 8050 to the whole internet; the dashboard itself has no login.

## What Jarvis can't do

Jarvis can read the bot's status and receive its news. It can't place trades, change rules or
risk limits, or turn the kill switch off. Those stay with you, on purpose.
