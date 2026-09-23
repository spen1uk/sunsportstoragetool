import type { NotableEntity } from "@/lib/types/database";

export const BUCKET_FOR_ENTITY: Record<NotableEntity, string> = {
  unit: "unit-photos",
  intake: "unit-photos",
  customer: "documents",
};
