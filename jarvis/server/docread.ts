import zlib from 'node:zlib';

/**
 * Turns the bytes of a document into plain text, in units (pages, sheets, slides). It runs inside a throw-away child process (see doc-worker.ts),
 * because the file is untrusted. The kind is decided from the first bytes, never from the file name. Nothing here opens a network connection,
 * writes a file, runs a macro or follows a link. Word, Excel and PowerPoint files are zip files of XML; they are read with a small reader that
 * refuses encrypted, huge or oddly built files. PDFs go through the one reviewed library (unpdf), loaded only when a PDF arrives.
 */
export const MAX_FILE = 10 * 1024 * 1024, MAX_ENTRY = 24 * 1024 * 1024, MAX_ENTRIES = 3000, MAX_UNITS = 200, MAX_CHARS = 400_000;
export type Unit = { label: string; text: string };
export type Read = { kind: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'text' | 'csv'; units: Unit[] };
export class DocError extends Error {}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : ' '; } return ENT[e.toLowerCase()] ?? m; });
const clip = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- zip ----------
type ZEntry = { name: string; method: number; csize: number; usize: number; off: number; flags: number };
export function zipEntries(b: Buffer): ZEntry[] {
  let e = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new DocError('That is not a valid zip-based document.');
  const n = b.readUInt16LE(e + 10), cdOff = b.readUInt32LE(e + 16); if (n > MAX_ENTRIES) throw new DocError('That file has too many parts to read safely.');
  if (n === 0xffff || cdOff === 0xffffffff) throw new DocError('That file is too large or unusual to read safely.');
  const out: ZEntry[] = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new DocError('That document is damaged.');
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    out.push({ name: b.toString('utf8', p + 46, p + 46 + nl), method, csize, usize, off, flags }); p += 46 + nl + xl + cl;
  }
  return out;
}
export function zipRead(b: Buffer, en: ZEntry): string {
  if (en.flags & 1) throw new DocError('That document is password-protected, so I cannot read it.');
  if (en.usize > MAX_ENTRY) throw new DocError('A part of that document is too large to read safely.');
  if (en.off + 30 > b.length || b.readUInt32LE(en.off) !== 0x04034b50) throw new DocError('That document is damaged.');
  const start = en.off + 30 + b.readUInt16LE(en.off + 26) + b.readUInt16LE(en.off + 28), raw = b.subarray(start, start + en.csize);
  if (en.method === 0) return raw.toString('utf8');
  if (en.method !== 8) throw new DocError('That document uses a compression I do not support.');
  try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }).toString('utf8'); } catch { throw new DocError('A part of that document is damaged or too large to read safely.'); }
}
const byName = (es: ZEntry[], re: RegExp) => es.filter((x) => re.test(x.name)).sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }));

// ---------- Office XML ----------
export function docxText(xml: string): string {
  return clip(decode(xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<w:t\b[^>]*>([^<]*)<\/w:t>/g, '$1\u0001').replace(/<[^>]*>/g, '').replace(/\u0001/g, '')));
}
export function pptxText(xml: string): string { return clip(decode(xml.replace(/<\/a:p>/g, '\n').replace(/<a:t\b[^>]*>([^<]*)<\/a:t>/g, '$1\u0001').replace(/<[^>]*>/g, '').replace(/\u0001/g, ''))); }
function sharedStrings(xml: string): string[] { return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''))); }
export function sheetText(xml: string, ss: string[]): string {
  const rows: string[] = []; let n = 0;
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (++n > 5000) { rows.push('(more rows not read)'); break; } const cells: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = /\bt="(\w+)"/.exec(c[1])?.[1], body = c[2] ?? ''; let v = '';
      if (t === 'inlineStr') v = decode([...body.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
      else { const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? ''; v = t === 's' ? ss[Number(raw)] ?? '' : t === 'b' ? (raw === '1' ? 'yes' : 'no') : decode(raw); }
      if (v.trim()) cells.push(v.trim());
    }
    if (cells.length) rows.push(cells.join(' | '));
  }
  return clip(rows.join('\n'));
}

