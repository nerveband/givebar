// Pull the Givebar Stats dashboard (ledger stats plus website analytics from Umami) into
// reports/data/givebar-stats.json. Signs in once with an operator account; the session is
// revoked with a logout at the end.
//
//   secret-gate exec --item "Givebar administrator - givebar.wavedepth.com" --field password --env GIVEBAR_PIN -- \
//     env GIVEBAR_USER=<username> bun reports/pull-stats.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";

const config = JSON.parse(readFileSync("reports/report.config.json", "utf8")) as { givebar_url: string };
const base = config.givebar_url.replace(/\/$/, "");
const user = process.env.GIVEBAR_USER || "";
const pin = process.env.GIVEBAR_PIN || "";
if (!user || !pin) { console.error("GIVEBAR_USER and GIVEBAR_PIN are required (use secret-gate exec)."); process.exit(2); }

const login = await fetch(`${base}/api/control`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ action: "login", username: user, pin }) });
if (!login.ok) { console.error(`login failed: HTTP ${login.status}`); process.exit(1); }
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const get = async (query: string) => {
  const res = await fetch(`${base}/api/stats?${query}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`stats ${query}: HTTP ${res.status}`);
  return res.json();
};
const ranges: Record<string, unknown> = {};
for (const range of ["all", "30d", "7d", "24h"]) ranges[range] = await get(`range=${range}`);
await fetch(`${base}/api/control`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: JSON.stringify({ action: "logout" }) });

mkdirSync("reports/data", { recursive: true });
writeFileSync("reports/data/givebar-stats.json", JSON.stringify({ pulled_at: new Date().toISOString(), ranges }));
const all = ranges.all as { website?: { connected?: boolean; totals?: Record<string, number> } };
console.log(`wrote reports/data/givebar-stats.json · website ${all.website?.connected ? "connected" : "not connected"} ${JSON.stringify(all.website?.totals || {})}`);
