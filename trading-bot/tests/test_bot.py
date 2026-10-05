import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

TMP = tempfile.mkdtemp(prefix="tradebot-test-")
os.environ["TRADEBOT_DATA_DIR"] = TMP
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tradebot.backtest import run_backtest  # noqa: E402
from tradebot.config import load_config  # noqa: E402
from tradebot.data import synthetic_candles  # noqa: E402
from tradebot.engine import Engine  # noqa: E402
from tradebot.indicators import atr, ema, rsi  # noqa: E402
from tradebot.learner import candidates, improve, loss_autopsy  # noqa: E402
from tradebot.models import Candle, Position  # noqa: E402
from tradebot.strategy import compute_indicators, signal_at  # noqa: E402

CFG = load_config()


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


class Indicators(unittest.TestCase):
    def test_ema_constant_series(self):
        out = ema([5.0] * 30, 10)
        self.assertIsNone(out[8])
        self.assertAlmostEqual(out[-1], 5.0)

    def test_rsi_bounds(self):
        up = rsi([float(i) for i in range(50)], 14)
        self.assertEqual(up[-1], 100.0)
        mixed = rsi([10, 11, 10, 11, 10, 11] * 10, 14)
        self.assertTrue(40 < mixed[-1] < 60)

    def test_atr_positive(self):
        c = synthetic_candles(100)
        a = atr([x.h for x in c], [x.l for x in c], [x.c for x in c], 14)
        self.assertTrue(all(v > 0 for v in a[14:]))


def _engine(**risk):
    cfg = copy.deepcopy(CFG)
    cfg["risk"].update(risk)
    return Engine(cfg, copy.deepcopy(cfg["strategy"]))


def _pos(eng, side=1, entry=100.0, stop=98.0, target=104.0, qty=0.5):
    p = Position(id="t", symbol="X", side=side, entry_ts=0, entry_price=entry, qty=qty, stop=stop,
                 initial_stop=stop, target=target, risk_per_unit=abs(entry - stop), atr=1.0,
                 params_version=0, best_price=entry, worst_price=entry)
    eng.positions["X"] = p
    return p


class EngineRules(unittest.TestCase):
    def test_stop_assumed_before_target_when_both_touched(self):
        eng = _engine()
        _pos(eng)
        eng._manage(eng.positions["X"], Candle(3_600_000, 100, 105, 97, 101), 1.0)
        self.assertEqual(eng.closed[-1].exit_reason, "stop_loss")
        self.assertLess(eng.closed[-1].net_pnl, 0)

    def test_gap_through_stop_fills_at_open(self):
        eng = _engine()
        _pos(eng)
        eng._manage(eng.positions["X"], Candle(3_600_000, 95, 96, 94, 95), 1.0)
        self.assertEqual(eng.closed[-1].exit_reason, "stop_loss_gap")
        self.assertLess(eng.closed[-1].exit_price, 95.0)

    def test_short_target(self):
        eng = _engine()
        _pos(eng, side=-1, entry=100, stop=102, target=96)
        eng._manage(eng.positions["X"], Candle(3_600_000, 99, 99.5, 95.5, 96), 1.0)
        t = eng.closed[-1]
        self.assertEqual(t.exit_reason, "take_profit")
        self.assertGreater(t.net_pnl, 0)
        self.assertAlmostEqual(t.r_multiple, 2.0, delta=0.15)

    def test_breakeven_moves_stop(self):
        eng = _engine()
        p = _pos(eng)
        eng._manage(p, Candle(3_600_000, 100, 102.2, 99.5, 101.5), 1.0)  # +1.1R, no exit
        self.assertTrue(p.breakeven_moved)
        self.assertGreater(p.stop, 100.0)

    def test_risk_per_trade_is_respected(self):
        cfg = copy.deepcopy(CFG)
        res = run_backtest(cfg, cfg["strategy"], {"A": synthetic_candles(2500, seed=3)})
        self.assertGreater(len(res["trades"]), 5)
        for t in res["trades"]:
            if t.exit_reason.startswith("stop_loss") and not t.exit_reason.endswith("gap"):
                # balance before the trade ~ balance_after - net; loss should be ~1% (+fees/slippage)
                before = t.balance_after - t.net_pnl
                self.assertLess(-t.net_pnl / before * 100, 1.5)

    def test_kill_switch_halts_entries(self):
        eng = _engine(max_drawdown_pct=5.0, pause_after_consecutive_losses=0)
        for _ in range(8):
            _pos(eng, qty=1.0)
            eng._manage(eng.positions["X"], Candle(3_600_000, 100, 100, 97, 97), 1.0)
        self.assertTrue(eng.halted)
        c = synthetic_candles(600, seed=5)
        ind = compute_indicators(c, eng.p)
        for i in range(250, 600):
            eng.on_bar("Y", c, ind, i)
        self.assertNotIn("Y", eng.positions)

    def test_pause_after_losing_streak(self):
        eng = _engine(pause_after_consecutive_losses=3, pause_bars=24, max_drawdown_pct=100)
        for _ in range(3):
            _pos(eng, qty=0.1)
            eng._manage(eng.positions["X"], Candle(3_600_000, 100, 100, 97, 97), 1.0)
        self.assertEqual(eng.pause_until, 3_600_000 + 24 * 3_600_000)

    def test_state_roundtrip(self):
        eng = _engine()
        _pos(eng)
        eng.balance = 123.0
        s = json.loads(json.dumps(eng.to_state()))
        eng2 = _engine()
        eng2.load_state(s)
        self.assertEqual(eng2.balance, 123.0)
        self.assertEqual(eng2.positions["X"].entry_price, 100.0)


