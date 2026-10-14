import { pool } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from '../domain/authz.js';
import { audit } from '../domain/events.js';
import { latestBackup } from '../domain/ops.js';

/**
 * The cutover checklist. IMPORTANT: this is a record-keeping and gating tool. Relay has NO code path that changes number routing, ports a number,
 * contacts Kenect or RingCentral, or cancels anything: those happen outside Relay, by the owner, and are recorded here as evidence.
 */
export interface ItemDef {
  key: string; category: string; title: string; detail: string;
  ownerOnly?: boolean; optional?: boolean; requires?: string[];
  /** The item can only be passed this many days after another item was passed (a validation window). */
  minDaysAfter?: { key: string; days: number };
  /** Automatic evidence from Relay's own data. A failing check blocks "passed" (owner may waive with a written reason). */
  check?: (workspaceId: string) => Promise<{ ok: boolean; detail: string }>;
}

const q = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows;
const batchDone = (kind: string) => async (ws: string) => { const r = await q(`SELECT count(*)::int n, coalesce(sum((counts->>'valid')::int),0)::int v FROM import_batches WHERE workspace_id=$1 AND kind=$2 AND status='committed'`, [ws, kind]); return { ok: r[0].n > 0, detail: r[0].n ? `${r[0].n} committed ${kind} import(s)` : `no committed ${kind} import yet` }; };

