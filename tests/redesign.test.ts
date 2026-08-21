import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import {
  foldLedger,
  recordDonation,
  amendDonation,
  voidDonation,
  holdDonation,
  releaseHeldDonation,
  updateEventState,
  getEventState,
  getStageState,
  getEmceeState,
  getControlState,
  getVolunteerState
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
      donor_name: "Match Donor"
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
      card_number: "0412"
    });

    let folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(2000000); // $10k + $10k match

    // Amend to $20,000
    amendDonation(db, "don_amend_1", {
      amount_cents: 2000000,
      donor_name: "Updated Donor Name",
      card_number: "0412"
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
    const stageRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db);
    const stageData = await stageRes.json();
    expect((stageData as any).control_pin).toBeUndefined();
    expect((stageData as any).entry_pin).toBeUndefined();

    const entryRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=entry"), db);
    const entryData = await entryRes.json();
    expect((entryData as any).control_pin).toBeUndefined();
    expect((entryData as any).entry_pin).toBeUndefined();
    expect(entryData.has_entry_pin).toBe(true);

    const ctrlRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db);
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
    expect(svg).toContain("path d=");
  });
});
