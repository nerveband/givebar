/**
 * Givebar Stats: SVG charts drawn by hand, no chart library.
 *
 * Every figure comes from /api/stats for the chosen range, source, and payment
 * method. Ledger charts are exact folds; website charts come from Umami for the
 * donation pages (visits, QR/UTM arrivals, referrers, devices). The page
 * refreshes itself every 20 seconds and keeps the last good data on a failure.
 */
(function () {
  'use strict';

  const fmt = GivebarSession.format;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const GOLD = '#e6bd7b';
  const INK = '#f4f5f6';
  const MUTED = '#88888e';
  const LINE = 'rgba(255,255,255,0.08)';
  const state = {
    range: localStorage.getItem('givebar_stats_range') || 'all',
    source: '',
    method: '',
    data: null,
    timer: null
  };

  const money = cents => fmt.money(cents);
  const short = cents => {
    const dollars = cents / 100;
    if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1)}M`;
    if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(dollars >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return `$${Math.round(dollars)}`;
  };
  const eastern = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts });
  const timeLabel = (t, bucketMs) => bucketMs >= 86_400_000
    ? eastern({ month: 'short', day: 'numeric' }).format(new Date(t))
    : bucketMs >= 6 * 3_600_000
      ? eastern({ month: 'short', day: 'numeric', hour: 'numeric' }).format(new Date(t))
      : eastern({ hour: 'numeric', minute: '2-digit' }).format(new Date(t));

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function text(parent, x, y, value, attrs) {
    const el = svg('text', { x, y, fill: MUTED, 'font-family': 'inherit', ...attrs }, parent);
    el.textContent = value;
    return el;
  }
  function empty(container, message) {
    container.innerHTML = `<p class="chart-empty">${fmt.escape(message)}</p>`;
  }

  /** Area + line for cumulative money, bars for per-period amounts, with milestone rules. */
  /** Charts are drawn at the container's real width so labels stay legible on every screen. */
  function chartWidth(container) { return Math.max(320, Math.round(container.clientWidth || container.parentElement.clientWidth || 900)); }

  function areaChart(container, points, opts) {
    if (!points.length || !points.some(p => p.y > 0)) return empty(container, opts.emptyMessage || 'Nothing in this range yet.');
    const W = chartWidth(container), H = W < 520 ? 220 : 260, L = 56, R = 16, T = 16, B = 34;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': opts.label });
    const maxY = Math.max(...points.map(p => p.y), ...(opts.rules || []).filter(r => r.value <= Math.max(...points.map(p => p.y)) * 1.6).map(r => r.value), 1);
    const x = i => L + (i / Math.max(points.length - 1, 1)) * (W - L - R);
    const y = v => T + (1 - v / maxY) * (H - T - B);
    for (let g = 0; g <= 4; g++) {
      const value = (maxY / 4) * g;
      svg('line', { x1: L, x2: W - R, y1: y(value), y2: y(value), stroke: LINE }, root);
      text(root, L - 8, y(value) + 4, opts.format(value), { 'text-anchor': 'end' });
    }
    for (const rule of opts.rules || []) {
      if (rule.value > maxY) continue;
      svg('line', { x1: L, x2: W - R, y1: y(rule.value), y2: y(rule.value), stroke: GOLD, 'stroke-dasharray': '4 4', opacity: 0.5 }, root);
      text(root, W - R, y(rule.value) - 4, rule.label, { 'text-anchor': 'end', fill: GOLD });
    }
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    svg('path', { d: `${path} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`, fill: GOLD, opacity: 0.12 }, root);
    svg('path', { d: path, fill: 'none', stroke: GOLD, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, root);
    const last = points[points.length - 1];
    svg('circle', { cx: x(points.length - 1), cy: y(last.y), r: 4, fill: GOLD }, root);
    axisLabels(root, points, x, H - 10);
    container.replaceChildren(root);
    addHover(root, points, x, i => `${points[i].label}: ${opts.format(points[i].y)}${points[i].detail ? ' · ' + points[i].detail : ''}`);
  }

  /** Vertical bars over time (gifts per period, visits per period). */
  function columnChart(container, points, opts) {
    if (!points.length || !points.some(p => p.y > 0)) return empty(container, opts.emptyMessage || 'Nothing in this range yet.');
    const W = chartWidth(container), H = W < 520 ? 190 : 220, L = 40, R = 12, T = 12, B = 34;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': opts.label });
    const maxY = Math.max(...points.map(p => p.y), 1);
    const slot = (W - L - R) / points.length;
    const y = v => T + (1 - v / maxY) * (H - T - B);
    for (let g = 0; g <= 3; g++) {
      const value = Math.round((maxY / 3) * g);
      svg('line', { x1: L, x2: W - R, y1: y(value), y2: y(value), stroke: LINE }, root);
      text(root, L - 8, y(value) + 4, String(value), { 'text-anchor': 'end' });
    }
    points.forEach((p, i) => {
      svg('rect', { x: L + i * slot + slot * 0.15, y: y(p.y), width: slot * 0.7, height: Math.max(0, y(0) - y(p.y)), fill: opts.color || GOLD, rx: 2, opacity: p.y ? 0.9 : 0 }, root);
      if (p.y2 !== undefined) svg('rect', { x: L + i * slot + slot * 0.15, y: y(p.y2), width: slot * 0.7, height: Math.max(0, y(0) - y(p.y2)), fill: INK, rx: 2, opacity: p.y2 ? 0.55 : 0 }, root);
    });
    axisLabels(root, points, i => L + i * slot + slot / 2, H - 10);
    container.replaceChildren(root);
    addHover(root, points, i => L + i * slot + slot / 2, i => `${points[i].label}: ${opts.format(points[i])}`);
  }

  /** About eight evenly spaced labels plus the last point, never two on top of each other. */
  function axisLabels(root, points, x, y) {
    const width = root.viewBox.baseVal.width;
    const step = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(width / 110))));
    const last = points.length - 1;
    points.forEach((p, i) => {
      if (i === last) text(root, x(i), y, p.label, { 'text-anchor': 'end' });
      else if (i % step === 0 && last - i > step * 0.6) text(root, x(i), y, p.label, { 'text-anchor': i === 0 ? 'start' : 'middle' });
    });
  }

  function addHover(root, points, x, describe) {
    const tip = svg('g', { opacity: 0 }, root);
    const rule = svg('line', { y1: 0, y2: root.viewBox.baseVal.height - 30, stroke: INK, opacity: 0.35 }, tip);
    const box = svg('rect', { rx: 6, fill: '#101116', stroke: '#2a2c34', height: 24 }, tip);
    const label = text(tip, 0, 0, '', { fill: INK });
    root.addEventListener('mousemove', event => {
      const rect = root.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * root.viewBox.baseVal.width;
      let best = 0;
      for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
      const cx = x(best);
      rule.setAttribute('x1', cx); rule.setAttribute('x2', cx);
      label.textContent = describe(best);
      const width = label.getComputedTextLength() + 16;
      const bx = Math.min(Math.max(cx - width / 2, 4), root.viewBox.baseVal.width - width - 4);
      box.setAttribute('x', bx); box.setAttribute('y', 2); box.setAttribute('width', width);
      label.setAttribute('x', bx + 8); label.setAttribute('y', 18);
      tip.setAttribute('opacity', 1);
    });
    root.addEventListener('mouseleave', () => tip.setAttribute('opacity', 0));
  }

  /** Horizontal bars with label, count, and amount: sources, methods, sizes, hours, devices. */
  function barList(container, rows, opts) {
    if (!rows.length) return empty(container, opts.emptyMessage || 'Nothing in this range yet.');
    const max = Math.max(...rows.map(r => opts.value(r)), 1);
    container.innerHTML = rows.map(row => {
      const value = opts.value(row);
      return `<div class="bar-row"><span class="bar-label">${fmt.escape(opts.label(row))}</span><span class="bar-track"><span class="bar-fill" style="width:${(value / max) * 100}%"></span></span><span class="bar-value">${fmt.escape(opts.format(row))}</span></div>`;
    }).join('');
  }

  function table(container, rows, columns, emptyMessage) {
    if (!rows.length) return empty(container, emptyMessage || 'Nothing in this range yet.');
    container.innerHTML = `<table class="donations-table stats-table-el"><thead><tr>${columns.map(c => `<th class="${c.align || ''}">${fmt.escape(c.title)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(c => `<td class="${c.align || ''}">${c.html ? c.html(row) : fmt.escape(String(c.value(row)))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function utmLabel(row) {
    const parts = [row.source, row.medium, row.campaign, row.content].filter(Boolean);
    const known = { 'qrcode|backcover': 'Booklet back cover QR', 'qrcode|tablecard': 'Table card QR', 'qrcode|booklet': 'Booklet QR', 'pledgeform|qrcode': 'Pledge form QR', 'givebar|qr': 'Ballroom chart QR', 'ig|social': 'Instagram link in bio' };
    const base = known[`${row.source}|${row.medium}`] || parts.slice(0, 2).join(' · ');
    return row.content && !/link_in_bio/.test(row.content) ? `${base} (${row.content})` : base;
  }

  function render(data) {
    const s = data.summary;
    const rangeText = { today: 'today', '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' }[data.range];
    const filters = [state.source && ({ bloomerang: 'online gifts only', manual: 'gifts entered by hand only' })[state.source], state.method && `${state.method} only`].filter(Boolean);
    $('stats-subtitle').textContent = `Gifts, sources, and how people reached the donation page, ${rangeText}${filters.length ? ', ' + filters.join(', ') : ''}.`;
    $('btn-clear-filters').hidden = !filters.length;
    $('t-total').textContent = money(s.total_cents);
    $('t-total-sub').textContent = s.matched_cents ? `${money(s.direct_cents)} given + ${money(s.matched_cents)} matched` : `${Math.round((s.total_cents / Math.max(data.goal_cents, 1)) * 100)}% of the ${short(data.goal_cents)} goal`;
    $('t-gifts').textContent = String(s.gifts);
    $('t-gifts-sub').textContent = `${s.online} online · ${s.manual} by hand · ${s.anonymous} anonymous`;
    $('t-average').textContent = money(Math.round(s.average_cents / 100) * 100);
    $('t-average-sub').textContent = `median ${money(Math.round(s.median_cents / 100) * 100)}`;
    $('t-largest').textContent = money(s.largest_cents);
    $('t-largest-sub').textContent = s.deleted || s.edited ? `${s.edited} edited · ${s.deleted} deleted` : 'no corrections';

    const web = data.website;
    if (web.connected) {
      $('t-visitors').textContent = String(web.totals.donate_visitors);
      $('t-visitors-sub').textContent = `${web.totals.donate_views} views · ${web.totals.visitors} site visitors`;
      $('t-tagged').textContent = String(web.totals.tagged_visitors);
      $('t-tagged-sub').textContent = web.totals.visitors ? `${Math.round((web.totals.tagged_visitors / web.totals.visitors) * 100)}% of site visitors` : '';
      $('web-hint').textContent = data.range === 'all' ? 'Last 90 days' : '';
    } else {
      $('t-visitors').textContent = '—';
      $('t-visitors-sub').textContent = web.message || '';
      $('t-tagged').textContent = '—';
      $('t-tagged-sub').textContent = '';
    }

    const bucket = data.bucket_ms;
    $('timeline-hint').textContent = `per ${bucket >= 86_400_000 ? 'day' : bucket >= 3_600_000 ? `${bucket / 3_600_000} hour${bucket > 3_600_000 ? 's' : ''}` : `${bucket / 60_000} minutes`}`;
    areaChart($('chart-timeline'), data.timeline.map(b => ({ label: timeLabel(b.t, bucket), y: b.cumulative_cents, detail: b.gifts ? `${b.gifts} gift${b.gifts === 1 ? '' : 's'} (${money(b.cents)})` : '' })), {
      label: 'Total raised over time', format: short,
      rules: [...data.milestones.map(m => ({ value: m.cents, label: m.label })), { value: data.goal_cents, label: 'Goal' }]
    });
    columnChart($('chart-gifts'), data.timeline.map(b => ({ label: timeLabel(b.t, bucket), y: b.gifts, cents: b.cents })), { label: 'Gifts per period', format: p => `${p.y} gift${p.y === 1 ? '' : 's'} · ${money(p.cents)}` });
    if (web.connected) {
      columnChart($('chart-web'), web.timeline.map(b => ({ label: timeLabel(b.t, web.bucket_ms), y: b.views, y2: b.visitors })), { label: 'Donation page visits', color: '#7ab8e6', format: p => `${p.y} views · ${p.y2} visitors`, emptyMessage: 'No donation page visits in this range.' });
    } else empty($('chart-web'), web.message || 'Website analytics are not connected.');

    barList($('chart-source'), data.by_source, { label: r => r.label, value: r => r.cents, format: r => `${money(r.cents)} · ${r.gifts}` });
    barList($('chart-method'), data.by_method, { label: r => r.label, value: r => r.cents, format: r => `${money(r.cents)} · ${r.gifts}` });
    barList($('chart-size'), data.by_size, { label: r => r.label, value: r => r.gifts, format: r => `${r.gifts} · ${money(r.cents)}` });
    barList($('chart-hour'), data.by_hour, { label: r => r.label, value: r => r.cents, format: r => `${money(r.cents)} · ${r.gifts}` });
    if (web.connected) barList($('chart-devices'), web.devices, { label: r => r.device.charAt(0).toUpperCase() + r.device.slice(1), value: r => r.visitors, format: r => `${r.visitors}`, emptyMessage: 'No donation page visits in this range.' });
    else empty($('chart-devices'), 'Not connected.');

    if (web.connected) {
      table($('table-utm'), web.utm, [
        { title: 'Arrived via', value: utmLabel },
        { title: 'Tags', html: r => `<span class="mono">${fmt.escape([r.source, r.medium, r.campaign, r.content].filter(Boolean).join(' / '))}</span>` },
        { title: 'Visitors', value: r => r.visitors, align: 'text-right' },
        { title: 'Donation page views', value: r => r.donate_views, align: 'text-right' }
      ], 'No tagged arrivals in this range.');
      table($('table-referrers'), web.referrers, [
        { title: 'Referrer', value: r => r.domain },
        { title: 'Visitors', value: r => r.visitors, align: 'text-right' },
        { title: 'Views', value: r => r.views, align: 'text-right' }
      ], 'No visits in this range.');
      table($('table-pages'), web.pages, [
        { title: 'Page', html: r => `<span class="mono">${fmt.escape(r.path)}</span>` },
        { title: 'Views', value: r => r.views, align: 'text-right' },
        { title: 'Visitors', value: r => r.visitors, align: 'text-right' }
      ], 'No donation page visits in this range.');
    } else {
      empty($('table-utm'), web.message || 'Not connected.');
      empty($('table-referrers'), 'Not connected.');
      empty($('table-pages'), 'Not connected.');
    }
    table($('table-top'), data.top_gifts, [
      { title: 'Donor', html: r => `${fmt.escape(r.donor_name)}${r.is_anonymous ? ' <span class="donation-flag">Anonymous on screen</span>' : ''}` },
      { title: 'Amount', html: r => `${money(r.amount_cents)}${r.matched_amount_cents ? `<div class="donation-attribution">+ ${money(r.matched_amount_cents)} match</div>` : ''}`, align: 'text-right' },
      { title: 'Source', value: r => fmt.source(r.source) },
      { title: 'When', value: r => fmt.time(r.created_at) }
    ]);
    table($('table-operators'), data.operators, [
      { title: 'Operator', value: r => r.operator },
      { title: 'Added', value: r => r.adds, align: 'text-right' },
      { title: 'Amount', value: r => money(r.cents), align: 'text-right' },
      { title: 'Edited', value: r => r.edits, align: 'text-right' },
      { title: 'Deleted', value: r => r.deletes, align: 'text-right' }
    ], 'No activity in this range.');
    $('stats-updated').textContent = `Updated ${eastern({ hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(data.server_time))}`;
  }

  async function load() {
    try {
      const response = await GivebarSession.api(`/api/stats?range=${state.range}&source=${state.source}&method=${state.method}`);
      if (!response.ok) return;
      state.data = await response.json();
      render(state.data);
    } catch (_) {
      $('stats-updated').textContent = 'Connection lost; showing the last figures.';
    }
  }

  function seg(id, attr, key) {
    const group = $(id);
    group.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-checked', String(button.dataset[attr] === state[key]));
      button.addEventListener('click', () => {
        state[key] = button.dataset[attr];
        if (key === 'range') localStorage.setItem('givebar_stats_range', state.range);
        group.querySelectorAll('button').forEach(other => other.setAttribute('aria-checked', String(other === button)));
        load();
      });
    });
  }
  seg('range-seg', 'range', 'range');
  seg('source-seg', 'source', 'source');
  seg('method-seg', 'method', 'method');
  $('btn-clear-filters').addEventListener('click', () => {
    state.source = '';
    state.method = '';
    document.querySelectorAll('#source-seg button, #method-seg button').forEach(button => button.setAttribute('aria-checked', String(!button.dataset.source && !button.dataset.method)));
    load();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) render(state.data); }, 200); });
  load();
  setInterval(load, 20000);
})();
