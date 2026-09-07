/**
 * Givebar — Fullscreen Bar Chart Controller
 * Dominant rolling odometer, horizontal progress bar, milestone scale,
 * explicit reflow layout states, contrast-verified custom bar color,
 * independent settings toggles, and live stream updates.
 */

(function () {
  'use strict';

  let odometer = null;
  let lastTotalCents = 0;
  let currentQrUrl = '';
  let lastSuccessfulUpdateAt = Date.now();
  let serverTimeOffsetMs = 0;
  let pollInterval = null;
  let sseSource = null;
  const stageCanvas = document.getElementById('stage-canvas');
  const odometerEl = document.getElementById('main-odometer');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const barTrack = document.getElementById('stage-bar-track');
  const goalAmountText = document.getElementById('goal-amount-text');
  const stageGoalWrap = document.getElementById('stage-goal-wrap');
  const liveIndicator = document.getElementById('stage-live-indicator');
  const logoWrap = document.getElementById('stage-logo-wrap');
  const logoImg = document.getElementById('stage-logo-img');
  const stageMessageBar = document.getElementById('stage-message-bar');
  const milestonesScale = document.getElementById('stage-milestones-scale');
  const recentFeedList = document.getElementById('recent-donations-feed');
  const qrImg = document.getElementById('stage-qr-img');
  const qrUrlText = document.getElementById('stage-qr-url');
  const matchBanner = document.getElementById('stage-match-banner');
  const matchText = document.getElementById('stage-match-text');
  const freezeBanner = document.getElementById('stage-freeze-banner');

  function init() {
    initOdometer();
    setupFullscreenShortcut();
    startSync();
  }

  function initOdometer() {
    if (odometerEl && window.RollingOdometer) {
      odometer = new RollingOdometer(odometerEl, {
        currency: '$',
        showCents: false,
        allowBackward: false,
        initialValue: 0
      });
    }
  }

  // --- Realtime Sync (SSE with Polling Fallback) ---
  function startSync() {
    fetchState();
    pollInterval = setInterval(fetchState, 1500);
    setInterval(checkStaleness, 1000);
    initSSE();
  }

  function checkStaleness() {
    const elapsed = Date.now() - lastSuccessfulUpdateAt;
    const isStale = elapsed >= 5000;
    const dot = liveIndicator ? liveIndicator.querySelector('.pulse-dot') : null;
    const liveText = liveIndicator ? liveIndicator.querySelector('span:last-child') : null;

    if (dot) {
      dot.classList.toggle('degraded', isStale);
    }
    if (liveText) {
      liveText.textContent = isStale ? 'Reconnecting' : 'Live';
      liveText.style.color = isStale ? '#88888e' : '#d4a359';
    }
  }

  function initSSE() {
    try {
      if (window.EventSource) {
        sseSource = new EventSource('/api/state/stream?role=stage');
        sseSource.onmessage = function (event) {
          try {
            const data = JSON.parse(event.data);
            handleStateUpdate(data);
          } catch (e) {
            // Ignore parse errors, polling covers it
          }
        };
        sseSource.onerror = function () {
          if (sseSource) {
            sseSource.close();
            sseSource = null;
          }
        };
      }
    } catch (e) {
      // EventSource unavailable
    }
  }

  async function fetchState() {
    try {
      const res = await fetch('/api/state?role=stage', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();
      handleStateUpdate(data);
    } catch (err) {
      console.warn('[Givebar Stage] State fetch failed:', err);
    }
  }

  // --- State Application & Layout Reflow ---
  function handleStateUpdate(data) {
    if (!data) return;
    lastSuccessfulUpdateAt = Date.now();
    if (data.server_time) {
      serverTimeOffsetMs = data.server_time - Date.now();
    }
    checkStaleness();
    // 1. Total Raised Odometer
    const totalCents = data.total_raised_cents || 0;
    if (odometer) {
      odometer.update(totalCents);
    } else if (odometerEl) {
      odometerEl.textContent = formatCurrency(totalCents);
    }
    lastTotalCents = totalCents;

    // 2. Goal & Progress Percentage
    const goalCents = data.goal_cents || 50000000;
    const showGoal = data.show_goal !== undefined ? Boolean(data.show_goal) : true;
    if (stageGoalWrap) {
      stageGoalWrap.style.display = showGoal ? 'block' : 'none';
    }
    if (goalAmountText) {
      goalAmountText.textContent = formatShortCurrency(goalCents);
    }

    const percent = goalCents > 0
      ? Math.min(100, Math.max(0, (totalCents / goalCents) * 100))
      : 0;
    if (progressBarFill) {
      progressBarFill.style.width = `${percent}%`;
    }

    // 3. Bar Color Customization & Contrast Verification
    applyBarColor(data.bar_color);

    // 4. Background Style
    applyBackgroundStyle(data.background_style || 'plain');

    // 5. Live Indicator Toggle
    const showLive = data.show_live_indicator !== undefined ? Boolean(data.show_live_indicator) : true;
    if (liveIndicator) {
      liveIndicator.style.display = showLive ? 'inline-flex' : 'none';
    }

    // 6. Logo Area (collapses cleanly when empty)
    if (logoWrap && logoImg) {
      const logoUrl = (data.logo_url || '').trim();
      if (logoUrl) {
        if (logoImg.getAttribute('src') !== logoUrl) {
          logoImg.src = logoUrl;
        }
        logoWrap.style.display = 'inline-flex';
      } else {
        logoWrap.style.display = 'none';
      }
    }

    // 7. Stage Message Line
    const showMessage = Boolean(data.stage_message_visible);
    const messageText = (data.stage_message || '').trim();
    if (stageMessageBar) {
      if (showMessage && messageText) {
        stageMessageBar.textContent = messageText;
        stageMessageBar.style.display = 'block';
      } else {
        stageMessageBar.style.display = 'none';
      }
    }

    // 8. Milestones Scale
    renderMilestonesScale(data.milestones || [], goalCents);

    // 9. CRITICAL REFLOW: Layout State Computation
    const showRecent = data.show_recent_donations !== undefined ? Boolean(data.show_recent_donations) : true;
    const showQr = data.show_qr !== undefined ? Boolean(data.show_qr) : true;

    let layoutState = 'full';
    if (!showRecent && !showQr) {
      layoutState = 'minimal';
    } else if (showRecent && !showQr) {
      layoutState = 'recent-only';
    } else if (!showRecent && showQr) {
      layoutState = 'qr-only';
    } else {
      layoutState = 'full';
    }

    if (stageCanvas) {
      stageCanvas.setAttribute('data-layout', layoutState);
    }

    // 10. Recent Donations List
    if (showRecent) {
      renderRecentDonations(data.chyrons || []);
    }

    // 11. QR Code & Donation Link
    if (showQr) {
      renderQR(data.qr_donate_url);
    }

    // 12. Matching Sponsor Banner
    if (matchBanner) {
      if (data.is_match_active) {
        matchBanner.style.display = 'inline-flex';
        if (matchText) {
          matchText.textContent = `${data.match_sponsor_title || 'Matching Sponsor'} • Double Your Impact`;
        }
      } else {
        matchBanner.style.display = 'none';
      }
    }

    // 13. Freeze Notice
    if (freezeBanner) {
      freezeBanner.style.display = data.is_frozen ? 'inline-flex' : 'none';
    }
  }

  // --- Milestone Scale Rendering ---
  function renderMilestonesScale(milestones, goalCents) {
    if (!milestonesScale) return;

    // Use default intervals if none configured
    let items = Array.isArray(milestones) && milestones.length > 0
      ? milestones
      : [
          { cents: 0, label: '$0' },
          { cents: Math.round(goalCents * 0.25), label: formatShortCurrency(Math.round(goalCents * 0.25)) },
          { cents: Math.round(goalCents * 0.5), label: formatShortCurrency(Math.round(goalCents * 0.5)) },
          { cents: Math.round(goalCents * 0.75), label: formatShortCurrency(Math.round(goalCents * 0.75)) },
          { cents: goalCents, label: formatShortCurrency(goalCents) }
        ];
    // Ensure 0 is represented
    if (!items.some(m => m.cents === 0)) {
      items = [{ cents: 0, label: '$0' }, ...items];
    }
    // Ensure goal is represented
    if (!items.some(m => m.cents >= goalCents)) {
      items.push({ cents: goalCents, label: formatShortCurrency(goalCents) });
    }

    // Sort by cents ascending
    items.sort((a, b) => a.cents - b.cents);

    // Deduplicate ticks that land on the exact same percentage (within 2%)
    const uniqueItems = [];
    const seenPcts = new Set();
    for (const m of items) {
      const pct = goalCents > 0 ? Math.min(100, Math.max(0, Math.round((m.cents / goalCents) * 100))) : 0;
      if (!seenPcts.has(pct)) {
        seenPcts.add(pct);
        uniqueItems.push({ ...m, pct });
      }
    }

    // Render scale ticks
    const ticksHtml = uniqueItems.map(m => {
      const displayLabel = formatShortCurrency(m.cents);
      return `
        <div class="scale-tick" style="left: ${m.pct}%;">
          <div class="scale-tick-line"></div>
          <span class="scale-tick-label">${displayLabel}</span>
        </div>
      `;
    }).join('');

    milestonesScale.innerHTML = `<div class="milestones-scale-axis"></div>${ticksHtml}`;
  }

  // --- Recent Donations Feed ---
  function renderRecentDonations(chyrons) {
    if (!recentFeedList) return;

    const top3 = chyrons.slice(0, 3);
    if (top3.length === 0) {
      recentFeedList.innerHTML = `
        <div style="color: #88888e; font-size: var(--text-sm); font-style: italic;">
          Recent donations will appear here live...
        </div>
      `;
      return;
    }

    recentFeedList.innerHTML = top3.map(c => `
      <div class="recent-feed-item">
        <span class="recent-feed-avatar" aria-hidden="true"></span>
        <span class="recent-feed-donor">${escapeHTML(c.display_name || 'Anonymous Supporter')}</span>
        <span class="recent-feed-amount">${formatCurrency(c.amount_cents)}</span>
      </div>
    `).join('');
  }

  // --- QR Code & Donation Link ---
  function renderQR(url) {
    const cleanUrl = url || 'https://example.org/donate';
    if (qrUrlText) {
      // Show clean host + path without https://
      const displayUrl = cleanUrl.replace(/^https?:\/\//i, '');
      qrUrlText.textContent = displayUrl;
    }

    if (qrImg && cleanUrl !== currentQrUrl) {
      currentQrUrl = cleanUrl;
      qrImg.src = `/api/qr?url=${encodeURIComponent(cleanUrl)}&margin=1`;
    }
  }

  // --- Bar Color & Contrast Verification ---
  function applyBarColor(customColor) {
    if (!progressBarFill) return;

    const defaultAmber = '#d4a359';
    if (!customColor || typeof customColor !== 'string' || !customColor.trim()) {
      progressBarFill.style.backgroundColor = defaultAmber;
      return;
    }

    const color = customColor.trim();
    if (isValidContrast(color, '#15161a')) {
      progressBarFill.style.backgroundColor = color;
    } else {
      // Contrast failed, fallback to amber
      progressBarFill.style.backgroundColor = defaultAmber;
    }
  }

  /**
   * Contrast ratio calculation (WCAG relative luminance against track #15161a)
   * Track #15161a has relative luminance ~0.007
   * Requires contrast ratio >= 3:1 for graphical objects
   */
  function isValidContrast(fgHex, bgHex) {
    try {
      const L1 = getLuminance(fgHex);
      const L2 = getLuminance(bgHex);
      if (isNaN(L1) || isNaN(L2)) return false;

      const lighter = Math.max(L1, L2);
      const darker = Math.min(L1, L2);
      const ratio = (lighter + 0.05) / (darker + 0.05);
      return ratio >= 3.0;
    } catch {
      return false;
    }
  }

  function getLuminance(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    if (clean.length !== 6) return NaN;

    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;

    const sRGB = [r, g, b].map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
  }

  // --- Background Style Application ---
  function applyBackgroundStyle(style) {
    const valid = style === 'subtle-gradient' || style === 'vignette' ? style : 'plain';
    document.body.setAttribute('data-bg-style', valid);
  }

  // --- Formatting Helpers ---
  function formatCurrency(cents) {
    return `$${Math.floor(cents / 100).toLocaleString('en-US')}`;
  }

  function formatShortCurrency(cents) {
    const dollars = Math.floor(cents / 100);
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

  function setupFullscreenShortcut() {
    document.addEventListener('keydown', e => {
      if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      }
    });

    document.addEventListener('dblclick', () => {
      toggleFullscreen();
    });
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
