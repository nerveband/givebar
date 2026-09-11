import type { Database } from "bun:sqlite";
import { foldLedger, type LedgerEvent } from "../ledger";
import { requireRole } from "../authz";
import type { BackupManager } from "../backup";

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
  const auth = requireRole(db, req, ["admin", "operator"]);
  if (auth instanceof Response) return auth;

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

/** GET /api/export/backup[?name=] downloads a named snapshot, or a fresh one taken right now. Administrators only. */
export function handleExportBackup(req: Request, db: Database, backups: BackupManager): Response {
  const auth = requireRole(db, req, ["admin"]);
  if (auth instanceof Response) return auth;
  const requested = new URL(req.url).searchParams.get("name");
  try {
    const name = requested || backups.snapshot("download").name;
    return new Response(Bun.file(backups.path(name)), {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return Response.json({ error: "BACKUP_UNAVAILABLE", message: error instanceof Error ? error.message : "Backup unavailable" }, { status: 404 });
  }
}
