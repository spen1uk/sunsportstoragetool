"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

// BarcodeDetector isn't in TS's DOM lib yet on every target; declare loosely.
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => {
      detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
    };
  }
}

export function QrScanner() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manualId, setManualId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cameraSupported] = useState(() => typeof window !== "undefined" && "BarcodeDetector" in window);
  const [scanning, setScanning] = useState(false);

  const handleScannedValue = useCallback(
    (value: string) => {
      setScanning(false);
      try {
        const url = new URL(value);
        router.push(url.pathname);
      } catch {
        // Not a URL — ignore, employee can still use manual entry.
      }
    },
    [router],
  );

  useEffect(() => {
    if (!scanning || !cameraSupported) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const detector = new window.BarcodeDetector!({ formats: ["qr_code"] });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              const value = codes[0].rawValue;
              handleScannedValue(value);
              return;
            }
          } catch {
            // ignore transient detection errors
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError("Couldn't access the camera. Enter the storage ID below instead.");
        setScanning(false);
      }
    }

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning, cameraSupported, handleScannedValue]);

  async function handleManualLookup() {
    setError(null);
    const trimmed = manualId.trim();
    if (!trimmed) return;

    const supabase = createClient();
    const { data } = await supabase
      .from("units")
      .select("id")
      .or(`internal_storage_id.eq.${trimmed},qr_token.eq.${trimmed}`)
      .maybeSingle();

    if (!data) {
      setError("No unit found with that storage ID.");
      return;
    }
    router.push(`/units/${data.id}`);
  }

  return (
    <div className="space-y-4">
      {cameraSupported ? (
        <Card>
          <CardContent className="space-y-3">
            {scanning ? (
              <video ref={videoRef} className="w-full rounded-lg bg-black aspect-square object-cover" muted playsInline />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-muted">
                <Camera className="h-10 w-10 text-muted-foreground" />
              </div>
            )}
            <Button className="w-full h-12 text-base" onClick={() => setScanning((s) => !s)}>
              {scanning ? "Stop Camera" : "Start Camera"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">Or enter the storage ID</p>
          <div className="flex gap-2">
            <Input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="SSM-2026-00001"
              className="h-12 text-base"
              onKeyDown={(e) => e.key === "Enter" && handleManualLookup()}
            />
            <Button size="icon" className="h-12 w-12 shrink-0" onClick={handleManualLookup}>
              <Search className="h-5 w-5" />
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
