import Link from "next/link";
import { Building2, Sun, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LOCATION_TYPE_LABELS } from "@/lib/utils/status";

export const dynamic = "force-dynamic";

export default async function FacilityMapPage() {
  const supabase = await createClient();

  const [{ data: buildings }, { data: capacityByBuilding }, { data: yardLocations }, { data: stagingLocations }, { data: activeAssignments }] =
    await Promise.all([
      supabase.from("buildings").select("id, name, code").order("sort_order"),
      supabase.from("v_capacity_by_building").select("*"),
      supabase.from("storage_locations").select("id").is("building_id", null).eq("location_type", "storage_spot").eq("is_active", true),
      supabase
        .from("storage_locations")
        .select("id, location_type")
        .is("building_id", null)
        .neq("location_type", "storage_spot")
        .eq("is_active", true),
      supabase.from("location_assignments").select("storage_location_id").is("unassigned_at", null),
    ]);

  const occupiedIds = new Set((activeAssignments ?? []).map((a) => a.storage_location_id));
  const yardOccupied = (yardLocations ?? []).filter((l) => occupiedIds.has(l.id)).length;
  const stagingCounts = new Map<string, number>();
  for (const loc of stagingLocations ?? []) {
    stagingCounts.set(loc.location_type, (stagingCounts.get(loc.location_type) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facility Map</h1>
        <p className="text-sm text-muted-foreground">Select a building or area to see live occupancy.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(buildings ?? []).map((b) => {
          const cap = (capacityByBuilding ?? []).find((c) => c.building_id === b.id);
          return (
            <Link key={b.id} href={`/map/${b.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader className="flex flex-row items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-base">{b.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {cap?.occupied_spaces ?? 0}
                    <span className="text-sm font-normal text-muted-foreground"> / {cap?.total_spaces ?? 0} spaces</span>
                  </p>
                </CardContent>
              </Card>
            </Link>
          );
        })}

        <Link href="/map/yard">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sun className="h-5 w-5" />
              </div>
              <CardTitle className="text-base">Outdoor Yard</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">
                {yardOccupied}
                <span className="text-sm font-normal text-muted-foreground"> / {(yardLocations ?? []).length} spaces</span>
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Staging &amp; Service Areas</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from(stagingCounts.entries()).map(([type, count]) => (
            <Link key={type} href={`/map/staging?type=${type}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-3 py-2">
                  <Wrench className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{LOCATION_TYPE_LABELS[type] ?? type}</p>
                    <p className="text-xs text-muted-foreground">{count} location(s)</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
