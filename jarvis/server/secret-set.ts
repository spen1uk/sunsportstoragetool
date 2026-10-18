import { setSecret, clearSecret, keychainEnabled } from './llm/secrets.ts';
// usage: npm run secret:set -- anthropic        (prompts without echo)   |   npm run secret:set -- anthropic --clear
const [name, flag] = process.argv.slice(2);
if (!name || !['anthropic'].includes(name)) { console.error('usage: npm run secret:set -- anthropic [--clear]'); process.exit(2); }
if (flag === '--clear') { clearSecret(name); console.log(`Cleared ${name}.`); process.exit(0); }
process.stdout.write(`Paste the ${name} API key (input hidden), then press Enter: `);
let buf = '';
if (!process.stdin.isTTY) { for await (const c of process.stdin) buf += c; }
else {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  await new Promise<void>((done) => process.stdin.on('data', (ch: string) => {
    for (const c of ch) { if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); done(); return; } if (c === '\u0003') process.exit(130); if (c === '\u007f') buf = buf.slice(0, -1); else buf += c; }
  }));
}
buf = buf.trim(); console.log('');
if (buf.length < 20) { console.error('That does not look like an API key; nothing saved.'); process.exit(1); }
setSecret(name, buf); console.log(keychainEnabled() ? 'Saved to the macOS Keychain. It is never sent to the browser.' : 'Saved to data/secrets.json (mode 0600). It is never sent to the browser.');
