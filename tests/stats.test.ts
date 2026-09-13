import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../server/src/db";
import { amendDonation, recordDonation, updateEventState, voidDonation } from "../server/src/ledger";
import { handleStatsRequest, ledgerStats, rangeBounds, summarizeWeb } from "../server/src/stats";
import { backupsFor, get, sessionCookie } from "./auth-helper";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => db.close());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function backdate(donationId: string, ms: number): void {
  db.query(`UPDATE ledger SET created_at = created_at - ? WHERE donation_id = ?`).run(ms, donationId);
}

describe("Ledger stats", () => {
  test("folds gifts in range by source, method, size, and operator; corrections count once; rehearsal never counts", () => {
    updateEventState(db, { is_match_active: 1, match_total_cents: 100000, match_ratio: 1 });
    recordDonation(db, { donation_id: "a", donor_name: "Ada", amount_cents: 250000, payment_method: "pledge", entered_by: "Sara" });
    recordDonation(db, { donation_id: "b", donor_name: "Bo", amount_cents: 5000, payment_method: "card", source: "bloomerang", source_txn_id: "t1", entered_by: "Bloomerang Fundraising" });
    recordDonation(db, { donation_id: "c", donor_name: "Cy", amount_cents: 75000, payment_method: "check", entered_by: "Sara", is_anonymous: true });
    recordDonation(db, { donation_id: "r", donor_name: "Sample", amount_cents: 9000000, source: "rehearsal", confirmed_major_gift: true, confirmed_duplicate: true });
    recordDonation(db, { donation_id: "old", donor_name: "Old", amount_cents: 1000, entered_by: "Omar" });
    backdate("old", 3 * DAY);
    amendDonation(db, "a", { amount_cents: 200000, entered_by: "Omar" });
    recordDonation(db, { donation_id: "d", donor_name: "Del", amount_cents: 4000, entered_by: "Sara" });
    voidDonation(db, "d", "Omar", "typo");

    const stats = ledgerStats(db, "24h", "", "");
    expect(stats.summary.gifts).toBe(3);
    expect(stats.summary.direct_cents).toBe(280000);
    expect(stats.summary.matched_cents).toBe(100000);
    expect(stats.summary.total_cents).toBe(380000);
    expect(stats.summary.anonymous).toBe(1);
    expect(stats.summary.online).toBe(1);
    expect(stats.summary.edited).toBe(1);
    expect(stats.summary.deleted).toBe(1);
    expect(stats.summary.largest_cents).toBe(200000);
    expect(stats.summary.median_cents).toBe(75000);
    expect(stats.by_source.map(r => [r.key, r.gifts])).toEqual([["manual", 2], ["bloomerang", 1]]);
    expect(stats.by_method.map(r => r.key)).toEqual(["pledge", "check", "card"]);
    expect(stats.by_size.map(r => [r.label, r.gifts])).toEqual([["Under $100", 1], ["$500 to $999", 1], ["$1,000 to $4,999", 1]]);
    expect(stats.timeline[stats.timeline.length - 1].cumulative_cents).toBe(380000);
    expect(stats.timeline.reduce((sum, b) => sum + b.gifts, 0)).toBe(3);
    const sara = stats.operators.find(o => o.operator === "Sara")!;
    expect([sara.adds, sara.edits, sara.deletes]).toEqual([3, 0, 0]);
    const omar = stats.operators.find(o => o.operator === "Omar")!;
    expect([omar.adds, omar.edits, omar.deletes]).toEqual([0, 1, 1]);
    expect(JSON.stringify(stats)).not.toContain("Sample");

    expect(ledgerStats(db, "all", "", "").summary.gifts).toBe(4);
    expect(ledgerStats(db, "24h", "bloomerang", "").summary.gifts).toBe(1);
    expect(ledgerStats(db, "24h", "", "check").summary.direct_cents).toBe(75000);
  });

  test("range buckets shrink with the window", () => {
    const now = Date.parse("2026-09-12T23:00:00Z");
    expect(rangeBounds("24h", now, 0).bucket_ms).toBe(60_000);
    expect(rangeBounds("7d", now, 0).bucket_ms).toBe(HOUR);
    expect(rangeBounds("30d", now, 0).bucket_ms).toBe(6 * HOUR);
    expect(rangeBounds("all", now, now - 100 * DAY).bucket_ms).toBe(DAY);
    const today = rangeBounds("today", now, 0);
    expect(now - today.from).toBeLessThanOrEqual(DAY);
    expect(new Date(today.from).toISOString()).toBe("2026-09-12T04:00:00.000Z");
  });
});

