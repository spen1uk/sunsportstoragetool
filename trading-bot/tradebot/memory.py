"""Memory Keeper: the bot's notebook of mistakes.

It remembers three things across restarts (data/memory.json):
  1. PATTERNS  - losing patterns found by the loss autopsy ("bought when price was stretched").
                 Each one has evidence, a status and an action:
                   watching  -> found once, just noted
                   caution   -> strong evidence: matching trades are taken at HALF size
                   avoid     -> NEW trades after the pattern was found kept losing: matching trades
                                are SKIPPED (requires out-of-sample confirmation, never just hindsight)
                   fixed     -> a rule change that filters it passed testing and was adopted
                   cleared   -> later trades matching it made money, so the caution was lifted
  2. FIXES     - every rule change the learner tried, adopted or rejected, and why.
  3. COOLDOWN  - rejected ideas aren't retested until their cooldown ends (the market has
                 had time to change), so the learner doesn't keep repeating itself.
"""
import json
import os
import time

from .config import DATA_DIR
from .util import ts_iso

DAY_MS = 86_400_000
COOLDOWN_DAYS = {"no_gain": 14, "curve_fit": 30, "drawdown": 30}
CAUTION = {"losers": 5, "r_sum": -3.0, "ratio": 2.0}     # evidence needed for half size
AVOID = {"trades": 5, "r_sum": -3.0}                      # NEW live trades needed to skip
CLEAR = {"trades": 5, "r_sum": 2.0}                       # NEW live trades that lift caution


def _now():
    return int(time.time() * 1000)


def matches(cond, features):
    v = features.get(cond["feature"])
    if v is None:
        return False
    op = cond["op"]
    if op == ">":
        return v > cond["threshold"]
    if op == "<":
        return v < cond["threshold"]
    if op == "is_false":
        return v is False
    return False


