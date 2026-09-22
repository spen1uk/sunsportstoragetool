"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import type { LocationType, StorageType } from "@/lib/types/database";

export type FacilityFormState = { error: string | null };

async function requireAdmin() {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") {
    throw new Error("Only admins can edit the facility layout.");
  }
  return profile;
}

async function getOrCreateFacilityId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: existing } = await supabase.from("facilities").select("id").limit(1).maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("facilities")
    .insert({ name: "Sun Sport Marine" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create facility.");
  return data.id;
}

export async function createBuilding(_prevState: FacilityFormState, formData: FormData): Promise<FacilityFormState> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Not authorized." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!name || !code) return { error: "Name and code are required." };

  const supabase = await createClient();
  const facilityId = await getOrCreateFacilityId(supabase);

  const { error } = await supabase.from("buildings").insert({ facility_id: facilityId, name, code });
  if (error) return { error: error.message };

  revalidatePath("/settings/facility");
  revalidatePath("/map");
  return { error: null };
}

export async function bulkCreateSpots(_prevState: FacilityFormState, formData: FormData): Promise<FacilityFormState> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Not authorized." };
  }

  const buildingId = String(formData.get("building_id") ?? "").trim() || null;
  const section = String(formData.get("section") ?? "").trim().toUpperCase();
  const startNum = Number(formData.get("start_number") ?? 1);
  const count = Number(formData.get("count") ?? 0);
  const storageType = String(formData.get("storage_type") ?? "outdoor") as StorageType;
  const maxLength = formData.get("max_length_ft") ? Number(formData.get("max_length_ft")) : null;
  const maxWidth = formData.get("max_width_ft") ? Number(formData.get("max_width_ft")) : null;

  if (!section || count < 1 || count > 100) {
    return { error: "Enter a section letter and a count between 1 and 100." };
  }

  const supabase = await createClient();
  const facilityId = await getOrCreateFacilityId(supabase);

  const rows = Array.from({ length: count }, (_, i) => {
    const num = startNum + i;
    return {
      facility_id: facilityId,
      building_id: buildingId,
      full_code: `${section}-${String(num).padStart(2, "0")}`,
      section,
      spot_number: String(num).padStart(2, "0"),
      location_type: "storage_spot" as const,
      storage_type: storageType,
      max_length_ft: maxLength,
      max_width_ft: maxWidth,
      sort_order: num,
    };
  });

  const { error } = await supabase.from("storage_locations").insert(rows);
  if (error) return { error: error.message };

  revalidatePath("/settings/facility");
  revalidatePath("/map");
  return { error: null };
}

export async function createStagingLocation(_prevState: FacilityFormState, formData: FormData): Promise<FacilityFormState> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Not authorized." };
  }

  const fullCode = String(formData.get("full_code") ?? "").trim();
  const locationType = String(formData.get("location_type") ?? "service_bay") as LocationType;
  if (!fullCode) return { error: "Name is required." };

  const supabase = await createClient();
  const facilityId = await getOrCreateFacilityId(supabase);

  const { error } = await supabase.from("storage_locations").insert({
    facility_id: facilityId,
    building_id: null,
    full_code: fullCode,
    location_type: locationType,
    storage_type: "temporary",
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/facility");
  revalidatePath("/map");
  return { error: null };
}
