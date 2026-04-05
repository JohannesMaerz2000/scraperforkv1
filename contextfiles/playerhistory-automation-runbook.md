# Experimental Player History Automation Runbook

This runbook is for the **separate experiment pipeline** (`exp_*` tables only).

## 1) Apply SQL in Supabase

Run:

`contextfiles/supabaseschema/exp_player_history_automation.sql`

## 2) Reload extension

- Reload this unpacked extension in Chrome.
- Open a `teamportrait` page, for example:
  `https://www.tennis.de/spielen/spielbetrieb/mannschaftssuche.html#teamportrait/3579823`

## 3) Start automation (from extension page console)

Use `chrome.runtime.sendMessage(...)`:

```js
chrome.runtime.sendMessage({
  action: 'expStartPlayerHistoryAutomation',
  teamPortraitUrl: 'https://www.tennis.de/spielen/spielbetrieb/mannschaftssuche.html#teamportrait/3579823',
  batchKey: 'batch_001_home_club_50',
  batchLabel: 'Home Club 50 Pilot',
  maxPlayers: 50,
  maxAttempts: 3,
  delayMinMs: 1500,
  delayMaxMs: 3500
}, console.log);
```

## 4) Check status

```js
chrome.runtime.sendMessage({
  action: 'expGetPlayerHistoryAutomationStatus'
}, console.log);
```

## 5) Stop automation

```js
chrome.runtime.sendMessage({
  action: 'expStopPlayerHistoryAutomation'
}, console.log);
```

## Notes

- The worker uses team-page click navigation (`Spieler:innen` -> `anzeigen`) by `dtb_id`.
- Existing history logic is reused (`full_backfill` vs `incremental_update`).
- Job state is written only to `exp_player_history_batches` / `exp_player_history_jobs`.
