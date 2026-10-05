# Trading Playbook

This file is the bot's rulebook in plain English. Claude reads it during every
review (when `claude_review.enabled` is on) and judges each trade against it.

## Source 1: *The Crypto Cheat Guide* (Calvin Hill, 2025 ebook): reviewed

The ebook is a beginner's investing guide (exchanges, portfolio split, wallets,
market cycles, DCA, mistakes, scams). **It contains no entry/exit trading rules.**
Those are expected in his *Super Simple Crypto Trading System* video course.
These are the parts that translate into bot rules:

| Ebook says (page) | Bot rule | Setting | Default |
|---|---|---|---|
| Market Cipher A = 8-EMA ribbon; bullish when the ribbon turns blue/white (p.34) | Only enter when the 8 EMAs are stacked in trade direction | `ribbon_filter`, `ribbon_lengths` | off; learner tests it |
| "Bitcoin holds significant influence over market trends"; bull/bear cycles (p.5, 20-23) | Longs only while BTC is above its 200-EMA; shorts only below | `btc_filter` | off; learner tests it |
| Mistake #6: don't buy all-time highs / FOMO (p.36) | Skip entries when price is stretched too far above the 50-EMA | `max_extension_atr` | off; loss autopsy proposes a level |
| Mistake #1: not taking profits; take profits at set levels (p.35) | Bank 50% of the position at +X R | `partial_tp_r`, `partial_tp_pct` | off; learner tests it |
| Mistake #9: chasing losses (p.36) | Never raise risk after losses; pause after 3 losses in a row | `risk.pause_after_consecutive_losses` | on (fixed) |
| Mistake #8: ignoring fees (p.36) | Every simulated trade pays taker fees + slippage | `fees` | on (fixed) |
| Mistake #5: only invest what you can afford to lose (p.35) | 1% risk per trade, 20% drawdown kill switch, paper first | `risk` | on (fixed) |
| Trading exchanges with leverage: BloFin/Bybit 3x-10x (p.5) | **Not used.** The bot runs 1x (no leverage) until paper results prove the strategy | `risk.max_leverage` | 1.0 |

The ribbon now uses Calvin's own settings (20-55) from his TradingView screenshots;
see Source 2.

## Source 2: Calvin's indicator set (TradingView screenshots, Oct 2026): built in

| Indicator | Settings (from his screenshots) | Config keys |
|---|---|---|
| EMA ribbon (8 lines, yellow -> blue) | 20, 25, 30, 35, 40, 45, 50, 55 on close | `ribbon_lengths` |
| SMMA (white) | 50 on close | `smma_len` |
| UT Bot Alerts | Key value 2, ATR period 1, Heikin Ashi off | `ut_key`, `ut_atr` |
| Stoch RSI | K 3, D 3, RSI 14, Stochastic 14, bands 80 / 20 | `stoch_*` |
| Chart timeframe | 1D (BTC/USDT) | `timeframe` |

All four are standard open-source TradingView indicators; the bot computes them with the
same formulas (see `tradebot/indicators.py`; tested).

**How the bot combines them (`strategy.name = "calvin_system"`).** This is **my reading of
the chart, not confirmed by Calvin yet.** Correct anything that's wrong:

1. **Trigger:** UT Bot prints BUY on a closed daily candle.
2. **Trend (ribbon):** price above all 8 ribbon EMAs, and the ribbon stacked bullish
   (20 above 25 above ... 55). Toggle: `ribbon_filter`.
3. **Trend (SMMA):** price above the SMMA 50. Toggle: `smma_filter`.
4. **Timing (Stoch RSI):** K above D and K below 80 (not overbought). Toggle: `stoch_filter`,
   level: `stoch_max`.
5. **Exit:** UT Bot SELL (`ut_exit`), or the safety stop (1.5 x ATR14), or target (3R).
   The stop is always on.
6. Shorts (UT SELL below a bearish ribbon) are off: `allow_shorts`.

The learner may switch any of these filters off or adjust `stoch_max` / `ut_key` **only if**
the change wins on unseen data.

**Open questions for the course:**
- Does he require UT Bot BUY *and* the ribbon/SMMA, or does he use the ribbon alone?
- Stoch RSI: buy when K crosses up from below 20, or just K above D?
- Where is his stop-loss: below the UT Bot line, below the ribbon, or a % amount?
- How does he take profit: UT SELL, a % target, or scaling out?
- Does he trade the daily only, or lower timeframes (4H/1H) too? Which coins?

## Source 3: indicators you're adding next: TODO

| Indicator | Settings | How it's used (entry / exit / filter) |
|---|---|---|
| | | |

## Non-negotiables (enforced in code, never changed by the bot itself)

1. Risk per trade: 1% of the account. Max 2 positions open. No leverage (1x).
2. Every trade has a stop-loss from the moment it opens.
3. Daily loss limit 3%: no new trades until tomorrow (UTC).
4. 3 losses in a row: pause new entries for 24 hours.
5. Account 20% below its peak: the bot stops opening trades until a human
   reviews it and runs `python run.py resume`.
6. Paper money only until the go-live checklist in the README is met.