describe("Website stats", () => {
  test("counts donation page visits, UTM arrivals, referrers, and devices per session", () => {
    const from = Date.parse("2026-09-12T00:00:00Z");
    const row = (minutes: number, session: string, path: string, extra: Record<string, string | null> = {}) => ({
      created_at: new Date(from + minutes * 60_000), session_id: session, url_path: path,
      utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, referrer_domain: null, device: "mobile", ...extra
    });
    const rows = [
      row(5, "s1", "/gala2026donate/", { utm_source: "qrcode", utm_medium: "tablecard", utm_campaign: "cgagala2026" }),
      row(6, "s1", "/gala2026donate/#give", { utm_source: "qrcode", utm_medium: "tablecard", utm_campaign: "cgagala2026" }),
      row(20, "s2", "/", { referrer_domain: "google.com", device: "desktop" }),
      row(21, "s2", "/donate/", { referrer_domain: "google.com", device: "desktop" }),
      row(70, "s3", "/about/", { utm_source: "givebar", utm_medium: "qr" }),
      row(71, "s3", "/gala2026donate/", { utm_source: "givebar", utm_medium: "qr" })
    ];
    const web = summarizeWeb(rows, from, from + 2 * HOUR, HOUR);
    expect(web.totals).toEqual({ views: 6, visitors: 3, donate_views: 4, donate_visitors: 3, tagged_visitors: 2 });
    expect(web.timeline.map(b => [b.views, b.visitors])).toEqual([[3, 2], [1, 1], [0, 0]]);
    expect(web.utm.map(u => [u.source, u.medium, u.visitors, u.donate_views])).toEqual([["qrcode", "tablecard", 1, 2], ["givebar", "qr", 1, 1]]);
    expect(web.referrers[0]).toEqual({ domain: "(direct)", views: 4, visitors: 2 });
    expect(web.devices).toEqual([{ device: "mobile", visitors: 2 }, { device: "desktop", visitors: 1 }]);
    expect(web.pages[0].path).toBe("/gala2026donate/");
  });

  test("the stats endpoint is public and reports unavailable analytics", async () => {
    const backups = backupsFor(db);
    const web = { query: async () => ({ connected: false, message: "Website analytics are not connected on this server." }), close() {} };
    expect((await handleStatsRequest(get("/api/stats"), db, web)).status).toBe(200);
    const cookie = await sessionCookie(db, backups, "sara", "operator");
    expect((await handleStatsRequest(get("/api/stats?range=lastyear", cookie), db, web)).status).toBe(400);
    const body = await (await handleStatsRequest(get("/api/stats?range=today", cookie), db, web)).json();
    expect(body.website.connected).toBe(false);
    expect(body.summary.gifts).toBe(0);
  });
});


test("last hour separates adjacent minutes, fills idle minutes, and excludes older gifts", () => {
  const now = Date.parse("2026-09-12T23:30:30Z");
  for (const [id, at, cents] of [["older", now - HOUR - 1, 9000], ["first", Date.parse("2026-09-12T23:21:10Z"), 1000], ["second", Date.parse("2026-09-12T23:22:10Z"), 2000]] as const) {
    recordDonation(db, { donation_id: id, donor_name: id, amount_cents: cents });
    db.query("UPDATE ledger SET created_at = ? WHERE donation_id = ?").run(at, id);
  }
  const stats = ledgerStats(db, "1h", "", "", now);
  expect(stats.from).toBe(now - HOUR);
  expect(stats.bucket_ms).toBe(60_000);
  expect(stats.summary.total_cents).toBe(3000);
  expect(stats.timeline.filter(b => b.gifts).map(b => b.cents)).toEqual([1000, 2000]);
  expect(stats.timeline.find(b => b.t === Date.parse("2026-09-12T23:23:00Z"))?.gifts).toBe(0);
  expect(stats.timeline.at(-1)?.cumulative_cents).toBe(3000);
  expect(stats.by_minute.map(b => [b.label, b.cents])).toEqual([["7:21 PM", 1000], ["7:22 PM", 2000]]);
});

test('search and amount filters agree across summary, timeline, rows and authenticated CSV', async () => {
  const web = { query: async () => ({ connected: false }), close() {} };
  const cookie = await sessionCookie(db, backupsFor(db), 'reviewer', 'operator');
  recordDonation(db, { donation_id: 'csv-a', donor_name: '=Example, "Donor"', amount_cents: 12345, entered_by: 'Desk One' });
  recordDonation(db, { donation_id: 'csv-b', donor_name: 'Other', amount_cents: 999, entered_by: 'Desk Two' });
  const query = '/api/stats?range=1h&q=Example&min=10000&max=20000&bucket=300000&sort=amount_desc';
  const result = await (await handleStatsRequest(get(query, cookie), db, web)).json();
  expect(result.summary.total_cents).toBe(12345);
  expect(result.donations).toHaveLength(1);
  expect(result.timeline.at(-1).cumulative_cents).toBe(12345);
  expect(result.bucket_ms).toBe(300000);
  expect(result.operators.map(o => o.operator)).toEqual(['Desk One']);
  const csv = await handleStatsRequest(get(query + '&format=csv', cookie), db, web);
  expect(csv.status).toBe(200);
  const text = await csv.text();
  expect(text).toContain('"\'=Example, ""Donor"""');
  expect(text).toContain('"123.45"');
  expect(text).not.toContain('Other');
  expect((await handleStatsRequest(get(query + '&format=csv'), db, web)).status).toBe(401);
});

