// Data contract for the reusable 360° boat viewer.
//
// The viewer engine (components/boat360) only ever consumes a
// `BoatViewerConfig`. Where the config comes from — a static file today, the
// Supabase `boats` / `boat_360_*` tables later — is invisible to it.
//
// Conventions:
// - Frame numbers are 1-based everywhere in config (frame 1 = bow-on).
// - Hotspot / placement coordinates are percentages (0–100) of the image,
//   so they stay correct at any rendered size.

export type ImageTierName = "thumb" | "sm" | "md" | "lg";

export interface ImageTier {
  name: ImageTierName;
  width: number;
  height: number;
  webp: string;
  avif?: string;
}

/** One optimized image with its responsive derivatives. */
export interface MediaAsset {
  id: string;
  alt: string;
  width: number;
  height: number;
  tiers: ImageTier[];
  blurDataURL?: string;
  /** True for generated "photo needed" cards — never a real photograph. */
  placeholder?: boolean;
  /** Set when this asset is a crop of another source photo. */
  derivedFrom?: string;
}

export interface SpinTier {
  name: "sm" | "md" | "lg";
  width: number;
  /** URL with a `{frame}` token, replaced by the zero-padded frame number. */
  urlPattern: string;
}

export type SpinAngle = "front" | "starboard" | "rear" | "port";

export interface SpinSet {
  frameCount: number;
  /** Intrinsic frame size (for aspect ratio). */
  width: number;
  height: number;
  padLength: number;
  tiers: SpinTier[];
  /** Frame shown first (1-based). */
  initialFrame: number;
  /**
   * Frames used by FRONT / RIGHT SIDE / REAR / LEFT SIDE shortcuts. Omit an
   * angle the sequence doesn't cover (e.g. a walkaround with no bow-on shot).
   */
  angles: Partial<Record<SpinAngle, number>>;
  /**
   * Whether the sequence wraps (last frame → first). Default true. Set false
   * for a partial arc, e.g. frames taken from a walkaround video.
   */
  loop?: boolean;
  /** Short caption shown on the viewer, e.g. what the sequence covers. */
  caption?: string;
  /**
   * Present when the sequence is not real photography. The viewer shows a
   * persistent notice so placeholders are never mistaken for the boat.
   */
  placeholder?: { notice: string };
  /** Full-width drags per full revolution multiplier (1 = one width ≈ one turn). */
  sensitivity?: number;
  /** Flip drag direction if a sequence was shot counter-clockwise. */
  reverseDrag?: boolean;
  /** Momentum after release. Default true. */
  inertia?: boolean;
}

export type HotspotCategory =
  | "engine"
  | "helm"
  | "bimini"
  | "seating"
  | "electronics"
  | "stereo"
  | "fish-finder"
  | "trailer"
  | "prop"
  | "swim-ladder"
  | "storage"
  | "bow"
  | "stern"
  | "feature"
  | "condition";

export type ConditionType =
  | "scratch"
  | "dent"
  | "upholstery-wear"
  | "dock-rash"
  | "prop-damage"
  | "trailer-damage"
  | "oxidation"
  | "other";

export interface Point {
  x: number;
  y: number;
}

export interface VideoRef {
  id: string;
  title: string;
  /** mp4/webm URL, or an embeddable (YouTube/Vimeo) URL when `kind` is "embed". */
  src?: string;
  /** Alternative encodings (e.g. WebM + MP4); browsers play the first they support. */
  sources?: { src: string; type: string }[];
  kind?: "file" | "embed";
  poster?: string;
  /** Planned video that has not been recorded yet. */
  placeholder?: boolean;
}

export type DetailPanel = "engine" | "trailer";

export interface Hotspot {
  id: string;
  title: string;
  category: HotspotCategory;
  description?: string;
  bullets?: string[];
  conditionType?: ConditionType;
  /** Shown as "pending inspection" — observations not yet confirmed by staff. */
  needsReview?: boolean;

