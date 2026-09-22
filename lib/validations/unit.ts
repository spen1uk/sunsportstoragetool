import { z } from "zod";

const unitTypeValues = [
  "boat", "pontoon", "tritoon", "wake_boat", "fishing_boat",
  "pwc", "rv", "camper", "trailer", "other",
] as const;

const storageTypeValues = [
  "heated_indoor", "cold_indoor", "outdoor", "shrink_wrapped", "temporary", "other",
] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const optionalNumber = z.coerce.number().optional().or(z.literal("").transform(() => undefined));
const optionalDate = z.string().trim().optional().or(z.literal(""));

export const unitSchema = z.object({
  customer_id: z.string().uuid("Select a customer"),
  unit_type: z.enum(unitTypeValues),
  year: optionalNumber,
  make: optionalText(100),
  model: optionalText(100),
  length_ft: optionalNumber,
  beam_ft: optionalNumber,
  registration_number: optionalText(50),
  hin: optionalText(50),
  engine_make: optionalText(100),
  engine_model: optionalText(100),
  horsepower: optionalNumber,
  engine_hours: optionalNumber,
  trailer_included: z.coerce.boolean().optional(),
  trailer_make: optionalText(100),
  trailer_plate: optionalText(50),
  storage_type: z.enum(storageTypeValues),
  arrival_date: optionalDate,
  expected_pickup_date: optionalDate,
  notes: optionalText(4000),
});

export type UnitInput = z.infer<typeof unitSchema>;

export const unitStatusUpdateSchema = z.object({
  unit_id: z.string().uuid(),
  status_code: z.string().min(1),
});

export const unitNoteSchema = z.object({
  entity_type: z.enum(["unit", "customer"]),
  entity_id: z.string().uuid(),
  body: z.string().trim().min(1, "Note can't be empty").max(4000),
});
