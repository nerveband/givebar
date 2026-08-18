/**
 * Givebar — In-Browser Client State Engine (Static / Offline / Demo Mode)
 * Activates automatically when running as a static site without a backend server.
 * Uses BroadcastChannel and localStorage for instant cross-tab sync across /stage, /control, /entry, /emcee.
 */

(function () {
  // If running with a live Givebar server, let native server handle requests
  const isStaticSite = window.location.protocol === 'file:' || 
    window.location.hostname.includes('here.now') || 
    window.location.hostname.includes('netlify.app') || 
    window.location.hostname.includes('github.io') ||
    window.location.hostname.includes('share.wavedepth.com');

  if (!isStaticSite) {
    return; // Native Bun server is present
  }

  console.log('[Givebar] Running in static/demo mode with in-browser ledger sync.');

  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('givebar_channel') : null;

  // Local state storage
  function getLedger() {
    return JSON.parse(localStorage.getItem('givebar_demo_ledger') || '[]');
  }

  function saveLedger(ledger) {
    localStorage.setItem('givebar_demo_ledger', JSON.stringify(ledger));
    notifyUpdate();
  }

  function getEventState() {
    const defaultState = {
      event_name: 'Annual Gala & Benefit Auction',
      goal_cents: 50000000,
      match_pool_cents: 0,
      match_total_cents: 0,
      match_ratio: 1.0,
      is_match_active: 0,
      match_sponsor_title: 'Board of Directors Matching Grant',
      is_frozen: 0,
      manual_override_cents: null,
      qr_donate_url: 'https://example.org/donate?source=stage-qr',
      milestones_json: JSON.stringify([
        { cents: 10000000, label: 'Foundation' },
        { cents: 25000000, label: 'Staffing' },
        { cents: 50000000, label: 'Legal Clinic' },
        { cents: 100000000, label: 'Expansion' }
      ]),
      odometer_floor_cents: 0,
      confetti_trigger: 0,
      updated_at: Date.now()
    };

    const stored = localStorage.getItem('givebar_demo_state');
    return stored ? { ...defaultState, ...JSON.parse(stored) } : defaultState;
  }

  function saveEventState(state) {
    localStorage.setItem('givebar_demo_state', JSON.stringify(state));
    notifyUpdate();
  }

  function notifyUpdate() {
    if (channel) channel.postMessage({ type: 'STATE_CHANGED', timestamp: Date.now() });
  }

  // Fold ledger
  function fold() {
    const events = getLedger();
    let directRaised = 0;
    let matchApplied = 0;
    let voidCount = 0;
    const activeMap = new Map();
    const allRecords = [];

    for (const ev of events) {
      if (ev.event_type === 'match_apply') {
        matchApplied += ev.amount_cents;
        continue;
      }
      if (ev.event_type === 'create') {
        const item = { ...ev, is_voided: false };
        activeMap.set(ev.donation_id, item);
        allRecords.push(item);
      } else if (ev.event_type === 'void') {
        const existing = activeMap.get(ev.donation_id);
        if (existing) {
          existing.is_voided = true;
          activeMap.delete(ev.donation_id);
          voidCount++;
        }
      }
    }

    for (const rec of activeMap.values()) {
      directRaised += rec.amount_cents;
    }

    return {
      direct_raised_cents: directRaised,
      match_applied_cents: matchApplied,
      total_raised_cents: directRaised + matchApplied,
      active_donation_count: activeMap.size,
      void_count: voidCount,
      active_donations: Array.from(activeMap.values()),
      all_records: allRecords,
      latest_seq: events.length
    };
  }

  // Intercept window.fetch for /api/* in demo mode
  const originalFetch = window.fetch;
  window.fetch = async function (url, options = {}) {
    const urlStr = typeof url === 'string' ? url : url.url;
    if (!urlStr.includes('/api/')) {
      return originalFetch(url, options);
    }

    const parsedUrl = new URL(urlStr, window.location.origin);
    const pathname = parsedUrl.pathname;
    const method = (options.method || 'GET').toUpperCase();

    // 1. GET /api/state
    if (pathname.startsWith('/api/state')) {
      const role = parsedUrl.searchParams.get('role') || 'stage';
      const eventState = getEventState();
      const folded = fold();
      const now = Date.now();

      if (role === 'stage') {
        const displayTotal = eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents;
        const milestones = JSON.parse(eventState.milestones_json || '[]');
        const chyrons = folded.active_donations.map(d => ({
          donation_id: d.donation_id,
          display_name: d.is_anonymous ? 'Anonymous Supporter' : d.donor_name,
          amount_cents: d.amount_cents,
          created_at: d.created_at
        }));

        return new Response(JSON.stringify({
          seq: folded.latest_seq,
          event_name: eventState.event_name,
          total_raised_cents: displayTotal,
          true_total_raised_cents: folded.total_raised_cents,
          goal_cents: eventState.goal_cents,
          percent: Math.min(100, Math.round((displayTotal / eventState.goal_cents) * 1000) / 10),
          is_match_active: Boolean(eventState.is_match_active),
          match_sponsor_title: eventState.match_sponsor_title,
          match_pool_cents: eventState.match_pool_cents,
          is_frozen: Boolean(eventState.is_frozen),
          qr_donate_url: eventState.qr_donate_url,
          milestones,
          chyrons,
          confetti_trigger: eventState.confetti_trigger,
          server_time: now
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (role === 'emcee') {
        const total = eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents;
        const topGifts = [...folded.active_donations].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 5);
        return new Response(JSON.stringify({
          seq: folded.latest_seq,
          event_name: eventState.event_name,
          total_raised_cents: total,
          direct_raised_cents: folded.direct_raised_cents,
          match_applied_cents: folded.match_applied_cents,
          goal_cents: eventState.goal_cents,
          percent: Math.min(100, Math.round((total / eventState.goal_cents) * 1000) / 10),
          active_donation_count: folded.active_donation_count,
          top_gifts: topGifts,
          recent_gifts: folded.active_donations.slice(0, 10),
          is_match_active: Boolean(eventState.is_match_active),
          match_pool_cents: eventState.match_pool_cents,
          is_frozen: Boolean(eventState.is_frozen),
          server_time: now
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (role === 'control') {
        return new Response(JSON.stringify({
          seq: folded.latest_seq,
          event_state: eventState,
          folded: {
            total_raised_cents: folded.total_raised_cents,
            direct_raised_cents: folded.direct_raised_cents,
            match_applied_cents: folded.match_applied_cents,
            active_donation_count: folded.active_donation_count,
            void_count: folded.void_count
          },
          staged_chyrons: folded.active_donations.map(d => ({
            ...d,
            elapsed_sec: 10,
            remaining_delay_sec: 0,
            is_live_on_stage: true,
            is_yanked: false
          })),
          recent_events: getLedger().slice(-50).reverse(),
          server_time: now
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (role === 'entry') {
        const vid = parsedUrl.searchParams.get('volunteer_id');
        const personalLog = folded.all_records.filter(d => !vid || d.entered_by === vid).slice(-15).reverse();
        return new Response(JSON.stringify({
          seq: folded.latest_seq,
          event_name: eventState.event_name,
          total_raised_cents: folded.total_raised_cents,
          goal_cents: eventState.goal_cents,
          personal_log: personalLog,
          server_time: now
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 2. PUT or POST /api/donation
    if (pathname.startsWith('/api/donation')) {
      const parts = pathname.split('/').filter(Boolean);
      const isVoid = parts.length === 4 && parts[3] === 'void';
      const body = JSON.parse(options.body || '{}');

      if (isVoid) {
        const donationId = parts[2];
        const ledger = getLedger();
        ledger.push({
          seq: ledger.length + 1,
          event_type: 'void',
          donation_id: donationId,
          amount_cents: 0,
          created_at: Date.now()
        });
        saveLedger(ledger);
        return new Response(JSON.stringify({ ok: true, voided: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      // Record donation
      const ledger = getLedger();
      const donationId = parts[2] || body.donation_id || `don_${Date.now()}`;
      
      // Check card serial collision
      if (body.card_number) {
        const existing = ledger.find(e => e.card_number === body.card_number && e.event_type !== 'void');
        if (existing) {
          return new Response(JSON.stringify({
            error: 'CARD_COLLISION',
            message: `Pledge card ${body.card_number} was already entered.`,
            card_number: body.card_number
          }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
      }

      ledger.push({
        seq: ledger.length + 1,
        event_type: 'create',
        donation_id: donationId,
        amount_cents: body.amount_cents,
        donor_name: body.donor_name,
        display_name: body.display_name || body.donor_name,
        is_anonymous: Boolean(body.is_anonymous),
        payment_method: body.payment_method || 'pledge',
        card_number: body.card_number || null,
        entered_by: body.entered_by || 'V-1',
        notes: body.notes || null,
        created_at: Date.now()
      });

      // Matching check
      const eventState = getEventState();
      if (eventState.is_match_active && eventState.match_pool_cents > 0) {
        const matchAmt = Math.min(body.amount_cents, eventState.match_pool_cents);
        ledger.push({
          seq: ledger.length + 1,
          event_type: 'match_apply',
          donation_id: `match_${donationId}`,
          amount_cents: matchAmt,
          donor_name: eventState.match_sponsor_title,
          display_name: eventState.match_sponsor_title,
          created_at: Date.now()
        });
        eventState.match_pool_cents -= matchAmt;
        saveEventState(eventState);
      }

      saveLedger(ledger);
      return new Response(JSON.stringify({ ok: true, seq: ledger.length, donation_id: donationId }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. POST /api/control
    if (pathname === '/api/control') {
      const body = JSON.parse(options.body || '{}');
      const state = getEventState();

      if (body.action === 'freeze') state.is_frozen = 1;
      if (body.action === 'unfreeze') state.is_frozen = 0;
      if (body.action === 'trigger_confetti') state.confetti_trigger = Date.now();
      if (body.action === 'set_override') state.manual_override_cents = body.override_cents;
      if (body.action === 'clear_override') state.manual_override_cents = null;
      if (body.action === 'set_goal') state.goal_cents = body.goal_cents;
      if (body.action === 'set_match') {
        if (typeof body.is_active === 'boolean') state.is_match_active = body.is_active ? 1 : 0;
        if (body.pool_cents !== undefined) state.match_pool_cents = body.pool_cents;
        if (body.sponsor_title) state.match_sponsor_title = body.sponsor_title;
      }
      if (body.action === 'reset_ledger') {
        localStorage.removeItem('givebar_demo_ledger');
        localStorage.removeItem('givebar_demo_state');
        notifyUpdate();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      saveEventState(state);
      return new Response(JSON.stringify({ ok: true, state }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 4. POST /api/rehearsal
    if (pathname === '/api/rehearsal') {
      const body = JSON.parse(options.body || '{}');
      const mode = body.mode || 'single';
      const donors = ['Dr. Arthur Vance', 'The Sterling Trust', 'Elena Rostova', 'Maya Lin', 'Anonymous Supporter'];
      const tiers = [5000000, 2500000, 1000000, 500000, 250000, 100000];

      const count = mode === 'burst' ? 5 : 1;
      const ledger = getLedger();

      for (let i = 0; i < count; i++) {
        const amount = tiers[Math.floor(Math.random() * tiers.length)];
        const name = donors[Math.floor(Math.random() * donors.length)];
        ledger.push({
          seq: ledger.length + 1,
          event_type: 'create',
          donation_id: `don_demo_${Date.now()}_${i}`,
          amount_cents: amount,
          donor_name: name,
          display_name: name === 'Anonymous Supporter' ? 'Anonymous Supporter' : name,
          is_anonymous: name === 'Anonymous Supporter',
          payment_method: 'pledge',
          card_number: `#0${Math.floor(Math.random() * 400 + 100)}`,
          entered_by: 'REHEARSAL_BOT',
          notes: 'Table ' + (Math.floor(Math.random() * 20) + 1),
          created_at: Date.now()
        });
      }

      saveLedger(ledger);
      return new Response(JSON.stringify({ ok: true, mode, count }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 5. GET /api/qr
    if (pathname === '/api/qr') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect width="200" height="200" fill="#fff" rx="8"/><rect x="20" y="20" width="50" height="50" fill="#000"/><rect x="130" y="20" width="50" height="50" fill="#000"/><rect x="20" y="130" width="50" height="50" fill="#000"/><rect x="80" y="80" width="40" height="40" fill="#E2B755"/></svg>`;
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
    }

    return originalFetch(url, options);
  };
})();
