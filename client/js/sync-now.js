(() => {
  'use strict';
  const host = document.querySelector('[data-sync-now]');
  if (!host) return;
  const button = host.querySelector('button');
  const status = host.querySelector('[role="status"]');
  fetch('/api/control', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'auth_check' })
  }).then(response => response.json()).then(me => {
    host.hidden = !me.authenticated || !['admin', 'operator'].includes(me.role);
  }).catch(() => {});
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Syncing…';
    status.textContent = '';
    try {
      const response = await fetch('/api/fundraising', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
        signal: AbortSignal.timeout(25000)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to sync.' : 'Could not sync. Try again.');
      status.textContent = result.last_error ? 'Sync needs attention. See Settings.' : !result.enabled ? 'Import is paused in Settings.' : result.running ? 'A sync is already running.' : 'Synced. Live totals update automatically.';
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? 'Sync is taking longer than expected. Check Settings.' : error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Sync now';
    }
  });
})();
