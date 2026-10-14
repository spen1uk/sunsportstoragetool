import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DB, setMeta, getMeta, openDb } from './db.ts';
import { audit } from './audit.ts';
import { config, dbPath } from './config.ts';
import { backupTo, verifyBackup } from './backup.ts';
import { encryptFile, decryptFile, generateRecoveryKey } from './backup-crypto.ts';

export const KEY_FILE = () => path.join(config.dataDir, 'backup.pub');
export const NAME_RE = /^jarvis-\d{8}-\d{6}\.jvbk$/;
export function loadPublicKey(): string {
  const k = (process.env.JARVIS_BACKUP_PUBKEY ?? (fs.existsSync(KEY_FILE()) ? fs.readFileSync(KEY_FILE(), 'utf8') : '')).trim();
  if (!k) throw new Error('No backup key yet. Run:  npm run backup:keygen');
  return k;
}
export function createKeyFile(force = false) {
  if (fs.existsSync(KEY_FILE()) && !force) throw new Error('A backup key already exists. Older backups can only be opened with its recovery key. Use --force to replace it anyway.');
  const k = generateRecoveryKey(); fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(KEY_FILE(), k.publicKey + '\n', { mode: 0o600 }); return k;
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** Snapshot → verify the snapshot is healthy → encrypt → remove the plaintext copy → keep only the newest `keep` files. */
export async function runBackup(db: DB, dir: string, o: { keep?: number; publicKey?: string; now?: Date } = {}) {
  const pub = o.publicKey ?? loadPublicKey(), now = o.now ?? new Date(), keep = Math.max(1, o.keep ?? 14);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(config.dataDir === ':memory:' ? os.tmpdir() : (fs.existsSync(config.dataDir) ? config.dataDir : os.tmpdir()), '.bk-')); fs.chmodSync(tmp, 0o700);
  const snap = path.join(tmp, 'snapshot.db'), dest = path.join(dir, `jarvis-${stamp(now)}.jvbk`);
  try {
    backupTo(db, snap); const v = verifyBackup(snap);
    if (v.integrity !== 'ok') throw new Error(`The database failed its own integrity check (${v.integrity}); not backing up a damaged copy over good ones.`);
    const { bytes } = await encryptFile(snap, dest, pub);
    const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort(); const old = files.slice(0, Math.max(0, files.length - keep));
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    setMeta(db, 'last_backup', JSON.stringify({ at: now.getTime(), file: path.basename(dest), bytes, kept: files.length - old.length, auditChainOk: v.auditChainOk }));
    audit(db, 'jarvis', 'backup.encrypted', path.basename(dest), { bytes, auditChainOk: v.auditChainOk });
    return { file: dest, bytes, kept: files.length - old.length, removed: old.length, auditChainOk: v.auditChainOk, tasks: v.tasks, memories: v.memories };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Decrypt into `out` (a new file), then prove it is a healthy Jarvis database before keeping it. */
export async function restoreBackup(file: string, out: string, recoveryKey: string) {
  if (fs.existsSync(out)) throw new Error(`${out} already exists; choose a new name so nothing is overwritten.`);
  const part = out + '.partial'; fs.rmSync(part, { force: true });
  try {
    await decryptFile(file, part, recoveryKey); const v = verifyBackup(part);
    if (v.integrity !== 'ok') throw new Error(`The backup decrypted but the database inside is damaged (${v.integrity}).`);
    fs.renameSync(part, out); fs.chmodSync(out, 0o600); return v;
  } catch (e) { fs.rmSync(part, { force: true }); throw e; }
}
/** Restore drill: prove a backup can really be opened, using the recovery key, then throw the copy away. */
export async function drill(file: string, recoveryKey: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-drill-')); try { return await restoreBackup(file, path.join(tmp, 'drill.db'), recoveryKey); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export const backupStatus = (db: DB) => { try { return { last: JSON.parse(getMeta(db, 'last_backup') ?? 'null'), drill: JSON.parse(getMeta(db, 'last_drill') ?? 'null'), hasKey: fs.existsSync(KEY_FILE()) || !!process.env.JARVIS_BACKUP_PUBKEY }; } catch { return { last: null, drill: null, hasKey: false }; } };

// ---------- command line ----------
async function ask(q: string) {
  process.stdout.write(q); let buf = '';
  if (!process.stdin.isTTY) { for await (const c of process.stdin) buf += c; return buf.trim(); }
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  await new Promise<void>((done) => process.stdin.on('data', (ch: string) => { for (const c of ch) { if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); done(); return; } if (c === '\u0003') process.exit(130); if (c === '\u007f') buf = buf.slice(0, -1); else buf += c; } }));
  console.log(''); return buf.trim();
}
if (import.meta.filename === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2); const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (cmd === 'keygen') {
      const k = createKeyFile(args.includes('--force'));
      console.log('\nYour backup RECOVERY KEY (shown once). Put it in your password manager NOW. Without it, backups cannot be opened by anyone:\n\n  ' + k.recoveryKey + '\n\nThis machine keeps only the public half (data/backup.pub), so it can make backups but cannot read them.\nNext:  npm run backup -- --to <folder>   then practise a restore:  npm run backup:drill -- <file>\n');
    } else if (cmd === 'run') {
      const to = flag('--to'); if (!to) throw new Error('usage: npm run backup -- --to <folder> [--keep 14]');
      const db = openDb(dbPath()); const r = await runBackup(db, path.resolve(to), { keep: flag('--keep') ? Number(flag('--keep')) : undefined });
      console.log(`Encrypted backup written: ${r.file} (${(r.bytes / 1024).toFixed(0)} KB). Keeping ${r.kept}, removed ${r.removed} older.${r.auditChainOk ? '' : '\nWARNING: the audit log failed its tamper check inside this backup. Investigate.'}`);
    } else if (cmd === 'restore' || cmd === 'drill') {
      const file = args[0], out = cmd === 'restore' ? args[1] : undefined; if (!file || (cmd === 'restore' && !out)) throw new Error(cmd === 'restore' ? 'usage: npm run backup:restore -- <file.jvbk> <new-database-file>' : 'usage: npm run backup:drill -- <file.jvbk>');
      const key = await ask('Paste your recovery key (starts with jvk1_; input hidden), then Enter: ');
      if (cmd === 'restore') { const v = await restoreBackup(file, path.resolve(out!), key); console.log(`Restored to ${out}. Integrity: ${v.integrity}. Audit chain ok: ${v.auditChainOk}. ${v.tasks} tasks, ${v.memories} memories.\nTo use it: stop Jarvis, then copy it over data/jarvis.db.`); }
      else { const v = await drill(file, key); console.log(`RESTORE DRILL PASSED: decrypted, integrity ${v.integrity}, audit chain ok: ${v.auditChainOk}, ${v.tasks} tasks, ${v.memories} memories. (The test copy was deleted.)`); const db = openDb(dbPath()); setMeta(db, 'last_drill', JSON.stringify({ at: Date.now(), file: path.basename(file) })); audit(db, 'luke', 'backup.drill_passed', path.basename(file)); }
    } else console.log('usage: npm run backup:keygen | npm run backup -- --to <folder> | npm run backup:drill -- <file> | npm run backup:restore -- <file> <out>');
  } catch (e) { console.error('Backup: ' + (e as Error).message); process.exit(1); }
}
