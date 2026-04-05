-- Normalize club_player_rankings to reference canonical players and keep only observed snapshots.

alter table public.club_player_rankings
  add column if not exists player_id uuid null;

alter table public.club_player_rankings
  add column if not exists nationality text null;

-- Rename legacy columns when they still exist.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'player_dtb_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'observed_player_dtb_id'
  ) then
    alter table public.club_player_rankings rename column player_dtb_id to observed_player_dtb_id;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'player_dtb_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'observed_player_dtb_id'
  ) then
    execute 'update public.club_player_rankings set observed_player_dtb_id = coalesce(observed_player_dtb_id, player_dtb_id)';
    execute 'alter table public.club_player_rankings drop column if exists player_dtb_id';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'player_name'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'observed_player_name'
  ) then
    alter table public.club_player_rankings rename column player_name to observed_player_name;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'player_name'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and column_name = 'observed_player_name'
  ) then
    execute 'update public.club_player_rankings set observed_player_name = coalesce(observed_player_name, player_name)';
    execute 'alter table public.club_player_rankings drop column if exists player_name';
  end if;
end
$$;

alter table public.club_player_rankings
  add column if not exists observed_player_dtb_id bigint null;

alter table public.club_player_rankings
  add column if not exists observed_player_name text null;

-- Ensure observed name exists even for older rows.
update public.club_player_rankings
set observed_player_name = coalesce(observed_player_name, '')
where observed_player_name is null;

-- Normalize LK storage to numeric(4,1).
alter table public.club_player_rankings
  alter column lk_numeric type numeric(4, 1)
  using round(lk_numeric::numeric, 1);

-- Drop old textual LK snapshot once numeric canonical is available.
alter table public.club_player_rankings
  drop column if exists lk_text;

-- Backfill canonical player link by DTB ID.
update public.club_player_rankings cpr
set player_id = p.id
from public.players p
where cpr.player_id is null
  and cpr.observed_player_dtb_id is not null
  and p.dtb_id = cpr.observed_player_dtb_id;

-- Replace legacy uniqueness and indexes.
drop index if exists public.idx_club_player_rankings_player_dtb_id;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'club_player_rankings'
      and constraint_name = 'club_player_rankings_unique_player_per_season'
  ) then
    alter table public.club_player_rankings
      drop constraint club_player_rankings_unique_player_per_season;
  end if;
end
$$;

-- Tighten required fields for future inserts.
alter table public.club_player_rankings
  alter column observed_player_name set not null;

-- Keep legacy rows valid by filling missing rank/team with stable placeholders first.
update public.club_player_rankings
set overall_rank = 0
where overall_rank is null;

update public.club_player_rankings
set observed_source_team_id = coalesce(observed_source_team_id, 'unknown-team')
where observed_source_team_id is null;

alter table public.club_player_rankings
  alter column overall_rank set not null;

alter table public.club_player_rankings
  alter column observed_source_team_id set not null;

alter table public.club_player_rankings
  drop constraint if exists club_player_rankings_player_id_fkey;

alter table public.club_player_rankings
  add constraint club_player_rankings_player_id_fkey
  foreign key (player_id) references public.players (id) on delete set null;

-- Remove potential duplicate rows before creating the new uniqueness constraint.
delete from public.club_player_rankings a
using public.club_player_rankings b
where a.id < b.id
  and a.club_id is not distinct from b.club_id
  and a.season_year is not distinct from b.season_year
  and a.season_type is not distinct from b.season_type
  and a.observed_source_team_id = b.observed_source_team_id
  and a.observed_player_name = b.observed_player_name;

alter table public.club_player_rankings
  drop constraint if exists club_player_rankings_unique_team_row_per_season;

alter table public.club_player_rankings
  add constraint club_player_rankings_unique_team_row_per_season
  unique (club_id, season_year, season_type, observed_source_team_id, observed_player_name);

create index if not exists idx_club_player_rankings_player_id
  on public.club_player_rankings using btree (player_id);

create index if not exists idx_club_player_rankings_observed_player_dtb_id
  on public.club_player_rankings using btree (observed_player_dtb_id);
