# Givebar — Redesign & Simplification Implementation Plan

**Status:** Proposed
**Supersedes:** the UI/UX sections of `IMPLEMENTATION_PLAN.md` (that file remains the original architecture spec)
**Audited commit:** `09b1ae1`
**Audit method:** full source read + live server on `:3717` + headless browser verification of all four surfaces + direct ledger probes

---

## 0. Executive summary

Givebar's architecture is sound. Its **implementation is not shippable today.**

Before any redesign work is justified, seven defects must be fixed. Six were verified by execution, not inspection. The headline: **`/entry` — the volunteer pledge pad — does not run at all**, and **the ballroom screen's total is invisible.** Those are the two things the product exists to do.

The redesign directives are correct and I am adopting them essentially as written, with three substantive amendments where the directive as stated would not survive a live gala:

1. **The 8-second buffer must cover money, not just names.** Today a `$500,000` extra-zero typo hits the ballroom odometer in ≤1s and, because of the No-Backward floor, **stays there permanently even after it is voided** (verified: screen locked at `$605,000` while the ledger read `$105,000`). Holding a chyron does nothing to the number. Section 3.1 unifies both invariants under one staging horizon.
2. **Matching grants must be a pure fold, not a mutated counter.** Voiding a matched gift currently leaves a phantom match in the total and silently burns the sponsor's pool (verified: void a matched `$50k` → total reads `$50,000` instead of `$0`, pool never refunded). Section 3.2 replaces the mutation with `match_release` events.
3. **The $9,500 guardrail must be server-enforced.** It is client-only today, and `/api/rehearsal` + all three webhooks bypass it entirely. A client bug (see D1) removes the last line of defence.

Everything else — OKLCH tokens, flat `.surface-card`, 3-tab control room, thumb-zone `/entry`, plain-English copy, zero-JSON settings — is additive on top of a correct core.

**Sequencing rule: no cosmetic work ships before Phase 0 lands.** A beautiful screen showing the wrong number is worse than an ugly one showing the right number.

---

## 1. Verified defect inventory

Severity: **S0** = event-ruining, **S1** = wrong money on screen, **S2** = operator trap, **S3** = quality.

