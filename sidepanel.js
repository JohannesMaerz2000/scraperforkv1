document.addEventListener('DOMContentLoaded', () => {
  const els = {
    loginButton: document.getElementById('login-button'),
    logoutButton: document.getElementById('logout-button'),
    authStatus: document.getElementById('auth-status'),
    loginModal: document.getElementById('login-modal'),
    closeModal: document.getElementById('close-modal'),
    loginForm: document.getElementById('login-form'),
    loginStatus: document.getElementById('login-status'),
    emailInput: document.getElementById('email-input'),
    passwordInput: document.getElementById('password-input'),
    loginSubmit: document.getElementById('login-submit'),

    fullHistorySyncButton: document.getElementById('full-history-sync-button'),
    statusMessage: document.getElementById('status-message'),
    resultsContainer: document.getElementById('results-container'),
    pageStatus: document.getElementById('page-status'),

    profileLinkingSection: document.getElementById('profile-linking-section'),
    linkProfileButton: document.getElementById('link-profile-button'),
    linkingStatus: document.getElementById('linking-status'),
    linkConfirmation: document.getElementById('link-confirmation'),
    linkSuccess: document.getElementById('link-success'),
    confirmLinkButton: document.getElementById('confirm-link-button'),
    cancelLinkButton: document.getElementById('cancel-link-button'),
    linkPlayerName: document.getElementById('link-player-name'),
    linkDtbId: document.getElementById('link-dtb-id'),
    linkedDtbId: document.getElementById('linked-dtb-id'),
    linkGuidance: document.getElementById('link-guidance'),

    playerName: document.getElementById('player-name'),
    playerClub: document.getElementById('player-club'),
    playerLK: document.getElementById('player-lk'),
    playerNationality: document.getElementById('player-nationality')
  };

  const state = {
    currentPlayerUrl: null,
    isPlayerLoaded: false,
    isAuthenticated: false,
    isUploading: false,
    currentUser: null,
    isOwnerProfile: false,
    hasLinkedProfile: false,
    userLinkedDtbId: null,
    linkedPlayerData: null,
    pendingLinkData: null
  };

  function isPlayerProfileUrl(url) {
    if (!url) return false;
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.hostname.includes('tennis.de') && parsedUrl.pathname.toLowerCase().includes('/spielerprofil');
    } catch (_error) {
      return url.includes('tennis.de') && url.includes('spielerprofil');
    }
  }

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

  function showPageStatus(message, className) {
    if (!els.pageStatus) return;
    els.pageStatus.textContent = message;
    els.pageStatus.className = `page-indicator ${className}`;
  }

  function showStatusMessage(message, type = 'info') {
    if (!els.statusMessage) return;
    els.statusMessage.textContent = message;
    els.statusMessage.className = `status-message status-${type}`;
  }

  function showLoginStatus(message, type) {
    if (!els.loginStatus) return;
    els.loginStatus.textContent = message;
    els.loginStatus.className = `status-message status-${type}`;
  }

  function showLinkingStatus(message, type) {
    if (!els.linkingStatus) return;
    els.linkingStatus.textContent = message;
    els.linkingStatus.className = `status-message ${type ? `status-${type}` : ''}`;
  }

  function openLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'block';
    if (els.emailInput) els.emailInput.focus();
  }

  function closeLoginModal() {
    if (els.loginModal) els.loginModal.style.display = 'none';
    if (els.loginForm) els.loginForm.reset();
    showLoginStatus('', '');
  }

  function showEmptyState() {
    if (!els.resultsContainer) return;
    els.resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎾</div>
        <p>No matches extracted yet</p>
        <small>Click "Sync Match History" to begin</small>
      </div>
    `;
  }

  function clearMatchHistory() {
    showEmptyState();
  }

  function hideUploadProgress() {
    const progressContainer = document.querySelector('.progress-container');
    if (progressContainer) {
      progressContainer.remove();
    }
  }

  function showUploadProgress(percent, message, stats = null) {
    const existing = document.querySelector('.progress-container');
    if (existing) existing.remove();

    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    progressContainer.innerHTML = `
      <div class="loading-message">${message}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="progress-text">${percent}% complete</div>
      ${stats ? `
        <div class="upload-stats">
          <div class="upload-stat stat-uploaded"><div>Uploaded</div><div><strong>${stats.uploaded || 0}</strong></div></div>
          <div class="upload-stat stat-duplicates"><div>Duplicates</div><div><strong>${stats.duplicates || 0}</strong></div></div>
          <div class="upload-stat stat-errors"><div>Errors</div><div><strong>${stats.errors || 0}</strong></div></div>
        </div>
      ` : ''}
    `;

    els.resultsContainer.parentNode.insertBefore(progressContainer, els.resultsContainer);
  }

  function updateUploadButtons() {
    if (!els.fullHistorySyncButton) return;
    const disabled = !state.isPlayerLoaded || state.isUploading || !state.isAuthenticated;
    els.fullHistorySyncButton.disabled = disabled;
    els.fullHistorySyncButton.style.opacity = disabled ? '0.5' : '1';
  }

  function resetSyncButton() {
    if (!els.fullHistorySyncButton) return;
    els.fullHistorySyncButton.textContent = 'Sync Match History';
    updateUploadButtons();
  }

  function updateProfileLinkingUI() {
    if (!els.profileLinkingSection) return;

    if (!state.isAuthenticated || state.hasLinkedProfile) {
      els.profileLinkingSection.style.display = 'none';
      return;
    }

    els.profileLinkingSection.style.display = 'block';

    const canLink = state.isOwnerProfile && state.isPlayerLoaded && state.pendingLinkData;
    els.linkProfileButton.style.display = canLink ? 'block' : 'none';
    if (els.linkGuidance) els.linkGuidance.style.display = canLink ? 'none' : 'block';

    if (!canLink) {
      els.linkConfirmation.style.display = 'none';
    }
  }

  function updateAuthUI(authenticated, user) {
    state.isAuthenticated = !!authenticated;
    state.currentUser = user || null;

    if (state.isAuthenticated && state.currentUser) {
      if (state.hasLinkedProfile && state.userLinkedDtbId) {
        els.authStatus.textContent = `Logged in as: ${state.currentUser.email} | DTB ID: ${state.userLinkedDtbId}`;
        els.authStatus.style.color = '#155724';
      } else {
        els.authStatus.textContent = `Logged in as: ${state.currentUser.email}`;
        els.authStatus.style.color = '#666';
      }
      els.loginButton.style.display = 'none';
      els.logoutButton.style.display = 'block';
    } else {
      els.authStatus.textContent = 'Not logged in';
      els.authStatus.style.color = '#666';
      els.loginButton.style.display = 'block';
      els.logoutButton.style.display = 'none';

      state.hasLinkedProfile = false;
      state.userLinkedDtbId = null;
      state.linkedPlayerData = null;
      hideUploadProgress();
    }

    updateUploadButtons();
    updateProfileLinkingUI();
  }

  function renderMatchItem(match) {
    let displayDate;
    let displayEvent;
    let displayPlayers;
    let displayScore;
    let resultClass;

    if (match.date && match.event && match.playersDisplay) {
      displayDate = match.date || 'Unknown date';
      displayEvent = match.event || 'Unknown event';
      displayPlayers = match.playersDisplay;
      displayScore = match.score || 'No score';
      resultClass = match.result === 'Win' ? 'score-win' : match.result === 'Loss' ? 'score-loss' : 'score-unknown';
    } else {
      displayDate = match.match_date || 'Unknown date';
      displayEvent = match.event_name || 'Unknown event';

      const team1 = match.team1_player1_name || 'Unknown';
      const team1Partner = match.team1_player2_name ? ` / ${match.team1_player2_name}` : '';
      const team2 = match.team2_player1_name || 'Unknown';
      const team2Partner = match.team2_player2_name ? ` / ${match.team2_player2_name}` : '';

      displayPlayers = `${team1}${team1Partner} vs. ${team2}${team2Partner}`;
      displayScore = match.normalized_score || match.original_score || 'No score';

      if (match.winning_team && match.scraped_from_player) {
        resultClass = match.winning_team.includes(match.scraped_from_player) ? 'score-win' : 'score-loss';
      } else {
        resultClass = 'score-unknown';
      }
    }

    return `
      <div class="match-item">
        <div class="match-header">${displayDate} - ${displayEvent}</div>
        <div class="match-players">
          <span>${displayPlayers}</span>
          <span class="match-score ${resultClass}">${displayScore}</span>
        </div>
      </div>
    `;
  }

  function displayResults(data) {
    resetSyncButton();

    if (!data || data.length === 0) {
      showEmptyState();
      return;
    }

    els.resultsContainer.innerHTML = data.map(renderMatchItem).join('');
  }

  function displayPlayerData(data) {
    if (!data || !data.fullName) {
      els.playerName.textContent = 'No player loaded';
      els.playerClub.textContent = '-';
      els.playerLK.textContent = '-';
      els.playerNationality.textContent = '-';

      state.isPlayerLoaded = false;
      state.isOwnerProfile = false;
      state.pendingLinkData = null;
      state.currentPlayerUrl = null;

      clearMatchHistory();
      showStatusMessage('', '');
      updateUploadButtons();
      updateProfileLinkingUI();
      return;
    }

    const newPlayerUrl = data.url || window.location.href;
    const isDifferentPlayer = state.currentPlayerUrl !== newPlayerUrl;

    if (isDifferentPlayer) {
      state.currentPlayerUrl = newPlayerUrl;
      clearMatchHistory();
      chrome.storage.local.remove(['fullMatchHistory']);
      showStatusMessage('', '');
    }

    els.playerName.textContent = data.fullName;
    els.playerClub.textContent = data.club || 'Unknown Club';
    els.playerLK.textContent = `LK ${data.leistungsklasse || 'N/A'}`;
    els.playerNationality.textContent = data.nationality || 'Unknown';

    state.isOwnerProfile = !!data.isOwner;
    state.pendingLinkData = {
      fullName: data.fullName,
      dtbId: data.dtbId,
      club: data.club,
      nationality: data.nationality,
      url: data.url
    };
    state.isPlayerLoaded = true;

    updateUploadButtons();
    updateProfileLinkingUI();

    if (isDifferentPlayer) {
      showStatusMessage(`Profile loaded: ${data.fullName}`, 'success');
    }
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();

    const email = els.emailInput.value.trim();
    const password = els.passwordInput.value.trim();

    if (!email || !password) {
      showLoginStatus('Please enter both email and password', 'error');
      return;
    }

    showLoginStatus('Signing in...', 'info');
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

    if (response && response.success) {
      updateAuthUI(true, response.user);
      closeLoginModal();
      await refreshLinkedProfileState();
      return;
    }

    showLoginStatus(`Sign in failed: ${response?.error || 'Unknown error'}`, 'error');
  }

  async function refreshLinkedProfileState() {
    if (!state.isAuthenticated) return;

    const response = await sendRuntimeMessage({ action: 'checkPlayerLink' });
    if (response && response.success && response.hasLink) {
      state.hasLinkedProfile = true;
      state.userLinkedDtbId = response.data?.dtb_id || null;
      state.linkedPlayerData = response.data || null;
      if (state.userLinkedDtbId) {
        els.linkedDtbId.textContent = String(state.userLinkedDtbId);
      }
    } else {
      state.hasLinkedProfile = false;
      state.userLinkedDtbId = null;
      state.linkedPlayerData = null;
    }

    updateAuthUI(state.isAuthenticated, state.currentUser);
    updateProfileLinkingUI();
  }

  async function handleLogout() {
    const response = await sendRuntimeMessage({ action: 'logout' });
    if (!response || !response.success) {
      showStatusMessage(`Logout failed: ${response?.error || 'Unknown error'}`, 'error');
      return;
    }

    updateAuthUI(false, null);
    showStatusMessage('Logged out', 'info');
  }

  function handleInitiateLink() {
    if (!state.isAuthenticated) {
      showLinkingStatus('Please login first', 'error');
      return;
    }

    if (!state.isOwnerProfile) {
      showLinkingStatus('Please open your own "Mein Spielerprofil" page first', 'error');
      return;
    }

    if (!state.isPlayerLoaded || !state.pendingLinkData) {
      showLinkingStatus('Player data not loaded. Refresh page and try again.', 'error');
      return;
    }

    els.linkPlayerName.textContent = state.pendingLinkData.fullName || '-';
    els.linkDtbId.textContent = state.pendingLinkData.dtbId || '-';
    els.linkProfileButton.style.display = 'none';
    els.linkConfirmation.style.display = 'block';
  }

  async function handleConfirmLink() {
    if (!state.pendingLinkData) {
      showLinkingStatus('No player data to link', 'error');
      return;
    }

    showLinkingStatus('Linking profile...', 'info');
    els.confirmLinkButton.disabled = true;
    els.confirmLinkButton.textContent = 'Linking...';

    const response = await sendRuntimeMessage({
      action: 'linkPlayerProfile',
      playerData: state.pendingLinkData
    });

    els.confirmLinkButton.disabled = false;
    els.confirmLinkButton.textContent = 'Confirm Link';

    if (response && response.success) {
      state.hasLinkedProfile = true;
      state.userLinkedDtbId = state.pendingLinkData.dtbId;
      state.linkedPlayerData = response.data || null;
      els.linkedDtbId.textContent = state.pendingLinkData.dtbId || '';

      els.linkConfirmation.style.display = 'none';
      els.linkSuccess.style.display = 'block';
      showLinkingStatus('', '');

      updateAuthUI(state.isAuthenticated, state.currentUser);
      updateProfileLinkingUI();

      setTimeout(() => {
        els.linkSuccess.style.display = 'none';
        updateProfileLinkingUI();
      }, 3000);
      return;
    }

    showLinkingStatus(`Link failed: ${response?.error || 'Unknown error'}`, 'error');
  }

  function handleCancelLink() {
    els.linkConfirmation.style.display = 'none';
    els.linkProfileButton.style.display = 'block';
    showLinkingStatus('', '');
  }

  async function handleFullHistorySync() {
    if (!state.isPlayerLoaded) {
      showStatusMessage('Please navigate to a player profile first', 'error');
      return;
    }

    clearMatchHistory();
    showStatusMessage('Extracting match history...', 'info');

    state.isUploading = true;
    updateUploadButtons();
    els.fullHistorySyncButton.textContent = 'Extracting...';

    chrome.storage.local.remove(['fullMatchHistory']);

    const response = await sendRuntimeMessage({
      action: 'startFullHistoryScrape',
      playerData: state.pendingLinkData || null
    });
    if (!response || response.status === 'Error') {
      state.isUploading = false;
      resetSyncButton();
      showStatusMessage(`Could not start extraction: ${response?.message || 'Unknown error'}`, 'error');
    }
  }

  function updatePageStatusFromUrl(url) {
    if (isPlayerProfileUrl(url)) {
      showPageStatus('Player profile detected', 'status-ready');
      return;
    }
    if (url && url.includes('tennis.de')) {
      showPageStatus('Navigate to player profile', 'status-navigate');
      return;
    }
    showPageStatus('Go to tennis.de', 'status-offline');
  }

  function onRuntimeMessage(request) {
    switch (request.action) {
      case 'urlUpdated':
        updatePageStatusFromUrl(request.url);
        break;

      case 'playerDataScraped':
        displayPlayerData(request.data);
        break;

      case 'fullMatchHistoryScraped':
        showStatusMessage('Match history scraped. Uploading...', 'info');
        displayResults(request.data || []);
        break;

      case 'uploadProgress': {
        const progress = request.progress || { percent: 0, uploaded: 0, duplicates: 0, errors: 0 };
        showUploadProgress(progress.percent, 'Syncing match history...', {
          uploaded: progress.uploaded,
          duplicates: progress.duplicates,
          errors: progress.errors
        });
        break;
      }

      case 'uploadCompleted': {
        state.isUploading = false;
        hideUploadProgress();
        resetSyncButton();

        const result = request.result || {};
        if (result.success) {
          showStatusMessage('Match history synced successfully', 'success');
        } else {
          showStatusMessage(`Sync failed: ${result.error || 'Unknown error'}`, 'error');
        }
        break;
      }

      case 'authStatusChanged':
      case 'userSignedIn':
        updateAuthUI(!!request.authenticated || !!request.success, request.user || null);
        refreshLinkedProfileState();
        break;

      case 'userSignedOut':
        updateAuthUI(false, null);
        break;

      case 'playerProfileLinked':
        if (request.success) {
          state.hasLinkedProfile = true;
          state.userLinkedDtbId = request.data?.dtb_id || state.userLinkedDtbId;
          state.linkedPlayerData = request.data || null;
          updateAuthUI(state.isAuthenticated, state.currentUser);
          updateProfileLinkingUI();
          showLinkingStatus('Profile linked successfully', 'success');
        }
        break;

      default:
        break;
    }
  }

  async function initialize() {
    showEmptyState();
    updateUploadButtons();

    els.loginButton.addEventListener('click', () => {
      if (!state.isAuthenticated) {
        openLoginModal();
      }
    });

    els.logoutButton.addEventListener('click', handleLogout);
    els.closeModal.addEventListener('click', closeLoginModal);
    els.loginModal.addEventListener('click', (event) => {
      if (event.target === els.loginModal) {
        closeLoginModal();
      }
    });
    els.loginForm.addEventListener('submit', handleLoginSubmit);

    els.linkProfileButton.addEventListener('click', handleInitiateLink);
    els.confirmLinkButton.addEventListener('click', handleConfirmLink);
    els.cancelLinkButton.addEventListener('click', handleCancelLink);

    els.fullHistorySyncButton.addEventListener('click', handleFullHistorySync);

    chrome.runtime.onMessage.addListener((request) => {
      onRuntimeMessage(request);
    });

    const authResponse = await sendRuntimeMessage({ action: 'checkAuthStatus' });
    if (authResponse && authResponse.success) {
      updateAuthUI(!!authResponse.authenticated, authResponse.user || null);
      await refreshLinkedProfileState();
    } else {
      updateAuthUI(false, null);
    }

    chrome.storage.local.get(['fullMatchHistory', 'playerData'], (result) => {
      if (result.playerData) {
        displayPlayerData(result.playerData);
      }

      if (
        result.fullMatchHistory &&
        Array.isArray(result.fullMatchHistory) &&
        result.fullMatchHistory.length > 0 &&
        result.playerData &&
        result.playerData.url === state.currentPlayerUrl
      ) {
        displayResults(result.fullMatchHistory);
      }
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.url) {
        updatePageStatusFromUrl(tabs[0].url);
      }
      updateUploadButtons();
    });
  }

  initialize();
});
