import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeDb } from './helpers.ts';
import { openDb } from '../db.ts';
import { generateRecoveryKey, encryptFile, decryptFile } from '../backup-crypto.ts';
import { runBackup, restoreBackup, drill, NAME_RE, backupStatus } from '../backup-run.ts';
import * as memory from '../memory.ts';
import { createTask } from '../tasks.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jbk-'));

test('encrypt/decrypt round trip; the file holds no readable content; only the recovery key opens it', async () => {
  const d = tmp(), k = generateRecoveryKey(), other = generateRecoveryKey();
  const src = path.join(d, 'plain.bin'); const secret = 'TOP-SECRET-MARKER-' + 'x'.repeat(5000); fs.writeFileSync(src, Buffer.concat([Buffer.from(secret), Buffer.alloc(3_000_000, 7)]));
  const enc = path.join(d, 'a.jvbk'); const { bytes } = await encryptFile(src, enc, k.publicKey);
  assert.ok(bytes > 3_000_000); assert.equal(fs.statSync(enc).mode & 0o077, 0, 'private to the user'); assert.equal(fs.readFileSync(enc).includes('TOP-SECRET-MARKER'), false);
  const out = path.join(d, 'b.bin'); await decryptFile(enc, out, k.recoveryKey); assert.ok(fs.readFileSync(out).equals(fs.readFileSync(src)));
  await assert.rejects(() => decryptFile(enc, path.join(d, 'c.bin'), other.recoveryKey), /wrong recovery key, or the file is damaged/); assert.equal(fs.existsSync(path.join(d, 'c.bin')), false, 'nothing left behind on failure');
  await assert.rejects(() => decryptFile(enc, path.join(d, 'e.bin'), 'jvk1_short'), /does not look like a Jarvis recovery key/);
  await assert.rejects(() => encryptFile(src, path.join(d, 'f.jvbk'), 'not-a-key'), /not a backup public key/);
  const enc2 = path.join(d, 'a2.jvbk'); await encryptFile(src, enc2, k.publicKey); assert.notDeepEqual(fs.readFileSync(enc), fs.readFileSync(enc2), 'fresh key and iv every time');
});

test('any change to the file is detected: flipped byte (header, body, tag), truncation, extra bytes, wrong magic', async () => {
  const d = tmp(), k = generateRecoveryKey(); const src = path.join(d, 'p'); fs.writeFileSync(src, Buffer.alloc(200_000, 9)); const enc = path.join(d, 'a.jvbk'); await encryptFile(src, enc, k.publicKey);
  const good = fs.readFileSync(enc); let n = 0;
  const attempt = async (buf: Buffer, re: RegExp) => { const f = path.join(d, `t${n++}.jvbk`); fs.writeFileSync(f, buf); await assert.rejects(() => decryptFile(f, path.join(d, `o${n}`), k.recoveryKey), re); assert.equal(fs.existsSync(path.join(d, `o${n}`)), false); };
  for (const pos of [10, 30, 50, 70, 100_000, good.length - 1]) { const b = Buffer.from(good); b[pos] ^= 1; await attempt(b, /damaged or has been changed/); }
  await attempt(good.subarray(0, good.length - 1), /damaged or has been changed/); await attempt(good.subarray(0, 40), /damaged|not a Jarvis/); await attempt(Buffer.concat([good, Buffer.from([0])]), /damaged or has been changed/);
  await attempt(Buffer.concat([Buffer.from('NOTJV1\n'), good.subarray(7)]), /not a Jarvis backup|damaged/);
});

test('full backup: snapshot is verified, encrypted, plaintext removed, rotation keeps the newest N and ignores other files; restore and drill prove it opens', async () => {
  const db = makeDb(); memory.remember(db, 'Luke keeps the dock keys in the blue box', { source: 'test' }); createTask(db, { title: 'Order dock lights', kind: 'manual' });
  const dir = path.join(tmp(), 'offsite'), k = generateRecoveryKey(); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');
  let last = '';
  for (let i = 0; i < 4; i++) { const r = await runBackup(db, dir, { publicKey: k.publicKey, keep: 3, now: new Date(Date.UTC(2026, 9, 14, 3, 15, i)) }); last = r.file; assert.equal(r.auditChainOk, true); }
  const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)); assert.equal(files.length, 3); assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'unrelated files are never touched');
  assert.ok(files.includes('jarvis-20261014-031503.jvbk') && !files.includes('jarvis-20261014-031500.jvbk'));
  assert.equal(fs.readFileSync(last).includes('dock keys'), false, 'no plaintext in the backup file'); assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.db')), false);
  const status = backupStatus(db); assert.equal(status.last.kept, 3); assert.equal(status.last.file, 'jarvis-20261014-031503.jvbk');
  const out = path.join(tmp(), 'restored.db'); const v = await restoreBackup(last, out, k.recoveryKey); assert.equal(v.integrity, 'ok'); assert.equal(v.auditChainOk, true); assert.equal(v.memories, 1); assert.equal(v.tasks, 1);
  const r2 = openDb(out); assert.equal((r2.prepare('SELECT content FROM memories').get() as any).content, 'Luke keeps the dock keys in the blue box'); r2.close();
  await assert.rejects(() => restoreBackup(last, out, k.recoveryKey), /already exists/, 'never overwrites');
  assert.equal((await drill(last, k.recoveryKey)).integrity, 'ok');
  await assert.rejects(() => drill(last, generateRecoveryKey().recoveryKey), /wrong recovery key/);
  assert.equal(fs.existsSync(out + '.partial'), false);
});

test('a backup refuses to run without a key, and a damaged database is never backed up over good copies', async () => {
  const db = makeDb(); const dir = path.join(tmp(), 'o');
  delete process.env.JARVIS_BACKUP_PUBKEY; await assert.rejects(() => runBackup(db, dir, {}), /npm run backup:keygen/);
  await assert.rejects(() => runBackup(db, dir, { publicKey: 'garbage' }), /not a backup public key/); assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).length : 0, 0, 'failed run leaves no file behind');
});
