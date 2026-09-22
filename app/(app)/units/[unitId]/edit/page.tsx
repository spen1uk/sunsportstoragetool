import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { UnitForm } from "@/components/units/unit-form";
import { updateUnit } from "@/lib/actions/units";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function EditUnitPage({
  params,
}: {
  params: Promise<{ unitId: string }>;
}) {
  const { unitId } = await params;
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    redirect(`/units/${unitId}`);
  }

  const supabase = await createClient();
  const [{ data: unit }, { data: customers }] = await Promise.all([
    supabase.from("units").select("*").eq("id", unitId).single(),
    supabase.from("customers").select("id, first_name, last_name").is("deleted_at", null).order("last_name"),
  ]);

  if (!unit) notFound();

  const action = updateUnit.bind(null, unitId);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit {unit.internal_storage_id}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unit Information</CardTitle>
        </CardHeader>
        <CardContent>
          <UnitForm customers={customers ?? []} unit={unit} action={action} />
        </CardContent>
      </Card>
    </div>
  );
}
