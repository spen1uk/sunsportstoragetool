import { formatDistanceToNow } from "date-fns";

type ActivityRow = {
  id: string;
  action: string;
  entity_type: string;
  created_at: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  employee_full_name: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  unit_moved: "moved a unit",
  unit_created: "added a new unit",
  unit_removed_from_storage: "removed a unit from storage",
  customer_created: "added a new customer",
  customer_edited: "edited a customer",
  status_changed: "changed a unit's status",
  service_completed: "completed a service",
  note_added: "added a note",
  photo_uploaded: "uploaded a photo",
};

function describe(row: ActivityRow): string {
  const who = row.employee_full_name ?? "Someone";
  const label = ACTION_LABELS[row.action] ?? row.action.replaceAll("_", " ");

  if (row.action === "status_changed") {
    const to = (row.new_value?.status_code as string | undefined)?.replaceAll("_", " ");
    return `${who} ${label}${to ? ` to "${to}"` : ""}`;
  }
  return `${who} ${label}`;
}

export function ActivityFeed({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No recent activity yet.</p>;
  }

  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start justify-between gap-4 py-3">
          <p className="text-sm">{describe(row)}</p>
          <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
            {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
          </span>
        </li>
      ))}
    </ul>
  );
}
