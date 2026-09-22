-- Private buckets — the app reads via signed URLs, never a public bucket,
-- since these are tied to customer/unit data.
insert into storage.buckets (id, name, public)
values ('unit-photos', 'unit-photos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "unit_photos_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'unit-photos');

create policy "unit_photos_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'unit-photos');

create policy "documents_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents');

create policy "documents_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents');
