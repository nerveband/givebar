# Givebar — Agent & Contributor Contract

## Overview & Mission
Givebar is a live fundraising bar chart and stage presentation suite for high-stakes nonprofit galas and benefit appeals ($100k–$2M+).

---

## 1. Architectural & Financial Invariants
1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite event stream (`create`, `amend`, `void`, `restore`, `match_apply`, `match_release`). Total is a deterministic fold (`foldLedger`). Only rehearsal purge and the admin reset delete ledger rows, and both snapshot the database first.
2. **Staging Delay**: A manual gift is excluded from the audience chart until `stage_delay_ms` (8 s) after it was recorded. Exclusion is by donation, so a delete or correction made inside the window is honoured the moment the gift would have appeared. Verified online gifts (`source = 'bloomerang'`) skip the window (`isLiveOnStage`). `getStageState` and `getControlState` share `stagedView` for this. The Fundraising sync polls every 5 s and backs off 30 s after a failure.
3. **Amount bounds**: `amount_cents` is a safe integer between 1 and `MAX_AMOUNT_CENTS` ($100,000,000) on record and amend (`isValidAmountCents`); the route rejects anything else with 400.
3. **Major Gift Guardrail**: The server rejects gifts at or above `major_gift_threshold_cents` with 428 unless `confirmed_major_gift: true`; amended amounts crossing the threshold need it too.
4. **Duplicate Guards**: Physical card serials are unique among active gifts (409 `CARD_COLLISION`). A manual gift with the same normalised donor name and amount as an active gift recorded within 10 minutes is a 409 `POSSIBLE_DUPLICATE` unless `confirmed_duplicate: true`; a replay from a browser outbox sends `queued_at` and the window is measured from then, so a long outage never slips a duplicate through. A PUT for a known `donation_id` is idempotent (200). Imports never trip the second guard; they are idempotent on `(source, source_txn_id)`, and a malformed upstream row is skipped with a reason (`fundraising_sync.last_error`) while the rest import.
5. **No-Backward Chart Rule**: `odometer_floor_cents` ratchets up whenever any projection computes the wall figure; deletes and downward corrections hold the audience total steady. Pause (`is_frozen`) holds the figure and hides the feed.
6. **Strict Privacy Shield**: The chart feed carries display name, amount, and time only. Team notes, operator names, legal names of anonymous donors, card numbers, and pronunciation never leave the operator role. The presenter sees names, pronunciation, and table numbers (named donors only), never notes or operators. Public feeds carry an opaque per-gift key (`publicKey`), never the ledger or import id.
7. **Pure Matching Grant Fold**: Matching funds are derived deterministically; voids and amendments emit compensating `match_release` events. A gift corrected after matching closes keeps the match it earned (scaled down if the gift shrank), never a fresh one.
8. **Recovery floors**: purge, re-sync, and restore set `odometer_floor_cents` to 0 and let `getStageState` ratchet from the staged view, so held and in-window gifts stay off the wall. Sample milestones and quick amounts are seeded into a brand-new database only.

---

## 2. Access Model
* **Public viewing, authenticated editing**: Home live totals, gift count and progress, Donations, History, Stats, `/projector`, and `/presenter` are public. Signed-out data is privacy-filtered on the server, including historical names of gifts marked anonymous. All mutations, administrative tools, private CSV exports, operator identities, and team notes still require a session. Public pages offer explicit sign-in links for protected actions; they must not automatically redirect merely to display financial data.
* **Financial display contract**: Home reads `total_raised_cents`, `goal_cents`, and `active_donation_count` from the public live ledger projection (`role=emcee`). Validate required figures before rendering: missing or invalid data is unavailable, never a zero or `NaN%`. Zero goals have no percentage; progress above the goal remains meaningful.
* **Revision-checked corrections**: the operator form sends `expected_seq` (the gift's `latest_seq` when the dialog opened); `amendDonation` rejects a stale form with `StaleEditError` (409 `STALE_EDIT`) so a note-only edit can never undo a colleague's amount or anonymity change. An amend event carries resolved values: an empty pronunciation or table clears it.
* **Browser outbox**: every manual gift is written to `localStorage` (`givebar_outbox`) before its request leaves, with `queued_at`; every change is a read-merge-write by `donation_id` so tabs never overwrite each other; entries stuck in `sending` for 60 s are replayed; each waiting gift can be discarded on its own.
* Every JSON write is same-origin (a foreign `Origin` header is a 403), bodies are capped (64 KB; 4 MB for Settings saves carrying an image), and pages send `X-Frame-Options: SAMEORIGIN`.
* Images uploaded in Settings are stored inline in `event_state` but every projection carries `/api/asset/<name>?v=<settings_seq>` instead of the bytes (`withAssetUrls`); the Settings form omits an unchanged asset URL on save.
* Named operator accounts only (`operator_account`, roles `admin` and `operator`), HttpOnly session cookies (`Secure` whenever the request arrived over HTTPS, directly or via `X-Forwarded-Proto`), single-use email invites. No shared PINs. The client never relies on secure-context-only APIs (`crypto.randomUUID` has a `getRandomValues` fallback) so a plain-HTTP laptop on the venue network still works.
* Operators: record, edit, delete, and restore gifts; stage messages; pause/resume the chart; team notes; CSV.
* Administrators additionally: Settings, Team and backups (`/team`: accounts, sign-in links, invites, snapshots, restore), Testing (rehearsal gifts, purge, chart re-sync), reset, Fundraising import configuration.
* Presence identity comes from the session; heartbeats require a session.

---

## 3. Design System
1. **Phosphor icon paths, never emoji** in UI buttons, badges, tables, or modals.
5. **No native dialogs**: every confirmation, prompt, and notice goes through `GivebarSession.confirm`, `prompt`, and `toast` in `client/js/session.js`. `window.confirm`/`prompt`/`alert` are prohibited.
2. **OKLCH token architecture** with a brand layer (`--brand-hue`, `--brand-chroma`, `--brand-accent`, `--brand-radius`).
3. **≥ 44 px touch targets** on operator surfaces; **56 px** in the donation dialog.
4. **Tabular numerals** on the odometer and every financial figure.

---

## 4. Zero-Code In-App Settings Rules
* Non-developers configure titles, goals, milestones, appearance, quick amounts, matching grants, and Fundraising import in **Settings** (`/settings`); accounts and backups live in **Team and backups** (`/team`).
* Never introduce external JSON configuration files for event settings. Settings persist in SQLite (`event_state`, `milestone`, `ask_tier`, `fundraising_sync`) and propagate live.

---

## 5. Deployment & Infrastructure
* **Production**: the manually run `givebar` container on the wavedepth host (`root@172.245.248.17`), bind-mounted `/etc/dokploy/applications/givebar/data` at `/app/data`, reached through Traefik at `givebar.wavedepth.com`. Deploy with `scripts/deploy-wavedepth.sh`.
* **Schema**: fresh databases are created at `SCHEMA_VERSION`; the only in-place upgrade is from the previous release (13). Anything older restores from a backup or starts fresh.
* **Backups**: `VACUUM INTO` snapshots in `data/backups` every 5 minutes when anything changed, plus pre-purge, pre-reset, pre-restore, and pre-deploy snapshots. Never copy `givebar.sqlite` by hand while the server runs.
* **Verification**: after changes run `bun test` once; judge observable ledger, privacy, staging, and role behaviour. Documentation-only work needs no test run.
* **Approval boundary**: source edits do not authorise deployment or changes to live financial data.
