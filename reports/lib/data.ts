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
  share_slug: string; share_url: string; master_workbook: string; prospects_workbook?: string; master_sheets: { prospects: string; sponsors: string; tickets: string; tables: string };
  inputs: { givebar_sqlite: string; qgiv_history: string; bloomerang: string; stats: string }; extra_takeaways: string[];
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
  constituent_id: number; name: string; email: string;
  /** Giving before the gala day: what the team knew walking in. */
  lifetime_cents: number; gift_count: number; first_gift: string; last_gift: string; last_gift_cents: number;
  /** Gift(s) tied to last year's gala campaign or its date window. */
  last_gala_cents: number; last_gala_date: string; years_active: number[];
  /** Every gala campaign the constituent gave to, oldest first ("6th Annual": cents). */
  galas: { label: string; cents: number }[];
  monthly: boolean;
  /** Bloomerang holds duplicate records for many people (Kindful import); every record matching the donor is folded into one row. */
  records: number; ids: number[];
};

export type Gift = {
  donation_id: string; seq: number; public_key: string; donor_name: string; display_name: string; is_anonymous: boolean;
  amount_cents: number; original_amount_cents: number; payment_method: string; source: "manual" | "online"; entered_by: string;
  notes: string; table_number: string; donor_phonetic: string; created_at: number; updated_at: number; local_time: string;
  status: "active" | "voided"; void_reason: string; amended: boolean; event_count: number; minutes_into_appeal: number | null;
  qgiv: QgivTxn | null; prospect: Prospect | null; sponsor: Sponsor | null; ticket: TicketOrder | null; table: TableRow | null; bloomerang: BloomerangMatch | null;
  household: string;
  /** How the money arrives, read from the team note: online card, check in hand, cash in hand, card details on the pledge card, or a pledge to invoice. */
  collection: Collection; collection_ref: string; note_plain: string;
};
export type Collection = "online" | "check" | "cash" | "card" | "pledge";
export const COLLECTION_LABEL: Record<Collection, string> = { online: "Paid online", check: "Check received", cash: "Cash received", card: "Card on pledge card", pledge: "Pledge to invoice" };

