"""Self-improvement loop.

Each cycle:
  1. REVIEW   - study recent trades (live paper trades + a fresh backtest) and write plain-English
                lessons: losers that were in profit first, winners that kept running after exit, etc.
  2. PROPOSE  - turn lessons (and optionally Claude's review) into candidate parameter changes,
                plus small +/- steps on every tunable parameter. Only strategy parameters inside
                hard bounds can change - risk limits are never touched by the bot.
  3. PROVE IT - walk-forward test: candidates are scored on older history, and the winner must
                ALSO beat the current settings on the most recent slice it was never chosen on.
  4. ADOPT    - only if it passes; the change, the evidence and the lessons are logged, and the
                previous version can be restored with `python run.py rollback`.

This is evaluation, not data-mining: a change that only looks good on the data it was picked
on is rejected.
"""
import copy
import math
import os

from .backtest import run_backtest, stats
from .config import DATA_DIR
from .util import now_iso, ts_iso


# ---------------------------------------------------------------- 1. review
def after_exit_runup_r(trade, candles, bars=24):
    """How far price kept going in the trade's direction after we exited, in R."""
    d = 1 if trade["side"] == "LONG" else -1
    risk = abs(trade["entry_price"] - trade["initial_stop"]) or 1e-12
    future = [c for c in candles if c.ts > trade["exit_ts"]][:bars]
    if not future:
        return None
    best = max(c.h for c in future) if d > 0 else min(c.l for c in future)
    return (best - trade["exit_price"]) * d / risk


def diagnose(trades, candles_by_symbol, params):
    """Returns (lessons, hints) where hints maps param -> +1/-1 suggested direction."""
    lessons, hints = [], {}
    n = len(trades)
    if n < 10:
        return [f"Only {n} closed trades so far - too few to learn from safely; keeping current rules."], hints
    st = stats(trades, 100.0)
    lessons.append(f"Reviewed {n} trades: win rate {st['win_rate']:.0f}%, expectancy {st['expectancy_r']:+.2f}R "
                   f"per trade, profit factor {st['profit_factor']:.2f}.")

    losers = [t for t in trades if t["r_multiple"] <= 0]
    tps = [t for t in trades if t["exit_reason"] == "take_profit"]
    stops = [t for t in trades if t["exit_reason"].startswith("stop_loss")]
    times = [t for t in trades if t["exit_reason"] == "time_exit"]

    real_losers = [t for t in losers if t["r_multiple"] < -0.25]  # ignore breakeven scratches
    gave_back = [t for t in real_losers if t["mfe_r"] >= 1.0]
    if real_losers and len(gave_back) / len(real_losers) >= 0.2:
        lessons.append(f"{len(gave_back)}/{len(real_losers)} losing trades were up 1R+ before turning into losses "
                       f"-> test protecting profits sooner (lower breakeven trigger / trailing stop).")
        hints["breakeven_at_r"] = -1
        hints["trail_atr_mult"] = +1

    if tps:
        runs = [r for r in (after_exit_runup_r(t, candles_by_symbol.get(t["symbol"], [])) for t in tps) if r is not None]
        if runs:
            big = [r for r in runs if r >= 1.0]
            avg = sum(runs) / len(runs)
            if len(big) / len(runs) >= 0.4:
                lessons.append(f"Left money on the table: after {len(big)}/{len(runs)} take-profits price ran another "
                               f"1R+ (avg {avg:+.2f}R) -> test a further target or a trailing stop.")
                hints["take_profit_r"] = +1
                hints.setdefault("trail_atr_mult", +1)
            elif len(big) / len(runs) < 0.15 and st["win_rate"] < 40:
                lessons.append("Price rarely continued after take-profit and win rate is low -> test a closer target.")
                hints["take_profit_r"] = -1

    if stops:
        quick = [t for t in stops if t["bars_held"] <= 2]
        recovered = []
        for t in stops:
            r = after_exit_runup_r(t, candles_by_symbol.get(t["symbol"], []))
            if r is not None and r >= params["take_profit_r"] + 1.0:  # would have hit target from exit
                recovered.append(t)
        if len(quick) / len(stops) >= 0.35 or len(recovered) / len(stops) >= 0.3:
            lessons.append(f"Stops look too tight: {len(quick)} of {len(stops)} stop-outs happened within 2 bars and "
                           f"{len(recovered)} then went on to reach the target -> test a wider ATR stop.")
            hints["atr_stop_mult"] = +1

    if times and len(times) / n >= 0.2:
        avg_t = sum(t["r_multiple"] for t in times) / len(times)
        lessons.append(f"{len(times)} trades hit the time limit (avg {avg_t:+.2f}R) -> "
                       + ("test giving trades longer." if avg_t > 0 else "test cutting stale trades sooner."))
        hints["max_bars_in_trade"] = +1 if avg_t > 0 else -1

    if st["expectancy_r"] < 0:
        lessons.append("Negative expectancy -> test stricter entries (narrower RSI band).")
        hints["rsi_max"] = -1
        hints["rsi_min"] = +1
    return lessons, hints


