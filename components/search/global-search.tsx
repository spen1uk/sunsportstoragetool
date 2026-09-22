"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Ship, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

type SearchResult = {
  result_type: "unit" | "customer";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();

    debounceRef.current = setTimeout(async () => {
      if (trimmed.length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase.rpc("search_everything", { p_query: trimmed });
      setResults((data as SearchResult[] | null) ?? []);
      setLoading(false);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const units = results.filter((r) => r.result_type === "unit");
  const customers = results.filter((r) => r.result_type === "customer");

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="w-full max-w-sm justify-start gap-2 text-muted-foreground h-9"
      >
        <Search className="h-4 w-4" />
        Search boats, customers, spots...
        <kbd className="ml-auto hidden md:inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by customer, boat, HIN, registration, or spot..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!loading && query.trim().length >= 2 && results.length === 0 ? (
              <CommandEmpty>No results found.</CommandEmpty>
            ) : null}
            {units.length > 0 ? (
              <CommandGroup heading="Units">
                {units.map((r) => (
                  <CommandItem key={r.id} value={r.id} onSelect={() => go(r.href)}>
                    <Ship className="h-4 w-4 text-muted-foreground" />
                    <div className="flex flex-col">
                      <span>{r.title}</span>
                      {r.subtitle ? <span className="text-xs text-muted-foreground">{r.subtitle}</span> : null}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {customers.length > 0 ? (
              <CommandGroup heading="Customers">
                {customers.map((r) => (
                  <CommandItem key={r.id} value={r.id} onSelect={() => go(r.href)}>
                    <User className="h-4 w-4 text-muted-foreground" />
                    <div className="flex flex-col">
                      <span>{r.title}</span>
                      {r.subtitle ? <span className="text-xs text-muted-foreground">{r.subtitle}</span> : null}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
