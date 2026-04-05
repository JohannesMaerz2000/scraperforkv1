# Automated Player History Scraping Plan (Fork v1, Updated)

Last updated: 2026-04-05

## Scope
- This fork is a separate automation experiment.
- Focus is only `player_history` scraping.
- Team/league/tournament automation remains out of scope.
- Core app data flow remains unchanged:
  - `players` for history state
  - `matches_v2` for canonical matches

## Current Strategy (Implemented)
Use the current team page URL (`#teamportrait/...`) as the entrypoint and run:
1. Open `Spieler:innen` tab.
2. Expand list (`Mehr Spieler:innen anzeigen`) until full list is visible.
3. Build player queue from visible rows (`DTB-ID` + name + rank).
4. For each queued player, click `anzeigen`.
5. Reuse existing full-history sync flow (`full_backfill` / `incremental_update`).
6. Persist queue/job state in separate experiment tables.

This avoids dependency on direct player profile URLs.

## Resume Model
- Each team URL maps to a stable batch key:
  - `exp_team_<teamId>_full_playerlist`
- Restarting from the same team URL continues where it left off.
- Completed jobs are not reset.
- Failed jobs are retryable up to `max_attempts`.
- Sidepanel shows progress from DB (`completed_count / seed_count`).

## Experimental Tables (Separate from Main App)

### `exp_player_history_batches`
- One row per team batch run (logical campaign for one team URL).
- Tracks:
  - `batch_key`
  - `team_portrait_url`
  - `status`
  - `target_count`
  - `seed_count`
  - `completed_count`
  - `failed_count`
  - `started_at`, `finished_at`
  - `last_error`

### `exp_player_history_jobs`
- One row per `dtb_id` within a batch.
- Unique key: `(batch_id, dtb_id)`.
- Tracks:
  - `status` (`pending|running|completed|failed|skipped`)
  - `attempt_count`, `max_attempts`
  - `next_retry_at`
  - `last_error_code`, `last_error_message`
  - `last_sync_mode`
  - `matches_scraped`
  - `meta`

## Worker Behavior
1. Ensure/load stable batch for current team URL.
2. Upsert jobs from team player list.
3. Claim next eligible job (`pending` or retryable `failed`).
4. Navigate back to team URL.
5. Open player row by `DTB-ID` via `anzeigen`.
6. Run existing history sync.
7. Mark job `completed` or `failed`.
8. Refresh batch counters.
9. Repeat until queue empty or stop requested.

## UI Control (Implemented)
Club sidepanel contains:
- Button: `Scrape Full Playerlist`
- Button: `Stop`
- Live status:
  - running/idle
  - `completed / total`
  - failed count
  - last error (if any)

## Operational Defaults
- Concurrency: `1` (single worker, safer for DOM/session stability).
- Delay between players: randomized (default ~1.5s to 3.5s).
- Max attempts per player: `3`.

## Success Criteria
- Resume across sessions works for same `teamportrait` team.
- No duplicate queue jobs per player in a batch.
- Main data integrity preserved (`matches_v2.match_fingerprint` uniqueness).
- Operator can monitor and stop/restart from sidepanel without losing progress.

## Next Optional Improvements
1. Add ETA estimate in sidepanel (`remaining / avg duration`).
2. Add filter option (`only pending`, `retry failed only`, `force resync completed`).
3. Add per-job detail view in sidepanel for debugging failed rows.
