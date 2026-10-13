import type { PoolClient } from 'pg';

export type Purpose = 'conversational' | 'transactional' | 'marketing' | 'compliance';
export interface ContactRestrictions {
  inbound_blocked: boolean; outbound_blocked: boolean; do_not_text: boolean; sms_opted_out: boolean; marketing_status: string;
}

/**
 * Single source of truth for "may we text this contact for this purpose?". Called at queue time AND again at execution time.
 *  - 'compliance' (STOP/HELP acknowledgments) is allowed even after opt-out, but not when outbound is administratively blocked.
 *  - Marketing requires explicit marketing opt-in (opt_in_not_received is NOT consent).
 */
export function checkSmsAllowed(c: ContactRestrictions, purpose: Purpose): { allowed: true } | { allowed: false; reason: string } {
  if (c.outbound_blocked) return { allowed: false, reason: 'outbound_blocked' };
  if (purpose === 'compliance') return { allowed: true };
  if (c.sms_opted_out) return { allowed: false, reason: 'sms_opted_out' };
  if (c.do_not_text) return { allowed: false, reason: 'do_not_text' };
  if (purpose === 'marketing' && c.marketing_status !== 'opt_in') return { allowed: false, reason: 'no_marketing_consent' };
  return { allowed: true };
}

const STOP = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START = new Set(['start', 'unstop', 'yes']);
const HELP = new Set(['help', 'info']);
/** Keyword is only recognised when the whole message is the keyword (case/punctuation-insensitive). "yes" alone is NOT treated as START unless previously opted out (checked by caller). */
export function classifyKeyword(body: string): 'stop' | 'start' | 'help' | null {
  const w = body.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP.has(w)) return 'stop';
  if (START.has(w)) return 'start';
  if (HELP.has(w)) return 'help';
  return null;
}

export async function recordConsent(db: PoolClient, args: {
  workspaceId: string; contactId: string; type: string; scope?: string; source: string; evidence?: string; actorUserId?: string | null; occurredAt?: Date;
}) {
  await db.query(
    `INSERT INTO consent_events (workspace_id, contact_id, type, scope, source, evidence, actor_user_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()))`,
    [args.workspaceId, args.contactId, args.type, args.scope ?? 'all', args.source, args.evidence ?? null, args.actorUserId ?? null, args.occurredAt ?? null]);
  const set: Record<string, string> = {
    sms_stop: 'sms_opted_out=true', sms_start: 'sms_opted_out=false',
    marketing_opt_in: `marketing_status='opt_in'`, marketing_opt_out: `marketing_status='opted_out'`,
    inbound_block: 'inbound_blocked=true', inbound_unblock: 'inbound_blocked=false',
    outbound_block: 'outbound_blocked=true', outbound_unblock: 'outbound_blocked=false',
    do_not_text_set: 'do_not_text=true', do_not_text_clear: 'do_not_text=false',
    do_not_email_set: 'do_not_email=true', do_not_email_clear: 'do_not_email=false',
    email_unsubscribe: 'email_unsubscribed=true',
  };
  const s = set[args.type];
  if (s) await db.query(`UPDATE contacts SET ${s}, updated_at=now() WHERE id=$1`, [args.contactId]);
  await db.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary, actor_user_id, origin_table) VALUES ($1,$2,'consent',$3,$4,'consent_events')`,
    [args.workspaceId, args.contactId, `Consent: ${args.type} (${args.source})`, args.actorUserId ?? null]);
}
