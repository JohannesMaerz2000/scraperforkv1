create table public.player_user_links (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  dtb_id bigint not null,
  player_name text not null,
  tennis_club text null,
  profile_url text null,
  linked_at timestamp with time zone not null default timezone ('utc'::text, now()),
  verified boolean null default false,
  constraint player_user_links_pkey primary key (id),
  constraint player_user_links_dtb_id_key unique (dtb_id),
  constraint player_user_links_user_id_key unique (user_id),
  constraint player_user_links_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_player_user_links_user_id on public.player_user_links using btree (user_id) TABLESPACE pg_default;

create index IF not exists idx_player_user_links_dtb_id on public.player_user_links using btree (dtb_id) TABLESPACE pg_default;

create trigger update_fullname_trigger
after INSERT
or DELETE
or
update on player_user_links for EACH row
execute FUNCTION update_fullname_on_link ();