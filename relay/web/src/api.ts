export class ApiError extends Error { constructor(public status: number, message: string, public body?: any) { super(message); } }
export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-relay-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const text = await res.text(); const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data as T;
}
export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});

/** Subscribe to server-sent events; auto-reconnects (EventSource does this natively). */
export function subscribe(onEvent: (e: any) => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
  return () => es.close();
}
export const uuid = () => crypto.randomUUID();
export const fmtTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
export const nameOf = (c: { first_name?: string | null; last_name?: string | null; company?: string | null; phone?: string | null }) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.phone || 'Unknown';
