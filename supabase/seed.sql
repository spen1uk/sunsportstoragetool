-- Realistic Sun Sport Marine sample data for development/testing.
--
-- IMPORTANT — run order:
--   1. Migrations must already be applied (schema + lookup data).
--   2. `node scripts/seed-demo-users.mjs` must already have run — this file
--      references the demo profiles ("Luke", "Mike", "Sarah") by name for
--      realistic attribution (who moved/serviced what).
--
-- Intentionally left EMPTY / AVAILABLE: Building 1 spot "A-14" and Building 2
-- spot "C-07" — these are reserved for the Phase 1 success-test walkthrough
-- (create John Smith + his 2021 Bennington 23 LSB, assign to A-14, then move
-- to C-07), so don't seed anything into them.

-- =========================================================================
-- Facility, buildings, and every storage/staging location
-- =========================================================================
do $$
declare
  v_facility_id uuid;
  v_building1_id uuid;
  v_building2_id uuid;
  v_section text;
  v_num int;
begin
  insert into public.facilities (name, address, city, state, zip)
  values ('Sun Sport Marine - Main Facility', '4800 Marina Drive', 'Harbor Springs', 'MI', '49740')
  returning id into v_facility_id;

  insert into public.buildings (facility_id, name, code, description, sort_order)
  values (v_facility_id, 'Building 1', 'B1', 'Heated indoor storage', 1)
  returning id into v_building1_id;

  insert into public.buildings (facility_id, name, code, description, sort_order)
  values (v_facility_id, 'Building 2', 'B2', 'Cold indoor storage', 2)
  returning id into v_building2_id;

  -- Building 1: heated indoor, sections A-C, 15 spots each
  foreach v_section in array array['A', 'B', 'C'] loop
    for v_num in 1..15 loop
      insert into public.storage_locations
        (facility_id, building_id, full_code, section, spot_number, location_type,
         storage_type, max_length_ft, max_width_ft, sort_order)
      values
        (v_facility_id, v_building1_id, v_section || '-' || lpad(v_num::text, 2, '0'),
         v_section, lpad(v_num::text, 2, '0'), 'storage_spot', 'heated_indoor', 28, 10,
         (case v_section when 'A' then 0 when 'B' then 100 else 200 end) + v_num);
    end loop;
  end loop;

  -- Building 2: cold indoor, sections A-C, 15 spots each
  foreach v_section in array array['A', 'B', 'C'] loop
    for v_num in 1..15 loop
      insert into public.storage_locations
        (facility_id, building_id, full_code, section, spot_number, location_type,
         storage_type, max_length_ft, max_width_ft, sort_order)
      values
        (v_facility_id, v_building2_id, v_section || '-' || lpad(v_num::text, 2, '0'),
         v_section, lpad(v_num::text, 2, '0'), 'storage_spot', 'cold_indoor', 26, 9,
         (case v_section when 'A' then 0 when 'B' then 100 else 200 end) + v_num);
    end loop;
  end loop;

  -- Outdoor yard: no building, sections A-B, 15 spots each
  foreach v_section in array array['A', 'B'] loop
    for v_num in 1..15 loop
      insert into public.storage_locations
        (facility_id, building_id, full_code, section, spot_number, location_type,
         storage_type, max_length_ft, max_width_ft, sort_order)
      values
        (v_facility_id, null, v_section || '-' || lpad(v_num::text, 2, '0'),
         v_section, lpad(v_num::text, 2, '0'), 'storage_spot', 'outdoor', 32, 12,
         (case v_section when 'A' then 0 else 100 end) + v_num);
    end loop;
  end loop;

  -- Staging / service locations
  insert into public.storage_locations (facility_id, building_id, full_code, location_type, storage_type, sort_order) values
    (v_facility_id, null, 'Intake Area', 'intake_area', 'temporary', 1000),
    (v_facility_id, null, 'Service Bay 1', 'service_bay', 'temporary', 1001),
    (v_facility_id, null, 'Service Bay 2', 'service_bay', 'temporary', 1002),
    (v_facility_id, null, 'Detail Bay', 'detail_bay', 'temporary', 1003),
    (v_facility_id, null, 'Spring Pickup Area', 'spring_pickup_area', 'temporary', 1004),
    (v_facility_id, null, 'Delivery Area', 'delivery_area', 'temporary', 1005);
