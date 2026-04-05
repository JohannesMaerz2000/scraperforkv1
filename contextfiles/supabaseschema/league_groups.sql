create table public.league_groups (
  id uuid not null default gen_random_uuid (),
  federation_code text not null,
  season_year integer not null,
  season_type text not null,
  group_code text not null,
  league_name text null,
  competition_label text null,
  source_url text null,
  source_hash text null,
  source_fetched_at timestamp with time zone null,
  ingest_run_id text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  age_group text null,
  table_matrix jsonb null,
  constraint league_groups_pkey primary key (id)
) TABLESPACE pg_default;

create unique INDEX IF not exists uq_league_groups_canonical on public.league_groups using btree (
  federation_code,
  season_year,
  season_type,
  group_code
) TABLESPACE pg_default;

create index IF not exists idx_league_groups_group_code on public.league_groups using btree (group_code) TABLESPACE pg_default;

create index IF not exists idx_league_groups_source_hash on public.league_groups using btree (source_hash) TABLESPACE pg_default;

create index IF not exists idx_league_groups_age_group on public.league_groups using btree (age_group) TABLESPACE pg_default;

create trigger update_league_groups_updated_at BEFORE
update on league_groups for EACH row
execute FUNCTION update_updated_at_column ();