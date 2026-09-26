"use client";

// One Pointer Events state machine for everything the stage responds to, so
// mouse, pen and touch share a single code path:
//
//   1 pointer, not zoomed, spin mode    → rotate (reported as px deltas)
//   1 pointer, not zoomed, gallery mode → horizontal swipe = next/prev photo
//   1 pointer, zoomed                   → pan (rotation is suppressed)
//   2 pointers                          → pinch-zoom around the midpoint
//   double tap / double click           → toggle zoom at that point
//   wheel                               → zoom (see `wheelZoom`)
//
// Elements marked `data-no-drag` (toolbar, arrows, cards) never start a
// gesture. Everything else — including hotspot markers — can: the pointer is
// only captured once a drag actually begins, so a plain tap on a hotspot
// still delivers its click, while a swipe that starts on one still rotates.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export const IDENTITY: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** Keep the zoomed content covering the stage (or centred when smaller). */
export function clampZoom(z: ZoomState, box: Box, stageW: number, stageH: number, maxScale: number): ZoomState {
  const scale = Math.min(maxScale, Math.max(1, z.scale));
  if (scale <= 1.001) return IDENTITY;
  const axis = (t: number, start: number, size: number, stage: number) => {
    const scaled = size * scale;
    if (scaled <= stage) return (stage - scaled) / 2 - start * scale;
    return Math.min(-start * scale, Math.max(stage - (start + size) * scale, t));
  };
  return { scale, tx: axis(z.tx, box.left, box.width, stageW), ty: axis(z.ty, box.top, box.height, stageH) };
}

/** Zoom to `scale` keeping stage point (fx, fy) fixed under the finger/cursor. */
export function zoomAround(z: ZoomState, scale: number, fx: number, fy: number): ZoomState {
  const k = scale / z.scale;
  return { scale, tx: fx - (fx - z.tx) * k, ty: fy - (fy - z.ty) * k };
}

interface Options {
  stageRef: React.RefObject<HTMLElement | null>;
  getContentBox: () => Box;
  mode: "spin" | "gallery";
  maxScale?: number;
  /** "always" (fullscreen) or "modifier" (ctrl/⌘ or already zoomed) */
  wheelZoom: "always" | "modifier";
  onRotateStart?: () => void;
  onRotate?: (dxPx: number) => void;
  onRotateEnd?: (velocityPxPerMs: number) => void;
  onSwipe?: (dir: 1 | -1) => void;
  onTap?: (x: number, y: number, zoom: ZoomState) => void;
  onWheelHint?: () => void;
  onZoomUsed?: (method: string) => void;
}

interface PointerInfo {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
}

const TAP_SLOP = 8;

function capture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer already released — nothing to capture.
  }
}
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2.5;

