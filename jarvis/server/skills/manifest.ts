import { z } from 'zod';

/**
 * Skill vocabulary. Every capability a skill can need, every place data may come from, and every kind of side effect is listed here, in code.
 * A skill cannot invent a new capability or grant itself one: only a reviewed change to this file adds to the list.
 */
export const CAPABILITIES = {
  'tasks.read': 0, 'tasks.write': 1, 'habits.write': 1, 'people.write': 1, 'goals.write': 1, 'links.write': 1, 'memory.read': 0, 'memory.write': 1, 'knowledge.read': 0,
  'catalog.read': 0, 'catalog.write': 1, 'web.search': 0, 'web.fetch': 1, 'docs.process': 0, 'research.queue': 1,
  'artifacts.publish': 2, 'artifacts.delete': 3, 'domains.allow': 3, 'budget.raise': 3, 'messages.send': 3, 'money.move': 4,
} as const;
export type Capability = keyof typeof CAPABILITIES;
export const SIDE_EFFECTS = ['none', 'internal_write', 'external_read', 'external_write', 'money'] as const;
export const SENSITIVITY = ['public', 'private', 'secret'] as const;
export const TRUST = ['builtin', 'reviewed', 'experimental'] as const;
/** Where the work actually runs today. Only 'direct' skills run through the registry's own `invoke`; the others keep their existing, tested path (dual-run). */
export const RUN_PATHS = ['direct', 'proposal', 'approval', 'job', 'turn'] as const;
export const SENS_RANK: Record<string, number> = { public: 0, private: 1, secret: 2 };
export const EFFECT_RANK: Record<string, number> = { none: 0, internal_write: 1, external_read: 2, external_write: 3, money: 4 };

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(60),
  title: z.string().min(3).max(80), purpose: z.string().min(10).max(400), owner: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/),
  version: semver,
  permissions: z.array(z.enum(Object.keys(CAPABILITIES) as [Capability, ...Capability[]])).max(8),
  dependencies: z.array(z.string()).max(8).default([]),
  dataSensitivity: z.enum(SENSITIVITY), sideEffects: z.enum(SIDE_EFFECTS),
  /** True if what the skill returns comes from outside (web pages, search results): it must never steer a skill with side effects. */
  untrustedOutput: z.boolean().default(false),
  externalServices: z.array(z.string().max(60)).max(5).default([]),
  cost: z.object({ perCallMicroUsd: z.number().int().min(0).max(5_000_000).default(0), note: z.string().max(160).default('') }).default({ perCallMicroUsd: 0, note: '' }),
  trust: z.enum(TRUST), runPath: z.enum(RUN_PATHS),
  /** The existing key in proposals.ts / approvals.ts this skill describes (used by the parity tests). */
  legacyKey: z.string().max(40).optional(),
  modelProposable: z.boolean().default(false), standingEligible: z.boolean().default(false),
  /** Shown to any agent whose ceilings allow it without a per-agent grant (read-only, public, free skills only). */
  autoShare: z.boolean().default(false),
  outputDescription: z.string().max(200), tests: z.array(z.string().max(80)).max(6).default([]), docs: z.string().max(300).default(''),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** The highest tier among what the skill needs, plus what its side effects imply. Tier 3+ always needs your approval; tier 4 is permanently outside the registry. */
export const tierOf = (m: Pick<Manifest, 'permissions' | 'sideEffects'>) => Math.max(0, ...m.permissions.map((p) => CAPABILITIES[p]), m.sideEffects === 'money' ? 4 : m.sideEffects === 'external_write' ? 3 : 0);

export const PRINCIPALS = {
  jarvis: { label: 'Jarvis', maxSensitivity: 'private', capabilities: ['tasks.read', 'tasks.write', 'habits.write', 'people.write', 'goals.write', 'links.write', 'memory.read', 'memory.write', 'catalog.read', 'catalog.write', 'web.search', 'web.fetch', 'docs.process', 'research.queue'] as Capability[] },
  prometheus: { label: 'Prometheus', maxSensitivity: 'public', capabilities: ['catalog.read', 'catalog.write', 'web.search', 'web.fetch', 'docs.process', 'research.queue'] as Capability[] },
} as const;
export type Principal = keyof typeof PRINCIPALS;
export const isPrincipal = (p: string): p is Principal => p in PRINCIPALS;
