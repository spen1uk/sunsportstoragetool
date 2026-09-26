"use client";

// <Boat360Viewer boat={config} /> — the reusable viewer engine.
//
// It knows nothing about any particular boat: everything (frames, hotspots,
// galleries, view buttons, specs) comes from the BoatViewerConfig.
//
// Rendering model
// - The stage measures itself and "contain"-fits the current image into a
//   content box. Zoom/pan is one CSS transform on a layer holding that box.
// - Spin frames are painted onto a <canvas> from a decoded-image cache
//   (lib/boat360/frame-cache.ts); changing frames is a single drawImage and
//   never hits the network.
// - Gallery photos use <picture> with AVIF/WebP srcsets whose `sizes` tracks
//   the zoomed width, so zooming pulls in the high-res tier automatically.
// - Hotspots are positioned in stage pixels from percentage coordinates, so
//   they follow rotation, zoom and resize but never scale themselves.
// - Overlays (cards, video) render inside the viewer root, not in portals,
//   so they keep working in element fullscreen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { track } from "@/lib/boat360/analytics";
import { FrameCache } from "@/lib/boat360/frame-cache";
import {
  assetSrcSet,
  describeFrame,
  hotspotPosition,
  isHotspotVisible,
  frameDelta,
  normalizeFrame,
} from "@/lib/boat360/frames";
import type { BoatViewerConfig, Gallery, Hotspot, VideoRef, ViewButton } from "@/lib/boat360/types";
import { type Box, IDENTITY, useStageGestures } from "./use-stage-gestures";
import { HotspotMarker } from "./hotspot-marker";
import { HotspotCard } from "./hotspot-card";
import { VideoModal } from "./video-modal";
import { ViewSelector } from "./view-selector";
import { ThumbnailStrip, type ThumbEntry } from "./thumbnail-strip";
import { EngineSpecPanel, TrailerSpecPanel } from "./spec-panels";

type Mode = { kind: "spin" } | { kind: "gallery"; galleryId: string; index: number };
type FullscreenState = "none" | "native" | "pseudo";

const MAX_ZOOM = 4;
const INERTIA_TIME_CONSTANT = 325; // ms
const MAX_DPR = 2;

