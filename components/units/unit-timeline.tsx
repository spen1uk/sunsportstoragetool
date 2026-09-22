import { format } from "date-fns";
import { ArrowRight, MapPin } from "lucide-react";

type HistoryRow = {
  id: string;
  moved_at: string;
  note: string | null;
  mover_full_name: string | null;
  from_label: string | null;
  to_label: string | null;
};

export function UnitTimeline({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No location history yet.</p>;
  }

  return (
    <ol className="space-y-4">
      {rows.map((row) => (
        <li key={row.id} className="flex gap-3">
          <div className="flex flex-col items-center pt-0.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MapPin className="h-3.5 w-3.5" />
            </span>
          </div>
          <div className="flex-1 pb-1">
            <p className="text-sm">
              {row.from_label ? (
                <>
                  <span className="font-medium">{row.from_label}</span>
                  <ArrowRight className="mx-1.5 inline h-3 w-3 text-muted-foreground" />
                </>
              ) : (
                <span className="text-muted-foreground">Arrived</span>
              )}
              <span className="font-medium">{row.to_label ?? "Left the facility"}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {row.mover_full_name ?? "Unknown"} · {format(new Date(row.moved_at), "MMM d, yyyy 'at' h:mm a")}
            </p>
            {row.note ? <p className="mt-1 text-xs italic text-muted-foreground">&ldquo;{row.note}&rdquo;</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
