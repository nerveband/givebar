/**
 * Givebar Rolling Odometer Reel Engine
 *
 * Each digit is a vertical strip of cells (0-9 repeated) translated with
 * transform only, so a roll is a single compositor-driven animation per digit.
 * Positions are absolute indices into the strip, never a modulo of the digit,
 * which is what makes 9 -> 0 roll UPWARD like a physical counter instead of
 * spinning backward through 8,7,6...
 *
 * Motion contract:
 *   purpose      confirm that the total changed and by roughly how much
 *   trigger      set()/update() with a higher value
 *   duration     --dur-roll (900ms) --ease-out, per-digit stagger, left settles last
 *   settled      every reel parked on its target digit, transitionDelay cleared
 *   interrupt    a newer value retargets the same reels mid-flight; no queueing,
 *                the newest value always wins and reels converge on it
 *   reduced      digits land on the settled value with no strip travel
 */

const ODO_STRIP_REPEATS = 3;   // cells 0..29, digit = index % 10
const ODO_NORMALIZE_AT = 10;   // rewind the strip once a reel passes one full turn
const ODO_MAX_STAGGER_MS = 260;
const ODO_STEP_STAGGER_MS = 40;

class RollingOdometer {
  /**
   * @param {HTMLElement} container - DOM element to mount the odometer
   * @param {Object} options - Configuration options
   * @param {string} [options.currency='$'] - Currency prefix symbol
   * @param {boolean} [options.showCents=false] - Whether to render .00 cents
   * @param {boolean} [options.allowBackward=false] - If false, enforces no-backward-odometer rule
   * @param {number} [options.initialValue=0] - Starting value in cents
   */
  constructor(container, options = {}) {
    this.container = container;
    this.currency = options.currency !== undefined ? options.currency : '$';
    this.showCents = Boolean(options.showCents);
    this.allowBackward = Boolean(options.allowBackward);

    this.currentCents = options.initialValue || 0;
    this.peakCents = this.currentCents;
    /** @type {{reel: HTMLElement, track: HTMLElement, pos: number}[]} */
    this.reels = [];
    this.separators = [];

    this.render();
  }

  /**
   * @returns {boolean} true when the viewer asked for reduced motion
   */
  prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Format cents to display string
   * @param {number} cents
   * @returns {string} e.g. "1,250,000" or "500"
   */
  formatAmount(cents) {
    const dollars = Math.floor(cents / 100);
    if (this.showCents) {
      const centPart = (cents % 100).toString().padStart(2, '0');
      return `${dollars.toLocaleString('en-US')}.${centPart}`;
    }
    return dollars.toLocaleString('en-US');
  }

  /**
   * Initial DOM layout setup
   */
  render() {
    this.container.innerHTML = '';
    this.container.classList.add('odometer-wrapper');

    if (this.currency) {
      const currSpan = document.createElement('span');
      currSpan.className = 'odometer-currency';
      currSpan.textContent = this.currency;
      this.container.appendChild(currSpan);
    }

    const valueSpan = document.createElement('span');
    valueSpan.className = 'odometer-digits-container';
    valueSpan.style.display = 'inline-flex';
    valueSpan.style.alignItems = 'baseline';
    this.container.appendChild(valueSpan);
    this.digitsContainer = valueSpan;

    this.reels = [];
    this.updateReels(this.formatAmount(this.currentCents), false);
  }

  /**
   * @param {{track: HTMLElement, pos: number}} reel
   */
  _paint(reel) {
    reel.track.style.transform = `translate3d(0, calc(${-reel.pos} * var(--odo-cell, 1.12em)), 0)`;
  }

  /**
   * Rebuild the reel/separator DOM, preserving the strip position of reels that
   * survive the change. Alignment is anchored to the RIGHT so that crossing a
   * digit boundary ($999 -> $1,000) keeps the low-order digits rolling
   * continuously instead of snapping every column back to zero.
   * @param {string[]} chars
   */
  _build(chars) {
    const previousPositions = this.reels.map(r => r.pos);
    const nextDigitCount = chars.filter(c => /\d/.test(c)).length;
    const shift = nextDigitCount - previousPositions.length;

    this.digitsContainer.innerHTML = '';
    this.reels = [];

    let digitIndex = 0;
    for (const char of chars) {
      if (/\d/.test(char)) {
        const reel = document.createElement('div');
        reel.className = 'odometer-digit-reel';

        const track = document.createElement('div');
        track.className = 'odometer-digit-track';
        track.style.transition = 'none';

        for (let i = 0; i < ODO_STRIP_REPEATS * 10; i++) {
          const cell = document.createElement('div');
          cell.className = 'odometer-digit-val';
          cell.textContent = (i % 10).toString();
          track.appendChild(cell);
        }

        reel.appendChild(track);
        this.digitsContainer.appendChild(reel);

        const carriedIndex = digitIndex - shift;
        const seededPos = carriedIndex >= 0 && carriedIndex < previousPositions.length
          ? previousPositions[carriedIndex] % 10
          : 0;

        const entry = { reel, track, pos: seededPos };
        this._paint(entry);
        this.reels.push(entry);
        digitIndex++;
      } else {
        const sep = document.createElement('span');
        sep.className = 'odometer-separator';
        sep.textContent = char;
        this.digitsContainer.appendChild(sep);
      }
    }

    // Commit the seeded (un-transitioned) positions before any target is applied.
    void this.digitsContainer.offsetHeight;
    for (const entry of this.reels) {
      entry.track.style.transition = '';
    }
  }

