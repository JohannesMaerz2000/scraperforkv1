-- DANGER: This deletes all rows from the requested tables.
-- Tables cleared:
--   public.matches_v2
--   public.players
--   public.exp_player_history_jobs
--   public.exp_player_history_batches

begin;

-- Queue tables first (jobs references batches)
delete from public.exp_player_history_jobs;
delete from public.exp_player_history_batches;

-- Core scrape output tables
delete from public.matches_v2;
delete from public.players;

commit;
