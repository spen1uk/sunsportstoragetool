import {
  Armchair,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Cog,
  Gauge,
  Rotate3d,
  Scan,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { HotspotCategory, ViewIcon } from "@/lib/boat360/types";

export const VIEW_ICONS: Record<ViewIcon, LucideIcon> = {
  spin: Rotate3d,
  front: ArrowUpToLine,
  rear: ArrowDownToLine,
  left: ArrowLeftToLine,
  right: ArrowRightToLine,
  top: Scan,
  interior: Armchair,
  helm: Gauge,
  engine: Cog,
  trailer: Truck,
};

export const CATEGORY_LABEL: Record<HotspotCategory, string> = {
  engine: "Engine",
  helm: "Helm",
  bimini: "Bimini",
  seating: "Seating",
  electronics: "Electronics",
  stereo: "Stereo",
  "fish-finder": "Fish finder",
  trailer: "Trailer",
  prop: "Prop",
  "swim-ladder": "Swim ladder",
  storage: "Storage",
  bow: "Bow",
  stern: "Stern",
  feature: "Feature",
  condition: "Condition",
};
