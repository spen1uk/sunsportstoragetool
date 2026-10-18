import { type DB, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';

/**
 * Per-mission spending caps. A model call tagged with a `ref` that has a mission budget is refused once that mission's own spend plus the
 * call's estimate would pass its cap, on top of the global monthly cap and daily ceiling (which always apply). Spend is read from the usage
 * ledger, so it cannot drift from what was really recorded.
 */
export const spentOn = (db: DB, ref: string) => (db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND ref=?').get(ref) as { s: number }).s;
export function create(db: DB, ref: string, label: string, capMicro: number, now = Date.now()) {
  if (!/^[a-z0-9:_-]{1,60}$/i.test(ref)) throw new Error('bad mission reference');
  if (!Number.isInteger(capMicro) || capMicro < 1_000 || capMicro > 50_000_000) throw new Error('A mission budget must be between $0.001 and $50.');
  db.prepare('INSERT INTO mission_budgets(ref,label,cap_micro_usd,created_at) VALUES(?,?,?,?)').run(ref, label.slice(0, 80), capMicro, now);
  audit(db, 'luke', 'mission.budget_set', ref, { capMicro });
}
export const get = (db: DB, ref: string) => db.prepare('SELECT * FROM mission_budgets WHERE ref=? AND closed_at IS NULL').get(ref) as { ref: string; label: string; cap_micro_usd: number } | undefined;
/** Would spending `estMicro` more on this mission pass its cap? (A ref with no budget is not limited here.) */
export function wouldExceed(db: DB, ref: string | undefined, estMicro: number): { exceeded: boolean; capMicro?: number; spentMicro?: number } {
  if (!ref) return { exceeded: false }; const b = get(db, ref); if (!b) return { exceeded: false };
  const spent = spentOn(db, ref); return { exceeded: spent + estMicro > b.cap_micro_usd, capMicro: b.cap_micro_usd, spentMicro: spent };
}
export const list = (db: DB) => (db.prepare('SELECT * FROM mission_budgets ORDER BY created_at DESC LIMIT 100').all() as any[]).map((b) => ({ ref: b.ref, label: b.label, capMicroUsd: b.cap_micro_usd, spentMicroUsd: spentOn(db, b.ref), closed: !!b.closed_at }));
export function close(db: DB, ref: string, now = Date.now()) { db.prepare('UPDATE mission_budgets SET closed_at=? WHERE ref=? AND closed_at IS NULL').run(now, ref); }

/** Defaults Luke approved on 2026-10-18: quick lookup $0.10, deep project $2, proactive exploration $10 a month in total. */
export type Defaults = { quickMicro: number; deepMicro: number; exploreMonthlyMicro: number };
export const DEFAULTS: Defaults = { quickMicro: 100_000, deepMicro: 2_000_000, exploreMonthlyMicro: 10_000_000 };
export function getDefaults(db: DB): Defaults { try { return { ...DEFAULTS, ...JSON.parse(getMeta(db, 'mission:defaults') ?? '{}') }; } catch { return DEFAULTS; } }
export function setDefaults(db: DB, d: Defaults) {
  for (const v of Object.values(d)) if (!Number.isInteger(v) || v < 1_000 || v > 100_000_000) throw new Error('Budgets must be between $0.001 and $100.');
  setMeta(db, 'mission:defaults', JSON.stringify(d)); audit(db, 'luke', 'mission.defaults_set', 'defaults', d);
}
