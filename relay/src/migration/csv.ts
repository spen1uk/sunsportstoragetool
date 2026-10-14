/** Minimal RFC 4180 CSV reader: BOM, CRLF/LF/CR, quoted fields with "" escapes and embedded newlines, delimiter sniffing (, ; tab). */
export interface Csv { headers: string[]; rows: string[][]; delimiter: string }

export function parseCsv(input: string): Csv {
  const text = input.replace(/^\uFEFF/, '');
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQ = false; let i = 0; let any = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); if (row.length > 1 || row[0].trim() !== '') rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; any = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === '\r') { endRow(); i += text[i + 1] === '\n' ? 2 : 1; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (inQ) throw new Error('unterminated quoted field (the file is truncated or malformed)');
  if (field !== '' || row.length || any) endRow();
  const [h, ...data] = rows;
  if (!h) throw new Error('file is empty');
  return { headers: h.map((x) => x.trim()), rows: data, delimiter };
}

/** CSV writer for reports; cells that a spreadsheet would execute as formulas are neutralised. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
