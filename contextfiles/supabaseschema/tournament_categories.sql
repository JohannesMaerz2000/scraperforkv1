create table public.tournament_categories (
  id uuid not null default extensions.uuid_generate_v4 (),
  tournament_id uuid not null,
  category_name text not null,
  gender text null,
  age_group text null,
  type text not null,
  last_scraped_at timestamp with time zone null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  category_code text null,
  last_updated timestamp with time zone null default now(),
  source_category_id text not null,
  source_category_slug text null,
  source_status text null,
  constraint tournament_categories_pkey primary key (id),
  constraint tournament_categories_tournament_id_source_category_id_key unique (tournament_id, source_category_id),
  constraint tournament_categories_tournament_id_fkey foreign KEY (tournament_id) references tournaments (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_tournament_categories_category_name on public.tournament_categories using btree (category_name) TABLESPACE pg_default;

create index IF not exists idx_tournament_categories_tournament_id on public.tournament_categories using btree (tournament_id) TABLESPACE pg_default;

create index IF not exists idx_tournament_categories_source_category_id on public.tournament_categories using btree (source_category_id) TABLESPACE pg_default;

create trigger update_tournament_categories_modtime BEFORE
update on tournament_categories for EACH row
execute FUNCTION update_modified_column ();