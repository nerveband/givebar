/**
 * Givebar — Presenter View Controller
 * Focuses on current donor name large, Name Pronunciation directly beneath at >= 20px (not italicized),
 * secondary amount, compact recent donations feed, and non-dominant milestone/total metrics.
 * Strict privacy shield: anonymous records never expose donor name, table number, or notes.
 */

(function () {
  'use strict';
  let pollInterval = null;
  let sseSource = null;
  let lastSuccessfulUpdateAt = Date.now();
  let serverTimeOffsetMs = 0;

  // DOM Elements
  const donorNameEl = document.getElementById('presenter-donor-name');
  const pronunciationEl = document.getElementById('presenter-pronunciation');
  const amountEl = document.getElementById('presenter-amount');
  const metaEl = document.getElementById('presenter-meta');
  const recentListEl = document.getElementById('presenter-recent-list');
  const recentCountEl = document.getElementById('presenter-recent-count');
  const milestoneTextEl = document.getElementById('presenter-milestone-text');
  const totalRaisedEl = document.getElementById('presenter-total-raised');
  const percentEl = document.getElementById('presenter-percent');
  const goalEl = document.getElementById('presenter-goal');

  function init() {
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

  function initSSE() {
    try {
      if (window.EventSource) {
        sseSource = new EventSource('/api/state/stream?role=emcee');
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
      const res = await fetch('/api/state?role=emcee', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();
      handleStateUpdate(data);
    } catch (err) {
      console.warn('[Givebar Presenter] State fetch failed:', err);
    }
  }
  function handleStateUpdate(data) {
    if (!data) return;
    lastSuccessfulUpdateAt = Date.now();
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

      // Name Pronunciation directly beneath, readable >= 20px, NOT italicized
      if (pronunciationEl) {
        if (!isAnon && currentGift.donor_phonetic && currentGift.donor_phonetic.trim()) {
          pronunciationEl.textContent = currentGift.donor_phonetic.trim();
          pronunciationEl.style.display = 'block';
        } else {
          pronunciationEl.style.display = 'none';
          pronunciationEl.textContent = '';
        }
      }

      // Secondary Amount
      if (amountEl) {
        amountEl.textContent = formatCurrency(currentGift.amount_cents);
        amountEl.style.display = 'block';
      }

      // Optional metadata (table number, notes) — stripped if anonymous!
      if (metaEl) {
        if (!isAnon && (currentGift.table_number || currentGift.notes)) {
          const parts = [];
          if (currentGift.table_number) parts.push(`Table ${currentGift.table_number}`);
          if (currentGift.notes) parts.push(currentGift.notes);
          metaEl.textContent = parts.join(' • ');
          metaEl.style.display = 'block';
        } else {
          metaEl.style.display = 'none';
          metaEl.textContent = '';
        }
      }
    } else {
      if (donorNameEl) donorNameEl.textContent = 'Awaiting First Gift...';
      if (pronunciationEl) pronunciationEl.style.display = 'none';
      if (amountEl) amountEl.style.display = 'none';
      if (metaEl) metaEl.style.display = 'none';
    }

    // 2. Compact Recent Donations Feed (Last 5 items)
    if (recentListEl) {
      const displayRecent = recentGifts.slice(0, 5);
      if (recentCountEl) {
        recentCountEl.textContent = `${displayRecent.length} gifts`;
      }

      if (displayRecent.length === 0) {
        recentListEl.innerHTML = `
          <div style="color: #88888e; font-size: var(--text-xs); padding: 8px 0; text-align: center;">
            Recent gifts will appear here live
          </div>
        `;
      } else {
        recentListEl.innerHTML = displayRecent.map(g => {
          const isAnon = Boolean(g.is_anonymous);
          const name = isAnon ? 'Anonymous Supporter' : (g.display_name || 'Anonymous Supporter');
          return `
            <div class="presenter-recent-row">
              <span class="presenter-recent-name">${escapeHTML(name)}</span>
              <span class="presenter-recent-amt">${formatCurrency(g.amount_cents)}</span>
            </div>
          `;
        }).join('');
      }
    }

    // 3. Secondary Metrics: Next Milestone & Total Raised (Never dominant)
    if (milestoneTextEl) {
      if (data.next_milestone) {
        const remaining = formatShortCurrency(data.next_milestone.remaining_cents);
        const target = formatShortCurrency(data.next_milestone.target_cents);
        milestoneTextEl.textContent = `${remaining} away (${target} target)`;
      } else if (data.goal_cents && data.total_raised_cents >= data.goal_cents) {
        milestoneTextEl.textContent = 'Goal Reached!';
      } else {
        milestoneTextEl.textContent = 'In progress';
      }
    }

    if (totalRaisedEl) {
      totalRaisedEl.textContent = formatCurrency(data.total_raised_cents || 0);
    }
    if (percentEl) {
      percentEl.textContent = `${data.percent || 0}%`;
    }
    if (goalEl) {
      goalEl.textContent = formatShortCurrency(data.goal_cents || 50000000);
    }
  }

  // --- Formatting Helpers ---
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
