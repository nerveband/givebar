/**
 * Givebar — Settings View Controller
 * Collapsible grouped sections for Event, Display, Donations, Connections, Features, Access.
 * Optimistic concurrency with settings_seq, end-to-end milestone & ask-tier persistence,
 * Bloomerang masked key handling, and persistent error surface.
 */

(function () {
  'use strict';

  let currentSettingsSeq = 1;
  let currentControlPin = '';
  let currentEntryPin = '';
  let milestonesData = [];
  let askTiersData = [];

  // DOM Elements
  const form = document.getElementById('settings-form');
  const btnSaveTop = document.getElementById('btn-save-top');
  const btnSaveBottom = document.getElementById('btn-save-bottom');
  const errorBanner = document.getElementById('settings-error-banner');
  const errorText = document.getElementById('settings-error-text');
  const btnReloadConflict = document.getElementById('btn-reload-conflict');
  const successBanner = document.getElementById('settings-success-banner');

  // Event Inputs
  const eventNameInput = document.getElementById('setting-event-name');
  const eventSubtitleInput = document.getElementById('setting-event-subtitle');
  const goalDollarsInput = document.getElementById('setting-goal-dollars');
  const trustBadgeInput = document.getElementById('setting-trust-badge');
  const milestonesTbody = document.getElementById('milestones-tbody');
  const btnAddMilestone = document.getElementById('btn-add-milestone');

  // Display Inputs
  const bgStyleSelect = document.getElementById('setting-bg-style');
  const barColorInput = document.getElementById('setting-bar-color');
  const logoUrlInput = document.getElementById('setting-logo-url');
  const qrUrlInput = document.getElementById('setting-qr-url');
  const toggleShowQr = document.getElementById('toggle-show-qr');
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
  const entryPinInput = document.getElementById('setting-entry-pin');

  function init() {
    setupAccordion();
    setupMilestonesEditor();
    setupAskTiersEditor();
    setupKeyViewToggle();
    setupTestConnection();
    setupSaveHandlers();
    setupReloadConflict();
    loadSettings();
  }

  // --- Accordion Paneling ---
  function setupAccordion() {
    const headers = document.querySelectorAll('.accordion-header');
    headers.forEach(header => {
      header.addEventListener('click', () => {
        const targetId = header.getAttribute('data-toggle');
        const panel = document.getElementById(targetId);
        if (panel) {
          panel.classList.toggle('expanded');
          const chevron = header.querySelector('.accordion-chevron');
          if (chevron) {
            chevron.innerHTML = panel.classList.contains('expanded') ? '&#x2303;' : '&#x2304;';
          }
        }
      });
    });
  }

  // --- Load Settings ---
  async function loadSettings() {
    try {
      const res = await fetch('/api/state?role=control', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) {
        showError('Could not load settings from server. Check Control Room PIN.');
        return;
      }
      const data = await res.json();
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
    if (eventNameInput) eventNameInput.value = es.event_name || '';
    if (eventSubtitleInput) eventSubtitleInput.value = es.event_subtitle || '';
    if (goalDollarsInput) goalDollarsInput.value = Math.floor((es.goal_cents || 50000000) / 100);
    if (trustBadgeInput) trustBadgeInput.value = es.trust_badge_text || '';

    // Milestones
    milestonesData = Array.isArray(data.milestones) ? data.milestones : [];
    renderMilestonesRows();

    // 2. Display
    if (bgStyleSelect) bgStyleSelect.value = es.background_style || 'plain';
    if (barColorInput) barColorInput.value = es.bar_color || '';
    if (logoUrlInput) logoUrlInput.value = es.logo_url || '';
    if (qrUrlInput) qrUrlInput.value = es.qr_donate_url || '';

    if (toggleShowQr) toggleShowQr.checked = es.show_qr !== undefined ? Boolean(es.show_qr) : true;
    if (toggleShowRecent) toggleShowRecent.checked = es.show_recent_donations !== undefined ? Boolean(es.show_recent_donations) : true;
    if (toggleShowLive) toggleShowLive.checked = es.show_live_indicator !== undefined ? Boolean(es.show_live_indicator) : true;
    if (toggleShowGoal) toggleShowGoal.checked = es.show_goal !== undefined ? Boolean(es.show_goal) : true;

    if (stageMessageInput) stageMessageInput.value = es.stage_message || '';
    if (toggleStageMessageVisible) toggleStageMessageVisible.checked = Boolean(es.stage_message_visible);

    // 3. Donations
    askTiersData = Array.isArray(data.ask_tiers) ? data.ask_tiers : [];
    renderAskTiersRows();

    if (guardrailThresholdInput) guardrailThresholdInput.value = Math.floor((es.major_gift_threshold_cents || 950000) / 100);
    if (stagingDelayInput) stagingDelayInput.value = Math.floor((es.stage_delay_ms || 0) / 1000);

    if (toggleMatchActive) toggleMatchActive.checked = Boolean(es.is_match_active);
    if (matchTitleInput) matchTitleInput.value = es.match_sponsor_title || '';
    if (matchPoolInput) matchPoolInput.value = Math.floor((es.match_total_cents || 0) / 100);

    // 4. Connections (Bloomerang)
    if (bloomerangKeyInput) {
      if (data.has_bloomerang_api_key) {
        bloomerangKeyInput.value = data.bloomerang_key_masked || '••••••••••••••';
      } else {
        bloomerangKeyInput.value = '';
      }
    }
    updateConnectionStatus(data.has_bloomerang_api_key, es.bloomerang_last_sync_at, es.bloomerang_last_error);

    // 5. Features
    if (toggleFeatureTimer) toggleFeatureTimer.checked = Boolean(es.feature_timer);
    if (toggleFeatureCard) toggleFeatureCard.checked = Boolean(es.feature_card_number);
    if (toggleFeatureTable) toggleFeatureTable.checked = Boolean(es.feature_table_number);

    // 6. Access
    if (controlPinInput) controlPinInput.value = '';
    if (entryPinInput) entryPinInput.value = '';
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
    if (btnAddMilestone) {
      btnAddMilestone.addEventListener('click', () => {
        milestonesData.push({
          cents: 5000000,
          label: 'New Milestone'
        });
        renderMilestonesRows();
      });
    }
  }

  function renderMilestonesRows() {
    if (!milestonesTbody) return;
    milestonesTbody.innerHTML = milestonesData.map((m, idx) => {
      const dollars = Math.floor((m.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="number" class="form-input-text milestone-dollars" value="${dollars}" min="0" style="padding: 4px 8px; font-size: var(--text-xs);">
          </td>
          <td>
            <input type="text" class="form-input-text milestone-label" value="${escapeHTML(m.label || '')}" style="padding: 4px 8px; font-size: var(--text-xs);">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-milestone="${idx}" title="Remove milestone">&#x2715;</button>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row events
    milestonesTbody.querySelectorAll('.milestone-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        const val = parseInt(inp.value || '0', 10);
        milestonesData[idx].cents = val * 100;
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
    if (btnAddTier) {
      btnAddTier.addEventListener('click', () => {
        askTiersData.push({
          cents: 100000,
          label: '$1,000'
        });
        renderAskTiersRows();
      });
    }
  }

  function renderAskTiersRows() {
    if (!askTiersTbody) return;
    askTiersTbody.innerHTML = askTiersData.map((t, idx) => {
      const dollars = Math.floor((t.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="number" class="form-input-text tier-dollars" value="${dollars}" min="1" style="padding: 4px 8px; font-size: var(--text-xs);">
          </td>
          <td>
            <input type="text" class="form-input-text tier-label" value="${escapeHTML(t.label || `$${dollars.toLocaleString('en-US')}`)}" style="padding: 4px 8px; font-size: var(--text-xs);">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-tier="${idx}" title="Remove ask tier">&#x2715;</button>
          </td>
        </tr>
      `;
    }).join('');

    askTiersTbody.querySelectorAll('.tier-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        const val = parseInt(inp.value || '0', 10);
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
    if (btnToggleKeyView && bloomerangKeyInput) {
      btnToggleKeyView.addEventListener('click', () => {
        const isPassword = bloomerangKeyInput.type === 'password';
        bloomerangKeyInput.type = isPassword ? 'text' : 'password';
        btnToggleKeyView.textContent = isPassword ? 'Hide' : 'Show';
      });
    }
  }

  // --- Test Connection ---
  function setupTestConnection() {
    if (btnTestConnection) {
      btnTestConnection.addEventListener('click', async () => {
        clearBanners();
        btnTestConnection.textContent = 'Testing...';

        const enteredKey = bloomerangKeyInput?.value?.trim() || '';
        try {
          const res = await fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'test_bloomerang',
              api_key: enteredKey.startsWith('••••') ? undefined : enteredKey
            })
          });

          const data = await res.json();
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
  }

  // --- Save Handlers ---
  function setupSaveHandlers() {
    if (btnSaveTop) btnSaveTop.addEventListener('click', handleSaveSettings);
    if (btnSaveBottom) btnSaveBottom.addEventListener('click', handleSaveSettings);
  }

  function setupReloadConflict() {
    if (btnReloadConflict) {
      btnReloadConflict.addEventListener('click', () => {
        clearBanners();
        loadSettings();
      });
    }
  }

  async function handleSaveSettings() {
    clearBanners();

    // 1. PIN Validation (Min length 4, no empty values)
    const newControlPin = controlPinInput?.value?.trim();
    const newEntryPin = entryPinInput?.value?.trim();

    if (newControlPin !== undefined && newControlPin !== '') {
      if (newControlPin.length < 4 || newControlPin.length > 12) {
        showError('Control PIN must be between 4 and 12 characters.');
        if (controlPinInput) controlPinInput.focus();
        return;
      }
    }

    if (newEntryPin !== undefined && newEntryPin !== '') {
      if (newEntryPin.length < 4 || newEntryPin.length > 12) {
        showError('Volunteer Pad PIN must be between 4 and 12 characters.');
        if (entryPinInput) entryPinInput.focus();
        return;
      }
    }

    // Prepare payload
    const goalDollars = parseInt(goalDollarsInput?.value || '500000', 10);
    const guardrailDollars = parseInt(guardrailThresholdInput?.value || '9500', 10);
    const stagingSec = parseInt(stagingDelayInput?.value || '0', 10);
    const matchPoolDollars = parseInt(matchPoolInput?.value || '0', 10);

    const payload = {
      action: 'update_settings',
      settings_seq: currentSettingsSeq,

      // Event
      event_name: eventNameInput?.value?.trim() || undefined,
      event_subtitle: eventSubtitleInput?.value?.trim() || undefined,
      goal_cents: goalDollars * 100,
      trust_badge_text: trustBadgeInput?.value?.trim() || undefined,
      milestones: milestonesData,

      // Display
      background_style: bgStyleSelect?.value || 'plain',
      bar_color: barColorInput?.value?.trim() || '',
      logo_url: logoUrlInput?.value?.trim() || '',
      qr_donate_url: qrUrlInput?.value?.trim() || '',
      show_qr: Boolean(toggleShowQr?.checked),
      show_recent_donations: Boolean(toggleShowRecent?.checked),
      show_live_indicator: Boolean(toggleShowLive?.checked),
      show_goal: Boolean(toggleShowGoal?.checked),
      stage_message: stageMessageInput?.value?.trim() || '',
      stage_message_visible: Boolean(toggleStageMessageVisible?.checked),

      // Donations
      ask_tiers: askTiersData,
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

    // Bloomerang key (only send if not masked bullet string)
    const bloomKey = bloomerangKeyInput?.value?.trim();
    if (bloomKey && !bloomKey.startsWith('••••') && !bloomKey.startsWith('...')) {
      payload.bloomerang_api_key = bloomKey;
    }

    // Access PINs
    if (newControlPin) payload.control_pin = newControlPin;
    if (newEntryPin) payload.entry_pin = newEntryPin;

    try {
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 409) {
        const conflictData = await res.json().catch(() => ({}));
        showError(conflictData.message || 'Settings have been modified in another session. Please reload before saving.', true);
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        showError(errData.message || 'Failed to save settings.');
        return;
      }

      const resData = await res.json();
      currentSettingsSeq = resData.state?.settings_seq || (currentSettingsSeq + 1);
      showSuccess('Settings saved successfully.');
      populateForm(resData.state);
    } catch (err) {
      console.error('[Givebar Settings] Save error:', err);
      showError('Network error saving settings.');
    }
  }

  // --- Banner Helpers (Real Error Surface) ---
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
