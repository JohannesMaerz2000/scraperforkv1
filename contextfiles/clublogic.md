# Club Logic (Current State)

Last updated: 2026-04-04 (player canonicalization + ranking normalization)

This document is the source of truth for club/team/league ingestion in the JM Tennis extension.

## Scope
- Clublogic is now intentionally narrow:
  - keep only player list + ranking ingestion from `teamportrait`
  - do not treat club overview as canonical source for leagues/matchups
- League and matchup truth is handled in `leaguesystem.md` (PDF-first pipeline).
- Player and tournament modes remain separate.
- Team identity is shared across sources:
  - `club_teams` is canonical team entity.
  - PDF league ingest may create the first team row.
  - Team detail (`teamportrait`) enriches that same row and attaches `source_team_id`.

## Domain Rules
- `source_club_id` (tennis.de club code like `01038`) is the canonical external club identity.
- Season identity is `season_year + season_type` (`Sommer` / `Winter`).
- Team labels are not guaranteed to be unique globally; they are interpreted in club + season context.
- Team portrait pages can be incomplete; ingestion must tolerate missing league/team metadata.

## Runtime Architecture
- `tennisdescraper/manifest.json`
  - content script injection for `*mannschaftssuche*`
- `tennisdescraper/background.js`
  - detects club pages
  - routes to `club-sidepanel.html`
  - handles:
    - `clubTeamPortraitData`
    - `saveClubTeamPortraitData`
- `tennisdescraper/club-content.js`
  - parses portrait pages (and uses overview hints only for label resolution)
  - applies season and team-label guardrails
  - tracks team label hints across clicks (`teamId -> teamLabel`)
- `tennisdescraper/club-sidepanel.js`
  - receives parsed payloads and persists through background handlers

## Parsing Strategy
- Uses stable anchors:
  - hash route (`teamview`, `teamportrait`)
  - visible labels (`Gruppeneinteilung`, `Spieler:innen`, `Rang`, `DTB-ID`)
- Avoids generated DOM IDs.
- Overview season assignment is bound to the preceding `Gruppeneinteilung Sommer/Winter` heading block.
- Portrait season extraction accepts explicit header season only (`Sommer|Winter YYYY`).
- Portrait team label resolution priority:
  1. known `teamId -> teamLabel` hint (click/overview-derived)
  2. direct `sourceTeamId` match in parsed rows
  3. conservative fallback heuristics

## Persistence Model (Current)
- `saveClubTeamPortraitData(payload)`
  - upserts `club_teams` metadata and attaches `source_team_id`
  - upserts players into canonical `players` by `dtb_id`
  - writes ranking observation rows into `club_player_rankings` linked via `player_id` when resolvable
  - stores portrait team context as observation metadata only (not hard membership truth)

## Database Model (Current)
### Club-related SQL files
- `supabaseschema/clubs.sql`
- `supabaseschema/club_teams.sql`
- `supabaseschema/club_player_rankings.sql`

### Core table intent
- `clubs`
  - canonical club identity (`source_club_id`, `name`)
- `club_teams`
  - canonical team registry per club/season (shared across PDF + portrait ingestion)
  - `source_team_id` is attached when available from team detail pages
- `club_player_rankings`
  - team-portrait ranking observations per `club + season + source_team + observed_player_name`
  - canonical join target is `player_id` -> `players.id`
  - snapshot identity fields retained for provenance:
    - `observed_player_name`
    - `observed_player_dtb_id`
    - `observed_source_team_id`
  - ranking/LK fields:
    - `overall_rank` (required)
    - `lk_numeric` (`numeric(4,1)`)

## Data Semantics
- Player rank is canonical for the observed team-season snapshot.
- Team membership is derived by business rules (lineup slicing / eligibility), not persisted as hard truth.
- `source_team_id` and observed team label in player rankings are observational provenance.
- `players` remains the single canonical table for app-wide player search.
- Profile LK is source-of-truth; team LK only seeds/fills missing values.

## Guardrails / Validation
- Snapshot guardrail script:
  - `npm run test:clublogic`
  - script: `tennisdescraper/scripts/club-season-guardrails.mjs`
- Validation snapshots:
  - `rawsnapshots/clublogicrawpages/cluboverviewpage.html`
  - `rawsnapshots/clublogicrawpages/clubherrenteamoverview.html`
  - `rawsnapshots/clublogicrawpages/clubherrenteamoverviewafterclickedspielerinnen.html`
  - `rawsnapshots/clublogicrawpages/clubherren2rawdetailspage.html`

## Remaining Risks
- Some pages do not expose a first-class "selected team" marker in DOM; parser relies on route + guarded hints.
- Portrait payloads with ambiguous labels can still reduce deterministic merge confidence.

## Planned League-System Integration (Next)
- New source docs and mechanics are captured in `leaguesystem.md`.
- Direction:
  - `Tabellen gesamt` PDF is canonical for league groups, teams and tables.
  - `Vereinsspielplan` is canonical for fixtures.
  - `clublogic` contributes player ranking data only.

## League-System Implementation Notes (2026-04-04)
- Added canonical league schema files:
  - `supabaseschema/league_groups.sql`
  - `supabaseschema/league_group_teams.sql`
  - `supabaseschema/league_fixtures.sql`
- Added shared parser module:
  - `tennisdescraper/league-parsers.js`
  - PDF parser: `parseLeagueTablesPdfText(...)`
  - Vereinsspielplan parsers:
    - `parseVereinsspielplanFromDocument(...)` for runtime DOM parsing
    - `parseVereinsspielplanFromHtml(...)` for snapshot guardrails
- Extension runtime wiring:
  - `manifest.json` now injects `league-parsers.js` before `club-content.js` on both `mannschaftssuche` and `vereinsspielplan`.
  - `club-content.js` now emits:
    - `clubLeagueTablesData`
    - `clubCalendarData`
  - `background.js` forwards and persists new payloads via:
    - `saveClubLeagueTablesData`
    - `saveClubCalendarData`
  - `club-sidepanel.js/html` now displays and syncs league table + calendar status blocks.
- Supabase client orchestration:
  - New upsert helpers for `league_groups`, `league_group_teams`, `league_fixtures`.
  - New save methods:
    - `saveClubLeagueTablesData(payload)`
    - `saveClubCalendarData(payload)`
- Guardrail tests:
  - `npm run test:leaguesystem`
  - script: `tennisdescraper/scripts/league-system-guardrails.mjs`
  - validates:
    - federation `BTV`
    - main club id `01038`
    - group `018 SU`
    - presence of `(H)` / `(A)` fixture markers
