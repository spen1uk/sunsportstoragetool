import copy
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(ROOT, "config.json")
DATA_DIR = os.environ.get("TRADEBOT_DATA_DIR", os.path.join(ROOT, "data"))
PARAMS_FILE = os.path.join(DATA_DIR, "params.json")  # learned strategy params (versioned)


def load_config(path=None):
    with open(path or DEFAULT_CONFIG) as f:
        cfg = json.load(f)
    if cfg.get("mode") != "paper":
        raise SystemExit(
            "Only mode='paper' is supported. Live trading is intentionally not wired up "
            "until the paper results justify it (see README: 'Going live')."
        )
    # Secrets can come from the environment instead of the file.
    rep = cfg.setdefault("reports", {})
    rep["discord_webhook_url"] = os.environ.get("DISCORD_WEBHOOK_URL", rep.get("discord_webhook_url", ""))
    rep["telegram_bot_token"] = os.environ.get("TELEGRAM_BOT_TOKEN", rep.get("telegram_bot_token", ""))
    rep["telegram_chat_id"] = os.environ.get("TELEGRAM_CHAT_ID", rep.get("telegram_chat_id", ""))
    os.makedirs(DATA_DIR, exist_ok=True)
    return cfg


def load_params(cfg):
    """Active strategy params: the latest learned version, else config defaults (version 0)."""
    if os.path.exists(PARAMS_FILE):
        with open(PARAMS_FILE) as f:
            hist = json.load(f)
        if hist.get("versions"):
            cur = hist["versions"][-1]
            merged = copy.deepcopy(cfg["strategy"])
            merged.update(cur["params"])
            return merged, cur["version"]
    return copy.deepcopy(cfg["strategy"]), 0


def save_new_params(params, reason, evidence):
    hist = {"versions": []}
    if os.path.exists(PARAMS_FILE):
        with open(PARAMS_FILE) as f:
            hist = json.load(f)
    version = (hist["versions"][-1]["version"] if hist["versions"] else 0) + 1
    from .util import now_iso
    hist["versions"].append({
        "version": version, "adopted_at": now_iso(), "params": params,
        "reason": reason, "evidence": evidence,
    })
    _write_json(PARAMS_FILE, hist)
    return version


def rollback_params():
    if not os.path.exists(PARAMS_FILE):
        return None
    with open(PARAMS_FILE) as f:
        hist = json.load(f)
    if not hist.get("versions"):
        return None
    dropped = hist["versions"].pop()
    _write_json(PARAMS_FILE, hist)
    return dropped


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)
