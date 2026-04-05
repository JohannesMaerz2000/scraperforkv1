create table public.follows (
  id uuid not null default gen_random_uuid (),
  follower_id uuid not null,
  target_dtb_id bigint not null,
  followed_at timestamp with time zone not null default timezone ('utc'::text, now()),
  is_active boolean not null default true,
  constraint follows_pkey primary key (id),
  constraint follows_follower_id_target_dtb_id_key unique (follower_id, target_dtb_id),
  constraint follows_follower_id_fkey foreign KEY (follower_id) references auth.users (id) on delete CASCADE,
  constraint follows_target_dtb_id_fkey foreign KEY (target_dtb_id) references players (dtb_id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_follows_followed_at on public.follows using btree (followed_at desc) TABLESPACE pg_default;

create index IF not exists idx_follows_follower_id on public.follows using btree (follower_id) TABLESPACE pg_default;

create index IF not exists idx_follows_target_dtb_id on public.follows using btree (target_dtb_id) TABLESPACE pg_default;