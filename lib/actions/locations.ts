"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type MoveResult = { error: string | null };

/** Assigns or moves a unit to a new storage location. Wraps the move_unit()
 * Postgres function — see supabase/migrations/20260921190130_functions.sql —
 * which is the only sanctioned way to change a unit's location. */
export async function moveUnit(unitId: string, newLocationId: string, note?: string): Promise<MoveResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("move_unit", {
    p_unit_id: unitId,
    p_new_location_id: newLocationId,
    p_note: note ?? null,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/map");
  revalidatePath(`/units/${unitId}`);
  revalidatePath("/arrivals");
  revalidatePath("/dashboard");
  return { error: null };
}

export async function removeUnitFromStorage(unitId: string, note?: string): Promise<MoveResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("remove_unit_from_storage", {
    p_unit_id: unitId,
    p_note: note ?? null,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/map");
  revalidatePath(`/units/${unitId}`);
  revalidatePath("/pickups");
  revalidatePath("/dashboard");
  return { error: null };
}
