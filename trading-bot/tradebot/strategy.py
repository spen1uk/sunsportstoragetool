"""The rulebook. Every rule is a plain, inspectable condition so every trade can say
exactly *why* it was taken. See playbook/RULES.md for where each rule comes from.

Core strategy: "trend pullback"
  1. Only trade in the direction of the higher trend (price vs. EMA-trend, EMA-slow vs EMA-trend).
  2. Wait for a pullback that touches the fast EMA, then a candle that closes back in trend direction.
  3. Skip if momentum is already stretched (RSI band) or volatility is dead/extreme (ATR%).
  4. Stop = entry -/+ ATR multiple. Target = fixed R multiple. Move stop to breakeven at +X R.

Optional filters (on/off and thresholds can be switched on by the learner, only if they pass testing):
  * ribbon_filter      - EMA ribbon must be stacked in trade direction (Market Cipher A style)
  * btc_filter         - altcoin longs only while BTC is above its trend EMA (shorts: below)
  * max_extension_atr  - don't chase: skip if price is more than N ATRs past the slow EMA
  * min_trend_strength - skip weak trends: slow EMA must be N ATRs past the trend EMA

Every signal also records these measurements ("features") so the loss autopsy can find
what losing trades had in common.
"""
from .indicators import atr, ema, rsi
from .models import Signal

# Commonly cited Market Cipher A ribbon lengths. Replace with Calvin's exact settings when available.
DEFAULT_RIBBON = [5, 11, 15, 18, 21, 24, 28, 34]


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
        "ribbon": [ema(closes, int(n)) for n in p.get("ribbon_lengths", DEFAULT_RIBBON)],
    }


def btc_regime(candles, p):
    """{bar ts: True if BTC closed above its trend EMA} - the 'Bitcoin leads the market' rule."""
    et = ema([c.c for c in candles], int(p["ema_trend"]))
    return {c.ts: (c.c > e) for c, e in zip(candles, et) if e is not None}


def _ribbon_stacked(ind, i, d):
    vals = [r[i] for r in ind["ribbon"]]
    if any(v is None for v in vals):
        return None
    return all((a - b) * d > 0 for a, b in zip(vals, vals[1:]))


def signal_at(candles, ind, i, p, ctx=None):
    """Evaluate the rules on the CLOSED bar i. Returns a Signal or None.
    ctx may carry {"btc_up": bool} for the Bitcoin regime filter."""
    if i < 1:
        return None
    ef, es, et = ind["ema_fast"][i], ind["ema_slow"][i], ind["ema_trend"][i]
    r, a = ind["rsi"][i], ind["atr"][i]
    if None in (ef, es, et, r, a) or a <= 0:
        return None
    bar = candles[i]
    atr_pct = a / bar.c * 100
    if not (p["min_atr_pct"] <= atr_pct <= p["max_atr_pct"]):
        return None

    look = int(p["pullback_lookback"])
    recent = range(max(0, i - look + 1), i + 1)
    side = None
    if bar.c > et and es > et and ef > es:
        touched = any(candles[j].l <= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        if touched and bar.c > ef and bar.c > bar.o and p["rsi_min"] <= r <= p["rsi_max"]:
            side = +1
    elif p.get("allow_shorts") and bar.c < et and es < et and ef < es:
        touched = any(candles[j].h >= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        if touched and bar.c < ef and bar.c < bar.o and 100 - p["rsi_max"] <= r <= 100 - p["rsi_min"]:
            side = -1
    if side is None:
        return None
    d = side

    btc_up = (ctx or {}).get("btc_up")
    features = {
        "extension_atr": round((bar.c - es) * d / a, 3),     # how stretched past the slow EMA
        "trend_strength": round((es - et) * d / a, 3),       # how far the trend EMAs are apart
        "rsi": round(r, 2),
        "atr_pct": round(atr_pct, 3),
        "ribbon_aligned": _ribbon_stacked(ind, i, d),
        "btc_aligned": None if btc_up is None else (btc_up if d > 0 else not btc_up),
    }

    # Optional filters (each can be switched on by the learner after passing testing)
    if p.get("ribbon_filter") and features["ribbon_aligned"] is False:
        return None
    if p.get("btc_filter") and features["btc_aligned"] is False:
        return None
    if p.get("max_extension_atr", 0) > 0 and features["extension_atr"] > p["max_extension_atr"]:
        return None
    if p.get("min_trend_strength", 0) > 0 and features["trend_strength"] < p["min_trend_strength"]:
        return None

    stop = bar.c - d * p["atr_stop_mult"] * a
    risk = abs(bar.c - stop)
    name = "LONG" if d > 0 else "SHORT"
    reasons = [
        f"{'uptrend' if d > 0 else 'downtrend'}: EMA{p['ema_fast']}/{p['ema_slow']}/{p['ema_trend']} stacked",
        f"pullback to EMA{p['ema_fast']} within {look} bars, closed back {'above' if d > 0 else 'below'}",
        f"{'bullish' if d > 0 else 'bearish'} candle", f"RSI {r:.1f}", f"ATR {atr_pct:.2f}% of price",
        f"stretch {features['extension_atr']:+.2f} ATR",
    ]
    if features["ribbon_aligned"] is not None:
        reasons.append("ribbon " + ("aligned" if features["ribbon_aligned"] else "NOT aligned"))
    if features["btc_aligned"] is not None:
        reasons.append("BTC trend " + ("agrees" if features["btc_aligned"] else "DISAGREES"))
    return Signal(d, bar.c, stop, bar.c + d * p["take_profit_r"] * risk, a, reasons, features)
