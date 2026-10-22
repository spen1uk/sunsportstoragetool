// Checks the vendored Founder pack against its checksum list. Usage: node scripts/founder-verify.ts
import { verifyPack } from '../server/founder.ts';
const r = verifyPack();
console.log(r.ok ? 'Founder pack: every file matches the reviewed version (fd9385b).' : `Founder pack differs from the reviewed version:\n- ${r.problems.join('\n- ')}`);
process.exit(r.ok ? 0 : 1);