# ---------------------------------------------------------------- 2. propose
def _clip(v, lo, hi, step):
    v = min(max(v, lo), hi)
    v = round(round((v - lo) / step) * step + lo, 6)
    return int(v) if float(step).is_integer() and float(lo).is_integer() else v


def candidates(params, tunable, hints, extra=()):
    out, seen = [], set()

    def add(c, why):
        key = tuple(sorted((k, c[k]) for k in tunable))
        if key not in seen and c != params:
            seen.add(key)
            out.append((c, why))

    for k, (lo, hi, step) in tunable.items():
        for mult in (1, -1):
            c = copy.deepcopy(params)
            c[k] = _clip(params[k] + mult * step, lo, hi, step)
            add(c, f"{k} {params[k]} -> {c[k]}")
        if k in hints:  # lessons get a bigger step in their suggested direction
            c = copy.deepcopy(params)
            c[k] = _clip(params[k] + hints[k] * 2 * step, lo, hi, step)
            add(c, f"{k} {params[k]} -> {c[k]} (from review)")
    for prop, why in extra:
        c = copy.deepcopy(params)
        for k, v in prop.items():
            if k in tunable:
                lo, hi, step = tunable[k]
                c[k] = _clip(float(v), lo, hi, step)
        add(c, why)
    return out


# ---------------------------------------------------------------- 3. prove it
def _fold_bounds(candles_by_symbol, folds, warmup):
    ts = sorted({c.ts for cs in candles_by_symbol.values() for c in cs})[warmup:]
    size = len(ts) // folds
    edges = [ts[i * size] for i in range(folds)] + [ts[-1] + 1]
    return list(zip(edges[:-1], edges[1:]))


def _score(trades):
    if not trades:
        return 0.0
    s = stats(trades, 100.0)
    return s["total_r"] - 0.5 * s["max_dd_r"]


def evaluate(cfg, params, candles_by_symbol, bounds):
    """Score each walk-forward fold. Risk kill-switch is disabled here so we measure the rules."""
    eval_cfg = copy.deepcopy(cfg)
    eval_cfg["risk"]["max_drawdown_pct"] = 100.0
    res = run_backtest(eval_cfg, params, candles_by_symbol, start_ts=bounds[0][0])
    trades = [t.to_dict() for t in res["trades"]]
    per_fold = []
    for lo, hi in bounds:
        ft = [t for t in trades if lo <= t["entry_ts"] < hi]
        per_fold.append({"score": _score(ft), "trades": len(ft)})
    return {"folds": per_fold, "all": stats(trades, cfg["starting_balance"]), "trades": trades}


