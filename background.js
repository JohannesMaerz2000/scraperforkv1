importScripts('config.js');
importScripts('supabase.js');
importScripts('league-parsers.js');
importScripts('supabase-client.js');

const PANEL_PATHS = {
  player: 'sidepanel.html',
  tournament: 'tournament-sidepanel.html',
  club: 'club-sidepanel.html'
};

const state = {
  supabaseClient: null,
  activeHistorySyncContext: null,
  expPlayerHistoryAutomation: {
    isRunning: false,
    stopRequested: false,
    runStartedAt: null,
    tabId: null,
    batchId: null,
    batchKey: null,
    teamPortraitUrl: null,
    processed: 0,
    completed: 0,
    failed: 0,
    lastError: null
  },
  latestClubLeagueContext: null,
  leaguePdfContextByKey: {},
  activeTabPage: {
    tabId: null,
    url: null,
    isTennisPage: false,
    isProfilePage: false,
    isTournamentPage: false,
    isClubPage: false
  }
};

function buildLeaguePdfContextKey(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const club = parsed.searchParams.get('club');
    const season = parsed.searchParams.get('season');
    if (!club || !season) return null;
    return `${club}|${season}`;
  } catch (_error) {
    return null;
  }
}

async function persistLeaguePdfContext(url, context) {
  const key = buildLeaguePdfContextKey(url);
  if (!key) return;

  const existing = state.leaguePdfContextByKey || {};
  state.leaguePdfContextByKey = {
    ...existing,
    [key]: {
      federation_code: context?.federation_code || null,
      source_club_id: context?.source_club_id || null,
      season_year: context?.season_year || null,
      season_type: context?.season_type || null
    }
  };

  try {
    await chrome.storage.local.set({ leaguePdfContextByKey: state.leaguePdfContextByKey });
  } catch (_error) {
    // Non-fatal
  }
}

async function loadLeaguePdfContextByUrl(url) {
  const key = buildLeaguePdfContextKey(url);
  if (!key) return null;

  if (state.leaguePdfContextByKey && state.leaguePdfContextByKey[key]) {
    return state.leaguePdfContextByKey[key];
  }

  try {
    const result = await chrome.storage.local.get(['leaguePdfContextByKey']);
    const map = result?.leaguePdfContextByKey || {};
    state.leaguePdfContextByKey = map;
    return map[key] || null;
  } catch (_error) {
    return null;
  }
}

async function persistLatestClubLeagueContext(partial = {}) {
  const merged = {
    federation_code: partial?.federation_code || state.latestClubLeagueContext?.federation_code || null,
    source_club_id: partial?.source_club_id || state.latestClubLeagueContext?.source_club_id || null,
    season_year: partial?.season_year || state.latestClubLeagueContext?.season_year || null,
    season_type: partial?.season_type || state.latestClubLeagueContext?.season_type || null
  };
  state.latestClubLeagueContext = merged;
  try {
    await chrome.storage.local.set({ latestClubLeagueContext: merged });
  } catch (_error) {
    // Ignore storage errors; in-memory fallback still exists.
  }
}

async function loadLatestClubLeagueContext() {
  if (state.latestClubLeagueContext) return state.latestClubLeagueContext;
  try {
    const result = await chrome.storage.local.get(['latestClubLeagueContext']);
    if (result?.latestClubLeagueContext) {
      state.latestClubLeagueContext = result.latestClubLeagueContext;
      return state.latestClubLeagueContext;
    }
  } catch (_error) {
    // Ignore storage read issues.
  }
  return null;
}

function log(...args) {
  console.log('[background]', ...args);
}

function parseTennisPageType(url) {
  if (!url) {
    return {
      isTennisPage: false,
      isProfilePage: false,
      isTournamentPage: false,
      isClubPage: false
    };
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const isTennisHost = host === 'www.tennis.de' || host.endsWith('.tennis.de');
    const isLigaPdfPage = host === 'dtb.liga.nu'
      && path.includes('/cgi-bin/webobjects/nuligadokumenttende.woa/wa/nudokument');
    const isTennisPage = isTennisHost || isLigaPdfPage;

    if (!isTennisPage) {
      return {
        isTennisPage: false,
        isProfilePage: false,
        isTournamentPage: false,
        isClubPage: false
      };
    }

    return {
      isTennisPage,
      isProfilePage: isTennisHost && path.includes('/spielerprofil'),
      isTournamentPage: isTennisHost && path.includes('/turniersuche'),
      isClubPage: (isTennisHost && (path.includes('/mannschaftssuche') || path.includes('/vereinsspielplan')))
        || isLigaPdfPage
    };
  } catch (error) {
    log('Failed to parse URL', url, error);
    return {
      isTennisPage: false,
      isProfilePage: false,
      isTournamentPage: false,
      isClubPage: false
    };
  }
}

