/**
 * Givebar — Manage Donations Controller
 * Unified dataset, Table & Stream views, client sorting/filtering,
 * keyed row updates, delete dialog with 30s undo affordance,
 * explicit PIN unlock screen on 401, staleness detector, and honest state isolation.
 */

(function () {
  'use strict';

  // State
  let currentDonations = [];
  let totalRaisedCents = 0;
  let activeTab = 'table'; // 'table' | 'stream'
  let searchQuery = '';
  let sortColumn = 'time'; // 'donor' | 'amount' | 'time' | 'status'
  let sortDirection = 'desc'; // 'asc' | 'desc'
  let pollInterval = null;
  let sseSource = null;
  let authState = 'unauthenticated'; // 'unauthenticated' | 'authenticated'
  let lastSuccessfulUpdateAt = 0;

  // Pending deletion & Undo state
  let pendingDeleteDonation = null;
  let lastDeletedDonation = null;
  let undoTimer = null;
  let undoExpiresAt = 0;

  // DOM Elements
  const summaryTotalRaisedEl = document.getElementById('summary-total-raised');
  const tabTableBtn = document.getElementById('tab-table');
  const tabStreamBtn = document.getElementById('tab-stream');
  const panelTable = document.getElementById('panel-table');
  const panelStream = document.getElementById('panel-stream');
  const searchInput = document.getElementById('manage-search');
  const tbodyEl = document.getElementById('manage-tbody');
  const streamEl = document.getElementById('manage-stream');
  const emptyStateEl = document.getElementById('empty-state');
  const emptyStateTitleEl = document.getElementById('empty-state-title');
  const emptyStateTextEl = document.getElementById('empty-state-text');
  const emptyStateBtn = document.getElementById('empty-state-btn');
  const authView = document.getElementById('authenticated-view');

  // Stale Banner Elements
  const staleBanner = document.getElementById('stale-banner');
  const staleBannerText = document.getElementById('stale-banner-text');
  const btnReconnectPoll = document.getElementById('btn-reconnect-poll');

  // Unlock Screen Elements
  const unlockScreen = document.getElementById('unlock-screen');
  const unlockForm = document.getElementById('unlock-form');
  const unlockPinInput = document.getElementById('unlock-pin-input');
  const btnSubmitUnlock = document.getElementById('btn-submit-unlock');
  const unlockError = document.getElementById('unlock-error');

  // Modal Dialog Elements
  const deleteModal = document.getElementById('delete-modal');
  const deleteTitle = document.getElementById('delete-dialog-title');
  const deleteBody = document.getElementById('delete-dialog-body');
  const btnCancelDelete = document.getElementById('btn-cancel-delete');
  const btnConfirmDelete = document.getElementById('btn-confirm-delete');

  // Undo Banner Elements
  const undoBanner = document.getElementById('undo-banner');
  const undoMessage = document.getElementById('undo-message');
  const btnUndoDelete = document.getElementById('btn-undo-delete');

  // --- PIN Storage Helpers ---
  function getControlPin() {
    return sessionStorage.getItem('givebar_control_pin') || localStorage.getItem('givebar_control_pin') || '';
  }

  function setControlPin(pin) {
    sessionStorage.setItem('givebar_control_pin', pin);
    localStorage.setItem('givebar_control_pin', pin);
  }

  function clearControlPin() {
    sessionStorage.removeItem('givebar_control_pin');
    localStorage.removeItem('givebar_control_pin');
  }

  function init() {
    setupTabListeners();
    setupSearchListener();
    setupSortHeaders();
    setupDeleteModal();
    setupUndoAction();
    setupUnlockForm();
    setupStaleBanner();
    startDataSync();
  }

  // --- Unlock Screen & State Isolation ---
  function setupUnlockForm() {
    if (unlockForm) {
      unlockForm.addEventListener('submit', handleUnlockSubmit);
    }
  }

  async function handleUnlockSubmit(e) {
    if (e) e.preventDefault();
    const pin = (unlockPinInput?.value || '').trim();
    if (!pin) {
      showUnlockError('Please enter the Control Room PIN.');
      if (unlockPinInput) unlockPinInput.focus();
      return;
    }

    clearUnlockError();
    if (btnSubmitUnlock) {
      btnSubmitUnlock.disabled = true;
      btnSubmitUnlock.textContent = 'Verifying...';
    }

    try {
      const res = await fetch(`/api/state?role=control&pin=${encodeURIComponent(pin)}`, {
        headers: {
          'X-Control-Pin': pin,
          'Cache-Control': 'no-cache'
        }
      });

      if (res.status === 401) {
        showUnlockError('Invalid Control Room PIN.');
        if (unlockPinInput) {
          unlockPinInput.focus();
          unlockPinInput.select();
        }
        return;
      }

      if (!res.ok) {
        showUnlockError('Server error validating PIN. Please try again.');
        return;
      }

      const data = await res.json();
      setControlPin(pin);
      lastSuccessfulUpdateAt = Date.now();
      setAuthUIState('authenticated');
      setDegradedState(false);
      handleStateUpdate(data);

      // Re-init SSE with valid PIN
      initSSE();
    } catch (err) {
      showUnlockError('Network error connecting to server.');
    } finally {
      if (btnSubmitUnlock) {
        btnSubmitUnlock.disabled = false;
        btnSubmitUnlock.textContent = 'Unlock';
      }
    }
  }

  function showUnlockError(msg) {
    if (unlockError) {
      unlockError.textContent = msg;
      unlockError.style.display = 'block';
    }
  }

  function clearUnlockError() {
    if (unlockError) {
      unlockError.textContent = '';
      unlockError.style.display = 'none';
    }
  }

  function setAuthUIState(state) {
    authState = state;
    if (state === 'unauthenticated') {
      if (unlockScreen) unlockScreen.style.display = 'flex';
      if (authView) authView.style.display = 'none';
      if (summaryTotalRaisedEl) summaryTotalRaisedEl.textContent = '—';
      if (emptyStateEl) emptyStateEl.style.display = 'none';
      if (staleBanner) staleBanner.style.display = 'none';
      if (unlockPinInput) {
        setTimeout(() => unlockPinInput.focus(), 50);
      }
    } else {
      if (unlockScreen) unlockScreen.style.display = 'none';
      if (authView) authView.style.display = 'block';
    }
  }

  function setupStaleBanner() {
    if (btnReconnectPoll) {
      btnReconnectPoll.addEventListener('click', () => {
        fetchState();
      });
    }
  }

  function setDegradedState(isDegraded) {
    const isStale = isDegraded || (lastSuccessfulUpdateAt > 0 && Date.now() - lastSuccessfulUpdateAt > 5000);

    if (staleBanner) {
      if (isStale && authState === 'authenticated') {
        staleBanner.style.display = 'flex';
        const timeStr = lastSuccessfulUpdateAt > 0
          ? new Date(lastSuccessfulUpdateAt).toLocaleTimeString()
          : 'an earlier session';
        if (staleBannerText) {
          staleBannerText.textContent = `Connection degraded. Displaying cached data from ${timeStr}. Retrying...`;
        }
        if (summaryTotalRaisedEl && totalRaisedCents > 0) {
          summaryTotalRaisedEl.textContent = `${formatCurrency(totalRaisedCents)} (Stale)`;
        }
      } else if (authState === 'authenticated') {
        staleBanner.style.display = 'none';
        if (summaryTotalRaisedEl) {
          summaryTotalRaisedEl.textContent = formatCurrency(totalRaisedCents);
        }
      }
    }
  }

  // --- Realtime / Sync ---
  function startDataSync() {
    fetchState();
    pollInterval = setInterval(fetchState, 1500);
    setInterval(() => {
      if (authState === 'authenticated') {
        setDegradedState(false);
      }
    }, 1000);
    initSSE();
  }

  function initSSE() {
    if (sseSource) {
      try { sseSource.close(); } catch (e) {}
      sseSource = null;
    }

    const pin = getControlPin();
    if (!pin) return;

    try {
      if (window.EventSource) {
        sseSource = new EventSource(`/api/state/stream?role=control&pin=${encodeURIComponent(pin)}`);
        sseSource.onmessage = function (event) {
          try {
            const data = JSON.parse(event.data);
            lastSuccessfulUpdateAt = Date.now();
            setAuthUIState('authenticated');
            setDegradedState(false);
            handleStateUpdate(data);
          } catch (e) {}
        };
        sseSource.onerror = function () {
          if (sseSource) {
            sseSource.close();
            sseSource = null;
          }
        };
      }
    } catch (e) {}
  }

  async function fetchState() {
    const pin = getControlPin();
    try {
      const res = await fetch(`/api/state?role=control&pin=${encodeURIComponent(pin)}`, {
        headers: {
          'X-Control-Pin': pin,
          'Cache-Control': 'no-cache'
        }
      });

      if (res.status === 401) {
        // Unauthenticated state: never paint a zero or empty state
        clearControlPin();
        setAuthUIState('unauthenticated');
        return;
      }

      if (!res.ok) {
        setDegradedState(true);
        return;
      }

      const data = await res.json();
      lastSuccessfulUpdateAt = Date.now();
      setAuthUIState('authenticated');
      setDegradedState(false);
      handleStateUpdate(data);
    } catch (err) {
      console.warn('[Givebar] Failed to fetch state:', err);
      setDegradedState(true);
    }
  }

  function handleStateUpdate(data) {
    if (!data) return;

    // Total Raised
    totalRaisedCents = data.folded?.total_raised_cents || 0;
    if (summaryTotalRaisedEl) {
      summaryTotalRaisedEl.textContent = formatCurrency(totalRaisedCents);
    }

    // Process donations list
    const chyrons = data.staged_chyrons || [];
    currentDonations = chyrons.map(item => {
      const isPending = !item.is_live_on_stage || item.is_held;
      const status = item.is_voided ? 'removed' : (isPending ? 'pending' : 'confirmed');
      return {
        id: item.donation_id,
        donor: item.donor_name || 'Anonymous',
        displayName: item.display_name || item.donor_name || 'Anonymous',
        isAnonymous: Boolean(item.is_anonymous),
        amountCents: item.amount_cents || 0,
        createdAt: item.created_at || Date.now(),
        status,
        isHeld: Boolean(item.is_held),
        enteredBy: item.entered_by || 'User'
      };
    });

    renderCurrentView();
  }

  // --- Filtering & Sorting ---
  function getFilteredAndSorted() {
    const q = searchQuery.trim().toLowerCase();
    let list = currentDonations.filter(d => {
      if (!q) return true;
      const donorMatch = d.donor.toLowerCase().includes(q);
      const displayMatch = d.displayName.toLowerCase().includes(q);
      return donorMatch || displayMatch;
    });

    list.sort((a, b) => {
      let comparison = 0;
      if (sortColumn === 'donor') {
        comparison = a.donor.localeCompare(b.donor);
      } else if (sortColumn === 'amount') {
        comparison = a.amountCents - b.amountCents;
      } else if (sortColumn === 'time') {
        comparison = a.createdAt - b.createdAt;
      } else if (sortColumn === 'status') {
        comparison = a.status.localeCompare(b.status);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return list;
  }

  // --- Render Views (Unambiguous 3-State Separation) ---
  function renderCurrentView() {
    // If not authenticated, do not render data or empty states
    if (authState !== 'authenticated') return;

    const list = getFilteredAndSorted();

    // Authenticated with genuinely zero donations (State 2)
    if (currentDonations.length === 0) {
      if (panelTable) panelTable.style.display = 'none';
      if (panelStream) panelStream.style.display = 'none';
      if (emptyStateEl) {
        emptyStateEl.style.display = 'block';
        if (emptyStateTitleEl) emptyStateTitleEl.textContent = 'No donations yet';
        if (emptyStateTextEl) emptyStateTextEl.textContent = 'The event has not started yet. Pledges and donations entered from Add Donation or online links will appear here live.';
        if (emptyStateBtn) {
          emptyStateBtn.style.display = 'inline-flex';
          emptyStateBtn.textContent = '+ Add First Donation';
          emptyStateBtn.onclick = () => { window.location.href = '/add'; };
        }
      }
      return;
    }

    // Authenticated with search filter yielding 0 matches
    if (list.length === 0) {
      if (panelTable) panelTable.style.display = 'none';
      if (panelStream) panelStream.style.display = 'none';
      if (emptyStateEl) {
        emptyStateEl.style.display = 'block';
        if (emptyStateTitleEl) emptyStateTitleEl.textContent = 'No donations match your search';
        if (emptyStateTextEl) emptyStateTextEl.textContent = `No donations matching "${searchQuery}".`;
        if (emptyStateBtn) {
          emptyStateBtn.style.display = 'inline-flex';
          emptyStateBtn.textContent = 'Clear Search';
          emptyStateBtn.onclick = () => {
            if (searchInput) searchInput.value = '';
            searchQuery = '';
            renderCurrentView();
          };
        }
      }
      return;
    }

    // Authenticated with active donation rows
    if (emptyStateEl) emptyStateEl.style.display = 'none';

    if (activeTab === 'table') {
      if (panelTable) panelTable.style.display = 'block';
      if (panelStream) panelStream.style.display = 'none';
      renderKeyedTable(list);
    } else {
      if (panelTable) panelTable.style.display = 'none';
      if (panelStream) panelStream.style.display = 'block';
      renderKeyedStream(list);
    }
  }

  // --- Keyed Table Update (Preserves Focus & Selection) ---
  function renderKeyedTable(list) {
    if (!tbodyEl) return;

    const existingRows = new Map();
    Array.from(tbodyEl.children).forEach(tr => {
      const id = tr.getAttribute('data-donation-id');
      if (id) existingRows.set(id, tr);
    });

    const activeIds = new Set(list.map(d => d.id));

    existingRows.forEach((tr, id) => {
      if (!activeIds.has(id)) {
        tr.remove();
      }
    });

    let previousNode = null;
    list.forEach(item => {
      let tr = existingRows.get(item.id);
      const isNew = !tr;

      if (isNew) {
        tr = document.createElement('tr');
        tr.setAttribute('data-donation-id', item.id);
      }

      const relativeTime = formatRelativeTime(item.createdAt);
      const formattedAmount = formatCurrency(item.amountCents);
      const statusHtml = getStatusBadgeHtml(item.status);

      const innerHtml = `
        <td style="font-weight: 600; color: #f4f5f6;">${escapeHTML(item.donor)}</td>
        <td class="text-right amount-cell" style="color: #f4f5f6;">${formattedAmount}</td>
        <td class="text-center time-cell">${relativeTime}</td>
        <td class="text-center">${statusHtml}</td>
        <td class="text-right">
          <button type="button" class="btn-delete-row" data-action="delete" data-id="${escapeHTML(item.id)}" data-donor="${escapeHTML(item.donor)}" data-amount="${item.amountCents}" aria-label="Delete donation" title="Delete donation">
            &#x2715;
          </button>
        </td>
      `;

      if (tr.innerHTML !== innerHtml) {
        tr.innerHTML = innerHtml;
        const deleteBtn = tr.querySelector('.btn-delete-row');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', () => {
            promptDeleteDonation(item);
          });
        }
      }

      if (isNew) {
        if (previousNode && previousNode.nextSibling) {
          tbodyEl.insertBefore(tr, previousNode.nextSibling);
        } else if (!previousNode && tbodyEl.firstChild) {
          tbodyEl.insertBefore(tr, tbodyEl.firstChild);
        } else {
          tbodyEl.appendChild(tr);
        }
      } else {
        const expectedNext = previousNode ? previousNode.nextSibling : tbodyEl.firstChild;
        if (tr !== expectedNext) {
          tbodyEl.insertBefore(tr, expectedNext);
        }
      }

      previousNode = tr;
    });
  }

  // --- Keyed Stream Update ---
  function renderKeyedStream(list) {
    if (!streamEl) return;

    const existingCards = new Map();
    Array.from(streamEl.children).forEach(card => {
      const id = card.getAttribute('data-donation-id');
      if (id) existingCards.set(id, card);
    });

    const activeIds = new Set(list.map(d => d.id));
    existingCards.forEach((card, id) => {
      if (!activeIds.has(id)) card.remove();
    });

    let previousNode = null;
    list.forEach(item => {
      let card = existingCards.get(item.id);
      const isNew = !card;

      if (isNew) {
        card = document.createElement('div');
        card.setAttribute('data-donation-id', item.id);
        card.style.cssText = 'background: #18191d; border: 1px solid #27282e; border-radius: var(--brand-radius); padding: var(--space-4); display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);';
      }

      const relativeTime = formatRelativeTime(item.createdAt);
      const formattedAmount = formatCurrency(item.amountCents);
      const statusHtml = getStatusBadgeHtml(item.status);

      const innerHtml = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="font-weight: 700; font-size: var(--text-sm); color: #f4f5f6;">
            ${escapeHTML(item.donor)}
          </div>
          <div style="font-size: var(--text-xs); color: #88888e; display: flex; align-items: center; gap: var(--space-2);">
            <span>${relativeTime}</span>
            <span>&bull;</span>
            <span>${statusHtml}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-4);">
          <div style="font-size: var(--text-base); font-weight: 800; color: #f4f5f6; font-variant-numeric: tabular-nums;">
            ${formattedAmount}
          </div>
          <button type="button" class="btn-delete-row" data-action="delete" data-id="${escapeHTML(item.id)}" aria-label="Delete donation" title="Delete donation">
            &#x2715;
          </button>
        </div>
      `;

      if (card.innerHTML !== innerHtml) {
        card.innerHTML = innerHtml;
        const deleteBtn = card.querySelector('.btn-delete-row');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', () => {
            promptDeleteDonation(item);
          });
        }
      }

      if (isNew) {
        if (previousNode && previousNode.nextSibling) {
          streamEl.insertBefore(card, previousNode.nextSibling);
        } else if (!previousNode && streamEl.firstChild) {
          streamEl.insertBefore(card, streamEl.firstChild);
        } else {
          streamEl.appendChild(card);
        }
      } else {
        const expectedNext = previousNode ? previousNode.nextSibling : streamEl.firstChild;
        if (card !== expectedNext) {
          streamEl.insertBefore(card, expectedNext);
        }
      }

      previousNode = card;
    });
  }

  function getStatusBadgeHtml(status) {
    if (status === 'confirmed') {
      return '<span class="status-badge" title="Confirmed">&#x2713;</span>';
    } else if (status === 'pending') {
      return '<span class="status-badge pending" title="Pending" style="color: #d4a359;">&#x1F552; Pending</span>';
    } else if (status === 'removed') {
      return '<span class="status-badge removed" title="Removed">&#x2715; Removed</span>';
    }
    return '';
  }

  // --- Sorting Controls ---
  function setupSortHeaders() {
    const headers = document.querySelectorAll('.donations-table th.sortable');
    headers.forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort');
        if (!col) return;

        if (sortColumn === col) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col;
          sortDirection = col === 'amount' || col === 'time' ? 'desc' : 'asc';
        }

        updateSortIndicators();
        renderCurrentView();
      });
    });
    updateSortIndicators();
  }

  function updateSortIndicators() {
    ['donor', 'amount', 'time', 'status'].forEach(col => {
      const icon = document.getElementById(`sort-icon-${col}`);
      if (!icon) return;
      if (sortColumn === col) {
        icon.textContent = sortDirection === 'asc' ? '▲' : '▼';
        icon.style.color = '#d4a359';
      } else {
        icon.textContent = '⇅';
        icon.style.color = '#555660';
      }
    });
  }

  // --- Tab & Search Controls ---
  function setupTabListeners() {
    if (tabTableBtn) {
      tabTableBtn.addEventListener('click', () => {
        activeTab = 'table';
        tabTableBtn.classList.add('active');
        tabTableBtn.setAttribute('aria-selected', 'true');
        tabStreamBtn.classList.remove('active');
        tabStreamBtn.setAttribute('aria-selected', 'false');
        renderCurrentView();
      });
    }

    if (tabStreamBtn) {
      tabStreamBtn.addEventListener('click', () => {
        activeTab = 'stream';
        tabStreamBtn.classList.add('active');
        tabStreamBtn.setAttribute('aria-selected', 'true');
        tabTableBtn.classList.remove('active');
        tabTableBtn.setAttribute('aria-selected', 'false');
        renderCurrentView();
      });
    }
  }

  function setupSearchListener() {
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderCurrentView();
      });
    }
  }

  // --- Delete Dialog & Undo Flow ---
  function setupDeleteModal() {
    if (btnCancelDelete) {
      btnCancelDelete.addEventListener('click', closeDeleteModal);
    }

    if (btnConfirmDelete) {
      btnConfirmDelete.addEventListener('click', async () => {
        if (!pendingDeleteDonation) return;
        const donationToVoid = pendingDeleteDonation;
        closeDeleteModal();
        await executeDeleteDonation(donationToVoid);
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && deleteModal && deleteModal.style.display !== 'none') {
        closeDeleteModal();
      }
    });
  }

  function promptDeleteDonation(donation) {
    pendingDeleteDonation = donation;
    const formattedAmount = formatCurrency(donation.amountCents);

    if (deleteTitle) {
      deleteTitle.textContent = 'Delete this donation?';
    }
    if (deleteBody) {
      deleteBody.textContent = `Delete donation of ${formattedAmount} from ${donation.donor}? This donation will be removed from the display and subtracted from the total raised. It can be restored from History.`;
    }

    if (deleteModal) {
      deleteModal.style.display = 'flex';
      if (btnCancelDelete) {
        btnCancelDelete.focus();
      }
    }
  }

  function closeDeleteModal() {
    if (deleteModal) {
      deleteModal.style.display = 'none';
    }
    pendingDeleteDonation = null;
  }

  async function executeDeleteDonation(donation) {
    const pin = getControlPin();
    try {
      const res = await fetch(`/api/donation/${donation.id}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': pin
        },
        body: JSON.stringify({
          entered_by: 'User',
          reason: `Deleted via Manage Donations by User`,
          pin
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        alert(errData.message || 'Failed to delete donation');
        return;
      }

      lastDeletedDonation = donation;
      showUndoAffordance(donation);

      currentDonations = currentDonations.filter(d => d.id !== donation.id);
      renderCurrentView();

      fetchState();
    } catch (err) {
      console.error('[Givebar] Void error:', err);
    }
  }

  // --- Inline Undo Affordance ---
  function showUndoAffordance(donation) {
    if (!undoBanner || !undoMessage) return;

    if (undoTimer) {
      clearTimeout(undoTimer);
    }

    const formattedAmount = formatCurrency(donation.amountCents);
    undoExpiresAt = Date.now() + 30000;
    undoMessage.textContent = `Donation of ${formattedAmount} from ${donation.donor} deleted. It can also be restored from History.`;
    undoBanner.style.display = 'flex';

    undoTimer = setTimeout(() => {
      undoBanner.style.display = 'none';
      lastDeletedDonation = null;
    }, 30000);
  }

  function setupUndoAction() {
    if (btnUndoDelete) {
      btnUndoDelete.addEventListener('click', async () => {
        if (!lastDeletedDonation) return;
        const donationToRestore = lastDeletedDonation;

        if (undoTimer) clearTimeout(undoTimer);
        if (undoBanner) undoBanner.style.display = 'none';
        lastDeletedDonation = null;

        await executeRestoreDonation(donationToRestore);
      });
    }
  }

  async function executeRestoreDonation(donation) {
    const pin = getControlPin();
    try {
      const res = await fetch(`/api/donation/${donation.id}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Control-Pin': pin
        },
        body: JSON.stringify({
          entered_by: 'User',
          reason: `Restored via Undo in Manage Donations by User`,
          pin
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        alert(errData.message || 'Failed to restore donation');
        return;
      }

      fetchState();
    } catch (err) {
      console.error('[Givebar] Restore error:', err);
    }
  }

  // --- Utilities ---
  function formatCurrency(cents) {
    return `$${Math.floor(cents / 100).toLocaleString('en-US')}`;
  }

  function formatRelativeTime(epochMs) {
    const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h`;
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
