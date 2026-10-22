import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Working files go to a throwaway folder, never the real data folder. Set before anything imports the config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-founder-')); process.env.JARVIS_DATA_DIR = TMP;
const F = await import('../founder.ts'); const { makeDb } = await import('./helpers.ts'); const gw = await import('../llm/gateway.ts'); const { converse } = await import('../converse.ts');
const W = await import('../calendarwrite.ts'); const { setPaused } = await import('../pause.ts'); const { emergencyStop } = await import('../emergency.ts');
const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
const PACK = F.PACK_DIR; const ex = (f: string) => fs.readFileSync(path.join(PACK, 'skills', f), 'utf8');
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15)); };
const last = (db: any) => db.prepare('SELECT * FROM founder_runs ORDER BY created_at DESC LIMIT 1').get() as any;
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 };
/** A scripted model: orchestrator turns come from `steps`; sub-agents and buyers are answered by `sub`/`buyer`. */
function model(steps: unknown[], o: { sub?: (u: string) => string; buyer?: (u: string) => string } = {}) {
  const seen = { orch: 0, sub: 0, buyer: 0, systems: [] as string[] };
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) {
    const u = req.messages[req.messages.length - 1].content as string; let text = '';
    if (req.system.includes('Founder pack for Luke')) { seen.systems.push(req.system); text = JSON.stringify(steps[Math.min(seen.orch, steps.length - 1)]); seen.orch++; }
    else if (req.system.includes('simulated buyer')) { seen.buyer++; text = (o.buyer ?? ((b) => JSON.stringify({ id: b.match(/"id": "(P\d{3})"/)![1], buys: false, purchases_first_month: 0, reason_code: 'price', reason: 'Too steep for me.', objection: 'price', would_change_my_mind: 'a lower price', price_too_cheap: 2, price_cheap: 4, price_expensive: 6, price_too_expensive: 9 })))(u); }
    else if (req.system.includes('one member of a panel')) { seen.sub++; text = (o.sub ?? (() => 'Verdict: fund with conditions. Risk: demand is unproven.'))(u); }
    else text = 'Plain chat answer.';
    return { text, model: req.model, stopReason: 'end_turn', usage } as any; } } as any };
  return seen;
}

