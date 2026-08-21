/**
 * Givebar — Main Ballroom Screen Controller (/stage)
 * Hardware-accelerated rolling odometer, canvas confetti, live theme updates
 */

(function () {
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const API_BASE = (basePath === '/' || basePath === '') ? '/api' : `${basePath}/api`;

  let odometer = null;
  let lastSeq = 0;
  let lastConfettiTrigger = 0;
  let chyronList = [];
  let chyronIndex = 0;
  let currentQrUrl = '';
  let currentQrStyle = '';
  let currentQrBadge = '';

  // Confetti Particle Engine
  const confettiCanvas = document.getElementById('confetti-canvas');
  const ctx = confettiCanvas?.getContext('2d');
  let particles = [];
  let confettiAnimationId = null;

  function resizeCanvas() {
    if (!confettiCanvas) return;
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function fireConfettiBurst() {
    if (!confettiCanvas || !ctx) return;
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
    if (!ctx || !confettiCanvas) return;
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
    if (odoContainer && typeof window.RollingOdometer !== 'undefined') {
      odometer = new window.RollingOdometer(odoContainer, {
        currency: '$',
        showCents: false,
        allowBackward: false,
        initialValue: 0
      });
    }

    startPolling();
    startChyronRotator();
  }

  // --- 1-Second State Polling ---
  async function fetchState() {
    try {
      const res = await fetch(`${API_BASE}/state?role=stage&since=${lastSeq}`);
      if (!res.ok) return;

      const data = await res.json();
      lastSeq = data.seq;

      // 1. Update Event Headers
      const eventNameEl = document.getElementById('event-name');
      const eventSubEl = document.getElementById('event-subtitle');
      if (eventNameEl && data.event_name) eventNameEl.textContent = data.event_name;
      if (eventSubEl && data.event_subtitle) eventSubEl.textContent = data.event_subtitle;

      // 2. Update Odometer Total
      if (odometer && data.total_raised_cents !== undefined) {
        odometer.set(data.total_raised_cents);
      }

      // 3. Update Progress Bar & Percentage
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

      // 4. Update Matching Grant Banner
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

      // 5. Update Freeze Indicator
      const freezeEl = document.getElementById('freeze-indicator');
      if (freezeEl) {
        freezeEl.style.display = data.is_frozen ? 'block' : 'none';
      }

      // 6. Confetti Trigger Check
      if (data.confetti_trigger && data.confetti_trigger > lastConfettiTrigger) {
        lastConfettiTrigger = data.confetti_trigger;
        fireConfettiBurst();
      }

      // 7. Update Adaptive Scannable QR Code
      const qrUrl = data.qr_donate_url || 'https://give.hope.org/donate';
      const qrStyle = data.qr_style || 'dots';
      const qrBadge = data.qr_center_icon || 'star';

      if (qrUrl !== currentQrUrl || qrStyle !== currentQrStyle || qrBadge !== currentQrBadge) {
        currentQrUrl = qrUrl;
        currentQrStyle = qrStyle;
        currentQrBadge = qrBadge;
        const qrImg = document.getElementById('stage-qr-img');
        if (qrImg) {
          qrImg.src = `${API_BASE}/qr?url=${encodeURIComponent(currentQrUrl)}&style=${encodeURIComponent(qrStyle)}&center=${encodeURIComponent(qrBadge)}&size=200`;
        }
      }

      // 8. Apply Live Theme Tokens
      if (data.theme) {
        document.documentElement.style.setProperty('--brand-hue', data.theme.hue);
        document.documentElement.style.setProperty('--brand-chroma', data.theme.chroma);
        if (data.theme.radius_px) {
          document.documentElement.style.setProperty('--brand-radius', `${data.theme.radius_px}px`);
        }
      }

      // 9. Update Chyrons List
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
      if (chyronList.length === 0) return;

      const item = chyronList[chyronIndex % chyronList.length];
      chyronIndex++;

      const donorEl = document.getElementById('chyron-donor');
      const metaEl = document.getElementById('chyron-meta');
      const hostEl = document.getElementById('chyron-host');

      if (!donorEl || !metaEl || !hostEl) return;

      const dollars = `$${Math.floor(item.amount_cents / 100).toLocaleString('en-US')}`;

      // Smooth fade transition
      hostEl.style.opacity = '0.2';
      setTimeout(() => {
        donorEl.textContent = `${dollars} — ${item.display_name}`;
        metaEl.textContent = `Verified Live Gift`;
        hostEl.style.opacity = '1';
      }, 200);

    }, 4500); // Rotate every 4.5 seconds
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
