"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowRightLeft } from "lucide-react";
import { moveUnit } from "@/lib/actions/locations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { LOCATION_TYPE_LABELS, STORAGE_TYPE_LABELS } from "@/lib/utils/status";

export type AvailableLocation = {
  id: string;
  full_code: string;
  building_name: string | null;
  location_type: string;
  storage_type: string;
};

export function MoveUnitDialog({
  unitId,
  unitLabel,
  currentLocationLabel,
  availableLocations,
  triggerLabel = "Move",
}: {
  unitId: string;
  unitLabel: string;
  currentLocationLabel: string | null;
  availableLocations: AvailableLocation[];
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AvailableLocation | null>(null);
  const [isPending, startTransition] = useTransition();

  const grouped = useMemo(() => {
    const groups = new Map<string, AvailableLocation[]>();
    for (const loc of availableLocations) {
      const key = loc.building_name ?? LOCATION_TYPE_LABELS[loc.location_type] ?? "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(loc);
    }
    return groups;
  }, [availableLocations]);

  function confirmMove() {
    if (!selected) return;
    startTransition(async () => {
      const result = await moveUnit(unitId, selected.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Moved ${unitLabel} to ${selected.full_code}`);
      setOpen(false);
      setSelected(null);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSelected(null);
      }}
    >
      <DialogTrigger render={<Button variant="outline" className="gap-2" />}>
        <ArrowRightLeft className="h-4 w-4" />
        {triggerLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {unitLabel}</DialogTitle>
          <DialogDescription>
            {currentLocationLabel ? `Currently at ${currentLocationLabel}.` : "Not currently assigned a location."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <Command className="rounded-lg border">
            <CommandInput placeholder="Search spots, service bays, staging areas..." />
            <CommandList className="max-h-72">
              <CommandEmpty>No matching locations.</CommandEmpty>
              {Array.from(grouped.entries()).map(([groupName, locs]) => (
                <CommandGroup key={groupName} heading={groupName}>
                  {locs.map((loc) => (
                    <CommandItem key={loc.id} value={`${groupName} ${loc.full_code}`} onSelect={() => setSelected(loc)}>
                      <span className="flex-1">{loc.full_code}</span>
                      <span className="text-xs text-muted-foreground">
                        {STORAGE_TYPE_LABELS[loc.storage_type] ?? loc.storage_type}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            Move <span className="font-medium">{unitLabel}</span>
            {currentLocationLabel ? <> from <span className="font-medium">{currentLocationLabel}</span></> : null} to{" "}
            <span className="font-medium">{selected.full_code}</span>?
          </div>
        )}

        <DialogFooter>
          {selected ? (
            <>
              <Button variant="ghost" onClick={() => setSelected(null)} disabled={isPending}>
                Back
              </Button>
              <Button onClick={confirmMove} disabled={isPending}>
                {isPending ? "Moving..." : "Confirm Move"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
