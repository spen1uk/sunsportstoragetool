// Boat data for the 2000 Harris-Kayot 220 Classic.
//
// This file is DATA ONLY — the viewer engine knows nothing about this boat.
// Photos come from the generated media index (originals in the Sun Sport
// Google Drive folder, see media-source/…/manifest.json). The spin is 48
// real frames taken from the walkaround video (scripts/boat360/video-to-spin.mjs):
// it covers the port side, stern and starboard side but not the bow, so it
// is a partial arc (loop: false) with no FRONT angle. Hotspot keyframes on
// the spin and pins on photos were placed by hand.
//
// Facts come from Sun Sport or are visible in the photos (capacity plate,
// fuel fill, electronics). Unknowns stay `null` → "To be confirmed".

import type { BoatViewerConfig, Hotspot, MediaAsset, SpinSet, VideoRef } from "@/lib/boat360/types";
import media from "../generated/harris-kayot-220-classic.media.json";

type XY = [number, number];

/**
 * Spin placement for a hotspot: the frame ranges where it's visible and
 * hand-placed keyframes (percent x/y). Frames between keys are interpolated,
 * so each visible range needs a key at both ends.
 */
function onSpin(ranges: [number, number][], keys: Record<number, XY>): Pick<Hotspot, "visibleFrames" | "positions"> {
  const visibleFrames = ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
  const positions = Object.fromEntries(Object.entries(keys).map(([f, [x, y]]) => [f, { x, y }]));
  return { visibleFrames, positions };
}

const generatedVideos =
  (media as { videos?: Record<string, { src: string; sources: VideoRef["sources"]; poster: string }> }).videos ?? {};

const walkaround: VideoRef = {
  id: "walkaround",
  title: "Exterior walkaround",
  kind: "file",
  src: generatedVideos.walkaround?.src,
  sources: generatedVideos.walkaround?.sources,
  poster: generatedVideos.walkaround?.poster,
  placeholder: !generatedVideos.walkaround,
};
const spin: SpinSet = {
  frameCount: media.spin.frameCount,
  width: media.spin.width,
  height: media.spin.height,
  padLength: media.spin.padLength,
  tiers: media.spin.tiers as SpinSet["tiers"],
  initialFrame: 1,
  // Frame 1 = wide port side; the walk goes round the stern to the starboard bow.
  angles: { port: 1, rear: 25, starboard: 42 },
  loop: false,
  caption: "Real walkaround footage · port side → stern → starboard side",
  // The arc is ~220° over 48 frames, so ~1.5 stage widths cover it.
  sensitivity: 0.7,
  inertia: true,
};

