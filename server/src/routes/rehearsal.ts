import type { Database } from "bun:sqlite";
import { recordDonation, foldLedger, getEventState } from "../ledger";

const SAMPLE_DONORS = [
  "Dr. Tariq & Mona Al-Mansoor",
  "The Henderson Family Trust",
  "Elena Rostova & Mark Vance",
  "Sarah Jenkins & David Cole",
  "Amira & Bilal Siddiqui",
  "Marcus Sterling",
  "Dr. Aris Thorne",
  "Priya & Rajiv Patel",
  "Jonathan & Claire Hayes",
  "The Sterling Foundation",
  "Maya Lin & Robert Chen",
  "James & Patricia O'Connor",
  "Fatima & Omar Qureshi",
  "Victoria & Arthur Vance",
  "Alexander & Sophia Wright",
  "Anonymous Supporter",
  "Dr. Kenneth & Rachel Brooks",
  "Lila & Samuel Ward",
  "Zayn & Hannah Malik",
  "The Apex Technology Group"
];

const SAMPLE_TIERS = [
  5000000, // $50,000
  2500000, // $25,000
  1000000, // $10,000
  500000,  // $5,000
  250000,  // $2,500
  100000,  // $1,000
  50000,   // $500
  25000,   // $250
  10000    // $100
];

let rehearsalCardCounter = 100;

export async function handleRehearsalRequest(req: Request, db: Database): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    return Response.json({ error: "METHOD_NOT_ALLOWED", message: "POST required" }, { status: 405 });
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const mode = String(body.mode || "single");

    switch (mode) {
      case "single": {
        const donation = generateRandomDonation();
        const result = recordDonation(db, donation);
        return Response.json({ ok: true, mode: "single", donation, result });
      }

      case "burst": {
        // Generate 5 to 10 rapid-fire donations
        const count = typeof body.count === "number" ? Math.min(25, Math.max(2, body.count)) : 7;
        const results = [];
        for (let i = 0; i < count; i++) {
          const donation = generateRandomDonation();
          const res = recordDonation(db, donation);
          results.push({ donation, res });
        }
        return Response.json({ ok: true, mode: "burst", count, results });
      }

      case "typo": {
        // Explicitly inject a typo gift to test the 8s Yank queue
        rehearsalCardCounter++;
        const typoDonation = {
          donation_id: crypto.randomUUID(),
          amount_cents: 500000, // $5,000
          donor_name: "TEST TYPO NAME - PLEASE HOLD FROM STAGE",
          display_name: "TEST TYPO NAME - PLEASE HOLD FROM STAGE",
          is_anonymous: false,
          payment_method: "pledge" as const,
          source: "rehearsal" as const,
          card_number: `#${rehearsalCardCounter}`,
          entered_by: "REHEARSAL_BOT",
          notes: "Table 99 - Test typo for 8s stage review buffer",
          confirmed_major_gift: true
        };
        const result = recordDonation(db, typoDonation);
        return Response.json({ ok: true, mode: "typo", donation: typoDonation, result });
      }

      case "milestone": {
        // Find next milestone and inject amount to cross it
        const eventState = getEventState(db);
        const folded = foldLedger(db);
        const currentTotal = eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents;
        
        let milestones: Array<{ cents: number; label: string }> = [];
        try {
          milestones = JSON.parse(eventState.milestones_json);
        } catch {
          milestones = [{ cents: 50000000, label: "Goal" }];
        }
        milestones.sort((a, b) => a.cents - b.cents);

        let targetCents = eventState.goal_cents;
        for (const m of milestones) {
          if (m.cents > currentTotal) {
            targetCents = m.cents;
            break;
          }
        }

        const neededCents = Math.max(100000, targetCents - currentTotal + 500000); // Cross by $5k
        rehearsalCardCounter++;
        const milestoneDonation = {
          donation_id: crypto.randomUUID(),
          amount_cents: neededCents,
          donor_name: "Benefactor Milestone Grantor",
          display_name: "Benefactor Milestone Grantor",
          is_anonymous: false,
          payment_method: "pledge" as const,
          source: "rehearsal" as const,
          card_number: `#${rehearsalCardCounter}`,
          entered_by: "REHEARSAL_BOT",
          notes: "Milestone celebration trigger test",
          confirmed_major_gift: true
        };

        const result = recordDonation(db, milestoneDonation);
        return Response.json({ ok: true, mode: "milestone", donation: milestoneDonation, result });
      }

      default:
        return Response.json({ error: "UNKNOWN_MODE", message: `Unknown rehearsal mode: ${mode}` }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Rehearsal injection failed";
    return Response.json({ error: "REHEARSAL_ERROR", message }, { status: 500 });
  }
}

function generateRandomDonation() {
  rehearsalCardCounter++;
  const donorName = SAMPLE_DONORS[Math.floor(Math.random() * SAMPLE_DONORS.length)];
  const isAnon = donorName === "Anonymous Supporter" || Math.random() < 0.12;
  const amountCents = SAMPLE_TIERS[Math.floor(Math.random() * SAMPLE_TIERS.length)];
  const tableNum = Math.floor(Math.random() * 35) + 1;

  return {
    donation_id: crypto.randomUUID(),
    amount_cents: amountCents,
    donor_name: donorName,
    display_name: isAnon ? "Anonymous Supporter" : donorName,
    is_anonymous: isAnon,
    payment_method: (Math.random() < 0.7 ? "pledge" : (Math.random() < 0.5 ? "card" : "check")) as "pledge" | "card" | "check",
    source: "rehearsal" as const,
    card_number: `#0${rehearsalCardCounter}`,
    entered_by: `CLERK_${Math.floor(Math.random() * 3) + 1}`,
    notes: `Table ${tableNum}`,
    confirmed_major_gift: true
  };
}
