import type { Database } from "bun:sqlite";
import { foldLedger, type LedgerEvent } from "../ledger";

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function handleExportCSV(req: Request, db: Database): Response {
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
  rows.push(`Active Donation Count,${folded.active_donation_count},Void Count,${folded.void_count}`);
  rows.push(`Generated At ISO,${new Date().toISOString()}`);

  const csvContent = rows.join("\r\n");
  const filename = `givebar-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

  return new Response(csvContent, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    }
  });
}