const hotspots: Hotspot[] = [
  {
    id: "engine",
    title: "Yamaha 100 HP Four-Stroke",
    category: "engine",
    description: "Yamaha 100 horsepower four-stroke outboard with a binnacle-mount Yamaha throttle/shift control at the helm.",
    bullets: ["100 HP", "Four-stroke", "Outboard", "Yamaha", "550 hours", "Three-blade aluminum propeller (per photos)"],
    galleryId: "engine",
    detail: "engine",
    videos: [walkaround],
    ...onSpin([[16, 34]], { 16: [86, 17], 17: [80, 17], 21: [62, 20], 25: [40, 15], 29: [30, 18], 33: [15, 22], 34: [10, 24] }),
  },
  {
    id: "helm",
    title: "Helm Console",
    category: "helm",
    description: "Starboard helm with a woodgrain dash, sport steering wheel, windscreen and helm seat.",
    bullets: [
      "Speedometer, tachometer and additional gauges",
      "Lighted switch panel with horn",
      "Key ignition with lanyard",
      "Yamaha binnacle throttle/shift",
      "Humminbird fish finder and Sony stereo",
    ],
    galleryId: "helm",
    ...onSpin([[1, 5], [40, 44]], { 1: [54, 28], 3: [58, 25], 5: [66, 14], 40: [34, 15], 41: [30, 15], 44: [15, 15] }),
  },
  {
    id: "fish-finder",
    title: "Humminbird PiranhaMAX 4",
    category: "fish-finder",
    description: "Humminbird PiranhaMAX 4 fish finder mounted at the helm.",
    galleryId: "electronics",
    galleryImageId: "fish-finder",
  },
  {
    id: "stereo",
    title: "Sony Bluetooth Stereo",
    category: "stereo",
    description: "Sony stereo head unit with Bluetooth, plus Kicker marine speakers.",
    galleryId: "electronics",
    galleryImageId: "stereo",
  },
  {
    id: "bimini",
    title: "Navy Bimini Top",
    category: "bimini",
    description: "Navy bimini top on an aluminum frame, shading the aft seating area.",
    galleryId: "exterior",
    galleryImageId: "starboard",
    ...onSpin([[1, 3]], { 1: [82, 5], 3: [76, 6] }),
  },
  {
    id: "seating",
    title: "Lounge Seating & Captain's Chairs",
    category: "seating",
    description:
      "Beige and navy upholstery throughout: aft L-lounge, side benches, a helm seat and two captain's chairs, with pedestal tables.",
    galleryId: "interior",
    ...onSpin([[1, 10]], { 1: [26, 32], 3: [28, 27], 5: [32, 16], 7: [30, 16], 9: [30, 21], 10: [30, 21] }),
  },
  {
    id: "storage",
    title: "Under-Seat Storage",
    category: "storage",
    description: "Storage compartments under the lounge seats and in the helm console.",
    galleryId: "storage",
  },
  {
    id: "bow",
    title: "Bow & Navigation Lights",
    category: "bow",
    description: "Bow deck with entry gate, red/green navigation lights and docking lights in the bow caps.",
    galleryId: "bow",
    ...onSpin([[1, 3], [44, 48]], { 1: [7, 45], 3: [5, 46], 44: [88, 42], 46: [78, 40], 48: [56, 40] }),
  },
  {
    id: "trailer",
    title: "2026 Mid America Bunk Trailer",
    category: "trailer",
    description:
      "2026 Mid America Trailers tandem-axle bunk trailer with carpeted bunks, manual winch and swing-away jack. No brakes. Available for an additional $4,000.",
    bullets: ["2026 model year", "Tandem axle, carpeted bunks", "No brakes", "Additional $4,000"],
    galleryId: "trailer",
    detail: "trailer",
    ...onSpin([[1, 7], [39, 45]], { 1: [70, 75], 3: [78, 77], 5: [88, 82], 7: [93, 90], 39: [28, 93], 41: [20, 92], 44: [11, 89], 45: [6, 88] }),
  },
  {
    id: "pontoon-finish",
    title: "Pontoon Tube Finish",
    category: "condition",
    conditionType: "oxidation",
    needsReview: true,
    description:
      "Surface oxidation and staining are visible on the aluminum pontoon tubes in the photos. Sun Sport will confirm the condition during inspection.",
    galleryId: "condition",
    galleryImageId: "pontoons",
    ...onSpin([[4, 13], [36, 43]], { 4: [40, 62], 5: [40, 62], 9: [50, 67], 13: [50, 67], 36: [50, 65], 37: [50, 65], 41: [50, 66], 43: [50, 66] }),
  },
  {
    id: "deck-underside",
    title: "Deck Underside",
    category: "condition",
    conditionType: "other",
    needsReview: true,
    description: "White spotting/residue is visible on the underside of the deck between the pontoons. To be confirmed during inspection.",
    galleryId: "condition",
    galleryImageId: "underside",
  },
];

/** Gallery image shorthand: id + asset id + caption (+ optional label/hotspot pins). */
const img = (id: string, assetId: string, caption: string, label?: string, hotspots?: { hotspotId: string; x: number; y: number }[]) => ({
  id,
  assetId,
  caption,
  label,
  hotspots,
});

