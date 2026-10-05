# Paper Trading Bot (BloFin, $100, conservative, self-improving)

An automated crypto trading bot that **paper trades** a $100 account using live BloFin prices,
24/7. It logs every trade, reviews its own results and only changes its rules when a change
proves itself on data it wasn't tuned on.

> **Paper money only.** No API keys and no real orders. Nothing in this folder can place a
> real trade. Live trading is a later, deliberate step (see *Going live*).

## What it does

| You asked for | How it works |
|---|---|
| Start with $100, paper trade | `starting_balance: 100` in `config.json`. Simulated fills use real BloFin prices, plus fees (0.06%) and slippage (0.05%). |
| Conservative | Risks 1% per trade, max 2 positions, no leverage, and a stop-loss on every trade. Daily loss limit 3%. Pauses 24h after 3 losses in a row. Stops itself at 20% drawdown. |
| Follow a trading course's rules | `playbook/RULES.md` is where your rules go. `tradebot/strategy.py` is the coded version. Every trade records *why* it entered. |
| Log of every trade | `data/trades.csv` (opens in Excel/Sheets) and `data/report.html`: entry/exit time and price, P&L, reason, R multiple, best open profit (MFE). |
| Updates over time | `python run.py status` anytime. A daily summary goes to Discord or Telegram if you set one up. |
| Learn from mistakes / "could have made more" | Every 24h it reviews trades: losers that were in profit first, winners that kept running after exit, stops that were too tight. It then tests fixes (see below). |
| Run 24/7 without touching it | `python run.py run` on an always-on machine (Docker/systemd files in `deploy/`). Restarts recover the account and open trades. |

### How the self-improvement works (and why it's safe)

1. **Review:** writes plain-English lessons to `data/learning_log.md`.
2. **Propose:** small changes to strategy settings (stop width, target, breakeven, trailing stop,
   RSI band, time limit), plus anything the review or Claude suggests. Only settings inside hard
   limits can change. **Risk limits are never changed by the bot.**
3. **Prove it (walk-forward test):** the change has to beat the current rules on older history
   *and* on the most recent period it was never chosen on. A change that only looks good on the
   data it was picked from is rejected as curve-fit. That's the point of your video's caption:
   evaluate, don't data-mine.
4. **Adopt or reject:** both are logged. Undo the last change with `python run.py rollback`.

### Loss autopsy (cutting avoidable losses)

Every trade records what the market looked like when it entered: how stretched the price
was, how strong the trend was, volatility, whether the EMA ribbon was lined up, and whether
Bitcoin's trend agreed. Each learning cycle, the bot looks for what its **losing** trades had
in common. Example: *"trades entered when price was stretched more than 2.5 ATR past the 50
EMA lost 9R in total (14 losers vs 3 winners)."* It then tests a filter that would have
skipped them. The filter is kept only if results improve on data it hasn't seen, because
every filter also blocks some winners.

Rules from Calvin Hill's ebook (EMA ribbon, Bitcoin trend, don't chase/FOMO, take partial
profits) are built in as optional rules the learner can switch on. See `playbook/RULES.md`.

**About "eliminating losses":** no strategy wins every trade. Losses are the cost of trading. The
goal is small, controlled losses (about 1% each) and winners bigger than losers. A bot claiming
it never loses is either lying or hiding risk.

## Quick start (on your computer)

Needs Python 3.10+. No other packages are required.

```bash
cd trading-bot
python run.py demo        # offline walkthrough on SIMULATED prices
python run.py backtest    # test the rules on ~4 months of real BloFin 1H data
python run.py run         # start paper trading (leave it running)
```

Other commands:

```bash
python run.py status      # balance, open trades, last trades
python run.py report      # refresh data/report.html and data/trades.csv
python run.py learn       # run a self-improvement cycle now
python run.py resume      # after the 20% drawdown kill switch, once you've reviewed why
python run.py rollback    # undo the last rule change
python -m unittest discover tests   # run the tests
```

## Running 24/7

Your laptop sleeps, so the bot needs a small always-on cloud server. About $4-6/month from
DigitalOcean, Vultr, Hetzner, Linode or similar.

1. **Create the server.** Pick the cheapest Ubuntu 24.04 plan (1 CPU / 1 GB RAM is plenty).
   Region: start with one near you. If BloFin blocks it, step 4 will tell you; recreate the
   server in another region.
2. **Log in.** The provider shows a command like `ssh root@<server-ip>`. Run it in Terminal
   (Mac) or PowerShell (Windows).
3. **Copy the bot onto it:**
   `git clone https://github.com/spen1uk/sunsportstoragetool.git && cd sunsportstoragetool/trading-bot`
   (if the repo is private, GitHub asks you to log in. Use a personal access token as the
   password: GitHub → Settings → Developer settings → Tokens.)
4. **Run the setup script:** `bash deploy/setup_vps.sh`. It installs Python, checks BloFin
   works from that server, runs the tests and starts the bot as a service that restarts
   after crashes or reboots.
5. **Phone updates (optional):** `nano .env`, paste your Discord webhook or Telegram details,
   then `sudo systemctl restart tradebot`.

Check on it anytime: `ssh` in and run `python3 run.py status`, or download `data/report.html`.

Prefer Docker? `docker compose -f deploy/docker-compose.yml up -d --build`.

## Getting updates on your phone

Put these in `.env` (copy `.env.example`) or `config.json` → `reports`:

- **Discord:** channel settings → Integrations → Webhooks → copy URL → `DISCORD_WEBHOOK_URL`
- **Telegram:** create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`, plus your `TELEGRAM_CHAT_ID`

You'll get a message on every closed trade, a daily summary, and a note every time the bot changes its rules.

## Claude reviews (optional)

Set `claude_review.enabled: true`, run `pip install -r requirements.txt` and set `ANTHROPIC_API_KEY`.
Each learning cycle, Claude reads the journal and `playbook/RULES.md` and writes a coaching
review into `data/learning_log.md`. Claude's suggested changes go through the **same
walk-forward test**; they are never applied blindly. The API request enables server-side
refusal fallback (`fallbacks: "default"`). This uses API credits: about one call per day.

## Adding your course rules

1. Fill in `playbook/RULES.md` with each rule as an exact, testable condition.
2. Open Claude Code in this repo and ask it to add the rule to `tradebot/strategy.py`, with a test.
3. `python run.py backtest` and compare with before. Keep the rule only if it helps.

## Going live (later; not built yet, on purpose)

Don't switch to real money until **all** of these are true:

- [ ] 3+ months of paper trading, 100+ closed trades
- [ ] Paper results are close to the backtest (no big surprise gap)
- [ ] Positive average R and max drawdown under 15% over that period
- [ ] You've read every losing trade in the log and agree with how it was handled
- [ ] You're fine losing the whole $100

Then the next step is a BloFin order adapter using their **demo trading** API keys first, with
withdrawal permission disabled and an IP whitelist on the key. Ask Claude Code to build that step.

## Files

```
config.json           all settings (symbols, timeframe, risk, learning limits)
playbook/RULES.md     your trading rules in plain English
tradebot/strategy.py  the rules as code
tradebot/engine.py    paper broker + risk manager (shared by backtest and live)
tradebot/learner.py   review -> propose -> walk-forward test -> adopt
tradebot/runner.py    the 24/7 loop
data/                 created at runtime: journal.db, trades.csv, report.html, learning_log.md, bot.log
```

*Not financial advice. Crypto is volatile and you can lose money. This is an educational tool.*
