// Progressive preloader + in-memory cache for a 360° frame sequence.
//
// Loading order (lowest score first, recomputed every time a slot frees up so
// it always follows what the customer is looking at right now):
//
//   0. the current frame at the lowest tier   → something on screen fast
//   1. the current frame at the display tier  → sharp first impression
//   2. ±3 neighbours at the lowest tier        → first drag feels instant
//   3. the whole sequence at the lowest tier   → full loop spins, nearest first
//   4. the whole sequence at the display tier  → background upgrade
//   5. zoom tier, current frame only           → only when zoomed in
//
// Decoded HTMLImageElements are kept in a Map, so a frame is fetched at most
// once per tier. Frame changes never touch the network.

import { frameDelta, frameUrl, pickTier } from "./frames";
import type { SpinSet, SpinTier } from "./types";

type TierName = SpinTier["name"];

interface Task {
  frame: number;
  tier: SpinTier;
  score: number;
}

export interface FrameCacheOptions {
  concurrency?: number;
  onFrameReady?: (frame: number, tier: TierName) => void;
  onProgress?: (loadedFrames: number, total: number) => void;
}

export class FrameCache {
  private readonly spin: SpinSet;
  private readonly tiers: SpinTier[];
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly inflight = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly opts: FrameCacheOptions;
  private current: number;
  private displayTier: SpinTier;
  private zoomTier: SpinTier | null = null;
  private backgroundEnabled = false;
  private saveData = false;
  private disposed = false;
  private framesWithAnyTier = new Set<number>();

  constructor(spin: SpinSet, opts: FrameCacheOptions = {}) {
    this.spin = spin;
    this.tiers = [...spin.tiers].sort((a, b) => a.width - b.width);
    this.opts = opts;
    this.current = spin.initialFrame;
    this.displayTier = this.tiers[0];
    if (typeof navigator !== "undefined") {
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      this.saveData = Boolean(conn?.saveData);
    }
  }

  private key(frame: number, tier: TierName) {
    return `${tier}:${frame}`;
  }

  /** Choose the tier that matches the rendered pixel width (15% tolerance). */
  setDisplayWidth(pixelWidth: number) {
    this.displayTier = pickTier(this.tiers, pixelWidth * 0.85);
    this.pump();
  }

  /** Request the zoom tier for the current frame (null to cancel). */
  setZoomWidth(pixelWidth: number | null) {
    this.zoomTier = pixelWidth ? pickTier(this.tiers, pixelWidth * 0.85) : null;
    this.pump();
  }

  setCurrent(frame: number) {
    this.current = frame;
    this.pump();
  }

  /** Begin loading the whole sequence (call once the viewer is on screen). */
  startBackground() {
    this.backgroundEnabled = true;
    this.pump();
  }

  /** Sharpest decoded image available for a frame, or null if none yet. */
  get(frame: number): HTMLImageElement | null {
    for (let i = this.tiers.length - 1; i >= 0; i--) {
      const img = this.images.get(this.key(frame, this.tiers[i].name));
      if (img) return img;
    }
    return null;
  }

  dispose() {
    this.disposed = true;
    this.images.clear();
  }

  private candidates(): Task[] {
    const n = this.spin.frameCount;
    const low = this.tiers[0];
    const tasks: Task[] = [];
    const push = (frame: number, tier: SpinTier, phase: number) => {
      const k = this.key(frame, tier.name);
      if (this.images.has(k) || this.inflight.has(k) || this.failed.has(k)) return;
      const distance = Math.abs(frameDelta(this.current, frame, n, this.spin.loop !== false));
      tasks.push({ frame, tier, score: phase * 1000 + distance });
    };

    push(this.current, low, 0);
    if (this.displayTier !== low) push(this.current, this.displayTier, 1);
    if (this.zoomTier && this.zoomTier.width > this.displayTier.width) push(this.current, this.zoomTier, 1);
    for (let d = -3; d <= 3; d++) {
      const f = this.current + d;
      if (this.spin.loop !== false) push(((f - 1 + n) % n) + 1, low, 2);
      else if (f >= 1 && f <= n) push(f, low, 2);
    }
    if (this.backgroundEnabled) {
      for (let f = 1; f <= n; f++) push(f, low, 3);
      if (!this.saveData && this.displayTier !== low) {
        for (let f = 1; f <= n; f++) push(f, this.displayTier, 4);
      }
    }
    return tasks;
  }

  private pump() {
    if (this.disposed) return;
    const limit = this.opts.concurrency ?? 4;
    if (this.inflight.size >= limit) return;
    const tasks = this.candidates().sort((a, b) => a.score - b.score);
    for (const task of tasks) {
      if (this.inflight.size >= limit) break;
      void this.load(task);
    }
  }

  private async load({ frame, tier }: Task) {
    const k = this.key(frame, tier.name);
    this.inflight.add(k);
    const img = new Image();
    img.decoding = "async";
    img.src = frameUrl(tier, frame, this.spin.padLength);
    try {
      if (typeof img.decode === "function") {
        await img.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("load failed"));
        });
      }
      if (this.disposed) return;
      this.images.set(k, img);
      this.framesWithAnyTier.add(frame);
      this.opts.onFrameReady?.(frame, tier.name);
      this.opts.onProgress?.(this.framesWithAnyTier.size, this.spin.frameCount);
    } catch {
      this.failed.add(k);
    } finally {
      this.inflight.delete(k);
      this.pump();
    }
  }
}
