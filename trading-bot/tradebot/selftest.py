"""Safety self-test: `python3 run.py selftest`.

Acts out the things that go wrong with trading bots and checks the bot reacts safely:
stale prices, the same candle arriving twice, a restart in the middle of a trade, the
exchange going down, gaps through a stop, the kill switch, the daily loss limit, market
mode RED, UTC day changes, paper-only mode and position sizing.

Uses simulated prices and its own data folder. It never sends alerts and never touches
your paper account.
"""
import copy
import os
import shutil

from .config import DATA_DIR
from .data import synthetic_candles
from .engine import Engine
from .models import Candle, Position
from .regime import contexts, ctx_at
from .strategy import compute_indicators, signal_at

DAY = 86_400_000
GREEN = {"btc_up": True, "market": "GREEN", "market_why": "test"}
RED = {"btc_up": True, "market": "RED", "market_why": "BTC -8.0% in 1 candle (test)"}


def _quiet(cfg):
    cfg = copy.deepcopy(cfg)
    cfg["reports"] = {"every_hours": 24}          # no phone alerts from a test, ever
    cfg["learning"]["enabled"] = False
    cfg["claude_review"] = {"enabled": False}
    cfg["symbols"] = ["BTC-USDT"]
    return cfg


SCRATCH = ("state.json", "journal.db", "memory.json", "skips.json", "dashboard.json", "trades.csv",
           "bot.log", "heartbeat", "report.html", "learning_log.md", "weekly_reviews.md", "params.json")


def _safe_dir():
    """The self-test resets its folder between checks, so it must NEVER run in the real account
    folder (trading-bot/data). run.py points it at data/selftest."""
    from .config import ROOT
    real = os.path.realpath(os.path.join(ROOT, "data"))
    here = os.path.realpath(DATA_DIR)
    if here == real or not (os.path.basename(here) == "selftest" or os.environ.get("TRADEBOT_SELFTEST_DIR_OK")):
        raise SystemExit(f"Refusing to run the self-test in {DATA_DIR} - it would reset that folder. "
                         f"Run it with: python3 run.py selftest")


def _wipe():
    """Reset only the files this test itself creates."""
    _safe_dir()
    for name in SCRATCH:
        p = os.path.join(DATA_DIR, name)
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(os.path.join(DATA_DIR, "candles"), ignore_errors=True)


def _signal_series(cfg):
    """Simulated daily candles + the index of a candle where the rules fire (market GREEN)."""
    p = cfg["strategy"]
    for seed in range(1, 80):
        cs = synthetic_candles(900, seed=seed, start_price=100.0, bar=cfg["timeframe"])
        ind = compute_indicators(cs, p)
        ctxs = contexts(cs, p, cfg)
        for i in range(650, len(cs) - 5):
            ctx = ctx_at(ctxs, cs[i].ts)
            if ctx["market"] == "GREEN" and signal_at(cs, ind, i, p, ctx):
                return cs, i
    raise RuntimeError("no test signal found")


class _Fake:
    """Pretend exchange that serves candles up to index n (or fails when told to)."""

    def __init__(self, candles, n):
        self.c, self.n, self.fail, self.calls, self.on_call = candles, n, False, 0, None

    def _maybe_fail(self):
        self.calls += 1
        if self.on_call:
            self.on_call(self.calls)
        if self.fail:
            raise RuntimeError("BloFin request failed: connection timed out (simulated)")

    def candles(self, inst, bar, limit=300, after=None):
        self._maybe_fail()
        return self.c[:self.n + 1][-limit:]

    def history(self, inst, bar, total):
        self._maybe_fail()
        return self.c[:self.n + 1][-total:]


def _bot(cfg, fake):
    from .runner import PaperBot
    return PaperBot(cfg, client=fake)


def _at(candles, i, extra_ms=60_000):
    """A clock reading just after candle i closed."""
    return (candles[i].ts + DAY + extra_ms) / 1000


def _tick(bot, now_s):
    import tradebot.runner as r
    real = r.time.time
    r.time.time = lambda: now_s
    try:
        bot.tick()
    finally:
        r.time.time = real


def _engine(cfg, **risk):
    c = copy.deepcopy(cfg)
    c["risk"].update(risk)
    return Engine(c, copy.deepcopy(c["strategy"]))


def _pos(eng, entry=100.0, stop=95.0, target=115.0, qty=0.2):
    p = Position(id="t", symbol="X", side=1, entry_ts=0, entry_price=entry, qty=qty, stop=stop,
                 initial_stop=stop, target=target, risk_per_unit=entry - stop, atr=2.0, params_version=0,
                 best_price=entry, worst_price=entry, orig_qty=qty)
    eng.positions["X"] = p
    return p


