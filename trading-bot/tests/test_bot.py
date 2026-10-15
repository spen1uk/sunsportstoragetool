import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

TMP = tempfile.mkdtemp(prefix="tradebot-test-")
os.environ["TRADEBOT_DATA_DIR"] = TMP
for _secret in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DISCORD_WEBHOOK_URL", "ANTHROPIC_API_KEY"):
    os.environ[_secret] = ""  # tests must never message your phone, even if a real .env exists
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tradebot.backtest import run_backtest  # noqa: E402
from tradebot.config import load_config  # noqa: E402
from tradebot.data import synthetic_candles  # noqa: E402
from tradebot.engine import Engine  # noqa: E402
from tradebot.indicators import atr, ema, rsi, smma, stoch_rsi, ut_bot  # noqa: E402
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
        eng = _engine(pause_after_consecutive_losses=3, pause_hours=24, max_drawdown_pct=100)
        for _ in range(3):
            _pos(eng, qty=0.1)
            eng._manage(eng.positions["X"], Candle(3_600_000, 100, 100, 97, 97), 1.0)
        self.assertEqual(eng.pause_until, 3_600_000 + eng.bar_ms + 24 * 3_600_000)  # 24 real hours

    def test_state_roundtrip(self):
        eng = _engine()
        _pos(eng)
        eng.balance = 123.0
        s = json.loads(json.dumps(eng.to_state()))
        eng2 = _engine()
        eng2.load_state(s)
        self.assertEqual(eng2.balance, 123.0)
        self.assertEqual(eng2.positions["X"].entry_price, 100.0)


class CalvinIndicators(unittest.TestCase):
    def test_smma_matches_wilder(self):
        out = smma([1, 2, 3, 4, 5, 6], 3)
        self.assertEqual(out[2], 2.0)
        self.assertAlmostEqual(out[3], (2.0 * 2 + 4) / 3)

    def test_stoch_rsi_range_and_lag(self):
        c = [x.c for x in synthetic_candles(400, seed=3)]
        k, d = stoch_rsi(c, 3, 3, 14, 14)
        vals = [v for v in k if v is not None]
        self.assertTrue(all(0 <= v <= 100 for v in vals))
        self.assertIsNone(k[28])  # RSI(14) + stoch(14) + SMA(3) -> first K at bar 29
        self.assertIsNotNone(k[29])
        self.assertIsNotNone(d[60])

    def test_ut_bot_flips_on_trend_change(self):
        closes = [100 + i for i in range(30)] + [130 - 2 * i for i in range(30)]
        highs = [x + 0.5 for x in closes]
        lows = [x - 0.5 for x in closes]
        stop, buy, sell = ut_bot(highs, lows, closes, key=2, atr_period=1)
        self.assertTrue(any(sell[30:40]))        # sells soon after the turn down
        self.assertFalse(any(buy[31:]))          # no buy while falling
        for i in range(5, 29):                   # rising: stop trails below price
            self.assertLess(stop[i], closes[i])

    def test_calvin_entries_obey_every_rule(self):
        p = copy.deepcopy(CFG["strategy"])
        self.assertEqual(p["name"], "calvin_system")
        c = synthetic_candles(3000, seed=4)
        ind = compute_indicators(c, p)
        sigs = [(i, signal_at(c, ind, i, p)) for i in range(60, 3000)]
        sigs = [(i, s) for i, s in sigs if s]
        self.assertTrue(sigs)
        for i, s in sigs:
            self.assertTrue(ind["ut_buy"][i])
            self.assertTrue(all(c[i].c > r[i] for r in ind["ribbon"]))
            self.assertGreater(c[i].c, ind["smma"][i])
            self.assertGreater(ind["stoch_k"][i], ind["stoch_d"][i])
            self.assertLess(ind["stoch_k"][i], p["stoch_max"])
            self.assertLess(s.stop, s.entry)

    def test_ut_sell_closes_calvin_trade(self):
        res = run_backtest(CFG, CFG["strategy"], {"A": synthetic_candles(3000, seed=4)})
        self.assertIn("signal_exit", {t.exit_reason.split("+")[0] for t in res["trades"]})


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
        self.assertIn("ribbon_filter off", names)
        self.assertIn("stoch_filter off", names)
        self.assertIn("btc_filter on", names)


