-- Experimental only: fully separate automation queue for player-history scraping.
-- This schema does not modify existing production tables or constraints.

create table if not exists public.exp_player_history_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  label text not null,
  team_portrait_url text null,
  status text not null default 'active' check (status in ('draft', 'active', 'paused', 'completed', 'failed')),
  target_count integer not null default 0,
  seed_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null,
  created_by_user_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.exp_player_history_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.exp_player_history_batches(id) on delete cascade,
  dtb_id bigint not null,
  player_name text null,
  source_team_id text null,
  source_rank integer null,
  priority integer not null default 100,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  locked_at timestamptz null,
  locked_by text null,
  last_started_at timestamptz null,
  last_finished_at timestamptz null,
  next_retry_at timestamptz null,
  last_error_code text null,
  last_error_message text null,
  last_sync_mode text null check (last_sync_mode in ('full_backfill', 'incremental_update') or last_sync_mode is null),
  matches_scraped integer not null default 0,
  meta jsonb null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exp_player_history_jobs_unique_batch_dtb unique (batch_id, dtb_id)
);

create index if not exists idx_exp_player_history_jobs_batch_status
  on public.exp_player_history_jobs(batch_id, status);

create index if not exists idx_exp_player_history_jobs_claim
  on public.exp_player_history_jobs(status, next_retry_at, priority, created_at);

create index if not exists idx_exp_player_history_jobs_dtb
  on public.exp_player_history_jobs(dtb_id);

create index if not exists idx_exp_player_history_batches_status
  on public.exp_player_history_batches(status, created_at);

do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'update_updated_at_column'
  ) then
    begin
      create trigger update_exp_player_history_batches_updated_at
      before update on public.exp_player_history_batches
      for each row execute function update_updated_at_column();
    exception
      when duplicate_object then null;
    end;

    begin
      create trigger update_exp_player_history_jobs_updated_at
      before update on public.exp_player_history_jobs
      for each row execute function update_updated_at_column();
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;