function getClient() {
  return state.supabaseClient;
}

function isClientReadyAndAuthed() {
  const client = getClient();
  return !!(client && client.isReady() && client.isAuthenticated());
}

async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (_error) {
    // Sidepanel may not be open; ignore.
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIntBetween(minValue, maxValue) {
  const min = Number.isFinite(minValue) ? Math.max(0, Math.floor(minValue)) : 0;
  const max = Number.isFinite(maxValue) ? Math.max(min, Math.floor(maxValue)) : min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sendToTabWithRetry(tabId, message, maxAttempts = 8, waitMs = 700) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await sendToTab(tabId, message);
    if (response) return response;
    await delay(waitMs);
  }
  return null;
}

async function navigateTabAndWait(tabId, url, timeoutMs = 20000) {
  if (!tabId || !url) return false;

  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (done) return;
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;
      if (!tab?.url || !tab.url.includes('tennis.de')) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(true);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    });
  });
}

function getExpAutomationStatus() {
  return { ...state.expPlayerHistoryAutomation };
}

function extractTeamPortraitIdFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const hash = (url.hash || '').replace(/^#/, '');
    const match = hash.match(/^\/?teamportrait\/(\d+)/i);
    return match ? match[1] : null;
  } catch (_error) {
    return null;
  }
}

function buildStableBatchKeyForTeamUrl(teamPortraitUrl) {
  const teamId = extractTeamPortraitIdFromUrl(teamPortraitUrl);
  if (teamId) return `exp_team_${teamId}_full_playerlist`;
  return `exp_team_unknown_${Date.now()}`;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function setBadge(tabId, pageInfo) {
  if (!tabId) return;

  if (!pageInfo.isTennisPage) {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setTitle({ title: 'Tennis.de Match Scraper', tabId });
    return;
  }

  chrome.action.setBadgeText({ text: '●', tabId });
  const badgeColor = pageInfo.isTournamentPage
    ? '#FFA500'
    : pageInfo.isClubPage
      ? '#00796B'
      : '#4CAF50';
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: badgeColor
  });
  const title = pageInfo.isTournamentPage
    ? 'Tournament Mode - Click to open'
    : pageInfo.isClubPage
      ? 'Club Mode - Click to open'
      : 'Player Mode - Click to open';
  chrome.action.setTitle({
    tabId,
    title
  });
}

async function setPanelByPage(tabId, pageInfo) {
  const automationState = state.expPlayerHistoryAutomation;
  const lockToClubPanel =
    automationState?.isRunning
    && Number.isInteger(automationState?.tabId)
    && Number.isInteger(tabId)
    && automationState.tabId === tabId;

  if (lockToClubPanel) {
    await chrome.sidePanel.setOptions({ path: PANEL_PATHS.club, enabled: true });
    return;
  }

  if (pageInfo.isTournamentPage) {
    await chrome.sidePanel.setOptions({ path: PANEL_PATHS.tournament, enabled: true });
    return;
  }

  if (pageInfo.isClubPage) {
    await chrome.sidePanel.setOptions({ path: PANEL_PATHS.club, enabled: true });
    return;
  }

  if (pageInfo.isProfilePage) {
    await chrome.sidePanel.setOptions({ path: PANEL_PATHS.player, enabled: true });
    return;
  }

  await chrome.sidePanel.setOptions({ path: PANEL_PATHS.player, enabled: true });
}

async function notifyUrlUpdated(tabId, url, pageInfo) {
  state.activeTabPage = {
    tabId,
    url,
    ...pageInfo
  };

  await broadcast({
    action: 'urlUpdated',
    url,
    isPlayerProfile: pageInfo.isProfilePage,
    isTournamentPage: pageInfo.isTournamentPage,
    isClubPage: pageInfo.isClubPage
  });
}

async function triggerPageInit(tabId, pageInfo, delayMs = 800) {
  if (!tabId || (!pageInfo.isProfilePage && !pageInfo.isTournamentPage && !pageInfo.isClubPage)) return;

  let action = 'scrapeCurrentPage';
  if (pageInfo.isTournamentPage) {
    action = 'initializeTournamentView';
  } else if (pageInfo.isClubPage) {
    action = 'initializeClubView';
  }

  setTimeout(() => {
    sendToTab(tabId, { action });
  }, delayMs);
}

async function processPageContext(tabId, url, triggerInit = false) {
  const pageInfo = parseTennisPageType(url);

  setBadge(tabId, pageInfo);
  await setPanelByPage(tabId, pageInfo);
  await notifyUrlUpdated(tabId, url, pageInfo);

  if (triggerInit) {
    await triggerPageInit(tabId, pageInfo);
  }
}

