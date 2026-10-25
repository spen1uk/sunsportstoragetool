import { ACTIONS, ALWAYS_ASK } from './approvals.ts';

/**
 * The one table of what Jarvis can do, how risky it is, and what it needs from Luke. It is documentation that a test keeps honest:
 * every protected action in approvals.ts must have a row here, and no row may name an action that does not exist.
 * "asks" says what Luke is asked for:
 *   never    nothing: read-only, or a change inside Jarvis that is trivially undone
 *   request  his own plain-words request is the go-ahead (direct mode); the record is still written and audited
 *   approve  an Approvals card; high-risk ones also need his passphrase or passkey (step-up) and the exact payload is bound by digest
 *   always   waits for him in every mode, including direct mode, and an agent can only ever propose it
 *   cannot   nothing is connected, so it cannot happen at all
 */
export type Ask = 'never' | 'request' | 'approve' | 'always' | 'cannot';
export type Row = { id: string; what: string; risk: 'low' | 'medium' | 'high'; asks: Ask; agents: 'no' | 'read only' | 'propose only'; enforcedIn: string };

const ROWS: Row[] = [
  { id: 'read', what: 'Read his tasks, notes, calendar, memory, search the web (walled off from private data)', risk: 'low', asks: 'never', agents: 'read only', enforcedIn: 'skills/registry.ts, websearch.ts' },
  { id: 'memory.write', what: 'Remember a fact (including what Jarvis picks up on his own)', risk: 'low', asks: 'never', agents: 'no', enforcedIn: 'memory.ts, autolearn.ts' },
  { id: 'tasks.write', what: 'Add or change tasks, goals, notes', risk: 'low', asks: 'never', agents: 'no', enforcedIn: 'converse.ts, tasks.ts' },
  { id: 'open', what: 'Open web pages, apps, saved sites, drafts (never run anything)', risk: 'low', asks: 'never', agents: 'no', enforcedIn: 'opener.ts' },
  { id: 'browser', what: 'Click safe buttons in the separate Jarvis Browser', risk: 'medium', asks: 'request', agents: 'no', enforcedIn: 'browser.ts, browser-driver.ts' },
  { id: 'research', what: 'Run research and deep research within a per-job budget', risk: 'medium', asks: 'request', agents: 'propose only', enforcedIn: 'missionbudget.ts, deepresearch.ts' },
  { id: 'founder', what: 'Founder skill pack (business topics only)', risk: 'medium', asks: 'request', agents: 'no', enforcedIn: 'founder.ts' },
  { id: 'sandra.read', what: 'Read Sandra\'s counts-only summary', risk: 'low', asks: 'never', agents: 'no', enforcedIn: 'sandra.ts' },
  { id: 'allow_domain', what: 'Allow a new website for research fetches', risk: 'high', asks: 'approve', agents: 'propose only', enforcedIn: 'approvals.ts' },
  { id: 'publish_artifact', what: 'Mark a document published (internal only)', risk: 'medium', asks: 'approve', agents: 'propose only', enforcedIn: 'approvals.ts' },
  { id: 'delete_artifact_permanent', what: 'Permanently delete a document and its versions', risk: 'high', asks: 'approve', agents: 'propose only', enforcedIn: 'approvals.ts' },
  { id: 'calendar_create', what: 'Add a calendar event', risk: 'high', asks: 'request', agents: 'propose only', enforcedIn: 'approvals.ts, calendarwrite.ts' },
  { id: 'calendar_move', what: 'Move a calendar event', risk: 'high', asks: 'request', agents: 'propose only', enforcedIn: 'approvals.ts, calendarwrite.ts' },
  { id: 'calendar_delete', what: 'Delete a calendar event', risk: 'high', asks: 'request', agents: 'propose only', enforcedIn: 'approvals.ts, calendarwrite.ts' },
  { id: 'budget_increase', what: 'Raise the monthly spending cap', risk: 'high', asks: 'always', agents: 'propose only', enforcedIn: 'approvals.ts' },
  { id: 'raise_daily_ceiling', what: 'Raise the daily spending ceiling', risk: 'high', asks: 'always', agents: 'propose only', enforcedIn: 'approvals.ts' },
  { id: 'send_message', what: 'Send a text, email or make a call', risk: 'high', asks: 'cannot', agents: 'propose only', enforcedIn: 'approvals.ts (no adapter connected)' },
  { id: 'trade_or_transfer', what: 'Trade, move or spend money', risk: 'high', asks: 'cannot', agents: 'propose only', enforcedIn: 'approvals.ts (no connection exists)' },
];

/** The table, with the facts that come from the code itself (risk and whether anything can execute) checked against ROWS. */
export function actionPolicy() {
  return ROWS.map((r) => {
    const def = ACTIONS[r.id];
    return { ...r, risk: def ? (def.risk === 'high' ? 'high' as const : 'medium' as const) : r.risk, executable: def ? !!def.handler : null, alwaysAsks: def ? ALWAYS_ASK.has(r.id) : null };
  });
}
export const _rows = ROWS;
