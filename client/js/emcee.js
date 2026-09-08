/**
 * Givebar — Presenter View Controller
 *
 * Read by an emcee holding a microphone, often on a phone. Everything is scaled
 * for glanceability: large donor name, large non-italic pronunciation guide,
 * prominent running total, readable recent gifts, and a Full History view that
 * can be flicked through quickly.
 *
 * Invariants:
 *  - Held gifts never reach this surface (server getEmceeState already excludes them).
 *  - Strict privacy shield: anonymous records render as "Anonymous Supporter" with
 *    no real name, no notes, no phonetic guide, no other identifying metadata —
 *    in the hero card, the recent list, and the full history alike.
 *  - Table numbers are never rendered anywhere on this surface.
 *  - No fake zero total: a 401 shows the unlock screen instead of empty figures.
 */

(function () {
  'use strict';
  let pollInterval = null;
  let sseSource = null;
  let lastSuccessfulUpdateAt = Date.now();
  let serverTimeOffsetMs = 0;
  let hasLoadedState = false;
  let controlPin = '';
  let historyOpen = false;
  let historySignature = null;
  let allGifts = [];

  // DOM Elements
  const mainViewEl = document.getElementById('presenter-main');
  const donorNameEl = document.getElementById('presenter-donor-name');
  const pronunciationBlockEl = document.getElementById('presenter-pronunciation-block');
  const pronunciationEl = document.getElementById('presenter-pronunciation');
  const amountEl = document.getElementById('presenter-amount');
  const metaEl = document.getElementById('presenter-meta');
  const recentListEl = document.getElementById('presenter-recent-list');
  const recentCountEl = document.getElementById('presenter-recent-count');
  const milestoneTextEl = document.getElementById('presenter-milestone-text');
  const totalRaisedEl = document.getElementById('presenter-total-raised');
  const percentEl = document.getElementById('presenter-percent');
  const goalEl = document.getElementById('presenter-goal');
  const eventTitleEl = document.getElementById('presenter-event-title');

  // Full History
  const historyViewEl = document.getElementById('presenter-history-view');
  const historyListEl = document.getElementById('presenter-history-list');
  const historyCountEl = document.getElementById('presenter-history-count');
  const historyScrollEl = document.getElementById('presenter-history-scroll');
  const btnOpenHistory = document.getElementById('btn-full-history');
  const btnOpenHistoryInline = document.getElementById('btn-full-history-inline');
  const btnCloseHistory = document.getElementById('btn-close-history');

  // Unlock (only used when the server actually enforces a PIN)
  const unlockEl = document.getElementById('presenter-unlock');
  const unlockFormEl = document.getElementById('presenter-unlock-form');
  const unlockPinEl = document.getElementById('presenter-unlock-pin');
  const unlockSubmitEl = document.getElementById('presenter-unlock-submit');
  const unlockErrorEl = document.getElementById('presenter-unlock-error');

  function init() {
    try {
      controlPin = sessionStorage.getItem('givebar_control_pin') || '';
    } catch (e) {
      controlPin = '';
    }
    setupHistoryControls();
    setupUnlockForm();
    startSync();
  }

  function startSync() {
    fetchState();
    pollInterval = setInterval(fetchState, 1500);
    setInterval(checkStaleness, 1000);
    initSSE();
  }

  function checkStaleness() {
    const elapsed = Date.now() - lastSuccessfulUpdateAt;
    const isStale = elapsed >= 5000;
    const dot = document.querySelector('.presenter-title .pulse-dot');
    const degradedBanner = document.getElementById('presenter-degraded-banner');
    if (dot) {
      dot.classList.toggle('degraded', isStale);
    }
    if (degradedBanner) {
      degradedBanner.style.display = isStale ? 'inline-flex' : 'none';
    }
  }

  function stateQuery() {
    return controlPin
      ? `role=emcee&pin=${encodeURIComponent(controlPin)}`
      : 'role=emcee';
  }

  function initSSE() {
    try {
      if (window.EventSource) {
        if (sseSource) {
          sseSource.close();
          sseSource = null;
        }
        sseSource = new EventSource(`/api/state/stream?${stateQuery()}`);
        sseSource.onmessage = function (event) {
          try {
            const data = JSON.parse(event.data);
            handleStateUpdate(data);
          } catch (e) {}
        };
        sseSource.onerror = function () {
          if (sseSource) {
            sseSource.close();
            sseSource = null;
          }
        };
      }
    } catch (e) {}
  }

  async function fetchState() {
    try {
      const headers = { 'Cache-Control': 'no-cache' };
      if (controlPin) headers['X-Control-Pin'] = controlPin;
      const res = await fetch(`/api/state?${stateQuery()}`, { headers });
      if (res.status === 401) {
        // Never paint a fake zero total. A PIN is actually configured.
        setUnlockVisible(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setUnlockVisible(false);
      handleStateUpdate(data);
    } catch (err) {
      console.warn('[Givebar Presenter] State fetch failed:', err);
    }
  }

  function handleStateUpdate(data) {
    if (!data) return;
    lastSuccessfulUpdateAt = Date.now();
    hasLoadedState = true;
    if (data.server_time) {
      serverTimeOffsetMs = data.server_time - Date.now();
    }
    checkStaleness();

    // 1. Current / Latest Donor (Held items are already excluded by server getEmceeState)
    const recentGifts = Array.isArray(data.recent_gifts) ? data.recent_gifts : [];
    const topGifts = Array.isArray(data.top_gifts) ? data.top_gifts : [];

    // Most recent donation is primary highlight
    const currentGift = recentGifts.length > 0 ? recentGifts[0] : (topGifts.length > 0 ? topGifts[0] : null);

    if (currentGift) {
      const isAnon = Boolean(currentGift.is_anonymous);
      const displayName = isAnon ? 'Anonymous Supporter' : (currentGift.display_name || 'Anonymous Supporter');

      if (donorNameEl) {
        donorNameEl.textContent = displayName;
      }

      // Pronunciation guide — large, high-contrast, not italicized. Anonymous
      // gifts never expose a phonetic guide.
      if (pronunciationBlockEl && pronunciationEl) {
        if (!isAnon && currentGift.donor_phonetic && String(currentGift.donor_phonetic).trim()) {
          pronunciationEl.textContent = String(currentGift.donor_phonetic).trim();
          pronunciationBlockEl.style.display = 'block';
        } else {
          pronunciationBlockEl.style.display = 'none';
          pronunciationEl.textContent = '';
        }
      }

      if (amountEl) {
        amountEl.textContent = formatCurrency(currentGift.amount_cents);
        amountEl.style.display = 'block';
      }

      // Dedication note only. Table numbers are never rendered here.
      if (metaEl) {
        const note = !isAnon && currentGift.notes ? String(currentGift.notes).trim() : '';
        if (note) {
          metaEl.textContent = note;
          metaEl.style.display = 'block';
        } else {
          metaEl.style.display = 'none';
          metaEl.textContent = '';
        }
      }
    } else {
      if (donorNameEl) donorNameEl.textContent = 'Awaiting First Gift...';
      if (pronunciationBlockEl) pronunciationBlockEl.style.display = 'none';
      if (amountEl) amountEl.style.display = 'none';
      if (metaEl) metaEl.style.display = 'none';
    }

    // 2. Recent Gifts feed (last 5)
    if (recentListEl) {
      const displayRecent = recentGifts.slice(0, 5);
      if (recentCountEl) {
        recentCountEl.textContent = pluralGifts(displayRecent.length);
      }

      if (displayRecent.length === 0) {
        recentListEl.innerHTML = '<div class="presenter-empty">Recent gifts will appear here live</div>';
      } else {
        recentListEl.innerHTML = displayRecent.map(renderGiftRow).join('');
      }
    }

    // 3. Full History source (server-shielded, held gifts excluded, newest first)
    allGifts = Array.isArray(data.all_gifts) ? data.all_gifts : recentGifts;
    renderHistory();

    // 4. Total Raised (prominent) + goal context
    if (totalRaisedEl) {
      totalRaisedEl.textContent = formatCurrency(data.total_raised_cents || 0);
    }
    if (percentEl) {
      percentEl.textContent = `${data.percent || 0}%`;
    }
    if (goalEl) {
      goalEl.textContent = formatShortCurrency(data.goal_cents || 50000000);
    }

    if (milestoneTextEl) {
      if (data.next_milestone) {
        const remaining = formatShortCurrency(data.next_milestone.remaining_cents);
        const target = formatShortCurrency(data.next_milestone.target_cents);
        milestoneTextEl.textContent = `${remaining} to ${target}`;
      } else if (data.goal_cents && data.total_raised_cents >= data.goal_cents) {
        milestoneTextEl.textContent = 'Goal Reached';
      } else {
        milestoneTextEl.textContent = 'In progress';
      }
    }

    // 5. Event identity (emcee payload field `event_title`)
    if (eventTitleEl) {
      const title = typeof data.event_title === 'string' ? data.event_title.trim() : '';
      eventTitleEl.textContent = title;
      eventTitleEl.hidden = title === '';
    }
  }

  // --- Gift Rows (shared by recent list and full history) ---
  function renderGiftRow(gift) {
    const isAnon = Boolean(gift.is_anonymous);
    // Privacy shield: anonymous gifts expose the amount only.
    const name = isAnon ? 'Anonymous Supporter' : (gift.display_name || 'Anonymous Supporter');
    return `
      <div class="presenter-row">
        <span class="presenter-row-name${isAnon ? ' anon' : ''}">${escapeHTML(name)}</span>
        <span class="presenter-row-amt">${formatCurrency(gift.amount_cents)}</span>
      </div>
    `;
  }

  // --- Full History ---
  function setupHistoryControls() {
    if (btnOpenHistory) btnOpenHistory.addEventListener('click', openHistory);
    if (btnOpenHistoryInline) btnOpenHistoryInline.addEventListener('click', openHistory);
    if (btnCloseHistory) btnCloseHistory.addEventListener('click', closeHistory);
    document.addEventListener('keydown', (e) => {
      if (historyOpen && e.key === 'Escape') {
        closeHistory();
      }
    });
  }

  function openHistory() {
    if (!historyViewEl) return;
    historyOpen = true;
    historyViewEl.hidden = false;
    if (mainViewEl) mainViewEl.hidden = true;
    renderHistory();
    if (historyScrollEl) {
      historyScrollEl.scrollTop = 0;
      historyScrollEl.focus();
    }
  }

  function closeHistory() {
    if (!historyViewEl) return;
    historyOpen = false;
    historyViewEl.hidden = true;
    if (mainViewEl) mainViewEl.hidden = false;
    if (btnOpenHistory) btnOpenHistory.focus();
  }

  function renderHistory() {
    if (!historyListEl) return;
    if (historyCountEl) {
      historyCountEl.textContent = pluralGifts(allGifts.length);
    }

    // Avoid re-painting (and losing the emcee's scroll position) when nothing changed.
    const signature = allGifts.map(g =>
      `${g.donation_id || ''}:${g.amount_cents || 0}:${g.is_anonymous ? 1 : 0}:${g.is_anonymous ? '' : (g.display_name || '')}`
    ).join('|');
    if (signature === historySignature) return;
    historySignature = signature;

    if (allGifts.length === 0) {
      historyListEl.innerHTML = '<div class="presenter-empty">No gifts recorded yet</div>';
      return;
    }
    historyListEl.innerHTML = allGifts.map(renderGiftRow).join('');
  }

  // --- Unlock (only when the server enforces a PIN) ---
  function setUnlockVisible(visible) {
    if (!unlockEl) return;
    unlockEl.hidden = !visible;
    if (visible) {
      if (mainViewEl) mainViewEl.hidden = true;
      if (historyViewEl) historyViewEl.hidden = true;
      historyOpen = false;
      if (unlockPinEl && document.activeElement !== unlockPinEl) {
        setTimeout(() => unlockPinEl.focus(), 50);
      }
    } else if (!historyOpen && mainViewEl) {
      mainViewEl.hidden = false;
    }
  }

  function setupUnlockForm() {
    if (!unlockFormEl) return;
    unlockFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = (unlockPinEl && unlockPinEl.value || '').trim();
      if (!pin) {
        showUnlockError('Enter the event PIN.');
        return;
      }
      showUnlockError('');
      if (unlockSubmitEl) unlockSubmitEl.disabled = true;
      try {
        const res = await fetch(`/api/state?role=emcee&pin=${encodeURIComponent(pin)}`, {
          headers: { 'X-Control-Pin': pin, 'Cache-Control': 'no-cache' }
        });
        if (res.status === 401) {
          showUnlockError('Invalid PIN.');
          if (unlockPinEl) unlockPinEl.select();
          return;
        }
        if (!res.ok) {
          showUnlockError('Server error validating PIN.');
          return;
        }
        const data = await res.json();
        controlPin = pin;
        try { sessionStorage.setItem('givebar_control_pin', pin); } catch (err) {}
        setUnlockVisible(false);
        handleStateUpdate(data);
        initSSE();
      } catch (err) {
        showUnlockError('Network error connecting to server.');
      } finally {
        if (unlockSubmitEl) unlockSubmitEl.disabled = false;
      }
    });
  }

  function showUnlockError(msg) {
    if (!unlockErrorEl) return;
    unlockErrorEl.textContent = msg || '';
    unlockErrorEl.style.display = msg ? 'block' : 'none';
  }

  // --- Formatting Helpers ---
  function pluralGifts(n) {
    return `${n} ${n === 1 ? 'gift' : 'gifts'}`;
  }

  function formatCurrency(cents) {
    return `$${Math.floor((cents || 0) / 100).toLocaleString('en-US')}`;
  }

  function formatShortCurrency(cents) {
    const dollars = Math.floor((cents || 0) / 100);
    if (dollars === 0) return '$0';
    if (dollars >= 1000000) {
      const m = dollars / 1000000;
      return `$${Number(m.toFixed(1))}M`;
    }
    if (dollars >= 1000) {
      const k = dollars / 1000;
      return `$${Number(k.toFixed(0))}k`;
    }
    return `$${dollars}`;
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
