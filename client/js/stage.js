/**
 * Givebar — Stage 1080p HUD Controller
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let odometer = null;
  let lastSeq = 0;
  let lastConfettiTrigger = 0;
  let chyronList = [];
  let chyronIndex = 0;
  let chyronInterval = null;
  let cachedMilestonesJson = '';
  let currentQrUrl = '';

  // Confetti Particle Engine
  const confettiCanvas = document.getElementById('confetti-canvas');
  const ctx = confettiCanvas.getContext('2d');
  let particles = [];
  let confettiAnimationId = null;

  function resizeCanvas() {
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function fireConfettiBurst() {
    const colors = ['#F3D78A', '#E2B755', '#4ADE80', '#38BDF8', '#FFFFFF', '#F87171'];
    const count = 180;
    
    for (let i = 0; i < count; i++) {
      particles.push({
        x: confettiCanvas.width * (0.2 + Math.random() * 0.6),
        y: confettiCanvas.height * 0.4,
        vx: (Math.random() - 0.5) * 18,
        vy: -Math.random() * 16 - 6,
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.35,
        opacity: 1,
        decay: Math.random() * 0.008 + 0.006
      });
    }

    if (!confettiAnimationId) {
      animateConfetti();
    }
  }

  function animateConfetti() {
    ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.rotationSpeed;
      p.opacity -= p.decay;

      if (p.opacity <= 0 || p.y > confettiCanvas.height + 20) {
        particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    if (particles.length > 0) {
      confettiAnimationId = requestAnimationFrame(animateConfetti);
    } else {
      confettiAnimationId = null;
      ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }
  }

  // --- Initial Setup ---
  function init() {
    const odoContainer = document.getElementById('main-odometer');
    odometer = new RollingOdometer(odoContainer, {
      currency: '$',
      showCents: false,
      allowBackward: false, // Strict no-backward rule on stage
      initialValue: 0
    });

    startPolling();
    startChyronRotator();
  }

  // --- 1-Second Sequence Polling ---
  async function fetchState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=stage&since=${lastSeq}`);
      if (!res.ok) return;

      const data = await res.json();
      lastSeq = data.seq;

      // 1. Update Event Header
      const eventNameEl = document.getElementById('event-name');
      if (eventNameEl && data.event_name) {
        eventNameEl.textContent = data.event_name;
      }

      // 2. Update Odometer Total
      if (odometer) {
        odometer.set(data.total_raised_cents);
      }

      // 3. Update Progress Bar & Percent
      const barFill = document.getElementById('progress-bar-fill');
      const percentEl = document.getElementById('progress-percent');
      const goalEl = document.getElementById('goal-amount');

      if (data.goal_cents > 0) {
        const pct = Math.min(100, Math.round((data.total_raised_cents / data.goal_cents) * 1000) / 10);
        if (barFill) barFill.style.width = `${pct}%`;
        if (percentEl) percentEl.textContent = `${pct}%`;
        if (goalEl) goalEl.textContent = `$${Math.floor(data.goal_cents / 100).toLocaleString('en-US')}`;
      }

      // 4. Update Matching Banner
      const matchBanner = document.getElementById('match-banner');
      const matchText = document.getElementById('match-banner-text');
      if (data.is_match_active) {
        matchBanner.style.display = 'inline-flex';
        const poolDollars = Math.floor(data.match_pool_cents / 100).toLocaleString('en-US');
        matchText.textContent = data.match_sponsor_title 
          ? `⭐ ${data.match_sponsor_title.toUpperCase()} — $${poolDollars} REMAINING ⭐`
          : `⭐ MATCH ACTIVE — $${poolDollars} REMAINING ⭐`;
      } else {
        matchBanner.style.display = 'none';
      }

      // 5. Freeze indicator
      const freezeEl = document.getElementById('freeze-indicator');
      if (freezeEl) {
        freezeEl.style.display = data.is_frozen ? 'inline-block' : 'none';
      }

      // 6. Update Dynamic Milestones
      updateMilestones(data.milestones || [], data.goal_cents, data.total_raised_cents);

      // 7. Update Chyron List
      if (Array.isArray(data.chyrons)) {
        chyronList = data.chyrons;
      }

      // 8. Update QR code image if URL changed
      if (data.qr_donate_url && data.qr_donate_url !== currentQrUrl) {
        currentQrUrl = data.qr_donate_url;
        const qrImg = document.getElementById('stage-qr-img');
        if (qrImg) {
          qrImg.src = `${API_BASE}/qr?url=${encodeURIComponent(currentQrUrl)}&size=288`;
        }
      }

      // 9. Check Confetti Trigger
      if (data.confetti_trigger && data.confetti_trigger !== lastConfettiTrigger) {
        if (lastConfettiTrigger > 0) {
          fireConfettiBurst();
        }
        lastConfettiTrigger = data.confetti_trigger;
      }

    } catch {
      // Offline/flapping safety — keep last visible state
    }
  }

  function startPolling() {
    fetchState();
    setInterval(fetchState, 1000);
  }

  // --- Dynamic Milestone Notches ---
  // --- Dynamic Milestone Notches (Staggered Anti-Collision) ---
  function updateMilestones(milestones, goalCents, currentCents) {
    if (goalCents <= 0) return;
    const key = JSON.stringify(milestones) + `_${goalCents}_${currentCents}`;
    if (key === cachedMilestonesJson) return;
    cachedMilestonesJson = key;

    const container = document.getElementById('milestones-container');
    if (!container) return;
    container.innerHTML = '';

    milestones.forEach((m, idx) => {
      if (m.cents <= 0 || m.cents >= goalCents) return; // Only intermediate milestones

      const pct = (m.cents / goalCents) * 100;
      const isReached = currentCents >= m.cents;
      const dollars = Math.floor(m.cents / 100);
      const displayAmount = dollars >= 1000000 
        ? `$${(dollars / 1000000).toFixed(dollars % 1000000 === 0 ? 0 : 1)}M`
        : `$${Math.floor(dollars / 1000)}k`;

      const marker = document.createElement('div');
      const isStaggered = idx % 2 === 1;
      marker.className = `milestone-marker ${isStaggered ? 'stagger-high' : ''} ${isReached ? 'reached' : ''}`;
      marker.style.left = `clamp(54px, ${pct}%, calc(100% - 54px))`;

      marker.innerHTML = `
        <div class="milestone-pill">
          ${displayAmount}: ${m.label}
        </div>
        <div class="milestone-notch"></div>
      `;

      container.appendChild(marker);
    });
  }

  // --- Paced Chyron Stream Rotator with Surge Aggregation ---
  let chyronTick = 0;
  function startChyronRotator() {
    rotateChyron();
    chyronInterval = setInterval(rotateChyron, 4000);
  }

  function rotateChyron() {
    const host = document.getElementById('chyron-host');
    if (!host) return;

    if (chyronList.length === 0) {
      host.innerHTML = `
        <div class="chyron-item">
          <span class="chyron-name">Welcoming all Gala Patrons & Guests</span>
          <span class="chyron-badge">Live</span>
        </div>
      `;
      return;
    }

    chyronTick++;
    // If rapid surge (> 6 gifts in stream) and every 3rd tick, show aggregate momentum toast
    if (chyronList.length >= 6 && chyronTick % 3 === 0) {
      const recentSubset = chyronList.slice(0, 8);
      const sumCents = recentSubset.reduce((acc, c) => acc + c.amount_cents, 0);
      const sumDollars = Math.floor(sumCents / 100).toLocaleString('en-US');

      host.innerHTML = `
        <div class="chyron-item" style="border-left-color: var(--emerald-400);">
          <span style="font-size: 20px;">⚡</span>
          <span class="chyron-name">${recentSubset.length} Pledges Streaming In • +$${sumDollars} Surge</span>
          <span class="chyron-badge" style="background: rgba(74, 222, 128, 0.15); color: var(--emerald-400);">Momentum</span>
        </div>
      `;
      return;
    }

    chyronIndex = (chyronIndex + 1) % chyronList.length;
    const item = chyronList[chyronIndex];
    const amountStr = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;

    host.innerHTML = `
      <div class="chyron-item">
        <span class="chyron-name">${escapeHTML(item.display_name)}</span>
        <span class="chyron-amount">${amountStr}</span>
        <span class="chyron-badge">Pledged</span>
      </div>
    `;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }

  // Run on DOM load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
