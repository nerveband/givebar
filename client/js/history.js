/**
 * Givebar History: the complete audit trail, newest first.
 *
 * Every create, edit, delete, and restore with the operator who did it and the
 * exact Eastern time. Actions here go through the same ledger endpoints as
 * Manage Donations: Undo voids a gift, Restore brings a deleted gift back.
 * The Restore/Undo buttons follow the gift's current status, not the row, so
 * a gift that was deleted and already restored does not offer Restore twice.
 */
(function () {
  'use strict';

  const fmt = GivebarSession.format;
  let events = [];
  let status = {};
  let filterType = 'all';
  let searchQuery = '';

  const timeline = document.getElementById('history-timeline');
  const searchInput = document.getElementById('history-search');
  const summary = document.getElementById('history-summary');
  const chips = document.querySelectorAll('.filter-chip');
  const ACTION_LABEL = { create: 'Added', amend: 'Edited', void: 'Deleted', restore: 'Restored' };

  async function sync() {
    try {
      const response = await GivebarSession.api('/api/history');
      if (!response.ok) return;
      const data = await response.json();
      events = data.events;
      status = data.status;
      if (summary) summary.textContent = `${data.active_donation_count} active gifts · ${fmt.money(data.total_raised_cents)} · ${data.void_count} deleted`;
      render();
    } catch (_) { /* next poll retries */ }
  }

  function filtered() {
    return events.filter(event => {
      if (event.event_type === 'match_apply' || event.event_type === 'match_release') return false;
      if (filterType !== 'all' && event.event_type !== filterType) return false;
      if (!searchQuery) return true;
      return [event.donor_name, event.display_name, event.entered_by, event.notes, event.card_number].some(value => value && String(value).toLowerCase().includes(searchQuery));
    });
  }

  function render() {
    const list = filtered();
    if (list.length === 0) {
      timeline.innerHTML = `<div class="history-empty">${searchQuery || filterType !== 'all' ? 'No history events match your filter.' : 'No history recorded in this event.'}</div>`;
      return;
    }
    const bySeq = new Map(events.map(event => [event.seq, event]));
    timeline.innerHTML = list.map(event => {
      const donor = event.is_anonymous ? `${fmt.escape(event.donor_name)} <span class="donation-flag">Anonymous on screen</span>` : fmt.escape(event.donor_name);
      let amount = fmt.money(event.amount_cents);
      if (event.event_type === 'amend' && event.supersedes_seq) {
        const prior = bySeq.get(event.supersedes_seq);
        if (prior && prior.amount_cents !== event.amount_cents) amount = `${fmt.money(prior.amount_cents)} &rarr; ${fmt.money(event.amount_cents)}`;
      }
      const current = status[event.donation_id];
      let action = '';
      if (current && current.is_voided && event.event_type === 'void') action = `<button type="button" class="btn-timeline-action" data-restore-id="${fmt.escape(event.donation_id)}" data-donor="${fmt.escape(event.donor_name)}" data-amount="${current.amount_cents}">Restore gift</button>`;
      else if (current && !current.is_voided && (event.event_type === 'create' || event.event_type === 'restore' || event.event_type === 'amend')) action = `<button type="button" class="btn-timeline-action danger" data-void-id="${fmt.escape(event.donation_id)}" data-donor="${fmt.escape(event.donor_name)}" data-amount="${current.amount_cents}">Delete gift</button>`;
      const note = event.notes && event.event_type !== 'void' && event.event_type !== 'restore' ? `<div class="donation-note">${fmt.escape(event.notes)}</div>` : '';
      const reason = (event.event_type === 'void' || event.event_type === 'restore') && event.notes ? ` &bull; <span>${fmt.escape(event.notes)}</span>` : '';
      return `
        <div class="timeline-item" data-seq="${event.seq}">
          <div class="timeline-node" aria-hidden="true"></div>
          <div class="timeline-main-content">
            <div class="timeline-primary-line">
              <span class="timeline-action-tag ${event.event_type}">${ACTION_LABEL[event.event_type] || event.event_type}</span>
              <span class="timeline-sep">|</span>
              <span class="timeline-donor">${donor}</span>
              <span class="timeline-sep">|</span>
              <span class="timeline-amount">${amount}</span>
            </div>
            ${note}
            <div class="timeline-sub-line">
              <span>${fmt.escape(event.entered_by || 'Unknown operator')}</span>
              <span>&bull;</span>
              <span>${fmt.escape(fmt.time(event.created_at))}</span>
              <span>&bull;</span><span>${fmt.escape(fmt.source(event.source))}</span>${reason}
            </div>
          </div>
          <div>${action}</div>
        </div>`;
    }).join('');
  }

  timeline.addEventListener('click', async event => {
    const restore = event.target.closest('[data-restore-id]');
    const undo = event.target.closest('[data-void-id]');
    const button = restore || undo;
    if (!button) return;
    const verb = restore ? 'restore' : 'void';
    const amount = fmt.money(Number(button.dataset.amount));
    const ok = await GivebarSession.confirm(verb === 'void'
      ? { title: 'Delete this gift?', body: `Delete ${amount} from ${button.dataset.donor}? It leaves the total and the list; the ballroom figure never rolls backward. You can restore it from here.`, confirmLabel: 'Delete gift', danger: true }
      : { title: 'Restore this gift?', body: `Restore ${amount} from ${button.dataset.donor}? It returns to the total and the list, and appears on the ballroom screen after the staging delay.`, confirmLabel: 'Restore gift' });
    if (!ok) return;
    const id = restore ? restore.dataset.restoreId : undo.dataset.voidId;
    const response = await GivebarSession.api(`/api/donation/${id}/${verb}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: verb === 'restore' ? 'Restored from History' : 'Deleted from History' }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      GivebarSession.toast(data.message || 'The change could not be made.', 'error');
    } else GivebarSession.toast(`${amount} from ${button.dataset.donor} ${verb === 'restore' ? 'restored' : 'deleted'}.`);
    await sync();
  });

  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(other => other.classList.remove('active'));
    chip.classList.add('active');
    filterType = chip.dataset.filter || 'all';
    render();
  }));
  if (searchInput) searchInput.addEventListener('input', () => { searchQuery = searchInput.value.trim().toLowerCase(); render(); });

  sync();
  setInterval(sync, 3000);
})();
