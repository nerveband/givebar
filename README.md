# Givebar

Live fundraising bar chart and stage suite for nonprofit galas and benefit appeals. One Bun process, one SQLite file, no external services in the money path.

- **Fullscreen Bar Chart** `/chart` for the projector or LED wall: rolling total, progress bar, recent-gift feed, rotating impact messages, donation QR.
- **Presenter View** `/presenter` for the podium: current donor with pronunciation, total, next milestone, full gift list.
- **Manage Donations** `/donations` for operators: add, edit, delete, undo, team notes, stage messages, pause switch, CSV.
- **Settings** `/settings`, **Testing** `/testing`, **History** `/history`, **Home** `/` with links, presence, and the team briefing.

---

## How the money is protected

| Rule | What it means on the night |
| :--- | :--- |
| Append-only ledger | Every add, edit, delete, and restore is a new row with the operator's name and the exact time. Nothing is overwritten. History shows all of it. |
| Staging delay (8 s) | A gift reaches the ballroom screen 8 seconds after it is recorded. Delete or correct it before then and the room never sees it. |
| Major gift confirmation | Gifts at or above the threshold ($9,500 by default) need a second confirmation so $5,000 never becomes $50,000. |
| Duplicate guards | The same donor and amount entered twice within 10 minutes is challenged before it counts. Pledge card numbers are unique. Online gifts import once, keyed by their Bloomerang transaction ID. |
| No-backward chart | Once a figure is on the wall it never rolls back. A later delete is absorbed by the next gifts. |
| Pause | Operators can hold the wall figure and hide the feed during an emergency, then resume. |
| Privacy shield | The audience feed carries a display name, amount, and time. Team notes, operator names, card numbers, and the legal names of anonymous donors stay inside the operator pages. |
| Backups | A consistent snapshot of the whole database is taken every 5 minutes when anything changed, and before any purge, reset, restore, or deploy. Administrators can download any snapshot or restore one. |

---

## Accounts and roles

Administrators create one account per person in Settings → Operator accounts and either hand over the name and PIN or send an **email invite**. The invite carries a one-time sign-in link (7 days), the person's sign-in name, and the steps for the night. Home → **Copy briefing** gives the same steps plus every link as plain text for a group chat.

| | Operator | Administrator |
| :--- | :---: | :---: |
| Record, edit, delete, restore gifts; team notes | yes | yes |
| Stage message, impact rotation, pause/resume chart | yes | yes |
| CSV export, History, Home presence | yes | yes |
| Settings, milestones, appearance, QR, ask tiers, matching | | yes |
| Rehearsal gifts and purge, full reset | | yes |
| Backups, restore, accounts, invites, Fundraising import setup | | yes |

Sessions last 12 hours. Disabling an account ends its session immediately. Five wrong PINs lock a name for 15 minutes.

---

## Online gifts (Bloomerang Fundraising)

Settings → Connections → Bloomerang Fundraising. Set the gala form ID and the date to import from, tick **Automatically import gifts**, and save. The server reconciles the form every 30 seconds; **Sync now** runs the same reconciliation. Only the gift amount counts: donor-covered fee assistance and ticket or store purchases are excluded. Refunds and corrections append ledger events and release matching funds. A gift an operator deleted stays deleted. Never enter online gifts by hand.

The Fundraising token lives in a mode-600 file on the server (`GIVEBAR_FUNDRAISING_TOKEN_FILE`). It is never shown in the app.

---

## If something goes wrong

| Situation | What to do |
| :--- | :--- |
| Typo just entered | Manage Donations → **Delete** on that row inside 8 seconds. Nobody in the room sees it. |
| Typo noticed later | **Edit** the row (amount, name, note, anonymous) or **Delete** it. The wall figure holds; the total and the presenter update immediately. |
| Deleted the wrong gift | Press **Undo** in the banner (30 s) or History → **Restore**. |
| Two people entered the same gift | The second entry is challenged. If it slipped through, delete one; History keeps the record. |
| Operator's laptop drops off Wi-Fi | Keep the page open. Gifts recorded offline wait in the browser ("waiting to sync") and send when the network returns, without creating duplicates. The banner reads "Connection lost" until then. |
| Chart shows something wrong | Manage Donations → **Pause chart**. Fix the ledger. **Resume chart**. |
| Someone changed settings mid-appeal | Only administrators can; Settings warns when another session saved first. Settings → Backups → restore the last snapshot if needed. |
| Serious data mistake | Settings → Backups and restore → **Restore** on the snapshot before the mistake. A pre-restore snapshot is taken first. Accounts and sessions are untouched. |
| Server restart | Everything is in `data/givebar.sqlite`. Presence rebuilds in 5 seconds; open pages reconnect on their own. |

---

## Launch checklist

1. **Accounts**: create every operator, send invites or hand out PINs, disable test accounts. Have each person sign in once before doors.
2. **Rehearsal**: Testing → inject sample gifts, delete one inside 8 seconds and watch the chart never show it, practise Edit and Undo, check the presenter reads names correctly.
3. **Purge**: Testing → **Purge Sample Data**. Confirm Home shows the real total (online gifts already imported) and the chart resets.
4. **Settings**: goal, milestones, event title, QR target and printed URL, ask tiers, major-gift threshold, staging delay. Scan the QR on the real projector.
5. **Room screens**: open `/chart?fullscreen=1` on the projector machine and `/presenter` on the podium tablet. Both are public URLs; nobody signs in on them.
6. **Bloomerang**: Settings → Connections shows "Automatic import on" with a recent sync time. Make a $1 test gift online if you want to see it arrive (then delete it).
7. **Backups**: Settings → Backups → **Snapshot now**, then **Download a fresh copy** and keep it on a laptop.
8. **During the appeal**: one person watches Manage Donations for "Waiting to appear" and the stale banner; the emcee keeps `/presenter` open; nobody opens Settings or Testing.
9. **After**: CSV export for finance; a final download of the database.

---

## Running it

```bash
bun install
bun dev                      # http://localhost:3000, database at data/givebar.sqlite
bun test
```

Environment: `PORT`, `HOST`, `GIVEBAR_DB_PATH`, `GIVEBAR_FUNDRAISING_TOKEN_FILE`, and for invite emails either `BREVO_API_KEY` or `BREVO_SMTP_USER` + `BREVO_SMTP_KEY`. Backups are written next to the database in `backups/`.

### Production (wavedepth)

`scripts/deploy-wavedepth.sh` syncs the checkout to the host, snapshots the live database, builds an image tagged with the commit, swaps the `givebar` container, health-checks it, and rolls back on failure. The database and its snapshots live in `/etc/dokploy/applications/givebar/data`. The first start after this release upgrades a previous-release database in place; anything older must start from a fresh database or a restored snapshot.

License: MIT.
