import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Boat360Viewer } from "@/components/boat360/boat-360-viewer";
import { EmbedHeightReporter } from "@/components/boat360/embed-height-reporter";
import { getBoat, listBoats } from "@/lib/boats/registry";

// Chrome-free version of the viewer for embedding in other sites (the Sun
// Sport Squarespace product pages) via an iframe. See docs/boat360/SQUARESPACE.md.

export function generateStaticParams() {
  return listBoats().map((b) => ({ slug: b.slug }));
}

export async function generateMetadata({ params }: PageProps<"/embed/boats/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const boat = getBoat(slug);
  return {
    title: boat ? `${[boat.year, boat.make, boat.model].filter(Boolean).join(" ")} 360° view` : "360° view",
    robots: { index: false },
  };
}

export default async function EmbedBoatPage({ params }: PageProps<"/embed/boats/[slug]">) {
  const { slug } = await params;
  const boat = getBoat(slug);
  if (!boat) notFound();

  return (
    <div id="boat360-embed" className="bg-transparent p-1 [font-family:var(--font-geist-sans),ui-sans-serif,system-ui,sans-serif]">
      <Boat360Viewer boat={boat} thumbnailLayout="strip" />
      <EmbedHeightReporter slug={slug} targetId="boat360-embed" />
    </div>
  );
}
