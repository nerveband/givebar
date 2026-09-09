/**
 * Live Presence
 * -------------
 * Active operator browsers grouped by page. Chart and presenter are excluded;
 * the roster is displayed in the dedicated Presence section on Home.
 *
 * IDENTITY WITHOUT LOGIN. There are no accounts. This browser gets a stable id
 * in localStorage. The display name resolves, in order:
 *   1. a name the person set for themselves    (givebar_presence_name)
 *   2. the existing volunteer id, if the pad set one   (givebar_volunteer_id)
 *   3. an auto-assigned readable label derived from the client id
 * Renaming is local to this browser and travels with its heartbeats.
 *
 * PRIVACY. A heartbeat carries a client id, a display name, and a surface.
 * Nothing else. No donor data, no PINs, no API keys. The device class is
 * derived server-side from the request user-agent.
 *
 * NO SECOND POLLING LOOP. The roster arrives on the state channel the operator
 * surfaces already hold open: a page calls GiveBarPresence.update() with
 * `payload.presence` from its own /api/state fetch or SSE frame. Until a page
 * does that even once, the panel self-serves from GET /api/presence on the
 * heartbeat tick it already owns — one timer, and it retires the moment the
 * first push lands.
 *
 * DEGRADED STATE IS NOT OPTIONAL. Same rule the donation surfaces run under:
 * never assert current data you cannot confirm. When heartbeats or roster
 * reads stop succeeding, the panel says the roster is stale and when it was
 * last confirmed, rather than showing names as though they were live.
 *
 * Usage:
 *   GiveBarPresence.render(document.querySelector('#presence'));
 *   GiveBarPresence.update(payload.presence);   // from the page's own state feed
 */
