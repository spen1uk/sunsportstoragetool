import { useEffect, useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { listVoices, speak, stop, supported } from './speech.ts';

const Err = ({ m }: { m: string }) => (m ? <p className="err" role="alert">{m}</p> : null);

export function PersonaCard() {
  const { data, reload } = useLive<any>(() => api('/api/persona'), []);
  const [p, setP] = useState<any>(null), [err, setErr] = useState(''), [saved, setSaved] = useState(false), [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => { if (data) setP({ ...data, prefsText: data.preferences.join('\n') }); }, [data]);
  useEffect(() => { if (!supported()) return; const f = () => setVoices(listVoices()); f(); speechSynthesis.addEventListener('voiceschanged', f); return () => speechSynthesis.removeEventListener('voiceschanged', f); }, []);
  if (!p) return null;
  const set = (k: string, v: any) => { setSaved(false); setP({ ...p, [k]: v }); };
  const setV = (k: string, v: any) => { setSaved(false); setP({ ...p, voice: { ...p.voice, [k]: v } }); };
  const ordered = [...voices].sort((a, b) => Number(b.lang === p.voice.lang) - Number(a.lang === p.voice.lang) || a.name.localeCompare(b.name));
  return (
    <div className="glass pad section"><h2>Persona &amp; voice</h2><Err m={err} />
      <div className="grid2">
        <div>
          <label>Address you as<input value={p.addressAs} maxLength={30} onChange={(e) => set('addressAs', e.target.value)} /></label>
          <label>Tone<textarea rows={3} value={p.tone} maxLength={300} onChange={(e) => set('tone', e.target.value)} /></label>
          <div className="row"><label className="grow">Length<select value={p.verbosity} onChange={(e) => set('verbosity', e.target.value)}><option value="terse">Terse</option><option value="concise">Concise</option><option value="detailed">Detailed</option></select></label>
            <label className="grow">Humour<select value={p.humour} onChange={(e) => set('humour', e.target.value)}><option value="none">None</option><option value="subtle">Subtle</option><option value="playful">Playful</option></select></label></div>
          <label>Communication preferences (one per line)<textarea rows={4} value={p.prefsText} onChange={(e) => set('prefsText', e.target.value)} placeholder={'Lead with the recommendation.\nUse bullet points for lists.'} /></label>
        </div>
        <div>
          <label>Voice (on-device, $0)
            <select value={p.voice.voiceName} onChange={(e) => setV('voiceName', e.target.value)} disabled={!supported()}>
              <option value="">Best match for {p.voice.lang}</option>{ordered.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}</select></label>
          <label>Speed {p.voice.rate.toFixed(2)}<input type="range" min={0.6} max={1.4} step={0.05} value={p.voice.rate} onChange={(e) => setV('rate', +e.target.value)} /></label>
          <label>Pitch {p.voice.pitch.toFixed(2)}<input type="range" min={0.6} max={1.4} step={0.05} value={p.voice.pitch} onChange={(e) => setV('pitch', +e.target.value)} /></label>
          <div className="row"><button disabled={!supported()} onClick={() => speak(`Good morning, ${p.addressAs}. All systems are, as ever, entirely at your disposal.`, p.voice)}>Preview</button><button onClick={stop}>Stop</button></div>
          <p className="muted small">Uses your Mac's built-in voices through the browser: free and private, but not studio quality. Animation follows real speech events, not audio amplitude. Premium voices, listening and phone calls are deferred.</p>
        </div>
      </div>
      <p className="muted small">Persona changes how Jarvis sounds. It cannot grant abilities, relax approvals, or make Jarvis claim connections that don't exist: the safety rules are fixed in code and always sent first.</p>
      <button className="primary" onClick={() => { setErr(''); const { prefsText, ...rest } = p; api('/api/persona', 'PUT', { ...rest, preferences: String(prefsText).split('\n').map((x: string) => x.trim()).filter(Boolean) }).then(() => { setSaved(true); reload(); }).catch((e) => setErr(e.message)); }}>Save persona</button> {saved && <span className="ok">Saved.</span>}
    </div>
  );
}

export function ModelsCard() {
  const { data, reload } = useLive<any>(() => api('/api/llm'), ['chat', 'budget']);
  const [err, setErr] = useState(''), [msg, setMsg] = useState(''), [ceil, setCeil] = useState('');
  if (!data) return null;
  const u = data.usage, cfg = data.config, anth = data.providers.find((x: any) => x.id === 'anthropic');
  const put = (b: object) => api('/api/llm/config', 'PUT', b).then((r) => { setErr(''); if (r.approvalId) setMsg('Raising spend needs your approval: see Approvals.'); reload(); }).catch((e) => setErr(e.message));
  return (
    <div className="glass pad section"><h2>AI models</h2><Err m={err} />{msg && <p className="warn">{msg} <a href="#/approvals">Open Approvals</a></p>}
      <p>Anthropic: {anth?.configured ? <span className="badge connected">key configured</span> : <span className="badge planned">no key: chat stays in free command mode</span>}</p>
      {!anth?.configured && <p className="note small">To enable: create a key in the Anthropic console with a monthly spend limit, then run <code>npm run secret:set -- anthropic</code> on this Mac (input hidden). It is stored in <code>data/secrets.json</code> (mode 0600) or read from <code>ANTHROPIC_API_KEY</code>, and is never sent to the browser. Nothing is billed until then.</p>}
      <table><thead><tr><th>Task</th><th>Order tried (cheap first)</th><th>Max reply</th></tr></thead>
        <tbody>{Object.entries(data.routes).map(([task, c]: any) => <tr key={task}><td>{task === 'analysis' ? 'deep: / analysis' : task}</td><td>{c.map((x: any) => `${x.model} (${x.effort})`).join(' → ')}</td><td>{c[0].maxTokens} tokens</td></tr>)}</tbody></table>
      <p className="muted small">Fallback: rate limits, outages and key problems move to the next model; refusals and bad requests do not. Prices are from a cached table (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million tokens): verify before relying on them.</p>
      <dl className="kv"><dt>Today</dt><dd>{u.today.calls} calls · {usd(u.today.cost)} of {usd(cfg.dailyCeilingMicroUsd)} daily ceiling</dd><dt>This month</dt><dd>{u.month.calls} calls · {usd(u.month.cost)} · {u.failures} failed</dd></dl>
      {u.byModel.length > 0 && <p className="muted small">{u.byModel.map((m: any) => `${m.model}: ${m.calls} calls, ${usd(m.cost)}`).join(' · ')}</p>}
      <div className="row wrap">
        <label className="inline">Daily ceiling $<input style={{ width: 90 }} type="number" min={0} step={0.25} placeholder={(cfg.dailyCeilingMicroUsd / 1e6).toFixed(2)} value={ceil} onChange={(e) => setCeil(e.target.value)} /></label>
        <button disabled={ceil === ''} onClick={() => put({ dailyCeilingUsd: Number(ceil) }).then(() => setCeil(''))}>Set (raising needs approval)</button>
        <label className="check"><input type="checkbox" checked={cfg.strongEnabled} onChange={(e) => put({ strongEnabled: e.target.checked })} /> Allow stronger model (Sonnet)</label>
        <label className="check" title="Private sessions are never saved, but a provider would still receive the text."><input type="checkbox" checked={cfg.allowInPrivate} onChange={(e) => put({ allowInPrivate: e.target.checked })} /> Allow model in private mode</label>
      </div>
      <p className="muted small">Anything sent to a model leaves this Mac and is subject to the provider's retention terms (I haven't verified them; do so before enabling). Private mode keeps the model off unless you tick the box above.</p>
      <button disabled={!anth?.configured} onClick={() => api('/api/llm/test', 'POST', {}).then((r) => { setErr(r.ok ? '' : r.error); setMsg(r.ok ? `Connection OK via ${r.model} (${usd(r.costMicroUsd)}).` : ''); reload(); })}>Test connection (costs a fraction of a cent)</button>
    </div>
  );
}
