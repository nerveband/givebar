# Givebar

> The open-source live fundraising thermometer and stage presentation suite for high-stakes nonprofit galas and benefit auctions ($100k–$2M+ live appeals).

---

## Overview

Givebar replaces fragile, multi-tab spreadsheets during live fundraising appeals where hundreds of thousands or millions of dollars are pledged in 30 to 45 minutes.

Everything runs on a single self-contained process backed by embedded SQLite in WAL mode with 1-second live synchronization. No external databases, WebSocket dropouts, or cloud queue dependencies.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            GIVEBAR LIVE TOPOLOGY                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   VOLUNTEER PLEDGE PADS             EVENT CONTROL ROOM                      │
│   (Mobile 1-Thumb Entry)            (8s Review Queue & Settings)            │
│   [ Table Volunteer Phones ] ────>  [ Director & AV Laptop ]                │
│                                                │                            │
│                                                ▼ 8s Review Horizon          │
│   PODIUM SCREEN                     MAIN BALLROOM SCREEN                    │
│   (Emcee OLED Confidence Monitor)   (1080p Projector / LED Wall HUD)        │
│   [ Stage Downstage Tablet ]        [ 130px Odometer & Lower Third Ticker ] │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Live Surfaces

| Surface | Path | Primary Device | Purpose |
| :--- | :--- | :--- | :--- |
| **Suite Launcher** | `/` | Any Browser | One-click launchpad for all live-event surfaces. |
| **Main Ballroom Screen** | `/chart` | Projector / LED wall | Rolling total, horizontal bar or centered thermometer, donation feed, rotating impact messages, and donation QR. |
| **Manage Donations** | `/donations` | Volunteer phones / director laptop | One donation table with Add donation modal, major-gift confirmation, offline outbox, delete/undo, CSV export, and live stage messaging. |
| **Podium Screen** | `/presenter` | Podium tablet / teleprompter | Total and live progress bar, donor shoutouts, pronunciation, and milestone context. No table numbers. |
| **Event Settings & Testing** | `/settings`, `/testing` | Director / AV laptop | Persistent event configuration and rehearsal tools with the same live chart embedded for verification. |

### Presentation previews

The operator sidebar opens the chart preview at `/preview` and the presenter
preview at `/presenter-preview`. Both show the live screen inset, a copyable
standalone URL, a **Fullscreen** button, and **Open in new tab**.

Fullscreen expands the live iframe without reloading it; leaving fullscreen
returns to the preview. If the browser denies fullscreen, use the new-tab link.
Shared room URLs remain `/chart` and `/presenter`, without the operator shell.

### Presence

Home (`/`) includes a **Who's here** section with the active browser count and a
roster grouped by operator page. Home, Preview, Manage Donations,
Settings, Testing, and History report presence without adding overlays to their
interfaces. The fullscreen Chart and Presenter are not tracked.

On first use, enter your name; use **Recording donations as → Change name** on any operator
page or rename yourself in Presence. New manual gifts and subsequent actions
record that name. These are self-reported browser identities, not authenticated
accounts; renaming does not rewrite historical ledger attribution.

Browsers send a heartbeat every 5 seconds; entries expire 15 seconds after their
last heartbeat. Backgrounded tabs stop reporting after a 30-second grace period.
Presence is ephemeral and never writes to the donation ledger. A disconnected
Home marks its cached roster stale rather than claiming everyone is still live.

When a Control Room PIN is configured, unlock an operator page first, then return
to Home to view the roster. Names and counts are hidden when access is denied.

Manage Donations shows one table with exact Eastern 12-hour timestamps (including
seconds and EST/EDT), source and operator labels, and donation-detail copying.
Add donation opens a modal on that page. History retains the actor for each action.

---

## Core Architectural Invariants

1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite stream (`create`, `amend`, `void`, `match_apply`, `match_release`). The verified balance is a deterministic fold over the ledger.
2. **Unified 8-Second Staging Horizon**: Both ballroom display totals and lower-third chyrons pass through an 8-second review buffer. If an operator clicks **"Hold from Stage"** or a volunteer taps **"Undo"** within 8 seconds, the typo never reaches the ballroom screen or odometer.
3. **$\ge \$9,500$ Major Gift Guardrail**: Server-enforced verification intercept modal to prevent accidental extra-zero submissions ($50k $\rightarrow$ $500k).
4. **Physical Pledge Card Duplicate Check**: Enforces unique card serials (`#0412`) in $O(1)$, rejecting duplicates with detailed resolution guidance.
5. **No-Backward Ballroom Screen Rule**: Ordinary voids or downward corrections hold the ballroom total steady. Explicit rehearsal purge and full reset advance a reset sequence so both the bar and odometer can reset; rehearsal purge preserves real gifts and their matching contributions.
6. **Strict Privacy Shield**: Anonymous donors display as *"Anonymous Supporter — $X"* on stage; real donor names are completely stripped before reaching the ballroom projection feed.
7. **Pure Matching Grant Folds**: Matching funds are derived deterministically. Voiding or amending a matched gift emits compensating `match_release` events, keeping sponsor pools 100% auditable.