async function handleUserSignIn({ email, password, supabaseUrl, supabaseKey }) {
  try {
    const client = getClient();
    if (!client) {
      return { success: false, error: 'Supabase client not initialized' };
    }

    const result = await client.signIn(email, password, supabaseUrl, supabaseKey);
    if (result.success) {
      await broadcast({ action: 'userSignedIn', success: true, user: result.user });
      await broadcast({ action: 'authStatusChanged', authenticated: true, user: result.user });
    }

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleUserSignOut() {
  try {
    const client = getClient();
    if (client) {
      await client.signOut();
    }

    await broadcast({ action: 'userSignedOut' });
    await broadcast({ action: 'authStatusChanged', authenticated: false, user: null });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleCheckAuthStatus() {
  const client = getClient();
  if (!client) {
    return { success: false, authenticated: false, user: null, error: 'Client not initialized' };
  }

  const authenticated = client.isAuthenticated();
  const user = client.getCurrentUser();

  return {
    success: true,
    authenticated,
    user
  };
}

async function uploadPlayerData(playerData) {
  if (!isClientReadyAndAuthed()) return;

  try {
    const result = await getClient().uploadPlayerData(playerData);
    await broadcast({ action: 'playerDataUploaded', ...result });
  } catch (error) {
    await broadcast({ action: 'playerDataUploaded', success: false, error: error.message });
  }
}

async function uploadMatches(matches) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first to upload matches.' };
  }

  try {
    const onProgress = (progress) => {
      broadcast({ action: 'uploadProgress', progress });
    };

    const result = await getClient().uploadMatches(matches, onProgress);
    await broadcast({ action: 'uploadCompleted', result });
    return result;
  } catch (error) {
    const result = { success: false, error: error.message };
    await broadcast({ action: 'uploadCompleted', result });
    return result;
  }
}

async function handleStartFullHistoryScrape() {
  return handleStartFullHistoryScrapeWithContext({});
}

async function getStoredPlayerData() {
  const result = await chrome.storage.local.get(['playerData']);
  return result?.playerData || null;
}

function toNumericDtbId(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function resolvePlayerContext(request = {}) {
  if (request.playerData) {
    const provided = {
      ...request.playerData,
      dtbId: toNumericDtbId(request.playerData.dtbId)
    };
    if (provided.dtbId) return provided;
  }

  const stored = await getStoredPlayerData();
  if (!stored) return null;
  return {
    ...stored,
    dtbId: toNumericDtbId(stored.dtbId)
  };
}

async function determineHistoryScrapeMode(playerDtbId) {
  const fallback = {
    mode: 'full_backfill',
    historyState: null,
    latestKnownMatchDate: null
  };

  if (!playerDtbId || !isClientReadyAndAuthed()) {
    return fallback;
  }

  try {
    const historyStateResult = await getClient().getPlayerHistoryState(playerDtbId);
    if (!historyStateResult?.success || !historyStateResult?.data) {
      return fallback;
    }

    const historyState = historyStateResult.data;
    const completed = !!historyState.history_backfill_completed;
    const hasLatestDate = typeof historyState.history_latest_match_date === 'string' && historyState.history_latest_match_date.length > 0;
    return {
      mode: (completed && hasLatestDate) ? 'incremental_update' : 'full_backfill',
      historyState,
      latestKnownMatchDate: historyState.history_latest_match_date || null
    };
  } catch (error) {
    log('Failed to determine history scrape mode, falling back to full backfill', error);
    return fallback;
  }
}

async function handleStartFullHistoryScrapeWithContext(request = {}) {
  let tab = null;
  if (Number.isInteger(request.tabId)) {
    try {
      tab = await chrome.tabs.get(request.tabId);
    } catch (_error) {
      tab = null;
    }
  }
  if (!tab) {
    tab = await getActiveTab();
  }
  if (!tab) {
    return { status: 'Error', message: 'No active tab found to scrape.' };
  }

  const playerContext = await resolvePlayerContext(request);
  const playerDtbId = toNumericDtbId(playerContext?.dtbId);
  if (playerDtbId) {
    const identityResponse = await sendToTabWithRetry(tab.id, { action: 'expGetCurrentPlayerIdentity' }, 6, 250);
    const activeProfileDtbId = toNumericDtbId(identityResponse?.data?.dtbId);
    if (!identityResponse?.success || activeProfileDtbId !== playerDtbId) {
      return {
        status: 'Error',
        message: `Profile DTB-ID mismatch before scrape. Expected ${playerDtbId}, got ${activeProfileDtbId || 'unknown'}.`
      };
    }
  }

  const modeResult = await determineHistoryScrapeMode(playerDtbId);

  state.activeHistorySyncContext = {
    tabId: tab.id,
    playerDtbId,
    mode: modeResult.mode,
    latestKnownMatchDate: modeResult.latestKnownMatchDate,
    requestedAt: Date.now()
  };

  const response = await sendToTab(tab.id, {
    action: 'startFullHistoryScrape',
    mode: modeResult.mode,
    latestKnownMatchDate: modeResult.latestKnownMatchDate
  });

  if (!response || response.status === 'Error') {
    state.activeHistorySyncContext = null;
    return response || { status: 'Error', message: 'No response from content script.' };
  }

  return {
    ...(response || {}),
    mode: modeResult.mode,
    latestKnownMatchDate: modeResult.latestKnownMatchDate
  };
}

async function waitForExpectedPlayerProfile(tabId, expectedDtbId, timeoutMs = 22000, pollMs = 500) {
  const expected = toNumericDtbId(expectedDtbId);
  if (!Number.isInteger(expected)) {
    return { success: false, error: 'Invalid expected DTB-ID', data: null };
  }

  const startedAt = Date.now();
  let lastIdentity = null;

  while ((Date.now() - startedAt) < timeoutMs) {
    const response = await sendToTab(tabId, { action: 'expGetCurrentPlayerIdentity' });
    if (response?.success && response?.data) {
      lastIdentity = response.data;
      const currentDtbId = toNumericDtbId(response.data.dtbId);
      if (response.data.isPlayerProfilePage && response.data.isLoaded && currentDtbId === expected) {
        return { success: true, data: response.data };
      }
    }
    await delay(pollMs);
  }

  const got = toNumericDtbId(lastIdentity?.dtbId);
  const gotText = got ? String(got) : 'unknown';
  return {
    success: false,
    error: `Expected DTB-ID ${expected}, but current profile is ${gotText}.`,
    data: lastIdentity
  };
}

async function handleStartFullSyncWithUpload(request = {}) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first to sync data.' };
  }

  const scrapeResult = await handleStartFullHistoryScrapeWithContext(request);
  if (!scrapeResult || scrapeResult.status === 'Error') {
    return {
      success: false,
      error: scrapeResult?.message || 'Failed to scrape full history.'
    };
  }

  return uploadMatches(scrapeResult.data || []);
}

async function handlePlayerDataScraped(data) {
  if (!data) {
    return { success: false, error: 'No player data provided' };
  }

  const playerData = {
    ...data,
    lastUpdated: Date.now()
  };

  await chrome.storage.local.set({ playerData });
  await broadcast({ action: 'playerDataScraped', data: playerData });
  await uploadPlayerData(playerData);
  return { success: true };
}

async function handleFullMatchHistoryScraped(data, meta = {}, scrapeError = null) {
  const safeData = Array.isArray(data) ? data : [];
  const syncContext = state.activeHistorySyncContext;
  const hasFatalScrapeError = !!(scrapeError || meta?.hadFatalError);

  await chrome.storage.local.set({ fullMatchHistory: safeData });
  await broadcast({
    action: 'fullMatchHistoryScraped',
    data: safeData,
    meta: {
      ...(meta || {}),
      mode: meta?.mode || syncContext?.mode || 'full_backfill'
    }
  });

  if (hasFatalScrapeError) {
    await broadcast({
      action: 'uploadCompleted',
      result: {
        success: false,
        uploaded: 0,
        duplicates: 0,
        errors: safeData.length,
        message: scrapeError || meta?.stoppedReason || 'Scrape failed before upload.'
      }
    });
    state.activeHistorySyncContext = null;
    return { success: false, error: scrapeError || meta?.stoppedReason || 'Scrape failed' };
  }

  let uploadResult = { success: true, uploaded: 0, duplicates: 0, errors: 0 };
  if (safeData.length > 0) {
    uploadResult = await uploadMatches(safeData);
  } else {
    await broadcast({
      action: 'uploadCompleted',
      result: {
        success: true,
        uploaded: 0,
        duplicates: 0,
        errors: 0,
        message: syncContext?.mode === 'incremental_update' ? 'No new matches found.' : 'No matches found.'
      }
    });
  }

  if (isClientReadyAndAuthed() && syncContext?.playerDtbId) {
    await getClient().updatePlayerHistoryAfterSync({
      dtbId: syncContext.playerDtbId,
      mode: syncContext.mode,
      matches: safeData,
      scrapeMeta: meta || {},
      uploadResult
    });
  }

  state.activeHistorySyncContext = null;
  return { success: true, uploadResult };
}

async function handleSaveTournament(payload) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }

  return getClient().saveTournament(payload);
}

