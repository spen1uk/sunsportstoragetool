"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FormState } from "@/lib/actions/customers";
import { STORAGE_TYPE_LABELS, UNIT_TYPE_LABELS } from "@/lib/utils/status";

const initialState: FormState = { error: null };

function Field({
  name,
  label,
  defaultValue,
  error,
  type = "text",
}: {
  name: string;
  label: string;
  defaultValue?: string | number | null;
  error?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? ""} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

type UnitDefaults = {
  customer_id: string;
  unit_type: string;
  storage_type: string;
  year: number | null;
  make: string | null;
  model: string | null;
  length_ft: number | null;
  beam_ft: number | null;
  registration_number: string | null;
  hin: string | null;
  engine_make: string | null;
  engine_model: string | null;
  horsepower: number | null;
  engine_hours: number | null;
  trailer_included: boolean;
  trailer_make: string | null;
  trailer_plate: string | null;
  arrival_date: string | null;
  expected_pickup_date: string | null;
  notes: string | null;
};

export function UnitForm({
  customers,
  defaultCustomerId,
  unit,
  action,
}: {
  customers: { id: string; first_name: string; last_name: string }[];
  defaultCustomerId?: string;
  unit?: UnitDefaults;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="customer_id">
            Customer <span className="text-destructive">*</span>
          </Label>
          <Select name="customer_id" defaultValue={unit?.customer_id ?? defaultCustomerId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a customer" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.first_name} {c.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.customer_id ? <p className="text-xs text-destructive">{errors.customer_id}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="unit_type">Unit Type</Label>
          <Select name="unit_type" defaultValue={unit?.unit_type ?? "boat"}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(UNIT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="storage_type">Storage Type</Label>
          <Select name="storage_type" defaultValue={unit?.storage_type ?? "outdoor"}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(STORAGE_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Field name="year" label="Year" type="number" defaultValue={unit?.year} error={errors.year} />
        <Field name="make" label="Make" defaultValue={unit?.make} error={errors.make} />
        <Field name="model" label="Model" defaultValue={unit?.model} error={errors.model} />
        <Field name="length_ft" label="Length (ft)" type="number" defaultValue={unit?.length_ft} error={errors.length_ft} />
        <Field name="beam_ft" label="Beam (ft)" type="number" defaultValue={unit?.beam_ft} error={errors.beam_ft} />
        <Field
          name="registration_number"
          label="Registration Number"
          defaultValue={unit?.registration_number}
          error={errors.registration_number}
        />
        <Field name="hin" label="HIN" defaultValue={unit?.hin} error={errors.hin} />
        <Field name="engine_make" label="Engine Make" defaultValue={unit?.engine_make} error={errors.engine_make} />
        <Field name="engine_model" label="Engine Model" defaultValue={unit?.engine_model} error={errors.engine_model} />
        <Field name="horsepower" label="Horsepower" type="number" defaultValue={unit?.horsepower} error={errors.horsepower} />
        <Field
          name="engine_hours"
          label="Engine Hours"
          type="number"
          defaultValue={unit?.engine_hours}
          error={errors.engine_hours}
        />

        <div className="flex items-center gap-2 pt-6">
          <Checkbox id="trailer_included" name="trailer_included" defaultChecked={unit?.trailer_included} />
          <Label htmlFor="trailer_included" className="font-normal">
            Trailer included
          </Label>
        </div>
        <div />

        <Field name="trailer_make" label="Trailer Make" defaultValue={unit?.trailer_make} error={errors.trailer_make} />
        <Field name="trailer_plate" label="Trailer Plate" defaultValue={unit?.trailer_plate} error={errors.trailer_plate} />
        <Field
          name="arrival_date"
          label="Arrival Date"
          type="date"
          defaultValue={unit?.arrival_date}
          error={errors.arrival_date}
        />
        <Field
          name="expected_pickup_date"
          label="Expected Pickup Date"
          type="date"
          defaultValue={unit?.expected_pickup_date}
          error={errors.expected_pickup_date}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={4} defaultValue={unit?.notes ?? ""} />
      </div>

      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
        {isPending ? "Saving..." : "Save Unit"}
      </Button>
    </form>
  );
}
