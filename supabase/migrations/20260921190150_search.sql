-- Trigram indexes for fast fuzzy/substring search across the fields
-- employees actually search by.
create index idx_customers_name_trgm on public.customers using gin ((first_name || ' ' || last_name) gin_trgm_ops);
create index idx_customers_phone_trgm on public.customers using gin (phone gin_trgm_ops);
create index idx_customers_email_trgm on public.customers using gin (email gin_trgm_ops);

create index idx_units_make_trgm on public.units using gin (make gin_trgm_ops);
create index idx_units_model_trgm on public.units using gin (model gin_trgm_ops);
create index idx_units_registration_trgm on public.units using gin (registration_number gin_trgm_ops);
create index idx_units_hin_trgm on public.units using gin (hin gin_trgm_ops);
create index idx_units_internal_id_trgm on public.units using gin (internal_storage_id gin_trgm_ops);

create index idx_storage_locations_full_code_trgm on public.storage_locations using gin (full_code gin_trgm_ops);

-- One RPC, one round trip: ranked units + customers matching a query.
-- Runs as the caller so normal RLS (deleted_at filtering included) applies.
create or replace function public.search_everything(p_query text)
returns table (
  result_type text,
  id uuid,
  title text,
  subtitle text,
  href text
)
language sql
stable
as $$
  select
    'unit' as result_type,
    u.id,
    trim(both ' ' from coalesce(u.year::text, '') || ' ' || coalesce(u.make, '') || ' ' || coalesce(u.model, '')) as title,
    trim(both ', ' from
      coalesce(c.first_name || ' ' || c.last_name, '') ||
      case when sl.full_code is not null then ', ' || sl.full_code else '' end
    ) as subtitle,
    '/units/' || u.id as href
  from public.units u
  join public.customers c on c.id = u.customer_id
  left join public.location_assignments la on la.unit_id = u.id and la.unassigned_at is null
  left join public.storage_locations sl on sl.id = la.storage_location_id
  where u.deleted_at is null
    and (
      u.make ilike '%' || p_query || '%'
      or u.model ilike '%' || p_query || '%'
      or u.registration_number ilike '%' || p_query || '%'
      or u.hin ilike '%' || p_query || '%'
      or u.internal_storage_id ilike '%' || p_query || '%'
      or u.year::text ilike '%' || p_query || '%'
      or sl.full_code ilike '%' || p_query || '%'
      or c.first_name ilike '%' || p_query || '%'
      or c.last_name ilike '%' || p_query || '%'
      or c.phone ilike '%' || p_query || '%'
      or c.email ilike '%' || p_query || '%'
    )

  union all

  select
    'customer' as result_type,
    c.id,
    c.first_name || ' ' || c.last_name as title,
    trim(both ', ' from coalesce(c.phone, '') || case when c.email is not null then ', ' || c.email else '' end) as subtitle,
    '/customers/' || c.id as href
  from public.customers c
  where c.deleted_at is null
    and (
      c.first_name ilike '%' || p_query || '%'
      or c.last_name ilike '%' || p_query || '%'
      or c.phone ilike '%' || p_query || '%'
      or c.email ilike '%' || p_query || '%'
    )

  limit 25;
$$;

grant execute on function public.search_everything(text) to authenticated;