test('public search cannot discover private anonymous names, notes or operators', async () => {
  const web = { query: async () => ({ connected: false }), close() {} };
  recordDonation(db, { donation_id: 'private-search', donor_name: 'Secret Name', amount_cents: 5000, is_anonymous: true, notes: 'Hidden Note', entered_by: 'Private Operator' });
  for (const q of ['Secret', 'Hidden', 'Private']) {
    const result = await (await handleStatsRequest(get('/api/stats?range=1h&q=' + q), db, web)).json();
    expect(result.summary.gifts).toBe(0);
    expect(result.donations).toEqual([]);
  }
  const publicResult = await (await handleStatsRequest(get('/api/stats?range=1h&q=Anonymous'), db, web)).json();
  expect(publicResult.donations[0].donor_name).toBe('Anonymous Supporter');
  expect(JSON.stringify(publicResult)).not.toContain('Secret Name');
  expect(publicResult.donations[0].operator).toBeUndefined();
});

test('rejects invalid filters and impractically dense chart ranges', async () => {
  const web = { query: async () => ({ connected: false }), close() {} };
  for (const query of ['min=-1', 'min=200&max=100', 'bucket=12', 'sort=bad', 'range=30d&bucket=60000']) {
    expect((await handleStatsRequest(get('/api/stats?' + query), db, web)).status).toBe(400);
  }
});

test('every chart interval preserves amounts and forwards the interval to website analytics', async () => {
  recordDonation(db, { donation_id: 'interval', donor_name: 'Interval', amount_cents: 12345 });
  for (const bucket of [60000, 300000, 900000, 3600000, 86400000]) {
    let received: number | undefined;
    const web = { query: async (_range: string, _now: number, interval?: number) => { received = interval; return { connected: false }; }, close() {} };
    const result = await (await handleStatsRequest(get(`/api/stats?range=1h&bucket=${bucket}`), db, web)).json();
    expect(received).toBe(bucket);
    expect(result.bucket_ms).toBe(bucket);
    expect(result.timeline.reduce((sum, row) => sum + row.cents, 0)).toBe(12345);
    expect(result.timeline.at(-1).cumulative_cents).toBe(result.summary.total_cents);
  }
});

test('all sort orders retain the same filtered gifts and exact totals', () => {
  const now = Date.now();
  for (const [id, amount, age] of [['sort-a', 1000, 3000], ['sort-b', 3000, 2000], ['sort-c', 2000, 1000]] as const) {
    recordDonation(db, { donation_id: id, donor_name: id, amount_cents: amount });
    db.query('UPDATE ledger SET created_at=? WHERE donation_id=?').run(now-age, id);
  }
  for (const [sort, amounts] of [['newest', [2000, 3000, 1000]], ['oldest', [1000, 3000, 2000]], ['amount_asc', [1000, 2000, 3000]], ['amount_desc', [3000, 2000, 1000]]] as const) {
    const result = ledgerStats(db, '1h', '', '', now, {sort});
    expect(result.donations.map(g => g.amount_cents)).toEqual([...amounts]);
    expect(result.summary.direct_cents).toBe(6000);
  }
});

test('custom date bounds include the full requested period in rows, charts, website query and CSV', async () => {
  const from = Date.parse('2026-09-12T23:00:00Z'), to = Date.parse('2026-09-12T23:59:00Z');
  const cookie = await sessionCookie(db, backupsFor(db), 'customreview', 'operator');
  for (const [id, time] of [['before', from - 1], ['start', from], ['end', to], ['after', to + 1]] as const) {
    recordDonation(db, { donation_id: id, donor_name: id, amount_cents: 1000 });
    db.query('UPDATE ledger SET created_at=? WHERE donation_id=?').run(time, id);
  }
  let received;
  const web = { query: async (_r, _n, _b, custom) => { received = custom; return {connected:false}; }, close() {} };
  const query = `/api/stats?range=custom&from=${from}&to=${to}`;
  const result = await (await handleStatsRequest(get(query, cookie), db, web)).json();
  expect(received).toEqual({from,to});
  expect(result.summary.gifts).toBe(2);
  expect(result.timeline.at(-1).cumulative_cents).toBe(2000);
  expect(result.donations.map(g => g.donor_name)).toEqual(['end','start']);
  const csv = await (await handleStatsRequest(get(query+'&format=csv', cookie), db, web)).text();
  expect(csv).toContain('"start"'); expect(csv).not.toContain('"before"');
  for (const bad of ['range=custom', `range=custom&from=${to}&to=${from}`, `range=custom&from=${from}&to=${Date.now()+86400000}`])
    expect((await handleStatsRequest(get('/api/stats?'+bad), db, web)).status).toBe(400);
});