end $$;

-- =========================================================================
-- Customers
-- =========================================================================
insert into public.customers (first_name, last_name, phone, email, address, city, state, zip, notes) values
  ('Robert', 'Anderson', '231-555-0142', 'randerson@example.com', '118 Birchwood Ln', 'Harbor Springs', 'MI', '49740', null),
  ('Karen', 'Mitchell', '231-555-0198', 'kmitchell@example.com', '42 Lakeview Ct', 'Petoskey', 'MI', '49770', null),
  ('Thomas', 'Wright', '231-555-0173', 'twright@example.com', '905 Shoreline Dr', 'Harbor Springs', 'MI', '49740', null),
  ('Patricia', 'Lewis', '231-555-0129', 'plewis@example.com', '27 Bayfront Ave', 'Petoskey', 'MI', '49770', null),
  ('Daniel', 'Foster', '231-555-0187', 'dfoster@example.com', '1188 Harbor Rd', 'Charlevoix', 'MI', '49720', null),
  ('Nancy', 'Coleman', '231-555-0165', 'ncoleman@example.com', '63 Sunset Trail', 'Harbor Springs', 'MI', '49740', null),
  ('Christopher', 'Hayes', '231-555-0119', 'chayes@example.com', '214 Marina Way', 'Petoskey', 'MI', '49770', null),
  ('Michelle', 'Turner', '231-555-0154', 'mturner@example.com', '77 Dockside Dr', 'Charlevoix', 'MI', '49720', null),
  ('Mark', 'Sullivan', '231-555-0136', 'msullivan@example.com', '305 Anchor St', 'Harbor Springs', 'MI', '49740', null),
  ('Amanda', 'Reed', '231-555-0181', 'areed@example.com', '19 Pier Ln', 'Petoskey', 'MI', '49770', null),
  ('Kevin', 'Brooks', '231-555-0147', 'kbrooks@example.com', '440 Regatta Rd', 'Charlevoix', 'MI', '49720', null),
  ('Laura', 'Bennett', '231-555-0192', 'lbennett@example.com', '58 Windward Ave', 'Harbor Springs', 'MI', '49740', null),
  ('Steven', 'Price', '231-555-0128', 'sprice@example.com', '812 Cove Ct', 'Petoskey', 'MI', '49770', null),
  ('George', 'Kim', '231-555-0163', 'gkim@example.com', '29 Harborview Dr', 'Charlevoix', 'MI', '49720', 'Long-time customer, always requests the same outdoor row.');

