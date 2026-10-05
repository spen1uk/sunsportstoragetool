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
