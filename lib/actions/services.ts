"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/actions/activity";

export async function completeService(serviceId: string, unitId: string) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not authenticated.");

  const { data: service } = await supabase
    .from("unit_services")
    .select("service_types(name)")
    .eq("id", serviceId)
    .single();

  const { error } = await supabase
    .from("unit_services")
    .update({ status: "complete", completed_at: new Date().toISOString(), assigned_employee_id: userData.user.id })
    .eq("id", serviceId);

  if (error) throw new Error(error.message);

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "service_completed",
    entityType: "unit",
    entityId: unitId,
    newValue: { service: (service?.service_types as unknown as { name: string } | null)?.name ?? null },
  });

  revalidatePath("/service");
  revalidatePath(`/units/${unitId}`);
  revalidatePath("/dashboard");
}