function office(b: Buffer): Read {
  const es = zipEntries(b), has = (re: RegExp) => es.some((x) => re.test(x.name));
  const part = (en: ZEntry) => zipRead(b, en);
  if (has(/^word\/document\.xml$/)) {
    const main = es.find((x) => x.name === 'word/document.xml')!, extra = byName(es, /^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/);
    const text = [docxText(part(main)), ...extra.map((x) => docxText(part(x)))].filter(Boolean).join('\n\n'); return { kind: 'docx', units: [{ label: 'document', text }] };
  }
  if (has(/^xl\/workbook\.xml$/)) {
    const ssE = es.find((x) => x.name === 'xl/sharedStrings.xml'), ss = ssE ? sharedStrings(part(ssE)) : [];
    const wb = part(es.find((x) => x.name === 'xl/workbook.xml')!), names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]));
    const sheets = byName(es, /^xl\/worksheets\/sheet\d+\.xml$/).slice(0, 50);
    return { kind: 'xlsx', units: sheets.map((x, i) => ({ label: `sheet ${names[i] ?? i + 1}`, text: sheetText(part(x), ss) })).filter((u) => u.text) };
  }
  if (has(/^ppt\/presentation\.xml$/)) {
    return { kind: 'pptx', units: byName(es, /^ppt\/slides\/slide\d+\.xml$/).slice(0, MAX_UNITS).map((x, i) => ({ label: `slide ${i + 1}`, text: pptxText(part(x)) })).filter((u) => u.text) };
  }
  throw new DocError('That zip file is not a Word, Excel or PowerPoint document.');
}

// ---------- everything ----------
export async function readDocument(bytes: Buffer): Promise<Read> {
  if (bytes.length === 0) throw new DocError('That file is empty.'); if (bytes.length > MAX_FILE) throw new DocError('That file is larger than 10 MB, which is the most I will read.');
  let r: Read;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') r = await pdf(bytes);
  else if (bytes.readUInt32LE(0) === 0x04034b50) r = office(bytes);
  else if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new DocError('That is an old Office format (.doc, .xls or .ppt). Save it as .docx, .xlsx or .pptx and add it again.');
  else {
    const head = bytes.subarray(0, 4096); if (head.includes(0)) throw new DocError('I can read PDF, Word, Excel, PowerPoint, text, CSV and web page files, and that is none of them.');
    const s = bytes.toString('utf8');
    if (/^\s*(?:<!doctype html|<html)/i.test(s)) { const text = clip(decode(s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n').replace(/<[^>]*>/g, ' '))); r = { kind: 'html', units: [{ label: 'page', text }] }; }
    else r = { kind: 'text', units: split(clip(s)).map((t, i) => ({ label: `part ${i + 1}`, text: t })) };
  }
  let total = 0; const units: Unit[] = [];
  for (const u of r.units) { if (units.length >= MAX_UNITS) break; const left = MAX_CHARS - total; if (left <= 0) break; const text = u.text.slice(0, left); if (text.trim()) { units.push({ label: u.label, text }); total += text.length; } }
  return { kind: r.kind, units };
}
const split = (s: string, n = 6000) => { const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };

async function pdf(bytes: Buffer): Promise<Read> {
  let lib: any; const name = 'unpdf';
  try { lib = await import(name); } catch { throw new DocError('Reading PDFs needs one package that has not been installed yet (unpdf). Run "npm install" in the Jarvis folder after it has been approved.'); }
  let doc: any;
  try { doc = await lib.getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: false }); } catch (e) { throw new DocError(/password/i.test(String((e as Error).message)) ? 'That PDF is password-protected, so I cannot read it.' : 'That PDF is damaged or not one I can read.'); }
  const pages = Math.min(doc.numPages as number, MAX_UNITS), units: Unit[] = [];
  for (let i = 1; i <= pages; i++) { const pg = await doc.getPage(i); const tc = await pg.getTextContent(); const text = clip(tc.items.map((it: any) => (typeof it.str === 'string' ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('')); units.push({ label: `page ${i}`, text }); }
  return { kind: 'pdf', units };
}
