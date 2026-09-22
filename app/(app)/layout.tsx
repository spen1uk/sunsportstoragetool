import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { TopBar } from "@/components/layout/top-bar";
import type { AppRole } from "@/lib/utils/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, active")
    .eq("id", user.id)
    .single();

  if (!profile || !profile.active) {
    redirect("/login");
  }

  const role = profile.role as AppRole;

  return (
    <div className="min-h-screen bg-secondary/30">
      <Sidebar role={role} />
      <div className="md:pl-60 flex flex-col min-h-screen">
        <TopBar fullName={profile.full_name} role={role} />
        <main className="flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      </div>
      <MobileTabBar role={role} />
    </div>
  );
}
