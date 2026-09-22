import Link from "next/link";
import { format } from "date-fns";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoveUnitDialog, type AvailableLocation } from "@/components/units/move-unit-dialog";
import { UNIT_TYPE_LABELS } from "@/lib/utils/status";
import { RealtimeRefresher } from "@/components/realtime/realtime-refresher";

export const dynamic = "force-dynamic";

export default async function ArrivalsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  const [{ data: scheduled }, { data: unassigned }, { data: allLocations }, { data: activeAssignments }] = await Promise.all([
    supabase
      .from("units")
      .select("id, internal_storage_id, year, make, model, unit_type, arrival_date, customers(first_name, last_name)")
      .eq("status_code", "scheduled_for_arrival")
      .is("deleted_at", null)
      .order("arrival_date", { ascending: true }),
    supabase
      .from("units")
      .select("id, internal_storage_id, year, make, model, unit_type, length_ft, customers(first_name, last_name)")
      .in("status_code", ["arrived", "needs_location"])
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("storage_locations")
      .select("id, full_code, location_type, storage_type, admin_status, is_active, buildings(name)")
      .eq("is_active", true)
      .neq("admin_status", "unavailable"),
    supabase.from("location_assignments").select("storage_location_id").is("unassigned_at", null),
  ]);

  const occupiedIds = new Set((activeAssignments ?? []).map((a) => a.storage_location_id));
  const availableLocations: AvailableLocation[] = (allLocations ?? [])
    .filter((loc) => !occupiedIds.has(loc.id))
    .map((loc) => ({
      id: loc.id,
      full_code: loc.full_code,
      building_name: (loc.buildings as unknown as { name: string } | null)?.name ?? null,
      location_type: loc.location_type,
      storage_type: loc.storage_type,
    }));

  return (
    <div className="space-y-6">
      <RealtimeRefresher tables={["units", "location_assignments"]} />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Arrivals</h1>
          <p className="text-sm text-muted-foreground">Boats scheduled to arrive, and boats on-site awaiting a permanent spot.</p>
        </div>
        {profile && canManage(profile.role) ? (
          <Button render={<Link href="/arrivals/intake" />}>
            <Plus className="h-4 w-4" />
            Create Intake
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unassigned Queue ({unassigned?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(unassigned ?? []).length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">Nothing waiting on a location right now.</p>
          ) : (
            <ul className="divide-y">
              {(unassigned ?? []).map((u) => {
                const customer = u.customers as unknown as { first_name: string; last_name: string } | null;
                const label = `${u.year ?? ""} ${u.make ?? ""} ${u.model ?? ""}`.trim();
                return (
                  <li key={u.id} className="flex items-center justify-between gap-4 px-6 py-3">
                    <div className="min-w-0">
                      <Link href={`/units/${u.id}`} className="text-sm font-medium hover:underline">
                        {label} {u.length_ft ? <span className="text-muted-foreground">· {u.length_ft}&apos;</span> : null}
                      </Link>
                      <p className="text-xs text-muted-foreground truncate">
                        {customer ? `${customer.first_name} ${customer.last_name}` : "—"} · {u.internal_storage_id} ·{" "}
                        {UNIT_TYPE_LABELS[u.unit_type] ?? u.unit_type}
                      </p>
                    </div>
                    <MoveUnitDialog
                      unitId={u.id}
                      unitLabel={label}
                      currentLocationLabel={null}
                      availableLocations={availableLocations}
                      triggerLabel="Assign Location"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Arriving Soon ({scheduled?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(scheduled ?? []).length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">No scheduled arrivals.</p>
          ) : (
            <ul className="divide-y">
              {(scheduled ?? []).map((u) => {
                const customer = u.customers as unknown as { first_name: string; last_name: string } | null;
                return (
                  <li key={u.id}>
                    <Link href={`/units/${u.id}`} className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-accent">
                      <div>
                        <p className="text-sm font-medium">
                          {u.year} {u.make} {u.model}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {customer ? `${customer.first_name} ${customer.last_name}` : "—"} · {u.internal_storage_id}
                        </p>
                      </div>
                      <span className="text-xs font-medium text-muted-foreground">
                        {u.arrival_date ? format(new Date(u.arrival_date), "MMM d, yyyy") : "No date set"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
