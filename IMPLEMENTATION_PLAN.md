# Givebar — Implementation Plan & Architecture Specification

> **Givebar**: The open, bulletproof live fundraising thermometer & stage presentation HUD for high-stakes nonprofit galas and benefit auctions.

> **Superseded in part.** The UI/UX, styling, settings, and surface-behaviour sections below are superseded by [`docs/REDESIGN_PLAN.md`](docs/REDESIGN_PLAN.md), which also carries a verified defect inventory. This file remains the original architecture and schema reference.

---

## 1. Executive Summary & Core Principles

Givebar is designed to replace fragile multi-tab spreadsheets during live fundraising appeals ($100k–$2M+ raised in 30–45 minutes).

### Core Principles
1. **Append-Only Accounting**: Source of truth is an immutable event ledger (`create`, `amend`, `void`). The total is a deterministic fold over this ledger.
2. **Decoupled Financial vs. Display State**: Pledges/donations immediately update the authoritative total, but public stage chyrons pass through an 8-second delay buffer with a 1-click "Yank" safety rail.
3. **Major Gift Guardrail ($\ge \$9,500$)**: Any manual or online contribution $\ge \$9,500$ triggers a mandatory confirmation modal to prevent extra-zero entry accidents ($50k \rightarrow $500k).
4. **Low-Concurrency, High-Reliability Architecture**: Built for 1–3 stage screens, 2–5 volunteer data entry clerks, 1 AV technician, and 1 stage emcee (~10 concurrent clients total).
5. **Anti-Overengineering**: 1-second snapshot polling against an embedded SQLite database (WAL mode). Zero WebSocket disconnect bugs, zero cloud queue dependencies, and single-command local/cloud execution.
6. **Sans-Serif Luxury UI**: Deep OLED obsidian background (`#07090E`), liquid champagne gold accents (`#E2B755` / `#F3D78A`), double-bezel machined card containers, and fluid GSAP numeric roll physics. **Strictly sans-serif typography.**

---

## 2. System Architecture

```mermaid
flowchart TD
    subgraph Ingestion [Input Streams]
        A[Bloomerang / Kindful Webhooks] --> Ingest[API Gateway]
        B[Bloomerang / Kindful Poller (5s lease)] --> Ingest
        C[Stripe Webhooks] --> Ingest
        D[Volunteer Numpad Terminal (Client UUID)] --> Ingest
    end

    subgraph Core [Backend & State Engine]
        Ingest --> Guard{Amount >= $9,500?}
        Guard -->|Yes| Flag[Flag for Review / Require Terminal Confirm]
        Guard -->|No| Dedup[Idempotency & Dedup Engine]
        Flag --> Dedup
        Dedup --> Ledger[(SQLite Append-Only Ledger)]
        Ledger --> State[Compute Monotonic Sequence State]
    end

    subgraph Views [Four Specialized Client Surfaces]
        State -->|1s Polling /api/state?since=seq| Stage[Stage 1080p HUD /stage]
        State -->|1s Polling /api/state?since=seq| Control[AV & Admin Control Deck /control]
        State -->|1s Polling /api/state?since=seq| Emcee[Emcee Confidence Monitor /emcee]
        State -->|2s Polling /api/state?since=seq| Entry[Volunteer Entry Form /entry]
    end
```

---

## 3. Database Schema (SQLite WAL Mode)

```sql
-- Append-Only Event Ledger (Source of Truth)
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,         -- 'create', 'amend', 'void', 'match_apply'
  donation_id TEXT NOT NULL,        -- UUIDv7 minted on client form open or adapter receipt
  supersedes_seq INTEGER,           -- Points to superseded record for amendments and voids
  amount_cents INTEGER NOT NULL,    -- 64-bit signed integer cents ($10,000.00 = 1000000)
  donor_name TEXT NOT NULL,         -- Full legal or CRM contact name
  display_name TEXT,                -- Sanitized public chyron text ("Dr. Alshroof" or "Anonymous Supporter")
  is_anonymous INTEGER DEFAULT 0,   -- 1 = true, 0 = false
  payment_method TEXT NOT NULL,     -- 'pledge', 'card', 'check', 'cash', 'match'
  source TEXT NOT NULL,             -- 'manual', 'bloomerang', 'kindful', 'stripe', 'qr'
  source_txn_id TEXT,               -- Vendor transaction/charge ID (Unique with source)
  card_number TEXT,                 -- Physical paper pledge card serial number (#0412)
  entered_by TEXT,                  -- Volunteer initials or adapter name
  notes TEXT,                       -- Table number, pledge terms, notes
  created_at INTEGER NOT NULL       -- Server epoch millisecond timestamp
);

CREATE INDEX IF NOT EXISTS idx_ledger_seq ON ledger(seq);
CREATE INDEX IF NOT EXISTS idx_ledger_donation_id ON ledger(donation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_source_txn ON ledger(source, source_txn_id) WHERE source_txn_id IS NOT NULL;

-- Event State & Live Configuration
CREATE TABLE IF NOT EXISTS event_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_name TEXT NOT NULL DEFAULT 'Annual Gala & Benefit Auction',
  goal_cents INTEGER NOT NULL DEFAULT 50000000,          -- $500,000.00
  match_pool_cents INTEGER NOT NULL DEFAULT 0,           -- Matching pool capacity
  match_ratio REAL NOT NULL DEFAULT 1.0,                 -- 1.0 = 1:1 match ($1 gives $1 match)
  is_match_active INTEGER NOT NULL DEFAULT 0,            -- 0 = disabled, 1 = active on stage
  match_sponsor_title TEXT DEFAULT 'Board of Directors Matching Grant',
  is_frozen INTEGER NOT NULL DEFAULT 0,                  -- 1 = stage display frozen
  manual_override_cents INTEGER DEFAULT NULL,            -- Manual override total if emergency
  qr_donate_url TEXT DEFAULT 'https://example.org/donate?source=stage-qr',
  entry_pin TEXT NOT NULL DEFAULT '1234',
  control_pin TEXT NOT NULL DEFAULT '9999',
  updated_at INTEGER NOT NULL
);

-- Connector Leases & Checkpoints
CREATE TABLE IF NOT EXISTS connector_state (
  connector_id TEXT PRIMARY KEY,    -- 'bloomerang', 'kindful'
  last_cursor TEXT,                 -- ISO timestamp or transaction ID
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER,
  last_error TEXT
);
```

