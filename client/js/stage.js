/**
 * Givebar — 1080p Main Ballroom Screen HUD
 * 130px Odometer, Countdown Appeal Clock, Trust Badges, Split Media, Pinned VIP Chyrons & Confetti
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let odometer = null;
  let chyronList = [];
  let chyronIndex = 0;
  let lastConfettiTrigger = 0;
  let currentQrUrl = '';
  let currentQrStyle = '';
  let currentQrBadge = '';
  let currentPinnedDonation = null;

  function init() {
    initOdometer();
    initMilestones();
    setupFullscreenShortcut();
    startPolling();
    startChyronRotator();
  }

  function initOdometer() {
    const el = document.getElementById('main-odometer');
    if (!el) return;

    if (typeof window.RollingOdometer !== 'undefined') {
      odometer = new window.RollingOdometer(el, {
        initialValue: 0,
        currency: '$'
      });
    } else if (typeof window.GivebarOdometer !== 'undefined') {
      odometer = new window.GivebarOdometer(el, {
        initialValue: 0,
        currency: '$'
      });
    } else {
      el.textContent = '$0';
      odometer = {
        set: (cents) => {
          el.textContent = `$${Math.floor(cents / 100).toLocaleString('en-US')}`;
        }
      };
    }
  }

  function initMilestones() {
    const container = document.getElementById('milestones-container');
    if (!container) return;

    const defaultMilestones = [
      { percent: 25, label: 'Foundation' },
      { percent: 50, label: 'Staffing' },
      { percent: 75, label: 'Legal Clinic' },
      { percent: 100, label: 'Expansion' }
    ];

    container.innerHTML = defaultMilestones.map(m => `
      <div class="milestone-marker" style="left: ${m.percent}%;">
        <div class="milestone-pin"></div>
        <div class="milestone-label">${m.label}</div>
      </div>
    `).join('');
  }

  function setupFullscreenShortcut() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    });
  }

  function renderMilestones(milestones, goalCents) {
    const container = document.getElementById('milestones-container');
    if (!container || !Array.isArray(milestones) || milestones.length === 0) return;

    container.innerHTML = milestones.map(m => {
      const pct = m.percent_of_goal !== null && m.percent_of_goal !== undefined
        ? m.percent_of_goal
        : (goalCents > 0 ? (m.cents / goalCents) * 100 : 0);

      if (pct < 5 || pct > 100) return '';

      return `
        <div class="milestone-marker" style="left: ${pct}%;">
          <div class="milestone-pin"></div>
          <div class="milestone-label">${escapeHTML(m.label)}</div>
        </div>
      `;
    }).join('');
  }

  // --- Live State Polling ---
  async function fetchState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=stage`);
      if (!res.ok) return;
      const data = await res.json();
      // 2. Countdown Appeal Clock Pill (Synchronized with server_time)
      const clockPill = document.getElementById('stage-clock-pill');
      const clockText = document.getElementById('stage-clock-text');
      const serverOffset = data.server_time ? data.server_time - Date.now() : 0;
      const currentSyncedNow = Date.now() + serverOffset;

      if (clockPill && clockText) {
        if (data.timer_status === 'running' || data.timer_status === 'paused') {
          let rem = data.countdown_seconds || 300;
          if (data.timer_status === 'running' && data.timer_ends_at) {
            rem = Math.max(0, Math.ceil((data.timer_ends_at - currentSyncedNow) / 1000));
          }
          const mins = Math.floor(rem / 60);
          const secs = rem % 60;
          clockText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
          clockPill.style.display = 'inline-flex';
          if (rem <= 10 && data.timer_status === 'running') {
            clockPill.classList.add('urgent');
          } else {
            clockPill.classList.remove('urgent');
          }
        } else {
          clockPill.style.display = 'none';
        }
      }


      // 3. Update Odometer Total
      if (odometer && data.total_raised_cents !== undefined) {
        odometer.set(data.total_raised_cents);
      }

      // 4. Update Progress Bar & Percentage
      const progressFill = document.getElementById('progress-bar-fill');
      const progressPercent = document.getElementById('progress-percent');
      const goalAmount = document.getElementById('goal-amount');

      if (progressFill && data.percent !== undefined) {
        progressFill.style.width = `${Math.min(100, data.percent)}%`;
      }
      if (progressPercent && data.percent !== undefined) {
        progressPercent.textContent = `${data.percent}%`;
      }
      if (goalAmount && data.goal_cents) {
        goalAmount.textContent = `$${Math.floor(data.goal_cents / 100).toLocaleString('en-US')}`;
      }

      // 5. Update Matching Grant Banner
      const matchBanner = document.getElementById('match-banner');
      const matchBannerText = document.getElementById('match-banner-text');

      if (matchBanner && matchBannerText) {
        if (data.is_match_active && data.match_pool_cents > 0) {
          const poolDollars = `$${Math.floor(data.match_pool_cents / 100).toLocaleString('en-US')}`;
          const sponsor = data.match_sponsor_title || 'MATCH ACTIVE';
          matchBannerText.textContent = `${poolDollars} MATCH ACTIVE — EVERY DOLLAR DOUBLED BY ${sponsor.toUpperCase()}`;
          matchBanner.style.display = 'inline-flex';
        } else {
          matchBanner.style.display = 'none';
        }
      }

      // 6. Update Freeze Indicator
      const freezeEl = document.getElementById('freeze-indicator');
      if (freezeEl) {
        freezeEl.style.display = data.is_frozen ? 'block' : 'none';
      }

      // 7. Confetti Trigger Check
      if (data.confetti_trigger && data.confetti_trigger > lastConfettiTrigger) {
        lastConfettiTrigger = data.confetti_trigger;
        fireConfettiBurst();
      }

      // 8. Split Media Embed Frame
      const mediaWrap = document.getElementById('stage-media-wrap');
      const mediaFrame = document.getElementById('stage-media-frame');
      if (mediaWrap && mediaFrame) {
        if (data.thermometer_visual_mode === 'split_media' && data.embed_media_url) {
          mediaWrap.style.display = 'block';
          if (mediaFrame.getAttribute('data-active-url') !== data.embed_media_url) {
            mediaFrame.setAttribute('data-active-url', data.embed_media_url);
            mediaFrame.src = data.embed_media_url;
          }
        } else {
          mediaWrap.style.display = 'none';
          if (mediaFrame.getAttribute('data-active-url')) {
            mediaFrame.removeAttribute('data-active-url');
            mediaFrame.src = 'about:blank';
          }
        }
      }

      // 9. Update Pinned VIP Donation
      currentPinnedDonation = data.pinned_donation || null;

      // 10. Update Adaptive Scannable QR Code
      const qrUrl = data.qr_donate_url || 'https://give.hope.org/donate';
      if (qrUrl !== currentQrUrl) {
        currentQrUrl = qrUrl;
        const qrImg = document.getElementById('stage-qr-img');
        if (qrImg) {
          qrImg.src = `${API_BASE}/qr?url=${encodeURIComponent(currentQrUrl)}&margin=2&v=4.2.0`;
        }
      }

      // 11. Apply Live Theme Tokens
      if (data.theme) {
        document.documentElement.style.setProperty('--brand-hue', data.theme.hue);
        document.documentElement.style.setProperty('--brand-chroma', data.theme.chroma);
        if (data.theme.radius_px) {
          document.documentElement.style.setProperty('--brand-radius', `${data.theme.radius_px}px`);
        }
      }

      // 12. Update Milestones
      if (Array.isArray(data.milestones)) {
        renderMilestones(data.milestones, data.goal_cents || 50000000);
      }

      // 13. Update Chyrons List
      if (Array.isArray(data.chyrons)) {
        chyronList = data.chyrons;
      }

    } catch {
      // Ignore network hiccup
    }
  }

  // --- Chyron Rotator Engine ---
  function startChyronRotator() {
    setInterval(() => {
      const donorEl = document.getElementById('chyron-donor');
      const metaEl = document.getElementById('chyron-meta');
      const hostEl = document.getElementById('chyron-host');

      if (!donorEl || !metaEl || !hostEl) return;

      // If there is a VIP Pinned Donation, keep it prominently featured
      if (currentPinnedDonation) {
        const dollars = `$${Math.floor(currentPinnedDonation.amount_cents / 100).toLocaleString('en-US')}`;
        hostEl.classList.add('pinned');
        donorEl.innerHTML = `★ ${escapeHTML(currentPinnedDonation.display_name)} — <span style="color: var(--brand-accent); font-weight: 900;">${dollars}</span>`;
        metaEl.textContent = currentPinnedDonation.notes ? `“${currentPinnedDonation.notes}”` : 'Featured Gala Supporter';
        return;
      }

      hostEl.classList.remove('pinned');

      if (chyronList.length === 0) {
        donorEl.textContent = 'Welcome to the Live Appeal';
        metaEl.textContent = 'Live verified donations will appear here';
        return;
      }

      const item = chyronList[chyronIndex % chyronList.length];
      chyronIndex++;

      const dollars = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;

      // Smooth fade transition
      hostEl.style.opacity = '0.2';
      setTimeout(() => {
        donorEl.innerHTML = `${escapeHTML(item.display_name)} — <span style="color: var(--brand-accent); font-weight: 900;">${dollars}</span>`;
        metaEl.textContent = item.notes ? `“${escapeHTML(item.notes)}”` : 'Verified Live Gala Supporter';
        hostEl.style.opacity = '1';
      }, 200);

    }, 4500); // Rotate every 4.5 seconds
  }

  // --- Confetti Cannon Engine ---
  function fireConfettiBurst() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#E2B755', '#38BDF8', '#4ADE80', '#F43F5E', '#A855F7', '#F59E0B', '#FFFFFF'];

    for (let i = 0; i < 160; i++) {
      particles.push({
        x: canvas.width / 2,
        y: canvas.height * 0.45,
        vx: (Math.random() - 0.5) * 26,
        vy: (Math.random() - 0.8) * 22,
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.45,
        opacity: 1
      });
    }

    let frame = 0;
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.rotation += p.rSpeed;
        p.opacity -= 0.007;

        if (p.opacity > 0) {
          alive = true;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.globalAlpha = Math.max(0, p.opacity);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
          ctx.restore();
        }
      });

      frame++;
      if (alive && frame < 180) {
        requestAnimationFrame(render);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    render();
  }

  function escapeHTML(str) {
    if (!str) return '';
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  function startPolling() {
    fetchState();
    setInterval(fetchState, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
