import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile();

  const { data: customersRaw } = await supabase
    .from("customers")
    .select("id, first_name, last_name, phone, email, city, state, units(id)")
    .order("last_name", { ascending: true });

  const customers = customersRaw as unknown as
    | {
        id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        email: string | null;
        city: string | null;
        state: string | null;
        units: { id: string }[];
      }[]
    | null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">{customers?.length ?? 0} customers on file.</p>
        </div>
        {profile && canManage(profile.role) ? (
          <Button nativeButton={false} render={<Link href="/customers/new" />}>
            <Plus className="h-4 w-4" />
            New Customer
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {(customers ?? []).map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent">
                  <div>
                    <p className="text-sm font-medium">
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[c.phone, c.email].filter(Boolean).join(" · ") || "No contact info"}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0">
                    <p>{c.units?.length ?? 0} unit(s)</p>
                    <p>{[c.city, c.state].filter(Boolean).join(", ")}</p>
                  </div>
                </Link>
              </li>
            ))}
            {(customers ?? []).length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">No customers yet.</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
