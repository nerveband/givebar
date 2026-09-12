import type { Database } from "bun:sqlite";
import { foldLedger, type LedgerEvent } from "../ledger";
import { getSession } from "../authz";

const MAX_EVENTS = 5000;

/** GET /api/history: the full audit trail, newest first, plus the current status of every gift. */
export function handleHistoryRequest(req: Request, db: Database): Response {
  const session = getSession(req, db);
  if (req.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED", message: "GET required" }, { status: 405 });

  let events = db.query<LedgerEvent, [number]>(`SELECT * FROM ledger ORDER BY seq DESC LIMIT ?`).all(MAX_EVENTS);
  const folded = foldLedger(db);
  const status: Record<string, { is_voided: boolean; amount_cents: number }> = {};
  const key = (id: string) => session ? id : Bun.hash(id).toString(36);
  for (const record of folded.all_records.values()) status[key(record.donation_id)] = { is_voided: record.is_voided, amount_cents: record.amount_cents };
  if (!session) {
    const anonymousIds = new Set(db.query<{ donation_id: string }, []>("SELECT DISTINCT donation_id FROM ledger WHERE is_anonymous = 1").all().map(row => row.donation_id));
    events = events.map(event => ({
      ...event, donation_id: key(event.donation_id),
      donor_name: anonymousIds.has(event.donation_id) ? "Anonymous Supporter" : (folded.all_records.get(event.donation_id)?.display_name || ""),
      display_name: anonymousIds.has(event.donation_id) ? "Anonymous Supporter" : (folded.all_records.get(event.donation_id)?.display_name || ""),
      donor_phonetic: null, table_number: null, card_number: null,
      entered_by: "", notes: "", source_txn_id: null
    }));
  }
  return Response.json(
    { events, status, can_edit: !!session, total_raised_cents: folded.total_raised_cents, active_donation_count: folded.active_donation_count, void_count: folded.void_count, server_time: Date.now() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
