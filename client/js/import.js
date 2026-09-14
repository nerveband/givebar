/**
 * Givebar bulk import: paste or upload a list of pledges, check it in a
 * spreadsheet grid, and record every ready row as an ordinary manual gift.
 *
 * Every row is sent through the same PUT /api/donation/:id the single-gift
 * dialog uses, with an id minted the first time the row is checked, so the
 * server applies every guard per row (amount bounds, major-gift confirmation,
 * possible duplicate, card collision) and a re-run after a lost connection
 * never records a gift twice. Nothing about the ledger, staging delay, or
 * privacy rules changes: a recorded row is a normal manual gift.
 *
 * The sheet is saved in this browser (localStorage) after every change so a
 * reload mid-import keeps the rows, their ids, and which ones are recorded.
 */
(async () => {
  'use strict';
  if (!(await GivebarSession.whoami()).authenticated) return;
  const fmt = GivebarSession.format;
  const $ = id => document.getElementById(id);
  const headers = { 'Content-Type': 'application/json' };
  const DRAFT_KEY = 'givebar_import_draft';

  const COL = { id: 0, name: 1, amount: 2, anonymous: 3, phonetic: 4, table: 5, card: 6, note: 7, confirm: 8, status: 9 };
  const FIELD_COLS = [COL.name, COL.amount, COL.anonymous, COL.phonetic, COL.table, COL.card, COL.note];

  let threshold = 950000;
  let stageDelayMs = 8000;
  let cardFeature = true;
  let tableFeature = true;
  let running = false;
  let refreshing = false;
  /** id -> { donation_id, recorded, needs: string[], problem?, duplicateText? } */
  const meta = new Map();

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // --- Parsing --------------------------------------------------------------

  /** Splits delimited text (tab from a spreadsheet, comma or semicolon from a CSV) honouring quoted cells. */
  function parseDelimited(text, forcedDelimiter) {
    const firstLine = text.slice(0, text.search(/\r?\n|$/));
    const delimiter = forcedDelimiter || (firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ','));
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"' && cell === '') { quoted = true; continue; }
      if (ch === delimiter) { row.push(cell); cell = ''; continue; }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
        continue;
      }
      cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
  }

  function parseAmount(value) {
    const raw = String(value ?? '').trim().replace(/^\$\s*/, '').replace(/,/g, '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    const cents = Math.round(Number(raw) * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function parseFlag(value) {
    if (typeof value === 'boolean') return value;
    return /^(?:y|yes|true|1|x|anon|anonymous)$/i.test(String(value ?? '').trim());
  }

  const HEADER_MATCHERS = [
    ['first', /^(?:first|firstname|givenname)$/],
    ['last', /^(?:last|lastname|surname|familyname)$/],
    ['name', /^(?:donor|donorname|name|fullname|donors|supporter|guest|pledgedby|from)$/],
    ['amount', /^(?:amount|amt|gift|giftamount|pledge|pledgeamount|donation|donationamount|total|amountusd|usd|dollars|value)$/],
    ['anonymous', /^(?:anonymous|anon|isanonymous|private)$/],
    ['phonetic', /^(?:pronunciation|phonetic|howtosayit|sayit|pronounce)$/],
    ['table', /^(?:table|tableno|tablenumber|tbl)$/],
    ['card', /^(?:card|cardno|cardnumber|paddle|paddleno|paddlenumber|bidder|bidderno|biddernumber|serial)$/],
    ['note', /^(?:note|notes|comment|comments|memo|teamnote|remarks)$/]
  ];
  function headerField(cell) {
    const key = String(cell).toLowerCase().replace(/[^a-z]/g, '');
    if (!key) return null;
    const hit = HEADER_MATCHERS.find(([, pattern]) => pattern.test(key));
    return hit ? hit[0] : null;
  }
  /** A header row names at least the amount or donor column and carries no amount of its own. */
  function detectHeader(rows) {
    if (!rows.length) return null;
    const fields = rows[0].map(headerField);
    const named = fields.filter(Boolean);
    if (!named.includes('amount') && !named.includes('name') && !(named.includes('first') && named.includes('last'))) return null;
    if (rows[0].some(cell => parseAmount(cell) !== null)) return null;
    return fields;
  }

  function blankRow() { return ['', '', '', false, '', '', '', '', false, '']; }
  function blankRows(count) { return Array.from({ length: count }, blankRow); }

  /** Converts parsed text into sheet rows, matching columns by header when one is present. */
  function toSheetRows(rows) {
    const fields = detectHeader(rows);
    const body = fields ? rows.slice(1) : rows;
    const ignored = fields ? rows[0].filter((cell, i) => cell && !fields[i]) : [];
    const pick = (row, field) => { const i = fields.indexOf(field); return i === -1 ? '' : (row[i] ?? ''); };
    const sheetRows = body.map(row => {
      const out = blankRow();
      out[COL.id] = newId();
      if (fields) {
        const first = pick(row, 'first'); const last = pick(row, 'last');
        out[COL.name] = pick(row, 'name') || [first, last].filter(Boolean).join(' ');
        out[COL.amount] = pick(row, 'amount');
        out[COL.anonymous] = parseFlag(pick(row, 'anonymous'));
        out[COL.phonetic] = pick(row, 'phonetic');
        out[COL.table] = pick(row, 'table');
        out[COL.card] = pick(row, 'card');
        out[COL.note] = pick(row, 'note');
      } else {
        out[COL.name] = row[0] ?? '';
        out[COL.amount] = row[1] ?? '';
        out[COL.anonymous] = parseFlag(row[2]);
        out[COL.phonetic] = row[3] ?? '';
        out[COL.table] = row[4] ?? '';
        out[COL.card] = row[5] ?? '';
        out[COL.note] = row[6] ?? '';
      }
      return out;
    });
    return { sheetRows, header: Boolean(fields), ignored };
  }

  // --- Grid -----------------------------------------------------------------

  const intakeStatus = $('intake-status');
  const importStatus = $('import-status');
  const summary = $('sheet-summary');
  const importButton = $('btn-import');

  function say(el, text) { el.textContent = text; el.hidden = false; }

  const sheet = jspreadsheet($('sheet'), {
    data: blankRows(8),
    columns: [
      { type: 'hidden', title: 'id' },
      { type: 'text', title: 'Donor name', width: 220 },
      { type: 'text', title: 'Amount ($)', width: 120, align: 'right' },
      { type: 'checkbox', title: 'Anonymous', width: 100 },
      { type: 'text', title: 'Pronunciation', width: 160 },
      { type: 'text', title: 'Table', width: 80 },
      { type: 'text', title: 'Card number', width: 110 },
      { type: 'text', title: 'Note for the team', width: 240 },
      { type: 'checkbox', title: 'Confirm', width: 90 },
      { type: 'text', title: 'Status', width: 340, readOnly: true }
    ],
    defaultColAlign: 'left',
    minDimensions: [10, 8],
    tableOverflow: true,
    tableWidth: '100%',
    tableHeight: '60vh',
    parseFormulas: false,
    autoCasting: false,
    columnSorting: false,
    columnDrag: false,
    columnResize: true,
    rowDrag: false,
    allowInsertColumn: false,
    allowManualInsertColumn: false,
    allowDeleteColumn: false,
    allowRenameColumn: false,
    allowDeletingAllRows: true,
    allowComments: false,
    allowExport: false,
    contextMenu(instance, x, y) {
      if (y === null || y === undefined) return [];
      const rowIndex = Number(y);
      return [
        { title: 'Insert a row above', onclick: () => instance.insertRow(1, rowIndex, true) },
        { title: 'Insert a row below', onclick: () => instance.insertRow(1, rowIndex) },
        { type: 'line' },
        { title: 'Delete selected rows', onclick: () => instance.deleteRow() }
      ];
    },
    // Event handlers receive the container element; the instance hangs off it as el.jexcel.
    onbeforepaste(el, data, x) {
      const startColumn = Number(x);
      const rows = parseDelimited(String(data), '\t');
      // A paste that carries a header row is matched by column name instead of position.
      if (startColumn === COL.name && detectHeader(rows)) {
        addRows(rows, 'pasted into the sheet');
        return false;
      }
      // Otherwise the grid fills cells positionally; "yes"/"x" in a checkbox column must arrive as true/false.
      const quote = cell => /[\t\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
      return rows.map(row => row.map((cell, j) => {
        const column = startColumn + j;
        return column === COL.anonymous || column === COL.confirm ? String(parseFlag(cell)) : quote(cell);
      }).join('\t')).join('\n');
    },
    onbeforedeleterow(el, rowIndex, count) {
      for (let y = rowIndex; y < rowIndex + count; y++) {
        const info = meta.get(el.jexcel.options.data[y]?.[COL.id]);
        if (info?.recorded) { say(importStatus, 'Recorded rows stay in the sheet as a record of what was sent. Use Start over to clear them.'); return false; }
      }
      return true;
    },
    onbeforechange(el, cell, x, y, value) {
      // An edit to a held row clears the server's last objection so the row is tried again.
      const row = el.jexcel.options.data[y];
      const info = row && meta.get(row[COL.id]);
      if (info && !info.recorded && Number(x) !== COL.confirm && Number(x) !== COL.status) info.problem = undefined;
      return value;
    },
    onafterchanges() { if (!refreshing) refresh(); },
    onpaste() { if (!refreshing) refresh(); },
    oninsertrow() { if (!refreshing) { applyColumnVisibility(); refresh(); } },
    ondeleterow() { if (!refreshing) refresh(); },
    onundo() { if (!refreshing) refresh(); },
    onredo() { if (!refreshing) refresh(); }
  });

  function isBlank(row) { return FIELD_COLS.every(c => row[c] === '' || row[c] === false || row[c] == null); }

  function setCell(x, y, value) {
    if (sheet.options.data[y][x] === value) return;
    sheet.setValueFromCoords(x, y, value, true);
  }

  /** Replaces the sheet contents without firing change handlers or touching undo history. */
  function replaceData(rows) {
    refreshing = true;
    sheet.ignoreHistory = true;
    sheet.ignoreEvents = true;
    try { sheet.setData(rows); applyColumnVisibility(); } finally { refreshing = false; sheet.ignoreHistory = false; sheet.ignoreEvents = false; }
  }

  /** hideColumn only touches cells that exist, so it is reapplied after rows are created. */
  function applyColumnVisibility() {
    if (!cardFeature) sheet.hideColumn(COL.card);
    if (!tableFeature) sheet.hideColumn(COL.table);
  }

  /** Client-side check of one row; the server repeats every rule. */
  function checkRow(row) {
    if (!String(row[COL.name] ?? '').trim()) return { problem: 'Missing donor name' };
    const cents = parseAmount(row[COL.amount]);
    if (cents === null) return { problem: 'Amount must be a number of dollars, such as 1,500 or 1500.50' };
    if (cents > 10000000000) return { problem: 'Amount is above the $100,000,000 limit' };
    if (String(row[COL.name]).trim().length > 200) return { problem: 'Donor name is longer than 200 characters' };
    if (String(row[COL.note] ?? '').length > 1000) return { problem: 'Note is longer than 1,000 characters' };
    return { cents };
  }

  function needsText(info) {
    const parts = [];
    if (info.needs.includes('major')) parts.push(`large gift (${fmt.money(threshold)} or more): check for an extra zero`);
    if (info.needs.includes('duplicate')) parts.push(info.duplicateText || 'possible repeat of a gift already recorded');
    return parts.join('; ');
  }

  /** Recomputes every Status cell, mints ids for new rows, and enables the Record button. */
  function refresh() {
    refreshing = true;
    sheet.ignoreHistory = true;
    sheet.ignoreEvents = true;
    try {
      const data = sheet.options.data;
      let ready = 0, readyCents = 0, attention = 0, recorded = 0;
      for (let y = 0; y < data.length; y++) {
        const row = data[y];
        if (isBlank(row)) {
          if (row[COL.id] && !meta.get(row[COL.id])?.recorded) { meta.delete(row[COL.id]); setCell(COL.id, y, ''); }
          setCell(COL.status, y, '');
          setCell(COL.confirm, y, false);
          continue;
        }
        if (!row[COL.id]) setCell(COL.id, y, newId());
        const id = row[COL.id];
        if (!meta.has(id)) meta.set(id, { donation_id: id, recorded: false, needs: [] });
        const info = meta.get(id);
        if (typeof row[COL.anonymous] !== 'boolean') setCell(COL.anonymous, y, parseFlag(row[COL.anonymous]));
        if (typeof row[COL.confirm] !== 'boolean') setCell(COL.confirm, y, parseFlag(row[COL.confirm]));
        if (info.recorded) {
          recorded++;
          setCell(COL.status, y, 'Recorded');
          lockRow(y);
          continue;
        }
        const check = checkRow(row);
        if (check.problem) { attention++; setCell(COL.status, y, check.problem); continue; }
        const wasMajor = info.needs.includes('major');
        const isMajor = check.cents >= threshold;
        if (isMajor && !wasMajor) info.needs.push('major');
        if (!isMajor && wasMajor) info.needs = info.needs.filter(n => n !== 'major');
        if (info.problem) { attention++; setCell(COL.status, y, info.problem); continue; }
        if (info.needs.length && !row[COL.confirm]) { attention++; setCell(COL.status, y, `Tick Confirm: ${needsText(info)}`); continue; }
        ready++; readyCents += check.cents;
        setCell(COL.status, y, info.needs.length ? `Ready (confirmed: ${needsText(info)})` : 'Ready');
      }
      const parts = [];
      if (ready) parts.push(`${ready} ready (${fmt.money(readyCents)})`);
      if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
      if (recorded) parts.push(`${recorded} recorded`);
      summary.textContent = parts.length ? parts.join(' · ') : 'No rows yet.';
      importButton.disabled = running || !ready;
      importButton.textContent = ready ? `Record ${ready} ${ready === 1 ? 'gift' : 'gifts'} (${fmt.money(readyCents)})` : 'Record gifts';
      saveDraft();
    } finally {
      refreshing = false;
      sheet.ignoreHistory = false;
      sheet.ignoreEvents = false;
    }
  }

  function lockRow(y) {
    const cells = sheet.records[y];
    if (!cells) return;
    for (let x = 1; x < cells.length; x++) {
      cells[x].classList.add('readonly');
      cells[x].querySelector('input')?.setAttribute('disabled', 'disabled');
    }
    sheet.rows[y]?.classList.add('import-row-recorded');
  }

  function rowIndexOf(id) { return sheet.options.data.findIndex(row => row[COL.id] === id); }

  /** Appends parsed rows after the last filled row, replacing an empty sheet outright. */
  function addRows(rows, origin) {
    const { sheetRows, header, ignored } = toSheetRows(rows);
    if (!sheetRows.length) { say(intakeStatus, 'Nothing to add: no rows with any content were found.'); return; }
    const existing = sheet.options.data.filter(row => !isBlank(row));
    replaceData([...existing, ...sheetRows, ...blankRows(3)]);
    refresh();
    const notes = [`${sheetRows.length} ${sheetRows.length === 1 ? 'row' : 'rows'} added (${origin}${header ? ', columns matched by header' : ', columns taken in sheet order'}).`];
    if (ignored.length) notes.push(`Ignored columns: ${ignored.join(', ')}.`);
    say(intakeStatus, notes.join(' '));
  }

  $('btn-load-paste').addEventListener('click', () => {
    const text = $('paste-box').value;
    if (!text.trim()) { say(intakeStatus, 'Paste some rows first.'); $('paste-box').focus(); return; }
    addRows(parseDelimited(text), 'pasted');
    $('paste-box').value = '';
  });
  $('file-input').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      say(intakeStatus, 'Excel files cannot be opened here. Open the file in Excel, copy the cells, and paste them above.');
    } else {
      try { addRows(parseDelimited(await file.text()), file.name); } catch (_) { say(intakeStatus, `Could not read ${file.name}.`); }
    }
    event.target.value = '';
  });

  // --- Draft persistence ----------------------------------------------------

  let saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const data = sheet.options.data.filter(row => !isBlank(row));
      try {
        if (!data.length) localStorage.removeItem(DRAFT_KEY);
        else localStorage.setItem(DRAFT_KEY, JSON.stringify({ data, meta: [...meta.values()] }));
      } catch (_) { /* Storage full or blocked: the sheet still works for this page load. */ }
    }, 250);
  }
  function restoreDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return; }
    if (!draft || !Array.isArray(draft.data) || !draft.data.length) return;
    for (const info of draft.meta || []) {
      if (info?.donation_id) meta.set(info.donation_id, { donation_id: info.donation_id, recorded: Boolean(info.recorded), needs: Array.isArray(info.needs) ? info.needs : [], problem: info.problem, duplicateText: info.duplicateText });
    }
    const rows = draft.data.map(saved => { const out = blankRow(); saved.forEach((v, i) => { if (i < out.length) out[i] = v; }); return out; });
    replaceData([...rows, ...blankRows(3)]);
    refresh();
    say(intakeStatus, 'Restored the sheet from your last visit in this browser.');
  }

  $('btn-clear').addEventListener('click', async () => {
    const unsent = sheet.options.data.filter(row => !isBlank(row) && !meta.get(row[COL.id])?.recorded).length;
    const ok = await GivebarSession.confirm({
      title: 'Clear the sheet?',
      body: unsent ? `${unsent} ${unsent === 1 ? 'row has' : 'rows have'} not been recorded and will be lost. Recorded gifts stay in the ledger.` : 'Recorded gifts stay in the ledger; only this sheet is cleared.',
      confirmLabel: 'Clear sheet', danger: unsent > 0
    });
    if (!ok) return;
    meta.clear();
    replaceData(blankRows(8));
    sheet.rows.forEach(row => row.classList.remove('import-row-recorded'));
    localStorage.removeItem(DRAFT_KEY);
    refresh();
    intakeStatus.hidden = true;
    say(importStatus, 'Sheet cleared.');
  });

  // --- Recording ------------------------------------------------------------

  function payloadFor(row, info, cents) {
    return {
      amount_cents: cents,
      donor_name: String(row[COL.name]).trim(),
      is_anonymous: row[COL.anonymous] === true,
      notes: String(row[COL.note] ?? '').trim(),
      donor_phonetic: String(row[COL.phonetic] ?? '').trim(),
      card_number: cardFeature ? String(row[COL.card] ?? '').trim() : undefined,
      table_number: tableFeature ? String(row[COL.table] ?? '').trim() : undefined,
      confirmed_major_gift: row[COL.confirm] === true && info.needs.includes('major'),
      confirmed_duplicate: row[COL.confirm] === true && info.needs.includes('duplicate'),
      queued_at: Date.now()
    };
  }

  /** Records the server's objection on the row and clears the Confirm tick so it must be re-read. */
  function objection(info, y, text, need) {
    if (need && !info.needs.includes(need)) info.needs.push(need);
    if (!need) info.problem = text;
    sheet.ignoreHistory = true;
    try { setCell(COL.confirm, y, false); } finally { sheet.ignoreHistory = false; }
  }

  async function recordReadyRows() {
    if (running) return;
    const jobs = [];
    sheet.options.data.forEach(row => {
      if (isBlank(row)) return;
      const info = meta.get(row[COL.id]);
      if (!info || info.recorded || info.problem) return;
      const check = checkRow(row);
      if (check.problem) return;
      if (info.needs.length && row[COL.confirm] !== true) return;
      jobs.push({ id: row[COL.id], cents: check.cents });
    });
    if (!jobs.length) return;
    const total = jobs.reduce((sum, job) => sum + job.cents, 0);
    const ok = await GivebarSession.confirm({
      title: `Record ${jobs.length} ${jobs.length === 1 ? 'gift' : 'gifts'} totalling ${fmt.money(total)}?`,
      body: `Each gift is recorded under your name and reaches the ballroom screen after ${Math.round(stageDelayMs / 1000)} seconds. Pause the chart first if the audience should not see them yet.`,
      confirmLabel: `Record ${fmt.money(total)}`
    });
    if (!ok) return;
    running = true;
    importButton.disabled = true;
    importButton.textContent = 'Recording…';
    let recorded = 0, held = 0, stopped = false;
    try {
      for (const job of jobs) {
        const y = rowIndexOf(job.id);
        if (y === -1) continue;
        const row = sheet.options.data[y];
        const info = meta.get(job.id);
        say(importStatus, `Recording ${recorded + held + 1} of ${jobs.length}: ${fmt.money(job.cents)} from ${row[COL.name]}…`);
        let response, result;
        try {
          response = await GivebarSession.api(`/api/donation/${job.id}`, { method: 'PUT', headers, body: JSON.stringify(payloadFor(row, info, job.cents)) });
          result = await response.json().catch(() => ({}));
        } catch (_) {
          stopped = true;
          break;
        }
        if (response.ok) {
          info.recorded = true; info.needs = []; info.problem = undefined;
          recorded++;
          continue;
        }
        if (response.status >= 500) { stopped = true; break; }
        held++;
        if (response.status === 428) {
          threshold = result.threshold_cents || threshold;
          objection(info, y, '', 'major');
        } else if (response.status === 409 && result.error === 'POSSIBLE_DUPLICATE') {
          info.duplicateText = `${fmt.money(result.prior_amount_cents)} from ${result.prior_donor_name} was recorded at ${fmt.time(result.prior_created_at)} by ${result.prior_entered_by || 'another operator'}; if this is the same gift, delete this row`;
          objection(info, y, '', 'duplicate');
        } else if (response.status === 409) {
          objection(info, y, `Card ${result.card_number} is already recorded for ${result.prior_donor_name} (${fmt.money(result.prior_amount_cents)}). Change or clear the card number.`);
        } else {
          objection(info, y, result.message || result.error || 'Not accepted by the server');
        }
      }
    } finally {
      running = false;
      refresh();
      const parts = [`${recorded} ${recorded === 1 ? 'gift' : 'gifts'} recorded.`];
      if (held) parts.push(`${held} held: see the Status column, fix or confirm, then press Record gifts again.`);
      if (stopped) parts.push('The server could not be reached; the remaining rows were not sent. Nothing was lost: press Record gifts again when the connection returns.');
      if (recorded) parts.push(`Recorded gifts reach the ballroom screen in ${Math.round(stageDelayMs / 1000)} seconds and can be edited or deleted in Manage Donations.`);
      say(importStatus, parts.join(' '));
    }
  }
  importButton.addEventListener('click', recordReadyRows);

  async function loadSettings() {
    try {
      const response = await GivebarSession.api('/api/state?role=entry');
      if (!response.ok) return;
      const data = await response.json();
      threshold = data.major_gift_threshold_cents;
      stageDelayMs = data.stage_delay_ms;
      cardFeature = Boolean(data.feature_card_number);
      tableFeature = Boolean(data.feature_table_number);
      applyColumnVisibility();
    } catch (_) { /* Server still enforces every rail. */ }
    refresh();
  }

  window.addEventListener('beforeunload', event => {
    if (running) { event.preventDefault(); event.returnValue = ''; }
  });

  restoreDraft();
  await loadSettings();
})();
