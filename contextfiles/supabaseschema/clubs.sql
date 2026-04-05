create table public.clubs (
  id uuid not null default gen_random_uuid (),
  source_club_id text not null,
  name text not null,
  last_seen_at timestamp with time zone null default now(),
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint clubs_pkey primary key (id),
  constraint clubs_source_club_id_key unique (source_club_id)
) TABLESPACE pg_default;

create index IF not exists idx_clubs_source_club_id on public.clubs using btree (source_club_id) TABLESPACE pg_default;

create index IF not exists idx_clubs_name on public.clubs using btree (name) TABLESPACE pg_default;

create trigger update_clubs_updated_at BEFORE
update on clubs for EACH row
execute FUNCTION update_updated_at_column ();