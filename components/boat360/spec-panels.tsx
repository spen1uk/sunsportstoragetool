import { ArrowRight, Cog, Truck } from "lucide-react";
import type { EngineSpec, SpecValue, TrailerSpec } from "@/lib/boat360/types";

const TBC = "To be confirmed";

function SpecGrid({ rows }: { rows: SpecValue[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{r.label}</dt>
          <dd className={r.value ? "font-semibold text-brand-navy" : "italic text-slate-400"}>{r.value ?? TBC}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EngineSpecPanel({ engine }: { engine: EngineSpec }) {
  const rows: SpecValue[] = [
    { label: "Manufacturer", value: engine.manufacturer },
    { label: "Model", value: engine.model },
    { label: "Horsepower", value: `${engine.horsepower} HP` },
    { label: "Hours", value: engine.hours != null ? engine.hours.toLocaleString() : null },
    { label: "Fuel type", value: engine.fuelType },
    { label: "Engine type", value: engine.engineType },
    { label: "Inspection", value: engine.inspectionStatus },
  ];
  if (engine.showSerialNumber) rows.push({ label: "Serial number", value: engine.serialNumber ?? null });
  return (
    <section aria-label="Engine details" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-brand-navy">
        <Cog className="size-4 text-brand-blue" /> {engine.manufacturer} {engine.horsepower} HP
      </h3>
      <SpecGrid rows={rows} />
      {engine.notes && <p className="mt-3 text-sm text-slate-600">{engine.notes}</p>}
    </section>
  );
}

const INCLUDED: Record<NonNullable<TrailerSpec["included"]>, string> = {
  included: "Included",
  "available-separately": "Available separately",
  "not-available": "Not available",
};

export function TrailerSpecPanel({ trailer }: { trailer: TrailerSpec }) {
  return (
    <section aria-label="Trailer details" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-brand-navy">
        <Truck className="size-4 text-brand-blue" /> Trailer
      </h3>
      <SpecGrid
        rows={[
          { label: "Year", value: trailer.year ? String(trailer.year) : null },
          { label: "Manufacturer", value: trailer.manufacturer },
          { label: "Axles", value: trailer.axles },
          { label: "Bunk / roller", value: trailer.support },
          { label: "Brakes", value: trailer.brakes },
          { label: "Tires", value: trailer.tires },
          { label: "Condition", value: trailer.condition },
          {
            label: "Availability",
            value: trailer.included
              ? `${INCLUDED[trailer.included]}${trailer.included === "available-separately" && trailer.price ? ` · ${trailer.price}` : ""}`
              : null,
          },
        ]}
      />
      {trailer.link && (
        <a
          href={trailer.link}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-blue hover:underline focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:outline-none"
        >
          More pontoon trailers <ArrowRight className="size-4" aria-hidden />
        </a>
      )}
    </section>
  );
}
