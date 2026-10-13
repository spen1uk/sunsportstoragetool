import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import { buildSummary, getSummary, redactMessage, stats, CHUNK_SIZE } from '../src/domain/summary.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { heuristicProvider, registerSummaryProvider, type SummaryProvider } from '../src/providers/summarizer.js';
import { simulatorControl } from '../src/providers/sms.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>;
beforeEach(async () => { registerSummaryProvider(heuristicProvider); stats.providerCalls = 0; s = await resetDb(); sam = actor(s, 'sam', 'staff', ['sales']); owner = actor(s, 'owner', 'owner'); });
afterAll(() => pool.end());

/** Insert history directly with controlled timestamps (simulates imported/older messages). */
async function addMsg(conversationId: string, direction: 'inbound' | 'outbound', body: string, minutesAgo: number) {
  const r = await pool.query(`INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, body, status, created_at) VALUES ($1,$2,$3,$4,$5,$6, now() - ($7||' minutes')::interval) RETURNING id`,
    [s.workspaceId, conversationId, direction, direction === 'inbound' ? 'customer' : 'staff', body, direction === 'inbound' ? 'received' : 'delivered', minutesAgo]);
  return r.rows[0].id as string;
}
const filler = async (cv: string, n: number, startMin: number) => { for (let i = 0; i < n; i++) await addMsg(cv, i % 2 ? 'outbound' : 'inbound', `chit chat number ${i}`, startMin - i); };

