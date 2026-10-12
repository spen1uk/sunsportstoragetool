# Trading & Investing systems: roster, review decisions, and how Jarvis connects

Written 2026-10-12 from Luke's own agent tables. **Statuses (✅ ⚠️ ❌) are Luke's claims about his own system. Jarvis has verified none of them.** The trading system is still being built and will run on its own server; nothing is connected.

## Review decisions
**Trading (16 → 17 members + the Supervisor as the system's "sun").** Keep all except **Reporter**, which Jarvis does (phone updates, daily summary, "why did you take that trade?" from the Scribe log). Added: **Reconciler** (exchange vs. the bot's records, must-have before real money) and **Performance Accountant** (realized vs. unrealized, fees, funding, period). A fee/slippage/funding **cost model** belongs inside Skeptic and the Gatekeeper, not a separate agent.

**Investing (10).** Keep all except **Ask the System**, which is Jarvis chat with a read-only investing snapshot (one chat window, not two). Daily Briefing becomes a section Jarvis folds into the morning briefing. Added: a small **scheduler** (the sun), **Performance Accountant** (shared). Deferred: **Tax Lot Tracker**, **Wallet Safety**.

**Shared engines** (build once, configure twice): Skeptic ≡ Overfitting Critic · Watchdog ≡ Data Watchdog · Loss Investigator/Coach ≡ Post-Mortem Reviewer · Reconciler ≡ Trade Reconciler · Performance Accountant.

## Dashboard grouping
Trading: Inputs (Market Data, Signal, Market Mood) · Risk (Risk Manager) · Execution (Trader, Position Manager, Reconciler) · Records (Scribe, Memory Keeper, Performance Accountant) · Learning (Loss Investigator, Coach, Researcher, Skeptic) · Oversight (Watchdog, Go-Live Gatekeeper). 
Investing: Briefing · Research · Data & Inputs · Portfolio. Single source of truth: `server/roster.ts`.

## Design requirements raised in review
- **Risk Manager** is the veto: the Trader cannot place an order without a one-time, single-use token from Risk. Cap correlated exposure (BTC/ETH ≈ one bet), leverage, distance to liquidation.
- **Stops live on the exchange**, not only in the bot. **Unique client order IDs** so a retry cannot double-order.
- **Skeptic** uses data the Researcher can never see, counts how many ideas were tried (multiple-testing discount), requires a minimum trade count. **Researcher proposals never apply themselves.**
- **Watchdog runs outside the Supervisor** (a watchdog that dies with its subject is useless). Positions need exchange-side stops so a silent bot is survivable.
- **Scribe log is append-only.** **Signal decisions carry the rule-set version.** Add a **second price source** for Market Data cross-checks.
- Decide whether **Market Mood** may change Signal. If it can, it is part of the strategy and must be tested as such.

## Go-Live Gatekeeper: a lock in code, not a checklist
Real orders must be impossible unless **all** hold: enough paper trades over enough time · positive after fees, slippage and funding · drawdown within your limit · a kill-switch test that actually worked · no unresolved Watchdog alerts · exchange key is **trade-only, no withdrawal rights, IP-restricted**, separate from the paper key · initial size is a small fraction · **Luke approves through Jarvis with step-up** (trades and moving money are protected actions).

## How Jarvis connects (read-only first)
Contract (same as every manager): authenticated identity · capability list · **heartbeat** · status · reports · help request · result references · pause. Phase order:
1. **Read-only:** heartbeat, last run, reports, Scribe log pointers, Performance Accountant figures. Anything stale is labelled stale; anything unreported is labelled unavailable. Profit shown only as the Accountant reports it: realized vs. unrealized, fees, period, deposits/withdrawals.
2. **Pause/kill propagation:** Jarvis's Pause tells the trading Supervisor to stop opening trades. Positions stay protected by exchange-side stops.
3. **Approvals:** go-live, rule-change proposals and anything that moves money are approval requests Luke decides in the dashboard.

**Never:** Jarvis holds exchange keys, places or cancels trades, or moves money. The trading server holds its own keys.
**Reporting:** the trading system writes structured events; Jarvis turns them into briefings, alerts and "why did you take that trade?" answers.

## Open questions
- Server/host and language of each system (so the heartbeat client can be built to match). Read-only access to the code when ready.
- Which Investing agents already exist (only Daily Briefing was marked built).
- Whether Market Mood gates Signal.
