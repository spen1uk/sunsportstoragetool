import { verifyBackup } from './backup.ts';
const f = process.argv[2];
if (!f) { console.error('usage: npm run backup:verify -- <snapshot.db>'); process.exit(2); }
const r = verifyBackup(f); console.log(r);
process.exit(r.integrity === 'ok' && r.auditChainOk ? 0 : 1);
