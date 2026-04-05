create table public.club_teams (
  id uuid not null default gen_random_uuid (),
  source_team_id text null,
  club_id uuid null,
  season_year integer null,
  season_type text null,
  group_code text null,
  team_label text null,
  team_number integer null,
  source_url text null,
  last_seen_at timestamp with time zone null default now(),
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint club_teams_pkey primary key (id),
  constraint club_teams_source_team_id_key unique (source_team_id),
  constraint club_teams_club_id_fkey foreign KEY (club_id) references clubs (id) on delete set null
) TABLESPACE pg_default;

create index IF not exists idx_club_teams_club_id on public.club_teams using btree (club_id) TABLESPACE pg_default;

create index IF not exists idx_club_teams_season on public.club_teams using btree (season_year, season_type) TABLESPACE pg_default;

create index IF not exists idx_club_teams_group_code on public.club_teams using btree (group_code) TABLESPACE pg_default;

create index IF not exists idx_club_teams_source_team_id on public.club_teams using btree (source_team_id) TABLESPACE pg_default;

create unique INDEX IF not exists uq_club_teams_group_per_season on public.club_teams using btree (
  club_id,
  COALESCE(season_year, '-1'::integer),
  COALESCE(season_type, ''::text),
  COALESCE(group_code, ''::text)
) TABLESPACE pg_default
where
  (group_code is not null);

create unique INDEX IF not exists uq_club_teams_label_fallback on public.club_teams using btree (
  club_id,
  COALESCE(season_year, '-1'::integer),
  COALESCE(season_type, ''::text),
  COALESCE(team_label, ''::text)
) TABLESPACE pg_default
where
  (
    (group_code is null)
    and (source_team_id is null)
  );

create trigger update_club_teams_updated_at BEFORE
update on club_teams for EACH row
execute FUNCTION update_updated_at_column ();