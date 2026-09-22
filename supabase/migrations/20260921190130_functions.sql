-- =========================================================================
-- current_role() — used throughout RLS policies. SECURITY DEFINER + STABLE
-- avoids RLS-recursion pitfalls when checking a user's own role.
-- =========================================================================
create or replace function public.current_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

grant execute on function public.current_role() to authenticated;

-- =========================================================================
-- move_unit — the ONLY sanctioned way to change a unit's location.
-- Closes the current active assignment (if any), opens a new one, and
-- permanently records the move in location_history + activity_logs, all in
-- one transaction so it can never partially apply.
-- =========================================================================
create or replace function public.move_unit(
  p_unit_id uuid,
  p_new_location_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role app_role;
  v_old_location_id uuid;
  v_dest_status location_admin_status_enum;
  v_dest_active boolean;
  v_occupant uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select role into v_role from public.profiles where id = v_actor and active;
  if v_role is null then
    raise exception 'No active profile for current user';
  end if;

  select admin_status, is_active into v_dest_status, v_dest_active
  from public.storage_locations
  where id = p_new_location_id
  for update;

  if not found then
    raise exception 'Destination location does not exist';
  end if;
  if not v_dest_active then
    raise exception 'Destination location is not active';
  end if;
  if v_dest_status = 'unavailable' then
    raise exception 'Destination location is marked unavailable';
  end if;

  select storage_location_id into v_old_location_id
  from public.location_assignments
  where unit_id = p_unit_id and unassigned_at is null
  for update;

  if v_old_location_id = p_new_location_id then
    raise exception 'Unit is already at that location';
  end if;

  select unit_id into v_occupant
  from public.location_assignments
  where storage_location_id = p_new_location_id and unassigned_at is null
  for update;

  if v_occupant is not null and v_occupant <> p_unit_id then
    raise exception 'Destination location is already occupied';
  end if;

  if v_old_location_id is not null then
    update public.location_assignments
      set unassigned_at = now()
      where unit_id = p_unit_id and unassigned_at is null;
  end if;

  insert into public.location_assignments (unit_id, storage_location_id, assigned_by)
  values (p_unit_id, p_new_location_id, v_actor);

  insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, note)
  values (p_unit_id, v_old_location_id, p_new_location_id, v_actor, p_note);

  insert into public.activity_logs (employee_id, action, entity_type, entity_id, old_value, new_value)
  values (
    v_actor, 'unit_moved', 'unit', p_unit_id,
    jsonb_build_object('location_id', v_old_location_id),
    jsonb_build_object('location_id', p_new_location_id)
  );
end;
$$;

grant execute on function public.move_unit(uuid, uuid, text) to authenticated;

-- =========================================================================
-- remove_unit_from_storage — pulls a unit out of the facility entirely
-- (pickup completed). Leaves a location_history row with to_location_id
-- null so "left the facility" is visible in the timeline.
-- =========================================================================
create or replace function public.remove_unit_from_storage(
  p_unit_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role app_role;
  v_old_location_id uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select role into v_role from public.profiles where id = v_actor and active;
  if v_role is null then
    raise exception 'No active profile for current user';
  end if;

  select storage_location_id into v_old_location_id
  from public.location_assignments
  where unit_id = p_unit_id and unassigned_at is null
  for update;

  if v_old_location_id is null then
    raise exception 'Unit has no active location to remove from';
  end if;

  update public.location_assignments
    set unassigned_at = now()
    where unit_id = p_unit_id and unassigned_at is null;

  insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, note)
  values (p_unit_id, v_old_location_id, null, v_actor, p_note);

  update public.units set status_code = 'removed_from_storage' where id = p_unit_id;

  insert into public.activity_logs (employee_id, action, entity_type, entity_id, old_value, new_value)
  values (
    v_actor, 'unit_removed_from_storage', 'unit', p_unit_id,
    jsonb_build_object('location_id', v_old_location_id),
    jsonb_build_object('location_id', null)
  );
end;
$$;

grant execute on function public.remove_unit_from_storage(uuid, text) to authenticated;

-- =========================================================================
-- Column-guard: employees may only change a unit's status/notes, never its
-- identifying, customer, or dimension fields (that's Manager+ territory).
-- Enforced in the database, not just hidden in the UI.
-- =========================================================================
create or replace function public.enforce_units_update_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role app_role;
begin
  select role into v_role from public.profiles where id = auth.uid();

  if v_role = 'employee' then
    if new.customer_id is distinct from old.customer_id
      or new.internal_storage_id is distinct from old.internal_storage_id
      or new.unit_type is distinct from old.unit_type
      or new.year is distinct from old.year
      or new.make is distinct from old.make
      or new.model is distinct from old.model
      or new.length_ft is distinct from old.length_ft
      or new.beam_ft is distinct from old.beam_ft
      or new.registration_number is distinct from old.registration_number
      or new.hin is distinct from old.hin
      or new.engine_make is distinct from old.engine_make
      or new.engine_model is distinct from old.engine_model
      or new.horsepower is distinct from old.horsepower
      or new.engine_hours is distinct from old.engine_hours
      or new.trailer_included is distinct from old.trailer_included
      or new.trailer_make is distinct from old.trailer_make
      or new.trailer_plate is distinct from old.trailer_plate
      or new.storage_type is distinct from old.storage_type
      or new.arrival_date is distinct from old.arrival_date
      or new.expected_pickup_date is distinct from old.expected_pickup_date
      or new.deleted_at is distinct from old.deleted_at
    then
      raise exception 'Employees may only update a unit''s status and notes';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_units_enforce_update_permissions
  before update on public.units
  for each row execute function public.enforce_units_update_permissions();
