import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import {
  foldLedger,
  recordDonation,
  amendDonation,
  voidDonation,
  updateEventState,
  getEventState,
  getStageState,
  getEmceeState
} from "../server/src/ledger";
import { handleDonationRequest } from "../server/src/routes/donation";
import type { Database } from "bun:sqlite";

describe("Givebar Live Safety Rails & Invariants", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("rejects negative or zero amounts", async () => {
    const req = new Request("http://localhost:3000/api/donation/don_invalid", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: -5000,
        donor_name: "Negative Donor"
      })
    });

    const res = await handleDonationRequest(req, db, ["api", "donation", "don_invalid"]);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("VALIDATION_ERROR");
  });

  test("rejects donation missing donor name", async () => {
    const req = new Request("http://localhost:3000/api/donation/don_missing_name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 100000,
        donor_name: "   "
      })
    });

    const res = await handleDonationRequest(req, db, ["api", "donation", "don_missing_name"]);
    expect(res.status).toBe(400);
  });

  test("matching pool caps automatically when pledge exceeds remaining capacity", () => {
    // $10,000 match pool
    updateEventState(db, {
      is_match_active: 1,
      match_pool_cents: 1000000, // $10,000
      match_total_cents: 1000000,
      match_ratio: 1.0
    });

    // Donor pledges $25,000
    recordDonation(db, {
      donation_id: "don_cap_1",
      amount_cents: 2500000, // $25k
      donor_name: "Lead Donor",
      confirmed_major_gift: true
    });

    const folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(2500000); // $25k
    expect(folded.match_applied_cents).toBe(1000000);  // capped at $10k
    expect(folded.total_raised_cents).toBe(3500000);   // $35k

    const state = getEventState(db);
    expect(state.match_pool_cents).toBe(0); // Pool exhausted

    // Subsequent pledge receives no match
    recordDonation(db, {
      donation_id: "don_cap_2",
      amount_cents: 500000, // $5k
      donor_name: "Followup Donor"
    });

    const folded2 = foldLedger(db);
    expect(folded2.direct_raised_cents).toBe(3000000);
    expect(folded2.match_applied_cents).toBe(1000000);
    expect(folded2.total_raised_cents).toBe(4000000);
  });

  test("handles sequential amendments and final void deterministically", () => {
    // 1. Create at $5k
    recordDonation(db, {
      donation_id: "don_seq",
      amount_cents: 500000,
      donor_name: "Dr. Initial"
    });
    expect(foldLedger(db).total_raised_cents).toBe(500000);

    // 2. Amend to $15k
    amendDonation(db, "don_seq", { amount_cents: 1500000, donor_name: "Dr. Upgraded", confirmed_major_gift: true });
    expect(foldLedger(db).total_raised_cents).toBe(1500000);

    // 3. Amend to $20k
    amendDonation(db, "don_seq", { amount_cents: 2000000, confirmed_major_gift: true });
    expect(foldLedger(db).total_raised_cents).toBe(2000000);

    // 4. Void
    voidDonation(db, "don_seq", "ADMIN", "Card declined / entered in error");
    expect(foldLedger(db).total_raised_cents).toBe(0);
    expect(foldLedger(db).active_donation_count).toBe(0);
  });

  test("calculates milestone gaps accurately across multi-tier goals", () => {
    updateEventState(db, {
      goal_cents: 100000000, // $1,000,000
      milestones_json: JSON.stringify([
        { cents: 25000000, label: "Staffing" },
        { cents: 50000000, label: "Legal Clinic" },
        { cents: 100000000, label: "Expansion" }
      ])
    });

    // Record $150,000
    recordDonation(db, {
      donation_id: "don_mile_1",
      amount_cents: 15000000,
      donor_name: "Kickoff Donor",
      confirmed_major_gift: true
    });

    const emceeState = getEmceeState(db);
    expect(emceeState.next_milestone).not.toBeNull();
    // Next milestone is $250k ($25,000,000 cents). Remaining is $250k - $150k = $100k ($10,000,000 cents).
    expect(emceeState.next_milestone?.target_cents).toBe(25000000);
    expect(emceeState.next_milestone?.remaining_cents).toBe(10000000);
    expect(emceeState.next_milestone?.label).toBe("Staffing");
  });
});
