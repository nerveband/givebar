import type { Database } from "bun:sqlite";
import { foldLedger, type LedgerEvent } from "../ledger";

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return "";
  let str = String(val);
  // Formula injection defense: prepend single quote if starting with =, +, -, @, \t
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function handleExportCSV(req: Request, db: Database): Response {
  const url = new URL(req.url);
  const eventState = db.query<{ control_pin: string }, []>(`SELECT control_pin FROM event_state WHERE id = 1`).get();
  const isAuthDisabled = process.env.GIVEBAR_DISABLE_AUTH === "1";
  const pin = req.headers.get("X-Control-Pin") || url.searchParams.get("pin") || "";
  if (!isAuthDisabled && eventState && eventState.control_pin && eventState.control_pin.trim() !== "" && pin !== eventState.control_pin) {
    return Response.json({ error: "UNAUTHORIZED", message: "Control Room PIN required to download finance CSV" }, { status: 401 });
  }

  const folded = foldLedger(db);
  const events = db.query<LedgerEvent, []>(`SELECT * FROM ledger ORDER BY seq ASC`).all();
  const headers = [
    "Sequence",
    "Event Type",
    "Donation ID",
    "Supersedes Seq",
    "Amount USD",
    "Amount Cents",
    "Donor Legal Name",
    "Display Name",
    "Is Anonymous",
    "Payment Method",
    "Source",
    "Transaction ID",
    "Card Serial",
    "Entered By",
    "Notes",
    "Created At ISO",
    "Created At Unix MS"
  ];

  const rows: string[] = [];
  rows.push(headers.join(","));

  for (const ev of events) {
    const amountUSD = (ev.amount_cents / 100).toFixed(2);
    const isoDate = new Date(ev.created_at).toISOString();

    const row = [
      ev.seq,
      ev.event_type,
      ev.donation_id,
      ev.supersedes_seq || "",
      amountUSD,
      ev.amount_cents,
      ev.donor_name,
      ev.display_name || "",
      ev.is_anonymous ? "YES" : "NO",
      ev.payment_method,
      ev.source,
      ev.source_txn_id || "",
      ev.card_number || "",
      ev.entered_by || "",
      ev.notes || "",
      isoDate,
      ev.created_at
    ].map(escapeCSV).join(",");

    rows.push(row);
  }

  // Add auditable reconciliation summary footer
  rows.push("");
  rows.push("# --- AUDIT RECONCILIATION SUMMARY ---");
  rows.push(`Direct Raised (USD),${(folded.direct_raised_cents / 100).toFixed(2)},Direct Raised (Cents),${folded.direct_raised_cents}`);
  rows.push(`Match Applied (USD),${(folded.match_applied_cents / 100).toFixed(2)},Match Applied (Cents),${folded.match_applied_cents}`);
  rows.push(`Total Authoritative Raised (USD),${(folded.total_raised_cents / 100).toFixed(2)},Total Raised (Cents),${folded.total_raised_cents}`);
  const csvBody = rows.join("\r\n");
  return new Response("\uFEFF" + csvBody, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="givebar-ledger-${Date.now()}.csv"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}
