"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/actions/customers";
import type { Database } from "@/lib/types/database";

type Customer = Database["public"]["Tables"]["customers"]["Row"];

const initialState: FormState = { error: null };

function Field({
  name,
  label,
  defaultValue,
  error,
  type = "text",
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  error?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? ""} required={required} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function CustomerForm({
  customer,
  action,
}: {
  customer?: Customer;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="first_name" label="First Name" defaultValue={customer?.first_name} error={errors.first_name} required />
        <Field name="last_name" label="Last Name" defaultValue={customer?.last_name} error={errors.last_name} required />
        <Field name="phone" label="Phone" defaultValue={customer?.phone} error={errors.phone} />
        <Field name="email" label="Email" defaultValue={customer?.email} error={errors.email} type="email" />
        <Field name="address" label="Address" defaultValue={customer?.address} error={errors.address} />
        <Field name="city" label="City" defaultValue={customer?.city} error={errors.city} />
        <Field name="state" label="State" defaultValue={customer?.state} error={errors.state} />
        <Field name="zip" label="ZIP" defaultValue={customer?.zip} error={errors.zip} />
        <Field
          name="secondary_contact_name"
          label="Secondary Contact Name"
          defaultValue={customer?.secondary_contact_name}
          error={errors.secondary_contact_name}
        />
        <Field
          name="secondary_contact_phone"
          label="Secondary Contact Phone"
          defaultValue={customer?.secondary_contact_phone}
          error={errors.secondary_contact_phone}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={4} defaultValue={customer?.notes ?? ""} />
      </div>
      {state.error ? <p className="text-sm font-medium text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
        {isPending ? "Saving..." : customer ? "Save Changes" : "Create Customer"}
      </Button>
    </form>
  );
}