class NewRules(unittest.TestCase):
    def test_partial_take_profit_accounting(self):
        eng = _engine()
        eng.p["partial_tp_r"], eng.p["partial_tp_pct"] = 1.0, 50
        p = _pos(eng, qty=1.0)
        p.orig_qty = 1.0
        start = eng.balance
        eng._manage(p, Candle(3_600_000, 100, 102.5, 99.5, 102), 1.0)  # hits +1R -> bank half
        self.assertTrue(p.partial_done)
        self.assertAlmostEqual(p.qty, 0.5)
        eng._manage(p, Candle(7_200_000, 102, 104.5, 101.5, 104), 1.0)  # target on the rest
        t = eng.closed[-1]
        self.assertEqual(t.exit_reason, "take_profit+partial")
        self.assertAlmostEqual(t.qty, 1.0)
        self.assertAlmostEqual(t.gross_pnl, 0.5 * 2 + 0.5 * 4)
        self.assertAlmostEqual(t.r_multiple, t.net_pnl / 2.0)

    def test_btc_filter_blocks_altcoin_long_in_btc_downtrend(self):
        p = copy.deepcopy(CFG["strategy"])
        c = synthetic_candles(3000, seed=2)
        ind = compute_indicators(c, p)
        idx = [i for i in range(250, 3000) if signal_at(c, ind, i, p)]
        self.assertTrue(idx)
        p["btc_filter"] = True
        for i in idx[:20]:
            self.assertIsNone(signal_at(c, ind, i, p, {"btc_up": False}))
            self.assertIsNotNone(signal_at(c, ind, i, p, {"btc_up": True}))

    def test_signals_record_features(self):
        p = CFG["strategy"]
        c = synthetic_candles(3000, seed=2)
        ind = compute_indicators(c, p)
        sig = next(s for s in (signal_at(c, ind, i, p, {"btc_up": True}) for i in range(250, 3000)) if s)
        for k in ("extension_atr", "trend_strength", "rsi", "atr_pct", "ribbon_aligned", "btc_aligned"):
            self.assertIn(k, sig.features)

    def test_loss_autopsy_finds_planted_pattern(self):
        trades = []
        for k in range(40):
            chasing = k % 2 == 0
            trades.append({"r_multiple": -1.1 if chasing and k % 10 else 1.9, "symbol": "A",
                           "features": json.dumps({"extension_atr": 3.0 + k * 0.01 if chasing else 0.5,
                                                   "trend_strength": 1.0, "atr_pct": 1.0,
                                                   "ribbon_aligned": True, "btc_aligned": True})})
        lessons, props = loss_autopsy(trades, CFG["strategy"])
        self.assertTrue(any("max_extension_atr" in pr for pr, _ in props), lessons)
        thr = next(pr["max_extension_atr"] for pr, _ in props if "max_extension_atr" in pr)
        caught = [t for t in trades if t["r_multiple"] < 0 and json.loads(t["features"])["extension_atr"] > thr]
        self.assertGreaterEqual(len(caught), 12)  # the filter would have skipped most planted losers
        self.assertTrue(any("chasing" in x for x in lessons))

    def test_toggle_candidates(self):
        names = [why for _, why in candidates(CFG["strategy"], CFG["learning"]["tunable"], {}, (),
                                              CFG["learning"]["toggles"])]
        self.assertIn("ribbon_filter on", names)
        self.assertIn("btc_filter on", names)


