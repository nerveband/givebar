# Givebar ⚡

> The open-source, bulletproof live fundraising thermometer & stage HUD for high-stakes nonprofit galas and benefit auctions ($100k–$2M+ live appeals).

---

## 🌟 Overview & Philosophy

Givebar is built to replace fragile, multi-tab spreadsheets during live fundraising appeals where hundreds of thousands or millions of dollars are pledged in 30–45 minutes.

### Core Architectural Invariants
1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite event stream (`create`, `amend`, `void`, `match_apply`). The authoritative total is a deterministic fold over this ledger.
2. **Decoupled Financial vs. Display State**: Pledges immediately increment the authoritative financial total, but public ballroom chyrons pass through an 8-second delay buffer with a 1-click **"YANK"** safety button in the AV Control Deck.
3. **$\ge \$9,500$ Major Gift Guardrail**: Any pledge $\ge \$9,500$ entered on volunteer numpads triggers an explicit crimson confirmation intercept modal to prevent accidental extra-zero submissions ($50k \rightarrow $500k).
4. **Physical Pledge Card Collision Detection**: Server enforces physical card serial uniqueness (`#0412`), rejecting duplicates with `409 Conflict` and identifying the previous clerk.
5. **No-Backward-Odometer Rule**: Downward pledge voids or corrections hold the ballroom display total steady, absorbing the difference into future gifts rather than rolling backward on stage.
6. **Strict Privacy Shield**: Anonymous donors display as *"Anonymous Supporter — $X"* on stage; real donor names are completely stripped before reaching the `/stage` projection payload.
7. **Anti-Overengineering**: 1-second monotonic sequence polling against embedded SQLite (WAL mode). Zero WebSocket disconnect issues, zero cloud queue dependencies, single-process execution.
8. **Vanguard Sans-Serif Luxury UI**: Deep OLED obsidian background (`#07090E`), liquid champagne gold accents (`#E2B755`), double-bezel machined card containers, and hardware-accelerated CSS vertical rolling reels. **Strictly sans-serif typography (`Plus Jakarta Sans` / `Geist`).**

---

## 🖥️ The Four Specialized Surfaces

| Surface | URL | Intended Device | Description |
| :--- | :--- | :--- | :--- |
| **Stage 1080p HUD** | `/stage` | Ballroom Projector / LED Wall | 120px rolling odometer, concentric progress bar, milestone notches, dynamic matching grant banner, paced chyrons, dynamic QR code. |
| **Volunteer Entry Terminal** | `/entry` | Table Volunteer Phone / Tablet | Numpad-first rapid pledge entry, ask-tier buttons, $9,500 guardrail modal, idempotent offline outbox, 1-tap instant undo. |
| **AV & Admin Control Deck** | `/control` | AV Tech / Director Laptop | 8s delay buffer with 1-click Yank, emergency freeze, manual override, confetti trigger, force odometer resync, rehearsal simulator. |
| **Emcee Confidence Monitor** | `/emcee` | Stage Podium iPad / Teleprompter | Giant authoritative total, milestone gap countdown, active match pool, top 5 largest gifts for vocal shoutouts, live incoming feed. |

---

## 🚀 Quickstart

### Running with Bun (Recommended)

```bash
# Clone the repository
git clone https://github.com/your-org/givebar.git
cd givebar

# Run development server with live reload
bun dev

# Run automated test suite
bun test
```

### Running with Docker

```bash
# Build and run container
docker build -t givebar .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name givebar givebar
```

---

## 📡 API Reference

- `GET /api/state?role=stage|emcee|control|entry&since=seq`: 1-second monotonic state sync endpoint.
- `PUT /api/donation/:id` or `POST /api/donation`: Idempotent volunteer pledge submission.
- `POST /api/donation/:id/void`: Void a donation and deduct from total calculations.
- `POST /api/donation/:id/amend`: Append an amendment to a donation.
- `POST /api/control`: AV director controls (freeze, override, goal, match, yank, confetti, resync).
- `GET /api/export/csv`: Auditable RFC 4180 finance reconciliation export matching exact cents.
- `POST /api/rehearsal`: Gala tech rehearsal simulator (`single`, `burst`, `typo`, `milestone`).
- `POST /api/webhooks/:provider`: External webhook ingestion (`bloomerang`, `stripe`, `kindful`).
- `GET /api/qr?url=...`: Scalable, high-contrast vector SVG QR code with quiet zone.

---

## 🎪 Live-Event Rehearsal & Verification Checklist

Before doors open on gala night:
1. **Tech Rehearsal**: Open `/control`, click **"⚡ Rapid Burst (7 Pledges)"** and verify the 1080p `/stage` odometer rolls smoothly at 60 FPS.
2. **Yank Verification**: Click **"⚠️ Inject Typo"** in `/control`, click the red **"🛑 YANK"** button within 8 seconds, and confirm the typo name never appears on `/stage`.
3. **$9,500 Guardrail Test**: Open `/entry`, enter `$50,000`, and confirm the crimson confirmation intercept modal appears.
4. **Collision Test**: Enter pledge with card `#0101`; attempt to enter another with `#0101` and verify the collision alert prevents duplicate entry.
5. **Stage Confetti Cue**: Trigger confetti from `/control` and verify celebration particles burst across `/stage`.
6. **Finance Reconciliation Check**: Click **"📊 Export Finance CSV"** and verify all events balance down to the exact cent.

---

## 📄 License

MIT License. Designed for nonprofit galas and benefit auctions worldwide.