# ---------------------------------------------------------------------------- the checks
def check_stale_prices(cfg, cs, i):
    _wipe()
    bot = _bot(cfg, _Fake(cs, i))
    _tick(bot, _at(cs, i) + 3 * DAY / 1000)   # the newest candle is 3 days old
    opened = bool(bot.engine.positions)
    warned = bot.meta.get("stale") == ["BTC"]
    _wipe()
    bot2 = _bot(cfg, _Fake(cs, i))
    _tick(bot2, _at(cs, i))                   # same candles, but fresh
    ok = (not opened) and warned and bool(bot2.engine.positions)
    return ok, ("old prices: no trade + warning sent; fresh prices: trade opened" if ok else
                f"stale opened={opened} warned={warned} fresh opened={bool(bot2.engine.positions)}")


def check_duplicate_candle(cfg, cs, i):
    _wipe()
    bot = _bot(cfg, _Fake(cs, i))
    for _ in range(3):
        _tick(bot, _at(cs, i))
    n_open, n_closed = len(bot.engine.positions), len(bot.engine.closed)
    ok = n_open == 1 and n_closed == 0
    return ok, ("the same candle 3 times -> exactly 1 trade" if ok else f"{n_open} open, {n_closed} closed")


def check_restart_mid_trade(cfg, cs, i):
    _wipe()
    fake = _Fake(cs, i)
    bot = _bot(cfg, fake)
    _tick(bot, _at(cs, i))
    before = {k: (p.entry_price, p.qty, p.stop) for k, p in bot.engine.positions.items()}
    bal = bot.engine.balance
    bot2 = _bot(cfg, fake)                    # "crash" and start again
    _tick(bot2, _at(cs, i))
    after = {k: (p.entry_price, p.qty, p.stop) for k, p in bot2.engine.positions.items()}
    ok = bool(before) and before == after and abs(bot2.engine.balance - bal) < 1e-9
    return ok, ("restart picked up the same open trade, nothing doubled" if ok else f"before {before} after {after}")


def check_exchange_down(cfg, cs, i):
    _wipe()
    fake = _Fake(cs, i)
    bot = _bot(cfg, fake)
    _tick(bot, _at(cs, i))
    held = dict(bot.engine.positions)
    fake.fail, fake.calls = True, 0

    def stop_after(n):
        if n >= 3:
            bot._stop = True
    fake.on_call = stop_after
    import tradebot.runner as r
    real_sleep = r.time.sleep
    r.time.sleep = lambda s: None
    try:
        bot.run_forever(poll_seconds=1)       # must survive the errors, not crash
    finally:
        r.time.sleep = real_sleep
    errs = len(bot.health["errors"])
    ok = errs >= 1 and set(bot.engine.positions) == set(held)
    return ok, (f"{errs} connection errors logged, bot kept running, open trade untouched" if ok else
                f"errors={errs} positions={list(bot.engine.positions)}")


def check_gap_through_stop(cfg, *_):
    eng = _engine(cfg)
    _pos(eng)
    eng._manage(eng.positions["X"], Candle(DAY, 90, 91, 88, 90), 2.0)
    t = eng.closed[-1] if eng.closed else None
    ok = bool(t) and t.exit_reason == "stop_loss_gap" and t.exit_price < 90
    return ok, ("price opened below the stop -> sold at the (worse) open, not the stop" if ok else str(t))


def check_kill_switch(cfg, cs, i):
    eng = _engine(cfg)
    n = 0
    while not eng.halted and n < 40:
        n += 1
        p = _pos(eng, qty=eng.balance * 0.05 / 5)   # 5% of the account lost per trade
        p.entry_ts = n * DAY
        eng._manage(p, Candle((n + 1) * DAY, 94, 94, 93, 94), 2.0)
    ind = compute_indicators(cs, cfg["strategy"])
    eng.on_bar("BTC-USDT", cs, ind, i, ctx=GREEN)
    dd = (1 - eng.balance / eng.peak) * 100
    ok = eng.halted and "BTC-USDT" not in eng.positions and dd >= cfg["risk"]["max_drawdown_pct"]
    return ok, (f"stopped opening trades at {dd:.1f}% below peak (limit {cfg['risk']['max_drawdown_pct']:.0f}%)"
                if ok else f"halted={eng.halted} dd={dd:.1f}%")


