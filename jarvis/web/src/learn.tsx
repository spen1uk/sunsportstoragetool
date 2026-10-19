import { useState } from 'react';
import { api, useLive } from './api.ts';

const RATE: [string, string, string][] = [['again', 'Again', 'Back soon'], ['hard', 'Hard', 'A bit longer'], ['good', 'Good', 'Normal'], ['easy', 'Easy', 'Much longer']];

/** Flash cards that come back just as you are about to forget them, plus study plans and summaries when you ask. */
export function LearnPage() {
  const { data, reload } = useLive<any>(() => api('/api/learn'), ['learn']);
  const [show, setShow] = useState(false), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [front, setFront] = useState(''), [back, setBack] = useState(''), [deck, setDeck] = useState('General');
  const [text, setText] = useState(''), [prop, setProp] = useState<any[] | null>(null), [busy, setBusy] = useState(''), [topic, setTopic] = useState(''), [weeks, setWeeks] = useState('4'), [hours, setHours] = useState('3'), [sumText, setSumText] = useState(''), [sumTitle, setSumTitle] = useState(''), [sum, setSum] = useState<any>(null), [openPlan, setOpenPlan] = useState<string | null>(null);
  if (!data) return <section className="page"><h1>Learn</h1><p className="muted">Loading…</p></section>;
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => { setMsg(null); setBusy(key); try { await fn(); if (ok) setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { setBusy(''); } };
  const card = data.due[0], s = data.stats;
  return (
    <section className="page"><h1>Learn</h1>
      <p className="muted">Flash cards that come back just before you would forget them: the better you know a card, the longer until you see it again. Make cards by hand or from notes you paste, ask for a study plan, or have a text summarised. A language model is used only when you press the button, and only on the text you give it.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <div className="glass pad section"><h2>Today</h2>
        <p className="small">{s.due} due · {s.total} cards · {s.mature} well known · reviewed today: {s.reviewedToday}</p>
        {card ? <div className="rcard"><div className="muted small">{card.deck} · {data.due.length} left in this session</div><p style={{ fontSize: '1.15em' }}>{card.front}</p>
          {!show ? <button className="primary" onClick={() => setShow(true)}>Show the answer</button> : <><p><b>{card.back}</b></p><div className="row wrap">{RATE.map(([k, l, h]) => <button key={k} title={h} onClick={() => void run('r', async () => { await api('/api/learn/review', 'POST', { id: card.id, rating: k }); setShow(false); }, '')}>{l}</button>)}</div></>}</div>
          : <p className="muted small">{s.total === 0 ? 'No cards yet. Add some below.' : 'Nothing due. Come back tomorrow.'}</p>}</div>
      <div className="glass pad section"><h2>Add a card</h2>
        <div className="row wrap"><input className="grow" value={front} onChange={(e) => setFront(e.target.value)} placeholder="Question or prompt" aria-label="Front" maxLength={300} /><input className="grow" value={back} onChange={(e) => setBack(e.target.value)} placeholder="Answer" aria-label="Back" maxLength={600} /><input value={deck} onChange={(e) => setDeck(e.target.value)} aria-label="Deck" style={{ width: 120 }} maxLength={40} />
          <button className="primary" disabled={front.trim().length < 2 || !back.trim()} onClick={() => void run('add', async () => { await api('/api/learn/cards', 'POST', { front, back, deck: deck || 'General' }); setFront(''); setBack(''); }, 'Card added.')}>Add</button></div>
        <h3>Or make cards from notes</h3>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Paste notes or a passage (at least a few sentences)" aria-label="Notes to make cards from" />
        <button disabled={text.trim().length < 40 || busy === 'prop'} onClick={() => void run('prop', async () => setProp((await api('/api/learn/propose', 'POST', { text, deck: deck || 'General' })).cards.map((c: any) => ({ ...c, keep: true }))), '')}>{busy === 'prop' ? 'Thinking…' : 'Suggest cards (about a cent)'}</button>
        {prop && <><ul className="plain small">{prop.map((c, i) => <li key={i}><label><input type="checkbox" checked={c.keep} onChange={() => setProp(prop.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))} /> <b>{c.front}</b> → {c.back}</label></li>)}</ul>
          <button className="primary" disabled={!prop.some((c) => c.keep)} onClick={() => void run('save', async () => { await api('/api/learn/cards', 'POST', { cards: prop.filter((c) => c.keep).map((c) => ({ front: c.front, back: c.back, deck: c.deck, source: 'model' })) }); setProp(null); setText(''); }, 'Cards added.')}>Add the ticked cards</button></>}</div>
      <div className="glass pad section"><h2>Study plan</h2>
        <div className="row wrap"><input className="grow" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What do you want to learn?" aria-label="Topic" maxLength={120} /><label className="small">weeks <input value={weeks} onChange={(e) => setWeeks(e.target.value)} style={{ width: 50 }} inputMode="numeric" /></label><label className="small">hours a week <input value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 50 }} inputMode="decimal" /></label>
          <button className="primary" disabled={topic.trim().length < 3 || busy === 'plan'} onClick={() => void run('plan', async () => { await api('/api/learn/plan', 'POST', { topic, weeks: Number(weeks), hoursPerWeek: Number(hours) }); setTopic(''); }, 'Plan saved below.')}>{busy === 'plan' ? 'Planning…' : 'Make a plan (a few cents)'}</button></div>
        {data.plans.map((p: any) => <div key={p.id} className="small"><button className="link" onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}><b>{p.topic}</b></button> <button onClick={() => void run('del', () => api(`/api/learn/plans/${p.id}`, 'DELETE'), '')}>Delete</button>{openPlan === p.id && <pre style={{ whiteSpace: 'pre-wrap' }}>{p.plan}</pre>}</div>)}</div>
      <div className="glass pad section"><h2>Summarise a text</h2>
        <input value={sumTitle} onChange={(e) => setSumTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" maxLength={120} style={{ width: '100%' }} /><textarea value={sumText} onChange={(e) => setSumText(e.target.value)} rows={5} placeholder="Paste a chapter, article or your notes (up to about 8,000 characters)" aria-label="Text to summarise" />
        <button disabled={sumText.trim().length < 80 || busy === 'sum'} onClick={() => void run('sum', async () => setSum(await api('/api/learn/summarize', 'POST', { text: sumText, title: sumTitle })), '')}>{busy === 'sum' ? 'Reading…' : 'Summarise (a few cents)'}</button>
        {sum && <div className="small"><p>{sum.summary}</p><b>Key ideas</b><ul>{sum.keyIdeas.map((k: string) => <li key={k}>{k}</li>)}</ul><b>Test yourself</b><ul>{sum.questions.map((k: string) => <li key={k}>{k}</li>)}</ul></div>}</div>
    </section>);
}
