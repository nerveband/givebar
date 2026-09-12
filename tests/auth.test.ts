import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../server/src/db";
import { handleControlRequest } from "../server/src/routes/control";
import { handleStateRequest } from "../server/src/routes/state";
import { handleDonationRequest } from "../server/src/routes/donation";
import { handleRehearsalRequest } from "../server/src/routes/rehearsal";
import { handleExportBackup, handleExportCSV } from "../server/src/routes/export";
import { getPresenceView, handlePresenceRequest, PRESENCE_TTL_MS, recordHeartbeat, resetPresence } from "../server/src/presence";
import { LOCKOUT_MS } from "../server/src/authz";
import type { BackupManager } from "../server/src/backup";
import { backupsFor, control, get, json, sessionCookie } from "./auth-helper";

let db: Database;
let backups: BackupManager;
beforeEach(() => { db = initDatabase(":memory:"); backups = backupsFor(db); resetPresence(); });
afterEach(() => db.close());

describe("Sessions", () => {
  test("viewing is public; editing, private form configuration, and exports need a session", async () => {
    expect(handleStateRequest(get("/api/state?role=stage"), db).status).toBe(200);
    expect(handleStateRequest(get("/api/state?role=emcee"), db).status).toBe(200);
    expect((await handleStateRequest(get("/api/state?role=control"), db).json()).can_edit).toBe(false);
    expect(handleStateRequest(get("/api/state?role=entry"), db).status).toBe(401);
    expect(handleStateRequest(get("/api/state?role=bogus"), db).status).toBe(400);
    expect((await handleDonationRequest(json("/api/donation/x", { donor_name: "A", amount_cents: 100 }, undefined, "PUT"), db, ["api", "donation", "x"])).status).toBe(401);
    expect(handleExportCSV(get("/api/export/csv"), db).status).toBe(401);
    const cookie = await sessionCookie(db, backups);
    expect(handleStateRequest(get("/api/state?role=control", cookie), db).status).toBe(200);
    expect(handleExportCSV(get("/api/export/csv", cookie), db).status).toBe(200);
  });

  test("wrong PINs lock the name for a while and never leak hash material", async () => {
    await sessionCookie(db, backups);
    for (let i = 0; i < 5; i++) {
      const res = await handleControlRequest(control({ action: "login", username: "founder", pin: "0000" }), db, backups);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("$argon");
    }
    expect((await handleControlRequest(control({ action: "login", username: "founder", pin: "1357911" }), db, backups)).status).toBe(429);
    db.query(`UPDATE login_attempt SET expires_at = ?`).run(Date.now() - LOCKOUT_MS);
    expect((await handleControlRequest(control({ action: "login", username: "founder", pin: "1357911" }), db, backups)).status).toBe(200);
  });

  test("bootstrap works once; afterwards only administrators create accounts, and disabling revokes immediately", async () => {
    const admin = await sessionCookie(db, backups);
    expect((await handleControlRequest(control({ action: "bootstrap_admin", username: "x", displayName: "X", pin: "1234" }), db, backups)).status).toBe(403);
    const operator = await sessionCookie(db, backups, "sara", "operator");
    expect((await handleControlRequest(control({ action: "create_account", username: "z", displayName: "Z", pin: "1234" }, operator), db, backups)).status).toBe(403);
    const accounts = await (await handleControlRequest(control({ action: "list_accounts" }, admin), db, backups)).json();
    const sara = accounts.accounts.find((a: { username: string }) => a.username === "sara");
    expect((await handleControlRequest(control({ action: "update_account", id: sara.id, disabled: true }, admin), db, backups)).status).toBe(200);
    expect(handleStateRequest(get("/api/state?role=entry", operator), db).status).toBe(401);
    expect((await handleControlRequest(control({ action: "login", username: "sara", pin: "2468" }), db, backups)).status).toBe(401);
  });

  test("an administrator cannot disable or demote their own account", async () => {
    const admin = await sessionCookie(db, backups);
    const me = await (await handleControlRequest(control({ action: "auth_check" }, admin), db, backups)).json();
    const accounts = await (await handleControlRequest(control({ action: "list_accounts" }, admin), db, backups)).json();
    const self = accounts.accounts.find((a: { username: string }) => a.username === me.username);
    expect((await handleControlRequest(control({ action: "update_account", id: self.id, disabled: true }, admin), db, backups)).status).toBe(400);
    expect((await handleControlRequest(control({ action: "update_account", id: self.id, role: "operator" }, admin), db, backups)).status).toBe(400);
  });

  test("a one-time sign-in link is administrator-issued, signs in as that account exactly once, and dies with the account", async () => {
    const admin = await sessionCookie(db, backups);
    const operator = await sessionCookie(db, backups, "sara", "operator");
    const accounts = await (await handleControlRequest(control({ action: "list_accounts" }, admin), db, backups)).json();
    const sara = accounts.accounts.find((a: { username: string }) => a.username === "sara");
    expect((await handleControlRequest(control({ action: "create_invite_link", id: sara.id }, operator), db, backups)).status).toBe(403);
    const issued = await (await handleControlRequest(control({ action: "create_invite_link", id: sara.id }, admin), db, backups)).json();
    expect(issued.link).toMatch(/^http:\/\/localhost:3000\/signin\?invite=/);
    const token = new URL(issued.link).searchParams.get("invite")!;
    const redeemed = await handleControlRequest(control({ action: "redeem_invite", token }), db, backups);
    expect(redeemed.status).toBe(200);
    const cookie = redeemed.headers.get("set-cookie")!.split(";")[0];
    const me = await (await handleControlRequest(control({ action: "auth_check" }, cookie), db, backups)).json();
    expect(me.username).toBe("sara");
    expect(me.role).toBe("operator");
    expect((await handleControlRequest(control({ action: "redeem_invite", token }), db, backups)).status).toBe(400);
    // The invitee was never told a PIN: right after arriving they may set one without it, once.
    const setPin = await handleControlRequest(control({ action: "change_pin", current_pin: "", pin: "7777" }, cookie), db, backups);
    expect(setPin.status).toBe(200);
    const fresh = setPin.headers.get("set-cookie")!.split(";")[0];
    expect((await handleControlRequest(control({ action: "change_pin", current_pin: "", pin: "8888" }, fresh), db, backups)).status).toBe(401);
    expect((await handleControlRequest(control({ action: "login", username: "sara", pin: "7777" }), db, backups)).status).toBe(200);
    const second = await (await handleControlRequest(control({ action: "create_invite_link", id: sara.id }, admin), db, backups)).json();
    await handleControlRequest(control({ action: "update_account", id: sara.id, disabled: true }, admin), db, backups);
    expect((await handleControlRequest(control({ action: "redeem_invite", token: new URL(second.link).searchParams.get("invite") }), db, backups)).status).toBe(400);
    expect((await handleControlRequest(control({ action: "create_invite_link", id: sara.id }, admin), db, backups)).status).toBe(400);
  });

  test("a PIN change and a PIN reset both rotate sessions", async () => {
    const admin = await sessionCookie(db, backups);
    const operator = await sessionCookie(db, backups, "sara", "operator");
    const changed = await handleControlRequest(control({ action: "change_pin", current_pin: "2468", pin: "9999" }, operator), db, backups);
    expect(changed.status).toBe(200);
    expect(handleStateRequest(get("/api/state?role=entry", operator), db).status).toBe(401);
    const fresh = changed.headers.get("set-cookie")!.split(";")[0];
    expect(handleStateRequest(get("/api/state?role=control", fresh), db).status).toBe(200);
    const accounts = await (await handleControlRequest(control({ action: "list_accounts" }, admin), db, backups)).json();
    const sara = accounts.accounts.find((a: { username: string }) => a.username === "sara");
    await handleControlRequest(control({ action: "update_account", id: sara.id, pin: "5555" }, admin), db, backups);
    expect(handleStateRequest(get("/api/state?role=entry", fresh), db).status).toBe(401);
    expect((await handleControlRequest(control({ action: "login", username: "sara", pin: "5555" }), db, backups)).status).toBe(200);
  });
});

