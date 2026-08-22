/**
 * Givebar Rolling Odometer Reel Physics Engine
 * Hardware-accelerated CSS vertical rolling reels with staggered column settling.
 */

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
    this.digitTracks = [];

    this.render();
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

    this.updateReels(this.formatAmount(this.currentCents), false);
  }

  /**
   * Update or create digit reels
   * @param {string} formattedStr 
   * @param {boolean} animate 
   */
  updateReels(formattedStr, animate = true) {
    const chars = formattedStr.split('');
    
    // Check if existing structure matches for smooth continuous roll
    const existingElements = this.digitsContainer.querySelectorAll('.odometer-digit-reel, .odometer-separator');
    const structureMatches = existingElements.length === chars.length && Array.from(existingElements).every((el, i) => {
      const isDigit = /\d/.test(chars[i]);
      return isDigit ? el.classList.contains('odometer-digit-reel') : (el.classList.contains('odometer-separator') && el.textContent === chars[i]);
    });

    if (structureMatches && this.digitTracks.length > 0) {
      let digitIdx = 0;
      const digitCount = chars.filter(c => /\d/.test(c)).length;
      chars.forEach((char) => {
        if (/\d/.test(char)) {
          const targetDigit = parseInt(char, 10);
          const trackInfo = this.digitTracks[digitIdx];
          if (trackInfo) {
            trackInfo.targetDigit = targetDigit;
            const staggerDelay = (digitCount - 1 - digitIdx) * 45;
            trackInfo.track.style.transitionDelay = `${staggerDelay}ms`;
            trackInfo.track.style.transform = `translateY(-${targetDigit * 1.15}em)`;
          }
          digitIdx++;
        }
      });
      return;
    }

    // Otherwise perform full build
    this.digitsContainer.innerHTML = '';
    this.digitTracks = [];

    const digitCount = chars.filter(c => /\d/.test(c)).length;
    let digitIndex = 0;

    chars.forEach((char) => {
      if (/\d/.test(char)) {
        const targetDigit = parseInt(char, 10);
        
        const reel = document.createElement('div');
        reel.className = 'odometer-digit-reel';

        const track = document.createElement('div');
        track.className = 'odometer-digit-track';

        // Append digits 0 through 9
        for (let i = 0; i <= 9; i++) {
          const digit = document.createElement('div');
          digit.className = 'odometer-digit-val';
          digit.textContent = i.toString();
          track.appendChild(digit);
        }

        reel.appendChild(track);
        this.digitsContainer.appendChild(reel);

        // Stagger animation delay from right to left
        const staggerDelay = (digitCount - 1 - digitIndex) * 45;
        track.style.transitionDelay = `${staggerDelay}ms`;

        this.digitTracks.push({
          track,
          targetDigit
        });

        digitIndex++;
      } else {
        // Separator (comma or dot)
        const sep = document.createElement('span');
        sep.className = 'odometer-separator';
        sep.textContent = char;
        this.digitsContainer.appendChild(sep);
      }
    });
    // Force layout reflow before triggering transform
    if (animate) {
      requestAnimationFrame(() => {
        this.digitTracks.forEach(({ track, targetDigit }) => {
          track.style.transform = `translateY(-${targetDigit * 1.15}em)`;
        });
      });
    } else {
      this.digitTracks.forEach(({ track, targetDigit }) => {
        track.style.transition = 'none';
        track.style.transform = `translateY(-${targetDigit * 1.15}em)`;
        requestAnimationFrame(() => {
          track.style.transition = '';
        });
      });
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

    if (effectiveCents === this.currentCents && this.digitTracks.length > 0) {
      return;
    }

    this.currentCents = effectiveCents;
    this.updateReels(this.formatAmount(this.currentCents), true);
  }
}

// Export for browser global
if (typeof window !== 'undefined') {
  window.RollingOdometer = RollingOdometer;
  window.GivebarOdometer = RollingOdometer;
}
