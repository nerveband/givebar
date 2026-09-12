/**
 * Givebar Team and backups (administrators).
 * Accounts, one-time sign-in links, email invites, PIN resets, and database snapshots.
 * Every destructive step goes through the shared confirmation dialog.
 */
(function () {
  'use strict';

  const fmt = GivebarSession.format;
  const $ = id => document.getElementById(id);
  const inviteDialog = $('invite-dialog');
  const linkDialog = $('link-dialog');

  // --- Accounts -------------------------------------------------------------
  async function loadOperators() {
    const tbody = $('operator-tbody');
    const result = await GivebarSession.control('list_accounts');
    if (!result.ok) {
      tbody.innerHTML = `<tr><td colspan="5">${fmt.escape(result.data.message || 'Could not load operators.')}</td></tr>`;
      return;
    }
    tbody.innerHTML = result.data.accounts.map(account => `<tr>
      <td>${fmt.escape(account.username)}</td>
      <td>${fmt.escape(account.display_name)}</td>
      <td>${account.role === 'admin' ? 'Administrator' : 'Operator'}</td>
      <td>${account.disabled ? '<span class="status-badge held">Disabled</span>' : '<span class="status-badge confirmed">Active</span>'}</td>
      <td class="row-actions text-right">
        <button type="button" class="btn-secondary btn-row" data-link="${account.id}" data-name="${fmt.escape(account.display_name)}" ${account.disabled ? 'disabled' : ''}>Sign-in link</button>
        <button type="button" class="btn-secondary btn-row" data-invite="${account.id}" data-name="${fmt.escape(account.display_name)}" ${account.disabled ? 'disabled' : ''}>Email invite</button>
        <button type="button" class="btn-secondary btn-row" data-reset-pin="${account.id}" data-name="${fmt.escape(account.display_name)}">Reset PIN</button>
        <button type="button" class="btn-secondary btn-row" data-disable="${account.id}" data-name="${fmt.escape(account.display_name)}" data-disabled="${account.disabled ? 0 : 1}">${account.disabled ? 'Enable' : 'Disable'}</button>
      </td></tr>`).join('');
  }

  $('operator-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = $('operator-error');
    error.textContent = '';
    error.removeAttribute('data-tone');
    const displayName = $('operator-display').value.trim();
    const result = await GivebarSession.control('create_account', {
      username: $('operator-username').value,
      displayName,
      pin: $('operator-pin').value,
      role: $('operator-role').value
    });
    if (!result.ok) { error.textContent = result.data.message || 'Could not create the account.'; return; }
    error.dataset.tone = 'ok';
    error.textContent = `Account created for ${displayName}. Tell them the name and PIN, or use Sign-in link or Email invite on their row.`;
    $('operator-form').reset();
    await loadOperators();
  });

  $('operator-tbody').addEventListener('click', async event => {
    const button = event.target.closest('button[data-link], button[data-invite], button[data-reset-pin], button[data-disable]');
    if (!button) return;
    const name = button.dataset.name;

    if (button.dataset.link) {
      const result = await GivebarSession.control('create_invite_link', { id: button.dataset.link });
      if (!result.ok) { GivebarSession.toast(result.data.message || 'Could not create the link.', 'error'); return; }
      $('link-dialog-title').textContent = `Sign-in link for ${name}`;
      $('link-dialog-body').textContent = `Works once, expires ${fmt.time(result.data.expires_at)}. Whoever opens it is signed in as ${result.data.display_name} (sign-in name ${result.data.username}) and can set a PIN. Send it by text or chat; do not post it anywhere public.`;
      $('link-value').value = result.data.link;
      $('btn-copy-link').dataset.copyText = result.data.link;
      linkDialog.showModal();
      $('link-value').select();
      return;
    }
    if (button.dataset.invite) {
      $('invite-account-id').value = button.dataset.invite;
      $('invite-dialog-title').textContent = `Email invite to ${name}`;
      $('invite-email').value = '';
      $('invite-result').hidden = true;
      $('invite-error').textContent = '';
      inviteDialog.showModal();
      $('invite-email').focus();
      return;
    }
    if (button.dataset.resetPin) {
      const pin = await GivebarSession.prompt({
        title: `New PIN for ${name}`,
        body: 'Their current session ends and they sign in again with this PIN. Tell them in person or by phone.',
        label: 'New PIN (4 to 12 characters)', type: 'password', inputMode: 'numeric', confirmLabel: 'Set PIN',
        validate: value => value.length >= 4 && value.length <= 12 ? '' : 'PIN must be 4 to 12 characters.'
      });
      if (pin === null) return;
      const result = await GivebarSession.control('update_account', { id: button.dataset.resetPin, pin });
      GivebarSession.toast(result.ok ? `PIN updated for ${name}.` : (result.data.message || 'Could not update the PIN.'), result.ok ? 'ok' : 'error');
      return;
    }
    if (button.dataset.disable) {
      const disabling = button.dataset.disabled === '1';
      if (disabling && !(await GivebarSession.confirm({ title: `Disable ${name}?`, body: 'Their session ends immediately and they cannot sign in until re-enabled. Their past entries stay in the ledger.', confirmLabel: 'Disable account', danger: true }))) return;
      const result = await GivebarSession.control('update_account', { id: button.dataset.disable, disabled: disabling });
      if (!result.ok) GivebarSession.toast(result.data.message || 'Could not update the account.', 'error');
      else GivebarSession.toast(disabling ? `${name} disabled.` : `${name} enabled.`);
      await loadOperators();
    }
  });

  $('invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = $('invite-error');
    const button = $('btn-send-invite');
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const result = await GivebarSession.control('send_invite', { id: $('invite-account-id').value, email: $('invite-email').value });
      if (!result.ok) { error.textContent = result.data.message || 'Could not send the invite.'; return; }
      $('invite-result').hidden = false;
      $('invite-link').value = result.data.link;
      $('btn-copy-invite').dataset.copyText = result.data.link;
    } finally {
      button.disabled = false;
      button.textContent = 'Send invite email';
    }
  });
  $('btn-close-invite').addEventListener('click', () => inviteDialog.close());
  $('btn-close-link').addEventListener('click', () => linkDialog.close());

  // --- Backups --------------------------------------------------------------
  async function loadBackups() {
    const list = $('backup-list');
    const result = await GivebarSession.control('list_backups');
    if (!result.ok) { list.innerHTML = `<p class="form-hint">${fmt.escape(result.data.message || 'Backups unavailable.')}</p>`; return; }
    const backups = result.data.backups;
    $('backup-summary').textContent = backups.length
      ? `${backups.length} snapshots on the server. Latest: ${fmt.time(backups[0].created_at)} (${backups[0].label}). Automatic snapshots run every 5 minutes whenever anything changed.`
      : 'No snapshots yet. Automatic snapshots run every 5 minutes whenever anything changed.';
    list.innerHTML = backups.slice(0, 40).map(item => `<div class="backup-row">
      <span>${fmt.escape(fmt.time(item.created_at))}</span>
      <span class="backup-meta">${fmt.escape(item.label)} · ${Math.round(item.bytes / 1024)} KB</span>
      <span class="backup-actions">
        <a class="btn-secondary" href="/api/export/backup?name=${encodeURIComponent(item.name)}">Download</a>
        <button type="button" class="btn-secondary" data-restore="${fmt.escape(item.name)}" data-when="${fmt.escape(fmt.time(item.created_at))}">Restore</button>
      </span></div>`).join('');
  }

  $('btn-backup-now').addEventListener('click', async () => {
    const result = await GivebarSession.control('create_backup');
    GivebarSession.toast(result.ok ? 'Snapshot saved.' : (result.data.message || 'Backup failed.'), result.ok ? 'ok' : 'error');
    await loadBackups();
  });

  $('backup-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-restore]');
    if (!button) return;
    const typed = await GivebarSession.prompt({
      title: `Restore the snapshot from ${button.dataset.when}?`,
      body: 'Every gift, setting, and team note goes back to that moment. Anything recorded since is removed from the ledger (a pre-restore snapshot is taken first, so nothing is lost for good). Operator accounts and sessions stay as they are.',
      label: 'Type RESTORE to continue', placeholder: 'RESTORE', confirmLabel: 'Restore snapshot', danger: true,
      validate: value => value === 'RESTORE' ? '' : 'Type RESTORE exactly to continue.'
    });
    if (typed !== 'RESTORE') return;
    button.disabled = true;
    const result = await GivebarSession.control('restore_backup', { name: button.dataset.restore, confirm: 'RESTORE' });
    if (!result.ok) { GivebarSession.toast(result.data.message || 'Restore failed.', 'error'); button.disabled = false; return; }
    GivebarSession.toast(`Restored. A pre-restore snapshot was saved as ${result.data.pre_restore.name}.`);
    await loadBackups();
  });

  loadOperators();
  loadBackups();
})();
