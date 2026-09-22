-- Extensions
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- fast fuzzy/substring search

-- Enums for small, structurally-fixed vocabularies.
-- (Unit status uses a lookup table instead — see 20260921190110 — since it
-- needs color/icon/sort metadata and admins should be able to extend it.)

create type app_role as enum ('admin', 'manager', 'employee');

create type unit_type_enum as enum (
  'boat', 'pontoon', 'tritoon', 'wake_boat', 'fishing_boat',
  'pwc', 'rv', 'camper', 'trailer', 'other'
);

create type storage_type_enum as enum (
  'heated_indoor', 'cold_indoor', 'outdoor', 'shrink_wrapped', 'temporary', 'other'
);

create type location_type_enum as enum (
  'storage_spot', 'intake_area', 'service_bay', 'detail_bay',
  'outdoor_staging', 'spring_pickup_area', 'delivery_area', 'temporary_location'
);

create type location_admin_status_enum as enum ('available', 'reserved', 'unavailable');

create type service_status_enum as enum ('requested', 'scheduled', 'in_progress', 'complete');

create type pickup_status_enum as enum ('scheduled', 'ready', 'completed');

create type fuel_level_enum as enum ('empty', 'quarter', 'half', 'three_quarter', 'full');

create type notable_entity_enum as enum ('unit', 'customer', 'intake');

-- Reusable "touch updated_at" trigger function.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
