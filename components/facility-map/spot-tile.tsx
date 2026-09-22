"use client";

import { cn } from "@/lib/utils";
import { SPOT_STATE_CLASSES, getSpotVisualState } from "@/lib/utils/status";
import { AlertOctagon, CheckCircle2, Clock, Lock, ShipWheel } from "lucide-react";

export type SpotWithOccupant = {
  id: string;
  full_code: string;
  section: string | null;
  admin_status: "available" | "reserved" | "unavailable";
  max_length_ft: number | null;
  max_width_ft: number | null;
  occupant: {
    unit_id: string;
    label: string;
    customer_name: string;
    status_code: string;
  } | null;
};

const STATE_ICON = {
  available: null,
  occupied: ShipWheel,
  reserved: Clock,
  attention: AlertOctagon,
  pickup_soon: CheckCircle2,
  unavailable: Lock,
};

export function SpotTile({ spot, onClick }: { spot: SpotWithOccupant; onClick: () => void }) {
  const state = getSpotVisualState({
    adminStatus: spot.admin_status,
    occupantStatusCode: spot.occupant?.status_code ?? null,
  });
  const Icon = STATE_ICON[state];

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex aspect-square w-full flex-col items-center justify-center gap-0.5 rounded-md border-2 px-1 text-center transition-transform hover:scale-[1.03] hover:shadow-sm",
        SPOT_STATE_CLASSES[state],
      )}
      title={spot.occupant ? `${spot.full_code}: ${spot.occupant.label} (${spot.occupant.customer_name})` : spot.full_code}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      <span className="text-[11px] font-semibold leading-tight">{spot.full_code}</span>
    </button>
  );
}
