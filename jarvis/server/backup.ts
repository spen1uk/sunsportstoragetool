import fs from 'node:fs';
import path from 'node:path';
import { type DB, openDb } from './db.ts';
import { verifyAuditChain } from './audit.ts';

/** Consistent online snapshot (VACUUM INTO). Encrypt before it leaves this machine; see docs/THREAT_MODEL.md. */
export function backupTo(db: DB, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) throw new Error('backup target exists');
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
}

/** Restore test: open the snapshot, run integrity check, verify the audit hash chain, and count core tables. */
export function verifyBackup(file: string) {
  const db = openDb(file);
  const integrity = (db.prepare('PRAGMA integrity_check').get() as any).integrity_check;
  const chain = verifyAuditChain(db);
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const out = { integrity, auditChainOk: chain.ok, tasks: count('tasks'), artifacts: count('artifacts'), versions: count('artifact_versions'), memories: count('memories') };
  db.close();
  return out;
}
