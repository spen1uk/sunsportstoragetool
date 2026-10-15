"""Optional push updates to your phone via a Discord webhook and/or a Telegram bot."""
import json
import os
import time
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


# ------------------------------------------------------------------ Telegram setup helper
def _tg(token, method, params=None):
    url = f"https://api.telegram.org/bot{token}/{method}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=40) as r:
        data = json.loads(r.read().decode())
    if not data.get("ok"):
        raise RuntimeError(data.get("description", "Telegram said no"))
    return data["result"]


def find_chat_id(updates):
    """The chat id of the most recent private message sent to the bot, or None."""
    for u in reversed(updates):
        msg = u.get("message") or u.get("edited_message") or {}
        chat = msg.get("chat") or {}
        if chat.get("id") is not None:
            return chat["id"], (chat.get("first_name") or chat.get("title") or "")
    return None


def write_env(path, values):
    """Set KEY=value lines in a .env file, keeping everything else as is."""
    lines = []
    if os.path.exists(path):
        with open(path) as f:
            lines = f.read().splitlines()
    done = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in values:
            lines[i] = f"{key}={values[key]}"
            done.add(key)
    lines += [f"{k}={v}" for k, v in values.items() if k not in done]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(path, 0o600)  # secrets: readable by you only


def telegram_setup(env_path, token=None, wait_seconds=180):
    """Interactive: check the token, find your chat id, save both to .env, send a test message."""
    token = (token or input("Paste your Telegram bot token from @BotFather: ")).strip()
    try:
        me = _tg(token, "getMe")
    except Exception as e:
        raise SystemExit(f"That token didn't work ({e}). Copy it again from @BotFather - it looks like 123456:ABC-...")
    name = me.get("username")
    print(f"Token OK - your bot is @{name}.")
    print(f"Now open Telegram on your phone, search for @{name}, tap Start (or send it any message).")
    print("Waiting for your message...", flush=True)
    found, offset, deadline = None, None, time.time() + wait_seconds
    while time.time() < deadline and not found:
        params = {"timeout": 25}
        if offset:
            params["offset"] = offset
        updates = _tg(token, "getUpdates", params)
        if updates:
            offset = updates[-1]["update_id"] + 1
            found = find_chat_id(updates)
    if not found:
        raise SystemExit("Didn't see a message in time. Send your bot a message in Telegram, then run this again.")
    chat_id, who = found
    write_env(env_path, {"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_CHAT_ID": chat_id})
    _post(f"https://api.telegram.org/bot{token}/sendMessage",
          {"chat_id": chat_id, "text": "✅ Bot City is connected! You'll get a message here when the bot "
                                       "opens or closes a trade, a daily summary, and when it learns something."},
          form=True)
    print(f"Connected to {who or 'your chat'} (chat id {chat_id}) and saved to {env_path}.")
    print("Check your phone for the test message.")
    return chat_id
