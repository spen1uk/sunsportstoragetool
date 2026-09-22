"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateUnitStatus } from "@/lib/actions/units";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function StatusSelect({
  unitId,
  currentStatus,
  statuses,
}: {
  unitId: string;
  currentStatus: string;
  statuses: { code: string; label: string }[];
}) {
  const [isPending, startTransition] = useTransition();

  function onChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      try {
        await updateUnitStatus(unitId, value);
        toast.success("Status updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update status");
      }
    });
  }

  return (
    <Select defaultValue={currentStatus} onValueChange={onChange} disabled={isPending}>
      <SelectTrigger className="w-full sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {statuses.map((s) => (
          <SelectItem key={s.code} value={s.code}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
