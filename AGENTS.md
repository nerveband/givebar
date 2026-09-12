# Givebar — Agent & Contributor Contract

## Overview & Mission
Givebar is a live fundraising bar chart and stage presentation suite for high-stakes nonprofit galas and benefit appeals ($100k–$2M+).

---

## 1. Architectural & Financial Invariants
1. **Append-Only Event Ledger**: Source of truth is an immutable SQLite event stream (`create`, `amend`, `void`, `restore`, `match_apply`, `match_release`). Total is a deterministic fold (`foldLedger`). Only rehearsal purge and the admin reset delete ledger rows, and both snapshot the database first.
2. **Staging Delay**: A gift is excluded from the audience chart until `stage_delay_ms` (8 s) after it was recorded. Exclusion is by donation, so a delete or correction made inside the window is honoured the moment the gift would have appeared. `getStageState` and `getControlState` share `stagedView` for this.
3. **Major Gift Guardrail**: The server rejects gifts at or above `major_gift_threshold_cents` with 428 unless `confirmed_major_gift: true`; amended amounts crossing the threshold need it too.
4. **Duplicate Guards**: Physical card serials are unique among active gifts (409 `CARD_COLLISION`). A manual gift with the same normalised donor name and amount as an active gift recorded within 10 minutes is a 409 `POSSIBLE_DUPLICATE` unless `confirmed_duplicate: true`. Imports never trip the second guard; they are idempotent on `(source, source_txn_id)`.
5. **No-Backward Chart Rule**: `odometer_floor_cents` ratchets up whenever any projection computes the wall figure; deletes and downward corrections hold the audience total steady. Pause (`is_frozen`) holds the figure and hides the feed.
6. **Strict Privacy Shield**: The chart feed carries display name, amount, and time only. Team notes, operator names, legal names of anonymous donors, card numbers, and pronunciation never leave the operator role. The presenter sees names, pronunciation, and table numbers, never notes or operators.
7. **Pure Matching Grant Fold**: Matching funds are derived deterministically; voids and amendments emit compensating `match_release` events.

---

## 2. Access Model
* Named operator accounts only (`operator_account`, roles `admin` and `operator`), HttpOnly session cookies, single-use email invites. No shared PINs.
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
