const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<(script|style|noscript|template|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
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