  // --- Visibility on the 360° spin --------------------------------------
  /** Explicit visible frames. Takes precedence over frameStart/frameEnd. */
  visibleFrames?: number[];
  /** Inclusive range; wraps when start > end (e.g. 30 → 5). */
  frameStart?: number;
  frameEnd?: number;
  /** Default position when a frame has no specific coordinate. */
  x?: number;
  y?: number;
  /**
   * Frame-specific coordinates keyed by frame number. Frames between two
   * keyed frames are interpolated, so a few keyframes are usually enough.
   */
  positions?: Record<string, Point>;

  // --- What it links to ---------------------------------------------------
  /** Gallery opened by the card's "View photos" action. */
  galleryId?: string;
  /** Specific image in that gallery to open first. */
  galleryImageId?: string;
  /** Spec panel associated with this hotspot. */
  detail?: DetailPanel;
  videos?: VideoRef[];
}

/** A hotspot pinned onto a still photo (not the spin). */
export interface ImageHotspotPlacement extends Point {
  hotspotId: string;
}

export interface GalleryImage {
  /** Unique within the gallery. */
  id: string;
  assetId: string;
  caption?: string;
  /** Optional sub-category label, e.g. "Bow seating", "Cockpit". */
  label?: string;
  hotspots?: ImageHotspotPlacement[];
}

export type GalleryCategory =
  | "exterior"
  | "overhead"
  | "bow"
  | "stern"
  | "engine"
  | "helm"
  | "interior"
  | "seating"
  | "trailer"
  | "storage"
  | "electronics"
  | "condition"
  | "other";

export interface Gallery {
  id: string;
  label: string;
  category: GalleryCategory;
  images: GalleryImage[];
  /** Show a spec panel (engine / trailer) alongside this gallery. */
  detail?: DetailPanel;
}

export type ViewIcon =
  | "spin"
  | "front"
  | "rear"
  | "left"
  | "right"
  | "top"
  | "interior"
  | "helm"
  | "engine"
  | "trailer"
  | "electronics"
  | "storage"
  | "video";

export type ViewAction =
  | { type: "spin" }
  | { type: "angle"; angle: SpinAngle }
  | { type: "gallery"; galleryId: string; imageId?: string }
  | { type: "video"; videoId: string };

export interface ViewButton {
  id: string;
  label: string;
  icon: ViewIcon;
  action: ViewAction;
}

export interface SpecValue {
  label: string;
  /** `null` renders as "To be confirmed" so unknowns are explicit. */
  value: string | null;
}

export interface EngineSpec {
  manufacturer: string;
  model: string | null;
  horsepower: number;
  hours: number | null;
  fuelType: string | null;
  engineType: string | null;
  serialNumber?: string | null;
  showSerialNumber?: boolean;
  inspectionStatus: string | null;
  notes?: string;
}

export interface TrailerSpec {
  year: number | null;
  manufacturer: string | null;
  axles: string | null;
  support: string | null;
  brakes: string | null;
  tires: string | null;
  condition: string | null;
  included: "included" | "available-separately" | "not-available" | null;
  /** Price when sold separately, e.g. "$4,000". */
  price?: string | null;
  /** Page with more about the trailer / trailer inventory. */
  link?: string;
}

export interface BoatLinks {
  details?: string;
  financing?: string;
  tradeIn?: string;
  contact?: string;
}

export interface BoatViewerConfig {
  boatId: string;
  slug: string;
  year?: number;
  make: string;
  model: string;
  stockNumber?: string;
  /** Short headline facts for the information panel (length, capacity…). */
  highlights: SpecValue[];
  engine?: EngineSpec;
  trailer?: TrailerSpec;
  spin?: SpinSet;
  assets: Record<string, MediaAsset>;
  galleries: Gallery[];
  views: ViewButton[];
  hotspots: Hotspot[];
  /** Boat-level videos (walkaround, cold start…) opened from view buttons. */
  videos?: VideoRef[];
  links?: BoatLinks;
}