/** Turn a staff shorthand note ("Check #8934", "Pledge card with credit card detail", "Table 19") into a collection status and a plain sentence. */
export function readNote(note: string, method: string, source: string): { collection: Collection; ref: string; plain: string } {
  if (source !== "manual") return { collection: "online", ref: "", plain: "" };
  const check = /check(?:\s*(?:number|no\.?|#))?\s*#?\s*(\d+)/i.exec(note);
  const table = /table\s*(\d+)/i.exec(note);
  const parts: string[] = [];
  let collection: Collection = "pledge"; let ref = "";
  if (check) { collection = "check"; ref = check[1]; parts.push(`Check number ${check[1]} was handed in at the table.`); }
  else if (/\bcash\b/i.test(note)) { collection = "cash"; const mult = /(\d+)\s*x\s*\$?(\d+)/i.exec(note); parts.push(mult ? `Cash received: ${mult[1]} bills of ${mult[2]}.` : "Cash received at the table."); }
  else if (/credit\s*card|card\s*detail/i.test(note)) { collection = "card"; parts.push("The pledge card carries credit card details; charge the card, no invoice needed."); }
  else if (method === "pledge") { parts.push("Pledge only: nothing was collected on the night, invoice and follow up."); }
  if (table) parts.push(`Seated at table ${table[1]}.`);
  if (/out of town/i.test(note)) parts.push("Donor is out of town.");
  const reach = /reach out to ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i.exec(note);
  if (reach) parts.push(`${reach[1]} will collect the check.`);
  return { collection, ref, plain: parts.join(" ") };
}

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
  bloomerang: { connected: boolean; pulled_at: string; constituents: number; matched: number; message: string; returning: { count: number; then_cents: number; now_cents: number; upgraded: number; downgraded: number }; repeat_cents: number; new_cents: number; lapsed: { name: string; email: string; last_gala_cents: number; last_gift: string; lifetime_cents: number }[] };
  web: WebStats; stats: Stats; takeaways: Takeaway[];
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
  /** Ballroom money by how it arrives. "pledge" is the part that still needs an invoice. */
  collection: Record<Collection, { count: number; cents: number }>;
};

export type WebChannel = { label: string; visitors: number; donate_views: number };
export type WebStats = { connected: boolean; pulled_at: string; week: { views: number; visitors: number; donate_visitors: number; tagged_visitors: number } | null; all: { views: number; visitors: number; donate_visitors: number } | null; channels: WebChannel[]; devices: { device: string; visitors: number }[]; referrers: { domain: string; visitors: number }[]; conversion: number };

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
  // The ask list was removed from the shared MASTER after the gala; read it from the archived copy when the live file lacks the sheet.
  let prospectSource = workbook;
  if (!workbook.getWorksheet(config.master_sheets.prospects) && config.prospects_workbook && existsSync(config.prospects_workbook)) { prospectSource = new ExcelJS.Workbook(); await prospectSource.xlsx.readFile(config.prospects_workbook); }
  const prospects: Prospect[] = [];
  for (const row of (await sheetRows(prospectSource, config.master_sheets.prospects)).slice(1)) {
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
  // Header-driven: the seating sheet has been re-laid out more than once (a leading room-number column appeared after the gala).
  const tables: TableRow[] = [];
  const tableRows = await sheetRows(workbook, config.master_sheets.tables);
  const header = Array.from(tableRows[0] || [], v => text(v).toLowerCase());
  const col = (label: string, fallback: number) => { const i = header.findIndex(h => h.includes(label)); return i >= 0 ? i : fallback; };
  const nameCol = col("table name", 1), numberCol = col("table number", 0), allottedCol = col("allotted", 2), occupiedCol = col("occupied", 3), guestsCol = col("guest names", 4);
  const roomCol = numberCol > 0 && header[0] === "" ? 0 : -1;
  for (const row of tableRows.slice(1)) {
    const host = text(row[nameCol]);
    if (!host) continue;
    const room = roomCol >= 0 ? text(row[roomCol]) : "";
    tables.push({ number: room || text(row[numberCol]) || String(tables.length + 1), host, allotted: Number(row[allottedCol]) || 0, occupied: Number(row[occupiedCol]) || 0, guests: text(row[guestsCol]) });
  }
  return { prospects, sponsors, tickets, tables };
}

type BloomerangData = { pulled_at: string; constituents: Record<string, unknown>[]; transactions: Record<string, unknown>[]; campaigns: Record<string, unknown>[]; appeals: Record<string, unknown>[] };

function campaignName(designation: Record<string, unknown>): string {
  const campaign = designation.Campaign;
  return campaign && typeof campaign === "object" && "Name" in campaign ? String(campaign.Name || "") : "";
}

/** Fold every constituent record that matches one donor (duplicates are common) into a single history. */
export function mergeBloomerang(matches: BloomerangMatch[]): BloomerangMatch | null {
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const primary = matches.reduce((best, m) => m.gift_count > best.gift_count ? m : best, matches[0]);
  const out: BloomerangMatch = { ...primary, years_active: [], galas: [], lifetime_cents: 0, gift_count: 0, first_gift: "", last_gift: "", last_gift_cents: 0, last_gala_cents: 0, last_gala_date: "", monthly: false, records: matches.length, ids: matches.map(m => m.constituent_id) };
  const galas = new Map<string, number>();
  for (const m of matches) {
    out.lifetime_cents += m.lifetime_cents; out.gift_count += m.gift_count; out.last_gala_cents += m.last_gala_cents; out.monthly ||= m.monthly;
    if (m.first_gift && (!out.first_gift || m.first_gift < out.first_gift)) out.first_gift = m.first_gift;
    if (m.last_gift && (!out.last_gift || m.last_gift > out.last_gift)) { out.last_gift = m.last_gift; out.last_gift_cents = m.last_gift_cents; }
    if (m.last_gala_date > out.last_gala_date) out.last_gala_date = m.last_gala_date;
    for (const y of m.years_active) if (!out.years_active.includes(y)) out.years_active.push(y);
    for (const g of m.galas) galas.set(g.label, (galas.get(g.label) || 0) + g.cents);
    if (!out.email && m.email) out.email = m.email;
  }
  out.years_active.sort();
  out.galas = [...galas.entries()].map(([label, cents]) => ({ label, cents })).sort((a, b) => (parseInt(a.label) || 99) - (parseInt(b.label) || 99));
  return out;
}

export function loadBloomerang(path: string, previousEventDate: string, eventDate: string): { connected: boolean; pulled_at: string; constituents: number; index: NameIndex<BloomerangMatch>; all: BloomerangMatch[]; message: string } {
  const index = new NameIndex<BloomerangMatch>();
  if (!existsSync(path)) return { connected: false, pulled_at: "", constituents: 0, index, all: [], message: "Bloomerang CRM history is not connected yet. Run reports/pull-bloomerang.ts with a Bloomerang API key; the next build fills in repeat-donor status, last gift, lifetime giving, and last year's gala gift for every matched donor." };
  const data = JSON.parse(readFileSync(path, "utf8")) as BloomerangData;
  const byConstituent = new Map<number, BloomerangMatch>();
  const previous = new Date(previousEventDate).getTime();
  const galaWindow = [previous - 14 * 86_400_000, previous + 21 * 86_400_000];
  const galaCampaign = /(\d+)(?:st|nd|rd|th) annual|gala/i;
  for (const c of data.constituents) {
    const id = Number(c.Id);
    const primary = c.PrimaryEmail;
    const email = normalizeEmail(primary && typeof primary === "object" && "Value" in primary ? primary.Value : "");
    const name = String(c.FullName || [c.FirstName, c.LastName].filter(Boolean).join(" ") || c.InformalName || "");
    byConstituent.set(id, { constituent_id: id, name, email, lifetime_cents: 0, gift_count: 0, first_gift: "", last_gift: "", last_gift_cents: 0, last_gala_cents: 0, last_gala_date: "", years_active: [], galas: [], monthly: false, records: 1, ids: [id] });
  }
  const galaTotals = new Map<number, Map<string, number>>();
  for (const t of data.transactions) {
    const match = byConstituent.get(Number(t.AccountId));
    if (!match || t.IsRefunded === true || t.IsRefunded === "Yes") continue;
    const date = String(t.Date || "").slice(0, 10);
    const ms = new Date(date).getTime();
    const amount = centsOf(t.Amount);
    const designations = Array.isArray(t.Designations) ? t.Designations as Record<string, unknown>[] : [];
    const types = designations.map(d => String(d.Type));
    if (!types.some(type => ["Donation", "Pledge", "PledgePayment", "RecurringDonationPayment"].includes(type))) continue;
    if (types.includes("RecurringDonationPayment")) match.monthly = true;
    const campaigns = designations.map(campaignName).filter(name => galaCampaign.test(name));
    for (const name of campaigns) {
      const label = name.replace(/^(\d+(?:st|nd|rd|th) Annual)\b.*$/i, "$1").replace(/ - id:\d+$/, "").trim();
      const totals = galaTotals.get(match.constituent_id) || new Map<string, number>();
      totals.set(label, (totals.get(label) || 0) + amount); galaTotals.set(match.constituent_id, totals);
    }
    const lastYear = campaigns.some(name => name.includes(`${new Date(previous).getFullYear()}`) || /9th annual/i.test(name)) || (ms >= galaWindow[0] && ms <= galaWindow[1]);
    if (lastYear) { match.last_gala_cents += amount; match.last_gala_date = date; }
    // Tonight's online gifts are already synced into Bloomerang; history means everything before the gala day.
    if (date >= eventDate) continue;
    match.lifetime_cents += amount; match.gift_count++;
    if (!match.first_gift || date < match.first_gift) match.first_gift = date;
    if (!match.last_gift || date > match.last_gift) { match.last_gift = date; match.last_gift_cents = amount; }
    const year = new Date(date).getFullYear();
    if (!match.years_active.includes(year)) match.years_active.push(year);
  }
  for (const match of byConstituent.values()) {
    match.years_active.sort();
    match.galas = [...(galaTotals.get(match.constituent_id) || new Map()).entries()].map(([label, cents]) => ({ label, cents })).sort((a, b) => (parseInt(a.label) || 99) - (parseInt(b.label) || 99));
    index.add(match.name, match, match.email);
  }
  return { connected: true, pulled_at: data.pulled_at, constituents: byConstituent.size, index, all: [...byConstituent.values()], message: `Bloomerang history pulled ${data.pulled_at}: ${byConstituent.size} constituents, ${data.transactions.length} transactions.` };
}

type StatsPayload = { pulled_at: string; ranges: Record<string, { website?: { connected?: boolean; totals?: { views: number; visitors: number; donate_views: number; donate_visitors: number; tagged_visitors: number }; utm?: { source: string; medium: string; campaign: string; content: string; visitors: number; donate_views: number }[]; devices?: { device: string; visitors: number }[]; referrers?: { domain: string; visitors: number }[] } }> };
const CHANNEL_LABELS: Record<string, string> = { "pledgeform/qrcode": "Pledge form QR", "qrcode/tablecard": "Table card QR", "givebar/qr": "Ballroom chart QR", "qrcode/backcover": "Booklet back cover QR", "qrcode/booklet": "Booklet inside QR", "ig/social": "Instagram bio link" };

/** Website analytics from the Givebar Stats dashboard (Umami), gala week and all time. */
export function loadWebStats(path: string, onlineGifts: number): WebStats {
  const empty: WebStats = { connected: false, pulled_at: "", week: null, all: null, channels: [], devices: [], referrers: [], conversion: 0 };
  if (!existsSync(path)) return empty;
  const payload = JSON.parse(readFileSync(path, "utf8")) as StatsPayload;
  const week = payload.ranges["7d"]?.website; const all = payload.ranges.all?.website;
  if (!week?.connected || !week.totals) return { ...empty, pulled_at: payload.pulled_at };
  const merged = new Map<string, WebChannel>();
  for (const u of week.utm || []) {
    if (!u.source) continue;
    const label = CHANNEL_LABELS[`${u.source}/${u.medium}`] || [u.source, u.medium].filter(Boolean).join(" / ");
    const row = merged.get(label) || { label, visitors: 0, donate_views: 0 };
    row.visitors += u.visitors; row.donate_views += u.donate_views; merged.set(label, row);
  }
  const channels = [...merged.values()].sort((a, b) => b.visitors - a.visitors).slice(0, 8);
  return {
    connected: true, pulled_at: payload.pulled_at,
    week: { views: week.totals.views, visitors: week.totals.visitors, donate_visitors: week.totals.donate_visitors, tagged_visitors: week.totals.tagged_visitors },
    all: all?.totals ? { views: all.totals.views, visitors: all.totals.visitors, donate_visitors: all.totals.donate_visitors } : null,
    channels, devices: (week.devices || []).map(d => ({ device: d.device, visitors: d.visitors })), referrers: (week.referrers || []).slice(0, 6).map(r => ({ domain: r.domain, visitors: r.visitors })),
    conversion: week.totals.donate_visitors ? onlineGifts / week.totals.donate_visitors : 0
  };
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
  const bloomerang = loadBloomerang(config.inputs.bloomerang, config.previous_event_date, config.event_date);

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
      table: tableIndex.find(r.donor_name)[0] || null, bloomerang: mergeBloomerang(bloomerang.index.find(r.donor_name, email)), household: personKey(r.donor_name) || r.donor_name.toLowerCase(),
      ...(() => { const n = readNote(r.notes && !/^Fundraising transaction/.test(r.notes) ? r.notes : "", r.payment_method, r.source); return { collection: n.collection, collection_ref: n.ref, note_plain: n.plain }; })()
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
    d.relationship = d.bloomerang ? (d.bloomerang.gift_count > 0 ? "repeat" : "new") : (d.prospect?.gave_before_cents ? "repeat" : "unknown");
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
    entered_by_hour: [],
    collection: (["online", "check", "cash", "card", "pledge"] as Collection[]).reduce((m, k) => { const rows = active.filter(g => g.collection === k); m[k] = { count: rows.length, cents: rows.reduce((n, g) => n + g.amount_cents, 0) }; return m; }, {} as Record<Collection, { count: number; cents: number }>)
  };

  const report: Report = {
    generated_at: new Date().toISOString(), config,
    event: { name: state.event_name, subtitle: state.event_subtitle, goal_cents: goal, total_cents: total, major_gift_threshold_cents: state.major_gift_threshold_cents, match_total_cents: state.match_total_cents, qr_url: state.qr_url, display_url: state.display_url, appeal_start: appealStart, first_gift_at: active[0]?.created_at || 0, last_gift_at: last },
    gifts, donors, events, qgiv: { all: qgiv.all, declined, pre_event: preEvent, form_name: qgiv.form_name, pulled_at: qgiv.pulled_at }, prospects: master.prospects, sponsors: master.sponsors, tickets: master.tickets, tables: master.tables, milestones, ask_tiers: askTiers,
    bloomerang: (() => {
      const returning = donors.filter(d => d.bloomerang?.last_gala_cents);
      const matchedIds = new Set(donors.flatMap(d => d.bloomerang?.ids || []));
      const matchedEmails = new Set(donors.flatMap(d => [d.email, d.bloomerang?.email || ""]).filter(Boolean));
      const lapsed = bloomerang.all.filter(m => m.last_gala_cents > 0 && !m.ids.some(id => matchedIds.has(id)) && !(m.email && matchedEmails.has(m.email))).map(m => ({ name: m.name, email: m.email, last_gala_cents: m.last_gala_cents, last_gift: m.last_gift, lifetime_cents: m.lifetime_cents })).sort((a, b) => b.last_gala_cents - a.last_gala_cents);
      return { connected: bloomerang.connected, pulled_at: bloomerang.pulled_at, constituents: bloomerang.constituents, matched: donors.filter(d => d.bloomerang).length, message: bloomerang.message,
        returning: { count: returning.length, then_cents: returning.reduce((n, d) => n + d.bloomerang!.last_gala_cents, 0), now_cents: returning.reduce((n, d) => n + d.total_cents, 0), upgraded: returning.filter(d => d.total_cents > d.bloomerang!.last_gala_cents).length, downgraded: returning.filter(d => d.total_cents < d.bloomerang!.last_gala_cents).length },
        repeat_cents: donors.filter(d => d.relationship === "repeat").reduce((n, d) => n + d.total_cents, 0), new_cents: donors.filter(d => d.relationship === "new").reduce((n, d) => n + d.total_cents, 0), lapsed };
    })(),
    web: loadWebStats(config.inputs.stats, online.length), stats, takeaways: []
  };
  report.takeaways = buildTakeaways(report);
  db.close();
  return report;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildTakeaways(r: Report): Takeaway[] {
  const s = r.stats; const out: Takeaway[] = [];
  const gap = s.goal_cents - s.total_cents;
  const col = s.collection;
  out.push({ kind: gap <= 0 ? "win" : "insight", title: gap <= 0 ? `Goal met: ${money(s.total_cents)} against ${money(s.goal_cents)}` : `${money(s.total_cents)} raised, ${pct(s.pct_of_goal)} of the ${money(s.goal_cents)} goal`, body: gap <= 0 ? `The total is ${money(-gap)} above the goal.` : `${money(gap)} short. ${s.prospects_missing.length} people on the major-donor ask list have no gift recorded; their asks total ${money(s.prospects_missing.reduce((t, p) => t + p.ask_cents, 0))}.` });
  if (col.pledge.cents > 0) out.push({ kind: "action", title: `${money(col.pledge.cents)} in pledges still needs an invoice (${col.pledge.count} gifts)`, body: `Of the ${money(s.pledge_cents)} recorded as pledges in the ballroom, staff notes show ${money(col.check.cents)} arrived as checks (${col.check.count}), ${money(col.cash.cents)} as cash (${col.cash.count}), and ${money(col.card.cents)} as card details on pledge cards (${col.card.count}). The remaining ${money(col.pledge.cents)} is a promise only. Send those donors a thank-you with a payment link within 48 hours and call every pledge of ${money(r.event.major_gift_threshold_cents)} or more. The Follow-up page lists them.` });
  if (col.check.cents + col.cash.cents > 0) out.push({ kind: "action", title: `Deposit ${money(col.check.cents + col.cash.cents)} in checks and cash collected at the tables`, body: `${col.check.count} checks and ${col.cash.count} cash gifts are recorded with their check numbers on the Gifts page. Deposit them this week and mark each one paid in Bloomerang so the pledge balance is correct.` });
  if (s.top10_pct > 0.5) out.push({ kind: "watch", title: `Ten gifts are ${pct(s.top10_pct)} of the total`, body: `${money(s.top10_cents)} came from ten gifts; the median gift is ${money(s.median_cents)}. Next year's result depends on ten conversations. Schedule those visits in the first quarter.` });
  if (s.declined_count) out.push({ kind: "action", title: `${s.declined_count} online payments were declined (${money(s.declined_cents)})`, body: `These people tried to give and their card failed. Email them the donate link with a short note that the payment did not go through. The list is on the Follow-up page.` });
  if (s.prospects_total) out.push({ kind: "insight", title: `${s.prospects_gave} of ${s.prospects_total} people on the ask list gave; ${s.prospects_under_ask.length} gave less than their ask`, body: `Asks on the list total ${money(s.prospects_ask_cents)}; the people who gave recorded ${money(s.prospects_actual_cents)}. Call the under-ask group this month; they already said yes to something.` });
  if (s.anonymous_count) out.push({ kind: "insight", title: `${s.anonymous_count} anonymous gifts, ${money(s.anonymous_cents)}`, body: `${pct(s.anonymous_cents / s.total_cents)} of the total. Their names are in this report and the workbook for the team only. Thank them privately; never print them.` });
  if (s.zakat_count) out.push({ kind: "insight", title: `Zakat was ${pct(s.zakat_cents / (s.online_cents || 1))} of online giving`, body: `${s.zakat_count} online donors chose the Zakat option (${money(s.zakat_cents)}). Keep the Zakat wording in the follow-up email.` });
  if (s.recurring_count) out.push({ kind: "win", title: `${s.recurring_count} new monthly donors`, body: `${money(s.recurring_monthly_cents)} per month started tonight, ${money(s.recurring_monthly_cents * 12)} a year. Send them a welcome note this week.` });
  if (s.gift_assist_cents) out.push({ kind: "insight", title: `Donors covered ${money(s.gift_assist_cents)} of ${money(s.fees_cents)} in card fees`, body: `Net online is ${money(s.net_online_cents)}. Leave the fee-cover option on.` });
  if (s.peak) out.push({ kind: "insight", title: `Most money arrived at ${s.peak.label}: ${money(s.peak.cents)} in 15 minutes`, body: `${s.peak.count} gifts in that window. Next year, announce the match and make the second ask inside it, not after.` });
  if (s.ticket_buyers) out.push({ kind: "action", title: `${s.ticket_buyers - s.ticket_buyers_gave} of ${s.ticket_buyers} ticket buyers have no gift recorded`, body: `They were in the room and heard the appeal. Email them first.` });
  if (r.web.connected && r.web.week) out.push({ kind: "insight", title: `${r.web.week.donate_visitors.toLocaleString("en-US")} people opened the donate page during gala week; ${pct(r.web.conversion)} of them gave`, body: `${r.web.week.visitors.toLocaleString("en-US")} website visitors in the seven days around the gala, ${Math.round(100 * (r.web.devices.find(d => d.device === "mobile")?.visitors || 0) / Math.max(1, r.web.devices.reduce((n, d) => n + d.visitors, 0)))}% on phones. The pledge-form QR (${r.web.channels[0]?.visitors || 0} visitors) and table-card QR brought more people than the chart on screen. Print both again next year.` });
  if (r.event.match_total_cents === 0) out.push({ kind: "watch", title: "No matching grant was set up", body: "A board or sponsor match, even $25,000, gives the emcee a second moment to ask. Arrange it before the next appeal; Givebar applies it automatically." });
  if (!r.bloomerang.connected) out.push({ kind: "action", title: "Connect Bloomerang to see repeat-donor history", body: r.bloomerang.message });
  else {
    const b = r.bloomerang;
    out.push({ kind: "insight", title: `${s.repeat_donors} repeat donors gave ${money(b.repeat_cents)}; ${s.new_donors} first-time donors gave ${money(b.new_cents)}`, body: `${b.matched} of ${s.households} households matched a Bloomerang record; ${s.unknown_donors} did not. Send first-time donors a welcome email within 7 days. Send repeat donors a thank-you that mentions their last gift.` });
    if (b.returning.count) out.push({ kind: b.returning.now_cents >= b.returning.then_cents ? "win" : "watch", title: `${b.returning.count} donors from last year's gala gave again: ${money(b.returning.then_cents)} last year, ${money(b.returning.now_cents)} this year`, body: `${b.returning.upgraded} gave more than last year, ${b.returning.downgraded} gave less. Call the people who gave less first. A board member should thank the people who gave more.` });
    if (b.lapsed.length) out.push({ kind: "action", title: `${b.lapsed.length} donors gave at last year's gala (${money(b.lapsed.reduce((n, l) => n + l.last_gala_cents, 0))}) and have no gift recorded this year`, body: `Some of them gave under a spouse's or business name; check the Follow-up list before calling. Then email them as a separate group.` });
  }
  for (const extra of r.config.extra_takeaways) out.push({ kind: "insight", title: extra, body: "" });
  return out;
}
