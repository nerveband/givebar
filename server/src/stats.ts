import type { Database } from "bun:sqlite";
import { SQL } from "bun";
import { foldLedger, getEventState, type LedgerEvent } from "./ledger";
import { getMilestones } from "./projection";
import { getSession } from "./authz";

/**
 * Stats projection (/stats): what came in, from where, and how the room found the donation page.
 *
 * Ledger figures are folded from SQLite on every request. Website figures come from the
 * Umami database for the configured website when GIVEBAR_UMAMI_DATABASE_URL and
 * GIVEBAR_UMAMI_WEBSITE_ID are set; they are cached briefly because the page refreshes
 * itself and the event table is large. Public responses mask anonymous names and
 * omit operator identities; signed-in operators retain their detailed view.
 */

export type StatsRange = "today" | "24h" | "7d" | "30d" | "all";
const RANGES: Record<string, true> = { today: true, "24h": true, "7d": true, "30d": true, all: true };
const WEB_CACHE_MS = 30_000;
const WEB_MAX_DAYS = 90;
const DONATE_PATHS = /donat|gala|give|pledge/i;

export interface Bucket { t: number; gifts: number; cents: number; cumulative_cents: number }
export interface KeyCount { key: string; label: string; gifts: number; cents: number }
export interface WebBucket { t: number; views: number; visitors: number }
export interface UtmRow { source: string; medium: string; campaign: string; content: string; views: number; visitors: number; donate_views: number }

interface WebEventRow { created_at: Date; session_id: string; url_path: string; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; utm_content: string | null; referrer_domain: string | null; device: string | null }

