import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/utils/nav";

export async function getCurrentProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, role, active")
    .eq("id", user.id)
    .single();

  if (!profile) return null;
  return { ...profile, role: profile.role as AppRole };
}

export function canManage(role: AppRole) {
  return role === "admin" || role === "manager";
}
