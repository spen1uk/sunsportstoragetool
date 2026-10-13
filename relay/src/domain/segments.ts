// SMS segment estimation (GSM-7 vs UCS-2). Used for usage estimates only — the provider's own count is authoritative.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = '^{}\\[~]|€';
export function smsSegments(text: string): { segments: number; encoding: 'GSM-7' | 'UCS-2'; length: number } {
  let units = 0; let gsm = true;
  for (const ch of text) { if (GSM_BASIC.includes(ch)) units += 1; else if (GSM_EXT.includes(ch)) units += 2; else { gsm = false; break; } }
  if (gsm) return { segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), encoding: 'GSM-7', length: units };
  const len = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);   // UCS-2 counts surrogate pairs as 2
  return { segments: len <= 70 ? 1 : Math.ceil(len / 67), encoding: 'UCS-2', length: len };
}
