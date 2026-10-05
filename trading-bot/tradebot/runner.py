"""The always-on paper trading loop."""
import json
import os
import signal
import time
import traceback

from .config import DATA_DIR, load_params, save_new_params
from .data import BloFinData, get_history
from .engine import Engine
from .journal import Journal
from .learner import improve
from .notify import notify
from .report import summary_text, write_html
from .strategy import compute_indicators
from .util import BAR_MS, now_iso

STATE_FILE = os.path.join(DATA_DIR, "state.json")
LIVE_BARS = 600  # enough history for the 200-EMA to be fully warmed up


def log(msg):
    line = f"[{now_iso()}] {msg}"
    print(line, flush=True)
    with open(os.path.join(DATA_DIR, "bot.log"), "a") as f:
        f.write(line + "\n")


class PaperBot:
    def __init__(self, cfg, client=None):
        self.cfg = cfg
        self.client = client or BloFinData()
        self.journal = Journal()
        params, version = load_params(cfg)
        self.engine = Engine(cfg, params, version, journal=self.journal, mode="paper")
        self.meta = {"last_report": 0, "last_learn": 0, "started": now_iso()}
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                s = json.load(f)
            self.engine.load_state(s["engine"])
            self.meta.update(s.get("meta", {}))
        else:
            self.journal.event("start", f"Paper account opened with ${cfg['starting_balance']:.2f}")
        self.prices = {}
        self._stop = False

    def save(self):
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"engine": self.engine.to_state(), "meta": self.meta, "saved_at": now_iso()}, f, indent=1)
        os.replace(tmp, STATE_FILE)

    # ----------------------------------------------------------------- one pass
    def tick(self):
        bar_ms = BAR_MS[self.cfg["timeframe"]]
        now_ms = int(time.time() * 1000)
        for sym in self.cfg["symbols"]:
            candles = get_history(self.client, sym, self.cfg["timeframe"], LIVE_BARS)
            if not candles:
                continue
            ind = compute_indicators(candles, self.engine.p)
            last = self.engine.last_ts.get(sym, 0)
            new = [i for i, c in enumerate(candles) if c.ts > last]
            if not last:
                new = new[-1:]  # first run: start from the latest closed bar, don't trade the past
            newest = len(candles) - 1
            fresh = now_ms - (candles[-1].ts + bar_ms) < 2 * bar_ms  # data isn't stale
            before = len(self.engine.closed)
            for i in new:
                # Catch-up bars (after downtime) still manage stops/targets, but only the
                # newest bar may open a trade - the bot never "trades the past".
                self.engine.on_bar(sym, candles, ind, i, allow_entry=(i == newest and fresh))
            for t in self.engine.closed[before:]:
                notify(self.cfg, f"{t.side} {t.symbol} closed ({t.exit_reason}): ${t.net_pnl:+.2f} "
                                 f"({t.r_multiple:+.2f}R). Balance ${t.balance_after:.2f}", log)
            if sym in self.engine.positions and self.engine.positions[sym].entry_ts == candles[newest].ts:
                p = self.engine.positions[sym]
                log(f"ENTER {'LONG' if p.side > 0 else 'SHORT'} {sym} @ {p.entry_price:.4f} stop {p.stop:.4f} "
                    f"target {p.target:.4f}")
            self.prices[sym] = candles[-1].c
        self.journal.snapshot(now_ms, self.engine.balance, self.engine.equity(self.prices), len(self.engine.positions))
        self.save()
        self._periodic(now_ms)

    def _periodic(self, now_ms):
        rep_every = self.cfg["reports"]["every_hours"] * 3_600_000
        if now_ms - self.meta["last_report"] >= rep_every:
            text = summary_text(self.cfg, self.engine, self.journal, self.prices)
            write_html(self.cfg, self.journal, self.engine)
            log(text)
            notify(self.cfg, text, log)
            self.meta["last_report"] = now_ms
            self.save()
        L = self.cfg["learning"]
        if L["enabled"] and now_ms - self.meta["last_learn"] >= L["every_hours"] * 3_600_000:
            self.meta["last_learn"] = now_ms
            self.save()
            self.learn()

    def learn(self):
        log("Learning cycle: reviewing trades and testing improvements...")
        hist = {s: get_history(self.client, s, self.cfg["timeframe"], self.cfg["learning"]["history_bars"])
                for s in self.cfg["symbols"]}
        live = self.journal.trades(mode="paper")
        extra = []
        try:
            from .claude_review import review
            text, extra = review(self.cfg, self.engine.p, live, [], log)
            if text:
                with open(os.path.join(DATA_DIR, "learning_log.md"), "a") as f:
                    f.write(f"\n### Claude review {now_iso()}\n{text}\n")
        except Exception as e:
            log(f"[claude] review skipped: {e}")
        new_params, report = improve(self.cfg, self.engine.p, hist, live, extra)
        if report["changes"]:
            reason = "; ".join(c["change"] for c in report["changes"])
            v = save_new_params(new_params, reason, report["changes"])
            self.engine.p, self.engine.pv = new_params, v
            self.journal.event("learn", f"Adopted strategy v{v}: {reason}")
            msg = f"Bot improved itself -> v{v}: {reason}\nLessons:\n- " + "\n- ".join(report["lessons"][:4])
        else:
            self.journal.event("learn", "Reviewed; no change passed the out-of-sample test")
            msg = "Learning cycle: no change passed testing; rules unchanged.\n- " + "\n- ".join(report["lessons"][:4])
        log(msg)
        notify(self.cfg, msg, log)
        self.save()

    # ----------------------------------------------------------------- forever
    def run_forever(self, poll_seconds=60):
        def _sig(*_):
            self._stop = True
        signal.signal(signal.SIGTERM, _sig)
        signal.signal(signal.SIGINT, _sig)
        log(f"Paper bot running on {', '.join(self.cfg['symbols'])} ({self.cfg['timeframe']}), "
            f"strategy v{self.engine.pv}, balance ${self.engine.balance:.2f}")
        last_err_note = 0
        while not self._stop:
            try:
                self.tick()
                with open(os.path.join(DATA_DIR, "heartbeat"), "w") as f:
                    f.write(now_iso())
            except Exception as e:
                log(f"ERROR: {e}\n{traceback.format_exc()}")
                if time.time() - last_err_note > 3600:
                    notify(self.cfg, f"Trading bot error (it keeps retrying): {e}", log)
                    last_err_note = time.time()
            for _ in range(poll_seconds):
                if self._stop:
                    break
                time.sleep(1)
        self.save()
        log("Stopped cleanly; state saved.")