class NoLookahead(unittest.TestCase):
    def test_future_bars_do_not_change_past_trades(self):
        c = synthetic_candles(2500, seed=11)
        p = CFG["strategy"]
        full = run_backtest(CFG, p, {"A": c})["trades"]
        cut_ts = c[1800].ts
        part = run_backtest(CFG, p, {"A": c[:1801]})["trades"]
        done_before = [t.id and (t.entry_ts, t.exit_ts, round(t.net_pnl, 9)) for t in full if t.exit_ts < cut_ts]
        part_done = [(t.entry_ts, t.exit_ts, round(t.net_pnl, 9)) for t in part if t.exit_reason != "end_of_test"]
        self.assertEqual(done_before, part_done)


class Learner(unittest.TestCase):
    def test_candidates_stay_in_bounds(self):
        tun = CFG["learning"]["tunable"]
        for c, _ in candidates(CFG["strategy"], tun, {"atr_stop_mult": 1}, [({"atr_stop_mult": 99}, "x")]):
            for k, (lo, hi, _s) in tun.items():
                self.assertTrue(lo <= c[k] <= hi or c[k] == CFG["strategy"][k], (k, c[k]))
            for k in ("ema_fast", "ema_slow", "ema_trend"):
                self.assertEqual(c[k], CFG["strategy"][k])

    def test_improve_never_touches_risk_and_logs(self):
        hist = {"A": synthetic_candles(3000, seed=2), "B": synthetic_candles(3000, seed=4)}
        cfg_before = copy.deepcopy(CFG)
        new, rep = improve(CFG, copy.deepcopy(CFG["strategy"]), hist)
        self.assertEqual(CFG["risk"], cfg_before["risk"])
        self.assertTrue(rep["lessons"])
        self.assertTrue(os.path.exists(os.path.join(TMP, "learning_log.md")))
        for c in rep["changes"]:  # anything adopted must not be worse on the unseen recent fold
            self.assertGreaterEqual(c["holdout_r"][1], c["holdout_r"][0])


class LiveLoop(unittest.TestCase):
    def test_tick_with_fake_exchange(self):
        from tradebot.runner import PaperBot
        candles = synthetic_candles(1200, seed=9)

        class Fake:
            n = 700

            def candles(self, inst, bar, limit=300, after=None):
                return candles[:self.n][-limit:]

            def history(self, inst, bar, total):
                return candles[:self.n][-total:]

        fake = Fake()
        cfg = copy.deepcopy(CFG)
        cfg["symbols"] = ["BTC-USDT"]
        cfg["learning"]["enabled"] = False
        bot = PaperBot(cfg, client=fake)
        import tradebot.runner as r
        real_time = r.time.time
        try:
            for n in range(700, 1200):
                fake.n = n
                r.time.time = lambda n=n: (candles[n - 1].ts + 3_600_000) / 1000 + 5
                bot.tick()
        finally:
            r.time.time = real_time
        self.assertGreater(len(bot.journal.trades()), 0)
        self.assertTrue(os.path.exists(os.path.join(TMP, "trades.csv")))
        bot2 = PaperBot(cfg, client=fake)  # restart resumes the same account
        self.assertAlmostEqual(bot2.engine.balance, bot.engine.balance)


if __name__ == "__main__":
    unittest.main()
