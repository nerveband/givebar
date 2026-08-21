/**
 * Givebar — Podium Screen Controller (/emcee)
 * High-contrast OLED monitor, 3-second glance hierarchy, vocal shoutout cards
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

      // 1. Total Raised & Goal Percentage
      const totalEl = document.getElementById('emcee-total-raised');
      const percentEl = document.getElementById('emcee-percent');
      const goalEl = document.getElementById('emcee-goal');
      const countEl = document.getElementById('emcee-active-count');
      const subTitleEl = document.getElementById('emcee-subtitle');

      if (totalEl && data.total_raised_cents !== undefined) {
        totalEl.textContent = `$${Math.floor(data.total_raised_cents / 100).toLocaleString('en-US')}`;
      }

      if (percentEl && data.percent !== undefined) {
        percentEl.textContent = `${data.percent}%`;
      }

      if (goalEl && data.goal_cents) {
        goalEl.textContent = `$${Math.floor(data.goal_cents / 100).toLocaleString('en-US')}`;
      }

      if (countEl && data.active_donation_count !== undefined) {
        countEl.textContent = data.active_donation_count.toLocaleString('en-US');
      }

      if (subTitleEl && data.event_name) {
        subTitleEl.textContent = `${data.event_name} • ${data.event_subtitle || 'Live Appeal'}`;
      }

      // 2. Next Milestone Target
      const gapEl = document.getElementById('emcee-milestone-gap');
      const nameEl = document.getElementById('emcee-milestone-name');

      if (gapEl && nameEl) {
        if (data.next_milestone) {
          const remainingDollars = Math.floor(data.next_milestone.remaining_cents / 100);
          gapEl.textContent = `$${remainingDollars.toLocaleString('en-US')} to go`;
          nameEl.textContent = `Goal: ${data.next_milestone.label} ($${Math.floor(data.next_milestone.target_cents / 100).toLocaleString('en-US')})`;
        } else {
          gapEl.textContent = 'All Milestones Cleared!';
          nameEl.textContent = 'Fundraising goal achieved';
        }
      }

      // 3. Active Matching Grant Badge
      const matchBadge = document.getElementById('emcee-match-badge');
      const matchPool = document.getElementById('emcee-match-pool');

      if (matchBadge && matchPool) {
        if (data.is_match_active && data.match_pool_cents > 0) {
          matchPool.textContent = `$${Math.floor(data.match_pool_cents / 100).toLocaleString('en-US')}`;
          matchBadge.style.display = 'inline-flex';
        } else {
          matchBadge.style.display = 'none';
        }
      }

      // 4. Apply Live Theme Tokens
      if (data.theme) {
        document.documentElement.style.setProperty('--brand-hue', data.theme.hue);
        document.documentElement.style.setProperty('--brand-chroma', data.theme.chroma);
        if (data.theme.radius_px) {
          document.documentElement.style.setProperty('--brand-radius', `${data.theme.radius_px}px`);
        }
      }

      // 5. Render Top 5 Largest Gifts & Recent Stream
      renderTopGifts(data.top_gifts || []);
      renderRecentGifts(data.recent_gifts || []);

    } catch {
      // Ignore network hiccup
    }
  }

  function renderTopGifts(gifts) {
    const container = document.getElementById('top-gifts-container');
    if (!container) return;

    if (gifts.length === 0) {
      container.innerHTML = `
        <div style="color: var(--ink-muted); font-size: var(--text-sm); text-align: center; padding: var(--space-6);">
          Awaiting first major gift...
        </div>
      `;
      return;
    }

    let html = '';
    gifts.forEach((item, index) => {
      const dollars = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      const phoneticGuide = item.donor_phonetic
        ? `<div style="font-size: var(--text-xs); color: var(--color-warning); font-style: italic;">Pronounce: ${escapeHTML(item.donor_phonetic)}</div>`
        : '';
      const tableTag = item.table_number
        ? `<span class="badge" style="background: var(--bg-canvas); color: var(--ink-secondary);">Table ${escapeHTML(item.table_number)}</span>`
        : '';

      html += `
        <div class="shoutout-card">
          <div>
            <div style="font-size: var(--text-base); font-weight: 800; color: var(--ink-primary);">
              #${index + 1} • ${escapeHTML(item.display_name)}
            </div>
            ${phoneticGuide}
            ${item.notes ? `<div style="font-size: var(--text-xs); color: var(--ink-muted); margin-top: 2px;">${escapeHTML(item.notes)}</div>` : ''}
          </div>

          <div style="display: flex; align-items: center; gap: var(--space-2);">
            ${tableTag}
            <div style="font-size: var(--text-lg); font-weight: 900; color: var(--brand-accent);" class="tabular">
              ${dollars}
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function renderRecentGifts(gifts) {
    const container = document.getElementById('recent-gifts-container');
    if (!container) return;

    if (gifts.length === 0) {
      container.innerHTML = `
        <div style="color: var(--ink-muted); font-size: var(--text-sm); text-align: center; padding: var(--space-6);">
          Awaiting incoming gifts...
        </div>
      `;
      return;
    }

    let html = '';
    gifts.forEach((item) => {
      const dollars = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;
      const timeStr = item.seconds_ago < 60
        ? `${item.seconds_ago}s ago`
        : `${Math.floor(item.seconds_ago / 60)}m ago`;

      html += `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle);">
          <div>
            <div style="font-size: var(--text-sm); font-weight: 700;">${escapeHTML(item.display_name)}</div>
            ${item.donor_phonetic ? `<div style="font-size: var(--text-xs); color: var(--color-warning);">${escapeHTML(item.donor_phonetic)}</div>` : ''}
            <div style="font-size: var(--text-xs); color: var(--ink-muted);">${timeStr}</div>
          </div>
          <div style="font-size: var(--text-base); font-weight: 900; color: var(--brand-accent);" class="tabular">
            ${dollars}
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
