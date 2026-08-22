import { describe, test, expect, beforeAll } from "bun:test";
import { initDatabase } from "../server/src/db";
import {
  foldLedger,
  recordDonation,
  amendDonation,
  voidDonation,
  updateEventState,
  getEventState,
  getStageState,
  getEmceeState,
  getControlState
} from "../server/src/ledger";
import { handleDonationRequest } from "../server/src/routes/donation";
import { handleControlRequest } from "../server/src/routes/control";
import { handleRehearsalRequest } from "../server/src/routes/rehearsal";
import { handleStateRequest } from "../server/src/routes/state";
import { generateQRCodeSVG } from "../server/src/routes/qr";
import type { Database } from "bun:sqlite";

describe("Givebar Deep Fuzzing, Concurrency, and Stress Engine", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  // 1. Extreme Dollar Values & Boundary Limits
  test("fuzzes extreme amounts: $0, negative, $10M ceiling, integer overflow limits", async () => {
    // 0 cents -> rejected
    const req0 = new Request("http://localhost:3000/api/donation/don_zero", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: 0, donor_name: "Zero Donor" })
    });
    const res0 = await handleDonationRequest(req0, db, ["api", "donation", "don_zero"]);
    expect(res0.status).toBe(400);

    // Negative cents -> rejected
    const reqNeg = new Request("http://localhost:3000/api/donation/don_neg", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: -50000, donor_name: "Neg Donor" })
    });
    const resNeg = await handleDonationRequest(reqNeg, db, ["api", "donation", "don_neg"]);
    expect(resNeg.status).toBe(400);

    // $10,000,000 (1000000000 cents) -> allowed with confirmed_major_gift
    const reqMax = new Request("http://localhost:3000/api/donation/don_max", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 1000000000,
        donor_name: "Megadonor Foundation",
        confirmed_major_gift: true
      })
    });
    const resMax = await handleDonationRequest(reqMax, db, ["api", "donation", "don_max"]);
    expect(resMax.status).toBe(201);

    const folded = foldLedger(db);
    expect(folded.direct_raised_cents).toBe(1000000000);
    expect(folded.total_raised_cents).toBe(1000000000);
  });

  // 2. Unicode, Emojis, XSS & Long String Injections
  test("safely handles XSS injections, multi-byte Unicode, Emojis, and 500-char strings", async () => {
    const xssPayloads = [
      "<script>alert('XSS')</script>",
      "<img src=x onerror=alert(1)>",
      "Dr. 𝕬𝖗𝖙𝖍𝖚𝖗 & 𝕰𝖑𝖊𝖓𝖆 𝖁𝖆𝖓𝖈𝖊 🌟🎉🔥",
      "د. طارق ومنى المنصور",
      "田中 太郎 ＆ 花子",
      "A".repeat(500)
    ];

    for (let i = 0; i < xssPayloads.length; i++) {
      const name = xssPayloads[i];
      const id = `don_fuzz_str_${i}`;
      const req = new Request(`http://localhost:3000/api/donation/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_cents: 50000,
          donor_name: name,
          donor_phonetic: "Phonetic Test",
          notes: "Notes <script>alert(2)</script>"
        })
      });

      const res = await handleDonationRequest(req, db, ["api", "donation", id]);
      expect(res.status).toBe(201);
    }

    // Verify stage and emcee projections render strings without crashing
    const stageState = getStageState(db);
    expect(stageState.chyrons.length).toBeGreaterThan(0);

    const emceeState = getEmceeState(db);
    expect(emceeState.recent_gifts.length).toBeGreaterThan(0);
  });

  // 3. High-Concurrency Race Conditions (50 Concurrent Pledges)
  test("handles 50 concurrent pledge submissions in parallel with zero deadlocks", async () => {
    const startSeq = foldLedger(db).latest_seq;
    const count = 50;
    const promises: Promise<Response>[] = [];

    for (let i = 0; i < count; i++) {
      const id = `don_concurrent_${i}_${Date.now()}`;
      const req = new Request(`http://localhost:3000/api/donation/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_cents: 10000, // $100
          donor_name: `Concurrent Donor ${i}`,
          source: "rehearsal"
        })
      });
      promises.push(handleDonationRequest(req, db, ["api", "donation", id]));
    }

    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const folded = foldLedger(db);
    expect(folded.latest_seq).toBe(startSeq + count);
  });

  // 4. Concurrent Card Serial Collisions (10 Requests Competing for Card #7777)
  test("guarantees exactly 1 winner and 9 rejections when 10 workers enter Card #7777 simultaneously", async () => {
    const cardNum = "7777";
    const attempts = 10;
    const promises: Promise<Response>[] = [];

    for (let i = 0; i < attempts; i++) {
      const id = `don_card_race_${i}`;
      const req = new Request(`http://localhost:3000/api/donation/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_cents: 25000,
          donor_name: `Racer ${i}`,
          card_number: cardNum,
          entered_by: `CLERK_${i}`
        })
      });
      promises.push(handleDonationRequest(req, db, ["api", "donation", id]));
    }

    const responses = await Promise.all(promises);
    const statuses = responses.map(r => r.status);
    const winners = statuses.filter(s => s === 201).length;
    const collisions = statuses.filter(s => s === 409).length;

    expect(winners).toBe(1);
    expect(collisions).toBe(9);
  });

  // 5. Complex Ledger Mutation Sequence (Create -> Match -> Amend -> Void -> Re-enter)
  test("verifies full lifecycle determinism across sequential amendments and voids", () => {
    updateEventState(db, {
      is_match_active: 1,
      match_total_cents: 50000000, // $500k
      match_ratio: 1.0
    });

    const donationId = "don_lifecycle_1";

    // 1. Initial pledge $10,000 -> $10k match applied
    recordDonation(db, {
      donation_id: donationId,
      amount_cents: 1000000,
      donor_name: "Lifecycle Donor",
      card_number: "#8888"
    });

    let folded = foldLedger(db);
    expect(folded.active_donations.get(donationId)?.amount_cents).toBe(1000000);
    expect(folded.match_by_parent.get(donationId)).toBe(1000000);

    // 2. Amend to $30,000 -> match expands to $30k
    amendDonation(db, donationId, {
      amount_cents: 3000000,
      donor_name: "Lifecycle Donor Renamed",
      card_number: "#8888"
    });

    folded = foldLedger(db);
    expect(folded.active_donations.get(donationId)?.amount_cents).toBe(3000000);
    expect(folded.match_by_parent.get(donationId)).toBe(3000000);

    // 3. Void the donation -> match completely released
    voidDonation(db, donationId, "ADMIN", "Test Void");

    folded = foldLedger(db);
    expect(folded.active_donations.get(donationId)).toBeUndefined();
    expect(folded.match_by_parent.get(donationId)).toBeUndefined();

    // 4. Re-enter Card #8888 under new donation_id (Must succeed since prior was voided!)
    const newDonationId = "don_lifecycle_2";
    expect(() => {
      recordDonation(db, {
        donation_id: newDonationId,
        amount_cents: 500000,
        donor_name: "New Donor with Reused Card",
        card_number: "#8888"
      });
    }).not.toThrow();

    folded = foldLedger(db);
    expect(folded.active_donations.get(newDonationId)?.card_number).toBe("#8888");
  });

  // 6. QR Code Fuzzing with diverse URL lengths
  test("generates valid SVG QR code for arbitrary URL lengths from 10 to 500 chars", () => {
    const urls = [
      "https://a.io",
      "https://give.hope.org/donate?source=stage-qr",
      "https://give.hope.org/donate?source=stage-qr&event=gala2026&utm_campaign=live_appeal&ref=" + "x".repeat(150),
      "https://give.hope.org/donate?data=" + "A".repeat(350)
    ];

    for (const url of urls) {
      const svg = generateQRCodeSVG(url, 300);
      expect(svg).toContain("<svg");
      expect(svg).toContain("<path");
      expect(svg).toContain("d=\"");
      expect(svg.length).toBeGreaterThan(100);
    }
  });

  // 7. Rehearsal Mode Stress Fuzzing
  test("executes rehearsal modes burst, typo, and milestone repeatedly without errors", async () => {
    const modes = ["burst", "single", "typo", "milestone"];
    for (const mode of modes) {
      const req = new Request("http://localhost:3000/api/rehearsal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
      const res = await handleRehearsalRequest(req, db);
      expect(res.status).toBe(200);
    }
  });
});
