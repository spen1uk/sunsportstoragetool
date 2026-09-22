-- =========================================================================
-- location_assignments — current + past occupancy; exactly one active row
-- per unit and per location at a time
-- =========================================================================
create table public.location_assignments (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  storage_location_id uuid not null references public.storage_locations(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,        -- null = this is the active assignment
  assigned_by uuid references public.profiles(id),
  notes text
);

create unique index one_active_assignment_per_unit
  on public.location_assignments (unit_id) where unassigned_at is null;

create unique index one_active_assignment_per_location
  on public.location_assignments (storage_location_id) where unassigned_at is null;

create index idx_location_assignments_unit on public.location_assignments (unit_id);

-- =========================================================================
-- location_history — permanent, insert-only. Written exclusively by the
-- move_unit / remove_unit_from_storage functions (see migration 190130), so
-- history can never be silently skipped or overwritten.
-- =========================================================================
create table public.location_history (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  from_location_id uuid references public.storage_locations(id),
  to_location_id uuid references public.storage_locations(id),
  moved_by uuid references public.profiles(id),
  moved_at timestamptz not null default now(),
  note text
);

create index idx_location_history_unit on public.location_history (unit_id, moved_at desc);

-- =========================================================================
-- service_types — admin-managed lookup
-- =========================================================================
create table public.service_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text,
  is_active boolean not null default true
);

-- =========================================================================
-- unit_services
-- =========================================================================
create table public.unit_services (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  service_type_id uuid not null references public.service_types(id),
  status service_status_enum not null default 'requested',
  requested_at timestamptz not null default now(),
  scheduled_at timestamptz,
  completed_at timestamptz,
  assigned_employee_id uuid references public.profiles(id),
  notes text
);

create index idx_unit_services_unit on public.unit_services (unit_id);
create index idx_unit_services_status on public.unit_services (status);

-- =========================================================================
-- intakes — one per unit, captured when the unit arrives
-- =========================================================================
create table public.intakes (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null unique references public.units(id) on delete cascade,
  performed_by uuid references public.profiles(id),
  fuel_level fuel_level_enum,
  engine_hours numeric(7,1),
  key_received boolean not null default false,
  cover_received boolean not null default false,
  trailer_included boolean not null default false,
  existing_damage text,
  special_instructions text,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- pickups — Spring Pull / Pickup Queue backing table
-- =========================================================================
create table public.pickups (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  requested_pickup_date date,
  actual_pickup_date date,
  status pickup_status_enum not null default 'scheduled',
  scheduled_by uuid references public.profiles(id),
  notes text,
  created_at timestamptz not null default now()
);

create index idx_pickups_unit on public.pickups (unit_id);
create index idx_pickups_status on public.pickups (status);

-- =========================================================================
-- notes / photos — generic attachments on a unit or customer (or intake, for
-- photos). Polymorphic by convention (entity_type + entity_id), not FK
-- enforced across the two possible parents — a standard, accepted trade-off
-- for this kind of attachment table.
-- =========================================================================
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  entity_type notable_entity_enum not null,
  entity_id uuid not null,
  author_id uuid references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

create index idx_notes_entity on public.notes (entity_type, entity_id);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  entity_type notable_entity_enum not null,
  entity_id uuid not null,
  storage_path text not null,
  caption text,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index idx_photos_entity on public.photos (entity_type, entity_id);

-- =========================================================================
-- activity_logs — permanent audit trail, insert-only
-- =========================================================================
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create index idx_activity_logs_created_at on public.activity_logs (created_at desc);
create index idx_activity_logs_entity on public.activity_logs (entity_type, entity_id);
