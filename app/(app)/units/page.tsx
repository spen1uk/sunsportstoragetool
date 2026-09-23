import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UnitStatusBadge } from "@/components/units/unit-status-badge";
import { UNIT_TYPE_LABELS } from "@/lib/utils/status";

export const dynamic = "force-dynamic";

export default async function UnitsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  const [{ data: units }, { data: activeAssignments }] = await Promise.all([
    supabase
      .from("units")
      .select(
        "id, internal_storage_id, year, make, model, unit_type, status_code, customers(first_name, last_name), unit_statuses(label, color, icon)",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("location_assignments")
      .select("unit_id, storage_locations(full_code, buildings(name))")
      .is("unassigned_at", null),
  ]);

  const locationByUnit = new Map(
    (activeAssignments ?? []).map((a) => {
      const loc = a.storage_locations as unknown as { full_code: string; buildings: { name: string } | null } | null;
      const label = loc ? [loc.buildings?.name, loc.full_code].filter(Boolean).join(" · ") : null;
      return [a.unit_id, label];
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stored Units</h1>
          <p className="text-sm text-muted-foreground">{units?.length ?? 0} units on file.</p>
        </div>
        {profile && canManage(profile.role) ? (
          <Button nativeButton={false} render={<Link href="/units/new" />}>
            <Plus className="h-4 w-4" />
            New Unit
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {(units ?? []).map((u) => {
              const customer = u.customers as unknown as { first_name: string; last_name: string } | null;
              const status = u.unit_statuses as unknown as { label: string; color: string; icon: string } | null;
              return (
                <li key={u.id}>
                  <Link href={`/units/${u.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {u.year} {u.make} {u.model}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          ({UNIT_TYPE_LABELS[u.unit_type] ?? u.unit_type})
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {customer ? `${customer.first_name} ${customer.last_name}` : "—"} · {u.internal_storage_id}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="hidden sm:inline text-xs text-muted-foreground">
                        {locationByUnit.get(u.id) ?? "No location"}
                      </span>
                      {status ? <UnitStatusBadge label={status.label} color={status.color} icon={status.icon} /> : null}
                    </div>
                  </Link>
                </li>
              );
            })}
            {(units ?? []).length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">No units yet.</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