-- =========================================================================
-- Units
-- =========================================================================
insert into public.units (
  internal_storage_id, customer_id, unit_type, year, make, model, length_ft, beam_ft,
  registration_number, hin, trailer_included, storage_type, status_code, arrival_date, expected_pickup_date
) values
  ('SSM-2026-00001', (select id from public.customers where first_name = 'Robert' and last_name = 'Anderson'),
   'pontoon', 2019, 'Bennington', '23SSRXP', 23, 8.5, 'MI-4471-AB', 'BEN23991A919', true, 'heated_indoor', 'stored', '2026-09-10', '2027-05-01'),

  ('SSM-2026-00002', (select id from public.customers where first_name = 'Karen' and last_name = 'Mitchell'),
   'wake_boat', 2021, 'Malibu', '22 LSV', 22, 8.5, 'MI-5502-CD', 'MAL22LSV21B22', true, 'heated_indoor', 'service_complete', '2026-09-05', '2027-04-20'),

  ('SSM-2026-00003', (select id from public.customers where first_name = 'Thomas' and last_name = 'Wright'),
   'fishing_boat', 2018, 'Lund', '1875 Fisherman', 19, 7.5, 'MI-2201-EF', 'LUND1875F18C33', true, 'outdoor', 'stored', '2026-09-12', '2027-04-15'),

  ('SSM-2026-00004', (select id from public.customers where first_name = 'Patricia' and last_name = 'Lewis'),
   'pwc', 2020, 'Sea-Doo', 'GTX', 11, 4, 'MI-9981-GH', 'SEAD11GTX0D44', true, 'cold_indoor', 'stored', '2026-09-08', '2027-05-10'),

  ('SSM-2026-00005', (select id from public.customers where first_name = 'Daniel' and last_name = 'Foster'),
   'fishing_boat', 2022, 'Grady-White', '236', 23, 8.5, 'MI-3345-IJ', 'GRAD236F22E55', true, 'heated_indoor', 'needs_service', '2026-09-14', '2027-05-15'),

  ('SSM-2026-00006', (select id from public.customers where first_name = 'Nancy' and last_name = 'Coleman'),
   'pontoon', 2017, 'Starcraft', 'Marine LX', 22, 8.5, 'MI-1187-KL', 'STAR22LX17F66', true, 'outdoor', 'ready_for_pickup', '2026-05-01', '2026-09-25'),

  ('SSM-2026-00007', (select id from public.customers where first_name = 'Christopher' and last_name = 'Hayes'),
   'wake_boat', 2023, 'Yamaha', '252SD', 25, 8.5, 'MI-7723-MN', 'YAM252SD23G77', true, 'cold_indoor', 'pickup_scheduled', '2026-06-01', '2026-09-30'),

  ('SSM-2026-00008', (select id from public.customers where first_name = 'Michelle' and last_name = 'Turner'),
   'fishing_boat', 2016, 'Crestliner', '1850', 18, 7.5, 'MI-4432-OP', 'CRES1850F16H88', true, 'outdoor', 'needs_detailing', '2026-09-16', '2027-04-10'),

  ('SSM-2026-00009', (select id from public.customers where first_name = 'Mark' and last_name = 'Sullivan'),
   'pontoon', 2019, 'Sun Tracker', 'Party Barge', 20, 8, 'MI-6621-QR', 'SUNT20PB19I99', true, 'outdoor', 'needs_location', '2026-09-19', '2027-05-05'),

  ('SSM-2026-00010', (select id from public.customers where first_name = 'Amanda' and last_name = 'Reed'),
   'fishing_boat', 2020, 'Tracker', 'Pro Team 175', 17, 7, 'MI-8834-ST', 'TRAC175PT20J00', true, 'outdoor', 'stored', '2026-09-11', '2027-04-25'),

  ('SSM-2026-00011', (select id from public.customers where first_name = 'Robert' and last_name = 'Anderson'),
   'pontoon', 2018, 'Bennington', '22SSR', 22, 8, 'MI-2290-UV', 'BEN22SSR18K11', true, 'heated_indoor', 'needs_location', null, null),

  ('SSM-2026-00012', (select id from public.customers where first_name = 'Kevin' and last_name = 'Brooks'),
   'wake_boat', 2020, 'Malibu', '22 LSV', 22, 8.5, 'MI-3312-WX', 'MAL22LSV20L22', true, 'heated_indoor', 'needs_location', null, null),

  ('SSM-2026-00013', (select id from public.customers where first_name = 'Laura' and last_name = 'Bennett'),
   'fishing_boat', 2017, 'Lund', '1875', 19, 7.5, 'MI-5567-YZ', 'LUND1875F17M33', true, 'outdoor', 'needs_location', null, null),

  ('SSM-2026-00014', (select id from public.customers where first_name = 'Steven' and last_name = 'Price'),
   'pwc', 2019, 'Yamaha', 'WaveRunner FX', 11, 4, 'MI-7789-AA', 'YAMFX11WR19N44', false, 'cold_indoor', 'scheduled_for_arrival', null, null),

  ('SSM-2026-00015', (select id from public.customers where first_name = 'George' and last_name = 'Kim'),
   'rv', 2015, 'Airstream', 'Flying Cloud', 27, 8.5, 'MI-9012-BB', 'AIRFC27RV15O55', false, 'outdoor', 'stored', '2026-09-09', '2027-04-30');

update public.units set expected_pickup_date = '2026-09-22'
  where internal_storage_id = 'SSM-2026-00006';

-- =========================================================================
-- Current + historical locations for every already-placed unit
-- =========================================================================

