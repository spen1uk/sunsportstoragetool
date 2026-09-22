-- =========================================================================
-- Additional permission-guard triggers (soft-delete + profiles + locations)
-- =========================================================================

-- Only admins may set/clear deleted_at, on any table that has it.
create or replace function public.enforce_admin_only_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at and public.current_role() <> 'admin' then
    raise exception 'Only admins can delete or restore records';
  end if;
  return new;
end;
$$;

create trigger trg_customers_soft_delete_guard
  before update on public.customers
  for each row execute function public.enforce_admin_only_soft_delete();

create trigger trg_units_soft_delete_guard
  before update on public.units
  for each row execute function public.enforce_admin_only_soft_delete();

-- Only admins may change a profile's role or active flag; anyone may still
-- update their own full_name/phone.
create or replace function public.enforce_profiles_update_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'admin' then
    if new.role is distinct from old.role or new.active is distinct from old.active then
      raise exception 'Only admins can change role or active status';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_profiles_update_permissions
  before update on public.profiles
  for each row execute function public.enforce_profiles_update_permissions();

-- Managers may only toggle a spot's admin_status/notes; structural changes
-- (dimensions, code, type, building) are admin-only.
create or replace function public.enforce_storage_locations_update_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() = 'manager' then
    if new.full_code is distinct from old.full_code
      or new.building_id is distinct from old.building_id
      or new.facility_id is distinct from old.facility_id
      or new.section is distinct from old.section
      or new.spot_number is distinct from old.spot_number
      or new.location_type is distinct from old.location_type
      or new.storage_type is distinct from old.storage_type
      or new.max_length_ft is distinct from old.max_length_ft
      or new.max_width_ft is distinct from old.max_width_ft
      or new.is_active is distinct from old.is_active
    then
      raise exception 'Only admins can edit facility layout';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_storage_locations_update_permissions
  before update on public.storage_locations
  for each row execute function public.enforce_storage_locations_update_permissions();

-- =========================================================================
-- Enable RLS everywhere
-- =========================================================================
alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.facilities enable row level security;
alter table public.buildings enable row level security;
alter table public.storage_locations enable row level security;
alter table public.unit_statuses enable row level security;
alter table public.units enable row level security;
alter table public.location_assignments enable row level security;
alter table public.location_history enable row level security;
alter table public.service_types enable row level security;
alter table public.unit_services enable row level security;
alter table public.intakes enable row level security;
alter table public.pickups enable row level security;
alter table public.notes enable row level security;
alter table public.photos enable row level security;
alter table public.activity_logs enable row level security;

-- profiles ----------------------------------------------------------------
create policy "profiles_select_all" on public.profiles
  for select to authenticated using (true);

create policy "profiles_update_self_or_admin" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.current_role() = 'admin')
  with check (id = auth.uid() or public.current_role() = 'admin');

-- customers -----------------------------------------------------------------
create policy "customers_select" on public.customers
  for select to authenticated
  using (deleted_at is null or public.current_role() = 'admin');

create policy "customers_insert_manager_up" on public.customers
  for insert to authenticated
  with check (public.current_role() in ('admin', 'manager'));

create policy "customers_update_manager_up" on public.customers
  for update to authenticated
  using (public.current_role() in ('admin', 'manager'))
  with check (public.current_role() in ('admin', 'manager'));

-- facilities ----------------------------------------------------------------
create policy "facilities_select" on public.facilities
  for select to authenticated using (true);

create policy "facilities_write_admin" on public.facilities
  for all to authenticated
  using (public.current_role() = 'admin')
  with check (public.current_role() = 'admin');

-- buildings -------------------------------------------------------------------
create policy "buildings_select" on public.buildings
  for select to authenticated using (true);

create policy "buildings_write_admin" on public.buildings
  for all to authenticated
  using (public.current_role() = 'admin')
  with check (public.current_role() = 'admin');

-- storage_locations -----------------------------------------------------------
create policy "storage_locations_select" on public.storage_locations
  for select to authenticated using (true);

