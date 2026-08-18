/**
 * Givebar — AV & Admin Control Deck Controller
 */

(function () {
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
      const res = await fetch('/api/control', {
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

  // --- Emergency Actions ---
  function setupEmergencyActions() {
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

    // Force Odometer Resync
    const resyncBtn = document.getElementById('btn-resync-odometer');
    if (resyncBtn) {
      resyncBtn.addEventListener('click', async () => {
        if (confirm('Force Stage Odometer to immediately resync to true authoritative total? (Bypasses no-backward freeze)')) {
          await postControl({ action: 'resync_odometer' });
        }
      });
    }

    // Manual Override Total
    const overrideBtn = document.getElementById('btn-set-override');
    if (overrideBtn) {
      overrideBtn.addEventListener('click', async () => {
        const input = prompt('Enter manual override total in USD (or leave blank to clear override):');
        if (input === null) return;

        if (input.trim() === '') {
          await postControl({ action: 'clear_override' });
        } else {
          const dollars = parseFloat(input.replace(/[^0-9.]/g, ''));
          if (isNaN(dollars) || dollars < 0) {
            alert('Invalid dollar amount');
            return;
          }
          await postControl({ action: 'set_override', override_cents: Math.round(dollars * 100) });
        }
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
          const res = await fetch('/api/rehearsal', {
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
      wipeBtn.addEventListener('click', async () => {
        if (confirm('⚠️ CRITICAL WARNING: This will permanently delete all donations and reset the live gala ledger. Continue?')) {
          if (confirm('Type YES in your mind and click OK to confirm complete ledger wipe.')) {
            await postControl({ action: 'reset_ledger', confirm_wipe: true });
            alert('Ledger has been completely wiped for fresh rehearsal.');
          }
        }
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

      // Void Donation
      const voidBtn = e.target.closest('[data-void-id]');
      if (voidBtn) {
        const donationId = voidBtn.getAttribute('data-void-id');
        if (confirm(`Void donation ${donationId}? This will remove it from total calculations.`)) {
          try {
            const res = await fetch(`/api/donation/${donationId}/void`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entered_by: 'AV_CONTROL', reason: 'Voided from Control Deck' })
            });
            if (res.ok) {
              alert('Donation successfully voided.');
            }
          } catch {
            alert('Failed to void donation.');
          }
        }
        return;
      }
    });
  }

  // --- 1-Second Continuous State Polling ---
  async function pollControlState() {
    try {
      const res = await fetch('/api/state?role=control');
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

    let html = '';
    chyrons.forEach(item => {
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

      html += `
        <div class="delay-queue-item ${statusClass}">
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

          <div style="display: flex; align-items: center; gap: 12px;">
            ${statusBadge}
            ${yankBtn}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
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
