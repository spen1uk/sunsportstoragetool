import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as S from '../search.ts';
import * as memory from '../memory.ts';
import * as X from '../exclusions.ts';
import * as D from '../decisions.ts';
import * as C from '../chatimport.ts';
import * as reg from '../skills/registry.ts';
import { createTask } from '../tasks.ts';
import { createPerson } from '../life.ts';
import { converse } from '../converse.ts';
import { createAssigned } from '../missions.ts';

function seed(db: any) {
  memory.remember(db, 'The Harbor Lights marina budget is tight this quarter', { source: 't' });
  createTask(db, { title: 'Call Menards about Harbor Lights dock lumber', owner: 'luke' }); createTask(db, { title: 'Demo task about harbor', owner: 'luke', isDemo: true } as any);
  createPerson(db, { name: 'Maria Lopez', relationship: 'partner', notes: 'Runs Harbor Lights' });
  db.prepare("INSERT INTO notes_cache(id,folder,title,body,modified_ms) VALUES('n1','Work','Dock plan','Replace the harbor lights dock boards in spring',?)").run(Date.now());
  db.prepare("INSERT INTO calendar_events(calendar,uid,title,start_ms,end_ms,location) VALUES('Home','u1','Harbor Lights walkthrough',?,?,'Marina office')").run(Date.now() + 86_400_000, Date.now() + 90_000_000);
  D.create(db, { title: 'Buy a second boat for Harbor Lights', context: 'Rental demand is up' }); createAssigned(db, { goal: 'Find the best way to cut winter storage costs at Harbor Lights' });
  C.importChats(db, { conversations: [{ title: 'Boat budget chat', createdAt: null, messages: [{ role: 'user', text: 'How much is a Harbor Lights slip?' }] }] });
}

test('universal search: finds across every source with a source label and link; every word must match; demo data and imports are left out by default', () => {
  const db = makeDb(); seed(db); const r = S.search(db, 'harbor lights'); const kinds = r.groups.map((g) => g.kind);
  for (const k of ['memory', 'task', 'person', 'note', 'calendar', 'decision', 'mission']) assert.ok(kinds.includes(k), k);
  assert.ok(!kinds.includes('import'), 'imports excluded by default'); assert.ok(!JSON.stringify(r).includes('Demo task'), 'demo records never appear');
  const t = r.groups.find((g) => g.kind === 'task')!.items[0]; assert.match(t.title, /Menards/); assert.equal(t.link, '#/tasks'); assert.ok(t.snippet.length > 0 && t.at);
  assert.equal(S.search(db, 'harbor spaceship').total, 0, 'every word must match'); assert.ok(S.search(db, 'lumber menards').total >= 1, 'word order does not matter');
  const withImp = S.search(db, 'harbor lights', { includeImports: true }); assert.ok(withImp.groups.some((g) => g.kind === 'import' && g.items[0].title === 'Boat budget chat'));
  assert.equal(S.search(db, 'a').total, 0); assert.equal(S.search(db, '   ').total, 0); assert.equal(S.search(db, '%').total, 0, 'wildcards are literal'); assert.equal(S.search(db, "'; DROP TABLE tasks; --").total, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n >= 2, true);
  const ranked = S.search(db, 'marina'); assert.ok(ranked.total >= 2);
});

test('universal search: excluded names never appear or can be searched; the chat command is deterministic, never quotes imported chats, and only counts them', async () => {
  const db = makeDb(); seed(db); X.add(db, 'Maria Lopez');
  assert.ok(!JSON.stringify(S.search(db, 'harbor lights')).includes('Maria')); assert.equal(S.search(db, 'maria lopez').excluded, true);
  const r = await converse(db, 'find my notes about harbor lights'); assert.equal(r.source, 'command'); assert.match(r.text, /Here's what I found/); assert.match(r.text, /Notes: Dock plan/); assert.doesNotMatch(r.text, /slip|Boat budget chat/); assert.match(r.text, /Also 1 match in chats you imported/);
  assert.match((await converse(db, 'search my everything for zebra')).text, /couldn't find anything/); assert.match((await converse(db, 'search everything for harbor lights')).text, /Here's what I found/);
  assert.equal((await converse(db, 'find my notes about harbor lights', { private: true })).source === 'command' && /Here's what I found/.test((await converse(db, 'find my notes about harbor lights', { private: true })).text), false, 'not in private mode');
});

test('universal search skill: registered for Jarvis only, needs a grant, never includes imports, and Prometheus can never hold it', async () => {
  const db = makeDb(); seed(db); reg.sync(db);
  assert.equal(reg.access(db, 'jarvis', 'search.everything').allowed, false); assert.match(reg.access(db, 'jarvis', 'search.everything').reasons[0], /not granted/);
  assert.equal(reg.access(db, 'prometheus', 'search.everything').allowed, false); assert.throws(() => reg.grant(db, 'prometheus', 'search.everything', 'luke'));
  reg.grant(db, 'jarvis', 'search.everything', 'luke'); const r = await reg.invoke(db, 'jarvis', 'search.everything', { query: 'harbor lights' }) as any; assert.ok(r.ok && r.result.length > 0 && r.result.every((x: any) => x.source !== 'Imported chats'));
  assert.ok(r.result.every((x: any) => x.source && x.link), 'every result names its source');
  for (const id of ['knowledge.lookup', 'decisions.due']) { reg.grant(db, 'jarvis', id, 'luke'); assert.ok((await reg.invoke(db, 'jarvis', id, id === 'knowledge.lookup' ? { query: 'harbor' } : {}) as any).ok, `${id} can really be used by Jarvis`); }
});
