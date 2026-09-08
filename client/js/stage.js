/**
 * Givebar — Fullscreen Bar Chart Controller (audience-facing)
 *
 * Owns: live sync, branding, horizontal/vertical thermometer geometry,
 * milestone scale, recent-donation feed, QR split, and the opt-in ?edit=1
 * WYSIWYG path.
 *
 * MOTION CHOREOGRAPHY (see tokens: --dur-*, --ease-out)
 *   total increases   roll + fill + single decaying glow pulse
 *                     trigger: total_raised_cents rises
 *                     roll  --dur-roll ease-out (odometer.js, per-digit stagger)
 *                     fill  --dur-roll ease-out, transform: scaleX/scaleY only
 *                     pulse --dur-pulse ease-out, ONE run, opacity+scale, decays to 0
 *                     interrupt: a newer total retargets the same transform and
 *                                restarts the pulse from frame 0; newest wins
 *                     reduced: fill snaps, pulse becomes an opacity-only fade,
 *                              digits land without reel travel
 *   donation arrives  feed slides down by exactly the number of new rows
 *                     --dur-conf ease-out, transform on the list, fixed-height
 *                     viewport, so nothing below can reflow
 *                     reduced: no slide, new rows cross-fade in
 *   milestone reached tick line + label recolor, --dur-ins ease-out
 *                     reduced: same recolor (no spatial component to remove)
 *   logo resolves     slot width transition --dur-conf ease-out
 *                     reduced: instant
 *   no-JS / bfcache   markup renders complete and visible; nothing is hidden by
 *                     static CSS waiting on script. Reveal markers are only ever
 *                     applied by JS and cleared in the same frame batch.
 */

