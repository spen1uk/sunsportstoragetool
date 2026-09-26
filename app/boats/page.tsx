import type { Metadata } from "next";
import Link from "next/link";
import { Rotate3d } from "lucide-react";
import { assetThumb } from "@/lib/boat360/frames";
import { listBoats } from "@/lib/boats/registry";

export const metadata: Metadata = {
  title: "Pre-owned boats | Sun Sport Marine",
  description: "Browse Sun Sport Marine's pre-owned boats in interactive 360°.",
};

export default function BoatsIndexPage() {
  const boats = listBoats();
  return (
    <div className="min-h-screen bg-slate-50 [font-family:var(--font-geist-sans),ui-sans-serif,system-ui,sans-serif]">
      <header className="bg-brand-navy text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4 text-sm font-extrabold uppercase tracking-[0.2em]">Sun Sport Marine</div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <h1 className="mb-4 text-2xl font-bold tracking-tight text-brand-navy">Pre-owned inventory</h1>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boats.map((boat) => {
            const cover = boat.assets[boat.galleries[0]?.images[0]?.assetId ?? ""];
            return (
              <li key={boat.slug}>
                <Link
                  href={`/boats/${boat.slug}`}
                  className="group block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
                >
                  <div className="relative aspect-[4/3] bg-slate-200">
                    {cover && (
                      // eslint-disable-next-line @next/next/no-img-element -- pre-optimized tier
                      <img src={assetThumb(cover)} alt={cover.alt} className="size-full object-cover" loading="lazy" />
                    )}
                    {boat.spin && (
                      <span className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-brand-navy/85 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                        <Rotate3d className="size-3.5" /> 360°
                      </span>
                    )}
                  </div>
                  <div className="p-4">
                    <p className="font-bold text-brand-navy">{[boat.year, boat.make, boat.model].filter(Boolean).join(" ")}</p>
                    <p className="text-sm text-slate-500">{boat.highlights.map((h) => h.value).filter(Boolean).join(" · ")}</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
