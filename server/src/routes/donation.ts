import type { Database } from "bun:sqlite";
import { recordDonation, amendDonation, voidDonation, CardSerialCollisionError, type CreateDonationInput } from "../ledger";

export async function handleDonationRequest(req: Request, db: Database, pathParts: string[]): Promise<Response> {
  const method = req.method.toUpperCase();

  // Route: POST /api/donation or PUT /api/donation/:id
  if ((method === "POST" && pathParts.length === 2) || (method === "PUT" && pathParts.length === 3)) {
    try {
      const body = await req.json() as Partial<CreateDonationInput>;
      
      const donationId = (method === "PUT" ? pathParts[2] : body.donation_id) || crypto.randomUUID();
      const amountCents = typeof body.amount_cents === "number" ? Math.round(body.amount_cents) : 0;
      const donorName = (body.donor_name || "").trim();

      if (!donationId) {
        return Response.json({ error: "VALIDATION_ERROR", message: "donation_id is required" }, { status: 400 });
      }

      if (amountCents <= 0) {
        return Response.json({ error: "VALIDATION_ERROR", message: "amount_cents must be a positive integer" }, { status: 400 });
      }

      if (!donorName) {
        return Response.json({ error: "VALIDATION_ERROR", message: "donor_name is required" }, { status: 400 });
      }

      const input: CreateDonationInput = {
        donation_id: donationId,
        amount_cents: amountCents,
        donor_name: donorName,
        display_name: body.display_name,
        is_anonymous: Boolean(body.is_anonymous),
        payment_method: body.payment_method || "pledge",
        source: body.source || "manual",
        source_txn_id: body.source_txn_id,
        card_number: body.card_number,
        entered_by: body.entered_by,
        notes: body.notes
      };

      const result = recordDonation(db, input);
      return Response.json({
        ok: true,
        seq: result.seq,
        donation_id: result.donation_id,
        is_duplicate: result.is_duplicate
      }, { status: result.is_duplicate ? 200 : 201 });
    } catch (err: unknown) {
      if (err instanceof CardSerialCollisionError) {
        return Response.json({
          error: "CARD_COLLISION",
          message: err.message,
          card_number: err.card_number,
          prior_donation_id: err.prior_donation_id,
          prior_entered_by: err.prior_entered_by,
          prior_created_at: err.prior_created_at
        }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: "SERVER_ERROR", message }, { status: 500 });
    }
  }

  // Route: POST /api/donation/:id/void
  if (method === "POST" && pathParts.length === 4 && pathParts[3] === "void") {
    const donationId = pathParts[2];
    try {
      const body = await req.json().catch(() => ({})) as { entered_by?: string; reason?: string };
      const seq = voidDonation(db, donationId, body.entered_by, body.reason);
      return Response.json({ ok: true, seq, donation_id: donationId, voided: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to void donation";
      return Response.json({ error: "VOID_FAILED", message }, { status: 400 });
    }
  }

  // Route: POST /api/donation/:id/amend
  if (method === "POST" && pathParts.length === 4 && pathParts[3] === "amend") {
    const donationId = pathParts[2];
    try {
      const body = await req.json() as Partial<CreateDonationInput>;
      const seq = amendDonation(db, donationId, body);
      return Response.json({ ok: true, seq, donation_id: donationId, amended: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to amend donation";
      return Response.json({ error: "AMEND_FAILED", message }, { status: 400 });
    }
  }

  return Response.json({ error: "NOT_FOUND", message: "Endpoint not found" }, { status: 404 });
}
