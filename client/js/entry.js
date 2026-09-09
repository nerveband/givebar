(() => {
  'use strict';
  const dialog = document.getElementById('add-donation-dialog');
  const form = document.getElementById('add-donation-form');
  const open = document.getElementById('btn-open-add');
  const close = document.getElementById('btn-close-add');
  const amount = document.getElementById('amount-numeric-input');
  const donor = document.getElementById('donor-name-input');
  const anonymous = document.getElementById('donation-anonymous');
  const submit = document.getElementById('btn-submit-add');
  const error = document.getElementById('add-error-banner');
  const confirmation = document.getElementById('major-gift-confirmation');
  const confirmed = document.getElementById('major-gift-confirmed');
  const status = document.getElementById('add-donation-status');
  const outboxStatus = document.getElementById('outbox-status');
  let threshold = 950000;
  let pending = false;
  let flushing = false;
  let outbox = JSON.parse(localStorage.getItem('givebar_outbox') || '[]');
  const currency = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2});
  const money = cents => currency.format(cents / 100);
  const headers = () => ({'Content-Type':'application/json'});
  function showError(text, field) {
    error.textContent = text;
    error.hidden = false;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', error.id); field.focus(); }
  }
  function announce(text) { status.textContent = text; status.hidden = false; }
  function saveOutbox() {
    localStorage.setItem('givebar_outbox', JSON.stringify(outbox));
    document.getElementById('outbox-count').textContent = outbox.length;
    outboxStatus.hidden = !outbox.length;
  }
  async function loadSettings() {
    try {
      const response = await GivebarSession.api('/api/state?role=entry');
      if (!response.ok) return;
      const data = await response.json();
      const settings = data;
      threshold = settings.major_gift_threshold_cents || 950000;
      document.getElementById('field-card-number-wrap').hidden = !settings.feature_card_number;
      document.getElementById('field-table-number-wrap').hidden = !settings.feature_table_number;
      const grid = document.getElementById('preset-grid');
      grid.replaceChildren(...(data.ask_tiers || []).map(tier => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn-secondary'; button.textContent = money(tier.cents);
        button.addEventListener('click', () => { amount.value = (tier.cents / 100).toLocaleString('en-US'); confirmed.checked = false; confirmation.hidden = true; amount.focus(); });
        return button;
      }));
    } catch (_) { /* Server still enforces the major-gift threshold. */ }
  }
  open.addEventListener('click', () => { dialog.showModal(); donor.focus(); loadSettings(); });
  close.addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => open.focus());
  form.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
    error.hidden = true;
    if (event.target !== confirmed) { confirmed.checked = false; confirmation.hidden = true; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    error.hidden = true;
    const raw = amount.value.trim().replace(/^\$/, '');
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return showError('Enter a dollar amount, such as 1,500 or 1,500.50.', amount);
    const cents = Math.round(Number(raw.replaceAll(',', '')) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) return showError('Enter an amount greater than zero.', amount);
    if (!donor.value.trim()) return showError('Enter the donor name, including for an anonymous gift.', donor);
    if (cents >= threshold && !confirmed.checked) {
      document.getElementById('guardrail-body').textContent = `${money(cents)} from ${donor.value.trim()}. Check for an extra zero before recording.`;
      confirmation.hidden = false; confirmed.focus(); return;
    }
    const payload = {
      donation_id: crypto.randomUUID(), amount_cents: cents, donor_name: donor.value.trim(),
      is_anonymous: anonymous.checked, source: 'manual', payment_method: 'pledge', entered_by: GivebarOperator.actor(),
      donor_phonetic: document.getElementById('donor-phonetic-input').value.trim(),
      card_number: document.getElementById('field-card-number-wrap').hidden ? undefined : document.getElementById('card-number-input').value.trim(),
      table_number: document.getElementById('field-table-number-wrap').hidden ? undefined : document.getElementById('table-number-input').value.trim(),
      confirmed_major_gift: confirmed.checked
    };
    pending = true;
    form.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
    submit.textContent = 'Recording…';
    try {
      const response = await GivebarSession.api(`/api/donation/${payload.donation_id}`, {method:'PUT',headers:headers(),body:JSON.stringify(payload)});
      const result = await response.json();
      if (response.status === 428) {
        threshold = result.threshold_cents; confirmed.checked = false;
        document.getElementById('guardrail-body').textContent = `${money(cents)} from ${payload.donor_name}. Check the amount.`;
        confirmation.hidden = false; confirmed.focus(); return;
      }
      if (response.status === 409) {
        showError(`Card ${result.card_number} is already recorded for ${result.prior_donor_name} (${money(result.prior_amount_cents)}), entered by ${result.prior_entered_by || 'another operator'}. Your draft has been kept.`, document.getElementById('card-number-input'));
        return;
      }
      if (!response.ok && response.status < 500) { showError(result.message || result.error || 'Donation was not recorded. Your draft has been kept.'); return; }
      if (!response.ok) throw new Error('Temporary server error');
      announce(`${money(cents)} from ${payload.donor_name} recorded. Use Delete in the table to undo an entry.`);
      form.reset(); confirmation.hidden = true; dialog.close();
      window.dispatchEvent(new Event('givebar:donation-recorded'));
    } catch (_) {
      // Keep the exact identifier so a lost response can never create a second gift.
      outbox.push(payload); saveOutbox();
      announce(`${money(cents)} from ${payload.donor_name} is waiting to sync—not yet confirmed. Do not enter it again.`);
      form.reset(); confirmation.hidden = true; dialog.close();
    } finally {
      pending = false;
      form.querySelectorAll('input, button').forEach(control => { control.disabled = false; });
      submit.textContent = 'Record donation';
      if (!error.hidden) form.querySelector('[aria-invalid="true"]')?.focus();
      else if (!confirmation.hidden) confirmed.focus();
    }
  });
  async function flushOutbox() {
    if (flushing || !outbox.length || !navigator.onLine) return;
    flushing = true;
    try {
      for (const payload of [...outbox]) {
        const response = await GivebarSession.api(`/api/donation/${payload.donation_id}`, {method:'PUT',headers:headers(),body:JSON.stringify(payload)});
        if (!response.ok) {
          const result = await response.json();
          announce(`Waiting gift for ${payload.donor_name}: ${result.message || result.error || 'Sync unavailable'}. The gift is retained in this browser.`);
          break;
        }
        outbox = outbox.filter(item => item.donation_id !== payload.donation_id); saveOutbox();
        announce(`${money(payload.amount_cents)} from ${payload.donor_name} synced successfully.`);
        window.dispatchEvent(new Event('givebar:donation-recorded'));
      }
    } catch (_) { /* Retain pending gifts until the connection recovers. */ }
    finally { flushing = false; }
  }
  document.getElementById('btn-retry-outbox').addEventListener('click', flushOutbox);
  saveOutbox(); flushOutbox(); setInterval(flushOutbox, 3000);
})();