describe('full-history summary', () => {
  it('covers ALL messages across many chunks, cites sources, and marks a changed budget as superseded', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0401');
    const early = await addMsg(conversationId, 'inbound', 'Hi, I am looking for a used pontoon. My budget is $25,000 and I prefer a tritoon.', 100000);
    await filler(conversationId, 100, 99990);
    const later = await addMsg(conversationId, 'inbound', 'Update: I can now spend up to $32k. Also I have a 2015 Bayliner to trade in.', 500);
    const promise = await addMsg(conversationId, 'outbound', "Great, I'll send you the 2019 Sea Ray listing tomorrow at 10am.", 400);
    const r = await buildSummary(contactId);
    expect(r.status).toBe('complete'); expect(r.processedChunks).toBe(Math.ceil(103 / CHUNK_SIZE));
    const sum = await getSummary(owner, contactId);
    expect(sum.coverage).toMatchObject({ messagesCovered: 103, messagesTotal: 103, chunks: 3 }); expect(sum.status).toBe('complete');
    const budgets = sum.fields.budget; expect(budgets).toHaveLength(2);
    const old = budgets.find((b: any) => b.value === '$25,000'), cur = budgets.find((b: any) => b.value === '$32,000');
    expect(old.status).toBe('superseded'); expect(cur.status).toBe('current'); expect(old.supersededBy).toBe(cur.id);
    expect(old.citations[0].messageId).toBe(early); expect(cur.citations[0].messageId).toBe(later);          // older AND newer history both cited
    expect(sum.fields.trade[0].citations[0].messageId).toBe(later);
    expect(sum.fields.boat.map((b: any) => b.value)).toEqual(expect.arrayContaining(['2015 Bayliner', '2019 Sea Ray']));
    expect(sum.fields.promise[0].citations[0].messageId).toBe(promise); expect(sum.fields.date.map((d: any) => d.value)).toContain('tomorrow at 10am');
    expect(sum.fields.goal[0].citations[0].messageId).toBe(early);
    expect(sum.provider?.label).toMatch(/no AI/);
  });

  it('does not invent: no budget/boat facts when none were stated; prices quoted by STAFF are not the customer budget', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0402');
    await addMsg(conversationId, 'inbound', 'Hello?', 10); await addMsg(conversationId, 'outbound', 'The boat is $45,000 and our budget for shipping is $500.', 9);
    await buildSummary(contactId); const sum = await getSummary(owner, contactId);
    expect(sum.fields.budget).toBeUndefined(); expect(sum.fields.boat).toBeUndefined(); expect(sum.fields.trade).toBeUndefined();
  });

  it('incremental update re-processes only the changed tail chunk; explicit rebuild redoes everything', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0403');
    await filler(conversationId, 100, 5000); await buildSummary(contactId); expect(stats.providerCalls).toBe(3);
    await addMsg(conversationId, 'inbound', 'One more thing: what is the lead time?', 1);
    const r = await buildSummary(contactId); expect(r).toMatchObject({ status: 'complete', processedChunks: 1, reusedChunks: 2 }); expect(stats.providerCalls).toBe(4);
    expect((await getSummary(owner, contactId)).fields.question_unanswered).toHaveLength(1);
    expect((await buildSummary(contactId, { force: true })).processedChunks).toBe(3);
  });

  it('older imported messages, edits/deletions and merges are picked up (affected chunks re-extracted)', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0404');
    await filler(conversationId, 60, 5000); await buildSummary(contactId);
    await addMsg(conversationId, 'inbound', 'Years ago I asked about a 2012 Lund. Budget then was $9,000.', 900000);   // imported older history shifts every chunk
    expect((await buildSummary(contactId)).processedChunks).toBe(2);
    expect((await getSummary(owner, contactId)).fields.budget[0].value).toBe('$9,000');
    const bad = await addMsg(conversationId, 'inbound', 'My budget is $77,777.', 3); await buildSummary(contactId);
    expect((await getSummary(owner, contactId)).fields.budget.map((b: any) => b.value)).toContain('$77,777');
    await redactMessage(owner, bad); await drain(); await buildSummary(contactId);       // deletion
    expect(JSON.stringify((await getSummary(owner, contactId)).fields)).not.toContain('77,777');
    // identity merge: another contact merged into this one contributes its history
    const other = await newCustomerConvo(s, sam, '(414) 201-0405', 'Dupe');
    await addMsg(other.conversationId, 'inbound', 'I also want a 2020 Malibu.', 2);
    await pool.query('UPDATE contacts SET merged_into=$2 WHERE id=$1', [other.contactId, contactId]); await buildSummary(contactId);
    expect((await getSummary(owner, contactId)).fields.boat.map((b: any) => b.value).join()).toMatch(/Malibu/);
  });

  it('provider failure: messaging is unaffected; partial coverage is reported honestly; recovers on retry', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0406');
    await filler(conversationId, 100, 5000);
    let calls = 0, failAt = 2;
    const flaky: SummaryProvider = { ...heuristicProvider, key: 'flaky', async extractChunk(m) { if (++calls === failAt) throw new Error('provider 503'); return heuristicProvider.extractChunk(m); } };
    registerSummaryProvider(flaky);
    // normal sending keeps working while the AI side is broken
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'still works', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'flaky-0001-a' });
    expect(r.ok).toBe(true); await drain(); expect(simulatorControl.sent).toHaveLength(1);
    calls = 0; failAt = 1;   // drain() also ran the queued summarize job; start counting for the explicit build
    const b = await buildSummary(contactId);
    expect(b.status).toBe('partial'); expect(b.error).toMatch(/503/);
    const sum = await getSummary(owner, contactId);
    expect(sum.status).toBe('partial'); expect(sum.coverage.messagesCovered).toBe(CHUNK_SIZE); expect(sum.coverage.messagesTotal).toBe(101); expect(sum.lastError).toMatch(/503/);
    expect((await buildSummary(contactId)).status).toBe('complete');          // retry resumes: chunk 0 reused
    expect((await getSummary(owner, contactId)).status).toBe('complete');
  });

  it('total failure keeps the previous summary and flags failed; new messages mark it stale', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0407');
    await addMsg(conversationId, 'inbound', 'budget is $10,000', 50); await buildSummary(contactId);
    registerSummaryProvider({ ...heuristicProvider, key: 'down', async extractChunk() { throw new Error('offline'); } });
    await inbound('+14142010407', 'are you there?'); 
    expect((await getSummary(owner, contactId)).status).toBe('stale');
    expect((await buildSummary(contactId)).status).toBe('failed');
    const sum = await getSummary(owner, contactId); expect(sum.status).toBe('failed'); expect(sum.fields.budget[0].value).toBe('$10,000'); expect(sum.coverage.messagesCovered).toBe(1);
  });

  it('permission-scoped: facts citing a conversation the viewer cannot see are hidden, with an explicit note', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0408');
    await addMsg(conversationId, 'inbound', 'My budget is $20,000', 60);
    // same customer, second conversation on a financing-restricted channel
    const ch2 = (await pool.query(`INSERT INTO channels (workspace_id, kind, provider, address) VALUES ($1,'sms','simulator','+12625550101') RETURNING id`, [s.workspaceId])).rows[0].id;
    const cv2 = (await pool.query(`INSERT INTO conversations (workspace_id, contact_id, channel_id, department_id) VALUES ($1,$2,$3,$4) RETURNING id`, [s.workspaceId, contactId, ch2, s.departments.financing])).rows[0].id;
    await addMsg(cv2, 'inbound', 'Financing: my budget is now $50,000 and I trade in a 2018 Crest', 30);
    await buildSummary(contactId);
    const full = await getSummary(owner, contactId); expect(full.restricted).toBe(false); expect(full.fields.trade).toHaveLength(1); expect(full.fields.budget.find((b: any) => b.value === '$50,000')).toBeTruthy();
    const limited = await getSummary(sam, contactId);
    expect(limited.restricted).toBe(true); expect(limited.restrictedNote).toMatch(/not accessible/);
    expect(JSON.stringify(limited.fields)).not.toContain('50,000'); expect(JSON.stringify(limited.fields)).not.toContain('Crest');
    expect(limited.coverage.conversationsCovered).toBe(1);
    const sue = actor(s, 'sue', 'staff', ['service']); await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [conversationId, s.departments.financing]);
    await expect(getSummary(sue, contactId)).rejects.toThrow(/not found/);
  });

  it('never includes internal notes or team chat', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0409');
    await addMsg(conversationId, 'inbound', 'hello there', 5);
    await pool.query(`INSERT INTO notes (workspace_id, contact_id, conversation_id, author_user_id, body) VALUES ($1,$2,$3,$4,'SECRET NOTE budget $99,999')`, [s.workspaceId, contactId, conversationId, s.users.sam]);
    await buildSummary(contactId); expect(JSON.stringify(await getSummary(owner, contactId))).not.toContain('SECRET');
  });
});
