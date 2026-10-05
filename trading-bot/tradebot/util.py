import datetime as _dt
import uuid


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def ts_iso(ms):
    return _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


def utc_day(ms):
    return _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).strftime("%Y-%m-%d")


def new_id():
    return uuid.uuid4().hex[:10]


BAR_MS = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1H": 3_600_000, "2H": 7_200_000, "4H": 14_400_000, "1D": 86_400_000,
}
