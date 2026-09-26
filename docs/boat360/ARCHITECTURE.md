# Sun Sport Marine — Interactive 360° Boat Viewer

Phase 1 prototype. Live route: **`/boats/harris-kayot-220-classic`** (index at `/boats`).

## 1. Existing project (what was there)

- Next.js 16.3 (App Router, `proxy.ts` instead of middleware), React 19.2, TypeScript, Tailwind v4, shadcn/base-ui, Supabase.
- It is the **internal storage-management app**: every route is behind staff login (`lib/supabase/proxy.ts`).
- Brand tokens already exist in `app/globals.css` (`--brand-navy #0b2545`, `--brand-blue #2563eb`).
- `sharp` is already installed (Next's optional image dependency) — reused by the build-time media scripts, so **no new dependencies were added**.

Changes to existing code were kept to the two lines needed to make the listing public:
`/boats` added to `PUBLIC_PATHS`, and `boat-media/` + `.avif` excluded from the proxy matcher (otherwise media requests would redirect to `/login`).

## 2. Architecture

```
            ┌──────────── BOAT DATA (per boat) ────────────┐
media-source/boats/<slug>/   ──build-media.mjs──►  public/boat-media/<slug>/…  (WebP/AVIF tiers)
  manifest.json, photos/, 360/                   lib/boats/generated/<slug>.media.json
lib/boats/data/<slug>.ts  (specs, hotspots, galleries, view buttons)
lib/boats/registry.ts     getBoat(slug) → BoatViewerConfig   (Phase 2: Supabase)
            └───────────────────────┬───────────────────────┘
                                    ▼
            ┌──────────── VIEWER ENGINE (boat-agnostic) ───┐
components/boat360/boat-360-viewer.tsx   <Boat360Viewer boat={config} />
  use-stage-gestures.ts   Pointer Events: rotate / pan / pinch / swipe / double-tap / wheel
  hotspot-marker / hotspot-card / video-modal / view-selector / thumbnail-strip / spec-panels
lib/boat360/
  types.ts        the BoatViewerConfig contract
  frames.ts       pure frame math, hotspot visibility + interpolation, srcset helpers
  frame-cache.ts  progressive preloader + decoded image cache
  analytics.ts    track() → dataLayer + DOM event
  validate.ts     referential checks on a config
            └──────────────────────────────────────────────┘
```

The viewer never imports boat data; pages pass a config in. Adding a boat = adding data (Phase 1: a data file + media folder; Phase 2: rows in the DB), not code.

## 3. Image-sequence rotation

- Frames are 1-based. Frame 1 = bow-on; with 36 frames, 10 = starboard, 19 = stern, 28 = port (configurable via `spin.angles`). `frameCount` comes from config (24/36/48/72 all work).
- Rotation state is a **float position**; the shown frame is `wrapFrame(round(pos))`, so it loops forever in both directions (36 → 1, 1 → 36).
- Drag distance → frames: one stage width ≈ one full turn (`spin.sensitivity` scales it, `reverseDrag` flips it). Drag right = next frame.
- On release, velocity from the last ~90 ms drives **inertia** with exponential decay (time constant 325 ms), then snaps to a whole frame. Disabled for `prefers-reduced-motion`.
- FRONT / REAR / LEFT / RIGHT animate along the **shortest path** to the configured frame.
- Frames are painted onto a `<canvas>` from already-decoded `Image` objects: a frame change is one `drawImage`, with no DOM swaps, no network, and no flicker.

## 4. Data model

TypeScript contract: `lib/boat360/types.ts` (`BoatViewerConfig`, `SpinSet`, `Hotspot`, `Gallery`, `MediaAsset`, `EngineSpec`, `TrailerSpec`, `ViewButton`, `VideoRef`).
Proposed Postgres schema (not applied): `docs/boat360/schema.sql`. Its tables are `boats`, `boat_360_sets`, `boat_360_frames`, `boat_images`, `boat_galleries`, `boat_gallery_images`, `boat_hotspots`, `boat_hotspot_positions`, `boat_videos`, `boat_features` and `boat_viewer_events`, with RLS so anonymous users can read published boats.

Hotspot shape (percent coordinates, frame-specific positions optional and interpolated):

```ts
{
  id: "engine", title: "Yamaha 100 HP Four-Stroke", category: "engine",
  visibleFrames: [10, 11, …, 28],          // or frameStart/frameEnd (wraps if start > end)
  positions: { "14": { x: 82, y: 61 }, "19": { x: 50, y: 55 } },   // or a single x/y
  galleryId: "engine", detail: "engine",
  videos: [{ id: "cold-start", title: "Engine cold start" }],
  // condition hotspots: category "condition", conditionType, needsReview
}
```

Photos can carry their own hotspot pins (`GalleryImage.hotspots`), so the engine hotspot works on the stern photo too.

## 5. Files

| Path | Role |
|---|---|
| `app/boats/[slug]/page.tsx`, `app/boats/page.tsx` | Public listing pages (static params from registry) |
| `components/boat360/*` | Viewer engine UI |
| `lib/boat360/*` | Engine logic (no React) |
| `lib/boats/data/*.ts`, `lib/boats/registry.ts` | Boat data + lookup |
| `lib/boats/generated/*.json` | Generated media / placeholder indexes (don't hand-edit) |
| `scripts/boat360/build-media.mjs` | Optimize photos, crops, placeholders, real 360 frames + validation |
| `scripts/boat360/generate-placeholder-spin.mjs` | Placeholder 360 renders + hotspot tracks |
| `media-source/boats/<slug>/` | Originals + manifest (not served) |
| `public/boat-media/<slug>/` | Optimized, served derivatives |

## 6. Image optimization & loading

Build time (`npm run boat360:media -- --slug <slug>`):
- Photos go to `thumb` 400w (WebP), then `sm` 768 / `md` 1440 / `lg` 2400 (AVIF + WebP). Nothing is upscaled, EXIF orientation is applied, and metadata (including GPS) is stripped. A 16px blur placeholder is inlined.
- 360 frames go to `sm` 640 / `md` 1280 / `lg` 1920 WebP. Frames use WebP only, because canvas decoding of AVIF sequences is still uneven on older iOS.

Run time (`FrameCache`), with priorities recomputed every time a download slot frees up:
1. current frame, low tier → something on screen immediately
2. current frame at display tier
3. ±3 neighbours, low tier → the first drag is instant
4. the whole low-res loop, nearest first (starts only when the viewer is near the viewport)
5. the whole sequence at the display tier (skipped with Save-Data)
6. zoom tier for the current frame, only while zoomed

"Display tier" is picked from the actual rendered pixel width (DPR capped at 2). Phones get the 640 px frames (~10 KB each here), and desktops get 1280. Each frame is downloaded at most once per tier (checked in the e2e run: 73 requests, no duplicates). Gallery photos use `<picture>` + `srcset`, and `sizes` follows the zoomed width, so zooming fetches `lg` on demand. Thumbnails are `loading="lazy"`.

## 7. Responsive hotspot positioning

Coordinates are percentages of the image. The stage "contain"-fits the image into a content box, and zoom/pan is one transform `(tx, ty, scale)`. A hotspot's stage position is `t + scale × (box.origin + pct × box.size)`. Markers are placed in that un-scaled overlay, so they track rotation, zoom, pan and resize exactly while staying 44 px touch targets. Off-screen markers (when zoomed) are hidden. Hotspots only render on their visible frames. Between keyed frames, positions are interpolated around the loop.

## 8. Technical risks / notes

- **iPhone fullscreen**: iOS Safari has no element Fullscreen API. The viewer falls back to a fixed full-viewport overlay (with body scroll lock), which works but can't hide Safari's own toolbars. iPad and desktop use real fullscreen.
- **Touch arbitration**: the stage uses `touch-action: pan-y` (vertical page scroll still works over the boat) and switches to `none` when zoomed. iOS `gesturestart` is suppressed so pinches zoom the photo, not the page. Test this on physical iPhone and Android devices. The e2e run uses Chromium touch emulation.
- **Memory**: decoded frames are about 4 bytes per pixel. 72 × 1280-wide frames ≈ 350 MB decoded, which is why phones stay on 640-wide frames. For 72-frame premium sets, consider 1024 px `md`.
- **Hotspot re-placement**: the positions on the placeholder spin are computed from the placeholder model. When real frames are shot, hotspots must be placed again. Append `?hotspotPicker=1` to the URL, click the boat, and a ready-to-paste `"frame": { x, y }` snippet is copied — a precursor to the Phase 2 editor.
- **Consistency of real shoots**: rotation only looks smooth if frames are evenly spaced, level, and consistently framed and exposed. `validateSequence` warns about size mismatches, gaps, duplicates and exposure outliers. A turntable, or marked positions and a tripod at fixed height, are strongly recommended.
- **Global font**: `app/globals.css` maps `--font-sans` to itself, so the existing app falls back to a serif font. The boat pages set Geist explicitly. The one-line global fix (`--font-sans: var(--font-geist-sans)`) was left alone because it changes the whole staff app.

## Placeholders (honesty)

- The **360 sequence is placeholder renders** of a generic pontoon model. Each frame is watermarked "PLACEHOLDER / NOT A PHOTOGRAPH", and the viewer shows a placeholder notice. No frame is derived from, or pretends to be, the boat's photographs.
- The **real photos** are the four supplied shots: starboard side, port side, stern/engine, and overhead interior. "Detail" images are straight crops of those photos.
- **Missing photos** (front view, helm gauges, storage, electronics) are generated "PHOTO NEEDED" cards, labelled as placeholders in the UI.
- **Condition hotspots** describe only what is visible in the photos, and are marked "pending inspection" (`needsReview`).
- **Unknown specs** (engine hours, model, trailer brakes/tires, …) are `null` and render as "To be confirmed".

## Adding a real 360 sequence

1. Shoot 36 (or 24/48/72) evenly spaced photos, starting bow-on and moving clockwise toward starboard.
2. Save them as `media-source/boats/<slug>/360/boat-001.jpg …`.
3. Run `npm run boat360:media -- --slug <slug>` and fix any validation warnings it prints.
4. In the boat data file, build `spin` from `media.spin` instead of the placeholder JSON, remove `spin.placeholder`, and re-place the hotspots.

## Analytics

`track(event, boatId, props)` pushes to `window.dataLayer` (GTM/GA4) and dispatches a `boat360:analytics` DOM event. The events are:

- `360_view_opened`
- `360_rotated` (once per rotation, with the number of frames)
- `hotspot_clicked`
- `engine_viewed`, `interior_viewed`, `trailer_viewed`
- `gallery_image_viewed`
- `video_played`
- `condition_issue_viewed`
- `zoom_used`, `fullscreen_entered`
- `financing_clicked`, `trade_clicked`, `contact_clicked`, `details_clicked`

## Phase 2 (not built)

- Admin "EDIT 360 VIEW": click-to-place hotspots, using the picker math already in the viewer.
- Upload, reorder, rotate and replace frames, then "GENERATE 360 VIEW" (runs the same pipeline as `build-media.mjs` server-side).
- Supabase-backed registry.
- Interior 360 panorama.
