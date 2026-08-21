# Givebar — Agent & Contributor Contract

## Overview & Mission
Givebar is a live fundraising thermometer and stage presentation suite for high-stakes nonprofit galas and benefit appeals ($100k–$2M+).

---

## 1. Architectural & Financial Invariants
1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite event stream (`create`, `amend`, `void`, `match_apply`, `match_release`). Total is a deterministic fold.
2. **Unified 8-Second Staging Delay**: Both ballroom odometer totals and lower-third chyrons pass through an 8-second staging horizon. Holding or undoing a pledge within 8 seconds prevents it from ever reaching the ballroom screen.
3. **$\ge \$9,500$ Major Gift Guardrail**: Server-enforced verification intercept modal (`confirmed_major_gift: true`) to prevent extra-zero errors ($50k $\to$ $500k).
4. **$O(1)$ Physical Card Duplicate Detection**: Unique card numbers (`#0412`) checked against `active_card` table, returning 409 Conflict with metadata without wiping volunteer form input.
5. **No-Backward Ballroom Screen Rule**: Downward voids or corrections hold the ballroom screen total steady, absorbing the difference into future gifts rather than rolling backward on stage.
6. **Strict Privacy Shield**: Anonymous donors display as *"Anonymous Supporter — $X"* on stage; real donor names are completely stripped before reaching the ballroom projection feed.
7. **Pure Matching Grant Fold**: Matching funds are derived deterministically. Voiding or amending a matched gift emits compensating `match_release` events, keeping sponsor pools 100% auditable.

---

## 2. Design System & Icon Standards
1. **Phosphor Icons Exclusively**: Never use emojis in UI buttons, badges, tables, or modals. Use vector Phosphor icons (`@phosphor-icons/web` and `client/js/icons.js`).
2. **OKLCH Token Architecture**: Base colors, surfaces, and inks defined using OKLCH with a 4-variable brand layer (`--brand-hue`, `--brand-chroma`, `--brand-accent`, `--brand-radius`).
3. **Apple-Grade Glassmorphism**: Frosted translucent glass surfaces (`backdrop-filter: blur(20px)`, `1px solid rgba(255,255,255,0.08)` hairline border lighting).
4. **Mobile Ergonomics**: All volunteer pad inputs and presets anchored in the **bottom 60% thumb zone** with $\ge 56\text{px}$ touch targets.
5. **Tabular Numeral Alignment**: Odometer and financial metrics must use `font-variant-numeric: tabular-nums` to eliminate layout jitter during fast rolls.

---

## 3. Zero-Code In-App Settings Rules
* Non-developers configure gala titles, goals, live theme swatches, quick-amount buttons, and matching grants directly in the **Event Setup** tab in `/control`.
* Never introduce external JSON configuration files or textareas for core event settings. All settings persist directly to SQLite child tables (`milestone`, `ask_tier`) and propagate live via 1-second state sync.

---

## 4. Deployment & Infrastructure
* **Production Deployment**: Hosted on `wavedepth` (`root@172.245.248.17`) running Dokploy on `panel.wavedepth.com` with Traefik reverse proxy and persistent SQLite volume mounted at `/app/data`.
* **Single Canonical Tree**: The application serves directly from `client/` and `server/` via Bun. Never reintroduce mock backends or static preview duplicates.
* **Test Verification**: Always run `bun test` before committing. All 42+ automated tests must pass.