async function handleSaveZulassungsliste(payload) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }

  return getClient().saveZulassungslisteData(payload);
}

async function handleSaveClubTeamPortrait(payload) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }

  return getClient().saveClubTeamPortraitData(payload);
}

async function handleSaveClubLeagueTables(payload) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }

  const storedContext = await loadLatestClubLeagueContext();
  const pdfUrlContext = await loadLeaguePdfContextByUrl(payload?.sourceUrl || payload?.source_url || null);
  const mergedPayload = {
    ...(payload || {}),
    federation_code: payload?.federation_code || pdfUrlContext?.federation_code || storedContext?.federation_code || null,
    source_club_id: payload?.source_club_id || pdfUrlContext?.source_club_id || storedContext?.source_club_id || null,
    season_year: payload?.season_year || pdfUrlContext?.season_year || storedContext?.season_year || null,
    season_type: payload?.season_type || pdfUrlContext?.season_type || storedContext?.season_type || null
  };

  const hasGroups = Array.isArray(mergedPayload?.groups) && mergedPayload.groups.length > 0;
  const effectivePdfUrl = mergedPayload?.pdf_url || mergedPayload?.sourceUrl || mergedPayload?.source_url || null;
  const pdfFallbackDebug = {
    attempted: false,
    url: effectivePdfUrl || null,
    fetchOk: null,
    status: null,
    contentType: null,
    bytes: 0,
    parsedGroups: 0,
    parsedTeams: 0,
    parseUsed: false,
    error: null
  };

  if (!hasGroups && effectivePdfUrl && typeof LeagueParsers !== 'undefined' && LeagueParsers.parseLeagueTablesPdfBytes) {
    pdfFallbackDebug.attempted = true;
    try {
      const response = await fetch(effectivePdfUrl, {
        method: 'GET',
        credentials: 'include'
      });
      pdfFallbackDebug.fetchOk = !!response.ok;
      pdfFallbackDebug.status = response.status;
      pdfFallbackDebug.contentType = response.headers?.get?.('content-type') || null;
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        pdfFallbackDebug.bytes = buffer.byteLength || 0;
        const parsedFromBytes = await LeagueParsers.parseLeagueTablesPdfBytes(buffer, {
          federation_code: mergedPayload?.federation_code || null,
          source_club_id: mergedPayload?.source_club_id || null,
          season_year: mergedPayload?.season_year || null,
          season_type: mergedPayload?.season_type || null,
          source_url: effectivePdfUrl
        });

        const parsedGroups = Array.isArray(parsedFromBytes?.groups) ? parsedFromBytes.groups : [];
        const parsedTeamsCount = parsedGroups.reduce(
          (sum, group) => sum + (Array.isArray(group?.teams) ? group.teams.length : 0),
          0
        );
        pdfFallbackDebug.parsedGroups = parsedGroups.length;
        pdfFallbackDebug.parsedTeams = parsedTeamsCount;
        if (parsedGroups.length > 0 && parsedTeamsCount > 0) {
          pdfFallbackDebug.parseUsed = true;
          mergedPayload.groups = parsedFromBytes.groups;
          if (!mergedPayload.pdf_text && parsedFromBytes?.pdf_text) {
            mergedPayload.pdf_text = parsedFromBytes.pdf_text;
            mergedPayload.pdf_text_available = true;
          }
          mergedPayload.federation_code = mergedPayload.federation_code || parsedFromBytes?.federation_code || null;
          mergedPayload.source_club_id = mergedPayload.source_club_id || parsedFromBytes?.source_club_id || null;
          mergedPayload.season_year = mergedPayload.season_year || parsedFromBytes?.season_year || null;
          mergedPayload.season_type = mergedPayload.season_type || parsedFromBytes?.season_type || null;
        }
      }
    } catch (error) {
      pdfFallbackDebug.error = error?.message || String(error);
      log('League tables PDF byte parse fallback failed', error);
    }
  }

  const saveResult = await getClient().saveClubLeagueTablesData(mergedPayload);
  if (!saveResult?.success || saveResult?.stagedOnly) {
    return {
      ...(saveResult || { success: false, error: 'Unknown league tables save error' }),
      debug: {
        ...(saveResult?.debug || {}),
        pdfFallback: pdfFallbackDebug
      }
    };
  }
  return saveResult;
}