/** Midnight in the event's time zone, as epoch ms. */
function startOfEasternDay(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  const secondsIntoDay = (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
  return now - secondsIntoDay * 1000 - (now % 1000);
}

export function rangeBounds(range: StatsRange, now: number, earliest: number): { from: number; to: number; bucket_ms: number } {
  const day = 86_400_000;
  const bounds = range === "today" ? { from: startOfEasternDay(now), to: now }
    : range === "24h" ? { from: now - day, to: now }
    : range === "7d" ? { from: now - 7 * day, to: now }
    : range === "30d" ? { from: now - 30 * day, to: now }
    : { from: Math.min(earliest || now, now - day), to: now };
  const span = bounds.to - bounds.from;
  const bucket = span <= day ? 15 * 60_000 : span <= 2 * day ? 30 * 60_000 : span <= 8 * day ? 3_600_000 : span <= 32 * day ? 6 * 3_600_000 : day;
  return { ...bounds, bucket_ms: bucket };
}

const SIZE_BUCKETS: [number, string][] = [[10_000, "Under $100"], [50_000, "$100 to $499"], [100_000, "$500 to $999"], [500_000, "$1,000 to $4,999"], [1_000_000, "$5,000 to $9,999"], [2_500_000, "$10,000 to $24,999"], [Infinity, "$25,000 and up"]];
const SOURCE_LABEL: Record<string, string> = { manual: "Entered by hand", bloomerang: "Online gift", rehearsal: "Rehearsal sample" };
const METHOD_LABEL: Record<string, string> = { pledge: "Pledge", card: "Card", check: "Check", cash: "Cash" };

function tally(map: Map<string, KeyCount>, key: string, label: string, cents: number): void {
  const row = map.get(key) || { key, label, gifts: 0, cents: 0 };
  row.gifts++;
  row.cents += cents;
  map.set(key, row);
}

export function ledgerStats(db: Database, range: StatsRange, source: string, method: string, now = Date.now()) {
  const fold = foldLedger(db);
  const events = db.query<LedgerEvent, []>(`SELECT * FROM ledger ORDER BY seq ASC`).all();
  const earliest = events.reduce((min, event) => event.event_type === "create" && event.source !== "rehearsal" ? Math.min(min, event.created_at) : min, now);
  const bounds = rangeBounds(range, now, earliest);
  const state = getEventState(db);

  const active = Array.from(fold.active_donations.values())
    .filter(record => record.source !== "rehearsal")
    .filter(record => record.created_at >= bounds.from && record.created_at <= bounds.to)
    .filter(record => !source || record.source === source)
    .filter(record => !method || record.payment_method === method)
    .sort((a, b) => a.created_at - b.created_at);

  const bySource = new Map<string, KeyCount>();
  const byMethod = new Map<string, KeyCount>();
  const bySize = new Map<string, KeyCount>();
  const byHour = new Map<string, KeyCount>();
  const buckets = new Map<number, Bucket>();
  let direct = 0;
  let matched = 0;
  let anonymous = 0;
  const amounts: number[] = [];
  for (const record of active) {
    direct += record.amount_cents;
    matched += record.matched_amount_cents;
    if (record.is_anonymous) anonymous++;
    amounts.push(record.amount_cents);
    tally(bySource, record.source, SOURCE_LABEL[record.source] || record.source, record.amount_cents);
    tally(byMethod, record.payment_method, METHOD_LABEL[record.payment_method] || record.payment_method, record.amount_cents);
    const size = SIZE_BUCKETS.find(([limit]) => record.amount_cents < limit)!;
    tally(bySize, String(SIZE_BUCKETS.indexOf(size)), size[1], record.amount_cents);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true }).format(new Date(record.created_at));
    tally(byHour, String(Math.floor(((record.created_at - startOfEasternDay(record.created_at)) / 3_600_000) % 24)).padStart(2, "0"), hour, record.amount_cents);
    const slot = Math.floor(record.created_at / bounds.bucket_ms) * bounds.bucket_ms;
    const bucket = buckets.get(slot) || { t: slot, gifts: 0, cents: 0, cumulative_cents: 0 };
    bucket.gifts++;
    bucket.cents += record.amount_cents + record.matched_amount_cents;
    buckets.set(slot, bucket);
  }
  const timeline: Bucket[] = [];
  let running = 0;
  for (let slot = Math.floor(bounds.from / bounds.bucket_ms) * bounds.bucket_ms; slot <= bounds.to; slot += bounds.bucket_ms) {
    const bucket = buckets.get(slot) || { t: slot, gifts: 0, cents: 0, cumulative_cents: 0 };
    running += bucket.cents;
    timeline.push({ ...bucket, cumulative_cents: running });
  }

  const sorted = [...amounts].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)) : 0;

  const operators = new Map<string, { operator: string; adds: number; edits: number; deletes: number; restores: number; cents: number }>();
  const inRange = events.filter(event => event.created_at >= bounds.from && event.created_at <= bounds.to && event.source !== "rehearsal" && !event.donation_id.startsWith("match_"));
  for (const event of inRange) {
    const name = event.entered_by || "Unknown";
    const row = operators.get(name) || { operator: name, adds: 0, edits: 0, deletes: 0, restores: 0, cents: 0 };
    if (event.event_type === "create") { row.adds++; row.cents += event.amount_cents; }
    else if (event.event_type === "amend") row.edits++;
    else if (event.event_type === "void") row.deletes++;
    else if (event.event_type === "restore") row.restores++;
    operators.set(name, row);
  }

  return {
    range,
    from: bounds.from,
    to: bounds.to,
    bucket_ms: bounds.bucket_ms,
    goal_cents: state.goal_cents,
    milestones: getMilestones(db, state.goal_cents),
    summary: {
      total_cents: direct + matched,
      direct_cents: direct,
      matched_cents: matched,
      gifts: active.length,
      average_cents: active.length ? Math.round(direct / active.length) : 0,
      median_cents: median,
      largest_cents: sorted.length ? sorted[sorted.length - 1] : 0,
      anonymous: anonymous,
      online: active.filter(record => record.source === "bloomerang").length,
      manual: active.filter(record => record.source === "manual").length,
      deleted: inRange.filter(event => event.event_type === "void").length,
      edited: inRange.filter(event => event.event_type === "amend").length,
      all_time_total_cents: fold.total_raised_cents,
      all_time_gifts: fold.active_donation_count
    },
    timeline,
    by_source: Array.from(bySource.values()).sort((a, b) => b.cents - a.cents),
    by_method: Array.from(byMethod.values()).sort((a, b) => b.cents - a.cents),
    by_size: Array.from(bySize.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, row]) => row),
    by_hour: Array.from(byHour.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([, row]) => row),
    top_gifts: [...active].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 10).map(record => ({
      donation_id: record.donation_id, donor_name: record.donor_name, is_anonymous: record.is_anonymous, amount_cents: record.amount_cents,
      matched_amount_cents: record.matched_amount_cents, source: record.source, payment_method: record.payment_method, created_at: record.created_at
    })),
    operators: Array.from(operators.values()).sort((a, b) => b.adds - a.adds)
  };
}

