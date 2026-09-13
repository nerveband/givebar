// Builds the report model: every ledger gift with its full event history, the online (Qgiv)
// detail behind imported gifts, one row per donor household, and cross-references against the
// staff MASTER workbook (major-donor asks, sponsors, ticket buyers, table hosts) and, when
// reports/data/bloomerang.json exists, the Bloomerang CRM giving history.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import ExcelJS from "exceljs";
import { foldLedger, getEventState, type DonationRecord, type LedgerEvent } from "../../server/src/ledger";
import { getAskTiers, getMilestones } from "../../server/src/projection";
import { NameIndex, nameKeys, normalizeEmail, personKey } from "./names";

export type Config = {
  client: string; event_name: string; event_short: string; event_date: string; timezone: string; previous_event_date: string;
  output_basename: string; prepared_by: string; prepared_by_url: string; givebar_url: string; donate_url: string; org_url: string;
  share_slug: string; share_url: string; master_workbook: string; master_sheets: { prospects: string; sponsors: string; tickets: string; tables: string };
  inputs: { givebar_sqlite: string; qgiv_history: string; bloomerang: string }; extra_takeaways: string[];
};

export type QgivTxn = {
  id: string; status: string; amount_cents: number; fee_cents: number; net_cents: number; gift_assist_cents: number; donor: string; email: string;
  city: string; state: string; zip: string; restriction: string; recurring: boolean; payment: string; date: string; date_ms: number; employer: string;
};

export type Prospect = { name: string; gave_before_cents: number; ask_cents: number; assumed_cents: number; notes: string };
export type Sponsor = { org: string; cost_cents: number; tier: string; poc: string; table: string; payment_status: string; guests: string };
export type TicketOrder = { name: string; email: string; tickets: number; items: string; cancelled: boolean };
export type TableRow = { number: string; host: string; allotted: number; occupied: number; guests: string };

export type BloomerangMatch = {
  constituent_id: number; name: string; email: string; lifetime_cents: number; gift_count: number;
  first_gift: string; last_gift: string; last_gift_cents: number; last_gala_cents: number; last_gala_date: string; years_active: number[];
};

export type Gift = {
  donation_id: string; seq: number; public_key: string; donor_name: string; display_name: string; is_anonymous: boolean;
  amount_cents: number; original_amount_cents: number; payment_method: string; source: "manual" | "online"; entered_by: string;
  notes: string; table_number: string; donor_phonetic: string; created_at: number; updated_at: number; local_time: string;
  status: "active" | "voided"; void_reason: string; amended: boolean; event_count: number; minutes_into_appeal: number | null;
  qgiv: QgivTxn | null; prospect: Prospect | null; sponsor: Sponsor | null; ticket: TicketOrder | null; table: TableRow | null; bloomerang: BloomerangMatch | null;
  household: string;
};

export type Donor = {
  key: string; name: string; display_name: string; is_anonymous: boolean; gifts: Gift[]; total_cents: number; pledged_cents: number; paid_cents: number;
  first_gift_at: number; largest_cents: number; sources: string[]; tier: string; prospect: Prospect | null; sponsor: Sponsor | null; ticket: TicketOrder | null;
  table: TableRow | null; bloomerang: BloomerangMatch | null; relationship: "new" | "repeat" | "unknown"; email: string; city: string; restriction: string;
};

export type LedgerEventRow = LedgerEvent & { local_time: string };

export type Report = {
  generated_at: string; config: Config; event: { name: string; subtitle: string; goal_cents: number; total_cents: number; major_gift_threshold_cents: number; match_total_cents: number; qr_url: string; display_url: string; appeal_start: number | null; first_gift_at: number; last_gift_at: number };
  gifts: Gift[]; donors: Donor[]; events: LedgerEventRow[]; qgiv: { all: QgivTxn[]; declined: QgivTxn[]; pre_event: QgivTxn[]; form_name: string; pulled_at: string };
  prospects: Prospect[]; sponsors: Sponsor[]; tickets: TicketOrder[]; tables: TableRow[]; milestones: { label: string; cents: number; reached_at: number | null }[]; ask_tiers: { label: string; cents: number; hits: number }[];
  bloomerang: { connected: boolean; pulled_at: string; constituents: number; matched: number; message: string };
  stats: Stats; takeaways: Takeaway[];
};