def improve(cfg, params, candles_by_symbol, live_trades=(), extra_proposals=(), log=print):
    L = cfg["learning"]
    tunable = L["tunable"]
    warmup = int(params["ema_trend"]) + 50
    bounds = _fold_bounds(candles_by_symbol, L["folds"], warmup)
    select, holdout = bounds[:-1], bounds[-1]

    base = evaluate(cfg, params, candles_by_symbol, bounds)
    review_trades = list(live_trades) if len(live_trades) >= 10 else base["trades"]
    source = "live paper trades" if len(live_trades) >= 10 else "backtest of recent history"
    lessons, hints = diagnose(review_trades, candles_by_symbol, params)
    lessons.insert(0, f"Review source: {source}.")

    current, cur_eval = copy.deepcopy(params), base
    changes = []
    tested = 0
    for _ in range(L["max_param_changes_per_cycle"]):
        best = None
        for cand, why in candidates(current, tunable, hints, extra_proposals):
            tested += 1
            ev = evaluate(cfg, cand, candles_by_symbol, bounds)
            if ev["all"]["trades"] < L["min_trades"]:
                continue
            cur_sel = [f["score"] for f in cur_eval["folds"][:-1]]
            cand_sel = [f["score"] for f in ev["folds"][:-1]]
            wins = sum(1 for a, b in zip(cand_sel, cur_sel) if a > b)
            gain = sum(cand_sel) - sum(cur_sel)
            need = max(L["min_improvement_pct"] / 100 * abs(sum(cur_sel)), 1.0)
            if wins < math.ceil(0.6 * len(select)) or gain < need:
                continue
            if best is None or gain > best[2]:
                best = (cand, why, gain, ev)
        if best is None:
            break
        cand, why, gain, ev = best
        hold_cur, hold_new = cur_eval["folds"][-1]["score"], ev["folds"][-1]["score"]
        if hold_new < hold_cur:
            lessons.append(f"Rejected '{why}': looked better on older data (+{gain:.1f}R) but was worse on the "
                           f"most recent unseen period ({hold_new:+.1f}R vs {hold_cur:+.1f}R) - likely curve-fit.")
            break
        if ev["all"]["max_dd_pct"] > cur_eval["all"]["max_dd_pct"] + 2.0:
            lessons.append(f"Rejected '{why}': more profitable but deeper drawdown "
                           f"({ev['all']['max_dd_pct']:.1f}% vs {cur_eval['all']['max_dd_pct']:.1f}%).")
            break
        changes.append({
            "change": why, "selection_gain_r": round(gain, 2),
            "holdout_r": [round(hold_cur, 2), round(hold_new, 2)],
            "before": _brief(cur_eval["all"]), "after": _brief(ev["all"]),
        })
        current, cur_eval = cand, ev

    report = {
        "at": now_iso(), "lessons": lessons, "candidates_tested": tested, "changes": changes,
        "period": f"{ts_iso(bounds[0][0])} -> {ts_iso(bounds[-1][1] - 1)}",
        "baseline": _brief(base["all"]), "final": _brief(cur_eval["all"]),
    }
    _write_log(report)
    return current, report


def _brief(s):
    return {k: round(s[k], 2) if isinstance(s[k], float) and math.isfinite(s[k]) else s[k]
            for k in ("trades", "win_rate", "expectancy_r", "profit_factor", "max_dd_pct", "return_pct")}


def _write_log(report):
    path = os.path.join(DATA_DIR, "learning_log.md")
    lines = [f"\n## Learning cycle {report['at']}", f"Data: {report['period']}, "
             f"{report['candidates_tested']} candidate settings tested.", "", "**Lessons**"]
    lines += [f"- {x}" for x in report["lessons"]]
    lines += ["", "**Changes adopted**"]
    if report["changes"]:
        for c in report["changes"]:
            lines.append(f"- {c['change']}: +{c['selection_gain_r']}R on selection folds, recent unseen period "
                         f"{c['holdout_r'][0]:+}R -> {c['holdout_r'][1]:+}R")
    else:
        lines.append("- None. No candidate beat the current rules on both older and unseen recent data.")
    lines += ["", f"Before: {report['baseline']}", f"After: {report['final']}", ""]
    with open(path, "a") as f:
        f.write("\n".join(lines))
