// Boat lookup for the public 360° listing pages.
//
// Phase 1: boats are static config modules. Phase 2 replaces the body of
// these functions with Supabase queries against boats / boat_360_sets /
// boat_hotspots … (see docs/boat360/schema.sql) that assemble the same
// BoatViewerConfig — no viewer changes required.

import type { BoatViewerConfig } from "@/lib/boat360/types";
import { validateBoatConfig } from "@/lib/boat360/validate";
import harrisKayot220Classic from "./data/harris-kayot-220-classic";

const BOATS: BoatViewerConfig[] = [harrisKayot220Classic];

export function listBoats(): BoatViewerConfig[] {
  return BOATS;
}

export function getBoat(slug: string): BoatViewerConfig | null {
  const boat = BOATS.find((b) => b.slug === slug) ?? null;
  if (boat && process.env.NODE_ENV !== "production") {
    for (const problem of validateBoatConfig(boat)) console.warn(`[boat360:${slug}] ${problem}`);
  }
  return boat;
}
