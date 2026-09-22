"use client";

import { useActionState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { createBuilding, bulkCreateSpots, createStagingLocation, type FacilityFormState } from "@/lib/actions/facility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STORAGE_TYPE_LABELS, LOCATION_TYPE_LABELS } from "@/lib/utils/status";

const initialState: FacilityFormState = { error: null };

function useResetOnSuccess(isPending: boolean, error: string | null, formRef: React.RefObject<HTMLFormElement | null>, message: string) {
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !isPending && !error) {
      toast.success(message);
      formRef.current?.reset();
    }
    wasPending.current = isPending;
  }, [isPending, error, formRef, message]);
}

export function NewBuildingForm() {
  const [state, formAction, isPending] = useActionState(createBuilding, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  useResetOnSuccess(isPending, state.error, formRef, "Building created");

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="building_name">Name</Label>
        <Input id="building_name" name="name" placeholder="Building 3" className="w-48" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="building_code">Code</Label>
        <Input id="building_code" name="code" placeholder="B3" className="w-24" required />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding..." : "Add Building"}
      </Button>
      {state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function BulkSpotsForm({ buildings }: { buildings: { id: string; name: string }[] }) {
  const [state, formAction, isPending] = useActionState(bulkCreateSpots, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  useResetOnSuccess(isPending, state.error, formRef, "Spots created");

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="building_id">Building</Label>
        <Select name="building_id">
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Outdoor Yard" />
          </SelectTrigger>
          <SelectContent>
            {buildings.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="section">Section</Label>
        <Input id="section" name="section" placeholder="D" className="w-16" required maxLength={2} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="start_number">Start #</Label>
        <Input id="start_number" name="start_number" type="number" defaultValue={1} className="w-20" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="count">Count</Label>
        <Input id="count" name="count" type="number" defaultValue={10} className="w-20" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="storage_type">Storage Type</Label>
        <Select name="storage_type" defaultValue="outdoor">
          <SelectTrigger className="w-40">
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
        <Label htmlFor="max_length_ft">Max Length (ft)</Label>
        <Input id="max_length_ft" name="max_length_ft" type="number" className="w-28" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="max_width_ft">Max Width (ft)</Label>
        <Input id="max_width_ft" name="max_width_ft" type="number" className="w-28" />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create Spots"}
      </Button>
      {state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function NewStagingLocationForm() {
  const [state, formAction, isPending] = useActionState(createStagingLocation, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  useResetOnSuccess(isPending, state.error, formRef, "Location created");

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="full_code">Name</Label>
        <Input id="full_code" name="full_code" placeholder="Service Bay 3" className="w-48" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="location_type">Type</Label>
        <Select name="location_type" defaultValue="service_bay">
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(LOCATION_TYPE_LABELS)
              .filter(([value]) => value !== "storage_spot")
              .map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding..." : "Add Location"}
      </Button>
      {state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}
