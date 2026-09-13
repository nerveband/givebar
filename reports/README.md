# End-of-night donor report

Three outputs from one build, all in `reports/out/` (gitignored):

| File | What it is |
|---|---|
| `<basename>.xlsx` | Full detail: every gift, every donor household, event log, online (Qgiv) detail, prospects vs actual, sponsors, ticket buyers, tables, declined attempts, timeline. Internal: legal names of anonymous donors and staff names are included. |
| `site/*.html` | Five-page interactive site: `index.html` (overview: numbers, takeaways, charts, website traffic, method), `donors.html`, `gifts.html`, `crossref.html`, `followup.html`. Paginated, searchable tables; a chapter menu top right. The PDF is the overview only and links to the online pages. |
| `<basename>.pdf` | Print of the HTML through headless Chromium (letter, booklet styling). Long tables are cut at 40 rows with a note. |
| `<basename>.json` | Stats and takeaways only, for diffing between refreshes. |

`<basename>` comes from `output_basename` in `reports/report.config.json`.

## Refresh in four commands

```bash
reports/pull-givebar.sh                                  # 1. snapshot the live ledger (Secret Gate SSH, Telegram approval)
secret-gate exec --item "CAIR-Georgia Givebar Fundraising API" --field credential --env QGIV_TOKEN -- bun reports/pull-qgiv.ts
                                                         # 2. online transactions since Jan 1 (token is form-scoped)
U=$(secret-gate item read --item "Givebar administrator - givebar.wavedepth.com" --fields username --reveal | jq -r .data.fields.username)
secret-gate exec --item "Givebar administrator - givebar.wavedepth.com" --field password --env GIVEBAR_PIN -- env GIVEBAR_USER="$U" bun reports/pull-stats.ts
                                                         # 2b. Stats dashboard incl. website analytics (optional)
bun reports/build-report.ts                              # 3. xlsx + site + pdf (add --no-pdf to skip Chromium)
reports/publish.sh                                       # 4. re-publish to the same password-protected share link (--password X to change it)
```

Step 2 can be skipped when nothing new came in online; the previous `reports/data/qgiv-history.json` is reused.

## Inputs

| Input | Path (config key) | Produced by |
|---|---|---|
| Givebar snapshot | `reports/data/givebar-prod.sqlite` (`inputs.givebar_sqlite`) | `reports/pull-givebar.sh`: `VACUUM INTO` on the host through `secret-gate ssh`, base64 over SSH, mode 600 locally. |
| Qgiv history | `reports/data/qgiv-history.json` (`inputs.qgiv_history`) | `reports/pull-qgiv.ts`: the reporting API, one request per calendar year. The current token only sees the 2026 gala form; an organisation-level token would add previous years. |
| Givebar Stats | `reports/data/givebar-stats.json` (`inputs.stats`), optional | `reports/pull-stats.ts`: signs in with the admin account, pulls `/api/stats` for all/30d/7d/24h (ledger stats plus Umami website analytics), logs out. |
| Bloomerang CRM | `reports/data/bloomerang.json` (`inputs.bloomerang`) | `reports/pull-bloomerang.ts` with `BLOOMERANG_API_KEY` in the environment (4,320 constituents, 9,338 transactions, about 2.5 minutes). The key is a CAIR-Georgia Bloomerang API key supplied by Ashraf; store it in 1Password ("AI Agents" vault) and run through `secret-gate exec`. Duplicate constituent records are folded by name and email; history excludes gifts on or after the gala day. |
| Staff MASTER workbook | `master_workbook` + `master_sheets`; `prospects_workbook` for the archived copy that still has the ask list | Downloaded from OneDrive (`Galas/2026 10th Anniversary/00 Master Planning & Logistics/2026 10th Anniversary MASTER.xlsx`) with the cair-georgia-m365-browser `onedrive_cli.py download` into `reports/data/master/`. The ask list (Donors 2026) was removed from the shared file after the gala, so it is read from the archived copy in the gala project checkout. Sheets: prospects (Donors 2026: name, gave earlier in 2026, ask, assumed gift, notes; rows stop at "Matches"), sponsors (Active Sponsors), tickets (Ticket Tailor export), tables (Final Tables). |

`reports/data/` and `reports/out/` are gitignored; the snapshot contains the full ledger and sessions table.

## Team notes

`readNote` in `reports/lib/data.ts` turns staff shorthand on each ballroom gift into a payment status: `check` (with the check number), `cash`, `card` (card details on the pledge card), or `pledge` (nothing collected). The status drives the "How the money arrives" figures, the payment filters on the Donors and Gifts pages, the Pledges to invoice list, and the Payment / Note-plain columns in the workbook. Add new shorthand patterns there.

## Code map

- `reports/lib/names.ts`: name normalisation and the `NameIndex` used for every cross-reference (titles stripped, couples split, first+last key, email match for online gifts).
- `reports/lib/data.ts`: loads everything, folds the ledger with the server's own `foldLedger`, builds `Gift`, `Donor`, `Stats`, and the generated takeaways (`buildTakeaways`). Change thresholds, bands, or the wording of takeaways here.
- `reports/lib/xlsx.ts`: workbook sheets (ExcelJS). Add a column by extending the sheet's column list and row mapper.
- `reports/lib/html.ts`: the HTML template, CSS (screen and print), inline charts, and the browser-side table code. The payload sent to the browser is built in `viewPayload`; anything new for the interactive tables goes there first.
- `reports/build-report.ts`: orchestration and the Chromium print (`~/.cache/ms-playwright/chromium-*` or a `chromium`/`google-chrome` on PATH).
- `reports/theme/`: the CAIR-Georgia logo and the wavedepth logo. `reports/theme/fonts/` (Brandon Grotesque, Plus Jakarta Sans) is gitignored because the fonts are licensed; `build-report.ts` copies them from the gala booklet release (`/home/nerveband/state/booklet-r22-spacing-release/versions/r16/assets`) when missing.

## Config (`reports/report.config.json`)

Event name and date, time zone, previous gala date (Bloomerang window), output basename, links for the QR page, share slug/URL, workbook path and sheet names, input paths, and `extra_takeaways` (strings appended to the takeaways cards).

## Privacy

Everything in `reports/out/` is operator-level data: anonymous donors' legal names, staff names, team notes, pledges. Share only with the client team, only through the password-protected link, never in the public repo or by email attachment to a wide list. The HTML hides anonymous legal names and team notes by default (toggles above the donor table).