export type Stats = {
  active_count: number; void_count: number; total_cents: number; goal_cents: number; pct_of_goal: number; avg_cents: number; median_cents: number;
  pledge_cents: number; pledge_count: number; online_cents: number; online_count: number; manual_paid_cents: number; anonymous_cents: number; anonymous_count: number;
  major_count: number; major_cents: number; top10_cents: number; top10_pct: number; bands: { label: string; min: number; max: number; count: number; cents: number }[];
  timeline: { t: number; label: string; count: number; cents: number; cumulative: number }[]; peak: { label: string; cents: number; count: number } | null;
  zakat_cents: number; zakat_count: number; general_cents: number; recurring_count: number; recurring_monthly_cents: number; gift_assist_cents: number; fees_cents: number; net_online_cents: number;
  declined_count: number; declined_cents: number; households: number; repeat_donors: number; new_donors: number; unknown_donors: number;
  prospects_gave: number; prospects_total: number; prospects_ask_cents: number; prospects_actual_cents: number; prospects_missing: Prospect[]; prospects_under_ask: { prospect: Prospect; donor: Donor }[];
  sponsors_gave: number; sponsors_total: number; ticket_buyers: number; ticket_buyers_gave: number; tables_with_gifts: number; tables_total: number;
  operators: { name: string; count: number; cents: number }[]; amended_count: number; entered_by_hour: { label: string; count: number }[];
};

export type Takeaway = { kind: "win" | "action" | "watch" | "insight"; title: string; body: string };

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 });
export const fmtMoney = money;

export function localTime(ms: number, timezone: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: timezone, ...opts });
}

function centsOf(value: unknown): number {
  if (typeof value === "number") return Math.round(value * 100);
  if (typeof value !== "string") return 0;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  return cleaned ? Math.round(parseFloat(cleaned) * 100) : 0;
}

function parseQgivDate(value: string): number {
  // "September 12, 2026 21:50:11" in the form's local time (Eastern).
  const match = /^(\w+) (\d+), (\d{4}) (\d+):(\d+):(\d+)$/.exec(value);
  if (!match) return 0;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const iso = `${match[3]}-${String(months.indexOf(match[1]) + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}:${match[6]}`;
  return new Date(`${iso}-04:00`).getTime();
}

export function loadQgiv(path: string): { all: QgivTxn[]; form_name: string; pulled_at: string } {
  if (!existsSync(path)) return { all: [], form_name: "", pulled_at: "" };
  const payload = JSON.parse(readFileSync(path, "utf8")) as { pulled_at: string; forms: { id: string; name: string; transactions: Record<string, unknown>[] }[] };
  const all: QgivTxn[] = [];
  for (const form of payload.forms) for (const t of form.transactions) {
    const donations = Array.isArray(t.donations) ? t.donations as Record<string, unknown>[] : [];
    const gross = donations.length ? donations.reduce((sum, item) => sum + centsOf(item.donationAmount), 0) : Math.max(0, centsOf(t.value) - centsOf(t.giftAssist ?? 0));
    all.push({
      id: String(t.id), status: String(t.transStatus || ""), amount_cents: gross, fee_cents: centsOf(t.fee), net_cents: centsOf(t.netAmount), gift_assist_cents: centsOf(t.giftAssist ?? 0),
      donor: [t.firstName, t.lastName].filter(v => typeof v === "string" && v.trim()).join(" ") || String(t.billingName || t.contactCompany || ""),
      email: normalizeEmail(t.contactEmail), city: String(t.contactCity || t.billingCity || ""), state: String(t.contactState || t.billingState || ""), zip: String(t.contactZip || t.billingZip || ""),
      restriction: String(t.restriction || ""), recurring: t.isRecurring === "y" || t.type === "recurring", payment: String(t.paymentMethod || t.paymentType || ""), date: String(t.transactionDate || ""), date_ms: parseQgivDate(String(t.transactionDate || "")), employer: String(t.employer || "")
    });
  }
  const firstForm = payload.forms[0];
  const firstTxnForm = firstForm?.transactions[0]?.form;
  const nestedName = firstTxnForm && typeof firstTxnForm === "object" && "name" in firstTxnForm ? String(firstTxnForm.name) : "";
  return { all, form_name: firstForm?.name || nestedName || firstForm?.id || "", pulled_at: payload.pulled_at };
}

/** ExcelJS cell values: formulas carry `result`, rich text carries `richText` runs; everything else is the scalar. */
function cellValue(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  if ("result" in v) return v.result;
  if ("richText" in v && Array.isArray(v.richText)) return v.richText.map(run => run && typeof run === "object" && "text" in run ? String(run.text) : "").join("");
  return v;
}

async function sheetRows(workbook: ExcelJS.Workbook, name: string): Promise<unknown[][]> {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) return [];
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const cells: unknown[] = Array.isArray(row.values) ? row.values.slice(1) : [];
    const values = cells.map(cellValue);
    if (values.some(v => v !== null && v !== undefined && String(v).trim() !== "")) rows.push(values);
  });
  return rows;
}

