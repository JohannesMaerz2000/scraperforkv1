create table public.league_fixtures (
  id uuid not null default gen_random_uuid (),
  league_group_id uuid not null,
  match_date date not null,
  match_time text null,
  home_club_id uuid null,
  away_club_id uuid null,
  home_team_label text null,
  away_team_label text null,
  is_home_for_main_club boolean null,
  status text null,
  result_text text null,
  source_url text null,
  source_hash text null,
  source_fetched_at timestamp with time zone null,
  ingest_run_id text null,
  parsed_from text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint league_fixtures_pkey primary key (id),
  constraint league_fixtures_away_club_id_fkey foreign KEY (away_club_id) references clubs (id) on delete set null,
  constraint league_fixtures_home_club_id_fkey foreign KEY (home_club_id) references clubs (id) on delete set null,
  constraint league_fixtures_league_group_id_fkey foreign KEY (league_group_id) references league_groups (id) on delete CASCADE
) TABLESPACE pg_default;

create unique INDEX IF not exists uq_league_fixtures_dedupe on public.league_fixtures using btree (
  league_group_id,
  match_date,
  match_time,
  home_team_label,
  away_team_label
) TABLESPACE pg_default;

create index IF not exists idx_league_fixtures_group_date on public.league_fixtures using btree (league_group_id, match_date) TABLESPACE pg_default;

create index IF not exists idx_league_fixtures_source_hash on public.league_fixtures using btree (source_hash) TABLESPACE pg_default;

create trigger update_league_fixtures_updated_at BEFORE
update on league_fixtures for EACH row
execute FUNCTION update_updated_at_column ();