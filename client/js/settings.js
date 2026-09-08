/**
 * Givebar — Settings View Controller
 * Collapsible grouped sections with persisted open/closed state, the full branding set
 * (title, logo, colors, typeface, orientation), separated QR destination vs. printed URL,
 * editable goal, milestone and ask-tier editors, and Control Room / Volunteer Pad PINs.
 */

(function () {
  'use strict';

  const OPEN_SECTIONS_KEY = 'givebar_settings_open_sections';
  const DEFAULT_OPEN_SECTIONS = ['sec-event'];

  // Typeface keys accepted by the server. The preview binds the same custom
  // properties the chart uses, so what you see here is what the room gets.
  const FONT_STACK_VARS = {
    brandon: 'var(--font-brandon, var(--font-sans))',
    humanist: 'var(--font-humanist, var(--font-sans))',
    grotesk: 'var(--font-grotesk, var(--font-sans))',
    mono: 'var(--font-mono)',
    serif: 'var(--font-serif, Georgia, serif)'
  };
  const FONT_KEYS = Object.keys(FONT_STACK_VARS);
  const DEFAULT_FONT_KEY = 'brandon';
  const ORIENTATIONS = ['horizontal', 'vertical'];

  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const OKLCH_RE = /^oklch\(\s*[^()]*\)$/i;

  let currentSettingsSeq = 1;
  let milestonesData = [];
  let askTiersData = [];

  // DOM Elements
  const btnSaveTop = document.getElementById('btn-save-top');
  const btnSaveBottom = document.getElementById('btn-save-bottom');
  const btnExpandAll = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');
  const errorBanner = document.getElementById('settings-error-banner');
  const errorText = document.getElementById('settings-error-text');
  const btnReloadConflict = document.getElementById('btn-reload-conflict');
  const successBanner = document.getElementById('settings-success-banner');

  // Auth Elements
  const unlockScreen = document.getElementById('unlock-screen');
  const unlockForm = document.getElementById('unlock-form');
  const unlockPinInput = document.getElementById('unlock-pin-input');
  const btnSubmitUnlock = document.getElementById('btn-submit-unlock');
  const unlockError = document.getElementById('unlock-error');
  const authView = document.getElementById('authenticated-view');

  // Event Inputs
  const eventTitleInput = document.getElementById('setting-event-title');
  const eventNameInput = document.getElementById('setting-event-name');
  const eventSubtitleInput = document.getElementById('setting-event-subtitle');
  const goalDollarsInput = document.getElementById('setting-goal-dollars');
  const errGoal = document.getElementById('err-goal');
  const trustBadgeInput = document.getElementById('setting-trust-badge');
  const milestonesTbody = document.getElementById('milestones-tbody');
  const milestonesEmpty = document.getElementById('milestones-empty');
  const btnAddMilestone = document.getElementById('btn-add-milestone');

  // Branding Inputs
  const logoUrlInput = document.getElementById('setting-logo-url');
  const barColorInput = document.getElementById('setting-bar-color');
  const errBarColor = document.getElementById('err-bar-color');
  const textColorInput = document.getElementById('setting-text-color');
  const errTextColor = document.getElementById('err-text-color');
  const bgStyleSelect = document.getElementById('setting-bg-style');
  const orientationSelect = document.getElementById('setting-chart-orientation');
  const fontFamilySelect = document.getElementById('setting-font-family');
  const fontPreview = document.getElementById('font-preview');
  const fontPreviewTitle = document.getElementById('font-preview-title');

  // QR Inputs
  const qrUrlInput = document.getElementById('setting-qr-url');
  const displayUrlInput = document.getElementById('setting-display-url');
  const errQrUrl = document.getElementById('err-qr-url');
  const displayUrlEffectiveEl = document.getElementById('display-url-effective');
  const toggleShowQr = document.getElementById('toggle-show-qr');

  // Stage Display Inputs
  const toggleShowRecent = document.getElementById('toggle-show-recent');
  const toggleShowLive = document.getElementById('toggle-show-live');
  const toggleShowGoal = document.getElementById('toggle-show-goal');
  const stageMessageInput = document.getElementById('setting-stage-message');
  const toggleStageMessageVisible = document.getElementById('toggle-stage-message-visible');

  // Donations Inputs
  const askTiersTbody = document.getElementById('ask-tiers-tbody');
  const btnAddTier = document.getElementById('btn-add-tier');
  const guardrailThresholdInput = document.getElementById('setting-guardrail-threshold');
  const stagingDelayInput = document.getElementById('setting-staging-delay');
  const toggleMatchActive = document.getElementById('toggle-match-active');
  const matchTitleInput = document.getElementById('setting-match-title');
  const matchPoolInput = document.getElementById('setting-match-pool');

  // Connections Inputs
  const bloomerangKeyInput = document.getElementById('setting-bloomerang-key');
  const btnToggleKeyView = document.getElementById('btn-toggle-key-view');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const connStatusDisplay = document.getElementById('conn-status-display');
  const connSyncInfo = document.getElementById('conn-sync-info');
  const connErrorInfo = document.getElementById('conn-error-info');

  // Features Inputs
  const toggleFeatureTimer = document.getElementById('toggle-feature-timer');
  const toggleFeatureCard = document.getElementById('toggle-feature-card');
  const toggleFeatureTable = document.getElementById('toggle-feature-table');

  // Access Inputs
  const controlPinInput = document.getElementById('setting-control-pin');
  const errControlPin = document.getElementById('err-control-pin');
  const controlPinStatus = document.getElementById('control-pin-status');
  const controlPinFeedback = document.getElementById('control-pin-feedback');
  const btnApplyControlPin = document.getElementById('btn-apply-control-pin');
  const btnClearControlPin = document.getElementById('btn-clear-control-pin');

  const entryPinInput = document.getElementById('setting-entry-pin');
  const errEntryPin = document.getElementById('err-entry-pin');
  const entryPinStatus = document.getElementById('entry-pin-status');
  const entryPinFeedback = document.getElementById('entry-pin-feedback');
  const btnApplyEntryPin = document.getElementById('btn-apply-entry-pin');
  const btnClearEntryPin = document.getElementById('btn-clear-entry-pin');

  // --- PIN storage helpers ---
  function getControlPin() {
    return sessionStorage.getItem('givebar_control_pin') || localStorage.getItem('givebar_control_pin') || '';
  }

  function setStoredControlPin(pin) {
    sessionStorage.setItem('givebar_control_pin', pin);
    localStorage.setItem('givebar_control_pin', pin);
  }

  function clearStoredControlPin() {
    sessionStorage.removeItem('givebar_control_pin');
    localStorage.removeItem('givebar_control_pin');
  }

  // The unlock screen appears only when the server actually answers 401.
  function setAuthUIState(state) {
    if (state === 'unauthenticated') {
      if (unlockScreen) unlockScreen.style.display = 'flex';
      if (authView) authView.style.display = 'none';
      if (unlockPinInput) setTimeout(() => unlockPinInput.focus(), 50);
    } else {
      if (unlockScreen) unlockScreen.style.display = 'none';
      if (authView) authView.style.display = 'block';
    }
  }

  function init() {
    setupAccordion();
    setupMilestonesEditor();
    setupAskTiersEditor();
    setupKeyViewToggle();
    setupTestConnection();
    setupSaveHandlers();
    setupReloadConflict();
    setupUnlockForm();
    setupLivePreviews();
    setupPinControls();
    loadSettings();
  }

  // --- Unlock ---
  function setupUnlockForm() {
    if (!unlockForm) return;
    unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = (unlockPinInput?.value || '').trim();
      if (!pin) {
        showUnlockError('Please enter the Control Room PIN.');
        return;
      }
      clearUnlockError();
      if (btnSubmitUnlock) {
        btnSubmitUnlock.disabled = true;
        btnSubmitUnlock.textContent = 'Verifying...';
      }
      try {
        const res = await fetch(`/api/state?role=control&pin=${encodeURIComponent(pin)}`, {
          headers: { 'X-Control-Pin': pin, 'Cache-Control': 'no-cache' }
        });
        if (res.status === 401) {
          showUnlockError('Invalid Control Room PIN.');
          if (unlockPinInput) { unlockPinInput.focus(); unlockPinInput.select(); }
          return;
        }
        if (!res.ok) {
          showUnlockError('Server error validating PIN.');
          return;
        }
        const data = await res.json();
        setStoredControlPin(pin);
        setAuthUIState('authenticated');
        populateForm(data);
      } catch (err) {
        showUnlockError('Network error connecting to server.');
      } finally {
        if (btnSubmitUnlock) {
          btnSubmitUnlock.disabled = false;
          btnSubmitUnlock.textContent = 'Unlock';
        }
      }
    });
  }

  function showUnlockError(msg) {
    if (unlockError) {
      unlockError.textContent = msg;
      unlockError.style.display = 'block';
    }
  }

  function clearUnlockError() {
    if (unlockError) {
      unlockError.textContent = '';
      unlockError.style.display = 'none';
    }
  }

  // --- Accordion with persisted open/closed state ---
  function readOpenSections() {
    try {
      const raw = localStorage.getItem(OPEN_SECTIONS_KEY);
      if (raw === null) return DEFAULT_OPEN_SECTIONS.slice();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch (err) {
      return DEFAULT_OPEN_SECTIONS.slice();
    }
  }

  function writeOpenSections(ids) {
    try {
      localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(ids));
    } catch (err) {
      /* storage unavailable: collapse state simply will not persist */
    }
  }

  function setPanelExpanded(panel, expanded) {
    panel.classList.toggle('expanded', expanded);
    const header = panel.querySelector('.accordion-header');
    if (header) header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function persistCurrentOpenSections() {
    const open = [];
    document.querySelectorAll('.accordion-panel').forEach(panel => {
      if (panel.classList.contains('expanded')) open.push(panel.id);
    });
    writeOpenSections(open);
  }

  function setupAccordion() {
    const openSections = readOpenSections();
    document.querySelectorAll('.accordion-panel').forEach(panel => {
      setPanelExpanded(panel, openSections.includes(panel.id));
    });

    document.querySelectorAll('.accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const panel = document.getElementById(header.getAttribute('data-toggle'));
        if (!panel) return;
        setPanelExpanded(panel, !panel.classList.contains('expanded'));
        persistCurrentOpenSections();
      });
    });

    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', () => {
        document.querySelectorAll('.accordion-panel').forEach(p => setPanelExpanded(p, true));
        persistCurrentOpenSections();
      });
    }

    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', () => {
        document.querySelectorAll('.accordion-panel').forEach(p => setPanelExpanded(p, false));
        persistCurrentOpenSections();
      });
    }
  }

  // --- Live previews ---
  function applyFontPreview() {
    const key = FONT_KEYS.includes(fontFamilySelect?.value) ? fontFamilySelect.value : DEFAULT_FONT_KEY;
    if (fontPreview) fontPreview.style.fontFamily = FONT_STACK_VARS[key];
    if (fontPreviewTitle) {
      const title = (eventTitleInput?.value || '').trim()
        || (eventNameInput?.value || '').trim()
        || 'Your Fundraiser Title';
      fontPreviewTitle.textContent = title;
    }
  }

  // Mirrors the server rule: empty printed URL falls back to the QR destination
  // with its query string and fragment stripped, so UTM never hits the projector.
  function derivePrintedUrl(qrUrl, displayUrl) {
    const explicit = (displayUrl || '').trim();
    if (explicit) return explicit;
    const raw = (qrUrl || '').trim();
    if (!raw) return '';
    const stripped = raw.split('#')[0].split('?')[0];
    return stripped.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function applyPrintedUrlPreview() {
    if (!displayUrlEffectiveEl) return;
    const printed = derivePrintedUrl(qrUrlInput?.value, displayUrlInput?.value);
    displayUrlEffectiveEl.innerHTML = printed
      ? `Printed on the chart: <strong>${escapeHTML(printed)}</strong>`
      : 'Nothing prints under the QR code until one of these two fields has a value.';
  }

  function setupLivePreviews() {
    if (fontFamilySelect) fontFamilySelect.addEventListener('change', applyFontPreview);
    if (eventTitleInput) eventTitleInput.addEventListener('input', applyFontPreview);
    if (eventNameInput) eventNameInput.addEventListener('input', applyFontPreview);
    if (qrUrlInput) qrUrlInput.addEventListener('input', applyPrintedUrlPreview);
    if (displayUrlInput) displayUrlInput.addEventListener('input', applyPrintedUrlPreview);
    if (qrUrlInput) {
      qrUrlInput.addEventListener('input', () => {
        setFieldValidity(qrUrlInput, errQrUrl, isValidQrUrl(qrUrlInput.value));
      });
    }
    [barColorInput, textColorInput].forEach(input => {
      if (!input) return;
      input.addEventListener('input', () => {
        const errEl = input === barColorInput ? errBarColor : errTextColor;
        setFieldValidity(input, errEl, isValidColor(input.value));
      });
    });
  }

  // --- Validation ---
  function isValidColor(value) {
    const v = (value || '').trim();
    if (!v) return true;
    return HEX_RE.test(v) || OKLCH_RE.test(v);
  }

  // Server rule: absolute http(s) URL, or empty (which means no QR block at all).
  function isValidQrUrl(value) {
    const v = (value || '').trim();
    if (!v) return true;
    try {
      const parsed = new URL(v);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  function setFieldValidity(input, errEl, ok) {
    if (input) input.classList.toggle('invalid', !ok);
    if (errEl) errEl.style.display = ok ? 'none' : 'block';
    return ok;
  }

  // --- Load Settings ---
  async function loadSettings() {
    const pin = getControlPin();
    try {
      const res = await fetch(`/api/state?role=control&pin=${encodeURIComponent(pin)}`, {
        headers: { 'X-Control-Pin': pin, 'Cache-Control': 'no-cache' }
      });
      if (res.status === 401) {
        clearStoredControlPin();
        setAuthUIState('unauthenticated');
        return;
      }
      if (!res.ok) {
        showError('Could not load settings from server.');
        return;
      }
      const data = await res.json();
      setAuthUIState('authenticated');
      populateForm(data);
    } catch (err) {
      console.warn('[Givebar Settings] Load error:', err);
      showError('Network error loading settings.');
    }
  }

  function populateForm(data) {
    if (!data) return;

    currentSettingsSeq = data.settings_seq || 1;
    const es = data.event_state || {};

    // 1. Event
    if (eventTitleInput) eventTitleInput.value = es.event_title || '';
    if (eventNameInput) eventNameInput.value = es.event_name || '';
    if (eventSubtitleInput) eventSubtitleInput.value = es.event_subtitle || '';
    if (goalDollarsInput) goalDollarsInput.value = Math.floor((es.goal_cents || 0) / 100);
    if (trustBadgeInput) trustBadgeInput.value = es.trust_badge_text || '';

    milestonesData = (Array.isArray(data.milestones) ? data.milestones : []).map(m => ({
      cents: m.cents || 0,
      label: m.label || '',
      percent_of_goal: typeof m.percent_of_goal === 'number' ? m.percent_of_goal : undefined,
      celebrate: m.celebrate === undefined ? undefined : Boolean(m.celebrate)
    }));
    renderMilestonesRows();

    // 2. Branding
    if (logoUrlInput) logoUrlInput.value = es.logo_url || '';
    if (barColorInput) barColorInput.value = es.bar_color || '';
    if (textColorInput) textColorInput.value = es.text_color || '';
    if (bgStyleSelect) bgStyleSelect.value = es.background_style || es.bg_style || 'plain';
    if (orientationSelect) {
      orientationSelect.value = ORIENTATIONS.includes(es.chart_orientation) ? es.chart_orientation : 'horizontal';
    }
    if (fontFamilySelect) {
      fontFamilySelect.value = FONT_KEYS.includes(es.font_family) ? es.font_family : DEFAULT_FONT_KEY;
    }
    setFieldValidity(barColorInput, errBarColor, true);
    setFieldValidity(textColorInput, errTextColor, true);
    applyFontPreview();

    // 3. Donation link & QR
    if (qrUrlInput) qrUrlInput.value = es.qr_url || '';
    if (displayUrlInput) displayUrlInput.value = es.display_url || '';
    setFieldValidity(qrUrlInput, errQrUrl, true);
    if (displayUrlEffectiveEl && typeof data.display_url_effective === 'string') {
      displayUrlEffectiveEl.innerHTML = data.display_url_effective
        ? `Printed on the chart: <strong>${escapeHTML(data.display_url_effective)}</strong>`
        : 'Nothing prints under the QR code until one of these two fields has a value.';
    } else {
      applyPrintedUrlPreview();
    }
    if (toggleShowQr) toggleShowQr.checked = es.show_qr !== undefined ? Boolean(es.show_qr) : true;

    // 4. Stage display
    if (toggleShowRecent) toggleShowRecent.checked = es.show_recent_donations !== undefined ? Boolean(es.show_recent_donations) : true;
    if (toggleShowLive) toggleShowLive.checked = es.show_live_indicator !== undefined ? Boolean(es.show_live_indicator) : true;
    if (toggleShowGoal) toggleShowGoal.checked = es.show_goal !== undefined ? Boolean(es.show_goal) : true;
    if (stageMessageInput) stageMessageInput.value = es.stage_message || '';
    if (toggleStageMessageVisible) toggleStageMessageVisible.checked = Boolean(es.stage_message_visible);

    // 5. Donations
    askTiersData = (Array.isArray(data.ask_tiers) ? data.ask_tiers : []).map(t => ({
      cents: t.cents || 0,
      label: t.label || ''
    }));
    renderAskTiersRows();

    if (guardrailThresholdInput) guardrailThresholdInput.value = Math.floor((es.major_gift_threshold_cents || 950000) / 100);
    if (stagingDelayInput) stagingDelayInput.value = Math.round((es.stage_delay_ms || 0) / 1000);

    if (toggleMatchActive) toggleMatchActive.checked = Boolean(es.is_match_active);
    if (matchTitleInput) matchTitleInput.value = es.match_sponsor_title || '';
    if (matchPoolInput) matchPoolInput.value = Math.floor((es.match_total_cents || 0) / 100);

    // 6. Connections
    if (bloomerangKeyInput) {
      bloomerangKeyInput.value = data.has_bloomerang_api_key
        ? (data.bloomerang_key_masked || '••••••••••••••')
        : '';
    }
    updateConnectionStatus(data.has_bloomerang_api_key, es.bloomerang_last_sync_at, es.bloomerang_last_error);

    // 7. Features
    if (toggleFeatureTimer) toggleFeatureTimer.checked = Boolean(es.feature_timer);
    if (toggleFeatureCard) toggleFeatureCard.checked = Boolean(es.feature_card_number);
    if (toggleFeatureTable) toggleFeatureTable.checked = Boolean(es.feature_table_number);

    // 8. Access — PIN inputs always start empty; status reflects the server.
    if (controlPinInput) controlPinInput.value = '';
    if (entryPinInput) entryPinInput.value = '';
    setFieldValidity(controlPinInput, errControlPin, true);
    setFieldValidity(entryPinInput, errEntryPin, true);
    renderPinStatus(Boolean(data.has_control_pin), Boolean(data.has_entry_pin));
  }

  function renderPinStatus(hasControlPin, hasEntryPin) {
    if (controlPinStatus) {
      controlPinStatus.className = `pin-status ${hasControlPin ? 'locked' : 'open'}`;
      controlPinStatus.textContent = hasControlPin
        ? 'A Control Room PIN is set. Settings, Manage Donations, Testing, and History ask for it.'
        : 'No Control Room PIN set. Every operator screen opens with no authentication.';
    }
    if (entryPinStatus) {
      entryPinStatus.className = `pin-status ${hasEntryPin ? 'locked' : 'open'}`;
      entryPinStatus.textContent = hasEntryPin
        ? 'A Volunteer Pad PIN is set. Add Donation asks for it.'
        : 'No Volunteer Pad PIN set. Add Donation opens with no authentication.';
    }
  }

  function updateConnectionStatus(hasKey, lastSyncAt, lastError) {
    if (connStatusDisplay) {
      if (hasKey) {
        connStatusDisplay.innerHTML = '<span style="color: #d4a359;">&#x2713; Connected</span>';
      } else {
        connStatusDisplay.textContent = 'Not connected';
        connStatusDisplay.style.color = '#88888e';
      }
    }

    if (connSyncInfo) {
      if (lastSyncAt) {
        connSyncInfo.textContent = `Last successful sync: ${new Date(lastSyncAt).toLocaleString()}`;
        connSyncInfo.style.display = 'block';
      } else {
        connSyncInfo.style.display = 'none';
      }
    }

    if (connErrorInfo) {
      if (lastError) {
        connErrorInfo.textContent = `Error: ${lastError}`;
        connErrorInfo.style.display = 'block';
      } else {
        connErrorInfo.style.display = 'none';
      }
    }
  }

  // --- Milestones Editor ---
  function setupMilestonesEditor() {
    if (!btnAddMilestone) return;
    btnAddMilestone.addEventListener('click', () => {
      const goalDollars = parseInt(goalDollarsInput?.value || '0', 10) || 0;
      const suggestedDollars = goalDollars > 0 ? Math.round(goalDollars / 2) : 50000;
      milestonesData.push({
        cents: suggestedDollars * 100,
        label: 'New Milestone'
      });
      renderMilestonesRows();
      const lastInput = milestonesTbody?.querySelector('tr:last-child .milestone-label');
      if (lastInput) { lastInput.focus(); lastInput.select(); }
    });
  }

  function renderMilestonesRows() {
    if (!milestonesTbody) return;
    milestonesTbody.innerHTML = milestonesData.map((m, idx) => {
      const dollars = Math.floor((m.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="number" class="form-input-text milestone-dollars" value="${dollars}" min="0" step="1" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Milestone target in dollars">
          </td>
          <td>
            <input type="text" class="form-input-text milestone-label" value="${escapeHTML(m.label || '')}" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Milestone label">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-milestone="${idx}" title="Delete this milestone">
              <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192Z"/></svg>
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join('');

    if (milestonesEmpty) {
      milestonesEmpty.style.display = milestonesData.length === 0 ? 'block' : 'none';
    }

    milestonesTbody.querySelectorAll('.milestone-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        milestonesData[idx].cents = (parseInt(inp.value || '0', 10) || 0) * 100;
      });
    });

    milestonesTbody.querySelectorAll('.milestone-label').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        milestonesData[idx].label = inp.value;
      });
    });

    milestonesTbody.querySelectorAll('[data-remove-milestone]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-milestone'), 10);
        milestonesData.splice(idx, 1);
        renderMilestonesRows();
      });
    });
  }

  // --- Ask Tiers Editor ---
  function setupAskTiersEditor() {
    if (!btnAddTier) return;
    btnAddTier.addEventListener('click', () => {
      askTiersData.push({ cents: 100000, label: '$1,000' });
      renderAskTiersRows();
    });
  }

  function renderAskTiersRows() {
    if (!askTiersTbody) return;
    askTiersTbody.innerHTML = askTiersData.map((t, idx) => {
      const dollars = Math.floor((t.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="number" class="form-input-text tier-dollars" value="${dollars}" min="1" step="1" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Ask tier amount in dollars">
          </td>
          <td>
            <input type="text" class="form-input-text tier-label" value="${escapeHTML(t.label || `$${dollars.toLocaleString('en-US')}`)}" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Ask tier label">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-tier="${idx}" title="Delete this ask tier">
              <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192Z"/></svg>
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join('');

    askTiersTbody.querySelectorAll('.tier-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        const val = parseInt(inp.value || '0', 10) || 0;
        askTiersData[idx].cents = val * 100;
        if (!askTiersData[idx].label || askTiersData[idx].label.startsWith('$')) {
          askTiersData[idx].label = `$${val.toLocaleString('en-US')}`;
          const labelInp = askTiersTbody.querySelector(`tr[data-index="${idx}"] .tier-label`);
          if (labelInp) labelInp.value = askTiersData[idx].label;
        }
      });
    });

    askTiersTbody.querySelectorAll('.tier-label').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        askTiersData[idx].label = inp.value;
      });
    });

    askTiersTbody.querySelectorAll('[data-remove-tier]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-tier'), 10);
        askTiersData.splice(idx, 1);
        renderAskTiersRows();
      });
    });
  }

  // --- Password Reveal ---
  function setupKeyViewToggle() {
    if (!btnToggleKeyView || !bloomerangKeyInput) return;
    btnToggleKeyView.addEventListener('click', () => {
      const isPassword = bloomerangKeyInput.type === 'password';
      bloomerangKeyInput.type = isPassword ? 'text' : 'password';
      btnToggleKeyView.textContent = isPassword ? 'Hide' : 'Show';
    });
  }

  // --- Test Connection ---
  function setupTestConnection() {
    if (!btnTestConnection) return;
    btnTestConnection.addEventListener('click', async () => {
      clearBanners();
      btnTestConnection.textContent = 'Testing...';

      const pin = getControlPin();
      const enteredKey = bloomerangKeyInput?.value?.trim() || '';
      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Control-Pin': pin
          },
          body: JSON.stringify({
            action: 'test_bloomerang',
            api_key: enteredKey.startsWith('••••') ? undefined : enteredKey,
            pin
          })
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.connected) {
          updateConnectionStatus(true, data.last_sync_at, '');
          showSuccess('Bloomerang connection verified successfully.');
        } else {
          updateConnectionStatus(false, null, data.error || 'Connection failed');
          showError(`Connection failed: ${data.error || 'Invalid API key or network error'}`);
        }
      } catch (err) {
        showError('Network error testing Bloomerang connection.');
      } finally {
        btnTestConnection.textContent = 'Test Connection';
      }
    });
  }

  // --- PIN set / change / clear (dedicated update_pins path) ---
  function setupPinControls() {
    if (btnApplyControlPin) {
      btnApplyControlPin.addEventListener('click', () => applyPin('control'));
    }
    if (btnClearControlPin) {
      btnClearControlPin.addEventListener('click', () => clearPin('control'));
    }
    if (btnApplyEntryPin) {
      btnApplyEntryPin.addEventListener('click', () => applyPin('entry'));
    }
    if (btnClearEntryPin) {
      btnClearEntryPin.addEventListener('click', () => clearPin('entry'));
    }
  }

  function pinFeedback(kind, msg, tone) {
    const el = kind === 'control' ? controlPinFeedback : entryPinFeedback;
    if (!el) return;
    el.textContent = msg;
    el.style.color = tone === 'error' ? '#fca5a5' : '#86efac';
  }

  async function applyPin(kind) {
    const input = kind === 'control' ? controlPinInput : entryPinInput;
    const errEl = kind === 'control' ? errControlPin : errEntryPin;
    const value = (input?.value || '').trim();

    if (!setFieldValidity(input, errEl, value.length >= 4 && value.length <= 12)) {
      pinFeedback(kind, '', 'error');
      if (input) input.focus();
      return;
    }

    const ok = await postPins(kind === 'control' ? { control_pin: value } : { entry_pin: value });
    if (!ok) return;

    if (kind === 'control') {
      // Keep this browser authenticated with the PIN it just installed.
      setStoredControlPin(value);
      pinFeedback('control', 'Control Room PIN saved.', 'ok');
    } else {
      pinFeedback('entry', 'Volunteer Pad PIN saved.', 'ok');
    }
    if (input) input.value = '';
    await loadSettings();
  }

  async function clearPin(kind) {
    const ok = await postPins(kind === 'control' ? { control_pin: '' } : { entry_pin: '' });
    if (!ok) return;

    if (kind === 'control') {
      clearStoredControlPin();
      pinFeedback('control', 'Control Room PIN removed. Operator screens now open with no authentication.', 'ok');
    } else {
      pinFeedback('entry', 'Volunteer Pad PIN removed. Add Donation now opens with no authentication.', 'ok');
    }
    const input = kind === 'control' ? controlPinInput : entryPinInput;
    if (input) input.value = '';
    setFieldValidity(input, kind === 'control' ? errControlPin : errEntryPin, true);
    await loadSettings();
  }

  async function postPins(patch) {
    clearBanners();
    const pin = getControlPin();
    try {
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': pin
        },
        body: JSON.stringify({ action: 'update_pins', pin, ...patch })
      });

      if (res.status === 401) {
        clearStoredControlPin();
        setAuthUIState('unauthenticated');
        return false;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        showError(errData.message || 'Could not update the PIN.');
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Givebar Settings] PIN update error:', err);
      showError('Network error updating the PIN.');
      return false;
    }
  }

  // --- Save Handlers ---
  function setupSaveHandlers() {
    if (btnSaveTop) btnSaveTop.addEventListener('click', handleSaveSettings);
    if (btnSaveBottom) btnSaveBottom.addEventListener('click', handleSaveSettings);
  }

  function setupReloadConflict() {
    if (!btnReloadConflict) return;
    btnReloadConflict.addEventListener('click', () => {
      clearBanners();
      loadSettings();
    });
  }

  async function handleSaveSettings() {
    clearBanners();

    // Client-side validation so the operator sees the field, not a bare 400.
    const goalDollars = parseInt(goalDollarsInput?.value || '0', 10);
    const goalOk = setFieldValidity(goalDollarsInput, errGoal, Number.isFinite(goalDollars) && goalDollars >= 1);
    const barOk = setFieldValidity(barColorInput, errBarColor, isValidColor(barColorInput?.value));
    const textOk = setFieldValidity(textColorInput, errTextColor, isValidColor(textColorInput?.value));
    const qrOk = setFieldValidity(qrUrlInput, errQrUrl, isValidQrUrl(qrUrlInput?.value));

    if (!goalOk || !barOk || !textOk || !qrOk) {
      const target = !goalOk ? goalDollarsInput
        : (!barOk ? barColorInput : (!textOk ? textColorInput : qrUrlInput));
      const panel = target?.closest('.accordion-panel');
      if (panel) {
        setPanelExpanded(panel, true);
        persistCurrentOpenSections();
      }
      showError('Fix the fields marked in red.');
      if (target) target.focus();
      return;
    }

    const guardrailDollars = parseInt(guardrailThresholdInput?.value || '9500', 10) || 9500;
    const stagingSec = Math.max(0, parseInt(stagingDelayInput?.value || '0', 10) || 0);
    const matchPoolDollars = Math.max(0, parseInt(matchPoolInput?.value || '0', 10) || 0);
    const fontKey = FONT_KEYS.includes(fontFamilySelect?.value) ? fontFamilySelect.value : DEFAULT_FONT_KEY;
    const orientation = ORIENTATIONS.includes(orientationSelect?.value) ? orientationSelect.value : 'horizontal';

    const payload = {
      action: 'update_settings',
      settings_seq: currentSettingsSeq,
      pin: getControlPin(),

      // Event
      event_title: eventTitleInput?.value?.trim() || '',
      event_name: eventNameInput?.value?.trim() || undefined,
      event_subtitle: eventSubtitleInput?.value?.trim() || '',
      goal_cents: goalDollars * 100,
      trust_badge_text: trustBadgeInput?.value?.trim() || '',
      milestones: milestonesData.map(m => ({ cents: m.cents || 0, label: m.label || '' })),

      // Branding
      logo_url: logoUrlInput?.value?.trim() || '',
      bar_color: barColorInput?.value?.trim() || '',
      text_color: textColorInput?.value?.trim() || '',
      background_style: bgStyleSelect?.value || 'plain',
      font_family: fontKey,
      chart_orientation: orientation,

      // Donation link & QR
      qr_url: qrUrlInput?.value?.trim() || '',
      display_url: displayUrlInput?.value?.trim() || '',
      show_qr: Boolean(toggleShowQr?.checked),

      // Stage display
      show_recent_donations: Boolean(toggleShowRecent?.checked),
      show_live_indicator: Boolean(toggleShowLive?.checked),
      show_goal: Boolean(toggleShowGoal?.checked),
      stage_message: stageMessageInput?.value?.trim() || '',
      stage_message_visible: Boolean(toggleStageMessageVisible?.checked),

      // Donations
      ask_tiers: askTiersData.map(t => ({ cents: t.cents || 0, label: t.label || '' })),
      major_gift_threshold_cents: guardrailDollars * 100,
      stage_delay_ms: stagingSec * 1000,
      is_match_active: Boolean(toggleMatchActive?.checked),
      match_sponsor_title: matchTitleInput?.value?.trim() || undefined,
      match_total_cents: matchPoolDollars * 100,

      // Features
      feature_timer: Boolean(toggleFeatureTimer?.checked),
      feature_card_number: Boolean(toggleFeatureCard?.checked),
      feature_table_number: Boolean(toggleFeatureTable?.checked)
    };

    // Bloomerang key: only send a freshly typed value, never the mask.
    const bloomKey = bloomerangKeyInput?.value?.trim();
    if (bloomKey && !bloomKey.startsWith('••••')) {
      payload.bloomerang_api_key = bloomKey;
    }

    setSaveBusy(true);
    try {
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': payload.pin
        },
        body: JSON.stringify(payload)
      });

      if (res.status === 401) {
        clearStoredControlPin();
        setAuthUIState('unauthenticated');
        showError('Unauthorized: the Control Room PIN was rejected.');
        return;
      }

      if (res.status === 409) {
        const conflictData = await res.json().catch(() => ({}));
        showError(conflictData.message || 'Settings were changed in another session. Reload before saving.', true);
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        showError(errData.message || 'Failed to save settings.');
        return;
      }

      const resData = await res.json();
      showSuccess('Settings saved.');
      if (resData.state) {
        populateForm(resData.state);
      } else {
        currentSettingsSeq += 1;
        await loadSettings();
      }
    } catch (err) {
      console.error('[Givebar Settings] Save error:', err);
      showError('Network error saving settings.');
    } finally {
      setSaveBusy(false);
    }
  }

  function setSaveBusy(busy) {
    [btnSaveTop, btnSaveBottom].forEach(btn => {
      if (!btn) return;
      btn.disabled = busy;
      btn.textContent = busy ? 'Saving...' : 'Save Settings';
    });
  }

  // --- Banner Helpers ---
  function showError(msg, showReload = false) {
    if (errorBanner && errorText) {
      errorText.textContent = msg;
      errorBanner.style.display = 'block';
      if (btnReloadConflict) {
        btnReloadConflict.style.display = showReload ? 'inline-flex' : 'none';
      }
    }
    if (successBanner) successBanner.style.display = 'none';
  }

  function showSuccess(msg) {
    if (successBanner) {
      successBanner.textContent = msg;
      successBanner.style.display = 'block';
    }
    if (errorBanner) errorBanner.style.display = 'none';
  }

  function clearBanners() {
    if (errorBanner) errorBanner.style.display = 'none';
    if (successBanner) successBanner.style.display = 'none';
  }

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
