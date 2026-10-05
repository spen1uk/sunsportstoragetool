"""The rulebook. Every rule is a plain, inspectable condition so every trade can say
exactly *why* it was taken. See playbook/RULES.md for where each rule comes from.

Two strategies (pick with strategy.name in config.json):

"calvin_system" - built from Calvin Hill's indicator set (TradingView screenshots):
    EMA ribbon 20/25/30/35/40/45/50/55, SMMA 50, UT Bot Alerts (key 2, ATR 1), Stoch RSI 3/3/14/14.
  LONG when, on a closed candle:
    1. UT Bot prints a BUY (close crosses above its trailing stop)          [trigger]
    2. price is above the whole EMA ribbon and the ribbon is stacked bullish [ribbon_filter]
    3. price is above the SMMA 50                                           [smma_filter]
    4. Stoch RSI K is above D (momentum turning up) and K below stoch_max  [stoch_filter]
  EXIT on the UT Bot SELL signal (ut_exit), the safety stop, or the profit target.
  Shorts are the mirror image (off unless allow_shorts).

"trend_pullback" - the original generic strategy (EMA 20/50/200 pullback + RSI band).

Shared optional filters: btc_filter, max_extension_atr, min_trend_strength.
Every signal records its entry measurements ("features") for the loss autopsy.
"""
from .indicators import atr, ema, rsi, smma, stoch_rsi, ut_bot
from .models import Signal

DEFAULT_RIBBON = [20, 25, 30, 35, 40, 45, 50, 55]  # Calvin's ribbon (from his TradingView settings)


def compute_indicators(candles, p):
    closes = [c.c for c in candles]
    highs = [c.h for c in candles]
    lows = [c.l for c in candles]
    k, d = stoch_rsi(closes, int(p.get("stoch_k", 3)), int(p.get("stoch_d", 3)),
                     int(p.get("stoch_rsi_len", 14)), int(p.get("stoch_len", 14)))
    ut_stop, ut_buy, ut_sell = ut_bot(highs, lows, closes, float(p.get("ut_key", 2)), int(p.get("ut_atr", 1)))
    return {
        "ema_fast": ema(closes, int(p["ema_fast"])),
        "ema_slow": ema(closes, int(p["ema_slow"])),
        "ema_trend": ema(closes, int(p["ema_trend"])),
        "rsi": rsi(closes, int(p["rsi_len"])),
        "atr": atr(highs, lows, closes, int(p["atr_len"])),
        "ribbon": [ema(closes, int(n)) for n in p.get("ribbon_lengths", DEFAULT_RIBBON)],
        "smma": smma(closes, int(p.get("smma_len", 50))),
        "stoch_k": k, "stoch_d": d,
        "ut_stop": ut_stop, "ut_buy": ut_buy, "ut_sell": ut_sell,
    }


def btc_regime(candles, p):
    """{bar ts: True if BTC closed above its trend EMA} - the 'Bitcoin leads the market' rule."""
    et = ema([c.c for c in candles], int(p["ema_trend"]))
    return {c.ts: (c.c > e) for c, e in zip(candles, et) if e is not None}


def _ribbon_state(ind, i, d, price):
    """(stacked in direction d, price beyond the whole ribbon) or (None, None) during warm-up."""
    vals = [r[i] for r in ind["ribbon"]]
    if any(v is None for v in vals):
        return None, None
    stacked = all((a - b) * d > 0 for a, b in zip(vals, vals[1:]))
    beyond = all((price - v) * d > 0 for v in vals)
    return stacked, beyond


# ------------------------------------------------------------------ entry rules
def _calvin_side(candles, ind, i, p):
    """Which side (if any) the Calvin system's core rules allow on bar i, plus reasons."""
    bar = candles[i]
    k, dd, sm = ind["stoch_k"][i], ind["stoch_d"][i], ind["smma"][i]
    for side, trig in ((+1, ind["ut_buy"][i]), (-1, ind["ut_sell"][i])):
        if not trig or (side < 0 and not p.get("allow_shorts")):
            continue
        why = [f"UT Bot {'BUY' if side > 0 else 'SELL'} (key {p.get('ut_key', 2)}, ATR {p.get('ut_atr', 1)})"]
        stacked, beyond = _ribbon_state(ind, i, side, bar.c)
        if p.get("ribbon_filter", True):
            if not (stacked and beyond):
                continue
            why.append(f"price {'above' if side > 0 else 'below'} EMA ribbon, ribbon stacked "
                       f"{'bullish' if side > 0 else 'bearish'}")
        if p.get("smma_filter", True):
            if sm is None or (bar.c - sm) * side <= 0:
                continue
            why.append(f"price {'above' if side > 0 else 'below'} SMMA {p.get('smma_len', 50)}")
        if p.get("stoch_filter", True):
            if k is None or dd is None:
                continue
            smax = p.get("stoch_max", 80)
            ok = (k > dd and k < smax) if side > 0 else (k < dd and k > 100 - smax)
            if not ok:
                continue
            why.append(f"Stoch RSI K {k:.0f} {'>' if side > 0 else '<'} D {dd:.0f}, not "
                       f"{'overbought' if side > 0 else 'oversold'}")
        return side, why
    return None, []


