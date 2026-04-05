import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const LeagueParsers = require('../league-parsers.js');

const ROOT = process.cwd();
const PDF_PATH = join(ROOT, 'rawsnapshots/leaguesraw/mscallteamstables.pdf');
const WINTER_PDF_PATH = join(ROOT, 'rawsnapshots/leaguesraw/winterleagues.pdf');
const CALENDAR_PATH = join(ROOT, 'rawsnapshots/leaguesraw/mscclubcalendar.html');

function extractPdfText(pdfPath) {
  return execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
}

function run() {
  const pdfText = extractPdfText(PDF_PATH);
  const tables = LeagueParsers.parseLeagueTablesPdfText(pdfText, {
    source_url: 'https://www.tennis.de/spielen/spielbetrieb/vereinsspielplan.html#BTV/01038/0',
    federation_code: 'BTV',
    source_club_id: '01038'
  });

  assert.equal(tables.federation_code, 'BTV', 'PDF parser should keep federation code BTV');
  assert.equal(tables.source_club_id, '01038', 'PDF parser should keep source club id 01038');
  assert.ok(Array.isArray(tables.groups) && tables.groups.length > 0, 'PDF parser should return league groups');

  const hasGroup018 = tables.groups.some((group) => group.group_code === '018 SU');
  assert.ok(hasGroup018, 'PDF parser should detect group 018 SU');

  const winterPdfText = extractPdfText(WINTER_PDF_PATH);
  const winterTables = LeagueParsers.parseLeagueTablesPdfText(winterPdfText, {
    source_url: 'https://www.tennis.de/spielen/spielbetrieb/vereinsspielplan.html#BTV/01038/0',
    federation_code: 'BTV',
    source_club_id: '01038'
  });
  assert.ok(Array.isArray(winterTables.groups) && winterTables.groups.length > 0, 'Winter PDF parser should return league groups');
  const winterGroup = winterTables.groups.find((group) => group.group_code === '005 SU') || winterTables.groups[0] || null;
  assert.ok(winterGroup, 'Winter PDF parser should resolve at least one winter group');
  const matrixRows = winterGroup?.table_matrix?.rows || [];
  assert.ok(Array.isArray(matrixRows) && matrixRows.length > 0, 'Winter PDF parser should extract cross-table matrix rows');
  const hasSummaryScores = (winterGroup?.teams || []).some(
    (team) => team.points_text && team.matches_text && team.sets_text
  );
  assert.ok(hasSummaryScores, 'Winter PDF parser should preserve optional standings summary scores when available');

  const calendarHtml = readFileSync(CALENDAR_PATH, 'utf8');
  const calendar = LeagueParsers.parseVereinsspielplanFromHtml(
    calendarHtml,
    'https://www.tennis.de/spielen/spielbetrieb/vereinsspielplan.html#BTV/01038/0'
  );

  assert.equal(calendar.federation_code, 'BTV', 'Calendar parser should detect federation BTV');
  assert.equal(calendar.source_club_id, '01038', 'Calendar parser should detect source club id 01038');

  const hasCalendarGroup018 = (calendar.columns || []).some((column) => column.group_code === '018 SU');
  assert.ok(hasCalendarGroup018, 'Calendar parser should detect at least one 018 SU column');

  const fixtureWithHomeAway = (calendar.fixtures || []).find(
    (fixture) => fixture.raw_cell_text.includes('(H)') || fixture.raw_cell_text.includes('(A)')
  );
  assert.ok(fixtureWithHomeAway, 'Calendar parser should detect at least one fixture with (H) or (A) marker');

  console.log('league-system-guardrails: all checks passed');
}

run();
