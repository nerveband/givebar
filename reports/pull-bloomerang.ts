// Pull constituents and transactions from the CAIR-Georgia Bloomerang CRM (REST API v2) into
// reports/data/bloomerang.json so build-report.ts can cross-reference tonight's donors against
// their giving history (first gift, last gift, last year's gala, lifetime total).
//
//   secret-gate exec --item "<Bloomerang item>" --field "<api key field>" --env BLOOMERANG_API_KEY -- bun reports/pull-bloomerang.ts
//
// API reference: https://bloomerang.co/product/integrations-data-management/api/rest-api/
// Every list endpoint pages with skip/take (max 50). Nothing but counts is printed.
import { mkdirSync, writeFileSync } from "fs";

const key = process.env.BLOOMERANG_API_KEY || "";
if (!key) { console.error("BLOOMERANG_API_KEY is not set; run through secret-gate exec."); process.exit(2); }
const BASE = "https://api.bloomerang.co/v2";
const TAKE = 50;

async function page<T>(path: string, extra: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; skip += TAKE) {
    const params = new URLSearchParams({ skip: String(skip), take: String(TAKE), ...extra });
    const response = await fetch(`${BASE}/${path}?${params}`, { headers: { "X-API-KEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
    if (response.status === 429) { await Bun.sleep(2000); skip -= TAKE; continue; }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const body = await response.json() as { Results?: T[]; TotalFiltered?: number; Total?: number };
    const results = body.Results || [];
    out.push(...results);
    const total = body.TotalFiltered ?? body.Total ?? 0;
    if (!results.length || out.length >= total) return out;
  }
}

const constituents = await page<Record<string, unknown>>("constituents");
console.log(`constituents: ${constituents.length}`);
const transactions = await page<Record<string, unknown>>("transactions", { orderBy: "Date", orderDirection: "Desc" });
console.log(`transactions: ${transactions.length}`);
const campaigns = await page<Record<string, unknown>>("campaigns").catch(() => []);
const appeals = await page<Record<string, unknown>>("appeals").catch(() => []);
const funds = await page<Record<string, unknown>>("funds").catch(() => []);

mkdirSync("reports/data", { recursive: true });
writeFileSync("reports/data/bloomerang.json", JSON.stringify({ pulled_at: new Date().toISOString(), constituents, transactions, campaigns, appeals, funds }));
console.log("wrote reports/data/bloomerang.json");
