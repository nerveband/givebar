# Givebar ⚡

> The open-source, bulletproof live fundraising thermometer and stage presentation suite for high-stakes nonprofit galas and benefit auctions ($100k–$2M+ live appeals).

---

## Overview

Givebar replaces fragile, multi-tab spreadsheets during live fundraising appeals where hundreds of thousands or millions of dollars are pledged in 30 to 45 minutes.

Everything runs on a single self-contained process backed by embedded SQLite in WAL mode with 1-second live synchronization. No external databases, WebSocket dropouts, or cloud queue dependencies.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            GIVEBAR LIVE TOPOLOGY                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   📱 VOLUNTEER PLEDGE PADS          🎛️ EVENT CONTROL ROOM                   │
│   (Mobile 1-Thumb Entry)            (8s Review Queue & Settings)            │
│   [ Table Volunteer Phones ] ────>  [ Director & AV Laptop ]                │
│                                                │                            │
│                                                ▼ 8s Review Horizon          │
│   🎤 PODIUM SCREEN                  🖥️ MAIN BALLROOM SCREEN                 │
│   (Emcee OLED Confidence Monitor)   (1080p Projector / LED Wall HUD)        │
│   [ Stage Downstage Tablet ]        [ 130px Odometer & Lower Third Ticker ] │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Four Live Surfaces

| Surface | Path | Primary Device | Purpose |
| :--- | :--- | :--- | :--- |
| **Suite Launcher** | `/` | Any Browser | One-click launchpad for all live-event surfaces. |
| **Main Ballroom Screen** | `/stage` | 1080p Projector / LED Wall | 130px rolling odometer, concentric progress line, matching grant banner, scannable QR code, and lower-third chyron ticker. |
| **Event Control Room** | `/control` | AV Tech / Director Laptop | 3-tab operational deck: 8-second staging queue with 1-click hold button, audited ledger list, live settings editor, and tech rehearsal simulator. |
| **Podium Screen** | `/emcee` | Podium iPad / Teleprompter | High-contrast OLED black display with 72px total, 3-second glance vocal shoutout cards (with phonetic guide & table number), and milestone countdown. |
| **Volunteer Pledge Pad** | `/entry` | Volunteer Phones / Tablets | Mobile-optimized 2-stage progressive disclosure in the bottom thumb zone with ask-tier presets, custom numpad, $9,500 guardrail modal, offline outbox, and 8-second floating undo toast. |

---

## Core Architectural Invariants

1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite stream (`create`, `amend`, `void`, `match_apply`, `match_release`). The verified balance is a deterministic fold over the ledger.
2. **Unified 8-Second Staging Horizon**: Both ballroom display totals and lower-third chyrons pass through an 8-second review buffer. If an operator clicks **"Hold from Stage"** or a volunteer taps **"↺ Undo"** within 8 seconds, the typo never reaches the ballroom screen or odometer.
3. **$\ge \$9,500$ Major Gift Guardrail**: Server-enforced verification intercept modal to prevent accidental extra-zero submissions ($50k $\rightarrow$ $500k).
4. **Physical Pledge Card Duplicate Check**: Enforces unique card serials (`#0412`) in $O(1)$, rejecting duplicates with detailed resolution guidance.
5. **No-Backward Ballroom Screen Rule**: Downward voids or corrections hold the ballroom screen total steady, absorbing the difference into future gifts rather than rolling backward on stage.
6. **Strict Privacy Shield**: Anonymous donors display as *"Anonymous Supporter — $X"* on stage; real donor names are completely stripped before reaching the ballroom projection feed.
7. **Pure Matching Grant Folds**: Matching funds are derived deterministically. Voiding or amending a matched gift emits compensating `match_release` events, keeping sponsor pools 100% auditable.

---

## Zero-Code In-App Customization

Non-technical event directors and gala chairs can customize the entire gala in real time from the **Event Settings** tab in the Control Room (`/control`):

* **Event Identity**: Event title, subtitle, organization, and donation QR code destination link.
* **Fundraising Goal**: Target goal amount, milestone celebration percentages (25%, 50%, 75%, 100%), and automatic confetti celebration triggers.
* **Theme Palettes**: Live visual swatches (**Champagne Gold**, **Royal Sapphire**, **Forest Emerald**, **Ruby Red**, or Custom HEX) that update colors across all screens instantly.
* **Volunteer Quick-Amounts**: Configurable ask-tier buttons ($10k, $5k, $2.5k, $1k, $500, or custom amounts).
* **Matching Donor Grants**: Sponsor name, matching pool amount, match ratio (1:1 double, 2:1 triple), and live active toggle.
* **Passcode Protection**: Optional PIN gates for the Control Room and Volunteer Pads.

---

## Quickstart

### Running with Bun (Recommended)

```bash
# Clone the repository
git clone https://github.com/nerveband/givebar.git
cd givebar

# Run development server with live reload
bun dev

# Run automated test suite (36 tests)
bun test

# Build static distribution artifacts
bun run build:static
```

### Running with Docker

```bash
# Build and run container
docker build -t givebar .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name givebar givebar
```

---

## Live Rehearsal & Gala Verification Checklist

Before doors open on gala night:
1. **Tech Rehearsal**: Open `/control`, switch to Tab 3 (Rehearsal), click **"Test 7-Pledge Burst"**, and verify the 1080p `/stage` odometer rolls forward smoothly at 60 FPS.
2. **Hold Verification**: Click **"Inject Test Typo"** in `/control`, click the red **"Hold from Stage"** button within 8 seconds, and confirm the typo name and amount never appear on `/stage`.
3. **Major Gift Guardrail**: Open `/entry`, enter `$50,000`, and confirm the high-contrast confirmation intercept modal appears before submission.
4. **Duplicate Card Test**: Enter a pledge with card `#0101`; attempt to enter another with `#0101` and verify the inline warning prevents duplicate entry without wiping form data.
5. **Stage Confetti**: Trigger confetti from `/control` and verify celebration particles burst across `/stage`.
6. **Finance Reconciliation**: Click **"Download Finance CSV"** and verify all events balance down to the exact cent.

---

## License

MIT License. Designed for nonprofit galas and benefit auctions worldwide.
