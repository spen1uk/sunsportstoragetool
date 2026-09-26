"use client";

import { Calculator, Handshake, Info, Phone } from "lucide-react";
import { track, type Boat360EventName } from "@/lib/boat360/analytics";
import type { BoatViewerConfig } from "@/lib/boat360/types";

/**
 * Optional listing summary + calls to action. Deliberately separate from the
 * viewer so pages decide where (or whether) it goes.
 */
export function BoatInfoPanel({ boat }: { boat: BoatViewerConfig }) {
  const links = boat.links ?? {};
  const ctas: { label: string; href?: string; icon: typeof Info; event: Boat360EventName; primary?: boolean }[] = [
    { label: "View details", href: links.details, icon: Info, event: "details_clicked" },
    { label: "Financing", href: links.financing, icon: Calculator, event: "financing_clicked" },
    { label: "Trade-in", href: links.tradeIn, icon: Handshake, event: "trade_clicked" },
    { label: "Contact Sun Sport", href: links.contact, icon: Phone, event: "contact_clicked", primary: true },
  ];

  return (
    <section aria-label="Boat summary" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-bold tracking-tight text-brand-navy sm:text-2xl">
        {[boat.year, boat.make, boat.model].filter(Boolean).join(" ")}
      </h2>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {boat.highlights.map((h) => (
          <div key={h.label} className="flex gap-1.5">
            <dt className="text-slate-500">{h.label}</dt>
            <dd className="font-semibold text-slate-900">{h.value ?? "TBC"}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {ctas
          .filter((c) => c.href)
          .map((c) => (
            <a
              key={c.label}
              href={c.href}
              onClick={() => track(c.event, boat.boatId)}
              className={
                c.primary
                  ? "col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-blue px-5 text-sm font-semibold uppercase tracking-wide text-white hover:bg-brand-blue/90 focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2 focus-visible:outline-none sm:col-span-1"
                  : "flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-semibold uppercase tracking-wide text-brand-navy hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
              }
            >
              <c.icon className="size-4" aria-hidden />
              {c.label}
            </a>
          ))}
      </div>
    </section>
  );
}
