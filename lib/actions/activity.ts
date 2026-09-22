import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

/**
 * Inserts one activity_logs row as the current user. RLS requires
 * employee_id = auth.uid(), so this only ever logs the caller's own action.
 */
export async function logActivity(
  supabase: SupabaseClient<Database>,
  params: {
    employeeId: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
  },
) {
  await supabase.from("activity_logs").insert({
    employee_id: params.employeeId,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    old_value: params.oldValue ?? null,
    new_value: params.newValue ?? null,
  });
}
