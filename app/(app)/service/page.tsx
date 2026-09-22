import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CompleteServiceButton } from "@/components/units/complete-service-button";
import { RealtimeRefresher } from "@/components/realtime/realtime-refresher";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  in_progress: "In Progress",
};

export default async function ServicePage() {
  const supabase = await createClient();

  const { data: services } = await supabase
    .from("unit_services")
    .select(
      `id, status, requested_at,
       service_types(name),
       units(id, internal_storage_id, year, make, model, customers(first_name, last_name))`,
    )
    .neq("status", "complete")
    .order("requested_at", { ascending: true });

  return (
    <div className="space-y-6">
      <RealtimeRefresher tables={["unit_services"]} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Service</h1>
        <p className="text-sm text-muted-foreground">Requested, scheduled, and in-progress service work.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open Services ({services?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(services ?? []).length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">No open service requests.</p>
          ) : (
            <ul className="divide-y">
              {(services ?? []).map((s) => {
                const unit = s.units as unknown as {
                  id: string;
                  internal_storage_id: string;
                  year: number | null;
                  make: string | null;
                  model: string | null;
                  customers: { first_name: string; last_name: string } | null;
                } | null;
                if (!unit) return null;
                return (
                  <li key={s.id} className="flex items-center justify-between gap-4 px-6 py-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{(s.service_types as unknown as { name: string } | null)?.name}</p>
                      <Link href={`/units/${unit.id}`} className="text-xs text-muted-foreground hover:underline">
                        {unit.year} {unit.make} {unit.model} ·{" "}
                        {unit.customers ? `${unit.customers.first_name} ${unit.customers.last_name}` : "—"}
                      </Link>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant="outline">{STATUS_LABEL[s.status] ?? s.status}</Badge>
                      <CompleteServiceButton serviceId={s.id} unitId={unit.id} />
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