async function handleSaveClubCalendar(payload) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }

  return getClient().saveClubCalendarData(payload);
}

async function runExperimentalPlayerHistoryAutomation(request = {}) {
  if (!isClientReadyAndAuthed()) {
    return { success: false, error: 'Please sign in first.' };
  }
  if (state.expPlayerHistoryAutomation.isRunning) {
    return { success: false, error: 'Automation is already running.' };
  }

  const teamPortraitUrl = String(request.teamPortraitUrl || '').trim();
  if (!teamPortraitUrl || !teamPortraitUrl.includes('teamportrait')) {
    return { success: false, error: 'teamPortraitUrl must be a valid teamportrait URL.' };
  }

  const maxPlayers = Number.isInteger(request.maxPlayers) ? request.maxPlayers : 5000;
  const maxAttempts = Number.isInteger(request.maxAttempts) ? request.maxAttempts : 3;
  const delayMinMs = Number.isInteger(request.delayMinMs) ? request.delayMinMs : 1500;
  const delayMaxMs = Number.isInteger(request.delayMaxMs) ? request.delayMaxMs : 3500;
  const batchKey = String(request.batchKey || buildStableBatchKeyForTeamUrl(teamPortraitUrl));
  const teamId = extractTeamPortraitIdFromUrl(teamPortraitUrl);
  const batchLabel = String(request.batchLabel || `Team ${teamId || 'unknown'} Full Playerlist`);
  const workerId = `bg-${Date.now()}`;

  state.expPlayerHistoryAutomation = {
    isRunning: true,
    stopRequested: false,
    runStartedAt: new Date().toISOString(),
    tabId: null,
    batchId: null,
    batchKey,
    teamPortraitUrl,
    processed: 0,
    completed: 0,
    failed: 0,
    lastError: null
  };

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error('No active tab found for automation');
    }
    state.expPlayerHistoryAutomation.tabId = tab.id;

    const navigated = await navigateTabAndWait(tab.id, teamPortraitUrl, 25000);
    if (!navigated) {
      throw new Error('Failed to load team portrait page');
    }

    const rosterResponse = await sendToTabWithRetry(tab.id, {
      action: 'expCollectTeamPlayers',
      maxPlayers,
      maxExpandClicks: 45
    }, 12, 800);

    if (!rosterResponse?.success) {
      throw new Error(rosterResponse?.error || 'Failed to collect team players');
    }

    const players = (rosterResponse.players || [])
      .filter((p) => Number.isInteger(parseInt(p?.dtbId, 10)))
      .slice(0, maxPlayers);
    if (players.length === 0) {
      throw new Error('No players with DTB-ID found on team page');
    }

    const batchResult = await getClient().expEnsurePlayerHistoryBatch({
      batchKey,
      label: batchLabel,
      teamPortraitUrl,
      targetCount: players.length,
      status: 'active'
    });
    if (!batchResult?.success || !batchResult?.data?.id) {
      throw new Error(batchResult?.error || 'Failed to create batch');
    }

    const batchId = batchResult.data.id;
    state.expPlayerHistoryAutomation.batchId = batchId;

    const enqueueResult = await getClient().expUpsertPlayerHistoryJobs({
      batchId,
      players,
      maxAttempts,
      defaultPriority: 100
    });
    if (!enqueueResult?.success) {
      throw new Error(enqueueResult?.error || 'Failed to enqueue jobs');
    }

    await getClient().expRefreshPlayerHistoryBatchCounters(batchId);

    while (!state.expPlayerHistoryAutomation.stopRequested) {
      const claimed = await getClient().expClaimNextPlayerHistoryJob({
        batchId,
        workerId
      });
      if (!claimed?.success) {
        throw new Error(claimed?.error || 'Failed to claim next job');
      }

      const job = claimed.data;
      if (!job?.id) {
        break;
      }

      state.expPlayerHistoryAutomation.processed += 1;
      const dtbId = parseInt(job.dtb_id, 10);
      const perJobDelayMs = randomIntBetween(delayMinMs, delayMaxMs);

      const onJobFailed = async (code, message) => {
        await getClient().expFailPlayerHistoryJob({
          jobId: job.id,
          errorCode: code,
          errorMessage: message,
          retryDelaySeconds: randomIntBetween(60, 180)
        });
        state.expPlayerHistoryAutomation.failed += 1;
        state.expPlayerHistoryAutomation.lastError = `${code}: ${message}`;
      };

      const teamPageReady = await navigateTabAndWait(tab.id, teamPortraitUrl, 25000);
      if (!teamPageReady) {
        await onJobFailed('TEAM_PAGE_NAVIGATION_FAILED', `Could not load ${teamPortraitUrl}`);
        await delay(perJobDelayMs);
        continue;
      }

      const openPlayerResult = await sendToTabWithRetry(tab.id, {
        action: 'expOpenPlayerByDtbId',
        dtbId,
        maxExpandClicks: 45
      }, 12, 700);
      if (!openPlayerResult?.success) {
        await onJobFailed('PLAYER_OPEN_FAILED', openPlayerResult?.error || `Failed to open DTB-ID ${dtbId}`);
        await delay(perJobDelayMs);
        continue;
      }

      const profileReady = await waitForExpectedPlayerProfile(tab.id, dtbId, 22000, 500);
      if (!profileReady?.success) {
        await onJobFailed('PLAYER_PROFILE_MISMATCH', profileReady?.error || `Expected profile DTB-ID ${dtbId}`);
        await delay(perJobDelayMs);
        continue;
      }

      const scrapeResult = await handleStartFullHistoryScrapeWithContext({
        tabId: tab.id,
        playerData: { dtbId }
      });
      if (!scrapeResult || scrapeResult.status === 'Error') {
        await onJobFailed('HISTORY_SCRAPE_FAILED', scrapeResult?.message || `History scrape failed for ${dtbId}`);
        await delay(perJobDelayMs);
        continue;
      }

      const scrapedMatches = Array.isArray(scrapeResult.data) ? scrapeResult.data.length : 0;
      const completeResult = await getClient().expCompletePlayerHistoryJob({
        jobId: job.id,
        syncMode: scrapeResult.mode || null,
        matchesScraped: scrapedMatches,
        meta: {
          latestKnownMatchDate: scrapeResult.latestKnownMatchDate || null,
          scrapeMeta: scrapeResult.meta || null
        }
      });

      if (!completeResult?.success) {
        await onJobFailed('JOB_COMPLETE_UPDATE_FAILED', completeResult?.error || `Failed to complete job ${job.id}`);
      } else {
        state.expPlayerHistoryAutomation.completed += 1;
      }

      await getClient().expRefreshPlayerHistoryBatchCounters(batchId);
      await delay(perJobDelayMs);
    }

    const stopped = state.expPlayerHistoryAutomation.stopRequested;
    await getClient().expRefreshPlayerHistoryBatchCounters(state.expPlayerHistoryAutomation.batchId);
    await getClient().expUpdatePlayerHistoryBatchStatus({
      batchId: state.expPlayerHistoryAutomation.batchId,
      status: stopped ? 'paused' : 'completed',
      lastError: state.expPlayerHistoryAutomation.lastError,
      finished: !stopped
    });

    const summary = {
      stopped,
      batchId: state.expPlayerHistoryAutomation.batchId,
      batchKey: state.expPlayerHistoryAutomation.batchKey,
      processed: state.expPlayerHistoryAutomation.processed,
      completed: state.expPlayerHistoryAutomation.completed,
      failed: state.expPlayerHistoryAutomation.failed
    };

    state.expPlayerHistoryAutomation.isRunning = false;
    state.expPlayerHistoryAutomation.stopRequested = false;
    state.expPlayerHistoryAutomation.tabId = null;
    return { success: true, summary };
  } catch (error) {
    const batchId = state.expPlayerHistoryAutomation.batchId;
    if (batchId) {
      await getClient().expUpdatePlayerHistoryBatchStatus({
        batchId,
        status: 'failed',
        lastError: error?.message || String(error),
        finished: true
      });
      await getClient().expRefreshPlayerHistoryBatchCounters(batchId);
    }

    state.expPlayerHistoryAutomation.lastError = error?.message || String(error);
    state.expPlayerHistoryAutomation.isRunning = false;
    state.expPlayerHistoryAutomation.stopRequested = false;
    state.expPlayerHistoryAutomation.tabId = null;
    return { success: false, error: error?.message || String(error) };
  }
}

