import { type DB } from './db.ts';
import { isPaused } from './pause.ts';
import { ACTIONS } from './approvals.ts';
import { listDevices } from './devices.ts';
import { list as listStanding, ELIGIBLE } from './standing.ts';
import { status as bridgeStatus } from './bridge.ts';
import { getConfig as web, usedToday } from './websearch.ts';
import { getConfig as weather } from './weather.ts';
import { ACTION_TYPES } from './proposals.ts';
import { list as missionBudgets, getDefaults } from './missionbudget.ts';
import { listPasskeys } from './passkey.ts';
import { list as tempAgents } from './tempagents.ts';
import { exploreCommitted } from './missions.ts';

/** One read-only page of "who and what may do what right now". Everything here is derived from the live records; nothing is cached or guessed. */
export function permissionLedger(db: DB, now = Date.now()) {
  const wc = web(db);
  return {
    switches: { paused: isPaused(db), webSearch: { enabled: wc.enabled, perDay: wc.perDay, usedToday: usedToday(db, now) }, weather: { enabled: !!weather(db) }, passkeys: listPasskeys(db).length },
    devices: listDevices(db, now).map((d) => ({ id: d.id, name: d.name, kind: d.kind, scopes: d.scopes, status: d.status, lastSeen: d.lastSeen, spentMicroUsd: d.spentMicroUsd, limitMicroUsd: d.monthlyLimitMicroUsd, expiresAt: d.expiresAt })),
    helper: bridgeStatus(db),
    standing: listStanding(db, now),
    standingEligible: [...ELIGIBLE],
    domains: (db.prepare('SELECT host, added_at FROM allowed_domains ORDER BY host').all() as { host: string; added_at: string }[]),
    protectedActions: Object.entries(ACTIONS).map(([type, a]) => ({ type, risk: a.risk, runnable: !!a.handler, why: a.unavailableReason ?? null })),
    chatSuggestionKinds: [...ACTION_TYPES],
    tempAgents: tempAgents(db, now).filter((a) => a.live), exploration: exploreCommitted(db, now),
    missionBudgets: missionBudgets(db), budgetDefaults: getDefaults(db),
    neverGrantable: ['approve or confirm anything from a device', 'change settings or permissions from a device', 'send messages', 'spend beyond the budget caps', 'trade or transfer money'],
  };
}
