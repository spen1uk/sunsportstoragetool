/**
 * Jarvis Go: a tiny page for a phone or car screen. It uses a device key (Settings → Devices), never a login.
 * It can show the glance line, play the greeting, and chat; it cannot confirm anything. Text is only ever placed with textContent.
 */
type Glance = { line1: string; line2: string; core: string };
const KEY = 'jarvis_device_key', MODE = 'jarvis_go_mode';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window: works for this visit only */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let key = store.get(KEY) ?? '', mode: 'driving' | 'parked' = store.get(MODE) === 'parked' ? 'parked' : 'driving', busy = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e;
}
class NeedKey extends Error {}
async function call(path: string, body?: unknown): Promise<any> {
  let r: Response;
  try { r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error("Can't reach Jarvis. Check the private connection."); }
  if (r.status === 401) { store.del(KEY); key = ''; throw new NeedKey('This key was refused. It may have been removed. Add a new one.'); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(r.status === 402 ? "This device has used its monthly allowance." : r.status === 429 ? 'Slow down a moment.' : (j as any).error ?? `Error ${r.status}`);
  return j;
}

// ----- speech (on-device browser voice, free) -----
const say = (t: string) => { try { if (!('speechSynthesis' in window) || !t) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t.slice(0, 1200)); u.lang = 'en-GB'; const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-GB'); if (v) u.voice = v; speechSynthesis.speak(u); } catch { /* no voice available */ } };
const Rec: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

// ----- screens -----
const app = document.getElementById('app')!;
function setup(msg = '') {
  app.className = ''; app.replaceChildren();
  const input = el('input', '', '', { type: 'password', placeholder: 'Paste this device’s key (starts jvd_)', autocomplete: 'off', 'aria-label': 'Device key' }) as HTMLInputElement;
  const go = el('button', 'primary', 'Connect');
  const out = el('p', 'note err', msg);
  go.onclick = () => { const v = input.value.trim(); if (!/^jvd_[A-Za-z0-9_-]{20,100}$/.test(v)) { out.textContent = 'That doesn’t look like a device key.'; return; } key = v; store.set(KEY, v); void main(); };
  app.append(el('h1', '', 'Jarvis Go'), el('div', 'panel', '', {}), input, go, out,
    el('p', 'note', 'Make a key on your dashboard: Settings → Devices → Add device. The key lives only in this browser and can only chat, hear the greeting and see the status line. It can never approve anything. Remove it on the dashboard any time.'));
  (app.children[1] as HTMLElement).textContent = 'Connect this phone or car screen to your Jarvis.';
}

async function main() {
  if (!key) return setup();
  app.className = mode === 'driving' ? (Rec ? 'drive rec' : 'drive') : ''; app.replaceChildren();
  const core = el('span', 'core'), title = el('h1'); title.append(core, document.createTextNode('Jarvis'));
  const modeBtn = el('button', 'small', mode === 'driving' ? 'Driving' : 'Parked'); modeBtn.onclick = () => { mode = mode === 'driving' ? 'parked' : 'driving'; store.set(MODE, mode); void main(); };
  const top = el('div', 'top'); top.append(title, modeBtn);
  const l1 = el('div', 'l1', '…'), l2 = el('div', 'l2'), glance = el('div', 'panel glance'); glance.append(l1, l2);
  const log = el('div', 'log'), status = el('p', 'note', ''), greet = el('button', 'primary', 'Greeting'), talk = el('button', '', Rec ? 'Talk' : 'Type');
  const input = el('input', '', '', { placeholder: 'Ask Jarvis…', 'aria-label': 'Message', maxlength: '1000', enterkeyhint: 'send' }) as HTMLInputElement, send = el('button', '', 'Send');
  const row1 = el('div', 'row'); row1.append(greet, talk); const row2 = el('div', 'row'); row2.append(input, send);
  app.append(top, glance, log, status, row1, row2);

  const fail = (e: unknown) => { if (e instanceof NeedKey) return setup(e.message); status.className = 'note err'; status.textContent = e instanceof Error ? e.message : String(e); };
  const bubble = (cls: string, t: string) => { log.append(el('div', cls, t)); log.scrollTop = log.scrollHeight; };
  const refresh = async () => { try { const g: Glance = await call('/api/device/glance'); l1.textContent = g.line1; l2.textContent = g.line2; core.className = `core ${g.core}`; if (status.className.includes('err')) status.textContent = ''; } catch (e) { fail(e); } };
  const ask = async (text: string) => {
    if (busy || !text.trim()) return; busy = true; send.disabled = talk.disabled = true; status.className = 'note'; status.textContent = 'Thinking…'; bubble('me', text); input.value = '';
    try { const r = await call('/api/device/chat', { text: text.trim(), mode }); bubble('jv', r.speak); say(r.speak); status.textContent = r.queuedForConfirmation ? 'Waiting for you to confirm on the dashboard.' : ''; void refresh(); }
    catch (e) { fail(e); } finally { busy = false; send.disabled = talk.disabled = false; }
  };
  greet.onclick = async () => { try { const g = await call(`/api/device/greeting?profile=${mode === 'driving' ? 'glance' : 'full'}`); bubble('jv', g.speak); say(g.speak); } catch (e) { fail(e); } };
  send.onclick = () => void ask(input.value); input.onkeydown = (e) => { if (e.key === 'Enter') void ask(input.value); };
  talk.onclick = () => {
    if (!Rec) { input.focus(); return; }
    try { const r = new Rec(); r.lang = 'en-US'; r.interimResults = false; r.onresult = (ev: any) => void ask(String(ev.results[0][0].transcript)); r.onerror = () => { status.className = 'note err'; status.textContent = 'Couldn’t hear that.'; }; status.className = 'note'; status.textContent = 'Listening…'; r.start(); }
    catch { status.textContent = 'Voice input isn’t available here.'; }
  };
  const forget = el('button', 'small', 'Forget this key'); forget.onclick = () => { if (confirm('Remove the key from this browser?')) { store.del(KEY); key = ''; setup(); } };
  if (mode === 'parked') app.append(forget);
  void refresh(); const t = window.setInterval(() => { if (!document.hidden && key) void refresh(); else if (!key) clearInterval(t); }, 60_000);
}
void main();
