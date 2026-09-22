"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createIntake } from "@/lib/actions/intake";
import { STORAGE_TYPE_LABELS, UNIT_TYPE_LABELS } from "@/lib/utils/status";
import type { FormState } from "@/lib/actions/customers";

const initialState: FormState = { error: null };

const FUEL_LEVELS = [
  { value: "empty", label: "Empty" },
  { value: "quarter", label: "1/4" },
  { value: "half", label: "1/2" },
  { value: "three_quarter", label: "3/4" },
  { value: "full", label: "Full" },
];

export function IntakeForm({
  customers,
  serviceTypes,
  defaultCustomerId,
}: {
  customers: { id: string; first_name: string; last_name: string }[];
  serviceTypes: { id: string; name: string }[];
  defaultCustomerId?: string;
}) {
  const [state, formAction, isPending] = useActionState(createIntake, initialState);
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");

  return (
    <form action={formAction} className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Customer</h2>
        <Tabs value={customerMode} onValueChange={(v) => setCustomerMode(v as "existing" | "new")}>
          <TabsList>
            <TabsTrigger value="existing">Existing Customer</TabsTrigger>
            <TabsTrigger value="new">New Customer</TabsTrigger>
          </TabsList>
        </Tabs>
        <input type="hidden" name="customer_mode" value={customerMode} />

        {customerMode === "existing" ? (
          <div className="space-y-1.5">
            <Label htmlFor="customer_id">Customer</Label>
            <Select name="customer_id" defaultValue={defaultCustomerId}>
              <SelectTrigger className="w-full sm:w-96">
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
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new_first_name">First Name</Label>
              <Input id="new_first_name" name="new_first_name" required={customerMode === "new"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new_last_name">Last Name</Label>
              <Input id="new_last_name" name="new_last_name" required={customerMode === "new"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new_phone">Phone</Label>
              <Input id="new_phone" name="new_phone" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new_email">Email</Label>
              <Input id="new_email" name="new_email" type="email" />
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Boat / Vehicle Information</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="unit_type">Unit Type</Label>
            <Select name="unit_type" defaultValue="boat">
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
            <Select name="storage_type" defaultValue="outdoor">
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
          <div className="space-y-1.5">
            <Label htmlFor="year">Year</Label>
            <Input id="year" name="year" type="number" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="make">Make</Label>
            <Input id="make" name="make" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            <Input id="model" name="model" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="length_ft">Length (ft)</Label>
            <Input id="length_ft" name="length_ft" type="number" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="beam_ft">Beam (ft)</Label>
            <Input id="beam_ft" name="beam_ft" type="number" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="registration_number">Registration Number</Label>
            <Input id="registration_number" name="registration_number" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hin">HIN</Label>
            <Input id="hin" name="hin" />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Intake Checklist</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="fuel_level">Fuel Level</Label>
            <Select name="fuel_level">
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Not recorded" />
              </SelectTrigger>
              <SelectContent>
                {FUEL_LEVELS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="engine_hours">Engine Hours</Label>
            <Input id="engine_hours" name="engine_hours" type="number" />
          </div>
          <div />
          <div className="flex items-center gap-2">
            <Checkbox id="key_received" name="key_received" />
            <Label htmlFor="key_received" className="font-normal">
              Key received
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="cover_received" name="cover_received" />
            <Label htmlFor="cover_received" className="font-normal">
              Cover received
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="trailer_included" name="trailer_included" />
            <Label htmlFor="trailer_included" className="font-normal">
              Trailer included
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trailer_make">Trailer Make</Label>
            <Input id="trailer_make" name="trailer_make" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trailer_plate">Trailer Plate</Label>
            <Input id="trailer_plate" name="trailer_plate" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="existing_damage">Existing Damage</Label>
          <Textarea id="existing_damage" name="existing_damage" rows={2} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="special_instructions">Special Instructions</Label>
          <Textarea id="special_instructions" name="special_instructions" rows={2} />
        </div>
      </section>

      {serviceTypes.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Requested Services</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {serviceTypes.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <Checkbox id={`service-${s.id}`} name="service_type_ids" value={s.id} />
                <Label htmlFor={`service-${s.id}`} className="font-normal">
                  {s.name}
                </Label>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} />
      </div>

      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
        {isPending ? "Saving..." : "Save Intake"}
      </Button>
    </form>
  );
}
