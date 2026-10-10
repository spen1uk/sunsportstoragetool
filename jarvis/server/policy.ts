import { z } from 'zod';
import type { DB } from './db.ts';
import { isPaused } from './pause.ts';

/**
 * Server-enforced tool policy. Model/prompt output and fetched content can never widen this:
 * the tool table, per-task-kind grants and argument schemas live here, outside any prompt.
 */
const TOOLS = {
  fetch_source: { args: z.object({ url: z.string().url().max(2048) }).strict(), grantedTo: ['research'] as string[] },
  save_artifact: { args: z.object({ title: z.string().max(200) }).passthrough(), grantedTo: ['research', 'revision'] as string[] },
} as const;

export type ToolName = keyof typeof TOOLS;
export type AuthResult =
  | { ok: true; args: any }
  | { ok: false; reason: string; needsApproval?: { actionType: string; payload: unknown } };

export function authorizeTool(db: DB, ctx: { taskKind: string; allowInsecureHttp?: boolean }, tool: string, rawArgs: unknown): AuthResult {
  if (isPaused(db)) return { ok: false, reason: 'Jarvis is paused; no new tool actions.' };
  const def = (TOOLS as Record<string, (typeof TOOLS)[ToolName]>)[tool];
  if (!def) return { ok: false, reason: `unknown tool "${tool}"` };
  if (!def.grantedTo.includes(ctx.taskKind)) return { ok: false, reason: `task kind "${ctx.taskKind}" is not granted tool "${tool}"` };
  const parsed = def.args.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, reason: `invalid arguments: ${parsed.error.issues[0]?.message}` };
  if (tool === 'fetch_source') {
    const u = new URL((parsed.data as { url: string }).url);
    if (u.protocol !== 'https:' && !(ctx.allowInsecureHttp && u.protocol === 'http:')) return { ok: false, reason: 'only https sources are allowed' };
    if (u.username || u.password) return { ok: false, reason: 'credentials in URLs are not allowed' };
    if (!isHostAllowed(db, u.hostname)) {
      return { ok: false, reason: `${u.hostname} is not on the research allow-list`, needsApproval: { actionType: 'allow_domain', payload: { host: u.hostname.toLowerCase() } } };
    }
  }
  return { ok: true, args: parsed.data };
}

export function isHostAllowed(db: DB, host: string): boolean {
  return !!db.prepare('SELECT 1 FROM allowed_domains WHERE host=?').get(host.toLowerCase());
}
