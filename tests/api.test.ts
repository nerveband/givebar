import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, migrateSchema, SCHEMA_VERSION } from "../server/src/db";
import { foldLedger, getEventState, recordDonation, updateEventState } from "../server/src/ledger";
import { getStageState } from "../server/src/projection";
import { handleControlRequest } from "../server/src/routes/control";
import { handleDonationRequest } from "../server/src/routes/donation";
import { handleHistoryRequest } from "../server/src/routes/history";
import { handleStateRequest } from "../server/src/routes/state";
import { handleExportCSV } from "../server/src/routes/export";
import { handleQRRequest } from "../server/src/routes/qr";
import type { BackupManager } from "../server/src/backup";
import { backupsFor, control, get, json, sessionCookie } from "./auth-helper";

let db: Database;
let backups: BackupManager;
beforeEach(() => { db = initDatabase(":memory:"); backups = backupsFor(db); });
afterEach(() => db.close());

async function donation(id: string, body: Record<string, unknown>, cookie: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await handleDonationRequest(json(`/api/donation/${id}`, body, cookie, "PUT"), db, ["api", "donation", id]);
  return { status: res.status, data: await res.json() };
}

describe("Donation endpoints", () => {
  test("PUT is idempotent on the client id, and every guard rail has its own status", async () => {
    const cookie = await sessionCookie(db, backups, "sara", "operator");
    updateEventState(db, { feature_card_number: 1 });
    expect((await donation("g1", { donor_name: "Ada", amount_cents: 250000, notes: "table 4", card_number: "0101" }, cookie)).status).toBe(201);
    expect((await donation("g1", { donor_name: "Ada", amount_cents: 250000 }, cookie)).status).toBe(200);
    expect(foldLedger(db).active_donations.get("g1")!.entered_by).toBe("Sara");

    const major = await donation("g2", { donor_name: "Whale", amount_cents: 5000000 }, cookie);
    expect(major.status).toBe(428);
    expect(major.data.error).toBe("MAJOR_GIFT_CONFIRMATION_REQUIRED");
    expect((await donation("g2", { donor_name: "Whale", amount_cents: 5000000, confirmed_major_gift: true }, cookie)).status).toBe(201);

    const dup = await donation("g3", { donor_name: "ada", amount_cents: 250000 }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.data.error).toBe("POSSIBLE_DUPLICATE");
    expect(dup.data.prior_entered_by).toBe("Sara");
    expect((await donation("g3", { donor_name: "ada", amount_cents: 250000, confirmed_duplicate: true }, cookie)).status).toBe(201);

    const card = await donation("g4", { donor_name: "Other", amount_cents: 100, card_number: "#0101" }, cookie);
    expect(card.status).toBe(409);
    expect(card.data.error).toBe("CARD_COLLISION");

    expect((await donation("bad id!", { donor_name: "X", amount_cents: 100 }, cookie)).status).toBe(400);
    expect((await donation("g5", { donor_name: "X", amount_cents: 0 }, cookie)).status).toBe(400);
  });

  test("amend, void, and restore are attributed to the session and surface on History", async () => {
    const sara = await sessionCookie(db, backups, "sara", "operator");
    await donation("g1", { donor_name: "Ada", amount_cents: 250000 }, sara);
    const amend = await handleDonationRequest(json("/api/donation/g1/amend", { amount_cents: 300000, notes: "corrected" }, sara), db, ["api", "donation", "g1", "amend"]);
    expect(amend.status).toBe(200);
    expect((await handleDonationRequest(json("/api/donation/g1/void", { reason: "typo" }, sara), db, ["api", "donation", "g1", "void"])).status).toBe(200);
    expect((await handleDonationRequest(json("/api/donation/g1/void", {}, sara), db, ["api", "donation", "g1", "void"])).status).toBe(400);
    expect((await handleDonationRequest(json("/api/donation/g1/restore", {}, sara), db, ["api", "donation", "g1", "restore"])).status).toBe(200);

    const history = await (await handleHistoryRequest(get("/api/history", sara), db)).json();
    expect(history.events.map((e: { event_type: string }) => e.event_type)).toEqual(["restore", "void", "amend", "create"]);
    expect(history.events.every((e: { entered_by: string }) => e.entered_by === "Sara")).toBe(true);
    expect(history.status.g1).toEqual({ is_voided: false, amount_cents: 300000 });
    expect(history.total_raised_cents).toBe(300000);
  });

  test("CSV export lists every ledger event with formula injection neutralised and a reconciliation footer", async () => {
    const cookie = await sessionCookie(db, backups);
    recordDonation(db, { donation_id: "csv", donor_name: "=cmd()|Injector", amount_cents: 12345, notes: "a,b \"quoted\"" });
    const csv = await handleExportCSV(get("/api/export/csv", cookie), db).text();
    expect(csv).toContain("'=cmd()|Injector");
    expect(csv).toContain("\"a,b \"\"quoted\"\"\"");
    expect(csv).toContain("Total Authoritative Raised (USD),123.45");
  });

  test("QR encodes the stored donation URL and rejects an empty target", async () => {
    expect(handleQRRequest(get("/api/qr"), db).status).toBe(400);
    updateEventState(db, { qr_url: "https://example.org/give" });
    const res = handleQRRequest(get("/api/qr"), db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });
});

describe("Settings", () => {
  test("update_settings validates, replaces milestones and ask tiers, bumps settings_seq, and rejects stale seq", async () => {
    const admin = await sessionCookie(db, backups);
    const seq = getEventState(db).settings_seq;
    const ok = await handleControlRequest(control({
      action: "update_settings", settings_seq: seq, goal_cents: 150000000, event_title: "Raise the Roof", font_family: "brandon", chart_orientation: "vertical",
      milestones: [{ cents: 50000000, label: "Halfway" }, { percent_of_goal: 100, label: "Goal" }], ask_tiers: [{ cents: 100000 }, { cents: 500000, label: "Table sponsor" }],
      stage_delay_ms: 5000, major_gift_threshold_cents: 200000
    }, admin), db, backups);
    expect(ok.status).toBe(200);
    const stage = getStageState(db);
    expect(stage.goal_cents).toBe(150000000);
    expect(stage.milestones.map(m => m.cents)).toEqual([50000000, 150000000]);
    expect(stage.font_family).toBe("brandon");
    const entry = await (await handleStateRequest(get("/api/state?role=entry", admin), db)).json();
    expect(entry.ask_tiers.map((t: { label: string }) => t.label)).toEqual(["$1,000", "Table sponsor"]);
    expect(entry.major_gift_threshold_cents).toBe(200000);
    expect(entry.stage_delay_ms).toBe(5000);

    expect((await handleControlRequest(control({ action: "update_settings", settings_seq: seq, goal_cents: 1 }, admin), db, backups)).status).toBe(409);
    for (const bad of [{ goal_cents: -5 }, { font_family: "comic" }, { chart_orientation: "diagonal" }, { qr_url: "javascript:alert(1)" }, { bar_color: "red" }, { impact_messages: ["x".repeat(161)] }]) {
      expect((await handleControlRequest(control({ action: "update_settings", ...bad }, admin), db, backups)).status).toBe(400);
    }
  });

  test("stage messages from an operator reach the chart without touching other settings", async () => {
    const operator = await sessionCookie(db, backups, "sara", "operator");
    const before = getEventState(db);
    expect((await handleControlRequest(control({ action: "stage_message", stage_message: "Thank you, table 9!", stage_message_visible: true, impact_messages: ["Legal aid", "Know your rights"] }, operator), db, backups)).status).toBe(200);
    const stage = getStageState(db);
    expect(stage.stage_message).toBe("Thank you, table 9!");
    expect(stage.stage_message_visible).toBe(true);
    expect(stage.impact_messages).toEqual(["Legal aid", "Know your rights"]);
    expect(getEventState(db).goal_cents).toBe(before.goal_cents);
  });
});

describe("Rehearsal purge, reset, and backups", () => {
  test("purge removes only rehearsal gifts, snapshots first, and resets the wall figure to the real total", async () => {
    const admin = await sessionCookie(db, backups);
    updateEventState(db, { stage_delay_ms: 0 });
    recordDonation(db, { donation_id: "real", donor_name: "Real", amount_cents: 100000 });
    recordDonation(db, { donation_id: "sample", donor_name: "Sample", amount_cents: 900000, source: "rehearsal", confirmed_major_gift: true });
    expect(getStageState(db).total_raised_cents).toBe(1000000);
    expect((await handleControlRequest(control({ action: "purge_rehearsal" }, admin), db, backups)).status).toBe(200);
    const stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(100000);
    expect(stage.stage_reset_seq).toBe(1);
    expect(foldLedger(db).active_donation_count).toBe(1);
    expect(backups.list().some(b => b.label === "pre-purge")).toBe(true);
  });

  test("reset needs the literal confirmation and clears import receipts so online gifts return on the next sync", async () => {
    const admin = await sessionCookie(db, backups);
    recordDonation(db, { donation_id: "x", donor_name: "X", amount_cents: 100 });
    db.query(`INSERT INTO fundraising_receipt (transaction_id, donation_id, remote_snapshot) VALUES ('t', 'x', '{}')`).run();
    expect((await handleControlRequest(control({ action: "reset_ledger", confirm_wipe: true }, admin), db, backups)).status).toBe(400);
    expect((await handleControlRequest(control({ action: "reset_ledger", confirm_wipe: "RESET" }, admin), db, backups)).status).toBe(200);
    expect(foldLedger(db).latest_seq).toBe(0);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM fundraising_receipt`).get()!.n).toBe(0);
    expect(backups.list().some(b => b.label === "pre-reset")).toBe(true);
  });

  test("a snapshot restores gifts, settings, and notes while leaving accounts and sessions alone", async () => {
    const admin = await sessionCookie(db, backups);
    recordDonation(db, { donation_id: "kept", donor_name: "Kept", amount_cents: 100000 });
    await handleControlRequest(control({ action: "add_team_note", body: "before" }, admin), db, backups);
    const snapshot = backups.snapshot("manual");
    recordDonation(db, { donation_id: "later", donor_name: "Later", amount_cents: 500000 });
    updateEventState(db, { goal_cents: 1 });
    await handleControlRequest(control({ action: "add_team_note", body: "after" }, admin), db, backups);
    const restored = await handleControlRequest(control({ action: "restore_backup", name: snapshot.name, confirm: "RESTORE" }, admin), db, backups);
    expect(restored.status).toBe(200);
    expect(foldLedger(db).active_donation_count).toBe(1);
    expect(getEventState(db).goal_cents).not.toBe(1);
    expect(getEventState(db).stage_reset_seq).toBe(1);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM team_note`).get()!.n).toBe(1);
    expect(handleStateRequest(get("/api/state?role=control", admin), db).status).toBe(200);
    expect(backups.list().some(b => b.label === "pre-restore")).toBe(true);
    expect((await handleControlRequest(control({ action: "restore_backup", name: "givebar-manual-nope.sqlite", confirm: "RESTORE" }, admin), db, backups)).status).toBe(500);
  });
});