const config: BoatViewerConfig = {
  boatId: "harris-kayot-220-classic-2000",
  slug: "harris-kayot-220-classic",
  year: 2000,
  make: "Harris-Kayot",
  model: "220 Classic",
  highlights: [
    { label: "Type", value: "Pontoon" },
    { label: "Engine", value: "Yamaha 100 HP Four-Stroke" },
    { label: "Length", value: "22'" },
    { label: "Capacity", value: "14 persons / 1,925 lbs" },
    { label: "Max HP", value: "130" },
    { label: "Engine hours", value: "550" },
    { label: "Trailer", value: "2026 Mid America bunk (+$4,000)" },
  ],
  engine: {
    manufacturer: "Yamaha",
    model: "100 HP Four-Stroke Outboard",
    horsepower: 100,
    hours: 550,
    fuelType: "Gasoline",
    engineType: "Four-stroke outboard",
    serialNumber: null,
    showSerialNumber: false,
    inspectionStatus: null,
    notes: "Fuel tank sits in an under-seat compartment at the stern. Boat is rated for up to 130 HP (capacity plate).",
  },
  trailer: {
    year: 2026,
    manufacturer: "Mid America Trailers",
    axles: "Tandem",
    support: "Bunk (carpeted)",
    brakes: "None",
    tires: "Kenda Loadstar",
    condition: null,
    included: "available-separately",
    price: "$4,000",
    link: "https://www.sunsportmarineinc.com/pontoon-trailers",
  },
  spin,
  assets: media.assets as unknown as Record<string, MediaAsset>,
  videos: [walkaround],
  galleries: [
    {
      id: "exterior",
      label: "Exterior",
      category: "exterior",
      images: [
        img("starboard", "starboard-side", "Right side (starboard)", "Right side", [
          { hotspotId: "bimini", x: 18, y: 22 },
          { hotspotId: "helm", x: 33, y: 39 },
          { hotspotId: "bow", x: 85, y: 52 },
          { hotspotId: "trailer", x: 26, y: 71 },
          { hotspotId: "pontoon-finish", x: 42, y: 58 },
        ]),
        img("port", "port-side", "Left side (port)", "Left side", [
          { hotspotId: "bimini", x: 76, y: 17 },
          { hotspotId: "seating", x: 30, y: 37 },
          { hotspotId: "trailer", x: 62, y: 70 },
          { hotspotId: "pontoon-finish", x: 52, y: 56 },
        ]),
        img("rear", "stern-engine", "Rear view", "Rear view", [{ hotspotId: "engine", x: 51, y: 22 }]),
        img("front-quarter", "front-quarter", "Front three-quarter view", "Front ¾"),
        img("port-bow", "port-bow-quarter", "Port bow quarter", "Bow ¾"),
        img("stern-quarter", "stern-quarter", "Starboard stern quarter", "Stern ¾"),
        img("street-starboard", "street-starboard", "Starboard side, bimini up", "Right side"),
        img("street-port", "street-port", "Port side, bimini up", "Left side"),
        img("street-stern", "street-stern", "Stern", "Rear view"),
        img("model-script", "model-script", "220 Classic script", "Details"),
        img("emblem", "hk-emblem", "Harris-Kayot emblem", "Details"),
        img("registration", "registration", "Registration sticker (2027)", "Details"),
        img("gas-fill", "gas-fill", "Gas fill", "Details"),
      ],
    },
    {
      id: "overhead",
      label: "Top View",
      category: "overhead",
      images: [
        img("overhead", "overhead-deck", "Deck layout from above, looking aft", "Top view", [
          { hotspotId: "helm", x: 27, y: 25 },
          { hotspotId: "fish-finder", x: 19, y: 19 },
          { hotspotId: "seating", x: 82, y: 45 },
        ]),
        img("deck", "deck-from-stern", "Deck toward the helm", "Top view"),
        img("helm-lounge", "helm-lounge", "Helm and aft lounge", "Top view", [
          { hotspotId: "helm", x: 20, y: 33 },
          { hotspotId: "stereo", x: 42, y: 78 },
        ]),
      ],
    },
    {
      id: "interior",
      label: "Interior",
      category: "interior",
      images: [
        img("overview", "overhead-deck", "Interior overview", "Cockpit", [
          { hotspotId: "helm", x: 27, y: 25 },
          { hotspotId: "seating", x: 82, y: 45 },
          { hotspotId: "storage", x: 10, y: 62 },
        ]),
        img("lounge-table", "lounge-table", "Helm, table and aft lounge", "Rear seating"),
        img("table-lounge", "table-lounge", "Pedestal table and lounge", "Rear seating"),
        img("helm-lounge", "helm-lounge", "Helm and L-lounge", "Rear seating"),
        img("captains-chairs", "captains-chairs-table", "Captain's chairs", "Passenger seating"),
        img("captains-pair", "captains-chairs-pair", "Captain's chairs and side lounge", "Passenger seating"),
        img("captain-1", "captains-chair-1", "Captain's chair", "Passenger seating"),
        img("captain-2", "captains-chair-2", "Captain's chair", "Passenger seating"),
        img("bow-seating", "bow-seating", "Bow seating", "Bow seating"),
        img("l-lounge", "l-lounge", "L-lounge", "Bow seating"),
        img("bow-entry", "bow-entry", "Bow deck and entry gate", "Bow seating"),
        img("helm-seat", "helm-seat", "Helm seat", "Helm"),
        img("lounge-corner", "lounge-corner", "Lounge upholstery", "Upholstery"),
        img("lounge-bench", "lounge-bench", "Lounge bench", "Upholstery"),
        img("rear-seat", "rear-lounge-seat", "Rear lounge cushions", "Upholstery"),
        img("rear-cushion", "rear-lounge-cushion", "Rear lounge cushion", "Upholstery"),
      ],
    },
    {
      id: "helm",
      label: "Helm",
      category: "helm",
      images: [
        img("dash", "helm-dash", "Helm dash, wheel and gauges", "Helm", [
          { hotspotId: "fish-finder", x: 71, y: 9 },
          { hotspotId: "stereo", x: 6, y: 82 },
          { hotspotId: "engine", x: 82, y: 52 },
        ]),
        img("console", "helm-console", "Helm console and windscreen", "Helm"),
        img("gauges", "gauges", "Speedometer and gauges", "Gauges"),
        img("tach", "tachometer", "Tachometer", "Gauges"),
        img("switches", "switch-panel", "Switch panel and horn", "Controls"),
        img("ignition", "ignition", "Key ignition", "Controls"),
        img("throttle", "throttle", "Yamaha throttle/shift", "Controls"),
        img("windscreen", "windscreen", "Windscreen", "Helm"),
        img("plate", "capacity-plate", "Capacity plate: 14 persons / 1,925 lbs, 130 HP max", "Capacity"),
      ],
    },
    {
      id: "electronics",
      label: "Electronics",
      category: "electronics",
      images: [
        img("fish-finder", "fish-finder", "Humminbird PiranhaMAX 4 fish finder", "Fish finder"),
        img("stereo", "stereo", "Sony Bluetooth stereo", "Stereo"),
        img("speaker", "speaker", "Kicker marine speaker", "Speakers"),
        img("speaker-net", "speaker-net", "Speaker and storage net", "Speakers"),
        img("nav-port", "nav-light-port", "Red navigation light and docking light", "Lights"),
        img("nav-starboard", "nav-light-starboard", "Green navigation light and docking light", "Lights"),
      ],
    },
    {
      id: "storage",
      label: "Storage",
      category: "storage",
      images: [
        img("seat-1", "storage-seat-1", "Under-seat storage", "Storage"),
        img("seat-2", "storage-seat-2", "Under-seat storage", "Storage"),
        img("seat-3", "storage-seat-3", "Under-seat storage", "Storage"),
        img("locker", "storage-locker", "Large storage locker", "Storage"),
        img("battery", "battery-compartment", "Battery compartment", "Storage"),
        img("fuel-tank", "fuel-tank-compartment", "Fuel tank compartment", "Storage"),
        img("console-lid", "console-lid", "Helm console lid", "Console"),
        img("console-bin", "console-storage", "Helm console storage", "Console"),
        img("console-door", "console-access", "Helm console access door", "Console"),
      ],
    },
    {
      id: "engine",
      label: "Engine",
      category: "engine",
      detail: "engine",
      images: [
        img("stern", "stern-engine", "Yamaha 100 four-stroke outboard", "Engine", [{ hotspotId: "engine", x: 51, y: 22 }]),
        img("cowling", "engine-cowling", "Engine cowling", "Engine"),
        img("quarter", "stern-quarter", "Outboard from the starboard quarter", "Engine"),
        img("from-deck", "engine-from-deck", "Outboard from the deck", "Engine"),
        img("rigging", "engine-rigging", "Stern access and rigging", "Engine"),
        img("prop", "prop", "Three-blade propeller", "Prop"),
        img("throttle", "throttle", "Yamaha throttle/shift", "Controls"),
      ],
    },
    {
      id: "bow",
      label: "Bow",
      category: "bow",
      images: [
        img("entry", "bow-entry", "Bow deck and entry gate", "Bow"),
        img("nav-port", "nav-light-port", "Bow cap, red navigation light", "Bow"),
        img("nav-starboard", "nav-light-starboard", "Bow cap, green navigation light", "Bow"),
        img("quarter", "port-bow-quarter", "Port bow quarter", "Bow"),
      ],
    },
    {
      id: "stern",
      label: "Stern",
      category: "stern",
      images: [
        img("stern", "stern-engine", "Stern", "Stern", [{ hotspotId: "engine", x: 51, y: 22 }]),
        img("street", "street-stern", "Stern", "Stern"),
      ],
    },
    {
      id: "trailer",
      label: "Trailer",
      category: "trailer",
      detail: "trailer",
      images: [
        img("wheels", "trailer-wheels", "Tandem axles, Kenda Loadstar tires", "Trailer"),
        img("wheels-2", "trailer-wheels-2", "Tandem axles and fender", "Trailer"),
        img("tongue", "trailer-tongue", "Tongue, swing-away jack and manual winch", "Trailer"),
        img("winch-stand", "trailer-winch-stand", "Winch stand and step", "Trailer"),
        img("frame", "trailer-frame", "Frame and cross members", "Trailer"),
        img("decal", "trailer-decal", "Mid America Trailers", "Trailer"),
        img("decal-2", "trailer-decal-2", "Mid America Trailers", "Trailer"),
        img("side", "starboard-side", "Boat on trailer", "Trailer", [{ hotspotId: "trailer", x: 26, y: 71 }]),
      ],
    },
    {
      id: "condition",
      label: "Condition",
      category: "condition",
      images: [
        img("pontoons", "pontoon-surface", "Pontoon tube surface — see condition note", "Condition", [
          { hotspotId: "pontoon-finish", x: 35, y: 45 },
        ]),
        img("pontoons-2", "pontoon-surface-2", "Pontoon tube surface — see condition note", "Condition"),
        img("underside", "deck-underside", "Deck underside — see condition note", "Condition", [
          { hotspotId: "deck-underside", x: 55, y: 15 },
        ]),
      ],
    },
  ],
  views: [
    { id: "spin", label: "360° View", icon: "spin", action: { type: "spin" } },
    // No bow-on frames in the walkaround, so FRONT shows the front ¾ photo.
    { id: "front", label: "Front", icon: "front", action: { type: "gallery", galleryId: "exterior", imageId: "front-quarter" } },
    { id: "rear", label: "Rear", icon: "rear", action: { type: "angle", angle: "rear" } },
    { id: "left", label: "Left Side", icon: "left", action: { type: "angle", angle: "port" } },
    { id: "right", label: "Right Side", icon: "right", action: { type: "angle", angle: "starboard" } },
    { id: "top", label: "Top View", icon: "top", action: { type: "gallery", galleryId: "overhead" } },
    { id: "interior", label: "Interior", icon: "interior", action: { type: "gallery", galleryId: "interior" } },
    { id: "helm", label: "Helm", icon: "helm", action: { type: "gallery", galleryId: "helm" } },
    { id: "electronics", label: "Electronics", icon: "electronics", action: { type: "gallery", galleryId: "electronics" } },
    { id: "storage", label: "Storage", icon: "storage", action: { type: "gallery", galleryId: "storage" } },
    { id: "engine", label: "Engine", icon: "engine", action: { type: "gallery", galleryId: "engine" } },
    { id: "trailer", label: "Trailer", icon: "trailer", action: { type: "gallery", galleryId: "trailer" } },
    { id: "walkaround", label: "Walkaround", icon: "video", action: { type: "video", videoId: "walkaround" } },
  ],
  hotspots,
  links: {
    details: "#boat-details",
    financing: "https://www.sunsportmarineinc.com/financing",
    contact: "https://www.sunsportmarineinc.com/contact",
  },
};

export default config;
