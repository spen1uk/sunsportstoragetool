/**
 * Browser speech synthesis ($0, on-device voices such as macOS "Daniel" for en-GB).
 * `speechState` is read by the 3D core every frame (no React re-render). It reflects REAL playback: speaking turns on at the
 * utterance's start event, each word boundary adds a pulse, and it clears on end/cancel/error. It is not an audio-amplitude
 * analysis (the Web Speech API doesn't expose one); the docs say so.
 */
export const speechState = { speaking: false, level: 0, typing: false };   // typing: a reply is being written out on the Command Center screen
const subs = new Set<() => void>();
export const onSpeech = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const emitSpeech = () => subs.forEach((f) => f());
const emit = () => subs.forEach((f) => f());

export type VoiceCfg = { lang: string; voiceName: string; rate: number; pitch: number };
export const supported = () => typeof speechSynthesis !== 'undefined';
export const listVoices = () => (supported() ? speechSynthesis.getVoices() : []);

export function stop() {
  if (!supported()) return;
  speechSynthesis.cancel(); speechState.speaking = false; speechState.level = 0; emit();
}

/** Speak text. Any previous speech is cancelled first so stale replies never resume. */
export function speak(text: string, v: VoiceCfg) {
  if (!supported() || !text.trim()) return;
  stop();
  const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
  const voices = listVoices();
  const pick = voices.find((x) => x.name === v.voiceName) ?? voices.find((x) => x.lang === v.lang) ?? voices.find((x) => x.lang.startsWith(v.lang.slice(0, 2)));
  if (pick) { u.voice = pick; u.lang = pick.lang; } else u.lang = v.lang;
  u.rate = v.rate; u.pitch = v.pitch;
  u.onstart = () => { speechState.speaking = true; speechState.level = 0.6; emit(); };
  u.onboundary = () => { speechState.level = 1; };
  const done = () => { speechState.speaking = false; speechState.level = 0; emit(); };
  u.onend = done; u.onerror = done;
  speechSynthesis.speak(u);
}
