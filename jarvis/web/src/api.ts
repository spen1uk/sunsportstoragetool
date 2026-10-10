import { useCallback, useEffect, useRef, useState } from 'react';

let csrf = '';
export const setCsrf = (c: string) => { csrf = c; };

export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-Jarvis-CSRF': csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
  return data as T;
}

export type Agent = { id: string; name: string; role: 'ceo' | 'manager' | 'employee'; parent_id: string | null; status_kind: string; description: string; sort: number };
export type AppState = {
  agents: Agent[]; pause: { paused: boolean; since: string | null; inflight: number };
  budget: { capMicroUsd: number; committedMicroUsd: number; fixedMicroUsd: number; usageMicroUsd: number; reservedMicroUsd: number; pctCommitted: number; level: string; period: string; note: string };
  counts: { tasksActive: number; review: number; approvals: number; blocked: number };
  running: { id: string; title: string; kind: string }[];
};

type Listener = (type: string) => void;
const listeners = new Set<Listener>();
let es: EventSource | null = null;
export const connection = { up: false, subs: new Set<() => void>() };

export function startEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => { connection.up = true; connection.subs.forEach((f) => f()); };
  es.onerror = () => { connection.up = false; connection.subs.forEach((f) => f()); };
  es.onmessage = (m) => { try { const e = JSON.parse(m.data); listeners.forEach((l) => l(e.type)); } catch { /* ignore */ } };
}
export function stopEvents() { es?.close(); es = null; connection.up = false; }

/** Fetch data and refetch whenever the server pushes one of the given event types (no polling). */
export function useLive<T>(fetcher: () => Promise<T>, types: string[], deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const fRef = useRef(fetcher); fRef.current = fetcher;
  const load = useCallback(() => { fRef.current().then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let t: number | undefined;
    const l: Listener = (type) => { if (types.includes(type)) { clearTimeout(t); t = window.setTimeout(load, 150); } };
    listeners.add(l); return () => { listeners.delete(l); clearTimeout(t); };
  }, [load, types.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load };
}

export const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro < 1e6 ? 3 : 2)}`;
export const ago = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
