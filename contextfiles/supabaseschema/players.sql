create table public.players (
  id uuid not null default extensions.uuid_generate_v4 (),
  dtb_id bigint not null,
  full_name text not null,
  leistungsklasse numeric(4, 1) null,
  club text null,
  nationality text null,
  association text null,
  profile_url text null,
  last_scraped timestamp without time zone null default now(),
  created_at timestamp without time zone null default now(),
  updated_at timestamp without time zone null default now(),
  history_backfill_completed boolean not null default false,
  history_backfill_completed_at timestamp with time zone null,
  history_last_synced_at timestamp with time zone null,
  history_latest_match_date date null,
  history_oldest_match_date date null,
  history_last_sync_mode text null,
  history_last_sync_status text null,
  main_club_id uuid null,
  gender_inferred text GENERATED ALWAYS as (
    case
      when ("left" ((dtb_id)::text, 1) = '1'::text) then 'm'::text
      when ("left" ((dtb_id)::text, 1) = '2'::text) then 'w'::text
      else null::text
    end
  ) STORED null,
  constraint players_pkey primary key (id),
  constraint players_dtb_id_key unique (dtb_id),
  constraint players_main_club_id_fkey foreign KEY (main_club_id) references clubs (id) on delete set null,
  constraint players_history_last_sync_mode_check check (
    (
      (
        history_last_sync_mode = any (
          array['full_backfill'::text, 'incremental_update'::text]
        )
      )
      or (history_last_sync_mode is null)
    )
  ),
  constraint players_history_last_sync_status_check check (
    (
      (
        history_last_sync_status = any (
          array['success'::text, 'partial'::text, 'failed'::text]
        )
      )
      or (history_last_sync_status is null)
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_players_club on public.players using btree (club) TABLESPACE pg_default;

create index IF not exists idx_players_dtb_id on public.players using btree (dtb_id) TABLESPACE pg_default;

create index IF not exists idx_players_name on public.players using btree (full_name) TABLESPACE pg_default;

create index IF not exists idx_players_main_club_id on public.players using btree (main_club_id) TABLESPACE pg_default;

create index IF not exists idx_players_gender_inferred on public.players using btree (gender_inferred) TABLESPACE pg_default;

create trigger update_players_updated_at BEFORE
update on players for EACH row
execute FUNCTION update_updated_at_column ();