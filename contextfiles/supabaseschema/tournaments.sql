create table public.tournaments (
  id uuid not null default extensions.uuid_generate_v4 (),
  event_id text not null,
  name text not null,
  start_date timestamp with time zone not null,
  end_date timestamp with time zone not null,
  location text not null,
  registration_deadline timestamp with time zone null,
  is_dtb_tournament boolean null default false,
  is_lk_tournament boolean null default false,
  google_maps_link text null,
  url text not null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint tournaments_pkey primary key (id),
  constraint tournaments_event_id_key unique (event_id)
) TABLESPACE pg_default;