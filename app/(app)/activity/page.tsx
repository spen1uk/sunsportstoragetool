import { redirect } from "next/navigation";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/utils/current-profile";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  unit_moved: "moved a unit",
  unit_created: "added a new unit",
  unit_edited: "edited a unit",
  unit_removed_from_storage: "removed a unit from storage",
  customer_created: "added a new customer",
  customer_edited: "edited a customer",
  status_changed: "changed a unit's status",
  service_completed: "completed a service",
  note_added: "added a note",
  photo_uploaded: "uploaded a photo",
};

export default async function ActivityPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.role === "employee") {
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("activity_logs")
    .select("id, action, entity_type, created_at, old_value, new_value, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity Log</h1>
        <p className="text-sm text-muted-foreground">Permanent audit trail of every important action.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {(rows ?? []).map((row) => {
              const who = (row.profiles as unknown as { full_name: string } | null)?.full_name ?? "Someone";
              const label = ACTION_LABELS[row.action] ?? row.action.replaceAll("_", " ");
              return (
                <li key={row.id} className="flex items-center justify-between gap-4 px-6 py-3">
                  <p className="text-sm">
                    <span className="font-medium">{who}</span> {label}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {format(new Date(row.created_at), "MMM d, yyyy h:mm a")}
                  </span>
                </li>
              );
            })}
            {(rows ?? []).length === 0 ? (
              <li className="px-6 py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
