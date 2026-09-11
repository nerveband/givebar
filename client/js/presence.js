/**
 * Live presence: which operators are connected, and on which page.
 *
 * Identity is the operator session; the browser only contributes a stable
 * client id so two tabs from one person count as two connections. Every
 * heartbeat answer carries the roster, so Home needs no second request.
 * When heartbeats stop succeeding the panel says the roster is stale rather
 * than showing names as though they were live.
 */
(function () {
  'use strict';

  const HEARTBEAT_MS = 5000;
  const STALE_MS = 12000;
  const HIDDEN_GRACE_MS = 30000;
  const CLIENT_ID_KEY = 'givebar_presence_client_id';

  const SURFACE_BY_PATH = { '/': 'home', '/donations': 'donations', '/settings': 'settings', '/testing': 'testing', '/history': 'history', '/preview': 'preview', '/presenter-preview': 'preview' };
  const SURFACE_ORDER = ['donations', 'preview', 'settings', 'testing', 'history', 'home'];
  const SURFACE_LABEL = { home: 'Home', donations: 'Manage Donations', settings: 'Settings', testing: 'Testing', history: 'History', preview: 'Preview' };

  const ICON_USERS = 'M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-6.05-14.81,60,60,0,0,1,55.6,105.6,95.78,95.78,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z';
  const ICON_WARNING = 'M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z';

  const surface = SURFACE_BY_PATH[location.pathname.replace(/\/+$/, '') || '/'] || null;
  const clientId = (() => {
    let existing = null;
    try { existing = localStorage.getItem(CLIENT_ID_KEY); } catch (_) { /* private mode */ }
    if (existing && /^[A-Za-z0-9_.:-]{4,64}$/.test(existing)) return existing;
    const fresh = 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem(CLIENT_ID_KEY, fresh); } catch (_) { /* session-local id */ }
    return fresh;
  })();

  const state = { view: null, confirmedAt: 0, failed: false, skewMs: 0, locked: false };
  const mounts = [];
  let beatTimer = null;
  let hideTimer = null;

  function svg(path) {
    return '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  async function beat() {
    if (!surface) return;
    try {
      const response = await fetch('/api/presence', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, surface })
      });
      if (response.status === 401) { state.locked = true; state.view = null; render(); return; }
      if (!response.ok) throw new Error('presence ' + response.status);
      const data = await response.json();
      state.locked = false;
      state.failed = false;
      state.view = data;
      state.confirmedAt = Date.now();
      state.skewMs = data.now - Date.now();
    } catch (_) {
      state.failed = true;
    }
    render();
  }

  function start() {
    if (beatTimer || !surface) return;
    beat();
    beatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  function stop() {
    clearInterval(beatTimer);
    beatTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; stop(); }, HIDDEN_GRACE_MS);
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = null;
    start();
  });

  function ago(ms) {
    if (ms < 2000) return 'now';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    return Math.round(ms / 3600000) + 'h';
  }

  function paint(mount) {
    const stale = state.view && (state.failed || Date.now() - state.confirmedAt > STALE_MS);
    mount.root.setAttribute('data-stale', stale ? 'true' : 'false');
    mount.count.textContent = state.view ? String(state.view.count) : '\u2014';
    if (state.locked) {
      mount.alertText.textContent = 'Sign in to see who is connected';
      mount.alert.hidden = false;
    } else if (stale) {
      mount.alertText.textContent = 'Roster stale \u00b7 last confirmed ' + ago(Date.now() - state.confirmedAt) + ' ago';
      mount.alert.hidden = false;
    } else if (!state.view && state.failed) {
      mount.alertText.textContent = 'Presence unreachable';
      mount.alert.hidden = false;
    } else {
      mount.alert.hidden = true;
    }

    mount.list.textContent = '';
    if (!state.view) {
      const waiting = document.createElement('p');
      waiting.className = 'gbp-empty';
      waiting.textContent = state.locked ? 'Sign in as an operator to see the roster.' : 'Roster not loaded.';
      mount.list.appendChild(waiting);
      return;
    }
    if (state.view.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'gbp-empty';
      empty.textContent = 'No one connected.';
      mount.list.appendChild(empty);
      return;
    }
    const serverNow = Date.now() + state.skewMs;
    const grouped = {};
    for (const entry of state.view.entries) (grouped[entry.surface] = grouped[entry.surface] || []).push(entry);
    for (const key of SURFACE_ORDER) {
      const members = grouped[key];
      if (!members) continue;
      const group = document.createElement('div');
      group.className = 'gbp-group';
      const head = document.createElement('div');
      head.className = 'gbp-ghead';
      head.textContent = SURFACE_LABEL[key] || key;
      const n = document.createElement('span');
      n.className = 'gbp-gn';
      n.textContent = String(members.length);
      head.appendChild(n);
      group.appendChild(head);
      for (const entry of members) {
        const row = document.createElement('div');
        row.className = 'gbp-row';
        if (entry.client_id === clientId) row.setAttribute('data-self', 'true');
        const name = document.createElement('span');
        name.className = 'gbp-name';
        name.textContent = entry.name + (entry.role === 'admin' ? ' (admin)' : '');
        const meta = document.createElement('span');
        meta.className = 'gbp-meta';
        meta.textContent = entry.device + ' \u00b7 ' + ago(Math.max(0, serverNow - entry.last_seen));
        row.append(name, meta);
        group.appendChild(row);
      }
      mount.list.appendChild(group);
    }
  }

  function render() {
    for (const mount of mounts) paint(mount);
  }

  /** Mounts the roster panel into `container`, replacing its contents. Home is the only page that shows it. */
  function mount(container) {
    if (!container) return null;
    const root = document.createElement('div');
    root.className = 'gbp';
    root.innerHTML =
      '<div class="gbp-bar"><span class="gbp-count">' + svg(ICON_USERS) + '<span data-gbp-count>\u2014</span></span><span class="gbp-word">connected</span></div>'
      + '<div class="gbp-alert" data-gbp-alert role="status" aria-live="polite" hidden>' + svg(ICON_WARNING) + '<span data-gbp-alert-text></span></div>'
      + '<div class="gbp-list" data-gbp-list></div>';
    container.textContent = '';
    container.appendChild(root);
    const entry = {
      root,
      count: root.querySelector('[data-gbp-count]'),
      alert: root.querySelector('[data-gbp-alert]'),
      alertText: root.querySelector('[data-gbp-alert-text]'),
      list: root.querySelector('[data-gbp-list]')
    };
    mounts.push(entry);
    paint(entry);
    setInterval(render, 1000);
    start();
    return root;
  }

  window.GivebarPresence = { mount, surface, clientId };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
