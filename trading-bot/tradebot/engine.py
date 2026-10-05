"""Paper broker + risk manager. The same engine drives backtests and the live paper bot,
so what the learner tests is exactly what runs 24/7.

Fill model (deliberately pessimistic):
  * entries fill at the signal bar's close plus slippage, taker fee charged
  * if a bar touches both stop and target, the STOP is assumed to hit first
  * gaps through the stop fill at the bar open (worse than the stop)
"""
import json

from .models import Position, Trade
from .strategy import exit_signal, signal_at
from .util import BAR_MS, new_id, ts_iso, utc_day


class Engine:
    def __init__(self, cfg, params, params_version=0, journal=None, mode="paper", balance=None):
        self.cfg = cfg
        self.fees = cfg["fees"]
        self.risk = cfg["risk"]
        self.bar_ms = BAR_MS[cfg["timeframe"]]
        self.p = params
        self.pv = params_version
        self.journal = journal
        self.mode = mode
        self.balance = float(balance if balance is not None else cfg["starting_balance"])
        self.peak = self.balance
        self.positions = {}
        self.closed = []
        self.events = []
        self.day = None
        self.day_start_balance = self.balance
        self.consec_losses = 0
        self.pause_until = 0
        self.halted = False
        self.halt_reason = ""
        self.last_ts = {}

    # ------------------------------------------------------------------ helpers
    @property
    def taker(self):
        return self.fees["taker_pct"] / 100.0

    @property
    def slip(self):
        return self.fees["slippage_pct"] / 100.0

    def _event(self, ts, kind, msg):
        e = {"ts": ts, "kind": kind, "message": msg}
        self.events.append(e)
        if self.journal:
            self.journal.event(kind, msg, ts)

    def _roll_day(self, ts):
        d = utc_day(ts)
        if d != self.day:
            self.day = d
            self.day_start_balance = self.balance

    def daily_loss_hit(self):
        lim = self.risk["daily_loss_limit_pct"] / 100.0
        return self.balance <= self.day_start_balance * (1 - lim)

    def equity(self, prices):
        eq = self.balance
        for sym, pos in self.positions.items():
            px = prices.get(sym)
            if px:
                eq += (px - pos.entry_price) * pos.side * pos.qty
        return eq

    # ------------------------------------------------------------------ main hook
    def on_bar(self, symbol, candles, ind, i, allow_entry=True, ctx=None):
        """Process CLOSED bar i for `symbol`: manage the open position, then look for an entry.
        ctx: market context for the filters, e.g. {"btc_up": True}."""
        bar = candles[i]
        self._roll_day(bar.ts)
        exited = False
        pos = self.positions.get(symbol)
        if pos and bar.ts > pos.entry_ts:
            exited = self._manage(pos, bar, ind["atr"][i], exit_signal(ind, i, self.p, pos.side))
        if allow_entry and not exited and symbol not in self.positions:
            self._maybe_enter(symbol, candles, ind, i, ctx)
        self.last_ts[symbol] = bar.ts

    def _manage(self, pos, bar, atr_now, exit_now=False):
        d, p = pos.side, self.p
        if d > 0:
            pos.best_price = max(pos.best_price, bar.h)
            pos.worst_price = min(pos.worst_price, bar.l)
        else:
            pos.best_price = min(pos.best_price, bar.l)
            pos.worst_price = max(pos.worst_price, bar.h)

        stop_kind = "stop_loss" if (pos.stop - pos.entry_price) * d < 0 else "protected_stop"
        px = reason = None
        if d > 0:
            if bar.o <= pos.stop:
                px, reason = bar.o * (1 - self.slip), stop_kind + "_gap"
            elif bar.l <= pos.stop:
                px, reason = pos.stop * (1 - self.slip), stop_kind
            elif bar.o >= pos.target:
                px, reason = bar.o, "take_profit"
            elif bar.h >= pos.target:
                px, reason = pos.target, "take_profit"
        else:
            if bar.o >= pos.stop:
                px, reason = bar.o * (1 + self.slip), stop_kind + "_gap"
            elif bar.h >= pos.stop:
                px, reason = pos.stop * (1 + self.slip), stop_kind
            elif bar.o <= pos.target:
                px, reason = bar.o, "take_profit"
            elif bar.l <= pos.target:
                px, reason = pos.target, "take_profit"
        if px is not None:
            self._close(pos, bar.ts, px, reason)
            return True

        pos.bars_held += 1
        risk = pos.risk_per_unit
        # Partial take-profit ("don't forget to take profits"): bank part of the position early.
        pr = p.get("partial_tp_r", 0)
        if pr > 0 and not pos.partial_done:
            level = pos.entry_price + d * pr * risk
            if (bar.h >= level) if d > 0 else (bar.l <= level):
                q = (pos.orig_qty or pos.qty) * p.get("partial_tp_pct", 50) / 100.0
                q = min(q, pos.qty)
                gross = (level - pos.entry_price) * d * q
                fee = q * level * self.taker
                self.balance += gross - fee
                pos.partial_pnl += gross
                pos.partial_fees += fee
                pos.qty -= q
                pos.partial_done = True
        favourable = (pos.best_price - pos.entry_price) * d
        be_r = p["breakeven_at_r"]
        if be_r > 0 and not pos.breakeven_moved and favourable >= be_r * risk:
            new_stop = pos.entry_price * (1 + d * 2 * self.taker)  # covers round-trip fees
            if (new_stop - pos.stop) * d > 0:
                pos.stop = new_stop
                pos.breakeven_moved = True
        if p["trail_atr_mult"] > 0 and atr_now and favourable >= max(be_r, 0.5) * risk:
            new_stop = bar.c - d * p["trail_atr_mult"] * atr_now
            if (new_stop - pos.stop) * d > 0:
                pos.stop = new_stop
        if exit_now:  # the strategy's own exit signal (e.g. UT Bot SELL), at the candle close
            self._close(pos, bar.ts, bar.c * (1 - d * self.slip), "signal_exit")
            return True
        if pos.bars_held >= p["max_bars_in_trade"]:
            self._close(pos, bar.ts, bar.c * (1 - d * self.slip), "time_exit")
            return True
        return False

    def _maybe_enter(self, symbol, candles, ind, i, ctx=None):
        bar = candles[i]
        if self.halted or bar.ts < self.pause_until:
            return
        if len(self.positions) >= self.risk["max_open_positions"] or self.daily_loss_hit():
            return
        sig = signal_at(candles, ind, i, self.p, ctx)
        if not sig:
            return
        d = sig.side
        fill = sig.entry * (1 + d * self.slip)
        risk_per_unit = (fill - sig.stop) * d
        if risk_per_unit <= 0:
            return
        target = fill + d * self.p["take_profit_r"] * risk_per_unit
        risk_amt = self.balance * self.risk["risk_per_trade_pct"] / 100.0
        qty = risk_amt / risk_per_unit
        max_notional = self.balance * self.risk["max_leverage"] / self.risk["max_open_positions"]
        qty = min(qty, max_notional / fill)
        if qty * fill < self.risk["min_notional"]:
            self._event(bar.ts, "skip", f"{symbol} signal skipped: size ${qty * fill:.2f} below exchange minimum")
            return
        fee = qty * fill * self.taker
        self.balance -= fee
        pos = Position(
            id=new_id(), symbol=symbol, side=d, entry_ts=bar.ts, entry_price=fill, qty=qty,
            stop=sig.stop, initial_stop=sig.stop, target=target, risk_per_unit=risk_per_unit,
            atr=sig.atr, params_version=self.pv, reasons=sig.reasons,
            best_price=fill, worst_price=fill, entry_fee=fee, features=sig.features, orig_qty=qty,
        )
        self.positions[symbol] = pos
        if self.journal:
            self.journal.event("entry", f"{'LONG' if d > 0 else 'SHORT'} {symbol} qty={qty:.6f} @ {fill:.4f} "
                                        f"stop={sig.stop:.4f} target={target:.4f} | " + "; ".join(sig.reasons), bar.ts)

    def _close(self, pos, ts, px, reason):
        d = pos.side
        rest = (px - pos.entry_price) * d * pos.qty
        exit_fee = pos.qty * px * self.taker
        self.balance += rest - exit_fee
        gross = rest + pos.partial_pnl
        fees = pos.entry_fee + pos.partial_fees + exit_fee
        net = gross - fees
        size = pos.orig_qty or pos.qty
        risk_dollars = pos.risk_per_unit * size
        if pos.partial_done:
            reason += "+partial"
        t = Trade(
            id=pos.id, symbol=pos.symbol, side="LONG" if d > 0 else "SHORT",
            entry_ts=pos.entry_ts, entry_price=pos.entry_price, exit_ts=ts, exit_price=px,
            qty=size, initial_stop=pos.initial_stop, target=pos.target, exit_reason=reason,
            gross_pnl=gross, fees=fees, net_pnl=net,
            r_multiple=net / risk_dollars if risk_dollars else 0.0,
            mfe_r=(pos.best_price - pos.entry_price) * d / pos.risk_per_unit,
            mae_r=(pos.worst_price - pos.entry_price) * d / pos.risk_per_unit,
            bars_held=pos.bars_held, balance_after=self.balance, params_version=pos.params_version,
            entry_reasons="; ".join(pos.reasons), mode=self.mode, features=json.dumps(pos.features),
        )
        del self.positions[pos.symbol]
        self.closed.append(t)
        if self.journal:
            self.journal.record_trade(t)

        if net < 0:
            self.consec_losses += 1
            n = self.risk["pause_after_consecutive_losses"]
            if n and self.consec_losses >= n:
                self.pause_until = ts + self.risk["pause_bars"] * self.bar_ms
                self._event(ts, "pause", f"{self.consec_losses} losses in a row - pausing new entries until "
                                         f"{ts_iso(self.pause_until)} UTC")
                self.consec_losses = 0
        else:
            self.consec_losses = 0

        self.peak = max(self.peak, self.balance)
        dd = 1 - self.balance / self.peak if self.peak else 0
        if dd * 100 >= self.risk["max_drawdown_pct"] and not self.halted:
            self.halted = True
            self.halt_reason = (f"Kill switch: balance ${self.balance:.2f} is {dd * 100:.1f}% below peak "
                                f"${self.peak:.2f}. New entries stopped until you run `python run.py resume`.")
            self._event(ts, "halt", self.halt_reason)

    # ------------------------------------------------------------------ persistence
    def to_state(self):
        return {
            "balance": self.balance, "peak": self.peak, "day": self.day,
            "day_start_balance": self.day_start_balance, "consec_losses": self.consec_losses,
            "pause_until": self.pause_until, "halted": self.halted, "halt_reason": self.halt_reason,
            "last_ts": self.last_ts, "positions": {k: v.to_dict() for k, v in self.positions.items()},
        }

    def load_state(self, s):
        self.balance = s["balance"]
        self.peak = s["peak"]
        self.day = s.get("day")
        self.day_start_balance = s.get("day_start_balance", self.balance)
        self.consec_losses = s.get("consec_losses", 0)
        self.pause_until = s.get("pause_until", 0)
        self.halted = s.get("halted", False)
        self.halt_reason = s.get("halt_reason", "")
        self.last_ts = s.get("last_ts", {})
        self.positions = {k: Position.from_dict(v) for k, v in s.get("positions", {}).items()}
