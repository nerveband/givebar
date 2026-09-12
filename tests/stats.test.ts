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
    expect(rangeBounds("24h", now, 0).bucket_ms).toBe(15 * 60_000);
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
