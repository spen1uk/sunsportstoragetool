"""Market data: BloFin public REST candles (no API key needed) plus a local CSV cache,
and a synthetic generator used only for offline tests/demos."""
import csv
import json
import math
import os
import random
import time
import urllib.parse
import urllib.request

from .config import DATA_DIR
from .models import Candle
from .util import BAR_MS

BLOFIN_BASE = "https://openapi.blofin.com"


class BloFinData:
    def __init__(self, base_url=BLOFIN_BASE, timeout=20):
        self.base = base_url
        self.timeout = timeout

    def _get(self, path, params):
        url = f"{self.base}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": "tradebot/0.1"})
        last_err = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    payload = json.loads(r.read().decode())
                if str(payload.get("code")) != "0":
                    raise RuntimeError(f"BloFin error {payload.get('code')}: {payload.get('msg')}")
                return payload["data"]
            except Exception as e:  # network blips: back off and retry
                last_err = e
                time.sleep(2 ** attempt)
        raise RuntimeError(f"BloFin request failed: {url}: {last_err}")

    def candles(self, inst_id, bar, limit=300, after=None):
        """Closed candles, oldest first. `after` = return bars older than this ts (ms)."""
        params = {"instId": inst_id, "bar": bar, "limit": str(limit)}
        if after:
            params["after"] = str(after)
        rows = self._get("/api/v1/market/candles", params)
        out = []
        for r in rows:
            # [ts, open, high, low, close, vol, volCurrency, volCurrencyQuote, confirm]
            if len(r) > 8 and str(r[8]) == "0":
                continue  # still-forming candle: never trade on it
            out.append(Candle(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
        out.sort(key=lambda c: c.ts)
        return out

    def history(self, inst_id, bar, total):
        """Page backwards until `total` closed candles are collected."""
        got = {}
        after = None
        while len(got) < total:
            batch = self.candles(inst_id, bar, limit=300, after=after)
            batch = [c for c in batch if c.ts not in got]
            if not batch:
                break
            for c in batch:
                got[c.ts] = c
            after = batch[0].ts
            time.sleep(0.25)  # stay well inside public rate limits
        return sorted(got.values(), key=lambda c: c.ts)[-total:]


def cache_path(symbol, bar):
    d = os.path.join(DATA_DIR, "candles")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{symbol}_{bar}.csv")


def load_cache(symbol, bar):
    p = cache_path(symbol, bar)
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [Candle(int(r["ts"]), float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"]), float(r["v"]))
                for r in csv.DictReader(f)]


def save_cache(symbol, bar, candles):
    p = cache_path(symbol, bar)
    with open(p + ".tmp", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ts", "o", "h", "l", "c", "v"])
        for c in candles:
            w.writerow([c.ts, c.o, c.h, c.l, c.c, c.v])
    os.replace(p + ".tmp", p)


def get_history(client, symbol, bar, total):
    """Cached history topped up from the exchange."""
    cached = load_cache(symbol, bar)
    if len(cached) >= total * 0.9:
        fresh = client.candles(symbol, bar, limit=300)
        merged = {c.ts: c for c in cached}
        merged.update({c.ts: c for c in fresh})
    else:
        merged = {c.ts: c for c in cached}
        merged.update({c.ts: c for c in client.history(symbol, bar, total)})
    candles = sorted(merged.values(), key=lambda c: c.ts)[-20000:]
    save_cache(symbol, bar, candles)
    return candles[-total:]


def synthetic_candles(n=3000, seed=1, start_price=100.0, bar="1H"):
    """Regime-switching random walk (trends + chop). For tests and offline demos ONLY -
    results on this data say nothing about real market performance."""
    rnd = random.Random(seed)
    step = BAR_MS[bar]
    ts = 1_700_000_000_000 - (1_700_000_000_000 % step)
    price = start_price
    drift, vol = 0.0, 0.008
    out = []
    for i in range(n):
        if i % rnd.randint(150, 400) == 0:
            drift = rnd.choice([0.0012, 0.0008, 0.0, -0.0008, -0.0012])
            vol = rnd.choice([0.005, 0.008, 0.012])
        o = price
        c = o * math.exp(drift + vol * rnd.gauss(0, 1))
        h = max(o, c) * (1 + abs(rnd.gauss(0, vol * 0.5)))
        l = min(o, c) * (1 - abs(rnd.gauss(0, vol * 0.5)))
        out.append(Candle(ts, o, h, l, c, rnd.uniform(100, 1000)))
        price = c
        ts += step
    return out
