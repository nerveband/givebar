/**
 * Givebar Testing: rehearsal sample gifts and their purge. Administrators only.
 * Sample gifts share the live ledger so the rehearsal exercises the real
 * chart; purging removes only rows tagged as rehearsal and snapshots first.
 */
(function () {
  'use strict';

  const fmt = GivebarSession.format;
  const $ = id => document.getElementById(id);
  const feedback = $('test-feedback');
  let sampleRecords = [];

  function showFeedback(message, tone) {
    feedback.textContent = message;
    feedback.className = `test-feedback ${tone === 'error' ? 'error' : 'ok'}`;
    feedback.style.display = 'block';
  }

  async function post(body) {
    try {
      const response = await GivebarSession.api('/api/rehearsal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return { ok: false, message: data.message || `Sample data generation failed (HTTP ${response.status}).` };
      }
      await sync();
      return { ok: true };
    } catch (_) {
      return { ok: false, message: 'Network error generating sample data.' };
    }
  }

  function wire(id, body, successMessage) {
    const button = $(id);
    if (!button) return;
    const label = button.textContent;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Generating…';
      try {
        const result = await post(body);
        showFeedback(result.ok ? successMessage : result.message, result.ok ? 'ok' : 'error');
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  }
  wire('btn-gen-single', { mode: 'single' }, 'Injected 1 sample gift.');
  wire('btn-gen-burst', { mode: 'burst', count: 7 }, 'Injected a burst of 7 sample gifts.');
  wire('btn-gen-typo', { mode: 'typo' }, 'Injected the typo gift. Go to Manage Donations and delete it before it reaches the screen.');
  wire('btn-gen-milestone', { mode: 'milestone' }, 'Injected the gift that crosses the next milestone.');

  $('btn-purge-sample-data').addEventListener('click', async () => {
    const count = sampleRecords.length;
    if (!count) { showFeedback('No sample gifts to purge.', 'ok'); return; }
    const ok = await GivebarSession.confirm({ title: `Purge ${count} sample gift${count === 1 ? '' : 's'}?`, body: 'Real gifts stay. A backup is taken first, and the ballroom screen resets to the real total.', confirmLabel: 'Purge sample data', danger: true });
    if (!ok) return;
    const button = $('btn-purge-sample-data');
    button.disabled = true;
    button.textContent = 'Purging…';
    try {
      const result = await GivebarSession.control('purge_rehearsal');
      if (!result.ok) { showFeedback(result.data.message || 'Purge failed.', 'error'); return; }
      await sync();
      showFeedback('Sample data purged. Real donations were left untouched.', 'ok');
    } finally {
      button.disabled = false;
      button.textContent = 'Purge Sample Data';
    }
  });

  $('btn-resync-chart').addEventListener('click', async () => {
    const ok = await GivebarSession.confirm({ title: 'Re-sync the ballroom figure?', body: 'The chart restarts from the real total right now. Use this before doors, never during the appeal.', confirmLabel: 'Re-sync chart', danger: true });
    if (!ok) return;
    const result = await GivebarSession.control('resync_chart');
    showFeedback(result.ok ? `Chart re-synced to ${fmt.money(result.data.state.stage_preview.stage_total_cents)}.` : (result.data.message || 'Could not re-sync the chart.'), result.ok ? 'ok' : 'error');
  });

  async function sync() {
    try {
      const response = await GivebarSession.api('/api/state?role=control');
      if (!response.ok) return;
      const data = await response.json();
      sampleRecords = data.donations.filter(item => item.source === 'rehearsal');
      render();
    } catch (_) { /* next poll retries */ }
  }

  function render() {
    const count = sampleRecords.length;
    const banner = $('test-mode-banner');
    banner.style.display = 'flex';
    $('test-banner-desc').textContent = count > 0 ? `${count} sample record${count === 1 ? '' : 's'} active. Purging removes only sample data.` : 'No sample records. The ledger holds real gifts only.';
    $('btn-purge-sample-data').disabled = count === 0;
    $('sample-count-badge').textContent = `${count} active record${count === 1 ? '' : 's'}`;
    const tbody = $('sample-records-tbody');
    const clean = $('sample-clean-state');
    if (count === 0) {
      tbody.innerHTML = '';
      clean.style.display = 'block';
      return;
    }
    clean.style.display = 'none';
    tbody.innerHTML = sampleRecords.map(item => `
      <tr>
        <td style="font-weight: 600; color: #f4f5f6;">${fmt.escape(item.donor_name)} <span class="sample-tag">[Sample Data]</span></td>
        <td class="text-right" style="font-weight: 700; font-variant-numeric: tabular-nums; color: #f4f5f6;">${fmt.money(item.amount_cents)}</td>
        <td class="text-center" style="color: #88888e; font-size: var(--text-xs);">${fmt.escape(fmt.time(item.created_at))}</td>
        <td class="text-center"><span class="status-badge ${item.is_live_on_stage ? 'confirmed' : 'pending'}">${item.is_live_on_stage ? 'On screen' : 'Waiting'}</span></td>
      </tr>`).join('');
  }

  sync();
  setInterval(sync, 3000);
})();
