import {
  AlertTriangle,
  Anchor,
  CalendarCheck,
  CalendarClock,
  CheckCircle,
  ClipboardList,
  type LucideIcon,
  Loader,
  LogOut,
  MapPinOff,
  PackageCheck,
  Sparkle,
  Sparkles,
  Sun,
  Warehouse,
  Wrench,
} from "lucide-react";

/** Maps the `color` column on unit_statuses to Tailwind badge classes. */
export const STATUS_COLOR_CLASSES: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700",
  blue: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900 dark:text-blue-200 dark:border-blue-800",
  amber: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200 dark:border-amber-800",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-200 dark:border-emerald-800",
  orange: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200 dark:border-orange-800",
  teal: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900 dark:text-teal-200 dark:border-teal-800",
  purple: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200 dark:border-purple-800",
  gray: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
  red: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200 dark:border-red-800",
};

const STATUS_ICONS: Record<string, LucideIcon> = {
  "calendar-clock": CalendarClock,
  anchor: Anchor,
  "clipboard-list": ClipboardList,
  "map-pin-off": MapPinOff,
  warehouse: Warehouse,
  wrench: Wrench,
  loader: Loader,
  "check-circle": CheckCircle,
  sparkles: Sparkles,
  sparkle: Sparkle,
  sun: Sun,
  "package-check": PackageCheck,
  "calendar-check": CalendarCheck,
  "log-out": LogOut,
};

export function getStatusIcon(icon: string): LucideIcon {
  return STATUS_ICONS[icon] ?? AlertTriangle;
}

/** Spot color-coding for the facility map (Section 10 of the spec). */
export const SPOT_STATE_CLASSES = {
  available: "bg-white border-gray-300 text-gray-500 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-400",
  occupied: "bg-blue-50 border-blue-400 text-blue-900 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-100",
  reserved: "bg-amber-50 border-amber-400 text-amber-900 dark:bg-amber-950 dark:border-amber-700 dark:text-amber-100",
  attention: "bg-orange-50 border-orange-400 text-orange-900 dark:bg-orange-950 dark:border-orange-700 dark:text-orange-100",
  pickup_soon: "bg-purple-50 border-purple-400 text-purple-900 dark:bg-purple-950 dark:border-purple-700 dark:text-purple-100",
  unavailable: "bg-red-50 border-red-400 text-red-900 dark:bg-red-950 dark:border-red-700 dark:text-red-100",
} as const;

export type SpotVisualState = keyof typeof SPOT_STATE_CLASSES;

const ATTENTION_STATUSES = new Set([
  "needs_service",
  "service_in_progress",
  "needs_detailing",
  "needs_spring_prep",
]);
const PICKUP_SOON_STATUSES = new Set(["ready_for_pickup", "pickup_scheduled"]);

/** Derives a spot's visual state from its admin status + occupant's status. */
export function getSpotVisualState(params: {
  adminStatus: "available" | "reserved" | "unavailable";
  occupantStatusCode: string | null;
}): SpotVisualState {
  const { adminStatus, occupantStatusCode } = params;

  if (adminStatus === "unavailable") return "unavailable";
  if (!occupantStatusCode) {
    return adminStatus === "reserved" ? "reserved" : "available";
  }
  if (PICKUP_SOON_STATUSES.has(occupantStatusCode)) return "pickup_soon";
  if (ATTENTION_STATUSES.has(occupantStatusCode)) return "attention";
  return "occupied";
}

export const STORAGE_TYPE_LABELS: Record<string, string> = {
  heated_indoor: "Heated Indoor",
  cold_indoor: "Cold Indoor",
  outdoor: "Outdoor",
  shrink_wrapped: "Shrink Wrapped",
  temporary: "Temporary",
  other: "Other",
};

export const UNIT_TYPE_LABELS: Record<string, string> = {
  boat: "Boat",
  pontoon: "Pontoon",
  tritoon: "Tritoon",
  wake_boat: "Wake Boat",
  fishing_boat: "Fishing Boat",
  pwc: "PWC",
  rv: "RV",
  camper: "Camper",
  trailer: "Trailer",
  other: "Other",
};

export const LOCATION_TYPE_LABELS: Record<string, string> = {
  storage_spot: "Storage Spot",
  intake_area: "Intake Area",
  service_bay: "Service Bay",
  detail_bay: "Detail Bay",
  outdoor_staging: "Outdoor Staging",
  spring_pickup_area: "Spring Pickup Area",
  delivery_area: "Delivery Area",
  temporary_location: "Temporary Location",
};
