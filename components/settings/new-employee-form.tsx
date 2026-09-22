"use client";

import { useActionState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { createEmployee, type EmployeeFormState } from "@/lib/actions/employees";
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

const initialState: EmployeeFormState = { error: null };

export function NewEmployeeForm() {
  const [state, formAction, isPending] = useActionState(createEmployee, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !isPending && !state.error) {
      toast.success("Employee account created");
      formRef.current?.reset();
    }
    wasPending.current = isPending;
  }, [isPending, state.error]);

  return (
    <form ref={formRef} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="full_name">Full Name</Label>
        <Input id="full_name" name="full_name" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="role">Role</Label>
        <Select name="role" defaultValue="employee">
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="employee">Employee</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Temporary Password</Label>
        <Input id="password" name="password" type="text" minLength={8} required />
      </div>
      {state.error ? <p className="text-sm font-medium text-destructive sm:col-span-2">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="sm:col-span-2 sm:w-auto">
        {isPending ? "Creating..." : "Create Employee"}
      </Button>
    </form>
  );
}
