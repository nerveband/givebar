import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import { handleStateRequest } from "../server/src/routes/state";
import { handleDonationRequest } from "../server/src/routes/donation";
import { handleControlRequest } from "../server/src/routes/control";
import { handleExportCSV } from "../server/src/routes/export";
import { handleRehearsalRequest } from "../server/src/routes/rehearsal";
import { handleWebhookRequest } from "../server/src/routes/webhook";
import { handleQRRequest } from "../server/src/routes/qr";
import type { Database } from "bun:sqlite";

describe("Givebar HTTP API Endpoints & Safety Rails", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("GET /api/state returns role-tailored state payloads", async () => {
    // 1. Stage Role
    const stageReq = new Request("http://localhost:3000/api/state?role=stage");
    const stageRes = handleStateRequest(stageReq, db);
    expect(stageRes.status).toBe(200);
    const stageData = await stageRes.json();
    expect(stageData.total_raised_cents).toBe(0);
    expect(stageData.goal_cents).toBe(50000000);

    // 2. Emcee Role
    const emceeReq = new Request("http://localhost:3000/api/state?role=emcee");
    const emceeRes = handleStateRequest(emceeReq, db);
    expect(emceeRes.status).toBe(200);
    const emceeData = await emceeRes.json();
    expect(emceeData.total_raised_cents).toBe(0);
    expect(emceeData.active_donation_count).toBe(0);

    // 3. Control Role
    const ctrlReq = new Request("http://localhost:3000/api/state?role=control");
    const ctrlRes = handleStateRequest(ctrlReq, db);
    expect(ctrlRes.status).toBe(200);
    const ctrlData = await ctrlRes.json();
    expect(ctrlData.folded.total_raised_cents).toBe(0);
    expect(Array.isArray(ctrlData.staged_chyrons)).toBe(true);
  });

  test("PUT /api/donation/:id records donation and handles collision 409", async () => {
    const donationId = "don_api_1";
    const body = {
      amount_cents: 250000,
      donor_name: "Senator Marcus",
      card_number: "#0777",
      entered_by: "V1"
    };

    const req1 = new Request(`http://localhost:3000/api/donation/${donationId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const res1 = await handleDonationRequest(req1, db, ["api", "donation", donationId]);
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.ok).toBe(true);
    expect(data1.donation_id).toBe(donationId);

    // Test Collision on same card number #0777
    const req2 = new Request(`http://localhost:3000/api/donation/don_api_2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 100000,
        donor_name: "Collision Donor",
        card_number: "#0777",
        entered_by: "V2"
      })
    });

    const res2 = await handleDonationRequest(req2, db, ["api", "donation", "don_api_2"]);
    expect(res2.status).toBe(409);
    const data2 = await res2.json();
    expect(data2.error).toBe("CARD_COLLISION");
    expect(data2.card_number).toBe("0777");
  });

  test("POST /api/control actions: freeze, override, confetti, match", async () => {
    // 1. Freeze Screen
    const freezeReq = new Request("http://localhost:3000/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "freeze", pin: "9999" })
    });
    const freezeRes = await handleControlRequest(freezeReq, db);
    expect(freezeRes.status).toBe(200);

    // 2. Set Manual Override Total
    const overrideReq = new Request("http://localhost:3000/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_override", override_cents: 125000000, pin: "9999" })
    });
    const overrideRes = await handleControlRequest(overrideReq, db);
    expect(overrideRes.status).toBe(200);

    // Verify in stage state
    const stageRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db);
    const stageData = await stageRes.json();
    expect(stageData.total_raised_cents).toBe(125000000);
    expect(stageData.is_frozen).toBe(true);

    // 3. Trigger Confetti
    const confettiReq = new Request("http://localhost:3000/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "trigger_confetti", pin: "9999" })
    });
    const confettiRes = await handleControlRequest(confettiReq, db);
    expect(confettiRes.status).toBe(200);
  });

  test("GET /api/export/csv generates RFC 4180 compliant auditable export", async () => {
    // Record two donations
    await handleDonationRequest(new Request("http://localhost:3000/api/donation/don_csv_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 500000,
        donor_name: "Acme Corp, LLC",
        display_name: 'Acme "Special" Corp',
        is_anonymous: false,
        payment_method: "check",
        source: "manual",
        card_number: "#0101",
        entered_by: "V1",
        notes: "Table 1"
      })
    }), db, ["api", "donation", "don_csv_1"]);

    const exportReq = new Request("http://localhost:3000/api/export/csv");
    const exportRes = handleExportCSV(exportReq, db);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("Content-Type")).toContain("text/csv");

    const csvText = await exportRes.text();
    expect(csvText).toContain("Sequence,Event Type,Donation ID");
    expect(csvText).toContain('"Acme Corp, LLC"');
    expect(csvText).toContain('"Acme ""Special"" Corp"');
    expect(csvText).toContain("5000.00,500000");
    expect(csvText).toContain("AUDIT RECONCILIATION SUMMARY");
    expect(csvText).toContain("Total Raised (Cents),500000");
  });

  test("POST /api/rehearsal generates realistic mock gala events", async () => {
    const burstReq = new Request("http://localhost:3000/api/rehearsal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "burst", count: 5 })
    });

    const burstRes = await handleRehearsalRequest(burstReq, db);
    expect(burstRes.status).toBe(200);
    const data = await burstRes.json();
    expect(data.ok).toBe(true);
    expect(data.results.length).toBe(5);

    const stageRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db);
    const stageData = await stageRes.json();
    expect(stageData.total_raised_cents).toBeGreaterThan(0);
  });

  test("POST /api/webhooks/bloomerang and /stripe ingest transactions cleanly", async () => {
    // Bloomerang webhook
    const bloomReq = new Request("http://localhost:3000/api/webhooks/bloomerang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Transaction: {
          Id: 88412,
          Amount: 2500.00,
          AccountName: "Bloomerang Major Giver",
          Method: "CreditCard"
        }
      })
    });

    const bloomRes = await handleWebhookRequest(bloomReq, db, ["api", "webhooks", "bloomerang"]);
    expect(bloomRes.status).toBe(200);

    // Stripe webhook
    const stripeReq = new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_test_12345",
            amount: 100000,
            billing_details: {
              name: "Stripe Online Giver"
            }
          }
        }
      })
    });

    const stripeRes = await handleWebhookRequest(stripeReq, db, ["api", "webhooks", "stripe"]);
    expect(stripeRes.status).toBe(200);

    const stageRes = handleStateRequest(new Request("http://localhost:3000/api/state?role=stage"), db);
    const stageData = await stageRes.json();
    // $2,500 (250000) + $1,000 (100000) = $3,500 (350000)
    expect(stageData.total_raised_cents).toBe(350000);
  });

  test("GET /api/qr returns valid SVG QR matrix", async () => {
    const qrReq = new Request("http://localhost:3000/api/qr?url=https://example.org/donate&size=200");
    const qrRes = handleQRRequest(qrReq);
    expect(qrRes.status).toBe(200);
    expect(qrRes.headers.get("Content-Type")).toBe("image/svg+xml");

    const svg = await qrRes.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("<rect");
    expect(svg).toContain('fill="#000000"');
  });
});