async function handleStartExperimentalPlayerHistoryAutomation(request = {}) {
  if (state.expPlayerHistoryAutomation.isRunning) {
    return { success: false, error: 'Automation is already running.' };
  }

  runExperimentalPlayerHistoryAutomation(request).catch((error) => {
    log('Experimental automation crashed unexpectedly', error);
  });
  return { success: true, status: 'started' };
}

async function handleStopExperimentalPlayerHistoryAutomation() {
  if (!state.expPlayerHistoryAutomation.isRunning) {
    return { success: true, status: 'idle' };
  }
  state.expPlayerHistoryAutomation.stopRequested = true;
  return { success: true, status: 'stop_requested' };
}

async function handleGetExperimentalPlayerHistoryAutomationStatus(request = {}) {
  const status = getExpAutomationStatus();
  const teamPortraitUrl = String(request.teamPortraitUrl || status.teamPortraitUrl || '').trim();
  const batchKey = String(request.batchKey || status.batchKey || (teamPortraitUrl ? buildStableBatchKeyForTeamUrl(teamPortraitUrl) : ''));

  if (!isClientReadyAndAuthed() || !batchKey) {
    return { success: true, status, summary: null };
  }

  const summaryResult = await getClient().expGetPlayerHistoryBatchSummary({ batchKey });
  if (!summaryResult?.success) {
    return { success: true, status, summary: null };
  }
  return { success: true, status, summary: summaryResult.data || null };
}

