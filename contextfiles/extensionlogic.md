# Chrome Extension Logic (tennisdescraper)

This document reflects the current runtime behavior in `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/tennisdescraper`.

## 1) What the extension does
- Scrapes tennis.de **player profiles** and **match history**.
- Scrapes tennis.de **tournament pages** and Zulassungsliste player lists.
- Authenticates users against Supabase Auth and writes to Supabase tables.

## 2) Runtime architecture
- `manifest.json`
  - Registers `background.js` (service worker).
  - Injects `content.js` on player pages and `tournament-content.js` on tournament pages.
  - Uses side panel UI: `sidepanel.html/js` (player mode) and `tournament-sidepanel.html/js` (tournament mode).

- `background.js`
  - Central message bus between content scripts and side panels.
  - Detects current tab URL, sets badge, switches sidepanel path.
  - Owns auth/session lifecycle through `SupabaseClient`.
  - Orchestrates scrape mode selection (`full_backfill` vs `incremental_update`) **before** scraping.
  - Uploads matches and updates per-player history sync state.

- `content.js` (player scraper)
  - Watches player profile SPA DOM changes.
  - Scrapes profile metadata and owner verification.
  - Parses desktop + mobile history rows (including doubles partners).
  - Scrapes history in two modes:
    - `full_backfill`: full pagination + `Alle Spiele laden` path.
    - `incremental_update`: fast recent scan first, then auto-escalates to `Alle Spiele laden` if needed.
  - Sends `fullMatchHistoryScraped` with `meta` (mode, stop reason, reach-start flags, page counters).

- `sidepanel.js`
  - Renders status/results and progress.
  - Starts sync via `startFullHistoryScrape` and now passes player context so background can pre-fetch state.

- `supabase-client.js`
  - REST-based auth/session management.
  - Player profile linking (`rpc/link_player_profile` + checks).
  - Match upload/upsert to `matches_v2` with identity keys and protective merges.
  - Reads and updates per-player history sync state in `players`.

## 3) Player sync flow (current)
1. Player page loads, `content.js` sends `playerDataScraped`.
2. `background.js` stores player data and upserts `players` row metadata.
3. User clicks sync.
4. `background.js` loads player context (from request/storage), fetches player history state from Supabase, and decides mode:
   - `full_backfill` if no completed backfill or no `history_latest_match_date`.
   - `incremental_update` otherwise.
5. `background.js` sends mode + `latestKnownMatchDate` to `content.js`.
6. `content.js` scrapes and sends `fullMatchHistoryScraped` + `meta`.
7. `background.js` uploads matches, then updates `players.history_*` fields.

## 4) Adaptive incremental behavior
- Incremental does **not** blindly skip `Alle Spiele laden`.
- It first scans recent pages (fast path).
- If known history is not reached within the window (for example long inactivity + many missed matches), it auto-clicks `Alle Spiele laden` and continues until it reaches known history or terminal pagination.
- This keeps normal updates fast while still handling large backlogs.

## 5) Full-backfill completion trigger
`history_backfill_completed = true` is only set when all are true:
1. Sync mode is `full_backfill`.
2. Scrape reached terminal history start (`reachedHistoryStart = true`).
3. No fatal scrape error.
4. Upload succeeded.

## 6) Data model notes
### `players` (history sync state)
Current important fields:
- `last_scraped`
- `history_backfill_completed`
- `history_backfill_completed_at`
- `history_last_synced_at`
- `history_latest_match_date`
- `history_oldest_match_date`
- `history_last_sync_mode` (`full_backfill` | `incremental_update`)
- `history_last_sync_status` (`success` | `partial` | `failed`)

`players.scraped_at` was removed as redundant.

Player identity/profile normalization:
- `players` is the canonical source of truth for player identity (`dtb_id`, `full_name`).
- Profile scrape stores cleaned club display names in `players.club` (without trailing code),
  e.g. `Münchner Sportclub` instead of `Münchner Sportclub (01038)`.
- Club code is still parsed from profile/team text to resolve `players.main_club_id`.
- Profile LK (`players.leistungsklasse`) is authoritative over team-list LK snapshots.

### `matches_v2` (canonical matches)
- Canonical uniqueness key: `match_fingerprint` (unique).
- Secondary key: `soft_match_key`.
- `fingerprint_version=2`.
- `identity_confidence` + `is_identity_ambiguous` track merge certainty.
- `winner_side` stores canonical outcome when derivable.
- Per-player LK values are stored in normalized slots:
  - `team1_player1_lk`, `team1_player2_lk`, `team2_player1_lk`, `team2_player2_lk`
- Per-player LK improvements are stored in normalized slots:
  - `team1_player1_lk_improvement`, `team1_player2_lk_improvement`, `team2_player1_lk_improvement`, `team2_player2_lk_improvement`
  - Only the scraped player gets a non-null improvement on a given row (source limitation).

## 7) Identity and merge behavior
- Identity keys are generated in `supabase-client.js` (`buildMatchIdentityKeys`).
- Matching priority:
  1. Exact key (`match_fingerprint`)
  2. Unique soft key (`soft_match_key`)
  3. Ambiguous soft collisions marked low-confidence
- Merge is non-downgrading:
  - Preserve strong existing values over null/weak incoming values.
  - Never downgrade known winner to unknown.
  - Preserve existing DTB IDs when incoming is weaker.

## 8) Winner derivation (current)
Priority chain:
1. UI border color (`rgb(172, 198, 9)` win, `rgb(208, 74, 0)` loss)
2. Score-set fallback parsing
3. Unknown (`null` in DB)

LK improvement is stored as a datapoint only (not used for winner derivation).

## 9) Known constraints / risk areas
1. tennis.de DOM/selector volatility (dynamic classes/IDs) remains the highest break risk.
2. Core files are still large and multi-responsibility (`content.js`, `background.js`, `supabase-client.js`).
3. Ambiguous soft-key collisions still require operator review.

## 10) Tournament flow (unchanged)
1. Tab URL matches tournament route.
2. `background.js` opens tournament sidepanel and initializes view.
3. `tournament-content.js` scrapes tournament metadata / Zulassungsliste.
4. `supabase-client.js` persists to:
   - `tournaments`
   - `tournament_categories`
   - `tournament_registrations`

## 11) Club ranking normalization (updated)
- `players` is the canonical source of truth for player identity (`dtb_id`, `full_name`) and profile LK (`leistungsklasse`).
- `club_player_rankings` stores club/season/team ranking context and observed team snapshot data:
  - canonical link: `player_id` -> `players.id`
  - observed snapshot: `observed_player_name`, `observed_player_dtb_id`, `observed_source_team_id`
- Team portrait scraping now upserts players into `players` by `dtb_id` and then writes rankings with:
  - `player_id` (resolved when possible)
  - observed snapshot fields (`observed_player_name`, `observed_player_dtb_id`)
- LK values in rankings are numeric (`lk_numeric numeric(4,1)`) and profile LK remains authoritative:
  - team-list LK only seeds/fills missing player LK; it does not override profile LK.
- Team scrape now also seeds player club fields (`club`, `main_club_id`) when missing,
  while profile-sourced rows remain preferred.

## 12) Authenticated debugging SOP
- Use persistent debug Chrome profile:
  - `./tennisdescraper/scripts/start-auth-debug-chrome.sh`
  - Optional check: `./tennisdescraper/scripts/check-auth-debug-session.sh`
- Connect via `http://127.0.0.1:9222/json`.
- Never share raw credentials.
