import {
  AlertTriangle,
  Boxes,
  CalendarClock,
  MapPinOff,
  PackageCheck,
  Percent,
  Snowflake,
  Sun,
  Thermometer,
  Truck,
  Warehouse,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/dashboard/stat-card";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function pct(occupied: number, total: number) {
  if (total === 0) return 0;
  return Math.round((occupied / total) * 100);
}

export default async function DashboardPage() {
  const supabase = await createClient();

  const [
    { count: totalInStorage },
    { count: unassignedCount },
    { count: arrivingSoonCount },
    { count: serviceRequiredCount },
    { count: readyForPickupCount },
    { count: pickupsSoonCount },
    { data: capacityByType },
    { data: activityRows },
  ] = await Promise.all([
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .not("status_code", "in", "(scheduled_for_arrival,removed_from_storage)"),
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status_code", "needs_location"),
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status_code", "scheduled_for_arrival"),
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .in("status_code", ["needs_service", "needs_detailing", "needs_spring_prep"]),
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status_code", "ready_for_pickup"),
    supabase
      .from("units")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .in("status_code", ["ready_for_pickup", "pickup_scheduled"]),
    supabase.from("v_capacity_by_storage_type").select("*"),
    supabase
      .from("activity_logs")
      .select("id, action, entity_type, created_at, old_value, new_value, profiles(full_name)")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const capacity = capacityByType ?? [];
  const totalSpaces = capacity.reduce((sum, c) => sum + c.total_spaces, 0);
  const occupiedSpaces = capacity.reduce((sum, c) => sum + c.occupied_spaces, 0);
  const availableSpaces = totalSpaces - occupiedSpaces;

  const heated = capacity.find((c) => c.storage_type === "heated_indoor");
  const cold = capacity.find((c) => c.storage_type === "cold_indoor");
  const outdoor = capacity.find((c) => c.storage_type === "outdoor");

  const activity = (activityRows ?? []).map((row) => ({
    id: row.id,
    action: row.action,
    entity_type: row.entity_type,
    created_at: row.created_at,
    old_value: row.old_value,
    new_value: row.new_value,
    employee_full_name: (row.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Live overview of Sun Sport Marine storage operations.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total Units in Storage" value={totalInStorage ?? 0} icon={Boxes} href="/units" />
        <StatCard
          label="Heated Indoor"
          value={`${heated?.occupied_spaces ?? 0}/${heated?.total_spaces ?? 0}`}
          sublabel={`${pct(heated?.occupied_spaces ?? 0, heated?.total_spaces ?? 0)}% full`}
          icon={Thermometer}
          href="/map"
        />
        <StatCard
          label="Cold Indoor"
          value={`${cold?.occupied_spaces ?? 0}/${cold?.total_spaces ?? 0}`}
          sublabel={`${pct(cold?.occupied_spaces ?? 0, cold?.total_spaces ?? 0)}% full`}
          icon={Snowflake}
          href="/map"
        />
        <StatCard
          label="Outdoor"
          value={`${outdoor?.occupied_spaces ?? 0}/${outdoor?.total_spaces ?? 0}`}
          sublabel={`${pct(outdoor?.occupied_spaces ?? 0, outdoor?.total_spaces ?? 0)}% full`}
          icon={Sun}
          href="/map"
        />
        <StatCard
          label="Unassigned Units"
          value={unassignedCount ?? 0}
          icon={MapPinOff}
          href="/arrivals"
          tone="warning"
        />
        <StatCard label="Arriving Soon" value={arrivingSoonCount ?? 0} icon={Truck} href="/arrivals" />
        <StatCard
          label="Service Required"
          value={serviceRequiredCount ?? 0}
          icon={AlertTriangle}
          href="/service"
          tone="warning"
        />
        <StatCard
          label="Ready for Pickup"
          value={readyForPickupCount ?? 0}
          icon={PackageCheck}
          href="/pickups"
          tone="purple"
        />
        <StatCard label="Pickups Soon" value={pickupsSoonCount ?? 0} icon={CalendarClock} href="/pickups" tone="purple" />
        <StatCard
          label="Available Storage Spaces"
          value={availableSpaces}
          sublabel={`of ${totalSpaces} total`}
          icon={Warehouse}
          href="/map"
          tone="green"
        />
        <StatCard
          label="Facility Capacity"
          value={`${pct(occupiedSpaces, totalSpaces)}%`}
          sublabel={`${occupiedSpaces}/${totalSpaces} spaces`}
          icon={Percent}
          href="/map"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityFeed rows={activity} />
        </CardContent>
      </Card>
    </div>
  );
}
