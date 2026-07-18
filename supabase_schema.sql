create table entries (
  id bigint generated always as identity primary key,
  client_id uuid unique not null,
  ts timestamptz not null,
  lat double precision,
  lon double precision,
  gps_accuracy_m real,
  type text not null check (type in ('food', 'stay', 'sight', 'transport', 'cost', 'note', 'people')),
  title text,
  body text,
  rating int check (rating between 1 and 5),
  cost_amt numeric,
  currency text default 'ISK',
  tags text[] default '{}',
  audio_path text,
  transcript text,
  transcript_status text default 'none' check (transcript_status in ('none', 'pending', 'done', 'failed')),
  created_offline boolean default false,
  synced_at timestamptz
);

create index entries_ts_idx on entries (ts);
create index entries_type_idx on entries (type);

alter table entries enable row level security;

create policy "Authenticated users can manage entries"
on entries
for all
to authenticated
using (auth.uid() is not null)
with check (auth.uid() is not null);

-- Create a PRIVATE Storage bucket named "trail-audio" before using these policies.
create policy "Authenticated users can read trail audio"
on storage.objects
for select
to authenticated
using (bucket_id = 'trail-audio' and auth.uid() is not null);

create policy "Authenticated users can upload trail audio"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'trail-audio' and auth.uid() is not null);

create policy "Authenticated users can update trail audio"
on storage.objects
for update
to authenticated
using (bucket_id = 'trail-audio' and auth.uid() is not null)
with check (bucket_id = 'trail-audio' and auth.uid() is not null);

create policy "Authenticated users can delete trail audio"
on storage.objects
for delete
to authenticated
using (bucket_id = 'trail-audio' and auth.uid() is not null);
