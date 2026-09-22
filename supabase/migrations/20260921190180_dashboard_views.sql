-- Views back the capacity cards on the dashboard. Ordinary views (not
-- SECURITY DEFINER), so they run with the caller's own RLS automatically —
-- no separate permission model to maintain.

create or replace view public.v_location_occupancy as
select
  sl.id as location_id,
  sl.facility_id,
  sl.building_id,
  sl.storage_type,
  sl.location_type,
  sl.admin_status,
  sl.is_active,
  la.unit_id as occupied_by_unit_id
from public.storage_locations sl
left join public.location_assignments la
  on la.storage_location_id = sl.id and la.unassigned_at is null;

create or replace view public.v_capacity_by_storage_type as
select
  storage_type,
  count(*) filter (where is_active) as total_spaces,
  count(*) filter (where is_active and occupied_by_unit_id is not null) as occupied_spaces
from public.v_location_occupancy
where location_type = 'storage_spot'
group by storage_type;

create or replace view public.v_capacity_by_building as
select
  building_id,
  count(*) filter (where is_active) as total_spaces,
  count(*) filter (where is_active and occupied_by_unit_id is not null) as occupied_spaces
from public.v_location_occupancy
where location_type = 'storage_spot' and building_id is not null
group by building_id;
