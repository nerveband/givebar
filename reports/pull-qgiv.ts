// Pull every Qgiv transaction the CAIR-Georgia token can see, one calendar year per request,
// into reports/data/qgiv-history.json. Used by build-report.ts for repeat-donor cross-reference.
//
//   secret-gate exec --item "CAIR-Georgia Givebar Fundraising API" --field credential --env QGIV_TOKEN -- bun reports/pull-qgiv.ts [fromYear]
//
// The token is only ever read from the environment; nothing is printed except counts.
import { mkdirSync, writeFileSync } from "fs";

const token = process.env.QGIV_TOKEN || "";
if (!token) { console.error("QGIV_TOKEN is not set; run through secret-gate exec."); process.exit(2); }
const fromYear = Number(process.argv[2] || new Date().getFullYear() - 4);
const thisYear = new Date().getFullYear();

type Form = { id: string; name?: string; transactions: Record<string, unknown>[]; summary?: Record<string, unknown> };
const formsById = new Map<string, { id: string; name: string; transactions: Record<string, unknown>[] }>();

for (let year = fromYear; year <= thisYear; year++) {
  const start = `0101${year}`;
  const end = year === thisYear ? `${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate() + 1).padStart(2, "0")}${year}` : `0101${year + 1}`;
  const url = `https://secure.qgiv.com/admin/api/reporting/transactions/dates/${start}:${end}.json`;
  const response = await fetch(url, { method: "POST", body: new URLSearchParams({ token }), redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok) { console.error(`${year}: HTTP ${response.status}`); process.exit(1); }
  const payload = await response.json() as { forms?: Form[] };
  let count = 0;
  for (const form of payload.forms || []) {
    const entry = formsById.get(String(form.id)) || { id: String(form.id), name: String(form.name || ""), transactions: [] };
    if (!entry.name && form.name) entry.name = String(form.name);
    const seen = new Set(entry.transactions.map(t => String(t.id)));
    for (const t of form.transactions || []) if (!seen.has(String(t.id))) { entry.transactions.push(t); seen.add(String(t.id)); count++; }
    formsById.set(entry.id, entry);
  }
  console.log(`${year}: ${count} transactions across ${(payload.forms || []).length} forms`);
}

mkdirSync("reports/data", { recursive: true });
const out = { pulled_at: new Date().toISOString(), from_year: fromYear, forms: [...formsById.values()] };
writeFileSync("reports/data/qgiv-history.json", JSON.stringify(out));
console.log(`wrote reports/data/qgiv-history.json: ${out.forms.length} forms, ${out.forms.reduce((n, f) => n + f.transactions.length, 0)} transactions`);