(function () {
  'use strict';

  // ---- Font allowlist. Local system stacks only. No network font requests. --
  var FONT_STACKS = {
    system: 'var(--font-sans)',
    humanist: 'var(--font-humanist)',
    grotesk: 'var(--font-grotesk)',
    mono: 'var(--font-mono)',
    serif: 'var(--font-serif)'
  };

  var DEFAULT_BAR = '#d4a359';
  var TRACK_RGB = [16, 17, 22];        // #101116, the bar track base
  var DEFAULT_INK = '#f4f5f6';
  var MAX_FEED_ROWS = 4;               // 3 visible + 1 buffer row that slides out

  var params = new URLSearchParams(window.location.search);
  var EDIT_MODE = params.get('edit') === '1' || params.get('edit') === 'true';
  var WANT_FULLSCREEN = params.get('fullscreen') === '1' || params.get('fullscreen') === 'true';

  var odometer = null;
  var lastTotalCents = null;
  var lastGoalCents = 0;
  var currentQrEncoded = '';
  var lastSuccessfulUpdateAt = Date.now();
  var lastBarKey = '';
  var lastInkKey = '';
  var lastFontKey = '';
  var recentKeys = [];
  var sseSource = null;
  var lockedOut = false;
  var latestState = null;

  var el = {};

  function $(id) { return document.getElementById(id); }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function init() {
    el.canvas = $('stage-canvas');
    el.odometer = $('main-odometer');
    el.barFill = $('progress-bar-fill');
    el.barPulse = $('stage-bar-pulse');
    el.thermoFill = $('thermo-bar-fill');
    el.thermoPulse = $('stage-thermo-pulse');
    el.goalAmount = $('goal-amount-text');
    el.goalWrap = $('stage-goal-wrap');
    el.liveIndicator = $('stage-live-indicator');
    el.liveLabel = el.liveIndicator ? el.liveIndicator.querySelector('.live-label') : null;
    el.liveDot = el.liveIndicator ? el.liveIndicator.querySelector('.pulse-dot') : null;
    el.degraded = $('stage-degraded-banner');
    el.logoSlot = $('stage-logo-slot');
    el.logoImg = $('stage-logo-img');
    el.title = $('stage-event-title');
    el.message = $('stage-message-bar');
    el.milestonesH = $('stage-milestones-h');
    el.milestonesV = $('stage-milestones-v');
    el.feed = $('recent-donations-feed');
    el.qrImg = $('stage-qr-img');
    el.qrUrl = $('stage-qr-url');
    el.qrPanel = $('stage-qr-panel');
    el.recentPanel = $('stage-recent-panel');
    el.matchBanner = $('stage-match-banner');
    el.matchText = $('stage-match-text');
    el.freezeBanner = $('stage-freeze-banner');

    if (el.logoImg) {
      el.logoImg.addEventListener('error', function () {
        if (el.logoSlot) el.logoSlot.setAttribute('data-state', 'error');
      });
      el.logoImg.addEventListener('load', function () {
        if (el.logoSlot && el.logoImg.getAttribute('src')) {
          el.logoSlot.setAttribute('data-state', 'ready');
        }
      });
    }

    initOdometer();
    setupFullscreenShortcut();
    if (WANT_FULLSCREEN) setupFullscreenHint();
    if (EDIT_MODE) EditMode.mount();
    startSync();
  }

  function initOdometer() {
    if (el.odometer && window.RollingOdometer) {
      odometer = new RollingOdometer(el.odometer, {
        currency: '$',
        showCents: false,
        allowBackward: false,
        initialValue: 0
      });
    }
  }

  // =========================================================================
  // Realtime sync (SSE, polling fallback)
  // =========================================================================
  function startSync() {
    fetchState();
    setInterval(fetchState, 1500);
    setInterval(checkStaleness, 1000);
    initSSE();
  }

  function checkStaleness() {
    var isStale = (Date.now() - lastSuccessfulUpdateAt) >= 5000;
    if (el.liveDot) el.liveDot.classList.toggle('degraded', isStale);
    if (el.liveIndicator) el.liveIndicator.setAttribute('data-state', isStale ? 'stale' : 'live');
    if (el.liveLabel) el.liveLabel.textContent = isStale ? 'Reconnecting' : 'Live';
    if (el.degraded) {
      if (lockedOut) {
        el.degraded.textContent = 'Display locked';
        el.degraded.hidden = false;
      } else {
        el.degraded.textContent = 'Reconnecting';
        el.degraded.hidden = !isStale;
      }
    }
  }

  function initSSE() {
    try {
      if (!window.EventSource) return;
      sseSource = new EventSource('/api/state/stream?role=stage');
      sseSource.onmessage = function (event) {
        try {
          handleStateUpdate(JSON.parse(event.data));
        } catch (e) { /* polling covers it */ }
      };
      sseSource.onerror = function () {
        if (sseSource) { sseSource.close(); sseSource = null; }
      };
    } catch (e) { /* EventSource unavailable */ }
  }

  function fetchState() {
    fetch('/api/state?role=stage', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (res) {
        if (res.status === 401) {
          // Never render a fake zero total: keep the last known good figure.
          lockedOut = true;
          checkStaleness();
          return null;
        }
        if (!res.ok) return null;
        lockedOut = false;
        return res.json();
      })
      .then(function (data) { if (data) handleStateUpdate(data); })
      .catch(function () { /* staleness watchdog reports it */ });
  }

  // =========================================================================
  // State application
  // =========================================================================
  function handleStateUpdate(data) {
    if (!data) return;
    latestState = data;
    lastSuccessfulUpdateAt = Date.now();
    lockedOut = false;
    checkStaleness();

    applyBranding(data);

    var orientation = data.chart_orientation === 'vertical' ? 'vertical' : 'horizontal';
    document.body.setAttribute('data-orientation', orientation);

    var totalCents = Math.max(0, Number(data.total_raised_cents) || 0);
    var goalCents = Math.max(0, Number(data.goal_cents) || 0);
    var isFirstPaint = lastTotalCents === null;
    var increased = !isFirstPaint && totalCents > lastTotalCents;
    var goalChanged = goalCents !== lastGoalCents;

    // 1. Figure
    if (odometer) {
      odometer.update(totalCents);
    } else if (el.odometer) {
      el.odometer.textContent = formatCurrency(totalCents);
    }
    if (el.odometer) {
      el.odometer.setAttribute('aria-label', 'Total raised ' + formatCurrency(totalCents));
    }

    // 2. Goal
    var showGoal = data.show_goal === undefined ? true : Boolean(data.show_goal);
    if (el.goalWrap) el.goalWrap.hidden = !showGoal;
    if (el.goalAmount && !EditMode.isDirty('goal')) {
      el.goalAmount.textContent = goalText(goalCents);
    }

    // 3. Fill geometry
    var percent = goalCents > 0 ? Math.min(100, Math.max(0, (totalCents / goalCents) * 100)) : 0;
    setFill(percent);

    // 4. Single decaying pulse on a real increase (not on first paint)
    if (increased) pulse(orientation);

    // 5. Milestones
    if (increased || goalChanged || isFirstPaint || milestonesChanged(data.milestones)) {
      renderMilestones(data.milestones || [], goalCents, totalCents);
    } else {
      markMilestonesReached(totalCents);
    }

    // 6. Live indicator toggle
    var showLive = data.show_live_indicator === undefined ? true : Boolean(data.show_live_indicator);
    if (el.liveIndicator) el.liveIndicator.hidden = !showLive;

    // 7. Stage message
    applyStageMessage(data);

    // 8. Layout reflow from the visibility toggles
    var showRecent = data.show_recent_donations === undefined ? true : Boolean(data.show_recent_donations);
    var qrEncoded = typeof data.qr_url === 'string' ? data.qr_url.trim() : '';
    var showQr = (data.show_qr === undefined ? true : Boolean(data.show_qr)) && qrEncoded !== '';

    var layout = 'full';
    if (!showRecent && !showQr) layout = 'minimal';
    else if (showRecent && !showQr) layout = 'recent-only';
    else if (!showRecent && showQr) layout = 'qr-only';
    if (el.canvas) el.canvas.setAttribute('data-layout', layout);

    // 9. Recent donations
    if (showRecent) {
      renderRecentDonations(data.chyrons || [], !isFirstPaint);
    }

    // 10. QR split: encode qr_url, print display_url_effective
    if (showQr) renderQR(qrEncoded, data.display_url_effective, data.display_url);

    // 11. Match / freeze banners
    if (el.matchBanner) {
      el.matchBanner.hidden = !data.is_match_active;
      if (data.is_match_active && el.matchText) {
        el.matchText.textContent = (data.match_sponsor_title || 'Matching Sponsor') + ' \u2022 Double Your Impact';
      }
    }
    if (el.freezeBanner) el.freezeBanner.hidden = !data.is_frozen;

    lastTotalCents = totalCents;
    lastGoalCents = goalCents;
    EditMode.sync(data);
  }

  // =========================================================================
  // Branding: title, logo, colors, background, font
  // =========================================================================
  function applyBranding(data) {
    // Event title
    if (el.title && !EditMode.isDirty('title')) {
      var title = (data.event_title || '').trim();
      el.title.textContent = title;
      el.title.hidden = !title && !EDIT_MODE;
      if (EDIT_MODE) el.title.setAttribute('data-empty', title ? '0' : '1');
    }

    // Logo: reserve the row, collapse the width, degrade on error
    if (el.logoSlot && el.logoImg) {
      var logoUrl = (data.logo_url || '').trim();
      if (!logoUrl) {
        if (el.logoImg.getAttribute('src')) el.logoImg.removeAttribute('src');
        el.logoSlot.setAttribute('data-state', 'empty');
      } else if (el.logoImg.getAttribute('src') !== logoUrl) {
        el.logoSlot.setAttribute('data-state', 'loading');
        el.logoImg.setAttribute('src', logoUrl);
      }
    }

    applyBarColor(data.bar_color);
    applyTextColor(data.text_color);
    applyFont(data.font_family);

    var bg = data.background_style;
    var validBg = (bg === 'subtle-gradient' || bg === 'vignette') ? bg : 'plain';
    document.body.setAttribute('data-bg-style', validBg);
  }

  /**
   * Resolve any CSS color string to sRGB bytes. A 1x1 canvas gives exact
   * results for #hex, rgb(), and oklch() alike without shipping a parser.
   * @returns {number[]|null} [r,g,b]
   */
  function resolveRGB(color) {
    if (!color || typeof color !== 'string') return null;
    var trimmed = color.trim();
    if (!trimmed) return null;
    try {
      if (!resolveRGB._ctx) {
        var canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        resolveRGB._ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      var ctx = resolveRGB._ctx;
      if (!ctx) return hexToRGB(trimmed);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000';
      ctx.fillStyle = trimmed;
      // An unparseable value leaves fillStyle at the previous colour.
      if (ctx.fillStyle === '#000000' && !/^#0{3,8}$/i.test(trimmed) && !/\bblack\b/i.test(trimmed)) {
        return hexToRGB(trimmed);
      }
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) {
      return hexToRGB(trimmed);
    }
  }

  function hexToRGB(hex) {
    var clean = String(hex).replace('#', '');
    if (clean.length === 3 || clean.length === 4) {
      clean = clean.slice(0, 3).split('').map(function (c) { return c + c; }).join('');
    }
    if (clean.length === 8) clean = clean.slice(0, 6);
    if (clean.length !== 6 || /[^0-9a-f]/i.test(clean)) return null;
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }

  function rgbToCss(rgb) { return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')'; }

  function mixRGB(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function luminance(rgb) {
    var s = rgb.map(function (v) {
      var c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  }

  function contrastRatio(a, b) {
    var l1 = luminance(a);
    var l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /** Bar colour drives the fill gradient, the figure ink, and the glow. */
  function applyBarColor(customColor) {
    var key = String(customColor || '');
    if (key === lastBarKey) return;
    lastBarKey = key;

    var rgb = resolveRGB(customColor);
    // WCAG 1.4.11: graphical objects need >= 3:1 against their track.
    if (!rgb || contrastRatio(rgb, TRACK_RGB) < 3.0) {
      rgb = hexToRGB(DEFAULT_BAR);
    }

    var root = document.documentElement.style;
    root.setProperty('--stage-bar', rgbToCss(rgb));
    root.setProperty('--stage-bar-lo', rgbToCss(mixRGB(rgb, [0, 0, 0], 0.42)));
    root.setProperty('--stage-bar-hi', rgbToCss(mixRGB(rgb, [255, 255, 255], 0.3)));
    root.setProperty('--stage-bar-peak', rgbToCss(mixRGB(rgb, [255, 255, 255], 0.62)));
    root.setProperty('--stage-glow', 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', 0.3)');
    root.setProperty('--stage-glow-soft', 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', 0.13)');
  }

  function applyTextColor(customColor) {
    var key = String(customColor || '');
    if (key === lastInkKey) return;
    lastInkKey = key;

    var rgb = resolveRGB(customColor);
    // Body copy needs to survive a projector: >= 4.5:1 against the canvas.
    if (!rgb || contrastRatio(rgb, [7, 8, 10]) < 4.5) {
      rgb = hexToRGB(DEFAULT_INK);
    }
    var root = document.documentElement.style;
    root.setProperty('--stage-ink', rgbToCss(rgb));
    root.setProperty('--stage-ink-dim', rgbToCss(mixRGB(rgb, [10, 11, 14], 0.42)));
  }

  function applyFont(family) {
    var key = String(family || 'system');
    if (key === lastFontKey) return;
    lastFontKey = key;
    var stack = Object.prototype.hasOwnProperty.call(FONT_STACKS, key)
      ? FONT_STACKS[key]
      : FONT_STACKS.system;
    document.documentElement.style.setProperty('--stage-font', stack);
  }

  // =========================================================================
  // Fill + pulse
  // =========================================================================
  function setFill(percent) {
    var scale = Math.max(0, Math.min(1, percent / 100));
    if (el.barFill) el.barFill.style.transform = 'scaleX(' + scale.toFixed(5) + ')';
    if (el.thermoFill) el.thermoFill.style.transform = 'scaleY(' + scale.toFixed(5) + ')';
  }

  /**
   * One decaying pulse. Retriggering restarts it from frame zero so the newest
   * donation always owns the animation instead of being swallowed by an
   * in-flight run.
   */
  function pulse(orientation) {
    var target = orientation === 'vertical' ? el.thermoPulse : el.barPulse;
    if (!target) return;
    target.removeAttribute('data-pulse');
    void target.offsetWidth;
    target.setAttribute('data-pulse', 'on');
  }

  // =========================================================================
  // Milestones
  // =========================================================================
  var lastMilestoneSig = null;

  function milestonesChanged(milestones) {
    return signature(milestones) !== lastMilestoneSig;
  }

  function signature(milestones) {
    if (!Array.isArray(milestones)) return '';
    return milestones.map(function (m) { return m.cents + ':' + (m.label || ''); }).join('|');
  }

  function renderMilestones(milestones, goalCents, totalCents) {
    lastMilestoneSig = signature(milestones);

    var items = Array.isArray(milestones) ? milestones.slice() : [];
    if (items.length === 0 && goalCents > 0) {
      items = [0.25, 0.5, 0.75, 1].map(function (f) {
        var cents = Math.round(goalCents * f);
        return { cents: cents, label: formatShortCurrency(cents) };
      });
    }
    if (goalCents > 0 && !items.some(function (m) { return Number(m.cents) >= goalCents; })) {
      items.push({ cents: goalCents, label: formatShortCurrency(goalCents) });
    }

    var seen = [];
    var ticks = items
      .map(function (m) {
        var cents = Math.max(0, Number(m.cents) || 0);
        var pct = goalCents > 0 ? Math.min(100, (cents / goalCents) * 100) : 0;
        return { cents: cents, pct: pct, label: (m.label || '').trim() || formatShortCurrency(cents) };
      })
      .filter(function (t) { return t.pct > 0.5; })
      .sort(function (a, b) { return a.pct - b.pct; })
      .filter(function (t) {
        // Keep projector labels from colliding.
        var clash = seen.some(function (p) { return Math.abs(p - t.pct) < 6; });
        if (clash) return false;
        seen.push(t.pct);
        return true;
      });

    paintTicks(el.milestonesH, ticks, totalCents, 'h');
    paintTicks(el.milestonesV, ticks, totalCents, 'v');
  }

  function paintTicks(host, ticks, totalCents, axis) {
    if (!host) return;
    host.innerHTML = ticks.map(function (t) {
      var pos = axis === 'h'
        ? 'left: ' + t.pct.toFixed(3) + '%;'
        : 'bottom: ' + t.pct.toFixed(3) + '%;';
      var edge = '';
      if (axis === 'h') {
        if (t.pct <= 3) edge = ' data-edge="start"';
        else if (t.pct >= 97) edge = ' data-edge="end"';
      }
      return '<div class="mtick" data-cents="' + t.cents + '" data-reached="' +
        (totalCents >= t.cents ? '1' : '0') + '"' + edge + ' style="' + pos + '">' +
        '<div class="mtick-line"></div>' +
        '<span class="mtick-label">' + escapeHTML(t.label) + '</span>' +
        '</div>';
    }).join('');
  }

  function markMilestonesReached(totalCents) {
    var nodes = document.querySelectorAll('.mtick');
    for (var i = 0; i < nodes.length; i++) {
      var cents = Number(nodes[i].getAttribute('data-cents')) || 0;
      nodes[i].setAttribute('data-reached', totalCents >= cents ? '1' : '0');
    }
  }

  // =========================================================================
  // Recent donations feed
  // =========================================================================
  function chyronKey(c, index) {
    return String(c.donation_id || (c.display_name + '|' + c.amount_cents + '|' + index));
  }

  function renderRecentDonations(chyrons, allowMotion) {
    if (!el.feed) return;

    var items = (chyrons || []).slice(0, MAX_FEED_ROWS);
    var keys = items.map(chyronKey);

    if (keys.length === recentKeys.length && keys.every(function (k, i) { return k === recentKeys[i]; })) {
      return;
    }

    if (items.length === 0) {
      el.feed.style.transform = '';
      el.feed.innerHTML = '<div class="recent-empty">Recent donations will appear here live</div>';
      recentKeys = [];
      return;
    }

    // How many rows entered at the head of the list?
    var newCount = 0;
    if (recentKeys.length > 0) {
      var idx = keys.indexOf(recentKeys[0]);
      newCount = idx > 0 ? idx : (idx === 0 ? 0 : items.length);
    }
    newCount = Math.min(newCount, 3);

    var hadRows = recentKeys.length > 0;
    var previous = recentKeys;
    recentKeys = keys;

    el.feed.innerHTML = items.map(function (c, i) {
      var isNew = previous.indexOf(keys[i]) === -1;
      return '<div class="recent-feed-item"' + (isNew ? ' data-new="1"' : '') + '>' +
        '<span class="recent-feed-donor">' + escapeHTML(c.display_name || 'Anonymous Supporter') + '</span>' +
        '<span class="recent-feed-amount">' + formatCurrency(c.amount_cents) + '</span>' +
        '</div>';
    }).join('');

    if (!allowMotion || !hadRows) {
      el.feed.style.transform = '';
      return;
    }

    var entering = el.feed.querySelectorAll('.recent-feed-item[data-new="1"]');
    var reduced = prefersReducedMotion();

    for (var i = 0; i < entering.length; i++) {
      entering[i].setAttribute('data-enter', 'pending');
    }

    if (reduced || newCount === 0) {
      el.feed.style.transform = '';
      void el.feed.offsetHeight;
      clearEntering(entering);
      return;
    }

    // Put the surviving rows back where the eye last saw them, then let the
    // whole list settle downward by exactly the number of new rows. The
    // viewport height is fixed, so nothing outside the feed can move.
    var step = rowStep();
    el.feed.style.transition = 'none';
    el.feed.style.transform = 'translateY(' + (-newCount * step) + 'px)';
    void el.feed.offsetHeight;
    el.feed.style.transition = 'transform var(--dur-conf) var(--ease-out)';
    el.feed.style.transform = 'translateY(0)';
    clearEntering(entering);
  }

  function clearEntering(nodes) {
    requestAnimationFrame(function () {
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].removeAttribute('data-enter');
      }
    });
  }

  function rowStep() {
    var rows = el.feed.querySelectorAll('.recent-feed-item');
    if (rows.length >= 2) return rows[1].offsetTop - rows[0].offsetTop;
    if (rows.length === 1) {
      var gap = parseFloat(window.getComputedStyle(el.feed).rowGap) || 0;
      return rows[0].offsetHeight + gap;
    }
    return 0;
  }

  // =========================================================================
  // QR split — encode qr_url, print display_url_effective
  // =========================================================================
  function renderQR(encodeUrl, effective, fallbackDisplay) {
    var printed = (effective || fallbackDisplay || '').trim();
    if (!printed) printed = stripToHumanUrl(encodeUrl);
    if (el.qrUrl) el.qrUrl.textContent = printed;

    if (el.qrImg && encodeUrl && encodeUrl !== currentQrEncoded) {
      currentQrEncoded = encodeUrl;
      el.qrImg.src = '/api/qr?url=' + encodeURIComponent(encodeUrl) + '&margin=1';
    }
  }

  /** Never print a UTM string on a projector. */
  function stripToHumanUrl(url) {
    if (!url) return '';
    return String(url)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('?')[0]
      .split('#')[0]
      .replace(/\/$/, '');
  }

  // =========================================================================
  // Stage message
  // =========================================================================
  function applyStageMessage(data) {
    if (!el.message) return;
    if (EditMode.isDirty('message')) return;

    var text = (data.stage_message || '').trim();
    var visible = Boolean(data.stage_message_visible) && text !== '';

    if (EDIT_MODE) {
      el.message.hidden = false;
      el.message.textContent = text;
      el.message.setAttribute('data-empty', text ? '0' : '1');
      return;
    }

    el.message.textContent = visible ? text : '';
    el.message.hidden = !visible;
  }

  // =========================================================================
  // WYSIWYG edit mode (?edit=1). Entirely absent without the parameter.
  // =========================================================================
  var EditMode = (function () {
    var mounted = false;
    var dirty = {};
    var original = {};
    var saveToken = 0;
    var nodes = {};
    var bar = null;
    var statusEl = null;
    var saveBtn = null;
    var pinInput = null;

    function isDirty(field) { return mounted && dirty[field] === true; }

    function pin() {
      try { return window.sessionStorage.getItem('givebar_control_pin') || ''; }
      catch (e) { return ''; }
    }

    function setPin(value) {
      try { window.sessionStorage.setItem('givebar_control_pin', value); } catch (e) { /* private mode */ }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      document.body.setAttribute('data-edit', 'on');

      nodes.title = el.title;
      nodes.goal = el.goalAmount;
      nodes.message = el.message;

      if (nodes.title) {
        nodes.title.hidden = false;
        prepare(nodes.title, 'title', 'Event title');
      }
      if (nodes.goal) prepare(nodes.goal, 'goal', 'Goal');
      if (nodes.message) {
        nodes.message.hidden = false;
        prepare(nodes.message, 'message', 'Stage message');
      }

      buildBar();
    }

    function prepare(node, field, placeholder) {
      node.setAttribute('contenteditable', 'plaintext-only');
      node.setAttribute('data-editable', field);
      node.setAttribute('data-placeholder', placeholder);
      node.setAttribute('spellcheck', 'false');
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'textbox');
      node.setAttribute('aria-label', placeholder);

      node.addEventListener('focus', function () {
        original[field] = node.textContent;
        node.setAttribute('data-empty', '0');
      });
      node.addEventListener('input', function () {
        dirty[field] = true;
        refreshBar();
      });
      node.addEventListener('blur', function () {
        node.setAttribute('data-empty', node.textContent.trim() ? '0' : '1');
      });
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          node.textContent = original[field] !== undefined ? original[field] : node.textContent;
          dirty[field] = false;
          node.blur();
          refreshBar();
          return;
        }
        if (e.key === 'Enter' && (field !== 'message' || !e.shiftKey)) {
          e.preventDefault();
          node.blur();
          save();
        }
      });
    }

    function buildBar() {
      bar = document.createElement('div');
      bar.className = 'edit-bar';
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Live edit');

      var label = document.createElement('span');
      label.className = 'edit-bar-label';
      label.innerHTML = '<svg class="icon" viewBox="0 0 256 256" aria-hidden="true">' +
        '<path d="M227.31 73.37 182.63 28.68a16 16 0 0 0-22.63 0L36.69 152a15.86 15.86 0 0 0-4.69 11.31V208a16 16 0 0 0 16 16h44.69a15.86 15.86 0 0 0 11.31-4.69L227.31 96a16 16 0 0 0 0-22.63ZM92.69 208H48v-44.69l88-88L180.69 120ZM192 108.68 147.31 64l24-24L216 84.68Z"/>' +
        '</svg><span>Edit mode</span>';

      statusEl = document.createElement('span');
      statusEl.className = 'edit-bar-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      statusEl.textContent = 'Click the title, goal, or message';

      saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'edit-btn';
      saveBtn.textContent = 'Save';
      saveBtn.disabled = true;
      saveBtn.addEventListener('click', save);

      var revertBtn = document.createElement('button');
      revertBtn.type = 'button';
      revertBtn.className = 'edit-btn ghost';
      revertBtn.textContent = 'Revert';
      revertBtn.addEventListener('click', revert);

      var exitBtn = document.createElement('button');
      exitBtn.type = 'button';
      exitBtn.className = 'edit-btn ghost';
      exitBtn.textContent = 'Exit';
      exitBtn.addEventListener('click', function () {
        window.location.href = window.location.pathname;
      });

      bar.appendChild(label);
      bar.appendChild(statusEl);
      bar.appendChild(saveBtn);
      bar.appendChild(revertBtn);
      bar.appendChild(exitBtn);
      document.body.appendChild(bar);
    }

    function refreshBar() {
      if (!saveBtn) return;
      var anyDirty = dirty.title || dirty.goal || dirty.message;
      saveBtn.disabled = !anyDirty;
      if (anyDirty) setStatus('Unsaved changes', '');
    }

    function setStatus(text, tone) {
      if (!statusEl) return;
      statusEl.textContent = text;
      if (tone) statusEl.setAttribute('data-tone', tone);
      else statusEl.removeAttribute('data-tone');
    }

    function revert() {
      dirty = {};
      if (latestState) {
        if (nodes.title) nodes.title.textContent = (latestState.event_title || '').trim();
        if (nodes.goal) nodes.goal.textContent = goalText(latestState.goal_cents || 0);
        if (nodes.message) nodes.message.textContent = (latestState.stage_message || '').trim();
        markEmptyStates();
      }
      refreshBar();
      setStatus('Reverted', '');
    }

    function markEmptyStates() {
      ['title', 'goal', 'message'].forEach(function (f) {
        if (nodes[f]) nodes[f].setAttribute('data-empty', nodes[f].textContent.trim() ? '0' : '1');
      });
    }

    /** "$1.2M", "500k", "$500,000" -> cents */
    function parseGoal(text) {
      var raw = String(text || '').trim().toLowerCase().replace(/[$,\s]/g, '');
      if (!raw) return null;
      var mult = 1;
      if (/m$/.test(raw)) { mult = 1000000; raw = raw.slice(0, -1); }
      else if (/k$/.test(raw)) { mult = 1000; raw = raw.slice(0, -1); }
      var num = parseFloat(raw);
      if (!isFinite(num) || num <= 0) return null;
      return Math.round(num * mult * 100);
    }

    function save() {
      if (!mounted) return;
      var payload = { action: 'update_settings' };

      if (dirty.title && nodes.title) {
        payload.event_title = nodes.title.textContent.trim();
      }
      if (dirty.message && nodes.message) {
        var msg = nodes.message.textContent.trim();
        payload.stage_message = msg;
        payload.stage_message_visible = msg !== '';
      }
      if (dirty.goal && nodes.goal) {
        var cents = parseGoal(nodes.goal.textContent);
        if (cents === null) {
          setStatus('Goal must be an amount', 'err');
          return;
        }
        payload.goal_cents = cents;
      }

      if (Object.keys(payload).length === 1) {
        setStatus('Nothing to save', '');
        return;
      }

      var currentPin = pin();
      if (currentPin) payload.pin = currentPin;

      var token = ++saveToken;
      setStatus('Saving...', '');
      if (saveBtn) saveBtn.disabled = true;

      fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (token !== saveToken) return null;   // a newer save owns the status
        if (res.status === 401) {
          promptForPin();
          return null;
        }
        return res.json().catch(function () { return { ok: res.ok }; });
      }).then(function (body) {
        if (token !== saveToken || body === null) return;
        if (body && body.error) {
          setStatus(body.message || body.error, 'err');
          if (saveBtn) saveBtn.disabled = false;
          return;
        }
        dirty = {};
        removePinInput();
        setStatus('Saved', 'ok');
        refreshBar();
      }).catch(function () {
        if (token !== saveToken) return;
        setStatus('Save failed', 'err');
        if (saveBtn) saveBtn.disabled = false;
      });
    }

    function promptForPin() {
      setStatus('Control PIN required', 'err');
      if (saveBtn) saveBtn.disabled = false;
      if (pinInput) { pinInput.focus(); return; }
      pinInput = document.createElement('input');
      pinInput.type = 'password';
      pinInput.className = 'edit-pin-input';
      pinInput.placeholder = 'PIN';
      pinInput.setAttribute('aria-label', 'Control PIN');
      pinInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          setPin(pinInput.value.trim());
          save();
        }
      });
      bar.insertBefore(pinInput, saveBtn);
      pinInput.focus();
    }

    function removePinInput() {
      if (pinInput && pinInput.parentNode) pinInput.parentNode.removeChild(pinInput);
      pinInput = null;
    }

    function sync() {
      if (!mounted) return;
      markEmptyStates();
    }

    return { mount: mount, isDirty: isDirty, sync: sync };
  })();

  // =========================================================================
  // Fullscreen
  // =========================================================================
  function isEditingText(node) {
    return !!node && (node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
  }

  function setupFullscreenShortcut() {
    document.addEventListener('keydown', function (e) {
      if (isEditingText(document.activeElement)) return;
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    });

    document.addEventListener('dblclick', function (e) {
      if (isEditingText(e.target) || (EDIT_MODE && e.target.closest('.edit-bar'))) return;
      toggleFullscreen();
    });
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      var req = document.documentElement.requestFullscreen;
      if (req) req.call(document.documentElement).catch(function () {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  }

  /**
   * ?fullscreen=1 — requestFullscreen needs a user gesture, so arm a one-shot
   * handler and tell the operator what to do. The clean /chart URL never sees
   * any of this.
   */
  function setupFullscreenHint() {
    var hint = document.createElement('div');
    hint.className = 'fullscreen-hint';
    hint.setAttribute('role', 'status');
    hint.textContent = 'Click anywhere or press F for fullscreen';
    document.body.appendChild(hint);

    var done = false;
    function activate() {
      if (done) return;
      done = true;
      document.removeEventListener('click', activate, true);
      document.removeEventListener('keydown', activate, true);
      toggleFullscreen();
      hint.setAttribute('data-leaving', '1');
      setTimeout(function () {
        if (hint.parentNode) hint.parentNode.removeChild(hint);
      }, 400);
    }
    document.addEventListener('click', activate, true);
    document.addEventListener('keydown', activate, true);
  }

  // =========================================================================
  // Formatting
  // =========================================================================
  function formatCurrency(cents) {
    return '$' + Math.floor((Number(cents) || 0) / 100).toLocaleString('en-US');
  }

  function formatShortCurrency(cents) {
    var dollars = Math.floor((Number(cents) || 0) / 100);
    if (dollars === 0) return '$0';
    if (dollars >= 1000000) return '$' + Number((dollars / 1000000).toFixed(1)) + 'M';
    if (dollars >= 1000) return '$' + Number((dollars / 1000).toFixed(0)) + 'k';
    return '$' + dollars;
  }

  /**
   * Projector-friendly short goal ("$500k"), except in edit mode where the
   * short form would round the operator's own number away on save.
   */
  function goalText(cents) {
    var short = formatShortCurrency(cents);
    if (!EDIT_MODE) return short;
    var roundTrip = short.replace(/[$,]/g, '');
    var mult = /M$/i.test(roundTrip) ? 1000000 : (/k$/i.test(roundTrip) ? 1000 : 1);
    var lossless = Math.round(parseFloat(roundTrip) * mult * 100) === Math.round(Number(cents) || 0);
    return lossless ? short : formatCurrency(cents);
  }

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
