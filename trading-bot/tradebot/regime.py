"""Market mode: the whole market, checked before any coin.

When Bitcoin dumps, almost everything dumps with it. Market mode sits above every coin:
  GREEN  normal trading
  RED    Bitcoin fell hard (1 candle <= red_1d_pct, or 3 candles <= red_3d_pct):
         no new entries, and stops on open trades are tightened (stops only ever tighten).
         Back to GREEN after `green_after_bars` candles with no new trigger.

It is a safety rule (config.json -> risk.market_mode), so the learner never switches it off.
Every candle's mode is computed from candles that have already closed - no peeking ahead.
"""
from .strategy import btc_regime

DEFAULTS = {"enabled": True, "red_1d_pct": -6.0, "red_3d_pct": -10.0, "green_after_bars": 2,
            "red_trail_atr": 1.0}


def settings(cfg):
    out = dict(DEFAULTS)
    out.update((cfg.get("risk") or {}).get("market_mode") or {})
    return out


def market_modes(btc_candles, cfg):
    """{bar ts: {"mode": "GREEN"|"RED", "why": str}} from BTC candles (oldest first)."""
    s = settings(cfg)
    out = {}
    if not btc_candles:
        return out
    red_left, why = 0, ""
    for i, c in enumerate(btc_candles):
        ch1 = (c.c / btc_candles[i - 1].c - 1) * 100 if i >= 1 else 0.0
        ch3 = (c.c / btc_candles[i - 3].c - 1) * 100 if i >= 3 else 0.0
        trigger = None
        if s["enabled"]:
            if ch1 <= s["red_1d_pct"]:
                trigger = f"BTC {ch1:+.1f}% in 1 candle"
            elif ch3 <= s["red_3d_pct"]:
                trigger = f"BTC {ch3:+.1f}% in 3 candles"
        if trigger:
            red_left, why = int(s["green_after_bars"]), trigger
            out[c.ts] = {"mode": "RED", "why": trigger}
        elif red_left > 0:
            red_left -= 1
            out[c.ts] = {"mode": "RED", "why": f"{why} - calm for {int(s['green_after_bars']) - red_left} "
                                               f"of {int(s['green_after_bars'])} candles"}
        else:
            out[c.ts] = {"mode": "GREEN", "why": f"BTC {ch1:+.1f}% last candle"}
    return out


def contexts(btc_candles, params, cfg):
    """{ts: ctx} - everything the engine needs to know about the whole market at that candle."""
    up = btc_regime(btc_candles, params) if btc_candles else {}
    modes = market_modes(btc_candles, cfg)
    return {ts: {"btc_up": up.get(ts), "market": m["mode"], "market_why": m["why"]} for ts, m in modes.items()}


def ctx_at(ctx_map, ts):
    """Context for a candle time (unknown time -> GREEN with no BTC info)."""
    return ctx_map.get(ts) or {"btc_up": None, "market": "GREEN", "market_why": "no BTC data"}
