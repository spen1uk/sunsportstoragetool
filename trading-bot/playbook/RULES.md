# Trading Playbook

This file is the bot's rulebook in plain English. Claude reads it during every
review (when `claude_review.enabled` is on) and judges each trade against it.

**Put your course notes here.** Write your own summary of the rules from the
course you're following (e.g. Calvin Hill's), not copied course material. The
more mechanical a rule is, the better. "Enter when the 1H candle closes back
above the 20 EMA after touching it, in an uptrend" can be coded and tested.
"Enter when it feels strong" can't.

For each rule, fill in:

| Rule | Exact condition (numbers!) | Timeframe | Already in bot? |
|------|----------------------------|-----------|-----------------|
| _example_ Trade with the trend | Price above 200 EMA, 50 EMA above 200 EMA | 1H | Yes - `ema_trend`, `ema_slow` |
| _example_ Enter on pullback | Low touches 20 EMA in last 3 bars, candle closes back above | 1H | Yes - `ema_fast`, `pullback_lookback` |
| _example_ Don't chase | RSI between 40 and 65 at entry | 1H | Yes - `rsi_min`, `rsi_max` |
| _example_ Risk 1% per trade | Stop = 1.5 x ATR; size so stop = 1% of account | - | Yes - `risk_per_trade_pct`, `atr_stop_mult` |
| _example_ Take profit at 2R, protect at 1R | Target 2R, stop to breakeven at +1R | - | Yes - `take_profit_r`, `breakeven_at_r` |
| _your rule_ | | | |
| _your rule_ | | | |

Rules that aren't in the bot yet: open a Claude Code session in this repo and ask
"add rule X from playbook/RULES.md to strategy.py with a test". Then run
`python run.py backtest` to see whether it helps before trusting it.

## Non-negotiables (enforced in code, never changed by the bot itself)

1. Risk per trade: 1% of the account. Max 2 positions open. No leverage (1x).
2. Every trade has a stop-loss from the moment it opens.
3. Daily loss limit 3%: no new trades until tomorrow (UTC).
4. 3 losses in a row: pause new entries for 24 hours.
5. Account 20% below its peak: the bot stops opening trades until a human
   reviews it and runs `python run.py resume`.
6. Paper money only until the go-live checklist in the README is met.
