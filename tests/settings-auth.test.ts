import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, migrateSchema } from "../server/src/db";
import { getEventState, updateEventState, recordDonation } from "../server/src/ledger";
import { handleControlRequest } from "../server/src/routes/control";
import { handleStateRequest } from "../server/src/routes/state";
import { handleExportCSV } from "../server/src/routes/export";
import { handleQRRequest } from "../server/src/routes/qr";

function control(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

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

describe("Default-open authentication", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("a fresh database ships with no PIN of any kind", () => {
    const state = getEventState(db);
    expect(state.control_pin).toBe("");
    expect(state.entry_pin).toBe("");
  });

  test("every control-role surface returns real data with no credentials when no PIN is set", async () => {
    recordDonation(db, {
      donation_id: "don_open_1",
      amount_cents: 425000,
      donor_name: "Open Access Donor"
    });

    const stateRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db);
    expect(stateRes.status).toBe(200);
    const stateData = await stateRes.json();
    expect(stateData.folded.total_raised_cents).toBe(425000);
    expect(stateData.staged_chyrons.length).toBe(1);
    expect(stateData.has_control_pin).toBe(false);

    const freezeRes = await handleControlRequest(control({ action: "freeze" }), db);
    expect(freezeRes.status).toBe(200);
    expect(getEventState(db).is_frozen).toBe(1);

    const csvRes = handleExportCSV(new Request("http://localhost:3000/api/export/csv"), db);
    expect(csvRes.status).toBe(200);
    expect(await csvRes.text()).toContain("Open Access Donor");
  });

  test("setting a PIN closes the surfaces, clearing it reopens them", async () => {
    const setRes = await handleControlRequest(control({ action: "update_pins", control_pin: "8271" }), db);
    expect(setRes.status).toBe(200);
    expect(getEventState(db).control_pin).toBe("8271");

    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db).status).toBe(401);
    expect(handleExportCSV(new Request("http://localhost:3000/api/export/csv"), db).status).toBe(401);
    expect((await handleControlRequest(control({ action: "freeze" }), db)).status).toBe(401);

    // Correct PIN still works
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control&pin=8271"), db).status).toBe(200);
    expect((await handleControlRequest(control({ action: "freeze", pin: "8271" }), db)).status).toBe(200);

    // Clearing requires the current PIN, then reopens everything
    const clearRes = await handleControlRequest(control({ action: "update_pins", pin: "8271", control_pin: "" }), db);
    expect(clearRes.status).toBe(200);
    expect(getEventState(db).control_pin).toBe("");

    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db).status).toBe(200);
    expect(handleExportCSV(new Request("http://localhost:3000/api/export/csv"), db).status).toBe(200);
    expect((await handleControlRequest(control({ action: "unfreeze" }), db)).status).toBe(200);
  });

  test("update_settings persists a PIN change and rejects malformed PINs", async () => {
    const okRes = await handleControlRequest(control({ action: "update_settings", control_pin: "424242" }), db);
    expect(okRes.status).toBe(200);
    expect(getEventState(db).control_pin).toBe("424242");

    const shortRes = await handleControlRequest(control({ action: "update_settings", pin: "424242", control_pin: "12" }), db);
    expect(shortRes.status).toBe(400);
    expect((await shortRes.json()).error).toBe("INVALID_PIN");
    expect(getEventState(db).control_pin).toBe("424242");

    const changeRes = await handleControlRequest(control({ action: "update_settings", pin: "424242", control_pin: "777777" }), db);
    expect(changeRes.status).toBe(200);
    expect(getEventState(db).control_pin).toBe("777777");
  });

  test("auth_check reports whether a PIN is required without leaking it", async () => {
    const openRes = await handleControlRequest(control({ action: "auth_check" }), db);
    const openData = await openRes.json();
    expect(openData.authenticated).toBe(true);
    expect(openData.pin_required).toBe(false);

    updateEventState(db, { control_pin: "3131" });

    const closedRes = await handleControlRequest(control({ action: "auth_check" }), db);
    const closedData = await closedRes.json();
    expect(closedData.authenticated).toBe(false);
    expect(closedData.pin_required).toBe(true);
    expect(JSON.stringify(closedData).includes("3131")).toBe(false);
  });

  test("migrates a legacy database that carried the seeded 9999 / 1234 PINs", () => {
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
    expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version;").get()?.user_version).toBe(6);

    // Migrated database is fully open
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), legacy).status).toBe(200);
    legacy.close();
  });

  test("an operator-set PIN survives a re-open of the same database", () => {
    updateEventState(db, { control_pin: "5150" });
    // Re-running migrations (server restart) must not resurrect the legacy default
    migrateSchema(db);
    expect(getEventState(db).control_pin).toBe("5150");
  });
});

