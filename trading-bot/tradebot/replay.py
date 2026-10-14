"""Replay mode: run history through the real trading engine one candle at a time and record
what the city looked like after every candle, so the dashboard can play it back."""
import json
import os
import threading
import time

from .config import DATA_DIR, load_params
from .dashboard import think
from .engine import Engine
from .strategy import btc_regime, checklist, compute_indicators
from .util import ts_iso, utc_day

BTC = "BTC-USDT"
WARMUP = 60  # candles needed before the indicators are meaningful


def build_replay(cfg, hist, params):
    """hist: {symbol: [Candle]} (BTC may be included as context only). Returns a compact,
    JSON-ready recording: one frame per candle with each coin's state + the vault balance."""
    eng = Engine(cfg, params, mode="replay")
    symbols = [s for s in cfg["symbols"] if hist.get(s)]
    inds = {s: compute_indicators(hist[s], params) for s in hist}
    btc = btc_regime(hist[BTC], params) if hist.get(BTC) else {}
    index = {s: {c.ts: i for i, c in enumerate(hist[s])} for s in symbols}
    timeline = sorted({c.ts for s in symbols for c in hist[s]})
    first_ok = max(hist[s][min(WARMUP, len(hist[s]) - 1)].ts for s in symbols)
    timeline = [t for t in timeline if t >= first_ok]

    rules = {}
    trades, frames, earned, last_thought = [], [], {s: 0.0 for s in symbols}, {}
    seen = 0
    for ts in timeline:
        ctx = {"btc_up": btc.get(ts)}
        for s in symbols:
            i = index[s].get(ts)
            if i is not None:
                eng.on_bar(s, hist[s], inds[s], i, ctx=ctx)
        for t in eng.closed[seen:]:
            earned[t.symbol] += t.net_pnl
            trades.append({"id": t.id, "symbol": t.symbol, "side": t.side, "pnl": round(t.net_pnl, 4),
                           "r": round(t.r_multiple, 3), "how": t.exit_reason, "entry_time": ts_iso(t.entry_ts),
                           "exit_time": ts_iso(t.exit_ts), "day": utc_day(t.exit_ts)})
        seen = len(eng.closed)
        prices, workers = {}, []
        for s in symbols:
            cs = hist[s]
            i = index[s].get(ts)
            if i is None:  # no candle for this coin at this time: use its latest earlier candle
                i = max(k for k, c in enumerate(cs) if c.ts <= ts)
            items = checklist(cs, inds[s], i, params, ctx)
            rules.setdefault(s, [x["name"] for x in items])
            pos = eng.positions.get(s)
            kind, text = think(s, items, pos, eng, ts)
            px = cs[i].c
            prices[s] = px
            w = {"k": kind, "c": [1 if x["ok"] else 0 for x in items], "p": px, "e": round(earned[s], 4)}
            if pos:
                w["pos"] = {"side": "LONG" if pos.side > 0 else "SHORT",
                            "upnl": round((px - pos.entry_price) * pos.side * pos.qty + pos.partial_pnl, 4)}
            if last_thought.get(s) != text:  # thoughts only when they change (keeps the file small)
                w["th"] = text
                last_thought[s] = text
            workers.append(w)
        frames.append({"t": ts_iso(ts), "eq": round(eng.equity(prices), 4), "k": len(trades), "w": workers})

    return {
        "generated_at": ts_iso(int(time.time() * 1000)), "timeframe": cfg["timeframe"],
        "start_balance": cfg["starting_balance"], "symbols": symbols,
        "names": [s.split("-")[0] for s in symbols], "rules": [rules.get(s, []) for s in symbols],
        "trades": trades, "frames": frames,
    }


class ReplayProvider:
    """Builds the replay once (in the background) and caches it for 6 hours."""

    def __init__(self, cfg, demo=False):
        self.cfg, self.demo = cfg, demo
        self.path = os.path.join(DATA_DIR, "replay.json")
        self.lock = threading.Lock()
        self.building = False
        self.error = None

    def _hist(self):
        if self.demo:
            from .data import synthetic_candles
            return {s: synthetic_candles(900, seed=35 + i, start_price=[60000, 3000, 150, 1.0, 0.5][i % 5],
                                         bar=self.cfg["timeframe"]) for i, s in enumerate(self.cfg["symbols"])}
        from .data import BloFinData, get_history
        client, total = BloFinData(), self.cfg["learning"]["history_bars"]
        hist = {s: get_history(client, s, self.cfg["timeframe"], total) for s in self.cfg["symbols"]}
        if BTC not in hist:
            hist[BTC] = get_history(client, BTC, self.cfg["timeframe"], total)
        return hist

    def _build(self):
        try:
            params, _ = load_params(self.cfg)
            data = build_replay(self.cfg, self._hist(), params)
            data["demo"] = self.demo
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, self.path)
            self.error = None
        except Exception as e:  # shown in the dashboard instead of crashing the server
            self.error = str(e)
        finally:
            self.building = False

    def get(self):
        """Returns (status_code, bytes). 202 while building."""
        fresh = os.path.exists(self.path) and time.time() - os.path.getmtime(self.path) < 6 * 3600
        if fresh:
            with open(self.path, "rb") as f:
                return 200, f.read()
        with self.lock:
            if self.error and not self.building:
                err, self.error = self.error, None
                return 500, json.dumps({"error": f"Replay failed: {err}"}).encode()
            if not self.building:
                self.building = True
                threading.Thread(target=self._build, daemon=True).start()
        return 202, b'{"building": true}'
