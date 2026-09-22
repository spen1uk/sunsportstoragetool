import Link from "next/link";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkPickedUpButton } from "@/components/units/mark-picked-up-button";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  ready: "Ready",
  completed: "Completed",
};

export default async function PickupsPage() {
  const supabase = await createClient();

  const { data: pickups } = await supabase
    .from("pickups")
    .select(
      `id, requested_pickup_date, status,
       units(id, internal_storage_id, year, make, model, customers(first_name, last_name))`,
    )
    .neq("status", "completed")
    .order("requested_pickup_date", { ascending: true, nullsFirst: false });

  const unitIds = (pickups ?? [])
    .map((p) => (p.units as unknown as { id: string } | null)?.id)
    .filter((id): id is string => Boolean(id));

  const [{ data: activeAssignments }, { data: pendingServices }] = await Promise.all([
    unitIds.length
      ? supabase
          .from("location_assignments")
          .select("unit_id, storage_locations(full_code, buildings(name))")
          .in("unit_id", unitIds)
          .is("unassigned_at", null)
      : Promise.resolve({ data: [] }),
    unitIds.length
      ? supabase.from("unit_services").select("unit_id, status").in("unit_id", unitIds).neq("status", "complete")
      : Promise.resolve({ data: [] }),
  ]);

  const locationByUnit = new Map(
    (activeAssignments ?? []).map((a) => {
      const loc = a.storage_locations as unknown as { full_code: string; buildings: { name: string } | null } | null;
      return [a.unit_id, loc ? [loc.buildings?.name, loc.full_code].filter(Boolean).join(" · ") : null];
    }),
  );
  const pendingServiceCount = new Map<string, number>();
  for (const s of pendingServices ?? []) {
    pendingServiceCount.set(s.unit_id, (pendingServiceCount.get(s.unit_id) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Spring Pull / Pickup Queue</h1>
        <p className="text-sm text-muted-foreground">Sorted by requested pickup date — earliest first.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          {(pickups ?? []).length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">Nothing in the pickup queue.</p>
          ) : (
            <ul className="divide-y">
              {(pickups ?? []).map((p) => {
                const unit = p.units as unknown as {
                  id: string;
                  internal_storage_id: string;
                  year: number | null;
                  make: string | null;
                  model: string | null;
                  customers: { first_name: string; last_name: string } | null;
                } | null;
                if (!unit) return null;
                const remaining = pendingServiceCount.get(unit.id) ?? 0;

                return (
                  <li key={p.id} className="flex items-center justify-between gap-4 px-6 py-4">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-muted-foreground">
                        {p.requested_pickup_date ? format(new Date(p.requested_pickup_date), "MMMM d") : "No date"}
                      </p>
                      <Link href={`/units/${unit.id}`} className="text-sm font-medium hover:underline">
                        {unit.customers ? `${unit.customers.first_name} ${unit.customers.last_name}` : "—"} —{" "}
                        {unit.year} {unit.make} {unit.model}
                      </Link>
                      <p className="text-xs text-muted-foreground">{locationByUnit.get(unit.id) ?? "No location"}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {remaining > 0 ? (
                        <Badge variant="outline" className="border-orange-300 bg-orange-50 text-orange-800 dark:bg-orange-950 dark:text-orange-200">
                          {remaining} service(s) remaining
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-purple-300 bg-purple-50 text-purple-800 dark:bg-purple-950 dark:text-purple-200">
                          {STATUS_LABEL[p.status]}
                        </Badge>
                      )}
                      <MarkPickedUpButton unitId={unit.id} />
                    </div>
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