const text = (v: unknown) => v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim();

export async function loadMaster(config: Config): Promise<{ prospects: Prospect[]; sponsors: Sponsor[]; tickets: TicketOrder[]; tables: TableRow[] }> {
  const empty = { prospects: [], sponsors: [], tickets: [], tables: [] };
  if (!existsSync(config.master_workbook)) return empty;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(config.master_workbook);
  const prospects: Prospect[] = [];
  for (const row of (await sheetRows(workbook, config.master_sheets.prospects)).slice(1)) {
    const name = text(row[0]);
    if (!name || /^(matches|total|board)/i.test(name)) { if (/^matches/i.test(name)) break; continue; }
    if (typeof row[1] === "number") continue; // pledge-tracker rows below the prospect list carry an amount in column B
    const notes = [row[5], row[6]].map(text).filter(Boolean).join("; ");
    prospects.push({ name, gave_before_cents: centsOf(row[2]), ask_cents: typeof row[3] === "number" ? centsOf(row[3]) : 0, assumed_cents: centsOf(row[4]), notes: typeof row[3] === "string" ? [row[3], notes].map(text).filter(Boolean).join("; ") : notes });
  }
  const sponsors: Sponsor[] = [];
  for (const row of (await sheetRows(workbook, config.master_sheets.sponsors)).slice(1)) {
    const org = text(row[0]);
    if (!org || /^total/i.test(org) || typeof row[1] !== "number") continue;
    sponsors.push({ org, cost_cents: centsOf(row[1]), tier: text(row[2]), poc: text(row[3]), table: text(row[14]), payment_status: text(row[15]), guests: text(row[12]) });
  }
  const tickets: TicketOrder[] = [];
  for (const row of (await sheetRows(workbook, config.master_sheets.tickets)).slice(1)) {
    // Some rows lack the "cancelled" column, shifting name/email left by one.
    const shifted = typeof row[2] === "string" && String(row[2]).includes(" ") && !/^[01]$/.test(String(row[2]));
    const name = text(shifted ? row[2] : row[3]); const email = normalizeEmail(shifted ? row[3] : row[4]);
    if (!name) continue;
    tickets.push({ name, email, tickets: Number(row[1]) || 0, items: text(row[0]), cancelled: !shifted && Number(row[2]) === 1 });
  }
  const tables: TableRow[] = [];
  for (const row of (await sheetRows(workbook, config.master_sheets.tables)).slice(1)) {
    const host = text(row[1]);
    if (!host) continue;
    tables.push({ number: text(row[0]) || String(tables.length + 1), host, allotted: Number(row[2]) || 0, occupied: Number(row[3]) || 0, guests: text(row[4]) });
  }
  return { prospects, sponsors, tickets, tables };
}

type BloomerangData = { pulled_at: string; constituents: Record<string, unknown>[]; transactions: Record<string, unknown>[]; campaigns: Record<string, unknown>[]; appeals: Record<string, unknown>[] };

