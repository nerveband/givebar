/**
 * Givebar donation dialog: add a new gift or edit an existing one.
 *
 * Safety rails, all enforced by the server and mirrored here so the operator
 * sees them before the round trip: major-gift confirmation, the possible-
 * duplicate check (same donor and amount within minutes), and the physical
 * card-number collision. A new gift keeps its client-minted id, so a lost
 * response can be retried without ever creating a second gift; while the
 * network is down the gift waits in a local outbox and is sent later.
 */
(() => {
  'use strict';
  const fmt = GivebarSession.format;
  const $ = id => document.getElementById(id);
  const dialog = $('add-donation-dialog');
  const form = $('add-donation-form');
  const amount = $('amount-numeric-input');
  const donor = $('donor-name-input');
  const anonymous = $('donation-anonymous');
  const notes = $('donation-notes-input');
  const submit = $('btn-submit-add');
  const error = $('add-error-banner');
  const majorBox = $('major-gift-confirmation');
  const majorConfirmed = $('major-gift-confirmed');
  const duplicateBox = $('duplicate-confirmation');
  const duplicateConfirmed = $('duplicate-confirmed');
  const status = $('add-donation-status');
  const outboxStatus = $('outbox-status');

  let threshold = 950000;
  let stageDelayMs = 8000;
  let pending = false;
  let flushing = false;
  let editing = null;
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');
  const headers = { 'Content-Type': 'application/json' };

  function showError(text, field) {
    error.textContent = text;
    error.hidden = false;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  function announce(text) { status.textContent = text; status.hidden = false; }
  function resetConfirmations() {
    majorConfirmed.checked = false; majorBox.hidden = true;
    duplicateConfirmed.checked = false; duplicateBox.hidden = true;
  }
  function saveOutbox() {
    localStorage.setItem('givebar_outbox', JSON.stringify(outbox));
    $('outbox-count').textContent = outbox.length;
    outboxStatus.hidden = !outbox.length;
  }

  async function loadSettings() {
    try {
      const response = await GivebarSession.api('/api/state?role=entry');
      if (!response.ok) return;
      const data = await response.json();
      threshold = data.major_gift_threshold_cents;
      stageDelayMs = data.stage_delay_ms;
      $('field-card-number-wrap').hidden = !data.feature_card_number;
      $('field-table-number-wrap').hidden = !data.feature_table_number;
      $('preset-grid').replaceChildren(...data.ask_tiers.map(tier => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn-secondary'; button.textContent = fmt.money(tier.cents);
        button.addEventListener('click', () => { amount.value = (tier.cents / 100).toLocaleString('en-US'); resetConfirmations(); amount.focus(); });
        return button;
      }));
    } catch (_) { /* Server still enforces every rail. */ }
  }

  function open(item) {
    editing = item || null;
    form.reset();
    resetConfirmations();
    error.hidden = true;
    $('add-dialog-title').textContent = item ? 'Edit donation' : 'Add donation';
    $('add-dialog-intro').textContent = item
      ? 'Corrections apply immediately. A lower amount never rolls the ballroom figure backward; the screen absorbs the difference in later gifts.'
      : 'Record a pledge or offline gift. Online gifts are imported automatically; do not enter them again.';
    submit.textContent = item ? 'Save changes' : 'Record donation';
    if (item) {
      donor.value = item.donor_name;
      amount.value = (item.amount_cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
      anonymous.checked = item.is_anonymous;
      notes.value = item.notes || '';
      $('donor-phonetic-input').value = item.donor_phonetic || '';
      $('card-number-input').value = (item.card_number || '').replace(/^#/, '');
      $('table-number-input').value = item.table_number || '';
    } else {
      amount.value = '';
    }
    dialog.showModal();
    donor.focus();
    loadSettings();
  }

  $('btn-open-add').addEventListener('click', () => open(null));
  window.addEventListener('givebar:edit-donation', event => open(event.detail));
  $('btn-close-add').addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => { editing = null; $('btn-open-add').focus(); });
  form.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
    error.hidden = true;
    if (event.target !== majorConfirmed && event.target !== duplicateConfirmed) resetConfirmations();
  });

  function parseAmount() {
    const raw = amount.value.trim().replace(/^\$/, '');
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
    const cents = Math.round(Number(raw.replaceAll(',', '')) * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function collect(cents) {
    return {
      amount_cents: cents,
      donor_name: donor.value.trim(),
      is_anonymous: anonymous.checked,
      notes: notes.value.trim(),
      donor_phonetic: $('donor-phonetic-input').value.trim(),
      card_number: $('field-card-number-wrap').hidden ? undefined : $('card-number-input').value.trim(),
      table_number: $('field-table-number-wrap').hidden ? undefined : $('table-number-input').value.trim(),
      confirmed_major_gift: majorConfirmed.checked,
      confirmed_duplicate: duplicateConfirmed.checked
    };
  }

  /** Shows the server's objection inline. Returns true when the form should stay open. */
  function handleRail(response, result, cents) {
    if (response.status === 428) {
      threshold = result.threshold_cents;
      $('guardrail-body').textContent = `${fmt.money(cents)} from ${donor.value.trim()}. Check for an extra zero before recording.`;
      majorConfirmed.checked = false; majorBox.hidden = false; majorConfirmed.focus();
      return true;
    }
    if (response.status === 409 && result.error === 'POSSIBLE_DUPLICATE') {
      $('duplicate-body').textContent = `${fmt.money(result.prior_amount_cents)} from ${result.prior_donor_name} was recorded at ${fmt.time(result.prior_created_at)} by ${result.prior_entered_by || 'another operator'}. If this is the same gift, close this form; it is already counted.`;
      duplicateConfirmed.checked = false; duplicateBox.hidden = false; duplicateConfirmed.focus();
      return true;
    }
    if (response.status === 409) {
      showError(`Card ${result.card_number} is already recorded for ${result.prior_donor_name} (${fmt.money(result.prior_amount_cents)}), entered by ${result.prior_entered_by || 'another operator'}. Your draft has been kept.`, $('card-number-input'));
      return true;
    }
    if (!response.ok && response.status < 500) {
      showError(result.message || result.error || 'The donation was not saved. Your draft has been kept.');
      return true;
    }
    return false;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    error.hidden = true;
    const cents = parseAmount();
    if (cents === null) return showError('Enter a dollar amount, such as 1,500 or 1,500.50.', amount);
    if (!donor.value.trim()) return showError('Enter the donor name, including for an anonymous gift.', donor);
    const changedAmount = !editing || editing.amount_cents !== cents;
    if (changedAmount && cents >= threshold && !majorConfirmed.checked) {
      $('guardrail-body').textContent = `${fmt.money(cents)} from ${donor.value.trim()}. Check for an extra zero before recording.`;
      majorBox.hidden = false; majorConfirmed.focus(); return;
    }
    const payload = collect(cents);
    pending = true;
    form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
    submit.textContent = editing ? 'Saving…' : 'Recording…';
    try {
      if (editing) {
        const response = await GivebarSession.api(`/api/donation/${editing.donation_id}/amend`, { method: 'POST', headers, body: JSON.stringify(payload) });
        const result = await response.json();
        if (handleRail(response, result, cents)) return;
        if (!response.ok) throw new Error('Temporary server error');
        announce(`${payload.donor_name}: changes saved.`);
        dialog.close();
        window.dispatchEvent(new Event('givebar:donation-recorded'));
        return;
      }
      const donationId = crypto.randomUUID();
      const response = await GivebarSession.api(`/api/donation/${donationId}`, { method: 'PUT', headers, body: JSON.stringify(payload) });
      const result = await response.json();
      if (handleRail(response, result, cents)) return;
      if (!response.ok) throw new Error('Temporary server error');
      announce(`${fmt.money(cents)} from ${payload.donor_name} recorded. It reaches the ballroom screen in ${Math.round(stageDelayMs / 1000)} seconds; use Delete in the table before then if it is wrong.`);
      dialog.close();
      window.dispatchEvent(new Event('givebar:donation-recorded'));
    } catch (_) {
      if (editing) {
        showError('The server could not be reached. Your changes were not saved; try again in a moment.');
        return;
      }
      // Keep the exact identifier so a lost response can never create a second gift.
      outbox.push({ donation_id: crypto.randomUUID(), ...payload, confirmed_duplicate: true });
      saveOutbox();
      announce(`${fmt.money(cents)} from ${payload.donor_name} is waiting to sync and is not yet counted. Do not enter it again.`);
      dialog.close();
    } finally {
      pending = false;
      form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = false; });
      submit.textContent = editing ? 'Save changes' : 'Record donation';
      if (!error.hidden) form.querySelector('[aria-invalid="true"]')?.focus();
      else if (!majorBox.hidden) majorConfirmed.focus();
      else if (!duplicateBox.hidden) duplicateConfirmed.focus();
    }
  });

  async function flushOutbox() {
    if (flushing || !outbox.length || !navigator.onLine) return;
    flushing = true;
    try {
      for (const payload of [...outbox]) {
        const response = await GivebarSession.api(`/api/donation/${payload.donation_id}`, { method: 'PUT', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          announce(`Waiting gift for ${payload.donor_name}: ${result.message || result.error || 'sync unavailable'}. It stays saved in this browser.`);
          break;
        }
        outbox = outbox.filter(item => item.donation_id !== payload.donation_id);
        saveOutbox();
        announce(`${fmt.money(payload.amount_cents)} from ${payload.donor_name} synced.`);
        window.dispatchEvent(new Event('givebar:donation-recorded'));
      }
    } catch (_) { /* Retain pending gifts until the connection recovers. */ }
    finally { flushing = false; }
  }
  $('btn-retry-outbox').addEventListener('click', flushOutbox);
  $('btn-discard-outbox').addEventListener('click', () => {
    if (!outbox.length || !window.confirm(`Discard ${outbox.length} waiting gift(s)? They were never counted and will need to be entered again if they are real.`)) return;
    outbox = [];
    saveOutbox();
    announce('Waiting gifts discarded.');
  });
  window.addEventListener('online', flushOutbox);
  saveOutbox();
  flushOutbox();
  setInterval(flushOutbox, 3000);
})();
