"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRightLeft, ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { moveUnit } from "@/lib/actions/locations";
import type { SpotWithOccupant } from "./spot-tile";

export type UnassignedUnit = {
  id: string;
  label: string;
  customer_name: string;
};

export function SpotDetailSheet({
  spot,
  locationLabel,
  unassignedUnits,
  open,
  onOpenChange,
}: {
  spot: SpotWithOccupant | null;
  locationLabel: string;
  unassignedUnits: UnassignedUnit[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [assigning, setAssigning] = useState(false);

  const dims = useMemo(() => {
    if (!spot) return null;
    if (!spot.max_length_ft && !spot.max_width_ft) return null;
    return [spot.max_length_ft ? `${spot.max_length_ft}' L` : null, spot.max_width_ft ? `${spot.max_width_ft}' W` : null]
      .filter(Boolean)
      .join(" × ");
  }, [spot]);

  function assignUnit(unitId: string, label: string) {
    if (!spot) return;
    startTransition(async () => {
      const result = await moveUnit(unitId, spot.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Assigned ${label} to ${spot.full_code}`);
      setAssigning(false);
      onOpenChange(false);
    });
  }

  if (!spot) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setAssigning(false); }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{locationLabel}</SheetTitle>
          <SheetDescription>{dims ?? "No size limit set"}</SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-4">
          {spot.occupant ? (
            <>
              <div className="rounded-lg border p-4">
                <p className="text-sm font-semibold">{spot.occupant.label}</p>
                <p className="text-sm text-muted-foreground">{spot.occupant.customer_name}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" render={<Link href={`/units/${spot.occupant.unit_id}`} />}>
                  <ExternalLink className="h-4 w-4" />
                  Open Unit
                </Button>
              </div>
            </>
          ) : assigning ? (
            <Command className="rounded-lg border">
              <CommandInput placeholder="Search unassigned units..." />
              <CommandList className="max-h-72">
                <CommandEmpty>No unassigned units.</CommandEmpty>
                <CommandGroup>
                  {unassignedUnits.map((u) => (
                    <CommandItem key={u.id} value={`${u.label} ${u.customer_name}`} onSelect={() => assignUnit(u.id, u.label)}>
                      <div className="flex flex-col">
                        <span>{u.label}</span>
                        <span className="text-xs text-muted-foreground">{u.customer_name}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">This spot is available.</p>
              <Button className="w-full" onClick={() => setAssigning(true)} disabled={isPending}>
                <ArrowRightLeft className="h-4 w-4" />
                Assign a Unit Here
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