const actionHandlers = {
  signIn: async (request) =>
    handleUserSignIn({
      email: request.email,
      password: request.password,
      supabaseUrl: request.supabaseUrl,
      supabaseKey: request.supabaseKey
    }),

  signOut: async () => handleUserSignOut(),
  logout: async () => handleUserSignOut(),
  checkAuthStatus: async () => handleCheckAuthStatus(),
  getAuthStatus: async () => handleCheckAuthStatus(),

  linkPlayerProfile: async (request) => {
    const client = getClient();
    if (!client) return { success: false, error: 'Client not initialized' };
    const result = await client.linkPlayerProfile(request.playerData);
    if (result.success) {
      await broadcast({ action: 'playerProfileLinked', success: true, data: result.data });
    }
    return result;
  },

  checkPlayerLink: async () => {
    const client = getClient();
    if (!client) return { success: false, hasLink: false, error: 'Client not initialized' };
    return client.checkPlayerLink();
  },

  getLinkedPlayerProfile: async () => {
    const client = getClient();
    if (!client) return { success: false, error: 'Client not initialized' };
    return client.getLinkedPlayerProfile();
  },

  testSupabaseConnection: async () => {
    if (!isClientReadyAndAuthed()) {
      return { success: false, error: 'Supabase client not initialized or not authenticated' };
    }
    return getClient().testConnection();
  },

  startFullHistoryScrape: async (request) => handleStartFullHistoryScrapeWithContext(request || {}),
  startFullSyncWithUpload: async (request) => handleStartFullSyncWithUpload(request || {}),
  uploadMatches: async (request) => uploadMatches(request.data || []),

  playerDataScraped: async (request) => handlePlayerDataScraped(request.data || null),
  fullMatchHistoryScraped: async (request) =>
    handleFullMatchHistoryScraped(request.data || [], request.meta || {}, request.error || null),

  tournamentPageLoaded: async (request) => {
    await broadcast(request);
    return { success: true };
  },

  tournamentLocationData: async (request) => {
    await broadcast(request);
    return { success: true };
  },

  zulassungslisteData: async (request) => {
    await broadcast(request);
    return { success: true };
  },

  clubTeamPortraitData: async (request) => {
    await broadcast(request);
    return { success: true };
  },
  clubLeagueTablesData: async (request) => {
    await persistLatestClubLeagueContext({
      federation_code: request?.federation_code || null,
      source_club_id: request?.source_club_id || null,
      season_year: request?.season_year || null,
      season_type: request?.season_type || null
    });
    await persistLeaguePdfContext(request?.pdf_url || request?.sourceUrl || request?.source_url, {
      federation_code: request?.federation_code || null,
      source_club_id: request?.source_club_id || null,
      season_year: request?.season_year || null,
      season_type: request?.season_type || null
    });
    await broadcast(request);
    return { success: true };
  },
  clubCalendarData: async (request) => {
    await persistLatestClubLeagueContext({
      federation_code: request?.federation_code || null,
      source_club_id: request?.source_club_id || null,
      season_year: request?.season_year || null,
      season_type: request?.season_type || null
    });
    await persistLeaguePdfContext(request?.pdf_url || request?.sourceUrl || request?.source_url, {
      federation_code: request?.federation_code || null,
      source_club_id: request?.source_club_id || null,
      season_year: request?.season_year || null,
      season_type: request?.season_type || null
    });
    await broadcast(request);
    return { success: true };
  },

  saveTournamentData: async (request) => handleSaveTournament(request.tournament),
  saveZulassungslisteData: async (request) =>
    handleSaveZulassungsliste({
      tournamentId: request.tournamentId,
      sourceCategoryId: request.sourceCategoryId,
      sourceCategorySlug: request.sourceCategorySlug,
      sourceStatus: request.sourceStatus,
      categoryName: request.categoryName,
      players: request.players
    }),
  saveClubTeamPortraitData: async (request) => handleSaveClubTeamPortrait(request.payload),
  saveClubLeagueTablesData: async (request) => handleSaveClubLeagueTables(request.payload),
  saveClubCalendarData: async (request) => handleSaveClubCalendar(request.payload),

  expStartPlayerHistoryAutomation: async (request) =>
    handleStartExperimentalPlayerHistoryAutomation(request || {}),
  expStopPlayerHistoryAutomation: async () => handleStopExperimentalPlayerHistoryAutomation(),
  expGetPlayerHistoryAutomationStatus: async (request) =>
    handleGetExperimentalPlayerHistoryAutomationStatus(request || {})
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  log('Installed: side panel click behavior enabled');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    await processPageContext(tabId, tab.url, true);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await processPageContext(details.tabId, details.url, true);
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await processPageContext(details.tabId, details.url, true);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request?.action;
  const handler = actionHandlers[action];

  if (!handler) {
    sendResponse({ success: false, error: `Unknown action: ${action}` });
    return false;
  }

  Promise.resolve(handler(request, sender))
    .then((result) => {
      sendResponse(result === undefined ? { success: true } : result);
    })
    .catch((error) => {
      sendResponse({ success: false, error: error.message });
    });

  return true;
});

(async () => {
  if (typeof SupabaseClient === 'undefined') {
    log('SupabaseClient unavailable in background script');
    return;
  }

  state.supabaseClient = new SupabaseClient();
  await state.supabaseClient.loadSavedSession();

  const tab = await getActiveTab();
  if (tab) {
    await processPageContext(tab.id, tab.url, false);
  }

  const auth = await handleCheckAuthStatus();
  await broadcast({ action: 'authStatusChanged', authenticated: auth.authenticated, user: auth.user });

  log('Background initialized');
})();
