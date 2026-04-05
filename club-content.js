console.log('🎾 Club content script loaded');

const CLUB_ROUTE_POLL_MS = 900;
const CLUB_REPARSE_DEBOUNCE_MS = 300;

let clubRoutePollTimer = null;
let clubDomObserver = null;
let clubPendingParseTimer = null;
let clubLastRouteKey = null;
let clubClickListenerBound = false;
let clubLastClickedTeamHint = null;
const clubTeamLabelHintsById = new Map();
let clubLastSentSignatures = {
  clubTeamPortraitData: null,
  clubLeagueTablesData: null,
  clubCalendarData: null
};

function normalizeText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function isElementVisible(element) {
  if (!element || !(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleText(element) {
  return isElementVisible(element) ? normalizeText(element.textContent) : '';
}

function safeSendMessage(message) {
  return chrome.runtime.sendMessage(message).catch(() => false);
}

function sendDeduped(action, payload, signatureSource) {
  const signature = JSON.stringify(signatureSource);
  if (clubLastSentSignatures[action] === signature) return;
  clubLastSentSignatures[action] = signature;
  safeSendMessage({ action, ...payload });
}

function parseClubHashContext(rawUrl = window.location.href) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    const hash = (url.hash || '').replace(/^#/, '');
    const host = url.hostname.toLowerCase();

    const isMannschaft = path.includes('/mannschaftssuche');
    const isVereinsspielplan = path.includes('/vereinsspielplan');
    const isNuLigaPdf = host === 'dtb.liga.nu'
      && path.includes('/cgi-bin/webobjects/nuligadokumenttende.woa/wa/nudokument');

    if (!isMannschaft && !isVereinsspielplan && !isNuLigaPdf) {
      return { pageType: 'other', hash, clubViewId: null, teamId: null };
    }

    if (isNuLigaPdf) {
      return {
        pageType: 'leaguepdf',
        hash: url.search || '',
        clubViewId: null,
        teamId: null,
        federationCode: null,
        sourceClubId: null
      };
    }

    if (isVereinsspielplan) {
      const idMatch = hash.match(/^([A-Za-z]{2,6})\/(\d{4,8})\/(\d+)/);
      return {
        pageType: 'clubcalendar',
        hash,
        clubViewId: null,
        teamId: null,
        federationCode: idMatch ? idMatch[1].toUpperCase() : null,
        sourceClubId: idMatch ? idMatch[2] : null
      };
    }

    const teamview = hash.match(/^\/?teamview\/(\d+)/i);
    if (teamview) {
      return { pageType: 'teamview', hash, clubViewId: teamview[1], teamId: null };
    }

    const teamportrait = hash.match(/^\/?teamportrait\/(\d+)/i);
    if (teamportrait) {
      return { pageType: 'teamportrait', hash, clubViewId: null, teamId: teamportrait[1] };
    }

    return { pageType: 'search', hash, clubViewId: null, teamId: null };
  } catch (_error) {
    return { pageType: 'other', hash: '', clubViewId: null, teamId: null };
  }
}

function emitLeagueTablesFromPdfTab(route) {
  const pdfText = normalizeText(document.body?.innerText || document.documentElement?.innerText || '');
  const referrerIdentity = window.LeagueParsers?.parseHashIdentity
    ? window.LeagueParsers.parseHashIdentity(document.referrer || '')
    : { federation_code: null, source_club_id: null };
  const parsed = window.LeagueParsers?.parseLeagueTablesPdfText
    ? window.LeagueParsers.parseLeagueTablesPdfText(pdfText, {
      federation_code: referrerIdentity?.federation_code || null,
      source_club_id: referrerIdentity?.source_club_id || null,
      source_url: window.location.href
    })
    : null;

  const payload = {
    route,
    sourceUrl: window.location.href,
    sourceHash: route?.hash || null,
    sourceFetchedAt: new Date().toISOString(),
    federation_code: parsed?.federation_code || referrerIdentity?.federation_code || null,
    source_club_id: parsed?.source_club_id || referrerIdentity?.source_club_id || null,
    season_year: parsed?.season_year || null,
    season_type: parsed?.season_type || null,
    pdf_url: window.location.href,
    pdf_text: pdfText || null,
    pdf_text_available: !!pdfText,
    groups: Array.isArray(parsed?.groups) ? parsed.groups : []
  };

  sendDeduped('clubLeagueTablesData', payload, {
    hash: route.hash,
    sourceUrl: payload.sourceUrl,
    federation: payload.federation_code,
    sourceClubId: payload.source_club_id,
    season: `${payload.season_type || ''}-${payload.season_year || ''}`,
    groups: payload.groups.map((group) => `${group.group_code}|${group.teams?.length || 0}`).join('||'),
    hasPdfText: payload.pdf_text_available
  });
}

function extractPdfPayloadFromVereinsspielplan(route) {
  const pdfAnchor = Array.from(document.querySelectorAll('a[href], .z-toolbarbutton, button'))
    .find((node) => /pdf/i.test(normalizeText(node.textContent)) || /\.pdf($|\?)/i.test(node.getAttribute?.('href') || ''));
  const pdfUrl = (() => {
    const href = pdfAnchor?.getAttribute?.('href');
    if (!href) return null;
    try {
      return new URL(href, window.location.href).toString();
    } catch (_error) {
      return null;
    }
  })();

  const textBlocks = Array.from(document.querySelectorAll('pre, .textLayer, .z-label, div'))
    .map((el) => normalizeText(el.textContent))
    .filter((text) => text && text.includes('Ergebnistabellen - gesamt'));
  const pdfText = textBlocks.find((text) => text.includes('Gr.')) || null;

  const parsed = pdfText && window.LeagueParsers?.parseLeagueTablesPdfText
    ? window.LeagueParsers.parseLeagueTablesPdfText(pdfText, {
      federation_code: route?.federationCode || null,
      source_club_id: route?.sourceClubId || null,
      source_url: window.location.href
    })
    : null;

  return {
    route,
    sourceUrl: window.location.href,
    sourceHash: route?.hash || null,
    sourceFetchedAt: new Date().toISOString(),
    federation_code: route?.federationCode || parsed?.federation_code || null,
    source_club_id: route?.sourceClubId || parsed?.source_club_id || null,
    season_year: parsed?.season_year || null,
    season_type: parsed?.season_type || null,
    pdf_url: pdfUrl,
    pdf_text_available: !!pdfText,
    groups: Array.isArray(parsed?.groups) ? parsed.groups : []
  };
}

function emitClubLeagueTables(route) {
  const payload = extractPdfPayloadFromVereinsspielplan(route);
  if (!payload.pdf_url && payload.groups.length === 0) return;

  sendDeduped('clubLeagueTablesData', payload, {
    hash: route.hash,
    federation: payload.federation_code,
    sourceClubId: payload.source_club_id,
    pdfUrl: payload.pdf_url || null,
    groups: payload.groups.map((group) => `${group.group_code}|${group.teams?.length || 0}`).join('||')
  });
}

function emitClubCalendar(route) {
  if (!window.LeagueParsers?.parseVereinsspielplanFromDocument) return;
  const parsed = window.LeagueParsers.parseVereinsspielplanFromDocument(document, window.location.href);
  const pdfPayload = extractPdfPayloadFromVereinsspielplan(route);

  const payload = {
    route,
    sourceUrl: window.location.href,
    sourceHash: route?.hash || null,
    sourceFetchedAt: new Date().toISOString(),
    pdf_url: pdfPayload?.pdf_url || null,
    federation_code: parsed.federation_code || route?.federationCode || null,
    source_club_id: parsed.source_club_id || route?.sourceClubId || null,
    season_year: parsed.season_year || null,
    season_type: parsed.season_type || null,
    columns: parsed.columns || [],
    fixtures: parsed.fixtures || []
  };

  sendDeduped('clubCalendarData', payload, {
    hash: route.hash,
    federation: payload.federation_code,
    sourceClubId: payload.source_club_id,
    season: `${payload.season_type || ''}-${payload.season_year || ''}`,
    columns: payload.columns.map((column) => `${column.team_label_with_age}|${column.group_code}`).join('||'),
    fixtures: payload.fixtures.map((fixture) => `${fixture.date}|${fixture.group_code}|${fixture.time}|${fixture.opponent_team_label}|${fixture.is_home_for_main_club}`).join('||')
  });
}

function extractSeason(rawText) {
  const text = normalizeText(rawText);
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const seasonType = text.toLowerCase().includes('winter')
    ? 'Winter'
    : text.toLowerCase().includes('sommer')
      ? 'Sommer'
      : null;
  return {
    seasonLabel: text || null,
    season_year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    season_type: seasonType
  };
}

function extractClubIdentity() {
  const candidates = Array.from(document.querySelectorAll('span, h1, h2'))
    .map((el) => ({ el, text: visibleText(el) }))
    .filter((item) => item.text && /\(\d{4,8}\)\s*$/.test(item.text));

  if (candidates.length === 0) {
    return { sourceClubId: null, name: null, display: null };
  }

  candidates.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
  const display = candidates[0].text;
  const idMatch = display.match(/\((\d{4,8})\)\s*$/);
  return {
    sourceClubId: idMatch ? idMatch[1] : null,
    name: normalizeText(display.replace(/\(\d{4,8}\)\s*$/, '')),
    display
  };
}

function findVisibleSeasonText() {
  const clubHeading = Array.from(document.querySelectorAll('span, h1, h2'))
    .find((el) => /\(\d{4,8}\)\s*$/.test(visibleText(el)));
  const headerScope = clubHeading?.closest('.z-vlayout');

  const scopedCandidates = headerScope
    ? Array.from(headerScope.querySelectorAll('span,div'))
    : [];
  const globalCandidates = Array.from(document.querySelectorAll('span,div'));
  const candidates = scopedCandidates.length > 0 ? scopedCandidates : globalCandidates;
  const seasonEl = candidates
    .filter((el) => isElementVisible(el))
    .find((el) => /^(sommer|winter)\s+20\d{2}$/i.test(visibleText(el)));
  return seasonEl ? normalizeText(seasonEl.textContent) : null;
}

function findGroupTextNearTop() {
  const candidates = Array.from(document.querySelectorAll('span,div'))
    .filter((el) => isElementVisible(el))
    .map((el) => normalizeText(el.textContent))
    .filter((text) => text && /^(Herren|Damen|Mixed|Junior|Jugend)/i.test(text));
  return candidates[0] || null;
}

function isLikelyTeamLabel(text) {
  if (!text) return false;
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (['anzeigen', 'downloaden', 'favorit'].includes(normalized.toLowerCase())) return false;
  return /^(Herren|Damen|Mixed|Junior|Jugend|Freizeit-|U\d+)/i.test(normalized);
}

function rememberTeamLabelHint(teamId, label) {
  const normalizedLabel = normalizeText(label);
  if (!teamId || !isLikelyTeamLabel(normalizedLabel)) return;
  clubTeamLabelHintsById.set(String(teamId), normalizedLabel);
}

function getTeamLabelHint(teamId) {
  if (!teamId) return null;
  return clubTeamLabelHintsById.get(String(teamId)) || null;
}

function captureTeamHintFromClick(event) {
  const target = event?.target;
  if (!(target instanceof Element)) return;
  const contentEl = target.closest('.z-toolbarbutton-content');
  if (!contentEl) return;
  const label = normalizeText(contentEl.textContent);
  if (!isLikelyTeamLabel(label)) return;

  const row = contentEl.closest('tr.z-row, tr[class*="plaingrid"]');
  const rowText = normalizeText(row?.textContent || '');
  if (!rowText.toLowerCase().includes('anzeigen')) return;

  clubLastClickedTeamHint = {
    label,
    capturedAt: Date.now()
  };
}

function romanToInt(value) {
  const roman = normalizeText(value).toUpperCase();
  if (!roman || !/^[IVX]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < roman.length; i += 1) {
    const current = values[roman[i]] || 0;
    const next = values[roman[i + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function extractTeamOrdinalFromLabel(label) {
  const text = normalizeText(label);
  if (!text) return null;
  const romanMatch = text.match(/\b([IVX]{1,6})$/i);
  if (!romanMatch) return 1;
  return romanToInt(romanMatch[1]) || null;
}

function inferTeamOrdinalFromPlayers(players) {
  const numericRanks = (Array.isArray(players) ? players : [])
    .map((p) => (Number.isInteger(p?.rank) ? p.rank : null))
    .filter((rank) => Number.isInteger(rank) && rank > 0);
  if (numericRanks.length === 0) return null;
  const minRank = Math.min(...numericRanks);
  if (minRank < 7) return null;
  return Math.ceil(minRank / 6);
}

function isPlainFamilyCandidate(label, headerGroupCode) {
  const labelText = normalizeText(label);
  const base = normalizeText(headerGroupCode);
  if (!labelText || !base) return false;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedBase}(\\s+[IVX]{1,6})?$`, 'i').test(labelText);
}

function resolvePortraitTeamLabel(route, headerGroupCode, players) {
  const hintFromTeamId = getTeamLabelHint(route?.teamId);
  if (isLikelyTeamLabel(hintFromTeamId)) {
    return hintFromTeamId;
  }

  const parsedRows = parseTeamOverviewRows(route);
  const teams = Array.isArray(parsedRows?.teams) ? parsedRows.teams : [];
  if (teams.length === 0) return headerGroupCode || null;

  if (route?.teamId) {
    const byTeamId = teams.find((team) => team?.sourceTeamId && String(team.sourceTeamId) === String(route.teamId));
    if (byTeamId?.teamLabel && isLikelyTeamLabel(byTeamId.teamLabel)) {
      return byTeamId.teamLabel;
    }
  }

  const base = normalizeText(headerGroupCode || '');
  const familyCandidates = teams.filter((team) => {
    const label = normalizeText(team?.teamLabel || '');
    return isLikelyTeamLabel(label) && isPlainFamilyCandidate(label, base);
  });

  if (familyCandidates.length > 0) {
    const inferredOrdinal = inferTeamOrdinalFromPlayers(players);
    if (Number.isInteger(inferredOrdinal)) {
      const ordinalMatches = familyCandidates.filter((team) => {
        const label = team?.teamLabel || '';
        return extractTeamOrdinalFromLabel(label) === inferredOrdinal;
      });
      if (ordinalMatches.length === 1) {
        return ordinalMatches[0].teamLabel || headerGroupCode || null;
      }
    }

    const exactBase = familyCandidates.find((team) => normalizeText(team?.teamLabel || '') === base);
    if (exactBase?.teamLabel) return exactBase.teamLabel;
  }

  return headerGroupCode || null;
}

function extractIdFromAttributes(root) {
  const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    for (const attr of node.getAttributeNames()) {
      const value = node.getAttribute(attr) || '';
      const teamMatch = value.match(/teamportrait\/(\d+)/i);
      if (teamMatch) return teamMatch[1];
    }
  }
  return null;
}

function findNearestSeasonHeadingForRow(row) {
  const headings = Array.from(document.querySelectorAll('span,div'))
    .filter((el) => isElementVisible(el))
    .map((el) => ({ el, text: normalizeText(el.textContent) }))
    .filter((item) => /^Gruppeneinteilung\s+(Sommer|Winter)/i.test(item.text));

  const preceding = headings.filter((heading) => {
    const relation = heading.el.compareDocumentPosition(row);
    return !!(relation & Node.DOCUMENT_POSITION_FOLLOWING);
  });

  if (preceding.length === 0) return null;
  return preceding[preceding.length - 1].text || null;
}

function parseTeamOverviewRows(route) {
  const rowNodes = Array.from(document.querySelectorAll('tr.z-row, tr[class*="plaingrid"]'));
  const teams = [];

  for (const row of rowNodes) {
    if (!isElementVisible(row)) continue;
    const rowText = normalizeText(row.textContent);
    if (!rowText || !rowText.toLowerCase().includes('anzeigen')) continue;

    const labelCandidates = Array.from(row.querySelectorAll('.z-toolbarbutton-content'))
      .map((el) => normalizeText(el.textContent))
      .filter((text) => text && !['anzeigen', 'downloaden'].includes(text.toLowerCase()));
    const teamLabel = labelCandidates[0] || null;
    if (!teamLabel) continue;

    const leagueLabel = Array.from(row.querySelectorAll('span.z-label, span'))
      .map((el) => normalizeText(el.textContent))
      .find((text) => /liga|gr\./i.test(text)) || null;

    const seasonHeading = findNearestSeasonHeadingForRow(row) || '';
    const season = extractSeason(seasonHeading);

    teams.push({
      sourceTeamId: extractIdFromAttributes(row),
      sourceLeagueId: null,
      teamLabel,
      leagueLabel,
      season
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const team of teams) {
    const key = `${team.teamLabel}|${team.leagueLabel}|${team.season.season_type}|${team.season.season_year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(team);
  }

  return {
    route,
    teams: deduped
  };
}

function parsePlayersFromRichGrid() {
  const headers = Array.from(document.querySelectorAll('th .z-column-content, th'))
    .map((el) => normalizeText(el.textContent).toLowerCase());
  const hasRichHeaders = headers.includes('rang') && headers.includes('name');
  if (!hasRichHeaders) return [];

  const rows = Array.from(document.querySelectorAll('tbody.z-rows tr.z-row'));
  const players = [];

  for (const row of rows) {
    if (!isElementVisible(row)) continue;
    const rank = parseInt(normalizeText(row.querySelector('td:nth-child(1)')?.textContent), 10);
    const name = normalizeText(row.querySelector('.zk-font-bold')?.textContent || '');
    const dtbIdText = Array.from(row.querySelectorAll('span'))
      .map((el) => normalizeText(el.textContent))
      .find((text) => text.startsWith('DTB-ID')) || '';
    const dtbIdMatch = dtbIdText.match(/(\d{5,12})/);
    const nat = normalizeText(row.querySelector('td:nth-child(3)')?.textContent || '');
    const lk = normalizeText(row.querySelector('td:nth-child(4)')?.textContent || '');

    if (!name) continue;
    players.push({
      rank: Number.isInteger(rank) ? rank : null,
      name,
      dtbId: dtbIdMatch ? parseInt(dtbIdMatch[1], 10) : null,
      dtbIdText,
      nationality: nat || null,
      lk: lk || null,
      parsedFrom: 'rich_grid'
    });
  }

  return players;
}

function parsePlayersFromCompactGrid() {
  const compactLines = Array.from(document.querySelectorAll('span.z-label'))
    .map((el) => normalizeText(el.textContent))
    .filter((text) => text.includes(';DTB-ID'));

  const players = [];
  for (const line of compactLines) {
    const parts = line.split(';').map((p) => normalizeText(p));
    if (parts.length < 4) continue;

    const rank = parseInt(parts[0], 10);
    const lk = parts[1] || null;
    const dtbMatch = parts[2].match(/(\d{5,12})/);
    const nameYear = parts[3] || '';
    const name = normalizeText(nameYear.replace(/\(\d{4}\)\s*$/, ''));
    const nationality = parts[4] || null;

    if (!name) continue;
    players.push({
      rank: Number.isInteger(rank) ? rank : null,
      name,
      dtbId: dtbMatch ? parseInt(dtbMatch[1], 10) : null,
      dtbIdText: parts[2],
      nationality,
      lk,
      parsedFrom: 'compact_grid'
    });
  }

  return players;
}

function ensurePlayersTabSelected() {
  const playerTab = Array.from(document.querySelectorAll('.z-tab-text'))
    .find((el) => lower(el.textContent).includes('spieler'));
  if (!playerTab) return;

  const tabLi = playerTab.closest('li[role="tab"]');
  const selected = tabLi?.getAttribute('aria-selected') === 'true';
  if (!selected) {
    playerTab.closest('.z-tab-content')?.click();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findVisibleLoadMorePlayersButton() {
  return Array.from(document.querySelectorAll('button'))
    .find((button) => {
      const text = lower(button.textContent);
      return text.includes('mehr') && text.includes('spieler') && isElementVisible(button) && !button.disabled;
    }) || null;
}

function parseCurrentTeamPlayersForAutomation() {
  const rich = parsePlayersFromRichGrid();
  const compact = parsePlayersFromCompactGrid();
  const players = rich.length > 0 ? rich : compact;
  const deduped = [];
  const seen = new Set();

  for (const player of players) {
    const dtb = Number.isInteger(player?.dtbId) ? player.dtbId : null;
    if (!dtb) continue;
    if (seen.has(dtb)) continue;
    seen.add(dtb);
    deduped.push({
      dtbId: dtb,
      name: normalizeText(player?.name || ''),
      rank: Number.isInteger(player?.rank) ? player.rank : null
    });
  }

  return deduped;
}

async function expandTeamPlayersUntil(targetCount = 50, maxClicks = 30) {
  ensurePlayersTabSelected();
  await delay(500);

  let clicks = 0;
  let lastCount = -1;
  while (clicks < maxClicks) {
    const players = parseCurrentTeamPlayersForAutomation();
    if (players.length >= targetCount) {
      return { players, clicks, completed: true, reason: 'target_reached' };
    }
    if (players.length === lastCount && clicks > 0) {
      // No growth on last click cycle; likely fully expanded.
      const button = findVisibleLoadMorePlayersButton();
      if (!button) {
        return { players, clicks, completed: true, reason: 'no_more_button' };
      }
    }
    lastCount = players.length;

    const loadMore = findVisibleLoadMorePlayersButton();
    if (!loadMore) {
      return { players, clicks, completed: true, reason: 'no_more_button' };
    }

    loadMore.click();
    clicks += 1;
    await delay(900);
  }

  return {
    players: parseCurrentTeamPlayersForAutomation(),
    clicks,
    completed: false,
    reason: 'max_clicks_reached'
  };
}

async function clickPlayerAnzeigenByDtbId(dtbId, maxExpandClicks = 30) {
  const numericDtbId = parseInt(String(dtbId || ''), 10);
  if (!numericDtbId || Number.isNaN(numericDtbId)) {
    return { success: false, error: 'Invalid dtbId' };
  }

  ensurePlayersTabSelected();
  await delay(500);

  let expandClicks = 0;
  while (expandClicks <= maxExpandClicks) {
    const rows = Array.from(document.querySelectorAll('tbody.z-rows tr.z-row'));
    const row = rows.find((candidate) => {
      if (!isElementVisible(candidate)) return false;
      const text = normalizeText(candidate.textContent);
      return text.includes(`DTB-ID ${numericDtbId}`);
    });

    if (row) {
      const actionLabel = Array.from(row.querySelectorAll('.z-toolbarbutton-content'))
        .find((el) => lower(el.textContent) === 'anzeigen');
      const actionButton = actionLabel?.closest('a.z-toolbarbutton, button, [role="button"]');
      if (!actionButton) {
        return { success: false, error: 'Player row found but anzeigen button missing' };
      }
      actionButton.click();
      return { success: true, dtbId: numericDtbId };
    }

    const loadMore = findVisibleLoadMorePlayersButton();
    if (!loadMore) {
      break;
    }
    loadMore.click();
    expandClicks += 1;
    await delay(900);
  }

  return { success: false, error: `DTB-ID ${numericDtbId} not found in team list` };
}

function parseTeamPortrait(route) {
  ensurePlayersTabSelected();

  const seasonText = findVisibleSeasonText();
  const season = extractSeason(seasonText);
  const headerGroupCode = findGroupTextNearTop();

  const leagueLabel = Array.from(document.querySelectorAll('span,div'))
    .map((el) => visibleText(el))
    .find((text) => /liga|gr\./i.test(text) && text.length < 80) || null;

  const richPlayers = parsePlayersFromRichGrid();
  const compactPlayers = parsePlayersFromCompactGrid();
  const players = richPlayers.length > 0 ? richPlayers : compactPlayers;
  const teamLabel = resolvePortraitTeamLabel(route, headerGroupCode, players);

  return {
    route,
    season,
    teamLabel,
    leagueLabel,
    players,
    parsedFrom: richPlayers.length > 0 ? 'rich_grid' : 'compact_grid'
  };
}

function emitClubTeamPortrait(route) {
  const club = extractClubIdentity();
  if (!club.sourceClubId || !club.name) return;

  const parsed = parseTeamPortrait(route);
  if (parsed.players.length === 0) return;

  const payload = {
    route,
    sourceUrl: window.location.href,
    club,
    season: parsed.season,
    parsedFrom: parsed.parsedFrom,
    team: {
      sourceTeamId: route.teamId || null,
      sourceLeagueId: null,
      teamLabel: parsed.teamLabel,
      leagueLabel: parsed.leagueLabel
    },
    players: parsed.players
  };

  sendDeduped('clubTeamPortraitData', payload, {
    hash: route.hash,
    clubId: club.sourceClubId,
    teamId: route.teamId,
    parsedFrom: payload.parsedFrom,
    playerCount: payload.players.length,
    signature: payload.players.map((p) => `${p.rank}|${p.dtbId || ''}|${p.name}`).join('||')
  });
}

function runClubParseCycle() {
  const route = parseClubHashContext();
  const routeKey = `${route.pageType}|${route.hash}`;

  if (routeKey !== clubLastRouteKey) {
    if (
      route.pageType === 'teamportrait'
      && route.teamId
      && clubLastClickedTeamHint?.label
      && Date.now() - clubLastClickedTeamHint.capturedAt < 15000
    ) {
      rememberTeamLabelHint(route.teamId, clubLastClickedTeamHint.label);
    }
    clubLastRouteKey = routeKey;
    clubLastSentSignatures.clubTeamPortraitData = null;
    clubLastSentSignatures.clubLeagueTablesData = null;
    clubLastSentSignatures.clubCalendarData = null;
  }

  if (route.pageType === 'teamview') {
    // Team overview pages are no longer synced; league/team identity is PDF-first.
    return;
  }

  if (route.pageType === 'teamportrait') {
    emitClubTeamPortrait(route);
    return;
  }

  if (route.pageType === 'clubcalendar') {
    emitClubLeagueTables(route);
    emitClubCalendar(route);
    return;
  }

  if (route.pageType === 'leaguepdf') {
    emitLeagueTablesFromPdfTab(route);
  }
}

function scheduleClubParse(delay = CLUB_REPARSE_DEBOUNCE_MS) {
  if (clubPendingParseTimer) clearTimeout(clubPendingParseTimer);
  clubPendingParseTimer = setTimeout(() => {
    runClubParseCycle();
    clubPendingParseTimer = null;
  }, delay);
}

function startClubObservers() {
  if (!clubClickListenerBound) {
    document.addEventListener('click', captureTeamHintFromClick, true);
    clubClickListenerBound = true;
  }

  if (!clubDomObserver) {
    clubDomObserver = new MutationObserver(() => scheduleClubParse(CLUB_REPARSE_DEBOUNCE_MS));
    clubDomObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false
    });
  }

  if (!clubRoutePollTimer) {
    clubRoutePollTimer = setInterval(() => {
      const route = parseClubHashContext();
      const routeKey = `${route.pageType}|${route.hash}`;
      if (routeKey !== clubLastRouteKey) {
        scheduleClubParse(20);
      }
    }, CLUB_ROUTE_POLL_MS);
  }
}

function initializeClubView() {
  const path = window.location.pathname.toLowerCase();
  const isNuLigaPdf = window.location.hostname.toLowerCase() === 'dtb.liga.nu'
    && path.includes('/cgi-bin/webobjects/nuligadokumenttende.woa/wa/nudokument');
  if (!path.includes('/mannschaftssuche') && !path.includes('/vereinsspielplan') && !isNuLigaPdf) return;
  startClubObservers();
  scheduleClubParse(100);
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'initializeClubView') {
    initializeClubView();
    sendResponse?.({ success: true });
    return false;
  }

  if (request.action === 'expCollectTeamPlayers') {
    (async () => {
      const route = parseClubHashContext();
      if (route.pageType !== 'teamportrait') {
        sendResponse({ success: false, error: 'Not on a teamportrait page' });
        return;
      }

      const maxPlayers = Number.isInteger(request.maxPlayers) ? request.maxPlayers : 50;
      const expanded = await expandTeamPlayersUntil(maxPlayers, Number.isInteger(request.maxExpandClicks) ? request.maxExpandClicks : 30);
      const players = parseCurrentTeamPlayersForAutomation().slice(0, maxPlayers);
      sendResponse({
        success: true,
        route,
        totalVisible: parseCurrentTeamPlayersForAutomation().length,
        players,
        expand: expanded
      });
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (request.action === 'expOpenPlayerByDtbId') {
    (async () => {
      const route = parseClubHashContext();
      if (route.pageType !== 'teamportrait') {
        sendResponse({ success: false, error: 'Not on a teamportrait page' });
        return;
      }
      const openResult = await clickPlayerAnzeigenByDtbId(
        request.dtbId,
        Number.isInteger(request.maxExpandClicks) ? request.maxExpandClicks : 30
      );
      sendResponse(openResult);
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || String(error) });
    });
    return true;
  }

  return false;
});

initializeClubView();
