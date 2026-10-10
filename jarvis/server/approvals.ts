import { type DB, tx, id, now, canonicalJson, sha256 } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { hasStepUp, type Session } from './auth.ts';
import { isPaused } from './pause.ts';
import { setCap } from './budget.ts';

/** Protected action registry. `handler: null` means no adapter is connected — it can be requested but never executes. */
export type ActionDef = {
  risk: 'standard' | 'high';
  describe: (p: any) => string;
  handler: ((db: DB, p: any) => string) | null;
  unavailableReason?: string;
};

export const ACTIONS: Record<string, ActionDef> = {
  allow_domain: {
    risk: 'high', describe: (p) => `Allow research fetches from ${p.host}`,
    handler: (db, p) => { db.prepare('INSERT OR IGNORE INTO allowed_domains(host,added_at) VALUES(?,?)').run(p.host, now()); return `allowed ${p.host}`; },
  },
  publish_artifact: {
    risk: 'standard', describe: (p) => `Mark "${p.title}" v${p.version} as published (internal only; nothing is sent externally)`,
    handler: (db, p) => {
      const r = db.prepare("UPDATE artifacts SET status='published' WHERE id=? AND current_version=? AND status IN ('approved','in_review')").run(p.artifactId, p.version);
      if (!r.changes) throw new Error('artifact changed since approval was requested');
      return 'marked published internally';
    },
  },
  delete_artifact_permanent: {
    risk: 'high', describe: (p) => `Permanently delete "${p.title}" and all its versions`,
    handler: (db, p) => {
      db.prepare('DELETE FROM review_requests WHERE artifact_id=?').run(p.artifactId);
      db.prepare('DELETE FROM artifact_versions WHERE artifact_id=?').run(p.artifactId);
      db.prepare('DELETE FROM artifacts WHERE id=?').run(p.artifactId);
      return 'deleted';
    },
  },
  budget_increase: {
    risk: 'high', describe: (p) => `Raise the monthly cap to $${(p.newCapMicroUsd / 1e6).toFixed(2)}`,
    handler: (db, p) => { setCap(db, p.newCapMicroUsd); return `cap now ${p.newCapMicroUsd}`; },
  },
  send_message: {
    risk: 'high', describe: (p) => `Send ${p.channel} to ${p.recipient}: "${String(p.text).slice(0, 80)}"`,
    handler: null, unavailableReason: 'No SMS/email adapter is connected. Nothing can be sent.',
  },
  trade_or_transfer: {
    risk: 'high', describe: (p) => `Trade/transfer: ${JSON.stringify(p).slice(0, 80)}`,
    handler: null, unavailableReason: 'No financial connection exists. This action is permanently unavailable in this build.',
  },
};


const TTL_MS = 30 * 60_000;
export const digestOf = (actionType: string, payload: unknown) => sha256(canonicalJson({ actionType, payload }));

export function requestApproval(db: DB, a: { actionType: string; payload: unknown; requestedBy: string; taskId?: string; ttlMs?: number; scope?: string; limits?: object }) {
  const def = ACTIONS[a.actionType];
  if (!def) throw new Error(`unknown action type: ${a.actionType}`);
  const aid = id();
  db.prepare(`INSERT INTO approvals(id,action_type,summary,payload,digest,risk,scope,limits,requested_by,task_id,expires_at,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(aid, a.actionType, def.describe(a.payload), canonicalJson(a.payload), digestOf(a.actionType, a.payload),
    def.risk, a.scope ?? '', JSON.stringify(a.limits ?? {}), a.requestedBy, a.taskId ?? null, Date.now() + (a.ttlMs ?? TTL_MS), now());
  audit(db, a.requestedBy, 'approval.requested', aid, { actionType: a.actionType });
  publish({ type: 'approvals' });
  return aid;
}

export type Decision = { ok: true } | { ok: false; error: string };

/**
 * Record Luke's decision. The caller must echo the exact digest shown on screen (binds approval to payload).
 * High-risk actions need an authenticated dashboard session with recent step-up. Phone/SMS channels are not connected,
 * and caller ID / a bare "yes" can never satisfy this function.
 */
export function decide(db: DB, approvalId: string, decision: 'approve' | 'deny', o: { digest: string; channel: string; session: Session | null }): Decision {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
    if (!a) return { ok: false, error: 'not found' };
    if (a.status !== 'pending') return { ok: false, error: `already ${a.status}` };
    if (a.expires_at < Date.now()) { db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(approvalId); return { ok: false, error: 'expired' }; }
    if (o.digest !== a.digest || digestOf(a.action_type, JSON.parse(a.payload)) !== a.digest) return { ok: false, error: 'digest mismatch — the action changed; review again' };
    if (o.channel !== 'dashboard' || !o.session) return { ok: false, error: 'only the authenticated dashboard can decide approvals in this build' };
    if (decision === 'approve' && a.risk === 'high' && !hasStepUp(o.session)) return { ok: false, error: 'step-up confirmation required' };
    db.prepare('UPDATE approvals SET status=?, decided_at=?, decided_by=?, source_channel=?, decided_digest=? WHERE id=?')
      .run(decision === 'approve' ? 'approved' : 'denied', now(), 'luke', o.channel, o.digest, approvalId);
    audit(db, 'luke', `approval.${decision}`, approvalId, { actionType: a.action_type, digest: a.digest, channel: o.channel });
    publish({ type: 'approvals' });
    return { ok: true };
  });
}

/** Execute an approved action exactly once. The status transition is the lock; the digest is re-verified from stored payload. */
export function execute(db: DB, approvalId: string): { ok: boolean; outcome: string } {
  if (isPaused(db)) return { ok: false, outcome: 'Jarvis is paused; execution blocked.' };
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
    if (!a) return { ok: false, outcome: 'not found' };
    if (a.status !== 'approved') return { ok: false, outcome: `not executable (status: ${a.status})` };
    if (a.expires_at < Date.now()) { db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(approvalId); return { ok: false, outcome: 'approval expired' }; }
    const payload = JSON.parse(a.payload);
    if (digestOf(a.action_type, payload) !== a.digest || a.decided_digest !== a.digest) {
      db.prepare("UPDATE approvals SET status='invalidated', outcome='digest mismatch' WHERE id=?").run(approvalId);
      audit(db, 'system', 'approval.invalidated', approvalId);
      return { ok: false, outcome: 'payload no longer matches what was approved' };
    }
    const def = ACTIONS[a.action_type];
    if (!def?.handler) return { ok: false, outcome: def?.unavailableReason ?? 'no handler' }; // stays 'approved', not consumed
    db.exec('SAVEPOINT act');
    try {
      const outcome = def.handler(db, payload);
      db.exec('RELEASE act');
      db.prepare("UPDATE approvals SET status='executed', executed_at=?, outcome=? WHERE id=?").run(now(), outcome, approvalId);
      audit(db, 'system', 'approval.executed', approvalId, { actionType: a.action_type, outcome });
      publish({ type: 'approvals' });
      return { ok: true, outcome };
    } catch (e) {
      db.exec('ROLLBACK TO act'); db.exec('RELEASE act');
      const msg = (e as Error).message;
      db.prepare("UPDATE approvals SET status='failed', outcome=? WHERE id=?").run(msg, approvalId);
      audit(db, 'system', 'approval.failed', approvalId, { msg });
      return { ok: false, outcome: msg };
    }
  });
}

export function expireStale(db: DB) {
  db.prepare("UPDATE approvals SET status='expired' WHERE status IN ('pending','approved') AND expires_at < ?").run(Date.now());
}
