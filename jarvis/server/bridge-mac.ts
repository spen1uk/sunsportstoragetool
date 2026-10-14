import { saveConfig, loadConfig, cycle, validateUrl, configPath } from './bridge-client.ts';
// usage:  npm run bridge:setup      (asks for your server address and the helper credential; the credential is hidden)
//         npm run bridge            (one round, then exit)         npm run bridge -- --loop   (every 15 minutes; this is what auto-start runs)
const mode = process.argv[2] ?? '--once';
async function ask(q: string, hidden: boolean) {
  process.stdout.write(q); let buf = '';
  if (!process.stdin.isTTY) { for await (const c of process.stdin) buf += c; return buf.trim(); }
  if (!hidden) { process.stdin.setEncoding('utf8'); process.stdin.resume(); await new Promise<void>((d) => process.stdin.once('data', (c: string) => { buf = c; d(); })); process.stdin.pause(); return buf.trim(); }
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  await new Promise<void>((done) => process.stdin.on('data', (ch: string) => { for (const c of ch) { if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); done(); return; } if (c === '\u0003') process.exit(130); if (c === '\u007f') buf = buf.slice(0, -1); else buf += c; } }));
  console.log(''); return buf.trim();
}
if (mode === '--setup') {
  const url = validateUrl(await ask('Your Jarvis server address (https://…): ', false));
  const token = await ask('Paste the helper credential (starts with jvb_; input hidden), then Enter: ', true);
  saveConfig({ url, token }); console.log(`Saved to ${configPath()} (readable only by you). Test it with:  npm run bridge`);
} else {
  const cfg = loadConfig();
  const run = async () => { try { const r = await cycle(cfg); if (r.errors.length && mode !== '--loop') process.exitCode = 1; } catch (e) { console.error('bridge:', (e as Error).message); if (mode !== '--loop') process.exitCode = 1; } };
  await run();
  if (mode === '--loop') { setInterval(run, 15 * 60_000); }
}