export function useStageGestures(opts: Options) {
  const [zoom, setZoomState] = useState<ZoomState>(IDENTITY);
  const [interacting, setInteracting] = useState(false);
  const zoomRef = useRef(zoom);
  const optsRef = useRef(opts);
  const pointers = useRef(new Map<number, PointerInfo>());
  const gesture = useRef<"none" | "rotate" | "pan" | "swipe" | "pinch">("none");
  const samples = useRef<{ t: number; x: number }[]>([]);
  const pinchStart = useRef<{ dist: number; zoom: ZoomState; midX: number; midY: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  useEffect(() => {
    optsRef.current = opts;
  });

  const maxScale = opts.maxScale ?? 4;

  const stageSize = useCallback(() => {
    const el = optsRef.current.stageRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1, h: 1 };
  }, []);

  const setZoom = useCallback(
    (next: ZoomState) => {
      const { w, h } = stageSize();
      const clamped = clampZoom(next, optsRef.current.getContentBox(), w, h, maxScale);
      zoomRef.current = clamped;
      setZoomState(clamped);
    },
    [maxScale, stageSize],
  );

  const zoomBy = useCallback(
    (factor: number, focal?: { x: number; y: number }) => {
      const { w, h } = stageSize();
      const f = focal ?? { x: w / 2, y: h / 2 };
      const z = zoomRef.current;
      setZoom(zoomAround(z, Math.min(maxScale, Math.max(1, z.scale * factor)), f.x, f.y));
    },
    [maxScale, setZoom, stageSize],
  );

  const resetZoom = useCallback(() => setZoom(IDENTITY), [setZoom]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = optsRef.current.stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as Element).closest("[data-no-drag]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    pointers.current.set(e.pointerId, { x: p.x, y: p.y, startX: p.x, startY: p.y, startT: performance.now() });

    if (pointers.current.size === 2) {
      // Second finger: switch whatever we were doing into a pinch.
      if (gesture.current === "rotate") optsRef.current.onRotateEnd?.(0);
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: zoomRef.current,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      gesture.current = "pinch";
      for (const id of pointers.current.keys()) capture(e.currentTarget, id);
      setInteracting(true);
      return;
    }
    gesture.current = "none";
    samples.current = [{ t: performance.now(), x: p.x }];
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const info = pointers.current.get(e.pointerId);
      if (!info) return;
      const p = local(e);
      const dx = p.x - info.x;
      const dy = p.y - info.y;
      info.x = p.x;
      info.y = p.y;

      if (gesture.current === "pinch" && pinchStart.current && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const s = pinchStart.current;
        const scale = Math.min(maxScale, Math.max(1, s.zoom.scale * (dist / s.dist)));
        const z = zoomAround(s.zoom, scale, s.midX, s.midY);
        setZoom({ scale, tx: z.tx + (midX - s.midX), ty: z.ty + (midY - s.midY) });
        return;
      }

      if (gesture.current === "none") {
        const moved = Math.hypot(p.x - info.startX, p.y - info.startY);
        if (moved < TAP_SLOP) return;
        if (zoomRef.current.scale > 1) gesture.current = "pan";
        else if (optsRef.current.mode === "spin") {
          gesture.current = "rotate";
          optsRef.current.onRotateStart?.();
        } else gesture.current = "swipe";
        capture(e.currentTarget, e.pointerId);
        setInteracting(true);
      }

      if (gesture.current === "pan") {
        const z = zoomRef.current;
        setZoom({ ...z, tx: z.tx + dx, ty: z.ty + dy });
      } else if (gesture.current === "rotate") {
        optsRef.current.onRotate?.(dx);
        const now = performance.now();
        samples.current.push({ t: now, x: p.x });
        while (samples.current.length > 2 && now - samples.current[0].t > 90) samples.current.shift();
      }
    },
    [maxScale, setZoom],
  );

  const finish = useCallback(
    (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
      const info = pointers.current.get(e.pointerId);
      if (!info) return;
      pointers.current.delete(e.pointerId);
      const g = gesture.current;

      if (g === "pinch") {
        if (pointers.current.size === 0) {
          gesture.current = "none";
          setInteracting(false);
          optsRef.current.onZoomUsed?.("pinch");
        } else {
          // One finger still down: continue as a pan from here.
          gesture.current = zoomRef.current.scale > 1 ? "pan" : "none";
        }
        return;
      }

      if (g === "rotate") {
        const s = samples.current;
        const now = performance.now();
        const first = s[0];
        const last = s[s.length - 1];
        const fresh = now - last.t < 60;
        const v = !cancelled && fresh && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
        optsRef.current.onRotateEnd?.(v);
      } else if (g === "swipe" && !cancelled) {
        const dx = info.x - info.startX;
        const dy = info.y - info.startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) optsRef.current.onSwipe?.(dx < 0 ? 1 : -1);
      } else if (g === "none" && !cancelled && !(e.target as Element).closest("button")) {
        const now = performance.now();
        const lt = lastTap.current;
        if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(info.x - lt.x, info.y - lt.y) < 30) {
          lastTap.current = null;
          const z = zoomRef.current;
          if (z.scale > 1) resetZoom();
          else setZoom(zoomAround(z, DOUBLE_TAP_ZOOM, info.x, info.y));
          optsRef.current.onZoomUsed?.("double_tap");
        } else {
          lastTap.current = { t: now, x: info.x, y: info.y };
          optsRef.current.onTap?.(info.x, info.y, zoomRef.current);
        }
      }
      gesture.current = "none";
      setInteracting(false);
    },
    [resetZoom, setZoom],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => finish(e, false), [finish]);
  // A pointer that leaves before a drag began was never captured, so its
  // pointerup would be lost; forget it now so it can't fake a second finger.
  const onPointerLeave = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (gesture.current === "none") pointers.current.delete(e.pointerId);
  }, []);
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLElement>) => finish(e, true), [finish]);

  // Wheel + Safari gesture events need non-passive native listeners.
  useEffect(() => {
    const el = opts.stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[data-no-drag]")) return;
      const o = optsRef.current;
      const wants = o.wheelZoom === "always" || e.ctrlKey || e.metaKey || zoomRef.current.scale > 1;
      if (!wants) {
        o.onWheelHint?.();
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse notch
      // is ~100. Clamp so one notch is a comfortable ~1.5× step.
      const delta = Math.max(-40, Math.min(40, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      const factor = Math.exp(-delta * 0.01);
      zoomBy(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      o.onZoomUsed?.("wheel");
    };
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stopGesture);
    el.addEventListener("gesturechange", stopGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stopGesture);
      el.removeEventListener("gesturechange", stopGesture);
    };
  }, [opts.stageRef, zoomBy]);

  return {
    zoom,
    setZoom,
    zoomBy,
    resetZoom,
    interacting,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave },
  };
}
