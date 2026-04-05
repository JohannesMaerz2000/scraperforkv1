create table public.league_group_teams (
  id uuid not null default gen_random_uuid (),
  league_group_id uuid not null,
  club_id uuid null,
  club_team_id uuid null,
  team_label text null,
  rank integer null,
  points_text text null,
  matches_text text null,
  sets_text text null,
  join_confidence text null,
  raw_team_text text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint league_group_teams_pkey primary key (id),
  constraint league_group_teams_club_id_fkey foreign KEY (club_id) references clubs (id) on delete set null,
  constraint league_group_teams_club_team_id_fkey foreign KEY (club_team_id) references club_teams (id) on delete set null,
  constraint league_group_teams_league_group_id_fkey foreign KEY (league_group_id) references league_groups (id) on delete CASCADE
) TABLESPACE pg_default;

create unique INDEX IF not exists uq_league_group_teams_joined on public.league_group_teams using btree (league_group_id, club_id, team_label) TABLESPACE pg_default;

create index IF not exists idx_league_group_teams_group on public.league_group_teams using btree (league_group_id) TABLESPACE pg_default;

create index IF not exists idx_league_group_teams_club on public.league_group_teams using btree (club_id) TABLESPACE pg_default;

create trigger update_league_group_teams_updated_at BEFORE
update on league_group_teams for EACH row
execute FUNCTION update_updated_at_column ();