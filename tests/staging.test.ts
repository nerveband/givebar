import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../server/src/db";
import { amendDonation, holdDonation, recordDonation, updateEventState, voidDonation } from "../server/src/ledger";
import { getControlState, getEmceeState, getStageState } from "../server/src/projection";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => db.close());

/** Moves a gift's created_at into the past so the staging window has elapsed. */
function age(donationId: string, ms: number): void {
  db.query(`UPDATE ledger SET created_at = created_at - ? WHERE donation_id = ? AND event_type = 'create'`).run(ms, donationId);
}

describe("Staging delay and the wall figure", () => {
  test("a gift inside the staging window is invisible; a void or correction inside the window is honoured when it would have appeared", () => {
    updateEventState(db, { stage_delay_ms: 8000 });
    recordDonation(db, { donation_id: "typo", donor_name: "Typo", amount_cents: 50000000, confirmed_major_gift: true });
    recordDonation(db, { donation_id: "fix", donor_name: "Fix", amount_cents: 500000 });
    expect(getStageState(db).total_raised_cents).toBe(0);
    expect(getStageState(db).chyrons).toHaveLength(0);

    voidDonation(db, "typo", "Ops", "extra zero");
    amendDonation(db, "fix", { amount_cents: 50000 });
    age("typo", 9000);
    age("fix", 9000);

    const stage = getStageState(db);
    expect(stage.total_raised_cents).toBe(50000);
    expect(stage.chyrons.map(c => c.display_name)).toEqual(["Fix"]);
  });

  test("once on the wall the figure never rolls backward, and a pause holds it", () => {
    updateEventState(db, { stage_delay_ms: 0 });
    recordDonation(db, { donation_id: "a", donor_name: "A", amount_cents: 300000 });
    recordDonation(db, { donation_id: "b", donor_name: "B", amount_cents: 200000 });
    expect(getStageState(db).total_raised_cents).toBe(500000);

    voidDonation(db, "b");
    expect(getStageState(db).total_raised_cents).toBe(500000);
    expect(getStageState(db).true_total_raised_cents).toBe(300000);

    recordDonation(db, { donation_id: "c", donor_name: "C", amount_cents: 100000 });
    expect(getStageState(db).total_raised_cents).toBe(500000);
    recordDonation(db, { donation_id: "d", donor_name: "D", amount_cents: 150000 });
    expect(getStageState(db).total_raised_cents).toBe(550000);

    updateEventState(db, { is_frozen: 1 });
    recordDonation(db, { donation_id: "e", donor_name: "E", amount_cents: 900000 });
    const paused = getStageState(db);
    expect(paused.total_raised_cents).toBe(550000);
    expect(paused.chyrons).toHaveLength(0);
    expect(paused.is_frozen).toBe(true);
    updateEventState(db, { is_frozen: 0 });
    expect(getStageState(db).total_raised_cents).toBe(1450000);
  });

  test("the operator view reports the same wall figure as the chart, even when no chart is open", () => {
    updateEventState(db, { stage_delay_ms: 8000 });
    recordDonation(db, { donation_id: "a", donor_name: "A", amount_cents: 300000 });
    expect(getControlState(db).stage_preview.stage_total_cents).toBe(0);
    age("a", 9000);
    expect(getControlState(db).stage_preview.stage_total_cents).toBe(300000);
    expect(getStageState(db).total_raised_cents).toBe(300000);
  });

  test("a held gift stays off both room screens while remaining in the total", () => {
    updateEventState(db, { stage_delay_ms: 0 });
    recordDonation(db, { donation_id: "h", donor_name: "Held", amount_cents: 100000 });
    holdDonation(db, "h", "Ops");
    expect(getStageState(db).chyrons).toHaveLength(0);
    expect(getEmceeState(db).recent_gifts).toHaveLength(0);
    expect(getControlState(db).donations[0].is_held).toBe(true);
    expect(getControlState(db).folded.total_raised_cents).toBe(100000);
  });
});

describe("Privacy shield on the room screens", () => {
  test("the chart never carries legal names, notes, operators, or card numbers; the podium never carries notes or operators", () => {
    updateEventState(db, { stage_delay_ms: 0, feature_card_number: 1 });
    recordDonation(db, { donation_id: "p", donor_name: "Private Person", amount_cents: 25000, is_anonymous: true, notes: "SECRET NOTE", entered_by: "Volunteer V", card_number: "0099", donor_phonetic: "PRY-vit", table_number: "12" });
    recordDonation(db, { donation_id: "q", donor_name: "Public Person", amount_cents: 35000, notes: "ANOTHER SECRET", entered_by: "Volunteer W", donor_phonetic: "PUB-lik", table_number: "3" });
    const stage = JSON.stringify(getStageState(db));
    for (const forbidden of ["Private Person", "SECRET NOTE", "ANOTHER SECRET", "Volunteer", "0099", "PRY-vit", "PUB-lik"]) expect(stage).not.toContain(forbidden);
    expect(stage).toContain("Anonymous Supporter");
    expect(stage).toContain("Public Person");

    const podium = JSON.stringify(getEmceeState(db));
    for (const forbidden of ["Private Person", "SECRET NOTE", "ANOTHER SECRET", "Volunteer", "PRY-vit"]) expect(podium).not.toContain(forbidden);
    expect(podium).toContain("PUB-lik");
    expect(getEmceeState(db).recent_gifts.find(g => g.donation_id === "q")!.table_number).toBe("3");
    expect(getEmceeState(db).recent_gifts.find(g => g.donation_id === "p")!.table_number).toBeNull();
  });
});
