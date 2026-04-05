document.addEventListener('DOMContentLoaded', () => {
  const PANEL_DEBUG = (() => {
    try {
      return localStorage.getItem('tennisTournamentDebug') === '1';
    } catch (_error) {
      return false;
    }
  })();
  function debugLog(...args) {
    if (!PANEL_DEBUG) return;
    console.log('[tournament-sidepanel]', ...args);
  }
  debugLog('Debug mode enabled');

  const els = {
    pageStatus: document.getElementById('page-status'),
    authStatus: document.getElementById('auth-status'),
    authButton: document.getElementById('auth-button'),

    loginModal: document.getElementById('login-modal'),
    closeModal: document.getElementById('close-modal'),
    loginForm: document.getElementById('login-form'),
    loginStatus: document.getElementById('login-status'),
    emailInput: document.getElementById('email-input'),
    passwordInput: document.getElementById('password-input'),
    loginSubmit: document.getElementById('login-submit'),

    tournamentInfoPanel: document.getElementById('tournament-info-panel'),
    tournamentName: document.getElementById('tournament-name'),
    tournamentLocation: document.getElementById('tournament-location'),
    googleMapsButton: document.getElementById('google-maps-button'),

    tournamentSyncStatus: document.getElementById('tournament-sync-status'),
    zulassungslisteSyncStatus: document.getElementById('zulassungsliste-sync-status')
  };

  const state = {
    isAuthenticated: false,
    currentUser: null,
    currentTournamentId: null,
    currentTournament: null,
    lastTournamentSaveKey: null,
    isTournamentSaveInFlight: false,
    lastZlistSaveByCategory: new Map()
  };

  function sendRuntimeMessage(message) {
    debugLog('sendRuntimeMessage', message?.action, message);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          debugLog('sendRuntimeMessage lastError', message?.action, lastError.message);
          resolve({ success: false, error: lastError.message });
          return;
        }
        debugLog('sendRuntimeMessage response', message?.action, response);
        resolve(response);
      });
    });
  }

  function updatePageStatus(message, type = 'search') {
    if (!els.pageStatus) return;
    els.pageStatus.textContent = message;
    els.pageStatus.className = `page-status status-${type}`;
  }

  function showStatusMessage(element, message, type = 'info') {
    if (!element) return;
    element.style.display = 'block';
    element.textContent = message;
    element.className = `status-item status-${type}`;
  }

  function hideStatusMessage(element) {
    if (!element) return;
    element.style.display = 'none';
    element.textContent = '';
  }

  function updateAuthUI(authenticated, user) {
    state.isAuthenticated = !!authenticated;
    state.currentUser = user || null;

    if (state.isAuthenticated && state.currentUser) {
      els.authStatus.textContent = `Logged in as: ${state.currentUser.email}`;
      els.authStatus.style.color = '#22543d';
      els.authButton.textContent = 'Logout';
      return;
    }

    els.authStatus.textContent = 'Not logged in';
    els.authStatus.style.color = '#666';
    els.authButton.textContent = 'Login';
  }

  function openLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'block';
    if (els.emailInput) els.emailInput.focus();
  }

  function closeLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'none';
    if (els.loginForm) els.loginForm.reset();
    if (els.loginStatus) {
      els.loginStatus.textContent = '';
      els.loginStatus.className = 'status-message';
    }
  }

  function showLoginStatus(message, type) {
    if (!els.loginStatus) return;
    els.loginStatus.textContent = message;
    els.loginStatus.className = `status-message ${type ? `status-${type}` : ''}`;
  }

  function buildTournamentPayload(message) {
    return {
      id: message.tournamentId,
      name: message.tournamentName || '',
      url: message.url,
      startDate: message.startDate,
      endDate: message.endDate,
      registrationDeadline: message.registrationDeadline,
      location: message.location || null,
      googleMapsLink: message.googleMapsLink || null,
      isDtbTournament: !!message.isDtbTournament,
      isLkTournament: !!message.isLkTournament
    };
  }

  function hasStableTournamentName(name) {
    const value = (name || '').trim().toLowerCase();
    if (!value) return false;
    if (value === 'unnamed tournament') return false;
    if (value === 'unknown tournament') return false;
    if (value === 'turniersuche') return false;
    if (value.startsWith('zulassungsliste')) return false;
    return true;
  }

  function buildTournamentSaveKey(tournament) {
    const address =
      tournament?.location?.fullAddress ||
      [tournament?.location?.street, tournament?.location?.zipAndCity].filter(Boolean).join(', ');

    return JSON.stringify({
      id: tournament?.id || null,
      name: (tournament?.name || '').trim(),
      startDate: tournament?.startDate || null,
      endDate: tournament?.endDate || null,
      registrationDeadline: tournament?.registrationDeadline || null,
      address: address || null,
      googleMapsLink: tournament?.googleMapsLink || null,
      isDtbTournament: !!tournament?.isDtbTournament,
      isLkTournament: !!tournament?.isLkTournament
    });
  }

  function renderTournament(tournament) {
    state.currentTournament = tournament;
    state.currentTournamentId = tournament?.id || null;

    if (!tournament || !tournament.id) {
      els.tournamentInfoPanel.style.display = 'none';
      return;
    }

    els.tournamentInfoPanel.style.display = 'block';
    els.tournamentName.textContent = tournament.name || 'Unnamed Tournament';
    els.tournamentLocation.textContent =
      tournament.location?.fullAddress ||
      [tournament.location?.street, tournament.location?.zipAndCity].filter(Boolean).join(', ') ||
      '-';

    if (tournament.googleMapsLink) {
      els.googleMapsButton.disabled = false;
      els.googleMapsButton.dataset.href = tournament.googleMapsLink;
    } else {
      els.googleMapsButton.disabled = true;
      delete els.googleMapsButton.dataset.href;
    }
  }

  async function saveTournament(tournament) {
    if (!tournament?.id) {
      debugLog('saveTournament skipped: missing tournament id', tournament);
      return;
    }

    if (!hasStableTournamentName(tournament.name)) {
      debugLog('saveTournament skipped: unstable tournament name', {
        tournamentId: tournament.id,
        name: tournament.name
      });
      showStatusMessage(els.tournamentSyncStatus, 'Waiting for tournament data to fully load...', 'info');
      return;
    }

    if (!state.isAuthenticated) {
      debugLog('saveTournament skipped: not authenticated', {
        tournamentId: tournament.id,
        name: tournament.name
      });
      showStatusMessage(els.tournamentSyncStatus, 'Login required to sync tournament', 'info');
      return;
    }

    const saveKey = buildTournamentSaveKey(tournament);
    if (state.lastTournamentSaveKey === saveKey) {
      debugLog('saveTournament skipped: no meaningful changes', {
        tournamentId: tournament.id,
        name: tournament.name
      });
      return;
    }

    if (state.isTournamentSaveInFlight) {
      debugLog('saveTournament skipped: upload in flight', {
        tournamentId: tournament.id,
        name: tournament.name
      });
      return;
    }

    state.isTournamentSaveInFlight = true;
    try {
      debugLog('saveTournament upload start', {
        tournamentId: tournament.id,
        name: tournament.name
      });
      const response = await sendRuntimeMessage({
        action: 'saveTournamentData',
        tournament
      });

      if (response?.success) {
        state.lastTournamentSaveKey = saveKey;
        debugLog('saveTournament upload success', {
          tournamentId: tournament.id,
          name: tournament.name
        });
        showStatusMessage(els.tournamentSyncStatus, 'Tournament synced', 'success');
        return;
      }

      debugLog('saveTournament upload failure', {
        tournamentId: tournament.id,
        name: tournament.name,
        error: response?.error || 'Unknown error'
      });
      showStatusMessage(
        els.tournamentSyncStatus,
        `Tournament sync failed: ${response?.error || 'Unknown error'}`,
        'error'
      );
    } finally {
      state.isTournamentSaveInFlight = false;
    }
  }

  async function saveZulassungsliste({
    tournamentId,
    sourceCategoryId,
    sourceCategorySlug,
    sourceStatus,
    categoryName,
    players
  }) {
    if (!tournamentId || !sourceCategoryId || !categoryName || !Array.isArray(players)) return;

    if (!state.isAuthenticated) {
      debugLog('saveZulassungsliste skipped: not authenticated', {
        tournamentId,
        sourceCategoryId,
        categoryName
      });
      showStatusMessage(els.zulassungslisteSyncStatus, 'Login required to sync Zulassungsliste', 'info');
      return;
    }

    const validPlayers = players.filter((player) => {
      if (!player || !player.name || !player.name.trim() || player.name.trim() === '-') {
        return false;
      }
      if (player.isPlaceholder) {
        return false;
      }
      return true;
    });
    if (validPlayers.length === 0) {
      debugLog('saveZulassungsliste skipped: no valid players', {
        tournamentId,
        sourceCategoryId,
        categoryName,
        receivedPlayers: players.length
      });
      showStatusMessage(els.zulassungslisteSyncStatus, 'No valid players to sync', 'info');
      return;
    }

    const signatureParts = validPlayers
      .map((player) => `${player.dtbId || ''}|${player.name || ''}|${player.club || ''}|${player.registrationStatus || ''}|${player.position || ''}`)
      .sort();
    const dedupeBucket = `${tournamentId}|${sourceCategoryId}`;
    const dedupeKey = `${dedupeBucket}|${categoryName}|${validPlayers.length}|${signatureParts.join('||')}`;
    const lastRun = state.lastZlistSaveByCategory.get(dedupeBucket) || { key: null, at: 0 };
    if (lastRun.key === dedupeKey && Date.now() - lastRun.at < 2500) {
      debugLog('saveZulassungsliste skipped: deduped short-window replay', {
        tournamentId,
        sourceCategoryId,
        categoryName,
        validPlayers: validPlayers.length
      });
      return;
    }

    state.lastZlistSaveByCategory.set(dedupeBucket, {
      key: dedupeKey,
      at: Date.now()
    });

    showStatusMessage(
      els.zulassungslisteSyncStatus,
      `Syncing Zulassungsliste: ${categoryName} (${validPlayers.length})...`,
      'info'
    );

    const response = await sendRuntimeMessage({
      action: 'saveZulassungslisteData',
      tournamentId,
      sourceCategoryId,
      sourceCategorySlug,
      sourceStatus,
      categoryName,
      players: validPlayers
    });
    debugLog('saveZulassungsliste result', {
      tournamentId,
      sourceCategoryId,
      sourceCategorySlug,
      sourceStatus,
      categoryName,
      validPlayers: validPlayers.length,
      response
    });

    if (response?.success) {
      showStatusMessage(
        els.zulassungslisteSyncStatus,
        `Zulassungsliste synced: ${categoryName} (${response.count ?? validPlayers.length})`,
        'success'
      );
      return;
    }

    showStatusMessage(
      els.zulassungslisteSyncStatus,
      `Zulassungsliste sync failed: ${response?.error || 'Unknown error'}`,
      'error'
    );
  }

  function mergeLocation(tournament, incomingLocation) {
    if (!tournament) return tournament;
    if (!incomingLocation) return tournament;

    const location = {
      tournamentName: incomingLocation.tournamentName || tournament.name || 'Unnamed Tournament',
      clubName: incomingLocation.clubName || '',
      street: incomingLocation.street || '',
      zipAndCity: incomingLocation.zipAndCity || '',
      fullAddress: incomingLocation.fullAddress || ''
    };

    if (!location.fullAddress) {
      location.fullAddress = [location.street, location.zipAndCity].filter(Boolean).join(', ');
    }

    return {
      ...tournament,
      location
    };
  }

  async function handleTournamentPageLoaded(message) {
    debugLog('handleTournamentPageLoaded', message);
    if (!message.isDetailPage) {
      updatePageStatus('Searching for tournaments...', 'search');
      renderTournament(null);
      hideStatusMessage(els.tournamentSyncStatus);
      hideStatusMessage(els.zulassungslisteSyncStatus);
      return;
    }

    const tournament = buildTournamentPayload(message);
    debugLog('handleTournamentPageLoaded tournament payload', tournament);
    renderTournament(tournament);
    updatePageStatus('Tournament detected', 'tournament-detected');
    await saveTournament(tournament);
  }

  async function handleTournamentLocationData(message) {
    debugLog('handleTournamentLocationData', message);
    const tournamentId = message.tournamentId;
    if (!tournamentId || !state.currentTournament) return;
    if (String(tournamentId) !== String(state.currentTournament.id)) return;

    const merged = mergeLocation(state.currentTournament, message.location);
    debugLog('handleTournamentLocationData merged tournament', merged);
    renderTournament(merged);
    await saveTournament(merged);
  }

  async function handleZulassungslisteData(message) {
    debugLog('handleZulassungslisteData', message);
    debugLog('handleZulassungslisteData summary', {
      tournamentId: message.tournamentId,
      sourceCategoryId: message.sourceCategoryId,
      sourceCategorySlug: message.sourceCategorySlug,
      sourceStatus: message.sourceStatus,
      categoryName: message.categoryName,
      players: Array.isArray(message.players) ? message.players.length : 0,
      route: message.route,
      diagnostics: message.diagnostics
    });
    await saveZulassungsliste({
      tournamentId: message.tournamentId || state.currentTournamentId,
      sourceCategoryId: message.sourceCategoryId || message.route?.categoryId || null,
      sourceCategorySlug: message.sourceCategorySlug || message.route?.categorySlug || null,
      sourceStatus: message.sourceStatus || message.route?.status || null,
      categoryName: message.categoryName,
      players: message.players || []
    });
  }

  async function onRuntimeMessage(message) {
    debugLog('onRuntimeMessage', message?.action, message);
    switch (message.action) {
      case 'tournamentPageLoaded':
        await handleTournamentPageLoaded(message);
        break;

      case 'tournamentLocationData':
        await handleTournamentLocationData(message);
        break;

      case 'zulassungslisteData':
        await handleZulassungslisteData(message);
        break;

      case 'authStatusChanged':
      case 'userSignedIn':
        updateAuthUI(!!message.authenticated || !!message.success, message.user || null);
        break;

      case 'userSignedOut':
        updateAuthUI(false, null);
        break;

      case 'urlUpdated':
        if (!message.isTournamentPage) {
          updatePageStatus('Searching for tournaments...', 'search');
          renderTournament(null);
        }
        break;

      default:
        break;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();

    const email = els.emailInput?.value?.trim();
    const password = els.passwordInput?.value?.trim();

    if (!email || !password) {
      showLoginStatus('Please enter both email and password', 'error');
      return;
    }

    showLoginStatus('Signing in...', 'info');
    if (els.loginSubmit) {
      els.loginSubmit.disabled = true;
      els.loginSubmit.textContent = 'Signing in...';
    }

    const response = await sendRuntimeMessage({
      action: 'signIn',
      email,
      password,
      supabaseUrl: CONFIG.SUPABASE_URL,
      supabaseKey: CONFIG.SUPABASE_ANON_KEY
    });

    if (els.loginSubmit) {
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = 'Sign In';
    }

    if (response?.success) {
      updateAuthUI(true, response.user);
      closeLoginModal();

      if (state.currentTournament) {
        await saveTournament(state.currentTournament);
      }
      return;
    }

    showLoginStatus(`Sign in failed: ${response?.error || 'Unknown error'}`, 'error');
  }

  async function handleAuthClick() {
    if (state.isAuthenticated) {
      const response = await sendRuntimeMessage({ action: 'logout' });
      if (!response?.success) {
        showStatusMessage(els.tournamentSyncStatus, `Logout failed: ${response?.error || 'Unknown error'}`, 'error');
        return;
      }
      updateAuthUI(false, null);
      return;
    }

    openLoginModal();
  }

  function openGoogleMaps() {
    const href = els.googleMapsButton?.dataset?.href;
    if (!href) return;
    window.open(href, '_blank');
  }

  async function initialize() {
    updatePageStatus('Searching for tournaments...', 'search');

    els.authButton?.addEventListener('click', handleAuthClick);
    els.closeModal?.addEventListener('click', closeLoginModal);
    els.loginModal?.addEventListener('click', (event) => {
      if (event.target === els.loginModal) {
        closeLoginModal();
      }
    });
    els.loginForm?.addEventListener('submit', handleLogin);
    els.googleMapsButton?.addEventListener('click', openGoogleMaps);

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
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('tennis.de') && tab.url.includes('turniersuche')) {
        chrome.tabs.sendMessage(tab.id, { action: 'initializeTournamentView' }).catch(() => {
          // No content script on this exact view yet.
        });
      }
    });
  }

  initialize();
});
