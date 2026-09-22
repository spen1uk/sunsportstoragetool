import { QrScanner } from "@/components/units/qr-scanner";

export default function ScanPage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scan QR</h1>
        <p className="text-sm text-muted-foreground">
          Point your camera at a unit&rsquo;s QR label, or enter its storage ID below.
        </p>
      </div>
      <QrScanner />
    </div>
  );
}
