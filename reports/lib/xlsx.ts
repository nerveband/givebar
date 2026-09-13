// Excel workbook: every gift, every donor household, the full event log, online detail, the
// cross-references, follow-up lists, and a summary sheet. Internal document: legal names of
// anonymous donors and operator names are included, so it is never shared outside the team.
import ExcelJS from "exceljs";
import type { Report } from "./data";
import { localTime } from "./data";

const NAVY = "FF1E2A4A"; const GOLD = "FFC59B27"; const CREAM = "FFF7F4EE"; const SLATE = "FF334155";
const USD = '"$"#,##0.00;[Red]-"$"#,##0.00'; const USD0 = '"$"#,##0;[Red]-"$"#,##0';

let TZ = "UTC";
/** Excel has no time zones: write the wall-clock time of the event as if it were UTC so the sheet shows local time. */
function excelLocalDate(ms: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value || 0);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
}

type Column = { header: string; key: string; width?: number; money?: boolean; date?: boolean; wrap?: boolean };

function addTable(workbook: ExcelJS.Workbook, name: string, columns: Column[], rows: Record<string, unknown>[], note?: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: note ? 3 : 1 }] });
  let headerRow = 1;
  if (note) {
    sheet.mergeCells(1, 1, 1, Math.max(columns.length, 4));
    const cell = sheet.getCell(1, 1); cell.value = note; cell.font = { name: "Calibri", italic: true, color: { argb: SLATE }, size: 10 }; cell.alignment = { wrapText: true, vertical: "top" };
    sheet.getRow(1).height = 32; headerRow = 3;
  }
  sheet.columns = columns.map(c => ({ key: c.key, width: c.width || 16 }));
  const header = sheet.getRow(headerRow);
  columns.forEach((c, i) => { const cell = header.getCell(i + 1); cell.value = c.header; cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { vertical: "middle", wrapText: true }; cell.border = { bottom: { style: "medium", color: { argb: GOLD } } }; });
  header.height = 30;
  for (const row of rows) {
    const r = sheet.addRow(columns.map(c => row[c.key] ?? ""));
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      if (c.money) cell.numFmt = USD;
      const stamp = row[c.key];
      if (c.date && typeof stamp === "number") { cell.value = excelLocalDate(stamp); cell.numFmt = "mmm d, yyyy h:mm AM/PM"; }
      if (c.wrap) cell.alignment = { wrapText: true, vertical: "top" };
    });
  }
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: columns.length } };
  return sheet;
}