export function loadBloomerang(path: string, previousEventDate: string): { connected: boolean; pulled_at: string; constituents: number; index: NameIndex<BloomerangMatch>; message: string } {
  const index = new NameIndex<BloomerangMatch>();
  if (!existsSync(path)) return { connected: false, pulled_at: "", constituents: 0, index, message: "Bloomerang CRM history is not connected yet. Add a Bloomerang API key to 1Password and run reports/pull-bloomerang.ts; the next build fills in repeat-donor status, last gift, lifetime giving, and last year's gala gift for every matched donor." };
  const data = JSON.parse(readFileSync(path, "utf8")) as BloomerangData;
  const byConstituent = new Map<number, BloomerangMatch>();
  const previous = new Date(previousEventDate).getTime();
  const galaWindow = [previous - 14 * 86_400_000, previous + 21 * 86_400_000];
  const galaLabel = /gala|annual/i;
  const campaignNames = new Map<number, string>();
  for (const row of [...data.campaigns, ...data.appeals]) campaignNames.set(Number(row.Id), String(row.Name || ""));
  for (const c of data.constituents) {
    const id = Number(c.Id);
    const email = normalizeEmail((c.PrimaryEmail as { Value?: string } | undefined)?.Value);
    const name = String(c.FullName || [c.FirstName, c.LastName].filter(Boolean).join(" ") || c.InformalName || "");
    byConstituent.set(id, { constituent_id: id, name, email, lifetime_cents: 0, gift_count: 0, first_gift: "", last_gift: "", last_gift_cents: 0, last_gala_cents: 0, last_gala_date: "", years_active: [] });
  }
  for (const t of data.transactions) {
    const match = byConstituent.get(Number(t.AccountId));
    if (!match) continue;
    const date = String(t.Date || "");
    const ms = new Date(date).getTime();
    const amount = centsOf(t.Amount);
    const designations = Array.isArray(t.Designations) ? t.Designations as Record<string, unknown>[] : [];
    if (!designations.some(d => ["Donation", "Pledge", "PledgePayment", "RecurringDonationPayment"].includes(String(d.Type)))) continue;
    match.lifetime_cents += amount; match.gift_count++;
    if (!match.first_gift || date < match.first_gift) match.first_gift = date;
    if (!match.last_gift || date > match.last_gift) { match.last_gift = date; match.last_gift_cents = amount; }
    const year = new Date(date).getFullYear();
    if (!match.years_active.includes(year)) match.years_active.push(year);
    const named = designations.some(d => galaLabel.test(campaignNames.get(Number(d.CampaignId)) || "") || galaLabel.test(campaignNames.get(Number(d.AppealId)) || ""));
    if ((ms >= galaWindow[0] && ms <= galaWindow[1]) || (named && year === new Date(previous).getFullYear())) { match.last_gala_cents += amount; match.last_gala_date = date; }
  }
  for (const match of byConstituent.values()) { match.years_active.sort(); index.add(match.name, match, match.email); }
  return { connected: true, pulled_at: data.pulled_at, constituents: byConstituent.size, index, message: `Bloomerang history pulled ${data.pulled_at}: ${byConstituent.size} constituents, ${data.transactions.length} transactions.` };
}

function bandOf(cents: number): string {
  if (cents >= 5_000_000) return "$50,000+"; if (cents >= 2_500_000) return "$25,000 to $49,999"; if (cents >= 1_000_000) return "$10,000 to $24,999"; if (cents >= 500_000) return "$5,000 to $9,999";
  if (cents >= 100_000) return "$1,000 to $4,999"; if (cents >= 50_000) return "$500 to $999"; if (cents >= 10_000) return "$100 to $499"; return "Under $100";
}
const BANDS: { label: string; min: number; max: number }[] = [
  { label: "$50,000+", min: 5_000_000, max: Infinity }, { label: "$25,000 to $49,999", min: 2_500_000, max: 4_999_999 }, { label: "$10,000 to $24,999", min: 1_000_000, max: 2_499_999 },
  { label: "$5,000 to $9,999", min: 500_000, max: 999_999 }, { label: "$1,000 to $4,999", min: 100_000, max: 499_999 }, { label: "$500 to $999", min: 50_000, max: 99_999 }, { label: "$100 to $499", min: 10_000, max: 49_999 }, { label: "Under $100", min: 1, max: 9_999 }
];

