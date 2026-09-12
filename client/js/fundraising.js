(() => {
  'use strict';
  const formId = document.getElementById('fundraising-form-id');
  const startDate = document.getElementById('fundraising-start-date');
  const enabled = document.getElementById('fundraising-enabled');
  const message = document.getElementById('fundraising-status');
  const save = document.getElementById('fundraising-save');
  const sync = document.getElementById('fundraising-sync');
  let initialized = false;
  let connected = false;
  let busy = false;
  async function request(payload) {
    if (busy) return;
    busy = true;
    save.disabled = sync.disabled = true;
    if (payload) message.textContent = payload.action === 'sync' ? 'Syncing gifts…' : 'Saving import settings…';
    try {
      const response = await GivebarSession.api('/api/fundraising', {
        method: payload ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not reach Fundraising status.');
      if (!initialized || payload?.action === 'configure') {
        formId.value = data.form_id;
        startDate.value = data.start_date;
        enabled.checked = !!data.enabled;
        initialized = true;
      }
      const lastSync = data.last_sync_at ? GivebarSession.format.time(data.last_sync_at) : 'Never';
      connected = !!data.token_configured;
      const badge = document.getElementById('fundraising-badge');
      badge.textContent = data.last_error ? 'Needs attention' : !connected ? 'Not configured' : data.enabled ? 'Automatic import on' : 'Import paused';
      badge.dataset.state = data.last_error || !connected ? 'warning' : data.enabled ? 'connected' : 'paused';
      document.getElementById('fundraising-count').textContent = `${data.imported_count} ${data.imported_count === 1 ? 'gift' : 'gifts'}`;
      document.getElementById('fundraising-last-sync').textContent = lastSync;
      message.textContent = data.last_error || (!connected ? 'Ask the event administrator to provision the Fundraising token on the server.' : !data.enabled ? 'Automatic imports are paused. Existing gifts remain in the ledger.' : data.running ? 'Sync in progress…' : `Connected to form ${data.form_id}. Next automatic check within 30 seconds.`);
      message.style.color = data.last_error ? '#fca5a5' : '';
    } catch (error) {
      message.textContent = error.message;
      message.style.color = '#fca5a5';
    } finally { busy = false; save.disabled = false; sync.disabled = !connected; }
  }
  save.addEventListener('click', async () => {
    const ok = await GivebarSession.confirm(enabled.checked
      ? { title: 'Import online gifts into the live ledger?', body: 'Accepted gifts from this gala form and date arrive automatically. Do not enter the same online gifts by hand.', confirmLabel: 'Save and import' }
      : { title: 'Pause automatic import?', body: 'Existing online gifts remain in the ledger. New ones stop arriving until you turn it back on.', confirmLabel: 'Pause import', danger: true });
    if (!ok) return;
    request({ action: 'configure', form_id: formId.value.trim(), start_date: startDate.value, enabled: enabled.checked });
  });
  sync.addEventListener('click', () => request({ action: 'sync' }));
  request();
  setInterval(() => { if (!document.hidden) request(); }, 15000);
})();