describe("Role gates", () => {
  test("operators record gifts, send stage messages, pause the chart, and post notes; only administrators change settings, purge, reset, rehearse, or back up", async () => {
    const operator = await sessionCookie(db, backups, "sara", "operator");
    const admin = await sessionCookie(db, backups);
    const status = async (body: Record<string, unknown>, cookie: string) => (await handleControlRequest(control(body, cookie), db, backups)).status;
    expect(await status({ action: "stage_message", stage_message: "Hi", stage_message_visible: true }, operator)).toBe(200);
    expect(await status({ action: "pause_chart" }, operator)).toBe(200);
    expect(await status({ action: "resume_chart" }, operator)).toBe(200);
    expect(await status({ action: "add_team_note", body: "hello" }, operator)).toBe(200);
    expect(await status({ action: "briefing" }, operator)).toBe(200);
    expect(await status({ action: "update_settings", goal_cents: 100 }, operator)).toBe(403);
    expect(await status({ action: "purge_rehearsal" }, operator)).toBe(403);
    expect(await status({ action: "reset_ledger", confirm_wipe: "RESET" }, operator)).toBe(403);
    expect(await status({ action: "list_backups" }, operator)).toBe(403);
    expect((await handleRehearsalRequest(json("/api/rehearsal", { mode: "single" }, operator), db)).status).toBe(403);
    expect(handleExportBackup(get("/api/export/backup", operator), db, backups).status).toBe(403);
    expect(await status({ action: "update_settings", goal_cents: 100 }, admin)).toBe(200);
    expect((await handleRehearsalRequest(json("/api/rehearsal", { mode: "single" }, admin), db)).status).toBe(200);
    expect(handleExportBackup(get("/api/export/backup", admin), db, backups).status).toBe(200);
  });

  test("a team note can be removed by its author or an administrator, not by another operator", async () => {
    const admin = await sessionCookie(db, backups);
    const sara = await sessionCookie(db, backups, "sara", "operator");
    const omar = await sessionCookie(db, backups, "omar", "operator");
    await handleControlRequest(control({ action: "add_team_note", body: "from sara" }, sara), db, backups);
    const state = await (await handleStateRequest(get("/api/state?role=control", omar), db)).json();
    expect(state.team_notes[0].author_name).toBe("Sara");
    expect((await handleControlRequest(control({ action: "delete_team_note", id: state.team_notes[0].id }, omar), db, backups)).status).toBe(403);
    expect((await handleControlRequest(control({ action: "delete_team_note", id: state.team_notes[0].id }, admin), db, backups)).status).toBe(200);
  });
});

