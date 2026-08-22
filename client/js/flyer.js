/**
 * Givebar — Banquet Table Placards & Giving Tent Generator
 */

(function () {
  async function loadFlyerData() {
    try {
      const res = await fetch('api/state?role=stage');
      if (!res.ok) return;
      const data = await res.json();

      const nameEl = document.getElementById('flyer-event-name');
      const subEl = document.getElementById('flyer-event-sub');
      const trustEl = document.getElementById('flyer-trust-badge');
      const qrImg = document.getElementById('flyer-qr-img');
      const qrText = document.getElementById('flyer-qr-url-text');
      const matchEl = document.getElementById('flyer-match-snippet');

      if (nameEl && data.event_name) nameEl.textContent = data.event_name;
      if (subEl && data.event_subtitle) subEl.textContent = data.event_subtitle;
      if (trustEl && data.trust_badge_text) trustEl.textContent = data.trust_badge_text;
      
      const donateUrl = data.qr_donate_url || 'https://give.hope.org/donate';
      if (qrImg) qrImg.src = `api/qr?url=${encodeURIComponent(donateUrl)}&margin=2&v=4.2.0`;
      if (qrText) qrText.textContent = donateUrl;

      if (matchEl) {
        if (data.is_match_active) {
          matchEl.textContent = `Double Your Impact: Active Matching Grant in Effect`;
          matchEl.style.display = 'block';
        } else {
          matchEl.textContent = `Givebar Live Gala Appeal`;
        }
      }
    } catch (err) {
      console.warn('Could not load flyer state:', err);
    }
  }

  document.addEventListener('DOMContentLoaded', loadFlyerData);
})();
