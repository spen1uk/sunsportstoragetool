"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import type { ViewButton } from "@/lib/boat360/types";
import { VIEW_ICONS } from "./view-icons";

/** 360° VIEW / FRONT / REAR / … buttons. Horizontally scrollable on mobile. */
export const ViewSelector = memo(function ViewSelector({
  views,
  activeId,
  onSelect,
  variant = "light",
}: {
  views: ViewButton[];
  activeId: string | null;
  onSelect: (view: ViewButton) => void;
  variant?: "light" | "dark";
}) {
  return (
    <nav aria-label="Boat views" className="-mx-4 px-4 sm:mx-0 sm:px-0">
      <ul className="flex snap-x gap-2 overflow-x-auto py-1 [scrollbar-width:none] sm:flex-wrap sm:justify-center [&::-webkit-scrollbar]:hidden">
        {views.map((view) => {
          const Icon = VIEW_ICONS[view.icon];
          const active = view.id === activeId;
          return (
            <li key={view.id} className="snap-start">
              <button
                type="button"
                onClick={() => onSelect(view)}
                aria-pressed={active}
                className={cn(
                  "flex h-10 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-xs font-semibold uppercase tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2 focus-visible:outline-none",
                  active
                    ? variant === "dark"
                      ? "border-white bg-white text-brand-navy shadow"
                      : "border-brand-navy bg-brand-navy text-white shadow"
                    : variant === "dark"
                      ? "border-white/15 bg-white/10 text-white hover:bg-white/20"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {view.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
