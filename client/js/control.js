/**
 * Givebar Manage Donations.
 *
 * One table of every active gift with keyed row updates (focus and selection
 * survive refreshes), client-side search and sorting, edit and delete with a
 * 30-second undo, the ballroom pause switch, and the shared team notes.
 * State arrives on the live channel; the stale banner appears the moment the
 * page cannot confirm current data.
 */
(function () {
  'use strict';

  const fmt = GivebarSession.format;
  let donations = [];
  let state = null;
  let searchQuery = '';
  let sortColumn = 'time';
  let sortDirection = 'desc';
  let serverOffsetMs = 0;

  let pendingDelete = null;
  let lastDeleted = null;
  let undoTimer = null;

  const $ = id => document.getElementById(id);
  const tbody = $('manage-tbody');
  const panelTable = $('panel-table');
  const emptyState = $('empty-state');
  const staleBanner = $('stale-banner');
  const staleText = $('stale-banner-text');
  const deleteModal = $('delete-modal');
  const undoBanner = $('undo-banner');

  // --- Live channel ---------------------------------------------------------
  const channel = GivebarLive.connect({
    role: 'control',
    onState: handleState,
    onServerTime: value => { serverOffsetMs = value - Date.now(); },
    onLiveness(ok, lastAt) {
      staleBanner.style.display = ok ? 'none' : 'flex';
      if (!ok) staleText.textContent = lastAt ? `Connection lost. Showing data from ${new Date(lastAt).toLocaleTimeString()}, retrying.` : 'Connecting to the server.';
    }
  });
  $('btn-reconnect-poll').addEventListener('click', channel.refresh);
  window.addEventListener('givebar:donation-recorded', channel.refresh);

  function handleState(data) {
    state = data;
    window.dispatchEvent(new CustomEvent('givebar:control-state', { detail: data }));
    $('summary-total-raised').textContent = fmt.money(data.folded.total_raised_cents);
    $('summary-stage-total').textContent = fmt.money(data.stage_preview.stage_total_cents);
    $('summary-gift-count').textContent = String(data.folded.active_donation_count);
    donations = data.donations;
    $('summary-pending-count').textContent = String(donations.filter(d => !d.is_live_on_stage || d.is_held).length);
    const paused = data.stage_preview.is_frozen;
    const pauseButton = $('btn-pause-chart');
    pauseButton.textContent = paused ? 'Resume chart' : 'Pause chart';
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.classList.toggle('btn-danger', paused);
    $('paused-notice').hidden = !paused;
    renderNotes(data.team_notes || []);
    renderTable();
  }

  // --- Table ----------------------------------------------------------------
  function statusOf(item) {
    if (item.is_held) return { key: 'held', label: 'Held' };
    if (!item.is_live_on_stage) {
      const remaining = Math.max(0, Math.ceil((item.created_at + (state.event_state.stage_delay_ms || 0) - (Date.now() + serverOffsetMs)) / 1000));
      return { key: 'pending', label: `On screen in ${remaining}s` };
    }
    return { key: 'confirmed', label: 'On screen' };
  }

  function filteredAndSorted() {
    const q = searchQuery.trim().toLowerCase();
    const list = donations.filter(d => !q || [d.donor_name, d.display_name, d.notes, d.entered_by, d.card_number, d.table_number].some(value => value && String(value).toLowerCase().includes(q)));
    const direction = sortDirection === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortColumn === 'donor') return direction * a.donor_name.localeCompare(b.donor_name);
      if (sortColumn === 'amount') return direction * (a.amount_cents - b.amount_cents);
      if (sortColumn === 'status') return direction * statusOf(a).key.localeCompare(statusOf(b).key);
      return direction * (a.created_at - b.created_at);
    });
    return list;
  }

  function renderTable() {
    if (!state) return;
    const list = filteredAndSorted();
    const empty = donations.length === 0;
    panelTable.style.display = empty || list.length === 0 ? 'none' : 'block';
    emptyState.style.display = empty || list.length === 0 ? 'block' : 'none';
    if (empty) {
      $('empty-state-title').textContent = 'No donations yet';
      $('empty-state-text').textContent = 'Gifts appear here as they are recorded.';
      $('empty-state-btn').textContent = 'Add first donation';
      $('empty-state-btn').onclick = () => $('btn-open-add').click();
      return;
    }
    if (list.length === 0) {
      $('empty-state-title').textContent = 'No donations match your search';
      $('empty-state-text').textContent = `Nothing matches "${searchQuery}".`;
      $('empty-state-btn').textContent = 'Clear search';
      $('empty-state-btn').onclick = () => { $('manage-search').value = ''; searchQuery = ''; renderTable(); };
      return;
    }

    const existing = new Map(Array.from(tbody.children).map(tr => [tr.dataset.donationId, tr]));
    const keep = new Set(list.map(d => d.donation_id));
    for (const [id, tr] of existing) if (!keep.has(id)) tr.remove();

    let previous = null;
    for (const item of list) {
      let tr = existing.get(item.donation_id);
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.donationId = item.donation_id;
      }
      const status = statusOf(item);
      const anonymous = item.is_anonymous ? '<span class="donation-flag">Anonymous on screen</span>' : '';
      const note = item.notes ? `<div class="donation-note">${fmt.escape(item.notes)}</div>` : '';
      const extras = [item.card_number && `Card ${item.card_number}`, item.table_number && `Table ${item.table_number}`, item.donor_phonetic && `Say: ${item.donor_phonetic}`].filter(Boolean).map(fmt.escape).join(' · ');
      const html = `
        <td><div class="donation-donor">${fmt.escape(item.donor_name)} ${anonymous}</div>${note}<div class="donation-attribution">${fmt.escape(fmt.source(item.source))} · ${fmt.escape(item.entered_by || 'Unknown operator')}${extras ? ' · ' + extras : ''}</div></td>
        <td class="text-right amount-cell">${fmt.money(item.amount_cents)}${item.matched_amount_cents ? `<div class="donation-attribution">+ ${fmt.money(item.matched_amount_cents)} match</div>` : ''}</td>
        <td class="text-center time-cell">${fmt.escape(fmt.time(item.created_at))}</td>
        <td class="text-center"><span class="status-badge ${status.key}">${status.label}</span></td>
        <td class="text-right row-actions">
          <button type="button" class="btn-secondary btn-row" data-edit="${fmt.escape(item.donation_id)}">Edit</button>
          <button type="button" class="btn-delete-row" data-delete="${fmt.escape(item.donation_id)}">Delete</button>
        </td>`;
      if (tr.innerHTML !== html) tr.innerHTML = html;
      const expectedNext = previous ? previous.nextSibling : tbody.firstChild;
      if (tr !== expectedNext) tbody.insertBefore(tr, expectedNext);
      previous = tr;
    }
  }

  tbody.addEventListener('click', event => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const item = donations.find(d => d.donation_id === edit.dataset.edit);
      if (item) window.dispatchEvent(new CustomEvent('givebar:edit-donation', { detail: item }));
      return;
    }
    const del = event.target.closest('[data-delete]');
    if (del) {
      const item = donations.find(d => d.donation_id === del.dataset.delete);
      if (item) promptDelete(item);
    }
  });

  $('manage-search').addEventListener('input', event => { searchQuery = event.target.value; renderTable(); });
  document.querySelectorAll('.donations-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;
      if (sortColumn === column) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      else { sortColumn = column; sortDirection = column === 'amount' || column === 'time' ? 'desc' : 'asc'; }
      for (const key of ['donor', 'amount', 'time', 'status']) {
        const icon = $(`sort-icon-${key}`);
        icon.textContent = sortColumn === key ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅';
        icon.style.color = sortColumn === key ? '#d4a359' : '#555660';
      }
      renderTable();
    });
  });
  setInterval(() => { if (donations.some(d => !d.is_live_on_stage)) renderTable(); }, 1000);

  // --- Pause chart ----------------------------------------------------------
  $('btn-pause-chart').addEventListener('click', async () => {
    if (!state) return;
    const paused = state.stage_preview.is_frozen;
    if (!paused && !window.confirm('Pause the ballroom screen? The figure holds and new gifts stay hidden until you resume.')) return;
    const result = await GivebarSession.control(paused ? 'resume_chart' : 'pause_chart');
    if (!result.ok) window.alert(result.data.message || 'Could not change the chart.');
    channel.refresh();
  });

  // --- Delete and undo ------------------------------------------------------
  function promptDelete(item) {
    pendingDelete = item;
    const live = statusOf(item).key === 'confirmed';
    $('delete-dialog-body').textContent = live
      ? `Delete ${fmt.money(item.amount_cents)} from ${item.donor_name}? It leaves the total and the list. The ballroom figure never rolls backward, so the screen absorbs the difference in later gifts. Restorable from History.`
      : `Delete ${fmt.money(item.amount_cents)} from ${item.donor_name}? It has not reached the ballroom screen yet, so nobody in the room will see it. Restorable from History.`;
    deleteModal.style.display = 'flex';
    $('btn-cancel-delete').focus();
  }
  function closeDelete() {
    deleteModal.style.display = 'none';
    pendingDelete = null;
  }
  $('btn-cancel-delete').addEventListener('click', closeDelete);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && deleteModal.style.display !== 'none') closeDelete(); });
  $('btn-confirm-delete').addEventListener('click', async () => {
    const item = pendingDelete;
    closeDelete();
    if (!item) return;
    const response = await GivebarSession.api(`/api/donation/${item.donation_id}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Deleted from Manage Donations' }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(data.message || 'Could not delete the donation.');
      return;
    }
    lastDeleted = item;
    clearTimeout(undoTimer);
    $('undo-message').textContent = `${fmt.money(item.amount_cents)} from ${item.donor_name} deleted.`;
    undoBanner.style.display = 'flex';
    undoTimer = setTimeout(() => { undoBanner.style.display = 'none'; lastDeleted = null; }, 30000);
    donations = donations.filter(d => d.donation_id !== item.donation_id);
    renderTable();
    channel.refresh();
  });
  $('btn-undo-delete').addEventListener('click', async () => {
    const item = lastDeleted;
    if (!item) return;
    clearTimeout(undoTimer);
    undoBanner.style.display = 'none';
    lastDeleted = null;
    const response = await GivebarSession.api(`/api/donation/${item.donation_id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Undo from Manage Donations' }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(data.message || 'Could not restore the donation.');
    }
    channel.refresh();
  });

  // --- Team notes -----------------------------------------------------------
  let lastNotesKey = '';
  function renderNotes(notes) {
    const key = JSON.stringify(notes.map(n => n.id));
    $('team-notes-count').textContent = String(notes.length);
    if (key === lastNotesKey) return;
    lastNotesKey = key;
    const list = $('team-notes-list');
    list.textContent = '';
    if (notes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'form-hint';
      empty.textContent = 'No notes yet.';
      list.appendChild(empty);
      return;
    }
    const me = state.me;
    for (const note of notes) {
      const row = document.createElement('div');
      row.className = 'team-note';
      const mine = me && (me.role === 'admin' || note.author_id === me.accountId);
      row.innerHTML = `<div class="team-note-meta"><strong>${fmt.escape(note.author_name)}</strong> · ${fmt.escape(fmt.time(note.created_at))}${mine ? ` <button type="button" class="btn-ghost team-note-delete" data-note="${note.id}">Remove</button>` : ''}</div><div class="team-note-body">${fmt.escape(note.body)}</div>`;
      list.appendChild(row);
    }
  }
  $('team-notes-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-note]');
    if (!button || !window.confirm('Remove this note for everyone?')) return;
    const result = await GivebarSession.control('delete_team_note', { id: Number(button.dataset.note) });
    if (!result.ok) window.alert(result.data.message || 'Could not remove the note.');
    channel.refresh();
  });
  $('team-note-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('team-note-input');
    const body = input.value.trim();
    if (!body) { input.focus(); return; }
    const result = await GivebarSession.control('add_team_note', { body });
    if (!result.ok) { window.alert(result.data.message || 'Could not post the note.'); return; }
    input.value = '';
    channel.refresh();
  });
})();
