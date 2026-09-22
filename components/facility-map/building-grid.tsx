"use client";

import { useMemo, useState } from "react";
import { SpotTile, type SpotWithOccupant } from "./spot-tile";
import { SpotDetailSheet, type UnassignedUnit } from "./spot-detail-sheet";
import { SPOT_STATE_CLASSES } from "@/lib/utils/status";

const LEGEND: { state: keyof typeof SPOT_STATE_CLASSES; label: string }[] = [
  { state: "available", label: "Available" },
  { state: "occupied", label: "Occupied" },
  { state: "reserved", label: "Reserved" },
  { state: "attention", label: "Needs Attention" },
  { state: "pickup_soon", label: "Pickup Soon" },
  { state: "unavailable", label: "Unavailable" },
];

export function MapLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {LEGEND.map((item) => (
        <span key={item.state} className="flex items-center gap-1.5">
          <span className={`h-3 w-3 rounded border-2 ${SPOT_STATE_CLASSES[item.state]}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function BuildingGrid({
  spots,
  buildingName,
  unassignedUnits,
}: {
  spots: SpotWithOccupant[];
  buildingName: string;
  unassignedUnits: UnassignedUnit[];
}) {
  const [selected, setSelected] = useState<SpotWithOccupant | null>(null);
  const [open, setOpen] = useState(false);

  const sections = useMemo(() => {
    const bySection = new Map<string, SpotWithOccupant[]>();
    for (const spot of spots) {
      const key = spot.section ?? "";
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(spot);
    }
    return Array.from(bySection.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [spots]);

  function openSpot(spot: SpotWithOccupant) {
    setSelected(spot);
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      {sections.map(([section, sectionSpots]) => (
        <div key={section || "misc"}>
          {section ? <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Row {section}</p> : null}
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-[repeat(15,minmax(0,1fr))]">
            {sectionSpots.map((spot) => (
              <SpotTile key={spot.id} spot={spot} onClick={() => openSpot(spot)} />
            ))}
          </div>
        </div>
      ))}
      <SpotDetailSheet
        spot={selected}
        locationLabel={selected ? `${buildingName} · ${selected.full_code}` : ""}
        unassignedUnits={unassignedUnits}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
