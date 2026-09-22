import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Users } from "lucide-react";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") redirect("/dashboard");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Admin-only configuration.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/settings/employees">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Users className="h-5 w-5" />
              </div>
              <CardTitle className="text-base">Employees</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Add logins, manage roles and access.</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/settings/facility">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <CardTitle className="text-base">Facility Layout</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Buildings, sections, and storage spots.</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
