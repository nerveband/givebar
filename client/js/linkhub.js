/**
 * Surface Link Hub
 * ----------------
 * The operator hands these URLs to other machines during setup: the chart to an
 * AV laptop, the pad to volunteer phones. Home carries the full link table; the
 * working surfaces (/preview, /donations, /add) carry this compact disclosure so
 * the links are reachable without navigating back Home.
 *
 * One implementation, mounted identically on all three pages. The panel is
 * absolutely positioned, so revealing it never moves page content — that is what
 * keeps it out of the way of the pad's keypad, recent list, and submit button.
 *
 * Markup contract, per page:
 *   <div class="linkhub" data-linkhub data-linkhub-current="/add">
 *     <button type="button" class="lh-toggle" data-linkhub-toggle
 *             aria-expanded="false" aria-controls="linkhub-panel"
 *             aria-label="Surface links">…</button>
 *   </div>
 * The rows and the panel are built here so every page gets the same thing.
 */
(function () {
  'use strict';

  var SURFACES = [
    {
      path: '/chart',
      name: 'Fullscreen Bar Chart',
      icon: 'M216,40H40A16,16,0,0,0,24,56V168a16,16,0,0,0,16,16H96v16H80a8,8,0,0,0,0,16h96a8,8,0,0,0,0-16H160V184h56a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,168V56H216V168H40Zm72,32h32v16H112Z'
    },
    {
      path: '/donations',
      name: 'Manage Donations',
      icon: 'M88,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H96A8,8,0,0,1,88,64Zm128,56H96a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H96a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM40,48h8a8,8,0,0,1,8,8V88a8,8,0,0,1-16,0V64H40a8,8,0,0,1,0-16Z'
    },
    {
      path: '/presenter',
      name: 'Presenter View',
      icon: 'M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm112,64a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V224H104a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16H136V207.6A80.11,80.11,0,0,0,208,128Z'
    }
  ];

  var COPY_ICON = 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z';

  // Same clipboard helper as the Home hub: async clipboard first, hidden
  // textarea plus execCommand where the page is not a secure context.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        return selectionCopy(text);
      });
    }
    return Promise.resolve(selectionCopy(text));
  }

  function selectionCopy(text) {
    var scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(scratch);
    return ok;
  }

  function icon(path) {
    return '<svg class="lh-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">'
      + '<path d="' + path + '"/></svg>';
  }

  function buildPanel(container, panelId) {
    var origin = window.location.origin;
    var current = container.getAttribute('data-linkhub-current') || '';
    var isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

    var html = '';
    for (var i = 0; i < SURFACES.length; i++) {
      var s = SURFACES[i];
      html += '<div class="lh-row"' + (s.path === current ? ' data-current="true"' : '') + '>'
        + '<span class="lh-name">' + icon(s.icon) + s.name + '</span>'
        + '<span class="lh-url-wrap">'
        + '<input type="text" class="lh-url" readonly value="' + origin + s.path + '" aria-label="' + s.name + ' URL">'
        + '<button type="button" class="lh-copy" data-copy>' + icon(COPY_ICON)
        + '<span data-copy-label>Copy</span></button>'
        + '</span>'
        + '<span class="lh-status" data-copy-status aria-live="polite"></span>'
        + '</div>';
    }
    if (isLocalHost) {
      html += '<p class="lh-note">' + window.location.host + ' resolves only on this machine.</p>';
    }

    var panel = document.createElement('div');
    panel.className = 'lh-panel';
    panel.id = panelId;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Surface links');
    panel.hidden = true;
    panel.innerHTML = html;
    container.appendChild(panel);
    return panel;
  }

  // Same confirmation as the Home hub: the button flips to Copied, a live
  // region says so, the link is left selected as a manual fallback, and
  // everything resets after four seconds.
  function wireCopy(panel) {
    var buttons = panel.querySelectorAll('[data-copy]');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        var row = btn.closest('.lh-row');
        var label = btn.querySelector('[data-copy-label]');
        var status = row ? row.querySelector('[data-copy-status]') : null;
        var input = row ? row.querySelector('.lh-url') : null;
        var timer;

        btn.addEventListener('click', function () {
          copyText(input ? input.value : '').then(function (ok) {
            btn.classList.remove('copied', 'failed');
            btn.classList.add(ok ? 'copied' : 'failed');
            if (label) label.textContent = ok ? 'Copied' : 'Copy failed';
            if (status) {
              status.style.color = ok ? '#86efac' : '#fca5a5';
              status.textContent = ok
                ? 'Copied.'
                : 'Clipboard blocked. Select the link and copy it.';
            }
            if (input) { input.focus(); input.select(); }
            clearTimeout(timer);
            timer = setTimeout(function () {
              btn.classList.remove('copied', 'failed');
              if (label) label.textContent = 'Copy';
              if (status) status.textContent = '';
            }, 4000);
          });
        });
      })(buttons[i]);
    }
  }

  function mount(container) {
    var toggle = container.querySelector('[data-linkhub-toggle]');
    if (!toggle) return;

    var panelId = toggle.getAttribute('aria-controls') || 'linkhub-panel';
    var panel = buildPanel(container, panelId);
    wireCopy(panel);

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function () {
      setOpen(panel.hidden);
    });

    // Light dismiss, in the capture phase. The pad is worked one-handed while
    // money is being entered, so the tap that closes the panel is swallowed
    // instead of passed through to whatever sits underneath it: dismissing
    // never enters a stray keypad digit or fires the submit button.
    document.addEventListener('click', function (ev) {
      if (panel.hidden) return;
      if (container.contains(ev.target)) return;
      setOpen(false);
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || panel.hidden) return;
      setOpen(false);
      toggle.focus();
    });
  }

  function init() {
    var containers = document.querySelectorAll('[data-linkhub]');
    for (var i = 0; i < containers.length; i++) mount(containers[i]);
    var surfaceLinks = document.querySelectorAll('[data-surface-link]');
    for (var j = 0; j < surfaceLinks.length; j++) wireCopy(surfaceLinks[j]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
