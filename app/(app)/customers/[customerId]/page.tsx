import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, MapPin, Pencil, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UnitStatusBadge } from "@/components/units/unit-status-badge";
import { NoteSection } from "@/components/notes/note-section";
import { PhotoGallery } from "@/components/photos/photo-gallery";
import { RealtimeRefresher } from "@/components/realtime/realtime-refresher";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  const [{ data: customer }, { data: units }, { data: notes }, { data: photoRows }] = await Promise.all([
    supabase.from("customers").select("*").eq("id", customerId).single(),
    supabase
      .from("units")
      .select("id, internal_storage_id, year, make, model, unit_type, status_code, unit_statuses(label, color, icon)")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("notes")
      .select("id, body, created_at, profiles(full_name)")
      .eq("entity_type", "customer")
      .eq("entity_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("photos")
      .select("id, storage_path, caption")
      .eq("entity_type", "customer")
      .eq("entity_id", customerId)
      .order("created_at", { ascending: false }),
  ]);

  if (!customer) notFound();

  let photos: { id: string; url: string; caption: string | null }[] = [];
  if (photoRows && photoRows.length > 0) {
    const { data: signed } = await supabase.storage
      .from("documents")
      .createSignedUrls(
        photoRows.map((p) => p.storage_path),
        3600,
      );
    photos = photoRows.map((p, i) => ({
      id: p.id,
      caption: p.caption,
      url: signed?.[i]?.signedUrl ?? "",
    }));
  }

  const mappedNotes = (notes ?? []).map((n) => ({
    id: n.id,
    body: n.body,
    created_at: n.created_at,
    author_full_name: (n.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
  }));

  return (
    <div className="max-w-4xl space-y-6">
      <RealtimeRefresher tables={["units", "notes", "photos"]} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {customer.first_name} {customer.last_name}
          </h1>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {customer.phone ? (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" /> {customer.phone}
              </span>
            ) : null}
            {customer.email ? (
              <span className="flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" /> {customer.email}
              </span>
            ) : null}
            {customer.city ? (
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> {[customer.city, customer.state].filter(Boolean).join(", ")}
              </span>
            ) : null}
          </div>
        </div>
        {profile && canManage(profile.role) ? (
          <Button variant="outline" nativeButton={false} render={<Link href={`/customers/${customer.id}/edit`} />}>
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Stored Units ({units?.length ?? 0})</CardTitle>
          {profile && canManage(profile.role) ? (
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/units/new?customer=${customer.id}`} />}>
              Add Unit
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {(units ?? []).length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">No units on file for this customer.</p>
          ) : (
            <ul className="divide-y">
              {(units ?? []).map((u) => (
                <li key={u.id}>
                  <Link href={`/units/${u.id}`} className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-accent">
                    <div>
                      <p className="text-sm font-medium">
                        {u.year} {u.make} {u.model}
                      </p>
                      <p className="text-xs text-muted-foreground">{u.internal_storage_id}</p>
                    </div>
                    {u.unit_statuses ? (
                      <UnitStatusBadge
                        label={(u.unit_statuses as unknown as { label: string }).label}
                        color={(u.unit_statuses as unknown as { color: string }).color}
                        icon={(u.unit_statuses as unknown as { icon: string }).icon}
                      />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {customer.notes ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Office Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{customer.notes}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Documents &amp; Photos</CardTitle>
        </CardHeader>
        <CardContent>
          <PhotoGallery entityType="customer" entityId={customer.id} photos={photos} canDelete={profile?.role === "admin"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <NoteSection entityType="customer" entityId={customer.id} notes={mappedNotes} />
        </CardContent>
      </Card>
    </div>
  );
}
