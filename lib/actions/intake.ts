"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { logActivity } from "@/lib/actions/activity";
import type { FormState } from "@/lib/actions/customers";
import type { FuelLevel, StorageType, UnitType } from "@/lib/types/database";

function toNullable(value: FormDataEntryValue | null) {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function toNullableNumber(value: FormDataEntryValue | null) {
  const str = String(value ?? "").trim();
  if (str === "") return null;
  const n = Number(str);
  return Number.isNaN(n) ? null : n;
}

async function nextInternalStorageId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from("units")
    .select("id", { count: "exact", head: true })
    .like("internal_storage_id", `SSM-${year}-%`);
  const next = (count ?? 0) + 1;
  return `SSM-${year}-${String(next).padStart(5, "0")}`;
}

export async function createIntake(_prevState: FormState, formData: FormData): Promise<FormState> {
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    return { error: "Only managers and admins can complete an intake." };
  }

  const supabase = await createClient();

  // Customer: existing or created inline.
  let customerId = String(formData.get("customer_id") ?? "").trim();
  const customerMode = String(formData.get("customer_mode") ?? "existing");

  if (customerMode === "new") {
    const firstName = toNullable(formData.get("new_first_name"));
    const lastName = toNullable(formData.get("new_last_name"));
    if (!firstName || !lastName) {
      return { error: "New customer needs at least a first and last name." };
    }
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .insert({
        first_name: firstName,
        last_name: lastName,
        phone: toNullable(formData.get("new_phone")),
        email: toNullable(formData.get("new_email")),
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (customerError || !customer) {
      return { error: customerError?.message ?? "Failed to create customer." };
    }
    customerId = customer.id;
    await logActivity(supabase, {
      employeeId: profile.id,
      action: "customer_created",
      entityType: "customer",
      entityId: customerId,
      newValue: { first_name: firstName, last_name: lastName },
    });
  }

  if (!customerId) {
    return { error: "Select or create a customer." };
  }

  const engineHours = toNullableNumber(formData.get("engine_hours"));
  const trailerIncluded = formData.get("trailer_included") === "on";
  const internalStorageId = await nextInternalStorageId(supabase);

  const { data: unit, error: unitError } = await supabase
    .from("units")
    .insert({
      internal_storage_id: internalStorageId,
      customer_id: customerId,
      unit_type: String(formData.get("unit_type") ?? "boat") as UnitType,
      year: toNullableNumber(formData.get("year")),
      make: toNullable(formData.get("make")),
      model: toNullable(formData.get("model")),
      length_ft: toNullableNumber(formData.get("length_ft")),
      beam_ft: toNullableNumber(formData.get("beam_ft")),
      registration_number: toNullable(formData.get("registration_number")),
      hin: toNullable(formData.get("hin")),
      engine_hours: engineHours,
      trailer_included: trailerIncluded,
      trailer_make: toNullable(formData.get("trailer_make")),
      trailer_plate: toNullable(formData.get("trailer_plate")),
      storage_type: String(formData.get("storage_type") ?? "outdoor") as StorageType,
      status_code: "needs_location",
      arrival_date: new Date().toISOString().slice(0, 10),
      notes: toNullable(formData.get("notes")),
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (unitError || !unit) {
    return { error: unitError?.message ?? "Failed to create unit." };
  }

  const { error: intakeError } = await supabase.from("intakes").insert({
    unit_id: unit.id,
    performed_by: profile.id,
    fuel_level: toNullable(formData.get("fuel_level")) as FuelLevel | null,
    engine_hours: engineHours,
    key_received: formData.get("key_received") === "on",
    cover_received: formData.get("cover_received") === "on",
    trailer_included: trailerIncluded,
    existing_damage: toNullable(formData.get("existing_damage")),
    special_instructions: toNullable(formData.get("special_instructions")),
  });
  if (intakeError) {
    return { error: intakeError.message };
  }

  const serviceIds = formData.getAll("service_type_ids").map(String);
  if (serviceIds.length > 0) {
    const { error: servicesError } = await supabase.from("unit_services").insert(
      serviceIds.map((serviceTypeId) => ({
        unit_id: unit.id,
        service_type_id: serviceTypeId,
        status: "requested" as const,
      })),
    );
    if (servicesError) {
      return { error: servicesError.message };
    }
  }

  await logActivity(supabase, {
    employeeId: profile.id,
    action: "unit_created",
    entityType: "unit",
    entityId: unit.id,
    newValue: { internal_storage_id: internalStorageId, via: "intake" },
  });

  revalidatePath("/units");
  revalidatePath("/arrivals");
  revalidatePath("/dashboard");
  redirect(`/units/${unit.id}`);
}
