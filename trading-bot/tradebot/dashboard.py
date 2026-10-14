"""Live dashboard ("Bot City" style): each coin is a worker with a status, a rule checklist,
a '% charged' meter, a thoughts feed and a payroll. The bot writes data/dashboard.json every
tick; `python run.py dashboard` serves it at http://127.0.0.1:8050."""
import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from .backtest import stats
from .config import DATA_DIR, PARAMS_FILE, ROOT
from .strategy import checklist
from .util import ts_iso, utc_day

STATIC_DIR = os.path.join(ROOT, "dashboard")
SNAPSHOT = os.path.join(DATA_DIR, "dashboard.json")

EXIT_LABELS = {
    "take_profit": "hit profit target",
    "stop_loss": "stopped out",
    "stop_loss_gap": "stopped out (gap)",
    "protected_stop": "profit protected (stop)",
    "protected_stop_gap": "profit protected (gap)",
    "signal_exit": "UT Bot sell",
    "time_exit": "time limit",
    "end_of_test": "end of test",
}


def exit_label(reason):
    base, _, extra = reason.partition("+")
    label = EXIT_LABELS.get(base, base.replace("_", " "))
    return label + (" + partial profit" if extra == "partial" else "")


def fp(v):
    """Readable price: 64,975.91 / 185.755 / 0.4821."""
    return f"{v:,.2f}" if v >= 1000 else f"{v:.3f}" if v >= 1 else f"{v:.4g}"


# ------------------------------------------------------------------ thoughts
def think(symbol, items, position, engine, bar_ts):
    """One plain-English line describing what this worker is doing right now."""
    met = sum(1 for x in items if x["ok"])
    total = len(items) or 1
    if engine.halted:
        return "halted", "kill switch on - not opening trades until reviewed"
    if position:
        d = "LONG" if position.side > 0 else "SHORT"
        return "manage", (f"holding {d} from {fp(position.entry_price)} - stop {fp(position.stop)}, "
                          f"target {fp(position.target)}")
    if bar_ts < engine.pause_until:
        return "pause", f"cooling off after a losing streak until {ts_iso(engine.pause_until)} UTC"
    if engine.daily_loss_hit():
        return "pause", "daily loss limit reached - done for today"
    missing = [x["name"] for x in items if not x["ok"]]
    if met == total:
        return "fire", "all rules lined up - entry signal"
    if met >= total - 1:
        return "setup", f"setup forming: {met}/{total} rules met, waiting on {missing[0]}"
    return "scan", f"scanning: {met}/{total} rules met - missing {', '.join(missing)}"


