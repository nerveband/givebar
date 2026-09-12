/**
 * Givebar operator session helpers.
 *
 * Auth is an HttpOnly cookie; the browser never sees a PIN or token. Every
 * operator page loads this first: it paints "Signed in as", hides the
 * administrator-only pages from operators, and sends anyone without a
 * session back to the sign-in page as soon as an API call answers 401.
 */
(function () {
  'use strict';

  let whoamiPromise = null;

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache');
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    if (response.status === 401 && location.pathname !== '/signin') {
      location.replace('/signin?next=' + encodeURIComponent(location.pathname));
      throw new Error('Operator sign-in required');
    }
    return response;
  }

  async function control(action, payload = {}) {
    const response = await api('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  function whoami() {
    if (!whoamiPromise) {
      whoamiPromise = fetch('/api/control', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auth_check' })
      }).then(response => response.json()).catch(() => ({ authenticated: false }));
    }
    return whoamiPromise;
  }

  async function logout() {
    await control('logout');
    location.replace('/signin');
  }

  const easternTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short'
  });
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const SOURCE_LABEL = { manual: 'Entered by hand', bloomerang: 'Online gift', rehearsal: 'Rehearsal sample' };

  const format = {
    time: value => value ? easternTime.format(new Date(value)) : 'Time unavailable',
    money: cents => currency.format((cents || 0) / 100),
    source: value => SOURCE_LABEL[value] || value || 'Source unavailable',
    escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  };

  /**
   * One styled dialog for every confirmation and prompt in the product. Native
   * confirm()/prompt() are never used: Chrome can suppress them for the rest of a
   * session, which would silently disable Pause on the night.
   */
  let dialogEl = null;
  function ensureDialog() {
    if (dialogEl) return dialogEl;
    dialogEl = document.createElement('dialog');
    dialogEl.className = 'operator-dialog confirm-dialog';
    dialogEl.setAttribute('aria-labelledby', 'confirm-title');
    dialogEl.innerHTML = '<form method="dialog" novalidate><h2 id="confirm-title"></h2><p id="confirm-body"></p><label id="confirm-input-label" for="confirm-input" hidden></label><input id="confirm-input" hidden autocomplete="off"><p id="confirm-error" class="field-error" role="alert"></p><div class="operator-dialog-actions"><button type="button" class="btn-secondary" value="cancel">Cancel</button><button type="submit" class="btn-primary" value="ok">OK</button></div></form>';
    document.body.append(dialogEl);
    return dialogEl;
  }

  /** Resolves true when confirmed, false when cancelled. */
  function confirm(options) {
    return prompt({ ...options, input: false }).then(value => value !== null);
  }

  /**
   * Resolves the typed value (validated by `options.validate`, which returns an error
   * message or empty) or null when cancelled. `options.input` false makes it a plain confirm.
   */
  function prompt(options) {
    const dialog = ensureDialog();
    const title = dialog.querySelector('#confirm-title');
    const body = dialog.querySelector('#confirm-body');
    const label = dialog.querySelector('#confirm-input-label');
    const input = dialog.querySelector('#confirm-input');
    const error = dialog.querySelector('#confirm-error');
    const cancel = dialog.querySelector('[value="cancel"]');
    const ok = dialog.querySelector('[value="ok"]');
    const form = dialog.querySelector('form');
    const useInput = options.input !== false;
    title.textContent = options.title || 'Are you sure?';
    body.textContent = options.body || '';
    label.textContent = options.label || '';
    label.hidden = !useInput;
    input.hidden = !useInput;
    input.type = options.type || 'text';
    input.inputMode = options.inputMode || '';
    input.placeholder = options.placeholder || '';
    input.value = options.value || '';
    error.textContent = '';
    ok.textContent = options.confirmLabel || 'OK';
    ok.className = options.danger ? 'btn-danger' : 'btn-primary';
    cancel.textContent = options.cancelLabel || 'Cancel';
    const opener = document.activeElement;
    return new Promise(resolve => {
      const finish = value => {
        form.onsubmit = null;
        cancel.onclick = null;
        dialog.onclose = null;
        if (dialog.open) dialog.close();
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        resolve(value);
      };
      form.onsubmit = event => {
        event.preventDefault();
        const value = useInput ? input.value : true;
        const problem = options.validate ? options.validate(value) : '';
        if (problem) { error.textContent = problem; input.focus(); return; }
        finish(value);
      };
      cancel.onclick = () => finish(null);
      dialog.onclose = () => finish(null);
      dialog.showModal();
      (useInput ? input : options.danger ? cancel : ok).focus();
    });
  }

  /** Viewport-fixed notice that never depends on scroll position. */
  let toastHost = null;
  function toast(text, tone = 'ok') {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.append(toastHost);
    }
    const item = document.createElement('div');
    item.className = `toast toast-${tone}`;
    item.textContent = text;
    toastHost.append(item);
    setTimeout(() => item.remove(), tone === 'error' ? 8000 : 5000);
  }

  /**
   * Operator shell: "Signed in as" plus sign-out in the sidebar, administrator links
   * hidden from operators, a skip link, and a menu button that opens the sidebar on
   * phones and tablets.
   */
  async function mountShell() {
    const sidebar = document.querySelector('.ops-sidebar');
    const main = document.querySelector('.ops-main');
    if (!sidebar || !main) return;
    if (!main.id) main.id = 'main';
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = `#${main.id}`;
    skip.textContent = 'Skip to content';
    document.body.prepend(skip);
    // Sticky banners (record, outbox, Undo) sit just below the compact header on phones
    // and tablets; publish its live height so an open menu never hides them.
    const publishHeaderHeight = () => document.documentElement.style.setProperty('--ops-header-h', `${sidebar.offsetHeight}px`);
    publishHeaderHeight();
    new ResizeObserver(publishHeaderHeight).observe(sidebar);
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'ops-menu-toggle';
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-controls', 'ops-sidebar-nav');
    menu.textContent = 'Menu';
    sidebar.querySelector('.ops-brand').append(menu);
    sidebar.querySelector('.ops-nav').id = 'ops-sidebar-nav';
    menu.addEventListener('click', () => {
      const open = sidebar.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
      menu.textContent = open ? 'Close' : 'Menu';
    });

    const me = await whoami();
    if (!me.authenticated) return;
    if (me.role !== 'admin') {
      document.querySelectorAll('.ops-nav a[href="/settings"], .ops-nav a[href="/testing"], .ops-nav a[href="/team"]').forEach(link => link.remove());
    }
    const block = document.createElement('div');
    block.className = 'operator-identity';
    block.innerHTML = '<span class="operator-identity-label">Signed in as</span><strong></strong><span class="operator-identity-role"></span><button type="button" class="operator-identity-action">Sign out</button>';
    block.querySelector('strong').textContent = me.displayName || me.username;
    block.querySelector('.operator-identity-role').textContent = me.role === 'admin' ? 'Administrator' : 'Operator';
    block.querySelector('button').addEventListener('click', logout);
    sidebar.append(block);
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-text]');
    if (!button) return;
    const original = button.dataset.copyLabel || button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copyText);
      button.textContent = 'Copied';
    } catch (_) {
      button.textContent = 'Copy unavailable';
    }
    setTimeout(() => { button.textContent = original; }, 1800);
  });

  /** Arrow keys move selection inside any role="radiogroup" of buttons, as the ARIA pattern requires. */
  document.addEventListener('keydown', event => {
    const group = event.target.closest('[role="radiogroup"]');
    if (!group || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const index = items.indexOf(event.target);
    if (index === -1) return;
    event.preventDefault();
    const next = items[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
    next.focus();
    next.click();
  });

  window.GivebarSession = { api, control, whoami, logout, format, confirm, prompt, toast };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountShell);
  else mountShell();
})();
