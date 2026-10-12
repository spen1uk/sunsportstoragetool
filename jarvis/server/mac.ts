import { execFile } from 'node:child_process';

/**
 * Read-only bridge to Apple apps on the Mac Jarvis runs on, via macOS's own scripting (osascript / JavaScript for Automation).
 * No password or token is stored: macOS shows its own permission prompt the first time, and Luke can revoke it in
 * System Settings → Privacy & Security → Automation. Every script here only READS.
 */
export type MacErrorKind = 'unavailable' | 'permission' | 'timeout' | 'failed';
export class MacError extends Error { kind: MacErrorKind; constructor(kind: MacErrorKind, msg: string) { super(msg); this.kind = kind; } }

export type Runner = (script: string, args: string[], timeoutMs: number) => Promise<string>;
export const isMac = () => process.platform === 'darwin';

export function classify(stderr: string, timedOut: boolean): MacError {
  if (timedOut) return new MacError('timeout', 'The Mac took too long to answer (a large calendar or Notes library can need a longer first sync). Try again.');
  if (/-1743|not authori[sz]ed|not allowed to send apple events|assistive/i.test(stderr)) {
    return new MacError('permission', 'macOS has not allowed this yet. Open System Settings → Privacy & Security → Automation, switch on Calendar / Notes for Terminal (or the app that started Jarvis), then try again.');
  }
  return new MacError('failed', `The Mac reported an error: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown'}`);
}

const osaRunner: Runner = (script, args, timeoutMs) => new Promise((resolve, reject) => {
  if (!isMac()) return reject(new MacError('unavailable', 'Calendar and Notes can only be read on a Mac. Jarvis is not running on one.'));
  execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(classify(String(stderr || err.message), !!(err as any).killed));
    resolve(String(stdout));
  });
});

let runner: Runner = osaRunner;
export const getRunner = () => runner;
/** Tests inject a fake Mac here. */
export function setRunner(r: Runner | null) { runner = r ?? osaRunner; }
