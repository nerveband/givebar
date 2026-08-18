/**
 * Givebar — Volunteer Rapid Entry Terminal Controller
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
  let selectedMethod = 'pledge';
  let activeDonationId = generateUUID();
  let lastSubmittedDonation = null;
  let undoTimeout = null;
  let pendingSubmission = null;

  // Outbox for offline resilience
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');

  function saveOutbox() {
    localStorage.setItem('givebar_outbox', JSON.stringify(outbox));
  }

  function generateUUID() {
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
    setupPaymentMethods();
    setupSubmission();
    setupUndo();
    setupGuardrailModal();

    startPolling();
    flushOutbox();
  }

  // --- Numpad & Amount Controls ---
  function updateAmountDisplay() {
    const displayEl = document.getElementById('amount-display');
    if (!displayEl) return;
    const dollars = Math.floor(currentAmountCents / 100);
    displayEl.textContent = `$${dollars.toLocaleString('en-US')}`;
  }

  function setupNumpad() {
    const numpad = document.getElementById('numpad');
    if (!numpad) return;

    numpad.addEventListener('click', (e) => {
      const btn = e.target.closest('.numpad-btn');
      if (!btn) return;

      const key = btn.getAttribute('data-key');
      let currentDollars = Math.floor(currentAmountCents / 100);

      if (key === 'backspace') {
        const str = currentDollars.toString();
        const nextStr = str.length > 1 ? str.slice(0, -1) : '0';
        currentDollars = parseInt(nextStr, 10) || 0;
      } else if (key === '00') {
        currentDollars = currentDollars * 100;
      } else if (/\d/.test(key)) {
        const digit = parseInt(key, 10);
        currentDollars = currentDollars * 10 + digit;
      }

      // Max ceiling $10,000,000 to prevent runaway overflow
      if (currentDollars > 10000000) currentDollars = 10000000;
      currentAmountCents = currentDollars * 100;
      updateAmountDisplay();

      // Clear tier preset highlights if custom
      document.querySelectorAll('#tier-grid .tier-btn').forEach(b => {
        b.classList.toggle('selected', b.getAttribute('data-cents') === currentAmountCents.toString());
      });
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
        updateAmountDisplay();
      }
    });
  }

  function setupPaymentMethods() {
    document.querySelectorAll('[data-method]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-method]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedMethod = btn.getAttribute('data-method') || 'pledge';
      });
    });
  }

  // --- Submission & $9,500 Guardrail ---
  function setupSubmission() {
    const submitBtn = document.getElementById('btn-submit-pledge');
    if (!submitBtn) return;

    submitBtn.addEventListener('click', () => {
      const donorName = (document.getElementById('input-donor-name').value || '').trim();
      const isAnon = document.getElementById('input-is-anon').checked;
      const cardNumber = (document.getElementById('input-card-number').value || '').trim();
      const notes = (document.getElementById('input-notes').value || '').trim();

      if (currentAmountCents <= 0) {
        alert('Please enter a pledge amount greater than $0.');
        return;
      }

      if (!donorName) {
        alert('Please enter the donor name (or legal contact name).');
        document.getElementById('input-donor-name').focus();
        return;
      }

      const payload = {
        donation_id: activeDonationId,
        amount_cents: currentAmountCents,
        donor_name: donorName,
        display_name: isAnon ? 'Anonymous Supporter' : donorName,
        is_anonymous: isAnon,
        payment_method: selectedMethod,
        source: 'manual',
        card_number: cardNumber || null,
        entered_by: volunteerId,
        notes: notes || null
      };

      // Check $9,500 Major Gift Guardrail
      if (currentAmountCents >= 950000) {
        pendingSubmission = payload;
        showGuardrailModal(payload);
      } else {
        executeSubmission(payload);
      }
    });
  }

  function showGuardrailModal(payload) {
    const modal = document.getElementById('guardrail-modal');
    const amountEl = document.getElementById('guardrail-amount-text');
    const donorEl = document.getElementById('guardrail-donor-text');
    const cardEl = document.getElementById('guardrail-card-text');

    const dollars = Math.floor(payload.amount_cents / 100);
    amountEl.textContent = `$${dollars.toLocaleString('en-US')}`;
    donorEl.textContent = payload.donor_name;
    cardEl.textContent = payload.card_number || 'None specified';

    modal.style.display = 'flex';
  }

  function setupGuardrailModal() {
    const modal = document.getElementById('guardrail-modal');
    const confirmBtn = document.getElementById('btn-guardrail-confirm');
    const cancelBtn = document.getElementById('btn-guardrail-cancel');

    confirmBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      if (pendingSubmission) {
        const item = pendingSubmission;
        pendingSubmission = null;
        executeSubmission(item);
      }
    });

    cancelBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      pendingSubmission = null;
    });
  }

  async function executeSubmission(payload) {
    // Add to local outbox
    outbox.push(payload);
    saveOutbox();

    // Reset Form for next donor immediately
    resetForm();

    // Attempt network flush
    await flushOutbox();
  }

  function resetForm() {
    activeDonationId = generateUUID();
    currentAmountCents = 0;
    updateAmountDisplay();

    document.getElementById('input-donor-name').value = '';
    document.getElementById('input-is-anon').checked = false;
    document.getElementById('input-card-number').value = '';
    document.getElementById('input-notes').value = '';

    document.querySelectorAll('#tier-grid .tier-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-cents') === '0');
    });

    document.getElementById('input-donor-name').focus();
  }

  // --- Outbox Flush & Idempotent API ---
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
          // Card Serial Collision Error
          const collision = await res.json();
          alert(`⚠️ COLLISION WARNING:\n${collision.message}\nThis pledge was NOT submitted.`);
          // Remove from outbox so it doesn't loop
          outbox = outbox.filter(i => i.donation_id !== item.donation_id);
          saveOutbox();
          continue;
        }

        if (res.ok) {
          // Success or duplicate receipt
          outbox = outbox.filter(i => i.donation_id !== item.donation_id);
          saveOutbox();

          // Show 1-Tap Undo Banner for this item
          showUndoBanner(item);
        }
      } catch {
        // Network offline — will retry next tick
        break;
      }
    }
  }

  // --- 1-Tap Undo ---
  function showUndoBanner(item) {
    lastSubmittedDonation = item;
    const banner = document.getElementById('undo-banner');
    const desc = document.getElementById('undo-desc');

    const dollars = Math.floor(item.amount_cents / 100);
    desc.textContent = `$${dollars.toLocaleString('en-US')} from ${item.donor_name}`;
    banner.style.display = 'flex';

    if (undoTimeout) clearTimeout(undoTimeout);
    undoTimeout = setTimeout(() => {
      banner.style.display = 'none';
      lastSubmittedDonation = null;
    }, 25000); // 25s window for 1-tap undo
  }

  function setupUndo() {
    const undoBtn = document.getElementById('btn-undo');
    if (!undoBtn) return;

    undoBtn.addEventListener('click', async () => {
      if (!lastSubmittedDonation) return;

      const item = lastSubmittedDonation;
      const banner = document.getElementById('undo-banner');
      banner.style.display = 'none';

      try {
        const res = await fetch(`${API_BASE}/donation/${item.donation_id}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entered_by: volunteerId,
            reason: '1-tap volunteer undo from terminal'
          })
        });

        if (res.ok) {
          alert(`Undid pledge for $${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}.`);
        }
      } catch {
        alert('Failed to contact server to undo pledge. Please notify AV control deck.');
      }
    });
  }

  // --- Background Polling (State & Personal Audit Log) ---
  async function pollState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=entry&volunteer_id=${encodeURIComponent(volunteerId)}`);
      const connDot = document.getElementById('conn-dot');

      if (!res.ok) {
        if (connDot) connDot.style.background = 'var(--crimson-400)';
        return;
      }

      if (connDot) connDot.style.background = 'var(--emerald-400)';

      const data = await res.json();

      // Update live gala total snippet
      const totalSnippet = document.getElementById('live-total-snippet');
      if (totalSnippet) {
        const dollars = Math.floor(data.total_raised_cents / 100);
        totalSnippet.textContent = `$${dollars.toLocaleString('en-US')}`;
      }

      // Update personal audit log
      renderPersonalLog(data.personal_log || []);

    } catch {
      const connDot = document.getElementById('conn-dot');
      if (connDot) connDot.style.background = 'var(--crimson-400)';
    }
  }

  function renderPersonalLog(logs) {
    const container = document.getElementById('personal-log-container');
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 14px; text-align: center; padding: 20px;">
          No entries recorded in this session yet.
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
        ? `<span style="color: var(--crimson-400); font-weight: 800; font-size: 11px;">VOIDED</span>`
        : `<span style="color: var(--emerald-400); font-weight: 800; font-size: 11px;">ACTIVE</span>`;

      html += `
        <tr style="${item.is_voided ? 'opacity: 0.5; text-decoration: line-through;' : ''}">
          <td style="color: var(--text-muted); font-size: 12px;">${timeStr}</td>
          <td style="font-weight: 800; color: var(--gold-300);">${amountStr}</td>
          <td style="font-weight: 600;">${escapeHTML(item.donor_name)}</td>
          <td style="font-family: monospace; font-size: 12px;">${item.card_number || '-'}</td>
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
