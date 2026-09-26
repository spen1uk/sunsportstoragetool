// Referential checks for a BoatViewerConfig. Cheap enough to run on every
// dev request; Phase 2's admin "Generate 360 view" step runs it before
// publishing so broken references never reach customers.

import type { BoatViewerConfig } from "./types";

export function validateBoatConfig(boat: BoatViewerConfig): string[] {
  const problems: string[] = [];
  const galleries = new Map(boat.galleries.map((g) => [g.id, g]));
  const hotspotIds = new Set(boat.hotspots.map((h) => h.id));
  const count = boat.spin?.frameCount ?? 0;
  const inRange = (f: number) => Number.isInteger(f) && f >= 1 && f <= count;

  if (boat.spin) {
    if (boat.spin.frameCount < 24) problems.push(`Spin has ${boat.spin.frameCount} frames; 24 minimum recommended.`);
    for (const [name, f] of Object.entries(boat.spin.angles)) if (f != null && !inRange(f)) problems.push(`Angle "${name}" → frame ${f} is out of range.`);
    if (!inRange(boat.spin.initialFrame)) problems.push(`initialFrame ${boat.spin.initialFrame} is out of range.`);
  }

  for (const g of boat.galleries) {
    for (const img of g.images) {
      if (!boat.assets[img.assetId]) problems.push(`Gallery "${g.id}" image "${img.id}" references missing asset "${img.assetId}".`);
      for (const p of img.hotspots ?? []) {
        if (!hotspotIds.has(p.hotspotId)) problems.push(`Gallery "${g.id}" image "${img.id}" pins unknown hotspot "${p.hotspotId}".`);
      }
    }
  }

  for (const h of boat.hotspots) {
    if (h.galleryId && !galleries.has(h.galleryId)) problems.push(`Hotspot "${h.id}" links to missing gallery "${h.galleryId}".`);
    if (h.galleryId && h.galleryImageId && !galleries.get(h.galleryId)?.images.some((i) => i.id === h.galleryImageId)) {
      problems.push(`Hotspot "${h.id}" links to missing image "${h.galleryImageId}".`);
    }
    for (const f of h.visibleFrames ?? []) if (!inRange(f)) problems.push(`Hotspot "${h.id}" visible on out-of-range frame ${f}.`);
    for (const key of Object.keys(h.positions ?? {})) if (!inRange(Number(key))) problems.push(`Hotspot "${h.id}" has a position for out-of-range frame ${key}.`);
  }

  for (const v of boat.views) {
    if (v.action.type === "gallery" && !galleries.has(v.action.galleryId)) problems.push(`View "${v.id}" opens missing gallery "${v.action.galleryId}".`);
    if (v.action.type === "video" && !boat.videos?.some((x) => x.id === (v.action as { videoId: string }).videoId)) {
      problems.push(`View "${v.id}" plays missing video.`);
    }
    if (v.action.type === "angle" && boat.spin?.angles[v.action.angle] == null) {
      problems.push(`View "${v.id}" needs a spin with a "${v.action.angle}" angle.`);
    }
  }
  return problems;
}
