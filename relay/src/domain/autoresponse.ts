import { pool } from '../db/pool.js';
import { classifyKeyword } from './consent.js';
import { loadAutomationSettings, loadHours, openState } from './hours.js';
import { queueOutbound } from './messaging.js';
import { render } from './templates.js';

/** Variables available to automated text: only business-entered facts and the contact's real first name. */
export async function automationVars(workspaceId: string, contactId: string): Promise<Record<string, string>> {
  const v: Record<string, string> = { business_name: 'Sun Sport Marine' };
  for (const r of (await pool.query('SELECT key, value FROM workspace_settings WHERE workspace_id=$1', [workspaceId])).rows) v[r.key] = r.value;
  const c = (await pool.query('SELECT first_name, last_name FROM contacts WHERE id=$1', [contactId])).rows[0];
  const first = c?.first_name && !/^\+?\d[\d\s()-]*$/.test(c.first_name) ? c.first_name : '';
  v.first_name = first; v.last_name = c?.last_name ?? ''; v.full_name = [first, c?.last_name].filter(Boolean).join(' ');
  return v;
}

async function note(workspaceId: string, contactId: string, conversationId: string, summary: string) {
  await pool.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'automation',$4)`, [workspaceId, contactId, conversationId, summary]);
}

/**
 * Reply to an inbound text with a first-contact greeting or an after-hours/holiday notice.
 * Skips (and records why) when: disabled, globally paused, a human/Sandra owns the thread, staff already replied, the text was a STOP/HELP keyword,
 * a notice was already sent within the cadence window, or required details are missing. Never sends two notices for one inbound.
 */
export async function handleAutoResponse(conversationId: string, inboundMessageId: string): Promise<{ sent: boolean; reason: string }> {
  const conv = (await pool.query(`SELECT c.*, ws.global_automation_pause FROM conversations c JOIN workspaces ws ON ws.id=c.workspace_id WHERE c.id=$1`, [conversationId])).rows[0];
  const msg = (await pool.query(`SELECT * FROM messages WHERE id=$1 AND direction='inbound'`, [inboundMessageId])).rows[0];
  if (!conv || !msg) return { sent: false, reason: 'not_found' };
  const ws = conv.workspace_id as string;
  const st = await loadAutomationSettings(pool, ws);
  const skip = async (reason: string, log = true) => { if (log && st.auto_response_enabled) await note(ws, conv.contact_id, conversationId, `Auto-response skipped: ${reason.replaceAll('_', ' ')}`); return { sent: false, reason }; };
  if (!st.auto_response_enabled) return skip('disabled', false);
  if (conv.global_automation_pause) return skip('global_pause');
  if (classifyKeyword(msg.body)) return skip('compliance_keyword', false);
  if (conv.handling_mode !== 'human') return skip(`handling_mode_${conv.handling_mode}`);
  const staffReplied = await pool.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND direction='outbound' AND sender_type IN ('staff','sandra') AND status<>'suppressed' AND created_at >= $2 LIMIT 1`, [conversationId, msg.created_at]);
  if (staffReplied.rowCount) return skip('staff_already_replied');

  const hours = await loadHours(pool, ws);
  const now = openState(hours, new Date());
  const prior = (await pool.query(`SELECT auto_kind, created_at FROM messages WHERE conversation_id=$1 AND direction='outbound' AND auto_kind IN ('first_contact','after_hours','holiday') AND status<>'suppressed' ORDER BY created_at DESC`, [conversationId])).rows;
  const firstInbound = (await pool.query(`SELECT id FROM messages WHERE conversation_id=$1 AND direction='inbound' ORDER BY seq LIMIT 1`, [conversationId])).rows[0];
  const everReplied = (await pool.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND direction='outbound' AND status<>'suppressed' AND (auto_kind IS NULL OR auto_kind NOT IN ('first_contact','after_hours','holiday')) LIMIT 1`, [conversationId])).rowCount;

  let kind: 'first_contact' | 'after_hours' | 'holiday' | null = null; let text: string | null = null;
  if (now.state === 'closed') {
    const recent = prior.find((p) => ['after_hours', 'holiday'].includes(p.auto_kind) && Date.now() - new Date(p.created_at).getTime() < st.cadence_hours * 3600_000);
    if (recent) return skip('notice_already_sent_recently');
    if (now.reason === 'holiday') { kind = 'holiday'; text = now.holiday?.notice || st.holiday_message || st.after_hours_message; }
    else { kind = 'after_hours'; text = st.after_hours_message; }
  } else if (firstInbound?.id === inboundMessageId && !everReplied && !prior.some((p) => p.auto_kind === 'first_contact')) { kind = 'first_contact'; text = st.first_contact_message; }
  if (!kind) return skip('nothing_to_send', false);
  if (!text?.trim()) return skip(`no_${kind}_message_configured`);

  const { text: body, missing } = render(text, await automationVars(ws, conv.contact_id));
  if (missing.length) return skip(`missing_details_${missing.join('_')}`);
  const r = await queueOutbound({ workspaceId: ws, conversationId, body, senderType: 'automation', purpose: 'conversational', idempotencyKey: `autoresp:${inboundMessageId}`, expectedRevision: conv.revision, autoKind: kind, passive: true });
  if (!r.ok) return skip(r.reason);
  await note(ws, conv.contact_id, conversationId, `Auto-response sent (${kind.replace('_', ' ')})`);
  return { sent: true, reason: kind };
}
