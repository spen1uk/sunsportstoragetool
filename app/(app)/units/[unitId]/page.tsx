import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Pencil, User } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { UnitStatusBadge } from "@/components/units/unit-status-badge";
import { StatusSelect } from "@/components/units/status-select";
import { MoveUnitDialog, type AvailableLocation } from "@/components/units/move-unit-dialog";
import { UnitTimeline } from "@/components/units/unit-timeline";
import { NoteSection } from "@/components/notes/note-section";
import { UNIT_TYPE_LABELS, STORAGE_TYPE_LABELS } from "@/lib/utils/status";

export const dynamic = "force-dynamic";

function Detail({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

export default async function UnitDetailPage({
  params,
}: {
  params: Promise<{ unitId: string }>;
}) {
  const { unitId } = await params;
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  const [
    { data: unit },
    { data: statuses },
    { data: activeAssignment },
    { data: allLocations },
    { data: activeAssignments },
    { data: historyRows },
    { data: services },
    { data: notes },
  ] = await Promise.all([
    supabase
      .from("units")
      .select("*, customers(id, first_name, last_name, phone, email), unit_statuses(label, color, icon)")
      .eq("id", unitId)
      .single(),
    supabase.from("unit_statuses").select("code, label").order("sort_order"),
    supabase
      .from("location_assignments")
      .select("storage_location_id, storage_locations(full_code, buildings(name))")
      .eq("unit_id", unitId)
      .is("unassigned_at", null)
      .maybeSingle(),
    supabase
      .from("storage_locations")
      .select("id, full_code, location_type, storage_type, admin_status, is_active, building_id, buildings(name)")
      .eq("is_active", true)
      .neq("admin_status", "unavailable"),
    supabase.from("location_assignments").select("storage_location_id").is("unassigned_at", null),
    supabase
      .from("location_history")
      .select(
        `id, moved_at, note,
         mover:profiles!location_history_moved_by_fkey(full_name),
         from_location:storage_locations!location_history_from_location_id_fkey(full_code, buildings(name)),
         to_location:storage_locations!location_history_to_location_id_fkey(full_code, buildings(name))`,
      )
      .eq("unit_id", unitId)
      .order("moved_at", { ascending: false }),
    supabase
      .from("unit_services")
      .select("id, status, requested_at, completed_at, service_types(name), profiles(full_name)")
      .eq("unit_id", unitId)
      .order("requested_at", { ascending: false }),
    supabase
      .from("notes")
      .select("id, body, created_at, profiles(full_name)")
      .eq("entity_type", "unit")
      .eq("entity_id", unitId)
      .order("created_at", { ascending: false }),
  ]);

  if (!unit) notFound();

  const customer = unit.customers as unknown as {
    id: string;
    first_name: string;
    last_name: string;
    phone: string | null;
    email: string | null;
  } | null;
  const status = unit.unit_statuses as unknown as { label: string; color: string; icon: string } | null;

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

  const currentLoc = activeAssignment?.storage_locations as unknown as
    | { full_code: string; buildings: { name: string } | null }
    | null;
  const currentLocationLabel = currentLoc ? [currentLoc.buildings?.name, currentLoc.full_code].filter(Boolean).join(" · ") : null;

  const unitLabel = `${unit.year ?? ""} ${unit.make ?? ""} ${unit.model ?? ""}`.trim() || unit.internal_storage_id;

  const historyMapped = (historyRows ?? []).map((row) => {
    const from = row.from_location as unknown as { full_code: string; buildings: { name: string } | null } | null;
    const to = row.to_location as unknown as { full_code: string; buildings: { name: string } | null } | null;
    return {
      id: row.id,
      moved_at: row.moved_at,
      note: row.note,
      mover_full_name: (row.mover as unknown as { full_name: string } | null)?.full_name ?? null,
      from_label: from ? [from.buildings?.name, from.full_code].filter(Boolean).join(" · ") : null,
      to_label: to ? [to.buildings?.name, to.full_code].filter(Boolean).join(" · ") : null,
    };
  });

  const mappedNotes = (notes ?? []).map((n) => ({
    id: n.id,
    body: n.body,
    created_at: n.created_at,
    author_full_name: (n.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
  }));

  const canEdit = profile ? canManage(profile.role) : false;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{unitLabel}</h1>
            {status ? <UnitStatusBadge label={status.label} color={status.color} icon={status.icon} /> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {unit.internal_storage_id} · {UNIT_TYPE_LABELS[unit.unit_type] ?? unit.unit_type}
          </p>
          {customer ? (
            <Link href={`/customers/${customer.id}`} className="mt-1 flex items-center gap-1 text-sm text-primary hover:underline">
              <User className="h-3.5 w-3.5" />
              {customer.first_name} {customer.last_name}
            </Link>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Image src={`/api/qr/${unit.qr_token}`} alt="QR code" width={64} height={64} className="rounded border" unoptimized />
          {canEdit ? (
            <Button variant="outline" size="sm" render={<Link href={`/units/${unit.id}/edit`} />}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Current Location</p>
            <p className="text-lg font-semibold">{currentLocationLabel ?? "Not yet assigned"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusSelect unitId={unit.id} currentStatus={unit.status_code} statuses={statuses ?? []} />
            <MoveUnitDialog
              unitId={unit.id}
              unitLabel={unitLabel}
              currentLocationLabel={currentLocationLabel}
              availableLocations={availableLocations}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unit Information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Detail label="Year" value={unit.year} />
          <Detail label="Make" value={unit.make} />
          <Detail label="Model" value={unit.model} />
          <Detail label="Length" value={unit.length_ft ? `${unit.length_ft} ft` : null} />
          <Detail label="Beam" value={unit.beam_ft ? `${unit.beam_ft} ft` : null} />
          <Detail label="Storage Type" value={STORAGE_TYPE_LABELS[unit.storage_type]} />
          <Detail label="Registration #" value={unit.registration_number} />
          <Detail label="HIN" value={unit.hin} />
          <Detail label="Engine" value={[unit.engine_make, unit.engine_model].filter(Boolean).join(" ") || null} />
          <Detail label="Horsepower" value={unit.horsepower} />
          <Detail label="Engine Hours" value={unit.engine_hours} />
          <Detail label="Trailer" value={unit.trailer_included ? [unit.trailer_make, unit.trailer_plate].filter(Boolean).join(" · ") || "Yes" : "No"} />
          <Detail label="Arrival Date" value={unit.arrival_date} />
          <Detail label="Expected Pickup" value={unit.expected_pickup_date} />
        </CardContent>
        {unit.notes ? (
          <>
            <Separator />
            <CardContent>
              <p className="text-xs text-muted-foreground mb-1">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{unit.notes}</p>
            </CardContent>
          </>
        ) : null}
      </Card>

      {(services ?? []).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Services</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(services ?? []).map((s) => (
              <div key={s.id} className="flex items-center justify-between text-sm">
                <span>{(s.service_types as unknown as { name: string } | null)?.name}</span>
                <span className="text-xs text-muted-foreground capitalize">{s.status.replaceAll("_", " ")}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Location History</CardTitle>
        </CardHeader>
        <CardContent>
          <UnitTimeline rows={historyMapped} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <NoteSection entityType="unit" entityId={unit.id} notes={mappedNotes} />
        </CardContent>
      </Card>
    </div>
  );
}