def _pullback_side(candles, ind, i, p):
    bar = candles[i]
    ef, es, et, r = ind["ema_fast"][i], ind["ema_slow"][i], ind["ema_trend"][i], ind["rsi"][i]
    look = int(p["pullback_lookback"])
    recent = range(max(0, i - look + 1), i + 1)
    if bar.c > et and es > et and ef > es:
        touched = any(candles[j].l <= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        if touched and bar.c > ef and bar.c > bar.o and p["rsi_min"] <= r <= p["rsi_max"]:
            return +1, [f"uptrend: EMA{p['ema_fast']}/{p['ema_slow']}/{p['ema_trend']} stacked",
                        f"pullback to EMA{p['ema_fast']} within {look} bars, closed back above",
                        "bullish candle", f"RSI {r:.1f}"]
    elif p.get("allow_shorts") and bar.c < et and es < et and ef < es:
        touched = any(candles[j].h >= ind["ema_fast"][j] for j in recent if ind["ema_fast"][j] is not None)
        if touched and bar.c < ef and bar.c < bar.o and 100 - p["rsi_max"] <= r <= 100 - p["rsi_min"]:
            return -1, [f"downtrend: EMA{p['ema_fast']}/{p['ema_slow']}/{p['ema_trend']} stacked",
                        f"pullback to EMA{p['ema_fast']} within {look} bars, closed back below",
                        "bearish candle", f"RSI {r:.1f}"]
    return None, []


def signal_at(candles, ind, i, p, ctx=None):
    """Evaluate the rules on the CLOSED bar i. Returns a Signal or None.
    ctx may carry {"btc_up": bool} for the Bitcoin regime filter."""
    if i < 1:
        return None
    es, et, r, a = ind["ema_slow"][i], ind["ema_trend"][i], ind["rsi"][i], ind["atr"][i]
    if None in (es, r, a) or a <= 0:
        return None
    bar = candles[i]
    atr_pct = a / bar.c * 100
    if not (p["min_atr_pct"] <= atr_pct <= p["max_atr_pct"]):
        return None

    if p.get("name") == "calvin_system":
        side, reasons = _calvin_side(candles, ind, i, p)
    else:
        if et is None:
            return None
        side, reasons = _pullback_side(candles, ind, i, p)
    if side is None:
        return None
    d = side

    btc_up = (ctx or {}).get("btc_up")
    stacked, beyond = _ribbon_state(ind, i, d, bar.c)
    k = ind["stoch_k"][i]
    features = {
        "extension_atr": round((bar.c - es) * d / a, 3),   # how stretched past the 50 EMA
        "trend_strength": round((es - et) * d / a, 3) if et is not None else None,
        "rsi": round(r, 2),
        "atr_pct": round(atr_pct, 3),
        "stoch_k": None if k is None else round(k if d > 0 else 100 - k, 2),
        "ribbon_aligned": None if stacked is None else bool(stacked and beyond),
        "btc_aligned": None if btc_up is None else (btc_up if d > 0 else not btc_up),
    }

    # Shared optional filters (each can be switched on by the learner after passing testing)
    if p.get("name") != "calvin_system" and p.get("ribbon_filter") and features["ribbon_aligned"] is False:
        return None
    if p.get("btc_filter") and features["btc_aligned"] is False:
        return None
    if p.get("max_extension_atr", 0) > 0 and features["extension_atr"] > p["max_extension_atr"]:
        return None
    if (p.get("min_trend_strength", 0) > 0 and features["trend_strength"] is not None
            and features["trend_strength"] < p["min_trend_strength"]):
        return None

    stop = bar.c - d * p["atr_stop_mult"] * a
    risk = abs(bar.c - stop)
    reasons = reasons + [f"ATR {atr_pct:.2f}% of price", f"stretch {features['extension_atr']:+.2f} ATR"]
    if features["btc_aligned"] is not None:
        reasons.append("BTC trend " + ("agrees" if features["btc_aligned"] else "DISAGREES"))
    return Signal(d, bar.c, stop, bar.c + d * p["take_profit_r"] * risk, a, reasons, features)


def exit_signal(ind, i, p, side):
    """Strategy-driven exit for an open position (in addition to stop/target/time)."""
    if p.get("name") == "calvin_system" and p.get("ut_exit", True):
        return bool(ind["ut_sell"][i]) if side > 0 else bool(ind["ut_buy"][i])
    return False
