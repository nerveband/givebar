/**
 * Givebar — Add Donation Controller
 * Single-screen pledge entry, direct numeric input (desktop) + 56px thumb keypad (mobile),
 * accessible Anonymous switch with confirmation modal, dynamic 7-tier presets from Settings,
 * inline recent entries with delivery state & row-level undo, guarded offline outbox.
 */

(function () {
  'use strict';

  // State
  let volunteerId = localStorage.getItem('givebar_volunteer_id');
  if (!volunteerId) {
    volunteerId = `User-${Math.floor(Math.random() * 899 + 100)}`;
    localStorage.setItem('givebar_volunteer_id', volunteerId);
  }

  let currentAmountCents = 50000; // $500 default
  let isAnonymousState = false;
  let majorGiftThresholdCents = 950000; // $9,500
  let isFlushing = false;
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');
  let sessionRecentEntries = JSON.parse(localStorage.getItem('givebar_session_entries') || '[]');
  let pendingMajorGiftPayload = null;
  let pendingAnonTargetState = false;

  // DOM Elements
  const amountInput = document.getElementById('amount-numeric-input');
  const presetGrid = document.getElementById('preset-grid');
  const donorNameInput = document.getElementById('donor-name-input');
  const donorPhoneticInput = document.getElementById('donor-phonetic-input');
  const cardNumberInput = document.getElementById('card-number-input');
  const tableNumberInput = document.getElementById('table-number-input');
  const fieldCardWrap = document.getElementById('field-card-number-wrap');
  const fieldTableWrap = document.getElementById('field-table-number-wrap');
  const btnTogglePronunciation = document.getElementById('btn-toggle-pronunciation');
  const pronunciationToggleLabel = document.getElementById('pronunciation-toggle-label');
  const fieldDonorPhoneticWrap = document.getElementById('field-donor-phonetic-wrap');
  const mobileKeypad = document.getElementById('mobile-keypad');
  const btnSubmit = document.getElementById('btn-submit-add');
  const errorBanner = document.getElementById('add-error-banner');
  const outboxStatus = document.getElementById('outbox-status');
  const outboxCount = document.getElementById('outbox-count');
  const recentEntriesList = document.getElementById('recent-entries-list');
  const recentCountLabel = document.getElementById('recent-count-label');

  // Anonymous Switch Elements
  const anonSwitchContainer = document.getElementById('anon-switch-container');
  const anonSwitchBtn = document.getElementById('anon-switch-btn');
  const anonStatusPill = document.getElementById('anon-status-pill');

  // Anonymous Confirm Modal Elements
  const anonConfirmModal = document.getElementById('anon-confirm-modal');
  const anonDialogTitle = document.getElementById('anon-dialog-title');
  const anonDialogBody = document.getElementById('anon-dialog-body');
  const btnCancelAnon = document.getElementById('btn-cancel-anon');
  const btnConfirmAnon = document.getElementById('btn-confirm-anon');

  // Guardrail Modal Elements
  const guardrailModal = document.getElementById('major-gift-modal');
  const guardrailBody = document.getElementById('guardrail-body');
  const btnCancelGuardrail = document.getElementById('btn-cancel-guardrail');
  const btnConfirmGuardrail = document.getElementById('btn-confirm-guardrail');

  function init() {
    setupAmountInputs();
    setupPresets();
    setupMobileKeypad();
    setupAnonymousSwitch();
    setupPronunciationDisclosure();
    setupSubmission();
    setupGuardrailModal();
    updateUI();
    renderRecentEntries();
    updateOutboxIndicator();

    // Data sync
    fetchState();
    setInterval(fetchState, 3000);
    setInterval(flushOutbox, 3000);
  }

  // --- State Sync (Features & 7-tier Ask Tiers) ---
  async function fetchState() {
    try {
      const res = await fetch('/api/state?role=entry', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.major_gift_threshold_cents) {
        majorGiftThresholdCents = data.major_gift_threshold_cents;
      }

      // Feature flags
      if (fieldCardWrap) {
        fieldCardWrap.style.display = data.feature_card_number ? 'block' : 'none';
      }
      if (fieldTableWrap) {
        fieldTableWrap.style.display = data.feature_table_number ? 'block' : 'none';
      }

      // Dynamic ask tiers from server (full ladder driven by Settings)
      if (Array.isArray(data.ask_tiers) && data.ask_tiers.length > 0 && presetGrid) {
        const tiers = data.ask_tiers;
        const existingData = Array.from(presetGrid.children).map(c => c.getAttribute('data-amount'));
        const newData = tiers.map(t => String(Math.floor(t.cents / 100)));

        if (existingData.join(',') !== newData.join(',')) {
          presetGrid.innerHTML = tiers.map(t => {
            const dollars = Math.floor(t.cents / 100);
            return `<button type="button" class="preset-chip ${currentAmountCents === t.cents ? 'active' : ''}" data-amount="${dollars}">$${dollars.toLocaleString('en-US')}</button>`;
          }).join('');
          setupPresets();
        }
      }

      // Ensure recent entries populate initial rows
      if (sessionRecentEntries.length < 3) {
        try {
          const stRes = await fetch('/api/state?role=stage', { headers: { 'Cache-Control': 'no-cache' } });
          if (stRes.ok) {
            const stData = await stRes.json();
            if (Array.isArray(stData.chyrons) && stData.chyrons.length > 0 && sessionRecentEntries.length < 3) {
              const existingIds = new Set(sessionRecentEntries.map(e => e.id));
              stData.chyrons.forEach(c => {
                if (!existingIds.has(c.donation_id) && sessionRecentEntries.length < 3) {
                  existingIds.add(c.donation_id);
                  sessionRecentEntries.push({
                    id: c.donation_id,
                    donor: c.display_name || 'Anonymous Supporter',
                    amountCents: c.amount_cents,
                    createdAt: c.created_at || Date.now(),
                    status: 'confirmed',
                    isAnonymous: Boolean(c.is_anonymous)
                  });
                }
              });
              renderRecentEntries();
            }
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn('[Givebar Entry] State poll failed:', err);
    }
  }

  // --- Anonymous Accessible Switch with Confirmation ---
  function setupAnonymousSwitch() {
    if (anonSwitchBtn) {
      anonSwitchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerAnonymousToggle();
      });

      anonSwitchBtn.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          triggerAnonymousToggle();
        }
      });
    }

    if (anonSwitchContainer) {
      anonSwitchContainer.addEventListener('click', (e) => {
        // If click was not on the button itself, toggle
        if (e.target !== anonSwitchBtn && !anonSwitchBtn?.contains(e.target)) {
          triggerAnonymousToggle();
        }
      });
    }

    // Modal listeners
    if (btnCancelAnon) {
      btnCancelAnon.addEventListener('click', closeAnonModal);
    }

    if (btnConfirmAnon) {
      btnConfirmAnon.addEventListener('click', () => {
        applyAnonymousState(pendingAnonTargetState);
        closeAnonModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && anonConfirmModal && anonConfirmModal.style.display !== 'none') {
        closeAnonModal();
      }
    });
  }

  function triggerAnonymousToggle() {
    const targetState = !isAnonymousState;
    promptAnonymousConfirmation(targetState);
  }

  function promptAnonymousConfirmation(targetState) {
    pendingAnonTargetState = targetState;

    if (targetState) {
      // Turning ON
      if (anonDialogTitle) anonDialogTitle.textContent = 'Make this donation anonymous?';
      if (anonDialogBody) {
        anonDialogBody.textContent = "The donor's name will not appear on the Fullscreen Bar Chart or Presenter View and will show as Anonymous instead.";
      }
      if (btnConfirmAnon) {
        btnConfirmAnon.textContent = 'Make Anonymous';
        btnConfirmAnon.className = 'btn-primary';
      }
    } else {
      // Turning OFF
      if (anonDialogTitle) anonDialogTitle.textContent = 'Show donor name?';
      if (anonDialogBody) {
        anonDialogBody.textContent = "The donor's name will appear publicly on the Fullscreen Bar Chart and Presenter View.";
      }
      if (btnConfirmAnon) {
        btnConfirmAnon.textContent = 'Show Name';
        btnConfirmAnon.className = 'btn-primary';
      }
    }

    if (anonConfirmModal) {
      anonConfirmModal.style.display = 'flex';
      // Default focus on Cancel per contract
      if (btnCancelAnon) btnCancelAnon.focus();
    }
  }

  function closeAnonModal() {
    if (anonConfirmModal) anonConfirmModal.style.display = 'none';
    pendingAnonTargetState = isAnonymousState;
    if (anonSwitchBtn) anonSwitchBtn.focus();
  }

  function applyAnonymousState(newState) {
    isAnonymousState = Boolean(newState);
    if (anonSwitchBtn) {
      anonSwitchBtn.setAttribute('aria-checked', isAnonymousState ? 'true' : 'false');
    }
    if (anonStatusPill) {
      anonStatusPill.textContent = isAnonymousState ? 'ON' : 'OFF';
    }
    if (anonSwitchContainer) {
      anonSwitchContainer.classList.toggle('is-anon', isAnonymousState);
    }
  }

  // Programmatic reset (never fires confirmation)
  function resetAnonymousState() {
    isAnonymousState = false;
    if (anonSwitchBtn) {
      anonSwitchBtn.setAttribute('aria-checked', 'false');
    }
    if (anonStatusPill) {
      anonStatusPill.textContent = 'OFF';
    }
    if (anonSwitchContainer) {
      anonSwitchContainer.classList.remove('is-anon');
    }
  }

  // --- Compact Name Pronunciation Disclosure ---
  function setupPronunciationDisclosure() {
    if (!btnTogglePronunciation || !fieldDonorPhoneticWrap) return;

    btnTogglePronunciation.addEventListener('click', (e) => {
      e.preventDefault();
      const isExpanded = btnTogglePronunciation.getAttribute('aria-expanded') === 'true';
      setPronunciationExpanded(!isExpanded);
    });
  }

  function setPronunciationExpanded(expanded) {
    if (!btnTogglePronunciation || !fieldDonorPhoneticWrap) return;
    btnTogglePronunciation.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    fieldDonorPhoneticWrap.style.display = expanded ? 'block' : 'none';
    if (pronunciationToggleLabel) {
      pronunciationToggleLabel.textContent = expanded ? '− Remove pronunciation' : '+ Add pronunciation';
    }
    if (expanded && donorPhoneticInput) {
      donorPhoneticInput.focus();
    }
  }

  // --- Amount & Keypad Handling ---
  function setupAmountInputs() {
    if (amountInput) {
      amountInput.addEventListener('input', () => {
        const raw = amountInput.value.replace(/[^0-9]/g, '');
        const dollars = raw ? parseInt(raw, 10) : 0;
        currentAmountCents = dollars * 100;
        updateUI();
        syncPresetHighlight();
      });

      amountInput.addEventListener('blur', () => {
        amountInput.value = formatCurrency(currentAmountCents);
      });

      amountInput.addEventListener('focus', () => {
        const dollars = Math.floor(currentAmountCents / 100);
        amountInput.value = dollars > 0 ? String(dollars) : '';
      });
    }
  }

  function setupPresets() {
    if (!presetGrid) return;
    const chips = presetGrid.querySelectorAll('.preset-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        const dollars = parseInt(chip.getAttribute('data-amount') || '500', 10);
        currentAmountCents = dollars * 100;
        updateUI();
        syncPresetHighlight();
        if (donorNameInput) donorNameInput.focus();
      });
    });
  }

  function syncPresetHighlight() {
    if (!presetGrid) return;
    const currentDollars = Math.floor(currentAmountCents / 100);
    presetGrid.querySelectorAll('.preset-chip').forEach(chip => {
      const chipDollars = parseInt(chip.getAttribute('data-amount') || '0', 10);
      chip.classList.toggle('active', chipDollars === currentDollars);
    });
  }

  function setupMobileKeypad() {
    if (!mobileKeypad) return;

    mobileKeypad.addEventListener('click', e => {
      const btn = e.target.closest('.keypad-key');
      if (!btn) return;

      const key = btn.getAttribute('data-key');
      let currentDollars = Math.floor(currentAmountCents / 100);

      if (key === 'backspace') {
        const str = currentDollars.toString();
        currentDollars = str.length > 1 ? parseInt(str.slice(0, -1), 10) : 0;
      } else if (key === '.') {
        // Whole dollars only for live gala pledge pad
      } else if (/^\d$/.test(key)) {
        const digit = parseInt(key, 10);
        currentDollars = Math.min(currentDollars * 10 + digit, 5000000); // $5M max
      }

      currentAmountCents = currentDollars * 100;
      updateUI();
      syncPresetHighlight();
    });
  }

  function updateUI() {
    const formatted = formatCurrency(currentAmountCents);
    if (amountInput && document.activeElement !== amountInput) {
      amountInput.value = formatted;
    }
    if (btnSubmit) {
      btnSubmit.textContent = `Add ${formatted}`;
    }
  }

  // --- Submission Handling ---
  function setupSubmission() {
    if (btnSubmit) {
      btnSubmit.addEventListener('click', handleSubmit);
    }

    if (donorNameInput) {
      donorNameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSubmit();
        }
      });
    }
  }

  async function handleSubmit() {
    clearError();

    const donorName = (donorNameInput?.value || '').trim();

    if (currentAmountCents <= 0) {
      showError('Please enter a valid donation amount.');
      if (amountInput) amountInput.focus();
      return;
    }

    if (!donorName && !isAnonymousState) {
      showError('Please enter donor name, or mark as Anonymous.');
      if (donorNameInput) donorNameInput.focus();
      return;
    }

    const payload = {
      donation_id: crypto.randomUUID(),
      amount_cents: currentAmountCents,
      donor_name: donorName || 'Anonymous',
      display_name: isAnonymousState ? 'Anonymous Supporter' : donorName,
      is_anonymous: isAnonymousState,
      payment_method: 'pledge',
      source: 'manual',
      entered_by: volunteerId,
      card_number: cardNumberInput?.value?.trim() || undefined,
      table_number: tableNumberInput?.value?.trim() || undefined,
      donor_phonetic: donorPhoneticInput?.value?.trim() || undefined,
      created_at: Date.now()
    };

    // Major gift guardrail intercept
    if (currentAmountCents >= majorGiftThresholdCents) {
      promptMajorGiftGuardrail(payload);
      return;
    }

    await dispatchDonation(payload);
  }

  async function dispatchDonation(payload) {
    // Optimistically record in local session entries
    const sessionEntry = {
      id: payload.donation_id,
      donor: payload.donor_name,
      amountCents: payload.amount_cents,
      createdAt: payload.created_at,
      status: 'pending',
      isAnonymous: payload.is_anonymous
    };
    addSessionEntry(sessionEntry);

    // Reset inputs immediately without confirmation prompt and return focus to fresh amount without navigation
    resetFormForNextEntry();

    try {
      const res = await fetch(`/api/donation/${payload.donation_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        updateSessionEntryStatus(payload.donation_id, 'confirmed');
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status >= 400 && res.status < 500) {
          showError(`Submission error (${res.status}): ${data.message || data.error}`);
          updateSessionEntryStatus(payload.donation_id, 'failed');
        } else {
          queueOffline(payload);
        }
      }
    } catch (err) {
      console.warn('[Givebar] Network error, queuing offline:', err);
      queueOffline(payload);
    }
  }

  function resetFormForNextEntry() {
    if (donorNameInput) donorNameInput.value = '';
    resetAnonymousState(); // Silent reset without confirmation modal
    if (cardNumberInput) cardNumberInput.value = '';
    if (tableNumberInput) tableNumberInput.value = '';
    if (donorPhoneticInput) donorPhoneticInput.value = '';
    setPronunciationExpanded(false);

    // Return focus to fresh amount without navigation
    if (amountInput) {
      amountInput.focus();
      amountInput.select();
    }
  }

  // --- Major Gift Guardrail ---
  function setupGuardrailModal() {
    if (btnCancelGuardrail) {
      btnCancelGuardrail.addEventListener('click', () => {
        if (guardrailModal) guardrailModal.style.display = 'none';
        pendingMajorGiftPayload = null;
        if (amountInput) amountInput.focus();
      });
    }

    if (btnConfirmGuardrail) {
      btnConfirmGuardrail.addEventListener('click', async () => {
        if (!pendingMajorGiftPayload) return;
        const payload = pendingMajorGiftPayload;
        payload.confirmed_major_gift = true;
        if (guardrailModal) guardrailModal.style.display = 'none';
        pendingMajorGiftPayload = null;
        await dispatchDonation(payload);
      });
    }
  }

  function promptMajorGiftGuardrail(payload) {
    pendingMajorGiftPayload = payload;
    const formatted = formatCurrency(payload.amount_cents);

    if (guardrailBody) {
      guardrailBody.textContent = `A pledge of ${formatted} from "${payload.donor_name}" exceeds the verification threshold of ${formatCurrency(majorGiftThresholdCents)}. Please confirm this is not an extra-zero typo.`;
    }

    if (guardrailModal) {
      guardrailModal.style.display = 'flex';
      if (btnCancelGuardrail) btnCancelGuardrail.focus();
    }
  }

  // --- Offline Outbox with Single In-Flight Guard ---
  function queueOffline(payload) {
    if (!outbox.some(i => i.donation_id === payload.donation_id)) {
      outbox.push(payload);
      saveOutbox();
    }
    updateOutboxIndicator();
  }

  function saveOutbox() {
    localStorage.setItem('givebar_outbox', JSON.stringify(outbox));
  }

  async function flushOutbox() {
    if (isFlushing || outbox.length === 0) return;
    isFlushing = true;

    try {
      const itemsToFlush = [...outbox];
      for (const item of itemsToFlush) {
        try {
          const res = await fetch(`/api/donation/${item.donation_id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item)
          });

          if (res.ok) {
            outbox = outbox.filter(i => i.donation_id !== item.donation_id);
            saveOutbox();
            updateSessionEntryStatus(item.donation_id, 'confirmed');
          } else if (res.status >= 400 && res.status < 500) {
            const errData = await res.json().catch(() => ({}));
            outbox = outbox.filter(i => i.donation_id !== item.donation_id);
            saveOutbox();
            showError(`Offline item rejected (${res.status}): ${errData.message || errData.error}`);
            updateSessionEntryStatus(item.donation_id, 'failed');
          }
        } catch {
          break;
        }
      }
    } finally {
      isFlushing = false;
      updateOutboxIndicator();
    }
  }

  function updateOutboxIndicator() {
    if (!outboxStatus || !outboxCount) return;
    if (outbox.length > 0) {
      outboxCount.textContent = outbox.length;
      outboxStatus.style.display = 'inline-block';
    } else {
      outboxStatus.style.display = 'none';
    }
  }

  // --- Recent Entries & Row Undo ---
  function addSessionEntry(entry) {
    sessionRecentEntries.unshift(entry);
    if (sessionRecentEntries.length > 20) {
      sessionRecentEntries = sessionRecentEntries.slice(0, 20);
    }
    localStorage.setItem('givebar_session_entries', JSON.stringify(sessionRecentEntries));
    renderRecentEntries();
  }

  function updateSessionEntryStatus(donationId, status) {
    const entry = sessionRecentEntries.find(e => e.id === donationId);
    if (entry) {
      entry.status = status;
      localStorage.setItem('givebar_session_entries', JSON.stringify(sessionRecentEntries));
      renderRecentEntries();
    }
  }

  function renderRecentEntries() {
    if (!recentEntriesList) return;

    if (recentCountLabel) {
      recentCountLabel.textContent = `${sessionRecentEntries.length} entries`;
    }

    if (sessionRecentEntries.length === 0) {
      recentEntriesList.innerHTML = `
        <div style="color: #88888e; font-size: var(--text-sm); padding: var(--space-4) 0; text-align: center;">
          No recent entries in this session.
        </div>
      `;
      return;
    }

    recentEntriesList.innerHTML = sessionRecentEntries.slice(0, 10).map((entry, index) => {
      const formattedAmount = formatCurrency(entry.amountCents);
      const relativeTime = formatRelativeTime(entry.createdAt);
      const isFirst = index === 0;

      let statusHtml = '';
      if (entry.status === 'voided') {
        statusHtml = `<span style="color: #88888e; text-decoration: line-through;">Voided</span>`;
      } else if (entry.status === 'failed') {
        statusHtml = `<span style="color: #f87171;">Failed</span>`;
      } else if (isFirst || Date.now() - entry.createdAt < 45000) {
        statusHtml = `<button type="button" class="recent-undo-btn" data-undo-id="${entry.id}">Undo</button>`;
      } else if (entry.status === 'confirmed') {
        statusHtml = `<span class="recent-status confirmed">&#x2713; Confirmed</span>`;
      } else {
        statusHtml = `<span class="recent-status pending">&#x1F552; Pending</span>`;
      }

      return `
        <div class="recent-row ${isFirst ? 'highlight' : ''}" data-entry-id="${entry.id}">
          <span class="recent-donor" title="${escapeHTML(entry.donor)}">${escapeHTML(entry.donor)}</span>
          <span class="recent-amount">${formattedAmount}</span>
          <span class="recent-time">${relativeTime}</span>
          <span class="recent-status">${statusHtml}</span>
        </div>
      `;
    }).join('');

    recentEntriesList.querySelectorAll('.recent-undo-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-undo-id');
        if (!id) return;
        await executeRowUndo(id);
      });
    });
  }

  async function executeRowUndo(donationId) {
    try {
      const res = await fetch(`/api/donation/${donationId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entered_by: volunteerId,
          reason: '1-tap inline undo from recent list'
        })
      });

      if (res.ok) {
        updateSessionEntryStatus(donationId, 'voided');
      } else {
        const err = await res.json().catch(() => ({}));
        showError(`Undo failed: ${err.message || 'Could not void donation'}`);
      }
    } catch (err) {
      console.error('[Givebar] Undo error:', err);
    }
  }

  // --- Helpers ---
  function showError(msg) {
    if (errorBanner) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }
  }

  function clearError() {
    if (errorBanner) {
      errorBanner.style.display = 'none';
      errorBanner.textContent = '';
    }
  }

  function formatCurrency(cents) {
    return `$${Math.floor(cents / 100).toLocaleString('en-US')}`;
  }

  function formatRelativeTime(epochMs) { const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000)); if (sec < 60) return `${sec}s`; const min = Math.floor(sec / 60); if (min < 60) return `${min}m`; const hrs = Math.floor(min / 60); if (hrs < 24) return `${hrs}h`; const days = Math.floor(hrs / 24); if (days < 7) return `${days}d`; const weeks = Math.floor(days / 7); return `${weeks}w`; }

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