create policy "storage_locations_insert_admin" on public.storage_locations
  for insert to authenticated
  with check (public.current_role() = 'admin');

create policy "storage_locations_update_manager_up" on public.storage_locations
  for update to authenticated
  using (public.current_role() in ('admin', 'manager'))
  with check (public.current_role() in ('admin', 'manager'));

create policy "storage_locations_delete_admin" on public.storage_locations
  for delete to authenticated
  using (public.current_role() = 'admin');

-- unit_statuses -----------------------------------------------------------------
create policy "unit_statuses_select" on public.unit_statuses
  for select to authenticated using (true);

create policy "unit_statuses_write_admin" on public.unit_statuses
  for all to authenticated
  using (public.current_role() = 'admin')
  with check (public.current_role() = 'admin');

-- units ---------------------------------------------------------------------
create policy "units_select" on public.units
  for select to authenticated
  using (deleted_at is null or public.current_role() = 'admin');

create policy "units_insert_manager_up" on public.units
  for insert to authenticated
  with check (public.current_role() in ('admin', 'manager'));

create policy "units_update_any_employee" on public.units
  for update to authenticated
  using (public.current_role() in ('admin', 'manager', 'employee'))
  with check (public.current_role() in ('admin', 'manager', 'employee'));

-- location_assignments / location_history ------------------------------------
-- Select only — all writes go through move_unit() / remove_unit_from_storage(),
-- which are SECURITY DEFINER and bypass RLS. No insert/update/delete policy
-- exists here on purpose.
create policy "location_assignments_select" on public.location_assignments
  for select to authenticated using (true);

create policy "location_history_select" on public.location_history
  for select to authenticated using (true);

-- service_types -----------------------------------------------------------------
create policy "service_types_select" on public.service_types
  for select to authenticated using (true);

create policy "service_types_write_admin" on public.service_types
  for all to authenticated
  using (public.current_role() = 'admin')
  with check (public.current_role() = 'admin');

-- unit_services -------------------------------------------------------------
create policy "unit_services_select" on public.unit_services
  for select to authenticated using (true);

create policy "unit_services_insert_manager_up" on public.unit_services
  for insert to authenticated
  with check (public.current_role() in ('admin', 'manager'));

create policy "unit_services_update_any_employee" on public.unit_services
  for update to authenticated
  using (public.current_role() in ('admin', 'manager', 'employee'))
  with check (public.current_role() in ('admin', 'manager', 'employee'));

-- intakes -------------------------------------------------------------------
create policy "intakes_select" on public.intakes
  for select to authenticated using (true);

create policy "intakes_write_manager_up" on public.intakes
  for all to authenticated
  using (public.current_role() in ('admin', 'manager'))
  with check (public.current_role() in ('admin', 'manager'));

-- pickups ---------------------------------------------------------------------
create policy "pickups_select" on public.pickups
  for select to authenticated using (true);

create policy "pickups_write_manager_up" on public.pickups
  for all to authenticated
  using (public.current_role() in ('admin', 'manager'))
  with check (public.current_role() in ('admin', 'manager'));

-- notes -----------------------------------------------------------------------
create policy "notes_select" on public.notes
  for select to authenticated using (true);

create policy "notes_insert_own" on public.notes
  for insert to authenticated
  with check (author_id = auth.uid());

-- photos ----------------------------------------------------------------------
create policy "photos_select" on public.photos
  for select to authenticated using (true);

create policy "photos_insert_own" on public.photos
  for insert to authenticated
  with check (uploaded_by = auth.uid());

create policy "photos_delete_admin" on public.photos
  for delete to authenticated
  using (public.current_role() = 'admin');

-- activity_logs -----------------------------------------------------------------
-- Immutable audit trail: insert-your-own only, no update/delete policy at all.
create policy "activity_logs_select" on public.activity_logs
  for select to authenticated using (true);

create policy "activity_logs_insert_own" on public.activity_logs
  for insert to authenticated
  with check (employee_id = auth.uid());
