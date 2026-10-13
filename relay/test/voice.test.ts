import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import * as voice from '../src/domain/voice.js';
import { setStore, type BlobStore, getMediaForActor } from '../src/domain/media.js';
import { simulatorControl } from '../src/providers/sms.js';
import { buildApp } from '../src/server/app.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let sue: ReturnType<typeof actor>;
const mem = new Map<string, Buffer>();
const memStore: BlobStore = { put: async (k, d) => { mem.set(k, d); }, get: async (k) => mem.get(k)!, del: async (k) => { mem.delete(k); } };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
beforeEach(async () => { setStore(memStore); mem.clear(); voice.registerTranscriber(null); s = await resetDb(); sam = actor(s, 'sam', 'staff', ['sales']); sue = actor(s, 'sue', 'staff', ['service']); });
afterAll(() => pool.end());

describe('transcript cleanup', () => {
  it('removes fillers/stutters and fixes casing but never adds words (numbers preserved verbatim)', () => {
    const raw = "um so i can do the the pontoon for uh twenty five thousand dollars you know and i will call you at 3 pm";
    const out = voice.cleanTranscript(raw);
    expect(out).toBe('So I can do the pontoon for twenty five thousand dollars and I will call you at 3 pm.');
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const rawWords = new Set(norm(raw)); for (const w of norm(out)) expect(rawWords.has(w)).toBe(true);
  });
  it('property: output words are always a subset of input words (random inputs, incl. prices)', () => {
    const vocab = ['um', 'uh', 'the', 'boat', 'is', '$25,000', 'i', 'will', 'hold', 'it', 'until', 'friday', '3pm', 'like,', 'you', 'know', 'free', 'delivery', '0%'];
    for (let k = 0; k < 300; k++) {
      const raw = Array.from({ length: 3 + (k % 12) }, (_, i) => vocab[(k * 7 + i * 13) % vocab.length]).join(' ');
      const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9$%,]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/[,.]+$/, ''));
      const have = new Set(norm(raw)); for (const w of norm(voice.cleanTranscript(raw))) expect(have.has(w)).toBe(true);
    }
  });
});