export const ITEMS: ItemDef[] = [
  // ---- Discovery (facts that are UNKNOWN today)
  { key: 'd_sms_provider', category: 'Discovery', title: 'Find out who provides SMS for 262-269-0081 today and how Kenect texts on it', detail: 'Ask Kenect support and check the RingCentral admin portal (read-only). Record the answers as evidence. Do not change anything.' },
  { key: 'd_line_type', category: 'Discovery', title: 'Confirm the line type and whether it can be messaging-enabled elsewhere', detail: 'Carrier lookup (landline / VoIP / mobile) and the candidate provider’s hosted-SMS eligibility rules. Provider eligibility rules summarised in INTEGRATION_CAPABILITIES.md are from search summaries only: re-verify on the provider’s current official page.' },
  { key: 'd_kenect_exports', category: 'Discovery', title: 'Ask Kenect which exports exist (contacts, message history, templates, media, opt-outs) and in what format', detail: 'Availability is unknown. Record exactly what Kenect says it can and cannot export. If message history cannot be exported, the disclosure item below applies.' },
  { key: 'd_kenect_contract', category: 'Discovery', title: 'Read the Kenect agreement: term, renewal date, notice period, data-return clause', detail: 'Cancelling is the LAST step and must not be done before the notice requirements are understood.', ownerOnly: true },
  { key: 'd_ringcentral', category: 'Discovery', title: 'Confirm with RingCentral what the number does today (voice, hours routing, voicemail) and whether any SMS on it is in use there', detail: 'Read-only investigation. Relay never alters RingCentral.' },
  // ---- Export / import
  { key: 'e_contacts', category: 'Import', title: 'Contacts imported (staged, reviewed, committed)', detail: 'Preview counts reviewed; duplicates and shared numbers resolved or accepted.', requires: ['d_kenect_exports'], check: batchDone('contacts') },
  { key: 'e_optouts', category: 'Import', title: 'Opt-outs imported and verified (or confirmed there are none)', detail: 'Every Kenect opt-out must exist in Relay before any live text. Spot-check at least 10 numbers against Kenect.', requires: ['d_kenect_exports'], check: async (ws) => { const r = await q(`SELECT count(*)::int n FROM consent_events WHERE workspace_id=$1 AND source IN ('import') AND type='sms_stop'`, [ws]); return { ok: r[0].n > 0, detail: `${r[0].n} imported opt-out(s) in Relay (if Kenect has none, waive with that statement as evidence)` }; } },
  { key: 'e_history', category: 'Import', title: 'Message history imported — or the coverage limit is disclosed to staff in writing', detail: 'If Kenect cannot export history, staff must be told that summaries cover only messages since Relay started.', requires: ['d_kenect_exports'], check: async (ws) => { const r = await q(`SELECT count(*)::int n FROM import_batches WHERE workspace_id=$1 AND kind='messages' AND status='committed'`, [ws]); return { ok: r[0].n > 0, detail: r[0].n ? 'history imported' : 'no history imported: record the disclosure as evidence (summaries show a coverage note)' }; } },
  { key: 'e_templates', category: 'Import', title: 'Templates imported or recreated', detail: 'Review converted merge tokens.', optional: true },
  { key: 'e_media', category: 'Import', title: 'Media: decide what to carry over', detail: 'Message attachments are not fetched by import (needs an authenticated export). Upload files you need to the Media library.', optional: true },
  { key: 'e_reconcile', category: 'Import', title: 'Not-imported reports reviewed and counts reconciled against the source', detail: 'Download each import’s “not imported” CSV; every row accounted for.', requires: ['e_contacts'] },
  { key: 'e_rollback_rehearsed', category: 'Import', title: 'Import rollback rehearsed on staged data', detail: 'Commit and roll back a sample batch in a non-production copy, or confirm the rollback result report.', check: async (ws) => { const r = await q(`SELECT count(*)::int n FROM import_batches WHERE workspace_id=$1 AND status='rolled_back'`, [ws]); return { ok: r[0].n > 0, detail: r[0].n ? 'a rolled-back batch exists' : 'no rolled-back batch yet' }; } },
  // ---- Test number
  { key: 't_provider', category: 'Test number', title: 'SMS provider chosen and a TEMPORARY test number obtained (owner approves any spend)', detail: 'Use a new number, never 262-269-0081. No provider adapter is built until this is decided.', ownerOnly: true },
  { key: 't_inbound', category: 'Test number', title: 'Real inbound text received on the test number; signature verified; no duplicate on retry', detail: 'Evidence: message id, screenshot or log excerpt.', requires: ['t_provider'] },
  { key: 't_outbound', category: 'Test number', title: 'Real outbound text accepted and delivered; statuses shown honestly', detail: 'queued → provider accepted → delivered recorded separately.', requires: ['t_provider'] },
  { key: 't_stop_help', category: 'Test number', title: 'STOP / START / HELP verified end to end; scheduled and broadcast sends suppressed after STOP', detail: 'Use a staff phone.', requires: ['t_provider'] },
  { key: 't_mms', category: 'Test number', title: 'MMS attachment sent and received', detail: 'Carrier size limits recorded.', requires: ['t_provider'], optional: true },
  { key: 't_assistant_off', category: 'Test number', title: 'Sandra is not sending live (autonomy below “send”, or not connected)', detail: 'She is enabled separately and only after the owner connects her.', check: async (ws) => { const r = await q(`SELECT count(*)::int n FROM service_identities WHERE workspace_id=$1 AND status='active' AND autonomy='send'`, [ws]); return { ok: r[0].n === 0, detail: r[0].n ? `${r[0].n} assistant identity(ies) with send autonomy` : 'no assistant has send autonomy' }; } },
  { key: 't_backup', category: 'Test number', title: 'A recent backup exists and a restore rehearsal was done', detail: 'npm run drill:restore; backups < 36 h old.', check: async () => { const b = latestBackup(); return b ? { ok: b.ageHours < 36, detail: `latest backup ${b.ageHours} h old` } : { ok: false, detail: 'no backup found (BACKUP_DIR not set or empty)' }; } },
  // ---- Voice preservation
  { key: 'v_baseline', category: 'Voice (RingCentral)', title: 'Baseline call test recorded BEFORE any change: call rings, hours routing, voicemail, caller ID', detail: 'Place and log test calls from two different carriers.', requires: ['d_ringcentral'] },
  { key: 'v_plan_no_voice_change', category: 'Voice (RingCentral)', title: 'The plan changes SMS handling only; it does not port the whole number or alter voice routing', detail: 'If the only feasible path would move voice, STOP and re-plan with the owner.', ownerOnly: true, requires: ['d_line_type', 'd_ringcentral'] },
  // ---- Pilot
  { key: 'p_training', category: 'Pilot', title: 'Staff trained (inbox, takeover, opt-outs, templates)', detail: 'Everyone who will text customers.', requires: ['t_inbound', 't_outbound'] },
  { key: 'p_pilot', category: 'Pilot', title: 'Staff pilot on the test number completed (suggested: at least a week of real use)', detail: 'Owner decides the length. Record issues found.', requires: ['p_training', 't_stop_help'] },
  { key: 'p_issues', category: 'Pilot', title: 'Pilot issues triaged; no open blocker', detail: 'List remaining non-blockers.', requires: ['p_pilot'] },
  // ---- Cutover
  { key: 'c_plan', category: 'Cutover', title: 'Cutover plan written: date/time outside business hours, who does what, staff comms, customer notice if any', detail: 'Include the exact provider/portal steps once the provider is chosen. Provider constraints (e.g. porting/hosting lead times) are unverified until then.', requires: ['v_plan_no_voice_change', 'e_reconcile'] },
  { key: 'c_rollback_plan', category: 'Cutover', title: 'Rollback/fallback plan written and rehearsed; Kenect stays active throughout', detail: 'How to revert SMS handling, how long reverts take at the provider, who decides, what staff do meanwhile.', requires: ['c_plan'] },
  { key: 'c_go', category: 'Cutover', title: 'OWNER GO decision: change SMS handling for the business number', detail: 'Recorded by the owner after every item above. Relay does not perform the change.', ownerOnly: true, requires: ['d_kenect_contract', 'e_optouts', 'e_history', 'e_rollback_rehearsed', 't_backup', 't_assistant_off', 'v_baseline', 'p_issues', 'c_rollback_plan'] },
  { key: 'c_done', category: 'Cutover', title: 'Cutover performed (outside Relay) and the time recorded', detail: 'Owner records when it happened.', ownerOnly: true, requires: ['c_go'] },
  { key: 'c_post_voice', category: 'Cutover', title: 'Voice re-tested after the change: calls ring, hours routing and voicemail unchanged', detail: 'Compare to the baseline.', requires: ['c_done'] },
  { key: 'c_validation', category: 'Cutover', title: 'Validation period completed: inbound/outbound/opt-out/delivery all healthy', detail: 'The window is enforced (14 days, owner may change it in the app settings). Review delivery failures and unknown outcomes first.', requires: ['c_post_voice'], minDaysAfter: { key: 'c_done', days: 14 } },
  { key: 'c_kenect_cancel', category: 'Cutover', title: 'OWNER APPROVAL to cancel Kenect (after validation)', detail: 'Recorded after validation only. Cancelling happens with Kenect, outside Relay. Export a final copy of everything first.', ownerOnly: true, requires: ['c_validation'] },
];
const byKey = new Map(ITEMS.map((i) => [i.key, i]));
const admin = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required'); };