  /**
   * @param {string} formattedStr
   * @param {boolean} animate
   */
  updateReels(formattedStr, animate = true) {
    const chars = formattedStr.split('');
    const digitChars = chars.filter(c => /\d/.test(c));

    const existing = this.digitsContainer.querySelectorAll('.odometer-digit-reel, .odometer-separator');
    const structureMatches = this.reels.length > 0
      && existing.length === chars.length
      && Array.from(existing).every((el, i) => (
        /\d/.test(chars[i])
          ? el.classList.contains('odometer-digit-reel')
          : (el.classList.contains('odometer-separator') && el.textContent === chars[i])
      ));

    if (!structureMatches) {
      this._build(chars);
    }

    const targets = digitChars.map(c => parseInt(c, 10));
    this._applyTargets(targets, animate && !this.prefersReducedMotion());
  }

  /**
   * @param {number[]} targets - target digit (0-9) per reel, left to right
   * @param {boolean} animate
   */
  _applyTargets(targets, animate) {
    if (this.reels.length !== targets.length) return;

    if (!animate) {
      for (let i = 0; i < this.reels.length; i++) {
        const entry = this.reels[i];
        entry.track.style.transition = 'none';
        entry.track.style.transitionDelay = '0ms';
        entry.pos = targets[i];
        this._paint(entry);
      }
      void this.digitsContainer.offsetHeight;
      for (const entry of this.reels) {
        entry.track.style.transition = '';
      }
      return;
    }

    // Pass 1 — rewind any reel that has wandered past one full turn back onto
    // the first strip repeat. Visually identical (same digit showing), but it
    // guarantees the forward roll below never runs off the end of the strip.
    let rewound = false;
    for (const entry of this.reels) {
      if (entry.pos >= ODO_NORMALIZE_AT) {
        entry.track.style.transition = 'none';
        entry.pos = entry.pos % 10;
        this._paint(entry);
        rewound = true;
      }
    }
    if (rewound) {
      void this.digitsContainer.offsetHeight;
    }

    // Pass 2 — roll forward. Right-most digit leads, left-most settles last,
    // mirroring how a carry propagates on a physical counter.
    const count = this.reels.length;
    const stagger = count > 1
      ? Math.min(ODO_STEP_STAGGER_MS, ODO_MAX_STAGGER_MS / (count - 1))
      : 0;

    for (let i = 0; i < count; i++) {
      const entry = this.reels[i];
      const delta = (targets[i] - (entry.pos % 10) + 10) % 10;
      entry.track.style.transition = '';
      entry.track.style.transitionDelay = `${Math.round((count - 1 - i) * stagger)}ms`;
      entry.pos = entry.pos + delta;
      this._paint(entry);
    }
  }

  /**
   * Update the odometer to a new value
   * @param {number} newCents
   * @param {Object} [opts]
   * @param {boolean} [opts.force=false] - Override the no-backward rule
   */
  set(newCents, opts = {}) {
    const force = Boolean(opts.force);
    let effectiveCents = newCents;

    if (!this.allowBackward && !force) {
      if (newCents < this.peakCents) {
        // Enforce no-backward rule: freeze at peak
        effectiveCents = this.peakCents;
      } else {
        this.peakCents = newCents;
      }
    } else {
      this.peakCents = newCents;
    }

    if (effectiveCents === this.currentCents && this.reels.length > 0) {
      return false;
    }

    const increased = effectiveCents > this.currentCents;
    this.currentCents = effectiveCents;
    this.updateReels(this.formatAmount(this.currentCents), true);
    return increased;
  }

  update(newCents, opts = {}) {
    return this.set(newCents, opts);
  }

  getValue() {
    return this.currentCents;
  }
}

// Export for browser global
if (typeof window !== 'undefined') {
  window.RollingOdometer = RollingOdometer;
  window.GivebarOdometer = RollingOdometer;
}