export async function writeWorkbook(report: Report, path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `${report.config.prepared_by} · Givebar`; workbook.created = new Date(report.generated_at);
  const tz = report.config.timezone; TZ = tz; const s = report.stats;
  const money = (c: number) => c / 100;

  // Summary
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 44 }, { width: 22 }, { width: 60 }];
  const title = summary.getCell("A1"); title.value = report.event.name; title.font = { name: "Calibri", size: 18, bold: true, color: { argb: NAVY } };
  summary.getCell("A2").value = `Donor report · generated ${localTime(new Date(report.generated_at).getTime(), tz, { dateStyle: "long", timeStyle: "short" })} · prepared by ${report.config.prepared_by}`;
  summary.getCell("A2").font = { italic: true, color: { argb: SLATE } };
  const lines: [string, number | string, string?][] = [
    ["Total raised", money(s.total_cents), `${s.active_count} active gifts from ${s.households} donor households`],
    ["Goal", money(s.goal_cents), `${Math.round(s.pct_of_goal * 100)}% of goal`],
    ["Remaining to goal", money(Math.max(0, s.goal_cents - s.total_cents))],
    ["Ballroom pledges (to collect)", money(s.pledge_cents), `${s.pledge_count} pledges`],
    ["Online card gifts (settled)", money(s.online_cents), `${s.online_count} gifts; net after fees ${(s.net_online_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`],
    ["Average gift", money(s.avg_cents)], ["Median gift", money(s.median_cents)],
    ["Major gifts (≥ threshold)", money(s.major_cents), `${s.major_count} gifts at or above ${(report.event.major_gift_threshold_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`],
    ["Top 10 gifts", money(s.top10_cents), `${Math.round(s.top10_pct * 100)}% of total`],
    ["Anonymous gifts", money(s.anonymous_cents), `${s.anonymous_count} gifts`],
    ["Zakat-restricted online", money(s.zakat_cents), `${s.zakat_count} gifts`],
    ["New monthly donors", s.recurring_count, `${(s.recurring_monthly_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} per month`],
    ["Processing fees covered by donors", money(s.gift_assist_cents)], ["Processing fees charged", money(s.fees_cents)],
    ["Declined online attempts", s.declined_count, `${(s.declined_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} attempted`],
    ["Voided / deleted gifts", s.void_count], ["Amended gifts", s.amended_count],
    ["Major prospects who gave", `${s.prospects_gave} of ${s.prospects_total}`, `${s.prospects_under_ask.length} gave below their ask; ${s.prospects_missing.length} with an ask have no gift`],
    ["Sponsors with a personal gift", `${s.sponsors_gave} of ${s.sponsors_total}`],
    ["Ticket buyers who gave", `${s.ticket_buyers_gave} of ${s.ticket_buyers}`],
    ["Tables with at least one gift", `${s.tables_with_gifts} of ${s.tables_total}`],
    ["Bloomerang", report.bloomerang.connected ? `${report.bloomerang.matched} of ${s.households} matched` : "not connected", report.bloomerang.message]
  ];
  lines.forEach((line, i) => {
    const row = summary.getRow(4 + i); row.getCell(1).value = line[0]; row.getCell(1).font = { bold: true, color: { argb: NAVY } };
    row.getCell(2).value = line[1]; if (typeof line[1] === "number" && line[0] !== "New monthly donors" && !/Declined|Voided|Amended/.test(line[0])) row.getCell(2).numFmt = USD;
    row.getCell(2).alignment = { horizontal: "right" }; row.getCell(3).value = line[2] || ""; row.getCell(3).font = { color: { argb: SLATE } };
    if (i % 2) for (let c = 1; c <= 3; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CREAM } };
  });
  let r = 4 + lines.length + 1;
  summary.getCell(r, 1).value = "Takeaways"; summary.getCell(r, 1).font = { bold: true, size: 13, color: { argb: GOLD } }; r++;
  for (const t of report.takeaways) { summary.getCell(r, 1).value = t.title; summary.getCell(r, 1).font = { bold: true }; summary.mergeCells(r, 2, r, 3); summary.getCell(r, 2).value = t.body; summary.getCell(r, 2).alignment = { wrapText: true, vertical: "top" }; summary.getRow(r).height = Math.max(18, Math.ceil(t.body.length / 90) * 15); r++; }
  r++; summary.getCell(r, 1).value = "Milestones"; summary.getCell(r, 1).font = { bold: true, size: 13, color: { argb: GOLD } }; r++;
  for (const m of report.milestones) { summary.getCell(r, 1).value = m.label; summary.getCell(r, 2).value = money(m.cents); summary.getCell(r, 2).numFmt = USD0; summary.getCell(r, 3).value = m.reached_at ? `reached ${localTime(m.reached_at, tz)}` : "not reached"; r++; }
  r++; summary.getCell(r, 1).value = "Ask tiers (quick amounts)"; summary.getCell(r, 1).font = { bold: true, size: 13, color: { argb: GOLD } }; r++;
  for (const t of report.ask_tiers) { summary.getCell(r, 1).value = t.label; summary.getCell(r, 2).value = t.hits; summary.getCell(r, 3).value = "gifts at exactly this amount"; r++; }

  // Gifts
  addTable(workbook, "Gifts", [
    { header: "Time (local)", key: "time", width: 20, date: true }, { header: "Donor (legal name)", key: "donor", width: 30 }, { header: "Display name", key: "display", width: 28 }, { header: "Anonymous", key: "anon", width: 11 },
    { header: "Amount", key: "amount", width: 14, money: true }, { header: "Method", key: "method", width: 10 }, { header: "Source", key: "source", width: 10 }, { header: "Status", key: "status", width: 10 },
    { header: "Recorded by", key: "by", width: 18 }, { header: "Table", key: "table", width: 8 }, { header: "Pronunciation", key: "phonetic", width: 16 }, { header: "Team note", key: "notes", width: 30, wrap: true },
    { header: "Original amount", key: "original", width: 14, money: true }, { header: "Amended", key: "amended", width: 10 }, { header: "Void reason", key: "void", width: 24 }, { header: "Minutes into appeal", key: "minutes", width: 12 },
    { header: "Email (online)", key: "email", width: 28 }, { header: "City", key: "city", width: 16 }, { header: "State", key: "state", width: 8 }, { header: "ZIP", key: "zip", width: 8 }, { header: "Restriction", key: "restriction", width: 11 }, { header: "Recurring", key: "recurring", width: 10 },
    { header: "Fee", key: "fee", width: 10, money: true }, { header: "Fee covered by donor", key: "assist", width: 12, money: true }, { header: "Net", key: "net", width: 12, money: true }, { header: "Card / payment", key: "payment", width: 16 }, { header: "Qgiv transaction", key: "txn", width: 14 },
    { header: "Prospect match", key: "prospect", width: 26 }, { header: "Ask", key: "ask", width: 12, money: true }, { header: "Sponsor match", key: "sponsor", width: 26 }, { header: "Ticket buyer", key: "ticket", width: 26 }, { header: "Seated at table", key: "seated", width: 26 },
    { header: "Bloomerang lifetime", key: "bl_lifetime", width: 14, money: true }, { header: "Bloomerang last gift", key: "bl_last", width: 16 }, { header: "Last gala gift", key: "bl_gala", width: 14, money: true },
    { header: "Donation ID", key: "id", width: 26 }, { header: "Ledger seq", key: "seq", width: 8 }
  ], report.gifts.map(g => ({
    time: g.created_at, donor: g.donor_name, display: g.display_name, anon: g.is_anonymous ? "yes" : "", amount: money(g.amount_cents), method: g.payment_method, source: g.source, status: g.status, by: g.entered_by, table: g.table_number, phonetic: g.donor_phonetic, notes: g.notes,
    original: g.amended ? money(g.original_amount_cents) : "", amended: g.amended ? "yes" : "", void: g.void_reason, minutes: g.minutes_into_appeal ?? "", email: g.qgiv?.email || "", city: g.qgiv?.city || "", state: g.qgiv?.state || "", zip: g.qgiv?.zip || "", restriction: g.qgiv?.restriction || "", recurring: g.qgiv?.recurring ? "monthly" : "",
    fee: g.qgiv ? money(g.qgiv.fee_cents) : "", assist: g.qgiv ? money(g.qgiv.gift_assist_cents) : "", net: g.qgiv ? money(g.qgiv.net_cents) : "", payment: g.qgiv?.payment || "", txn: g.qgiv?.id || "",
    prospect: g.prospect?.name || "", ask: g.prospect?.ask_cents ? money(g.prospect.ask_cents) : "", sponsor: g.sponsor ? `${g.sponsor.org} (${g.sponsor.tier})` : "", ticket: g.ticket ? `${g.ticket.name} · ${g.ticket.tickets} ticket(s)` : "", seated: g.table ? `Table ${g.table.number}: ${g.table.host}` : "",
    bl_lifetime: g.bloomerang ? money(g.bloomerang.lifetime_cents) : "", bl_last: g.bloomerang?.last_gift ? `${g.bloomerang.last_gift.slice(0, 10)} · ${(g.bloomerang.last_gift_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}` : "", bl_gala: g.bloomerang?.last_gala_cents ? money(g.bloomerang.last_gala_cents) : "",
    id: g.donation_id, seq: g.seq
  })), "One row per gift ever recorded, including voided ones (see Status). Times are local to the event. Internal: legal names of anonymous donors and staff names are included.");

  // Donors
  addTable(workbook, "Donors", [
    { header: "Donor", key: "name", width: 30 }, { header: "Display name", key: "display", width: 28 }, { header: "Anonymous", key: "anon", width: 11 }, { header: "Total", key: "total", width: 14, money: true }, { header: "Gifts", key: "count", width: 7 },
    { header: "Pledged (to collect)", key: "pledged", width: 16, money: true }, { header: "Paid online", key: "paid", width: 14, money: true }, { header: "Largest gift", key: "largest", width: 14, money: true }, { header: "Tier", key: "tier", width: 18 }, { header: "First gift", key: "first", width: 20, date: true },
    { header: "Relationship", key: "rel", width: 12 }, { header: "Email", key: "email", width: 28 }, { header: "City", key: "city", width: 18 }, { header: "Restriction", key: "restriction", width: 12 },
    { header: "On prospect list", key: "prospect", width: 26 }, { header: "Ask", key: "ask", width: 12, money: true }, { header: "Assumed gift", key: "assumed", width: 12, money: true }, { header: "vs. ask", key: "delta", width: 12, money: true }, { header: "Prospect notes", key: "pnotes", width: 30, wrap: true },
    { header: "Sponsor", key: "sponsor", width: 26 }, { header: "Ticket buyer", key: "ticket", width: 26 }, { header: "Table", key: "table", width: 26 },
    { header: "Bloomerang lifetime", key: "bl_lifetime", width: 14, money: true }, { header: "Bloomerang gifts", key: "bl_count", width: 10 }, { header: "First gift ever", key: "bl_first", width: 12 }, { header: "Last gift", key: "bl_last", width: 20 }, { header: "Last gala gift", key: "bl_gala", width: 14, money: true }, { header: "Years active", key: "bl_years", width: 20 }, { header: "Gala history", key: "bl_galas", width: 40, wrap: true }, { header: "Monthly donor", key: "bl_monthly", width: 10 }, { header: "Bloomerang records folded", key: "bl_records", width: 10 }
  ], report.donors.map(d => ({
    name: d.name, display: d.display_name, anon: d.is_anonymous ? "yes" : "", total: money(d.total_cents), count: d.gifts.length, pledged: money(d.pledged_cents), paid: money(d.paid_cents), largest: money(d.largest_cents), tier: d.tier, first: d.first_gift_at, rel: d.relationship, email: d.email, city: d.city, restriction: d.restriction,
    prospect: d.prospect?.name || "", ask: d.prospect?.ask_cents ? money(d.prospect.ask_cents) : "", assumed: d.prospect?.assumed_cents ? money(d.prospect.assumed_cents) : "", delta: d.prospect?.ask_cents ? money(d.total_cents - d.prospect.ask_cents) : "", pnotes: d.prospect?.notes || "",
    sponsor: d.sponsor ? `${d.sponsor.org} (${d.sponsor.tier})` : "", ticket: d.ticket ? `${d.ticket.name} · ${d.ticket.tickets} ticket(s)` : "", table: d.table ? `Table ${d.table.number}: ${d.table.host}` : "",
    bl_lifetime: d.bloomerang ? money(d.bloomerang.lifetime_cents) : "", bl_count: d.bloomerang?.gift_count ?? "", bl_first: d.bloomerang?.first_gift.slice(0, 10) || "", bl_last: d.bloomerang?.last_gift ? `${d.bloomerang.last_gift.slice(0, 10)} · ${(d.bloomerang.last_gift_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}` : "", bl_gala: d.bloomerang?.last_gala_cents ? money(d.bloomerang.last_gala_cents) : "", bl_years: d.bloomerang?.years_active.join(", ") || "", bl_galas: d.bloomerang?.galas.map(g => g.label + ": " + (g.cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })).join("; ") || "", bl_monthly: d.bloomerang?.monthly ? "yes" : "", bl_records: d.bloomerang?.records ?? ""
  })), "One row per donor household (active gifts only), largest first. Relationship comes from Bloomerang when connected, otherwise from the staff prospect list.");

  // Follow-up: pledges
  addTable(workbook, "Pledges to collect", [
    { header: "Donor", key: "name", width: 30 }, { header: "Pledged", key: "pledged", width: 14, money: true }, { header: "Gifts", key: "count", width: 7 }, { header: "Recorded by", key: "by", width: 18 }, { header: "Time", key: "time", width: 20, date: true }, { header: "Table", key: "table", width: 24 }, { header: "Team note", key: "notes", width: 36, wrap: true }, { header: "Anonymous", key: "anon", width: 10 }, { header: "Ask on prospect list", key: "ask", width: 14, money: true }
  ], report.donors.filter(d => d.pledged_cents > 0).map(d => ({ name: d.name, pledged: money(d.pledged_cents), count: d.gifts.filter(g => g.payment_method === "pledge").length, by: [...new Set(d.gifts.map(g => g.entered_by))].join(", "), time: d.first_gift_at, table: d.table ? `Table ${d.table.number}: ${d.table.host}` : d.gifts.find(g => g.table_number)?.table_number || "", notes: d.gifts.map(g => g.notes).filter(Boolean).join(" | "), anon: d.is_anonymous ? "yes" : "", ask: d.prospect?.ask_cents ? money(d.prospect.ask_cents) : "" })),
    "Pledges recorded in the ballroom are not yet cash. Thank within 48 hours with a payment link; call every major pledge personally.");

  addTable(workbook, "Prospects vs actual", [
    { header: "Prospect", key: "name", width: 32 }, { header: "Gave earlier in 2026", key: "before", width: 16, money: true }, { header: "Ask", key: "ask", width: 12, money: true }, { header: "Assumed gift", key: "assumed", width: 12, money: true }, { header: "Gave tonight", key: "actual", width: 14, money: true }, { header: "vs. ask", key: "delta", width: 12, money: true }, { header: "Status", key: "status", width: 16 }, { header: "Matched donor row", key: "matched", width: 30 }, { header: "Notes", key: "notes", width: 36, wrap: true }
  ], report.prospects.map(p => { const d = report.donors.find(x => x.prospect === p); const actual = d ? d.total_cents : 0; return { name: p.name, before: p.gave_before_cents ? money(p.gave_before_cents) : "", ask: p.ask_cents ? money(p.ask_cents) : "", assumed: p.assumed_cents ? money(p.assumed_cents) : "", actual: d ? money(actual) : "", delta: p.ask_cents ? money(actual - p.ask_cents) : "", status: !d ? "no gift recorded" : p.ask_cents && actual < p.ask_cents ? "below ask" : p.ask_cents ? "met or exceeded ask" : "gave", matched: d ? `${d.name} (${d.gifts.length} gift${d.gifts.length === 1 ? "" : "s"})` : "", notes: p.notes }; }),
    "Staff major-donor ask list (MASTER workbook, Donors 2026) against what the ledger recorded tonight. Name matching is automatic; verify a blank before you call.");

  addTable(workbook, "Declined online", [
    { header: "Attempted (local)", key: "time", width: 20, date: true }, { header: "Name", key: "name", width: 28 }, { header: "Email", key: "email", width: 30 }, { header: "Amount", key: "amount", width: 12, money: true }, { header: "Status", key: "status", width: 12 }, { header: "Payment", key: "payment", width: 16 }, { header: "City", key: "city", width: 16 }, { header: "Restriction", key: "restriction", width: 11 }, { header: "Qgiv transaction", key: "txn", width: 14 }
  ], report.qgiv.declined.map(t => ({ time: t.date_ms, name: t.donor, email: t.email, amount: money(t.amount_cents), status: t.status, payment: t.payment, city: [t.city, t.state].filter(Boolean).join(", "), restriction: t.restriction, txn: t.id })),
    "Online attempts that did not go through and were not followed by an accepted gift from the same email. A short recovery email with the donate link is the cheapest money on this list.");

  addTable(workbook, "Sponsors", [
    { header: "Organization", key: "org", width: 34 }, { header: "Tier", key: "tier", width: 10 }, { header: "Sponsorship", key: "cost", width: 12, money: true }, { header: "Point of contact", key: "poc", width: 24 }, { header: "Payment status", key: "pay", width: 22 }, { header: "Gift recorded tonight", key: "gave", width: 14, money: true }, { header: "Matched donor", key: "donor", width: 28 }, { header: "Table assigned", key: "table", width: 12 }
  ], report.sponsors.map(sp => { const d = report.donors.find(x => x.sponsor === sp); return { org: sp.org, tier: sp.tier, cost: money(sp.cost_cents), poc: sp.poc, pay: sp.payment_status, gave: d ? money(d.total_cents) : "", donor: d?.name || "", table: sp.table }; }),
    "Sponsorship packages from the MASTER workbook (Active Sponsors). Gift recorded tonight is an additional appeal gift under the organisation or its contact's name.");

  addTable(workbook, "Ticket buyers", [
    { header: "Name", key: "name", width: 30 }, { header: "Email", key: "email", width: 30 }, { header: "Tickets", key: "tickets", width: 8 }, { header: "Order", key: "items", width: 44 }, { header: "Gift recorded", key: "gave", width: 14, money: true }, { header: "Matched donor", key: "donor", width: 28 }
  ], report.tickets.filter(t => !t.cancelled).map(t => { const d = report.donors.find(x => x.ticket === t); return { name: t.name, email: t.email, tickets: t.tickets, items: t.items, gave: d ? money(d.total_cents) : "", donor: d?.name || "" }; }).sort((a, b) => (a.gave === "" ? 0 : 1) - (b.gave === "" ? 0 : 1)),
    "Ticket Tailor orders from the MASTER workbook. Buyers without a gift are the first post-gala email segment.");

  addTable(workbook, "Tables", [
    { header: "Table", key: "number", width: 8 }, { header: "Host / table name", key: "host", width: 32 }, { header: "Seats", key: "seats", width: 10 }, { header: "Gifts from this table", key: "count", width: 10 }, { header: "Raised", key: "raised", width: 14, money: true }, { header: "Donors matched", key: "donors", width: 40, wrap: true }, { header: "Guests", key: "guests", width: 60, wrap: true }
  ], report.tables.map(t => { const ds = report.donors.filter(d => d.table === t); return { number: t.number, host: t.host, seats: `${t.occupied}/${t.allotted}`, count: ds.reduce((n, d) => n + d.gifts.length, 0), raised: money(ds.reduce((n, d) => n + d.total_cents, 0)), donors: ds.map(d => `${d.name} (${(d.total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })})`).join(", "), guests: t.guests }; }).sort((a, b) => b.raised - a.raised),
    "Seating from the MASTER workbook (Final Tables). Gifts are matched to a table by donor or guest name; Givebar's own table field is on the Gifts sheet.");

  addTable(workbook, "Online detail (Qgiv)", [
    { header: "Transaction", key: "id", width: 12 }, { header: "Date", key: "time", width: 20, date: true }, { header: "Status", key: "status", width: 10 }, { header: "Donor", key: "donor", width: 28 }, { header: "Email", key: "email", width: 30 }, { header: "Gift", key: "amount", width: 12, money: true }, { header: "Fee covered", key: "assist", width: 12, money: true }, { header: "Fee", key: "fee", width: 10, money: true }, { header: "Net", key: "net", width: 12, money: true },
    { header: "Restriction", key: "restriction", width: 11 }, { header: "Recurring", key: "recurring", width: 10 }, { header: "Payment", key: "payment", width: 16 }, { header: "City", key: "city", width: 16 }, { header: "State", key: "state", width: 10 }, { header: "ZIP", key: "zip", width: 8 }, { header: "Employer", key: "employer", width: 20 }
  ], report.qgiv.all.map(t => ({ id: t.id, time: t.date_ms, status: t.status, donor: t.donor, email: t.email, amount: money(t.amount_cents), assist: money(t.gift_assist_cents), fee: money(t.fee_cents), net: money(t.net_cents), restriction: t.restriction, recurring: t.recurring ? "monthly" : "", payment: t.payment, city: t.city, state: t.state, zip: t.zip, employer: t.employer })),
    `Every transaction on the Qgiv form "${report.qgiv.form_name}" since January 1, pulled ${report.qgiv.pulled_at}. Accepted rows are the online gifts in the ledger.`);

  addTable(workbook, "Timeline", [
    { header: "15-minute window", key: "label", width: 16 }, { header: "Gifts", key: "count", width: 8 }, { header: "Raised in window", key: "cents", width: 16, money: true }, { header: "Running total", key: "cumulative", width: 16, money: true }
  ], s.timeline.map(b => ({ label: b.label, count: b.count, cents: money(b.cents), cumulative: money(b.cumulative) })), "Gala-day giving in 15-minute windows (local time). The running total includes gifts made before the gala day.");

  addTable(workbook, "Event log", [
    { header: "Seq", key: "seq", width: 7 }, { header: "Time (local)", key: "time", width: 20, date: true }, { header: "Event", key: "type", width: 12 }, { header: "Donation ID", key: "id", width: 26 }, { header: "Amount", key: "amount", width: 12, money: true }, { header: "Donor", key: "donor", width: 28 }, { header: "Display name", key: "display", width: 26 }, { header: "Anonymous", key: "anon", width: 10 }, { header: "Method", key: "method", width: 9 }, { header: "Source", key: "source", width: 11 }, { header: "By", key: "by", width: 18 }, { header: "Notes", key: "notes", width: 40, wrap: true }, { header: "Supersedes", key: "supersedes", width: 10 }
  ], report.events.map(e => ({ seq: e.seq, time: e.created_at, type: e.event_type, id: e.donation_id, amount: e.amount_cents ? money(e.amount_cents) : "", donor: e.donor_name || "", display: e.display_name || "", anon: e.is_anonymous ? "yes" : "", method: e.payment_method || "", source: e.source || "", by: e.entered_by || "", notes: e.notes || "", supersedes: e.supersedes_seq ?? "" })),
    "The append-only Givebar ledger, every event in order: create, amend, void, restore, match_apply, match_release. This is the audit trail behind every other sheet.");

  if (report.bloomerang.connected) addTable(workbook, "Lapsed gala donors", [
    { header: "Name", key: "name", width: 32 }, { header: "Email", key: "email", width: 30 }, { header: "Last year's gala", key: "gala", width: 14, money: true }, { header: "Lifetime before tonight", key: "lifetime", width: 16, money: true }, { header: "Last gift", key: "last", width: 12 }
  ], report.bloomerang.lapsed.map(l => ({ name: l.name, email: l.email, gala: money(l.last_gala_cents), lifetime: money(l.lifetime_cents), last: l.last_gift })), "Bloomerang constituents with a gift at last year's gala and no gift matched tonight by name or email. Verify against the Donors sheet before calling: spouses and business names hide matches.");

  addTable(workbook, "Operators", [{ header: "Recorded by", key: "name", width: 28 }, { header: "Gifts", key: "count", width: 8 }, { header: "Amount", key: "cents", width: 16, money: true }], s.operators.map(o => ({ name: o.name, count: o.count, cents: money(o.cents) })));

  await workbook.xlsx.writeFile(path);
}
