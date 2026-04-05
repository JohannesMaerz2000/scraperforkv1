-- Convert tournament_registrations.dtb_id from text to bigint and preserve constraints/indexes.
-- Non-numeric or out-of-pattern legacy values are set to NULL.

begin;

alter table public.tournament_registrations
  add column if not exists dtb_id_bigint bigint;

update public.tournament_registrations
set dtb_id_bigint = case
  when dtb_id ~ '^\s*\d{5,12}\s*$' then trim(dtb_id)::bigint
  else null
end
where dtb_id_bigint is null;

-- Resolve collisions that can appear after normalization/cast (e.g. '00123' vs '123').
with ranked as (
  select
    id,
    row_number() over (
      partition by category_id, dtb_id_bigint
      order by created_at asc nulls last, id asc
    ) as rn
  from public.tournament_registrations
  where dtb_id_bigint is not null
)
update public.tournament_registrations tr
set dtb_id_bigint = null
from ranked r
where tr.id = r.id
  and r.rn > 1;

alter table public.tournament_registrations
  drop constraint if exists tournament_registrations_category_id_dtb_id_key;

drop index if exists public.idx_tournament_registrations_dtb_id;

alter table public.tournament_registrations
  drop column if exists dtb_id;

alter table public.tournament_registrations
  rename column dtb_id_bigint to dtb_id;

alter table public.tournament_registrations
  add constraint tournament_registrations_category_id_dtb_id_key unique (category_id, dtb_id);

create index if not exists idx_tournament_registrations_dtb_id
  on public.tournament_registrations using btree (dtb_id);

commit;
