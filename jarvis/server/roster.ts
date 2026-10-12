/**
 * Luke's Trading and Investing agent rosters, as reviewed on 2026-10-12 (see docs/TRADING_INVESTING.md).
 * `claimed` is the status Luke reported for his own system. It is NOT verified by Jarvis: nothing here is connected, so the dashboard
 * always shows it as "claimed". `new` = added in the design review; `later` = deliberately deferred; `jarvis` = provided by Jarvis itself.
 */
export type Claimed = 'built' | 'partial' | 'not_built' | 'new' | 'later' | 'jarvis' | 'unstated';
export type Member = { name: string; does: string; claimed: Claimed; note?: string };
export type Dept = { id: string; name: string; blurb: string; members: Member[] };
export type SystemDef = { id: string; name: string; description: string; depts: Dept[] };

export const TRADING: SystemDef = {
  id: 'trading', name: 'Trading',
  description: 'Calvin-based crypto trading system on BloFin. The manager is the Supervisor, which runs the loop 24/7 and tells every other agent when to act. Still being built; it will run on its own server. PLANNED: nothing is connected, no trade data is shown, and Jarvis never holds exchange keys or places trades. Reporting (phone updates, daily summary, "why did you take that trade?") is done by Jarvis from the trading log.',
  depts: [
    { id: 'trading-inputs', name: 'Inputs', blurb: 'What the system looks at before it decides.', members: [
      { name: 'Market Data', does: 'Pulls BloFin prices and checks them for gaps or bad data.', claimed: 'built', note: 'Review: add a second price source to cross-check bad ticks.' },
      { name: 'Signal', does: "Applies Calvin's rules (UT Bot, ribbon, SMMA, Stoch RSI): buy or no buy, with reasons.", claimed: 'built', note: 'Review: stamp every decision with the rule-set version.' },
      { name: 'Market Mood', does: 'Bull, bear or choppy, plus the Fear & Greed index.', claimed: 'partial', note: 'Claimed: BTC trend only. Decide whether it can change Signal; if so, test it as part of the strategy.' }] },
    { id: 'trading-risk', name: 'Risk', blurb: 'The veto. Locked.', members: [
      { name: 'Risk Manager', does: 'Can veto any trade. Enforces 1% risk, max 2 trades, daily loss limit, losing-streak pause, kill switch.', claimed: 'built', note: 'Review: the Trader should be unable to order without a one-time token from Risk. Also cap correlated exposure, leverage and distance to liquidation.' }] },
    { id: 'trading-exec', name: 'Execution', blurb: 'Places and manages orders; checks reality matches the books.', members: [
      { name: 'Trader', does: 'Places the order: paper now, real BloFin later.', claimed: 'built', note: 'Claimed: paper only. Review: unique client order IDs so a retry cannot double-order.' },
      { name: 'Position Manager', does: 'Watches open trades: stop, breakeven, partial profit, UT Bot sell.', claimed: 'built', note: 'Review: the stop must also exist on the exchange, not only inside the bot.' },
      { name: 'Reconciler', does: 'Compares exchange positions, orders and stops with the bot\'s own records; catches orphaned orders and missing stops.', claimed: 'new', note: 'Added in review. Treat as a must-have before real money.' }] },
    { id: 'trading-records', name: 'Records', blurb: 'The trustworthy memory and numbers.', members: [
      { name: 'Scribe', does: 'Writes every trade and decision to the log.', claimed: 'built', note: 'Review: make the log append-only.' },
      { name: 'Memory Keeper', does: 'Remembers every mistake, what was tried and whether it worked.', claimed: 'partial', note: 'Review: share Jarvis memory rather than building a second one.' },
      { name: 'Performance Accountant', does: 'One trusted source for profit and loss: realized vs unrealized, fees, funding, period.', claimed: 'new', note: 'Added in review. Shared with Investing.' }] },
    { id: 'trading-learning', name: 'Learning', blurb: 'Finds what is going wrong and proposes fixes, under strict testing.', members: [
      { name: 'Loss Investigator', does: 'After trades close, finds what the losers had in common.', claimed: 'built', note: 'Review: no conclusions from small samples.' },
      { name: 'Coach', does: "Reads the log against Calvin's rules and writes a plain-English review.", claimed: 'built', note: 'Claimed: optional (uses Claude). Review: read-only.' },
      { name: 'Researcher', does: "Proposes rule changes from the Investigator's and Coach's findings.", claimed: 'built', note: 'Review: proposals never apply themselves; each needs your approval.' },
      { name: 'Skeptic', does: 'Tests every proposed change on data it has not seen and rejects lucky-looking ones.', claimed: 'built', note: 'Review: use data the Researcher can never see, count how many ideas were tried, require a minimum trade count. Share the engine with Investing\'s Overfitting Critic.' }] },
    { id: 'trading-oversight', name: 'Oversight', blurb: 'Is it alive, and is it allowed to go live?', members: [
      { name: 'Watchdog', does: 'Checks the bot is alive and its data fresh; alerts you if it goes quiet.', claimed: 'partial', note: 'Review: run it separately from the Supervisor. Share the engine with Investing\'s Data Watchdog.' },
      { name: 'Go-Live Gatekeeper', does: 'Blocks real money until paper results pass the checklist.', claimed: 'not_built', note: 'Claimed: checklist on paper only. Review: make it a real lock in code; going live needs your approval through Jarvis with step-up.' },
      { name: 'Reporter', does: 'Phone updates, daily summary, "why did you take that trade?"', claimed: 'jarvis', note: 'Removed as a separate agent in review: Jarvis does this from the Scribe log.' }] },
  ],
};