(function () {
  'use strict';

  var HEARTBEAT_MS = 5000;
  /** Two missed heartbeats and the roster is no longer something we can assert. */
  var STALE_MS = 12000;
  /** A brief tab switch is not a departure; a backgrounded tab eventually is. */
  var HIDDEN_GRACE_MS = 30000;
  var TICK_MS = 1000;

  var CLIENT_ID_KEY = 'givebar_presence_client_id';
  var NAME_KEY = 'givebar_presence_name';
  var VOLUNTEER_KEY = 'givebar_volunteer_id';

  var ICON_USERS = 'M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-6.05-14.81,60,60,0,0,1,55.6,105.6,95.78,95.78,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z';
  var ICON_PENCIL = 'M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.32,96A16,16,0,0,0,227.32,73.37ZM48,163.31l88-88L180.69,120l-88,88H48ZM216,84.69,192,108.69,147.31,64,171.31,40Z';
  var ICON_WARNING = 'M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z';

  // Canonical route names, plus the legacy aliases still in circulation.
  var SURFACE_BY_PATH = {
    '/': 'home',
    '/index': 'home',
    '/chart': null,
    '/stage': null,
    '/donations': 'donations',
    '/control': 'donations',
    '/add': 'add',
    '/entry': 'add',
    '/presenter': null,
    '/emcee': null,
    '/settings': 'settings',
    '/testing': 'testing',
    '/presenter-preview': 'preview',
    '/history': 'history',
    '/preview': 'preview'
  };

  // Fixed group order so the roster never reshuffles under the operator's eye.
  var SURFACE_ORDER = ['donations', 'add', 'chart', 'presenter', 'preview', 'settings', 'testing', 'history', 'home'];
  var SURFACE_LABEL = {
    home: 'Home',
    chart: 'Chart',
    donations: 'Donations',
    add: 'Add',
    presenter: 'Presenter',
    settings: 'Settings',
    testing: 'Testing',
    history: 'History',
    preview: 'Preview'
  };

  // Reporting stays invisible on operator pages; Home owns the roster.
  var PANEL_SURFACES = {
    home: true
  };

  var STYLE_ID = 'gbp-style';
  var CSS = [
    '.gbp{--gbp-line:rgba(255,255,255,.09);--gbp-amber:var(--color-warning,oklch(0.80 0.16 75));',
    'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);',
    'background:var(--bg-surface,#16150f);border:1px solid var(--gbp-line);border-radius:var(--brand-radius,6px);',
    'color:var(--ink-primary,#f7f7f5);overflow:hidden}',
    '.gbp-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--gbp-line)}',
    '.gbp-count{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;letter-spacing:.01em}',
    '.gbp-count svg{width:14px;height:14px;color:var(--gbp-amber);flex:0 0 auto}',
    '.gbp-word{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted,#a3a099)}',
    '.gbp-me{margin-left:auto;display:inline-flex;align-items:center;gap:5px;background:transparent;',
    'border:1px solid var(--gbp-line);border-radius:var(--brand-radius,6px);color:var(--ink-secondary,#c9c6bd);',
    'font:inherit;font-size:12px;padding:3px 7px;cursor:pointer;max-width:52%;min-height:44px}',
    '.gbp-me:hover{border-color:var(--gbp-amber);color:var(--ink-primary,#f7f7f5)}',
    '.gbp-me svg{width:11px;height:11px;flex:0 0 auto;opacity:.65}',
    '.gbp-me-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gbp-input{margin-left:auto;background:var(--bg-canvas,#0b0a07);border:1px solid var(--gbp-amber);',
    'border-radius:var(--brand-radius,6px);color:var(--ink-primary,#f7f7f5);font:inherit;font-size:12px;',
    'padding:3px 7px;width:52%;min-width:0;min-height:44px}',
    '.gbp-alert{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:11.5px;',
    'color:var(--gbp-amber);background:color-mix(in oklab,var(--gbp-amber) 10%,transparent);',
    'border-bottom:1px solid var(--gbp-line)}',
    // `display:flex` outranks the UA sheet's `[hidden]{display:none}`, so the
    // happy path leaked an empty amber strip until this was stated explicitly.
    '.gbp-alert[hidden]{display:none}',
    '.gbp-alert svg{width:12px;height:12px;flex:0 0 auto}',
    '.gbp-list{max-height:280px;overflow:auto}',
    '.gbp-group + .gbp-group{border-top:1px solid var(--gbp-line)}',
    '.gbp-ghead{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:10.5px;',
    'text-transform:uppercase;letter-spacing:.09em;color:var(--ink-muted,#a3a099);',
    'background:color-mix(in oklab,#fff 3%,transparent)}',
    '.gbp-gn{margin-left:auto;font-variant-numeric:tabular-nums}',
    '.gbp-row{display:flex;align-items:baseline;gap:8px;padding:5px 10px;font-size:12.5px}',
    '.gbp-row + .gbp-row{border-top:1px solid color-mix(in oklab,#fff 5%,transparent)}',
    '.gbp-row[data-self]{box-shadow:inset 2px 0 0 var(--gbp-amber)}',
    '.gbp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gbp-meta{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--ink-muted,#a3a099);',
    'font-variant-numeric:tabular-nums}',
    '.gbp-empty{padding:12px 10px;font-size:12px;color:var(--ink-muted,#a3a099)}',
    '.gbp[data-stale="true"] .gbp-list{opacity:.45;filter:grayscale(1)}',
    '.gbp[data-stale="true"] .gbp-count svg{color:var(--ink-muted,#a3a099)}'
  ].join('');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function svg(path, cls) {
    return '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"'
      + (cls ? ' class="' + cls + '"' : '') + '><path d="' + path + '"/></svg>';
  }

  function store(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function keep(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* private mode: id stays session-local */ }
  }

  function currentSurface() {
    var path = window.location.pathname.replace(/\.html$/, '').replace(/\/+$/, '');
    if (path === '') path = '/';
    return SURFACE_BY_PATH[path] || null;
  }

  var clientId = (function () {
    var existing = store(CLIENT_ID_KEY);
    if (existing && /^[A-Za-z0-9_.:-]{4,64}$/.test(existing)) return existing;
    var fresh = 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    keep(CLIENT_ID_KEY, fresh);
    return fresh;
  })();

  /**
   * Auto label, derived from the client id so it is stable across reloads and
   * readable out loud: "Station 41", not a hash. Two operators colliding on a
   * number is survivable; either can rename.
   */
  function autoLabel() {
    var sum = 0;
    for (var i = 0; i < clientId.length; i++) sum = (sum * 31 + clientId.charCodeAt(i)) % 9973;
    return 'Station ' + (sum % 90 + 10);
  }

  function resolvedName() {
    var chosen = store(NAME_KEY);
    if (chosen && chosen.trim() !== '') return chosen.trim();
    var volunteer = store(VOLUNTEER_KEY);
    if (volunteer && volunteer.trim() !== '') return volunteer.trim();
    return autoLabel();
  }

  var surface = currentSurface();
  var state = {
    view: null,          // last roster received, whatever the source
    confirmedAt: 0,      // local ms of the last successful roster read
    beatOk: false,       // did the most recent heartbeat succeed
    locked: false,
    rosterFailed: false,
    beatAt: 0,
    skewMs: 0,           // server clock minus local clock
    pushes: 0,           // roster frames handed in by the page
    started: false,
    paused: false
  };

  var timers = { beat: null, tick: null, hide: null };
  var mounts = [];

  function heartbeat() {
    if (!surface) return Promise.resolve(false);
    return fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, name: resolvedName(), surface: surface })
    }).then(function (res) {
      if (!res.ok) throw new Error('presence ' + res.status);
      return res.json();
    }).then(function (data) {
      state.beatOk = true;
      state.beatAt = Date.now();
      if (typeof data.now === 'number') state.skewMs = data.now - state.beatAt;
      return true;
    }).catch(function () {
      state.beatAt = Date.now();
      state.beatOk = false;
      render();
      return false;
    });
  }

  /**
   * Self-served roster, used only while no page has pushed one. Rides the
   * heartbeat tick rather than adding a loop of its own, and stops for good
   * after the first update() call.
   */
  function pullRoster() {
    if (state.pushes > 0 || mounts.length === 0) return;
    fetch('/api/presence', {
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache' }
    }).then(function (res) {
      if (res.status === 401) {
        lockRoster();
        return null;
      }
      if (!res.ok) throw new Error('roster ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return;
      if (typeof data.now === 'number') state.skewMs = data.now - Date.now();
      applyView(data);
    }).catch(function () {
      state.rosterFailed = true;
      render();
    });
  }

  function lockRoster() {
    state.view = null;
    state.locked = true;
    state.pushes = 0;
    render();
  }

  function applyView(view) {
    if (!view || !Array.isArray(view.entries)) return;
    state.locked = false;
    state.rosterFailed = false;
    state.view = view;
    state.confirmedAt = Date.now();
    render();
  }

  function beat() {
    heartbeat().then(function (ok) {
      if (ok) pullRoster();
      else render();
    });
  }

  function start() {
    if (surface && !document.getElementById('operator-identity')) mountIdentity();
    if (state.started || !surface) return;
    state.started = true;
    state.paused = false;
    beat();
    timers.beat = setInterval(beat, HEARTBEAT_MS);
  }

  function stop() {
    state.started = false;
    if (timers.beat) { clearInterval(timers.beat); timers.beat = null; }
  }

  /**
   * A tab switch is not a departure. Heartbeats continue through a brief hide
   * and only stop once the tab has been backgrounded past the grace window, so
   * a minimized laptop stops claiming to be an active operator without a
   * cmd-tab dropping anyone off the roster.
   */
  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      if (timers.hide) return;
      timers.hide = setTimeout(function () {
        timers.hide = null;
        state.paused = true;
        stop();
      }, HIDDEN_GRACE_MS);
      return;
    }
    if (timers.hide) { clearTimeout(timers.hide); timers.hide = null; }
    if (state.paused || !state.started) {
      state.paused = false;
      start();
    }
  }

  function ago(ms) {
    if (ms < 2000) return 'now';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    return Math.round(ms / 3600000) + 'h';
  }

  function isStale() {
    if (!state.view) return false;
    if (!state.beatOk && state.beatAt !== 0) return true;
    return Date.now() - state.confirmedAt > STALE_MS;
  }

  function row(entry, serverNow) {
    var el = document.createElement('div');
    el.className = 'gbp-row';
    if (entry.client_id === clientId) el.setAttribute('data-self', 'true');

    var name = document.createElement('span');
    name.className = 'gbp-name';
    name.textContent = entry.name;

    var meta = document.createElement('span');
    meta.className = 'gbp-meta';
    meta.textContent = entry.device + ' \u00b7 ' + ago(Math.max(0, serverNow - entry.last_seen));

    el.appendChild(name);
    el.appendChild(meta);
    return el;
  }

  function buildList(target) {
    target.textContent = '';
    var view = state.view;

    if (!view) {
      var waiting = document.createElement('p');
      waiting.className = 'gbp-empty';
      waiting.textContent = state.locked
        ? 'Unlock an operator page with the Control Room PIN, then return here to see presence.'
        : 'Roster not loaded.';
      target.appendChild(waiting);
      return;
    }

    if (view.entries.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'gbp-empty';
      empty.textContent = 'No one connected.';
      target.appendChild(empty);
      return;
    }

    var serverNow = Date.now() + state.skewMs;
    var grouped = {};
    var i;
    for (i = 0; i < view.entries.length; i++) {
      var entry = view.entries[i];
      if (!grouped[entry.surface]) grouped[entry.surface] = [];
      grouped[entry.surface].push(entry);
    }

    for (i = 0; i < SURFACE_ORDER.length; i++) {
      var key = SURFACE_ORDER[i];
      var members = grouped[key];
      if (!members) continue;

      var group = document.createElement('div');
      group.className = 'gbp-group';

      var head = document.createElement('div');
      head.className = 'gbp-ghead';
      head.textContent = SURFACE_LABEL[key] || key;
      var n = document.createElement('span');
      n.className = 'gbp-gn';
      n.textContent = String(members.length);
      head.appendChild(n);
      group.appendChild(head);

      for (var j = 0; j < members.length; j++) group.appendChild(row(members[j], serverNow));
      target.appendChild(group);
    }
  }

  function render() {
    for (var i = 0; i < mounts.length; i++) paint(mounts[i]);
  }

  function paint(mount) {
    var stale = isStale();
    mount.root.setAttribute('data-stale', stale ? 'true' : 'false');
    mount.count.textContent = state.view ? String(state.view.count) : '\u2014';

    if (!mount.editing) {
      mount.meText.textContent = resolvedName();
      mount.me.title = 'Rename this browser';
    }

    if (state.locked) {
      mount.alertText.textContent = 'Presence requires the Control Room PIN';
      mount.alert.hidden = false;
    } else if (stale) {
      var since = state.confirmedAt ? ago(Date.now() - state.confirmedAt) : 'never';
      mount.alertText.textContent = 'Roster stale \u00b7 last confirmed ' + since + ' ago';
      mount.alert.hidden = false;
    } else if (!state.view && (state.rosterFailed || (state.beatAt !== 0 && !state.beatOk))) {
      mount.alertText.textContent = 'Presence unreachable';
      mount.alert.hidden = false;
    } else {
      mount.alert.hidden = true;
    }

    buildList(mount.list);
  }

  function beginRename(mount) {
    if (mount.editing) return;
    mount.editing = true;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'gbp-input';
    input.maxLength = 32;
    input.value = resolvedName();
    input.setAttribute('aria-label', 'Your display name');

    function finish(commit) {
      if (!mount.editing) return;
      mount.editing = false;
      var next = input.value.trim();
      input.replaceWith(mount.me);
      if (commit && next !== '') {
        keep(NAME_KEY, next);
        window.dispatchEvent(new Event('givebar:identitychange'));
        heartbeat().then(pullRoster);
      }
      paint(mount);
      mount.me.focus();
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });

    mount.me.replaceWith(input);
    input.focus();
    input.select();
  }

  function render_(container) {
    if (!container) return null;
    injectStyle();

    var existing = null;
    for (var i = 0; i < mounts.length; i++) {
      if (mounts[i].container === container) existing = mounts[i];
    }
    if (existing) { paint(existing); return existing.root; }

    var root = document.createElement('div');
    root.className = 'gbp';
    root.setAttribute('data-gbp', 'true');
    root.innerHTML =
      '<div class="gbp-bar">'
      + '<span class="gbp-count">' + svg(ICON_USERS) + '<span data-gbp-count>\u2014</span></span>'
      + '<span class="gbp-word">connected</span>'
      + '<button type="button" class="gbp-me" data-gbp-me>'
      + '<span class="gbp-me-text" data-gbp-me-text></span>' + svg(ICON_PENCIL)
      + '</button>'
      + '</div>'
      + '<div class="gbp-alert" data-gbp-alert role="status" aria-live="polite" hidden>'
      + svg(ICON_WARNING) + '<span data-gbp-alert-text></span></div>'
      + '<div class="gbp-list" data-gbp-list></div>';

    container.textContent = '';
    container.appendChild(root);

    var mount = {
      container: container,
      root: root,
      count: root.querySelector('[data-gbp-count]'),
      me: root.querySelector('[data-gbp-me]'),
      meText: root.querySelector('[data-gbp-me-text]'),
      alert: root.querySelector('[data-gbp-alert]'),
      alertText: root.querySelector('[data-gbp-alert-text]'),
      list: root.querySelector('[data-gbp-list]'),
      editing: false
    };
    mount.me.addEventListener('click', function () { beginRename(mount); });
    mounts.push(mount);

    if (!timers.tick) timers.tick = setInterval(render, TICK_MS);
    start();
    paint(mount);
    if (state.pushes === 0) pullRoster();
    return root;
  }

  const easternTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short'
  });
  window.GivebarOperator = {
    time: value => value ? easternTime.format(new Date(value)) : 'Time unavailable',
    actor: () => resolvedName(),
    source: value => ({ manual: 'Manual entry', bloomerang: 'Bloomerang', rehearsal: 'Rehearsal', stripe: 'Stripe', kindful: 'Kindful' })[value] || value || 'Source unavailable'
  };
  function mountIdentity() {
    const sidebar = document.querySelector('.ops-sidebar');
    if (!sidebar) return;
    const button = document.createElement('button');
    button.id = 'operator-identity';
    button.type = 'button';
    button.className = 'operator-identity';
    button.innerHTML = '<span class="operator-identity-label">Recording donations as</span><strong></strong><span class="operator-identity-action">Change name</span>';
    const repaint = () => { button.querySelector('strong').textContent = resolvedName(); };
    window.addEventListener('givebar:identitychange', repaint);
    repaint();
    sidebar.append(button);
    const dialog = document.createElement('dialog');
    dialog.className = 'operator-dialog';
    dialog.setAttribute('aria-labelledby', 'operator-dialog-title');
    dialog.setAttribute('aria-describedby', 'operator-dialog-help');
    dialog.innerHTML = '<form method="dialog" novalidate><h2 id="operator-dialog-title">Who is recording donations?</h2><p id="operator-dialog-help">Use your name so the team can see who added or changed a gift. This labels this browser; it is not a login.</p><label for="operator-name">Your name <span>(required)</span></label><input id="operator-name" maxlength="32" required autocomplete="name" aria-describedby="operator-name-error"><p id="operator-name-error" class="operator-name-error" role="alert" hidden>Enter your name to continue.</p><div class="operator-dialog-actions"><button type="button" class="btn-secondary" data-identity-cancel>Cancel</button><button type="submit" class="btn-primary">Save name</button></div></form>';
    document.body.append(dialog);
    const input = dialog.querySelector('input');
    const error = dialog.querySelector('#operator-name-error');
    const cancel = dialog.querySelector('[data-identity-cancel]');
    let firstUse = false;
    const open = () => {
      firstUse = !localStorage.getItem(NAME_KEY);
      dialog.querySelector('h2').textContent = firstUse ? 'Who is recording donations?' : 'Change your recording name';
      dialog.querySelector('[type="submit"]').textContent = firstUse ? 'Start recording' : 'Save name';
      cancel.hidden = firstUse;
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      input.value = firstUse ? '' : resolvedName();
      dialog.showModal();
      input.focus();
      input.select();
    };
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (!input.value.trim()) {
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      window.GiveBarPresence.setName(input.value);
      dialog.close();
      repaint();
      button.focus();
    });
    input.addEventListener('input', () => {
      if (input.value.trim()) { error.hidden = true; input.removeAttribute('aria-invalid'); }
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (firstUse) event.preventDefault(); });
    button.addEventListener('click', open);
    if (!localStorage.getItem(NAME_KEY)) open();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-donation]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copyDonation);
      button.textContent = 'Copied';
    } catch (_) { button.textContent = 'Copy unavailable'; }
  });

  window.GiveBarPresence = {
    surface: surface,
    clientId: clientId,
    heartbeatMs: HEARTBEAT_MS,
    panelSurfaces: PANEL_SURFACES,

    /** Home displays the roster; the other operator pages only report. */
    showsPanel: function () { return Boolean(surface && PANEL_SURFACES[surface]); },

    /** Mounts the panel into `container`, replacing its contents. */
    render: render_,

    /** Hand in `payload.presence` from the page's own /api/state fetch or SSE frame. */
    update: function (view) {
      if (view == null) { lockRoster(); return; }
      if (!view || !Array.isArray(view.entries)) return;
      state.pushes++;
      applyView(view);
    },

    getName: resolvedName,

    /** Local to this browser; travels with subsequent heartbeats. */
    setName: function (name) {
      var next = String(name == null ? '' : name).trim().slice(0, 32);
      if (next === '') return false;
      keep(NAME_KEY, next);
      window.dispatchEvent(new Event('givebar:identitychange'));
      render();
      heartbeat().then(pullRoster);
      return true;
    },

    start: start,
    stop: stop
  };

  document.addEventListener('visibilitychange', onVisibility);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
