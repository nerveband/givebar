/**
 * Givebar — Volunteer Mobile Pledge Pad Controller
 * 2-Stage Progressive Input, Dual-Mode Accumulator, 8s Undo Toast, Offline Outbox
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let volunteerId = localStorage.getItem('givebar_volunteer_id');
  if (!volunteerId) {
    volunteerId = `V-${Math.floor(Math.random() * 899 + 100)}`;
    localStorage.setItem('givebar_volunteer_id', volunteerId);
  }

  let currentAmountCents = 0;
  let activeDonationId = generateUUID();
  let lastSubmittedDonation = null;
  let undoTimeout = null;
  let pendingSubmission = null;
  let isPresetSelected = false;
  let majorGiftThresholdCents = 950000;
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');

  function saveOutbox() {
    localStorage.setItem('givebar_outbox', JSON.stringify(outbox));
  }

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function init() {
    const clerkBadge = document.getElementById('clerk-badge');
    if (clerkBadge) clerkBadge.textContent = volunteerId;

    setupNumpad();
    setupTiers();
    setupStageNavigation();
    setupSubmission();
    setupUndo();
    setupGuardrailModal();

    startPolling();
    flushOutbox();
  }

  // --- Numpad & Amount Controls ---
  function updateAmountDisplay() {
    const displayEl = document.getElementById('amount-display');
    const confirmEl = document.getElementById('confirm-amount-text');
    const submitBtn = document.getElementById('btn-submit-pledge');

    const dollars = Math.floor(currentAmountCents / 100);
    const formatted = `$${dollars.toLocaleString('en-US')}`;

    if (displayEl) displayEl.textContent = formatted;
    if (confirmEl) confirmEl.textContent = formatted;
    if (submitBtn) submitBtn.textContent = `Record Pledge (${formatted}) →`;
  }

  function setupNumpad() {
    const numpad = document.getElementById('numpad');
    if (!numpad) return;

    numpad.addEventListener('click', (e) => {
      const btn = e.target.closest('.numpad-btn');
      if (!btn) return;

      const key = btn.getAttribute('data-key');
      let currentDollars = Math.floor(currentAmountCents / 100);

      if (isPresetSelected) {
        if (/^\d+$/.test(key)) {
          currentDollars = parseInt(key, 10);
        } else if (key === '00') {
          currentDollars = 0;
        } else if (key === 'backspace') {
          currentDollars = 0;
        }
        isPresetSelected = false;
        clearPresetHighlights();
      } else {
        if (key === 'backspace') {
          const str = currentDollars.toString();
          currentDollars = str.length > 1 ? parseInt(str.slice(0, -1), 10) : 0;
        } else if (key === '00') {
          currentDollars = Math.min(currentDollars * 100, 10000000);
        } else if (/^\d+$/.test(key)) {
          const digit = parseInt(key, 10);
          currentDollars = Math.min(currentDollars * 10 + digit, 10000000);
        }
      }

      currentAmountCents = currentDollars * 100;
      updateAmountDisplay();
    });
  }

  function clearPresetHighlights() {
    document.querySelectorAll('#tier-grid .tier-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-cents') === '0');
    });
  }

  function setupTiers() {
    const tierGrid = document.getElementById('tier-grid');
    if (!tierGrid) return;

    tierGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.tier-btn');
      if (!btn) return;

      document.querySelectorAll('#tier-grid .tier-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      const cents = parseInt(btn.getAttribute('data-cents') || '0', 10);
      if (cents > 0) {
        currentAmountCents = cents;
        isPresetSelected = true;
      } else {
        isPresetSelected = false;
      }
      updateAmountDisplay();
    });
  }

  // --- 2-Stage Progressive Navigation ---
  function setupStageNavigation() {
    const nextBtn = document.getElementById('btn-next-step');
    const backBtn = document.getElementById('btn-back-to-stage-1');
    const pane1 = document.getElementById('pane-stage-1');
    const pane2 = document.getElementById('pane-stage-2');

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (currentAmountCents <= 0) {
          // Highlight amount display
          const hero = document.querySelector('.amount-hero');
          if (hero) {
            hero.style.borderColor = 'var(--color-danger)';
            setTimeout(() => hero.style.borderColor = '', 1000);
          }
          return;
        }

        pane1.style.display = 'none';
        pane2.style.display = 'flex';

        // Auto-focus donor name input
        const nameInput = document.getElementById('input-donor-name');
        if (nameInput) {
          setTimeout(() => nameInput.focus(), 50);
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        pane2.style.display = 'none';
        pane1.style.display = 'flex';
      });
    }
  }

  // --- Submission & Guardrails ---
  function setupSubmission() {
    const submitBtn = document.getElementById('btn-submit-pledge');
    if (!submitBtn) return;

    submitBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('input-donor-name');
      const donorName = (nameInput ? nameInput.value : '').trim();
      const phoneticInput = document.getElementById('input-donor-phonetic');
      const phonetic = (phoneticInput ? phoneticInput.value : '').trim();
      const isAnon = document.getElementById('input-is-anon')?.checked || false;
      const cardInput = document.getElementById('input-card-number');
      const cardNumber = (cardInput ? cardInput.value : '').trim();
      const tableInput = document.getElementById('input-table-number');
      const tableNumber = (tableInput ? tableInput.value : '').trim();

      const errorEl = document.getElementById('error-donor-name');

      if (!donorName) {
        if (errorEl) errorEl.style.display = 'block';
        if (nameInput) {
          nameInput.style.borderColor = 'var(--color-danger)';
          nameInput.focus();
        }
        return;
      }

      if (errorEl) errorEl.style.display = 'none';
      if (nameInput) nameInput.style.borderColor = '';

      const payload = {
        donation_id: activeDonationId,
        amount_cents: currentAmountCents,
        donor_name: donorName,
        display_name: isAnon ? 'Anonymous Supporter' : donorName,
        donor_phonetic: phonetic || null,
        table_number: tableNumber || null,
        is_anonymous: isAnon,
        payment_method: 'pledge',
        source: 'manual',
        card_number: cardNumber || null,
        entered_by: volunteerId
      };

      // Check Major Gift Guardrail (>= $9,500)
      if (currentAmountCents >= majorGiftThresholdCents) {
        pendingSubmission = payload;
        showGuardrailModal(payload);
      } else {
        await executeSubmission(payload);
      }
    });
  }

  function showGuardrailModal(payload) {
    const modal = document.getElementById('guardrail-modal');
    const amountEl = document.getElementById('guardrail-amount-text');
    const donorEl = document.getElementById('guardrail-donor-text');

    const dollars = Math.floor(payload.amount_cents / 100);
    if (amountEl) amountEl.textContent = `$${dollars.toLocaleString('en-US')}`;
    if (donorEl) donorEl.textContent = payload.donor_name;

    if (modal) modal.style.display = 'flex';
  }

  function setupGuardrailModal() {
    const modal = document.getElementById('guardrail-modal');
    const confirmBtn = document.getElementById('btn-guardrail-confirm');
    const cancelBtn = document.getElementById('btn-guardrail-cancel');

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (modal) modal.style.display = 'none';
        if (pendingSubmission) {
          const item = { ...pendingSubmission, confirmed_major_gift: true };
          pendingSubmission = null;
          await executeSubmission(item);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (modal) modal.style.display = 'none';
        pendingSubmission = null;
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
        modal.style.display = 'none';
        pendingSubmission = null;
      }
    });
  }

  async function executeSubmission(payload) {
    // Hide collision card
    const collisionCard = document.getElementById('collision-card');
    if (collisionCard) collisionCard.style.display = 'none';

    // Queue in outbox
    outbox.push(payload);
    saveOutbox();

    // Reset Form for next donor
    resetForm();

    // Switch back to Stage 1
    const pane1 = document.getElementById('pane-stage-1');
    const pane2 = document.getElementById('pane-stage-2');
    if (pane1 && pane2) {
      pane2.style.display = 'none';
      pane1.style.display = 'flex';
    }

    // Flush to server
    await flushOutbox();
  }

  function resetForm() {
    activeDonationId = generateUUID();
    currentAmountCents = 0;
    isPresetSelected = false;
    updateAmountDisplay();

    const nameInput = document.getElementById('input-donor-name');
    const phoneticInput = document.getElementById('input-donor-phonetic');
    const anonInput = document.getElementById('input-is-anon');
    const cardInput = document.getElementById('input-card-number');
    const tableInput = document.getElementById('input-table-number');

    if (nameInput) nameInput.value = '';
    if (phoneticInput) phoneticInput.value = '';
    if (anonInput) anonInput.checked = false;
    if (cardInput) cardInput.value = '';
    if (tableInput) tableInput.value = '';

    clearPresetHighlights();
  }

  // --- Outbox Flush & Duplicate Resolution ---
  async function flushOutbox() {
    if (outbox.length === 0) return;

    const queue = [...outbox];
    for (const item of queue) {
      try {
        const res = await fetch(`${API_BASE}/donation/${item.donation_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        });

        if (res.status === 409) {
          const collision = await res.json();
          // Remove from outbox so it doesn't loop
          outbox = outbox.filter(i => i.donation_id !== item.donation_id);
          saveOutbox();

          // Show non-destructive inline warning card
          const collisionCard = document.getElementById('collision-card');
          const collisionTitle = document.getElementById('collision-title');
          const collisionDesc = document.getElementById('collision-desc');
    clearTimeout(undoTimeout);
          if (collisionCard && collisionTitle && collisionDesc) {
            collisionTitle.textContent = `⚠️ Card #${collision.card_number} Already Entered`;
            collisionDesc.textContent = `Entered by ${collision.prior_entered_by || 'another clerk'}. Please verify physical card.`;
            collisionCard.style.display = 'block';
          }
          continue;
        }

        if (res.ok) {
          outbox = outbox.filter(i => i.donation_id !== item.donation_id);
          saveOutbox();

          showUndoToast(item);
        }
      } catch {
        // Network offline — will retry on next tick
        break;
      }
    }
  }

  // --- 8-Second Floating Undo Toast ---
  function showUndoToast(item) {
    lastSubmittedDonation = item;
    const toast = document.getElementById('undo-toast');
    const desc = document.getElementById('undo-toast-desc');

    if (!toast || !desc) return;

    const dollars = Math.floor(item.amount_cents / 100);
    desc.textContent = `$${dollars.toLocaleString('en-US')} — ${item.donor_name}`;
    toast.style.display = 'flex';

    clearTimeout(undoTimeout);
    undoTimeout = setTimeout(() => {
      toast.style.display = 'none';
      lastSubmittedDonation = null;
    }, 8000); // 8-second staging window
  }

  function setupUndo() {
    const undoBtn = document.getElementById('btn-toast-undo');
    if (!undoBtn) return;

    undoBtn.addEventListener('click', async () => {
      if (!lastSubmittedDonation) return;

      const item = lastSubmittedDonation;
      const toast = document.getElementById('undo-toast');
      if (toast) toast.style.display = 'none';

      try {
        const res = await fetch(`${API_BASE}/donation/${item.donation_id}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entered_by: volunteerId,
            reason: '1-tap volunteer undo from mobile pad'
          })
        });

        if (res.ok) {
          lastSubmittedDonation = null;
          pollState();
        }
      } catch {
        // Silently fail if unreachable
      }
    });
  }

  // --- 1-Second State Polling & Theme Sync ---
  async function pollState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=entry&volunteer_id=${encodeURIComponent(volunteerId)}`);
      const connDot = document.getElementById('conn-dot');

      if (!res.ok) {
        if (connDot) connDot.style.background = 'var(--color-danger)';
        return;
      }

      if (connDot) connDot.style.background = 'var(--color-success)';

      const data = await res.json();

      // Update major gift threshold
      if (data.major_gift_threshold_cents) {
        majorGiftThresholdCents = data.major_gift_threshold_cents;
      }

      // Update live total snippet
      const totalSnippet = document.getElementById('live-total-snippet');
      if (totalSnippet && data.total_raised_cents !== undefined) {
        const dollars = Math.floor(data.total_raised_cents / 100);
        totalSnippet.textContent = `$${dollars.toLocaleString('en-US')}`;
      }

      // Apply live theme custom properties
      if (data.theme) {
        document.documentElement.style.setProperty('--brand-hue', data.theme.hue);
        document.documentElement.style.setProperty('--brand-chroma', data.theme.chroma);
        if (data.theme.radius_px) {
          document.documentElement.style.setProperty('--brand-radius', `${data.theme.radius_px}px`);
        }
      }

      // Render personal audit log
      renderPersonalLog(data.personal_log || []);

    } catch {
      const connDot = document.getElementById('conn-dot');
      if (connDot) connDot.style.background = 'var(--color-danger)';
    }
  }

  function renderPersonalLog(logs) {
    const container = document.getElementById('personal-log-container');
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = `
        <div style="padding: var(--space-4); text-align: center; color: var(--ink-muted); font-size: var(--text-sm);">
          Awaiting first entry in this session...
        </div>
      `;
      return;
    }

    let html = `
      <table class="table-luxury">
        <thead>
          <tr>
            <th>Time</th>
            <th>Amount</th>
            <th>Donor</th>
            <th>Card #</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    logs.forEach((item) => {
      const timeStr = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const amountStr = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      const statusBadge = item.is_voided
        ? `<span class="badge badge-held">VOIDED</span>`
        : `<span class="badge badge-live">ACTIVE</span>`;

      html += `
        <tr style="${item.is_voided ? 'opacity: 0.45; text-decoration: line-through;' : ''}">
          <td style="color: var(--ink-muted); font-size: var(--text-xs);">${timeStr}</td>
          <td style="font-weight: 800; color: var(--brand-accent);">${amountStr}</td>
          <td style="font-weight: 600;">${escapeHTML(item.donor_name)}</td>
          <td class="mono" style="font-size: var(--text-xs);">${item.card_number || '-'}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    pollState();
    setInterval(pollState, 2000);
    setInterval(flushOutbox, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
