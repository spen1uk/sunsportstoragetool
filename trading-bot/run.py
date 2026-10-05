#!/usr/bin/env python3
"""Trading bot command line.

  python run.py run                 # start the 24/7 paper trading bot (BloFin live prices)
  python run.py status              # balance, open trades, last trades
  python run.py report              # write data/report.html + data/trades.csv
  python run.py backtest            # test current rules on recent BloFin history
  python run.py learn               # run one self-improvement cycle now
  python run.py resume              # clear the drawdown kill switch after you've reviewed it
  python run.py rollback            # undo the last self-improvement change
  python run.py demo                # offline demo on SIMULATED prices (no internet needed)
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "once", "status", "report", "backtest", "learn",
                                        "resume", "rollback", "demo"])
    ap.add_argument("--config", default=None)
    ap.add_argument("--bars", type=int, default=None, help="history length for backtest")
    args = ap.parse_args()

    # Backtests and demos get their own data folder so they never mix with the paper account.
    if args.command in ("backtest", "demo") and "TRADEBOT_DATA_DIR" not in os.environ:
        os.environ["TRADEBOT_DATA_DIR"] = os.path.join(HERE, "data", args.command)

    from tradebot.config import load_config, load_params, rollback_params
    cfg = load_config(args.config)

    if args.command == "demo":
        return demo(cfg)
    if args.command == "backtest":
        return backtest(cfg, args.bars)

    from tradebot.runner import PaperBot
    if args.command == "rollback":
        dropped = rollback_params()
        if not dropped:
            print("Nothing to roll back - already on the original rules (v0).")
        else:
            print(f"Removed v{dropped['version']} ({dropped['reason']}). Restart the bot to apply.")
        return
    bot = PaperBot(cfg)
    if args.command == "run":
        bot.run_forever()
    elif args.command == "once":
        bot.tick()
    elif args.command == "status":
        from tradebot.report import summary_text
        print(summary_text(cfg, bot.engine, bot.journal))
    elif args.command == "report":
        from tradebot.report import write_html
        print("Wrote", write_html(cfg, bot.journal, bot.engine))
        print("Wrote", bot.journal.export_csv())
    elif args.command == "learn":
        bot.learn()
    elif args.command == "resume":
        bot.engine.halted, bot.engine.halt_reason = False, ""
        bot.engine.peak = bot.engine.balance
        bot.journal.event("resume", "Kill switch cleared by user; drawdown measured from current balance")
        bot.save()
        print("Kill switch cleared. Restart the bot if it is not running.")


def backtest(cfg, bars):
    from tradebot.backtest import run_backtest
    from tradebot.config import load_params
    from tradebot.data import BloFinData, get_history
    from tradebot.journal import Journal
    from tradebot.report import write_html
    params, v = load_params(cfg)
    client = BloFinData()
    total = bars or cfg["learning"]["history_bars"]
    hist = {s: get_history(client, s, cfg["timeframe"], total) for s in cfg["symbols"]}
    _report_backtest(cfg, params, hist, f"Backtest v{v} on BloFin history")


def demo(cfg):
    from tradebot.data import synthetic_candles
    from tradebot.learner import improve
    from tradebot.config import load_params
    print("DEMO on SIMULATED prices - this shows how the bot works, NOT how it will perform.\n")
    params, _ = load_params(cfg)
    hist = {s: synthetic_candles(3000, seed=i + 7, start_price=[60000, 3000, 150][i % 3])
            for i, s in enumerate(cfg["symbols"])}
    _report_backtest(cfg, params, hist, "Demo backtest (simulated prices)")
    print("\nRunning one self-improvement cycle...")
    new_params, rep = improve(cfg, params, hist)
    for l in rep["lessons"]:
        print(" -", l)
    print("Changes adopted:" if rep["changes"] else "No change passed the out-of-sample test.")
    for c in rep["changes"]:
        print(f"   {c['change']}  (before {c['before']} -> after {c['after']})")


def _report_backtest(cfg, params, hist, title):
    from tradebot.backtest import run_backtest
    from tradebot.config import DATA_DIR
    from tradebot.journal import Journal
    from tradebot.report import write_html
    db = os.path.join(DATA_DIR, "journal.db")
    if os.path.exists(db):
        os.remove(db)
    j = Journal(db)
    res = run_backtest(cfg, params, hist, journal=j)
    s = res["stats"]
    print(f"{title}: {s['trades']} trades | win rate {s['win_rate']:.0f}% | avg {s['expectancy_r']:+.2f}R | "
          f"return {s['return_pct']:+.1f}% | max drawdown {s['max_dd_pct']:.1f}% | "
          f"final ${s['final_balance']:.2f}")
    print("Report:", write_html(cfg, j, None, title=title))
    print("Trade log CSV:", j.export_csv())


if __name__ == "__main__":
    main()
