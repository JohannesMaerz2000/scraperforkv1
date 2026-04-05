create table public.club_player_rankings (
  id uuid not null default extensions.uuid_generate_v4 (),
  club_id uuid null,
  season_year integer null,
  season_type text null,
  player_id uuid null,
  observed_player_dtb_id bigint null,
  observed_player_name text not null,
  overall_rank integer not null,
  lk_numeric numeric(4, 1) null,
  nationality text null,
  observed_source_team_id text not null,
  observed_group_code text null,
  observed_source_url text null,
  parsed_from text null,
  last_seen_at timestamp with time zone null default now(),
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint club_player_rankings_pkey primary key (id),
  constraint club_player_rankings_unique_team_row_per_season unique (club_id, season_year, season_type, observed_source_team_id, observed_player_name),
  constraint club_player_rankings_club_id_fkey foreign KEY (club_id) references clubs (id) on delete set null,
  constraint club_player_rankings_player_id_fkey foreign KEY (player_id) references players (id) on delete set null
) TABLESPACE pg_default;

create index IF not exists idx_club_player_rankings_club_season on public.club_player_rankings using btree (club_id, season_year, season_type) TABLESPACE pg_default;

create index IF not exists idx_club_player_rankings_player_id on public.club_player_rankings using btree (player_id) TABLESPACE pg_default;

create index IF not exists idx_club_player_rankings_observed_player_dtb_id on public.club_player_rankings using btree (observed_player_dtb_id) TABLESPACE pg_default;

create index IF not exists idx_club_player_rankings_rank on public.club_player_rankings using btree (overall_rank) TABLESPACE pg_default;

create trigger update_club_player_rankings_updated_at BEFORE
update on club_player_rankings for EACH row
execute FUNCTION update_updated_at_column ();