class Dashboard(unittest.TestCase):
    def test_demo_snapshot_shape(self):
        from tradebot.dashboard import build_demo
        snap = build_demo(copy.deepcopy(CFG))
        self.assertTrue(snap["demo"])
        self.assertEqual([w["symbol"] for w in snap["workers"]], CFG["symbols"])
        for w in snap["workers"]:
            self.assertTrue(0.0 <= w["charge"] <= 1.0)
            self.assertEqual(len(w["checklist"]), 4)  # Calvin: UT Bot, ribbon, SMMA, Stoch RSI
            self.assertTrue(w["thought"])
        self.assertIn("feeds", snap["health"])           # DATA view
        self.assertIn("stats", snap["lab"])              # LAB view
        self.assertTrue(all("id" in t for t in snap["trades"]))  # city coin animation
        json.dumps(snap)  # must be serialisable for the web page

    def test_server_serves_state(self):
        import threading
        import urllib.request
        from http.server import ThreadingHTTPServer
        from tradebot import dashboard
        path = os.path.join(TMP, "snap.json")
        dashboard.write_snapshot({"ok": 1}, path)
        srv = {}

        def run():
            orig = ThreadingHTTPServer.serve_forever

            def capture(self, *a, **k):
                srv["s"] = self
                orig(self, *a, **k)
            ThreadingHTTPServer.serve_forever = capture
            try:
                dashboard.serve("127.0.0.1", 0, path)
            finally:
                ThreadingHTTPServer.serve_forever = orig
        threading.Thread(target=run, daemon=True).start()
        import time
        for _ in range(50):
            if "s" in srv:
                break
            time.sleep(0.05)
        port = srv["s"].server_address[1]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.assertEqual(json.loads(opener.open(f"http://127.0.0.1:{port}/api/state").read()), {"ok": 1})
        self.assertIn(b"BOT CITY", opener.open(f"http://127.0.0.1:{port}/").read())
        srv["s"].shutdown()


class Replay(unittest.TestCase):
    def test_replay_matches_backtest(self):
        from tradebot.replay import build_replay
        hist = {"BTC-USDT": synthetic_candles(900, seed=35, bar="1D"), "ETH-USDT": synthetic_candles(900, seed=36, bar="1D"),
                "SOL-USDT": synthetic_candles(900, seed=37, bar="1D")}
        rp = build_replay(CFG, hist, CFG["strategy"])
        self.assertEqual(len(rp["rules"][0]), 4)
        self.assertTrue(rp["frames"] and rp["trades"])
        self.assertEqual(rp["frames"][-1]["k"], len(rp["trades"]))
        ks = [f["k"] for f in rp["frames"]]
        self.assertEqual(ks, sorted(ks))  # trades only ever accumulate
        for f in rp["frames"]:
            self.assertEqual(len(f["w"]), 3)
        # same engine as the backtester -> same closed trades over the same candles
        from tradebot.replay import WARMUP
        start = max(c[WARMUP].ts for c in hist.values())
        bt = run_backtest(CFG, CFG["strategy"], hist, start_ts=start)["trades"]
        closed = [t for t in bt if t.exit_reason != "end_of_test"]
        self.assertEqual(len(rp["trades"]), len(closed))
        for a, b in zip(closed, rp["trades"]):
            self.assertAlmostEqual(a.net_pnl, b["pnl"], places=3)
        json.dumps(rp)


