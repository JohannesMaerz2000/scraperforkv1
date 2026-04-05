# League System End-to-End Handoff Spec

Last updated: 2026-04-04 (calendar linking + fixture dedupe + time parsing fix)

## Goal
Build a robust pipeline where:
- `Tabellen gesamt` PDF is canonical for `league_groups` and `league_group_teams`.
- `Vereinsspielplan` is canonical for `league_fixtures`.
- Fixtures are linked to existing groups via canonical identity.

## Required Sync Order
1. Sync league tables PDF first (`Tabellen gesamt`).
2. Sync Vereinsspielplan calendar second.

Why:
- Calendar fixture sync requires an existing `league_group_id` resolved by
  `(federation_code, season_year, season_type, group_code)`.
- If league tables are missing/cleared, calendar fixtures are parsed but skipped as unresolved.

## Current Status
- Live PDF sync works (`League tables synced (34 groups)` observed).
- Calendar sync works with canonical linking after PDF sync.
- `npm run test:leaguesystem` passes.

## Storage Model
- `league_groups`: canonical group identity `(federation_code, season_year, season_type, group_code)`.
- `league_group_teams`: group memberships, with `club_id`/`club_team_id` when resolvable.
- `league_fixtures`: calendar fixtures linked to `league_group_id`.

Schema files:
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/supabaseschema/league_groups.sql`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/supabaseschema/league_group_teams.sql`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/supabaseschema/league_fixtures.sql`

## Implemented Fixes

### 1) PDF ingest robustness
- Background supports PDF byte-fetch + parse fallback.
- Parser supports ranked and matrix-style table formats.
- Missing parse identity in PDF path is staged non-fatally for follow-up.

### 2) Fixture dedupe correctness
- Fixture identity fields used for conflict key are normalized non-null:
  `match_time`, `home_team_label`, `away_team_label`.
- Existing row detection includes recovery for previously stored empty-time rows.
- Prevents repeated duplicate inserts on re-sync.

### 3) Vereinsspielplan time extraction
- Time is extracted from nested `.z-label` content inside fixture cells (e.g. `14:00 (A)`).
- Supports both `HH:MM` and `HH.MM`, normalized to `HH:MM`.
- Save path also has fallback extraction from raw cell text.

### 4) Calendar debug visibility
- Calendar sync returns compact debug summary:
  `total`, `saved`, `missingDate`, `missingGroupCode`, `unresolvedLeagueGroup`, `upsertFailed`.
- Full debug payload persisted to `chrome.storage.local.lastLeagueCalendarSyncDebug`.

## League Identity Clarification
- Canonical uniqueness is **not** `league_name + age_group`.
- Canonical uniqueness is `(federation_code, season_year, season_type, group_code)`.

## Team Identity / Merge Rules
`club_teams` is canonical across scraping sources.

Merge priority in `upsertClubTeamFromPayload(...)`:
1. `source_team_id` exact match
2. same `club_id + season + team_label`
3. same `club_id + season + team_number`
4. create new row only if no match

## Age Group Extraction
- `age_group` is extracted during `league_groups` upsert (e.g. `U9`, `U10`, `40`, `50`, `60`).
- Migration: `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/supabaseschema/league_groups_age_group.sql`
- Upsert gracefully falls back if `age_group` column is not present yet.

## Known Gaps
- Ranked standings fields (`rank`, `points_text`, `matches_text`, `sets_text`) are still format-dependent in some PDFs.
- Opponent club resolution can still be ambiguous for edge-case name variants.
