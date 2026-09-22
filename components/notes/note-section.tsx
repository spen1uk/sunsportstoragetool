"use client";

import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { addUnitNote } from "@/lib/actions/units";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type NoteRow = {
  id: string;
  body: string;
  created_at: string;
  author_full_name: string | null;
};

export function NoteSection({
  entityType,
  entityId,
  notes,
}: {
  entityType: "unit" | "customer";
  entityId: string;
  notes: NoteRow[];
}) {
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!body.trim()) return;
    startTransition(async () => {
      await addUnitNote(entityType, entityId, body.trim());
      setBody("");
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note..."
          rows={2}
          className="flex-1"
        />
        <Button onClick={submit} disabled={isPending || !body.trim()} className="sm:self-end">
          {isPending ? "Adding..." : "Add Note"}
        </Button>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm">{note.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {note.author_full_name ?? "Unknown"} ·{" "}
                {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
