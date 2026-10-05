"""Trade journal: every entry, exit, P&L, pause, halt and self-improvement change is
stored in SQLite (data/journal.db) and mirrored to data/trades.csv for spreadsheets."""
import csv
import os
import sqlite3
import time

from .config import DATA_DIR
from .util import ts_iso

TRADE_COLS = [
    "id", "mode", "symbol", "side", "entry_ts", "entry_price", "exit_ts", "exit_price", "qty",
    "initial_stop", "target", "exit_reason", "gross_pnl", "fees", "net_pnl", "r_multiple",
    "mfe_r", "mae_r", "bars_held", "balance_after", "params_version", "entry_reasons",
]


class Journal:
    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, "journal.db")
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY, mode TEXT, symbol TEXT, side TEXT,
                entry_ts INTEGER, entry_price REAL, exit_ts INTEGER, exit_price REAL, qty REAL,
                initial_stop REAL, target REAL, exit_reason TEXT, gross_pnl REAL, fees REAL,
                net_pnl REAL, r_multiple REAL, mfe_r REAL, mae_r REAL, bars_held INTEGER,
                balance_after REAL, params_version INTEGER, entry_reasons TEXT);
            CREATE TABLE IF NOT EXISTS events (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, message TEXT);
            CREATE TABLE IF NOT EXISTS equity (
                ts INTEGER PRIMARY KEY, balance REAL, equity REAL, open_positions INTEGER);
        """)
        self.db.commit()

    def record_trade(self, t):
        d = t.to_dict()
        self.db.execute(f"INSERT OR REPLACE INTO trades ({','.join(TRADE_COLS)}) VALUES "
                        f"({','.join('?' * len(TRADE_COLS))})", [d[c] for c in TRADE_COLS])
        self.db.execute("INSERT INTO events (ts, kind, message) VALUES (?,?,?)", (
            t.exit_ts, "exit",
            f"{t.side} {t.symbol} closed ({t.exit_reason}) @ {t.exit_price:.4f}: "
            f"net ${t.net_pnl:+.2f} ({t.r_multiple:+.2f}R), balance ${t.balance_after:.2f}"))
        self.db.commit()
        self.export_csv()

    def event(self, kind, message, ts=None):
        self.db.execute("INSERT INTO events (ts, kind, message) VALUES (?,?,?)",
                        (ts or int(time.time() * 1000), kind, message))
        self.db.commit()

    def snapshot(self, ts, balance, equity, open_positions):
        self.db.execute("INSERT OR REPLACE INTO equity VALUES (?,?,?,?)", (ts, balance, equity, open_positions))
        self.db.commit()

    def trades(self, mode=None):
        q = "SELECT * FROM trades" + (" WHERE mode=?" if mode else "") + " ORDER BY exit_ts"
        return [dict(r) for r in self.db.execute(q, (mode,) if mode else ())]

    def events(self, limit=200):
        return [dict(r) for r in self.db.execute(
            "SELECT * FROM events ORDER BY rowid DESC LIMIT ?", (limit,))]

    def equity_curve(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM equity ORDER BY ts")]

    def export_csv(self, path=None):
        path = path or os.path.join(os.path.dirname(self.path), "trades.csv")
        rows = self.trades()
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["entry_time_utc", "exit_time_utc"] + TRADE_COLS)
            for r in rows:
                w.writerow([ts_iso(r["entry_ts"]), ts_iso(r["exit_ts"])] + [r[c] for c in TRADE_COLS])
        return path
