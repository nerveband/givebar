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
 */

(function () {
  'use strict';
  let serverTimeOffsetMs = 0;
  let historyOpen = false;
  let historySignature = null;
  let allGifts = [];
  let lastFontKey = null;

  // Font allowlist, identical resolution to the chart: 'system' and an unset
  // value both land on Brandon Grotesque, the licensed face for the surfaces
  // read under pressure. @font-face and --font-brandon live in tokens.css and
  // --font-brandon ends in the system stack, so a face that never arrives
  // still renders text.
  const FONT_STACKS = {
    system: 'var(--font-brandon)',
    brandon: 'var(--font-brandon)',
    humanist: 'var(--font-humanist)',
    grotesk: 'var(--font-grotesk)',
    mono: 'var(--font-mono)',
    serif: 'var(--font-serif)'
  };

  // Large enough that a fractional advance rounds away, small enough to lay out
  // instantly. The result is stored in em so it tracks the clamp() font-size.
  const DIGIT_PROBE_PX = 400;

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

  // Unlock removed: presenter feed is intentionally public.

  // --- Typeface + fixed-advance figures -------------------------------------

  /**
   * Brandon Grotesque has no tabular figures and no "tnum" feature to enable:
   * measured on this surface, digit advances span 74.81px to 124.81px at 200px.
   * Publishing the widest digit advance of the ACTIVE face lets every digit
   * render in an identical cell (.pv-digit), so the centered total stops
   * sliding sideways as it rolls.
   */
  function measureDigitCell() {
    if (!totalRaisedEl) return;
    const cs = window.getComputedStyle(totalRaisedEl);
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;letter-spacing:0;visibility:hidden;';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.fontSize = DIGIT_PROBE_PX + 'px';
    document.body.appendChild(probe);
    let widest = 0;
    for (let d = 0; d <= 9; d++) {
      probe.textContent = String(d);
      const w = probe.getBoundingClientRect().width;
      if (w > widest) widest = w;
    }
    probe.remove();
    if (widest > 0) {
      document.documentElement.style.setProperty(
        '--pv-digit-w', (widest / DIGIT_PROBE_PX).toFixed(4) + 'em'
      );
      // Cell width just changed, so every painted figure's em ratio is stale.
      refreshFigureMetrics();
    }
  }

  function figureMarkup(text) {
    let html = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      html += (ch >= '0' && ch <= '9')
        ? `<span class="pv-digit">${ch}</span>`
        : escapeHTML(ch);
    }
    return html;
  }

  /**
   * Width of a rendered figure expressed in em of its own font-size, measured
   * offscreen with the same face, weight, letter-spacing and digit cells. The
   * ratio is scale-invariant, which is what lets CSS turn it into a font-size
   * ceiling (100cqi / ratio) without a measure/resize feedback loop.
   */
  function measureFigureEm(el, text) {
    const cs = window.getComputedStyle(el);
    const fontPx = parseFloat(cs.fontSize) || 16;
    const trackingPx = parseFloat(cs.letterSpacing);
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden;';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.fontSize = DIGIT_PROBE_PX + 'px';
    probe.style.letterSpacing = Number.isFinite(trackingPx)
      ? (trackingPx / fontPx * DIGIT_PROBE_PX) + 'px'
      : 'normal';
    probe.innerHTML = figureMarkup(text);
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width / DIGIT_PROBE_PX;
  }

  function setFigureMetric(el) {
    const text = el && el.dataset.figure;
    if (!text) return;
    el.style.setProperty('--pv-fig-em', measureFigureEm(el, text).toFixed(3));
  }

  function refreshFigureMetrics() {
    setFigureMetric(totalRaisedEl);
    setFigureMetric(amountEl);
  }

  function scheduleDigitMeasure() {
    const run = () => window.requestAnimationFrame(measureDigitCell);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(run, run);
    } else {
      run();
    }
  }

  function applyFont(family) {
    const key = String(family || 'system');
    if (key === lastFontKey) return;
    lastFontKey = key;
    const stack = Object.prototype.hasOwnProperty.call(FONT_STACKS, key)
      ? FONT_STACKS[key]
      : FONT_STACKS.system;
    document.documentElement.style.setProperty('--pv-font', stack);
    scheduleDigitMeasure();
  }


  /**
   * Paint a currency figure with each digit in a fixed-advance cell. Guarded on
   * the rendered string so a 1.5s poll that changes nothing never rebuilds the
   * DOM under the emcee.
   */
  function renderFigure(el, text) {
    if (el.dataset.figure === text) return;
    el.dataset.figure = text;
    el.innerHTML = figureMarkup(text);
    setFigureMetric(el);
  }

  function init() {
    setupHistoryControls();
    scheduleDigitMeasure();
    startSync();
  }

  function startSync() {
    GivebarLive.connect({
      role: 'emcee',
      onState: handleStateUpdate,
      onServerTime: value => { serverTimeOffsetMs = value - Date.now(); },
      onLiveness(ok) {
        const dot = document.querySelector('.presenter-title .pulse-dot');
        const degradedBanner = document.getElementById('presenter-degraded-banner');
        if (dot) dot.classList.toggle('degraded', !ok);
        if (degradedBanner) degradedBanner.style.display = ok ? 'none' : 'inline-flex';
      }
    });
  }

  function handleStateUpdate(data) {
    if (!data) return;
    applyFont(data.font_family);

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
        renderFigure(amountEl, formatCurrency(currentGift.amount_cents));
        amountEl.style.display = 'block';
      }

      // Team notes never reach the podium; the meta line stays empty.
      if (metaEl) {
        metaEl.style.display = 'none';
        metaEl.textContent = '';
      }
    } else {
      if (donorNameEl) donorNameEl.textContent = 'No gifts yet';
      if (pronunciationBlockEl) pronunciationBlockEl.style.display = 'none';
      if (amountEl) amountEl.style.display = 'none';
      if (metaEl) metaEl.style.display = 'none';
    }

    // 2. Recent Gifts feed (last 5)
    if (recentListEl) {
      const displayRecent = recentGifts.slice(0, 5);
      if (recentCountEl) {
        recentCountEl.textContent = `${data.active_donation_count || 0} total`;
      }

      if (displayRecent.length === 0) {
        recentListEl.innerHTML = '<div class="presenter-empty">No gifts yet</div>';
      } else {
        recentListEl.innerHTML = displayRecent.map(renderGiftRow).join('');
      }
    }

    // 3. Full History source (server-shielded, held gifts excluded, newest first)
    allGifts = Array.isArray(data.all_gifts) ? data.all_gifts : recentGifts;
    renderHistory();

    // 4. Total Raised (prominent) + goal context
    if (totalRaisedEl) {
      renderFigure(totalRaisedEl, formatCurrency(data.total_raised_cents || 0));
    }
    if (percentEl) {
      percentEl.textContent = `${data.percent || 0}%`;
    }
    if (goalEl) {
      goalEl.textContent = formatShortCurrency(data.goal_cents || 50000000);
    }
    const progress = document.getElementById('presenter-progress');
    progress.value = data.goal_cents > 0 ? Math.min(100, Math.max(0, data.total_raised_cents / data.goal_cents * 100)) : 0;
    progress.setAttribute('aria-valuetext', `${formatCurrency(data.total_raised_cents || 0)} of ${formatCurrency(data.goal_cents || 0)}`);

    if (milestoneTextEl) {
      if (data.next_milestone) {
        const remaining = formatShortCurrency(data.next_milestone.remaining_cents);
        const name = (data.next_milestone.label || '').trim() || formatShortCurrency(data.next_milestone.target_cents);
        milestoneTextEl.textContent = `${remaining} to ${name}`;
      } else if (data.goal_cents && data.total_raised_cents >= data.goal_cents) {
        milestoneTextEl.textContent = 'Goal Reached';
      } else {
        milestoneTextEl.textContent = '\u2014';
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
      historyListEl.innerHTML = '<div class="presenter-empty">No gifts yet</div>';
      return;
    }
    historyListEl.innerHTML = allGifts.map(renderGiftRow).join('');
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
