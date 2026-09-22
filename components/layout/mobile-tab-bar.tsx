"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LayoutDashboard, MapPinned, Menu, QrCode, ShipWheel } from "lucide-react";
import { cn } from "@/lib/utils";
import { navItemsForRole, type AppRole } from "@/lib/utils/nav";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const PRIMARY_TABS: { href: string; label: string; icon: typeof LayoutDashboard; primary?: boolean }[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/map", label: "Map", icon: MapPinned },
  { href: "/scan", label: "Scan", icon: QrCode, primary: true },
  { href: "/units", label: "Units", icon: ShipWheel },
];

export function MobileTabBar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const moreItems = navItemsForRole(role).filter(
    (item) => !PRIMARY_TABS.some((tab) => tab.href === item.href),
  );

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 flex h-16 items-stretch border-t bg-card safe-area-bottom">
      {PRIMARY_TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Icon = tab.icon;
        if (tab.primary) {
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex flex-1 flex-col items-center justify-center gap-1"
            >
              <span
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-full",
                  active ? "bg-primary text-primary-foreground" : "bg-primary/90 text-primary-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">{tab.label}</span>
            </Link>
          );
        }
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="h-5.5 w-5.5" />
            {tab.label}
          </Link>
        );
      })}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground">
          <Menu className="h-5.5 w-5.5" />
          More
        </SheetTrigger>
        <SheetContent side="bottom" className="pb-8">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-3 px-4">
            {moreItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-card p-5 text-sm font-medium"
                >
                  <Icon className="h-6 w-6 text-primary" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
