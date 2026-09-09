/**
 * Givebar — Manage Donations Controller
 * One donation table, client sorting/filtering,
 * keyed row updates, delete dialog with 30s undo affordance,
 * explicit PIN unlock screen on 401, staleness detector, and honest state isolation.
 */

(function () {
  'use strict';

  // State
  let currentDonations = [];
  let totalRaisedCents = 0;
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
  const panelTable = document.getElementById('panel-table');
  const searchInput = document.getElementById('manage-search');
  const tbodyEl = document.getElementById('manage-tbody');
  const emptyStateEl = document.getElementById('empty-state');
  const emptyStateTitleEl = document.getElementById('empty-state-title');
  const emptyStateTextEl = document.getElementById('empty-state-text');
  const emptyStateBtn = document.getElementById('empty-state-btn');
  const authView = document.getElementById('authenticated-view');

  // Stale Banner Elements
  const staleBanner = document.getElementById('stale-banner');
  const staleBannerText = document.getElementById('stale-banner-text');
  const btnReconnectPoll = document.getElementById('btn-reconnect-poll');

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

  function init() {
    setupSearchListener();
    setupSortHeaders();
    setupDeleteModal();
    setupUndoAction();
    setupStaleBanner();
    window.addEventListener('givebar:donation-recorded', fetchState);
    startDataSync();
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
          staleBannerText.textContent = `Connection lost. Showing cached data from ${timeStr}, retrying.`;
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

    try {
      if (window.EventSource) {
        sseSource = new EventSource('/api/state/stream?role=control');
        sseSource.onmessage = function (event) {
          try {
            const data = JSON.parse(event.data);
            lastSuccessfulUpdateAt = Date.now();

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
    try {
      const res = await GivebarSession.api('/api/state?role=control');


      if (!res.ok) {
        setDegradedState(true);
        return;
      }

      const data = await res.json();
      lastSuccessfulUpdateAt = Date.now();

      setDegradedState(false);
      handleStateUpdate(data);
    } catch (err) {
      console.warn('[Givebar] Failed to fetch state:', err);
      setDegradedState(true);
    }
  }

  function handleStateUpdate(data) {
    if (!data) return;
    window.dispatchEvent(new CustomEvent('givebar:control-state', {detail:data}));

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
        enteredBy: item.entered_by || 'Unknown operator',
        source: item.source
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
      if (emptyStateEl) {
        emptyStateEl.style.display = 'block';
        if (emptyStateTitleEl) emptyStateTitleEl.textContent = 'No donations yet';
        if (emptyStateTextEl) emptyStateTextEl.textContent = 'Gifts appear here as they are recorded.';
        if (emptyStateBtn) {
          emptyStateBtn.style.display = 'inline-flex';
          emptyStateBtn.textContent = '+ Add First Donation';
          emptyStateBtn.onclick = () => document.getElementById('btn-open-add').click();
        }
      }
      return;
    }

    // Authenticated with search filter yielding 0 matches
    if (list.length === 0) {
      if (panelTable) panelTable.style.display = 'none';
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

    if (panelTable) panelTable.style.display = 'block';
    renderKeyedTable(list);
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
        <td style="font-weight:600;color:#f4f5f6">${escapeHTML(item.donor)}<div class="donation-attribution">${escapeHTML(GivebarOperator.source(item.source))} · ${escapeHTML(item.enteredBy)}</div></td>
        <td class="text-right amount-cell" style="color: #f4f5f6;">${formattedAmount}</td>
        <td class="text-center time-cell">${relativeTime}</td>
        <td class="text-center">${statusHtml}</td>
        <td class="text-right">
          <button type="button" class="btn-secondary" data-copy-donation="${escapeHTML([item.donor, formattedAmount, relativeTime, GivebarOperator.source(item.source), item.enteredBy].join(' · '))}">Copy</button>
          <button type="button" class="btn-delete-row" data-action="delete" data-id="${escapeHTML(item.id)}" data-donor="${escapeHTML(item.donor)}" data-amount="${item.amountCents}" aria-label="Delete donation" title="Delete donation">
            Delete
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


  function getStatusBadgeHtml(status) {
    if (status === 'confirmed') {
      return '<span class="status-badge confirmed"><svg viewBox="0 0 256 256" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M229.66,69.66l-128,128a8,8,0,0,1-11.32,0l-64-64a8,8,0,0,1,11.32-11.32L96,180.69,218.34,58.34a8,8,0,0,1,11.32,11.32Z"/></svg> Confirmed</span>';
    } else if (status === 'pending') {
      return '<span class="status-badge pending" title="Pending" style="color: #d4a359;"><svg class="icon" viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/></svg> Pending</span>';
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
      deleteBody.textContent = `Delete ${formattedAmount} from ${donation.donor}? Subtracted from the total and removed from the chart. Restorable from History.`;
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
    try {
      const res = await GivebarSession.api(`/api/donation/${donation.id}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Deleted via Manage Donations' })
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
    undoMessage.textContent = `${formattedAmount} from ${donation.donor} deleted.`;
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
    try {
      const res = await GivebarSession.api(`/api/donation/${donation.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Restored via Manage Donations' })
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
    return (cents / 100).toLocaleString('en-US', {style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2});
  }

  function formatRelativeTime(epochMs) { return GivebarOperator.time(epochMs); }

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