---

## 4. The Four Frontend Surfaces

### 4.1 Stage Fullscreen Display (`/stage` — 1920 × 1080 Native HUD)
Designed specifically for ballroom projectors and digital stage backdrops:
* **Typography**: Clean, high-contrast sans-serif (`Plus Jakarta Sans` / `Geist`). Zero serifs.
* **Rolling Odometer**: 120px tall digits with hardware-accelerated CSS vertical rolling reels.
* **Thermometer / Progress Bar**: Double-bezel concentric container with glowing champagne-gold fill, milestone markers with tangible impact labels ($250k: *Staffing*, $500k: *Legal Clinic*, $1M: *Expansion*).
* **Dynamic QR Code**: High-contrast, sharp QR code positioned in the lower right for mobile table donors (Apple Pay / Google Pay / Card).
* **Matching Grant Banner**: Dynamic top badge (*"⭐ $100K MATCH ACTIVE — EVERY DOLLAR DOUBLED ⭐"*).
* **Paced Chyron Stream**: Lower-third recognition card cycling smoothly every 4–6 seconds. Collapses into aggregate toasts when rapid-fire spikes occur.
* **No-Backward-Odometer Rule**: If an amount is voided or amended downward, the visual counter freezes and absorbs the difference into future gifts rather than rolling backward on stage.
* **Strict Privacy Shield**: Anonymous donors display as *"Anonymous Supporter — $X"* on stage; real names are never included in the `/stage` API projection payload.

### 4.2 Volunteer Rapid Entry Terminal (`/entry` — Mobile / Tablet / Laptop)
Numpad-first interface for rapid entry of physical table pledge cards:
* **Ask-Tier Fast Buttons**: `[$10k]`, `[$5k]`, `[$2.5k]`, `[$1k]`, `[$500]`, `[Custom]`.
* **$\ge \$9,500$ Guardrail Modal**: Immediate high-contrast warning dialog requiring explicit 1-tap confirmation or re-entry for any pledge $\ge \$9,500$.
* **Idempotent Outbox**: Forms mint a client UUIDv7 when opened. Submissions retry automatically if Wi-Fi flaps, ensuring zero duplicates.
* **Pledge Card Serial**: Input for pre-printed card serial numbers (`#0412`) to eliminate cross-volunteer card collisions.
* **1-Tap Undo**: Instant single-tap undo for the volunteer's most recent submission.
* **Personal Audit Log**: Displays the last 10 entries keyed by this volunteer.

### 4.3 AV & Admin Control Deck (`/control` — Master Operations)
The cockpit for the event producer, lead moderator, and AV technician:
* **Broadcast Delay Buffer (8–10 Seconds)**: Incoming names sit in an 8-second staging queue with a prominent red **"YANK"** button to pull typos before they hit the ballroom screen.
* **Live Emergency Controls**:
  * **Freeze Screen**: Holds visible total while backend ingestion continues.
  * **Manual Total Override**: Emergency input to set the stage total directly.
  * **Milestone Confetti Trigger**: Manually arms and fires celebratory confetti bursts on emcee cues.
  * **Match Fund Toggle**: Activates/deactivates the matching grant banner and sets remaining match pool.
* **Rehearsal Mode**: Generates mock gala traffic (simulated donor stream, milestone milestones, typo corrections) to test on venue projection hardware during tech rehearsals.
* **Finance Reconciliation CSV Export**: Complete auditable export mapping ledger events to CRM accounting formats.