export interface WebStats {
  connected: boolean;
  message?: string;
  website?: string;
  from?: number;
  to?: number;
  bucket_ms?: number;
  timeline?: WebBucket[];
  utm?: UtmRow[];
  referrers?: { domain: string; views: number; visitors: number }[];
  devices?: { device: string; visitors: number }[];
  pages?: { path: string; views: number; visitors: number }[];
  totals?: { views: number; visitors: number; donate_views: number; donate_visitors: number; tagged_visitors: number };
}

export interface WebStatsSource {
  query(range: StatsRange, now: number): Promise<WebStats>;
  close(): void;
}

export function createWebStats(databaseUrl = process.env.GIVEBAR_UMAMI_DATABASE_URL || "", websiteId = process.env.GIVEBAR_UMAMI_WEBSITE_ID || ""): WebStatsSource {
  const sql = databaseUrl ? new SQL(databaseUrl, { max: 2, connectionTimeout: 5, idleTimeout: 60 }) : null;
  const cache = new Map<string, { at: number; value: WebStats }>();
  async function query(range: StatsRange, now: number): Promise<WebStats> {
    if (!sql || !websiteId) return { connected: false, message: "Website analytics are not connected on this server." };
    const key = `${range}:${Math.floor(now / WEB_CACHE_MS)}`;
    const hit = cache.get(key);
    if (hit) return hit.value;
    const bounds = rangeBounds(range, now, now - WEB_MAX_DAYS * 86_400_000);
    const from = new Date(Math.max(bounds.from, now - WEB_MAX_DAYS * 86_400_000));
    const to = new Date(bounds.to);
    try {
      const rows = await sql<WebEventRow[]>`
        SELECT e.created_at, e.session_id, e.url_path, e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.referrer_domain, s.device
        FROM website_event e LEFT JOIN session s ON s.session_id = e.session_id
        WHERE e.website_id = ${websiteId}::uuid AND e.event_type = 1 AND e.created_at >= ${from} AND e.created_at <= ${to}
        ORDER BY e.created_at ASC`;
      const value = summarizeWeb(rows, bounds.from, bounds.to, bounds.bucket_ms);
      const result: WebStats = { connected: true, website: websiteId, ...value };
      cache.set(key, { at: now, value: result });
      for (const [k, entry] of cache) if (now - entry.at > WEB_CACHE_MS * 4) cache.delete(k);
      return result;
    } catch (error) {
      return { connected: false, message: `Website analytics are unreachable: ${error instanceof Error ? error.message.slice(0, 120) : "connection failed"}` };
    }
  }

  return { query, close: () => sql?.close() };
}

