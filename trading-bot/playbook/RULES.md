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

The Market Cipher A ribbon lengths in `config.json` (5, 11, 15, 18, 21, 24, 28, 34)
are the commonly cited ones. **Replace them with Calvin's exact indicator settings**
when you have them.

## Source 2: *Super Simple Crypto Trading System* video course: TODO

For each rule from the course, fill in a row. Use your own words and **exact numbers**.
"Enter when the 1H candle closes back above the 20 EMA after touching it" can be
coded and tested. "Enter when it looks strong" can't.

| Rule | Exact condition (numbers!) | Timeframe | Indicator + settings | Entry / exit / filter? |
|------|----------------------------|-----------|----------------------|------------------------|
| | | | | |
| | | | | |

Then ask Claude Code: "add the rules from playbook/RULES.md Source 2 to strategy.py
as optional filters the learner can test." Each new rule goes through the same
walk-forward test as everything else, so a rule only stays on if it helps.

## Non-negotiables (enforced in code, never changed by the bot itself)

1. Risk per trade: 1% of the account. Max 2 positions open. No leverage (1x).
2. Every trade has a stop-loss from the moment it opens.
3. Daily loss limit 3%: no new trades until tomorrow (UTC).
4. 3 losses in a row: pause new entries for 24 hours.
5. Account 20% below its peak: the bot stops opening trades until a human
   reviews it and runs `python run.py resume`.
6. Paper money only until the go-live checklist in the README is met.
