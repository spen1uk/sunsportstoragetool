import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { UnitForm } from "@/components/units/unit-form";
import { createUnit } from "@/lib/actions/units";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function NewUnitPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    redirect("/units");
  }

  const { customer } = await searchParams;
  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("customers")
    .select("id, first_name, last_name")
    .is("deleted_at", null)
    .order("last_name");

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New Unit</h1>
        <p className="text-sm text-muted-foreground">
          A unique storage ID and QR code are generated automatically. New units start as &ldquo;Arrived&rdquo; — assign a
          location once it&rsquo;s placed.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unit Information</CardTitle>
        </CardHeader>
        <CardContent>
          <UnitForm customers={customers ?? []} defaultCustomerId={customer} action={createUnit} />
        </CardContent>
      </Card>
    </div>
  );
}
