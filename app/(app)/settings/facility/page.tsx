import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewBuildingForm, BulkSpotsForm, NewStagingLocationForm } from "@/components/settings/facility-forms";

export const dynamic = "force-dynamic";

export default async function FacilitySettingsPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") redirect("/dashboard");

  const supabase = await createClient();
  const { data: buildings } = await supabase.from("buildings").select("id, name, code").order("sort_order");

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facility Layout</h1>
        <p className="text-sm text-muted-foreground">
          Add buildings and storage spots. A full drag-and-drop layout editor is a planned future upgrade — for now,
          spots are created in bulk by section.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Buildings ({buildings?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="flex flex-wrap gap-2">
            {(buildings ?? []).map((b) => (
              <li key={b.id} className="rounded-full border px-3 py-1 text-sm">
                {b.name} ({b.code})
              </li>
            ))}
          </ul>
          <NewBuildingForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bulk-Create Storage Spots</CardTitle>
        </CardHeader>
        <CardContent>
          <BulkSpotsForm buildings={buildings ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staging &amp; Service Locations</CardTitle>
        </CardHeader>
        <CardContent>
          <NewStagingLocationForm />
        </CardContent>
      </Card>
    </div>
  );
}