describe("Presence", () => {
  test("heartbeats need a session, carry the account's own name, and expire without a write", async () => {
    expect((await handlePresenceRequest(json("/api/presence", { client_id: "abcd1234", surface: "home" }), db)).status).toBe(401);
    const sara = await sessionCookie(db, backups, "sara", "operator");
    const beat = await handlePresenceRequest(json("/api/presence", { client_id: "abcd1234", surface: "donations", name: "Spoofed Name" }, sara), db);
    expect(beat.status).toBe(200);
    const roster = await (await handlePresenceRequest(get("/api/presence", sara), db)).json();
    expect(roster.entries).toHaveLength(1);
    expect(roster.entries[0].name).toBe("Sara");
    expect(roster.entries[0].surface).toBe("donations");
    expect(JSON.stringify(roster)).not.toContain("Spoofed");
    expect((await handlePresenceRequest(json("/api/presence", { client_id: "abcd1234", surface: "chart" }, sara), db)).status).toBe(400);

    const session = { accountId: "acct", username: "late", displayName: "Late Laptop", role: "operator" as const };
    const t0 = Date.now();
    expect(recordHeartbeat({ client_id: "laptop-01", surface: "settings" }, session, "Mozilla/5.0 (iPad; CPU OS 17_0)", t0).ok).toBe(true);
    expect(getPresenceView(t0 + 1000).entries.find(e => e.client_id === "laptop-01")!.device).toBe("tablet");
    expect(getPresenceView(t0 + PRESENCE_TTL_MS + 1).entries.some(e => e.client_id === "laptop-01")).toBe(false);
  });
});
