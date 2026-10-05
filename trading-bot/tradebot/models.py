from dataclasses import dataclass, field, asdict


@dataclass
class Candle:
    ts: int  # open time, epoch milliseconds (UTC)
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


@dataclass
class Signal:
    side: int  # +1 long, -1 short
    entry: float
    stop: float
    target: float
    atr: float
    reasons: list = field(default_factory=list)
    features: dict = field(default_factory=dict)


@dataclass
class Position:
    id: str
    symbol: str
    side: int
    entry_ts: int
    entry_price: float
    qty: float
    stop: float
    initial_stop: float
    target: float
    risk_per_unit: float
    atr: float
    params_version: int
    reasons: list = field(default_factory=list)
    bars_held: int = 0
    best_price: float = 0.0   # most favourable price seen (for MFE)
    worst_price: float = 0.0  # most adverse price seen (for MAE)
    entry_fee: float = 0.0
    breakeven_moved: bool = False
    features: dict = field(default_factory=dict)
    orig_qty: float = 0.0        # size at entry (qty shrinks after a partial take-profit)
    partial_done: bool = False
    partial_pnl: float = 0.0     # gross P&L already banked by the partial take-profit
    partial_fees: float = 0.0

    def to_dict(self):
        return asdict(self)

    @staticmethod
    def from_dict(d):
        return Position(**d)


@dataclass
class Trade:
    id: str
    symbol: str
    side: str  # "LONG" / "SHORT"
    entry_ts: int
    entry_price: float
    exit_ts: int
    exit_price: float
    qty: float
    initial_stop: float
    target: float
    exit_reason: str
    gross_pnl: float
    fees: float
    net_pnl: float
    r_multiple: float
    mfe_r: float  # best unrealised profit during the trade, in R
    mae_r: float  # worst unrealised loss during the trade, in R
    bars_held: int
    balance_after: float
    params_version: int
    entry_reasons: str
    mode: str = "paper"
    features: str = "{}"  # JSON of entry measurements, used by the loss autopsy

    def to_dict(self):
        return asdict(self)
