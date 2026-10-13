import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { actor, drain, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import * as chat from '../src/domain/chat.js';
import { simulatorControl } from '../src/providers/sms.js';
import { listNotifications } from '../src/domain/notifications.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let sue: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>; let fin: ReturnType<typeof actor>;
beforeEach(async () => {
  s = await resetDb();
  sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; sue = { ...actor(s, 'sue', 'staff', ['service']), name: 'Sue' };
  owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; fin = { ...actor(s, 'fin', 'manager', ['financing', 'sales']), name: 'Fran' };
});
afterAll(() => pool.end());

describe('internal/external isolation', () => {
  it('chat code has no import path (transitively) to the messaging pipeline, queue or SMS providers', () => {
    const seen = new Set<string>(); const bad: string[] = [];
    const walk = (rel: string) => {
      const f = path.resolve('src/domain', rel.replace(/\.js$/, '.ts')); if (seen.has(f) || !existsSync(f)) return; seen.add(f);
      for (const m of readFileSync(f, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        const target = path.resolve(path.dirname(f), m[1].replace(/\.js$/, '.ts'));
        if (/(messaging|inbound|queue|scheduling|providers\/sms)/.test(target)) bad.push(`${path.basename(f)} -> ${m[1]}`);
        else walk(path.relative('src/domain', target));
      }
    };
    walk('chat.ts'); expect(bad).toEqual([]);
  });
  it('posting in a customer-linked channel creates no customer message, no send job, and nothing reaches the provider', async () => {
    const { contactId } = await newCustomerConvo(s, sam, '(414) 201-0301');
    const ch = await chat.openCustomerChannel(sam, contactId);
    await chat.postMessage(sam, ch, { body: 'INTERNAL: do not tell customer about the discount' });
    await drain();
    expect(simulatorControl.sent).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body LIKE '%INTERNAL%'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM jobs`)).rows[0].n).toBe(0);
  });
});

describe('membership and permissions', () => {
  it('department channels: members and admins only; DMs: only the two people; groups: members only', async () => {
    const list = (a: typeof sam) => chat.listChannels(a);
    const salesCh = (await list(sam)).find((c) => c.name === 'Sales')!;
    expect((await list(sam)).map((c) => c.name)).toContain('Sales'); expect((await list(sam)).map((c) => c.name)).not.toContain('Service');
    expect((await list(sue)).map((c) => c.name)).not.toContain('Sales'); expect((await list(owner)).map((c) => c.name)).toEqual(expect.arrayContaining(['Sales', 'Service', 'Financing', 'Storage']));
    await expect(chat.getMessages(sue, salesCh.id)).rejects.toThrow(/not found/);
    await expect(chat.postMessage(sue, salesCh.id, { body: 'hi' })).rejects.toThrow(/not found/);
    const dm = await chat.openDm(sam, s.users.sue); expect(await chat.openDm(sue, s.users.sam)).toBe(dm);
    await expect(chat.getMessages(owner, dm)).rejects.toThrow(/not found/);        // even the owner is not in someone's DM
    await expect(chat.getMessages(fin, dm)).rejects.toThrow(/not found/);
    const grp = await chat.createGroup(sam, 'Pontoon deal', [s.users.fin]);
    await expect(chat.getMessages(sue, grp)).rejects.toThrow(/not found/); expect(await chat.getMessages(fin, grp)).toEqual([]);
  });
  it('customer-linked channel follows customer visibility (financing customer hidden from sales staff)', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, fin, '(414) 201-0302');
    await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [conversationId, s.departments.financing]);
    const ch = await chat.openCustomerChannel(fin, contactId);
    await chat.postMessage(fin, ch, { body: 'credit check pending' });
    await expect(chat.getMessages(sam, ch)).rejects.toThrow(/not found/); await expect(chat.openCustomerChannel(sam, contactId)).rejects.toThrow(/not found/);
    expect((await chat.getMessages(owner, ch))).toHaveLength(1);
    expect((await chat.listChannels(sam)).find((c) => c.id === ch)).toBeUndefined();
    expect(await chat.searchMessages(sam, 'credit check')).toEqual([]); expect(await chat.searchMessages(owner, 'credit check')).toHaveLength(1);
  });
});

describe('threads, mentions, unread, search, attachments', () => {
  it('threads attach to a root; mentions notify only people with access; unread counts are per user', async () => {
    const sales = (await chat.listChannels(sam)).find((c) => c.name === 'Sales')!.id;
    const root = await chat.postMessage(sam, sales, { body: 'Who can cover Saturday?' });
    const reply = await chat.postMessage(fin, sales, { body: 'I can', parentId: root, mentions: [s.users.sam] });
    await expect(chat.postMessage(fin, sales, { body: 'nested', parentId: reply })).rejects.toThrow(/thread root/);
    await expect(chat.postMessage(sam, sales, { body: 'hey @sue', mentions: [s.users.sue] })).rejects.toThrow(/cannot mention/);
    const top = await chat.getMessages(sam, sales); expect(top).toHaveLength(1); expect(top[0].reply_count).toBe(1);
    expect((await chat.getMessages(sam, sales, { threadRootId: root })).map((m) => m.body)).toEqual(['Who can cover Saturday?', 'I can']);
    expect((await listNotifications(sam)).items.filter((n) => n.type === 'mention')).toHaveLength(1);
    expect((await listNotifications(sue)).unread).toBe(0);
    const unread = async (a: typeof sam) => (await chat.listChannels(a)).find((c) => c.id === sales)!.unread;
    expect(await unread(sam)).toBe(1); expect(await unread(fin)).toBe(0);
    await chat.markChannelRead(sam, sales); expect(await unread(sam)).toBe(0);
  });
  it('edit/delete permissions and searchable history', async () => {
    const sales = (await chat.listChannels(sam)).find((c) => c.name === 'Sales')!.id;
    const m = await chat.postMessage(sam, sales, { body: 'trailer hitch needed' });
    await expect(chat.editMessage(fin, m, 'x')).rejects.toThrow(/author/);
    await chat.editMessage(sam, m, 'trailer hitch ordered');
    expect((await chat.searchMessages(fin, 'hitch'))[0].body).toBe('trailer hitch ordered');
    await expect(chat.deleteMessage(fin, m)).rejects.toThrow(/author or an admin/);
    await chat.deleteMessage(owner, m);
    expect(await chat.searchMessages(fin, 'hitch')).toEqual([]);
  });
});

describe('tasks', () => {
  it('message → task with due date links back to the customer and conversation; assignee must have access', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0310');
    const ch = await chat.openCustomerChannel(sam, contactId);
    const m = await chat.postMessage(sam, ch, { body: 'Pull the trade-in value for this customer' });
    await expect(chat.messageToTask(sam, m, { assigneeId: s.users.sue })).resolves.toBeTruthy();   // unrouted conversation → visible to all staff
    await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [conversationId, s.departments.financing]);
    await expect(chat.messageToTask(fin, m, { assigneeId: s.users.sue })).rejects.toThrow(/cannot access/);
    const due = new Date(Date.now() - 3600_000).toISOString();
    const t = await chat.messageToTask(fin, m, { assigneeId: s.users.fin, dueAt: due, title: 'Trade-in value' });
    const mine = await chat.listTasks(fin, { scope: 'mine' }); const row = mine.find((x) => x.id === t)!;
    expect(row).toMatchObject({ contact_id: contactId, conversation_id: conversationId, overdue: true, title: 'Trade-in value' });
    expect((await chat.getMessages(fin, ch))[0].task_id).toBeTruthy();
    expect((await listNotifications(fin)).items.some((n) => n.type === 'task_assigned')).toBe(true);
    await chat.updateTask(fin, t, { status: 'done' }); expect((await chat.listTasks(fin, { scope: 'mine', status: 'open' })).some((x) => x.id === t)).toBe(false);
    await expect(chat.updateTask(sam, t, { status: 'cancelled' })).rejects.toThrow(/not your task/);
    await expect(chat.listTasks(sam, { scope: 'all' })).rejects.toThrow(/manager/);
  });
});
