const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'br', 'section', 'article']);
export const MAX_HTML_CHARS = 400_000;
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));   // same length as the input, so indexes line up

/**
 * HTML → plain text in ONE LINEAR PASS (no backtracking regexes: a hostile page of "<script <script …" or "<<<<…" used to freeze the whole
 * server for minutes). Input is capped; script/style/etc. blocks are dropped with their contents; an unclosed one drops the rest.
 */
export function htmlToText(htmlIn: string): { title: string; text: string } {
  const html = htmlIn.length > MAX_HTML_CHARS ? htmlIn.slice(0, MAX_HTML_CHARS) : htmlIn, low = asciiLower(html), n = html.length;
  let title = '';
  const t0 = low.indexOf('<title');
  if (t0 >= 0) { const g = html.indexOf('>', t0), e = g >= 0 ? low.indexOf('</title', g) : -1; if (g >= 0 && e >= 0) title = html.slice(g + 1, e).replace(/\s+/g, ' ').trim(); }
  const out: string[] = []; let i = 0, gt = -2;       // gt: cached position of the next '>' at or after i (-1 = none left)
  const nextGt = (from: number) => { if (gt === -2 || (gt !== -1 && gt < from)) gt = html.indexOf('>', from); return gt; };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    if (lt > i) out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); out.push(' '); if (e < 0) break; i = e + 3; continue; }
    const g = nextGt(lt + 1);
    if (g < 0) { out.push(html.slice(lt)); break; }   // a '<' with no tag end anywhere after it is just text
    let k = lt + 1; const closing = html[k] === '/'; if (closing) k++;
    let m = k; while (m < g && m - k < 12 && /[a-z0-9]/.test(low[m])) m++;
    const name = low.slice(k, m);
    if (!closing && SKIP_TAGS.has(name)) { const e = low.indexOf('</' + name, g + 1); if (e < 0) break; const g2 = html.indexOf('>', e); out.push(' '); if (g2 < 0) break; i = g2 + 1; continue; }
    out.push(BLOCK_TAGS.has(name) && (closing || name === 'br') ? '\n' : ' '); i = g + 1;
  }
  const text = out.join('')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m)
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: decodeTitle(title), text };
}
const decodeTitle = (t: string) => t.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m);

const STOP = new Set('the a an and or of to in on for with is are was were be by as at from that this it its into about what how why who when which can do does'.split(' '));
export const keywords = (q: string) => [...new Set(q.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 2 && !STOP.has(w));

/** Extractive selection: top sentences by keyword overlap. No language model involved. */
export function topSentences(text: string, question: string, n = 5): string[] {
  const kw = keywords(question);
  const sentences = text.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 400);
  return sentences
    .map((s, i) => ({ s, i, score: kw.reduce((a, k) => a + (s.toLowerCase().includes(k) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
}
