"use client";

import { memo } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Hotspot } from "@/lib/boat360/types";
import { CATEGORY_LABEL } from "./view-icons";

/**
 * A single tappable hotspot. Positioned in stage pixels by the parent (which
 * already applied zoom/pan), so the marker itself never scales and always
 * stays a comfortable 44px touch target.
 */
export const HotspotMarker = memo(function HotspotMarker({
  hotspot,
  x,
  y,
  active,
  dimmed,
  showLabel,
  onSelect,
}: {
  hotspot: Hotspot;
  x: number;
  y: number;
  active: boolean;
  dimmed: boolean;
  showLabel: boolean;
  onSelect: (id: string) => void;
}) {
  const condition = hotspot.category === "condition";
  return (
    <button
      type="button"
      onClick={() => onSelect(hotspot.id)}
      aria-label={`${condition ? "Condition note" : "Feature"}: ${hotspot.title}`}
      aria-pressed={active}
      className={cn(
        "group absolute z-10 flex -translate-x-[22px] -translate-y-1/2 items-center gap-2 rounded-full outline-none transition-opacity duration-150",
        dimmed ? "opacity-60" : "opacity-100",
      )}
      style={{ left: x, top: y }}
    >
      <span className="relative flex size-11 items-center justify-center">
        {!active && (
          <span
            className={cn(
              "absolute inset-1.5 rounded-full motion-safe:animate-ping",
              condition ? "bg-amber-400/40" : "bg-white/40",
            )}
          />
        )}
        <span
          className={cn(
            "relative flex size-8 items-center justify-center rounded-full border-2 shadow-lg ring-offset-2 transition-transform group-hover:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-sky-400",
            condition ? "border-amber-100 bg-amber-500 text-white" : "border-white bg-brand-navy text-white",
            active && "scale-110 bg-brand-blue",
          )}
        >
          {condition ? <TriangleAlert className="size-4" /> : <Plus className="size-4" strokeWidth={3} />}
        </span>
      </span>
      {showLabel && (
        <span className="pointer-events-none -ml-1 whitespace-nowrap rounded-full bg-brand-navy/85 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow backdrop-blur-sm">
          {CATEGORY_LABEL[hotspot.category]}
        </span>
      )}
    </button>
  );
});

