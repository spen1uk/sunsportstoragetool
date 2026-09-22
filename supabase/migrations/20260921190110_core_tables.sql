-- =========================================================================
-- profiles: one row per employee, extends auth.users
-- =========================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role app_role not null default 'employee',
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile whenever a new auth user is created. Admins create
-- employee accounts via the Supabase Admin API and pass full_name/role in
-- user_metadata; defaults cover any account created without metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    coalesce((new.raw_user_meta_data ->> 'role')::app_role, 'employee')
  );
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================================
-- customers
-- =========================================================================
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  phone text,
  email text,
  address text,
  city text,
  state text,
  zip text,
  secondary_contact_name text,
  secondary_contact_phone text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger trg_customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create index idx_customers_deleted_at on public.customers (deleted_at);

-- =========================================================================
-- facilities / buildings — Phase 1 seeds a single facility, schema supports more
-- =========================================================================
create table public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  city text,
  state text,
  zip text,
  created_at timestamptz not null default now()
);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete cascade,
  name text not null,
  code text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (facility_id, code)
);

-- =========================================================================
-- storage_locations — every physical or staging location a unit can occupy
-- =========================================================================
create table public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete cascade,
  building_id uuid references public.buildings(id) on delete set null,
  full_code text not null,                  -- e.g. "A-14", "Service Bay 2" — unique per building, see below
  section text,                             -- e.g. "A" — grid row grouping
  spot_number text,                         -- e.g. "14"
  location_type location_type_enum not null default 'storage_spot',
  -- What kind of storage this physical spot IS (drives capacity-by-type
  -- reporting). Staging/service/etc. locations still get a nominal value.
  storage_type storage_type_enum not null default 'outdoor',
  max_length_ft numeric(5,2),
  max_width_ft numeric(5,2),
  admin_status location_admin_status_enum not null default 'available',
  -- Unused by the Phase 1 grid renderer; present so a future drag-and-drop
  -- facility map editor needs no migration.
  position_x numeric,
  position_y numeric,
  rotation numeric,
  sort_order int not null default 0,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- "A-14" only has to be unique within its own building (or, for
  -- building_id IS NULL staging/service locations, among each other) — two
  -- different buildings can both have an "A-14".
  unique (building_id, full_code)
);

create trigger trg_storage_locations_updated_at
  before update on public.storage_locations
  for each row execute function public.set_updated_at();

create index idx_storage_locations_building on public.storage_locations (building_id);
create index idx_storage_locations_storage_type on public.storage_locations (storage_type);
create index idx_storage_locations_location_type on public.storage_locations (location_type);

-- =========================================================================
-- unit_statuses — lookup table (not an enum) so color/icon/order are
-- admin-editable without a migration
-- =========================================================================
create table public.unit_statuses (
  code text primary key,
  label text not null,
  color text not null,
  icon text not null,
  sort_order int not null default 0,
  is_terminal boolean not null default false
);

-- =========================================================================
-- units
-- =========================================================================
create table public.units (
  id uuid primary key default gen_random_uuid(),
  internal_storage_id text not null unique,   -- e.g. "SSM-2026-00482"
  qr_token uuid not null unique default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  unit_type unit_type_enum not null default 'boat',
  year int,
  make text,
  model text,
  length_ft numeric(5,2),
  beam_ft numeric(5,2),
  registration_number text,
  hin text,
  engine_make text,
  engine_model text,
  horsepower int,
  engine_hours numeric(7,1),
  trailer_included boolean not null default false,
  trailer_make text,
  trailer_plate text,
  storage_type storage_type_enum not null default 'outdoor',
  status_code text not null references public.unit_statuses(code) default 'scheduled_for_arrival',
  arrival_date date,
  expected_pickup_date date,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger trg_units_updated_at
  before update on public.units
  for each row execute function public.set_updated_at();

create index idx_units_customer on public.units (customer_id);
create index idx_units_status on public.units (status_code);
create index idx_units_deleted_at on public.units (deleted_at);
