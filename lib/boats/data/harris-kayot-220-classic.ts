// Boat data for the 2000 Harris-Kayot 220 Classic.
//
// This file is DATA ONLY — the viewer engine knows nothing about this boat.
// Photos/crops come from the generated media index; the 360° spin is
// currently a generated PLACEHOLDER sequence (see spin.placeholder) until a
// real 36-frame walk-around is shot. Hotspot positions on the placeholder
// spin come from the generator's anchor tracks; once real frames exist they
// get re-placed (by hand today, via the admin hotspot editor in Phase 2).
//
// Unknown facts are `null` so the UI shows "To be confirmed" rather than a
// guess.

import type { BoatViewerConfig, Hotspot, MediaAsset, SpinSet } from "@/lib/boat360/types";
import media from "../generated/harris-kayot-220-classic.media.json";
import placeholderSpin from "../generated/harris-kayot-220-classic.placeholder-spin.json";

type Track = { visibleFrames: number[]; positions: Record<string, { x: number; y: number }> };
const tracks = placeholderSpin.anchorTracks as Record<string, Track>;

/** Spin placement for a hotspot, from the placeholder generator's anchor track. */
function onSpin(track: keyof typeof placeholderSpin.anchorTracks): Pick<Hotspot, "visibleFrames" | "positions"> {
  return { visibleFrames: tracks[track].visibleFrames, positions: tracks[track].positions };
}

const spin: SpinSet = {
  frameCount: placeholderSpin.frameCount,
  width: placeholderSpin.width,
  height: placeholderSpin.height,
  padLength: placeholderSpin.padLength,
  tiers: placeholderSpin.tiers as SpinSet["tiers"],
  initialFrame: 10,
  angles: { front: 1, starboard: 10, rear: 19, port: 28 },
  placeholder: {
    notice: "Placeholder 360° renders — the real 36-photo walk-around for this boat hasn't been shot yet.",
  },
  sensitivity: 1,
  inertia: true,
};

const hotspots: Hotspot[] = [
  {
    id: "engine",
    title: "Yamaha 100 HP Four-Stroke",
    category: "engine",
    description: "Yamaha 100 horsepower four-stroke outboard.",
    bullets: ["100 HP", "Four-stroke", "Outboard", "Yamaha", "Aluminum 3-blade propeller (per photos)"],
    galleryId: "engine",
    detail: "engine",
    videos: [{ id: "cold-start", title: "Engine cold start", placeholder: true }],
    ...onSpin("engine"),
  },
  {
    id: "helm",
    title: "Helm Console",
    category: "helm",
    description: "Starboard helm with steering wheel, windscreen, cup holders and dash-mounted speaker.",
    galleryId: "helm",
    ...onSpin("helm"),
  },
  {
    id: "bimini",
    title: "Navy Bimini Top",
    category: "bimini",
    description: "Navy bimini top on an aluminum frame, shading the aft seating area.",
    galleryId: "exterior",
    galleryImageId: "starboard",
    ...onSpin("bimini"),
  },
  {
    id: "seating",
    title: "Lounge Seating & Captain's Chairs",
    category: "seating",
    description: "Beige and navy upholstery throughout: aft L-lounge, side benches, and two captain's chairs with a pedestal table.",
    galleryId: "interior",
    ...onSpin("seating"),
  },
  {
    id: "bow",
    title: "Bow & Pontoon Noses",
    category: "bow",
    description: "Bow deck with gate entry, pontoon nose cones, and trailer winch stand.",
    galleryId: "bow",
    ...onSpin("bow"),
  },
  {
    id: "trailer",
    title: "Mid America Tandem-Axle Trailer",
    category: "trailer",
    description: "Tandem-axle pontoon trailer (Mid America decal visible).",
    galleryId: "trailer",
    detail: "trailer",
    ...onSpin("trailer"),
  },
  {
    id: "pontoon-finish",
    title: "Pontoon Tube Finish",
    category: "condition",
    conditionType: "oxidation",
    needsReview: true,
    description:
      "Light surface staining / oxidation is visible on the pontoon tubes in the photos. Sun Sport will confirm the condition during inspection.",
    galleryId: "condition",
    galleryImageId: "pontoons",
    ...onSpin("pontoons"),
  },
  {
    id: "upholstery",
    title: "Bench Upholstery",
    category: "condition",
    conditionType: "upholstery-wear",
    needsReview: true,
    description: "Some marks and wear are visible on the starboard bench vinyl. To be confirmed during inspection.",
    galleryId: "condition",
    galleryImageId: "upholstery",
  },
];

