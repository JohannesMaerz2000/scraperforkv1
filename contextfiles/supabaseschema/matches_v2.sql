create table public.matches_v2 (
  id uuid not null default extensions.uuid_generate_v4 (),
  match_fingerprint text not null,
  match_date date null,
  event_name text null,
  is_double boolean not null default false,
  is_walkover boolean not null default false,
  is_retirement boolean not null default false,
  is_completed boolean not null default true,
  team1_player1_name text not null,
  team1_player1_dtb_id bigint null,
  team1_player2_name text null,
  team1_player2_dtb_id bigint null,
  team2_player1_name text not null,
  team2_player1_dtb_id bigint null,
  team2_player2_name text null,
  team2_player2_dtb_id bigint null,
  normalized_score text null,
  winner_side smallint null,
  source_url text null,
  scraped_at timestamp without time zone null default now(),
  created_at timestamp without time zone null default now(),
  updated_at timestamp without time zone null default now(),
  soft_match_key text null,
  fingerprint_version smallint not null default 2,
  identity_confidence text not null default 'high'::text,
  is_identity_ambiguous boolean not null default false,
  team1_player1_lk numeric null,
  team1_player1_lk_improvement numeric null,
  team1_player2_lk numeric null,
  team1_player2_lk_improvement numeric null,
  team2_player1_lk numeric null,
  team2_player1_lk_improvement numeric null,
  team2_player2_lk numeric null,
  team2_player2_lk_improvement numeric null,
  constraint matches_v2_pkey primary key (id),
  constraint matches_v2_match_fingerprint_key unique (match_fingerprint),
  constraint matches_v2_identity_confidence_check check (
    (
      identity_confidence = any (array['high'::text, 'medium'::text, 'low'::text])
    )
  ),
  constraint matches_v2_winner_side_check check (
    (
      (winner_side is null)
      or (winner_side = any (array[1, 2]))
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_date on public.matches_v2 using btree (match_date desc) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_event on public.matches_v2 using btree (event_name) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_fingerprint on public.matches_v2 using btree (match_fingerprint) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_team1_player1_dtb_id on public.matches_v2 using btree (team1_player1_dtb_id) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_team2_player1_dtb_id on public.matches_v2 using btree (team2_player1_dtb_id) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_winner_side on public.matches_v2 using btree (winner_side) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_soft_match_key on public.matches_v2 using btree (soft_match_key) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_team1_player2_dtb_id on public.matches_v2 using btree (team1_player2_dtb_id) TABLESPACE pg_default;

create index IF not exists idx_matches_v2_team2_player2_dtb_id on public.matches_v2 using btree (team2_player2_dtb_id) TABLESPACE pg_default;

create trigger update_matches_v2_updated_at BEFORE
update on matches_v2 for EACH row
execute FUNCTION update_updated_at_column ();