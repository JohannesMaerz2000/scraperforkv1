create table public.tournament_registrations (
  id uuid not null default extensions.uuid_generate_v4 (),
  category_id uuid not null,
  player_name text not null,
  club_name text null,
  lk_rating text null,
  is_seeded boolean null default false,
  seed_number integer null,
  created_at timestamp with time zone null default now(),
  position integer null,
  updated_at timestamp with time zone null default now(),
  dtb_ranking integer null,
  lk_rating_numeric numeric(3, 1) null,
  registration_status text null default 'main_draw'::text,
  section_name text null,
  dtb_id bigint null,
  constraint tournament_registrations_pkey primary key (id),
  constraint tournament_registrations_category_id_dtb_id_key unique (category_id, dtb_id),
  constraint tournament_registrations_category_id_player_name_club_name_key unique (category_id, player_name, club_name),
  constraint tournament_registrations_category_id_fkey foreign KEY (category_id) references tournament_categories (id) on delete CASCADE,
  constraint check_registration_status check (
    (
      registration_status = any (
        array[
          'main_draw'::text,
          'nachrücker'::text,
          'qualifikation'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_tournament_registrations_category_id on public.tournament_registrations using btree (category_id) TABLESPACE pg_default;

create index IF not exists idx_tournament_registrations_dtb_ranking on public.tournament_registrations using btree (dtb_ranking) TABLESPACE pg_default;

create index IF not exists idx_tournament_registrations_lk_rating_numeric on public.tournament_registrations using btree (lk_rating_numeric) TABLESPACE pg_default;

create index IF not exists idx_tournament_registrations_registration_status on public.tournament_registrations using btree (registration_status) TABLESPACE pg_default;

create index IF not exists idx_tournament_registrations_dtb_id on public.tournament_registrations using btree (dtb_id) TABLESPACE pg_default;

create trigger update_tournament_registrations_modtime BEFORE
update on tournament_registrations for EACH row
execute FUNCTION update_modified_column ();