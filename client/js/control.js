/**
 * Givebar — Event Control Room Controller
 * 3-Tab Operational Layout, Live Settings Management, Countdown Appeal Timer, QR Customizer, Pin & Anonymity Tools
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let controlPin = sessionStorage.getItem('givebar_control_pin') || '9999';
  let isFrozen = false;
  let hasPopulatedInputs = false;
  let activeModalCallback = null;
  let selectedThemePreset = 'champagne';
  let selectedThemeHue = 85;
  let selectedQrStyle = 'dots';
  let selectedQrBadge = 'star';
  let latestEventState = null;

  function init() {
    setupTabs();
    setupSwatches();
    setupQrCustomizer();
    setupTimerControls();
    setupTransportActions();
    setupRehearsalActions();
    setupSettingsForm();
    setupModalListeners();

    startPolling();
  }

  // --- API Helper ---
  async function postControl(payload) {
    try {
      const res = await fetch(`${API_BASE}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': controlPin
        },
        body: JSON.stringify({ ...payload, pin: controlPin })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Action failed' }));
        showNotification(err.message || 'Action failed', true);
        return null;
      }
      return await res.json();
    } catch {
      showNotification('Network error communicating with Givebar server.', true);
      return null;
    }
  }

  function showNotification(msg, isError = false) {
    const banner = document.getElementById('drift-banner');
    const desc = document.getElementById('drift-desc');
    if (banner && desc && isError) {
      desc.textContent = msg;
      banner.style.display = 'block';
    }
  }

  // --- Tab Navigation ---
  function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-bar .tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tabKey = btn.getAttribute('data-tab');
        document.getElementById('tab-pane-queue').style.display = tabKey === 'queue' ? 'block' : 'none';
        document.getElementById('tab-pane-donations').style.display = tabKey === 'donations' ? 'block' : 'none';
        document.getElementById('tab-pane-setup').style.display = tabKey === 'setup' ? 'block' : 'none';
      });
    });
  }

  // --- Theme Swatches ---
  function setupSwatches() {
    const swatches = document.querySelectorAll('.theme-swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        selectedThemePreset = swatch.getAttribute('data-preset') || 'champagne';
        selectedThemeHue = parseFloat(swatch.getAttribute('data-hue') || '85');

        // Apply locally to preview immediately
        document.documentElement.style.setProperty('--brand-hue', selectedThemeHue);
      });
    });
  }

  // --- QR Customizer & Live Preview ---
  function setupQrCustomizer() {
    const urlInput = document.getElementById('input-set-qr-url');

    function updateQrPreview() {
      const previewImg = document.getElementById('qr-customizer-preview');
      if (!previewImg) return;
      const url = (urlInput ? urlInput.value : '').trim() || 'https://give.hope.org/donate';
      previewImg.src = `${API_BASE}/qr?url=${encodeURIComponent(url)}&v=4.2.0`;
    }

    if (urlInput) {
      urlInput.addEventListener('input', () => {
        updateQrPreview();
      });
    }
  }

  // --- Countdown Appeal Timer Controls ---
  function setupTimerControls() {
    const toggleBtn = document.getElementById('btn-timer-toggle');
    const resetBtn = document.getElementById('btn-timer-reset');
    const addBtns = document.querySelectorAll('[data-timer-add]');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', async () => {
        const isRunning = latestEventState && latestEventState.timer_status === 'running';
        if (isRunning) {
          await postControl({ action: 'pause_timer' });
        } else {
          await postControl({ action: 'start_timer' });
        }
        pollState();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        await postControl({ action: 'reset_timer', seconds: 300 });
        pollState();
      });
    }

    addBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const addSec = parseInt(btn.getAttribute('data-timer-add') || '60', 10);
        await postControl({ action: 'add_timer_time', seconds: addSec });
        pollState();
      });
    });
  }

  function renderCountdownClock(state) {
    if (!state) return;
    const timerDisplay = document.getElementById('ctrl-timer-display');
    const timerBadge = document.getElementById('ctrl-timer-badge');
    const toggleBtn = document.getElementById('btn-timer-toggle');

    let remainingSeconds = state.countdown_seconds || 300;
    if (state.timer_status === 'running' && state.timer_ends_at) {
      remainingSeconds = Math.max(0, Math.ceil((state.timer_ends_at - Date.now()) / 1000));
    }

    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (timerDisplay) {
      timerDisplay.textContent = formatted;
      if (remainingSeconds <= 10 && state.timer_status === 'running') {
        timerDisplay.style.color = 'var(--color-danger)';
      } else if (remainingSeconds <= 60 && state.timer_status === 'running') {
        timerDisplay.style.color = 'var(--color-warning)';
      } else {
        timerDisplay.style.color = 'var(--ink-primary)';
      }
    }

    if (timerBadge) {
      if (state.timer_status === 'running') {
        timerBadge.className = 'badge badge-live';
        timerBadge.textContent = 'RUNNING';
      } else if (state.timer_status === 'paused') {
        timerBadge.className = 'badge badge-staged';
        timerBadge.textContent = 'PAUSED';
      } else {
        timerBadge.className = 'badge badge-held';
        timerBadge.textContent = 'STOPPED';
      }
    }

    if (toggleBtn) {
      if (state.timer_status === 'running') {
        toggleBtn.innerHTML = `
          <svg class="icon" viewBox="0 0 256 256"><path d="M208,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h32A16,16,0,0,1,208,48ZM96,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg>
          Pause Clock
        `;
        toggleBtn.className = 'btn-secondary';
      } else {
        toggleBtn.innerHTML = `
          <svg class="icon" viewBox="0 0 256 256"><path d="M232.4,114.49,88.32,26.35A16,16,0,0,0,64,40.2V215.8a16,16,0,0,0,24.32,13.85L232.4,141.51A16,16,0,0,0,232.4,114.49ZM80,215.8V40.2L224,128Z"/></svg>
          Start Clock
        `;
        toggleBtn.className = 'btn-primary';
      }
    }
  }

  // --- Modal Engine (Accessible, Non-Blocking, Phosphor Icons) ---
  function showModal({ iconHtml = '', title, desc, hasInput = false, inputPlaceholder = '', confirmText = 'Confirm', isDanger = false, onConfirm }) {
    const modal = document.getElementById('cockpit-modal');
    const iconEl = document.getElementById('cockpit-modal-icon');
    const titleEl = document.getElementById('cockpit-modal-title');
    const descEl = document.getElementById('cockpit-modal-desc');
    const inputWrap = document.getElementById('cockpit-modal-input-wrap');
    const inputEl = document.getElementById('cockpit-modal-input');
    const confirmBtn = document.getElementById('btn-cockpit-confirm');

    if (!modal) return;

    if (iconEl && iconHtml) iconEl.innerHTML = iconHtml;
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;

    if (hasInput && inputWrap && inputEl) {
      inputWrap.style.display = 'block';
      inputEl.value = '';
      inputEl.placeholder = inputPlaceholder;
      setTimeout(() => inputEl.focus(), 50);
    } else if (inputWrap) {
      inputWrap.style.display = 'none';
    }

    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
    }

    activeModalCallback = onConfirm;
    modal.style.display = 'flex';
  }

  function hideModal() {
    const modal = document.getElementById('cockpit-modal');
    if (modal) modal.style.display = 'none';
    activeModalCallback = null;
  }

  function setupModalListeners() {
    const confirmBtn = document.getElementById('btn-cockpit-confirm');
    const cancelBtn = document.getElementById('btn-cockpit-cancel');
    const inputEl = document.getElementById('cockpit-modal-input');

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        const val = inputEl ? inputEl.value : '';
        if (activeModalCallback) activeModalCallback(val);
        hideModal();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', hideModal);
    }

    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (confirmBtn) confirmBtn.click();
        } else if (e.key === 'Escape') {
          hideModal();
        }
      });
    }
  }

  // --- Transport Actions ---
  function setupTransportActions() {
    const freezeBtn = document.getElementById('btn-toggle-freeze');
    const confettiBtn = document.getElementById('btn-fire-confetti');
    const resyncOdometerBtn = document.getElementById('btn-resync-odometer');
    const overrideBtn = document.getElementById('btn-set-override');
    const reconcileBtn = document.getElementById('btn-reconcile-resync');
    const wipeBtn = document.getElementById('btn-wipe-ledger');

    if (freezeBtn) {
      freezeBtn.addEventListener('click', async () => {
        const action = isFrozen ? 'unfreeze' : 'freeze';
        await postControl({ action });
        pollState();
      });
    }

    if (confettiBtn) {
      confettiBtn.addEventListener('click', async () => {
        await postControl({ action: 'trigger_confetti' });
        confettiBtn.textContent = 'Confetti Fired!';
        setTimeout(() => {
          confettiBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 256 256"><path d="M216.49,104.49l-64,64a8,8,0,0,1-11.32,0L98.34,125.66a8,8,0,0,1,0-11.32l64-64a8,8,0,0,1,11.32,0l42.83,42.83A8,8,0,0,1,216.49,104.49ZM88,56A8,8,0,0,0,80,48H32a8,8,0,0,0,0,16H80A8,8,0,0,0,88,56Zm136,136H176a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16ZM56,96a8,8,0,0,0-8-8,8,8,0,0,0-8,8v48a8,8,0,0,0,16,0ZM192,208a8,8,0,0,0-8,8v16a8,8,0,0,0,16,0V216A8,8,0,0,0,192,208Z"/></svg>
            Launch Stage Confetti
          `;
        }, 1500);
      });
    }

    if (resyncOdometerBtn) {
      resyncOdometerBtn.addEventListener('click', () => {
        showModal({
          iconHtml: '<svg class="icon" viewBox="0 0 256 256"><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h30.82l-24.35-24.35A88,88,0,1,0,216,128a8,8,0,0,1,16,0,104,104,0,1,1-35.08-78.53L224,76.69V48a8,8,0,0,1,16,0Z"/></svg>',
          title: 'Resync Ballroom Screen Total',
          desc: 'This resets the stage odometer floor directly to match the verified total raised in the ledger.',
          confirmText: 'Yes, Resync Screen Total',
          onConfirm: async () => {
            await postControl({ action: 'resync_odometer' });
            pollState();
          }
        });
      });
    }

    if (reconcileBtn) {
      reconcileBtn.addEventListener('click', async () => {
        showModal({
          iconHtml: '<svg class="icon" viewBox="0 0 256 256"><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h30.82l-24.35-24.35A88,88,0,1,0,216,128a8,8,0,0,1,16,0,104,104,0,1,1-35.08-78.53L224,76.69V48a8,8,0,0,1,16,0Z"/></svg>',
          title: 'Resolve Ballroom Drift?',
          desc: 'This aligns the ballroom screen total directly with the verified ledger total.',
          confirmText: 'Align Screen with Ledger',
          onConfirm: async () => {
            await postControl({ action: 'resync_odometer' });
            pollState();
          }
        });
      });
    }

    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        showModal({
          iconHtml: '<svg class="icon" viewBox="0 0 256 256"><path d="M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.32,96A16,16,0,0,0,227.32,73.37ZM48,163.31l88-88L180.69,120l-88,88H48ZM216,84.69,192,108.69,147.31,64,171.31,40Z"/></svg>',
          title: 'Adjust Ballroom Screen Total',
          desc: 'Enter an override dollar amount for the stage display (leave blank to clear override):',
          hasInput: true,
          inputPlaceholder: 'e.g. 500000 (or leave blank to clear)',
          confirmText: 'Set Screen Total',
          onConfirm: async (val) => {
            const trimmed = val ? val.trim().replace(/[^0-9.]/g, '') : '';
            if (trimmed) {
              const cents = Math.round(parseFloat(trimmed) * 100);
              await postControl({ action: 'set_override', override_cents: cents });
            } else {
              await postControl({ action: 'clear_override' });
            }
            pollState();
          }
        });
      });
    }

    if (wipeBtn) {
      wipeBtn.addEventListener('click', () => {
        showModal({
          iconHtml: '<svg class="icon" viewBox="0 0 256 256"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"/></svg>',
          title: 'Reset All Event Data?',
          desc: 'Type WIPE to permanently delete all test pledges and reset the ledger for a fresh gala night:',
          hasInput: true,
          inputPlaceholder: 'Type WIPE to confirm',
          confirmText: 'Permanently Wipe Data',
          isDanger: true,
          onConfirm: async (val) => {
            if (val === 'WIPE') {
              await postControl({ action: 'reset_ledger', confirm_wipe: true });
              pollState();
            } else {
              alert('Reset cancelled. You must type WIPE exactly.');
            }
          }
        });
      });
    }
  }

  // --- Tech Rehearsal Actions ---
  function setupRehearsalActions() {
    const simBtns = document.querySelectorAll('[data-sim]');
    simBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-sim');
        try {
          await fetch(`${API_BASE}/rehearsal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          pollState();
        } catch {
          // Ignore
        }
      });
    });
  }

  // --- Settings Form Submission ---
  function setupSettingsForm() {
    const saveBtn = document.getElementById('btn-save-all-settings');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const titleInput = document.getElementById('input-set-title');
      const subtitleInput = document.getElementById('input-set-subtitle');
      const trustBadgeInput = document.getElementById('input-set-trust-badge');
      const visualModeSelect = document.getElementById('input-set-visual-mode');
      const mediaUrlInput = document.getElementById('input-set-media-url');
      const goalInput = document.getElementById('input-set-goal');
      const matchActiveInput = document.getElementById('input-set-match-active');
      const matchPoolInput = document.getElementById('input-set-match-pool');
      const matchRatioInput = document.getElementById('input-set-match-ratio');
      const matchSponsorInput = document.getElementById('input-set-match-sponsor');
      const qrUrlInput = document.getElementById('input-set-qr-url');
      const controlPinInput = document.getElementById('input-set-control-pin');
      const entryPinInput = document.getElementById('input-set-entry-pin');

      const payload = {
        action: 'update_settings',
        event_name: titleInput ? titleInput.value.trim() : 'Annual Gala & Benefit Auction',
        event_subtitle: subtitleInput ? subtitleInput.value.trim() : 'Supporting Community Programs & Education',
        trust_badge_text: trustBadgeInput ? trustBadgeInput.value.trim() : '501(c)(3) Tax-Deductible Contribution',
        thermometer_visual_mode: visualModeSelect ? visualModeSelect.value : 'classic',
        embed_media_url: mediaUrlInput ? mediaUrlInput.value.trim() : '',
        goal_cents: goalInput ? Math.round(parseFloat(goalInput.value || '500000') * 100) : 50000000,
        theme_preset: selectedThemePreset,
        brand_hue: selectedThemeHue,
        qr_donate_url: qrUrlInput ? qrUrlInput.value.trim() : 'https://give.hope.org/donate',
        is_match_active: matchActiveInput ? matchActiveInput.checked : false,
        match_total_cents: matchPoolInput ? Math.round(parseFloat(matchPoolInput.value || '0') * 100) : 0,
        match_ratio: matchRatioInput ? parseFloat(matchRatioInput.value || '1.0') : 1.0,
        match_sponsor_title: matchSponsorInput ? matchSponsorInput.value.trim() : 'Board of Directors Matching Grant'
      };

      if (controlPinInput && controlPinInput.value.trim()) {
        controlPin = controlPinInput.value.trim();
        sessionStorage.setItem('givebar_control_pin', controlPin);
      }

      saveBtn.textContent = 'Saving Settings...';
      const res = await postControl(payload);
      if (res && res.ok) {
        saveBtn.innerHTML = `
          <svg class="icon" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>
          Settings Saved!
        `;
        saveBtn.style.background = 'var(--color-success)';
        setTimeout(() => {
          saveBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>
            Save Event Settings
          `;
          saveBtn.style.background = '';
        }, 2000);
        pollState();
      } else {
        saveBtn.textContent = 'Save Event Settings';
      }
    });
  }

  // --- State Polling & UI Rendering ---
  async function pollState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=control&pin=${encodeURIComponent(controlPin)}`, {
        headers: { 'X-Control-Pin': controlPin }
      });
      if (!res.ok) return;
      const data = await res.json();

      latestEventState = data.event_state;

      // 1. Update Title Header
      const headerTitle = document.getElementById('event-name-sub');
      if (headerTitle && data.event_state?.event_name) {
        headerTitle.textContent = `${data.event_state.event_name} • ${data.event_state.event_subtitle || ''}`;
      }

      // 2. Metrics & Drift Banner
      renderMetrics(data);

      // 3. Countdown Clock
      renderCountdownClock(data.event_state);

      // 4. Staging Queue (Tab 1)
      if (Array.isArray(data.staged_chyrons)) {
        renderQueue(data.staged_chyrons, data.event_state?.pinned_donation_id);
      }

      // 5. Verified Ledger Audit Log (Tab 2)
      if (Array.isArray(data.recent_events)) {
        renderAuditLog(data.recent_events);
      }
      // 1. Update Title Header & Export Link
      const csvLink = document.getElementById('link-export-csv');
      if (csvLink) {
        csvLink.href = `${API_BASE}/export/csv?pin=${encodeURIComponent(controlPin)}`;
      }

      if (!hasPopulatedInputs && data.event_state) {
        populateSettingsInputs(data.event_state);
        hasPopulatedInputs = true;
      }
    } catch {
      // Network hiccup, retry next tick
    }
  }

  function renderMetrics(data) {
    const totalRaisedEl = document.getElementById('ctrl-total-raised');
    const directRaisedEl = document.getElementById('ctrl-direct-raised');
    const matchAppliedEl = document.getElementById('ctrl-match-applied');
    const goalProgressEl = document.getElementById('ctrl-goal-progress');
    const activeCountEl = document.getElementById('ctrl-active-count');
    const matchStatusEl = document.getElementById('ctrl-match-status');
    const displayStatusEl = document.getElementById('ctrl-display-status');
    const freezeBtn = document.getElementById('btn-toggle-freeze');
    const driftBanner = document.getElementById('drift-banner');
    const driftDesc = document.getElementById('drift-desc');

    const totalCents = data.folded?.total_raised_cents || 0;
    const directCents = data.folded?.direct_raised_cents || 0;
    const matchCents = data.folded?.match_applied_cents || 0;
    const goalCents = data.event_state?.goal_cents || 50000000;

    if (totalRaisedEl) totalRaisedEl.textContent = `$${Math.floor(totalCents / 100).toLocaleString('en-US')}`;
    if (directRaisedEl) directRaisedEl.textContent = `$${Math.floor(directCents / 100).toLocaleString('en-US')}`;
    if (matchAppliedEl) matchAppliedEl.textContent = `$${Math.floor(matchCents / 100).toLocaleString('en-US')}`;

    const percent = goalCents > 0 ? Math.min(100, Math.round((totalCents / goalCents) * 100)) : 0;
    if (goalProgressEl) goalProgressEl.textContent = `${percent}% of $${Math.floor(goalCents / 100).toLocaleString('en-US')} goal`;

    if (activeCountEl) activeCountEl.textContent = `${data.folded?.active_donation_count || 0} verified gifts`;

    if (matchStatusEl) {
      matchStatusEl.textContent = data.event_state?.is_match_active ? 'Match Active (Doubling)' : 'Match Inactive';
      matchStatusEl.style.color = data.event_state?.is_match_active ? 'var(--color-success)' : 'var(--ink-muted)';
    }

    isFrozen = Boolean(data.event_state?.is_frozen);
    if (displayStatusEl) {
      displayStatusEl.innerHTML = isFrozen
        ? '<span style="color: var(--color-danger);"><svg class="icon" viewBox="0 0 256 256"><path d="M208,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h32A16,16,0,0,1,208,48ZM96,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg> PAUSED</span>'
        : '<span style="color: var(--color-success);"><span class="pulse-dot"></span> LIVE ON-AIR</span>';
    }
    if (freezeBtn) {
      freezeBtn.innerHTML = isFrozen
        ? '<svg class="icon" viewBox="0 0 256 256"><path d="M232.4,114.49,88.32,26.35A16,16,0,0,0,64,40.2V215.8a16,16,0,0,0,24.32,13.85L232.4,141.51A16,16,0,0,0,232.4,114.49ZM80,215.8V40.2L224,128Z"/></svg> Resume Stage Screen'
        : '<svg class="icon" viewBox="0 0 256 256"><path d="M208,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h32A16,16,0,0,1,208,48ZM96,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg> Pause Ballroom Screen';
      freezeBtn.className = isFrozen ? 'btn-primary' : 'btn-secondary';
    }

    // Drift banner check
    if (data.stage_preview && data.stage_preview.is_drifted) {
      const stageDollars = Math.floor(data.stage_preview.stage_total_cents / 100).toLocaleString('en-US');
      const verifiedDollars = Math.floor(data.stage_preview.verified_total_cents / 100).toLocaleString('en-US');
      if (driftDesc) {
        driftDesc.textContent = `Ballroom screen displays $${stageDollars} while true verified ledger total is $${verifiedDollars}.`;
      }
      if (driftBanner) driftBanner.style.display = 'block';
    } else if (driftBanner) {
      driftBanner.style.display = 'none';
    }
  }

  function renderQueue(chyrons, pinnedDonationId) {
    const container = document.getElementById('chyron-queue-container');
    if (!container) return;

    if (chyrons.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--ink-muted); padding: var(--space-10);">
          No recent pledge transactions in buffer.
        </div>
      `;
      return;
    }

    let html = '';
    chyrons.forEach(item => {
      const dollars = Math.floor(item.amount_cents / 100).toLocaleString('en-US');
      const isStaged = !item.is_live_on_stage && !item.is_held;
      const isPinned = item.donation_id === pinnedDonationId;
      
      let rowClass = 'queue-row live';
      if (item.is_held) rowClass = 'queue-row held';
      else if (isStaged) rowClass = 'queue-row staged';
      if (isPinned) rowClass += ' pinned';

      let statusBadge = '';
      let actionBtn = '';

      if (item.is_held) {
        statusBadge = `<span class="badge badge-held"><svg class="icon" viewBox="0 0 256 256"><path d="M208,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h32A16,16,0,0,1,208,48ZM96,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg> HELD</span>`;
        actionBtn = `<button type="button" class="btn-secondary" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarRelease('${item.donation_id}')">Release</button>`;
      } else if (isStaged) {
        statusBadge = `<span class="badge badge-staged"><svg class="icon" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/></svg> REVIEW (${item.remaining_delay_sec}s)</span>`;
        actionBtn = `<button type="button" class="btn-danger" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarHold('${item.donation_id}')">Hold</button>`;
      } else {
        statusBadge = `<span class="badge badge-live"><span class="pulse-dot"></span> ON-AIR</span>`;
        actionBtn = `<button type="button" class="btn-ghost" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarHold('${item.donation_id}')">Remove</button>`;
      }

      const pinBadge = isPinned ? `<span class="badge badge-live">PINNED TOP</span>` : '';
      const pinBtn = `<button type="button" class="btn-secondary" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarPin('${item.donation_id}')">${isPinned ? 'Unpin' : 'Pin'}</button>`;
      const anonBtn = `<button type="button" class="btn-ghost" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarToggleAnon('${item.donation_id}')">${item.is_anonymous ? 'De-Anon' : 'Anon'}</button>`;

      const notesHtml = item.notes ? `<div style="font-size: 11px; color: var(--brand-accent); margin-top: 4px; font-style: italic;">“${escapeHTML(item.notes)}”</div>` : '';

      html += `
        <div class="${rowClass}">
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <div>
              <div style="font-size: var(--text-base); font-weight: 800; color: var(--brand-accent);">$${dollars}</div>
              <div style="font-size: var(--text-xs); color: var(--ink-muted); margin-top: 2px;">Card ${item.card_number || 'N/A'} • Table ${item.table_number || 'N/A'}</div>
            </div>
            <div style="border-left: 1px solid var(--border-subtle); padding-left: var(--space-3);">
              <div style="font-weight: 700; font-size: var(--text-sm);">${escapeHTML(item.donor_name)}</div>
              <div style="font-size: var(--text-xs); color: var(--ink-muted);">Display: "${escapeHTML(item.display_name)}"</div>
              ${notesHtml}
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            ${pinBadge}
            ${statusBadge}
            ${pinBtn}
            ${anonBtn}
            ${actionBtn}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    if (window.renderPhosphorIcons) window.renderPhosphorIcons(container);
  }

  function renderAuditLog(events) {
    const tbody = document.getElementById('ledger-table-body');
    if (!tbody) return;

    if (events.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--ink-muted); padding: var(--space-6);">No ledger events recorded yet.</td></tr>`;
      return;
    }

    let html = '';
    events.forEach(ev => {
      const dollars = `$${Math.floor(ev.amount_cents / 100).toLocaleString('en-US')}`;
      const isMatch = ev.event_type === 'match_apply' || ev.event_type === 'match_release';
      const isVoid = ev.event_type === 'void';

      let actionHtml = '-';
      if (!isMatch && !isVoid) {
        actionHtml = `<button type="button" class="btn-ghost" style="font-size: 11px; padding: 4px 8px;" onclick="window.givebarVoidPrompt('${ev.donation_id}')"><svg class="icon" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg> Void</button>`;
      }

      html += `
        <tr style="${isVoid ? 'opacity: 0.45; text-decoration: line-through;' : ''}">
          <td class="mono" style="font-size: var(--text-xs); color: var(--ink-muted);">#${ev.seq}</td>
          <td><span class="badge ${ev.event_type === 'create' ? 'badge-live' : (ev.event_type === 'void' ? 'badge-held' : 'badge-staged')}">${ev.event_type}</span></td>
          <td class="mono" style="font-weight: 800; color: var(--brand-accent);">${dollars}</td>
          <td style="font-weight: 600;">${escapeHTML(ev.donor_name)}</td>
          <td style="font-size: var(--text-xs); color: var(--ink-muted);">${escapeHTML(ev.display_name || '-')}</td>
          <td>${ev.payment_method}</td>
          <td>${ev.source}</td>
          <td class="mono" style="font-size: var(--text-xs);">${ev.card_number || '-'}</td>
          <td>${ev.entered_by || '-'}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
    if (window.renderPhosphorIcons) window.renderPhosphorIcons(tbody);
  }

  function populateSettingsInputs(state) {
    const titleInput = document.getElementById('input-set-title');
    const subtitleInput = document.getElementById('input-set-subtitle');
    const trustBadgeInput = document.getElementById('input-set-trust-badge');
    const visualModeSelect = document.getElementById('input-set-visual-mode');
    const mediaUrlInput = document.getElementById('input-set-media-url');
    const goalInput = document.getElementById('input-set-goal');
    const matchActiveInput = document.getElementById('input-set-match-active');
    const matchPoolInput = document.getElementById('input-set-match-pool');
    const matchRatioInput = document.getElementById('input-set-match-ratio');
    const matchSponsorInput = document.getElementById('input-set-match-sponsor');
    const qrUrlInput = document.getElementById('input-set-qr-url');

    if (titleInput && state.event_name) titleInput.value = state.event_name;
    if (subtitleInput && state.event_subtitle) subtitleInput.value = state.event_subtitle;
    if (trustBadgeInput && state.trust_badge_text) trustBadgeInput.value = state.trust_badge_text;
    if (visualModeSelect && state.thermometer_visual_mode) visualModeSelect.value = state.thermometer_visual_mode;
    if (mediaUrlInput && state.embed_media_url) mediaUrlInput.value = state.embed_media_url;
    if (goalInput && state.goal_cents) goalInput.value = Math.floor(state.goal_cents / 100);
    if (matchActiveInput) matchActiveInput.checked = Boolean(state.is_match_active);
    if (matchPoolInput && state.match_total_cents) matchPoolInput.value = Math.floor(state.match_total_cents / 100);
    if (matchRatioInput && state.match_ratio) matchRatioInput.value = state.match_ratio;
    if (matchSponsorInput && state.match_sponsor_title) matchSponsorInput.value = state.match_sponsor_title;
    if (qrUrlInput && state.qr_donate_url) qrUrlInput.value = state.qr_donate_url;

    if (state.theme_preset) {
      selectedThemePreset = state.theme_preset;
      document.querySelectorAll('.theme-swatch').forEach(s => {
        s.classList.toggle('active', s.getAttribute('data-preset') === state.theme_preset);
      });
    }

    // Refresh preview
    const previewImg = document.getElementById('qr-customizer-preview');
    if (previewImg && state.qr_donate_url) {
      previewImg.src = `${API_BASE}/qr?url=${encodeURIComponent(state.qr_donate_url)}&v=4.2.0`;
    }
  }

  // Global Action Handlers
  window.givebarHold = async (donationId) => {
    await postControl({ action: 'hold_donation', donation_id: donationId });
    pollState();
  };

  window.givebarRelease = async (donationId) => {
    await postControl({ action: 'release_donation', donation_id: donationId });
    pollState();
  };

  window.givebarPin = async (donationId) => {
    await postControl({ action: 'pin_donation', donation_id: donationId });
    pollState();
  };

  window.givebarToggleAnon = async (donationId) => {
    await postControl({ action: 'toggle_anonymity', donation_id: donationId });
    pollState();
  };

  window.givebarVoidPrompt = (donationId) => {
    showModal({
      iconHtml: '<svg class="icon" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>',
      title: 'Void Donation?',
      desc: 'Enter the reason for voiding this donation from the authoritative ledger:',
      hasInput: true,
      inputPlaceholder: 'Reason (e.g. Card entered with wrong amount)',
      confirmText: 'Confirm Void',
      isDanger: true,
      onConfirm: async (reason) => {
        try {
          await fetch(`${API_BASE}/donation/${donationId}/void`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entered_by: 'CONTROL_ROOM', reason: reason || 'Voided by operator' })
          });
          pollState();
        } catch {
          // Ignore
        }
      }
    });
  };

  function escapeHTML(str) {
    if (!str) return '';
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    pollState();
    setInterval(pollState, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
