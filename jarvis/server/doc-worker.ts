import { readDocument, DocError } from './docread.ts';
// Runs in a throw-away child process: reads the file bytes it is sent, answers once, exits. No network, no files, no secrets in its environment.
process.once('message', async (m: { bytes: string }) => {
  try { const r = await readDocument(Buffer.from(m.bytes, 'base64')); process.send!({ ok: true, ...r }, () => process.exit(0)); }
  catch (e) { process.send!({ ok: false, error: e instanceof DocError ? e.message : 'I could not read that file.' }, () => process.exit(0)); }
});