export async function buildReport(config: Config): Promise<Report> {
  const db = new Database(config.inputs.givebar_sqlite, { readonly: true });
  const state = getEventState(db);
  const fold = foldLedger(db);
  const events = db.query<LedgerEvent, []>("SELECT * FROM ledger ORDER BY seq ASC").all().map(e => ({ ...e, local_time: localTime(e.created_at, config.timezone) }));
  const qgiv = loadQgiv(config.inputs.qgiv_history);
  const master = await loadMaster(config);
  const bloomerang = loadBloomerang(config.inputs.bloomerang, config.previous_event_date);

  const qgivById = new Map(qgiv.all.map(t => [t.id, t]));
  const prospectIndex = new NameIndex<Prospect>(); for (const p of master.prospects) prospectIndex.add(p.name, p);
  const sponsorIndex = new NameIndex<Sponsor>(); for (const s of master.sponsors) { sponsorIndex.add(s.org, s); if (s.poc) sponsorIndex.add(s.poc, s); }
  const ticketIndex = new NameIndex<TicketOrder>(); for (const t of master.tickets) if (!t.cancelled) ticketIndex.add(t.name, t, t.email);
  const tableIndex = new NameIndex<TableRow>(); for (const t of master.tables) { tableIndex.add(t.host, t); for (const guest of t.guests.split(/\n|,|;/)) if (guest.trim().length > 4) tableIndex.add(guest.replace(/\+\s*\d+/g, ""), t); }

  const eventCounts = new Map<string, number>(); const voidReasons = new Map<string, string>(); const originals = new Map<string, number>();
  for (const e of events) {
    eventCounts.set(e.donation_id, (eventCounts.get(e.donation_id) || 0) + 1);
    if (e.event_type === "create") originals.set(e.donation_id, e.amount_cents);
    if (e.event_type === "void") voidReasons.set(e.donation_id, e.notes || "");
  }
  // Manual gifts from the ballroom define the appeal window; online gifts before the first pledge are pre-event.
  const records = [...fold.all_records.values()].filter(r => r.source !== "rehearsal");
  const manualStarts = records.filter(r => r.source === "manual" && !r.is_voided).map(r => r.created_at).sort((a, b) => a - b);
  const appealStart = manualStarts[0] ?? null;

  const gifts: Gift[] = records.map((r: DonationRecord) => {
    const txnId = r.source === "bloomerang" ? (/(\d+)$/.exec(r.donation_id)?.[1] || "") : "";
    const q = txnId ? qgivById.get(txnId) || null : null;
    const email = q?.email || "";
    const original = originals.get(r.donation_id) ?? r.amount_cents;
    // An imported gift's ledger time is when the sync saw it; the donor gave at the Qgiv transaction time.
    const givenAt = q?.date_ms || r.created_at;
    return {
      donation_id: r.donation_id, seq: r.latest_seq, public_key: r.donation_id.slice(0, 8), donor_name: r.donor_name, display_name: r.display_name, is_anonymous: r.is_anonymous,
      amount_cents: r.amount_cents, original_amount_cents: original, payment_method: r.payment_method, source: r.source === "bloomerang" ? "online" : "manual", entered_by: r.entered_by || "",
      notes: r.notes && !/^Fundraising transaction/.test(r.notes) ? r.notes : "", table_number: r.table_number || "", donor_phonetic: r.donor_phonetic || "", created_at: givenAt, updated_at: r.updated_at,
      local_time: localTime(givenAt, config.timezone), status: r.is_voided ? "voided" : "active", void_reason: voidReasons.get(r.donation_id) || "", amended: original !== r.amount_cents,
      event_count: eventCounts.get(r.donation_id) || 1, minutes_into_appeal: appealStart ? Math.round((givenAt - appealStart) / 60000) : null,
      qgiv: q, prospect: prospectIndex.find(r.donor_name)[0] || null, sponsor: sponsorIndex.find(r.donor_name)[0] || null, ticket: ticketIndex.find(r.donor_name, email)[0] || null,
      table: tableIndex.find(r.donor_name)[0] || null, bloomerang: bloomerang.index.find(r.donor_name, email)[0] || null, household: personKey(r.donor_name) || r.donor_name.toLowerCase()
    };
  }).sort((a, b) => a.created_at - b.created_at);

  // Donor households: same person key (first + last) regardless of source.
  const donorMap = new Map<string, Donor>();
  for (const g of gifts) {
    if (g.status !== "active") continue;
    const key = g.is_anonymous && /^anonymous$/i.test(g.donor_name) ? `anon:${g.donation_id}` : g.household;
    const d = donorMap.get(key) || { key, name: g.donor_name, display_name: g.display_name, is_anonymous: g.is_anonymous, gifts: [], total_cents: 0, pledged_cents: 0, paid_cents: 0, first_gift_at: g.created_at, largest_cents: 0, sources: [], tier: "", prospect: null, sponsor: null, ticket: null, table: null, bloomerang: null, relationship: "unknown" as const, email: "", city: "", restriction: "" };
    d.gifts.push(g); d.total_cents += g.amount_cents; if (g.payment_method === "pledge") d.pledged_cents += g.amount_cents; else d.paid_cents += g.amount_cents;
    d.first_gift_at = Math.min(d.first_gift_at, g.created_at); d.largest_cents = Math.max(d.largest_cents, g.amount_cents);
    if (!d.sources.includes(g.source)) d.sources.push(g.source);
    d.prospect ||= g.prospect; d.sponsor ||= g.sponsor; d.ticket ||= g.ticket; d.table ||= g.table; d.bloomerang ||= g.bloomerang;
    if (g.qgiv) { d.email ||= g.qgiv.email; d.city ||= [g.qgiv.city, g.qgiv.state].filter(Boolean).join(", "); if (g.qgiv.restriction && !d.restriction.includes(g.qgiv.restriction)) d.restriction = [d.restriction, g.qgiv.restriction].filter(Boolean).join(" + "); }
    if (!g.is_anonymous) { d.is_anonymous = false; d.display_name = g.display_name; }
    donorMap.set(key, d);
  }
  const donors = [...donorMap.values()].sort((a, b) => b.total_cents - a.total_cents);
  for (const d of donors) {
    d.tier = bandOf(d.total_cents);
    d.relationship = d.bloomerang ? (d.bloomerang.gift_count > 0 && d.bloomerang.first_gift < config.event_date ? "repeat" : "new") : (d.prospect?.gave_before_cents ? "repeat" : "unknown");
  }

  const active = gifts.filter(g => g.status === "active");
  const goal = state.goal_cents;
  const total = fold.total_raised_cents;
  const amounts = active.map(g => g.amount_cents).sort((a, b) => b - a);
  const median = amounts.length ? (amounts.length % 2 ? amounts[(amounts.length - 1) / 2] : Math.round((amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2)) : 0;
  const top10 = amounts.slice(0, 10).reduce((s, v) => s + v, 0);
  const bands = BANDS.map(b => { const rows = active.filter(g => g.amount_cents >= b.min && g.amount_cents <= b.max); return { ...b, count: rows.length, cents: rows.reduce((s, g) => s + g.amount_cents, 0) }; });

  // 15-minute timeline across the gala day (local date of the event) only; earlier online gifts are pre-event.
  const eventDay = active.filter(g => localTime(g.created_at, config.timezone, { year: "numeric", month: "2-digit", day: "2-digit" }) === `${config.event_date.slice(5, 7)}/${config.event_date.slice(8, 10)}/${config.event_date.slice(0, 4)}`);
  // Start the chart an hour before the first ballroom gift; earlier gifts (online, during the day) roll into the starting total.
  const dayStart = appealStart ? appealStart - 3600_000 : eventDay.length ? eventDay[0].created_at : Date.now();
  const bucketMs = 15 * 60000;
  const first = Math.floor(dayStart / bucketMs) * bucketMs;
  const last = eventDay.length ? eventDay[eventDay.length - 1].created_at : dayStart;
  const timeline: Stats["timeline"] = [];
  let cumulative = active.filter(g => g.created_at < first).reduce((s, g) => s + g.amount_cents, 0);
  for (let t = first; t <= last; t += bucketMs) {
    const rows = active.filter(g => g.created_at >= t && g.created_at < t + bucketMs);
    const cents = rows.reduce((s, g) => s + g.amount_cents, 0); cumulative += cents;
    timeline.push({ t, label: localTime(t, config.timezone, { hour: "numeric", minute: "2-digit" }), count: rows.length, cents, cumulative });
  }
  const peak = timeline.reduce<Stats["peak"]>((best, b) => !best || b.cents > best.cents ? { label: b.label, cents: b.cents, count: b.count } : best, null);

  const online = active.filter(g => g.source === "online");
  const zakat = online.filter(g => g.qgiv?.restriction === "Zakat");
  const recurring = online.filter(g => g.qgiv?.recurring);
  const acceptedIds = new Set(online.map(g => g.qgiv?.id));
  const acceptedEmails = new Set(online.map(g => g.qgiv?.email).filter(Boolean));
  const declined = qgiv.all.filter(t => t.status !== "Accepted" && !acceptedIds.has(t.id) && !acceptedEmails.has(t.email));
  const preEvent = qgiv.all.filter(t => t.status === "Accepted" && eventDay.length > 0 && t.date_ms < eventDay[0].created_at);

  const prospectsGave = master.prospects.filter(p => donors.some(d => d.prospect === p));
  const prospectsMissing = master.prospects.filter(p => !donors.some(d => d.prospect === p) && p.ask_cents > 0);
  const underAsk = donors.filter(d => d.prospect && d.prospect.ask_cents > 0 && d.total_cents < d.prospect.ask_cents).map(d => ({ prospect: d.prospect!, donor: d }));
  const ticketBuyers = master.tickets.filter(t => !t.cancelled);
  const ticketBuyersGave = ticketBuyers.filter(t => donors.some(d => d.ticket === t)).length;
  const operators = [...active.reduce((m, g) => { const k = g.source === "online" ? "Online (Qgiv import)" : g.entered_by || "Operator"; const v = m.get(k) || { name: k, count: 0, cents: 0 }; v.count++; v.cents += g.amount_cents; return m.set(k, v); }, new Map<string, { name: string; count: number; cents: number }>()).values()].sort((a, b) => b.cents - a.cents);
  const milestones = getMilestones(db, goal).map(m => ({ label: m.label, cents: m.cents ?? 0, reached_at: (() => { let run = 0; for (const g of active) { run += g.amount_cents; if (run >= (m.cents ?? 0)) return g.created_at; } return null; })() }));
  const askTiers = getAskTiers(db).map(t => ({ label: t.label, cents: t.cents, hits: active.filter(g => g.amount_cents === t.cents).length }));
  const majors = active.filter(g => g.amount_cents >= state.major_gift_threshold_cents);
  const stats: Stats = {
    active_count: active.length, void_count: gifts.length - active.length, total_cents: total, goal_cents: goal, pct_of_goal: goal ? total / goal : 0, avg_cents: active.length ? Math.round(total / active.length) : 0, median_cents: median,
    pledge_cents: active.filter(g => g.payment_method === "pledge").reduce((s, g) => s + g.amount_cents, 0), pledge_count: active.filter(g => g.payment_method === "pledge").length,
    online_cents: online.reduce((s, g) => s + g.amount_cents, 0), online_count: online.length, manual_paid_cents: active.filter(g => g.source === "manual" && g.payment_method !== "pledge").reduce((s, g) => s + g.amount_cents, 0),
    anonymous_cents: active.filter(g => g.is_anonymous).reduce((s, g) => s + g.amount_cents, 0), anonymous_count: active.filter(g => g.is_anonymous).length,
    major_count: majors.length, major_cents: majors.reduce((s, g) => s + g.amount_cents, 0), top10_cents: top10, top10_pct: total ? top10 / total : 0, bands, timeline, peak,
    zakat_cents: zakat.reduce((s, g) => s + g.amount_cents, 0), zakat_count: zakat.length, general_cents: online.filter(g => g.qgiv?.restriction !== "Zakat").reduce((s, g) => s + g.amount_cents, 0),
    recurring_count: recurring.length, recurring_monthly_cents: recurring.reduce((s, g) => s + g.amount_cents, 0), gift_assist_cents: online.reduce((s, g) => s + (g.qgiv?.gift_assist_cents || 0), 0), fees_cents: online.reduce((s, g) => s + (g.qgiv?.fee_cents || 0), 0), net_online_cents: online.reduce((s, g) => s + (g.qgiv?.net_cents || g.amount_cents), 0),
    declined_count: declined.length, declined_cents: declined.reduce((s, t) => s + t.amount_cents, 0), households: donors.length, repeat_donors: donors.filter(d => d.relationship === "repeat").length, new_donors: donors.filter(d => d.relationship === "new").length, unknown_donors: donors.filter(d => d.relationship === "unknown").length,
    prospects_gave: prospectsGave.length, prospects_total: master.prospects.length, prospects_ask_cents: master.prospects.reduce((s, p) => s + p.ask_cents, 0), prospects_actual_cents: donors.filter(d => d.prospect).reduce((s, d) => s + d.total_cents, 0), prospects_missing: prospectsMissing, prospects_under_ask: underAsk,
    sponsors_gave: master.sponsors.filter(s => donors.some(d => d.sponsor === s)).length, sponsors_total: master.sponsors.length, ticket_buyers: ticketBuyers.length, ticket_buyers_gave: ticketBuyersGave,
    tables_with_gifts: master.tables.filter(t => donors.some(d => d.table === t)).length, tables_total: master.tables.length, operators, amended_count: active.filter(g => g.amended).length,
    entered_by_hour: []
  };

  const report: Report = {
    generated_at: new Date().toISOString(), config,
    event: { name: state.event_name, subtitle: state.event_subtitle, goal_cents: goal, total_cents: total, major_gift_threshold_cents: state.major_gift_threshold_cents, match_total_cents: state.match_total_cents, qr_url: state.qr_url, display_url: state.display_url, appeal_start: appealStart, first_gift_at: active[0]?.created_at || 0, last_gift_at: last },
    gifts, donors, events, qgiv: { all: qgiv.all, declined, pre_event: preEvent, form_name: qgiv.form_name, pulled_at: qgiv.pulled_at }, prospects: master.prospects, sponsors: master.sponsors, tickets: master.tickets, tables: master.tables, milestones, ask_tiers: askTiers,
    bloomerang: { connected: bloomerang.connected, pulled_at: bloomerang.pulled_at, constituents: bloomerang.constituents, matched: donors.filter(d => d.bloomerang).length, message: bloomerang.message },
    stats, takeaways: []
  };
  report.takeaways = buildTakeaways(report);
  db.close();
  return report;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildTakeaways(r: Report): Takeaway[] {
  const s = r.stats; const out: Takeaway[] = [];
  const gap = s.goal_cents - s.total_cents;
  out.push({ kind: gap <= 0 ? "win" : "insight", title: gap <= 0 ? `Goal met: ${money(s.total_cents)} against ${money(s.goal_cents)}` : `${money(s.total_cents)} raised, ${pct(s.pct_of_goal)} of the ${money(s.goal_cents)} goal`, body: gap <= 0 ? `The room exceeded the goal by ${money(-gap)}.` : `${money(gap)} remains. ${s.prospects_missing.length} major-donor prospects on the ask list have not given yet (asks total ${money(s.prospects_missing.reduce((t, p) => t + p.ask_cents, 0))}); closing half of them covers most of the gap.` });
  if (s.pledge_cents > 0) out.push({ kind: "action", title: `${money(s.pledge_cents)} in ballroom pledges to collect (${pct(s.pledge_cents / s.total_cents)} of the total)`, body: `${s.pledge_count} pledges were recorded by staff at the tables and are not yet cash. Send a thank-you with a payment link within 48 hours, then a personal call for every pledge of ${money(r.event.major_gift_threshold_cents)} or more. Card gifts through the online form (${money(s.online_cents)}) are already settled.` });
  if (s.top10_pct > 0.5) out.push({ kind: "watch", title: `Top 10 gifts are ${pct(s.top10_pct)} of the night`, body: `${money(s.top10_cents)} came from ten gifts; the median gift is ${money(s.median_cents)}. Concentration this high means next year's result rides on ten conversations. Start those stewardship visits in the first quarter, not the month before the gala.` });
  if (s.declined_count) out.push({ kind: "action", title: `${s.declined_count} online attempts declined (${money(s.declined_cents)})`, body: `Card declines on the donate form from people who tried to give. A short "your gift did not go through" email with the link recovers a meaningful share; the list is in the Follow-up section and the workbook.` });
  if (s.prospects_total) out.push({ kind: "insight", title: `${s.prospects_gave} of ${s.prospects_total} major prospects gave; ${s.prospects_under_ask.length} gave below their ask`, body: `Asks on the staff list total ${money(s.prospects_ask_cents)}; matched prospects gave ${money(s.prospects_actual_cents)}. The under-ask group is the warmest upgrade list for a follow-up conversation this month.` });
  if (s.anonymous_count) out.push({ kind: "insight", title: `${s.anonymous_count} anonymous gifts worth ${money(s.anonymous_cents)}`, body: `Anonymous donors are ${pct(s.anonymous_cents / s.total_cents)} of the total. Their legal names are in the operator workbook only; thank them privately and never in print.` });
  if (s.zakat_count) out.push({ kind: "insight", title: `Zakat was ${pct(s.zakat_cents / (s.online_cents || 1))} of online giving`, body: `${s.zakat_count} online donors chose the Zakat restriction (${money(s.zakat_cents)}). Keep the Zakat-eligible framing in the follow-up email; it moved money tonight.` });
  if (s.recurring_count) out.push({ kind: "win", title: `${s.recurring_count} new monthly donors`, body: `${money(s.recurring_monthly_cents)} per month in recurring gifts started tonight (${money(s.recurring_monthly_cents * 12)} annualised). Welcome them as a named circle within the week.` });
  if (s.gift_assist_cents) out.push({ kind: "insight", title: `Donors covered ${money(s.gift_assist_cents)} in processing fees`, body: `Fees on online gifts were ${money(s.fees_cents)}; net online is ${money(s.net_online_cents)}. Keep the fee-cover option on by default.` });
  if (s.peak) out.push({ kind: "insight", title: `Peak giving window: ${s.peak.label} (${money(s.peak.cents)} in 15 minutes)`, body: `${s.peak.count} gifts landed in the strongest quarter hour. Next year, place the matching announcement and the emcee's second ask inside that window rather than after it.` });
  if (s.ticket_buyers) out.push({ kind: "action", title: `${s.ticket_buyers - s.ticket_buyers_gave} of ${s.ticket_buyers} ticket buyers on file have no gift recorded`, body: `Guests who bought tickets but did not give tonight are the first segment for the post-gala email; they were in the room and heard the case.` });
  if (r.event.match_total_cents === 0) out.push({ kind: "watch", title: "No matching grant was configured", body: "A board or sponsor match, even $25,000, gives the emcee a second peak. Secure it before the next appeal; Givebar folds it automatically." });
  if (!r.bloomerang.connected) out.push({ kind: "action", title: "Connect Bloomerang to see repeat-donor history", body: r.bloomerang.message });
  else out.push({ kind: "insight", title: `${s.repeat_donors} repeat donors, ${s.new_donors} first-time donors`, body: `${r.bloomerang.matched} of ${s.households} households matched a Bloomerang constituent. First-time donors need a welcome series within 7 days; repeat donors get a "you were with us again" note referencing their last gift.` });
  for (const extra of r.config.extra_takeaways) out.push({ kind: "insight", title: extra, body: "" });
  return out;
}
