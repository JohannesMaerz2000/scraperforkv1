// Tournament content script - URL-first, resilient parser
console.log('🎾 Tournament content script loaded (reworked)');
const CONTENT_DEBUG = (() => {
  try {
    const query = new URLSearchParams(window.location.search || '');
    if (query.get('tdebug') === '1') return true;
    if (window.localStorage.getItem('tennisTournamentDebug') === '1') return true;
    if (window.sessionStorage.getItem('tennisTournamentDebug') === '1') return true;
    return false;
  } catch (_error) {
    return false;
  }
})();
function debugLog(...args) {
  if (!CONTENT_DEBUG) return;
  console.log('[tournament-content]', ...args);
}
debugLog('Debug mode enabled', {
  href: window.location.href,
  userAgent: navigator.userAgent
});

const ROUTE_POLL_MS = 1000;
const REPARSE_DEBOUNCE_MS = 350;
const AUTO_EXPAND_REPARSE_MS = 500;
const AUTO_EXPAND_COOLDOWN_MS = 1500;

let currentTournamentId = null;
let lastRouteKey = null;
let routePollTimer = null;
let domObserver = null;
let pendingParseTimer = null;
let lastPlatzanlageExpandAttempt = {
  key: null,
  at: 0
};
let lastSentSignatures = {
  tournamentPageLoaded: null,
  tournamentLocationData: null,
  zulassungslisteData: null
};

function normalizeText(value) {
  return (value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normLower(value) {
  return normalizeText(value).toLowerCase();
}

function isElementVisible(element) {
  if (!element) return false;
  if (!(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleText(element) {
  if (!element || !isElementVisible(element)) return '';
  return normalizeText(element.textContent);
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (isElementVisible(node)) {
        return node;
      }
    }
  }
  return null;
}

function parseTournamentHashContext(rawUrl = window.location.href) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    const hash = (url.hash || '').replace(/^#/, '');
    debugLog('parseTournamentHashContext input', {
      rawUrl,
      path,
      hash
    });

    if (!path.includes('/turniersuche')) {
      const context = {
        pageType: 'other',
        tournamentId: null,
        categoryId: null,
        categorySlug: null,
        status: null,
        hash
      };
      debugLog('parseTournamentHashContext output', context);
      return context;
    }

    const detailMatch = hash.match(/^\/?detail\/(\d+)(?:\/.*)?$/i);
    if (detailMatch) {
      const context = {
        pageType: 'detail',
        tournamentId: detailMatch[1],
        categoryId: null,
        categorySlug: null,
        status: null,
        hash
      };
      debugLog('parseTournamentHashContext output', context);
      return context;
    }

    const zlistMatch = hash.match(/^\/?zlist\/(\d+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/?#]+))?/i);
    if (zlistMatch) {
      const context = {
        pageType: 'zlist',
        tournamentId: zlistMatch[1],
        categoryId: zlistMatch[2] ? decodeURIComponent(zlistMatch[2]) : null,
        categorySlug: zlistMatch[3] ? decodeURIComponent(zlistMatch[3]) : null,
        status: zlistMatch[4] ? decodeURIComponent(zlistMatch[4]) : null,
        hash
      };
      debugLog('parseTournamentHashContext output', context);
      return context;
    }

    const context = {
      pageType: 'search',
      tournamentId: null,
      categoryId: null,
      categorySlug: null,
      status: null,
      hash
    };
    debugLog('parseTournamentHashContext output', context);
    return context;
  } catch (_error) {
    const context = {
      pageType: 'other',
      tournamentId: null,
      categoryId: null,
      categorySlug: null,
      status: null,
      hash: ''
    };
    debugLog('parseTournamentHashContext output (fallback)', context);
    return context;
  }
}

function extractTournamentId() {
  return parseTournamentHashContext().tournamentId;
}

function storeTournamentContext(tournamentId) {
  if (!tournamentId) return;
  currentTournamentId = String(tournamentId);
  sessionStorage.setItem('currentTournamentId', String(tournamentId));
}

function getCurrentTournamentId() {
  return currentTournamentId || sessionStorage.getItem('currentTournamentId');
}

function clearTournamentContext() {
  currentTournamentId = null;
  sessionStorage.removeItem('currentTournamentId');
}

async function safeSendMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
    return true;
  } catch (error) {
    if (!String(error?.message || '').includes('Extension context invalidated')) {
      console.error('[tournament-content] Message send failed', error);
    }
    return false;
  }
}

function sendDeduped(action, payload, signatureSource) {
  const signature = JSON.stringify(signatureSource);
  if (lastSentSignatures[action] === signature) {
    debugLog('sendDeduped skipped (same signature)', action, signatureSource);
    return;
  }
  lastSentSignatures[action] = signature;
  debugLog('sendDeduped emit', action, {
    tournamentId: payload?.tournamentId || null,
    name: payload?.tournamentName || null,
    isDetailPage: payload?.isDetailPage,
    pageType: payload?.route?.pageType || null,
    hash: payload?.route?.hash || null
  });
  safeSendMessage({ action, ...payload });
}

function formatDateToIso(value) {
  const cleaned = normalizeText(value);
  const match = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3];
  return `${year}-${month}-${day}`;
}

function findLabelElements(label) {
  const target = normLower(label);
  const spans = document.querySelectorAll('span, div, td, th, strong');
  const results = [];
  for (const node of spans) {
    if (!isElementVisible(node)) continue;
    const text = normLower(node.textContent);
    if (text === target) {
      results.push(node);
    }
  }
  return results;
}

function findValueNearLabel(label) {
  const labelEls = findLabelElements(label);
  for (const labelEl of labelEls) {
    const row = labelEl.closest('tr');
    if (row) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      for (const cell of cells) {
        const text = visibleText(cell);
        if (text && normLower(text) !== normLower(label)) {
          return text;
        }
      }
    }

    const container = labelEl.closest('.z-hlayout, .z-vlayout, .z-row-content, .z-div') || labelEl.parentElement;
    if (!container) continue;

    const candidates = Array.from(container.querySelectorAll('span, div, a, td'));
    for (const candidate of candidates) {
      if (candidate === labelEl) continue;
      const text = visibleText(candidate);
      if (!text) continue;
      if (normLower(text) === normLower(label)) continue;
      if (['termin', 'meldeschluss', 'auslosung', 'status'].includes(normLower(text))) continue;
      return text;
    }

    let next = labelEl.nextElementSibling;
    let hops = 0;
    while (next && hops < 8) {
      const text = visibleText(next);
      if (text && normLower(text) !== normLower(label)) {
        return text;
      }
      next = next.nextElementSibling;
      hops += 1;
    }
  }

  return null;
}

