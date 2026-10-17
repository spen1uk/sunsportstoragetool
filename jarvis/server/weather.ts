import { z } from 'zod';
import { type DB, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import { fetchSource } from './fetch.ts';

/**
 * Live weather from Open-Meteo (free, no account or key). This is NOT general web access: the only two hosts Jarvis will ever contact for it are
 * fixed below, it is off until Luke turns it on in Settings (with a passphrase/passkey), and everything the model sees is rebuilt from numeric
 * fields and our own word table, never from free text sent by the service. A failed refresh shows the last good reading labelled with its age,
 * or "unavailable"; weather is never guessed.
 */
export const HOSTS = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
export type Fetcher = (url: string) => Promise<string>;
export const defaultFetcher: Fetcher = async (url) => (await fetchSource(url, { isHostAllowed: (h) => HOSTS.has(h.toLowerCase()), maxBytes: 200_000, timeoutMs: 8_000, totalMs: 12_000, maxRedirects: 0 })).body;

const CFG = 'weather:config', CACHE = 'weather:cache', FAIL = 'weather:lastfail';
const FRESH_MS = 15 * 60_000, USABLE_MS = 3 * 3_600_000;
const cleanName = (s: string) => s.replace(/[^\p{L}\p{N} .,'’-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

export const configInput = z.object({ name: z.string().min(1).max(80), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), units: z.enum(['f', 'c']).default('f') }).strict();
export type Config = z.infer<typeof configInput>;
export function getConfig(db: DB): Config | null { try { const v = getMeta(db, CFG); return v ? configInput.parse(JSON.parse(v)) : null; } catch { return null; } }
export function setConfig(db: DB, raw: unknown) { const c = configInput.parse(raw); setMeta(db, CFG, JSON.stringify({ ...c, name: cleanName(c.name) || 'Home' })); setMeta(db, CACHE, ''); audit(db, 'luke', 'weather.enabled', c.name.slice(0, 40), { lat: Math.round(c.lat * 100) / 100, lon: Math.round(c.lon * 100) / 100 }); }
export function clearConfig(db: DB) { setMeta(db, CFG, ''); setMeta(db, CACHE, ''); audit(db, 'luke', 'weather.disabled', 'weather'); }

// WMO weather codes → plain words (the only wording Jarvis ever uses for conditions)
const WMO: Record<number, string> = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };
export const describe = (code: number) => WMO[code] ?? 'unsettled';

const num = z.number().finite();
const forecastSchema = z.object({
  current: z.object({ temperature_2m: num, apparent_temperature: num.optional(), weather_code: num, wind_speed_10m: num.optional(), precipitation: num.optional() }),
  daily: z.object({ time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(7), weather_code: z.array(num), temperature_2m_max: z.array(num), temperature_2m_min: z.array(num), precipitation_probability_max: z.array(num.nullable()).optional() }),
});
export type Reading = { fetchedAt: number; name: string; units: 'f' | 'c'; temp: number; feels: number | null; wind: number | null; cond: string; days: { date: string; cond: string; hi: number; lo: number; rain: number | null }[] };

export async function fetchReading(c: Config, f: Fetcher = defaultFetcher, now = Date.now()): Promise<Reading> {
  const q = new URLSearchParams({ latitude: c.lat.toFixed(3), longitude: c.lon.toFixed(3), current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max', temperature_unit: c.units === 'f' ? 'fahrenheit' : 'celsius', wind_speed_unit: c.units === 'f' ? 'mph' : 'kmh', timezone: 'auto', forecast_days: '3' });
  const j = forecastSchema.parse(JSON.parse(await f(`https://api.open-meteo.com/v1/forecast?${q}`)));
  const d = j.daily, n = Math.min(d.time.length, d.weather_code.length, d.temperature_2m_max.length, d.temperature_2m_min.length, 3);
  return { fetchedAt: now, name: cleanName(c.name) || 'Home', units: c.units, temp: Math.round(j.current.temperature_2m), feels: j.current.apparent_temperature == null ? null : Math.round(j.current.apparent_temperature), wind: j.current.wind_speed_10m == null ? null : Math.round(j.current.wind_speed_10m), cond: describe(j.current.weather_code),
    days: Array.from({ length: n }, (_, i) => ({ date: d.time[i], cond: describe(d.weather_code[i]), hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), rain: d.precipitation_probability_max?.[i] == null ? null : Math.round(d.precipitation_probability_max[i]!) })) };
}

export type Place = { name: string; region: string; country: string; lat: number; lon: number };
const placeSchema = z.object({ results: z.array(z.object({ name: z.string(), latitude: num, longitude: num, admin1: z.string().optional(), country: z.string().optional() })).max(10).optional() });
export async function searchPlaces(query: string, f: Fetcher = defaultFetcher): Promise<Place[]> {
  const q = cleanName(query); if (q.length < 2) return [];
  const j = placeSchema.parse(JSON.parse(await f(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '5', language: 'en', format: 'json' })}`)));
  return (j.results ?? []).map((r) => ({ name: cleanName(r.name), region: cleanName(r.admin1 ?? ''), country: cleanName(r.country ?? ''), lat: r.latitude, lon: r.longitude }));
}

const unit = (u: 'f' | 'c') => (u === 'f' ? '°F' : '°C'), speed = (u: 'f' | 'c') => (u === 'f' ? 'mph' : 'km/h');
export function summarize(r: Reading, now = Date.now()): string {
  const age = Math.max(0, Math.round((now - r.fetchedAt) / 60_000)), u = unit(r.units);
  const L = [`${r.name}: ${r.temp}${u}, ${r.cond}${r.feels != null && Math.abs(r.feels - r.temp) >= 3 ? ` (feels like ${r.feels}${u})` : ''}${r.wind != null ? `, wind ${r.wind} ${speed(r.units)}` : ''}.`];
  const names = ['Today', 'Tomorrow', 'Day after'];
  r.days.forEach((d, i) => L.push(`${names[i] ?? d.date}: ${d.cond}, high ${d.hi}${u}, low ${d.lo}${u}${d.rain != null ? `, ${d.rain}% chance of precipitation` : ''}.`));
  L.push(`(Open-Meteo, ${age < 2 ? 'just now' : `${age} min ago`}.)`);
  return L.join(' ');
}

export function cached(db: DB): Reading | null { try { const v = getMeta(db, CACHE); return v ? (JSON.parse(v) as Reading) : null; } catch { return null; } }
/** Refresh if the saved reading is older than 15 minutes. Never throws: on failure the old reading stays and ages. */
export async function refresh(db: DB, f: Fetcher = defaultFetcher, now = Date.now(), force = false): Promise<{ ok: boolean; error?: string }> {
  const c = getConfig(db); if (!c) return { ok: false, error: 'not enabled' };
  const old = cached(db); if (!force && old && now - old.fetchedAt < FRESH_MS) return { ok: true };
  if (!force && now - Number(getMeta(db, FAIL) || 0) < 2 * 60_000) return { ok: false, error: 'the last attempt failed a moment ago' };   // don't make every chat message wait on a service that is down
  try { setMeta(db, CACHE, JSON.stringify(await fetchReading(c, f, now))); setMeta(db, FAIL, '0'); return { ok: true }; }
  catch (e) { setMeta(db, FAIL, String(now)); return { ok: false, error: e instanceof z.ZodError ? 'the weather service sent something unexpected' : (e as Error).message.slice(0, 120) }; }
}

/** The line the chat model sees (data, not instructions). Honest about off / stale / unavailable. */
export function contextLine(db: DB, now = Date.now()): string {
  if (!getConfig(db)) return 'WEATHER: not connected. If Luke asks about weather, tell him he can turn it on in Settings → Weather (free, no account). Do not guess.';
  const r = cached(db); if (!r || now - r.fetchedAt > USABLE_MS) return 'WEATHER: connected but unavailable right now (could not reach the weather service). Say so; do not guess.';
  return `WEATHER (live data): ${summarize(r, now)}`;
}
/** One short spoken clause for the greeting, only when the reading is recent. */
export function greetingBit(db: DB, now = Date.now()): string | null {
  const r = cached(db); if (!getConfig(db) || !r || now - r.fetchedAt > 2 * 3_600_000) return null;
  return `it's ${r.temp} degrees and ${r.cond} in ${r.name}${r.days[0] ? `, with a high of ${r.days[0].hi}` : ''}`;
}