# ------------------------------------------------------------------ snapshot
def build_snapshot(cfg, engine, journal, market, now_ms=None, demo=False, health=None):
    """market: {symbol: {"candles": [...], "ind": {...}, "ctx": {...}}} for the latest closed bar."""
    now_ms = now_ms or int(time.time() * 1000)
    today = utc_day(now_ms)
    start = cfg["starting_balance"]
    trades = journal.trades()
    prices = {s: m["candles"][-1].c for s, m in market.items() if m.get("candles")}
    equity = engine.equity(prices)

    by_day = {}
    for t in trades:
        by_day[utc_day(t["exit_ts"])] = by_day.get(utc_day(t["exit_ts"]), 0.0) + t["net_pnl"]
    days = sorted(by_day)[-14:]

    workers = []
    for slot, sym in enumerate(cfg["symbols"]):
        m = market.get(sym) or {}
        cs = m.get("candles") or []
        tt = [t for t in trades if t["symbol"] == sym]
        td = [t for t in tt if utc_day(t["exit_ts"]) == today]
        pos = engine.positions.get(sym)
        items = checklist(cs, m["ind"], len(cs) - 1, engine.p, m.get("ctx")) if cs and m.get("ind") else []
        kind, thought = think(sym, items, pos, engine, cs[-1].ts if cs else now_ms)
        status = {"halted": "Halted", "manage": "In a trade", "pause": "Paused",
                  "fire": "Firing", "setup": "Setup forming", "scan": "Scanning"}[kind]
        card = None
        if pos and cs:
            px = cs[-1].c
            upnl = (px - pos.entry_price) * pos.side * pos.qty + pos.partial_pnl
            card = {"side": "LONG" if pos.side > 0 else "SHORT", "entry": pos.entry_price, "stop": pos.stop,
                    "target": pos.target, "price": px, "upnl": upnl,
                    "r": upnl / (pos.risk_per_unit * (pos.orig_qty or pos.qty)),
                    "since": ts_iso(pos.entry_ts), "bars": pos.bars_held,
                    "progress": max(0.0, min(1.0, (px - pos.stop) / (pos.target - pos.stop)))
                    if pos.target != pos.stop else 0.5}
        workers.append({
            "symbol": sym, "name": sym.split("-")[0], "slot": slot + 1,
            "status": status, "status_kind": kind, "thought": thought,
            "price": cs[-1].c if cs else None,
            "change_pct": (cs[-1].c / cs[-2].c - 1) * 100 if len(cs) > 1 else 0.0,
            "spark": [c.c for c in cs[-60:]],
            "checklist": items, "charge": (sum(x["ok"] for x in items) / len(items)) if items else 0.0,
            "position": card,
            "today": {"trades": len(td), "wins": sum(1 for t in td if t["net_pnl"] > 0),
                      "earned": sum(t["net_pnl"] for t in td)},
            "all": {"trades": len(tt), "wins": sum(1 for t in tt if t["net_pnl"] > 0),
                    "earned": sum(t["net_pnl"] for t in tt)},
        })

    st = stats(trades, start)
    curve = [(trades[0]["entry_ts"], start)] if trades else []
    bal = start
    for t in trades:
        bal += t["net_pnl"]
        curve.append((t["exit_ts"], round(bal, 4)))

    thoughts = journal.events(60)
    return {
        "generated_at": ts_iso(int(time.time() * 1000)) + " UTC",
        "market_time": ts_iso(now_ms) + " UTC",
        "demo": demo,
        "mode": cfg["mode"], "timeframe": cfg["timeframe"],
        "strategy": engine.p.get("name"), "version": engine.pv,
        "vault": {"equity": equity, "balance": engine.balance, "start": start,
                  "return_pct": (equity / start - 1) * 100, "today": by_day.get(today, 0.0),
                  "peak": engine.peak, "drawdown_pct": (1 - engine.balance / engine.peak) * 100 if engine.peak else 0,
                  "win_rate": st["win_rate"], "trades": st["trades"], "max_dd_pct": st["max_dd_pct"],
                  "open": len(engine.positions)},
        "guards": {"halted": engine.halted, "halt_reason": engine.halt_reason,
                   "paused_until": ts_iso(engine.pause_until) if engine.pause_until > now_ms else None,
                   "daily_loss_hit": engine.daily_loss_hit()},
        "workers": workers,
        "daily": [{"day": d, "pnl": round(by_day[d], 4)} for d in days],
        "curve": curve,
        "trades": [{
            "id": t["id"], "symbol": t["symbol"], "side": t["side"], "pnl": t["net_pnl"], "r": t["r_multiple"],
            "entry": t["entry_price"], "exit": t["exit_price"], "entry_time": ts_iso(t["entry_ts"]),
            "exit_time": ts_iso(t["exit_ts"]), "bars": t["bars_held"], "how": exit_label(t["exit_reason"]),
            "best_r": t["mfe_r"],
        } for t in reversed(trades[-12:])],
        "thoughts": [{"time": ts_iso(e["ts"]), "kind": e["kind"], "message": e["message"]} for e in thoughts],
        "health": _health(cfg, market, health, now_ms),
        "lab": _lab(cfg, engine, trades),
        "memory": _memory(engine),
    }


def _memory(engine):
    from .memory import Memory
    try:
        return (engine.memory or Memory()).summary()
    except Exception:  # never let the notebook break the dashboard
        return None


def _health(cfg, market, health, now_ms):
    """Pipeline status for the DATA view (BloFin -> candles -> ... -> learner)."""
    from .util import BAR_MS
    h = dict(health or {})
    bar_ms = BAR_MS[cfg["timeframe"]]
    feeds = {}
    for s in cfg["symbols"]:
        cs = (market.get(s) or {}).get("candles") or []
        last = cs[-1].ts if cs else None
        feeds[s.split("-")[0]] = {"last_candle": ts_iso(last) if last else None, "bars": len(cs),
                                  "fresh": bool(last) and (now_ms - (last + bar_ms)) < 2 * bar_ms}
    h["feeds"] = feeds
    h.setdefault("errors", [])
    h["snapshot_at"] = int(time.time() * 1000)
    return h


def _lab(cfg, engine, trades):
    """Strategy-lab numbers: stats, drawdown, result histogram, rules and their history."""
    start = cfg["starting_balance"]
    st = {k: (None if isinstance(v, float) and v == float("inf") else v)
          for k, v in stats(trades, start).items()}
    bal = peak = start
    dd = []
    for t in trades:
        bal += t["net_pnl"]
        peak = max(peak, bal)
        dd.append(round((bal / peak - 1) * 100, 3))
    months = {}
    for t in trades:
        m = ts_iso(t["exit_ts"])[:7]
        months[m] = months.get(m, 0.0) + t["net_pnl"]
    L = cfg.get("learning", {})
    keys = list(L.get("tunable", {})) + list(L.get("toggles", []))
    versions = []
    if os.path.exists(PARAMS_FILE):
        try:
            with open(PARAMS_FILE) as f:
                versions = [{"version": v["version"], "at": v.get("adopted_at"), "reason": v.get("reason")}
                            for v in json.load(f).get("versions", [])][-10:]
        except (OSError, ValueError):
            versions = []
    log_path = os.path.join(DATA_DIR, "learning_log.md")
    learning = ""
    if os.path.exists(log_path):
        with open(log_path) as f:
            learning = f.read()[-4000:]
    return {"stats": st, "r": [round(t["r_multiple"], 3) for t in trades], "drawdown": dd,
            "months": [{"month": m, "pnl": round(v, 4)} for m, v in sorted(months.items())],
            "params": {k: engine.p.get(k) for k in keys}, "version": engine.pv,
            "versions": versions, "learning": learning, "risk": cfg["risk"]}


