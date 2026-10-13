import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from './events.js';
import type { Actor, Role } from './authz.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_FAILS = 5;

export async function login(email: string, password: string, ua?: string, ip?: string): Promise<{ token: string } | null> {
  const u = (await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
  // Constant-ish work even for unknown users to blunt user enumeration timing.
  if (!u || !u.password_hash || !u.is_active) { await argon2.hash(password).catch(() => {}); await audit(pool, { action: 'login.failed', meta: { email }, ip }); return null; }
  if (u.locked_until && u.locked_until > new Date()) return null;
  if (!(await argon2.verify(u.password_hash, password))) {
    await pool.query(`UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=$2 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [u.id, MAX_FAILS]);
    await audit(pool, { actorUserId: u.id, action: 'login.failed', ip });
    return null;
  }
  const m = (await pool.query('SELECT workspace_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1', [u.id])).rows[0];
  if (!m) return null;
  await pool.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (id_hash, user_id, workspace_id, expires_at, user_agent) VALUES ($1,$2,$3,now()+($4||' hours')::interval,$5)`, [sha(token), u.id, m.workspace_id, config.sessionTtlHours, ua ?? null]);
  await audit(pool, { workspaceId: m.workspace_id, actorUserId: u.id, action: 'login.success', ip });
  return { token };
}

export async function logout(token: string) { await pool.query('DELETE FROM sessions WHERE id_hash=$1', [sha(token)]); }

export async function actorFromToken(token: string | undefined): Promise<Actor | null> {
  if (!token) return null;
  const r = (await pool.query(
    `SELECT s.user_id, s.workspace_id, u.name, m.role,
       COALESCE((SELECT array_agg(md.department_id) FROM membership_departments md WHERE md.membership_id=m.id), '{}') AS deps
     FROM sessions s JOIN users u ON u.id=s.user_id AND u.is_active JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
     WHERE s.id_hash=$1 AND s.expires_at>now()`, [sha(token)])).rows[0];
  if (!r) return null;
  return { userId: r.user_id, workspaceId: r.workspace_id, role: r.role as Role, departmentIds: r.deps, name: r.name };
}

export const hashPassword = (p: string) => argon2.hash(p);

export async function createInvitation(a: Actor, email: string, role: 'admin' | 'manager' | 'staff', departmentIds: string[]) {
  const token = randomBytes(24).toString('base64url');
  await pool.query(`INSERT INTO invitations (workspace_id,email,role,department_ids,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '7 days')`, [a.workspaceId, email.toLowerCase(), role, departmentIds, sha(token), a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'invite.create', meta: { email, role } });
  return token;   // delivered out-of-band (email adapter pending); shown once to the admin
}

export async function acceptInvitation(token: string, name: string, password: string) {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  const inv = (await pool.query('SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now()', [sha(token)])).rows[0];
  if (!inv) return null;
  const hash = await hashPassword(password);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query(`INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash) RETURNING id`, [inv.email, name, hash])).rows[0];
    const m = (await c.query(`INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role RETURNING id`, [inv.workspace_id, u.id, inv.role])).rows[0];
    for (const d of inv.department_ids) await c.query('INSERT INTO membership_departments VALUES ($1,$2) ON CONFLICT DO NOTHING', [m.id, d]);
    await c.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [inv.id]);
    await c.query('COMMIT');
    return u.id as string;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
