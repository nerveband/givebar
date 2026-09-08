/**
 * Givebar — Add Donation Controller
 *
 * Single-screen pledge entry for a volunteer holding a phone in a dim ballroom.
 *   - Preset ask ladder plus an explicit "Custom amount" control that clears to
 *     $0 and drops into direct-entry mode with an Enter/Done commit.
 *   - Anonymous is an instant switch with an inline explanation (no modal). The
 *     donor name is ALWAYS required: anonymity is a public-display rule only,
 *     the name is still recorded for the organization.
 *   - Recent list: large donor name / right-aligned tabular amount, live undo
 *     countdown, settled green confirmed state, struck-through undone rows with
 *     Redo, and an ease-out arrival animation with a reduced-motion equivalent.
 *   - Guarded offline outbox, major-gift guardrail intercept.
 */

(function () {
  'use strict';

  // Client-side undo window. This is deliberately separate from the server's
  // stage_delay_ms staging horizon: it is how long THIS pad keeps offering a
  // one-tap undo on the row it just created.
  const UNDO_WINDOW_MS = 8000;
  const TICK_MS = 250;

  // State
  let volunteerId = localStorage.getItem('givebar_volunteer_id');
  if (!volunteerId) {
    volunteerId = `User-${Math.floor(Math.random() * 899 + 100)}`;
    localStorage.setItem('givebar_volunteer_id', volunteerId);
  }

  let currentAmountCents = 50000; // $500 default
  let isAnonymousState = false;
  let isCustomMode = false;
  let amountIsFresh = true; // next typed digit replaces rather than appends
  let majorGiftThresholdCents = 950000; // $9,500
  let isFlushing = false;
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');
  let sessionRecentEntries = JSON.parse(localStorage.getItem('givebar_session_entries') || '[]');
  let pendingMajorGiftPayload = null;
  let tickTimer = null;

  // Payloads kept for the page lifetime so Redo can re-send a donation that
  // never reached the server (offline undo).
  const payloadCache = new Map();

  // DOM Elements
  const pageRoot = document.body;
  const amountInput = document.getElementById('amount-numeric-input');
  const amountLabelText = document.getElementById('amount-label-text');
  const presetGrid = document.getElementById('preset-grid');
  const btnCustomAmount = document.getElementById('btn-custom-amount');
  const btnCustomDone = document.getElementById('btn-custom-done');
  const customEntryHint = document.getElementById('custom-entry-hint');
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
  const anonExplainer = document.getElementById('anon-explainer');

  // Guardrail Modal Elements
  const guardrailModal = document.getElementById('major-gift-modal');
  const guardrailBody = document.getElementById('guardrail-body');
  const btnCancelGuardrail = document.getElementById('btn-cancel-guardrail');
  const btnConfirmGuardrail = document.getElementById('btn-confirm-guardrail');

  // Inline SVG glyphs (Phosphor). No emojis anywhere in the UI.
  const ICONS = {
    check: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>',
    clock: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"></path></svg>',
    undo: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"></path></svg>',
    redo: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h27.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"></path></svg>',
    warning: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"></path></svg>',
    eyeSlash: '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true"><path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.68,45.85a32,32,0,0,1-41.68-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm119.31-60.75c-.79,1.83-20,45-63.06,64.65a8,8,0,0,1-6.62-14.57c39.19-17.86,55.9-56.75,56.07-57.14a8,8,0,0,0,0-6.5c-.35-.79-8.82-19.57-27.65-38.4C194.57,61.26,162.88,48,128,48a132.6,132.6,0,0,0-20.68,1.61A8,8,0,1,1,104.85,33.8,148.83,148.83,0,0,1,128,32c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.25Z"></path></svg>'
  };

  function init() {
    setupAmountInputs();
    setupCustomAmountControl();
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

  // --- State Sync (Features & ask tiers) ---
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
            const active = !isCustomMode && currentAmountCents === t.cents ? ' active' : '';
            return `<button type="button" class="preset-chip${active}" data-amount="${dollars}">$${dollars.toLocaleString('en-US')}</button>`;
          }).join('');
          setupPresets();
        }
      }

      // Seed the recent list from the live feed so the panel is not empty at open.
      if (sessionRecentEntries.length < 3) {
        try {
          const stRes = await fetch('/api/state?role=stage', { headers: { 'Cache-Control': 'no-cache' } });
          if (stRes.ok) {
            const stData = await stRes.json();
            if (Array.isArray(stData.chyrons) && stData.chyrons.length > 0 && sessionRecentEntries.length < 3) {
              const existingIds = new Set(sessionRecentEntries.map(e => e.id));
              let added = false;
              stData.chyrons.forEach(c => {
                if (!existingIds.has(c.donation_id) && sessionRecentEntries.length < 3) {
                  existingIds.add(c.donation_id);
                  added = true;
                  sessionRecentEntries.push({
                    id: c.donation_id,
                    donor: c.display_name || 'Anonymous Supporter',
                    amountCents: c.amount_cents,
                    createdAt: c.created_at || Date.now(),
                    status: 'confirmed',
                    isAnonymous: Boolean(c.is_anonymous),
                    // Already on stage — never offer an undo that would surprise.
                    undoUntil: 0
                  });
                }
              });
              if (added) renderRecentEntries();
            }
          }
        } catch (e) { /* offline: keep local list */ }
      }
    } catch (err) {
      console.warn('[Givebar Entry] State poll failed:', err);
    }
  }

  // --- Anonymous switch: instant apply + inline explanation ---
  function setupAnonymousSwitch() {
    if (anonSwitchBtn) {
      anonSwitchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyAnonymousState(!isAnonymousState);
      });

      anonSwitchBtn.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          applyAnonymousState(!isAnonymousState);
        }
      });
    }

    if (anonSwitchContainer) {
      anonSwitchContainer.addEventListener('click', (e) => {
        if (e.target !== anonSwitchBtn && !anonSwitchBtn?.contains(e.target)) {
          applyAnonymousState(!isAnonymousState);
        }
      });
    }
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
    if (anonExplainer) {
      anonExplainer.classList.toggle('is-visible', isAnonymousState);
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

  // --- Amount, custom (direct) entry mode & keypad ---
  function setupAmountInputs() {
    if (!amountInput) return;

    amountInput.addEventListener('input', () => {
      const raw = amountInput.value.replace(/[^0-9]/g, '');
      const dollars = raw ? Math.min(parseInt(raw, 10), 5000000) : 0;
      currentAmountCents = dollars * 100;
      amountIsFresh = false;
      // Typing directly IS custom entry — make the state visible.
      setCustomMode(true, { clear: false, focus: false });
      updateUI();
      syncPresetHighlight();
    });

    amountInput.addEventListener('blur', () => {
      amountInput.value = formatCurrency(currentAmountCents);
    });

    amountInput.addEventListener('focus', () => {
      // A "fresh" amount (just reset, or carried over from the last gift) stays
      // formatted and fully selected: the next digit replaces it outright, so
      // nobody types a new figure onto the tail of a stale one.
      if (amountIsFresh) {
        amountInput.value = formatCurrency(currentAmountCents);
        amountInput.select();
        return;
      }
      const dollars = Math.floor(currentAmountCents / 100);
      amountInput.value = dollars > 0 ? String(dollars) : '';
    });

    amountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitCustomAmount();
      }
    });
  }

  function setupCustomAmountControl() {
    if (btnCustomAmount) {
      btnCustomAmount.addEventListener('click', (e) => {
        e.preventDefault();
        // Start from zero so nobody is confused about what they are entering.
        setCustomMode(true, { clear: true, focus: true });
      });
    }
    if (btnCustomDone) {
      btnCustomDone.addEventListener('click', (e) => {
        e.preventDefault();
        commitCustomAmount();
      });
    }
  }

  function setCustomMode(on, opts) {
    const options = opts || {};
    const wasOn = isCustomMode;
    isCustomMode = Boolean(on);

    if (pageRoot) pageRoot.classList.toggle('is-custom-mode', isCustomMode);
    if (btnCustomAmount) btnCustomAmount.setAttribute('aria-pressed', isCustomMode ? 'true' : 'false');
    if (amountLabelText) amountLabelText.textContent = isCustomMode ? 'Custom amount' : 'Amount';

    if (isCustomMode && options.clear) {
      currentAmountCents = 0;
      amountIsFresh = true;
      updateUI();
      syncPresetHighlight();
    }

    if (isCustomMode && options.focus && amountInput) {
      // Focus handler renders the (freshly zeroed) value and selects it.
      amountInput.focus();
      amountInput.select();
    }

    if (!isCustomMode && wasOn) {
      resetCustomHint();
    }
  }

  function resetCustomHint() {
    if (customEntryHint) {
      customEntryHint.textContent = 'Press Enter to confirm.';
      customEntryHint.style.color = '';
    }
  }

  function commitCustomAmount() {
    if (currentAmountCents <= 0) {
      if (customEntryHint) {
        customEntryHint.textContent = 'Enter an amount over $0.';
      }
      if (amountInput) amountInput.focus();
      return;
    }
    setCustomMode(false, {});
    updateUI();
    syncPresetHighlight();
    if (donorNameInput) donorNameInput.focus();
  }

  function setupPresets() {
    if (!presetGrid) return;
    presetGrid.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const dollars = parseInt(chip.getAttribute('data-amount') || '500', 10);
        currentAmountCents = dollars * 100;
        amountIsFresh = true;
        setCustomMode(false, {});
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
      chip.classList.toggle('active', !isCustomMode && chipDollars === currentDollars);
    });
  }

  function setupMobileKeypad() {
    if (!mobileKeypad) return;

    mobileKeypad.addEventListener('click', e => {
      const btn = e.target.closest('.keypad-key');
      if (!btn) return;

      const key = btn.getAttribute('data-key');
      let currentDollars = amountIsFresh && key !== 'backspace' ? 0 : Math.floor(currentAmountCents / 100);

      if (key === 'backspace') {
        const str = currentDollars.toString();
        currentDollars = str.length > 1 ? parseInt(str.slice(0, -1), 10) : 0;
        amountIsFresh = false;
      } else if (key === '00') {
        currentDollars = Math.min(currentDollars * 100, 5000000);
        amountIsFresh = false;
      } else if (/^\d$/.test(key)) {
        const digit = parseInt(key, 10);
        currentDollars = Math.min(currentDollars * 10 + digit, 5000000); // $5M max
        amountIsFresh = false;
      }

      currentAmountCents = currentDollars * 100;
      // Keypad editing is direct entry: surface the same explicit custom state.
      setCustomMode(true, { clear: false, focus: false });
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
      showError('Enter an amount.');
      if (amountInput) amountInput.focus();
      return;
    }

    // Anonymity is a public-display rule. The record always keeps the real name.
    if (!donorName) {
      showError('Donor name is required, including for anonymous gifts.');
      if (donorNameInput) donorNameInput.focus();
      return;
    }

    const payload = {
      donation_id: crypto.randomUUID(),
      amount_cents: currentAmountCents,
      donor_name: donorName,
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

  async function dispatchDonation(payload, opts) {
    const options = opts || {};
    payloadCache.set(payload.donation_id, payload);

    if (options.reuseEntry) {
      updateSessionEntry(payload.donation_id, { status: 'pending', undoUntil: Date.now() + UNDO_WINDOW_MS });
    } else {
      addSessionEntry({
        id: payload.donation_id,
        donor: payload.donor_name,
        amountCents: payload.amount_cents,
        createdAt: payload.created_at,
        status: 'pending',
        isAnonymous: payload.is_anonymous,
        undoUntil: Date.now() + UNDO_WINDOW_MS
      });
      resetFormForNextEntry();
    }

    try {
      const res = await fetch(`/api/donation/${payload.donation_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        updateSessionEntry(payload.donation_id, { status: 'confirmed' });
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status >= 400 && res.status < 500) {
          showError(`Submission error (${res.status}): ${data.message || data.error}`);
          updateSessionEntry(payload.donation_id, { status: 'failed', undoUntil: 0 });
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
    applyAnonymousState(false);
    if (cardNumberInput) cardNumberInput.value = '';
    if (tableNumberInput) tableNumberInput.value = '';
    if (donorPhoneticInput) donorPhoneticInput.value = '';
    setPronunciationExpanded(false);
    setCustomMode(false, {});
    amountIsFresh = true;
    syncPresetHighlight();

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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && guardrailModal && guardrailModal.style.display !== 'none') {
        guardrailModal.style.display = 'none';
        pendingMajorGiftPayload = null;
      }
    });
  }

  function promptMajorGiftGuardrail(payload) {
    pendingMajorGiftPayload = payload;
    const formatted = formatCurrency(payload.amount_cents);

    if (guardrailBody) {
      guardrailBody.textContent = `${formatted} from "${payload.donor_name}". Check for an extra zero.`;
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
            updateSessionEntry(item.donation_id, { status: 'confirmed' });
          } else if (res.status >= 400 && res.status < 500) {
            const errData = await res.json().catch(() => ({}));
            outbox = outbox.filter(i => i.donation_id !== item.donation_id);
            saveOutbox();
            showError(`Offline item rejected (${res.status}): ${errData.message || errData.error}`);
            updateSessionEntry(item.donation_id, { status: 'failed', undoUntil: 0 });
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

  // --- Recent entries ---
  const enteringIds = new Set();

  function persistEntries() {
    localStorage.setItem('givebar_session_entries', JSON.stringify(sessionRecentEntries));
  }

  function addSessionEntry(entry) {
    sessionRecentEntries.unshift(entry);
    if (sessionRecentEntries.length > 20) {
      sessionRecentEntries = sessionRecentEntries.slice(0, 20);
    }
    enteringIds.add(entry.id);
    persistEntries();
    renderRecentEntries();
  }

  function updateSessionEntry(donationId, patch) {
    const entry = sessionRecentEntries.find(e => e.id === donationId);
    if (!entry) return;
    Object.assign(entry, patch);
    persistEntries();
    renderRecentEntries();
  }

  function undoRemainingMs(entry) {
    if (!entry.undoUntil) return 0;
    return Math.max(0, entry.undoUntil - Date.now());
  }

  /**
   * Derived row state. The countdown is honest: undo is only offered while the
   * window is genuinely open and the row is genuinely undoable.
   */
  function deriveRowState(entry) {
    if (entry.status === 'voided') return { kind: 'voided', remaining: 0 };
    if (entry.status === 'failed') return { kind: 'failed', remaining: 0 };
    const remaining = undoRemainingMs(entry);
    if (remaining > 0) {
      return { kind: entry.status === 'confirmed' ? 'live-confirmed' : 'live-pending', remaining };
    }
    if (entry.status === 'confirmed') return { kind: 'confirmed', remaining: 0 };
    return { kind: 'pending', remaining: 0 };
  }

  function statusMarkup(entry, state) {
    switch (state.kind) {
      case 'voided':
        return `<span class="recent-status voided">${ICONS.undo} Undone</span>`;
      case 'failed':
        return `<span class="recent-status failed">${ICONS.warning} Failed</span>`;
      case 'live-pending':
      case 'pending':
        return `<span class="recent-status pending">${ICONS.clock} Sending</span>`;
      default:
        return `<span class="recent-status confirmed">${ICONS.check} Confirmed</span>`;
    }
  }

  function actionsMarkup(entry, state) {
    if (state.kind === 'voided') {
      return `<button type="button" class="recent-action-btn" data-redo-id="${entry.id}">${ICONS.redo} Redo</button>`;
    }
    if (state.remaining > 0) {
      const secs = Math.ceil(state.remaining / 1000);
      return `<span class="undo-countdown" data-countdown-id="${entry.id}">Undo for ${secs}s</span>` +
        `<button type="button" class="recent-action-btn" data-undo-id="${entry.id}">${ICONS.undo} Undo</button>`;
    }
    return '';
  }

  function metaMarkup(entry, state) {
    const anon = entry.isAnonymous
      ? `<span class="recent-meta-sep">&middot;</span><span class="recent-status">${ICONS.eyeSlash} Anonymous</span>`
      : '';
    return `<span class="recent-time">${formatRelativeTime(entry.createdAt)}</span>` +
      `<span class="recent-meta-sep">&middot;</span>${statusMarkup(entry, state)}${anon}`;
  }

  function renderRecentEntries() {
    if (!recentEntriesList) return;

    if (recentCountLabel) {
      recentCountLabel.textContent = `${sessionRecentEntries.length} ${sessionRecentEntries.length === 1 ? 'entry' : 'entries'}`;
    }

    if (sessionRecentEntries.length === 0) {
      recentEntriesList.innerHTML = '<div class="recent-empty">No entries yet</div>';
      stopTicker();
      return;
    }

    recentEntriesList.innerHTML = sessionRecentEntries.slice(0, 10).map(entry => {
      const state = deriveRowState(entry);
      const classes = ['recent-row'];
      if (state.remaining > 0) classes.push('is-live');
      if (state.kind === 'voided') classes.push('is-voided');
      if (enteringIds.has(entry.id)) classes.push('is-entering');

      return `
        <div class="${classes.join(' ')}" data-entry-id="${entry.id}" data-state-kind="${state.kind}">
          <span class="recent-donor" title="${escapeHTML(entry.donor)}">${escapeHTML(entry.donor)}</span>
          <span class="recent-amount">${formatCurrency(entry.amountCents)}</span>
          <span class="recent-meta">${metaMarkup(entry, state)}</span>
          <span class="recent-actions">${actionsMarkup(entry, state)}</span>
        </div>
      `;
    }).join('');

    recentEntriesList.querySelectorAll('.recent-row.is-entering').forEach(row => {
      row.addEventListener('animationend', () => {
        enteringIds.delete(row.getAttribute('data-entry-id'));
        row.classList.remove('is-entering');
      }, { once: true });
    });

    bindRowActions(recentEntriesList);
    ensureTicker();
  }

  function bindRowActions(scope) {
    scope.querySelectorAll('[data-undo-id]').forEach(btn => {
      btn.addEventListener('click', () => executeRowUndo(btn.getAttribute('data-undo-id')));
    });
    scope.querySelectorAll('[data-redo-id]').forEach(btn => {
      btn.addEventListener('click', () => executeRowRedo(btn.getAttribute('data-redo-id')));
    });
  }

  /**
   * Ticker updates only the volatile parts of a row (relative time, countdown)
   * and rebuilds a row's meta/action cells when its derived state changes, so
   * the arrival animation and any in-progress interaction are not disturbed.
   */
  function ensureTicker() {
    if (tickTimer) return;
    if (!sessionRecentEntries.some(e => undoRemainingMs(e) > 0)) return;
    tickTimer = setInterval(tickRows, TICK_MS);
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function tickRows() {
    if (!recentEntriesList) return;
    let anyLive = false;

    recentEntriesList.querySelectorAll('.recent-row').forEach(row => {
      const id = row.getAttribute('data-entry-id');
      const entry = sessionRecentEntries.find(e => e.id === id);
      if (!entry) return;

      const state = deriveRowState(entry);
      if (state.remaining > 0) anyLive = true;

      const timeEl = row.querySelector('.recent-time');
      if (timeEl) timeEl.textContent = formatRelativeTime(entry.createdAt);

      if (row.getAttribute('data-state-kind') !== state.kind) {
        row.setAttribute('data-state-kind', state.kind);
        row.classList.toggle('is-live', state.remaining > 0);
        row.classList.toggle('is-voided', state.kind === 'voided');
        const metaEl = row.querySelector('.recent-meta');
        const actionsEl = row.querySelector('.recent-actions');
        if (metaEl) metaEl.innerHTML = metaMarkup(entry, state);
        if (actionsEl) {
          actionsEl.innerHTML = actionsMarkup(entry, state);
          bindRowActions(actionsEl.parentElement);
        }
        return;
      }

      const countdownEl = row.querySelector('.undo-countdown');
      if (countdownEl && state.remaining > 0) {
        countdownEl.textContent = `Undo for ${Math.ceil(state.remaining / 1000)}s`;
      }
    });

    if (!anyLive) stopTicker();
  }

  async function executeRowUndo(donationId) {
    if (!donationId) return;
    const entry = sessionRecentEntries.find(e => e.id === donationId);
    if (!entry || undoRemainingMs(entry) <= 0) {
      showError('Undo window closed. Correct it in Manage Donations.');
      renderRecentEntries();
      return;
    }

    // Never sent yet (offline queue): drop it locally instead of calling void.
    const queued = outbox.find(i => i.donation_id === donationId);
    if (queued) {
      outbox = outbox.filter(i => i.donation_id !== donationId);
      saveOutbox();
      updateOutboxIndicator();
      updateSessionEntry(donationId, { status: 'voided', undoUntil: 0, neverSent: true });
      return;
    }

    try {
      const res = await fetch(`/api/donation/${donationId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entered_by: volunteerId,
          reason: '1-tap inline undo from Add Donation pad'
        })
      });

      if (res.ok) {
        updateSessionEntry(donationId, { status: 'voided', undoUntil: 0 });
      } else {
        const err = await res.json().catch(() => ({}));
        showError(`Undo failed: ${err.message || 'Could not void donation'}`);
      }
    } catch (err) {
      console.error('[Givebar] Undo error:', err);
      showError('Undo failed: no connection.');
    }
  }

  async function executeRowRedo(donationId) {
    if (!donationId) return;
    const entry = sessionRecentEntries.find(e => e.id === donationId);
    if (!entry) return;
    clearError();

    // Undone before it ever reached the server: re-send the original payload.
    if (entry.neverSent) {
      const payload = payloadCache.get(donationId);
      if (payload) {
        entry.neverSent = false;
        await dispatchDonation(payload, { reuseEntry: true });
        return;
      }
    }

    try {
      const res = await fetch(`/api/donation/${donationId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entered_by: volunteerId,
          reason: 'Redo from Add Donation pad'
        })
      });

      if (res.ok) {
        updateSessionEntry(donationId, {
          status: 'confirmed',
          undoUntil: Date.now() + UNDO_WINDOW_MS
        });
      } else {
        const err = await res.json().catch(() => ({}));
        showError(`Redo failed: ${err.message || 'Could not restore donation'}`);
      }
    } catch (err) {
      console.error('[Givebar] Redo error:', err);
      showError('Redo failed: no connection.');
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

  function formatRelativeTime(epochMs) {
    const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
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

  // Restoring from bfcache must land on the current usable state, never a stale
  // countdown or a leftover entrance marker.
  window.addEventListener('pageshow', () => {
    enteringIds.clear();
    renderRecentEntries();
  });

  document.addEventListener('DOMContentLoaded', init);
})();
