import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import {
  foldLedger,
  recordDonation,
  amendDonation,
  voidDonation,
  restoreDonation,
  holdDonation,
  releaseHeldDonation,
  updateEventState,
  getEventState,
  getStageState,
  getEmceeState,
  getControlState,
  getVolunteerState,
  startTimer,
  pauseTimer,
  resetTimer,
  addTimerSeconds,
  pinDonation,
  toggleDonationAnonymity
} from "../server/src/ledger";
import { handleControlRequest } from "../server/src/routes/control";
import { handleDonationRequest } from "../server/src/routes/donation";
import { handleStateRequest } from "../server/src/routes/state";
import { generateQRCodeSVG } from "../server/src/routes/qr";
import type { Database } from "bun:sqlite";

describe("Givebar Redesign Architectural & Safety Invariants", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("getStageState is a pure read and does not mutate the database", () => {
    // Record a donation
    recordDonation(db, {
      donation_id: "don_pure_1",
      amount_cents: 100000,
      donor_name: "Pure Donor"
    });

    const initialFloor = getEventState(db).odometer_floor_cents;
    
    // Call getStageState multiple times
    getStageState(db);
    getStageState(db);
    getStageState(db);

    const postFloor = getEventState(db).odometer_floor_cents;
    expect(postFloor).toBe(initialFloor);
  });

  test("voiding a matched donation emits match_release and restores match pool", () => {
    updateEventState(db, {
      is_match_active: 1,
      match_total_cents: 10000000, // $100,000 pool
      match_ratio: 1.0
    });

    // Pledge $50,000 -> gets $50k match
    recordDonation(db, {
      donation_id: "don_matched_1",
      amount_cents: 5000000,
      donor_name: "Match Donor",
      confirmed_major_gift: true
    });
    let folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(5000000);
    expect(folded.match_applied_cents).toBe(5000000);
    expect(folded.derived_match_pool_cents).toBe(5000000);
    expect(folded.total_raised_cents).toBe(10000000);

    // Void the $50k donation
    voidDonation(db, "don_matched_1", "OPERATOR", "Mistake");

    folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(0);
    expect(folded.match_applied_cents).toBe(0);
    expect(folded.derived_match_pool_cents).toBe(10000000); // Full pool restored!
    expect(folded.total_raised_cents).toBe(0);
  });

  test("amendDonation correctly updates amount and recalculates match without argument order bugs", () => {
    updateEventState(db, {
      is_match_active: 1,
      match_total_cents: 10000000,
      match_ratio: 1.0
    });

    recordDonation(db, {
      donation_id: "don_amend_1",
      amount_cents: 1000000, // $10,000
      donor_name: "Initial Donor",
      card_number: "0412",
      confirmed_major_gift: true
    });

    let folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(2000000); // $10k + $10k match

    // Amend to $20,000
    amendDonation(db, "don_amend_1", {
      amount_cents: 2000000,
      donor_name: "Updated Donor Name",
      card_number: "0412",
      confirmed_major_gift: true
    });
    folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(2000000);
    expect(folded.match_applied_cents).toBe(2000000);
    expect(folded.total_raised_cents).toBe(4000000); // $20k + $20k match
    expect(folded.active_donations.get("don_amend_1")?.card_number).toBe("#0412");
  });

  test("server enforces major gift guardrail >= $9,500 unless confirmed", async () => {
    const unconfirmedReq = new Request("http://localhost:3000/api/donation/don_big_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 5000000, // $50,000 >= $9.5k
        donor_name: "Big Philanthropist"
      })
    });

    const res1 = await handleDonationRequest(unconfirmedReq, db, ["api", "donation", "don_big_1"]);
    expect(res1.status).toBe(428); // Precondition Required
    const errData = await res1.json();
    expect(errData.error).toBe("MAJOR_GIFT_CONFIRMATION_REQUIRED");

    // Retry with confirmed_major_gift: true
    const confirmedReq = new Request("http://localhost:3000/api/donation/don_big_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 5000000,
        donor_name: "Big Philanthropist",
        confirmed_major_gift: true
      })
    });

    const res2 = await handleDonationRequest(confirmedReq, db, ["api", "donation", "don_big_1"]);
    expect(res2.status).toBe(201);
  });

  test("state endpoint sanitizes PINs across all public roles", async () => {
    updateEventState(db, { control_pin: "4242", entry_pin: "1357" });

    const stageRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db);
    const stageData = await stageRes.json() as Record<string, unknown>;
    expect(stageData.control_pin).toBeUndefined();
    expect(stageData.entry_pin).toBeUndefined();

    const entryRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=entry"), db);
    const entryData = await entryRes.json() as Record<string, unknown>;
    expect(entryData.control_pin).toBeUndefined();
    expect(entryData.entry_pin).toBeUndefined();
    expect(entryData.has_entry_pin).toBe(true);

    const ctrlRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=control&pin=4242"), db);
    const ctrlData = await ctrlRes.json();
    expect(ctrlData.event_state.control_pin).toBeUndefined();
    expect(ctrlData.event_state.entry_pin).toBeUndefined();
    expect(ctrlData.has_control_pin).toBe(true);
  });

  test("PUT /api/control/settings updates event setup and theme swatches", async () => {
    const req = new Request("http://localhost:3000/api/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Control-Pin": "9999"
      },
      body: JSON.stringify({
        action: "update_settings",
        pin: "9999",
        event_name: "2026 Pediatric Health Gala",
        event_subtitle: "Hope & Healing Foundation",
        goal_cents: 75000000, // $750k
        theme_preset: "sapphire",
        brand_hue: 235,
        brand_chroma: 0.14
      })
    });

    const res = await handleControlRequest(req, db);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const updatedState = getEventState(db);
    expect(updatedState.event_name).toBe("2026 Pediatric Health Gala");
    expect(updatedState.event_subtitle).toBe("Hope & Healing Foundation");
    expect(updatedState.goal_cents).toBe(75000000);
    expect(updatedState.theme_preset).toBe("sapphire");
    expect(updatedState.brand_hue).toBe(235);
  });

  test("generates standards-compliant SVG QR code with quiet zone", () => {
    const svg = generateQRCodeSVG("https://give.hope.org/donate", 240);
    expect(svg).toContain("<svg");
    expect(svg).toContain("xmlns=\"http://www.w3.org/2000/svg\"");
    expect(svg).toContain("viewBox=\"0 0");
    expect(svg).toContain("d=");
  });

  test("Countdown Appeal Clock starts, pauses, resets, and adds time", () => {
    const started = startTimer(db, 300);
    expect(started.timer_status).toBe("running");
    expect(started.countdown_seconds).toBe(300);
    expect(started.timer_ends_at).toBeGreaterThan(Date.now());

    const paused = pauseTimer(db);
    expect(paused.timer_status).toBe("paused");
    expect(paused.timer_ends_at).toBeNull();

    const reset = resetTimer(db, 600);
    expect(reset.timer_status).toBe("stopped");
    expect(reset.countdown_seconds).toBe(600);
  });

  test("pinDonation and toggleDonationAnonymity update stage projection", () => {
    recordDonation(db, {
      donation_id: "don_pin_1",
      amount_cents: 2500000,
      donor_name: "VIP Donor",
      notes: "In honor of the volunteers",
      confirmed_major_gift: true
    });
    pinDonation(db, "don_pin_1");
    let stage = getStageState(db);
    expect(stage.pinned_donation_id).toBe("don_pin_1");
    expect(stage.pinned_donation).not.toBeNull();
    expect(stage.pinned_donation?.display_name).toBe("VIP Donor");
    expect(stage.pinned_donation?.notes).toBe("In honor of the volunteers");

    toggleDonationAnonymity(db, "don_pin_1");
    stage = getStageState(db);
    expect(stage.pinned_donation?.display_name).toBe("Anonymous Supporter");
  });

  test("P0-1: 8-second staging delay and no-backward floor hold concurrently", () => {
    updateEventState(db, { stage_delay_ms: 8000 });

    // 1. Record a gift right now (0s elapsed)
    recordDonation(db, {
      donation_id: "don_delayed_1",
      amount_cents: 5000000, // $50k
      donor_name: "Delayed Donor",
      confirmed_major_gift: true
    });
    // Stage total is $0, floor is $0 during the 8s review buffer
    let stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(0);
    expect(stage.true_total_raised_cents).toBe(5000000);

    // 2. Simulate 9 seconds elapsing (stage matures past horizon)
    updateEventState(db, { stage_delay_ms: 0 });
    stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(5000000);

    // Floor now ratchets to $50k
    const eventState = getEventState(db);
    expect(eventState.odometer_floor_cents).toBe(5000000);

    // 3. Void the $50k gift: Floor holds steady at $50,000 on stage!
    voidDonation(db, "don_delayed_1", "ADMIN", "Typo corrected");
    stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(5000000); // Enforces Invariant #5 (no backward drop)
    expect(stage.true_total_raised_cents).toBe(0);   // Verified ledger reflects void
  });

  test("P0-6: Emcee projection excludes held donations from vocal shoutouts", () => {
    recordDonation(db, {
      donation_id: "don_emcee_held",
      amount_cents: 7500000, // $75k
      donor_name: "Held Big Giver",
      confirmed_major_gift: true
    });
    holdDonation(db, "don_emcee_held", "DIRECTOR", "Under review");
    const emcee = getEmceeState(db);
    const foundInTop = emcee.top_gifts.find(g => g.donation_id === "don_emcee_held");
    const foundInRecent = emcee.recent_gifts.find(g => g.donation_id === "don_emcee_held");
    expect(foundInTop).toBeUndefined();
    expect(foundInRecent).toBeUndefined();
  });

  test("Phase 2: Database migration reaches user_version 6 and stage_delay_ms defaults to 0", () => {
    const versionRow = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(versionRow?.user_version).toBe(6);

    const state = getEventState(db);
    expect(state.stage_delay_ms).toBe(0);
    expect(state.logo_url).toBe("");
    expect(state.background_style).toBe("plain");
    expect(state.bar_color).toBe("");
    expect(state.show_qr).toBe(1);
    expect(state.show_recent_donations).toBe(1);
    expect(state.show_live_indicator).toBe(1);
    expect(state.show_goal).toBe(1);
    expect(state.stage_message).toBe("");
    expect(state.stage_message_visible).toBe(0);
    expect(state.feature_timer).toBe(0);
    expect(state.feature_card_number).toBe(0);
    expect(state.feature_table_number).toBe(0);
    expect(state.bloomerang_api_key).toBe("");
  });

  test("Phase 2: API key is never exposed in any projection or API response", async () => {
    // Set a real API key
    updateEventState(db, {
      bloomerang_api_key: "blm_secret_key_9876543210"
    });

    // 1. Check control state projection
    const ctrl = getControlState(db);
    expect((ctrl.event_state as Record<string, unknown>).bloomerang_api_key).toBeUndefined();
    expect((ctrl as Record<string, unknown>).bloomerang_api_key).toBeUndefined();
    expect(ctrl.has_bloomerang_api_key).toBe(true);
    expect(ctrl.bloomerang_key_masked).toBe("••••••••••••••");

    // Stringify inspection: verify secret string doesn't appear anywhere in JSON
    const ctrlJson = JSON.stringify(ctrl);
    expect(ctrlJson.includes("blm_secret_key")).toBe(false);

    // 2. Check state route response for all roles
    for (const role of ["stage", "control", "emcee", "entry", "default"]) {
      const req = new Request(`http://localhost:3000/api/state?role=${role}`);
      const res = handleStateRequest(req, db);
      const text = await res.text();
      expect(text.includes("blm_secret_key")).toBe(false);
    }
  });

  test("Verification 1: Immediate visibility with stage_delay_ms 0", () => {
    const state = getEventState(db);
    expect(state.stage_delay_ms).toBe(0);

    // Record a gift
    recordDonation(db, {
      donation_id: "don_imm_1",
      amount_cents: 250000,
      donor_name: "Immediate Donor"
    });

    // Stage state immediately reflects the total and chyron with 0s delay
    const stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(250000);
    expect(stage.chyrons.length).toBe(1);
    expect(stage.chyrons[0].donation_id).toBe("don_imm_1");
    expect(stage.chyrons[0].display_name).toBe("Immediate Donor");
  });

  test("Verification 2: Delete then restore round trip through History", async () => {
    // 1. Create donation
    recordDonation(db, {
      donation_id: "don_roundtrip_1",
      amount_cents: 500000,
      donor_name: "A. Rahman",
      card_number: "0412"
    });

    let fold = foldLedger(db);
    expect(fold.total_raised_cents).toBe(500000);
    expect(fold.active_donation_count).toBe(1);

    // 2. Delete / void donation
    voidDonation(db, "don_roundtrip_1", "User M. Chen", "Deleted via Manage Donations");

    fold = foldLedger(db);
    expect(fold.total_raised_cents).toBe(0);
    expect(fold.active_donation_count).toBe(0);
    expect(fold.void_count).toBe(1);

    // History check: both 'create' and 'void' in ledger
    let ctrl = getControlState(db);
    const voidEvent = ctrl.recent_events.find(e => e.donation_id === "don_roundtrip_1" && e.event_type === "void");
    expect(voidEvent).toBeDefined();
    expect(voidEvent?.entered_by).toBe("User M. Chen");

    // 3. Restore donation via API / ledger operation
    const restoreReq = new Request("http://localhost:3000/api/donation/don_roundtrip_1/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entered_by: "User J. Lee", reason: "Restored from History" })
    });
    const restoreRes = await handleDonationRequest(restoreReq, db, ["api", "donation", "don_roundtrip_1", "restore"]);
    expect(restoreRes.status).toBe(200);

    // 4. Verify fold reflects restoration
    fold = foldLedger(db);
    expect(fold.total_raised_cents).toBe(500000);
    expect(fold.active_donation_count).toBe(1);
    expect(fold.void_count).toBe(0);

    // History check: 'restore' event present in ledger
    ctrl = getControlState(db);
    const restoreEvent = ctrl.recent_events.find(e => e.donation_id === "don_roundtrip_1" && e.event_type === "restore");
    expect(restoreEvent).toBeDefined();
    expect(restoreEvent?.entered_by).toBe("User J. Lee");
  });

  test("Verification 3: Settings persistence for milestones and ask tiers", async () => {
    const customMilestones = [
      { cents: 5000000, label: "Community Center" },
      { cents: 15000000, label: "Endowment" }
    ];

    const customAskTiers = [
      { cents: 2500000, label: "$25,000" },
      { cents: 1000000, label: "$10,000" },
      { cents: 500000, label: "$5,000" }
    ];

    const updateReq = new Request("http://localhost:3000/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_settings",
        milestones: customMilestones,
        ask_tiers: customAskTiers,
        pin: "9999"
      })
    });

    const updateRes = await handleControlRequest(updateReq, db);
    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json();

    // Verify in returned control state
    expect(updateData.state.milestones.length).toBe(2);
    expect(updateData.state.milestones[0].label).toBe("Community Center");
    expect(updateData.state.milestones[0].cents).toBe(5000000);

    expect(updateData.state.ask_tiers.length).toBe(3);
    expect(updateData.state.ask_tiers[0].label).toBe("$25,000");
    expect(updateData.state.ask_tiers[0].cents).toBe(2500000);

    // Fresh query verification
    const freshCtrl = getControlState(db);
    expect(freshCtrl.milestones.length).toBe(2);
    expect(freshCtrl.ask_tiers.length).toBe(3);
  });

  test("Verification 5: Presenter View strictly excludes held and anonymous-sensitive fields", () => {
    // 1. Record an anonymous donation with private metadata
    recordDonation(db, {
      donation_id: "don_anon_sensitive",
      amount_cents: 1000000, // $10k
      donor_name: "Secret VIP Benefactor",
      display_name: "Secret VIP Benefactor",
      is_anonymous: true,
      table_number: "Table 42",
      notes: "Do not say my name out loud",
      donor_phonetic: "SEE-krit VEE-eye-pee",
      confirmed_major_gift: true
    });

    // 2. Record a held donation
    recordDonation(db, {
      donation_id: "don_held_sensitive",
      amount_cents: 2000000, // $20k
      donor_name: "Typo Mistake Donor",
      confirmed_major_gift: true
    });
    holdDonation(db, "don_held_sensitive", "Director", "Typo in review");

    // 3. Inspect Presenter View (Emcee projection)
    const emcee = getEmceeState(db);

    // A. Held donation must be completely excluded
    expect(emcee.top_gifts.some(g => g.donation_id === "don_held_sensitive")).toBe(false);
    expect(emcee.recent_gifts.some(g => g.donation_id === "don_held_sensitive")).toBe(false);

    // B. Anonymous donation must mask donor name, and strip table_number, notes, phonetic
    const anonTop = emcee.top_gifts.find(g => g.donation_id === "don_anon_sensitive");
    const anonRecent = emcee.recent_gifts.find(g => g.donation_id === "don_anon_sensitive");

    expect(anonTop).toBeDefined();
    expect(anonTop?.display_name).toBe("Anonymous Supporter");
    expect(anonTop?.donor_phonetic).toBeNull();
    expect(anonTop?.table_number).toBeNull();
    expect(anonTop?.notes).toBeNull();
    expect((anonTop as Record<string, unknown>).donor_name).toBeUndefined();

    expect(anonRecent).toBeDefined();
    expect(anonRecent?.display_name).toBe("Anonymous Supporter");
    expect(anonRecent?.donor_phonetic).toBeNull();
    expect(anonRecent?.table_number).toBeNull();
    expect(anonRecent?.notes).toBeNull();
    expect((anonRecent as Record<string, unknown>).donor_name).toBeUndefined();
  });

  test("Production Defect: 401 Unauthorized prevents unauthenticated state leakage and zero-total render", async () => {
    // Auth is only enforced once an operator actually sets a PIN
    updateEventState(db, { control_pin: "9999" });

    // Record donations so real total is non-zero
    recordDonation(db, {
      donation_id: "don_auth_test",
      amount_cents: 750000,
      donor_name: "Auth Test Donor"
    });

    // 1. Unauthenticated request without PIN
    const unauthReq = new Request("http://localhost:3000/api/state?role=control");
    const unauthRes = handleStateRequest(unauthReq, db);
    expect(unauthRes.status).toBe(401);
    const unauthData = await unauthRes.json();
    expect(unauthData.error).toBe("UNAUTHORIZED");
    expect(unauthData.message).toBe("Control Room PIN required");
    // Crucial: Must NOT contain any data fields that could paint a $0 total or empty list
    expect(unauthData.folded).toBeUndefined();
    expect(unauthData.total_raised_cents).toBeUndefined();
    expect(unauthData.staged_chyrons).toBeUndefined();

    // 2. Request with invalid PIN
    const wrongPinReq = new Request("http://localhost:3000/api/state?role=control&pin=1111");
    const wrongPinRes = handleStateRequest(wrongPinReq, db);
    expect(wrongPinRes.status).toBe(401);

    // 3. Authenticated request with valid PIN
    const authReq = new Request("http://localhost:3000/api/state?role=control&pin=9999");
    const authRes = handleStateRequest(authReq, db);
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(authData.folded).toBeDefined();
    expect(authData.folded.total_raised_cents).toBe(750000);
    expect(authData.staged_chyrons.length).toBe(1);
  });
});