export async function getChecklist(a: Actor) {
  admin(a);
  const st = new Map((await q('SELECT key, status, evidence, updated_by, updated_at FROM migration_checklist WHERE workspace_id=$1', [a.workspaceId])).map((r) => [r.key as string, r]));
  const win = await validationDays(a.workspaceId);
  type Row = { key: string; category: string; title: string; detail: string; ownerOnly: boolean; optional: boolean; requires: string[]; status: 'pending' | 'passed' | 'waived'; evidence: string | null; updatedAt: string | null; blockedBy: string[]; waitUntil: string | null; autoCheck: { ok: boolean; detail: string } | null };
  const items: Row[] = [];
  for (const d of ITEMS) {
    const s = st.get(d.key); const status = (s?.status ?? 'pending') as 'pending' | 'passed' | 'waived';
    const blockedBy = (d.requires ?? []).filter((k) => !['passed', 'waived'].includes(st.get(k)?.status ?? 'pending'));
    let waitUntil: string | null = null;
    if (d.minDaysAfter) { const base = st.get(d.minDaysAfter.key); if (base && ['passed', 'waived'].includes(base.status)) { const days = d.key === 'c_validation' ? win : d.minDaysAfter.days; const t = new Date(new Date(base.updated_at).getTime() + days * 86400_000); if (t > new Date()) waitUntil = t.toISOString(); } }
    const auto = d.check ? await d.check(a.workspaceId).catch((e) => ({ ok: false, detail: `check failed: ${(e as Error).message}` })) : null;
    items.push({ key: d.key, category: d.category, title: d.title, detail: d.detail, ownerOnly: !!d.ownerOnly, optional: !!d.optional, requires: d.requires ?? [], status, evidence: s?.evidence ?? null, updatedAt: s?.updated_at ?? null, blockedBy, waitUntil, autoCheck: auto });
  }
  const required = items.filter((i) => !i.optional); const open = required.filter((i) => i.status === 'pending');
  const gate = (k: string) => items.find((i) => i.key === k)!.status === 'pending' ? 'pending' : 'recorded';
  return {
    items, validationDays: win,
    summary: { required: required.length, done: required.length - open.length, open: open.map((i) => i.key) },
    // Informational statements derived from the records. None of these cause any action in Relay.
    readiness: { readyForOwnerGoDecision: items.filter((i) => !i.optional && i.key !== 'c_go' && !['c_done', 'c_post_voice', 'c_validation', 'c_kenect_cancel'].includes(i.key) && i.status === 'pending').length === 0, goRecorded: gate('c_go') === 'recorded', cutoverRecorded: gate('c_done') === 'recorded', kenectCancellationApproved: gate('c_kenect_cancel') === 'recorded' },
    notice: 'Relay does not change routing, port numbers, contact Kenect/RingCentral, or cancel anything. These are records of what the owner did elsewhere.',
  };
}
async function validationDays(ws: string) { const r = await q(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='migration_validation_days'`, [ws]); const n = Number(r[0]?.value); return Number.isFinite(n) && n >= 1 && n <= 90 ? n : 14; }
export async function setValidationDays(a: Actor, days: number) {
  if (a.role !== 'owner') throw new HttpError(403, 'only the owner can change the validation window'); if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'days must be 1–90');
  await pool.query(`INSERT INTO workspace_settings (workspace_id, key, value, updated_by) VALUES ($1,'migration_validation_days',$2,$3) ON CONFLICT (workspace_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [a.workspaceId, String(days), a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'migration.validation_days', meta: { days } });
}

/** Record an item as passed / waived / back to pending. Passing needs evidence text; prerequisites, the owner-only rule, the validation window and automatic checks are enforced here, not in the UI. */
export async function setItem(a: Actor, key: string, input: { status: string; evidence?: string }) {
  admin(a); const d = byKey.get(key); if (!d) throw new HttpError(404, 'unknown checklist item');
  if (!['passed', 'waived', 'pending'].includes(input.status)) throw new HttpError(400, 'status must be passed, waived or pending');
  const evidence = (input.evidence ?? '').trim();
  if (d.ownerOnly && a.role !== 'owner') throw new HttpError(403, 'only the owner can record this item');
  if (input.status !== 'pending' && evidence.length < 5) throw new HttpError(400, 'evidence is required (what was checked, by whom, when)');
  if (input.status === 'waived' && a.role !== 'owner') throw new HttpError(403, 'only the owner can waive an item');
  const cl = await getChecklist(a); const it = cl.items.find((i) => i.key === key)!;
  if (input.status === 'passed' || input.status === 'waived') {
    if (it.blockedBy.length && input.status === 'passed') throw new HttpError(409, `blocked by earlier items: ${it.blockedBy.join(', ')}`, { blockedBy: it.blockedBy });
    if (it.blockedBy.length && input.status === 'waived') throw new HttpError(409, `a waiver cannot skip earlier items: ${it.blockedBy.join(', ')}`, { blockedBy: it.blockedBy });
    if (it.waitUntil && input.status === 'passed') throw new HttpError(409, `the validation window is not over until ${it.waitUntil}`, { waitUntil: it.waitUntil });
    if (it.waitUntil && input.status === 'waived') throw new HttpError(409, `the validation window cannot be waived (until ${it.waitUntil})`);
    if (input.status === 'passed' && it.autoCheck && !it.autoCheck.ok) throw new HttpError(409, `Relay’s own check does not support this yet: ${it.autoCheck.detail}. The owner can waive it with a written reason.`, { check: it.autoCheck });
  }
  if (input.status === 'pending') {
    const later = ITEMS.filter((x) => (x.requires ?? []).includes(key) && cl.items.find((i) => i.key === x.key)!.status !== 'pending');
    if (later.length) throw new HttpError(409, `later items depend on this one: ${later.map((x) => x.key).join(', ')}; reopen those first`);
  }
  await pool.query(`INSERT INTO migration_checklist (workspace_id, key, status, evidence, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (workspace_id, key) DO UPDATE SET status=EXCLUDED.status, evidence=EXCLUDED.evidence, updated_by=EXCLUDED.updated_by, updated_at=now()`, [a.workspaceId, key, input.status, input.status === 'pending' ? null : evidence, a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: `migration.item.${input.status}`, targetType: 'migration_item', targetId: key, meta: { evidence: evidence.slice(0, 300) } });
  return { ok: true };
}
