"""Plain-Python technical indicators. Each returns a list aligned with the input,
with None during the warm-up period so nothing ever peeks at future bars."""


def ema(values, length):
    out = [None] * len(values)
    if len(values) < length:
        return out
    k = 2.0 / (length + 1)
    seed = sum(values[:length]) / length
    out[length - 1] = seed
    prev = seed
    for i in range(length, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(closes, length=14):
    """Wilder's RSI."""
    out = [None] * len(closes)
    if len(closes) <= length:
        return out
    gains = losses = 0.0
    for i in range(1, length + 1):
        ch = closes[i] - closes[i - 1]
        gains += max(ch, 0.0)
        losses += max(-ch, 0.0)
    avg_g, avg_l = gains / length, losses / length
    out[length] = _rsi_val(avg_g, avg_l)
    for i in range(length + 1, len(closes)):
        ch = closes[i] - closes[i - 1]
        avg_g = (avg_g * (length - 1) + max(ch, 0.0)) / length
        avg_l = (avg_l * (length - 1) + max(-ch, 0.0)) / length
        out[i] = _rsi_val(avg_g, avg_l)
    return out


def _rsi_val(avg_g, avg_l):
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return 100.0 - 100.0 / (1.0 + rs)


def atr(highs, lows, closes, length=14):
    """Wilder's Average True Range."""
    n = len(closes)
    out = [None] * n
    if n <= length:
        return out
    trs = [highs[0] - lows[0]]
    for i in range(1, n):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    prev = sum(trs[1:length + 1]) / length
    out[length] = prev
    for i in range(length + 1, n):
        prev = (prev * (length - 1) + trs[i]) / length
        out[i] = prev
    return out


def sma(values, length):
    """Simple moving average; tolerates None values during warm-up."""
    out = [None] * len(values)
    for i in range(length - 1, len(values)):
        window = values[i - length + 1:i + 1]
        if None not in window:
            out[i] = sum(window) / length
    return out


def smma(values, length):
    """TradingView SMMA (= Wilder's RMA): seeded with an SMA, then (prev*(n-1)+x)/n."""
    out = [None] * len(values)
    if len(values) < length:
        return out
    prev = sum(values[:length]) / length
    out[length - 1] = prev
    for i in range(length, len(values)):
        prev = (prev * (length - 1) + values[i]) / length
        out[i] = prev
    return out


def stoch_rsi(closes, k=3, d=3, rsi_len=14, stoch_len=14):
    """TradingView 'Stoch RSI': K = SMA(stoch(RSI), k), D = SMA(K, d). Returns (K, D), 0-100."""
    r = rsi(closes, rsi_len)
    raw = [None] * len(closes)
    for i in range(len(closes)):
        win = r[max(0, i - stoch_len + 1):i + 1]
        if i < stoch_len - 1 or None in win:
            continue
        lo, hi = min(win), max(win)
        raw[i] = 100.0 * (r[i] - lo) / (hi - lo) if hi > lo else 0.0
    kk = sma(raw, k)
    return kk, sma(kk, d)


def ut_bot(highs, lows, closes, key=2.0, atr_period=1):
    """'UT Bot Alerts' (QuantNomad/Yo_adriiiiaan version, Heikin Ashi off).
    Returns (trailing_stop, buy, sell) lists; buy/sell are True on signal bars."""
    n = len(closes)
    trs = [highs[0] - lows[0]] + [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]),
                                      abs(lows[i] - closes[i - 1])) for i in range(1, n)]
    a = smma(trs, atr_period) if atr_period > 1 else trs  # Pine atr(1) == true range
    stop = [None] * n
    buy = [False] * n
    sell = [False] * n
    prev = 0.0  # Pine nz(stop[1], 0)
    for i in range(n):
        if a[i] is None:
            continue
        loss = key * a[i]
        src, src1 = closes[i], closes[i - 1] if i else closes[i]
        if src > prev and src1 > prev:
            cur = max(prev, src - loss)
        elif src < prev and src1 < prev:
            cur = min(prev, src + loss)
        elif src > prev:
            cur = src - loss
        else:
            cur = src + loss
        if i:
            buy[i] = src > cur and src1 <= prev    # close crosses above the trailing stop
            sell[i] = src < cur and src1 >= prev   # close crosses below the trailing stop
        stop[i] = cur
        prev = cur
    return stop, buy, sell
