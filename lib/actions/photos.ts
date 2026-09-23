"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/actions/activity";
import { BUCKET_FOR_ENTITY } from "@/lib/utils/storage-buckets";
import type { NotableEntity } from "@/lib/types/database";

export async function recordPhoto(
  entityType: NotableEntity,
  entityId: string,
  storagePath: string,
  caption?: string,
) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not authenticated.");

  const { error } = await supabase.from("photos").insert({
    entity_type: entityType,
    entity_id: entityId,
    storage_path: storagePath,
    caption: caption ?? null,
    uploaded_by: userData.user.id,
  });
  if (error) throw new Error(error.message);

  await logActivity(supabase, {
    employeeId: userData.user.id,
    action: "photo_uploaded",
    entityType,
    entityId,
  });

  revalidatePath(entityType === "customer" ? `/customers/${entityId}` : `/units/${entityId}`);
}

export async function deletePhoto(photoId: string, entityType: NotableEntity, entityId: string) {
  const supabase = await createClient();

  const { data: photo } = await supabase.from("photos").select("storage_path").eq("id", photoId).single();
  if (!photo) return;

  const { error } = await supabase.from("photos").delete().eq("id", photoId);
  if (error) throw new Error(error.message);

  await supabase.storage.from(BUCKET_FOR_ENTITY[entityType]).remove([photo.storage_path]);

  revalidatePath(entityType === "customer" ? `/customers/${entityId}` : `/units/${entityId}`);
}