| # | Sev | Defect | Evidence |
|---|-----|--------|----------|
| **D1** | S0 | `/entry` is completely dead. `setupGuardrailModal()` is never closed, so `executeSubmission`/`resetForm` are nested inside it and the IIFE fails to parse. Numpad, presets, guardrail, submit, undo, outbox, polling — none of it binds. | `bun build client/js/entry.js` → `error: Unexpected ) at 431:2`. Browser: `pageerror: SyntaxError: Unexpected token ')'`. Tapping `5`, then `$10,000`, then Submit leaves display at `$0` and `guardrail-modal.style.display === "none"`. The green "connected" dot is static markup and lies. |
| **D2** | S0 | Stage odometer digits are **invisible**. `.text-gold-gradient` sets `-webkit-text-fill-color: transparent` on the wrapper; the digit reels are descendant elements, so their glyphs inherit transparency with no gradient painted behind them. | 1080p screenshot shows `$` and a stray `,` on an otherwise empty centrepiece. Computed `webkitTextFillColor: rgba(0,0,0,0)` on `.odometer-digit-val`. Removing the class renders `$105,000` correctly. |
| **D3** | S1 | Voiding a matched donation leaves the `match_apply` event in the fold and never refunds the pool. | Probe: match pool `$100k` 1:1, create `$50k` → total `$100,000` ✓. Void it → total `$50,000` (expected `$0`), `direct=0`, `match=5000000`, `match_pool_cents` still `5000000` (expected `10000000`). |
| **D4** | S1 | No-Backward floor cements typos. `getStageState` raises `odometer_floor_cents` on every poll (a **write on a GET**), so a mistaken gift is locked onto the ballroom screen forever. | Probe: stage `$105,000` → inject `$500,000` typo → stage `$605,000` → void it → stage **still `$605,000`**, `true_total_raised_cents: 10500000`. Only the buried "Force Odometer Resync" recovers it. |
| **D5** | S1 | `amendDonation` writes `card_number` into the `source_txn_id` column (13 placeholders, misaligned arg list). Because of `UNIQUE(source, source_txn_id)`, **any card-numbered donation can be amended exactly once**; the second amend throws. It also poisons the idempotency lookup in `recordDonation`. | Probe: amend row shows `source_txn_id: "#0412"`. Second amend → `UNIQUE constraint failed: ledger.source, ledger.source_txn_id`. |
| **D6** | S0 | `GET /api/state?role=control` returns the whole `event_state` row — **including `control_pin` and `entry_pin` in plaintext — with no authentication.** Anyone on venue Wi‑Fi reads the PIN and can then freeze the screen, set an arbitrary total, or wipe the ledger. | `curl -s localhost:3717/api/state?role=control` → `{'entry_pin': '1234', 'control_pin': '9999'}`. |
| **D7** | S0 | `POST /api/rehearsal` and `PUT /api/donation/:id` are unauthenticated. Any guest can inject pledges onto the ballroom screen. `entry_pin` is stored and settable but **enforced nowhere**. | `curl -X POST .../api/rehearsal -d '{"mode":"burst"}'` → `200`, 7 fake gifts on the projector. `grep entry_pin` finds only schema/DDL/setter — zero enforcement sites. |
| **D8** | S1 | The stage QR code is not a QR code. The file claims "Reed-Solomon GF(256) Math" in its header comment and implements **none**: no generator polynomial, no ECC codewords, no terminator or padding. The EC region is filled with `(r+col)%3===0` noise. | `grep -i 'galois\|gf256\|generatorPoly\|reedSolomon\|0x11d'` in `qr.ts` → **no matches**. Every phone in the ballroom sees "SCAN TO PLEDGE" above an unscannable square. *(Requires a physical phone scan at rehearsal to close out — cannot be decoded headlessly.)* |
| **D9** | S2 | Amending a matched gift does not adjust the match. Amend `$1,000` → `$50,000` leaves match at `$1,000`. | Probe: `d5 create total=6100000`, after amend `total=11000000, match=5400000`. |
| **D10** | S2 | Submit button sits **217 px below the fold** on iPhone-class viewports; volunteers must scroll past a 4-row numpad to record a gift. | 390×844: `#btn-submit-pledge` top = `1061`, viewport = `844`. |
| **D11** | S2 | Anonymous toggle is a 20×20 px checkbox — fails WCAG 2.2 AA **2.5.8 Target Size (Minimum)** (24×24). Ask-tier buttons 51 px, text inputs 47 px (below the 56 px ergonomic floor). | Measured `getBoundingClientRect()` on the live page. |
| **D12** | S2 | `.btn-danger` is white on `#EF4444` = **3.76:1**, failing AA 4.5:1 — on **Hold-from-Stage**, the most safety-critical control in the product. | Computed. `#DC2626` gives 4.83:1. |
| **D13** | S2 | 13 blocking `window.alert()` calls (7 in `control.js`, 6 in `entry.js`). A modal alert on the AV laptop halts the 1 Hz poll loop until dismissed. The 409 duplicate-card path `alert()`s **and discards the pledge**, losing the volunteer's typing. | `grep -n '\b(alert\|confirm\|prompt)\('`. |
| **D14** | S3 | `dist-static/` is a byte-identical duplicate of `client/` (HTML flattened to root) and is the live here.now publish target. `client/` has **no `index.html`** — `/` falls through to `control.html`. `mock-backend.js` activates by sniffing `share.wavedepth.com` in the hostname. | `diff -rq client/ dist-static/` → differs only in HTML placement. `.herenow/state.json` → 4 publishes at `/dist-static/`. |
| **D15** | S3 | `recordDonation` runs a **full `foldLedger`** to check card collisions, making inserts O(n²) across an event. | 1,500 sequential inserts = 932 ms cumulative; single fold = 1.09 ms at n=1500. Not fatal at gala scale, but the collision check should be one indexed row lookup. |

Baseline that is *not* broken and must not regress: **22/22 tests pass**, the privacy shield on `/stage` is correct (chyron payload carries only `donation_id`, `display_name`, `amount_cents`, `created_at`), and `/emcee` renders correctly.

---

## 2. Architectural decisions

### ADR-01 — One staging horizon for money and names
**Decision.** The ballroom screen renders a *delayed projection* of the ledger, not the live fold. All `/stage` numbers derive from events older than `stage_delay_ms` and not held.

**Why.** The current split (money instant, names delayed) means Hold-from-Stage cannot undo the thing that actually matters. Unifying them makes "Hold" a true program-out cut and makes the No-Backward rule apply only to genuine late corrections, which is what it was designed for.

**Invariant preservation.** #2 (8s buffer/hold) is strengthened. #5 (No-Backward) is preserved *and made honest*: the floor now only ratchets on the delayed total, so a held or quickly-voided typo never raises it.

### ADR-02 — Matching grants are a fold, not a counter
**Decision.** Delete the `UPDATE event_state SET match_pool_cents` mutation. Add `match_release` to the event vocabulary. Remaining pool becomes derived:
`pool_remaining = match_total_cents − Σ match_apply + Σ match_release`.

**Why.** Invariant #1 says the total is a deterministic fold. Today it isn't: replaying the ledger against a fresh DB yields a different answer than the live one, because pool depletion lives outside the ledger. D3 and D9 are both symptoms of this single violation.

### ADR-03 — Safety rails are server invariants
**Decision.** Move the $9,500 guardrail, card-collision check, and PIN enforcement behind the API boundary. The client modal becomes a *UX affordance over* a server rule, not the rule itself.

**Why.** D1 proved a single client-side syntax error removes every client-side protection at once. Rehearsal injection and all three webhooks bypass the guardrail today.

### ADR-04 — Settings live in SQLite, edited only through the UI
**Decision.** Zero JSON config files, zero env vars for anything an event director touches. `milestones_json` — the last JSON blob in the schema — is normalised into a `milestone` table. Ask tiers get an `ask_tier` table.

**Why.** The directive's "zero JSON files" is undermined if the settings panel is just a textarea that round-trips JSON. Child tables make the settings UI plain CRUD, make validation server-side, and make a malformed milestone list unrepresentable rather than caught by a `try/catch` that silently substitutes hardcoded defaults (which `getStageState` does today).

### ADR-05 — Live theming via state payload, not stylesheet swaps
**Decision.** Theme is four numbers (`brand_hue`, `brand_chroma`, `brand_accent`, `brand_radius`) in `event_state`. Every role projection carries a `theme` object and a `settings_seq`. Clients apply them by writing CSS custom properties on `:root` when `settings_seq` changes.

**Why.** Satisfies "update CSS tokens across all 4 surfaces in real time" with no reload, no rebuild, no extra endpoint, and no flash — the existing 1 Hz poll is already the transport.

### ADR-06 — Vendor a correct QR encoder; keep zero runtime dependencies
**Decision.** Replace `qr.ts`'s matrix builder with Nayuki's `qrcodegen` (MIT, single file, no deps), vendored at `server/src/vendor/qrcodegen.ts`. Keep the existing `handleQRRequest` SVG wrapper and its cache headers.

**Rejected:** npm `qrcode` (pulls a dependency tree into a repo that currently has none, and `bun install --production` in the Dockerfile would need a lockfile).

### ADR-07 — One client tree, `dist/` is generated
**Decision.** `client/*.html` at the root of `client/`. Delete `dist-static/` from git. Add `bun run build:static` → `dist/` (gitignored) for here.now. `mock-backend.js` activates on a build-injected `window.GIVEBAR_STATIC` flag, not hostname sniffing.

**Risk & mitigation.** Four live here.now publishes point at `/dist-static/`. **Republish from the new `dist/` and confirm all four URLs before deleting the directory** (Phase 6, T6.2). This is the one step in the plan that can break something currently working.

---

## 3. Core mechanics — precise specifications

### 3.1 Delayed stage projection

```ts
// server/src/projection.ts  (new)
export interface StageProjection {
  stage_total_cents: number;   // what the ballroom sees
  verified_total_cents: number;// authoritative fold, all events
  drift_cents: number;         // stage − verified; non-zero ⇒ show reconciliation banner
  chyrons: PublicChyron[];     // privacy-shielded
}

const HELD = new Set(db.query<{donation_id:string},[]>(
  `SELECT donation_id FROM held_donations`).all().map(r => r.donation_id));

const horizon = now - settings.stage_delay_ms;

// Fold only events the horizon has released, skipping held gifts and their matches.
const staged = foldLedger(db, {
  maxCreatedAt: horizon,
  excludeDonationIds: HELD,
});

// No-Backward ratchet applies to the DELAYED total only.
const stage_total_cents = Math.max(
  settings.manual_override_cents ?? staged.total_raised_cents,
  settings.odometer_floor_cents
);
```

Four behaviours fall out, all required:

| Scenario | Result |
|---|---|
| Typo entered, **held within 8 s** | Never enters `staged`. Neither the number nor the name ever reaches the screen. Floor never rises. **Fixes D4.** |
| Typo entered, voided at 30 s | Number was on screen; floor holds it (invariant #5). Control room shows `Ballroom screen is $500,000 above verified total — [Resync Ballroom Total]`. Operator is never blind. |
| Legitimate gift | Appears at exactly `created_at + stage_delay_ms`, money and name together. |
| Held gift released | Re-enters `staged` at the next poll. |

**Floor write must move off the read path.** `getStageState` currently `UPDATE`s on every GET (D4, and a write amplification of ~1 write/sec/screen). Advance the floor inside `recordDonation`/`amend`/`void`/`release` transactions instead, computed against the horizon; `getStageState` becomes pure.

`held_donations` replaces `yanked_chyrons` (same shape, honest name: it now holds money too). Migration copies rows across.

### 3.2 Matching grant as a fold

`ledger.event_type` gains `match_release`. `match_apply` and `match_release` rows carry `supersedes_seq` pointing at the parent gift's latest seq, and `donation_id = "match_" + parentId`.

```ts
// foldLedger
case "match_apply":   matchApplied += ev.amount_cents; matchByParent.set(parentId, ev.amount_cents); break;
case "match_release": matchApplied -= ev.amount_cents; matchByParent.delete(parentId);               break;
```

- **void(parent)** → emit `match_release` for the full applied amount, same transaction.
- **amend(parent, newAmount)** → emit `match_release` for the old amount, then recompute `min(newAmount × ratio, poolRemaining)` and emit a fresh `match_apply`. **Fixes D3 and D9.**
- `match_pool_cents` is **dropped from `event_state`**; `getEventState` exposes it as a derived read. This removes the last place where money lives outside the ledger.

**Verification of invariant #1:** a new test asserts that replaying the ledger into an empty database reproduces `total_raised_cents` exactly, after an arbitrary create/amend/void/match sequence. That test would have caught D3 on day one.

### 3.3 Server-enforced guardrail

```ts
// POST|PUT /api/donation
if (amount_cents >= settings.major_gift_threshold_cents && body.confirmed_major_gift !== true) {
  return Response.json({
    error: "MAJOR_GIFT_CONFIRMATION_REQUIRED",
    message: `Gifts of $9,500 or more need a second look before they go in.`,
    amount_cents,
    threshold_cents: settings.major_gift_threshold_cents,
  }, { status: 428 });
}
```

Client shows the intercept modal, then retries with `confirmed_major_gift: true`. Webhooks and rehearsal set the flag explicitly and are logged with `notes` recording the bypass, so the CSV audit trail shows which large gifts were machine-confirmed. Threshold is editable in Settings (default `950000`).

### 3.4 Card collision — indexed, normalised

```ts
function normalizeCard(raw?: string | null): string | null {
  const t = (raw ?? "").trim().replace(/^#/, "").toUpperCase();
  return t === "" ? null : t;
}
```

Store the **normalised** form in `ledger.card_number`; render with a `#` prefix in the UI. Fixes the current split where `recordDonation` normalises but `amendDonation` does not (`#0412` ≠ `0412` for collision purposes).

Replace the full-fold scan with a single indexed lookup against a new `active_card` table maintained inside the same transaction as create/amend/void — O(1) instead of O(n). **Fixes D15.**

The 409 body already carries `prior_entered_by` and `prior_created_at`; keep it and add `prior_amount_cents` and `prior_donor_name` so `/entry` can render a useful inline card (§6.1).

### 3.5 Authentication

| Route | Gate |
|---|---|
| `/stage` + `role=stage` | open (display URL; carries no legal names) |
| `/emcee` + `role=emcee` | **entry PIN** — it shows legal names and table numbers |
| `/entry` + `role=entry`, `PUT /api/donation` | **entry PIN** |
| `/control`, `role=control`, `/api/control`, `/api/settings`, `/api/rehearsal`, `/api/export/csv` | **control PIN** |
| `/api/webhooks/:provider` | shared secret header per provider (Settings) |

`POST /api/auth {pin}` → `HttpOnly; SameSite=Strict; Path=/` cookie carrying an HMAC'd role token. **PINs never appear in any response payload** — projections expose only `has_entry_pin` / `has_control_pin`. **Fixes D6 and D7.**

**Lockout mitigation (mandatory).** `GIVEBAR_DISABLE_AUTH=1` disables all gates and prints a loud banner; `bun run reset-pins` resets both from the console. Both are documented in the run-of-show card. An AV tech locked out at 8:05 pm is a worse outcome than an open port on a venue VLAN, and the escape hatch must exist before the gate does.

---

## 4. Data model

Additive migration keyed on `PRAGMA user_version` (currently `0` → target `2`). Existing `data/givebar.sqlite` upgrades in place; no data loss.

```sql
-- v1: ledger vocabulary + normalisation
ALTER TABLE ledger ADD COLUMN donor_phonetic TEXT;   -- podium pronunciation guide
ALTER TABLE ledger ADD COLUMN table_number  TEXT;    -- promoted out of free-text notes
UPDATE ledger SET card_number = upper(ltrim(card_number,'#')) WHERE card_number IS NOT NULL;

CREATE TABLE held_donations (
  donation_id TEXT PRIMARY KEY, held_at INTEGER NOT NULL,
  held_by TEXT, reason TEXT
);
INSERT INTO held_donations SELECT donation_id, yanked_at, yanked_by, reason FROM yanked_chyrons;
DROP TABLE yanked_chyrons;

CREATE TABLE active_card (
  card_number TEXT PRIMARY KEY, donation_id TEXT NOT NULL, entered_by TEXT, created_at INTEGER NOT NULL
);

-- v2: zero-JSON settings
ALTER TABLE event_state ADD COLUMN event_subtitle           TEXT    DEFAULT '';
ALTER TABLE event_state ADD COLUMN theme_preset             TEXT    DEFAULT 'champagne';
ALTER TABLE event_state ADD COLUMN brand_hue                REAL    DEFAULT 85;
ALTER TABLE event_state ADD COLUMN brand_chroma             REAL    DEFAULT 0.12;
ALTER TABLE event_state ADD COLUMN brand_accent_hex         TEXT    DEFAULT '';
ALTER TABLE event_state ADD COLUMN brand_radius_px          INTEGER DEFAULT 14;
ALTER TABLE event_state ADD COLUMN major_gift_threshold_cents INTEGER DEFAULT 950000;
ALTER TABLE event_state ADD COLUMN stage_delay_ms           INTEGER DEFAULT 8000;
ALTER TABLE event_state ADD COLUMN confetti_on_milestone    INTEGER DEFAULT 1;
ALTER TABLE event_state ADD COLUMN settings_seq             INTEGER DEFAULT 1;

CREATE TABLE milestone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order INTEGER NOT NULL,
  percent_of_goal REAL,        -- 25 | 50 | 75 | 100  (primary)
  cents INTEGER,               -- absolute override; NULL ⇒ derive from percent × goal
  label TEXT NOT NULL,
  celebrate INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ask_tier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order INTEGER NOT NULL,
  cents INTEGER NOT NULL,
  label TEXT NOT NULL           -- "$10,000"
);
-- seeded: 1000000, 500000, 250000, 100000, 50000  + a "Custom" affordance rendered by the client

-- dropped after backfill into `milestone`
-- event_state.milestones_json
-- event_state.match_pool_cents   (now derived — see ADR-02)
```

`donor_phonetic` is required by the Podium Screen directive ("phonetic guide"). Without it, the phonetic guide is undeliverable — it is an optional Stage-2 field on `/entry` (§6.1) and an editable column in the Donation List.

---

## 5. Design system — OKLCH tokens

**Files.** `client/css/app.css` (715 lines, mixed concerns) splits into:

```
client/css/tokens.css       # :root scales, theme presets, fallback layer
client/css/base.css         # reset, typography, focus rings, reduced-motion
client/css/components.css   # .surface-card, .btn-*, .field-*, .badge-*, .odometer
client/css/stage.css        # projection-only
client/css/control.css      # tabs, queue rows, tables
client/css/entry.css        # thumb-zone shell
client/css/emcee.css        # OLED podium
```

Surfaces load `tokens → base → components → <surface>`. **No `<style>` blocks in HTML** — every surface currently carries one, which is why `/entry`'s 20 px checkbox and `/stage`'s 116 px odometer drifted out of the system.

### 5.1 Tokens

```css
:root {
  /* ---- 4 customer-facing brand variables (ADR-05) ---- */
  --brand-hue: 85;          /* champagne gold */
  --brand-chroma: 0.12;
  --brand-accent: oklch(0.80 var(--brand-chroma) var(--brand-hue));
  --brand-radius: 14px;

  /* ---- 3-step lightness elevation (replaces double-bezel) ---- */
  --bg-canvas:   oklch(0.15 0.010 var(--brand-hue));
  --bg-surface:  oklch(0.21 0.012 var(--brand-hue));
  --bg-elevated: oklch(0.26 0.014 var(--brand-hue));

  --ink-primary:   oklch(0.97 0.005 var(--brand-hue));
  --ink-secondary: oklch(0.78 0.012 var(--brand-hue));
  --ink-muted:     oklch(0.68 0.014 var(--brand-hue));   /* ≥ 4.5:1 on --bg-surface */

  --line-hairline: oklch(0.32 0.010 var(--brand-hue));
  --line-strong:   oklch(0.42 0.014 var(--brand-hue));

  /* ---- semantic, fixed hue, never themed ---- */
  --ok:     oklch(0.76 0.17 152);
  --warn:   oklch(0.80 0.16  75);
  --danger: oklch(0.55 0.20  27);   /* #DC2626-equivalent: 4.83:1 with white — fixes D12 */
  --on-danger: oklch(1 0 0);

  /* ---- strict 4pt scale ---- */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-7: 32px; --space-8: 40px;
  --space-9: 48px; --space-10: 64px; --space-11: 80px; --space-12: 96px;

  --tap-min: 56px;          /* volunteer ergonomics */
  --tap-min-secondary: 44px;
}

/* Presets set only the 4 brand variables. */
[data-theme="champagne"] { --brand-hue:  85; --brand-chroma: 0.12; }
[data-theme="sapphire"]  { --brand-hue: 255; --brand-chroma: 0.14; }
[data-theme="emerald"]   { --brand-hue: 152; --brand-chroma: 0.13; }
/* [data-theme="custom"] — hue/chroma written onto :root from the state payload */
```

**Fallback layer (ship it).** AV laptops are not always current. Precede each OKLCH declaration with a hex fallback for the three presets, guarded by `@supports not (color: oklch(0 0 0))`. Cheap insurance; the failure mode otherwise is an unstyled projector at 7 pm.

### 5.2 Rules the tokens enforce

| Abolish | Replace with |
|---|---|
| `.double-bezel-card` > `.double-bezel-inner` (24 nested pairs across 4 files) | single flat `.surface-card { background: var(--bg-surface); border: 1px solid var(--line-hairline); border-radius: var(--brand-radius); }` |
| `box-shadow: 0 20px 40px -15px …`, `0 25px 60px …`, `0 0 40px var(--*-glow)` | elevation by background step. One shadow token `--shadow-lift: 0 1px 2px oklch(0 0 0 / .4)` for genuinely floating elements (toast, modal) only. |
| `-webkit-background-clip: text` + transparent fill (**cause of D2**) | solid `color: var(--brand-accent)` |
| `backdrop-filter: blur(16px)` ×3 | removed — invisible on a projector, expensive on an iPad |
| `animation: pulseGlow 3s infinite` on the match banner | static pill; motion reserved for state *changes* |
| ad-hoc `style="…"` attributes (≈300 across the four HTML files) | utility + component classes |

### 5.3 Odometer — jitter elimination

Two jitter sources today: proportional-width glyphs and an `em`-based reel height that reflows with font size.

```css
.odometer { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
.odometer-reel {
  inline-size: 1ch;              /* fixed coordinate box — no horizontal jitter  */
  block-size: var(--odo-line);   /* fixed line box     — no vertical  jitter     */
  line-height: var(--odo-line);
  overflow: clip;
}
.odometer-cell { block-size: var(--odo-line); }
.odometer-track { transform: translateY(calc(var(--d) * var(--odo-line) * -1)); }
```

`--odo-line` is set per surface (`130px` stage, `72px` podium, `32px` control) so reel geometry never depends on font metrics. Digit count changes (`$99,000` → `$100,000`) prepend a reel at `--d: 0` **before** the transition frame, so the comma does not slide.

---

## 6. Surface specifications

### 6.1 Volunteer Pledge Pad — `/entry`

Rewrite `client/js/entry.js` from scratch (it does not currently parse) as an explicit state machine.

**Shell.** `100dvh` grid: `header (auto) / pane (1fr, scrolls) / actionbar (auto, sticky bottom)`. `padding-bottom: env(safe-area-inset-bottom)`. **The primary action is never below the fold.** Fixes D10.

**Two-stage disclosure.**

```
Step 1 — How much?            Step 2 — Who?
┌──────────────────────┐      ┌──────────────────────┐
│ $12,500              │      │ $12,500  [Edit]      │  ← amount pinned, always visible
│──────────────────────│      │──────────────────────│
│ 10k  5k  2.5k        │      │ Donor name        [ ]│
│ 1k   500  Custom     │      │ Say it like…      [ ]│  ← donor_phonetic (optional)
│──────────────────────│      │ [ ] Give anonymously │  ← 56px row, not a 20px box
│  1   2   3           │      │ Card #   │ Table #   │
│  4   5   6           │      │ Pledge Card Cash Chk │
│  7   8   9           │      └──────────────────────┘
│ 00   0   ⌫           │      ┌──────────────────────┐
└──────────────────────┘      │ ← Back │ Record Gift │
┌──────────────────────┐      └──────────────────────┘
│        Next →        │
└──────────────────────┘
```

Step 1 is numpad-only → **the software keyboard never appears**, so it can never collide with the pad. Step 2 is text-only → the keyboard is expected and the pane scrolls under a sticky action bar.

**Amount reducer** (replaces the tangled `isPresetSelected` flag):

```js
const amount = { mode: 'empty', cents: 0 };   // 'empty' | 'preset' | 'custom'
function reduce(a, ev) {
  switch (ev.type) {
    case 'preset': return { mode: 'preset', cents: ev.cents };
    case 'digit':  return { mode: 'custom',
      cents: Math.min(MAX_CENTS, (a.mode === 'preset' || a.mode === 'empty' ? 0 : a.cents) * 10 + ev.d * 100) };
    case 'double_zero': return a.mode === 'custom'
      ? { mode: 'custom', cents: Math.min(MAX_CENTS, a.cents * 100) } : a;
    case 'backspace': { const c = Math.floor(a.cents / 100 / 10) * 100;
      return c ? { mode: 'custom', cents: c } : { mode: 'empty', cents: 0 }; }
    case 'clear': return { mode: 'empty', cents: 0 };
  }
}
```
Tapping a preset sets cleanly; the first digit after a preset **replaces** rather than appends. Ask tiers are rendered from `state.ask_tiers` (Settings), not hardcoded HTML.

**Validation.** Inline, at the field, on submit attempt — `aria-invalid`, `aria-describedby`, focus moves to the first offender. **Zero `alert()`.** Fixes D13.

**409 Duplicate Card Number — non-destructive.** Keep every keystroke. Render below the card field:

> **Card #0412 is already recorded.**
> $5,000 from The Henderson Family Trust, entered by Maria at 7:42 pm.
> [ Use a different card number ] [ This is the same gift — discard ]

The pledge stays in the outbox in a `blocked` state, visible in "Your recent entries", until resolved. Today the pledge is silently dropped after an `alert()`.

**Undo toast.** 8 s, duration read from `stage_delay_ms` so the promise ("you can still catch it before the room sees it") is literally true. Countdown ring via `@property --p` + `conic-gradient`, `position: fixed`, `contain: layout paint` — **zero layout shift**. Falls back to a linear bar where `@property` is unsupported. Under `prefers-reduced-motion` the ring becomes a stepped numeric countdown.

**Touch targets.** Every interactive element ≥ 56 px with ≥ 8 px gaps; secondary/utility ≥ 44 px; nothing below 24 px anywhere. Fixes D11.

### 6.2 Event Control Room — `/control`

Three tabs (`role="tablist"`, roving tabindex, `?tab=` deep-link) plus a **persistent transport bar** and reconciliation banner that are visible on all tabs.

```
Total Raised $105,000 · 21% of $500,000 · ● Live Connected
[ Pause Ballroom Screen ]  [ Launch Stage Confetti ]  [ Resync Ballroom Total ]
⚠ Ballroom screen is $500,000 above the verified total.  [ Resync Ballroom Total ]   ← only when drift ≠ 0
─────────────────────────────────────────────────────────────────────────────
 Live Stage Queue │ Donation List │ Event Setup
```

**Tab 1 — Live Stage Queue.** Rows show a countdown ring to air, then `On the ballroom screen`. One button per row: **Hold from Stage** (`--danger`, ≥ 44 px, white on `#DC2626`). Held rows collapse to a muted strip with **Put Back on Screen**. Keep the existing DOM-diffing renderer — it correctly preserves hover/focus during 1 Hz repaints — but drive it off `data-donation-id` keys and a `<template>` rather than `innerHTML` string building.

**Tab 2 — Donation List & Adjustments.** The verified ledger, newest first: amount, donor, card #, volunteer, time, status. Row actions: **Edit** (amount / name / anonymous / card / table / phonetic → `amend`), **Remove** (`void`, with reason), **Adjust Ballroom Screen Total** (manual override, with a plain-English explanation of what it does and a one-click revert). CSV export moves here, next to the data it exports.

**Tab 3 — Event Setup & Rehearsal.** §7.

**Emergency transport.** *Pause Ballroom Screen (Blackout)* holds the last frame and shows a neutral slate — currently `is_frozen` only renders a small "Display Paused" chip while the live number keeps updating behind it, which is not a blackout. Fix: when frozen, `/stage` renders the event title over `--bg-canvas` and stops all number updates.

### 6.3 Podium Screen — `/emcee`

True OLED black `#040609`. Three blocks, readable in 3 seconds from a lectern at ~700 mm:

1. **Total Raised** — 72 px, tabular-nums, no gradient.
2. **Say this next** — one card, not two lists: largest un-announced gift, with donor name, `donor_phonetic` in italic beneath, table number badge, amount. An **Announced** button marks it done and advances (requires an `announced_donation_ids` set in `event_state`; without it the emcee re-reads the same name all night).
3. **Milestone gap** — `$4,200 to reach the $500,000 Milestone`, `--ok`.

Below the fold: recent gifts and top gifts, as reference. Gated behind the entry PIN (it displays legal names).

### 6.4 Main Ballroom Screen — `/stage`

- **130 px odometer**, solid `--brand-accent`, tabular-nums, fixed reel boxes (§5.3). **D2 fixed.**
- **One progress line** — 12 px track, milestone **pips** on the line (not floating pills with the current `stagger-high` collision hack). Reached pips fill `--brand-accent`; the label renders only for the *next* unreached milestone. Milestones at or above goal are rendered at the 100% terminus instead of being silently dropped (today `m.cents >= goalCents` filters out the goal milestone entirely).
- **Match banner** — static pill, `Every gift doubled — $100,000 match from the Board`. No pulse animation.
- **Lower-third chyron ticker** — single lane, 4 s dwell, cross-fade. Keeps the surge-aggregation behaviour (≥ 6 pending → "7 gifts just came in · +$47,000").
- **QR** — real encoder (ADR-06), ≥ 288 px module area, pure white quiet zone.
- Zero legal names in the payload (already correct — regression-test it).

---

## 7. Zero-code settings panel

`GET|PUT /api/settings` (control PIN). `PUT` takes a partial patch, validates server-side, writes in one transaction, bumps `settings_seq`.

| Group | Fields | Live effect |
|---|---|---|
| **Event Identity** | Title, Subtitle, Donation link (QR target) | Stage header + podium + QR regenerate |
| **Goal & Milestones** | Goal dollars; milestone rows (25/50/75/100 % presets, editable label + %, add/remove/reorder); Celebrate with confetti automatically | Stage pips, podium gap, auto-confetti |
| **Look & Feel** | Champagne Gold / Royal Sapphire / Emerald Green / Custom HEX; corner roundness slider | **All four surfaces re-token within 1 s** |
| **Volunteer Quick Amounts** | Up to 6 tiers, dollar + label, drag to reorder, Custom always last | `/entry` preset grid |
| **Matching Gift** | Sponsor name, pool $, ratio (1:1 / 2:1 / custom), Active toggle | Stage banner, podium badge, match engine |
| **Safety** | Major-gift confirmation threshold ($9,500), Stage delay (8 s), No-backward rule on/off | Guardrail, buffer, floor |
| **Passcodes** | Control Room PIN, Volunteer Pad PIN (set/change only; never displayed) | Auth gates |

**Interaction rules.** Dollar fields accept `500000`, `$500,000`, `500k` and normalise on blur. Every change is `Save`-explicit with an inline "Saved · 7:41 pm" receipt (no autosave — this is a live event; a stray keystroke must not move the goal mid-appeal). Destructive settings (PIN change, threshold reduction) require re-entering the control PIN.

**Rehearsal tools** live in the same tab, renamed per §8: *Add 1 Test Gift*, *Test 7-Gift Burst*, *Add a Typo Gift (practise Hold)*, *Jump to Next Milestone*, *Clear All Test Data*. A persistent amber `REHEARSAL DATA PRESENT — N test gifts in the ledger` strip appears on `/control` until cleared, so nobody opens doors with fake money on the board.

---

## 8. Terminology & copy

Applies to every `<title>`, heading, button, badge, empty state, error, tooltip, log line, and the four `console.log` lines in `server/src/index.ts`.

| Current | Ship this |
|---|---|
| Stage 1080p HUD / Stage Canvas | **Main Ballroom Screen** |
| AV & Admin Control Deck / "Givebar Cockpit" / Master Control | **Event Control Room** |
| Emcee Confidence Monitor / Podium Confidence Monitor | **Podium Screen** |
| Volunteer Entry Terminal | **Volunteer Pledge Pad** |
| `🛑 YANK` / Un-Yank | **Hold from Stage** / **Put Back on Screen** |
| Folded Ledger Total / Authoritative Gala Total Raised | **Total Raised** |
| Card Serial Collision | **Duplicate Card Number** |
| Monotonic Sequence Polling | **● Live Connected** |
| Manual Override Total | **Adjust Ballroom Screen Total** |
| Force Odometer Resync | **Resync Ballroom Total** |
| Freeze Stage Screen | **Pause Ballroom Screen** |
| Chyron Broadcast Delay Buffer | **Waiting to Show on Screen (8 seconds)** |
| Authoritative Event Ledger Audit Trail | **Every Gift, In Order** |
| Wipe All Ledger Data | **Clear All Gifts and Start Over** |
| Clerk / entered_by | **Volunteer** |
| `⚡ Rapid Burst (7 Pledges)` | **Test 7-Gift Burst** |
| `⚠️ Inject Typo (Test Yank)` | **Add a Typo Gift (practise Hold)** |
| `🎉 Trigger Confetti Burst` | **Launch Stage Confetti** |
| Pledge Value (USD) | **How much?** |
| Donor Legal Name * | **Donor name** |

**Emoji are stripped from every button label** (17 occurrences). Emoji survive only as decorative `aria-hidden` glyphs in the confetti particle set. Error copy states what happened, what it means, and what to do next — never a raw exception string, which `postControl()` currently `alert()`s straight to the AV tech.

---

## 9. File-by-file change map

### Server

| File | Action |
|---|---|
| `server/src/db.ts` | Add `user_version` migration runner (`migrations/001…003`). New tables `held_donations`, `active_card`, `milestone`, `ask_tier`. New `event_state` columns. Backfill + drop `milestones_json`, `match_pool_cents`. |
| `server/src/ledger.ts` | **Split.** Fold + mutations stay; projections move out. Add `match_release`. Fix `amendDonation` column misalignment (**D5**) — switch every write to **named parameters** (`$donation_id`) so positional drift is structurally impossible. Emit `match_release` on void/amend (**D3/D9**). Indexed collision via `active_card` (**D15**). `normalizeCard`. Advance `odometer_floor_cents` in write transactions only (**D4**). Drop `match_pool_cents` writes (**ADR-02**). |
| `server/src/projection.ts` | **New.** `getStageState` / `getEmceeState` / `getControlState` / `getVolunteerState`, all pure reads. Horizon-delayed stage fold (**ADR-01**). Strip PINs from every payload (**D6**). Add `theme` + `settings_seq` to all roles (**ADR-05**). |
| `server/src/settings.ts` | **New.** Typed settings read/patch, validation, milestone/tier CRUD, hex→OKLCH conversion for custom themes. |
| `server/src/auth.ts` | **New.** `POST /api/auth`, HMAC cookie, `requireRole()` middleware, `GIVEBAR_DISABLE_AUTH` escape hatch (**D6/D7**). |
| `server/src/routes/state.ts` | Delegate to `projection.ts`. **Delete the `default:` branch** that dumps `getEventState(db)` — the PIN leak path. Gate `role=control`/`emcee`/`entry`. |
| `server/src/routes/donation.ts` | 428 major-gift guardrail (**ADR-03**). Enriched 409 body. Accept `donor_phonetic`, `table_number`. Entry-PIN gate. |
| `server/src/routes/control.ts` | Rename actions to plain verbs (`hold_from_stage`, `put_back_on_screen`, `pause_screen`, `resume_screen`, `resync_ballroom_total`, `adjust_screen_total`). Delete `set_goal`/`set_match`/`set_qr_url`/`set_event_name`/`set_milestones`/`update_pins` — all move to `/api/settings`. Keep transport + `clear_all_gifts`. |
| `server/src/routes/settings.ts` | **New.** `GET`/`PUT /api/settings`. |
| `server/src/routes/rehearsal.ts` | Control-PIN gate. Tag rows `is_rehearsal = 1`. `clear_test_data` mode. Deterministic seeded RNG so rehearsals are reproducible. |
| `server/src/routes/qr.ts` | Replace `buildQRMatrix` with vendored `qrcodegen` (**D8**). Keep SVG wrapper. |
| `server/src/vendor/qrcodegen.ts` | **New.** MIT, vendored verbatim, header comment recording source + version. |
| `server/src/routes/export.ts` | Add `Held`, `Rehearsal`, `Phonetic`, `Table` columns; `match_release` in the reconciliation footer. Control-PIN gate. |
| `server/src/routes/webhook.ts` | Per-provider shared secret. Set `confirmed_major_gift` explicitly + audit note. |
| `server/src/index.ts` | Serve from `client/` root. `/` → `client/index.html`. `no-store` on HTML, ETag + `must-revalidate` on css/js (stale JS after a mid-event hotfix is unacceptable). Plain-English startup banner. |

### Client

| File | Action |
|---|---|
| `client/index.html` | **New** launcher — four large labelled cards, the four PIN-gated URLs, and a QR to `/entry` for volunteer phones. |
| `client/{stage,control,entry,emcee}.html` | **Moved** from `client/public/`. Rewritten: no `<style>` blocks, no inline `style=`, no `double-bezel`, plain-English copy, correct landmarks/heading order/labels. |
| `client/css/app.css` | **Deleted** → split into 7 files (§5). |
| `client/js/entry.js` | **Rewritten** (**D1**). Two-stage shell, reducer, inline validation, non-destructive 409, 8 s undo ring, outbox with `blocked` state. |
| `client/js/control.js` | **Rewritten.** Tabs, transport bar, drift banner, settings panel, `<template>` rendering, zero `alert()`. |
| `client/js/stage.js` | Odometer without gradient (**D2**), pip progress line, blackout mode, live theming. |
| `client/js/emcee.js` | "Say this next" card + Announced state, phonetic, live theming. |
| `client/js/odometer.js` | Fixed `1ch`/`--odo-line` geometry; `allowBackward` now purely presentational (the ratchet is authoritative server-side). |
| `client/js/theme.js` | **New.** `applyTheme(theme)` — writes CSS custom properties on `:root` when `settings_seq` changes. Shared by all four surfaces. |
| `client/js/api.js` | **New.** Shared fetch wrapper: base path, PIN cookie, retry/backoff, connection-state events driving the `● Live Connected` indicator (today each surface reimplements this, and `/entry`'s indicator is decorative). |
| `client/js/mock-backend.js` | Gate on `window.GIVEBAR_STATIC` (**D14**); track the new event vocabulary. |
| `dist-static/` | **Deleted** after here.now republish is verified (ADR-07 risk note). |

### Build / infra

| File | Action |
|---|---|
| `package.json` | `build:static` → `dist/`, `reset-pins`, `test:client`, `check` (typecheck + client parse + tests). |
| `scripts/build-static.mjs` | **New.** Copies `client/` → `dist/`, injects `window.GIVEBAR_STATIC = true`. |
| `Dockerfile` | Drop `client/public` path assumption. `HEALTHCHECK` on `/api/health`. |
| `.gitignore` | `+dist/`, `-dist-static/`. |
| `README.md` | Rewritten around the four plain-English surfaces + run-of-show card. |
| `docs/RUN_OF_SHOW.md` | **New.** One printable page for the AV tech: URLs, PINs, the three emergency buttons, what to do when the number looks wrong, the `GIVEBAR_DISABLE_AUTH` escape hatch. |

---

## 10. Phased execution

Each phase is independently shippable and independently verifiable.

### Phase 0 — Stop the bleeding *(no redesign, no new features)*
- **T0.1** Fix `entry.js` brace nesting; **add `tests/client-syntax.test.ts`** that parses every file in `client/js/` with `Bun.Transpiler`. One cheap test that would have caught D1 before it reached a gala.
- **T0.2** Remove `text-gold-gradient` from the stage odometer; solid `--gold-300`. (D2)
- **T0.3** Convert every `ledger.ts` INSERT to named parameters; fix `source_txn_id`/`card_number`. (D5)
- **T0.4** `match_release` on void + amend; drop the `match_pool_cents` mutation. (D3, D9)
- **T0.5** Strip PINs from all payloads; delete the `default:` role branch. (D6)
- **T0.6** Interim D4 fix: voiding a gift lowers `odometer_floor_cents` when the void lands within `stage_delay_ms` of its create. (Full ADR-01 lands in Phase 2.)
- **T0.7** `--danger: #DC2626`, white ink. (D12)
- **Exit:** all defects reproduce green in tests; 22 existing tests still pass; browser check of all four surfaces.

### Phase 1 — Data + settings backbone *(server only, no UI change)*
- **T1.1** `user_version` migration runner + migrations 001–003. Round-trip test against a **copy of the real `data/givebar.sqlite`**.
- **T1.2** `held_donations`, `active_card`, `milestone`, `ask_tier`; backfill; drop `milestones_json`.
- **T1.3** `settings.ts` + `GET|PUT /api/settings` + validation.
- **T1.4** `auth.ts`, PIN gates, `GIVEBAR_DISABLE_AUTH`, `reset-pins`. (D7)
- **T1.5** Indexed card collision + normalisation. (D15)
- **Exit:** settings round-trip, migration idempotent, auth gates enforced, no client changes required.

### Phase 2 — Projection engine
- **T2.1** `projection.ts`; horizon-delayed stage fold; `drift_cents`. (ADR-01)
- **T2.2** Move the floor ratchet into write transactions; `getStageState` becomes pure. (D4)
- **T2.3** Server-enforced 428 guardrail; webhooks/rehearsal set the flag explicitly. (ADR-03)
- **T2.4** `theme` + `settings_seq` on every role payload. (ADR-05)
- **Exit:** hold-within-8s leaves the stage total untouched; drift banner appears on late voids; replay-equals-live test passes.

### Phase 3 — Design system
- **T3.1** Split `app.css` into 7 files; OKLCH tokens + hex fallback layer.
- **T3.2** `.surface-card`; delete `.double-bezel-*` and all 24 nested pairs.
- **T3.3** 4pt scale; purge ad-hoc `style=` attributes.
- **T3.4** Odometer geometry (`1ch` / `--odo-line`).
- **T3.5** `theme.js`; live re-tokening on `settings_seq` change.
- **Exit:** zero `double-bezel` / `background-clip: text` / `backdrop-filter` in the tree; contrast audit ≥ 4.5:1 on all text pairs and ≥ 3:1 on all UI boundaries; a themed swatch change propagates to all four surfaces within 1 s.

### Phase 4 — Surfaces (parallelisable: 4a/4b/4c/4d are independent)
- **T4a** `/entry` rewrite (§6.1). **Highest risk, most user-facing — do it first.**
- **T4b** `/control` rewrite (§6.2) + settings panel UI (§7).
- **T4c** `/stage` rewrite (§6.4) + real QR (D8).
- **T4d** `/emcee` rewrite (§6.3).
- **Exit:** each surface driven end-to-end in a real browser at its target viewport.

### Phase 5 — Copy & accessibility
- **T5.1** Terminology sweep (§8) across HTML, JS, server strings, README, console banner.
- **T5.2** Strip emoji from all action labels.
- **T5.3** WCAG 2.2 AA pass: landmarks, heading order, labels, focus visibility (`:focus-visible` ring ≥ 2 px, ≥ 3:1), focus traps in modals, target sizes, `prefers-reduced-motion` for odometer/confetti/toast, `aria-live="polite"` on the live total (`assertive` on the guardrail).
- **Exit:** keyboard-only run of the full pledge → hold → void flow; automated axe pass; manual screen-reader check of `/entry` and `/control`.

### Phase 6 — Infrastructure
- **T6.1** Move `client/public/*.html` → `client/`; add `client/index.html`; update the server.
- **T6.2** `scripts/build-static.mjs`; **republish all four here.now sites from `dist/` and verify each URL loads**; only then delete `dist-static/`. (ADR-07 risk)
- **T6.3** Cache headers, `/api/health`, Dockerfile.
- **Exit:** four here.now URLs verified live; `bun run check` green from a clean clone.

### Phase 7 — Verification (§11)

---

## 11. Test & verification plan

### Automated — new files under `tests/`

| File | Asserts |
|---|---|
| `client-syntax.test.ts` | Every `client/js/*.js` parses. **Catches D1 class.** |
| `migration.test.ts` | v0 → v2 on a copy of the real DB; idempotent re-run; no row loss; `milestones_json` fully backfilled. |
| `fold-determinism.test.ts` | **Invariant #1.** Random 500-event create/amend/void/match sequence; replaying the ledger into a fresh DB reproduces `total_raised_cents` bit-for-bit. Would have caught D3. |
| `stage-delay.test.ts` | **Invariants #2, #5.** Gift is absent from `stage_total_cents` before the horizon and present after. Hold within the window → never appears, floor unchanged. Void after the window → floor holds, `drift_cents` non-zero. |
| `guardrail.test.ts` | **Invariant #3.** `$9,500` without `confirmed_major_gift` → 428; with → 201. `$9,499` → 201. Threshold honours Settings. Rehearsal/webhook paths audited. |
| `collision.test.ts` | **Invariant #4.** 409 + prior clerk. `#0412` ≡ `0412`. Voided card is reusable. Two amends on one carded gift both succeed (**D5 regression**). |
| `privacy.test.ts` | **Invariant #6.** No `role=stage` payload — under any anonymity/hold/match permutation — contains a legal name, PIN, card number, or note. Property test over the whole payload tree. |
| `settings.test.ts` | Round-trip every field; validation rejects negative goals, ratio ≤ 0, > 6 tiers, malformed hex; `settings_seq` increments; theme reaches all four role payloads. |
| `auth.test.ts` | Every gated route → 401 without a cookie; correct PIN → 200; **no payload on any route contains `entry_pin` or `control_pin`** (D6 regression). |
| `match.test.ts` | Pool caps; void refunds; amend re-applies; pool never negative; derived pool equals `total − Σapply + Σrelease`. |

Target: **≥ 60 tests**, all deterministic, all runnable via `bun test` in under 5 s.

### Manual — rehearsal script (`docs/RUN_OF_SHOW.md`)

Run on the actual venue hardware, on the actual venue network, with the projector at its actual throw distance.

1. **Legibility.** From the back row, read the total. From 30 ft, read a chyron name.
2. **QR — closes D8.** Scan the stage QR with two different phones (iOS + Android) from 15 ft. *This is the only way to verify the encoder; it cannot be checked headlessly.*
3. **Dead-pad check — closes D1.** On a volunteer phone: tap `5`, tap `$10,000`, confirm the display reads `$10,000`. If it reads `$0`, the pad is dead — stop and escalate.
4. **Guardrail.** Enter `$50,000` → confirmation intercept. Cancel → amount preserved. Confirm → recorded.
5. **Hold-from-Stage — closes D4.** *Add a Typo Gift*, then Hold within 8 s. Verify on the projector that **neither the name nor the number** ever appears, and that the total is unchanged.
6. **Late void.** Add a gift, let it air, remove it. Verify the ballroom total holds steady and the control room shows the drift banner. Click *Resync Ballroom Total* and watch it settle.
7. **Duplicate card.** Two volunteers enter `#0412`. Second sees the inline card with the first volunteer's name — **and their typed donor name is still in the field**.
8. **Anonymous.** Enter an anonymous gift. Confirm the ballroom shows `Anonymous Supporter` and the podium shows the same. Confirm the legal name appears only in the Control Room and the CSV.
9. **Live theming.** Switch Champagne Gold → Royal Sapphire. All four screens re-token within one second, no reload, no flash.
10. **Blackout.** *Pause Ballroom Screen* → slate. Add a gift → screen does not move. Resume → number catches up in one roll.
11. **Network flap.** Pull the volunteer phone's Wi-Fi, enter two gifts, restore. Both arrive exactly once; the indicator went red and returned to `● Live Connected`.
12. **Reconciliation.** Export CSV. Verify the footer balances to the cent against the Control Room total, and that held/rehearsal rows are flagged.
13. **Clear test data.** Confirm the amber rehearsal strip disappears and the total returns to `$0`.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration corrupts a real event DB | Low | Catastrophic | Migration runs inside one transaction; server refuses to start if `user_version` is ahead of the binary; automatic timestamped backup copy before any migration; `migration.test.ts` runs against a copy of the real file. |
| PIN gates lock the AV tech out mid-event | Medium | Severe | `GIVEBAR_DISABLE_AUTH=1`, `bun run reset-pins`, both printed in the startup banner and on the run-of-show card. **Non-negotiable — ships in the same commit as the gate.** |
| Delayed stage total confuses the operator ("why doesn't it match?") | High | Moderate | The Control Room always shows both numbers, labelled *Total Raised (verified)* and *On the ballroom screen*, with an explicit drift banner and one-click resync. The 8 s lag is stated in the Live Stage Queue header. |
| Deleting `dist-static/` breaks four live here.now sites | Medium | Moderate | Republish from `dist/` and verify all four URLs **before** deletion (T6.2). |
| OKLCH unsupported on an old venue laptop | Low | Severe | `@supports` hex fallback layer for the three presets. Verify on the actual show laptop at rehearsal. |
| Rewriting all four surfaces at once destabilises everything | High | Severe | Phase 0 ships standalone and is independently valuable. Phases 4a–4d are separately mergeable and separately revertable. Never merge two surface rewrites in one commit. |
| `donor_phonetic` goes unfilled, making the podium card useless | High | Low | Optional field, Stage 2 only, `placeholder="TAR-ik al-man-SOOR"`. Podium falls back to the plain name. Editable later from the Donation List. |
| Vendored `qrcodegen` drifts from upstream | Low | Low | Pin the version in a header comment; it is a finished spec-complete algorithm with no maintenance surface. |

---

## 13. Definition of done

- [ ] All 15 defects closed, each with a regression test.
- [ ] All 7 core invariants covered by an automated test that fails if the invariant is removed.
- [ ] `bun run check` green from a clean clone (typecheck + client parse + ≥ 60 tests).
- [ ] Zero `alert()` / `confirm()` / `prompt()` in `client/`.
- [ ] Zero `double-bezel`, zero `background-clip: text`, zero `backdrop-filter`, zero inline `style=` attributes.
- [ ] Every interactive target ≥ 56 px on `/entry`, ≥ 44 px elsewhere, ≥ 24 px absolute floor everywhere.
- [ ] Every text pair ≥ 4.5:1; every UI boundary ≥ 3:1.
- [ ] An event director who has never seen the code can change title, goal, milestones, theme colour, ask tiers, matching gift, and PINs entirely from `/control` — with no file, no restart, and no developer.
- [ ] The 13-step rehearsal script passes on venue hardware, including a physical phone scan of the stage QR.
