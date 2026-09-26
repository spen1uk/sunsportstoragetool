// Pure helpers for frame math and hotspot placement. No DOM, no React —
// easy to unit test and safe to call from server components.

import type { Hotspot, MediaAsset, Point, SpinSet, SpinTier } from "./types";

/** Wrap any integer onto 1..count (so 0 → count, count + 1 → 1). */
export function wrapFrame(frame: number, count: number): number {
  return ((((Math.round(frame) - 1) % count) + count) % count) + 1;
}

/** Keep a frame on the sequence: wrap on a looping spin, clamp on a partial arc. */
export function normalizeFrame(frame: number, count: number, loop = true): number {
  return loop ? wrapFrame(frame, count) : Math.min(count, Math.max(1, Math.round(frame)));
}

/** Signed step count from `from` to `to`: shortest way round on a loop, direct otherwise. */
export function frameDelta(from: number, to: number, count: number, loop = true): number {
  return loop ? shortestDelta(from, to, count) : to - from;
}

/** Signed shortest step count from `from` to `to` on a loop of `count`. */
export function shortestDelta(from: number, to: number, count: number): number {
  let d = (to - from) % count;
  if (d > count / 2) d -= count;
  if (d < -count / 2) d += count;
  return d;
}

export function frameUrl(tier: SpinTier, frame: number, padLength: number): string {
  return tier.urlPattern.replace("{frame}", String(frame).padStart(padLength, "0"));
}

/** Degrees around the boat for a frame (frame 1 = 0° = bow-on). */
export function frameAngle(frame: number, count: number): number {
  return Math.round(((frame - 1) / count) * 360);
}

export function describeFrame(frame: number, spin: SpinSet): string {
  const loop = spin.loop !== false;
  const labels: Record<string, string> = {
    front: "front",
    starboard: "starboard (right) side",
    rear: "rear",
    port: "port (left) side",
  };
  const names = Object.entries(spin.angles)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .map(([k, f]) => [f, labels[k]] as [number, string]);
  const position = loop ? `, ${frameAngle(frame, spin.frameCount)}°` : `, frame ${frame} of ${spin.frameCount}`;
  if (names.length === 0) return position.slice(2);
  let best = names[0];
  const dist = (a: number) => Math.abs(frameDelta(frame, a, spin.frameCount, loop));
  for (const n of names) if (dist(n[0]) < dist(best[0])) best = n;
  return `${best[0] === frame ? "" : "Near "}${best[1]}${position}`;
}

export function isHotspotVisible(h: Hotspot, frame: number): boolean {
  if (h.visibleFrames) return h.visibleFrames.includes(frame);
  if (h.frameStart == null || h.frameEnd == null) return false;
  return h.frameStart <= h.frameEnd
    ? frame >= h.frameStart && frame <= h.frameEnd
    : frame >= h.frameStart || frame <= h.frameEnd;
}

/**
 * Position of a hotspot on a given frame. Uses the frame's own coordinate if
 * keyed, otherwise interpolates between the nearest keyed frames on either
 * side (around the loop), falling back to the default x/y.
 */
export function hotspotPosition(h: Hotspot, frame: number, count: number): Point | null {
  const keyed = h.positions ? Object.keys(h.positions).map(Number).sort((a, b) => a - b) : [];
  if (keyed.length === 0) return h.x != null && h.y != null ? { x: h.x, y: h.y } : null;
  const exact = h.positions![String(frame)];
  if (exact) return exact;
  if (keyed.length === 1) return h.positions![String(keyed[0])];

  let prev = keyed[keyed.length - 1];
  let next = keyed[0];
  for (const k of keyed) {
    if (k < frame) prev = k;
    if (k > frame) {
      next = k;
      break;
    }
  }
  const span = ((next - prev + count) % count) || count;
  const t = ((frame - prev + count) % count) / span;
  const a = h.positions![String(prev)];
  const b = h.positions![String(next)];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Largest-needed tier: the smallest one at least `targetWidth` wide. */
export function pickTier<T extends { width: number }>(tiers: T[], targetWidth: number): T {
  const sorted = [...tiers].sort((a, b) => a.width - b.width);
  return sorted.find((t) => t.width >= targetWidth) ?? sorted[sorted.length - 1];
}

/** `srcset` strings for a still image, per format. */
export function assetSrcSet(asset: MediaAsset, format: "webp" | "avif", includeThumb = false): string {
  return asset.tiers
    .filter((t) => (includeThumb || t.name !== "thumb") && t[format])
    .map((t) => `${t[format]} ${t.width}w`)
    .join(", ");
}

export function assetThumb(asset: MediaAsset): string {
  return (asset.tiers.find((t) => t.name === "thumb") ?? asset.tiers[0]).webp;
}
