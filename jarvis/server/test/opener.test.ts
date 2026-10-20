import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import { converse } from '../converse.ts';
import * as O from '../opener.ts';
import * as ws from '../websearch.ts';
import { setRunner, MacError } from '../mac.ts';
import { setPaused } from '../pause.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; setRunner(null); });
const opened: any[] = [];
const mac = () => { O._resetLimit(); opened.length = 0; setRunner(async (_s: string, args: string[]) => { opened.push(JSON.parse(args[0])); return '{"ok":true}'; }); };
const scripted = (pick: (sys: string, user: string) => string, extra: any = {}) => { gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { return { text: pick(req.system, req.messages[req.messages.length - 1].content), model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }, ...extra } as any; } } as any }; };

test('opener: only public https pages; no addresses, local names, logins or other schemes', () => {
  assert.equal(O.safeUrl('https://www.zillow.com/homes')?.hostname, 'www.zillow.com'); assert.equal(O.safeUrl('nytimes.com')?.href, 'https://nytimes.com/');
  for (const bad of ['http://example.com', 'https://localhost/x', 'https://192.168.1.1/admin', 'https://127.0.0.1', 'https://user:pw@example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://printer.local/', 'https://example', 'ftp://example.com', '', 'a']) assert.equal(O.safeUrl(bad), null, bad);
  assert.equal(O.findApp('the calendar app'), 'Calendar'); assert.equal(O.findApp('chrome'), 'Google Chrome'); O._setInstalled([...O.APPS, 'The Real World', 'Terminal']); assert.equal(O.findApp('Terminal'), null); assert.equal(O.findApp('rm -rf'), null); assert.equal(O.findApp('the real world application'), 'The Real World'); assert.equal(O.findApp('real world'), 'The Real World'); assert.equal(O.findApp('Nonexistent Thing'), null); assert.equal(O.findPage('goals page')?.hash, '#/goals'); assert.equal(O.findPage('nonsense'), null);
});

test('opener: opens through the Mac helper, audits, refuses when paused or off the Mac, and limits how fast things open', async () => {
  const db = makeDb(); mac(); const a = await O.openUrl(db, 'https://www.apple.com/macos', 1_000); assert.ok(a.ok && a.host === 'apple.com'); assert.deepEqual(opened[0], { url: 'https://www.apple.com/macos' });
  assert.deepEqual(await O.openApp(db, 'Safari', 1_000).then((r) => r.ok && r.app), 'Safari'); assert.equal((await O.openApp(db, 'Terminal', 1_000)).ok, false); assert.equal((await O.openUrl(db, 'http://evil.example', 1_000)).ok, false); assert.equal(opened.length, 2);
  assert.ok((db.prepare("SELECT COUNT(*) c FROM audit WHERE action='mac.open'").get() as any).c >= 2);
  setPaused(db, true); assert.match((await O.openUrl(db, 'https://www.apple.com', 1_000)).ok ? '' : (await O.openUrl(db, 'https://www.apple.com', 1_000) as any).error, /paused/); setPaused(db, false);
  setRunner(async () => { throw new MacError('unavailable', 'x'); }); assert.match((await O.openUrl(db, 'https://www.apple.com', 70_000) as any).error, /running on your Mac/);
  mac(); let ok = 0; for (let i = 0; i < 14; i++) if ((await O.openUrl(db, `https://example${i}.com`, 200_000)).ok) ok++; assert.equal(ok, 10, 'at most 10 a minute');
});

