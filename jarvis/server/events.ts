import { EventEmitter } from 'node:events';
/** In-process push bus. The UI subscribes over SSE; no polling or model calls per update. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
export type PushEvent = { type: string; [k: string]: unknown };
export const publish = (e: PushEvent) => bus.emit('event', e);
