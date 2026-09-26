"use client";

import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { assetThumb } from "@/lib/boat360/frames";
import type { MediaAsset } from "@/lib/boat360/types";

export interface ThumbEntry {
  key: string;
  galleryId: string;
  index: number;
  label: string;
  asset: MediaAsset;
}

/**
 * Photo thumbnails. Only the small `thumb` tier is requested, and lazily, so
 * the gallery costs nothing until it scrolls into view.
 */
export const ThumbnailStrip = memo(function ThumbnailStrip({
  entries,
  activeAssetId,
  onSelect,
  layout = "grid",
}: {
  entries: ThumbEntry[];
  activeAssetId: string | null;
  onSelect: (entry: ThumbEntry) => void;
  /** "grid" wraps on wider screens; "strip" is always one scrolling row (compact embeds). */
  layout?: "grid" | "strip";
}) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!activeAssetId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-asset="${activeAssetId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeAssetId]);

  return (
    <div className="-mx-4 px-4 sm:mx-0 sm:px-0">
      <ul
        ref={listRef}
        aria-label="Photo gallery"
        className={cn(
          "flex snap-x gap-2 overflow-x-auto pb-2 [scrollbar-width:thin]",
          layout === "grid" && "sm:grid sm:grid-cols-4 sm:overflow-visible md:grid-cols-6 lg:grid-cols-8",
        )}
      >
        {entries.map((entry) => {
          const active = entry.asset.id === activeAssetId;
          return (
            <li key={entry.key} className={cn("w-32 shrink-0 snap-start", layout === "grid" ? "sm:w-auto" : "sm:w-40")} data-asset={entry.asset.id}>
              <button
                type="button"
                onClick={() => onSelect(entry)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "group relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-slate-200 outline-none ring-offset-2 transition focus-visible:ring-2 focus-visible:ring-brand-blue",
                  active ? "ring-2 ring-brand-blue" : "hover:opacity-90",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- pre-optimized tier, see scripts/boat360 */}
                <img
                  src={assetThumb(entry.asset)}
                  alt={entry.asset.alt}
                  loading="lazy"
                  decoding="async"
                  width={400}
                  height={300}
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                {entry.asset.placeholder && (
                  <span className="absolute left-1.5 top-1.5 rounded bg-slate-900/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                    Placeholder
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-brand-navy/95 to-brand-navy/0 px-2 pb-1.5 pt-5 text-left text-[10px] font-bold uppercase tracking-wide text-white">
                  {entry.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
