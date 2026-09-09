import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, migrateSchema } from "../server/src/db";
import { getEventState, updateEventState, recordDonation } from "../server/src/ledger";
import { handleControlRequest } from "../server/src/routes/control";
import { handleStateRequest } from "../server/src/routes/state";
import { handleExportCSV } from "../server/src/routes/export";
import { handleQRRequest } from "../server/src/routes/qr";

import { controlRequest as control, operatorCookie } from "./auth-helper";

/** Every object key reachable in a payload, so `has_control_pin` never masks a real leak. */
function collectKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}

describe("Named operator session authentication", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("operator pages and APIs require sign-in; public roles stay readable", async () => {
    const adminCookie = await operatorCookie(db, "founder", "1357911", "admin");
    recordDonation(db, { donation_id: "don_session_1", amount_cents: 425000, donor_name: "Session Donor" });
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db).status).toBe(401);
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=entry"), db).status).toBe(401);
    expect(handleExportCSV(new Request("http://localhost:3000/api/export/csv"), db).status).toBe(401);
    expect((await handleControlRequest(control({ action: "freeze" }), db)).status).toBe(401);
    const authedControl = new Request("http://localhost:3000/api/state?role=control", { headers: { Cookie: adminCookie } });
    const stateData = await handleStateRequest(authedControl, db).json();
    expect(stateData.folded.total_raised_cents).toBe(425000);
    expect(stateData.me.username).toBe("founder");
    expect((await handleControlRequest(control({ action: "freeze" }, adminCookie), db)).status).toBe(200);
    const csv = handleExportCSV(new Request("http://localhost:3000/api/export/csv", { headers: { Cookie: adminCookie } }), db);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("Session Donor");
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).status).toBe(200);
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=emcee"), db).status).toBe(200);
  });

  test("wrong names, wrong PINs, and repeated guessing are rejected without leaking hashes", async () => {
    await operatorCookie(db, "founder", "1357911", "admin");
    expect((await handleControlRequest(control({ action: "login", username: "unknown", pin: "1357911" }), db)).status).toBe(401);
    expect((await handleControlRequest(control({ action: "login", username: "founder", pin: "0000" }), db)).status).toBe(401);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await handleControlRequest(control({ action: "login", username: "founder", pin: "0000" }), db);
    }
    expect((await handleControlRequest(control({ action: "login", username: "founder", pin: "0000" }), db)).status).toBe(429);
    const stored = db.query<{ pin_hash: string }, []>(`SELECT pin_hash FROM operator_account WHERE username = 'founder'`).get();
    expect(stored?.pin_hash.includes("1357911")).toBe(false);
  });

  test("auth_check reports the signed-in operator without leaking PIN material", async () => {
    expect((await (await handleControlRequest(control({ action: "auth_check" }), db)).json()).authenticated).toBe(false);
    const adminCookie = await operatorCookie(db, "founder", "1357911", "admin");
    const authenticated = await (await handleControlRequest(control({ action: "auth_check" }, adminCookie), db)).json();
    expect(authenticated.authenticated).toBe(true);
    expect(authenticated.username).toBe("founder");
    expect(authenticated.role).toBe("admin");
    expect(JSON.stringify(authenticated).includes("1357911")).toBe(false);
  });

  test("disabling or signing out immediately revokes access", async () => {
    const adminCookie = await operatorCookie(db, "founder", "1357911", "admin");
    const created = await (await handleControlRequest(control({ action: "create_account", username: "volunteer", displayName: "Hall Volunteer", pin: "2468", role: "operator" }, adminCookie), db)).json();
    const volunteerLogin = await handleControlRequest(control({ action: "login", username: "volunteer", pin: "2468" }), db);
    const volunteerCookie = volunteerLogin.headers.get("set-cookie")?.split(";")[0] || "";
    const authedEntry = new Request("http://localhost:3000/api/state?role=entry", { headers: { Cookie: volunteerCookie } });
    expect(handleStateRequest(authedEntry, db).status).toBe(200);
    expect((await handleControlRequest(control({ action: "update_account", id: created.id, disabled: true }, adminCookie), db)).status).toBe(200);
    expect(handleStateRequest(authedEntry, db).status).toBe(401);
    expect((await handleControlRequest(control({ action: "login", username: "volunteer", pin: "2468" }), db)).status).toBe(401);
    expect((await handleControlRequest(control({ action: "logout" }, adminCookie), db)).status).toBe(200);
    const authedControl = new Request("http://localhost:3000/api/state?role=control", { headers: { Cookie: adminCookie } });
    expect(handleStateRequest(authedControl, db).status).toBe(401);
  });

  test("single-use invite links sign in once and PIN changes rotate sessions", async () => {
    const adminCookie = await operatorCookie(db, "founder", "1357911", "admin");
    const created = await (await handleControlRequest(control({ action: "create_account", username: "invited", displayName: "Invited Operator", pin: "2468", role: "operator" }, adminCookie), db)).json();
    process.env.BREVO_API_KEY = "test-brevo-key";
    const fetchSpy = globalThis.fetch;
    let emailed = "";
    globalThis.fetch = (async (_url: string | URL | Request, options: { body?: unknown } = {}) => {
      emailed = JSON.parse(String(options.body || "{}")).to?.[0]?.email || "";
      return new Response(JSON.stringify({ messageId: "test" }), { status: 201 });
    }) as typeof fetch;
    const invite = await (await handleControlRequest(control({ action: "send_invite", id: created.id, email: "operator@example.org" }, adminCookie), db)).json();
    globalThis.fetch = fetchSpy;
    delete process.env.BREVO_API_KEY;
    expect(emailed).toBe("operator@example.org");
    const token = new URL(invite.link).searchParams.get("invite") || "";
    const redeemed = await handleControlRequest(control({ action: "redeem_invite", token }), db);
    expect(redeemed.status).toBe(200);
    expect((await handleControlRequest(control({ action: "redeem_invite", token }), db)).status).toBe(400);
    const sessionCookie = redeemed.headers.get("set-cookie")?.split(";")[0] || "";
    expect((await handleControlRequest(control({ action: "change_pin", current_pin: "2468", pin: "9753" }, sessionCookie), db)).status).toBe(200);
    expect((await handleControlRequest(control({ action: "login", username: "invited", pin: "9753" }), db)).status).toBe(200);
  });

  test("migrated databases clear retired shared PINs and require named operators", () => {
    const legacy = new Database(":memory:", { create: true });
    legacy.exec(`
      CREATE TABLE event_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        event_name TEXT NOT NULL DEFAULT 'Legacy Gala',
        goal_cents INTEGER NOT NULL DEFAULT 50000000,
        match_pool_cents INTEGER NOT NULL DEFAULT 0,
        match_total_cents INTEGER NOT NULL DEFAULT 0,
        match_ratio REAL NOT NULL DEFAULT 1.0,
        is_match_active INTEGER NOT NULL DEFAULT 0,
        match_sponsor_title TEXT DEFAULT '',
        is_frozen INTEGER NOT NULL DEFAULT 0,
        manual_override_cents INTEGER DEFAULT NULL,
        qr_donate_url TEXT DEFAULT 'https://legacy.example.org/give?utm_source=projector',
        entry_pin TEXT NOT NULL DEFAULT '1234',
        control_pin TEXT NOT NULL DEFAULT '9999',
        odometer_floor_cents INTEGER NOT NULL DEFAULT 0,
        confetti_trigger INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.exec(`INSERT INTO event_state (id, updated_at) VALUES (1, 1700000000000);`);
    legacy.exec(`PRAGMA user_version = 5;`);
    migrateSchema(legacy);
    const migrated = getEventState(legacy);
    expect(migrated.control_pin).toBe("");
    expect(migrated.entry_pin).toBe("");
    expect(migrated.qr_url).toBe("https://legacy.example.org/give?utm_source=projector");
    expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version;").get()?.user_version).toBe(13);
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), legacy).status).toBe(401);
    legacy.close();
  });
});

describe("Presentation settings model", () => {
  let db: Database;
  let cookie: string;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    cookie = await operatorCookie(db, "founder", "1357911", "admin");
  });

  test("all new presentation fields round-trip through update_settings onto every payload", async () => {
    const res = await handleControlRequest(control({
      action: "update_settings",
      event_title: "Hope Rising 2026",
      text_color: "#F5E9C8",
      bar_color: "oklch(0.82 0.16 85)",
      font_family: "grotesk",
      chart_orientation: "vertical",
      qr_url: "https://give.example.org/gala?utm_source=projector&utm_medium=qr",
      display_url: "give.example.org/gala",
      logo_url: "/assets/logo.svg",
      goal_cents: 123456700
    }, cookie), db);
    expect(res.status).toBe(200);

    const stored = getEventState(db);
    expect(stored.event_title).toBe("Hope Rising 2026");
    expect(stored.text_color).toBe("#F5E9C8");
    expect(stored.bar_color).toBe("oklch(0.82 0.16 85)");
    expect(stored.font_family).toBe("grotesk");
    expect(stored.chart_orientation).toBe("vertical");
    expect(stored.qr_url).toBe("https://give.example.org/gala?utm_source=projector&utm_medium=qr");
    expect(stored.display_url).toBe("give.example.org/gala");
    expect(stored.goal_cents).toBe(123456700);

    const stageData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(stageData.event_title).toBe("Hope Rising 2026");
    expect(stageData.text_color).toBe("#F5E9C8");
    expect(stageData.font_family).toBe("grotesk");
    expect(stageData.chart_orientation).toBe("vertical");
    expect(stageData.qr_url).toBe("https://give.example.org/gala?utm_source=projector&utm_medium=qr");
    expect(stageData.display_url).toBe("give.example.org/gala");
    expect(stageData.display_url_effective).toBe("give.example.org/gala");

    const ctrlData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=control", { headers: { Cookie: cookie } }), db).json();
    expect(ctrlData.event_state.event_title).toBe("Hope Rising 2026");
    expect(ctrlData.event_state.chart_orientation).toBe("vertical");
    expect(ctrlData.event_state.qr_url).toBe("https://give.example.org/gala?utm_source=projector&utm_medium=qr");
    expect(ctrlData.display_url_effective).toBe("give.example.org/gala");

    const defaultData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=default"), db).json();
    expect(defaultData.event.event_title).toBe("Hope Rising 2026");
    expect(defaultData.event.display_url_effective).toBe("give.example.org/gala");
  });

  test("display_url is independent of qr_url and falls back to the query-stripped QR target", async () => {
    const res = await handleControlRequest(control({
      action: "update_settings",
      qr_url: "https://give.example.org/gala/appeal?utm_source=table_card#pledge",
      display_url: ""
    }, cookie), db);
    expect(res.status).toBe(200);

    const stageData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(stageData.qr_url).toBe("https://give.example.org/gala/appeal?utm_source=table_card#pledge");
    expect(stageData.display_url).toBe("");
    expect(stageData.display_url_effective).toBe("https://give.example.org/gala/appeal");

    // An explicit display_url wins and never alters the encoded target
    await handleControlRequest(control({ action: "update_settings", display_url: "example.org/give" }, cookie), db);
    const updated = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(updated.display_url_effective).toBe("example.org/give");
    expect(updated.qr_url).toBe("https://give.example.org/gala/appeal?utm_source=table_card#pledge");
  });

  test("a stale client binding to a removed key fails loudly instead of saving nothing", async () => {
    const qrRes = await handleControlRequest(control({
      action: "update_settings",
      qr_donate_url: "https://give.example.org/legacy"
    }, cookie), db);
    expect(qrRes.status).toBe(400);
    const qrBody = await qrRes.json();
    expect(qrBody.error).toBe("INVALID_SETTING");
    expect(qrBody.message).toContain("qr_url");

    const milestoneRes = await handleControlRequest(control({
      action: "update_settings",
      milestones_json: JSON.stringify([{ cents: 100, label: "Legacy" }])
    }, cookie), db);
    expect(milestoneRes.status).toBe(400);
    expect((await milestoneRes.json()).error).toBe("INVALID_SETTING");
  });

  test("QR generation encodes the stored qr_url when no url parameter is supplied", async () => {
    const emptyRes = handleQRRequest(new Request("http://localhost:3000/api/qr"), db);
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()).error).toBe("QR_URL_MISSING");

    await handleControlRequest(control({ action: "update_settings", qr_url: "https://give.example.org/gala?utm_source=qr" }, cookie), db);

    const res = handleQRRequest(new Request("http://localhost:3000/api/qr"), db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await res.text()).toContain("<path");
  });

  test("rejects fonts, orientations, colors, URLs, and goals outside the contract", async () => {
    const cases: Array<{ patch: Record<string, unknown>; error: string }> = [
      { patch: { font_family: "Comic Sans MS" }, error: "INVALID_SETTING" },
      { patch: { font_family: "https://fonts.googleapis.com/css2?family=Inter" }, error: "INVALID_SETTING" },
      { patch: { chart_orientation: "diagonal" }, error: "INVALID_SETTING" },
      { patch: { text_color: "red" }, error: "INVALID_SETTING" },
      { patch: { bar_color: "rgb(255,0,0)" }, error: "INVALID_SETTING" },
      { patch: { qr_url: "javascript:alert(1)" }, error: "INVALID_SETTING" },
      { patch: { goal_cents: 0 }, error: "INVALID_SETTING" },
      { patch: { goal_cents: -5000 }, error: "INVALID_SETTING" },
      { patch: { goal_cents: 1000.5 }, error: "INVALID_SETTING" }
    ];

    for (const { patch, error } of cases) {
      const res = await handleControlRequest(control({ action: "update_settings", ...patch }, cookie), db);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }

    // Nothing from a rejected request is persisted
    const state = getEventState(db);
    expect(state.font_family).toBe("system");
    expect(state.chart_orientation).toBe("horizontal");
    expect(state.text_color).toBe("");
    expect(state.goal_cents).toBe(50000000);

    for (const font of ["system", "humanist", "grotesk", "mono", "serif"]) {
      const res = await handleControlRequest(control({ action: "update_settings", font_family: font }, cookie), db);
      expect(res.status).toBe(200);
      expect(getEventState(db).font_family).toBe(font);
    }
  });

  test("goal_cents edits immediately move projections and percent-based milestone math", async () => {
    recordDonation(db, {
      donation_id: "don_goal_1",
      amount_cents: 25000000,
      donor_name: "Goal Mover",
      confirmed_major_gift: true
    });

    const before = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(before.goal_cents).toBe(50000000);
    expect(before.percent).toBe(50);
    const beforeFirst = before.milestones.find((m: { label: string }) => m.label === "Foundation");
    expect(beforeFirst.cents).toBe(12500000);

    const res = await handleControlRequest(control({ action: "update_settings", goal_cents: 100000000 }, cookie), db);
    expect(res.status).toBe(200);

    const after = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(after.goal_cents).toBe(100000000);
    expect(after.percent).toBe(25);
    const afterFirst = after.milestones.find((m: { label: string }) => m.label === "Foundation");
    expect(afterFirst.cents).toBe(25000000);

    // Percent milestones re-resolve: $250k is now reached, so the next target is the 50% row
    const emcee = await handleStateRequest(new Request("http://localhost:3000/api/state?role=emcee"), db).json();
    expect(emcee.goal_cents).toBe(100000000);
    expect(emcee.next_milestone.target_cents).toBe(50000000);
    expect(emcee.next_milestone.label).toBe("Staffing");
  });
});

describe("Milestone editing", () => {
  let db: Database;
  let cookie: string;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    cookie = await operatorCookie(db, "founder", "1357911", "admin");
  });

  test("a fresh database seeds milestones and exposes them to the chart", async () => {
    const rows = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM milestone").get();
    expect(rows?.count).toBe(4);

    const stageData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(stageData.milestones.length).toBe(4);
    expect(stageData.milestones[0].label).toBe("Foundation");
    expect(stageData.milestones[3].cents).toBe(50000000);
  });

  test("update_settings full-replaces the milestone set: add, relabel, retarget, delete", async () => {
    const replaceRes = await handleControlRequest(control({
      action: "update_settings",
      milestones: [
        { cents: 5000000, label: "Community Center" },
        { cents: 15000000, label: "Endowment", celebrate: false },
        { percent_of_goal: 80, label: "Stretch Goal" }
      ]
    }, cookie), db);
    expect(replaceRes.status).toBe(200);

    const stageData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(stageData.milestones.length).toBe(3);
    expect(stageData.milestones[0].label).toBe("Community Center");
    expect(stageData.milestones[0].cents).toBe(5000000);
    expect(stageData.milestones[1].celebrate).toBe(false);
    // Percent rows resolve against the live goal
    expect(stageData.milestones[2].cents).toBe(40000000);

    // Relabel and retarget one row, delete another
    const editRes = await handleControlRequest(control({
      action: "update_settings",
      milestones: [
        { cents: 7500000, label: "Community Center Renovation" },
        { cents: 15000000, label: "Endowment" }
      ]
    }, cookie), db);
    expect(editRes.status).toBe(200);

    const edited = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(edited.milestones.length).toBe(2);
    expect(edited.milestones[0].label).toBe("Community Center Renovation");
    expect(edited.milestones[0].cents).toBe(7500000);

    // Deleting every milestone leaves an empty set rather than resurrecting defaults
    const clearRes = await handleControlRequest(control({ action: "update_settings", milestones: [] }, cookie), db);
    expect(clearRes.status).toBe(200);
    const cleared = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(cleared.milestones.length).toBe(0);
  });
});

describe("Secret containment across every role", () => {
  let db: Database;
  let cookie: string;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    cookie = await operatorCookie(db, "founder", "1357911", "admin");
  });

  test("no role payload ever carries PIN hashes, sessions, or bloomerang_api_key", async () => {
    updateEventState(db, { bloomerang_api_key: "blm_live_supersecret" });
    recordDonation(db, { donation_id: "don_secret_1", amount_cents: 100000, donor_name: "Secret Check Donor" });
    const forbiddenKeys = ["pin_hash", "token_hash", "bloomerang_api_key", "control_pin", "entry_pin"];
    const forbiddenValues = ["blm_live_supersecret"];
    for (const role of ["stage", "emcee"]) {
      const res = handleStateRequest(new Request(`http://localhost:3000/api/state?role=${role}`), db);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of forbiddenValues) expect(text.includes(secret)).toBe(false);
      for (const key of collectKeys(JSON.parse(text))) expect(forbiddenKeys.includes(key)).toBe(false);
    }
    for (const role of ["entry", "control"]) {
      expect(handleStateRequest(new Request(`http://localhost:3000/api/state?role=${role}`), db).status).toBe(401);
      const res = handleStateRequest(new Request(`http://localhost:3000/api/state?role=${role}`, { headers: { Cookie: cookie } }), db);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of forbiddenValues) expect(text.includes(secret)).toBe(false);
      for (const key of collectKeys(JSON.parse(text))) expect(forbiddenKeys.includes(key)).toBe(false);
    }
    const ctrlActionRes = await handleControlRequest(control({ action: "freeze" }, cookie), db);
    expect(ctrlActionRes.status).toBe(200);
    const ctrlActionText = await ctrlActionRes.text();
    for (const secret of forbiddenValues) expect(ctrlActionText.includes(secret)).toBe(false);
    for (const key of collectKeys(JSON.parse(ctrlActionText))) expect(forbiddenKeys.includes(key)).toBe(false);
    const csvText = await handleExportCSV(new Request("http://localhost:3000/api/export/csv", { headers: { Cookie: cookie } }), db).text();
    for (const secret of forbiddenValues) expect(csvText.includes(secret)).toBe(false);
  });
});
