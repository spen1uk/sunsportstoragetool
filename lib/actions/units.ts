"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { unitSchema } from "@/lib/validations/unit";
import { logActivity } from "@/lib/actions/activity";
import type { FormState } from "@/lib/actions/customers";

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

export async function createUnit(_prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = unitSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      error: "Please fix the errors below.",
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? ""]),
      ),
    };
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { error: "Not authenticated." };

  const internalStorageId = await nextInternalStorageId(supabase);

  const { data, error } = await supabase
    .from("units")
    .insert({
      internal_storage_id: internalStorageId,
      customer_id: parsed.data.customer_id,
      unit_type: parsed.data.unit_type,
      year: toNullableNumber(formData.get("year")),
      make: toNullable(formData.get("make")),
      model: toNullable(formData.get("model")),
      length_ft: toNullableNumber(formData.get("length_ft")),
      beam_ft: toNullableNumber(formData.get("beam_ft")),
      registration_number: toNullable(formData.get("registration_number")),
      hin: toNullable(formData.get("hin")),
      engine_make: toNullable(formData.get("engine_make")),
      engine_model: toNullable(formData.get("engine_model")),
      horsepower: toNullableNumber(formData.get("horsepower")),
      engine_hours: toNullableNumber(formData.get("engine_hours")),
      trailer_included: formData.get("trailer_included") === "on",
      trailer_make: toNullable(formData.get("trailer_make")),
      trailer_plate: toNullable(formData.get("trailer_plate")),
      storage_type: parsed.data.storage_type,
      status_code: "arrived",
      arrival_date: toNullable(formData.get("arrival_date")),
      expected_pickup_date: toNullable(formData.get("expected_pickup_date")),
      notes: toNullable(formData.get("notes")),
      created_by: userData.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { error: error?.message ?? "Failed to create unit." };
  }

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "unit_created",
    entityType: "unit",
    entityId: data.id,
    newValue: { internal_storage_id: internalStorageId },
  });

  revalidatePath("/units");
  revalidatePath("/arrivals");
  revalidatePath("/dashboard");
  redirect(`/units/${data.id}`);
}

export async function updateUnit(unitId: string, _prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = unitSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      error: "Please fix the errors below.",
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? ""]),
      ),
    };
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { error: "Not authenticated." };

  const { error } = await supabase
    .from("units")
    .update({
      customer_id: parsed.data.customer_id,
      unit_type: parsed.data.unit_type,
      year: toNullableNumber(formData.get("year")),
      make: toNullable(formData.get("make")),
      model: toNullable(formData.get("model")),
      length_ft: toNullableNumber(formData.get("length_ft")),
      beam_ft: toNullableNumber(formData.get("beam_ft")),
      registration_number: toNullable(formData.get("registration_number")),
      hin: toNullable(formData.get("hin")),
      engine_make: toNullable(formData.get("engine_make")),
      engine_model: toNullable(formData.get("engine_model")),
      horsepower: toNullableNumber(formData.get("horsepower")),
      engine_hours: toNullableNumber(formData.get("engine_hours")),
      trailer_included: formData.get("trailer_included") === "on",
      trailer_make: toNullable(formData.get("trailer_make")),
      trailer_plate: toNullable(formData.get("trailer_plate")),
      storage_type: parsed.data.storage_type,
      arrival_date: toNullable(formData.get("arrival_date")),
      expected_pickup_date: toNullable(formData.get("expected_pickup_date")),
      notes: toNullable(formData.get("notes")),
    })
    .eq("id", unitId);

  if (error) {
    return { error: error.message };
  }

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "unit_edited",
    entityType: "unit",
    entityId: unitId,
  });

  revalidatePath(`/units/${unitId}`);
  redirect(`/units/${unitId}`);
}

export async function updateUnitStatus(unitId: string, statusCode: string) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not authenticated.");

  const { data: before } = await supabase.from("units").select("status_code").eq("id", unitId).single();

  const { error } = await supabase.from("units").update({ status_code: statusCode }).eq("id", unitId);
  if (error) throw new Error(error.message);

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "status_changed",
    entityType: "unit",
    entityId: unitId,
    oldValue: { status_code: before?.status_code ?? null },
    newValue: { status_code: statusCode },
  });

  revalidatePath(`/units/${unitId}`);
  revalidatePath("/dashboard");
  revalidatePath("/arrivals");
  revalidatePath("/pickups");
}

export async function addUnitNote(entityType: "unit" | "customer", entityId: string, body: string) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not authenticated.");

  const { error } = await supabase.from("notes").insert({
    entity_type: entityType,
    entity_id: entityId,
    author_id: userData.user.id,
    body,
  });
  if (error) throw new Error(error.message);

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "note_added",
    entityType,
    entityId,
  });

  revalidatePath(entityType === "unit" ? `/units/${entityId}` : `/customers/${entityId}`);
}
