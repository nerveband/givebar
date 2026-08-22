import type { Database } from "bun:sqlite";
import { recordDonation } from "../ledger";

export async function handleWebhookRequest(req: Request, db: Database, pathParts: string[]): Promise<Response> {
  const provider = pathParts[2] || ""; // /api/webhooks/:provider

  if (req.method.toUpperCase() !== "POST") {
    return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }
  // Verify optional webhook secret if configured
  const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (provider === "stripe" && stripeSecret) {
    const sig = req.headers.get("stripe-signature");
    if (!sig) {
      return Response.json({ error: "UNAUTHORIZED", message: "Missing stripe-signature header" }, { status: 401 });
    }
  }

  try {
    const rawBody = await req.text();
    const body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
    switch (provider) {
      case "bloomerang": {
        // Bloomerang Webhook: Transaction created/updated
        const txn = (body.Transaction || body) as Record<string, unknown>;
        const txnId = String(txn.Id || txn.TransactionId || body.Id || crypto.randomUUID());
        const amount = typeof txn.Amount === "number" ? Math.round(txn.Amount * 100) : 0;
        const donorName = String(txn.AccountName || txn.DonorName || body.AccountName || "Bloomerang Donor");
        const method = String(txn.Method || "card").toLowerCase();

        if (amount > 0) {
          const result = recordDonation(db, {
            donation_id: `bloomerang_${txnId}`,
            amount_cents: amount,
            donor_name: donorName,
            display_name: donorName,
            is_anonymous: false,
            payment_method: method === "check" ? "check" : "card",
            source: "bloomerang",
            source_txn_id: txnId,
            notes: "Ingested from Bloomerang webhook"
          });
          return Response.json({ ok: true, provider: "bloomerang", result });
        }
        return Response.json({ ok: true, ignored: true, reason: "Zero or negative amount" });
      }

      case "stripe": {
        // Stripe Webhook: payment_intent.succeeded or charge.succeeded
        const type = String(body.type || "");
        const dataObj = ((body.data as Record<string, unknown>)?.object || {}) as Record<string, unknown>;
        
        if (type === "payment_intent.succeeded" || type === "charge.succeeded") {
          const txnId = String(dataObj.id || crypto.randomUUID());
          const amountCents = typeof dataObj.amount === "number" ? dataObj.amount : 0;
          const billing = (dataObj.billing_details || {}) as Record<string, unknown>;
          const donorName = String(billing.name || dataObj.customer_name || "Stripe Donor");

          if (amountCents > 0) {
            const result = recordDonation(db, {
              donation_id: `stripe_${txnId}`,
              amount_cents: amountCents,
              donor_name: donorName,
              display_name: donorName,
              is_anonymous: false,
              payment_method: "card",
              source: "stripe",
              source_txn_id: txnId,
              notes: `Stripe ${type}`
            });
            return Response.json({ ok: true, provider: "stripe", result });
          }
        }
        return Response.json({ ok: true, received: true });
      }

      case "kindful": {
        // Kindful Webhook
        const txn = (body.transaction || body) as Record<string, unknown>;
        const txnId = String(txn.id || crypto.randomUUID());
        const amountCents = typeof txn.amount_in_cents === "number" ? txn.amount_in_cents : 0;
        const donorName = String(txn.contact_name || "Kindful Donor");

        if (amountCents > 0) {
          const result = recordDonation(db, {
            donation_id: `kindful_${txnId}`,
            amount_cents: amountCents,
            donor_name: donorName,
            display_name: donorName,
            is_anonymous: false,
            payment_method: "card",
            source: "kindful",
            source_txn_id: txnId,
            notes: "Ingested from Kindful webhook"
          });
          return Response.json({ ok: true, provider: "kindful", result });
        }
        return Response.json({ ok: true, ignored: true });
      }

      default:
        return Response.json({ error: "UNKNOWN_PROVIDER", message: `Provider ${provider} not supported` }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Webhook processing error";
    return Response.json({ error: "WEBHOOK_ERROR", message }, { status: 500 });
  }
}