---

## Zero-Code In-App Customization

Non-technical event directors and gala chairs configure the event at **Settings** (`/settings`). Settings persist in SQLite, not external configuration files.

* **Event Identity**: Event title, subtitle, organization, trust/EIN text, and donation QR destination.
* **Fundraising Goal**: Comma-formatted dollar inputs; named milestones, dollar ticks with configurable spacing, or no markers. Changes to the goal or milestone list require confirmation.
* **Appearance**: Independent bar and figure colors, artwork, optional silent looping video, typeface, and orientation. Subtle Gradient has editable colors, direction, and intensity. The same embedded chart previews unsaved changes. Reduced-motion viewers see still artwork instead of video.
* **Images**: Hosted logo/artwork URLs or PNG/JPEG/WebP uploads up to 2 MB per image. Uploaded images are stored with settings.
* **Ballroom QR**: Separate tracked donation destination and short displayed URL. Upload a custom SVG/PNG/JPEG/WebP up to 2 MB, keep its transparency or add a white backdrop, and return to the automatic QR at any time. Uploads preserve their own encoded destination; changing the URL cannot rewrite an uploaded graphic. Scan-test the actual chart before the event. The automatic code retains its white quiet zone.
* **Volunteer Quick-Amounts**: Configurable ask-tier buttons ($10k, $5k, $2.5k, $1k, $500, or custom amounts).
* **Matching Donor Grants**: Sponsor name, matching pool amount, match ratio (1:1 double, 2:1 triple), and live active toggle.
* **Passcode Protection**: Optional PIN gates for the Control Room and Volunteer Pads.
* **Live messages**: Manage Donations → On the ballroom screen sends an immediate announcement or returns to the editable 12-second impact rotation. Settings saves do not overwrite live announcements.
* **Gala motion assets**: `/assets/gala-anniversary-loop.mp4` is a silent, seamless 8-second light-and-particle animation of the supplied illuminated tenth-anniversary artwork. `/assets/gala-anniversary-background.png` is its still fallback, with baked-in text removed to leave room for live figures. The earlier `/assets/gala-background-loop.mp4` remains available as an alternative decorative-border background.
* **Impact copy source**: The CAIR-Georgia gala rotation draws on the [2026 booklet](https://share.wavedepth.com/cga10year-booklet/), particularly free legal representation, religious freedom, Know Your Rights education, State Capitol advocacy, and rapid response. It makes no per-dollar allocation claims.
* **Rehearsal**: Testing puts controls beside a sticky, scaled 1920×1080 instance of the actual chart when space permits; narrow screens stack them. Sample records remain below the workbench. Sample gifts affect the same event, so rehearse before the live appeal.

### Bloomerang Fundraising

Settings → Connections configures one Fundraising form, an import start date,
and automatic import. The server reconciles that form every 30 seconds; **Sync
now** runs the same reconciliation. Gifts use stable upstream transaction IDs
so polling does not duplicate them. Corrections and refunds append ledger events
and release matching funds. Operator-deleted gifts stay deleted.

Only the gift amount counts: donor-covered fee assistance and non-donation
ticket/store purchases are excluded. Do not also enter online gifts manually.
Imported gifts retain the normal staging delay and anonymous-donor privacy.

Provision the token in a private mode-600 file outside the source tree and set
`GIVEBAR_FUNDRAISING_TOKEN_FILE` to its path. The token never appears in settings
responses. The optional **CRM** credential check is separate and does not import
donations. A successful Fundraising sync reports its time, form, and gift count.

---

## Quickstart

### Running with Bun (Recommended)

```bash
# Clone the repository
git clone https://github.com/nerveband/givebar.git
cd givebar

# Run development server with live reload
bun dev

# Run automated test suite
bun test
```

### Running with Docker (wavedepth Dokploy)

```bash
# Build and run container
docker build -t givebar .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name givebar givebar
```

---

## Live Rehearsal & Gala Verification Checklist

Before doors open on gala night:
1. **Tech rehearsal**: Open `/testing`, generate sample gifts, and watch the embedded `/chart` preview.
2. **Stage review**: Delete a sample gift within the configured staging horizon and verify it never reaches the ballroom.
3. **Major gift guardrail**: In `/donations`, open **Add donation**, enter `$50,000`, and verify explicit confirmation is required.
4. **Duplicate card test**: With card numbers enabled, record `#0101`, then attempt the same number again. Verify the warning preserves the draft.
5. **Presentation check**: Check both orientations, the presenter bar, QR readability, background loop, and reduced-motion fallback.
6. **Finance reconciliation**: Export CSV and verify ledger totals. Purge sample data only when rehearsal is finished; never reset real gifts.

---

## License

MIT License. Designed for nonprofit galas and benefit auctions worldwide.
