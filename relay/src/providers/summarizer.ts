/**
 * Summary extraction adapter. Providers turn ONE chunk of messages into cited evidence; reconciliation is deterministic code.
 * Shipped provider: 'heuristic' (regex rules, no AI model, sends no data anywhere). LLM providers (OpenAI/Anthropic) plug in via
 * registerSummaryProvider once API keys exist — see docs/AI_DATA_SHARING.md. Their output is validated (citations must be in-chunk).
 */
export interface SummaryMsg { id: string; conversation_id: string; direction: 'inbound' | 'outbound'; sender_type?: string; body: string; created_at: string; seq: number }
export interface Evidence { field: 'budget' | 'boat' | 'trade' | 'date' | 'decision' | 'promise' | 'preference' | 'question' | 'goal'; value: string; messageId: string; at: string; origin: 'customer_stated' | 'staff_stated'; normalized?: string | number }
export interface ExtractResult { evidence: Evidence[]; usage: { inputTokens: number; outputTokens: number; costUsd: number | null } }
export interface SummaryProvider { key: string; model: string; version: string; extractChunk(msgs: SummaryMsg[]): Promise<ExtractResult> }

const MAKES = ['Sea Ray', 'Bayliner', 'Sun Tracker', 'Tracker', 'Chaparral', 'Yamaha', 'Malibu', 'MasterCraft', 'Crest', 'Godfrey', 'Lund', 'Ranger', 'Boston Whaler', 'Cobalt', 'Regal', 'Four Winns', 'Monterey', 'Harris', 'Bennington', 'Stingray', 'Glastron', 'Princecraft', 'Starcraft', 'Larson', 'Cruisers'];
const MAKE_RE = new RegExp(`\\b((?:19|20)\\d{2})?\\s*(${MAKES.join('|')})((?:\\s+[A-Z0-9][A-Za-z0-9-]*){0,2})`, 'g');
const YEAR_BOAT_RE = /\b((?:19|20)\d{2})\s+([A-Z][A-Za-z]+(?:\s+[A-Z0-9][A-Za-z0-9-]*){1,2})\b/g;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?/g;
const BUDGET_CUE = /\b(budget|up to|under|around|max(?:imum)?|afford|spend|price range|no more than|can do|comfortable)\b/i;
const DATE_RE = /\b((?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm)?)?|tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s?(?:am|pm)?)?|next week|this weekend|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gi;
const DECISION_RE = /\b(let'?s do (?:it|that)|i'?ll take (?:it|that)|we'?ll take (?:it|that)|sounds good|you have a deal|deal\b|i want (?:it|that one)|go ahead|sign me up|count me in)\b/i;
const PROMISE_RE = /\b(i'?ll|i will|we'?ll|we will|let me|i can)\s+(call|text|send|check|find|get back|email|look|reserve|hold|order|schedule|follow up|ask|have)\b/i;
const INTENT_RE = /\b(looking (?:for|to)|interested|want to|need (?:a|to)|buy|purchase|sell|trade|service|storage|winteriz|quote|price on|available)\b/i;
const PREF_RE = /\b(prefer|must have|need(?:s)?|want(?:s)?|looking for|has to|should have)\b/i;
const TRADE_RE = /\b(trade[- ]?in|trading|my (?:current|old) boat|trade)\b/i;

const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
export const parseMoney = (num: string, k?: string) => { const n = Number(num.replace(/,/g, '')); return k ? n * 1000 : n; };

export const heuristicProvider: SummaryProvider = {
  key: 'heuristic', model: 'rules-v1', version: '1',
  async extractChunk(msgs) {
    const ev: Evidence[] = [];
    for (const m of msgs) {
      const customer = m.direction === 'inbound'; const origin = customer ? 'customer_stated' : 'staff_stated';
      const base = { messageId: m.id, at: m.created_at, origin } as const;
      if (customer) {
        for (const s of sentences(m.body)) {
          if (BUDGET_CUE.test(s)) for (const mm of s.matchAll(MONEY_RE)) { const v = parseMoney(mm[1], mm[2]); if (v >= 500) ev.push({ ...base, field: 'budget', value: `$${v.toLocaleString('en-US')}`, normalized: v }); }
          if (TRADE_RE.test(s)) ev.push({ ...base, field: 'trade', value: s.slice(0, 200), normalized: s.toLowerCase().slice(0, 120) });
          if (PREF_RE.test(s) && !s.endsWith('?')) ev.push({ ...base, field: 'preference', value: s.slice(0, 200), normalized: s.toLowerCase().slice(0, 120) });
          if (s.endsWith('?')) ev.push({ ...base, field: 'question', value: s.slice(0, 200) });
          if (INTENT_RE.test(s)) ev.push({ ...base, field: 'goal', value: s.slice(0, 200) });
        }
        if (DECISION_RE.test(m.body)) ev.push({ ...base, field: 'decision', value: m.body.slice(0, 200), normalized: m.body.toLowerCase().slice(0, 100) });
      } else {
        for (const s of sentences(m.body)) if (PROMISE_RE.test(s)) ev.push({ ...base, field: 'promise', value: s.slice(0, 200), normalized: s.toLowerCase().slice(0, 120) });
      }
      const seen = new Set<string>();
      for (const re of [MAKE_RE, YEAR_BOAT_RE]) for (const mm of m.body.matchAll(re)) {
        const text = mm[0].trim().replace(/\s+/g, ' ');
        if (re === YEAR_BOAT_RE && !MAKES.some((mk) => text.includes(mk))) continue;   // a year + capitalised words alone is not evidence of a boat
        const key = text.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
        ev.push({ ...base, field: 'boat', value: text, normalized: key });
      }
      for (const mm of m.body.matchAll(DATE_RE)) ev.push({ ...base, field: 'date', value: mm[0], normalized: mm[0].toLowerCase() });   // raw phrase only; never resolved to a calendar date
    }
    return { evidence: ev, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};

let active: SummaryProvider = heuristicProvider;
export const getSummaryProvider = () => active;
export const registerSummaryProvider = (p: SummaryProvider) => { active = p; };
