"""Missed-trade tracker: every setup the bot did NOT take is followed afterwards, as if it had
been taken, so you can see whether each safety rule saves money or just misses winners.

  good skip     -> it would have lost (the rule saved money)
  missed winner -> it would have made money (the rule cost money)

The follow-up is deliberately simple and pessimistic: stop checked before target, gaps fill at
the open, the strategy's own exit signal and the time limit apply. No fees, no partials,
no breakeven moves - so it is an estimate, and every report says so.
Skips blocked by a Memory Keeper pattern feed back into memory: a lesson whose skipped setups
keep winning is "too strict" and gets relaxed (see Memory.record_skip).
"""
import json
import os

from .util import new_id, ts_iso

REASONS = {
    "market_red": "Market mode RED (Bitcoin dumping)",
    "memory": "Memory Keeper (known mistake)",
    "max_positions": "Already at max open trades",
    "daily_loss": "Daily loss limit hit",
    "pause": "Cooling off after a losing streak",
    "halted": "Kill switch on",
    "too_small": "Below exchange minimum size",
}


class SkipTracker:
    def __init__(self, path=None, keep=400):
        self.path = path  # None = in memory only (backtests)
        self.keep = keep
        self.items = []
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    self.items = json.load(f).get("items", [])
            except (OSError, ValueError):
                self.items = []  # a damaged file must never stop the bot

    def save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"items": self.items[-self.keep:]}, f)
        os.replace(tmp, self.path)

    def open_for(self, symbol):
        return any(s["symbol"] == symbol and s["status"] == "open" for s in self.items)

    def add(self, symbol, sig, bar_ts, reason, risk_usd, pattern=None):
        """Record a skipped setup (one open follow-up per coin, like a real position)."""
        if self.open_for(symbol):
            return None
        risk = abs(sig.entry - sig.stop)
        if risk <= 0:
            return None
        item = {"id": new_id(), "symbol": symbol, "side": sig.side, "ts": bar_ts, "entry": sig.entry,
                "stop": sig.stop, "target": sig.target, "risk": risk, "risk_usd": round(risk_usd, 4),
                "reason": reason, "pattern": pattern, "bars": 0, "status": "open", "r": None,
                "closed_ts": None, "how": None}
        self.items.append(item)
        del self.items[:-self.keep]
        self.save()
        return item

    def update(self, symbol, bar, exit_now=False, max_bars=48):
        """Move each open follow-up for this coin forward by one closed candle.
        Returns the items that finished on this candle."""
        done = []
        for s in self.items:
            if s["symbol"] != symbol or s["status"] != "open" or bar.ts <= s["ts"]:
                continue
            d, px, how = s["side"], None, None
            if d > 0:
                if bar.o <= s["stop"]:
                    px, how = bar.o, "stop (gap)"
                elif bar.l <= s["stop"]:
                    px, how = s["stop"], "stop"
                elif bar.h >= s["target"]:
                    px, how = max(bar.o, s["target"]), "target"
            else:
                if bar.o >= s["stop"]:
                    px, how = bar.o, "stop (gap)"
                elif bar.h >= s["stop"]:
                    px, how = s["stop"], "stop"
                elif bar.l <= s["target"]:
                    px, how = min(bar.o, s["target"]), "target"
            s["bars"] += 1
            if px is None and exit_now:
                px, how = bar.c, "exit signal"
            if px is None and s["bars"] >= max_bars:
                px, how = bar.c, "time limit"
            if px is not None:
                s["r"] = round((px - s["entry"]) * d / s["risk"], 3)
                s["status"] = "would_win" if s["r"] > 0 else "would_lose"
                s["closed_ts"], s["how"] = bar.ts, how
                done.append(s)
        if done:
            self.save()
        return done

    # ------------------------------------------------------------- reporting
    def summary(self, since_ts=None):
        rows = {}
        for s in self.items:
            if since_ts and s["ts"] < since_ts:
                continue
            r = rows.setdefault(s["reason"], {"reason": s["reason"], "label": REASONS.get(s["reason"], s["reason"]),
                                             "skipped": 0, "open": 0, "would_win": 0, "would_lose": 0,
                                             "r": 0.0, "usd": 0.0})
            r["skipped"] += 1
            if s["status"] == "open":
                r["open"] += 1
                continue
            r[s["status"]] += 1
            r["r"] = round(r["r"] + s["r"], 3)
            r["usd"] = round(r["usd"] + s["r"] * s["risk_usd"], 4)
        out = sorted(rows.values(), key=lambda r: -r["skipped"])
        for r in out:
            # usd > 0: the skipped trades would have made money (the rule cost that much)
            r["verdict"] = ("still being followed" if r["skipped"] == r["open"] else
                            "saved money" if r["usd"] < 0 else "missed money" if r["usd"] > 0 else "no difference")
        return out

    def recent(self, n=20):
        out = []
        for s in reversed(self.items[-n:]):
            out.append({"symbol": s["symbol"], "side": "LONG" if s["side"] > 0 else "SHORT", "time": ts_iso(s["ts"]),
                        "reason": REASONS.get(s["reason"], s["reason"]), "pattern": s.get("pattern"),
                        "status": s["status"], "r": s["r"], "how": s["how"],
                        "usd": None if s["r"] is None else round(s["r"] * s["risk_usd"], 2)})
        return out

    def text_lines(self, since_ts=None):
        lines = []
        for r in self.summary(since_ts):
            done = r["would_win"] + r["would_lose"]
            if not done:
                lines.append(f"{r['label']}: skipped {r['skipped']} setup(s), still following them")
                continue
            effect = (f"saved about ${-r['usd']:.2f}" if r["usd"] < 0 else
                      f"missed about ${r['usd']:.2f}" if r["usd"] > 0 else "no difference")
            lines.append(f"{r['label']}: skipped {r['skipped']} - {r['would_lose']} would have lost, "
                         f"{r['would_win']} would have won -> {effect} (estimate)")
        return lines