class MemoryKeeper(unittest.TestCase):
    def _mem(self):
        from tradebot.memory import Memory
        path = os.path.join(TMP, "mem-%d.json" % id(self))
        if os.path.exists(path):
            os.remove(path)
        return Memory(path)

    FINDING = {"key": "extension_atr>", "text": "chasing", "cond": {"feature": "extension_atr", "op": ">", "threshold": 2.0},
               "fix": {"max_extension_atr": 2.0}, "why": "autopsy: x", "losers": 8, "winners": 2, "r_sum": -6.0, "trades": 10}

    def _trade(self, ext, r, ts):
        return {"features": json.dumps({"extension_atr": ext}), "entry_ts": ts, "exit_ts": ts + 1,
                "r_multiple": r, "net_pnl": r}

    def test_strong_evidence_means_half_size_and_survives_restart(self):
        from tradebot.memory import Memory
        m = self._mem()
        m.update_patterns([self.FINDING], now=1000)
        self.assertEqual(m.pre_trade({"extension_atr": 3.0})[0], "half")
        self.assertEqual(m.pre_trade({"extension_atr": 1.0})[0], None)
        self.assertEqual(Memory(m.path).pre_trade({"extension_atr": 3.0})[0], "half")  # remembered on disk

    def test_weak_evidence_only_watches(self):
        m = self._mem()
        m.update_patterns([dict(self.FINDING, losers=3, winners=2, r_sum=-2.1)], now=1000)
        self.assertEqual(m.pre_trade({"extension_atr": 3.0})[0], None)

    def test_avoid_needs_new_losing_trades_and_clear_needs_new_winners(self):
        m = self._mem()
        m.update_patterns([self.FINDING], now=1000)
        m.record_trade(self._trade(3.0, -2.0, 500))          # before discovery: hindsight, ignored
        self.assertEqual(m.data["patterns"]["extension_atr>"]["live"]["trades"], 0)
        for i in range(5):
            m.record_trade(self._trade(3.0, -1.0, 2000 + i))
        self.assertEqual(m.pre_trade({"extension_atr": 3.0})[0], "skip")
        for i in range(8):
            m.record_trade(self._trade(3.0, 1.5, 3000 + i))
        self.assertEqual(m.data["patterns"]["extension_atr>"]["status"], "cleared")
        self.assertEqual(m.pre_trade({"extension_atr": 3.0})[0], None)

    def test_rejected_ideas_cool_down_and_adoption_resets(self):
        m = self._mem()
        m.record_fix('{"a": 1}', "idea", "rejected", "no gain", "no_gain", now=0)
        self.assertTrue(m.cooling('{"a": 1}', now=1))
        self.assertFalse(m.cooling('{"a": 1}', now=15 * 86_400_000))
        m.record_fix('{"a": 1}', "idea", "rejected", "no gain", "no_gain", now=0)
        m.reset_cooldowns()
        self.assertFalse(m.cooling('{"a": 1}', now=1))

    def test_engine_halves_size_for_known_mistake(self):
        m = self._mem()
        c = synthetic_candles(3000, seed=4)
        p = copy.deepcopy(CFG["strategy"])
        ind = compute_indicators(c, p)
        i = next(i for i in range(60, 3000) if signal_at(c, ind, i, p))
        plain = Engine(copy.deepcopy(CFG), p)
        plain._maybe_enter("A", c, ind, i)
        m.update_patterns([dict(self.FINDING, cond={"feature": "rsi", "op": ">", "threshold": -1})], now=0)
        careful = Engine(copy.deepcopy(CFG), p, memory=m)
        careful._maybe_enter("A", c, ind, i)
        self.assertAlmostEqual(careful.positions["A"].qty, plain.positions["A"].qty / 2, places=9)
        self.assertEqual(m.data["stats"]["half_sized"], 1)

    def test_learner_uses_memory(self):
        from tradebot.learner import improve
        m = self._mem()
        hist = {s: synthetic_candles(3000, seed=35 + i, bar="1D") for i, s in enumerate(CFG["symbols"])}
        improve(CFG, copy.deepcopy(CFG["strategy"]), hist, memory=m)
        self.assertTrue(m.data["tried"])                     # it remembered what it tested
        _, rep = improve(CFG, copy.deepcopy(CFG["strategy"]), hist, memory=m)
        self.assertGreater(m.data["stats"]["ideas_skipped"], 0)  # and didn't repeat rejected ideas
        self.assertTrue(any("already tested" in l for l in rep["lessons"]))


class Telegram(unittest.TestCase):
    def test_tests_never_alert_your_phone(self):
        self.assertFalse(load_config()["reports"]["telegram_bot_token"])

    def test_find_chat_id_uses_latest_message(self):
        from tradebot.notify import find_chat_id
        ups = [{"update_id": 1, "message": {"chat": {"id": 11, "first_name": "Old"}}},
               {"update_id": 2, "message": {"chat": {"id": 42, "first_name": "Luke"}}}]
        self.assertEqual(find_chat_id(ups), (42, "Luke"))
        self.assertIsNone(find_chat_id([]))

    def test_write_env_updates_in_place(self):
        from tradebot.notify import write_env
        path = os.path.join(TMP, "env-test")
        with open(path, "w") as f:
            f.write("DISCORD_WEBHOOK_URL=\nTELEGRAM_BOT_TOKEN=\nANTHROPIC_API_KEY=keep\n")
        write_env(path, {"TELEGRAM_BOT_TOKEN": "123:abc", "TELEGRAM_CHAT_ID": 42})
        text = open(path).read()
        self.assertIn("TELEGRAM_BOT_TOKEN=123:abc", text)
        self.assertIn("TELEGRAM_CHAT_ID=42", text)
        self.assertIn("ANTHROPIC_API_KEY=keep", text)
        self.assertEqual(text.count("TELEGRAM_BOT_TOKEN"), 1)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_setup_flow(self):
        from unittest import mock
        from tradebot import notify
        calls = {"n": 0}

        def fake_tg(token, method, params=None):
            if method == "getMe":
                return {"username": "luke_city_bot"}
            calls["n"] += 1
            return [] if calls["n"] == 1 else [{"update_id": 5, "message": {"chat": {"id": 777, "first_name": "Luke"}}}]
        path = os.path.join(TMP, "env-flow")
        with mock.patch.object(notify, "_tg", fake_tg), mock.patch.object(notify, "_post") as post, \
                mock.patch("builtins.print"):
            self.assertEqual(notify.telegram_setup(path, token="123:abc"), 777)
        self.assertIn("TELEGRAM_CHAT_ID=777", open(path).read())
        self.assertEqual(post.call_args[0][1]["chat_id"], 777)  # test message sent


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
