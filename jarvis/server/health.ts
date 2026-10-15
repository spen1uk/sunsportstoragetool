import fs from 'node:fs';
import type { DB } from './db.ts';
import { getMeta, setMeta } from './db.ts';
import { config } from './config.ts';
import { backupStatus } from './backup-run.ts';
import { status as bridgeStatus } from './bridge.ts';

/**
 * "Is anything wrong that Luke would want to know about?" Cheap checks only, no model calls, nothing leaves the machine.
 * `urgent` problems also turn the external heartbeat into a failure signal and appear in the briefing; `warn` ones show in Settings.
 */
export type Issue = { key: string; level: 'urgent' | 'warn'; text: string; link: string };
export type Check = { key: string; ok: boolean; label: string; detail: string };
const H = 3_600_000;
export const backupDir = () => process.env.JARVIS_BACKUP_DIR || '';
let dbCheck = { at: 0, ok: true, detail: 'ok' };

export function checks(db: DB, now = Date.now()): Check[] {
  const out: Check[] = [];
  // database health (quick_check is fast on a small database; cached for 10 minutes)
  if (now - dbCheck.at > 10 * 60_000) { try { const r = (db.prepare('PRAGMA quick_check').get() as any).quick_check; dbCheck = { at: now, ok: r === 'ok', detail: String(r) }; } catch (e) { dbCheck = { at: now, ok: false, detail: (e as Error).message.slice(0, 120) }; } }
  out.push({ key: 'database', ok: dbCheck.ok, label: 'Database', detail: dbCheck.ok ? 'healthy' : `integrity problem: ${dbCheck.detail}` });
  // free disk space where the data lives
  try { const s = fs.statfsSync(fs.existsSync(config.dataDir) ? config.dataDir : '.'); const free = s.bavail * s.bsize, pct = s.bavail / Math.max(1, s.blocks); out.push({ key: 'disk', ok: free > 500e6 && pct > 0.05, label: 'Disk space', detail: `${(free / 1e9).toFixed(1)} GB free (${Math.round(pct * 100)}%)` }); } catch { /* not available on this platform */ }
  // backups: only expected once a backup key exists
  const bs = backupStatus(db);
  if (bs.hasKey) {
    const age = bs.last ? now - bs.last.at : Infinity;
    out.push({ key: 'backup', ok: age < 36 * H, label: 'Encrypted backup', detail: bs.last ? `last ${Math.round(age / H)} h ago` : 'none made yet' });
    if (bs.last && !bs.last.auditChainOk) out.push({ key: 'backup-chain', ok: false, label: 'Backup tamper check', detail: 'the activity log inside the latest backup failed its tamper check' });
    // off-site: only expected once a Mac helper has been set up (it is what pulls the copies)
    if (bridgeStatus(db).configured && bs.last) {
      const off = offsiteStatus(db), pulled = !!off && off.name === bs.last.file, young = now - bs.last.at < 12 * H;   // give the helper a few hours to fetch a new file
      out.push({ key: 'offsite', ok: pulled || young, label: 'Off-server copy', detail: pulled ? 'newest backup is also on your Mac' : off ? `last copy to your Mac was ${off.name}; a newer backup is waiting` : 'no copy pulled yet' });
    }
  }
  const hb = heartbeatStatus(db);
  out.push({ key: 'heartbeat', ok: true, label: 'External alert', detail: hb.configured ? (hb.last ? `${hb.last.ok ? 'last ping ok' : 'last ping FAILED'} ${Math.round((now - hb.last.at) / 60_000)} min ago` : 'configured, waiting for first ping') : 'not set up (optional): you only hear about problems when you open Jarvis' });
  return out;
}

export function healthIssues(db: DB, now = Date.now()): Issue[] {
  const issues: Issue[] = [];
  for (const c of checks(db, now)) {
    if (c.ok) continue;
    if (c.key === 'database') issues.push({ key: c.key, level: 'urgent', text: `Database problem: ${c.detail}. Stop and restore from a backup.`, link: '#/settings' });
    else if (c.key === 'disk') issues.push({ key: c.key, level: 'urgent', text: `Low disk space: ${c.detail}.`, link: '#/settings' });
    else if (c.key === 'backup') issues.push({ key: c.key, level: 'urgent', text: `The encrypted backup is overdue (${c.detail}).`, link: '#/settings' });
    else if (c.key === 'backup-chain') issues.push({ key: c.key, level: 'urgent', text: `Backup warning: ${c.detail}.`, link: '#/activity' });
    else if (c.key === 'offsite') issues.push({ key: c.key, level: 'warn', text: `Backups have not been copied off the server recently (${c.detail}). Is your Mac helper running?`, link: '#/settings' });
  }
  return issues;
}

// ---- off-server copy bookkeeping (the Mac helper pulls encrypted backups and confirms each one) ----
export const offsiteStatus = (db: DB): { name: string; at: number } | null => { try { return JSON.parse(getMeta(db, 'offsite_last') ?? 'null'); } catch { return null; } };
export const recordOffsite = (db: DB, name: string, at = Date.now()) => setMeta(db, 'offsite_last', JSON.stringify({ name, at }));

// ---- heartbeat status (the sender is in heartbeat.ts) ----
export const heartbeatConfigured = () => !!process.env.JARVIS_HEARTBEAT_URL;
export const heartbeatStatus = (db: DB) => { let last = null; try { last = JSON.parse(getMeta(db, 'heartbeat_last') ?? 'null'); } catch { /* none */ } return { configured: heartbeatConfigured(), host: heartbeatHost(), last }; };
export function heartbeatHost(): string | null { try { return process.env.JARVIS_HEARTBEAT_URL ? new URL(process.env.JARVIS_HEARTBEAT_URL).hostname : null; } catch { return null; } }
