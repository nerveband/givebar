/**
 * Givebar live state channel.
 *
 * One connection model for every live surface:
 *   1. Server-sent events carry a frame whenever the projection changes and a
 *      `ping` every two seconds when it does not. EventSource reconnects on
 *      its own after a network drop; we only close it on an explicit server
 *      error frame (for example, a session that expired).
 *   2. Polling runs as the fallback: every `pollMs` while the stream is not
 *      open, and every `watchdogMs` regardless, so a silently dead stream is
 *      caught within a few seconds.
 *   3. `onLiveness(ok, lastConfirmedAt)` fires each second so the page can
 *      show "Reconnecting" honestly instead of freezing on stale figures.
 *
 * Usage:
 *   GivebarLive.connect({ role: 'stage', onState, onLiveness });
 */
(function () {
  'use strict';

  const STALE_MS = 6000;

  function connect(options) {
    const role = options.role;
    const pollMs = options.pollMs || 2000;
    const watchdogMs = options.watchdogMs || 10000;
    const authenticated = role === 'control' || role === 'entry';
    let source = null;
    let lastConfirmedAt = 0;
    let lastPollAt = 0;
    let stopped = false;
    let inFlight = false;

    function confirmed(serverTime) {
      lastConfirmedAt = Date.now();
      if (typeof serverTime === 'number' && options.onServerTime) options.onServerTime(serverTime);
    }

    function openStream() {
      if (stopped || !window.EventSource || source) return;
      source = new EventSource('/api/state/stream?role=' + encodeURIComponent(role));
      source.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          confirmed(data.server_time);
          options.onState(data);
        } catch (_) { /* malformed frame: the watchdog poll will recover */ }
      };
      source.addEventListener('ping', event => {
        try { confirmed(JSON.parse(event.data).server_time); } catch (_) { confirmed(); }
      });
      source.addEventListener('error', event => {
        // A server-authored error frame (not a network hiccup) carries data.
        if (event.data) {
          source.close();
          source = null;
          if (authenticated) location.replace('/signin?next=' + encodeURIComponent(location.pathname));
        }
      });
    }

    async function poll() {
      if (stopped || inFlight) return;
      inFlight = true;
      lastPollAt = Date.now();
      try {
        const response = await fetch('/api/state?role=' + encodeURIComponent(role), { credentials: 'same-origin', headers: { 'Cache-Control': 'no-cache' } });
        if (response.status === 401 && authenticated) {
          location.replace('/signin?next=' + encodeURIComponent(location.pathname));
          return;
        }
        if (!response.ok) return;
        const data = await response.json();
        confirmed(data.server_time);
        options.onState(data);
      } catch (_) {
        /* offline: liveness tick reports it */
      } finally {
        inFlight = false;
      }
    }

    function tick() {
      if (stopped) return;
      const streamOpen = source && source.readyState === 1;
      const since = Date.now() - lastPollAt;
      if ((!streamOpen && since >= pollMs) || since >= watchdogMs) poll();
      if (!source && window.EventSource) openStream();
      if (options.onLiveness) options.onLiveness(lastConfirmedAt > 0 && Date.now() - lastConfirmedAt < STALE_MS, lastConfirmedAt);
    }

    poll();
    openStream();
    const timer = setInterval(tick, 1000);

    return {
      refresh: poll,
      stop() {
        stopped = true;
        clearInterval(timer);
        if (source) source.close();
        source = null;
      }
    };
  }

  window.GivebarLive = { connect, STALE_MS };
})();