test('the pack: verified against its checksum list, tamper and extra files are caught, nothing in skills/ was edited', () => {
  assert.deepEqual(F.verifyPack(), { ok: true, problems: [] });
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-pack-')); fs.cpSync(PACK, copy, { recursive: true }); assert.ok(F.verifyPack(copy).ok);
  fs.appendFileSync(path.join(copy, 'skills/founder-cfo/unit_economics.py'), '\nimport socket\n'); assert.ok(F.verifyPack(copy).problems.some((p) => /changed: skills\/founder-cfo\/unit_economics\.py/.test(p)));
  fs.writeFileSync(path.join(copy, 'skills/founder-cfo/extra.py'), 'x'); assert.ok(F.verifyPack(copy).problems.some((p) => /not in the manifest/.test(p)));
  assert.equal(F.MODES.length, 11); for (const m of F.MODES) assert.ok(fs.existsSync(path.join(PACK, 'skills', `founder-${m.id}`, 'SKILL.md')), m.id);
  assert.match(fs.readFileSync(path.join(PACK, 'UPSTREAM.md'), 'utf8'), /fd9385b0cfe1b96bebce3898fbd506d73eff5a9d/);
  // the four scripts: standard library only, no network or process modules
  for (const f of ['founder-cfo/unit_economics.py', 'founder-pricing/van_westendorp.py', 'founder-consumer/panel.py', 'founder-plan/compile.py']) { const src = ex(f); assert.doesNotMatch(src, /\b(?:import|from)\s+(?:socket|urllib|http|requests|subprocess|ftplib|smtplib|ssl|asyncio|ctypes|pickle)\b/, f); assert.doesNotMatch(src, /os\.system|popen|eval\(|__import__/, f); }
});

test('rule 1: business topics only', () => {
  for (const t of ['pressure-test my idea for a boat storage membership', 'what should I charge at Sun Sport Marine', 'would people buy this', 'plan the launch of the dock cafe']) assert.ok(F.isBusinessTopic(t), t);
  for (const t of ['should I break up with my girlfriend', 'help me with my diet and workout', 'my feelings about my dad', 'plan my vacation']) assert.equal(F.isBusinessTopic(t), false, t);
  assert.ok(F.isBusinessTopic('is my girlfriend\'s candle shop a good business idea'), 'a business question that mentions a person is still a business question');
});

test('rule 4: nothing sensitive is written into the founder files; paths cannot escape the working folder', () => {
  const p = 'rule4'; assert.equal(F.writeFile(p, 'founder/idea.md', '# Dock cafe\n- sells coffee at $4'), null); assert.match(F.readFile(p, 'founder/idea.md')!, /Dock cafe/);
  for (const [bad, what] of [['my password is hunter2', /password/], ['api key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', /password or key/], ['SSN 123-45-6789', /social security/], ['card 4111 1111 1111 1111', /card number/], ['routing number 021000021', /bank account/], ['IBAN GB82WEST12345698765432', /bank account/], ['passport number A1234567', /identity/]] as const) assert.match(F.writeFile(p, 'founder/notes.md', `fine text. ${bad}`) ?? '', what, bad);
  assert.equal(F.sensitive('Price $6.50, 120 cups a day, rent $4,200 a month, 4.1 stars from 1200 reviews'), null, 'ordinary business numbers are fine');
  for (const rel of ['../etc/passwd', '/etc/passwd', 'founder/../x.md', 'idea.md', 'founder//x.md', 'founder/a b.md', 'founder/x.sh', 'founder/.hidden/../../x.md']) assert.ok(F.writeFile(p, rel, 'x') !== null || F.safeRel(rel) === null, rel);
  assert.equal(F.safeRel('founder/panel/answers/P001.json'), 'founder/panel/answers/P001.json'); assert.match(F.writeFile(p, 'founder/big.md', 'x'.repeat(13_000))!, /too long/);
});

test('rule 2 and the script wrapper: the panel is 20 unless 100 was explicitly asked; only the four reviewed scripts and allowed options run', () => {
  const ok = (name: string, args: string[], full = false) => F.checkScriptArgs(name, args, full);
  assert.deepEqual(ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md']), { ok: true, argv: ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--n', '20'] }, 'no --n: quick');
  assert.deepEqual(ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--quick']).ok && (ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--quick']) as any).argv.slice(-2), ['--n', '20']);
  assert.match((ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--n', '100']) as any).error, /quick one \(20 buyers\)/, '100 refused without an explicit ask');
  assert.equal(ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--n', '100'], true).ok, true, '100 allowed when Luke asked');
  assert.equal(ok('panel', ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--n', '500'], true).ok, false);
  assert.equal(ok('panel', ['save', 'P001']).ok, false, 'save is only used by the program itself'); assert.equal(ok('panel', ['--dir', 'elsewhere', 'status']).ok, false); assert.equal(ok('panel', ['status', '; rm -rf /']).ok, false);
  assert.equal(ok('unit_economics', ['founder/numbers.json', '--out', 'founder/cfo.md', '--price', '7.5']).ok, true); assert.equal(ok('unit_economics', ['/etc/passwd']).ok, false); assert.equal(ok('unit_economics', ['founder/n.json', '--out', '../../x']).ok, false); assert.equal(ok('unit_economics', ['founder/n.json', '--evil']).ok, false);
  assert.equal(ok('unit_economics', ['founder/a.json', 'founder/b.json']).ok, false); assert.equal(ok('van_westendorp', ['founder/panel/answers', '--price', '6.5']).ok, true); assert.equal(ok('compile', ['--dir', 'founder', '--check']).ok, true); assert.equal(ok('compile', ['--dir', '/tmp']).ok, false);
  for (const bad of ['bash', 'python3', 'curl', '../x', '']) assert.equal(ok(bad, []).ok, false, bad);
});

test('the scripts really run (isolated python, inside the working folder) on the pack\'s own examples', async () => {
  const p = 'scripts-real'; assert.equal(F.writeFile(p, 'founder/numbers.json', ex('founder-cfo/example.json')), null);
  const r = await F.runScript(p, 'unit_economics', ['founder/numbers.json', '--out', 'founder/cfo.md']); assert.equal(r.code, 0, r.out); assert.match(F.readFile(p, 'founder/cfo.md')!, /Unit economics: Moss Matcha Bar/);
  assert.equal(fs.existsSync(path.join(PACK, 'skills', 'founder-cfo', '__pycache__')), false, 'no cache files written into the pack');
  const bad = await F.runScript(p, 'unit_economics', ['founder/missing.json']); assert.notEqual(bad.code, 0);
});

test('board run (smoke): modes load the SKILL.md, sub-agents are model calls, files land in the working folder, the summary is posted, and calendar changes ask first for an hour', async () => {
  const db = makeDb(); let n = 0;
  const seen = model([
    { do: 'write', file: 'founder/idea.md', content: '# Dock Storage Club\n- What it is: a membership for covered boat storage\n- Who: Wisconsin boaters\n- Price: $149 a month' },
    { do: 'write', file: 'founder/board/brief.md', content: 'Idea: a membership for covered boat storage at $149 a month for Wisconsin boaters.' },
    { do: 'read', file: 'pack:founder-board/lenses.md' },
    { do: 'agents', tasks: [{ name: 'offers', prompt: 'Read this brief and apply ONLY the Offers lens. Brief: covered boat storage membership at $149.' }, { name: 'monopoly', prompt: 'Apply ONLY the Monopoly lens to: covered boat storage membership.' }, { name: 'product', prompt: 'Apply ONLY the Product lens to: covered boat storage membership.' }] },
    { do: 'write', file: 'founder/board/verdict.md', content: '# Verdict\nTwo of three: fund with conditions.' },
    { do: 'finish', summary: 'The board voted fund with conditions. The main risk is unproven demand. Wrote founder/board/verdict.md.' },
  ]);
  const reply = await converse(db, '/founder-board a covered boat storage membership at $149 a month for Wisconsin boaters'); assert.match(reply.text, /Starting the Board of Directors/);
  await until(() => last(db)?.status === 'done'); const run = last(db); assert.equal(run.status, 'done', run.error); assert.equal(seen.sub, 3, 'three sub-agents'); assert.ok(seen.systems[0].includes('founder-board') && seen.systems[0].includes('Offers lens'), 'the SKILL.md is the method'); assert.ok(seen.systems[0].includes('RULES (fixed'));
  assert.match(F.readFile(run.project, 'founder/board/verdict.md')!, /fund with conditions/); assert.deepEqual(JSON.parse(run.files).slice(0, 2), ['founder/board/brief.md', 'founder/board/verdict.md']);
  const chat = db.prepare("SELECT content FROM messages WHERE role='jarvis' ORDER BY id DESC LIMIT 1").get() as any; assert.match(chat.content, /The board voted fund with conditions[\s\S]*Files: /);
  assert.equal(W.directOn(db), false, 'rule 3: calendar changes ask first for an hour after founder work'); assert.equal(W.directOn(db, Date.now() + 61 * 60_000), true); n++; void n;
});

test('consumer panel run (smoke): quick 20 by default; fake buyers answer through the pack\'s own save; tally is computed by the pack; 100 only when asked', async () => {
  const db = makeDb(); const base = [
    { do: 'write', file: 'founder/customer.json', content: ex('founder-consumer/customer.example.json') }, { do: 'write', file: 'founder/pitch.md', content: ex('founder-consumer/pitch.example.md') },
    { do: 'script', name: 'panel', args: ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md', '--n', '100'] },
    { do: 'script', name: 'panel', args: ['init', '--customer', 'founder/customer.json', '--pitch', 'founder/pitch.md'] },
    { do: 'script', name: 'panel', args: ['prompts'] }, { do: 'panel_run' }, { do: 'script', name: 'panel', args: ['tally'] },
    { do: 'finish', summary: 'Quick panel done: 0 buy, 20 pass.' }];
  const seen = model(base);
  await converse(db, '/founder-consumer would people buy a $6.50 matcha latte at a new cafe'); await until(() => last(db)?.status === 'done', 20000); const run = last(db); assert.equal(run.status, 'done', run.error);
  assert.equal(seen.buyer, 20, 'twenty buyers, not a hundred'); assert.match(F.readFile(run.project, 'founder/panel/results.md')!, /0 buy|pass/i); assert.match(JSON.parse(F.readFile(run.project, 'founder/panel/results.json')!).answered + '', /20/);
  assert.ok(JSON.parse(run.log).some((l: string) => /Script refused: panel/.test(l)), 'the model\'s attempt at --n 100 was refused'); assert.equal(fs.readdirSync(path.join(F.workspace(run.project), 'founder/panel/answers')).length, 20);
});

test('refusals: personal topics, sensitive details in the request, a paused Jarvis, a changed pack, one run at a time; stop and Stop everything end a run', async () => {
  const db = makeDb(); model([{ do: 'finish', summary: 'x' }]);
  assert.match(await F.start(db, { mode: 'board', request: 'should I break up with my girlfriend' }), /only for business topics/); assert.match(await F.start(db, { mode: 'cfo', request: 'my password is hunter2, run the numbers for my shop' }), /password/);
  setPaused(db, true); assert.match(await F.start(db, { mode: 'board', request: 'test my business idea for a shop' }), /paused/); setPaused(db, false);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { await gate; return { text: '{"do":"finish","summary":"x"}', model: req.model, stopReason: 'end_turn', usage } as any; } } as any };
  assert.match(await F.start(db, { mode: 'board', request: 'test my business idea for a boat shop' }), /On it/); await until(() => last(db)?.status === 'running'); assert.match(await F.start(db, { mode: 'cfo', request: 'run the numbers for my boat shop business' }), /already going/);
  assert.match((await converse(db, 'stop founder')).text, /Stopped the founder run/); assert.equal(last(db).status, 'stopped'); release();
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { await gate; return { text: '{"do":"scroll"}', model: req.model, stopReason: 'end_turn', usage } as any; } } as any };
  assert.match(await F.start(db, { mode: 'board', request: 'test my business idea for a marina' }), /On it/); emergencyStop(db); await until(() => last(db)?.status === 'stopped'); assert.equal(last(db).status, 'stopped');
  assert.match(F.founderHelp(), /\/founder-board[\s\S]*\/founder-plan[\s\S]*20 buyers unless you ask for 100/); assert.match((await converse(makeDb(), 'founder help')).text, /The Founder pack \(business topics only\)/);
});

test('plain words reach the founder pack through the front desk (business only); the persona carries the four rules', async () => {
  const db = makeDb(); let asked: unknown = null;
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { if (req.system.includes('front desk')) return { text: '{"actions":[{"action":"founder","args":{"mode":"cfo","request":"unit economics for a $149 storage membership"}}]}', model: req.model, stopReason: 'end_turn', usage } as any; if (req.system.includes('Founder pack for Luke')) { asked = req.system.includes('founder-cfo'); return { text: '{"do":"finish","summary":"Break-even is 12 members."}', model: req.model, stopReason: 'end_turn', usage } as any; } return { text: 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage } as any; } } as any };
  assert.match((await converse(db, 'work out the break-even on a $149 a month storage membership')).text, /Starting the CFO/); await until(() => last(db)?.status === 'done'); assert.equal(asked, true);
  const { buildSystemPrompt } = await import('../persona.ts'); const sys = buildSystemPrompt(db, { memories: [], proposals: false } as any); assert.match(sys, /Founder skills[\s\S]*business topics only[\s\S]*Never use them for personal life[\s\S]*quick one \(20 buyers\)[\s\S]*ask him before sending an email, changing his calendar or editing a CRM[\s\S]*Never save passwords/);
});