describe("Schema upgrade", () => {
  test("a previous-release database upgrades in place: retired columns go, gifts and accounts stay, stage delay becomes 8 seconds", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, donation_id TEXT NOT NULL, supersedes_seq INTEGER, amount_cents INTEGER NOT NULL, donor_name TEXT NOT NULL, display_name TEXT, is_anonymous INTEGER DEFAULT 0, payment_method TEXT NOT NULL, source TEXT NOT NULL, source_txn_id TEXT, card_number TEXT, entered_by TEXT, notes TEXT, donor_phonetic TEXT, table_number TEXT, created_at INTEGER NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_ledger_seq ON ledger(seq);
      CREATE TABLE event_state (id INTEGER PRIMARY KEY CHECK (id = 1), event_name TEXT NOT NULL DEFAULT 'Old Gala', goal_cents INTEGER NOT NULL DEFAULT 1000, match_pool_cents INTEGER NOT NULL DEFAULT 0, match_total_cents INTEGER NOT NULL DEFAULT 0, match_ratio REAL NOT NULL DEFAULT 1, is_match_active INTEGER NOT NULL DEFAULT 0, control_pin TEXT NOT NULL DEFAULT '', entry_pin TEXT NOT NULL DEFAULT '', bloomerang_api_key TEXT DEFAULT 'secret', timer_status TEXT NOT NULL DEFAULT 'stopped', stage_delay_ms INTEGER NOT NULL DEFAULT 0, odometer_floor_cents INTEGER NOT NULL DEFAULT 0, stage_reset_seq INTEGER NOT NULL DEFAULT 0, settings_seq INTEGER NOT NULL DEFAULT 1, impact_messages TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
      INSERT INTO event_state (id, updated_at) VALUES (1, 0);
      INSERT INTO ledger (event_type, donation_id, amount_cents, donor_name, payment_method, source, created_at) VALUES ('create', 'old', 4200, 'Old Donor', 'pledge', 'manual', 0);
      CREATE TABLE operator_account (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, pin_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'presenter', 'display')), disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      INSERT INTO operator_account VALUES ('a1', 'admin', 'Admin', 'hash', 'admin', 0, 0), ('d1', 'screen', 'Screen', 'hash', 'display', 0, 0);
      CREATE TABLE connector_state (connector_id TEXT PRIMARY KEY);
      PRAGMA user_version = 13;
    `);
    migrateSchema(legacy);
    const columns = legacy.query<{ name: string }, []>(`PRAGMA table_info(event_state)`).all().map(c => c.name);
    expect(columns).not.toContain("control_pin");
    expect(columns).not.toContain("bloomerang_api_key");
    expect(columns).not.toContain("timer_status");
    expect(columns).toContain("stage_message");
    expect(legacy.query<{ name: string }, []>(`PRAGMA table_info(ledger)`).all().map(c => c.name)).not.toContain("is_pinned");
    expect(legacy.query<{ user_version: number }, []>(`PRAGMA user_version`).get()!.user_version).toBe(SCHEMA_VERSION);
    expect(getEventState(legacy).stage_delay_ms).toBe(8000);
    expect(foldLedger(legacy).total_raised_cents).toBe(4200);
    expect(legacy.query<{ username: string }, []>(`SELECT username FROM operator_account`).all().map(r => r.username)).toEqual(["admin"]);
    expect(legacy.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE name IN ('connector_state', 'team_note')`).all().map(r => r.name)).toEqual(["team_note"]);
  });

  test("an unsupported older schema refuses to start instead of silently migrating", () => {
    const ancient = new Database(":memory:");
    ancient.exec(`CREATE TABLE event_state (id INTEGER PRIMARY KEY); PRAGMA user_version = 9;`);
    expect(() => migrateSchema(ancient)).toThrow(/Unsupported/);
  });
});