describe("Presentation settings model", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
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
    }), db);
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

    const ctrlData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db).json();
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
    }), db);
    expect(res.status).toBe(200);

    const stageData = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(stageData.qr_url).toBe("https://give.example.org/gala/appeal?utm_source=table_card#pledge");
    expect(stageData.display_url).toBe("");
    expect(stageData.display_url_effective).toBe("https://give.example.org/gala/appeal");

    // An explicit display_url wins and never alters the encoded target
    await handleControlRequest(control({ action: "update_settings", display_url: "example.org/give" }), db);
    const updated = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(updated.display_url_effective).toBe("example.org/give");
    expect(updated.qr_url).toBe("https://give.example.org/gala/appeal?utm_source=table_card#pledge");
  });

  test("a stale client binding to a removed key fails loudly instead of saving nothing", async () => {
    const qrRes = await handleControlRequest(control({
      action: "update_settings",
      qr_donate_url: "https://give.example.org/legacy"
    }), db);
    expect(qrRes.status).toBe(400);
    const qrBody = await qrRes.json();
    expect(qrBody.error).toBe("INVALID_SETTING");
    expect(qrBody.message).toContain("qr_url");

    const milestoneRes = await handleControlRequest(control({
      action: "update_settings",
      milestones_json: JSON.stringify([{ cents: 100, label: "Legacy" }])
    }), db);
    expect(milestoneRes.status).toBe(400);
    expect((await milestoneRes.json()).error).toBe("INVALID_SETTING");
  });

  test("QR generation encodes the stored qr_url when no url parameter is supplied", async () => {
    const emptyRes = handleQRRequest(new Request("http://localhost:3000/api/qr"), db);
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()).error).toBe("QR_URL_MISSING");

    await handleControlRequest(control({ action: "update_settings", qr_url: "https://give.example.org/gala?utm_source=qr" }), db);

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
      const res = await handleControlRequest(control({ action: "update_settings", ...patch }), db);
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
      const res = await handleControlRequest(control({ action: "update_settings", font_family: font }), db);
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

    const res = await handleControlRequest(control({ action: "update_settings", goal_cents: 100000000 }), db);
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

  beforeEach(() => {
    db = initDatabase(":memory:");
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
    }), db);
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
    }), db);
    expect(editRes.status).toBe(200);

    const edited = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(edited.milestones.length).toBe(2);
    expect(edited.milestones[0].label).toBe("Community Center Renovation");
    expect(edited.milestones[0].cents).toBe(7500000);

    // Deleting every milestone leaves an empty set rather than resurrecting defaults
    const clearRes = await handleControlRequest(control({ action: "update_settings", milestones: [] }), db);
    expect(clearRes.status).toBe(200);
    const cleared = await handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db).json();
    expect(cleared.milestones.length).toBe(0);
  });
});

describe("Secret containment across every role", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("no role payload ever carries control_pin, entry_pin, or bloomerang_api_key", async () => {
    updateEventState(db, {
      control_pin: "6162",
      entry_pin: "7273",
      bloomerang_api_key: "blm_live_supersecret"
    });
    recordDonation(db, {
      donation_id: "don_secret_1",
      amount_cents: 100000,
      donor_name: "Secret Check Donor"
    });

    const forbiddenKeys = ["control_pin", "entry_pin", "bloomerang_api_key"];
    const forbiddenValues = ["6162", "7273", "blm_live_supersecret"];

    const roles = ["stage", "emcee", "entry", "control", "default"];
    for (const role of roles) {
      const res = handleStateRequest(new Request(`http://localhost:3000/api/state?role=${role}&pin=6162`), db);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of forbiddenValues) {
        expect(text.includes(secret)).toBe(false);
      }
      for (const key of collectKeys(JSON.parse(text))) {
        expect(forbiddenKeys.includes(key)).toBe(false);
      }
    }

    const ctrlActionRes = await handleControlRequest(control({ action: "freeze", pin: "6162" }), db);
    expect(ctrlActionRes.status).toBe(200);
    const ctrlActionText = await ctrlActionRes.text();
    for (const secret of forbiddenValues) {
      expect(ctrlActionText.includes(secret)).toBe(false);
    }
    for (const key of collectKeys(JSON.parse(ctrlActionText))) {
      expect(forbiddenKeys.includes(key)).toBe(false);
    }

    const csvText = await handleExportCSV(new Request("http://localhost:3000/api/export/csv?pin=6162"), db).text();
    for (const secret of forbiddenValues) {
      expect(csvText.includes(secret)).toBe(false);
    }
  });
});
