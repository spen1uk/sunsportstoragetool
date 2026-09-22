"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Subscribes to Postgres changes on the given tables and refreshes the
 * current route's server-fetched data when anything changes — this is what
 * makes "multiple employees logged in at once see the same live state"
 * actually true, instead of requiring a manual page reload.
 *
 * Renders nothing. Mount one per page that shows data from these tables.
 */
export function RealtimeRefresher({ tables }: { tables: string[] }) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`live-${tables.join("-")}`);

    for (const table of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => router.refresh(), 300);
      });
    }

    channel.subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(",")]);

  return null;
}