export const INVESTING: SystemDef = {
  id: 'investing', name: 'Investing',
  description: 'Indicator-based portfolio system that produces a daily report; you place the trades. PLANNED: nothing is connected and no portfolio or indicator data is shown. It needs a small scheduler to trigger the daily, weekly and every-few-hours jobs (added in review). Daily briefing sections are assembled by Jarvis, and "Ask the System" is Jarvis chat with a read-only investing snapshot, not a separate chat.',
  depts: [
    { id: 'investing-briefing', name: 'Briefing', blurb: 'Plain-English explanation after each daily close.', members: [
      { name: 'Daily Briefing', does: 'Explains in plain English what changed, why, and what to do. Explains only.', claimed: 'built', note: 'Review: feeds one section into Jarvis\'s morning briefing instead of a separate page.' },
      { name: 'Ask the System', does: 'Chat: "Why am I in SOL?" "When did MTPI last flip?"', claimed: 'jarvis', note: 'Removed as a separate chat in review: this is Jarvis chat with read-only investing data.' }] },
    { id: 'investing-research', name: 'Research', blurb: 'Improves the indicators, and tries to catch its own over-fitting.', members: [
      { name: 'Indicator Researcher', does: "Grades every pair's 5 indicators, fills unfinished pairs, proposes swaps. Weekly, plus on request.", claimed: 'unstated', note: 'Proposes; you approve.' },
      { name: 'Overfitting Critic', does: 'Second opinion on every proposal: unseen data, neighbouring settings, other pairs. Can veto.', claimed: 'unstated', note: 'Review: same engine as Trading\'s Skeptic.' },
      { name: 'Post-Mortem Reviewer', does: 'Compares what the system said with what happened (whipsaws, late flips, missed moves); writes lessons to memory.', claimed: 'unstated', note: 'Review: same pattern as Trading\'s Loss Investigator and Coach.' }] },
    { id: 'investing-data', name: 'Data & Inputs', blurb: 'Keeps inputs trustworthy and fills the ones not on TradingView.', members: [
      { name: 'Data Watchdog', does: 'Catches stale prices, failed wallet reads, missing data, and indicator values drifting from TradingView. Every few hours.', claimed: 'unstated', note: 'Review: same engine as Trading\'s Watchdog.' },
      { name: 'Off-Chart Inputs Assistant', does: 'Suggests scores for on-chain, 42 Macro and valuation z-scores from public data; you confirm.', claimed: 'unstated', note: 'Review: check the terms of use for any paid or restricted data.' },
      { name: 'Altcoin Screener', does: 'Runs your 13-point large and small alt screeners and proposes coin lists. Weekly.', claimed: 'unstated', note: 'Review: make sure liquidity and manipulation checks are among the 13 points.' }] },
    { id: 'investing-portfolio', name: 'Portfolio', blurb: 'Your holdings versus the plan.', members: [
      { name: 'Trade Reconciler', does: 'After you trade, checks wallets against the target and flags anything missed.', claimed: 'unstated' },
      { name: 'Buy & Hold Steward', does: 'Tracks long-term holdings against their thesis and rebalance bands; flags drift. Weekly.', claimed: 'unstated', note: 'Proposes only.' },
      { name: 'Performance Accountant', does: 'One trusted source for results: realized vs unrealized, fees, period, deposits and withdrawals.', claimed: 'new', note: 'Added in review. Shared with Trading.' },
      { name: 'Tax Lot Tracker', does: 'Cost basis and lots for each rotation. Record-keeping only, not tax advice.', claimed: 'later', note: 'Deferred. Check with an accountant.' },
      { name: 'Wallet Safety', does: 'Watches for risky token approvals and lookalike addresses.', claimed: 'later', note: 'Deferred. Only if wallets are involved.' }] },
  ],
};
