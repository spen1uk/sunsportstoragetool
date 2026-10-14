import { FakeSandra, RelayAssistantClient, fetchTransport } from './fakeClient.js';

/** Usage: RELAY_URL=http://localhost:4000 RELAY_API_KEY=rk_… npm run sandra:fake [-- --once] */
const base = process.env.RELAY_URL ?? 'http://localhost:4000'; const key = process.env.RELAY_API_KEY;
if (!key) { console.error('Set RELAY_API_KEY (create one under Settings → Assistant).'); process.exit(2); }
const client = new RelayAssistantClient(fetchTransport(base), key);
const sandra = new FakeSandra(client);
const me = await client.me();
console.log(`connected as ${me.identity.name}; autonomy=${me.autonomy}; scopes=${me.scopes.join(',')}`);
for (;;) {
  const r = await sandra.tick();
  while (sandra.log.length) console.log(sandra.log.shift());
  if (process.argv.includes('--once')) break;
  if (!r.handled) await new Promise((res) => setTimeout(res, 2000));
}