const config: BoatViewerConfig = {
  boatId: "harris-kayot-220-classic-2000",
  slug: "harris-kayot-220-classic",
  year: 2000,
  make: "Harris-Kayot",
  model: "220 Classic",
  highlights: [
    { label: "Engine", value: "Yamaha 100 HP Four-Stroke" },
    { label: "Length", value: "22'" },
    { label: "Capacity", value: "14 passengers" },
    { label: "Trailer", value: "Tandem axle" },
  ],
  engine: {
    manufacturer: "Yamaha",
    model: null,
    horsepower: 100,
    hours: null,
    fuelType: "Gasoline",
    engineType: "Four-stroke outboard",
    serialNumber: null,
    showSerialNumber: false,
    inspectionStatus: null,
  },
  trailer: {
    year: null,
    manufacturer: "Mid America",
    axles: "Tandem",
    support: null,
    brakes: null,
    tires: null,
    condition: null,
    included: null,
  },
  spin,
  assets: media.assets as unknown as Record<string, MediaAsset>,
  galleries: [
    {
      id: "exterior",
      label: "Exterior",
      category: "exterior",
      images: [
        { id: "starboard", assetId: "starboard-side", caption: "Right side (starboard)", label: "Right side" },
        { id: "port", assetId: "port-side", caption: "Left side (port)", label: "Left side" },
        {
          id: "rear",
          assetId: "stern-engine",
          caption: "Rear view",
          label: "Rear view",
          hotspots: [{ hotspotId: "engine", x: 50, y: 22 }],
        },
        { id: "front", assetId: "front-view-needed", caption: "Front view — photo coming soon", label: "Front view" },
      ],
    },
    {
      id: "overhead",
      label: "Top View",
      category: "overhead",
      images: [
        {
          id: "overhead",
          assetId: "interior-overhead",
          caption: "Deck layout from above, looking aft",
          label: "Top view",
          hotspots: [
            { hotspotId: "helm", x: 30, y: 22 },
            { hotspotId: "seating", x: 83, y: 45 },
          ],
        },
      ],
    },
    {
      id: "interior",
      label: "Interior",
      category: "interior",
      images: [
        {
          id: "overview",
          assetId: "interior-overhead",
          caption: "Interior overview",
          label: "Cockpit",
          hotspots: [
            { hotspotId: "helm", x: 30, y: 22 },
            { hotspotId: "upholstery", x: 13, y: 55 },
          ],
        },
        { id: "helm", assetId: "helm-console", caption: "Helm console", label: "Helm" },
        { id: "aft-lounge", assetId: "aft-lounge", caption: "Aft L-lounge", label: "Rear seating" },
        { id: "captains-chairs", assetId: "captains-chairs", caption: "Captain's chairs", label: "Passenger seating" },
        { id: "bench", assetId: "bow-bench", caption: "Starboard bench", label: "Bench seating" },
        { id: "table", assetId: "deck-table", caption: "Pedestal table and carpet", label: "Flooring" },
        { id: "storage", assetId: "storage-needed", caption: "Storage — photos coming soon", label: "Storage" },
        { id: "electronics", assetId: "electronics-needed", caption: "Electronics — photos coming soon", label: "Electronics" },
      ],
    },
    {
      id: "helm",
      label: "Helm",
      category: "helm",
      images: [
        { id: "console", assetId: "helm-console", caption: "Helm console, wheel and windscreen", label: "Helm" },
        { id: "context", assetId: "interior-overhead", caption: "Helm position on deck", label: "Helm" },
        { id: "gauges", assetId: "helm-closeup-needed", caption: "Gauges close-up — photo coming soon", label: "Helm" },
      ],
    },
    {
      id: "engine",
      label: "Engine",
      category: "engine",
      detail: "engine",
      images: [
        {
          id: "stern",
          assetId: "stern-engine",
          caption: "Yamaha 100 four-stroke outboard",
          label: "Engine",
          hotspots: [{ hotspotId: "engine", x: 50, y: 22 }],
        },
        { id: "cowling", assetId: "engine-cowling", caption: "Engine cowling", label: "Engine" },
        { id: "lower-unit", assetId: "engine-lower-unit", caption: "Lower unit and propeller", label: "Prop" },
      ],
    },
    {
      id: "bow",
      label: "Bow",
      category: "bow",
      images: [
        { id: "starboard", assetId: "bow-starboard", caption: "Bow from starboard", label: "Bow" },
        { id: "port", assetId: "bow-port", caption: "Bow from port", label: "Bow" },
      ],
    },
    {
      id: "stern",
      label: "Stern",
      category: "stern",
      images: [{ id: "stern", assetId: "stern-engine", caption: "Stern", label: "Stern", hotspots: [{ hotspotId: "engine", x: 50, y: 22 }] }],
    },
    {
      id: "trailer",
      label: "Trailer",
      category: "trailer",
      detail: "trailer",
      images: [
        { id: "axles", assetId: "trailer-axles", caption: "Tandem axles", label: "Trailer" },
        { id: "tongue", assetId: "trailer-tongue", caption: "Tongue and winch stand", label: "Trailer" },
        { id: "side", assetId: "starboard-side", caption: "Boat on trailer", label: "Trailer", hotspots: [{ hotspotId: "trailer", x: 26, y: 70 }] },
      ],
    },
    {
      id: "condition",
      label: "Condition",
      category: "condition",
      images: [
        { id: "pontoons", assetId: "pontoon-surface", caption: "Pontoon tube surface — see condition note", label: "Condition" },
        { id: "upholstery", assetId: "upholstery-bench", caption: "Bench upholstery — see condition note", label: "Condition" },
      ],
    },
  ],
  views: [
    { id: "spin", label: "360° View", icon: "spin", action: { type: "spin" } },
    { id: "front", label: "Front", icon: "front", action: { type: "angle", angle: "front" } },
    { id: "rear", label: "Rear", icon: "rear", action: { type: "angle", angle: "rear" } },
    { id: "left", label: "Left Side", icon: "left", action: { type: "angle", angle: "port" } },
    { id: "right", label: "Right Side", icon: "right", action: { type: "angle", angle: "starboard" } },
    { id: "top", label: "Top View", icon: "top", action: { type: "gallery", galleryId: "overhead" } },
    { id: "interior", label: "Interior", icon: "interior", action: { type: "gallery", galleryId: "interior" } },
    { id: "helm", label: "Helm", icon: "helm", action: { type: "gallery", galleryId: "helm" } },
    { id: "engine", label: "Engine", icon: "engine", action: { type: "gallery", galleryId: "engine" } },
    { id: "trailer", label: "Trailer", icon: "trailer", action: { type: "gallery", galleryId: "trailer" } },
  ],
  hotspots,
  links: {
    details: "#boat-details",
    financing: "#financing",
    tradeIn: "#trade-in",
    contact: "#contact",
  },
};

export default config;
