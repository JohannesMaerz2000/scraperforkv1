document.addEventListener('DOMContentLoaded', () => {
  const els = {
    pageStatus: document.getElementById('page-status'),
    authStatus: document.getElementById('auth-status'),
    authButton: document.getElementById('auth-button'),
    clubMeta: document.getElementById('club-meta'),
    portraitSyncStatus: document.getElementById('portrait-sync-status'),
    leagueTablesSyncStatus: document.getElementById('league-tables-sync-status'),
    calendarSyncStatus: document.getElementById('calendar-sync-status'),
    expStartButton: document.getElementById('exp-start-button'),
    expStopButton: document.getElementById('exp-stop-button'),
    expAutomationStatus: document.getElementById('exp-automation-status'),
    expMeta: document.getElementById('exp-meta'),
    expPillCompleted: document.getElementById('exp-pill-completed'),
    expPillFailed: document.getElementById('exp-pill-failed'),
    expPillRunning: document.getElementById('exp-pill-running'),
    expPillUpdated: document.getElementById('exp-pill-updated'),
    expListWrap: document.getElementById('exp-list-wrap'),
    expListTitle: document.getElementById('exp-list-title'),
    expListSubtitle: document.getElementById('exp-list-subtitle'),
    expCompletedList: document.getElementById('exp-completed-list'),

    loginModal: document.getElementById('login-modal'),
    closeModal: document.getElementById('close-modal'),
    loginForm: document.getElementById('login-form'),
    loginStatus: document.getElementById('login-status'),
    emailInput: document.getElementById('email-input'),
    passwordInput: document.getElementById('password-input'),
    loginSubmit: document.getElementById('login-submit')
  };

  const state = {
    isAuthenticated: false,
    currentUser: null,
    latestPortraitPayload: null,
    latestLeagueTablesPayload: null,
    latestCalendarPayload: null,
    expIsRunning: false,
    expStatusPollTimer: null,
    expStatusPollCount: 0,
    expJobsSnapshot: null,
    expLastJobsFetchedAt: null,
    lastPortraitSaveKey: null,
    lastLeagueTablesSaveKey: null,
    lastCalendarSaveKey: null,
    portraitSyncPausedNoticeShown: false
  };

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ success: false, error: lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  function setStatus(target, message, type = 'info') {
    if (!target) return;
    target.textContent = message;
    target.className = `status-item status-${type}`;
    target.style.display = message ? 'block' : 'none';
  }

  function setPageStatus(message) {
    if (!els.pageStatus) return;
    els.pageStatus.textContent = message;
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs?.[0] || null);
      });
    });
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

  async function resolveCurrentTeamPortraitUrl() {
    const tab = await getActiveTab();
    const tabUrl = String(tab?.url || '');
    if (tabUrl.includes('teamportrait')) return tabUrl;
    const payloadUrl = String(state.latestPortraitPayload?.sourceUrl || '');
    if (payloadUrl.includes('teamportrait')) return payloadUrl;
    return '';
  }

  function openLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'block';
    if (els.emailInput) els.emailInput.focus();
  }

  function closeLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'none';
    if (els.loginForm) els.loginForm.reset();
    setStatus(els.loginStatus, '', 'info');
  }

  function updateAuthUI(authenticated, user) {
    state.isAuthenticated = !!authenticated;
    state.currentUser = user || null;

    if (state.isAuthenticated && state.currentUser) {
      els.authStatus.textContent = `Logged in: ${state.currentUser.email}`;
      els.authButton.textContent = 'Logout';
      return;
    }

    els.authStatus.textContent = 'Not logged in';
    els.authButton.textContent = 'Login';
  }

  function renderClubMeta() {
    const portrait = state.latestPortraitPayload;
    const leagueTables = state.latestLeagueTablesPayload;
    const calendar = state.latestCalendarPayload;
    const source = portrait || calendar || leagueTables;
    if (!source) {
      els.clubMeta.textContent = 'Open a team portrait or Vereinsspielplan page.';
      return;
    }

    const clubName = source.club?.name || source.club?.display || '-';
    const clubId = source.club?.sourceClubId || '-';
    const routeType = source.route?.pageType || '-';
    const seasonType = source.season?.season_type || '-';
    const seasonYear = source.season?.season_year || '-';

    let details = `Club: ${clubName} (${clubId})\nMode: ${routeType}\nSeason: ${seasonType} ${seasonYear}`;
    if (portrait?.players) {
      details += `\nTeam players: ${portrait.players.length}`;
    }
    if (leagueTables?.groups) {
      details += `\nLeague groups: ${leagueTables.groups.length}`;
    }
    if (calendar?.fixtures) {
      details += `\nCalendar fixtures: ${calendar.fixtures.length}`;
    }

    els.clubMeta.textContent = details;
  }

  async function savePortrait(payload) {
    if (state.expIsRunning) {
      if (!state.portraitSyncPausedNoticeShown) {
        setStatus(els.portraitSyncStatus, 'Team portrait auto-sync paused during player-history automation.', 'info');
        state.portraitSyncPausedNoticeShown = true;
      }
      return;
    }

    state.portraitSyncPausedNoticeShown = false;

    if (!state.isAuthenticated || !payload) {
      if (!state.isAuthenticated) {
        setStatus(els.portraitSyncStatus, 'Login required to sync team portrait.', 'info');
      }
      return;
    }

    const saveKey = JSON.stringify({
      route: payload.route,
      club: payload.club,
      season: payload.season,
      team: payload.team,
      players: payload.players
    });

    if (saveKey === state.lastPortraitSaveKey) return;

    setStatus(els.portraitSyncStatus, 'Syncing team portrait...', 'info');
    const response = await sendRuntimeMessage({ action: 'saveClubTeamPortraitData', payload });

    if (response?.success) {
      state.lastPortraitSaveKey = saveKey;
      setStatus(
        els.portraitSyncStatus,
        `Team portrait synced (${response.rankingsSaved ?? payload.players?.length ?? 0} players).`,
        'success'
      );
      return;
    }

    setStatus(els.portraitSyncStatus, `Team portrait sync failed: ${response?.error || 'Unknown error'}`, 'error');
  }

  async function saveLeagueTables(payload) {
    if (!state.isAuthenticated || !payload) {
      if (!state.isAuthenticated) {
        setStatus(els.leagueTablesSyncStatus, 'Login required to sync league tables.', 'info');
      }
      return;
    }

    const saveKey = JSON.stringify({
      sourceUrl: payload.sourceUrl,
      federation: payload.federation_code,
      sourceClubId: payload.source_club_id,
      seasonYear: payload.season_year,
      seasonType: payload.season_type,
      groups: payload.groups
    });
    if (saveKey === state.lastLeagueTablesSaveKey) return;

    setStatus(els.leagueTablesSyncStatus, 'Syncing league tables...', 'info');
    const response = await sendRuntimeMessage({ action: 'saveClubLeagueTablesData', payload });

    if (response?.success) {
      state.lastLeagueTablesSaveKey = saveKey;
      if (response?.stagedOnly) {
        const debugSuffix = response?.debug
          ? ` [debug: ${JSON.stringify(response.debug)}]`
          : '';
        setStatus(
          els.leagueTablesSyncStatus,
          `League tables received, staged for follow-up (${response.warning || 'missing parse metadata'}).${debugSuffix}`,
          'info'
        );
        return;
      }
      setStatus(
        els.leagueTablesSyncStatus,
        `League tables synced (${response.groupsSaved ?? payload.groups?.length ?? 0} groups).`,
        'success'
      );
      return;
    }

    const debugSuffix = response?.debug
      ? ` [debug: ${JSON.stringify(response.debug)}]`
      : '';
    setStatus(els.leagueTablesSyncStatus, `League tables sync failed: ${response?.error || 'Unknown error'}${debugSuffix}`, 'error');
  }

  async function saveCalendar(payload) {
    if (!state.isAuthenticated || !payload) {
      if (!state.isAuthenticated) {
        setStatus(els.calendarSyncStatus, 'Login required to sync calendar fixtures.', 'info');
      }
      return;
    }

    const saveKey = JSON.stringify({
      sourceUrl: payload.sourceUrl,
      federation: payload.federation_code,
      sourceClubId: payload.source_club_id,
      seasonYear: payload.season_year,
      seasonType: payload.season_type,
      fixtures: payload.fixtures
    });
    if (saveKey === state.lastCalendarSaveKey) return;

    setStatus(els.calendarSyncStatus, 'Syncing calendar fixtures...', 'info');
    const response = await sendRuntimeMessage({ action: 'saveClubCalendarData', payload });

    if (response?.success) {
      state.lastCalendarSaveKey = saveKey;
      const debugSuffix = response?.debugSummary
        ? ` [debug: ${response.debugSummary}]`
        : response?.debug
          ? ` [debug: ${JSON.stringify(response.debug)}]`
          : '';
      const savedCount = response.fixturesSaved ?? payload.fixtures?.length ?? 0;
      setStatus(
        els.calendarSyncStatus,
        `Calendar synced (${savedCount} fixtures).${debugSuffix}`,
        savedCount === 0 ? 'info' : 'success'
      );
      return;
    }

    const debugSuffix = response?.debugSummary
      ? ` [debug: ${response.debugSummary}]`
      : response?.debug
        ? ` [debug: ${JSON.stringify(response.debug)}]`
        : '';
    setStatus(els.calendarSyncStatus, `Calendar sync failed: ${response?.error || 'Unknown error'}${debugSuffix}`, 'error');
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();

    const email = els.emailInput?.value?.trim();
    const password = els.passwordInput?.value?.trim();
    if (!email || !password) {
      setStatus(els.loginStatus, 'Please enter both email and password.', 'error');
      return;
    }

    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Signing in...';

    const response = await sendRuntimeMessage({
      action: 'signIn',
      email,
      password,
      supabaseUrl: CONFIG.SUPABASE_URL,
      supabaseKey: CONFIG.SUPABASE_ANON_KEY
    });

    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = 'Sign In';

    if (response?.success) {
      updateAuthUI(true, response.user);
      closeLoginModal();
      await savePortrait(state.latestPortraitPayload);
      await saveLeagueTables(state.latestLeagueTablesPayload);
      await saveCalendar(state.latestCalendarPayload);
      return;
    }

    setStatus(els.loginStatus, `Sign in failed: ${response?.error || 'Unknown error'}`, 'error');
  }

  async function handleAuthClick() {
    if (state.isAuthenticated) {
      const response = await sendRuntimeMessage({ action: 'logout' });
      if (!response?.success) {
        setStatus(els.portraitSyncStatus, `Logout failed: ${response?.error || 'Unknown error'}`, 'error');
        return;
      }
      updateAuthUI(false, null);
      return;
    }

    openLoginModal();
  }

  function formatExpStatusText(status, summary) {
    if (!status) return 'No status available.';
    const total = Number.isInteger(summary?.seed_count) ? summary.seed_count : null;
    const done = Number.isInteger(summary?.completed_count) ? summary.completed_count : null;
    const failed = Number.isInteger(summary?.failed_count) ? summary.failed_count : null;

    const progressText = (done !== null && total !== null)
      ? `${done}/${total} completed`
      : `processed ${status.processed || 0}`;
    const failedText = failed !== null ? `, failed ${failed}` : `, failed ${status.failed || 0}`;

    if (!status.isRunning) {
      const suffix = status.lastError ? ` Last error: ${status.lastError}` : '';
      return `Idle. ${progressText}${failedText}.${suffix}`;
    }
    return `Running batch ${status.batchKey || '-'}: ${progressText}${failedText}.`;
  }

  function formatTimeForUi(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderExpJobs(summary, jobs) {
    const total = Number.isInteger(summary?.seed_count) ? summary.seed_count : 0;
    const completed = Number.isInteger(summary?.completed_count) ? summary.completed_count : 0;
    const failed = Number.isInteger(summary?.failed_count) ? summary.failed_count : 0;
    const runningJob = jobs?.running || null;
    const completedJobs = Array.isArray(jobs?.completed) ? jobs.completed : [];
    const hasAnyData = total > 0 || completedJobs.length > 0 || !!runningJob;

    if (els.expMeta) els.expMeta.style.display = hasAnyData ? 'grid' : 'none';
    if (els.expListWrap) els.expListWrap.style.display = hasAnyData ? 'block' : 'none';
    if (!hasAnyData) return;

    if (els.expPillCompleted) {
      els.expPillCompleted.textContent = `${completed}/${total || '-'}`;
    }
    if (els.expPillFailed) {
      els.expPillFailed.textContent = String(failed);
    }
    if (els.expPillRunning) {
      if (runningJob?.dtb_id) {
        const name = runningJob.player_name || `DTB ${runningJob.dtb_id}`;
        els.expPillRunning.textContent = `${name}`;
      } else {
        els.expPillRunning.textContent = '-';
      }
    }
    if (els.expPillUpdated) {
      els.expPillUpdated.textContent = formatTimeForUi(state.expLastJobsFetchedAt);
    }

    if (els.expListTitle) {
      els.expListTitle.textContent = 'Recently Scraped Players';
    }
    if (els.expListSubtitle) {
      els.expListSubtitle.textContent = `${completedJobs.length} shown`;
    }

    if (!els.expCompletedList) return;
    if (completedJobs.length === 0) {
      els.expCompletedList.innerHTML = '<div class="exp-empty">No completed players yet.</div>';
      return;
    }

    els.expCompletedList.innerHTML = completedJobs.map((job) => {
      const rank = Number.isInteger(job?.source_rank) ? `#${job.source_rank}` : '#-';
      const name = job?.player_name ? escapeHtml(job.player_name) : `DTB ${job?.dtb_id || '-'}`;
      const dtbText = job?.dtb_id ? `DTB ${job.dtb_id}` : 'DTB -';
      const matches = Number.isInteger(job?.matches_scraped) ? job.matches_scraped : 0;
      const finished = formatTimeForUi(job?.last_finished_at);
      return `
        <div class="exp-row">
          <div class="exp-row-main">
            <span>${rank} ${name}</span>
            <span>${matches} matches</span>
          </div>
          <div class="exp-row-sub">${dtbText} • finished ${finished}</div>
        </div>
      `;
    }).join('');
  }

  async function refreshExpStatus() {
    const teamPortraitUrl = await resolveCurrentTeamPortraitUrl();
    const shouldFetchJobs = state.expStatusPollCount === 0 || (state.expStatusPollCount % 3 === 0);
    const response = await sendRuntimeMessage({
      action: 'expGetPlayerHistoryAutomationStatus',
      teamPortraitUrl,
      includeJobs: shouldFetchJobs,
      jobsLimit: 60
    });
    if (!response?.success) {
      setStatus(els.expAutomationStatus, `Status error: ${response?.error || 'Unknown error'}`, 'error');
      return;
    }
    const status = response.status || {};
    state.expIsRunning = !!status.isRunning;
    if (!state.expIsRunning && state.portraitSyncPausedNoticeShown) {
      state.portraitSyncPausedNoticeShown = false;
      if (state.latestPortraitPayload) {
        await savePortrait(state.latestPortraitPayload);
      }
    }
    const summary = response.summary || null;
    if (response.jobs) {
      state.expJobsSnapshot = response.jobs;
      state.expLastJobsFetchedAt = new Date().toISOString();
    }
    const type = status.isRunning ? 'info' : (status.lastError ? 'error' : 'success');
    setStatus(els.expAutomationStatus, formatExpStatusText(status, summary), type);
    renderExpJobs(summary, state.expJobsSnapshot);
    if (els.expStartButton) els.expStartButton.disabled = !!status.isRunning;
    if (els.expStopButton) els.expStopButton.disabled = !status.isRunning;
    state.expStatusPollCount += 1;
  }

  function startExpStatusPolling() {
    if (state.expStatusPollTimer) clearInterval(state.expStatusPollTimer);
    state.expStatusPollTimer = setInterval(() => {
      refreshExpStatus();
    }, 3000);
  }

  async function handleExpStart() {
    if (!state.isAuthenticated) {
      setStatus(els.expAutomationStatus, 'Login required for automation.', 'info');
      return;
    }

    const teamPortraitUrl = await resolveCurrentTeamPortraitUrl();
    if (!teamPortraitUrl.includes('teamportrait')) {
      setStatus(els.expAutomationStatus, 'Open a teamportrait page first.', 'error');
      return;
    }
    const teamId = extractTeamPortraitIdFromUrl(teamPortraitUrl);
    const batchKey = teamId ? `exp_team_${teamId}_full_playerlist` : undefined;

    const response = await sendRuntimeMessage({
      action: 'expStartPlayerHistoryAutomation',
      teamPortraitUrl,
      batchKey,
      batchLabel: `Team ${teamId || 'unknown'} Full Playerlist`,
      maxPlayers: 5000,
      maxAttempts: 3,
      delayMinMs: 1500,
      delayMaxMs: 3500
    });

    if (!response?.success) {
      setStatus(els.expAutomationStatus, `Start failed: ${response?.error || 'Unknown error'}`, 'error');
      return;
    }

    setStatus(els.expAutomationStatus, 'Automation started.', 'success');
    await refreshExpStatus();
  }

  async function handleExpStop() {
    const response = await sendRuntimeMessage({ action: 'expStopPlayerHistoryAutomation' });
    if (!response?.success) {
      setStatus(els.expAutomationStatus, `Stop failed: ${response?.error || 'Unknown error'}`, 'error');
      return;
    }
    setStatus(els.expAutomationStatus, 'Stop requested.', 'info');
    await refreshExpStatus();
  }

  async function onRuntimeMessage(message) {
    switch (message.action) {
      case 'authStatusChanged':
      case 'userSignedIn':
        updateAuthUI(!!message.authenticated || !!message.success, message.user || null);
        break;
      case 'userSignedOut':
        updateAuthUI(false, null);
        break;
      case 'clubTeamPortraitData':
        state.latestPortraitPayload = message;
        renderClubMeta();
        setPageStatus('Team portrait detected');
        await savePortrait(message);
        break;
      case 'clubLeagueTablesData':
        state.latestLeagueTablesPayload = message;
        renderClubMeta();
        setPageStatus('League tables context detected');
        await saveLeagueTables(message);
        break;
      case 'clubCalendarData':
        state.latestCalendarPayload = message;
        renderClubMeta();
        setPageStatus('Club calendar fixtures detected');
        await saveCalendar(message);
        break;
      case 'urlUpdated':
        if (!message.isClubPage) {
          setPageStatus('Searching for club pages...');
        }
        break;
      default:
        break;
    }
  }

  async function initialize() {
    setPageStatus('Searching for club pages...');

    els.authButton?.addEventListener('click', handleAuthClick);
    els.closeModal?.addEventListener('click', closeLoginModal);
    els.loginModal?.addEventListener('click', (event) => {
      if (event.target === els.loginModal) closeLoginModal();
    });
    els.loginForm?.addEventListener('submit', handleLoginSubmit);
    els.expStartButton?.addEventListener('click', handleExpStart);
    els.expStopButton?.addEventListener('click', handleExpStop);

    chrome.runtime.onMessage.addListener((message) => {
      onRuntimeMessage(message);
    });

    const auth = await sendRuntimeMessage({ action: 'getAuthStatus' });
    if (auth?.success) {
      updateAuthUI(!!auth.authenticated, auth.user || null);
    } else {
      updateAuthUI(false, null);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      const isSupportedClubTab = !!tab?.url && (
        tab.url.includes('mannschaftssuche')
        || tab.url.includes('vereinsspielplan')
        || tab.url.includes('nuLigaDokumentTENDE.woa/wa/nuDokument')
      );
      if (!tab?.id || !isSupportedClubTab) return;
      chrome.tabs.sendMessage(tab.id, { action: 'initializeClubView' }).catch(() => {
        // content script may still be loading
      });
    });

    startExpStatusPolling();
    await refreshExpStatus();
  }

  initialize();
});