def check_daily_loss_limit(cfg, cs, i):
    eng = _engine(cfg, pause_after_consecutive_losses=0)
    eng._roll_day(cs[i].ts)
    eng.balance = eng.day_start_balance * (1 - cfg["risk"]["daily_loss_limit_pct"] / 100) - 0.01
    ind = compute_indicators(cs, cfg["strategy"])
    eng.on_bar("BTC-USDT", cs, ind, i, ctx=GREEN)
    skipped = any(s["reason"] == "daily_loss" for s in eng.skips.items)
    ok = "BTC-USDT" not in eng.positions and skipped
    return ok, (f"down {cfg['risk']['daily_loss_limit_pct']:.0f}% today -> setup skipped, no trade" if ok else
                f"positions={list(eng.positions)}")


def check_market_red(cfg, cs, i):
    eng = _engine(cfg)
    ind = compute_indicators(cs, cfg["strategy"])
    eng.on_bar("BTC-USDT", cs, ind, i, ctx=RED)
    blocked = "BTC-USDT" not in eng.positions and any(s["reason"] == "market_red" for s in eng.skips.items)
    eng2 = _engine(cfg)
    p = _pos(eng2, entry=100, stop=90, target=130)
    eng2._manage(p, Candle(DAY, 101, 103, 100, 102), 2.0, red=True)
    tightened = p.stop > 90
    s1 = p.stop
    eng2._manage(p, Candle(2 * DAY, 101, 101, 99, 99.5), 2.0, red=True)
    never_loosens = p.stop >= s1
    ok = blocked and tightened and never_loosens
    return ok, ("Bitcoin dumping -> setup skipped; open trade's stop pulled up and never moved down" if ok else
                f"blocked={blocked} tightened={tightened} never_loosens={never_loosens}")


def check_utc_day(cfg, *_):
    eng = _engine(cfg)
    midnight = 1_700_006_400_000          # 2023-11-15 00:00 UTC
    eng._roll_day(midnight - 60_000)
    eng.balance = 90.0
    eng._roll_day(midnight - 1_000)       # still the same UTC day
    same = eng.day_start_balance == 100.0
    eng._roll_day(midnight + 1_000)       # new UTC day
    ok = same and eng.day_start_balance == 90.0
    return ok, ("daily loss limit resets at midnight UTC, not before" if ok else
                f"day start balance {eng.day_start_balance}")


def check_paper_only(cfg, *_):
    from .config import load_config
    import json
    import tempfile
    live = copy.deepcopy(cfg)
    live["mode"] = "live"
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(live, f)
    try:
        load_config(path)
        ok = False
    except SystemExit:
        ok = True
    finally:
        os.remove(path)
    return ok, ("asking for real-money mode is refused - paper only" if ok else "live mode was accepted!")


def check_position_size(cfg, cs, i):
    eng = _engine(cfg)
    ind = compute_indicators(cs, cfg["strategy"])
    eng.on_bar("BTC-USDT", cs, ind, i, ctx=GREEN)
    p = eng.positions.get("BTC-USDT")
    if not p:
        return False, "no trade opened"
    risk = p.risk_per_unit * p.qty
    notional = p.qty * p.entry_price
    limit = 100.0 * cfg["risk"]["risk_per_trade_pct"] / 100 + 1e-6
    cap = 100.0 * cfg["risk"]["max_leverage"] / cfg["risk"]["max_open_positions"] + 1e-6
    ok = risk <= limit and notional <= cap
    return ok, (f"risks ${risk:.2f} (max ${limit:.2f}), position ${notional:.2f} (max ${cap:.2f}, no leverage)"
                if ok else f"risk ${risk:.2f} notional ${notional:.2f}")


CHECKS = [
    ("Old (stale) prices never trigger a trade", check_stale_prices),
    ("Same candle twice never doubles a trade", check_duplicate_candle),
    ("Restart in the middle of a trade", check_restart_mid_trade),
    ("Exchange down / timeouts", check_exchange_down),
    ("Price gaps through the stop", check_gap_through_stop),
    ("Kill switch at 20% drawdown", check_kill_switch),
    ("Daily loss limit", check_daily_loss_limit),
    ("Market mode RED (Bitcoin crash)", check_market_red),
    ("Day boundary is UTC midnight", check_utc_day),
    ("Paper money only", check_paper_only),
    ("Position size: 1% risk, no leverage", check_position_size),
]


def run_all(cfg):
    cfg = _quiet(cfg)
    _safe_dir()
    os.makedirs(DATA_DIR, exist_ok=True)
    cs, i = _signal_series(cfg)
    import tradebot.runner as r
    real_log = r.log
    r.log = lambda msg: None  # the simulated errors are expected - keep the output readable
    results = []
    try:
        for name, fn in CHECKS:
            try:
                ok, detail = fn(cfg, cs, i)
            except Exception as e:  # a crash is a failure, with the reason
                ok, detail = False, f"crashed: {e}"
            results.append((name, ok, detail))
    finally:
        r.log = real_log
        _wipe()
    return results
