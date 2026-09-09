(() => {
  const input = document.getElementById('live-stage-message');
  const list = document.getElementById('impact-message-list');
  const status = document.getElementById('stage-message-status');
  const controls = document.querySelector('.stage-message-controls');
  let messageDirty = false;
  let rotationDirty = false;
  let busy = false;
  let lastMessages = '';
  function addPoint(text = '') {
    const row = document.createElement('div'); row.className = 'impact-message-row';
    const field = document.createElement('input'); field.className = 'form-input-text'; field.maxLength = 160;
    field.setAttribute('aria-label', 'Impact message'); field.value = text;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-secondary'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { row.remove(); rotationDirty = true; });
    field.addEventListener('input', () => { rotationDirty = true; });
    row.append(field, remove); list.append(row); return field;
  }
  input.addEventListener('input', () => { messageDirty = true; });
  window.addEventListener('givebar:control-state', event => {
    const state = event.detail.event_state;
    if (!messageDirty) input.value = state.stage_message || '';
    if (!rotationDirty && lastMessages !== state.impact_messages) {
      list.replaceChildren(); JSON.parse(state.impact_messages || '[]').forEach(addPoint); lastMessages = state.impact_messages;
    }
    if (!busy) status.textContent = state.stage_message_visible ? 'Live announcement is showing on the ballroom screen.' : 'Impact rotation is active. An empty list leaves the message area blank.';
  });
  async function save(patch, success) {
    if (busy) return;
    busy = true; controls.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = 'Updating ballroom screen…';
    try {
      const response = await GivebarSession.api('/api/control', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'update_settings',...patch})});
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'The screen was not updated. Try again.');
      if (patch.stage_message !== undefined) messageDirty = false;
      if (patch.impact_messages !== undefined) rotationDirty = false;
      status.textContent = success; status.style.color = '#86efac';
    } catch (error) { status.textContent = error.message; status.style.color = '#fca5a5'; }
    finally { busy = false; controls.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  document.getElementById('publish-stage-message').addEventListener('click', () => {
    if (!input.value.trim()) { status.textContent = 'Enter a message before showing it.'; input.focus(); return; }
    save({stage_message:input.value.trim(),stage_message_visible:true}, 'Message sent to the ballroom screen.');
  });
  document.getElementById('hide-stage-message').addEventListener('click', () => save({stage_message_visible:false}, 'Returned to impact messages.'));
  document.getElementById('add-impact-message').addEventListener('click', () => {
    if (list.children.length >= 12) { status.textContent = 'Use up to 12 impact messages.'; return; }
    rotationDirty = true; addPoint().focus();
  });
  document.getElementById('save-impact-messages').addEventListener('click', () => save({impact_messages:[...list.querySelectorAll('input')].map(field => field.value.trim()).filter(Boolean)}, 'Impact rotation saved.'));
})();
