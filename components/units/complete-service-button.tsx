"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { completeService } from "@/lib/actions/services";

export function CompleteServiceButton({ serviceId, unitId }: { serviceId: string; unitId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          try {
            await completeService(serviceId, unitId);
            toast.success("Service marked complete");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update service");
          }
        })
      }
    >
      <CheckCircle className="h-4 w-4" />
      {isPending ? "Saving..." : "Mark Complete"}
    </Button>
  );
}
