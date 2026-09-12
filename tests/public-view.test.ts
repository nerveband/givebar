import { expect, test } from "bun:test";
import { initDatabase } from "../server/src/db";
import { recordDonation, amendDonation, updateEventState } from "../server/src/ledger";
import { handleStateRequest } from "../server/src/routes/state";
import { handleHistoryRequest } from "../server/src/routes/history";
import { handleStatsRequest } from "../server/src/stats";
import { handleDonationRequest } from "../server/src/routes/donation";
import { get, json } from "./auth-helper";

test("public views reconcile totals without exposing private data or permitting edits", async () => {
  const db = initDatabase(":memory:");
  try {
    updateEventState(db, { goal_cents: 100000 });
    recordDonation(db, { donation_id: "private-source-id", donor_name: "Private Legal Identity", amount_cents: 25000, entered_by: "Private Operator", notes: "Private Team Note", donor_phonetic: "Private Pronunciation", table_number: "Private Table", card_number: "Private Card", source: "bloomerang", source_txn_id: "Private Transaction" });
    amendDonation(db, "private-source-id", { is_anonymous: true });
    recordDonation(db, { donation_id: "public-gift", donor_name: "Public Supporter", amount_cents: 5000 });
    const responses = [
      handleStateRequest(get("/api/state?role=control"), db),
      handleHistoryRequest(get("/api/history"), db),
      await handleStatsRequest(get("/api/stats"), db, { query: async () => ({ connected: false }), close() {} })
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const privateValue of ["Private Legal Identity", "Private Operator", "Private Team Note", "Private Pronunciation", "Private Table", "Private Card", "Private Transaction", "private-source-id"]) expect(text).not.toContain(privateValue);
      expect(text).toContain("Public Supporter");
      expect(text).toContain("Anonymous Supporter");
    }
    const live = await handleStateRequest(get("/api/state?role=emcee"), db).json();
    expect(live.total_raised_cents).toBe(30000);
    expect(live.active_donation_count).toBe(2);
    expect(live.percent).toBe(30);
    updateEventState(db, { goal_cents: 0 });
    const noGoal = await handleStateRequest(get("/api/state?role=emcee"), db).json();
    expect(noGoal.percent).toBe(0);
    expect(noGoal.total_raised_cents).toBe(30000);
    const denied = await handleDonationRequest(json("/api/donation/public-gift/void", {}, undefined), db, ["api", "donation", "public-gift", "void"]);
    expect(denied.status).toBe(401);
    expect((await handleStateRequest(get("/api/state?role=emcee"), db).json()).active_donation_count).toBe(2);
  } finally { db.close(); }
});
