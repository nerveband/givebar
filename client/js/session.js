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

  /** "Signed in as" block plus sign-out in the operator sidebar; operators lose the administrator links. */
  async function mountIdentity() {
    const sidebar = document.querySelector('.ops-sidebar');
    if (!sidebar) return;
    const me = await whoami();
    if (!me.authenticated) return;
    if (me.role !== 'admin') {
      document.querySelectorAll('.ops-nav a[href="/settings"], .ops-nav a[href="/testing"]').forEach(link => link.remove());
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

  window.GivebarSession = { api, control, whoami, logout, format };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountIdentity);
  else mountIdentity();
})();
