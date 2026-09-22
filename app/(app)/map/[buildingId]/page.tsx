import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { BuildingGrid, MapLegend } from "@/components/facility-map/building-grid";
import type { SpotWithOccupant } from "@/components/facility-map/spot-tile";
import type { LocationType } from "@/lib/types/database";
import { RealtimeRefresher } from "@/components/realtime/realtime-refresher";

export const dynamic = "force-dynamic";

export default async function BuildingMapPage({
  params,
  searchParams,
}: {
  params: Promise<{ buildingId: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { buildingId } = await params;
  const { type } = await searchParams;
  const supabase = await createClient();

  let buildingName: string;
  let locationsQuery = supabase
    .from("storage_locations")
    .select("id, full_code, section, spot_number, location_type, admin_status, max_length_ft, max_width_ft")
    .eq("is_active", true)
    .order("sort_order");

  if (buildingId === "yard") {
    buildingName = "Outdoor Yard";
    locationsQuery = locationsQuery.is("building_id", null).eq("location_type", "storage_spot");
  } else if (buildingId === "staging") {
    buildingName = "Staging & Service Areas";
    locationsQuery = locationsQuery.is("building_id", null).neq("location_type", "storage_spot");
    if (type) locationsQuery = locationsQuery.eq("location_type", type as LocationType);
  } else {
    const { data: building } = await supabase.from("buildings").select("id, name").eq("id", buildingId).single();
    if (!building) notFound();
    buildingName = building.name;
    locationsQuery = locationsQuery.eq("building_id", buildingId);
  }

  const [{ data: locations }, { data: activeAssignments }] = await Promise.all([
    locationsQuery,
    supabase
      .from("location_assignments")
      .select(
        "storage_location_id, units(id, year, make, model, status_code, customers(first_name, last_name))",
      )
      .is("unassigned_at", null),
  ]);

  const occupantByLocation = new Map(
    (activeAssignments ?? [])
      .filter((a) => a.units)
      .map((a) => {
        const unit = a.units as unknown as {
          id: string;
          year: number | null;
          make: string | null;
          model: string | null;
          status_code: string;
          customers: { first_name: string; last_name: string } | null;
        };
        return [
          a.storage_location_id,
          {
            unit_id: unit.id,
            label: `${unit.year ?? ""} ${unit.make ?? ""} ${unit.model ?? ""}`.trim(),
            customer_name: unit.customers ? `${unit.customers.first_name} ${unit.customers.last_name}` : "—",
            status_code: unit.status_code,
          },
        ];
      }),
  );

  const spots: SpotWithOccupant[] = (locations ?? []).map((loc) => ({
    id: loc.id,
    full_code: loc.full_code,
    section: loc.section,
    admin_status: loc.admin_status,
    max_length_ft: loc.max_length_ft,
    max_width_ft: loc.max_width_ft,
    occupant: occupantByLocation.get(loc.id) ?? null,
  }));

  const { data: unassignedUnitsRaw } = await supabase
    .from("units")
    .select("id, year, make, model, customers(first_name, last_name)")
    .in("status_code", ["arrived", "needs_location"])
    .is("deleted_at", null);

  const unassignedUnits = (unassignedUnitsRaw ?? []).map((u) => {
    const customer = u.customers as unknown as { first_name: string; last_name: string } | null;
    return {
      id: u.id,
      label: `${u.year ?? ""} ${u.make ?? ""} ${u.model ?? ""}`.trim(),
      customer_name: customer ? `${customer.first_name} ${customer.last_name}` : "—",
    };
  });

  return (
    <div className="space-y-4">
      <RealtimeRefresher tables={["units", "location_assignments", "storage_locations"]} />
      <Link href="/map" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" />
        All buildings
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{buildingName}</h1>
        <MapLegend />
      </div>
      {spots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No locations here yet.</p>
      ) : (
        <BuildingGrid spots={spots} buildingName={buildingName} unassignedUnits={unassignedUnits} />
      )}
    </div>
  );
}
