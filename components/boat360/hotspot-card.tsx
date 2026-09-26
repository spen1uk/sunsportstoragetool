"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, Play, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Hotspot, VideoRef } from "@/lib/boat360/types";
import { CATEGORY_LABEL } from "./view-icons";

const CONDITION_LABEL: Record<NonNullable<Hotspot["conditionType"]>, string> = {
  scratch: "Scratch",
  dent: "Dent",
  "upholstery-wear": "Upholstery wear",
  "dock-rash": "Dock rash",
  "prop-damage": "Prop damage",
  "trailer-damage": "Trailer damage",
  oxidation: "Oxidation / staining",
  other: "Cosmetic",
};

/**
 * Hotspot information card. Rendered inside the viewer (not a portal) so it
 * keeps working in element fullscreen. Desktop: floating card in the stage's
 * top-right. Mobile: bottom sheet that slides up.
 */
export function HotspotCard({
  hotspot,
  galleryLabel,
  onClose,
  onOpenGallery,
  onPlayVideo,
}: {
  hotspot: Hotspot;
  galleryLabel?: string;
  onClose: () => void;
  onOpenGallery?: () => void;
  onPlayVideo: (video: VideoRef) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const condition = hotspot.category === "condition";

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [hotspot.id]);

  return (
    <>
      <div data-no-drag className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} aria-hidden />
      <div
        data-no-drag
        role="dialog"
        aria-modal="false"
        aria-labelledby={`hotspot-${hotspot.id}-title`}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 max-h-[75svh] overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-slate-900 shadow-2xl",
          "motion-safe:animate-in motion-safe:slide-in-from-bottom motion-safe:duration-200",
          "md:absolute md:inset-x-auto md:bottom-auto md:right-4 md:top-4 md:w-[22rem] md:rounded-2xl md:pb-5 md:motion-safe:slide-in-from-right-4 md:motion-safe:slide-in-from-bottom-0",
        )}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-300 md:hidden" aria-hidden />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider",
                condition ? "text-amber-600" : "text-brand-blue",
              )}
            >
              {condition && <TriangleAlert className="size-3.5" />}
              {condition && hotspot.conditionType ? `Condition · ${CONDITION_LABEL[hotspot.conditionType]}` : CATEGORY_LABEL[hotspot.category]}
            </p>
            <h3 id={`hotspot-${hotspot.id}-title`} className="text-lg font-bold uppercase leading-tight tracking-tight text-brand-navy">
              {hotspot.title}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {hotspot.bullets && hotspot.bullets.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-slate-700">
            {hotspot.bullets.map((b) => (
              <li key={b} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-blue" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        )}
        {hotspot.description && <p className="mt-3 text-sm leading-relaxed text-slate-600">{hotspot.description}</p>}
        {hotspot.needsReview && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Observation from photos — pending Sun Sport inspection notes.
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {hotspot.videos?.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onPlayVideo(v)}
              className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-brand-navy hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
            >
              <span className="flex items-center gap-2">
                <Play className="size-4 fill-current" /> Watch {v.title.toLowerCase()}
              </span>
              {v.placeholder && <span className="text-[10px] font-medium uppercase text-slate-400">Coming soon</span>}
            </button>
          ))}
          {onOpenGallery && (
            <button
              type="button"
              onClick={onOpenGallery}
              className="flex items-center justify-between rounded-xl bg-brand-navy px-4 py-3 text-sm font-semibold uppercase tracking-wide text-white hover:bg-brand-navy/90 focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              View {galleryLabel ? `${galleryLabel} ` : ""}photos
              <ArrowRight className="size-4" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