-- Simple single-move history: arrived straight into its current spot.
insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
select u.id, sl.id, u.arrival_date::timestamptz + interval '9 hours', (select id from public.profiles where full_name = 'Luke')
from public.units u
join public.storage_locations sl on (
  (u.internal_storage_id = 'SSM-2026-00001' and sl.building_id = (select id from public.buildings where code = 'B1') and sl.full_code = 'A-05') or
  (u.internal_storage_id = 'SSM-2026-00003' and sl.building_id is null and sl.full_code = 'A-08') or
  (u.internal_storage_id = 'SSM-2026-00004' and sl.building_id = (select id from public.buildings where code = 'B2') and sl.full_code = 'A-02') or
  (u.internal_storage_id = 'SSM-2026-00007' and sl.building_id = (select id from public.buildings where code = 'B2') and sl.full_code = 'B-06') or
  (u.internal_storage_id = 'SSM-2026-00010' and sl.building_id is null and sl.full_code = 'B-02') or
  (u.internal_storage_id = 'SSM-2026-00015' and sl.building_id is null and sl.full_code = 'B-05')
);

insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
select la.unit_id, null, la.storage_location_id, la.assigned_by, la.assigned_at
from public.location_assignments la
join public.units u on u.id = la.unit_id
where u.internal_storage_id in ('SSM-2026-00001', 'SSM-2026-00003', 'SSM-2026-00004', 'SSM-2026-00007', 'SSM-2026-00010', 'SSM-2026-00015');

-- Daniel Foster's Grady-White: currently in Service Bay 1 for engine repair
insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
select u.id, sl.id, now() - interval '2 days', (select id from public.profiles where full_name = 'Mike')
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00005' and sl.building_id is null and sl.full_code = 'Service Bay 1';

insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
select u.id, null, sl.id, (select id from public.profiles where full_name = 'Mike'), now() - interval '2 days'
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00005' and sl.building_id is null and sl.full_code = 'Service Bay 1';

-- Nancy Coleman's Starcraft: sitting in the Spring Pickup Area, ready to go
insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
select u.id, sl.id, now() - interval '1 day', (select id from public.profiles where full_name = 'Sarah')
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00006' and sl.building_id is null and sl.full_code = 'Spring Pickup Area';

insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
select u.id, null, sl.id, (select id from public.profiles where full_name = 'Sarah'), now() - interval '1 day'
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00006' and sl.building_id is null and sl.full_code = 'Spring Pickup Area';

-- Michelle Turner's Crestliner: in the Detail Bay
insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
select u.id, sl.id, now() - interval '1 day', (select id from public.profiles where full_name = 'Sarah')
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00008' and sl.building_id is null and sl.full_code = 'Detail Bay';

insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
select u.id, null, sl.id, (select id from public.profiles where full_name = 'Sarah'), now() - interval '1 day'
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00008' and sl.building_id is null and sl.full_code = 'Detail Bay';

-- Mark Sullivan's Party Barge: freshly arrived, sitting in the Intake Area,
-- awaiting a permanent spot — this is what puts it in the Unassigned queue.
insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
select u.id, sl.id, now() - interval '6 hours', (select id from public.profiles where full_name = 'Sarah')
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00009' and sl.building_id is null and sl.full_code = 'Intake Area';

insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
select u.id, null, sl.id, (select id from public.profiles where full_name = 'Sarah'), now() - interval '6 hours'
from public.units u, public.storage_locations sl
where u.internal_storage_id = 'SSM-2026-00009' and sl.building_id is null and sl.full_code = 'Intake Area';

-- Karen Mitchell's Malibu — the flagship history example: arrived into
-- storage, moved to Service Bay 1 for winterization, moved back to storage.
-- Mirrors the spec's own dashboard example almost verbatim.
do $$
declare
  v_unit_id uuid := (select id from public.units where internal_storage_id = 'SSM-2026-00002');
  v_spot_id uuid := (select sl.id from public.storage_locations sl
                      where sl.building_id = (select id from public.buildings where code = 'B1') and sl.full_code = 'B-03');
  v_bay_id uuid := (select id from public.storage_locations where building_id is null and full_code = 'Service Bay 1');
  v_luke uuid := (select id from public.profiles where full_name = 'Luke');
  v_mike uuid := (select id from public.profiles where full_name = 'Mike');