function containBox(stageW: number, stageH: number, aspect: number): Box {
  if (stageW <= 0 || stageH <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  let width = stageW;
  let height = width / aspect;
  if (height > stageH) {
    height = stageH;
    width = height * aspect;
  }
  return { left: (stageW - width) / 2, top: (stageH - height) / 2, width, height };
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keep a ref pointed at the latest value (for stable callbacks). */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface Boat360ViewerProps {
  boat: BoatViewerConfig;
  /** View id to open first (defaults to the spin, or the first gallery). */
  initialView?: string;
  className?: string;
  /** Show the photo gallery under the viewer. Default true. */
  showThumbnails?: boolean;
}

export function Boat360Viewer({ boat, initialView, className, showThumbnails = true }: Boat360ViewerProps) {
  const spin = boat.spin;
  const frameCount = spin?.frameCount ?? 1;
  const loop = spin?.loop !== false;
  // Hide angle shortcuts the sequence doesn't cover.
  const views = useMemo(
    () => boat.views.filter((v) => v.action.type !== "angle" || spin?.angles[v.action.angle] != null),
    [boat.views, spin],
  );

  const galleriesById = useMemo(() => new Map(boat.galleries.map((g) => [g.id, g])), [boat.galleries]);
  const hotspotsById = useMemo(() => new Map(boat.hotspots.map((h) => [h.id, h])), [boat.hotspots]);

  const initialMode = useMemo<Mode>(() => {
    const view = boat.views.find((v) => v.id === initialView);
    if (view?.action.type === "gallery") return { kind: "gallery", galleryId: view.action.galleryId, index: 0 };
    if (spin) return { kind: "spin" };
    return { kind: "gallery", galleryId: boat.galleries[0]?.id ?? "", index: 0 };
  }, [boat, initialView, spin]);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [frame, setFrame] = useState(spin?.initialFrame ?? 1);
  const [spinViewId, setSpinViewId] = useState("spin");
  const [activeHotspotId, setActiveHotspotId] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoRef | null>(null);
  const [fullscreen, setFullscreen] = useState<FullscreenState>("none");
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [progress, setProgress] = useState({ loaded: 0, total: frameCount });
  const [firstFrameShown, setFirstFrameShown] = useState(false);
  const [hasRotated, setHasRotated] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [wheelHint, setWheelHint] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [picker, setPicker] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<FrameCache | null>(null);
  const posRef = useRef(spin?.initialFrame ?? 1);
  const frameRef = useRef(spin?.initialFrame ?? 1);
  const drawnRef = useRef<number | null>(null);
  const animRef = useRef<number | null>(null);
  const rotatedFramesRef = useRef(0);
  const openedTrackedRef = useRef(false);
  const wheelHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Derived geometry ------------------------------------------------------
  const gallery: Gallery | null = mode.kind === "gallery" ? (galleriesById.get(mode.galleryId) ?? null) : null;
  const galleryImage = gallery ? gallery.images[mode.kind === "gallery" ? mode.index : 0] : null;
  const galleryAsset = galleryImage ? boat.assets[galleryImage.assetId] : null;

  const spinBox = useMemo(() => containBox(stage.w, stage.h, spin ? spin.width / spin.height : 4 / 3), [stage, spin]);
  const galleryBox = useMemo(
    () => containBox(stage.w, stage.h, galleryAsset ? galleryAsset.width / galleryAsset.height : 4 / 3),
    [stage, galleryAsset],
  );
  const box = mode.kind === "spin" ? spinBox : galleryBox;
  const boxRef = useLatest(box);

  // --- Canvas drawing ---------------------------------------------------------
  const draw = useCallback((f: number) => {
    const canvas = canvasRef.current;
    const img = cacheRef.current?.get(f);
    if (!canvas || !img || canvas.width === 0) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawnRef.current = f;
    return true;
  }, []);

  const showFrame = useCallback(
    (f: number) => {
      if (f === frameRef.current) return;
      frameRef.current = f;
      draw(f);
      cacheRef.current?.setCurrent(f);
      setFrame(f);
    },
    [draw],
  );

  const setPos = useCallback(
    (pos: number) => {
      posRef.current = pos;
      // A partial arc stops at its ends instead of wrapping round.
      const clamped = loop ? pos : Math.min(frameCount, Math.max(1, pos));
      posRef.current = clamped;
      showFrame(normalizeFrame(clamped, frameCount, loop));
    },
    [frameCount, loop, showFrame],
  );

  // --- Frame cache lifecycle ---------------------------------------------------
  useEffect(() => {
    if (!spin) return;
    const cache = new FrameCache(spin, {
      concurrency: 4,
      onFrameReady: (f) => {
        if (f === frameRef.current && draw(f)) setFirstFrameShown(true);
      },
      onProgress: (loaded, total) => setProgress({ loaded, total }),
    });
    cacheRef.current = cache;
    cache.setCurrent(frameRef.current);
    return () => {
      cache.dispose();
      cacheRef.current = null;
    };
  }, [spin, draw]);

  // Start the full-sequence download only once the viewer is near the screen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        cacheRef.current?.startBackground();
        if (!openedTrackedRef.current) {
          openedTrackedRef.current = true;
          track("360_view_opened", boat.boatId, { has_spin: Boolean(spin), placeholder_spin: Boolean(spin?.placeholder) });
        }
        io.disconnect();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [boat.boatId, spin]);

  // Stage size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Gestures ----------------------------------------------------------------
  const pxPerFrame = useCallback(
    () => Math.max(stageRef.current?.clientWidth ?? 600, 480) / frameCount / (spin?.sensitivity ?? 1),
    [frameCount, spin?.sensitivity],
  );
  const dragDir = spin?.reverseDrag ? -1 : 1;

  const stopAnimation = useCallback(() => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }, []);

  const finishRotation = useCallback(() => {
    setRotating(false);
    setAnnouncement(spin ? `Showing ${describeFrame(frameRef.current, spin)}` : "");
    if (rotatedFramesRef.current >= 1) {
      track("360_rotated", boat.boatId, { frames: Math.round(rotatedFramesRef.current), end_frame: frameRef.current });
    }
    rotatedFramesRef.current = 0;
  }, [boat.boatId, spin]);

  const startInertia = useCallback(
    (velocity: number) => {
      let v = velocity;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - last);
        last = now;
        v *= Math.exp(-dt / INERTIA_TIME_CONSTANT);
        const before = posRef.current;
        setPos(before + v * dt);
        rotatedFramesRef.current += Math.abs(v * dt);
        const hitEnd = !loop && (posRef.current <= 1 || posRef.current >= frameCount);
        if (Math.abs(v) < 0.004 || hitEnd) {
          animRef.current = null;
          setPos(Math.round(posRef.current));
          finishRotation();
          return;
        }
        animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    },
    [finishRotation, frameCount, loop, setPos],
  );

  const animateToFrame = useCallback(
    (target: number) => {
      stopAnimation();
      const from = posRef.current;
      const delta = frameDelta(frameRef.current, target, frameCount, loop);
      if (delta === 0 || prefersReducedMotion()) {
        setPos(from + delta);
        return;
      }
      const duration = Math.min(700, 160 + Math.abs(delta) * 26);
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        setPos(from + delta * eased);
        if (t < 1) animRef.current = requestAnimationFrame(step);
        else {
          animRef.current = null;
          setPos(Math.round(from + delta));
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [frameCount, loop, setPos, stopAnimation],
  );

  const galleryStep = useCallback(
    (dir: 1 | -1) => {
      setMode((m) => {
        if (m.kind !== "gallery") return m;
        const g = galleriesById.get(m.galleryId);
        if (!g) return m;
        return { ...m, index: (m.index + dir + g.images.length) % g.images.length };
      });
    },
    [galleriesById],
  );

  const onTapRef = useLatest((x: number, y: number, z: typeof IDENTITY) => {
    if (!picker) {
      setActiveHotspotId(null);
      return;
    }
    // Hotspot coordinate picker (append ?hotspotPicker=1). Precursor to the
    // Phase 2 admin editor: click the boat, get a ready-to-paste position.
    const b = boxRef.current;
    const px = +((((x - z.tx) / z.scale - b.left) / b.width) * 100).toFixed(1);
    const py = +((((y - z.ty) / z.scale - b.top) / b.height) * 100).toFixed(1);
    if (px < 0 || px > 100 || py < 0 || py > 100) return;
    const snippet =
      mode.kind === "spin"
        ? `"${frameRef.current}": { "x": ${px}, "y": ${py} }`
        : `{ "hotspotId": "", "x": ${px}, "y": ${py} } // ${mode.galleryId}/${galleryImage?.id}`;
    void navigator.clipboard?.writeText(snippet).catch(() => {});
    toast.message("Hotspot position copied", { description: snippet });
  });

  const gestures = useStageGestures({
    stageRef,
    getContentBox: () => boxRef.current,
    mode: mode.kind,
    maxScale: MAX_ZOOM,
    wheelZoom: fullscreen !== "none" ? "always" : "modifier",
    onRotateStart: () => {
      stopAnimation();
      setActiveHotspotId(null);
      setSpinViewId("spin");
      setHasRotated(true);
      setRotating(true);
    },
    onRotate: (dx) => {
      const df = (dragDir * dx) / pxPerFrame();
      rotatedFramesRef.current += Math.abs(df);
      setPos(posRef.current + df);
    },
    onRotateEnd: (v) => {
      const vf = (dragDir * v) / pxPerFrame();
      if (spin?.inertia !== false && Math.abs(vf) > 0.006 && !prefersReducedMotion()) {
        startInertia(Math.max(-0.09, Math.min(0.09, vf)));
      } else {
        setPos(Math.round(posRef.current));
        finishRotation();
      }
    },
    onSwipe: (dir) => galleryStep(dir),
    onTap: (x, y, z) => onTapRef.current(x, y, z),
    onWheelHint: () => {
      setWheelHint(true);
      if (wheelHintTimer.current) clearTimeout(wheelHintTimer.current);
      wheelHintTimer.current = setTimeout(() => setWheelHint(false), 1600);
    },
    onZoomUsed: (method) => track("zoom_used", boat.boatId, { method, mode: mode.kind }),
  });
  const { zoom, zoomBy, resetZoom, setZoom } = gestures;

  // --- Canvas backing store follows box size × zoom (crisp when zoomed) -------
  const zoomBucket = Math.min(3, Math.ceil(zoom.scale * 2) / 2);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spin || spinBox.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.min(4096, Math.round(spinBox.width * dpr * zoomBucket));
    const h = Math.round((w * spin.height) / spin.width);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    cacheRef.current?.setDisplayWidth(spinBox.width * dpr);
    cacheRef.current?.setZoomWidth(zoomBucket > 1 && mode.kind === "spin" ? spinBox.width * dpr * zoomBucket : null);
    if (draw(frameRef.current)) setFirstFrameShown(true);
  }, [spin, spinBox.width, zoomBucket, mode.kind, draw]);

  // Re-clamp zoom when the stage/box changes (resize, fullscreen, image change).
  useEffect(() => {
    setZoom(gestures.zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on geometry change
  }, [box.width, box.height, stage.w, stage.h]);

  // Picker flag from the URL (client only).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a browser-only value after hydration
    setPicker(new URLSearchParams(window.location.search).has("hotspotPicker"));
  }, []);

  // --- Navigation ----------------------------------------------------------------
  const openGallery = useCallback(
    (galleryId: string, imageId?: string) => {
      const g = galleriesById.get(galleryId);
      if (!g || g.images.length === 0) return;
      stopAnimation();
      const index = Math.max(0, imageId ? g.images.findIndex((i) => i.id === imageId) : 0);
      setMode({ kind: "gallery", galleryId, index });
      setActiveHotspotId(null);
      resetZoom();
      if (g.category === "engine" || g.detail === "engine") track("engine_viewed", boat.boatId);
      else if (g.category === "interior") track("interior_viewed", boat.boatId);
      else if (g.category === "trailer" || g.detail === "trailer") track("trailer_viewed", boat.boatId);
    },
    [boat.boatId, galleriesById, resetZoom, stopAnimation],
  );

  const selectViewRef = useLatest((view: ViewButton) => {
    setActiveHotspotId(null);
    resetZoom();
    const a = view.action;
    if (a.type === "gallery") {
      openGallery(a.galleryId, a.imageId);
      return;
    }
    if (a.type === "video") {
      const v = boat.videos?.find((x) => x.id === a.videoId);
      if (v) {
        setVideo(v);
        track("video_played", boat.boatId, { video_id: v.id, source: "view_button" });
      }
      return;
    }
    if (!spin) return;
    setMode({ kind: "spin" });
    setSpinViewId(view.id);
    if (a.type === "angle") {
      const target = spin.angles[a.angle];
      if (target == null) return;
      animateToFrame(target);
      setAnnouncement(`${view.label}: ${describeFrame(target, spin)}`);
    } else setAnnouncement("360° view. Drag or use the arrow keys to rotate.");
  });
  const onSelectView = useCallback((view: ViewButton) => selectViewRef.current(view), [selectViewRef]);

  const thumbEntries = useMemo<ThumbEntry[]>(() => {
    const seen = new Set<string>();
    const out: ThumbEntry[] = [];
    for (const g of boat.galleries) {
      g.images.forEach((img, index) => {
        const asset = boat.assets[img.assetId];
        if (!asset || seen.has(asset.id)) return;
        seen.add(asset.id);
        out.push({ key: `${g.id}/${img.id}`, galleryId: g.id, index, label: img.label ?? g.label, asset });
      });
    }
    return out;
  }, [boat.assets, boat.galleries]);

  const onThumbRef = useLatest((entry: ThumbEntry) => {
    // Stay in the current gallery if it contains this photo.
    if (gallery) {
      const idx = gallery.images.findIndex((i) => i.assetId === entry.asset.id);
      if (idx >= 0) {
        setMode({ kind: "gallery", galleryId: gallery.id, index: idx });
        resetZoom();
        return;
      }
    }
    openGallery(entry.galleryId, galleriesById.get(entry.galleryId)?.images[entry.index]?.id);
  });
  const onSelectThumb = useCallback((entry: ThumbEntry) => onThumbRef.current(entry), [onThumbRef]);

  const onSelectHotspot = useCallback(
    (id: string) => {
      const h = hotspotsById.get(id);
      if (!h) return;
      stopAnimation();
      setActiveHotspotId((cur) => (cur === id ? null : id));
      track("hotspot_clicked", boat.boatId, { hotspot_id: id, category: h.category });
      if (h.category === "condition") track("condition_issue_viewed", boat.boatId, { hotspot_id: id, condition: h.conditionType });
    },
    [boat.boatId, hotspotsById, stopAnimation],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (mode.kind === "gallery") {
        galleryStep(dir);
        return;
      }
      stopAnimation();
      setSpinViewId("spin");
      setPos(Math.round(posRef.current) + dir);
      setHasRotated(true);
    },
    [galleryStep, mode.kind, setPos, stopAnimation],
  );

  // Gallery image changes → analytics + announcement.
  useEffect(() => {
    if (!gallery || !galleryImage) return;
    track("gallery_image_viewed", boat.boatId, { gallery: gallery.id, image: galleryImage.id });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- screen reader announcement mirrors navigation
    setAnnouncement(
      `${gallery.label} photo ${(mode.kind === "gallery" ? mode.index : 0) + 1} of ${gallery.images.length}: ${galleryImage.caption ?? ""}`,
    );
  }, [boat.boatId, gallery, galleryImage, mode]);

  // --- Fullscreen ------------------------------------------------------------------
  const toggleFullscreen = useCallback(async () => {
    const el = rootRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (!el) return;
    if (fullscreen === "pseudo") {
      setFullscreen("none");
      return;
    }
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return;
    }
    track("fullscreen_entered", boat.boatId);
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else setFullscreen("pseudo");
    } catch {
      // iPhone Safari has no element fullscreen: fall back to a fixed overlay.
      setFullscreen("pseudo");
    }
  }, [boat.boatId, fullscreen]);

  useEffect(() => {
    const onChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      const active = (doc.fullscreenElement ?? doc.webkitFullscreenElement) === rootRef.current;
      setFullscreen((cur) => (active ? "native" : cur === "native" ? "none" : cur));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  useEffect(() => {
    if (fullscreen !== "pseudo") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen("none");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  useEffect(() => () => stopAnimation(), [stopAnimation]);

  // --- Keyboard ----------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest("[role=dialog]")) return;
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      step(k === "ArrowRight" ? 1 : -1);
    } else if (k === "+" || k === "=") {
      zoomBy(1.4);
      track("zoom_used", boat.boatId, { method: "keyboard" });
    } else if (k === "-" || k === "_") zoomBy(1 / 1.4);
    else if (k === "0") resetZoom();
    else if (k === "f" || k === "F") void toggleFullscreen();
    else if (k === "Escape") {
      if (activeHotspotId) setActiveHotspotId(null);
      else if (zoom.scale > 1) resetZoom();
    }
  };

  // --- Hotspots on screen ----------------------------------------------------------
  const toStage = (px: number, py: number) => ({
    x: zoom.tx + zoom.scale * (box.left + (px / 100) * box.width),
    y: zoom.ty + zoom.scale * (box.top + (py / 100) * box.height),
  });
  const onScreen = (p: { x: number; y: number }) => p.x > 8 && p.x < stage.w - 8 && p.y > 8 && p.y < stage.h - 8;

  const markers: { hotspot: Hotspot; x: number; y: number }[] = [];
  if (mode.kind === "spin" && spin && firstFrameShown) {
    for (const h of boat.hotspots) {
      if (!isHotspotVisible(h, frame)) continue;
      const pos = hotspotPosition(h, frame, frameCount);
      if (!pos) continue;
      const p = toStage(pos.x, pos.y);
      if (onScreen(p)) markers.push({ hotspot: h, ...p });
    }
  } else if (galleryImage) {
    for (const placement of galleryImage.hotspots ?? []) {
      const h = hotspotsById.get(placement.hotspotId);
      if (!h) continue;
      const p = toStage(placement.x, placement.y);
      if (onScreen(p)) markers.push({ hotspot: h, ...p });
    }
  }

  const activeHotspot = activeHotspotId ? (hotspotsById.get(activeHotspotId) ?? null) : null;
  const activeViewId =
    mode.kind === "spin" ? spinViewId : (boat.views.find((v) => v.action.type === "gallery" && v.action.galleryId === mode.galleryId)?.id ?? null);
  const detailPanel = gallery?.detail;
  const isFs = fullscreen !== "none";
  const loading = mode.kind === "spin" && !firstFrameShown;
  const spinLoadingAll = progress.loaded < progress.total;
  const title = [boat.make, boat.model].join(" ");
  const instructionsId = `boat360-${boat.slug}-instructions`;

  return (
    <section
      ref={rootRef}
      aria-label={`${[boat.year, title].filter(Boolean).join(" ")} interactive viewer`}
      className={cn(
        "flex flex-col gap-3 text-slate-900",
        isFs && "h-full w-full bg-[#06152b] p-2 sm:p-3",
        fullscreen === "pseudo" && "fixed inset-0 z-[100] h-[100dvh]",
        className,
      )}
    >
      {/* ---------------------------------------------------------------- STAGE */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-roledescription={mode.kind === "spin" ? "360 degree viewer" : "photo viewer"}
        aria-label={
          mode.kind === "spin" && spin
            ? `360° view of the ${title}. ${describeFrame(frame, spin)}.`
            : `${gallery?.label ?? "Photo"}: ${galleryAsset?.alt ?? ""}`
        }
        aria-describedby={instructionsId}
        onKeyDown={onKeyDown}
        {...gestures.handlers}
        className={cn(
          "relative select-none overflow-hidden rounded-2xl bg-gradient-to-b from-[#0d2a4f] via-[#0b2545] to-[#06152b] outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2",
          isFs ? "min-h-0 flex-1" : "h-[min(74svh,106vw)] sm:h-[min(72vh,64vw)] lg:h-[min(78vh,760px)]",
          zoom.scale > 1 ? "cursor-move" : mode.kind === "spin" ? (rotating ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
        )}
        style={{ touchAction: zoom.scale > 1 ? "none" : "pan-y" }}
      >
        <p id={instructionsId} className="sr-only">
          {mode.kind === "spin"
            ? "Drag or swipe sideways, or use the left and right arrow keys, to rotate the boat. Plus and minus keys zoom, F toggles fullscreen. Feature hotspots are buttons you can tab to."
            : "Swipe or use the left and right arrow keys for the previous or next photo. Plus and minus keys zoom."}
        </p>

        {/* Zoom/pan layer */}
        <div
          className={cn("absolute inset-0 origin-top-left will-change-transform", !gestures.interacting && "transition-transform duration-200 ease-out")}
          style={{ transform: `translate3d(${zoom.tx}px, ${zoom.ty}px, 0) scale(${zoom.scale})` }}
        >
          {spin && (
            <canvas
              ref={canvasRef}
              aria-hidden
              className={cn("absolute", mode.kind !== "spin" && "invisible")}
              style={{ left: spinBox.left, top: spinBox.top, width: spinBox.width, height: spinBox.height }}
            />
          )}
          {mode.kind === "gallery" && galleryAsset && (
            <picture
              key={galleryAsset.id}
              className="absolute block bg-cover bg-center"
              style={{
                left: galleryBox.left,
                top: galleryBox.top,
                width: galleryBox.width,
                height: galleryBox.height,
                backgroundImage: galleryAsset.blurDataURL ? `url(${galleryAsset.blurDataURL})` : undefined,
              }}
            >
              {galleryAsset.tiers.some((t) => t.avif) && (
                <source type="image/avif" srcSet={assetSrcSet(galleryAsset, "avif")} sizes={`${Math.round(galleryBox.width * zoom.scale)}px`} />
              )}
              <source type="image/webp" srcSet={assetSrcSet(galleryAsset, "webp")} sizes={`${Math.round(galleryBox.width * zoom.scale)}px`} />
              <img
                src={(galleryAsset.tiers.find((t) => t.name === "md") ?? galleryAsset.tiers[galleryAsset.tiers.length - 1]).webp}
                alt={galleryAsset.alt}
                width={galleryAsset.width}
                height={galleryAsset.height}
                draggable={false}
                decoding="async"
                className="size-full motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
              />
            </picture>
          )}
        </div>

        {/* Hotspots (not scaled) */}
        {markers.map((m) => (
          <HotspotMarker
            key={m.hotspot.id}
            hotspot={m.hotspot}
            x={m.x}
            y={m.y}
            active={m.hotspot.id === activeHotspotId}
            dimmed={rotating}
            showLabel={stage.w >= 640 && !rotating}
            onSelect={onSelectHotspot}
          />
        ))}

        {/* Loading */}
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80">
            <LoaderCircle className="size-8 animate-spin" />
            <span className="text-xs font-semibold uppercase tracking-widest">Loading 360°</span>
          </div>
        )}

        {/* Title + 360 badge */}
        <div className="pointer-events-none absolute left-2 top-2 flex max-w-[55%] flex-col items-start gap-2 sm:left-5 sm:top-5 sm:max-w-[70%]">
          <div className="px-1 py-1 text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.55)] sm:p-0">
            <p className="text-sm font-extrabold uppercase leading-none tracking-wide sm:text-2xl lg:text-3xl">{boat.make}</p>
            <p className="mt-1 text-xs font-semibold uppercase leading-none tracking-[0.2em] sm:text-base">
              {boat.model}
              {boat.year ? <span className="ml-2 font-normal opacity-80">{boat.year}</span> : null}
            </p>
          </div>
          {mode.kind === "spin" && spin && (
            <div className="hidden items-center gap-3 rounded-2xl bg-brand-navy/80 px-4 py-2.5 text-white shadow-lg backdrop-blur-sm sm:flex">
              <RotateCcw className="size-6" aria-hidden />
              <div className="leading-tight">
                <p className="text-xl font-extrabold">360°</p>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-white/80">
                  {spinLoadingAll ? `Loading ${progress.loaded}/${progress.total}` : "Drag to rotate"}
                </p>
              </div>
            </div>
          )}
          {mode.kind === "gallery" && spin && (
            <button
              type="button"
              data-no-drag
              onClick={() => onSelectView(boat.views.find((v) => v.action.type === "spin") ?? { id: "spin", label: "360°", icon: "spin", action: { type: "spin" } })}
              className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full bg-white/90 px-3 text-xs font-bold uppercase tracking-wide text-brand-navy shadow hover:bg-white focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
            >
              <ArrowLeft className="size-4" /> 360° view
            </button>
          )}
        </div>

        {/* Toolbar */}
        <div data-no-drag className="absolute right-2 top-2 flex flex-row gap-1.5 sm:right-5 sm:top-5 sm:flex-col sm:gap-2">
          <ToolButton label={isFs ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>
            {isFs ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
          </ToolButton>
          <ToolButton
            label="Zoom in"
            onClick={() => {
              zoomBy(1.5);
              track("zoom_used", boat.boatId, { method: "button" });
            }}
            disabled={zoom.scale >= MAX_ZOOM}
          >
            <ZoomIn className="size-5" />
          </ToolButton>
          <ToolButton label="Zoom out" onClick={() => zoomBy(1 / 1.5)} disabled={zoom.scale <= 1}>
            <ZoomOut className="size-5" />
          </ToolButton>
          {zoom.scale > 1 && (
            <ToolButton label="Reset zoom" onClick={() => setZoom(IDENTITY)}>
              <RotateCcw className="size-5" />
            </ToolButton>
          )}
        </div>

        {/* Arrows */}
        <ArrowButton
          side="left"
          label={mode.kind === "spin" ? "Rotate left (previous frame)" : "Previous photo"}
          onClick={() => step(-1)}
          disabled={mode.kind === "spin" && !loop && frame <= 1}
        />
        <ArrowButton
          side="right"
          label={mode.kind === "spin" ? "Rotate right (next frame)" : "Next photo"}
          onClick={() => step(1)}
          disabled={mode.kind === "spin" && !loop && frame >= frameCount}
        />

        {/* Bottom overlays */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-14 sm:bottom-5">
          {mode.kind === "spin" && !hasRotated && firstFrameShown && (
            <span className="flex items-center gap-2 rounded-full bg-brand-navy/80 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white shadow-lg backdrop-blur-sm motion-safe:animate-pulse">
              <RotateCcw className="size-4" aria-hidden />
              <span className="pointer-coarse:hidden">Drag to rotate</span>
              <span className="hidden pointer-coarse:inline">Swipe to rotate</span>
            </span>
          )}
          {wheelHint && (
            <span className="rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white">
              Hold Ctrl (⌘ on Mac) and scroll to zoom
            </span>
          )}
          {mode.kind === "gallery" && gallery && galleryImage && (
            <span className="max-w-full truncate rounded-full bg-brand-navy/80 px-4 py-2 text-xs font-semibold text-white backdrop-blur-sm">
              <span className="uppercase tracking-wide">{gallery.label}</span>
              {galleryImage.caption ? <span className="font-normal text-white/80"> · {galleryImage.caption}</span> : null}
              <span className="ml-2 text-white/60">
                {mode.index + 1}/{gallery.images.length}
              </span>
            </span>
          )}
        </div>

        {mode.kind === "spin" && spin?.caption && !spin.placeholder && (
          <span className="pointer-events-none absolute bottom-3 left-3 hidden max-w-[40%] rounded-md bg-brand-navy/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow backdrop-blur-sm sm:bottom-5 sm:left-5 sm:block">
            {spin.caption}
          </span>
        )}
        {mode.kind === "spin" && spin?.placeholder && (
          <span
            title={spin.placeholder.notice}
            className="pointer-events-none absolute bottom-3 left-3 hidden rounded-md bg-amber-400 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider text-amber-950 shadow sm:bottom-5 sm:left-5 sm:block"
          >
            Placeholder 360° — not photos
          </span>
        )}
        {mode.kind === "gallery" && galleryAsset?.placeholder && (
          <span className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-md bg-amber-400 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider text-amber-950 shadow">
            Placeholder — photo not yet supplied
          </span>
        )}
        {picker && (
          <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-fuchsia-600 px-2 py-1 text-[10px] font-bold uppercase text-white">
            Hotspot picker: click to copy position
          </span>
        )}

        {activeHotspot && (
          <HotspotCard
            hotspot={activeHotspot}
            galleryLabel={activeHotspot.galleryId ? galleriesById.get(activeHotspot.galleryId)?.label : undefined}
            onClose={() => setActiveHotspotId(null)}
            onOpenGallery={
              activeHotspot.galleryId ? () => openGallery(activeHotspot.galleryId!, activeHotspot.galleryImageId) : undefined
            }
            onPlayVideo={(v) => {
              setVideo(v);
              track("video_played", boat.boatId, { video_id: v.id, hotspot_id: activeHotspot.id, placeholder: Boolean(v.placeholder) });
            }}
          />
        )}
      </div>

      {/* Mobile placeholder notice (desktop shows it inside the stage). */}
      {mode.kind === "spin" && spin?.placeholder && !isFs && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 sm:hidden">{spin.placeholder.notice}</p>
      )}

      {/* ------------------------------------------------------------ CONTROLS */}
      <ViewSelector views={views} activeId={activeViewId} onSelect={onSelectView} variant={isFs ? "dark" : "light"} />

      {!isFs && detailPanel === "engine" && boat.engine && <EngineSpecPanel engine={boat.engine} />}
      {!isFs && detailPanel === "trailer" && boat.trailer && <TrailerSpecPanel trailer={boat.trailer} />}

      {!isFs && showThumbnails && (
        <ThumbnailStrip entries={thumbEntries} activeAssetId={mode.kind === "gallery" ? (galleryAsset?.id ?? null) : null} onSelect={onSelectThumb} />
      )}

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {video && <VideoModal video={video} onClose={() => setVideo(null)} />}
    </section>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-10 items-center justify-center rounded-full bg-brand-navy/70 text-white shadow-lg backdrop-blur-sm transition hover:bg-brand-navy disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function ArrowButton({
  side,
  label,
  onClick,
  disabled,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/40 bg-brand-navy/60 text-white shadow-lg backdrop-blur-sm transition hover:bg-brand-navy disabled:pointer-events-none disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none sm:size-14",
        side === "left" ? "left-2 sm:left-5" : "right-2 sm:right-5",
      )}
    >
      <Icon className="size-6 sm:size-8" />
    </button>
  );
}
