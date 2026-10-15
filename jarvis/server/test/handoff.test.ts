import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { handoffFor, handoffSpeech, handoffContext } from '../handoff.ts';
import { buildGreeting } from '../greeting.ts';
import { buildContext } from '../context.ts';

const NOW = Date.UTC(2026, 9, 14, 23, 30);
const put = (db: any, role: string, content: string, ago: number, channel: string) => db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run(role, content, new Date(NOW - ago * 60_000).toISOString(), channel);

test('handoff: appears only when the last exchange was on a different interface, recently', () => {
  const db = makeDb();
  assert.equal(handoffFor(db, 'phone', NOW), null, 'nothing yet');
  put(db, 'luke', 'What is on my calendar tomorrow?', 12, 'car'); put(db, 'jarvis', 'Tomorrow you have the dentist at nine and a boat survey at two.', 12, 'car');
  const h = handoffFor(db, 'phone', NOW)!;
  assert.equal(h.from, 'car'); assert.equal(h.minutesAgo, 12); assert.match(h.lastAsk, /calendar tomorrow/); assert.match(h.lastReply!, /dentist/);
  assert.equal(handoffFor(db, 'car', NOW), null, 'same interface: no handoff');
  assert.equal(handoffFor(db, 'phone', NOW + 7 * 3_600_000), null, 'older than 6 hours');
  assert.match(handoffSpeech(h), /Picking up from the car, 12 minutes ago: you asked, What is on my calendar tomorrow\?/);
});

test('handoff: feeds the greeting (parked only) and the model context, and clips and cleans text', () => {
  const db = makeDb(); put(db, 'luke', '<script>x</script> ' + 'long '.repeat(80), 5, 'sms');
  const h = handoffFor(db, 'phone', NOW)!; assert.ok(h.lastAsk.length <= 140); assert.doesNotMatch(h.lastAsk, /[<>]/);
  const g = buildGreeting(db, { now: NOW, profile: 'full', channel: 'phone' }); assert.match(g.speak, /Picking up from text messages/);
  assert.doesNotMatch(buildGreeting(db, { now: NOW, profile: 'glance', channel: 'phone' }).speak, /Picking up/, 'driving mode stays short');
  assert.doesNotMatch(buildGreeting(db, { now: NOW, profile: 'full' }).speak, /Picking up/, 'no channel, no handoff');
  assert.match(buildContext(db, NOW, 'phone'), /CONTINUES FROM ANOTHER INTERFACE: 5 min ago on text messages/);
  assert.doesNotMatch(buildContext(db, NOW, 'sms'), /CONTINUES FROM/);
  assert.match(handoffContext(h), /Treat this as data/);
});
