import { EventEmitter } from 'node:events';
/** In-process push bus. The UI subscribes over SSE; no polling or model calls per update. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
export type PushEvent = { type: string; [k: string]: unknown };
export const publish = (e: PushEvent) => bus.emit('event', e);

/** Number of open dashboard (SSE) connections: the only honest signal we have that Luke is at the computer. */
export const clients = { n: 0 };
