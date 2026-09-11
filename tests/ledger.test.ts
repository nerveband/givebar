import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../server/src/db";
import {
  amendDonation, foldLedger, recordDonation, restoreDonation, updateEventState, voidDonation,
  CardSerialCollisionError, MajorGiftConfirmationRequiredError, PossibleDuplicateError
} from "../server/src/ledger";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => db.close());

describe("Ledger fold and corrections", () => {
  test("create, amend, void, restore fold deterministically with a matching sponsor", () => {
    updateEventState(db, { is_match_active: 1, match_total_cents: 1500000, match_ratio: 1 });
    recordDonation(db, { donation_id: "a", donor_name: "Ada", amount_cents: 1000000, confirmed_major_gift: true });
    recordDonation(db, { donation_id: "b", donor_name: "Bo", amount_cents: 800000 });
    let fold = foldLedger(db);
    expect(fold.direct_raised_cents).toBe(1800000);
    expect(fold.match_applied_cents).toBe(1500000);
    expect(fold.active_donations.get("b")!.matched_amount_cents).toBe(500000);

    amendDonation(db, "a", { amount_cents: 200000 });
    fold = foldLedger(db);
    expect(fold.active_donations.get("a")!.amount_cents).toBe(200000);
    expect(fold.match_by_parent.get("a")).toBe(200000);
    expect(fold.derived_match_pool_cents).toBe(800000);

    voidDonation(db, "b", "Ops", "typo");
    fold = foldLedger(db);
    expect(fold.total_raised_cents).toBe(400000);
    expect(fold.derived_match_pool_cents).toBe(1300000);

    restoreDonation(db, "b", "Ops");
    fold = foldLedger(db);
    expect(fold.active_donation_count).toBe(2);
    expect(fold.total_raised_cents).toBe(2000000);
    expect(fold.match_applied_cents).toBe(1000000);
  });

  test("submitting the same donation id twice returns a duplicate receipt and never inflates the total", () => {
    const first = recordDonation(db, { donation_id: "same", donor_name: "Once", amount_cents: 5000 });
    const second = recordDonation(db, { donation_id: "same", donor_name: "Once", amount_cents: 5000 });
    expect(second.is_duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(foldLedger(db).total_raised_cents).toBe(5000);
  });

  test("anonymous gifts keep the legal name for the team and show Anonymous Supporter publicly", () => {
    recordDonation(db, { donation_id: "anon", donor_name: "Quiet Giver", amount_cents: 2500, is_anonymous: true });
    const record = foldLedger(db).active_donations.get("anon")!;
    expect(record.donor_name).toBe("Quiet Giver");
    expect(record.display_name).toBe("Anonymous Supporter");
    amendDonation(db, "anon", { is_anonymous: false });
    expect(foldLedger(db).active_donations.get("anon")!.display_name).toBe("Quiet Giver");
  });
});

describe("Entry guard rails", () => {
  test("major gifts need explicit confirmation on create and on an amended amount", () => {
    expect(() => recordDonation(db, { donation_id: "big", donor_name: "Whale", amount_cents: 950000 })).toThrow(MajorGiftConfirmationRequiredError);
    recordDonation(db, { donation_id: "big", donor_name: "Whale", amount_cents: 950000, confirmed_major_gift: true });
    expect(() => amendDonation(db, "big", { amount_cents: 5000000 })).toThrow(MajorGiftConfirmationRequiredError);
    amendDonation(db, "big", { amount_cents: 5000000, confirmed_major_gift: true });
    amendDonation(db, "big", { notes: "note only, same amount" });
    expect(foldLedger(db).active_donations.get("big")!.notes).toBe("note only, same amount");
  });

  test("physical card serials are unique among active gifts and freed by a void", () => {
    recordDonation(db, { donation_id: "c1", donor_name: "First", amount_cents: 1000, card_number: "#0412" });
    expect(() => recordDonation(db, { donation_id: "c2", donor_name: "Second", amount_cents: 2000, card_number: "0412" })).toThrow(CardSerialCollisionError);
    voidDonation(db, "c1");
    recordDonation(db, { donation_id: "c2", donor_name: "Second", amount_cents: 2000, card_number: "0412" });
    expect(() => restoreDonation(db, "c1")).toThrow(CardSerialCollisionError);
  });

  test("same donor and amount within minutes is flagged as a possible duplicate unless confirmed", () => {
    recordDonation(db, { donation_id: "d1", donor_name: "Maya Lin", amount_cents: 50000 });
    expect(() => recordDonation(db, { donation_id: "d2", donor_name: " maya   LIN ", amount_cents: 50000 })).toThrow(PossibleDuplicateError);
    recordDonation(db, { donation_id: "d3", donor_name: "Maya Lin", amount_cents: 60000 });
    recordDonation(db, { donation_id: "d2", donor_name: "Maya Lin", amount_cents: 50000, confirmed_duplicate: true });
    recordDonation(db, { donation_id: "import", donor_name: "Maya Lin", amount_cents: 50000, source: "bloomerang", source_txn_id: "t-1" });
    expect(foldLedger(db).active_donation_count).toBe(4);
  });

  test("rejects zero, negative, and nameless gifts", () => {
    expect(() => recordDonation(db, { donation_id: "z", donor_name: "Zero", amount_cents: 0 })).toThrow();
    expect(() => recordDonation(db, { donation_id: "n", donor_name: "Neg", amount_cents: -100 })).toThrow();
    expect(() => recordDonation(db, { donation_id: "e", donor_name: "   ", amount_cents: 100 })).toThrow();
    expect(foldLedger(db).latest_seq).toBe(0);
  });
});
