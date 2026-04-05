# Tournament Scraping Logic (Current State)

This file documents the current implementation state after the tournament scraping rework.

## 1) Scope and architecture

Tournament scraping currently spans:

- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/tennisdescraper/tournament-content.js`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/tennisdescraper/tournament-sidepanel.js`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/tennisdescraper/background.js`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/tennisdescraper/supabase-client.js`

Reference snapshots used for parser logic:

- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/rawsnapshots/tournamentpage/shownintheui.md`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/rawsnapshots/tournamentpage/tournamentsearchpage.html`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/rawsnapshots/tournamentpage/tournamentdetailpage.html`
- `/Users/johannesmaerz/Documents/Tennisapp/tennisappv1/rawsnapshots/tournamentpage/tournamentzulassungsliste.html`

## 2) Routing and identity model

Source of truth is URL hash context on `turniersuche.html`:

- `#detail/{tournamentId}` -> detail page
- `#zlist/{tournamentId}/{categoryId}/{categorySlug}/{status}` -> zulassung page
- otherwise -> search page

`tournamentId` from hash is the canonical event identifier used as `tournaments.event_id`.

Implemented parser helper:

- `parseTournamentHashContext()` returns:
  - `pageType`
  - `tournamentId`
  - `categoryId`
  - `categorySlug`
  - `status`
  - `hash`

## 3) Current content-script behavior

### 3.1 State machine

`initializeTournamentView()` triggers parse and emits deduped messages:

- `tournamentPageLoaded`
- `tournamentLocationData`
- `zulassungslisteData` (only on `zlist`)

Change detection:

- hashchange + popstate listeners
- periodic route check
- debounced MutationObserver reparse for SPA updates

### 3.2 Detail-page extraction

Extraction strategy is label/visibility based:

- Name: visible `zk-font-48`/`h1` candidates (filters out `Zulassungsliste` and `Turniersuche`)
- Dates:
  - `Termin` -> `startDate`, `endDate`
  - `Meldeschluss` -> `registrationDeadline`
- Location:
  - `PLZ und Ort`, `Straße`, `Platzbelag`
  - club + computed `fullAddress`
- Google Maps: direct maps links if present
- Type flags: visible image markers (`dtb.svg`, `lk.svg`) in scoped visible area

### 3.3 Zulassungsliste extraction

Primary parse path:

- visible table containing `Name`, `Verein`, `LK`, plus section text

Fallback parse path:

- legacy ZK row structure `.bottomgrid.z-row` + `.z-cell`

Row logic:

- section header rows (`colspan`) set active section:
  - `main_draw`
  - `qualifikation`
  - `nachruecker` (internal)
- player rows extract:
  - `position`
  - `seedNumber`
  - `name`
  - `dtbId`
  - `club`
  - `lk`
  - `lkNumeric`
  - `dtbRanking`
  - `registrationStatus`
  - `sectionName`
  - `isSeeded`
  - `isPlaceholder`

Placeholders detected:

- `[Wildcard]`
- `[Qualifikant]`

Current behavior: placeholders are detected but skipped before upload.

Diagnostics emitted with zlist payload:

- row count
- section counts
- placeholder count
- duplicate warnings

## 4) Current sidepanel behavior

`tournament-sidepanel.js`:

- Receives tournament and zlist messages from background.
- Saves tournament via `saveTournamentData`.
- Saves category registrations via `saveZulassungslisteData`.

Dedupe rules:

- tournament save throttled by time window
- zlist save deduped by content signature, not only player count

Guard currently active:

- Tournament save is blocked while name is not considered stable (`'', Unnamed Tournament, Unknown Tournament, Turniersuche, Zulassungsliste...`).

## 5) Current Supabase save behavior

### 5.1 Tournament upsert

`tournaments` upsert now uses conflict resolution correctly:

- endpoint: `/rest/v1/tournaments?on_conflict=event_id`
- `Prefer: resolution=merge-duplicates,return=representation`

This fixed the previous duplicate-key error on `event_id`.

### 5.2 Zulassung replacement

`saveZulassungslisteData` flow:

1. lookup tournament by `event_id`
2. upsert category (`tournament_id`, `category_name`)
3. delete previous registrations for category
4. insert new cleaned registrations in batches

Cleaning/normalization:

- skip invalid names and placeholders
- canonicalize `registration_status` to one of:
  - `main_draw`
  - `qualifikation`
  - `nachrücker`
- dedupe registrations preferring `dtb_id`, fallback `name+club`

## 6) Database status

No schema migration has been applied in this rework.

Current schema remains unchanged:

- `tournaments`
- `tournament_categories`
- `tournament_registrations`

Current mode is intentionally **latest state only** for registrations.

## 7) Suggested next debugging input for the next chat

To fix the remaining timing issue quickly, provide one run with these logs from tournament detail open:

- parsed hash context over time
- emitted `tournamentPageLoaded` payloads
- tournament name candidates and visibility
- sidepanel `saveTournament` skip reason (stable-name guard)

That will allow deciding whether to:

- improve detail-page name selection timing, or
- add a delayed retry save loop in sidepanel/background when guard blocks the first save.
