"""Optional push updates to your phone via a Discord webhook and/or a Telegram bot."""
import json
import urllib.parse
import urllib.request


def _post(url, payload, form=False):
    data = urllib.parse.urlencode(payload).encode() if form else json.dumps(payload).encode()
    headers = {} if form else {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def notify(cfg, text, log=print):
    rep = cfg.get("reports", {})
    sent = False
    if rep.get("discord_webhook_url"):
        try:
            _post(rep["discord_webhook_url"], {"content": text[:1900]})
            sent = True
        except Exception as e:
            log(f"[notify] Discord failed: {e}")
    if rep.get("telegram_bot_token") and rep.get("telegram_chat_id"):
        try:
            _post(f"https://api.telegram.org/bot{rep['telegram_bot_token']}/sendMessage",
                  {"chat_id": rep["telegram_chat_id"], "text": text[:4000]}, form=True)
            sent = True
        except Exception as e:
            log(f"[notify] Telegram failed: {e}")
    return sent
