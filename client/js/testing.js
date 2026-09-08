/**
 * Givebar — Testing / Rehearsal Controller
 * Isolated sample data generator, persistent test mode indicator,
 * sample-tagged record feed, and isolated rehearsal purge.
 */

(function () {
  'use strict';

  let pollInterval = null;
  let sampleRecords = [];

  // DOM Elements
  const testModeBanner = document.getElementById('test-mode-banner');
  const testBannerDesc = document.getElementById('test-banner-desc');
  const btnPurgeSampleData = document.getElementById('btn-purge-sample-data');
  const sampleCountBadge = document.getElementById('sample-count-badge');
  const sampleRecordsTbody = document.getElementById('sample-records-tbody');
  const sampleCleanState = document.getElementById('sample-clean-state');
  const feedbackEl = document.getElementById('test-feedback');

  // Generator Buttons
  const btnGenSingle = document.getElementById('btn-gen-single');
  const btnGenBurst = document.getElementById('btn-gen-burst');
  const btnGenTypo = document.getElementById('btn-gen-typo');
  const btnGenMilestone = document.getElementById('btn-gen-milestone');

  // Auth Elements
  const unlockScreen = document.getElementById('unlock-screen');
  const unlockForm = document.getElementById('unlock-form');
  const unlockPinInput = document.getElementById('unlock-pin-input');
  const btnSubmitUnlock = document.getElementById('btn-submit-unlock');
  const unlockError = document.getElementById('unlock-error');
  const authView = document.getElementById('authenticated-view');

  // PIN Helpers
  function getControlPin() {
    return sessionStorage.getItem('givebar_control_pin') || localStorage.getItem('givebar_control_pin') || '';
  }

  function setControlPin(pin) {
    sessionStorage.setItem('givebar_control_pin', pin);
    localStorage.setItem('givebar_control_pin', pin);
  }

  function clearControlPin() {
    sessionStorage.removeItem('givebar_control_pin');
    localStorage.removeItem('givebar_control_pin');
  }

  // The unlock screen only ever appears after the server answers 401.
  // When no Control Room PIN is configured, the operator walks straight in.
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
    setupGenerators();
    setupPurge();
    setupUnlockForm();
    syncState();
    pollInterval = setInterval(syncState, 2000);
  }

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
        setControlPin(pin);
        setAuthUIState('authenticated');
        applyState(data);
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

  // --- Operator Feedback ---
  function showFeedback(msg, tone) {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.className = `test-feedback ${tone === 'error' ? 'error' : 'ok'}`;
    feedbackEl.style.display = 'block';
  }

  // --- Generator Action Handlers ---
  function setupGenerators() {
    wireGenerator(btnGenSingle, { mode: 'single' }, 'Injected 1 sample gift.');
    wireGenerator(btnGenBurst, { mode: 'burst', count: 7 }, 'Injected a burst of 7 sample gifts.');
    wireGenerator(btnGenTypo, { mode: 'typo' }, 'Injected the typo gift.');
    wireGenerator(btnGenMilestone, { mode: 'milestone' }, 'Injected the gift that crosses the next milestone.');
  }

  function wireGenerator(button, body, successMsg) {
    if (!button) return;
    const originalLabel = button.textContent;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Generating...';
      try {
        const result = await postRehearsal(body);
        if (result.ok) {
          showFeedback(successMsg, 'ok');
        } else {
          showFeedback(result.message, 'error');
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  }

  async function postRehearsal(body) {
    const pin = getControlPin();
    try {
      const res = await fetch('/api/rehearsal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': pin
        },
        body: JSON.stringify({ ...body, pin })
      });
      if (res.status === 401) {
        clearControlPin();
        setAuthUIState('unauthenticated');
        return { ok: false, message: 'Control Room PIN required.' };
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return { ok: false, message: errData.message || `Sample data generation failed (HTTP ${res.status}).` };
      }
      await syncState();
      return { ok: true };
    } catch (err) {
      console.warn('[Givebar Testing] Rehearsal generation error:', err);
      return { ok: false, message: 'Network error generating sample data.' };
    }
  }

  function setupPurge() {
    if (!btnPurgeSampleData) return;
    btnPurgeSampleData.addEventListener('click', async () => {
      const pin = getControlPin();
      btnPurgeSampleData.disabled = true;
      btnPurgeSampleData.textContent = 'Purging...';
      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Control-Pin': pin
          },
          body: JSON.stringify({ action: 'purge_rehearsal', pin })
        });

        if (res.status === 401) {
          clearControlPin();
          setAuthUIState('unauthenticated');
          return;
        }
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showFeedback(errData.message || `Purge failed (HTTP ${res.status}).`, 'error');
          return;
        }
        await syncState();
        showFeedback('Sample data purged. Real donations were left untouched.', 'ok');
      } catch (err) {
        console.warn('[Givebar Testing] Purge failed:', err);
        showFeedback('Network error purging sample data.', 'error');
      } finally {
        btnPurgeSampleData.disabled = false;
        btnPurgeSampleData.textContent = 'Purge Sample Data';
      }
    });
  }

  // --- Sync & Render Sample Records ---
  async function syncState() {
    const pin = getControlPin();
    try {
      const res = await fetch(`/api/state?role=control&pin=${encodeURIComponent(pin)}`, {
        headers: { 'X-Control-Pin': pin, 'Cache-Control': 'no-cache' }
      });
      if (res.status === 401) {
        clearControlPin();
        setAuthUIState('unauthenticated');
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setAuthUIState('authenticated');
      applyState(data);
    } catch (err) {
      console.warn('[Givebar Testing] Sync state error:', err);
    }
  }

  function applyState(data) {
    const chyrons = Array.isArray(data.staged_chyrons) ? data.staged_chyrons : [];
    sampleRecords = chyrons.filter(c => c.source === 'rehearsal');
    renderSampleView();
  }

  function renderSampleView() {
    const count = sampleRecords.length;

    // 1. Persistent Test Mode Banner
    if (testModeBanner) {
      if (count > 0) {
        testModeBanner.style.display = 'flex';
        if (testBannerDesc) {
          testBannerDesc.textContent = `${count} sample record${count === 1 ? '' : 's'} active. Purging removes only sample data.`;
        }
      } else {
        testModeBanner.style.display = 'none';
      }
    }

    if (sampleCountBadge) {
      sampleCountBadge.textContent = `${count} active record${count === 1 ? '' : 's'}`;
    }

    // 2. Table or Clean State
    if (!sampleRecordsTbody || !sampleCleanState) return;

    if (count === 0) {
      sampleRecordsTbody.innerHTML = '';
      sampleCleanState.style.display = 'block';
    } else {
      sampleCleanState.style.display = 'none';
      sampleRecordsTbody.innerHTML = sampleRecords.map(item => {
        const timeStr = formatRelativeTime(item.created_at);
        const amountStr = `$${Math.floor((item.amount_cents || 0) / 100).toLocaleString('en-US')}`;
        const statusBadge = item.is_held
          ? '<span style="color: #f87171; font-weight: 700; font-size: var(--text-xs);">&#x25A0; HELD</span>'
          : '<span style="color: #d4a359; font-weight: 700; font-size: var(--text-xs);">&#x25CF; ACTIVE</span>';

        return `
          <tr>
            <td style="font-weight: 600; color: #f4f5f6;">
              ${escapeHTML(item.donor_name || 'Anonymous Supporter')}
              <span class="sample-tag">[Sample Data]</span>
            </td>
            <td class="text-right" style="font-weight: 700; font-variant-numeric: tabular-nums; color: #f4f5f6;">
              ${amountStr}
            </td>
            <td class="text-center" style="color: #88888e; font-size: var(--text-xs);">
              ${timeStr}
            </td>
            <td class="text-center">
              ${statusBadge}
            </td>
          </tr>
        `;
      }).join('');
    }
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
