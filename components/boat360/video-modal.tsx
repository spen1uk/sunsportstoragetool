"use client";

import { useEffect, useRef } from "react";
import { Video, X } from "lucide-react";
import type { VideoRef } from "@/lib/boat360/types";

/** Video player overlay. Lives inside the viewer so it works in fullscreen. */
export function VideoModal({ video, onClose }: { video: VideoRef; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-no-drag
      role="dialog"
      aria-modal="true"
      aria-label={video.title}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 motion-safe:animate-in motion-safe:fade-in"
      onClick={onClose}
    >
      <div className="relative w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between text-white">
          <h3 className="text-sm font-semibold uppercase tracking-wide">{video.title}</h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close video"
            className="flex size-10 items-center justify-center rounded-full hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="aspect-video overflow-hidden rounded-xl bg-black">
          {video.placeholder || !(video.src || video.sources?.length) ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-300">
              <Video className="size-10" />
              <p className="text-base font-semibold text-white">Video coming soon</p>
              <p className="max-w-sm text-sm">This video hasn&apos;t been recorded yet. Contact Sun Sport Marine to request it.</p>
            </div>
          ) : video.kind === "embed" ? (
            <iframe
              src={video.src}
              title={video.title}
              className="size-full"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            <video poster={video.poster} controls autoPlay playsInline preload="metadata" className="size-full">
              {video.sources?.map((s) => <source key={s.src} src={s.src} type={s.type} />)}
              {!video.sources?.length && video.src && <source src={video.src} />}
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