export function summarizeWeb(rows: WebEventRow[], from: number, to: number, bucketMs: number) {
  const buckets = new Map<number, { views: number; sessions: Set<string> }>();
  const utm = new Map<string, { row: UtmRow; sessions: Set<string> }>();
  const referrers = new Map<string, { views: number; sessions: Set<string> }>();
  const devices = new Map<string, Set<string>>();
  const pages = new Map<string, { views: number; sessions: Set<string> }>();
  const all = new Set<string>();
  const donate = new Set<string>();
  const tagged = new Set<string>();
  let views = 0;
  let donateViews = 0;

  for (const row of rows) {
    const at = row.created_at.getTime();
    const isDonate = DONATE_PATHS.test(row.url_path);
    views++;
    all.add(row.session_id);
    if (isDonate) {
      donateViews++;
      donate.add(row.session_id);
      const slot = Math.floor(at / bucketMs) * bucketMs;
      const bucket = buckets.get(slot) || { views: 0, sessions: new Set<string>() };
      bucket.views++;
      bucket.sessions.add(row.session_id);
      buckets.set(slot, bucket);
      const page = pages.get(row.url_path) || { views: 0, sessions: new Set<string>() };
      page.views++;
      page.sessions.add(row.session_id);
      pages.set(row.url_path, page);
      devices.set(row.device || "unknown", (devices.get(row.device || "unknown") || new Set<string>()).add(row.session_id));
    }
    if (row.utm_source || row.utm_medium || row.utm_campaign) {
      tagged.add(row.session_id);
      const key = [row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content].map(value => value || "").join("|");
      const entry = utm.get(key) || { row: { source: row.utm_source || "", medium: row.utm_medium || "", campaign: row.utm_campaign || "", content: row.utm_content || "", views: 0, visitors: 0, donate_views: 0 }, sessions: new Set<string>() };
      entry.row.views++;
      if (isDonate) entry.row.donate_views++;
      entry.sessions.add(row.session_id);
      utm.set(key, entry);
    }
    const domain = row.referrer_domain || "(direct)";
    const ref = referrers.get(domain) || { views: 0, sessions: new Set<string>() };
    ref.views++;
    ref.sessions.add(row.session_id);
    referrers.set(domain, ref);
  }

  const timeline: WebBucket[] = [];
  for (let slot = Math.floor(from / bucketMs) * bucketMs; slot <= to; slot += bucketMs) {
    const bucket = buckets.get(slot);
    timeline.push({ t: slot, views: bucket?.views || 0, visitors: bucket?.sessions.size || 0 });
  }
  return {
    from, to, bucket_ms: bucketMs, timeline,
    utm: Array.from(utm.values()).map(entry => ({ ...entry.row, visitors: entry.sessions.size })).sort((a, b) => b.visitors - a.visitors),
    referrers: Array.from(referrers.entries()).map(([domain, entry]) => ({ domain, views: entry.views, visitors: entry.sessions.size })).sort((a, b) => b.visitors - a.visitors).slice(0, 10),
    devices: Array.from(devices.entries()).map(([device, sessions]) => ({ device, visitors: sessions.size })).sort((a, b) => b.visitors - a.visitors),
    pages: Array.from(pages.entries()).map(([path, entry]) => ({ path, views: entry.views, visitors: entry.sessions.size })).sort((a, b) => b.views - a.views).slice(0, 10),
    totals: { views, visitors: all.size, donate_views: donateViews, donate_visitors: donate.size, tagged_visitors: tagged.size }
  };
}


/** GET /api/stats?range=today|24h|7d|30d|all&source=&method= */
export async function handleStatsRequest(req: Request, db: Database, web: WebStatsSource): Promise<Response> {
  const session = getSession(req, db);
  if (req.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED", message: "GET required" }, { status: 405 });
  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range") || "all";
  if (!RANGES[rangeParam]) return Response.json({ error: "INVALID_RANGE", message: "range must be today, 24h, 7d, 30d, or all" }, { status: 400 });
  const range = rangeParam as StatsRange;
  const source = url.searchParams.get("source") || "";
  const method = url.searchParams.get("method") || "";
  if (source && !SOURCE_LABEL[source]) return Response.json({ error: "INVALID_SOURCE", message: "source must be manual or bloomerang" }, { status: 400 });
  if (method && !METHOD_LABEL[method]) return Response.json({ error: "INVALID_METHOD", message: "method must be pledge, card, check, or cash" }, { status: 400 });
  const now = Date.now();
  const [ledger, website] = await Promise.all([ledgerStats(db, range, source, method, now), web.query(range, now)]);
  if (!session) {
    const records = foldLedger(db).active_donations;
    ledger.top_gifts = ledger.top_gifts.map(gift => ({
      ...gift, donation_id: Bun.hash(gift.donation_id).toString(36),
      donor_name: gift.is_anonymous ? "Anonymous Supporter" : records.get(gift.donation_id)!.display_name
    }));
    ledger.operators = [];
    if (!website.connected) website.message = "Website analytics are currently unavailable.";
  }
  return Response.json({ ...ledger, website, can_view_private: !!session, server_time: now }, { headers: { "Cache-Control": "no-store" } });
}
