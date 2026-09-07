/**
 * Givebar — Testing / Rehearsal Controller
 * Isolated sample data generator, persistent test mode indicator,
 * sample-tagged record feed, and isolated rehearsal purge.
 */

(function () {
  'use strict';

  let pollInterval = null;
  let sampleRecords = [];

  // DOM Elements
  const testModeBanner = document.getElementById('test-mode-banner');
  const testBannerDesc = document.getElementById('test-banner-desc');
  const btnPurgeSampleData = document.getElementById('btn-purge-sample-data');
  const sampleCountBadge = document.getElementById('sample-count-badge');
  const sampleRecordsTbody = document.getElementById('sample-records-tbody');
  const sampleCleanState = document.getElementById('sample-clean-state');

  // Generator Buttons
  const btnGenSingle = document.getElementById('btn-gen-single');
  const btnGenBurst = document.getElementById('btn-gen-burst');
  const btnGenTypo = document.getElementById('btn-gen-typo');
  const btnGenMilestone = document.getElementById('btn-gen-milestone');

  function init() {
    setupGenerators();
    setupPurge();
    syncState();
    pollInterval = setInterval(syncState, 2000);
  }

  // --- Generator Action Handlers ---
  function setupGenerators() {
    if (btnGenSingle) {
      btnGenSingle.addEventListener('click', () => postRehearsal({ mode: 'single' }));
    }
    if (btnGenBurst) {
      btnGenBurst.addEventListener('click', () => postRehearsal({ mode: 'burst', count: 7 }));
    }
    if (btnGenTypo) {
      btnGenTypo.addEventListener('click', () => postRehearsal({ mode: 'typo' }));
    }
    if (btnGenMilestone) {
      btnGenMilestone.addEventListener('click', () => postRehearsal({ mode: 'milestone' }));
    }
  }

  async function postRehearsal(body) {
    try {
      const res = await fetch('/api/rehearsal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        syncState();
      }
    } catch (err) {
      console.warn('[Givebar Testing] Rehearsal generation error:', err);
    }
  }

  // --- Isolated Purge Action ---
  function setupPurge() {
    if (btnPurgeSampleData) {
      btnPurgeSampleData.addEventListener('click', async () => {
        try {
          btnPurgeSampleData.disabled = true;
          btnPurgeSampleData.textContent = 'Purging...';

          const res = await fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'purge_rehearsal' })
          });

          if (res.ok) {
            syncState();
          }
        } catch (err) {
          console.warn('[Givebar Testing] Purge failed:', err);
        } finally {
          btnPurgeSampleData.disabled = false;
          btnPurgeSampleData.textContent = 'Purge Sample Data';
        }
      });
    }
  }

  // --- Sync & Render Sample Records ---
  async function syncState() {
    try {
      const res = await fetch('/api/state?role=control', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) return;
      const data = await res.json();

      // Extract sample/rehearsal records
      const chyrons = Array.isArray(data.staged_chyrons) ? data.staged_chyrons : [];
      sampleRecords = chyrons.filter(c => c.source === 'rehearsal');

      renderSampleView();
    } catch (err) {
      console.warn('[Givebar Testing] Sync state error:', err);
    }
  }

  function renderSampleView() {
    const count = sampleRecords.length;

    // 1. Persistent Test Mode Banner
    if (testModeBanner) {
      if (count > 0) {
        testModeBanner.style.display = 'flex';
        if (testBannerDesc) {
          testBannerDesc.textContent = `${count} sample record${count === 1 ? '' : 's'} active in database. Purging removes only sample data and leaves real donations untouched.`;
        }
      } else {
        testModeBanner.style.display = 'none';
      }
    }

    if (sampleCountBadge) {
      sampleCountBadge.textContent = `${count} active record${count === 1 ? '' : 's'}`;
    }

    // 2. Table or Clean State
    if (!sampleRecordsTbody || !sampleCleanState) return;

    if (count === 0) {
      sampleRecordsTbody.innerHTML = '';
      sampleCleanState.style.display = 'block';
    } else {
      sampleCleanState.style.display = 'none';
      sampleRecordsTbody.innerHTML = sampleRecords.map(item => {
        const timeStr = formatRelativeTime(item.created_at);
        const amountStr = `$${Math.floor((item.amount_cents || 0) / 100).toLocaleString('en-US')}`;
        const statusBadge = item.is_held
          ? '<span style="color: #f87171; font-weight: 700; font-size: var(--text-xs);">&#x25A0; HELD</span>'
          : '<span style="color: #d4a359; font-weight: 700; font-size: var(--text-xs);">&#x25CF; ACTIVE</span>';

        return `
          <tr>
            <td style="font-weight: 600; color: #f4f5f6;">
              ${escapeHTML(item.donor_name || 'Anonymous Supporter')}
              <span class="sample-tag">[Sample Data]</span>
            </td>
            <td class="text-right" style="font-weight: 700; font-variant-numeric: tabular-nums; color: #f4f5f6;">
              ${amountStr}
            </td>
            <td class="text-center" style="color: #88888e; font-size: var(--text-xs);">
              ${timeStr}
            </td>
            <td class="text-center">
              ${statusBadge}
            </td>
          </tr>
        `;
      }).join('');
    }
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
