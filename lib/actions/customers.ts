"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { customerSchema } from "@/lib/validations/customer";
import { logActivity } from "@/lib/actions/activity";

export type FormState = { error: string | null; fieldErrors?: Record<string, string> };

function toNullable(value: FormDataEntryValue | null) {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

export async function createCustomer(_prevState: FormState, formData: FormData): Promise<FormState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = customerSchema.safeParse(raw);

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

  const { data, error } = await supabase
    .from("customers")
    .insert({
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name,
      phone: toNullable(formData.get("phone")),
      email: toNullable(formData.get("email")),
      address: toNullable(formData.get("address")),
      city: toNullable(formData.get("city")),
      state: toNullable(formData.get("state")),
      zip: toNullable(formData.get("zip")),
      secondary_contact_name: toNullable(formData.get("secondary_contact_name")),
      secondary_contact_phone: toNullable(formData.get("secondary_contact_phone")),
      notes: toNullable(formData.get("notes")),
      created_by: userData.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { error: error?.message ?? "Failed to create customer." };
  }

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "customer_created",
    entityType: "customer",
    entityId: data.id,
    newValue: { first_name: parsed.data.first_name, last_name: parsed.data.last_name },
  });

  revalidatePath("/customers");
  redirect(`/customers/${data.id}`);
}

export async function updateCustomer(
  customerId: string,
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = customerSchema.safeParse(raw);

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
    .from("customers")
    .update({
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name,
      phone: toNullable(formData.get("phone")),
      email: toNullable(formData.get("email")),
      address: toNullable(formData.get("address")),
      city: toNullable(formData.get("city")),
      state: toNullable(formData.get("state")),
      zip: toNullable(formData.get("zip")),
      secondary_contact_name: toNullable(formData.get("secondary_contact_name")),
      secondary_contact_phone: toNullable(formData.get("secondary_contact_phone")),
      notes: toNullable(formData.get("notes")),
    })
    .eq("id", customerId);

  if (error) {
    return { error: error.message };
  }

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "customer_edited",
    entityType: "customer",
    entityId: customerId,
  });

  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}`);
}
