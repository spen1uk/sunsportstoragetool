"""Jarvis connector: lets your personal assistant ("Jarvis") deliver the bot's news and answer
questions about it. See docs/JARVIS.md for the full contract.

OUT  (bot -> Jarvis): every event is POSTed as JSON to JARVIS_WEBHOOK_URL, signed with
     HMAC-SHA256 (header X-Bot-Signature) using JARVIS_SECRET. If Jarvis is unreachable the
     event waits in data/jarvis_outbox.jsonl and is re-sent on the next event.
IN   (Jarvis -> bot): GET /api/jarvis/summary on the dashboard server returns a plain-English
     summary plus key numbers. Requires header "Authorization: Bearer <JARVIS_API_TOKEN>".
"""
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.request

from .config import DATA_DIR

PRIORITY = {"trade_opened": "normal", "trade_closed": "normal", "daily_summary": "low", "learning": "low",
            "memory": "normal", "error": "high", "halt": "high", "test": "normal", "info": "low"}
MAX_OUTBOX = 200


def outbox_path():
    return os.path.join(DATA_DIR, "jarvis_outbox.jsonl")


def sign(secret, body):
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def verify(secret, body, signature):
    """For Jarvis's side (Python example): True if the request really came from this bot."""
    return hmac.compare_digest(sign(secret, body), signature or "")


def make_event(kind, text, data=None, now_ms=None):
    return {"source": "trading-bot", "version": 1, "id": secrets.token_hex(8), "type": kind,
            "priority": PRIORITY.get(kind, "normal"), "time": now_ms or int(time.time() * 1000),
            "text": text, "data": data or {}}


def _send(url, secret, event, timeout=10):
    body = json.dumps(event, separators=(",", ":"), default=str).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "tradebot/1"}
    if secret:
        headers["X-Bot-Signature"] = sign(secret, body)
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status >= 300:
            raise RuntimeError(f"Jarvis answered HTTP {r.status}")


def _read_outbox():
    try:
        with open(outbox_path()) as f:
            return [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError):
        return []


def _write_outbox(events):
    events = events[-MAX_OUTBOX:]
    tmp = outbox_path() + ".tmp"
    with open(tmp, "w") as f:
        for e in events:
            f.write(json.dumps(e, default=str) + "\n")
    os.replace(tmp, outbox_path())


def deliver(url, secret, event, log=print):
    """Send queued events first (in order), then this one. Anything that fails stays queued."""
    queue = _read_outbox() + [event]
    sent = 0
    for i, e in enumerate(queue):
        try:
            _send(url, secret, e)
            sent += 1
        except Exception as err:
            log(f"[jarvis] not delivered ({err}); {len(queue) - i} event(s) kept for retry")
            _write_outbox(queue[i:])
            return False
    if os.path.exists(outbox_path()):
        os.remove(outbox_path())
    return True


# ------------------------------------------------------------------ the "ask the bot" answer
def summary(snapshot):
    """Plain-English status for Jarvis to say or text, plus key numbers, from a dashboard snapshot."""
    if not snapshot:
        return {"text": "The trading bot hasn't produced any data yet.", "data": {}}
    v, g = snapshot["vault"], snapshot.get("guards", {})
    parts = [f"Paper account is at ${v['equity']:.2f}, {'up' if v['return_pct'] >= 0 else 'down'} "
             f"{abs(v['return_pct']):.1f}% since the start."]
    if v.get("today"):
        parts.append(f"Today it's {'made' if v['today'] > 0 else 'lost'} ${abs(v['today']):.2f}.")
    trades = v.get("trades", 0)
    parts.append(f"{trades} closed trade{'s' if trades != 1 else ''}"
                 + (f", winning {v['win_rate']:.0f}% of them." if trades else "."))
    open_w = [w for w in snapshot["workers"] if w.get("position")]
    for w in open_w:
        p = w["position"]
        parts.append(f"{w['name']} is in a {p['side'].lower()} trade, "
                     f"{'up' if p['upnl'] >= 0 else 'down'} ${abs(p['upnl']):.2f}.")
    setups = [w["name"] for w in snapshot["workers"] if w.get("status_kind") in ("setup", "fire")]
    if setups:
        parts.append(f"Setups forming on {', '.join(setups)}.")
    if not open_w and not setups:
        parts.append("No trades open; it's waiting for Calvin's rules to line up.")
    if g.get("halted"):
        parts.append("Warning: the kill switch is on and it has stopped trading until you review it.")
    elif g.get("paused_until"):
        parts.append("It's cooling off after a losing streak.")
    mem = snapshot.get("memory") or {}
    active = (mem.get("stats") or {}).get("active", 0)
    if active:
        parts.append(f"The Memory Keeper is watching out for {active} known mistake pattern{'s' if active != 1 else ''}.")
    return {
        "text": " ".join(parts),
        "data": {"equity": round(v["equity"], 2), "return_pct": round(v["return_pct"], 2),
                 "today": round(v.get("today", 0.0), 2), "closed_trades": trades,
                 "win_rate": round(v.get("win_rate", 0.0), 1), "drawdown_pct": round(v.get("drawdown_pct", 0.0), 2),
                 "open_trades": [{"coin": w["name"], "side": w["position"]["side"],
                                  "unrealised": round(w["position"]["upnl"], 2)} for w in open_w],
                 "setups_forming": setups, "halted": bool(g.get("halted")),
                 "as_of": snapshot.get("market_time"), "mode": snapshot.get("mode")},
    }


def authorized(header_value, token):
    if not token:
        return False
    return bool(header_value) and hmac.compare_digest(header_value, f"Bearer {token}")


# ------------------------------------------------------------------ setup
def jarvis_setup(env_path, url=None, log=print):
    from .notify import write_env
    url = (url if url is not None else input("Jarvis's webhook URL (leave blank if Jarvis isn't ready yet): ")).strip()
    values = {"JARVIS_SECRET": secrets.token_urlsafe(32), "JARVIS_API_TOKEN": secrets.token_urlsafe(32)}
    if url:
        values["JARVIS_WEBHOOK_URL"] = url
    existing = {}
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    existing[k] = v
    for k in ("JARVIS_SECRET", "JARVIS_API_TOKEN"):  # keep existing keys so Jarvis doesn't need re-pairing
        if existing.get(k):
            values[k] = existing[k]
    write_env(env_path, values)
    log("Saved to " + env_path)
    log("\nGive Jarvis these two values (keep them private):")
    log(f"  JARVIS_SECRET    = {values['JARVIS_SECRET']}    (to check messages really come from the bot)")
    log(f"  JARVIS_API_TOKEN = {values['JARVIS_API_TOKEN']}    (to ask the bot questions)")
    if url:
        os.environ["JARVIS_WEBHOOK_URL"], os.environ["JARVIS_SECRET"] = url, values["JARVIS_SECRET"]
        ok = deliver(url, values["JARVIS_SECRET"],
                     make_event("test", "👋 Trading bot connected to Jarvis. You'll get trade news through me now."),
                     log)
        log("Test message delivered to Jarvis." if ok else "Couldn't reach Jarvis yet - messages will queue until it's up.")
    else:
        log("No URL yet - run `python3 run.py jarvis` again when Jarvis has one.")
    return values
