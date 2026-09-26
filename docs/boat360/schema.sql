-- =========================================================================
-- PROPOSED schema for the 360° boat viewer (Phase 2). NOT YET APPLIED.
--
-- Phase 1 reads boat configs from lib/boats/data/*.ts. When the admin
-- upload / hotspot editor is built, move this file into supabase/migrations
-- and make lib/boats/registry.ts assemble a BoatViewerConfig from it.
--
-- Relationships:
--   boats ─┬─ boat_360_sets ── boat_360_frames
--          ├─ boat_hotspots ─┬─ boat_hotspot_positions
--          │                 ├─ boat_hotspot_images ── boat_images
--          │                 └─ boat_videos (hotspot_id)
--          ├─ boat_galleries ── boat_gallery_images ── boat_images
--          ├─ boat_images (all optimized photos, incl. crops)
--          ├─ boat_features (engine / trailer / highlight specs)
--          └─ boat_videos
-- =========================================================================

create type boat_listing_status as enum ('draft', 'published', 'sold', 'archived');
create type boat_hotspot_category as enum (
  'engine', 'helm', 'bimini', 'seating', 'electronics', 'stereo', 'fish-finder', 'trailer',
  'prop', 'swim-ladder', 'storage', 'bow', 'stern', 'feature', 'condition'
);
create type boat_condition_type as enum (
  'scratch', 'dent', 'upholstery-wear', 'dock-rash', 'prop-damage', 'trailer-damage', 'oxidation', 'other'
);

create table public.boats (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  stock_number text unique,
  year int,
  make text not null,
  model text not null,
  length_ft numeric(5,1),
  passenger_capacity int,
  price_cents bigint,
  status boat_listing_status not null default 'draft',
  links jsonb not null default '{}'::jsonb,          -- financing / trade-in / contact URLs
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One boat can have several sequences (e.g. re-shot); one is active.
create table public.boat_360_sets (
  id uuid primary key default gen_random_uuid(),
  boat_id uuid not null references public.boats(id) on delete cascade,
  frame_count int not null check (frame_count >= 8),
  width int not null,
  height int not null,
  pad_length int not null default 3,
  tiers jsonb not null,                               -- [{name,width,urlPattern}]
  initial_frame int not null default 1,
  angle_front int not null default 1,
  angle_starboard int not null,
  angle_rear int not null,
  angle_port int not null,
  sensitivity numeric(4,2) not null default 1,
  reverse_drag boolean not null default false,
  is_placeholder boolean not null default false,
  is_active boolean not null default false,
  validation_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create unique index boat_360_sets_one_active on public.boat_360_sets(boat_id) where is_active;

create table public.boat_360_frames (
  set_id uuid not null references public.boat_360_sets(id) on delete cascade,
  frame_number int not null check (frame_number >= 1),
  source_path text not null,                          -- original upload in storage
  rotation_degrees int not null default 0,            -- admin "rotate image"
  width int,
  height int,
  luminance numeric(6,2),                             -- exposure check
  dhash text,                                         -- duplicate check
  primary key (set_id, frame_number)
);

create table public.boat_images (
  id uuid primary key default gen_random_uuid(),
  boat_id uuid not null references public.boats(id) on delete cascade,
  alt text not null,
  width int not null,
  height int not null,
  tiers jsonb not null,                               -- [{name,width,height,webp,avif}]
  blur_data_url text,
  derived_from uuid references public.boat_images(id) on delete set null,  -- crops
  crop jsonb,                                         -- {x,y,w,h} percent
  is_placeholder boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.boat_galleries (
  id uuid primary key default gen_random_uuid(),
  boat_id uuid not null references public.boats(id) on delete cascade,
  key text not null,                                  -- 'engine', 'interior', …
  label text not null,
  category text not null,
  detail_panel text check (detail_panel in ('engine', 'trailer')),
  sort_order int not null default 0,
  unique (boat_id, key)
);

create table public.boat_gallery_images (
  gallery_id uuid not null references public.boat_galleries(id) on delete cascade,
  image_id uuid not null references public.boat_images(id) on delete cascade,
  key text not null,
  caption text,
  label text,
  sort_order int not null default 0,
  primary key (gallery_id, image_id)
);

create table public.boat_hotspots (
  id uuid primary key default gen_random_uuid(),
  boat_id uuid not null references public.boats(id) on delete cascade,
  key text not null,
  title text not null,
  category boat_hotspot_category not null,
  condition_type boat_condition_type,
  needs_review boolean not null default false,
  description text,
  bullets text[] not null default '{}',
  frame_start int,                                    -- inclusive, wraps if start > end
  frame_end int,
  default_x numeric(5,2),
  default_y numeric(5,2),
  gallery_id uuid references public.boat_galleries(id) on delete set null,
  gallery_image_id uuid references public.boat_images(id) on delete set null,
  detail_panel text check (detail_panel in ('engine', 'trailer')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (boat_id, key),
  check (category <> 'condition' or condition_type is not null)
);

-- Frame-specific coordinates on the 360 spin (percent). Frames between two
-- keyed rows are interpolated by the viewer. A row may also pin the hotspot
-- onto a still photo instead (image_id set, frame_number null).
create table public.boat_hotspot_positions (
  id uuid primary key default gen_random_uuid(),
  hotspot_id uuid not null references public.boat_hotspots(id) on delete cascade,
  set_id uuid references public.boat_360_sets(id) on delete cascade,
  frame_number int,
  image_id uuid references public.boat_images(id) on delete cascade,
  x numeric(5,2) not null check (x between 0 and 100),
  y numeric(5,2) not null check (y between 0 and 100),
  visible boolean not null default true,
  check ((frame_number is not null and set_id is not null) <> (image_id is not null))
);
create unique index boat_hotspot_positions_frame on public.boat_hotspot_positions(hotspot_id, set_id, frame_number) where frame_number is not null;
create unique index boat_hotspot_positions_image on public.boat_hotspot_positions(hotspot_id, image_id) where image_id is not null;

create table public.boat_videos (
  id uuid primary key default gen_random_uuid(),
  boat_id uuid not null references public.boats(id) on delete cascade,
  hotspot_id uuid references public.boat_hotspots(id) on delete set null,
  key text not null,
  title text not null,                                -- 'Engine cold start', …
  kind text not null default 'file' check (kind in ('file', 'embed')),
  src text,
  poster text,
  sort_order int not null default 0
);

-- Engine, trailer and headline facts. Unknowns stay null → "To be confirmed".
create table public.boat_features (
  boat_id uuid not null references public.boats(id) on delete cascade,
  kind text not null check (kind in ('engine', 'trailer', 'highlight')),
  data jsonb not null,                                -- EngineSpec / TrailerSpec / SpecValue
  sort_order int not null default 0,
  primary key (boat_id, kind, sort_order)
);

-- Viewer analytics (360_view_opened, hotspot_clicked, …) for conversion
-- analysis against leads/sales.
create table public.boat_viewer_events (
  id bigint generated always as identity primary key,
  boat_id uuid references public.boats(id) on delete set null,
  event text not null,
  props jsonb not null default '{}'::jsonb,
  session_id text,
  occurred_at timestamptz not null default now()
);

-- RLS: public (anon) may read published boats and their media; only
-- manager+ staff may write (mirror the existing policies' role checks).
alter table public.boats enable row level security;
create policy "boats_public_read" on public.boats for select to anon, authenticated using (status = 'published');
-- … equivalent select policies joined through boat_id for the child tables,
-- and insert/update/delete policies using public.current_role() in ('manager','admin').
