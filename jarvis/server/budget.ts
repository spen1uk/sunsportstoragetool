import { type DB, tx, id, now } from './db.ts';
import { config } from './config.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';

export const currentPeriod = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
};

export function getCap(db: DB): number {
  const r = db.prepare("SELECT value FROM meta WHERE key='cap_micro_usd'").get() as { value: string } | undefined;
  return r ? Number(r.value) : config.capMicroUsd;
}
/** Only called by the approved `budget_increase` action; there is no automatic increase path. */
export function setCap(db: DB, micro: number) {
  db.prepare("INSERT INTO meta(key,value) VALUES('cap_micro_usd',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(micro));
}

export type BudgetSummary = {
  period: string; capMicroUsd: number; fixedMicroUsd: number; usageMicroUsd: number; reservedMicroUsd: number;
  committedMicroUsd: number; remainingMicroUsd: number; pctCommitted: number; level: 'ok' | 'watch75' | 'limit90' | 'capped';
  note: string;
};

export function summary(db: DB, period = currentPeriod()): BudgetSummary {
  const sum = (kind: string, status: string) => (db.prepare(
    'SELECT COALESCE(SUM(micro_usd),0) s FROM budget_ledger WHERE period=? AND kind=? AND status=?').get(period, kind, status) as { s: number }).s;
  const fixed = sum('fixed', 'active'), usage = sum('usage', 'settled'), reserved = sum('reservation', 'reserved');
  const cap = getCap(db), committed = fixed + usage + reserved, pct = cap ? committed / cap : 1;
  return {
    period, capMicroUsd: cap, fixedMicroUsd: fixed, usageMicroUsd: usage, reservedMicroUsd: reserved, committedMicroUsd: committed,
    remainingMicroUsd: cap - committed, pctCommitted: pct,
    level: committed >= cap ? 'capped' : pct >= 0.9 ? 'limit90' : pct >= 0.75 ? 'watch75' : 'ok',
    note: 'Local conservative accounting. Provider billing is delayed and may differ; fixed recurring fees are reserved first.',
  };
}

export type Reservation = { ok: true; id: string } | { ok: false; reason: string };

/** Reserve estimated cost before dispatch. Optional work is refused from 90%; nothing may cross the cap. */
export function reserve(db: DB, microUsd: number, category: string, opts: { optional?: boolean; ref?: string } = {}): Reservation {
  if (!Number.isInteger(microUsd) || microUsd < 0) return { ok: false, reason: 'invalid estimate' };
  return tx(db, () => {
    const s = summary(db);
    if (opts.optional && s.pctCommitted >= 0.9) return { ok: false as const, reason: 'Optional work is paused at 90% of the monthly cap.' };
    if (s.committedMicroUsd + microUsd > s.capMicroUsd) return { ok: false as const, reason: 'Would exceed the monthly cap; approval to raise it is required.' };
    const rid = id();
    db.prepare("INSERT INTO budget_ledger(id,period,kind,category,micro_usd,status,optional_work,ref,at) VALUES(?,?,?,?,?,'reserved'," +
      '?,?,?)').run(rid, s.period, 'reservation', category, microUsd, opts.optional ? 1 : 0, opts.ref ?? null, now());
    return { ok: true as const, id: rid };
  });
}

/** Replace a reservation with actual usage (or release it when actual is 0). */
export function settle(db: DB, reservationId: string, actualMicroUsd: number, note = '') {
  tx(db, () => {
    const r = db.prepare("SELECT * FROM budget_ledger WHERE id=? AND status='reserved'").get(reservationId) as any;
    if (!r) return;
    db.prepare("UPDATE budget_ledger SET status='released' WHERE id=?").run(reservationId);
    if (actualMicroUsd > 0) {
      db.prepare("INSERT INTO budget_ledger(id,period,kind,category,micro_usd,status,optional_work,ref,note,at) VALUES(?,?,?,?,?,'settled',?,?,?,?)")
        .run(id(), r.period, 'usage', r.category, actualMicroUsd, r.optional_work, r.ref, note, now());
    }
  });
  const s = summary(db);
  if (s.level !== 'ok') publish({ type: 'budget', level: s.level });
}

export function releaseReservation(db: DB, reservationId: string) { settle(db, reservationId, 0); }

export function addFixedCost(db: DB, category: string, microUsd: number, note: string) {
  db.prepare("INSERT INTO budget_ledger(id,period,kind,category,micro_usd,status,note,at) VALUES(?,?,?,?,?,'active',?,?)")
    .run(id(), currentPeriod(), 'fixed', category, microUsd, note, now());
  audit(db, 'luke', 'budget.fixed_cost_added', category, { microUsd, note });
}
