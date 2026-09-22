import {
  Activity,
  Calendar,
  LayoutDashboard,
  MapPinned,
  Settings,
  ShipWheel,
  Truck,
  Users,
  Wrench,
} from "lucide-react";

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "manager", "employee"] },
  { href: "/map", label: "Facility Map", icon: MapPinned, roles: ["admin", "manager", "employee"] },
  { href: "/units", label: "Stored Units", icon: ShipWheel, roles: ["admin", "manager", "employee"] },
  { href: "/customers", label: "Customers", icon: Users, roles: ["admin", "manager", "employee"] },
  { href: "/arrivals", label: "Arrivals", icon: Truck, roles: ["admin", "manager", "employee"] },
  { href: "/service", label: "Service", icon: Wrench, roles: ["admin", "manager", "employee"] },
  { href: "/pickups", label: "Pickups", icon: Calendar, roles: ["admin", "manager", "employee"] },
  { href: "/activity", label: "Activity", icon: Activity, roles: ["admin", "manager"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
] as const;

export type AppRole = "admin" | "manager" | "employee";

export function navItemsForRole(role: AppRole) {
  return NAV_ITEMS.filter((item) => (item.roles as readonly string[]).includes(role));
}
