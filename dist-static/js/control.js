/**
 * Givebar — Event Control Room Controller
 * 3-Tab Operational Layout, Live Settings Management, QR Customizer, Staging Hold Safety
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

  function init() {
    setupTabs();
    setupSwatches();
    setupQrCustomizer();
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
    const styleBtns = document.querySelectorAll('[data-qr-style]');
    const badgeBtns = document.querySelectorAll('[data-qr-badge]');
    const urlInput = document.getElementById('input-set-qr-url');

    function updateQrPreview() {
      const previewImg = document.getElementById('qr-customizer-preview');
      if (!previewImg) return;
      const url = (urlInput ? urlInput.value : '').trim() || 'https://give.hope.org/donate';
      previewImg.src = `${API_BASE}/qr?url=${encodeURIComponent(url)}&style=${encodeURIComponent(selectedQrStyle)}&center=${encodeURIComponent(selectedQrBadge)}&size=160`;
    }

    styleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        styleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedQrStyle = btn.getAttribute('data-qr-style') || 'dots';
        updateQrPreview();
      });
    });

    badgeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        badgeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedQrBadge = btn.getAttribute('data-qr-badge') || 'star';
        updateQrPreview();
      });
    });

    if (urlInput) {
      urlInput.addEventListener('input', () => {
        updateQrPreview();
      });
    }
  }

  // --- Modal Engine (Accessible, Non-Blocking, Phosphor Icons) ---
  function showModal({ iconHtml = '<i class="ph-bold ph-lightning"></i>', title, desc, hasInput = false, inputPlaceholder = '', confirmText = 'Confirm', isDanger = false, onConfirm }) {
    const modal = document.getElementById('cockpit-modal');
    const iconEl = document.getElementById('cockpit-modal-icon');
    const titleEl = document.getElementById('cockpit-modal-title');
    const descEl = document.getElementById('cockpit-modal-desc');
    const inputWrap = document.getElementById('cockpit-modal-input-wrap');
    const inputEl = document.getElementById('cockpit-modal-input');
    const confirmBtn = document.getElementById('btn-cockpit-confirm');

    if (iconEl) iconEl.innerHTML = iconHtml;
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
    if (modal) modal.style.display = 'flex';
  }

  function setupModalListeners() {
    const modal = document.getElementById('cockpit-modal');
    const confirmBtn = document.getElementById('btn-cockpit-confirm');
    const cancelBtn = document.getElementById('btn-cockpit-cancel');
    const inputEl = document.getElementById('cockpit-modal-input');

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        const val = inputEl ? inputEl.value : '';
        if (modal) modal.style.display = 'none';
        if (activeModalCallback) {
          const cb = activeModalCallback;
          activeModalCallback = null;
          cb(val);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (modal) modal.style.display = 'none';
        activeModalCallback = null;
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
        modal.style.display = 'none';
        activeModalCallback = null;
      }
    });
  }

  // --- Transport Actions ---
  function setupTransportActions() {
    const freezeBtn = document.getElementById('btn-toggle-freeze');
    const confettiBtn = document.getElementById('btn-fire-confetti');
    const resyncBtn = document.getElementById('btn-resync-odometer');
    const reconcileBtn = document.getElementById('btn-reconcile-resync');
    const overrideBtn = document.getElementById('btn-set-override');
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
      });
    }

    const doResync = async () => {
      showModal({
        iconHtml: '<i class="ph-bold ph-arrows-clockwise"></i>',
        title: 'Resync Ballroom Screen Total',
        desc: 'This resets the stage odometer floor directly to match the verified total raised in the ledger.',
        confirmText: 'Yes, Resync Screen Total',
        onConfirm: async () => {
          await postControl({ action: 'resync_odometer' });
          pollState();
        }
      });
    };

    if (resyncBtn) resyncBtn.addEventListener('click', doResync);
    if (reconcileBtn) reconcileBtn.addEventListener('click', doResync);

    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        showModal({
          iconHtml: '<i class="ph-bold ph-pencil-simple"></i>',
          title: 'Adjust Ballroom Screen Total',
          desc: 'Enter an override dollar amount for the stage display (leave blank to clear override):',
          hasInput: true,
          inputPlaceholder: 'e.g. 500000',
          confirmText: 'Set Screen Override',
          onConfirm: async (val) => {
            if (!val || val.trim() === '') {
              await postControl({ action: 'clear_override' });
            } else {
              const dollars = parseInt(val.replace(/[^0-9]/g, ''), 10);
              if (!isNaN(dollars) && dollars >= 0) {
                await postControl({ action: 'set_override', override_cents: dollars * 100 });
              }
            }
            pollState();
          }
        });
      });
    }

    if (wipeBtn) {
      wipeBtn.addEventListener('click', () => {
        showModal({
          iconHtml: '<i class="ph-bold ph-warning"></i>',
          title: 'Reset All Event Data?',
          desc: 'Type WIPE to permanently delete all test pledges and reset the ledger for a fresh gala night:',
          hasInput: true,
          inputPlaceholder: 'Type WIPE to confirm',
          confirmText: 'Reset Event Data',
          isDanger: true,
          onConfirm: async (val) => {
            if (val && val.trim() === 'WIPE') {
              await postControl({ action: 'reset_ledger', confirm_wipe: true });
              pollState();
            }
          }
        });
      });
    }
  }

  // --- Settings Form ---
  function setupSettingsForm() {
    const saveBtn = document.getElementById('btn-save-all-settings');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const title = document.getElementById('input-set-title')?.value || '';
      const subtitle = document.getElementById('input-set-subtitle')?.value || '';
      const goalDollars = parseInt(document.getElementById('input-set-goal')?.value || '500000', 10);
      const matchActive = document.getElementById('input-set-match-active')?.checked || false;
      const matchPool = parseInt(document.getElementById('input-set-match-pool')?.value || '0', 10);
      const matchRatio = parseFloat(document.getElementById('input-set-match-ratio')?.value || '1.0');
      const matchSponsor = document.getElementById('input-set-match-sponsor')?.value || '';
      const qrUrl = document.getElementById('input-set-qr-url')?.value || '';
      const controlPinInput = document.getElementById('input-set-control-pin')?.value || '';
      const entryPinInput = document.getElementById('input-set-entry-pin')?.value || '';

      const settingsPayload = {
        action: 'update_settings',
        event_name: title,
        event_subtitle: subtitle,
        goal_cents: goalDollars * 100,
        qr_donate_url: qrUrl,
        qr_style: selectedQrStyle,
        qr_center_icon: selectedQrBadge,
        theme_preset: selectedThemePreset,
        brand_hue: selectedThemeHue,
        is_match_active: matchActive,
        match_total_cents: matchPool * 100,
        match_ratio: matchRatio,
        match_sponsor_title: matchSponsor
      };

      const res = await postControl(settingsPayload);

      // Update PINs if entered
      if (controlPinInput || entryPinInput) {
        const pinPayload = { action: 'update_pins' };
        if (controlPinInput) {
          pinPayload.control_pin = controlPinInput;
          controlPin = controlPinInput;
          sessionStorage.setItem('givebar_control_pin', controlPin);
        }
        if (entryPinInput) pinPayload.entry_pin = entryPinInput;
        await postControl(pinPayload);
      }

      if (res && res.ok) {
        saveBtn.innerHTML = '<i class="ph-bold ph-check"></i> Settings Saved!';
        saveBtn.style.background = 'var(--color-success)';
        setTimeout(() => {
          saveBtn.innerHTML = '<i class="ph-bold ph-check"></i> Save Event Settings';
          saveBtn.style.background = '';
        }, 2000);
        pollState();
      }
    });
  }

  // --- Rehearsal Simulator Actions ---
  function setupRehearsalActions() {
    document.querySelectorAll('[data-sim]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const simMode = btn.getAttribute('data-sim');
        try {
          const res = await fetch(`${API_BASE}/rehearsal`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Control-Pin': controlPin
            },
            body: JSON.stringify({ mode: simMode, pin: controlPin })
          });
          if (res.ok) {
            pollState();
          }
        } catch {
          // Ignore
        }
      });
    });
  }

  // --- 1-Second Polling & Rendering ---
  async function pollState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=control`);
      if (!res.ok) return;

      const data = await res.json();

      // Render Top Metrics
      renderMetrics(data);

      // Render Staging Queue
      renderQueue(data.staged_chyrons || []);

      // Render Audit Log
      renderAuditLog(data.recent_events || []);

      // Populate Settings inputs once
      if (!hasPopulatedInputs && data.event_state) {
        populateSettingsInputs(data.event_state);
        hasPopulatedInputs = true;
      }

    } catch {
      // Ignore network hiccup
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
        ? '<span style="color: var(--color-danger);"><i class="ph-bold ph-pause"></i> PAUSED</span>'
        : '<span style="color: var(--color-success);"><span class="pulse-dot"></span> LIVE ON-AIR</span>';
    }
    if (freezeBtn) {
      freezeBtn.innerHTML = isFrozen ? '<i class="ph-bold ph-play"></i> Resume Stage Screen' : '<i class="ph-bold ph-pause"></i> Pause Ballroom Screen';
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

  function renderQueue(chyrons) {
    const container = document.getElementById('chyron-queue-container');
    if (!container) return;

    if (chyrons.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--ink-muted); padding: var(--space-8);">
          No recent pledge transactions in buffer.
        </div>
      `;
      return;
    }

    let html = '';
    chyrons.forEach(item => {
      const dollars = Math.floor(item.amount_cents / 100).toLocaleString('en-US');
      const isStaged = !item.is_live_on_stage && !item.is_held;
      const rowClass = item.is_held ? 'queue-row held' : (isStaged ? 'queue-row staged' : 'queue-row live');

      let statusBadge = '';
      let actionBtn = '';

      if (item.is_held) {
        statusBadge = `<span class="badge badge-held"><i class="ph-bold ph-pause"></i> HELD</span>`;
        actionBtn = `<button type="button" class="btn-secondary" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarRelease('${item.donation_id}')"><i class="ph-bold ph-play"></i> Release to Stage</button>`;
      } else if (isStaged) {
        statusBadge = `<span class="badge badge-staged"><i class="ph-bold ph-clock"></i> REVIEW (${item.remaining_delay_sec}s)</span>`;
        actionBtn = `<button type="button" class="btn-danger" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarHold('${item.donation_id}')"><i class="ph-bold ph-hand"></i> Hold from Stage</button>`;
      } else {
        statusBadge = `<span class="badge badge-live"><span class="pulse-dot"></span> ON-AIR</span>`;
        actionBtn = `<button type="button" class="btn-ghost" style="min-height: 38px; padding: var(--space-1) var(--space-3); font-size: var(--text-xs);" onclick="window.givebarHold('${item.donation_id}')"><i class="ph-bold ph-x"></i> Remove</button>`;
      }

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
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: var(--space-3);">
            ${statusBadge}
            ${actionBtn}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
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
        actionHtml = `<button type="button" class="btn-ghost" style="font-size: 11px; padding: 4px 8px;" onclick="window.givebarVoidPrompt('${ev.donation_id}')"><i class="ph-bold ph-trash"></i> Void</button>`;
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
  }

  function populateSettingsInputs(state) {
    const titleInput = document.getElementById('input-set-title');
    const subtitleInput = document.getElementById('input-set-subtitle');
    const goalInput = document.getElementById('input-set-goal');
    const matchActiveInput = document.getElementById('input-set-match-active');
    const matchPoolInput = document.getElementById('input-set-match-pool');
    const matchRatioInput = document.getElementById('input-set-match-ratio');
    const matchSponsorInput = document.getElementById('input-set-match-sponsor');
    const qrUrlInput = document.getElementById('input-set-qr-url');

    if (titleInput && state.event_name) titleInput.value = state.event_name;
    if (subtitleInput && state.event_subtitle) subtitleInput.value = state.event_subtitle;
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

    if (state.qr_style) {
      selectedQrStyle = state.qr_style;
      document.querySelectorAll('[data-qr-style]').forEach(s => {
        s.classList.toggle('active', s.getAttribute('data-qr-style') === state.qr_style);
      });
    }

    if (state.qr_center_icon) {
      selectedQrBadge = state.qr_center_icon;
      document.querySelectorAll('[data-qr-badge]').forEach(s => {
        s.classList.toggle('active', s.getAttribute('data-qr-badge') === state.qr_center_icon);
      });
    }

    // Refresh preview
    const previewImg = document.getElementById('qr-customizer-preview');
    if (previewImg && state.qr_donate_url) {
      previewImg.src = `${API_BASE}/qr?url=${encodeURIComponent(state.qr_donate_url)}&style=${encodeURIComponent(state.qr_style || 'dots')}&center=${encodeURIComponent(state.qr_center_icon || 'star')}&size=160`;
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

  window.givebarVoidPrompt = (donationId) => {
    showModal({
      iconHtml: '<i class="ph-bold ph-trash"></i>',
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
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    pollState();
    setInterval(pollState, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