describe('voice drafts', () => {
  it('recording alone never sends: draft stays a draft, nothing queued or sent, no job created', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0501');
    const d = await voice.createVoiceDraft(sam, conversationId, { audio: { data: WEBM, filename: 'v.webm' }, transcript: 'um hi i can have it ready friday', transcriptSource: 'browser_speech' });
    expect(d.cleanedText).toBe('Hi I can have it ready friday.'); expect(d.transcriptOriginal).toBe('um hi i can have it ready friday');
    await drain(); expect(simulatorControl.sent).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE direction='outbound'`)).rows[0].n).toBe(0);
  });
  it('without a transcription provider the draft asks for a transcript (no silent third-party upload)', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0502');
    const d = await voice.createVoiceDraft(sam, conversationId, { audio: { data: WEBM, filename: 'v.webm' } });
    expect(d).toMatchObject({ needsTranscript: true, transcriptionAvailable: false, transcriptOriginal: null });
  });
  it('server transcriber is used when configured; original transcript is kept next to the cleaned draft', async () => {
    voice.registerTranscriber({ key: 'fake', transcribe: async () => ({ text: 'uh price is thirty thousand' }) });
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0503');
    const d = await voice.createVoiceDraft(sam, conversationId, { audio: { data: WEBM, filename: 'v.webm' } });
    expect(d.transcriptOriginal).toBe('uh price is thirty thousand'); expect(d.cleanedText).toBe('Price is thirty thousand.');
    expect((await pool.query('SELECT transcript_source FROM voice_drafts WHERE id=$1', [d.id])).rows[0].transcript_source).toBe('server_stt');
  });
  it('sending requires explicit confirm; sends the reviewed text exactly once; consent still enforced', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0504');
    const d = await voice.createVoiceDraft(sam, conversationId, { transcript: 'see you friday' });
    await expect(voice.sendVoiceDraft(sam, d.id, { finalText: 'See you Friday.', confirm: false })).rejects.toThrow(/confirmation/);
    await voice.sendVoiceDraft(sam, d.id, { finalText: 'See you Friday!', confirm: true }); await drain();
    expect(simulatorControl.sent.map((x) => x.body)).toEqual(['See you Friday!']);
    await expect(voice.sendVoiceDraft(sam, d.id, { finalText: 'again', confirm: true })).rejects.toThrow(/already sent/);
    const d2 = await voice.createVoiceDraft(sam, conversationId, { transcript: 'second' });
    await pool.query('UPDATE contacts SET sms_opted_out=true WHERE id=$1', [contactId]);
    await expect(voice.sendVoiceDraft(sam, d2.id, { finalText: 'second', confirm: true })).rejects.toThrow(/sms_opted_out/);
  });
  it('drafts and recordings are private to their creator; discarding deletes the audio now', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0505');
    const d = await voice.createVoiceDraft(sam, conversationId, { audio: { data: WEBM, filename: 'v.webm' }, transcript: 'hello' });
    await expect(voice.getVoiceDraft(sue, d.id)).rejects.toThrow(/not found/); await expect(voice.sendVoiceDraft(sue, d.id, { finalText: 'x', confirm: true })).rejects.toThrow(/not found/);
    const mediaId = (await pool.query('SELECT audio_media_id FROM voice_drafts WHERE id=$1', [d.id])).rows[0].audio_media_id;
    await expect(getMediaForActor(sue, mediaId)).rejects.toThrow(/not found/);
    await voice.discardVoiceDraft(sam, d.id); expect(mem.size).toBe(0);
    await expect(getMediaForActor(sam, mediaId)).rejects.toThrow(/not found/);
  });
  it('retention: expired recordings are purged by maintenance; configured retention days are honored', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0506');
    await pool.query(`INSERT INTO workspace_settings VALUES ($1,'voice_retention_days','7',NULL)`, [s.workspaceId]);
    const d = await voice.createVoiceDraft(sam, conversationId, { audio: { data: WEBM, filename: 'v.webm' }, transcript: 'x' });
    const mid = (await pool.query('SELECT audio_media_id FROM voice_drafts WHERE id=$1', [d.id])).rows[0].audio_media_id;
    const days = (await pool.query(`SELECT extract(epoch FROM (expires_at - now()))/86400 AS d FROM media_assets WHERE id=$1`, [mid])).rows[0].d;
    expect(Math.round(days)).toBe(7);
    expect(await voice.purgeExpiredMedia()).toBe(0);
    await pool.query(`UPDATE media_assets SET expires_at = now() - interval '1 minute' WHERE id=$1`, [mid]);
    expect(await voice.purgeExpiredMedia()).toBe(1); expect(mem.size).toBe(0);
    expect((await pool.query('SELECT deleted_at FROM media_assets WHERE id=$1', [mid])).rows[0].deleted_at).not.toBeNull();
  });
});

describe('voice API (multipart)', () => {
  it('typed/browser transcript without audio works over HTTP; unknown file types are rejected', async () => {
    const app = await buildApp();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email: 'sam@demo.relay.test', password: 'test-password-123' } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0507');
    const boundary = 'xBOUNDARYx';
    const body = (parts: string) => `--${boundary}\r\n${parts}--${boundary}--\r\n`;
    const field = (n: string, v: string) => `Content-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n--${boundary}\r\n`;
    const send = (payload: string | Buffer) => app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/voice-drafts`, headers: { cookie, 'x-relay-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    const ok = await send(`--${boundary}\r\n${field('transcript', 'um hello there')}${field('transcriptSource', 'browser_speech')}`.replace(/--xBOUNDARYx\r\n$/, '') + `--${boundary}--\r\n`);
    expect(ok.statusCode).toBe(200); expect(ok.json().cleanedText).toBe('Hello there.');
    const bad = await send(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="x.exe"\r\nContent-Type: audio/webm\r\n\r\n`), Buffer.from('MZ not audio'), Buffer.from(`\r\n--${boundary}--\r\n`)]));
    expect(bad.statusCode).toBe(415);
    void body; await app.close();
  });
});
