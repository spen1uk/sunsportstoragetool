"""The rulebook. Every rule is a plain, inspectable condition so every trade can say
exactly *why* it was taken. Replace/extend these with the rules from your own course
notes (see playbook/RULES.md) - keep each rule mechanical and testable.

Default strategy: "trend pullback"
  1. Only trade in the direction of the higher trend (price vs. EMA-trend, EMA-slow vs EMA-trend).
  2. Wait for a pullback that touches the fast EMA, then a candle that closes back in trend direction.
  3. Skip if momentum is already stretched (RSI band) or volatility is dead/extreme (ATR%).
  4. Stop = entry -/+ ATR multiple. Target = fixed R multiple. Move stop to breakeven at +X R.
"""
from .indicators import atr, ema, rsi
from .models import Signal


def compute_indicators(candles, p):
    closes = [c.c for c in candles]
    highs = [c.h for c in candles]
    lows = [c.l for c in candles]
    return {
        "ema_fast": ema(closes, int(p["ema_fast"])),
        "ema_slow": ema(closes, int(p["ema_slow"])),
        "ema_trend": ema(closes, int(p["ema_trend"])),
        "rsi": rsi(closes, int(p["rsi_len"])),
        "atr": atr(highs, lows, closes, int(p["atr_len"])),
    }


def signal_at(candles, ind, i, p):
    """Evaluate the rules on the CLOSED bar i. Returns a Signal or None."""
    if i < 1:
        return None
    ef, es, et = ind["ema_fast"][i], ind["ema_slow"][i], ind["ema_trend"][i]
    r, a = ind["rsi"][i], ind["atr"][i]
    if None in (ef, es, et, r, a):
        return None
    bar = candles[i]
    atr_pct = a / bar.c * 100
    if not (p["min_atr_pct"] <= atr_pct <= p["max_atr_pct"]):
        return None

    look = int(p["pullback_lookback"])
    lo = max(0, i - look + 1)
    recent = range(lo, i + 1)

    # LONG
    if bar.c > et and es > et and ef > es:
        touched = any(candles[j].l <= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        if touched and bar.c > ef and bar.c > bar.o and p["rsi_min"] <= r <= p["rsi_max"]:
            stop = bar.c - p["atr_stop_mult"] * a
            risk = bar.c - stop
            return Signal(+1, bar.c, stop, bar.c + p["take_profit_r"] * risk, a, [
                "uptrend: close>EMA%d and EMA%d>EMA%d>EMA%d" % (p["ema_trend"], p["ema_fast"], p["ema_slow"], p["ema_trend"]),
                "pullback touched EMA%d in last %d bars, closed back above" % (p["ema_fast"], look),
                "bullish candle", "RSI %.1f in [%s,%s]" % (r, p["rsi_min"], p["rsi_max"]),
                "ATR %.2f%% of price" % atr_pct,
            ])

    # SHORT (mirror image), only if enabled
    if p.get("allow_shorts") and bar.c < et and es < et and ef < es:
        touched = any(candles[j].h >= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        lo_r, hi_r = 100 - p["rsi_max"], 100 - p["rsi_min"]
        if touched and bar.c < ef and bar.c < bar.o and lo_r <= r <= hi_r:
            stop = bar.c + p["atr_stop_mult"] * a
            risk = stop - bar.c
            return Signal(-1, bar.c, stop, bar.c - p["take_profit_r"] * risk, a, [
                "downtrend: close<EMA%d and EMA%d<EMA%d<EMA%d" % (p["ema_trend"], p["ema_fast"], p["ema_slow"], p["ema_trend"]),
                "pullback touched EMA%d in last %d bars, closed back below" % (p["ema_fast"], look),
                "bearish candle", "RSI %.1f in [%s,%s]" % (r, lo_r, hi_r),
                "ATR %.2f%% of price" % atr_pct,
            ])
    return None
