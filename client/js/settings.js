/**
 * Givebar — Settings View Controller
 * Collapsible grouped sections with persisted open/closed state, the full branding set
 * (title, logo, colors, typeface, orientation), separated QR destination vs. printed URL,
 * editable goal, milestone and ask-tier editors, and Control Room / Volunteer Pad PINs.
 */

(function () {
  'use strict';

  const OPEN_SECTIONS_KEY = 'givebar_settings_open_sections';
  const DEFAULT_OPEN_SECTIONS = ['sec-event'];

  // Typeface keys accepted by the server and rendered by the chart iframe.
  const FONT_KEYS = ['brandon', 'humanist', 'grotesk', 'mono', 'serif'];
  const DEFAULT_FONT_KEY = 'brandon';
  const ORIENTATIONS = ['horizontal', 'vertical'];

  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const OKLCH_RE = /^oklch\(\s*[^()]*\)$/i;

  let currentSettingsSeq = 1;
  let milestonesData = [];
  let askTiersData = [];

  let loadedGoalCents = 0;
  let loadedMilestones = '';
  const field = id => document.getElementById(id);
  const dollars = value => Number(String(value || '0').replaceAll(',', ''));
  // DOM Elements
  const btnSaveTop = document.getElementById('btn-save-top');
  const btnSaveBottom = document.getElementById('btn-save-bottom');
  const btnExpandAll = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');
  const errorBanner = document.getElementById('settings-error-banner');
  const errorText = document.getElementById('settings-error-text');
  const btnReloadConflict = document.getElementById('btn-reload-conflict');
  const successBanner = document.getElementById('settings-success-banner');

  const authView = document.getElementById('authenticated-view');

  // Event Inputs
  const eventTitleInput = document.getElementById('setting-event-title');
  const eventNameInput = document.getElementById('setting-event-name');
  const eventSubtitleInput = document.getElementById('setting-event-subtitle');
  const goalDollarsInput = document.getElementById('setting-goal-dollars');
  const errGoal = document.getElementById('err-goal');
  const trustBadgeInput = document.getElementById('setting-trust-badge');
  const milestonesTbody = document.getElementById('milestones-tbody');
  const milestonesEmpty = document.getElementById('milestones-empty');
  const btnAddMilestone = document.getElementById('btn-add-milestone');

  // Branding Inputs
  const logoUrlInput = document.getElementById('setting-logo-url');
  const barColorInput = document.getElementById('setting-bar-color');
  const errBarColor = document.getElementById('err-bar-color');
  const textColorInput = document.getElementById('setting-text-color');
  const errTextColor = document.getElementById('err-text-color');
  const bgStyleSelect = document.getElementById('setting-bg-style');
  const orientationSelect = document.getElementById('setting-chart-orientation');
  const fontFamilySelect = document.getElementById('setting-font-family');

  // QR Inputs
  const qrUrlInput = document.getElementById('setting-qr-url');
  const displayUrlInput = document.getElementById('setting-display-url');
  const errQrUrl = document.getElementById('err-qr-url');
  const displayUrlEffectiveEl = document.getElementById('display-url-effective');
  const toggleShowQr = document.getElementById('toggle-show-qr');

  // Stage Display Inputs
  const toggleShowRecent = document.getElementById('toggle-show-recent');
  const toggleShowLive = document.getElementById('toggle-show-live');
  const toggleShowGoal = document.getElementById('toggle-show-goal');

  // Donations Inputs
  const askTiersTbody = document.getElementById('ask-tiers-tbody');
  const btnAddTier = document.getElementById('btn-add-tier');
  const guardrailThresholdInput = document.getElementById('setting-guardrail-threshold');
  const stagingDelayInput = document.getElementById('setting-staging-delay');
  const toggleMatchActive = document.getElementById('toggle-match-active');
  const matchTitleInput = document.getElementById('setting-match-title');
  const matchPoolInput = document.getElementById('setting-match-pool');


  // Features Inputs
  const toggleFeatureCard = document.getElementById('toggle-feature-card');
  const toggleFeatureTable = document.getElementById('toggle-feature-table');

  function init() {
    setupAccordion();
    setupMilestonesEditor();
    setupAskTiersEditor();
    setupSaveHandlers();
    setupReloadConflict();
    setupLivePreviews();
    loadSettings();
  }

  // --- Accordion with persisted open/closed state ---
  function readOpenSections() {
    try {
      const raw = localStorage.getItem(OPEN_SECTIONS_KEY);
      if (raw === null) return DEFAULT_OPEN_SECTIONS.slice();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch (err) {
      return DEFAULT_OPEN_SECTIONS.slice();
    }
  }

  function writeOpenSections(ids) {
    try {
      localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(ids));
    } catch (err) {
      /* storage unavailable: collapse state simply will not persist */
    }
  }

  function setPanelExpanded(panel, expanded) {
    panel.classList.toggle('expanded', expanded);
    const header = panel.querySelector('.accordion-header');
    if (header) header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function persistCurrentOpenSections() {
    const open = [];
    document.querySelectorAll('.accordion-panel').forEach(panel => {
      if (panel.classList.contains('expanded')) open.push(panel.id);
    });
    writeOpenSections(open);
  }

  function setupAccordion() {
    const openSections = readOpenSections();
    document.querySelectorAll('.accordion-panel').forEach(panel => {
      setPanelExpanded(panel, openSections.includes(panel.id));
    });

    document.querySelectorAll('.accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const panel = document.getElementById(header.getAttribute('data-toggle'));
        if (!panel) return;
        setPanelExpanded(panel, !panel.classList.contains('expanded'));
        persistCurrentOpenSections();
      });
    });

    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', () => {
        document.querySelectorAll('.accordion-panel').forEach(p => setPanelExpanded(p, true));
        persistCurrentOpenSections();
      });
    }

    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', () => {
        document.querySelectorAll('.accordion-panel').forEach(p => setPanelExpanded(p, false));
        persistCurrentOpenSections();
      });
    }
  }

  // --- Live previews ---

  function updateChartPreview() {
    field('gradient-angle-value').value = field('setting-gradient-angle').value + '°';
    field('gradient-intensity-value').value = field('setting-gradient-intensity').value + '%';
    field('gradient-controls').hidden = bgStyleSelect.value !== 'subtle-gradient';
    field('setting-marker-step').hidden = field('setting-marker-mode').querySelector(':checked').value !== 'dollars';
    const artwork = field('setting-qr-image-url').value;
    const artworkPreview = field('qr-artwork-preview');
    artworkPreview.hidden = !artwork;
    field('clear-qr-artwork').hidden = !artwork;
    artworkPreview.style.background = field('setting-qr-image-backdrop').checked ? '#fff' : '#111114';
    if (artwork && artworkPreview.getAttribute('src') !== artwork) artworkPreview.src = artwork;
    if (!artwork) artworkPreview.removeAttribute('src');
    const frame = field('settings-chart-preview');
    if (!frame) return;
    frame.style.transform = `scale(${field('settings-preview-frame').clientWidth / 1920})`;
    frame.contentWindow?.postMessage({
      type: 'givebar:preview-settings',
      settings: {
        event_title: eventTitleInput.value,
        goal_cents: dollars(goalDollarsInput.value) * 100,
        logo_url: logoUrlInput.value,
        bar_color: barColorInput.value,
        text_color: textColorInput.value,
        background_style: bgStyleSelect.value,
        background_image_url: field('setting-background-url').value,
        gradient_start: field('setting-gradient-start').value,
        gradient_end: field('setting-gradient-end').value,
        gradient_angle: Number(field('setting-gradient-angle').value),
        gradient_intensity: Number(field('setting-gradient-intensity').value),
        background_video_url: field('setting-background-video').value.trim(),
        qr_image_url: artwork,
        qr_image_backdrop: field('setting-qr-image-backdrop').checked,
        chart_orientation: orientationSelect.value,
        font_family: fontFamilySelect.value,
        marker_mode: field('setting-marker-mode').querySelector(':checked').value,
        marker_step_cents: Number(field('setting-marker-step').querySelector(':checked').value),
        milestones: milestonesData
      }
    }, location.origin);
  }

  // Mirrors the server rule: empty printed URL falls back to the QR destination
  // with its query string and fragment stripped, so UTM never hits the projector.
  function derivePrintedUrl(qrUrl, displayUrl) {
    const explicit = (displayUrl || '').trim();
    if (explicit) return explicit;
    const raw = (qrUrl || '').trim();
    if (!raw) return '';
    const stripped = raw.split('#')[0].split('?')[0];
    return stripped.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function applyPrintedUrlPreview() {
    if (!displayUrlEffectiveEl) return;
    const printed = derivePrintedUrl(qrUrlInput?.value, displayUrlInput?.value);
    displayUrlEffectiveEl.innerHTML = printed
      ? `Printed on the chart: <strong>${escapeHTML(printed)}</strong>`
      : 'Nothing prints under the QR code until one of these two fields has a value.';
  }

  function setupLivePreviews() {
    document.getElementById('settings-form')?.addEventListener('input', updateChartPreview);
    document.getElementById('settings-form')?.addEventListener('change', updateChartPreview);
    document.getElementById('settings-form')?.addEventListener('focusout', event => {
      const input = event.target;
      if (!input.matches('.milestone-dollars,.tier-dollars,#setting-match-pool,#setting-guardrail-threshold')) return;
      const value = dollars(input.value);
      if (Number.isFinite(value)) input.value = value.toLocaleString('en-US');
    });
    const frame = field('settings-chart-preview');
    frame?.addEventListener('load', updateChartPreview);
    if (frame) new ResizeObserver(updateChartPreview).observe(field('settings-preview-frame'));
    goalDollarsInput.addEventListener('blur', () => {
      const value = dollars(goalDollarsInput.value);
      if (Number.isFinite(value)) goalDollarsInput.value = value.toLocaleString('en-US');
    });
    for (const name of ['bar', 'text']) {
      const picker = field(`setting-${name}-picker`);
      const input = field(`setting-${name}-color`);
      picker.addEventListener('input', () => {
        input.value = picker.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      input.addEventListener('input', () => {
        if (/^#[0-9a-f]{6}$/i.test(input.value)) picker.value = input.value;
      });
    }
    for (const name of ['logo', 'background', 'qr-image']) {
      field(`setting-${name}-file`).addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        const types = ['image/png', 'image/jpeg', 'image/webp'];
        if (name === 'qr-image') types.push('image/svg+xml');
        if (!types.includes(file.type) || file.size > 2 * 1024 * 1024) {
          showError(`Choose a PNG, JPEG, WebP${name === 'qr-image' ? ', or SVG' : ''} image up to 2 MB.`);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          field(`setting-${name}-url`).value = reader.result;
          updateChartPreview();
          showSuccess('Image ready. Save Settings to publish it to the chart.');
        };
        reader.onerror = () => showError('Could not read the image. Choose it again.');
        reader.readAsDataURL(file);
      });
    }
    field('clear-qr-artwork').addEventListener('click', () => {
      field('setting-qr-image-url').value = '';
      field('setting-qr-image-file').value = '';
      updateChartPreview();
      showSuccess('Automatic QR selected. Save Settings to publish it.');
    });
    if (qrUrlInput) qrUrlInput.addEventListener('input', applyPrintedUrlPreview);
    if (displayUrlInput) displayUrlInput.addEventListener('input', applyPrintedUrlPreview);
    if (qrUrlInput) {
      qrUrlInput.addEventListener('input', () => {
        setFieldValidity(qrUrlInput, errQrUrl, isValidQrUrl(qrUrlInput.value));
      });
    }
    [barColorInput, textColorInput].forEach(input => {
      if (!input) return;
      input.addEventListener('input', () => {
        const errEl = input === barColorInput ? errBarColor : errTextColor;
        setFieldValidity(input, errEl, isValidColor(input.value));
      });
    });
  }

  // --- Validation ---
  function isValidColor(value) {
    const v = (value || '').trim();
    if (!v) return true;
    return HEX_RE.test(v) || OKLCH_RE.test(v);
  }

  // Server rule: absolute http(s) URL, or empty (which means no QR block at all).
  function isValidQrUrl(value) {
    const v = (value || '').trim();
    if (!v) return true;
    try {
      const parsed = new URL(v);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  // The server hands uploaded images back as /api/asset/... URLs; sending one back unchanged
  // must leave the stored image alone, so it is omitted from the save.
  function imageValue(raw) {
    const value = (raw || '').trim();
    return value.startsWith('/api/asset/') ? undefined : value;
  }

  function setFieldValidity(input, errEl, ok) {
    if (input) input.classList.toggle('invalid', !ok);
    if (errEl) errEl.hidden = ok;
    return ok;
  }

  // --- Load Settings ---
  async function loadSettings() {
    try {
      const res = await GivebarSession.api('/api/state?role=control');
      if (res.status === 401) {
        return;
      }
      if (!res.ok) {
        showError('Could not load settings from server.');
        return;
      }
      const data = await res.json();
      populateForm(data);
    } catch (err) {
      console.warn('[Givebar Settings] Load error:', err);
      showError('Network error loading settings.');
    }
  }

  function populateForm(data) {
    if (!data) return;

    currentSettingsSeq = data.settings_seq || 1;
    const es = data.event_state || {};
    loadedGoalCents = es.goal_cents || 0;
    loadedMilestones = JSON.stringify((data.milestones || []).map(m => ({ cents: m.cents || 0, label: m.label || '' })));
    field('setting-marker-mode').querySelector(`input[value="${es.marker_mode || 'milestones'}"]`).checked = true;
    field('setting-marker-step').querySelector(`input[value="${es.marker_step_cents || 10000000}"]`).checked = true;
    field('setting-background-url').value = es.background_image_url || '';
    field('setting-gradient-start').value = es.gradient_start || '#183b46';
    field('setting-gradient-end').value = es.gradient_end || '#39213d';
    field('setting-gradient-angle').value = es.gradient_angle ?? 135;
    field('setting-gradient-intensity').value = es.gradient_intensity ?? 35;
    field('setting-background-video').value = es.background_video_url || '';
    field('setting-qr-image-url').value = es.qr_image_url || '';
    field('setting-qr-image-backdrop').checked = Boolean(es.qr_image_backdrop ?? true);

    // 1. Event
    if (eventTitleInput) eventTitleInput.value = es.event_title || '';
    if (eventNameInput) eventNameInput.value = es.event_name || '';
    if (eventSubtitleInput) eventSubtitleInput.value = es.event_subtitle || '';
    if (goalDollarsInput) goalDollarsInput.value = ((es.goal_cents || 0) / 100).toLocaleString('en-US');
    if (trustBadgeInput) trustBadgeInput.value = es.trust_badge_text || '';

    milestonesData = (Array.isArray(data.milestones) ? data.milestones : []).map(m => ({
      cents: m.cents || 0,
      label: m.label || '',
      percent_of_goal: typeof m.percent_of_goal === 'number' ? m.percent_of_goal : undefined,
      celebrate: m.celebrate === undefined ? undefined : Boolean(m.celebrate)
    }));
    renderMilestonesRows();

    // 2. Branding
    if (logoUrlInput) logoUrlInput.value = es.logo_url || '';
    if (barColorInput) barColorInput.value = es.bar_color || '';
    if (textColorInput) textColorInput.value = es.text_color || '';
    if (bgStyleSelect) bgStyleSelect.value = es.background_style || es.bg_style || 'plain';
    if (orientationSelect) {
      orientationSelect.value = ORIENTATIONS.includes(es.chart_orientation) ? es.chart_orientation : 'horizontal';
    }
    if (fontFamilySelect) {
      fontFamilySelect.value = FONT_KEYS.includes(es.font_family) ? es.font_family : DEFAULT_FONT_KEY;
    }
    setFieldValidity(goalDollarsInput, errGoal, true);
    setFieldValidity(barColorInput, errBarColor, true);
    setFieldValidity(textColorInput, errTextColor, true);
    updateChartPreview();

    // 3. Donation link & QR
    if (qrUrlInput) qrUrlInput.value = es.qr_url || '';
    if (displayUrlInput) displayUrlInput.value = es.display_url || '';
    setFieldValidity(qrUrlInput, errQrUrl, true);
    if (displayUrlEffectiveEl && typeof data.display_url_effective === 'string') {
      displayUrlEffectiveEl.innerHTML = data.display_url_effective
        ? `Printed on the chart: <strong>${escapeHTML(data.display_url_effective)}</strong>`
        : 'Nothing prints under the QR code until one of these two fields has a value.';
    } else {
      applyPrintedUrlPreview();
    }
    if (toggleShowQr) toggleShowQr.checked = es.show_qr !== undefined ? Boolean(es.show_qr) : true;

    // 4. Stage display
    if (toggleShowRecent) toggleShowRecent.checked = es.show_recent_donations !== undefined ? Boolean(es.show_recent_donations) : true;
    if (toggleShowLive) toggleShowLive.checked = es.show_live_indicator !== undefined ? Boolean(es.show_live_indicator) : true;
    if (toggleShowGoal) toggleShowGoal.checked = es.show_goal !== undefined ? Boolean(es.show_goal) : true;

    // 5. Donations
    askTiersData = (Array.isArray(data.ask_tiers) ? data.ask_tiers : []).map(t => ({
      cents: t.cents || 0,
      label: t.label || ''
    }));
    renderAskTiersRows();

    if (guardrailThresholdInput) guardrailThresholdInput.value = ((es.major_gift_threshold_cents || 950000) / 100).toLocaleString('en-US');
    if (stagingDelayInput) stagingDelayInput.value = Math.round((es.stage_delay_ms || 0) / 1000);

    if (toggleMatchActive) toggleMatchActive.checked = Boolean(es.is_match_active);
    if (matchTitleInput) matchTitleInput.value = es.match_sponsor_title || '';
    if (matchPoolInput) matchPoolInput.value = ((es.match_total_cents || 0) / 100).toLocaleString('en-US');


    // 7. Features
    if (toggleFeatureCard) toggleFeatureCard.checked = Boolean(es.feature_card_number);
    if (toggleFeatureTable) toggleFeatureTable.checked = Boolean(es.feature_table_number);

  }

  // --- Milestones Editor ---
  function setupMilestonesEditor() {
    if (!btnAddMilestone) return;
    btnAddMilestone.addEventListener('click', () => {
      const goalDollars = dollars(goalDollarsInput?.value);
      const suggestedDollars = goalDollars > 0 ? Math.round(goalDollars / 2) : 50000;
      milestonesData.push({
        cents: suggestedDollars * 100,
        label: 'New Milestone'
      });
      renderMilestonesRows();
      const lastInput = milestonesTbody?.querySelector('tr:last-child .milestone-label-input');
      if (lastInput) { lastInput.focus(); lastInput.select(); }
    });
  }

  function renderMilestonesRows() {
    if (!milestonesTbody) return;
    milestonesTbody.innerHTML = milestonesData.map((m, idx) => {
      const dollars = Math.floor((m.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="text" inputmode="decimal" class="form-input-text milestone-dollars" value="${dollars.toLocaleString('en-US')}" style="padding:6px 8px" aria-label="Milestone target in dollars">
          </td>
          <td>
            <input type="text" class="form-input-text milestone-label-input" value="${escapeHTML(m.label || '')}" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Milestone label">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-milestone="${idx}" title="Delete this milestone">
              <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192Z"/></svg>
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join('');

    if (milestonesEmpty) {
      milestonesEmpty.style.display = milestonesData.length === 0 ? 'block' : 'none';
    }

    milestonesTbody.querySelectorAll('.milestone-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        milestonesData[idx].cents = dollars(inp.value) * 100;
      });
    });

    milestonesTbody.querySelectorAll('.milestone-label-input').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        milestonesData[idx].label = inp.value;
      });
    });

    milestonesTbody.querySelectorAll('[data-remove-milestone]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-milestone'), 10);
        milestonesData.splice(idx, 1);
        renderMilestonesRows();
      });
    });
  }

  // --- Ask Tiers Editor ---
  function setupAskTiersEditor() {
    if (!btnAddTier) return;
    btnAddTier.addEventListener('click', () => {
      askTiersData.push({ cents: 100000, label: '$1,000' });
      renderAskTiersRows();
    });
  }

  function renderAskTiersRows() {
    if (!askTiersTbody) return;
    askTiersTbody.innerHTML = askTiersData.map((t, idx) => {
      const dollars = Math.floor((t.cents || 0) / 100);
      return `
        <tr data-index="${idx}">
          <td>
            <input type="text" inputmode="decimal" class="form-input-text tier-dollars" value="${dollars.toLocaleString('en-US')}" style="padding:6px 8px" aria-label="Ask tier amount in dollars">
          </td>
          <td>
            <input type="text" class="form-input-text tier-label" value="${escapeHTML(t.label || `$${dollars.toLocaleString('en-US')}`)}" style="padding: 6px 8px; font-size: var(--text-xs);" aria-label="Ask tier label">
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-row-remove" data-remove-tier="${idx}" title="Delete this ask tier">
              <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192Z"/></svg>
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join('');

    askTiersTbody.querySelectorAll('.tier-dollars').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        const val = dollars(inp.value);
        askTiersData[idx].cents = val * 100;
        if (!askTiersData[idx].label || askTiersData[idx].label.startsWith('$')) {
          askTiersData[idx].label = `$${val.toLocaleString('en-US')}`;
          const labelInp = askTiersTbody.querySelector(`tr[data-index="${idx}"] .tier-label`);
          if (labelInp) labelInp.value = askTiersData[idx].label;
        }
      });
    });

    askTiersTbody.querySelectorAll('.tier-label').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        askTiersData[idx].label = inp.value;
      });
    });

    askTiersTbody.querySelectorAll('[data-remove-tier]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-tier'), 10);
        askTiersData.splice(idx, 1);
        renderAskTiersRows();
      });
    });
  }

  // --- Password Reveal ---
  // --- Save Handlers ---
  function setupSaveHandlers() {
    if (btnSaveTop) btnSaveTop.addEventListener('click', handleSaveSettings);
    if (btnSaveBottom) btnSaveBottom.addEventListener('click', handleSaveSettings);
  }

  function setupReloadConflict() {
    if (!btnReloadConflict) return;
    btnReloadConflict.addEventListener('click', () => {
      clearBanners();
      loadSettings();
    });
  }

  async function handleSaveSettings() {
    clearBanners();

    // Client-side validation so the operator sees the field, not a bare 400.
    const goalDollars = dollars(goalDollarsInput?.value);
    const goalOk = setFieldValidity(goalDollarsInput, errGoal, Number.isFinite(goalDollars) && goalDollars >= 1);
    const barOk = setFieldValidity(barColorInput, errBarColor, isValidColor(barColorInput?.value));
    const textOk = setFieldValidity(textColorInput, errTextColor, isValidColor(textColorInput?.value));
    const qrOk = setFieldValidity(qrUrlInput, errQrUrl, isValidQrUrl(qrUrlInput?.value));

    if (!goalOk || !barOk || !textOk || !qrOk) {
      const target = !goalOk ? goalDollarsInput
        : (!barOk ? barColorInput : (!textOk ? textColorInput : qrUrlInput));
      const panel = target?.closest('.accordion-panel');
      if (panel) {
        setPanelExpanded(panel, true);
        persistCurrentOpenSections();
      }
      showError('Fix the fields marked in red.');
      if (target) target.focus();
      return;
    }
    const changedMilestones = JSON.stringify(milestonesData.map(m => ({ cents: m.cents || 0, label: m.label || '' })));
    if ((goalDollars * 100 !== loadedGoalCents || changedMilestones !== loadedMilestones) &&
        !(await GivebarSession.confirm({ title: 'Apply goal and milestones to the ballroom?', body: `This changes the live chart the moment it saves. Goal: $${goalDollars.toLocaleString('en-US')}.`, confirmLabel: 'Save and apply' }))) return;

    const guardrailDollars = dollars(guardrailThresholdInput?.value) || 9500;
    const stagingSec = Math.max(0, parseInt(stagingDelayInput?.value || '0', 10) || 0);
    const matchPoolDollars = Math.max(0, dollars(matchPoolInput?.value));
    const fontKey = FONT_KEYS.includes(fontFamilySelect?.value) ? fontFamilySelect.value : DEFAULT_FONT_KEY;
    const orientation = ORIENTATIONS.includes(orientationSelect?.value) ? orientationSelect.value : 'horizontal';

    const payload = {
      action: 'update_settings',
      settings_seq: currentSettingsSeq,

      // Event
      event_title: eventTitleInput?.value?.trim() || '',
      event_name: eventNameInput?.value?.trim() || undefined,
      event_subtitle: eventSubtitleInput?.value?.trim() || '',
      goal_cents: goalDollars * 100,
      trust_badge_text: trustBadgeInput?.value?.trim() || '',
      milestones: milestonesData.map(m => ({ cents: m.cents || 0, label: m.label || '' })),

      // Branding
      logo_url: imageValue(logoUrlInput?.value),
      bar_color: barColorInput?.value?.trim() || '',
      text_color: textColorInput?.value?.trim() || '',
      background_style: bgStyleSelect?.value || 'plain',
      font_family: fontKey,
      chart_orientation: orientation,
      marker_mode: field('setting-marker-mode').querySelector(':checked').value,
      marker_step_cents: Number(field('setting-marker-step').querySelector(':checked').value),
      background_image_url: imageValue(field('setting-background-url').value),
      gradient_start: field('setting-gradient-start').value,
      gradient_end: field('setting-gradient-end').value,
      gradient_angle: Number(field('setting-gradient-angle').value),
      gradient_intensity: Number(field('setting-gradient-intensity').value),
      background_video_url: field('setting-background-video').value.trim(),

      // Donation link & QR
      qr_url: qrUrlInput?.value?.trim() || '',
      qr_image_url: imageValue(field('setting-qr-image-url').value),
      qr_image_backdrop: field('setting-qr-image-backdrop').checked,
      display_url: displayUrlInput?.value?.trim() || '',
      show_qr: Boolean(toggleShowQr?.checked),

      // Stage display
      show_recent_donations: Boolean(toggleShowRecent?.checked),
      show_live_indicator: Boolean(toggleShowLive?.checked),
      show_goal: Boolean(toggleShowGoal?.checked),

      // Donations
      ask_tiers: askTiersData.map(t => ({ cents: t.cents || 0, label: t.label || '' })),
      major_gift_threshold_cents: guardrailDollars * 100,
      stage_delay_ms: stagingSec * 1000,
      is_match_active: Boolean(toggleMatchActive?.checked),
      match_sponsor_title: matchTitleInput?.value?.trim() || undefined,
      match_total_cents: matchPoolDollars * 100,

      // Features
      feature_card_number: Boolean(toggleFeatureCard?.checked),
      feature_table_number: Boolean(toggleFeatureTable?.checked)
    };


    setSaveBusy(true);
    try {
      const res = await GivebarSession.api('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 403) {
        showError('Only an administrator can save settings.');
        return;
      }

      if (res.status === 409) {
        const conflictData = await res.json().catch(() => ({}));
        showError(conflictData.message || 'Settings were changed in another session. Reload before saving.', true);
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        showError(errData.message || 'Failed to save settings.');
        return;
      }

      const resData = await res.json();
      showSuccess('Settings saved.');
      if (resData.state) {
        populateForm(resData.state);
      } else {
        currentSettingsSeq += 1;
        await loadSettings();
      }
    } catch (err) {
      console.error('[Givebar Settings] Save error:', err);
      showError('Network error saving settings.');
    } finally {
      setSaveBusy(false);
    }
  }
  function setSaveBusy(busy) {
    [btnSaveTop, btnSaveBottom].forEach(btn => {
      if (!btn) return;
      btn.disabled = busy;
      btn.textContent = busy ? 'Saving...' : 'Save Settings';
    });
  }

  // --- Banner Helpers ---
  function showError(msg, showReload = false) {
    if (errorBanner && errorText) {
      errorText.textContent = msg;
      errorBanner.style.display = 'block';
      if (btnReloadConflict) {
        btnReloadConflict.style.display = showReload ? 'inline-flex' : 'none';
      }
    }
    if (successBanner) successBanner.style.display = 'none';
  }

  function showSuccess(msg) {
    if (successBanner) {
      successBanner.textContent = msg;
      successBanner.style.display = 'block';
    }
    if (errorBanner) errorBanner.style.display = 'none';
  }

  function clearBanners() {
    if (errorBanner) errorBanner.style.display = 'none';
    if (successBanner) successBanner.style.display = 'none';
  }

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
