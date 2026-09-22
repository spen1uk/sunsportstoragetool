"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { removeUnitFromStorage } from "@/lib/actions/locations";

export async function completePickup(unitId: string): Promise<{ error: string | null }> {
  const result = await removeUnitFromStorage(unitId, "Picked up by customer");
  if (result.error) return result;

  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  await supabase
    .from("pickups")
    .update({ status: "completed", actual_pickup_date: today })
    .eq("unit_id", unitId)
    .neq("status", "completed");

  revalidatePath("/pickups");
  revalidatePath(`/units/${unitId}`);
  return { error: null };
}
