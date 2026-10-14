import { api, setCsrf } from './api.ts';

/** Browser side of passkeys: translate between the server's text (base64url) and the browser's binary buffers. */
const enc = (b: ArrayBuffer) => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const dec = (s: string) => { const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4); const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
export const passkeySupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
export const onNumericAddress = () => /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname);

const friendly = (e: unknown) => {
  const n = (e as DOMException)?.name;
  if (n === 'NotAllowedError') return new Error('The passkey prompt was cancelled or timed out.');
  if (n === 'InvalidStateError') return new Error('This device already has a Jarvis passkey.');
  return e instanceof Error ? e : new Error(String(e));
};

export async function registerPasskey(name: string) {
  const o = await api<any>('/api/passkeys/register/options', 'POST', {});
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({ publicKey: { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) }, excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) })) } })) as PublicKeyCredential;
  } catch (e) { throw friendly(e); }
  const r = cred.response as AuthenticatorAttestationResponse;
  return api('/api/passkeys/register/verify', 'POST', { id: cred.id, name, transports: r.getTransports?.() ?? [], response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject) } });
}

async function assertion(optionsUrl: string, verifyUrl: string) {
  const o = await api<any>(optionsUrl, 'POST', {});
  let cred: PublicKeyCredential;
  try { cred = (await navigator.credentials.get({ publicKey: { challenge: dec(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout, allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) })) } })) as PublicKeyCredential; }
  catch (e) { throw friendly(e); }
  const r = cred.response as AuthenticatorAssertionResponse;
  return api<any>(verifyUrl, 'POST', { id: cred.id, response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature) } });
}
export async function signInWithPasskey() { const r = await assertion('/api/passkeys/login/options', '/api/passkeys/login/verify'); setCsrf(r.csrf); return r; }
export const stepUpWithPasskey = () => assertion('/api/passkeys/stepup/options', '/api/passkeys/stepup/verify');
