import { pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import type { Actor } from '../src/domain/authz.js';
import { createContact, openConversationFor } from '../src/domain/contacts.js';
import { processWebhookEvent } from '../src/domain/inbound.js';
import { runOne } from '../src/domain/queue.js';
import { handlers } from '../src/worker/handlers.js';
import { simulatorControl } from '../src/providers/sms.js';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  simulatorControl.reset();
  return seed({ password: 'test-password-123' });
}
export type Seeded = Awaited<ReturnType<typeof resetDb>>;

export const actor = (s: Seeded, who: keyof Seeded['users'], role: Actor['role'], deps: string[] = []): Actor =>
  ({ userId: s.users[who], workspaceId: s.workspaceId, role, departmentIds: deps.map((d) => s.departments[d]) });

export async function newCustomerConvo(s: Seeded, a: Actor, phone = '(414) 201-0101', name = 'Casey') {
  const contactId = await createContact(a, { firstName: name, phone });
  const conversationId = await openConversationFor(a, contactId);
  return { contactId, conversationId };
}

let n = 0;
export const inbound = (from: string, body: string, extra: Partial<{ eventId: string; providerMessageId: string; occurredAt: Date }> = {}) =>
  processWebhookEvent('simulator', { type: 'inbound', eventId: extra.eventId ?? `ev${++n}-${Math.random()}`, providerMessageId: extra.providerMessageId ?? `pm${n}-${Math.random()}`, from, to: '+12625550100', body, occurredAt: extra.occurredAt ?? new Date() });

export const drain = async () => { let k = 0; while (await runOne(handlers)) k++; return k; };
