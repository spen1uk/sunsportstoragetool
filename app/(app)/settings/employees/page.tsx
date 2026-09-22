import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewEmployeeForm } from "@/components/settings/new-employee-form";
import { EmployeeRow } from "@/components/settings/employee-row";

export const dynamic = "force-dynamic";

export default async function EmployeesSettingsPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") redirect("/dashboard");

  const supabase = await createClient();
  const { data: employees } = await supabase
    .from("profiles")
    .select("id, full_name, role, active")
    .order("full_name");

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="text-sm text-muted-foreground">Add employee logins and manage roles. There is no public sign-up.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Employee</CardTitle>
        </CardHeader>
        <CardContent>
          <NewEmployeeForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All Employees ({employees?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y">
            {(employees ?? []).map((e) => (
              <EmployeeRow key={e.id} id={e.id} fullName={e.full_name} role={e.role} active={e.active} isSelf={e.id === profile.id} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
