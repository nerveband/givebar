/**
 * Givebar — Emcee Confidence Monitor Controller
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  function init() {
    startPolling();
  }

  async function pollEmceeState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=emcee`);
      if (!res.ok) return;

      const data = await res.json();

      // 1. Authoritative Total
      const totalDollars = Math.floor(data.total_raised_cents / 100);
      document.getElementById('emcee-total-raised').textContent = `$${totalDollars.toLocaleString('en-US')}`;

      // 2. Goal & Percent
      const goalDollars = Math.floor(data.goal_cents / 100);
      document.getElementById('emcee-goal').textContent = `$${goalDollars.toLocaleString('en-US')}`;
      document.getElementById('emcee-percent').textContent = `${data.percent}%`;
      document.getElementById('emcee-active-count').textContent = data.active_donation_count || 0;

      // 3. Matching Pool Badge
      const matchBadge = document.getElementById('emcee-match-badge');
      const matchPoolEl = document.getElementById('emcee-match-pool');
      if (data.is_match_active) {
        matchBadge.style.display = 'inline-block';
        matchPoolEl.textContent = `$${Math.floor(data.match_pool_cents / 100).toLocaleString('en-US')}`;
      } else {
        matchBadge.style.display = 'none';
      }

      // 4. Next Milestone Gap
      const milestoneGapEl = document.getElementById('emcee-milestone-gap');
      const milestoneNameEl = document.getElementById('emcee-milestone-name');

      if (data.next_milestone) {
        const remainingDollars = Math.floor(data.next_milestone.remaining_cents / 100);
        const targetDollars = Math.floor(data.next_milestone.target_cents / 100);
        milestoneGapEl.textContent = `$${remainingDollars.toLocaleString('en-US')} needed`;
        milestoneNameEl.textContent = `to reach $${targetDollars.toLocaleString('en-US')} (${data.next_milestone.label})`;
      } else {
        milestoneGapEl.textContent = '🎉 All Milestones Reached!';
        milestoneNameEl.textContent = 'Gala goal has been achieved or surpassed.';
      }

      // 5. Render Top 5 Largest Gifts
      renderTopGifts(data.top_gifts || []);

      // 6. Render Recent Pledges
      renderRecentGifts(data.recent_gifts || []);

    } catch {
      // Flapping tolerance
    }
  }

  let knownTopGiftIds = new Set();

  function renderTopGifts(gifts) {
    const container = document.getElementById('top-gifts-container');
    if (!container) return;

    if (gifts.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 14px; text-align: center; padding: 24px;">
          Awaiting first major gift...
        </div>
      `;
      return;
    }

    let html = '';
    gifts.forEach((item, index) => {
      const amountStr = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      const isNewMajor = !knownTopGiftIds.has(item.donation_id) && item.amount_cents >= 1000000;
      
      let noteBadge = '';
      if (item.notes) {
        const tableMatch = item.notes.match(/Table\s*#?\s*(\d+)/i);
        if (tableMatch) {
          noteBadge = `<span class="table-badge">TABLE ${tableMatch[1]}</span> <span style="font-size: 14px; font-weight: 700; color: var(--text-secondary); margin-left: 6px;">${escapeHTML(item.notes.replace(tableMatch[0], '').trim())}</span>`;
        } else {
          noteBadge = `<span style="font-size: 14px; font-weight: 700; color: var(--gold-300);">${escapeHTML(item.notes)}</span>`;
        }
      } else {
        noteBadge = `<span style="font-size: 13px; font-weight: 600; color: var(--text-muted);">General Gala Pledge</span>`;
      }

      html += `
        <div class="shoutout-card ${isNewMajor ? 'new-major-gift' : ''}">
          <div style="display: flex; align-items: center; gap: 14px;">
            <span style="font-size: 16px; font-weight: 900; color: var(--gold-400); min-width: 28px;">#${index + 1}</span>
            <div>
              <div style="font-size: 18px; font-weight: 800; color: var(--text-primary); letter-spacing: -0.01em;">${escapeHTML(item.display_name)}</div>
              <div style="margin-top: 4px; display: flex; align-items: center; gap: 6px;">
                ${noteBadge}
              </div>
            </div>
          </div>
          <div style="font-size: 24px; font-weight: 900; color: var(--gold-300); letter-spacing: -0.02em;">${amountStr}</div>
        </div>
      `;
    });

    // Track known IDs so beacon animation triggers only when fresh gifts enter top stack
    knownTopGiftIds = new Set(gifts.map(g => g.donation_id));
    container.innerHTML = html;
  }

  function renderRecentGifts(gifts) {
    const container = document.getElementById('recent-gifts-container');
    if (!container) return;

    if (gifts.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 14px; text-align: center; padding: 24px;">
          Awaiting live pledges...
        </div>
      `;
      return;
    }

    let html = '';
    gifts.forEach(item => {
      const amountStr = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      const timeAgo = item.seconds_ago < 5 ? 'Just now' : `${item.seconds_ago}s ago`;

      let noteSnippet = '';
      if (item.notes) {
        const tableMatch = item.notes.match(/Table\s*#?\s*(\d+)/i);
        if (tableMatch) {
          noteSnippet = `<span class="table-badge" style="font-size: 10px; padding: 2px 6px;">T${tableMatch[1]}</span>`;
        }
      }

      html += `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04);">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${noteSnippet}
            <div>
              <div style="font-size: 15px; font-weight: 700; color: var(--text-primary);">${escapeHTML(item.display_name)}</div>
              <div style="font-size: 12px; color: var(--text-muted);">${item.notes ? escapeHTML(item.notes) : 'Live Table Pledge'}</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 16px; font-weight: 800; color: var(--gold-300);">${amountStr}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${timeAgo}</div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    pollEmceeState();
    setInterval(pollEmceeState, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
