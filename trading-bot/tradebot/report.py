"""Status summary (for your phone) and a self-contained HTML trade log (data/report.html)."""
import html
import os

from .backtest import stats
from .config import DATA_DIR
from .util import now_iso, ts_iso


def summary_text(cfg, engine, journal, prices=None):
    trades = journal.trades(mode="paper")
    st = stats(trades, cfg["starting_balance"])
    eq = engine.equity(prices or {})
    start = cfg["starting_balance"]
    lines = [
        f"Paper bot update ({now_iso()})",
        f"Equity ${eq:.2f} (start ${start:.2f}, {(eq / start - 1) * 100:+.2f}%) | cash balance ${engine.balance:.2f}",
        f"Closed trades {st['trades']} | win rate {st['win_rate']:.0f}% | avg {st['expectancy_r']:+.2f}R | "
        f"max drawdown {st['max_dd_pct']:.1f}%",
    ]
    for p in engine.positions.values():
        px = (prices or {}).get(p.symbol)
        upnl = (px - p.entry_price) * p.side * p.qty if px else 0.0
        lines.append(f"Open: {'LONG' if p.side > 0 else 'SHORT'} {p.symbol} @ {p.entry_price:.4f} "
                     f"stop {p.stop:.4f} target {p.target:.4f} uPnL ${upnl:+.2f}")
    for t in trades[-3:]:
        lines.append(f"Last: {t['side']} {t['symbol']} {t['exit_reason']} ${t['net_pnl']:+.2f} ({t['r_multiple']:+.2f}R)")
    if engine.halted:
        lines.append("HALTED: " + engine.halt_reason)
    lines.append(f"Strategy version v{engine.pv}")
    return "\n".join(lines)


def _svg_curve(points, w=900, h=220):
    if len(points) < 2:
        return "<p class=muted>Equity curve appears after the first trades.</p>"
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    y0, y1 = (y0 - 1, y1 + 1) if y0 == y1 else (y0, y1)
    pts = " ".join(f"{(x - x0) / (x1 - x0 or 1) * (w - 60) + 50:.1f},{h - 25 - (y - y0) / (y1 - y0) * (h - 45):.1f}"
                   for x, y in points)
    return (f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="equity curve">'
            f'<text x="4" y="20" class=axis>${y1:.2f}</text><text x="4" y="{h - 25}" class=axis>${y0:.2f}</text>'
            f'<polyline fill="none" stroke="var(--line)" stroke-width="2" points="{pts}"/></svg>')


def write_html(cfg, journal, engine=None, path=None, title="Paper trading log"):
    path = path or os.path.join(DATA_DIR, "report.html")
    trades = journal.trades()
    st = stats(trades, cfg["starting_balance"])
    bal, curve = cfg["starting_balance"], []
    if trades:
        curve.append((trades[0]["entry_ts"], bal))
    for t in trades:
        bal += t["net_pnl"]
        curve.append((t["exit_ts"], bal))
    learn_path = os.path.join(DATA_DIR, "learning_log.md")
    learning = "No learning cycles yet."
    if os.path.exists(learn_path):
        with open(learn_path) as f:
            learning = f.read()[-6000:]

    def card(k, v):
        return f"<div class=card><div class=k>{k}</div><div class=v>{v}</div></div>"

    pf = st["profit_factor"]
    cards = "".join([
        card("Balance", f"${st['final_balance']:.2f}"), card("Return", f"{st['return_pct']:+.2f}%"),
        card("Trades", st["trades"]), card("Win rate", f"{st['win_rate']:.0f}%"),
        card("Avg trade", f"{st['expectancy_r']:+.2f}R"),
        card("Profit factor", "∞" if pf == float("inf") else f"{pf:.2f}"),
        card("Max drawdown", f"{st['max_dd_pct']:.1f}%"),
        card("Strategy", f"v{engine.pv}" if engine else "-"),
    ])
    rows = []
    for t in reversed(trades):
        cls = "win" if t["net_pnl"] > 0 else "loss"
        rows.append(
            f"<tr class={cls}><td>{ts_iso(t['entry_ts'])}</td><td>{ts_iso(t['exit_ts'])}</td><td>{t['symbol']}</td>"
            f"<td>{t['side']}</td><td>{t['entry_price']:.4f}</td><td>{t['exit_price']:.4f}</td>"
            f"<td>{html.escape(t['exit_reason'])}</td><td class='num pnl'>${t['net_pnl']:+.2f}</td>"
            f"<td class=num>{t['r_multiple']:+.2f}</td><td class=num>{t['mfe_r']:+.2f}</td>"
            f"<td class=num>${t['balance_after']:.2f}</td><td>v{t['params_version']}</td>"
            f"<td class=why>{html.escape(t['entry_reasons'])}</td></tr>")
    events = "".join(f"<li><b>{html.escape(e['kind'])}</b> {ts_iso(e['ts'])} - {html.escape(e['message'])}</li>"
                     for e in journal.events(60))
    doc = f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>
:root{{--bg:#fff;--fg:#1a1a1a;--muted:#666;--card:#f4f4f2;--line:#2563eb;--win:#15803d;--loss:#b91c1c;--border:#ddd}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111;--fg:#eee;--muted:#999;--card:#1c1c1c;--line:#60a5fa;--win:#4ade80;--loss:#f87171;--border:#333}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px;margin:auto}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}}
.card{{background:var(--card);border-radius:8px;padding:10px}}.k{{color:var(--muted);font-size:12px}}.v{{font-size:20px;font-weight:600}}
svg{{width:100%;height:auto}}.axis{{fill:var(--muted);font-size:11px}}.muted{{color:var(--muted)}}
.tbl{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;font-size:12px}}td,th{{padding:4px 6px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:left}}
.num{{text-align:right;font-variant-numeric:tabular-nums}}tr.win .pnl{{color:var(--win)}}tr.loss .pnl{{color:var(--loss)}}
.why{{white-space:normal;min-width:300px;color:var(--muted)}}pre{{white-space:pre-wrap;background:var(--card);padding:10px;border-radius:8px}}
</style></head><body>
<h1>{html.escape(title)}</h1><p class=muted>Generated {now_iso()} - paper money only. R = profit or loss as a multiple of the amount risked; MFE = best open profit during the trade.</p>
<div class=cards>{cards}</div><h2>Balance after each trade</h2>{_svg_curve(curve)}
<h2>Every trade</h2><div class=tbl><table><tr><th>Entry (UTC)</th><th>Exit (UTC)</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Exit reason</th><th>Net P&amp;L</th><th>R</th><th>MFE R</th><th>Balance</th><th>Rules</th><th>Why it entered</th></tr>
{''.join(rows) or '<tr><td colspan=13 class=muted>No closed trades yet.</td></tr>'}</table></div>
<h2>Bot activity</h2><ul>{events or '<li class=muted>Nothing yet.</li>'}</ul>
<h2>What the bot has learned</h2><pre>{html.escape(learning)}</pre></body></html>"""
    with open(path, "w") as f:
        f.write(doc)
    return path
