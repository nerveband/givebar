import type { Database } from "bun:sqlite";
import { foldLedger, type LedgerEvent } from "../ledger";
import { requireRole } from "../authz";

const MAX_EVENTS = 5000;

/** GET /api/history: the full audit trail, newest first, plus the current status of every gift. */
export function handleHistoryRequest(req: Request, db: Database): Response {
  const auth = requireRole(db, req, ["admin", "operator"]);
  if (auth instanceof Response) return auth;
  if (req.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED", message: "GET required" }, { status: 405 });

  const events = db.query<LedgerEvent, [number]>(`SELECT * FROM ledger ORDER BY seq DESC LIMIT ?`).all(MAX_EVENTS);
  const folded = foldLedger(db);
  const status: Record<string, { is_voided: boolean; amount_cents: number }> = {};
  for (const record of folded.all_records.values()) status[record.donation_id] = { is_voided: record.is_voided, amount_cents: record.amount_cents };
  return Response.json(
    { events, status, total_raised_cents: folded.total_raised_cents, active_donation_count: folded.active_donation_count, void_count: folded.void_count, server_time: Date.now() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
