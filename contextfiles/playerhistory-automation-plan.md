# Automated Player History Scraping Plan (Fork v1)

Last updated: 2026-04-05

## Scope
- This fork is a separate automation experiment.
- Focus is only `player_history` scraping.
- Team/league/tournament automation remains out of scope.
- Core app data flow remains unchanged:
  - `players` for history state
  - `matches_v2` for canonical matches

## Current Strategy (Implemented)
Use a team page URL (`#teamportrait/...`) as entrypoint and run:
1. Open `Spieler:innen` tab.
2. Expand list (`Mehr Spieler:innen anzeigen`) until full list is visible.
3. Build queue from visible rows (`DTB-ID` + name + rank).
4. For each queued player:
   - Navigate back to team page.
   - Open player via `anzeigen` by `DTB-ID`.
   - Wait until profile page is loaded and `DTB-ID` matches expected job.
   - Run existing full-history sync (`full_backfill` / `incremental_update`).
   - Apply identity guard: profile header name must appear in every scraped match row.
5. Persist queue state in experimental tables.

This avoids dependency on direct player profile URLs.

## Safety Guardrails (Implemented)
- **Tab pinning**: automation always scrapes in the same browser tab used to start the run.
- **Pre-scrape DTB-ID check**: scrape starts only if current profile `DTB-ID` equals claimed job `dtb_id`.
- **Row-level identity check**: scraped matches are rejected if profile name is missing in any row.
- **Fatal scrape handling**: identity/fatal scraper errors are treated as failed jobs (no upload as "successful empty result").
- **UI stability**: club sidepanel stays pinned during automation.
- **Portrait auto-sync pause**: team portrait auto-sync is paused while player-history automation is running.

## Resume Model
- Each team URL maps to a stable batch key:
  - `exp_team_<teamId>_full_playerlist`
- Restarting from same team URL continues existing batch.
- Completed jobs are not reset.
- Failed jobs are retryable up to `max_attempts`.
- Sidepanel progress is read from DB (`completed_count / seed_count`).

## Queue Claiming / Ordering (Implemented)
Claim order is deterministic and human-expected:
1. Claim from `pending` first.
2. Order by `priority`, then `source_rank`, then `created_at`, then `id`.
3. Only when no `pending` jobs remain, claim retryable `failed` jobs (`next_retry_at` null or due).

This prevents resume jumps like continuing at rank ~50 when rank ~16 is still pending.

## Stop Behavior
- `Stop` is cooperative.
- Current player is allowed to finish; then loop exits.
- Batch status becomes `paused` when stopped, `completed` when fully finished.

## Experimental Tables (Separate from Main App)

### `exp_player_history_batches`
- One row per team batch run.
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

## UI Control (Implemented)
Club sidepanel contains:
- Button: `Scrape Full Playerlist`
- Button: `Stop`
- Live status:
  - running/idle
  - `completed / total`
  - failed count
  - last error

## Operational Defaults
- Concurrency: `1` (single worker).
- Delay between players: randomized (default ~1.5s to 3.5s).
- Max attempts per player: `3`.

## Success Criteria
- Resume across sessions works for same team URL.
- No duplicate queue jobs per player in a batch.
- Main data integrity preserved (`matches_v2.match_fingerprint` uniqueness).
- Wrong-profile or mixed-profile states fail safely instead of corrupting player history mapping.

---

## URL Scraper Automation (Implemented)

Lightweight companion automation that only captures player profile URLs from team lists.
Purpose: collect the `profile_url` (e.g. `spielerprofil.html#id=NO503071/ranking`) for each player,
which is needed for mobile-app-based full history scraping. The URL contains an internal ID
that differs from the DTB-ID and is only revealed when navigating to the profile.

### Strategy (Two-Phase)

1. **Phase 1 - DOM href extraction (instant)**:
   - After expanding the full player list, tries to read `href` attributes directly from the "anzeigen" anchor elements.
   - If ZK generates real `spielerprofil#id=...` hrefs, all URLs are captured in one pass without clicking.
   - Batch-saved to DB immediately.

2. **Phase 2 - Click-and-capture (fallback)**:
   - For players whose URLs could not be extracted from the DOM:
     - Navigate to team page.
     - Click "anzeigen" for the player by DTB-ID.
     - Poll the tab URL (~150ms intervals, 8s timeout) for a `spielerprofil#id=...` change.
     - Capture URL as soon as hash changes - no need to wait for full page load.
     - Save to DB and navigate back to team page.
   - Much faster than history scraping (~1-2s per player vs 15-30s).

### Skip Logic
- Before starting the click loop, queries DB for players that already have `profile_url` set.
- Those players are skipped, making the automation effectively resumable.

### Data Storage
- Upserts into the existing `players` table using `dtb_id` as conflict key.
- Only writes `dtb_id`, `full_name`, `profile_url`, and `updated_at`.
- Does not overwrite other fields (LK, club, etc.) - merge-duplicates resolution.

### UI Control
Club sidepanel contains:
- Button: `Scrape Player URLs`
- Button: `Stop`
- Live status pills: URLs captured, skipped (already in DB), failed, current player name.
- Status polling every 2s while running.

### Action Handlers
- `urlScraperStart` - starts the automation on the current `#teamportrait/...` URL.
- `urlScraperStop` - cooperative stop (current player finishes, then exits).
- `urlScraperGetStatus` - returns live counters and state.

### Content Script Actions
- `expExtractAnzeigenHrefs` - attempts batch href extraction from DOM (Phase 1).
- `expOpenPlayerByDtbId` - reused from history automation for click-and-capture (Phase 2).

### Operational Defaults
- Delay between click-and-capture players: randomized ~0.8s to 2s.
- URL poll timeout: 8s per player.
- No job queue / batch tables needed - state is in-memory, resume via DB `profile_url` check.

### Files
- `background.js`: `runUrlScraperAutomation()`, state, handlers.
- `club-content.js`: `expExtractAnzeigenHrefs` action.
- `supabase-client.js`: `getPlayersWithUrls()`, `batchUpsertPlayerUrls()`.
- `club-sidepanel.html/js`: UI section + polling.
