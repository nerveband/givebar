/**
 * Givebar — History Controller
 * Dense scannable vertical timeline displaying Added, Edited, Deleted, and Restored activity,
 * User attribution, relative timestamps, action filtering, search, and real ledger restore actions.
 */

(function () {
  'use strict';

  let rawEvents = [];
  let filterType = 'all'; // 'all' | 'create' | 'amend' | 'void' | 'restore'
  let searchQuery = '';
  let pollInterval = null;

  // DOM Elements
  const timelineEl = document.getElementById('history-timeline');
  const searchInput = document.getElementById('history-search');
  const filterChips = document.querySelectorAll('.filter-chip');

  function init() {
    setupFilters();
    setupSearch();
    syncHistory();
    pollInterval = setInterval(syncHistory, 2500);
  }

  function setupFilters() {
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        filterType = chip.getAttribute('data-filter') || 'all';
        renderTimeline();
      });
    });
  }

  function setupSearch() {
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim().toLowerCase();
        renderTimeline();
      });
    }
  }

  async function syncHistory() {
    try {
      const res = await fetch('/api/state?role=control', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();

      rawEvents = Array.isArray(data.recent_events) ? data.recent_events : [];
      renderTimeline();
    } catch (err) {
      console.warn('[Givebar History] Sync error:', err);
    }
  }

  function getFilteredEvents() {
    // Filter out internal match events from user history
    let events = rawEvents.filter(e => e.event_type !== 'match_apply' && e.event_type !== 'match_release');

    // Type filter
    if (filterType !== 'all') {
      events = events.filter(e => e.event_type === filterType);
    }

    // Search filter
    if (searchQuery) {
      events = events.filter(e => {
        const donor = (e.donor_name || '').toLowerCase();
        const display = (e.display_name || '').toLowerCase();
        const user = (e.entered_by || '').toLowerCase();
        return donor.includes(searchQuery) || display.includes(searchQuery) || user.includes(searchQuery);
      });
    }

    return events;
  }

  function renderTimeline() {
    if (!timelineEl) return;

    const events = getFilteredEvents();

    if (events.length === 0) {
      timelineEl.innerHTML = `
        <div style="color: #88888e; font-size: var(--text-sm); padding: var(--space-6) 0;">
          ${searchQuery || filterType !== 'all' ? 'No history events match your filter.' : 'No history recorded in this event.'}
        </div>
      `;
      return;
    }

    // Build map to detect previous amount on edits
    const seqToEvent = new Map(rawEvents.map(e => [e.seq, e]));

    timelineEl.innerHTML = events.map((event, idx) => {
      const actionName = getActionDisplay(event.event_type);
      const actionClass = event.event_type;
      const donorName = event.is_anonymous ? 'Anonymous' : (event.donor_name || 'Anonymous');
      const timeStr = formatRelativeTime(event.created_at);
      const userStr = formatUser(event.entered_by);

      // Amount calculation
      let amountDisplay = formatCurrency(event.amount_cents);
      if (event.event_type === 'amend' && event.supersedes_seq) {
        const prior = seqToEvent.get(event.supersedes_seq);
        if (prior && prior.amount_cents !== event.amount_cents) {
          amountDisplay = `${formatCurrency(prior.amount_cents)} &rarr; ${formatCurrency(event.amount_cents)}`;
        }
      }

      // Action button
      let actionBtnHtml = '';
      if (event.event_type === 'void') {
        actionBtnHtml = `<button type="button" class="btn-timeline-action" data-restore-id="${escapeHTML(event.donation_id)}">Restore</button>`;
      } else if (event.event_type === 'create' || event.event_type === 'restore') {
        actionBtnHtml = `<button type="button" class="btn-timeline-action" data-void-id="${escapeHTML(event.donation_id)}">Undo</button>`;
      }

      return `
        <div class="timeline-item" data-seq="${event.seq}">
          <div class="timeline-node" aria-hidden="true"></div>
          <div class="timeline-main-content">
            <div class="timeline-primary-line">
              <span class="timeline-action-tag ${actionClass}">${actionName}</span>
              <span class="timeline-sep">|</span>
              <span class="timeline-donor">${escapeHTML(donorName)}</span>
              <span class="timeline-sep">|</span>
              <span class="timeline-amount">${amountDisplay}</span>
            </div>
            <div class="timeline-sub-line">
              <span>${escapeHTML(userStr)}</span>
              <span>&bull;</span>
              <span>${timeStr}</span>
            </div>
          </div>
          <div>
            ${actionBtnHtml}
          </div>
        </div>
      `;
    }).join('');

    // Attach restore listeners
    timelineEl.querySelectorAll('[data-restore-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-restore-id');
        if (!id) return;
        btn.textContent = 'Restoring...';
        await executeRestore(id);
      });
    });

    // Attach void/undo listeners
    timelineEl.querySelectorAll('[data-void-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-void-id');
        if (!id) return;
        btn.textContent = 'Undoing...';
        await executeVoid(id);
      });
    });
  }

  async function executeRestore(donationId) {
    try {
      const res = await fetch(`/api/donation/${donationId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entered_by: 'User',
          reason: 'Restored from History timeline'
        })
      });

      if (res.ok) {
        syncHistory();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.message || 'Could not restore donation');
      }
    } catch (err) {
      console.warn('[Givebar History] Restore error:', err);
    }
  }

  async function executeVoid(donationId) {
    try {
      const res = await fetch(`/api/donation/${donationId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entered_by: 'User',
          reason: 'Undone from History timeline'
        })
      });

      if (res.ok) {
        syncHistory();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.message || 'Could not undo donation');
      }
    } catch (err) {
      console.warn('[Givebar History] Undo error:', err);
    }
  }

  function getActionDisplay(eventType) {
    switch (eventType) {
      case 'create': return 'Added';
      case 'amend': return 'Edited';
      case 'void': return 'Deleted';
      case 'restore': return 'Restored';
      default: return eventType;
    }
  }

  function formatUser(user) {
    if (!user) return 'User';
    // Language rule: User, never Operator or Clerk
    const cleaned = user.replace(/^(clerk|operator|v)_?/i, 'User ');
    return cleaned.startsWith('User') ? cleaned : `User ${cleaned}`;
  }

  function formatCurrency(cents) {
    return `$${Math.floor((cents || 0) / 100).toLocaleString('en-US')}`;
  }

  function formatRelativeTime(epochMs) {
    const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h`;
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
