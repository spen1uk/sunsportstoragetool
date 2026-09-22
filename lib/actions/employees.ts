"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import { logActivity } from "@/lib/actions/activity";
import type { AppRole } from "@/lib/utils/nav";

export type EmployeeFormState = { error: string | null };

export async function createEmployee(_prevState: EmployeeFormState, formData: FormData): Promise<EmployeeFormState> {
  const requester = await getCurrentProfile();
  if (!requester || requester.role !== "admin") {
    return { error: "Only admins can add employees." };
  }

  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "employee") as AppRole;
  const password = String(formData.get("password") ?? "");

  if (!fullName || !email || password.length < 8) {
    return { error: "Name, email, and an 8+ character password are required." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, role },
  });

  if (error || !data.user) {
    return { error: error?.message ?? "Failed to create employee account." };
  }

  const supabase = await createClient();
  await logActivity(supabase, {
    employeeId: requester.id,
    action: "employee_created",
    entityType: "profile",
    entityId: data.user.id,
    newValue: { full_name: fullName, role },
  });

  revalidatePath("/settings/employees");
  return { error: null };
}

export async function updateEmployeeRole(profileId: string, role: AppRole) {
  const requester = await getCurrentProfile();
  if (!requester || requester.role !== "admin") throw new Error("Only admins can change roles.");

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ role }).eq("id", profileId);
  if (error) throw new Error(error.message);

  revalidatePath("/settings/employees");
}

export async function setEmployeeActive(profileId: string, active: boolean) {
  const requester = await getCurrentProfile();
  if (!requester || requester.role !== "admin") throw new Error("Only admins can change account status.");

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ active }).eq("id", profileId);
  if (error) throw new Error(error.message);

  revalidatePath("/settings/employees");
}
