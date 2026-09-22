"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateEmployeeRole, setEmployeeActive } from "@/lib/actions/employees";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { AppRole } from "@/lib/utils/nav";

export function EmployeeRow({
  id,
  fullName,
  role,
  active,
  isSelf,
}: {
  id: string;
  fullName: string;
  role: AppRole;
  active: boolean;
  isSelf: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <li className="flex items-center justify-between gap-4 px-6 py-3">
      <div>
        <p className="text-sm font-medium">
          {fullName} {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">{active ? "Active" : "Deactivated"}</p>
      </div>
      <div className="flex items-center gap-2">
        <Select
          defaultValue={role}
          disabled={isPending || isSelf}
          onValueChange={(value) =>
            startTransition(async () => {
              try {
                await updateEmployeeRole(id, value as AppRole);
                toast.success("Role updated");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to update role");
              }
            })
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="employee">Employee</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending || isSelf}
          onClick={() =>
            startTransition(async () => {
              try {
                await setEmployeeActive(id, !active);
                toast.success(active ? "Account deactivated" : "Account reactivated");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to update account");
              }
            })
          }
        >
          {active ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
    </li>
  );
}
