import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { IntakeForm } from "@/components/units/intake-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    redirect("/arrivals");
  }

  const { customer } = await searchParams;
  const supabase = await createClient();
  const [{ data: customers }, { data: serviceTypes }] = await Promise.all([
    supabase.from("customers").select("id, first_name, last_name").is("deleted_at", null).order("last_name"),
    supabase.from("service_types").select("id, name").eq("is_active", true).order("name"),
  ]);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create Intake</h1>
        <p className="text-sm text-muted-foreground">
          Record a boat arriving at the facility. Saving moves it straight to the Unassigned queue.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intake Details</CardTitle>
        </CardHeader>
        <CardContent>
          <IntakeForm customers={customers ?? []} serviceTypes={serviceTypes ?? []} defaultCustomerId={customer} />
        </CardContent>
      </Card>
    </div>
  );
}
