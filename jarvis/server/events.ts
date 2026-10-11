import { EventEmitter } from 'node:events';
/** In-process push bus. The UI subscribes over SSE; no polling or model calls per update. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
export type PushEvent = { type: string; [k: string]: unknown };
export const publish = (e: PushEvent) => bus.emit('event', e);

/** Number of open dashboard (SSE) connections: the only honest signal we have that Luke is at the computer. */
export const clients = { n: 0 };

/** The system (agent id) that owns Jarvis-run work today. Pulses on the universe's links are attributed to it. */
export const WORKER_SYSTEM = 'proj';
export type PulseKind = 'dispatch' | 'done' | 'attention' | 'failed';
/** A real operational event for the UI to visualise as an energy packet on a link. Never emitted for ambient/decorative reasons. */
export const pulse = (kind: PulseKind, ref = '') => publish({ type: 'pulse', kind, system: WORKER_SYSTEM, ref });