begin
  -- Move 1: arrival -> B-03
  insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
  values (v_unit_id, null, v_spot_id, v_luke, now() - interval '10 days');

  -- Move 2: B-03 -> Service Bay 1 (for winterization)
  insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
  values (v_unit_id, v_spot_id, v_bay_id, v_mike, now() - interval '3 days');

  -- Move 3: Service Bay 1 -> B-03 (back in storage after service)
  insert into public.location_history (unit_id, from_location_id, to_location_id, moved_by, moved_at)
  values (v_unit_id, v_bay_id, v_spot_id, v_mike, now() - interval '1 day');

  -- Current active assignment reflects the final move
  insert into public.location_assignments (unit_id, storage_location_id, assigned_at, assigned_by)
  values (v_unit_id, v_spot_id, now() - interval '1 day', v_mike);

  insert into public.activity_logs (employee_id, action, entity_type, entity_id, old_value, new_value)
  values
    (v_luke, 'unit_moved', 'unit', v_unit_id, jsonb_build_object('location_id', null), jsonb_build_object('location_id', v_spot_id)),
    (v_mike, 'unit_moved', 'unit', v_unit_id, jsonb_build_object('location_id', v_spot_id), jsonb_build_object('location_id', v_bay_id)),
    (v_mike, 'unit_moved', 'unit', v_unit_id, jsonb_build_object('location_id', v_bay_id), jsonb_build_object('location_id', v_spot_id));
end $$;

-- =========================================================================
-- Services
-- =========================================================================
insert into public.unit_services (unit_id, service_type_id, status, requested_at, scheduled_at, completed_at, assigned_employee_id, notes)
values (
  (select id from public.units where internal_storage_id = 'SSM-2026-00002'),
  (select id from public.service_types where name = 'Winterization'),
  'complete',
  now() - interval '9 days', now() - interval '3 days', now() - interval '1 day',
  (select id from public.profiles where full_name = 'Mike'),
  null
);

insert into public.activity_logs (employee_id, action, entity_type, entity_id, old_value, new_value, created_at)
values (
  (select id from public.profiles where full_name = 'Mike'),
  'service_completed', 'unit',
  (select id from public.units where internal_storage_id = 'SSM-2026-00002'),
  jsonb_build_object('service', 'Winterization', 'status', 'in_progress'),
  jsonb_build_object('service', 'Winterization', 'status', 'complete'),
  now() - interval '1 day'
);

insert into public.unit_services (unit_id, service_type_id, status, requested_at, scheduled_at, assigned_employee_id)
values (
  (select id from public.units where internal_storage_id = 'SSM-2026-00005'),
  (select id from public.service_types where name = 'Engine Repair'),
  'in_progress',
  now() - interval '3 days', now() - interval '2 days',
  (select id from public.profiles where full_name = 'Mike')
);

insert into public.unit_services (unit_id, service_type_id, status, requested_at)
values (
  (select id from public.units where internal_storage_id = 'SSM-2026-00008'),
  (select id from public.service_types where name = 'Detailing'),
  'in_progress',
  now() - interval '1 day'
);

-- =========================================================================
-- Pickups (Spring Pull / Pickup Queue)
-- =========================================================================
insert into public.pickups (unit_id, requested_pickup_date, status, scheduled_by)
values (
  (select id from public.units where internal_storage_id = 'SSM-2026-00006'),
  '2026-09-25', 'ready',
  (select id from public.profiles where full_name = 'Sarah')
);

insert into public.pickups (unit_id, requested_pickup_date, status, scheduled_by)
values (
  (select id from public.units where internal_storage_id = 'SSM-2026-00007'),
  '2026-09-30', 'scheduled',
  (select id from public.profiles where full_name = 'Luke')
);

-- =========================================================================
-- A couple of notes, for realism
-- =========================================================================
insert into public.notes (entity_type, entity_id, author_id, body, created_at)
values
  ('unit', (select id from public.units where internal_storage_id = 'SSM-2026-00005'),
   (select id from public.profiles where full_name = 'Mike'),
   'Customer reports intermittent stalling at low RPM — checking fuel lines first.', now() - interval '2 days'),
  ('customer', (select id from public.customers where first_name = 'George' and last_name = 'Kim'),
   (select id from public.profiles where full_name = 'Luke'),
   'Always requests the same outdoor row (B) — try to keep him there each season.', now() - interval '30 days');
