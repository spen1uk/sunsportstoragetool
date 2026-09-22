"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { completePickup } from "@/lib/actions/pickups";

export function MarkPickedUpButton({ unitId }: { unitId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await completePickup(unitId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Marked as picked up");
          }
        })
      }
    >
      <PackageCheck className="h-4 w-4" />
      {isPending ? "Saving..." : "Picked Up"}
    </Button>
  );
}