def write_snapshot(snap, path=SNAPSHOT):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(snap, f, default=float)
    os.replace(tmp, path)


class ThoughtLog:
    """Logs a worker's thought to the journal only when it changes (keeps the feed readable)."""

    def __init__(self, journal):
        self.journal = journal
        self.last = {}

    def update(self, symbol, kind, text, ts):
        if self.last.get(symbol) != text:
            self.last[symbol] = text
            self.journal.event("thought", f"{symbol.split('-')[0]}: {text}", ts)


# ------------------------------------------------------------------ server
def serve(host="127.0.0.1", port=8050, snapshot_path=SNAPSHOT, replay=None):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=STATIC_DIR, **kw)

        def do_GET(self):
            if self.path.split("?")[0] == "/api/replay":
                code, body = replay.get() if replay else (404, b'{"error": "replay not available"}')
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.split("?")[0] == "/api/state":
                try:
                    with open(snapshot_path, "rb") as f:
                        body = f.read()
                    self.send_response(200)
                except FileNotFoundError:
                    body = b'{"error": "no data yet - start the bot with: python run.py run"}'
                    self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Dashboard: http://{host}:{port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# ------------------------------------------------------------------ demo
def build_demo(cfg, seed=35):
    """A dashboard snapshot from SIMULATED prices so you can see it without the bot running."""
    from .data import synthetic_candles
    from .engine import Engine
    from .journal import Journal
    from .strategy import btc_regime, compute_indicators
    from .config import load_params

    from .memory import Memory
    params, v = load_params(cfg)
    path = os.path.join(DATA_DIR, "journal.db")
    if os.path.exists(path):
        os.remove(path)
    for stale in ("memory.json", "params.json", "learning_log.md"):
        if os.path.exists(os.path.join(DATA_DIR, stale)):
            os.remove(os.path.join(DATA_DIR, stale))
    hist = {s: synthetic_candles(900, seed=seed + i, start_price=[60000, 3000, 150, 1.0, 0.5][i % 5],
                                 bar=cfg["timeframe"])
            for i, s in enumerate(cfg["symbols"])}

    # 1) learn from a longer stretch of (simulated) history first, so the Memory Keeper has
    #    a notebook of past mistakes before the demo account starts trading
    memory = Memory()
    learned = False
    try:
        from .config import save_new_params
        from .learner import improve
        older = {s: synthetic_candles(3000, seed=5 * 7 + i, start_price=[60000, 3000, 150, 1.0, 0.5][i % 5],
                                      bar=cfg["timeframe"]) for i, s in enumerate(cfg["symbols"])}
        new_params, rep = improve(cfg, params, older, memory=memory)
        learned = True
        if rep["changes"]:
            v = save_new_params(new_params, "; ".join(c["change"] for c in rep["changes"]), rep["changes"])
            params = new_params
        for p in memory.data["patterns"].values():  # patterns count as "found" before the demo trades
            p["first_seen"] = hist[cfg["symbols"][0]][60].ts
        memory.save()
    except Exception:
        pass

    # 2) trade the demo account with those rules and that memory
    j = Journal(path)
    j.event("start", "DEMO: simulated $100 paper account opened", 0)
    eng = Engine(cfg, params, v, journal=j, mode="paper", memory=memory)
    inds = {s: compute_indicators(c, params) for s, c in hist.items()}
    btc = btc_regime(hist["BTC-USDT"], params) if "BTC-USDT" in hist else {}
    tl = ThoughtLog(j)
    n = min(len(c) for c in hist.values())
    for i in range(60, n):
        for s, cs in hist.items():
            ctx = {"btc_up": btc.get(cs[i].ts)}
            eng.on_bar(s, cs, inds[s], i, ctx=ctx)
            if i > n - 30:
                kind, text = think(s, checklist(cs, inds[s], i, params, ctx), eng.positions.get(s), eng, cs[i].ts)
                tl.update(s, kind, text, cs[i].ts)
    market = {s: {"candles": cs[:n], "ind": inds[s], "ctx": {"btc_up": btc.get(cs[n - 1].ts)}}
              for s, cs in hist.items()}
    t_end = hist[cfg["symbols"][0]][n - 1].ts
    health = {"started": ts_iso(hist[cfg["symbols"][0]][60].ts), "last_fetch_ok": t_end, "last_tick": t_end,
              "ticks": n - 60, "errors": [],
              "last_learn": t_end if learned else None}
    return build_snapshot(cfg, eng, j, market, now_ms=t_end, demo=True, health=health)
