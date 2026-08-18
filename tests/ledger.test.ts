import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import {
  foldLedger,
  recordDonation,
  amendDonation,
  voidDonation,
  yankChyron,
  unyankChyron,
  updateEventState,
  getStageState,
  getEmceeState,
  getControlState,
  CardSerialCollisionError
} from "../server/src/ledger";
import type { Database } from "bun:sqlite";

describe("Givebar Ledger & Deterministic Fold Engine", () => {
  let db: Database;

  beforeEach(() => {
    // In-memory database for isolated, lightning-fast testing
    db = initDatabase(":memory:");
  });

  test("initial state is zero raised", () => {
    const folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(0);
    expect(folded.direct_raised_cents).toBe(0);
    expect(folded.match_applied_cents).toBe(0);
    expect(folded.active_donation_count).toBe(0);
    expect(folded.void_count).toBe(0);
  });

  test("records single donation and computes exact fold", () => {
    const res = recordDonation(db, {
      donation_id: "don_1",
      amount_cents: 500000, // $5,000.00
      donor_name: "Dr. Arthur Vance",
      payment_method: "pledge",
      source: "manual",
      card_number: "#0101",
      entered_by: "V1"
    });

    expect(res.seq).toBe(1);
    expect(res.is_duplicate).toBe(false);

    const folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(500000);
    expect(folded.total_raised_cents).toBe(500000);
    expect(folded.active_donation_count).toBe(1);
  });

  test("idempotent submission returns duplicate receipt without inflating total", () => {
    const input = {
      donation_id: "don_idem",
      amount_cents: 250000, // $2,500.00
      donor_name: "Sarah Connor",
      source: "manual" as const,
      source_txn_id: "TXN_999"
    };

    const res1 = recordDonation(db, input);
    expect(res1.is_duplicate).toBe(false);

    const res2 = recordDonation(db, input);
    expect(res2.is_duplicate).toBe(true);
    expect(res2.donation_id).toBe("don_idem");

    const folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(250000);
    expect(folded.active_donation_count).toBe(1);
  });

  test("detects physical card serial collision and throws CardSerialCollisionError", () => {
    recordDonation(db, {
      donation_id: "don_card_1",
      amount_cents: 100000,
      donor_name: "Alice Smith",
      card_number: "#0412",
      entered_by: "V1"
    });

    expect(() => {
      recordDonation(db, {
        donation_id: "don_card_2",
        amount_cents: 200000,
        donor_name: "Bob Jones",
        card_number: "0412", // without hash
        entered_by: "V2"
      });
    }).toThrow(CardSerialCollisionError);
  });

  test("applies matching grant automatically when active", () => {
    // Enable 1:1 match with $100,000 pool
    updateEventState(db, {
      is_match_active: 1,
      match_pool_cents: 10000000, // $100k
      match_total_cents: 10000000,
      match_ratio: 1.0,
      match_sponsor_title: "Founders Matching Fund"
    });

    // Record $10k donation
    recordDonation(db, {
      donation_id: "don_match_1",
      amount_cents: 1000000, // $10,000
      donor_name: "Major Benefactor",
      source: "manual"
    });

    const folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(1000000); // $10k direct
    expect(folded.match_applied_cents).toBe(1000000); // $10k match applied
    expect(folded.total_raised_cents).toBe(2000000);  // $20k total authoritative
  });

  test("amends existing donation cleanly via append-only event", () => {
    recordDonation(db, {
      donation_id: "don_amend_1",
      amount_cents: 100000, // $1,000
      donor_name: "Typo Name",
      source: "manual"
    });

    amendDonation(db, "don_amend_1", {
      donor_name: "Correct Name",
      amount_cents: 150000 // $1,500
    });

    const folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(150000);
    expect(folded.active_donations.get("don_amend_1")?.donor_name).toBe("Correct Name");
  });

  test("voids donation and deducts from total", () => {
    recordDonation(db, {
      donation_id: "don_void_1",
      amount_cents: 500000, // $5k
      donor_name: "Mistake Donor",
      source: "manual"
    });

    expect(foldLedger(db).total_raised_cents).toBe(500000);

    voidDonation(db, "don_void_1", "ADMIN", "Accidental test entry");

    const folded = foldLedger(db);
    expect(folded.total_raised_cents).toBe(0);
    expect(folded.active_donation_count).toBe(0);
    expect(folded.void_count).toBe(1);
  });

  test("strict privacy shield masks real donor names for anonymous donations", () => {
    recordDonation(db, {
      donation_id: "don_anon_1",
      amount_cents: 2500000, // $25,000
      donor_name: "Secret Billionaire",
      is_anonymous: true,
      source: "manual"
    });

    const stageState = getStageState(db);
    expect(stageState.total_raised_cents).toBe(2500000);

    const emceeState = getEmceeState(db);
    expect(emceeState.top_gifts[0].display_name).toBe("Anonymous Supporter");
    expect(emceeState.top_gifts[0].is_anonymous).toBe(true);
  });

  test("1-click Yank removes donation chyron from stage HUD", () => {
    recordDonation(db, {
      donation_id: "don_yank_1",
      amount_cents: 50000,
      donor_name: "Typo in Public Name",
      source: "manual"
    });

    // Yank before it reaches stage
    yankChyron(db, "don_yank_1", "AV_DIRECTOR", "Typo noticed");

    const ctrlState = getControlState(db);
    const item = ctrlState.staged_chyrons.find(c => c.donation_id === "don_yank_1");
    expect(item?.is_yanked).toBe(true);

    // Unyank
    unyankChyron(db, "don_yank_1");
    const ctrlStateAfter = getControlState(db);
    const itemAfter = ctrlStateAfter.staged_chyrons.find(c => c.donation_id === "don_yank_1");
    expect(itemAfter?.is_yanked).toBe(false);
  });

  test("enforces no-backward-odometer rule across downward corrections", () => {
    recordDonation(db, {
      donation_id: "don_peak",
      amount_cents: 10000000, // $100,000
      donor_name: "Peak Donor",
      source: "manual"
    });

    // Stage sees $100k
    const state1 = getStageState(db);
    expect(state1.total_raised_cents).toBe(10000000);

    // Now void the $100k
    voidDonation(db, "don_peak", "ADMIN", "Voided");

    // Stage odometer floor holds at $100,000 to prevent on-stage embarrassment
    const state2 = getStageState(db);
    expect(state2.total_raised_cents).toBe(10000000);
    expect(state2.true_total_raised_cents).toBe(0);
  });
});