function extractTournamentName() {
  const candidates = Array.from(
    document.querySelectorAll('span.zk-font-48.zk-font-light.z-label, span[class*="zk-font-48"][class*="z-label"], h1')
  ).filter((node) => {
    if (!isElementVisible(node)) return false;
    const text = normalizeText(node.textContent);
    if (!text) return false;
    const lowered = normLower(text);
    if (lowered.startsWith('zulassungsliste')) return false;
    if (lowered.includes('turniersuche')) return false;
    return true;
  });
  if (CONTENT_DEBUG) {
    const candidateDetails = candidates.map((node, idx) => {
      const rect = node.getBoundingClientRect();
      return {
        idx,
        tag: node.tagName,
        className: node.className || '',
        text: normalizeText(node.textContent),
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
    debugLog('extractTournamentName candidates', candidateDetails);
  }

  if (candidates.length === 0) {
    debugLog('extractTournamentName selected fallback', 'Unnamed Tournament');
    return 'Unnamed Tournament';
  }

  candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const selected = normalizeText(candidates[0].textContent);
  debugLog('extractTournamentName selected', selected);
  return selected;
}

function extractTournamentDates() {
  const nowIso = new Date().toISOString().slice(0, 10);

  const terminValue = findValueNearLabel('Termin') || '';
  const terminMatches = terminValue.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || [];

  const startDate = formatDateToIso(terminMatches[0] || '') || nowIso;
  const endDate = formatDateToIso(terminMatches[1] || terminMatches[0] || '') || startDate;

  const deadlineValue = findValueNearLabel('Meldeschluss') || '';
  const registrationDeadline = formatDateToIso(deadlineValue) || startDate;

  const result = { startDate, endDate, registrationDeadline };
  debugLog('extractTournamentDates', {
    terminValue,
    deadlineValue,
    result
  });
  return result;
}

function extractGoogleMapsLink() {
  const direct = Array.from(
    document.querySelectorAll('a[href*="google.com/maps"], a[href*="maps.google.com"], a[href*="maps.app.goo.gl"]')
  ).find(isElementVisible);

  if (direct?.href) return direct.href;

  const mapsByText = Array.from(document.querySelectorAll('a')).find((a) => {
    return isElementVisible(a) && normLower(a.textContent).includes('google maps');
  });

  return mapsByText?.href || null;
}

function findPlatzanlageGroupbox() {
  const labels = Array.from(document.querySelectorAll('span, div, td, th, strong')).filter((node) => {
    return isElementVisible(node) && normLower(node.textContent) === 'platzanlage';
  });

  for (const label of labels) {
    const groupbox = label.closest('.z-groupbox');
    if (groupbox) return groupbox;
  }

  return null;
}

function isGroupboxExpanded(groupbox) {
  if (!groupbox) return false;

  const toggle = groupbox.querySelector(':scope > .z-groupbox-header [id$="-toggle"][role="button"]');
  if (toggle && toggle.getAttribute('aria-expanded') === 'true') {
    return true;
  }

  const openIndicator = groupbox.querySelector('[class*="gbopen-"]');
  if (openIndicator?.classList.contains('gbopen-true')) {
    return true;
  }

  const cave = groupbox.querySelector(':scope > .z-groupbox-content');
  if (cave && isElementVisible(cave)) {
    return true;
  }

  return false;
}

function triggerClick(element) {
  if (!element) return false;
  if (!(element instanceof Element)) return false;

  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}

function ensurePlatzanlageExpanded(routeKey = '') {
  const groupbox = findPlatzanlageGroupbox();
  if (!groupbox) return false;

  if (isGroupboxExpanded(groupbox)) return false;

  const attemptKey = `${routeKey}|${groupbox.id || 'platzanlage'}`;
  const now = Date.now();
  if (
    lastPlatzanlageExpandAttempt.key === attemptKey &&
    now - lastPlatzanlageExpandAttempt.at < AUTO_EXPAND_COOLDOWN_MS
  ) {
    return false;
  }

  const header = groupbox.querySelector(':scope > .z-groupbox-header');
  const clickTargets = [
    groupbox.querySelector(':scope > .z-groupbox-header [id$="-toggle"][role="button"]'),
    header?.querySelector('.z-caption-content'),
    header?.querySelector('.customPosition.z-caption'),
    header
  ].filter(Boolean);

  for (const target of clickTargets) {
    if (triggerClick(target)) {
      lastPlatzanlageExpandAttempt = {
        key: attemptKey,
        at: now
      };
      debugLog('Auto-expanded Platzanlage section', {
        routeKey,
        groupboxId: groupbox.id || null
      });
      return true;
    }
  }

  return false;
}

function extractLocationData() {
  const tournamentName = extractTournamentName();

  const zipAndCity = findValueNearLabel('PLZ und Ort') || '';
  const street = findValueNearLabel('Straße') || '';
  const courtSurface = findValueNearLabel('Platzbelag') || '';

  const website = Array.from(document.querySelectorAll('a[href^="http"]')).find((a) => {
    if (!isElementVisible(a)) return false;
    const href = (a.getAttribute('href') || '').toLowerCase();
    return !href.includes('google.') && !href.includes('maps.');
  })?.href || null;

  const clubNameCandidate = firstVisible([
    '.bottomgrid-court .zk-font-22.z-label',
    '.zk-font-22.z-label'
  ]);

  const clubName = normalizeText(clubNameCandidate?.textContent || '');

  const fullAddress = [street, zipAndCity].filter(Boolean).join(', ');

  return {
    tournamentName,
    clubName,
    street,
    zipAndCity,
    fullAddress,
    courtSurface: courtSurface || null,
    website
  };
}

function detectTournamentTypes() {
  const scopeRoot = firstVisible(['.z-window-content', '.z-window']) || document.body;
  const visibleImages = Array.from(scopeRoot.querySelectorAll('img')).filter((img) => {
    if (!isElementVisible(img)) return false;
    const rect = img.getBoundingClientRect();
    return rect.top < window.innerHeight * 1.8;
  });
  const visibleSources = visibleImages.map((img) => (img.getAttribute('src') || '').toLowerCase());

  const isDtbTournament = visibleSources.some((src) => src.includes('/dtb.svg'));
  const isLkTournament = visibleSources.some((src) => src.includes('/lk.svg'));

  return { isDtbTournament, isLkTournament };
}

function formatCategoryFromSlug(categorySlug) {
  if (!categorySlug) return null;
  return normalizeText(categorySlug.replace(/-/g, '/'));
}

function sanitizeCategoryName(rawCategoryName, context) {
  let categoryName = normalizeText(rawCategoryName || '');
  if (!categoryName) {
    return formatCategoryFromSlug(context?.categorySlug) || 'Unknown Category';
  }

  categoryName = categoryName
    .replace(/\s+(?:SP|Sp)\s+Name\b[\s\S]*$/i, '')
    .replace(/\s+(?:Impressum|Kontakt|Barrierefreiheit|Digital Services Act)\b[\s\S]*$/i, '')
    .trim();

  const looksContaminated =
    !categoryName ||
    categoryName.length > 80 ||
    /(digital services act|barrierefreiheit|kontakt|impressum)/i.test(categoryName);

  if (looksContaminated) {
    return formatCategoryFromSlug(context?.categorySlug) || 'Unknown Category';
  }

  return categoryName;
}

function extractZulassungHeader(context) {
  const headerCandidates = Array.from(document.querySelectorAll('span, div, td, th, h1, h2, h3, .z-label'))
    .filter((node) => isElementVisible(node))
    .map((node) => normalizeText(node.textContent))
    .filter((text) => /zulassungsliste\s+für/i.test(text))
    .filter((text) => text.length <= 220)
    .sort((a, b) => a.length - b.length);

  const headerText = headerCandidates[0] || '';
  const match = headerText.match(
    /Zulassungsliste\s+für\s+(.+?)(?:\s*\(Stand:\s*([^)]*)\))?(?:\s*$|\s+(?:SP|Sp)\s+Name\b)/i
  );

  const rawCategoryName = match?.[1] ? normalizeText(match[1]) : '';
  const categoryName = sanitizeCategoryName(rawCategoryName, context);
  const timestampText = match?.[2] ? normalizeText(match[2]) : null;

  return {
    categoryName,
    timestampText,
    sourceHeader: headerText
  };
}

function convertLKToNumeric(lkText) {
  if (!lkText) return null;
  const match = normalizeText(lkText).match(/(?:LK)?(\d+)[,.](\d+)/i);
  if (!match) return null;
  return Number.parseFloat(`${match[1]}.${match[2]}`);
}

function parseDtbId(text) {
  const match = normalizeText(text).match(/DTB-ID\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function cleanPlayerName(rawName) {
  const text = normalizeText(rawName);
  if (!text) return '';
  return text.replace(/\s*DTB-ID\s*\d+\s*/gi, '').trim();
}

function isPlaceholderName(name) {
  const lowered = normLower(name);
  return lowered === '[wildcard]' || lowered === '[qualifikant]';
}

function findZlistTable() {
  const tables = Array.from(document.querySelectorAll('table'));

  for (const table of tables) {
    if (!isElementVisible(table)) continue;
    const text = normLower(table.textContent);
    if (text.includes('name') && text.includes('verein') && text.includes('lk') && text.includes('hauptfeld')) {
      return table;
    }
  }

  return null;
}

function collectRowsFromLegacyZListDom() {
  const rows = Array.from(document.querySelectorAll('.bottomgrid.z-row'));
  return rows.filter((row) => isElementVisible(row) && row.querySelectorAll('.z-cell').length > 0);
}

function mapHeaderIndexes(table) {
  const headerRow = Array.from(table.querySelectorAll('tr')).find((tr) => {
    const text = normLower(tr.textContent);
    return text.includes('name') && text.includes('verein') && text.includes('lk');
  });

  if (!headerRow) {
    return {
      sp: 0,
      pos: 1,
      name: 2,
      club: 3,
      lk: 5,
      dr: 6
    };
  }

  const cells = Array.from(headerRow.querySelectorAll('th, td'));
  const indexByLabel = {};

  cells.forEach((cell, idx) => {
    const label = normLower(cell.textContent);
    if (label === 'sp') indexByLabel.sp = idx;
    if (label === 'name') indexByLabel.name = idx;
    if (label === 'verein') indexByLabel.club = idx;
    if (label === 'lk') indexByLabel.lk = idx;
    if (label === 'dr') indexByLabel.dr = idx;
    if (label === 'hauptfeld' || label === 'position') indexByLabel.pos = idx;
  });

  return {
    sp: Number.isInteger(indexByLabel.sp) ? indexByLabel.sp : 0,
    pos: Number.isInteger(indexByLabel.pos) ? indexByLabel.pos : 1,
    name: Number.isInteger(indexByLabel.name) ? indexByLabel.name : 2,
    club: Number.isInteger(indexByLabel.club) ? indexByLabel.club : 3,
    lk: Number.isInteger(indexByLabel.lk) ? indexByLabel.lk : 5,
    dr: Number.isInteger(indexByLabel.dr) ? indexByLabel.dr : 6
  };
}

function parseZulassungsliste(context) {
  const table = findZlistTable();
  const header = extractZulassungHeader(context);
  const idx = table ? mapHeaderIndexes(table) : {
    sp: 0,
    pos: 1,
    name: 2,
    club: 3,
    lk: 5,
    dr: 6
  };

  const rows = table
    ? Array.from(table.querySelectorAll('tbody tr, tr'))
    : collectRowsFromLegacyZListDom();

  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'zlist rows not found'
    };
  }

  let currentSection = 'main_draw';
  let currentSectionName = 'Hauptfeld';

  const players = [];
  const stats = {
    rowsSeen: 0,
    sections: {
      main_draw: 0,
      qualifikation: 0,
      nachruecker: 0
    },
    placeholders: 0,
    warnings: []
  };

  for (const row of rows) {
    if (!isElementVisible(row)) continue;

    let cells = Array.from(row.querySelectorAll(':scope > td, :scope > th'));
    if (cells.length === 0) {
      cells = Array.from(row.querySelectorAll('.z-cell'));
    }
    if (cells.length === 0) continue;

    stats.rowsSeen += 1;

    if (cells.length === 1 && cells[0].hasAttribute('colspan')) {
      const sectionText = normalizeText(cells[0].textContent);
      const lowered = normLower(sectionText);
      currentSectionName = sectionText;

      if (lowered.includes('nachrücker')) {
        currentSection = 'nachruecker';
      } else if (lowered.includes('qualifikation')) {
        currentSection = 'qualifikation';
      } else {
        currentSection = 'main_draw';
      }
      continue;
    }

    const nameCell = cells[idx.name] || cells[2] || null;
    if (!nameCell) continue;

    const nameCellText = normalizeText(nameCell.textContent);
    if (!nameCellText || normLower(nameCellText) === 'name') continue;

    let playerName = cleanPlayerName(nameCellText.split('DTB-ID')[0]);
    if (!playerName) {
      const altName = nameCell.querySelector('.z-toolbarbutton-content, .zk-font-bold, .z-label');
      playerName = cleanPlayerName(altName?.textContent || '');
    }
    const dtbId = parseDtbId(nameCellText) || parseDtbId(normalizeText(nameCell.innerText || ''));

    if (!playerName || playerName === '-') continue;

    const placeholder = isPlaceholderName(playerName);

    const clubText = normalizeText((cells[idx.club] || cells[3] || { textContent: '' }).textContent || '');
    const lkText = normalizeText((cells[idx.lk] || cells[5] || { textContent: '' }).textContent || '');
    const drText = normalizeText((cells[idx.dr] || cells[6] || { textContent: '' }).textContent || '');

    const posText = normalizeText((cells[idx.pos] || cells[1] || { textContent: '' }).textContent || '');
    const spText = normalizeText((cells[idx.sp] || cells[0] || { textContent: '' }).textContent || '');

    const position = Number.parseInt(posText, 10);
    const seedNumber = Number.parseInt(spText, 10);

    const dtbRanking = /^\d+$/.test(drText) ? Number.parseInt(drText, 10) : null;

    const registrationStatus = currentSection === 'nachruecker' ? 'nachrücker' : currentSection;

    const player = {
      position: Number.isInteger(position) ? position : null,
      seedNumber: Number.isInteger(seedNumber) ? seedNumber : null,
      name: playerName,
      dtbId: dtbId || null,
      club: clubText || null,
      lk: lkText || null,
      lkNumeric: convertLKToNumeric(lkText),
      dtbRanking,
      registrationStatus,
      sectionName: currentSectionName,
      isSeeded: Number.isInteger(seedNumber) && currentSection === 'main_draw',
      isPlaceholder: placeholder
    };

    if (placeholder) {
      stats.placeholders += 1;
      continue;
    }

    players.push(player);

    if (currentSection === 'qualifikation') stats.sections.qualifikation += 1;
    else if (currentSection === 'nachruecker') stats.sections.nachruecker += 1;
    else stats.sections.main_draw += 1;
  }

  const seenKeys = new Set();
  for (const player of players) {
    const key = player.dtbId ? `dtb:${player.dtbId}` : `nameclub:${normLower(player.name)}|${normLower(player.club || '')}`;
    if (seenKeys.has(key)) {
      stats.warnings.push(`duplicate:${key}`);
    }
    seenKeys.add(key);
  }

  const payload = {
    ok: true,
    categoryName: header.categoryName,
    timestamp: header.timestampText,
    players,
    stats,
    lastUpdated: new Date().toISOString(),
    route: context
  };
  debugLog('parseZulassungsliste summary', {
    categoryName: payload.categoryName,
    timestamp: payload.timestamp,
    playerCount: payload.players.length,
    stats: payload.stats,
    route: payload.route
  });
  return payload;
}

function buildTournamentPayload(context) {
  const tournamentId = context.tournamentId || getCurrentTournamentId();
  if (!tournamentId) {
    return null;
  }

  const name = extractTournamentName();
  const dates = extractTournamentDates();
  const location = extractLocationData();
  const googleMapsLink = extractGoogleMapsLink();
  const types = detectTournamentTypes();

  return {
    tournamentId,
    tournamentName: name,
    url: window.location.href,
    isDetailPage: true,
    startDate: dates.startDate,
    endDate: dates.endDate,
    registrationDeadline: dates.registrationDeadline,
    location,
    googleMapsLink,
    isDtbTournament: types.isDtbTournament,
    isLkTournament: types.isLkTournament,
    timestamp: Date.now(),
    route: context
  };
}

function emitTournamentState(context) {
  debugLog('emitTournamentState', context);
  if (context.pageType === 'search' || context.pageType === 'other') {
    sendDeduped(
      'tournamentPageLoaded',
      {
        isDetailPage: false,
        url: window.location.href,
        timestamp: Date.now(),
        route: context
      },
      {
        isDetailPage: false,
        url: window.location.href,
        hash: context.hash
      }
    );
    return;
  }

  const payload = buildTournamentPayload(context);
  if (!payload) return;
  debugLog('buildTournamentPayload', {
    tournamentId: payload.tournamentId,
    name: payload.tournamentName,
    pageType: context.pageType
  });

  sendDeduped('tournamentPageLoaded', payload, {
    tournamentId: payload.tournamentId,
    name: payload.tournamentName,
    startDate: payload.startDate,
    endDate: payload.endDate,
    registrationDeadline: payload.registrationDeadline,
    fullAddress: payload.location?.fullAddress || '',
    googleMapsLink: payload.googleMapsLink || '',
    pageType: context.pageType
  });

  if (payload.location && (payload.location.fullAddress || payload.location.clubName)) {
    sendDeduped(
      'tournamentLocationData',
      {
        tournamentId: payload.tournamentId,
        location: payload.location,
        timestamp: Date.now(),
        route: context
      },
      {
        tournamentId: payload.tournamentId,
        location: payload.location
      }
    );
  }

  if (context.pageType === 'zlist') {
    const zlist = parseZulassungsliste(context);
    if (zlist.ok) {
      sendDeduped(
        'zulassungslisteData',
        {
          tournamentId: payload.tournamentId,
          sourceCategoryId: context.categoryId || null,
          sourceCategorySlug: context.categorySlug || null,
          sourceStatus: context.status || null,
          categoryName: zlist.categoryName,
          timestamp: zlist.timestamp,
          lastUpdated: zlist.lastUpdated,
          players: zlist.players,
          diagnostics: zlist.stats,
          route: context
        },
        {
          tournamentId: payload.tournamentId,
          sourceCategoryId: context.categoryId || null,
          sourceCategorySlug: context.categorySlug || null,
          sourceStatus: context.status || null,
          categoryName: zlist.categoryName,
          playerCount: zlist.players.length,
          firstPlayer: zlist.players[0]?.name || '',
          lastPlayer: zlist.players[zlist.players.length - 1]?.name || '',
          sections: zlist.stats.sections,
          warnings: zlist.stats.warnings
        }
      );
    } else {
      console.warn('[tournament-content] zlist parse failed:', zlist.reason);
    }
  }
}

function scheduleParse(reason = 'unknown', immediate = false) {
  if (pendingParseTimer) {
    clearTimeout(pendingParseTimer);
    pendingParseTimer = null;
  }

  const run = () => {
    const context = parseTournamentHashContext();
    const routeKey = `${context.pageType}|${context.tournamentId || ''}|${context.categoryId || ''}|${context.categorySlug || ''}|${context.status || ''}`;

    if (context.tournamentId) {
      storeTournamentContext(context.tournamentId);
    } else if (context.pageType === 'search' || context.pageType === 'other') {
      clearTournamentContext();
    }

    const routeChanged = routeKey !== lastRouteKey;
    lastRouteKey = routeKey;
    debugLog('scheduleParse run', { reason, immediate, routeKey, routeChanged, context });

    if (!routeChanged && reason === 'route') {
      debugLog('scheduleParse route skipped (no route change)', { routeKey, context });
      return;
    }

    if (context.pageType === 'detail') {
      const expanded = ensurePlatzanlageExpanded(routeKey);
      if (expanded) {
        setTimeout(() => scheduleParse('platzanlage-auto-expanded', true), AUTO_EXPAND_REPARSE_MS);
      }
    }

    emitTournamentState(context);
  };

  if (immediate) {
    run();
    return;
  }

  pendingParseTimer = setTimeout(run, REPARSE_DEBOUNCE_MS);
}

function startObservers() {
  if (routePollTimer) {
    clearInterval(routePollTimer);
  }

  routePollTimer = setInterval(() => {
    const context = parseTournamentHashContext();
    const routeKey = `${context.pageType}|${context.tournamentId || ''}|${context.categoryId || ''}|${context.categorySlug || ''}|${context.status || ''}`;
    if (routeKey !== lastRouteKey) {
      scheduleParse('route', true);
    }
  }, ROUTE_POLL_MS);

  if (domObserver) {
    domObserver.disconnect();
  }

  domObserver = new MutationObserver((mutations) => {
    const context = parseTournamentHashContext();
    if (context.pageType !== 'detail' && context.pageType !== 'zlist') {
      return;
    }

    const shouldReparse = mutations.some((mutation) => {
      if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
        return true;
      }
      if (mutation.type === 'characterData') {
        return true;
      }
      return false;
    });

    if (shouldReparse) {
      scheduleParse('dom');
    }
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener('hashchange', () => scheduleParse('route', true));
  window.addEventListener('popstate', () => scheduleParse('route', true));
}

function initializeTournamentView() {
  scheduleParse('init', true);
}

function clickPlatzanlageButton() {
  const context = parseTournamentHashContext();
  const routeKey = `${context.pageType}|${context.tournamentId || ''}|${context.categoryId || ''}|${context.categorySlug || ''}|${context.status || ''}`;
  if (context.pageType === 'detail') {
    ensurePlatzanlageExpanded(routeKey);
  }
  scheduleParse('manual-location-refresh', true);
}

function setupTournamentPageObserver() {
  startObservers();
}

chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
  if (request.action === 'initializeTournamentView') {
    initializeTournamentView();
  }
  return true;
});

startObservers();
initializeTournamentView();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeTournamentView,
    extractTournamentId,
    extractTournamentName,
    extractTournamentDates,
    extractLocationData,
    clickPlatzanlageButton,
    setupTournamentPageObserver,
    parseTournamentHashContext,
    parseZulassungsliste
  };
}
