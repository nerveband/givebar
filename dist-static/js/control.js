/**
 * Givebar — AV & Admin Control Deck Controller
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let controlPin = sessionStorage.getItem('givebar_control_pin') || '9999';
  let isFrozen = false;
  let hasPopulatedInputs = false;

  function init() {
    setupEmergencyActions();
    setupRehearsalActions();
    setupConfigForms();
    setupLedgerActions();

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
        alert(`Error: ${err.message || 'Action failed'}`);
        return null;
      }
      return await res.json();
    } catch {
      alert('Network error communicating with Givebar control server.');
      return null;
    }
  }

  // --- Non-Blocking Custom Modal Dialog Engine ---
  let activeModalCallback = null;

  function showCockpitModal({ icon = '⚡', title, desc, hasInput = false, inputPlaceholder = '', confirmText = 'Confirm', isDanger = false, onConfirm }) {
    const modal = document.getElementById('cockpit-modal');
    const iconEl = document.getElementById('cockpit-modal-icon');
    const titleEl = document.getElementById('cockpit-modal-title');
    const descEl = document.getElementById('cockpit-modal-desc');
    const inputWrap = document.getElementById('cockpit-modal-input-wrap');
    const inputEl = document.getElementById('cockpit-modal-input');
    const confirmBtn = document.getElementById('btn-cockpit-confirm');

    if (iconEl) iconEl.textContent = icon;
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;

    if (hasInput) {
      inputWrap.style.display = 'block';
      inputEl.value = '';
      inputEl.placeholder = inputPlaceholder;
      setTimeout(() => inputEl.focus(), 50);
    } else {
      inputWrap.style.display = 'none';
    }

    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
      if (isDanger) {
        confirmBtn.style.background = 'var(--crimson-500)';
        confirmBtn.style.color = '#FFFFFF';
      } else {
        confirmBtn.style.background = '';
        confirmBtn.style.color = '';
      }
    }

    activeModalCallback = onConfirm;
    modal.style.display = 'flex';
  }

  function setupModalListeners() {
    const modal = document.getElementById('cockpit-modal');
    const confirmBtn = document.getElementById('btn-cockpit-confirm');
    const cancelBtn = document.getElementById('btn-cockpit-cancel');
    const inputEl = document.getElementById('cockpit-modal-input');

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        const val = inputEl ? inputEl.value : '';
        modal.style.display = 'none';
        if (activeModalCallback) {
          const cb = activeModalCallback;
          activeModalCallback = null;
          cb(val);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        activeModalCallback = null;
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display === 'flex') {
        modal.style.display = 'none';
        activeModalCallback = null;
      }
      if (e.key === 'Enter' && modal.style.display === 'flex') {
        confirmBtn.click();
      }
    });
  }

  // --- Emergency Actions ---
  function setupEmergencyActions() {
    setupModalListeners();

    // Freeze / Unfreeze
    const freezeBtn = document.getElementById('btn-toggle-freeze');
    if (freezeBtn) {
      freezeBtn.addEventListener('click', async () => {
        const nextAction = isFrozen ? 'unfreeze' : 'freeze';
        const res = await postControl({ action: nextAction });
        if (res) {
          isFrozen = !isFrozen;
          updateFreezeBtn();
        }
      });
    }

    // Confetti
    const confettiBtn = document.getElementById('btn-fire-confetti');
    if (confettiBtn) {
      confettiBtn.addEventListener('click', async () => {
        await postControl({ action: 'trigger_confetti' });
      });
    }

    // Force Odometer Resync (Non-blocking Modal)
    const resyncBtn = document.getElementById('btn-resync-odometer');
    if (resyncBtn) {
      resyncBtn.addEventListener('click', () => {
        showCockpitModal({
          icon: '🔄',
          title: 'Force Stage Odometer Resync',
          desc: 'This will immediately force the ballroom projector odometer to match the authoritative ledger total, clearing any downward void freeze floor.',
          confirmText: 'Yes, Force Resync',
          isDanger: false,
          onConfirm: async () => {
            await postControl({ action: 'resync_odometer' });
          }
        });
      });
    }

    // Manual Override Total (Non-blocking Modal)
    const overrideBtn = document.getElementById('btn-set-override');
    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        showCockpitModal({
          icon: '⚡',
          title: 'Manual Total Override',
          desc: 'Enter emergency total in USD (or leave blank and confirm to clear override):',
          hasInput: true,
          inputPlaceholder: 'e.g. 750000',
          confirmText: 'Apply Override',
          onConfirm: async (input) => {
            if (!input || input.trim() === '') {
              await postControl({ action: 'clear_override' });
            } else {
              const dollars = parseFloat(input.replace(/[^0-9.]/g, ''));
              if (!isNaN(dollars) && dollars >= 0) {
                await postControl({ action: 'set_override', override_cents: Math.round(dollars * 100) });
              }
            }
          }
        });
      });
    }
  }

  function updateFreezeBtn() {
    const btn = document.getElementById('btn-toggle-freeze');
    const statusEl = document.getElementById('ctrl-display-status');
    if (btn) {
      btn.textContent = isFrozen ? '▶️ Resume Stage Screen' : '⏸️ Freeze Stage Screen';
      btn.style.color = isFrozen ? 'var(--emerald-400)' : '';
    }
    if (statusEl) {
      statusEl.textContent = isFrozen ? '⏸️ PAUSED / FROZEN' : '● BROADCASTING';
      statusEl.style.color = isFrozen ? 'var(--crimson-400)' : 'var(--emerald-400)';
    }
  }

  // --- Rehearsal Simulation Actions ---
  function setupRehearsalActions() {
    document.querySelectorAll('[data-sim]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-sim');
        try {
          const res = await fetch(`${API_BASE}/rehearsal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          if (!res.ok) {
            alert('Rehearsal simulation error');
          }
        } catch {
          alert('Network error injecting rehearsal mock data');
        }
      });
    });
  }

  // --- Configuration Forms ---
  function setupConfigForms() {
    // Save Goal
    const saveGoalBtn = document.getElementById('btn-save-goal');
    if (saveGoalBtn) {
      saveGoalBtn.addEventListener('click', async () => {
        const dollars = parseFloat(document.getElementById('input-goal-dollars').value || '0');
        if (dollars > 0) {
          await postControl({ action: 'set_goal', goal_cents: Math.round(dollars * 100) });
          alert('Fundraising goal updated.');
        }
      });
    }

    // Save Matching Configuration
    const saveMatchBtn = document.getElementById('btn-save-match');
    if (saveMatchBtn) {
      saveMatchBtn.addEventListener('click', async () => {
        const isActive = document.getElementById('input-match-active').checked;
        const poolDollars = parseFloat(document.getElementById('input-match-pool').value || '0');
        const ratio = parseFloat(document.getElementById('input-match-ratio').value || '1.0');
        const title = (document.getElementById('input-match-title').value || '').trim();

        await postControl({
          action: 'set_match',
          is_active: isActive,
          pool_cents: Math.round(poolDollars * 100),
          ratio: isNaN(ratio) ? 1.0 : ratio,
          sponsor_title: title
        });
        alert('Matching grant configuration saved.');
      });
    }

    // Save QR Target URL
    const saveQrBtn = document.getElementById('btn-save-qr');
    if (saveQrBtn) {
      saveQrBtn.addEventListener('click', async () => {
        const url = (document.getElementById('input-qr-url').value || '').trim();
        if (url) {
          await postControl({ action: 'set_qr_url', qr_donate_url: url });
          alert('Stage QR code target URL updated.');
        }
      });
    }
  }

  // --- Ledger Actions & Wiping ---
  function setupLedgerActions() {
    const wipeBtn = document.getElementById('btn-wipe-ledger');
    if (wipeBtn) {
      wipeBtn.addEventListener('click', () => {
        showCockpitModal({
          icon: '⚠️',
          title: 'Wipe All Ledger Data',
          desc: 'CRITICAL: This will permanently delete all pledges and reset the live gala ledger for a fresh rehearsal.',
          confirmText: 'YES, WIPE ALL DATA',
          isDanger: true,
          onConfirm: async () => {
            await postControl({ action: 'reset_ledger', confirm_wipe: true });
          }
        });
      });
    }

    // Delegate Void & Yank buttons
    document.addEventListener('click', async (e) => {
      // Yank Chyron
      const yankBtn = e.target.closest('[data-yank-id]');
      if (yankBtn) {
        const donationId = yankBtn.getAttribute('data-yank-id');
        await postControl({ action: 'yank_chyron', donation_id: donationId });
        return;
      }

      // Unyank Chyron
      const unyankBtn = e.target.closest('[data-unyank-id]');
      if (unyankBtn) {
        const donationId = unyankBtn.getAttribute('data-unyank-id');
        await postControl({ action: 'unyank_chyron', donation_id: donationId });
        return;
      }

      // Void Donation (Non-blocking Modal)
      const voidBtn = e.target.closest('[data-void-id]');
      if (voidBtn) {
        const donationId = voidBtn.getAttribute('data-void-id');
        showCockpitModal({
          icon: '🗑️',
          title: 'Void Pledge',
          desc: `Void pledge ${donationId}? This will remove it from the authoritative gala total and stage display.`,
          confirmText: 'Void Pledge',
          isDanger: true,
          onConfirm: async () => {
            try {
              const res = await fetch(`${API_BASE}/donation/${donationId}/void`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entered_by: 'AV_CONTROL', reason: 'Voided from Control Deck' })
              });
              if (res.ok) {
                pollControlState();
              }
            } catch {}
          }
        });
        return;
      }
    });
  }

  // --- 1-Second Continuous State Polling ---
  async function pollControlState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=control`);
      if (!res.ok) return;

      const data = await res.json();
      const eventState = data.event_state;
      const folded = data.folded;

      isFrozen = Boolean(eventState.is_frozen);
      updateFreezeBtn();

      // Top Metrics
      const totalRaised = eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents;
      document.getElementById('ctrl-total-raised').textContent = `$${Math.floor(totalRaised / 100).toLocaleString('en-US')}`;
      document.getElementById('ctrl-direct-raised').textContent = `$${Math.floor(folded.direct_raised_cents / 100).toLocaleString('en-US')}`;
      document.getElementById('ctrl-match-applied').textContent = `$${Math.floor(folded.match_applied_cents / 100).toLocaleString('en-US')}`;
      document.getElementById('ctrl-active-count').textContent = `${folded.active_donation_count} active pledges`;

      const pct = eventState.goal_cents > 0 ? Math.round((totalRaised / eventState.goal_cents) * 100) : 0;
      document.getElementById('ctrl-goal-progress').textContent = `${pct}% of $${Math.floor(eventState.goal_cents / 100).toLocaleString('en-US')} goal`;

      const matchStatus = document.getElementById('ctrl-match-status');
      if (matchStatus) {
        matchStatus.textContent = eventState.is_match_active
          ? `Active ($${Math.floor(eventState.match_pool_cents / 100).toLocaleString('en-US')} pool remaining)`
          : 'Match Inactive';
        matchStatus.style.color = eventState.is_match_active ? 'var(--emerald-400)' : 'var(--text-muted)';
      }

      // Populate Inputs once initially
      if (!hasPopulatedInputs) {
        hasPopulatedInputs = true;
        document.getElementById('input-goal-dollars').value = Math.floor(eventState.goal_cents / 100);
        document.getElementById('input-match-active').checked = Boolean(eventState.is_match_active);
        document.getElementById('input-match-pool').value = Math.floor(eventState.match_pool_cents / 100);
        document.getElementById('input-match-ratio').value = eventState.match_ratio;
        document.getElementById('input-match-title').value = eventState.match_sponsor_title || '';
        document.getElementById('input-qr-url').value = eventState.qr_donate_url || '';
      }

      // Render Delay Buffer Queue
      renderChyronQueue(data.staged_chyrons || []);

      // Render Ledger Table
      renderLedgerTable(data.recent_events || []);

    } catch {
      // Flap tolerance
    }
  }

  // --- DOM Diffing Delay Buffer Queue (Preserves Clicks and Hover State) ---
  function renderChyronQueue(chyrons) {
    const container = document.getElementById('chyron-queue-container');
    if (!container) return;

    if (chyrons.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 40px;">
          No recent pledge transactions in buffer.
        </div>
      `;
      return;
    }

    // Remove placeholder if present
    const placeholder = container.querySelector('div[style*="text-align: center"]');
    if (placeholder) placeholder.remove();

    const currentIds = new Set(chyrons.map(c => c.donation_id));

    // Remove dead items
    Array.from(container.children).forEach(child => {
      const id = child.getAttribute('data-item-id');
      if (id && !currentIds.has(id)) {
        child.remove();
      }
    });

    // Update or insert items
    chyrons.forEach((item, index) => {
      const amountStr = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      let statusClass = item.is_live_on_stage ? 'live' : 'staged';
      if (item.is_yanked) statusClass = 'yanked';

      let statusBadge = '';
      if (item.is_yanked) {
        statusBadge = `<span style="font-size: 11px; font-weight: 800; color: var(--crimson-400); background: rgba(239, 68, 68, 0.15); padding: 3px 8px; border-radius: 6px;">YANKED (BLOCKED)</span>`;
      } else if (!item.is_live_on_stage) {
        statusBadge = `<span class="countdown-chip">BROADCASTING IN ${item.remaining_delay_sec}s</span>`;
      } else {
        statusBadge = `<span style="font-size: 11px; font-weight: 800; color: var(--emerald-400); background: rgba(74, 222, 128, 0.15); padding: 3px 8px; border-radius: 6px;">LIVE ON STAGE</span>`;
      }

      let yankBtn = '';
      if (item.is_yanked) {
        yankBtn = `<button type="button" class="btn-secondary" data-unyank-id="${item.donation_id}" style="padding: 6px 12px; font-size: 12px;">Un-Yank</button>`;
      } else {
        yankBtn = `<button type="button" class="btn-danger" data-yank-id="${item.donation_id}" style="padding: 6px 14px; font-size: 13px; font-weight: 800;">🛑 YANK</button>`;
      }

      let existing = container.querySelector(`[data-item-id="${item.donation_id}"]`);
      if (existing) {
        // In-place update without DOM wipe
        existing.className = `delay-queue-item ${statusClass}`;
        const actionWrap = existing.querySelector('.queue-action-wrap');
        if (actionWrap) {
          actionWrap.innerHTML = `${statusBadge} ${yankBtn}`;
        }
      } else {
        // Prepend new element
        const el = document.createElement('div');
        el.className = `delay-queue-item ${statusClass}`;
        el.setAttribute('data-item-id', item.donation_id);
        el.innerHTML = `
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
              <span style="font-size: 17px; font-weight: 800; color: var(--gold-300);">${amountStr}</span>
              <span style="font-size: 15px; font-weight: 700; color: var(--text-primary);">${escapeHTML(item.display_name)}</span>
              ${item.is_anonymous ? '<span style="font-size: 10px; color: var(--text-muted); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">ANON</span>' : ''}
            </div>
            <div style="font-size: 12px; color: var(--text-muted);">
              Legal: ${escapeHTML(item.donor_name)} • Card: ${item.card_number || '-'} • Clerk: ${item.entered_by || '-'}
            </div>
          </div>
          <div class="queue-action-wrap" style="display: flex; align-items: center; gap: 12px;">
            ${statusBadge}
            ${yankBtn}
          </div>
        `;

        if (container.children[index]) {
          container.insertBefore(el, container.children[index]);
        } else {
          container.appendChild(el);
        }
      }
    });
  }

  function renderLedgerTable(events) {
    const tbody = document.getElementById('ledger-table-body');
    if (!tbody) return;

    if (events.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">
            Ledger is currently empty.
          </td>
        </tr>
      `;
      return;
    }

    let html = '';
    events.forEach(ev => {
      const amountStr = `$${Math.floor(ev.amount_cents / 100).toLocaleString('en-US')}`;
      let typeBadge = `<span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-muted);">${ev.event_type}</span>`;
      
      if (ev.event_type === 'create') {
        typeBadge = `<span style="font-size: 11px; font-weight: 800; color: var(--emerald-400);">CREATE</span>`;
      } else if (ev.event_type === 'match_apply') {
        typeBadge = `<span style="font-size: 11px; font-weight: 800; color: var(--gold-300);">MATCH</span>`;
      } else if (ev.event_type === 'void') {
        typeBadge = `<span style="font-size: 11px; font-weight: 800; color: var(--crimson-400);">VOID</span>`;
      }

      html += `
        <tr style="${ev.event_type === 'void' ? 'opacity: 0.5; text-decoration: line-through;' : ''}">
          <td style="font-family: monospace; font-size: 12px; color: var(--text-muted);">#${ev.seq}</td>
          <td>${typeBadge}</td>
          <td style="font-weight: 800; color: var(--gold-300);">${amountStr}</td>
          <td style="font-weight: 600;">${escapeHTML(ev.donor_name)}</td>
          <td style="color: var(--text-secondary);">${escapeHTML(ev.display_name || '-')}</td>
          <td style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">${ev.payment_method}</td>
          <td style="font-size: 12px; color: var(--text-muted);">${ev.source}</td>
          <td style="font-family: monospace; font-size: 12px;">${ev.card_number || '-'}</td>
          <td style="font-size: 12px; color: var(--text-muted);">${ev.entered_by || '-'}</td>
          <td>
            ${ev.event_type !== 'void' && ev.event_type !== 'match_apply'
              ? `<button type="button" class="btn-danger" data-void-id="${ev.donation_id}" style="padding: 4px 8px; font-size: 11px;">Void</button>`
              : '-'}
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    pollControlState();
    setInterval(pollControlState, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
