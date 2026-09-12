import type { Database } from "bun:sqlite";
import {
  recordDonation, amendDonation, voidDonation, restoreDonation, isValidAmountCents, MAX_AMOUNT_CENTS,
  CardSerialCollisionError, MajorGiftConfirmationRequiredError, PossibleDuplicateError,
  type CreateDonationInput, type PaymentMethod
} from "../ledger";
import { requireRole } from "../authz";

const PAYMENT_METHODS: Record<string, true> = { pledge: true, card: true, check: true, cash: true };

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

/** Maps the guard errors every write shares onto the status codes the form understands. */
function guardResponse(error: unknown): Response | null {
  if (error instanceof MajorGiftConfirmationRequiredError) {
    return Response.json({ error: "MAJOR_GIFT_CONFIRMATION_REQUIRED", message: error.message, amount_cents: error.amount_cents, threshold_cents: error.threshold_cents }, { status: 428 });
  }
  if (error instanceof CardSerialCollisionError) {
    return Response.json({
      error: "CARD_COLLISION", message: error.message, card_number: error.card_number, prior_donation_id: error.prior_donation_id,
      prior_entered_by: error.prior_entered_by, prior_created_at: error.prior_created_at, prior_amount_cents: error.prior_amount_cents, prior_donor_name: error.prior_donor_name
    }, { status: 409 });
  }
  if (error instanceof PossibleDuplicateError) {
    return Response.json({
      error: "POSSIBLE_DUPLICATE", message: error.message, prior_donation_id: error.prior_donation_id, prior_donor_name: error.prior_donor_name,
      prior_amount_cents: error.prior_amount_cents, prior_entered_by: error.prior_entered_by, prior_created_at: error.prior_created_at
    }, { status: 409 });
  }
  return null;
}

/**
 * PUT  /api/donation/:id          record (idempotent on the client-minted id)
 * POST /api/donation/:id/amend    correct name, amount, note, flags
 * POST /api/donation/:id/void     delete (restorable)
 * POST /api/donation/:id/restore  undo a delete
 */
export async function handleDonationRequest(req: Request, db: Database, pathParts: string[]): Promise<Response> {
  const auth = requireRole(db, req, ["admin", "operator"]);
  if (auth instanceof Response) return auth;
  const actor = auth.displayName;
  const donationId = pathParts[2] || "";
  const verb = pathParts[3] || "";
  if (!donationId || !/^[A-Za-z0-9_-]{1,80}$/.test(donationId)) return Response.json({ error: "VALIDATION_ERROR", message: "donation_id is required" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    if (req.method === "PUT" && !verb) {
      const amountCents = typeof body.amount_cents === "number" ? Math.round(body.amount_cents) : 0;
      if (!isValidAmountCents(amountCents)) return Response.json({ error: "VALIDATION_ERROR", message: `amount_cents must be a positive integer of at most ${MAX_AMOUNT_CENTS}` }, { status: 400 });
      const donorName = optionalText(body.donor_name, 200) || "";
      if (!donorName) return Response.json({ error: "VALIDATION_ERROR", message: "donor_name is required" }, { status: 400 });
      const method = typeof body.payment_method === "string" && PAYMENT_METHODS[body.payment_method] ? body.payment_method as PaymentMethod : "pledge";
      const input: CreateDonationInput = {
        donation_id: donationId,
        amount_cents: amountCents,
        donor_name: donorName,
        is_anonymous: Boolean(body.is_anonymous),
        payment_method: method,
        source: "manual",
        card_number: optionalText(body.card_number, 40),
        entered_by: actor,
        notes: optionalText(body.notes, 1000),
        donor_phonetic: optionalText(body.donor_phonetic, 200),
        table_number: optionalText(body.table_number, 40),
        confirmed_major_gift: body.confirmed_major_gift === true,
        confirmed_duplicate: body.confirmed_duplicate === true,
        queued_at: typeof body.queued_at === "number" ? body.queued_at : undefined
      };
      const result = recordDonation(db, input);
      return Response.json({ ok: true, ...result }, { status: result.is_duplicate ? 200 : 201 });
    }
    if (req.method === "POST" && verb === "amend") {
      if (body.amount_cents !== undefined && (typeof body.amount_cents !== "number" || !isValidAmountCents(Math.round(body.amount_cents)))) {
        return Response.json({ error: "VALIDATION_ERROR", message: `amount_cents must be a positive integer of at most ${MAX_AMOUNT_CENTS}` }, { status: 400 });
      }
      const patch: Partial<CreateDonationInput> = {
        amount_cents: typeof body.amount_cents === "number" ? Math.round(body.amount_cents) : undefined,
        donor_name: optionalText(body.donor_name, 200),
        is_anonymous: typeof body.is_anonymous === "boolean" ? body.is_anonymous : undefined,
        payment_method: typeof body.payment_method === "string" && PAYMENT_METHODS[body.payment_method] ? body.payment_method as PaymentMethod : undefined,
        card_number: optionalText(body.card_number, 40),
        notes: optionalText(body.notes, 1000),
        donor_phonetic: optionalText(body.donor_phonetic, 200),
        table_number: optionalText(body.table_number, 40),
        entered_by: actor,
        confirmed_major_gift: body.confirmed_major_gift === true
      };
      const seq = amendDonation(db, donationId, patch);
      return Response.json({ ok: true, seq, donation_id: donationId, amended: true });
    }
    if (req.method === "POST" && verb === "void") {
      const seq = voidDonation(db, donationId, actor, optionalText(body.reason, 200));
      return Response.json({ ok: true, seq, donation_id: donationId, voided: true });
    }
    if (req.method === "POST" && verb === "restore") {
      const seq = restoreDonation(db, donationId, actor, optionalText(body.reason, 200));
      return Response.json({ ok: true, seq, donation_id: donationId, restored: true });
    }
    return Response.json({ error: "NOT_FOUND", message: "Endpoint not found" }, { status: 404 });
  } catch (error) {
    const guarded = guardResponse(error);
    if (guarded) return guarded;
    return Response.json({ error: "DONATION_ERROR", message: error instanceof Error ? error.message : "Donation request failed" }, { status: 400 });
  }
}