### 4.4 Emcee Confidence Monitor (`/emcee` — Stage Podium iPad View)
Ultra-high-contrast, dark-mode presenter display:
* Giant current total ($1,155,967) and distance to next milestone ($94,033 to $1.25M).
* Active matching pool countdown.
* Live feed of the top 5 largest gifts tonight for immediate on-stage vocal shoutouts.

---

## 5. Visual Design System & Tokens

* **Aesthetic**: Vanguard Dark Luxury / Precision HUD.
* **Typography Stack**: `Plus Jakarta Sans`, `Geist`, system sans-serif fallback. **No serifs anywhere.**
* **Palette**:
  * Surface 0 (Canvas): `#07090E` (Deep OLED Obsidian)
  * Surface 1 (Outer Bezel): `#0D111A` (Machined Dark Plate)
  * Surface 2 (Inner Card): `#141A26` (Elevated Panel)
  * Accent Primary: `#E2B755` (Liquid Champagne Gold)
  * Accent Glow: `rgba(226, 183, 85, 0.25)`
  * Accent Secondary (Milestones): `#4ADE80` (Emerald Green)
  * Warning / Guardrail: `#F87171` (Crimson Alert)
  * Text Primary: `#F9FAFB` (Pure Crisp White)
  * Text Secondary: `#9CA3AF` (Muted Steel)
* **Double-Bezel Card Architecture**:
  * Outer shell: `p-1.5 rounded-2xl bg-white/[0.04] border border-white/[0.08]`
  * Inner core: `p-6 rounded-[calc(1rem-2px)] bg-[#141A26] shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]`
* **Motion Choreography**:
  * Physics Curve: `cubic-bezier(0.16, 1, 0.3, 1)`
  * Odometer Reel Duration: `1400ms` with staggered column settle.

---

## 6. Implementation & File Structure

```
givebar/
├── server/
│   ├── src/
│   │   ├── index.ts        # Fast, single-process HTTP server (Bun / Node)
│   │   ├── db.ts           # SQLite connection, WAL mode, migrations
│   │   ├── ledger.ts       # Append-only transaction processor & fold engine
│   │   ├── adapters/
│   │   │   ├── bloomerang.ts   # Webhook handler + 5s polling fallback
│   │   │   └── stripe.ts       # Stripe webhook ingestion
│   │   └── routes/
│   │       ├── state.ts        # GET /api/state?since=seq (1s sync endpoint)
│   │       ├── donation.ts     # PUT /api/donation/:id (Idempotent volunteer entry)
│   │       ├── control.ts      # POST /api/control (Freeze, Yank, Override, Match)
│   │       ├── webhook.ts      # POST /api/webhooks/:provider
│   │       └── export.ts       # GET /api/export/csv (Finance export)
│   ├── data/
│   │   └── givebar.sqlite  # Embedded SQLite database
│   └── package.json
├── client/
│   ├── public/
│   │   ├── stage.html      # Fullscreen 1080p Stage Presentation HUD
│   │   ├── entry.html      # Volunteer Numpad & Tier Entry Form ($9,500 guardrail)
│   │   ├── control.html    # AV & Admin Cockpit (Yank, Freeze, Rehearsal, Goal)
│   │   └── emcee.html      # Podium iPad Confidence Monitor
│   ├── css/
│   │   └── app.css         # Custom Vanguard Design Tokens, Bezel & Odometer styles
│   └── js/
│       ├── odometer.js     # Rolling numeric reel animation engine
│       ├── stage.js        # Stage HUD sync, paced chyron queue, QR generator
│       ├── entry.js        # Offline outbox, numpad bindings, $9,500 modal
│       ├── control.js      # AV controls, delay buffer, rehearsal simulator
│       └── emcee.js        # Host podium monitor sync
├── Dockerfile              # 1-command container deploy (Dokploy / Railway / Render)
├── README.md               # Setup, rehearsal guide, and live-event checklist
└── package.json
```

---

## 7. Verification & Live-Event Readiness Checklist

Before doors open on event night:
1. **Offline Sim Test**: Disconnect volunteer laptop Wi-Fi for 60 seconds while entering 5 pledge cards; verify all 5 flush idempotently upon reconnection without duplicates.
2. **$9,500 Guardrail Test**: Enter `$500,000` on volunteer terminal; verify immediate red warning intercept modal triggers and requires explicit confirmation.
3. **Chyron Delay & Yank Test**: Enter test pledge with intentional typo; click **"YANK"** in control deck within 8 seconds; verify name never reaches the 1080p stage display.
4. **No-Backward-Odometer Test**: Void a $25,000 gift in control deck; verify stage total freezes in place and smoothly advances with next gifts without visibly spinning backward.
5. **Rehearsal Simulation**: Run 100 mock donations through Rehearsal Mode; verify 1080p projector display maintains 60 FPS without GPU or memory degradation.
6. **Finance CSV Match**: Verify `GET /api/export/csv` exactly matches the ledger fold total down to the cent.