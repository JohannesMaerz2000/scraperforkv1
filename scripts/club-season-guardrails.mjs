import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const SNAPSHOT_DIR = join(ROOT, 'rawsnapshots/clublogicrawpages');

function readSnapshot(name) {
  return readFileSync(join(SNAPSHOT_DIR, name), 'utf8');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOverviewSectionRowCounts(html) {
  const headings = [];
  const headingRegex = /Gruppeneinteilung\s*(Sommer|Winter)/gi;
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html)) !== null) {
    headings.push({
      index: headingMatch.index,
      seasonType: headingMatch[1][0].toUpperCase() + headingMatch[1].slice(1).toLowerCase()
    });
  }

  const counts = new Map();
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const block = html.slice(start, end);
    const rowCount = (block.match(/>anzeigen</gi) || []).length;
    counts.set(headings[i].seasonType, (counts.get(headings[i].seasonType) || 0) + rowCount);
  }
  return counts;
}

function extractPortraitHeaderSeason(html) {
  const clubHeaderIdx = html.search(/class="zk-font-48[^"]*z-label"/i);
  assert.notEqual(clubHeaderIdx, -1, 'Club header label not found');

  const windowAfterClubHeader = html.slice(clubHeaderIdx, clubHeaderIdx + 5000);
  const seasonMatch = windowAfterClubHeader.match(/>\s*(Sommer|Winter)\s*(20\d{2})\s*<\/span>/i);
  assert.ok(seasonMatch, 'Header season not found near club identity');

  return `${seasonMatch[1][0].toUpperCase()}${seasonMatch[1].slice(1).toLowerCase()} ${seasonMatch[2]}`;
}

function extractFirstLikelyPortraitTeamLabel(html) {
  const clubHeaderIdx = html.search(/class="zk-font-48[^"]*z-label"/i);
  assert.notEqual(clubHeaderIdx, -1, 'Club header label not found');

  const start = Math.max(0, clubHeaderIdx - 45000);
  const end = Math.min(html.length, clubHeaderIdx + 20000);
  const neighborhood = html.slice(start, end);
  const buttonContentRegex = /class="z-toolbarbutton-content">([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = buttonContentRegex.exec(neighborhood)) !== null) {
    const label = normalizeText(match[1]);
    if (!label) continue;
    if (['anzeigen', 'downloaden', 'favorit', 'gruppe'].includes(label.toLowerCase())) continue;
    if (/^(Herren|Damen|Mixed|Junior|Jugend|Freizeit-|U\d+)/i.test(label)) return label;
  }
  return null;
}

function run() {
  const overviewHtml = readSnapshot('cluboverviewpage.html');
  const overviewSectionRowCounts = extractOverviewSectionRowCounts(overviewHtml);
  assert.ok(
    (overviewSectionRowCounts.get('Sommer') || 0) > 0,
    'Overview should include at least one Sommer team row under the Sommer heading'
  );
  assert.ok(
    (overviewSectionRowCounts.get('Winter') || 0) > 0,
    'Overview should include at least one Winter team row under the Winter heading'
  );

  const portraitSeason = extractPortraitHeaderSeason(readSnapshot('clubherrenteamoverview.html'));
  assert.equal(portraitSeason, 'Sommer 2026', 'Team portrait header season should be Sommer 2026');

  const portraitAfterClickSeason = extractPortraitHeaderSeason(
    readSnapshot('clubherrenteamoverviewafterclickedspielerinnen.html')
  );
  assert.equal(
    portraitAfterClickSeason,
    'Sommer 2026',
    'Team portrait header season should remain Sommer 2026 after clicking Spieler:innen'
  );

  const herren2Label = extractFirstLikelyPortraitTeamLabel(readSnapshot('clubherren2rawdetailspage.html'));
  assert.equal(
    herren2Label,
    'Herren II',
    'Herren II detail page should expose the team row label as Herren II'
  );

  console.log('club-season-guardrails: all checks passed');
}

run();