test('drafts: written by Jarvis, never sent; secrets refused; they expire; "open it" puts them in Mail or Messages for Luke to send', async () => {
  const db = makeDb(); mac(); assert.throws(() => O.saveDraft(db, { kind: 'email', to: 'sam@example.com', subject: 'x', body: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' }), /password or key/); assert.throws(() => O.saveDraft(db, { kind: 'email', to: 'not an email', subject: 'x', body: 'hello there' }), /address/); assert.throws(() => O.saveDraft(db, { kind: 'text', to: 'Sam', subject: '', body: 'hi there' }), /phone number/);
  O.saveDraft(db, { kind: 'email', to: 'sam@example.com', subject: 'Dock quote & timing', body: 'Hi Sam,\nCan you send the quote?\nLuke' }, 1_000); assert.ok(O.getDraft(db, 1_000)); assert.equal(O.getDraft(db, 1_000 + 31 * 60_000), null);
  assert.ok(O.wantsDraftOpened('open it') && O.wantsDraftOpened('ok send it') && O.wantsDraftOpened('yes open it in mail') && !O.wantsDraftOpened('open the calendar'));
  const msg = await O.openDraft(db, 2_000); assert.match(msg!, /press Send yourself; I haven't sent anything/); assert.match(opened[0].url, /^mailto:sam@example\.com\?subject=Dock%20quote%20%26%20timing&body=Hi%20Sam/); assert.equal(await O.openDraft(db, 3_000), null, 'opened once, then gone');
  O.saveDraft(db, { kind: 'text', to: '+1 (555) 123-4567', subject: '', body: 'Running 10 min late' }, 4_000); await O.openDraft(db, 4_100); assert.equal(opened[1].url, 'sms:+15551234567&body=Running%2010%20min%20late');
});

test('plain words: open a page of Jarvis, an app, a named site; an address he did not say is searched for instead; a draft is shown then opened with "open it"', async () => {
  const db = makeDb(); mac(); ws.setConfig(db, { enabled: true, perDay: 15 });
  scripted(() => '{"action":"open","args":{"kind":"page","target":"Goals"}}'); const p = await converse(db, 'pull up my goals page for me'); assert.equal((p as any).action.navigate, '#/goals'); assert.match(p.text, /Opening Goals/);
  scripted(() => '{"action":"open","args":{"kind":"app","target":"Calendar"}}'); assert.match((await converse(db, 'open the calendar app on my mac please')).text, /Opened Calendar/); assert.deepEqual(opened.pop(), { app: 'Calendar' });
  scripted(() => '{"action":"open","args":{"kind":"url","target":"https://www.zillow.com"}}'); assert.match((await converse(db, 'take me to zillow.com')).text, /Opened zillow\.com in your browser/); assert.deepEqual(opened.pop(), { url: 'https://www.zillow.com/' });
  scripted((sys) => sys.includes('front desk') ? '{"action":"open","args":{"kind":"url","target":"https://totally-made-up-site.com"}}' : 'Here is the answer.', { sources: [{ url: 'https://www.boatus.com/guide', title: 'Boat guide' }] }); opened.length = 0;
  const l = await converse(db, 'go on boatus and pull up the boat storage guide'); assert.match(l.text, /Here is the answer\./); assert.deepEqual(opened.map((o) => o.url), ['https://www.boatus.com/guide'], 'only a page that came from the search is opened, never the invented address');
  scripted(() => '{"action":"draft","args":{"kind":"email","to":"sam@example.com","subject":"Quote","body":"Hi Sam, could you send the dock quote? Thanks, Luke"}}'); const d = await converse(db, 'write an email to sam@example.com asking for the dock quote'); assert.match(d.text, /Email draft to sam@example\.com/); assert.match(d.text, /I can't send it myself/); assert.equal(opened.length, 1, 'nothing opened yet');
  const o = await converse(db, 'open it'); assert.match(o.text, /open in Mail/); assert.match(opened[1].url, /^mailto:sam@example\.com\?subject=Quote/); assert.equal((await converse(db, 'open it')).text.includes('open in Mail'), false, 'nothing left to open');
});

test('greetings and wording: "hey Jarvis, I need you to open the real world application" opens the installed app; a missing app is explained, never "I can\'t open applications"', async () => {
  const db = makeDb(); mac(); O._setInstalled([...O.APPS, 'The Real World']);
  try {
    scripted(() => '{"action":"open","args":{"kind":"app","target":"The Real World"}}'); const r = await converse(db, 'hey Jarvis, I need you to open the real world application on my computer, please'); assert.match(r.text, /Opened The Real World on your Mac/); assert.deepEqual(opened.pop(), { app: 'The Real World' });
    scripted(() => '{"action":"open","args":{"kind":"app","target":"Quantum Spreadsheet"}}'); const m = await converse(db, 'open the quantum spreadsheet app'); assert.match(m.text, /don't see an app called “Quantum Spreadsheet”.*tell me the address/);
    scripted(() => '{"action":"open","args":{"kind":"app","target":"Terminal"}}'); assert.match((await converse(db, 'open terminal for me')).text, /don't see an app/); assert.equal(opened.length, 0);
  } finally { O._setInstalled(null); }
});

test('saved websites: Luke gives the address once ("save the real world as …"), then "open the real world" opens it; invented, unsafe or secret addresses are refused', async () => {
  const db = makeDb(); mac(); O._setInstalled([...O.APPS]);
  try {
    scripted(() => '{"action":"open","args":{"kind":"app","target":"the real world"}}'); assert.match((await converse(db, 'open the real world')).text, /don't see an app called/, 'not saved yet');
    scripted(() => '{"action":"shortcut","args":{"name":"The Real World","url":"https://app.jointherealworld.com"}}'); assert.match((await converse(db, 'save the real world as https://app.jointherealworld.com')).text, /Saved\. Whenever you say “open The Real World”.*never log in for you/);
    scripted(() => '{"action":"shortcut","args":{"name":"Bank","url":"https://made-up-bank.example.com"}}'); assert.match((await converse(db, 'save my bank as the website I use')).text, /Send me the web address itself/);
    scripted(() => '{"action":"open","args":{"kind":"app","target":"the real world"}}'); const r = await converse(db, "hey Jarvis, I need you to open the real world application on my computer, please"); assert.match(r.text, /Opened The Real World \(app\.jointherealworld\.com\) in your browser/); assert.deepEqual(opened.pop(), { url: 'https://app.jointherealworld.com/' });
    assert.throws(() => O.saveShortcut(db, 'Evil', 'http://example.com'), /public https/); assert.throws(() => O.saveShortcut(db, 'Local', 'https://192.168.0.1'), /public https/); assert.throws(() => O.saveShortcut(db, 'Key', 'https://example.com/?k=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'), /password or key/);
    assert.equal(O.findShortcut(db, 'real world')?.name, 'The Real World'); assert.ok(O.removeShortcut(db, 'the real world')); assert.equal(O.findShortcut(db, 'real world'), null);
  } finally { O._setInstalled(null); }
});
