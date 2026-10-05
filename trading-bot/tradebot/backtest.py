"""Backtester: replays history bar-by-bar through the exact same Engine the live bot uses."""
from .engine import Engine
from .strategy import compute_indicators


def run_backtest(cfg, params, candles_by_symbol, start_ts=None, end_ts=None, balance=None, journal=None):
    """Indicators are computed on the full series (so they are warmed up), but trading
    only happens for bars in [start_ts, end_ts). Nothing reads beyond the current bar."""
    eng = Engine(cfg, params, journal=journal, mode="backtest", balance=balance)
    inds = {s: compute_indicators(c, params) for s, c in candles_by_symbol.items()}
    timeline = sorted({c.ts for cs in candles_by_symbol.values() for c in cs})
    index = {s: {c.ts: i for i, c in enumerate(cs)} for s, cs in candles_by_symbol.items()}
    curve = []
    for ts in timeline:
        if (start_ts and ts < start_ts) or (end_ts and ts >= end_ts):
            continue
        for s, cs in candles_by_symbol.items():
            i = index[s].get(ts)
            if i is not None:
                eng.on_bar(s, cs, inds[s], i)
        curve.append((ts, eng.balance))
    # Close anything still open at the last price so results are complete.
    for s in list(eng.positions):
        last = [c for c in candles_by_symbol[s] if not end_ts or c.ts < end_ts][-1]
        eng._close(eng.positions[s], last.ts, last.c, "end_of_test")
    start_bal = float(balance if balance is not None else cfg["starting_balance"])
    return {"trades": eng.closed, "curve": curve, "events": eng.events,
            "stats": stats([t.to_dict() for t in eng.closed], start_bal)}


def stats(trades, start_balance):
    n = len(trades)
    if n == 0:
        return {"trades": 0, "win_rate": 0.0, "net_pnl": 0.0, "return_pct": 0.0, "profit_factor": 0.0,
                "expectancy_r": 0.0, "total_r": 0.0, "max_dd_pct": 0.0, "max_dd_r": 0.0,
                "avg_win_r": 0.0, "avg_loss_r": 0.0, "avg_mfe_r": 0.0, "final_balance": start_balance}
    rs = [t["r_multiple"] for t in trades]
    pnl = [t["net_pnl"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    gp = sum(p for p in pnl if p > 0)
    gl = -sum(p for p in pnl if p <= 0)
    bal = peak = start_balance
    max_dd = 0.0
    cum_r = peak_r = max_dd_r = 0.0
    for t in trades:
        bal += t["net_pnl"]
        peak = max(peak, bal)
        max_dd = max(max_dd, 1 - bal / peak if peak else 0)
        cum_r += t["r_multiple"]
        peak_r = max(peak_r, cum_r)
        max_dd_r = max(max_dd_r, peak_r - cum_r)
    return {
        "trades": n,
        "win_rate": len(wins) / n * 100,
        "net_pnl": sum(pnl),
        "return_pct": sum(pnl) / start_balance * 100,
        "profit_factor": gp / gl if gl > 0 else float("inf") if gp > 0 else 0.0,
        "expectancy_r": sum(rs) / n,
        "total_r": sum(rs),
        "max_dd_pct": max_dd * 100,
        "max_dd_r": max_dd_r,
        "avg_win_r": sum(wins) / len(wins) if wins else 0.0,
        "avg_loss_r": sum(losses) / len(losses) if losses else 0.0,
        "avg_mfe_r": sum(t["mfe_r"] for t in trades) / n,
        "final_balance": start_balance + sum(pnl),
    }
