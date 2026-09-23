"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Camera, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { recordPhoto, deletePhoto } from "@/lib/actions/photos";
import { BUCKET_FOR_ENTITY } from "@/lib/utils/storage-buckets";
import type { NotableEntity } from "@/lib/types/database";

export type PhotoWithUrl = {
  id: string;
  url: string;
  caption: string | null;
};

export function PhotoGallery({
  entityType,
  entityId,
  photos,
  canDelete = false,
}: {
  entityType: NotableEntity;
  entityId: string;
  photos: PhotoWithUrl[];
  canDelete?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    const supabase = createClient();
    const bucket = BUCKET_FOR_ENTITY[entityType];

    for (const file of Array.from(files)) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${entityType}/${entityId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      });

      if (uploadError) {
        toast.error(`Failed to upload ${file.name}: ${uploadError.message}`);
        continue;
      }

      try {
        await recordPhoto(entityType, entityId, path);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save photo record");
      }
    }

    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    toast.success("Photo(s) uploaded");
  }

  return (
    <div className="space-y-4">
      <div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <Button
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Camera className="h-4 w-4" />
          {uploading ? "Uploading..." : "Add Photo"}
        </Button>
      </div>

      {photos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-lg border">
              <Image src={photo.url} alt={photo.caption ?? "Unit photo"} fill className="object-cover" unoptimized />
              {canDelete ? (
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await deletePhoto(photo.id, entityType, entityId);
                    })
                  }
                  disabled={isPending}
                  className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