class Memory:
    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, "memory.json")
        self.data = {"patterns": {}, "tried": {}, "events": [], "stats": {"half_sized": 0, "skipped": 0,
                                                                           "ideas_skipped": 0}}
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    loaded = json.load(f)
                for k in self.data:
                    self.data[k] = loaded.get(k, self.data[k])
            except (OSError, ValueError):
                pass  # a damaged memory file must never stop the bot

    # ------------------------------------------------------------- persistence
    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, self.path)

    def _event(self, kind, message, ts=None):
        self.data["events"].insert(0, {"ts": _now() if ts is None else ts, "kind": kind, "message": message})
        del self.data["events"][80:]
        return message

    # ------------------------------------------------------------- 1. patterns
    def update_patterns(self, findings, now=None):
        """findings: structured results from learner.loss_autopsy. Returns plain-English notes."""
        now = _now() if now is None else now
        notes = []
        for f in findings:
            p = self.data["patterns"].get(f["key"])
            if p is None:
                p = self.data["patterns"][f["key"]] = {
                    "key": f["key"], "text": f["text"], "cond": f["cond"], "fix": f.get("fix"),
                    "status": "watching", "first_seen": now, "times_found": 0,
                    "live": {"trades": 0, "r": 0.0, "wins": 0}, "fixes": [],
                }
                notes.append(self._event("new", f"New mistake pattern noted: {f['text']}", now))
            p["cond"] = f["cond"]                       # threshold may drift as data grows
            p["text"] = f["text"]
            p["times_found"] += 1
            p["last_seen"] = now
            p["evidence"] = {"losers": f["losers"], "winners": f["winners"], "r_sum": round(f["r_sum"], 2),
                             "trades": f["trades"]}
            if p["status"] == "watching" and self._strong(p):
                p["status"], p["since"] = "caution", now
                notes.append(self._event("caution", f"Caution: {f['text']} - matching trades now use half size "
                                                    f"({f['losers']} losers vs {f['winners']} winners, "
                                                    f"{f['r_sum']:+.1f}R).", now))
        self.save()
        return notes

    @staticmethod
    def _strong(p):
        e = p["evidence"]
        return (e["losers"] >= CAUTION["losers"] and e["r_sum"] <= CAUTION["r_sum"]
                and e["losers"] >= CAUTION["ratio"] * max(e["winners"], 1)) or p["times_found"] >= 3

    # ------------------------------------------------------------- 2. before every trade
    def pre_trade(self, features):
        """('skip'|'half'|None, pattern) for the strongest known mistake this setup matches."""
        best = None
        for p in self.data["patterns"].values():
            if p["status"] not in ("caution", "avoid") or not matches(p["cond"], features):
                continue
            if p["status"] == "avoid":
                return "skip", p
            best = best or p
        return ("half", best) if best else (None, None)

    def note_action(self, action, pattern, symbol, ts):
        key = "skipped" if action == "skip" else "half_sized"
        self.data["stats"][key] += 1
        verb = "Skipped" if action == "skip" else "Half-size"
        msg = self._event(action, f"{verb} {symbol.split('-')[0]} entry - matches known mistake: {pattern['text']}", ts)
        self.save()
        return msg

    # ------------------------------------------------------------- after every trade
    def record_trade(self, trade):
        """Track how trades that match each pattern do AFTER it was found (out-of-sample evidence)."""
        try:
            features = json.loads(trade.get("features") or "{}")
        except (TypeError, ValueError):
            return []
        notes = []
        for p in self.data["patterns"].values():
            if trade["entry_ts"] < p["first_seen"] or not matches(p["cond"], features):
                continue
            lv = p["live"]
            lv["trades"] += 1
            lv["r"] = round(lv["r"] + trade["r_multiple"], 3)
            lv["wins"] += 1 if trade["net_pnl"] > 0 else 0
            if p["status"] == "caution" and lv["trades"] >= AVOID["trades"] and lv["r"] <= AVOID["r_sum"]:
                p["status"] = "avoid"
                notes.append(self._event("avoid", f"Confirmed mistake: {p['text']} kept losing after it was "
                                                  f"found ({lv['trades']} trades, {lv['r']:+.1f}R) - "
                                                  f"these setups are now skipped.", trade["exit_ts"]))
            elif p["status"] in ("caution", "avoid") and lv["trades"] >= CLEAR["trades"] and lv["r"] >= CLEAR["r_sum"]:
                p["status"] = "cleared"
                notes.append(self._event("cleared", f"Lifted caution on {p['text']}: newer matching trades made "
                                                    f"{lv['r']:+.1f}R, so it wasn't a real mistake.",
                                         trade["exit_ts"]))
        if notes or any(p["live"]["trades"] for p in self.data["patterns"].values()):
            self.save()
        return notes

    # ------------------------------------------------------------- 3. fixes & cooldown
    def cooling(self, change_key, now=None):
        t = self.data["tried"].get(change_key)
        if t and t["result"] == "rejected" and t["retry_after"] and (_now() if now is None else now) < t["retry_after"]:
            return t
        return None

    def record_fix(self, change_key, desc, result, reason="", kind="no_gain", pattern_key=None, now=None,
                   quiet=False):
        now = _now() if now is None else now
        prev = self.data["tried"].get(change_key, {})
        self.data["tried"][change_key] = {
            "desc": desc, "result": result, "reason": reason, "at": now, "times": prev.get("times", 0) + 1,
            "retry_after": now + COOLDOWN_DAYS.get(kind, 14) * DAY_MS if result == "rejected" else None,
        }
        p = self.data["patterns"].get(pattern_key) if pattern_key else None
        if p is not None:
            p["fixes"] = (p["fixes"] + [{"at": now, "desc": desc, "result": result, "reason": reason}])[-8:]
            if result == "adopted":
                p["status"] = "fixed"
        if not quiet:
            self._event("fix_" + result, f"{'Adopted' if result == 'adopted' else 'Rejected'} fix: {desc}"
                        + (f" - {reason}" if reason else ""), now)
        return change_key

    def reset_cooldowns(self):
        for t in self.data["tried"].values():
            if t["result"] == "rejected":
                t["retry_after"] = None

    def note_ideas_skipped(self, n):
        self.data["stats"]["ideas_skipped"] += n

    # ------------------------------------------------------------- dashboard
    def summary(self, now=None):
        now = _now() if now is None else now
        order = {"avoid": 0, "caution": 1, "watching": 2, "fixed": 3, "cleared": 4}
        pats = sorted(self.data["patterns"].values(), key=lambda p: (order.get(p["status"], 9), -p.get("last_seen", 0)))
        tried = sorted(self.data["tried"].values(), key=lambda t: -t["at"])
        return {
            "patterns": [{
                "text": p["text"], "status": p["status"], "first_seen": ts_iso(p["first_seen"]),
                "last_seen": ts_iso(p.get("last_seen", p["first_seen"])), "times_found": p["times_found"],
                "evidence": p.get("evidence", {}), "live": p["live"],
                "fixes": [{"at": ts_iso(x["at"]), "desc": x["desc"], "result": x["result"], "reason": x["reason"]}
                          for x in p["fixes"]],
            } for p in pats],
            "cooldown": [{"desc": t["desc"], "reason": t["reason"], "times": t["times"],
                          "retry_after": ts_iso(t["retry_after"])}
                         for t in tried if t["result"] == "rejected" and t["retry_after"] and t["retry_after"] > now][:40],
            "adopted": [{"desc": t["desc"], "at": ts_iso(t["at"])} for t in tried if t["result"] == "adopted"][:20],
            "events": [{"time": ts_iso(e["ts"]), "kind": e["kind"], "message": e["message"]}
                       for e in self.data["events"][:40]],
            "stats": dict(self.data["stats"], patterns=len(pats),
                          active=sum(1 for p in pats if p["status"] in ("caution", "avoid")),
                          tried=len(tried)),
        }
