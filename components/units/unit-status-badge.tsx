import { createElement } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getStatusIcon, STATUS_COLOR_CLASSES } from "@/lib/utils/status";

// createElement (not a `<Icon />` JSX tag bound to a local variable) — the
// icon is picked at runtime from a static map, not created during render,
// but the react-hooks/static-components rule can't tell the two apart from
// JSX syntax alone.
function StatusIcon({ icon, className }: { icon: string; className?: string }) {
  return createElement(getStatusIcon(icon), { className });
}

export function UnitStatusBadge({
  label,
  color,
  icon,
  className,
}: {
  label: string;
  color: string;
  icon: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium whitespace-nowrap", STATUS_COLOR_CLASSES[color], className)}
    >
      <StatusIcon icon={icon} className="h-3 w-3" />
      {label}
    </Badge>
  );
}
