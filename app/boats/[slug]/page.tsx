import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Boat360Viewer } from "@/components/boat360/boat-360-viewer";
import { BoatInfoPanel } from "@/components/boat360/boat-info-panel";
import { EngineSpecPanel, TrailerSpecPanel } from "@/components/boat360/spec-panels";
import { getBoat, listBoats } from "@/lib/boats/registry";

export function generateStaticParams() {
  return listBoats().map((b) => ({ slug: b.slug }));
}

export async function generateMetadata({ params }: PageProps<"/boats/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const boat = getBoat(slug);
  if (!boat) return {};
  const name = [boat.year, boat.make, boat.model].filter(Boolean).join(" ");
  const cover = boat.assets[boat.galleries[0]?.images[0]?.assetId ?? ""];
  return {
    title: `${name} | Sun Sport Marine`,
    description: `Explore the ${name} in an interactive 360° view with detailed photos of the engine, helm, interior and trailer.`,
    openGraph: cover ? { images: [(cover.tiers.find((t) => t.name === "md") ?? cover.tiers[0]).webp] } : undefined,
  };
}

export default async function BoatListingPage({ params }: PageProps<"/boats/[slug]">) {
  const { slug } = await params;
  const boat = getBoat(slug);
  if (!boat) notFound();

  return (
    <div className="min-h-screen bg-slate-50 [font-family:var(--font-geist-sans),ui-sans-serif,system-ui,sans-serif]">
      <header className="border-b border-white/10 bg-brand-navy text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <Link href="/boats" className="text-sm font-extrabold uppercase tracking-[0.2em]">
            Sun Sport Marine
          </Link>
          <span className="text-xs font-medium uppercase tracking-wider text-white/70">Pre-owned inventory</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-4 sm:py-6">
        <Boat360Viewer boat={boat} />
        <BoatInfoPanel boat={boat} />

        <section id="boat-details" aria-labelledby="details-heading" className="scroll-mt-4 space-y-3">
          <h2 id="details-heading" className="text-lg font-bold uppercase tracking-wide text-brand-navy">
            Details
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {boat.engine && <EngineSpecPanel engine={boat.engine} />}
            {boat.trailer && <TrailerSpecPanel trailer={boat.trailer} />}
          </div>
        </section>

        <section id="contact" aria-labelledby="contact-heading" className="scroll-mt-4 rounded-2xl bg-brand-navy p-5 text-white">
          <h2 id="contact-heading" className="text-lg font-bold uppercase tracking-wide">
            Interested in this boat?
          </h2>
          <p className="mt-1 text-sm text-white/75">
            Contact Sun Sport Marine about availability, financing, or trading in your current boat.
          </p>
          <span id="financing" />
          <span id="trade-in" />
        </section>
      </main>
    </div>
  );
}
